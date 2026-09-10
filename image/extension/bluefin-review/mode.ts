/**
 * Mode state: the single source of truth every surface reads.
 *
 * The status segment, the rail under the editor, the dashboard overlay, and the
 * LLM tools all project this one object. Nothing here touches the TUI, so the
 * whole model is testable without a terminal.
 */

import { GLYPH, type SpanStatus, statusIcon } from "./glyphs.ts";
import {
	type FetchOptions,
	type QueueItem,
	type QueueMode,
	type QueueResult,
	type QueueScope,
	fetchQueue,
	orgScope,
} from "./github.ts";
import { type HiveSnapshot, EMPTY_HIVE, fetchHive, fetchHiveKnowledge } from "./hive.ts";
import { type PrioritizedQueue, type Priority, itemKey, prioritize } from "./priority.ts";
import {
	type StateSnapshot,
	buildPipelineSpans,
	hasRecordedFindings,
	queueKey,
	readStateSnapshot,
	snapshotSignature,
	stateRoot,
} from "./state.ts";
import { SessionTrace } from "./session.ts";
import type { Span } from "./trace.ts";

export interface ReviewModeOptions {
	org: string;
	stateRoot?: string;
	token?: string;
	fetchImpl?: typeof fetch;
	env?: NodeJS.ProcessEnv;
}

/** Shape persisted to the session so a resumed session reopens where it left off. */
export interface PersistedSelection {
	mode: QueueMode;
	repo?: string;
	id?: number;
	filter?: string;
	hiveOnly?: boolean;
	scope?: QueueScope;
}

export class ReviewMode {
	readonly org: string;
	readonly stateRoot: string;

	queueMode: QueueMode = "prs";
	scope: QueueScope;
	items: QueueItem[] = [];
	cursor = 0;
	filter = "";
	hiveOnly = true;
	queueError?: string;
	queueTruncated = false;
	fetchedAt = 0;
	loading = false;
	selectedKeys = new Set<string>();

	snapshot: StateSnapshot;
	hive: HiveSnapshot = EMPTY_HIVE;
	readonly session = new SessionTrace();

	private token?: string;
	private fetchImpl?: typeof fetch;
	private env: NodeJS.ProcessEnv;
	private inflight?: AbortController;
	private snapshotSignature = "";
	private ranked: PrioritizedQueue = { items: [], priorities: new Map(), source: "local", hiveRanked: 0 };

	constructor(options: ReviewModeOptions) {
		this.org = options.org;
		this.scope = orgScope(options.org);
		this.stateRoot = options.stateRoot ?? stateRoot();
		this.token = options.token;
		this.fetchImpl = options.fetchImpl;
		this.env = options.env ?? process.env;
		this.snapshot = { root: this.stateRoot, runs: [], reviewEvents: [], landingEvents: [], receipts: new Map() };
	}

	setToken(token: string | undefined): void {
		this.token = token;
	}

	hasToken(): boolean {
		return Boolean(this.token);
	}

	/** Credential and transport for one-off calls that bypass the queue poll. */
	tokenOptions(): FetchOptions {
		return { token: this.token, org: this.org, scope: this.scope, fetchImpl: this.fetchImpl };
	}

	/** What the queue currently covers, for display. */
	scopeLabel(): string {
		return this.scope.value;
	}

	/** Point the queue at an organization or one repository. */
	setScope(scope: QueueScope): void {
		this.scope = scope;
		this.cursor = 0;
		this.items = [];
		this.ranked = { items: [], priorities: new Map(), source: "local", hiveRanked: 0 };
	}

	/** Why this item sits where it sits. */
	priorityFor(item: QueueItem): Priority | undefined {
		return this.ranked.priorities.get(itemKey(item));
	}

	priorities(): ReadonlyMap<string, Priority> {
		return this.ranked.priorities;
	}

	/** Which provider ordered the queue: Hive's priority, or local categories. */
	orderSource(): "hive" | "local" {
		return this.ranked.source;
	}

	hiveRankedCount(): number {
		return this.ranked.hiveRanked;
	}

	/**
	 * Recompute the order.
	 *
	 * Cheap and idempotent, so every input that can change priority — a queue
	 * refetch, a hub poll, a new receipt on disk — ends by calling it.
	 */
	reprioritize(now = Date.now()): void {
		this.ranked = prioritize(this.items, {
			hive: this.hive,
			hasFindings: (key) => hasRecordedFindings(this.snapshot, key),
			now,
		});
	}

	/** Items in priority order, after hive-only and substring filters. */
	visibleItems(): QueueItem[] {
		const ordered = this.ranked.items.length === this.items.length ? this.ranked.items : this.items;
		const candidates = this.hiveOnly && this.hive.online
			? ordered.filter((item) => this.priorityFor(item)?.category === "hive")
			: ordered;
		if (!this.filter) return candidates;
		const needle = this.filter.toLowerCase();
		return candidates.filter(
			(item) =>
				item.title.toLowerCase().includes(needle) ||
				item.repo.toLowerCase().includes(needle) ||
				item.author.toLowerCase().includes(needle) ||
				String(item.id).includes(needle) ||
				item.labels.some((label) => label.toLowerCase().includes(needle)) ||
				(this.priorityFor(item)?.category ?? "").includes(needle),
		);
	}

	selected(): QueueItem | undefined {
		const items = this.visibleItems();
		if (items.length === 0) return undefined;
		if (this.cursor >= items.length) this.cursor = items.length - 1;
		return items[Math.max(0, this.cursor)];
	}

	selectedKey(): string | undefined {
		const item = this.selected();
		return item ? queueKey(item.repo, item.id) : undefined;
	}

	move(delta: number): void {
		const count = this.visibleItems().length;
		if (count === 0) {
			this.cursor = 0;
			return;
		}
		this.cursor = Math.min(count - 1, Math.max(0, this.cursor + delta));
	}

	selectById(repo: string | undefined, id: number): boolean {
		const items = this.visibleItems();
		const index = items.findIndex((item) => item.id === id && (!repo || item.repo === repo));
		if (index < 0) return false;
		this.cursor = index;
		return true;
	}

	setFilter(filter: string): void {
		this.filter = filter;
		this.cursor = 0;
	}
	toggleHiveOnly(): boolean {
		this.hiveOnly = !this.hiveOnly;
		this.cursor = 0;
		return this.hiveOnly;
	}
	toggleMode(): QueueMode {
		this.queueMode = this.queueMode === "prs" ? "issues" : "prs";
		this.items = [];
		this.selectedKeys.clear();
		return this.queueMode;
	}

	toggleSelected(key?: string): boolean {
		const targetKey = key ?? this.selectedKey();
		if (!targetKey) return false;
		if (this.selectedKeys.has(targetKey)) {
			this.selectedKeys.delete(targetKey);
			return false;
		}
		this.selectedKeys.add(targetKey);
		return true;
	}

	clearSelected(): void {
		this.selectedKeys.clear();
	}

	chosenItems(): QueueItem[] {
		if (this.selectedKeys.size === 0) return [];
		return this.visibleItems().filter((item) => this.selectedKeys.has(`${item.repo}#${item.id}`));
	}

	/**
	 * Re-read durable appliance state.
	 *
	 * Returns whether anything actually changed, so a poll that finds the same
	 * bytes does not cost a terminal repaint.
	 */
	refreshState(): boolean {
		this.snapshot = readStateSnapshot(this.stateRoot);
		const signature = snapshotSignature(this.snapshot);
		if (signature === this.snapshotSignature) return false;
		this.snapshotSignature = signature;
		// Findings are a priority signal, so a new receipt reorders the queue.
		this.reprioritize();
		return true;
	}

	/**
	 * Ask the hub what the project needs first.
	 *
	 * Read-only and never fatal: an unreachable hub leaves the queue ordered by
	 * the local categories, with the reason kept for display.
	 */
	async refreshHive(signal?: AbortSignal): Promise<HiveSnapshot> {
		this.hive = await fetchHive({ env: this.env, signal, fetchImpl: this.fetchImpl });
		this.reprioritize();
		return this.hive;
	}
	/**
	 * Programmatically fetch the authenticated Hive knowledge base markdown export.
	 */
	async getHiveKnowledge(signal?: AbortSignal): Promise<string | undefined> {
		return await fetchHiveKnowledge({ env: this.env, signal, fetchImpl: this.fetchImpl });
	}

	/** Fetch the queue, cancelling any fetch still in flight. */
	async refreshQueue(): Promise<QueueResult> {
		this.inflight?.abort();
		const controller = new AbortController();
		this.inflight = controller;
		this.loading = true;

		try {
			const options: FetchOptions = {
				token: this.token,
				org: this.org,
				scope: this.scope,
				signal: controller.signal,
				fetchImpl: this.fetchImpl,
			};
			const result = await fetchQueue(this.queueMode, options);
			if (controller.signal.aborted) return result;

			this.queueError = result.error;
			this.queueTruncated = result.truncated === true;
			this.fetchedAt = result.fetchedAt;
			if (!result.error || result.items.length > 0) {
				const previousKey = this.selectedKey();
				this.items = result.items;
				this.reprioritize();
				if (previousKey) {
					const index = this.visibleItems().findIndex((item) => queueKey(item.repo, item.id) === previousKey);
					this.cursor = index >= 0 ? index : Math.min(this.cursor, Math.max(0, this.visibleItems().length - 1));
				}
			}
			return result;
		} finally {
			if (this.inflight === controller) {
				this.loading = false;
				this.inflight = undefined;
			}
		}
	}

	/** Durable pipeline trace for the selected item. */
	pipelineSpans(now: number): Span[] {
		const item = this.selected();
		if (!item) return [];
		return this.tracePipeline(queueKey(item.repo, item.id), item.title, now);
	}

	/** Durable pipeline trace for an arbitrary `owner/repo#number`. */
	tracePipeline(key: string, title: string, now: number): Span[] {
		return buildPipelineSpans(key, title, this.snapshot, now);
	}

	/** CI histogram across the visible queue, for the headline counters. */
	ciTally(): { success: number; failure: number; pending: number; unknown: number } {
		const tally = { success: 0, failure: 0, pending: 0, unknown: 0 };
		for (const item of this.visibleItems()) {
			if (item.ciStatus === "success") tally.success += 1;
			else if (item.ciStatus === "failure") tally.failure += 1;
			else if (item.ciStatus === "pending") tally.pending += 1;
			else tally.unknown += 1;
		}
		return tally;
	}

	position(): string {
		const count = this.visibleItems().length;
		if (count === 0) return "0/0";
		// A trailing "+" marks a queue cut off by the fetch ceiling.
		const total = `${count}${this.queueTruncated && !this.filter ? "+" : ""}`;
		return `${Math.min(this.cursor + 1, count)}/${total}`;
	}

	toPersisted(): PersistedSelection {
		const item = this.selected();
		return {
			mode: this.queueMode,
			repo: item?.repo,
			id: item?.id,
			filter: this.filter || undefined,
			hiveOnly: this.hiveOnly,
			scope: this.scope,
		};
	}

	restore(persisted: PersistedSelection | undefined): void {
		if (!persisted) return;
		if (persisted.mode === "prs" || persisted.mode === "issues") this.queueMode = persisted.mode;
		if (persisted.scope?.value && (persisted.scope.kind === "org" || persisted.scope.kind === "repo")) {
			this.scope = persisted.scope;
		}
		if (persisted.filter) this.filter = persisted.filter;
		if (typeof persisted.hiveOnly === "boolean") this.hiveOnly = persisted.hiveOnly;
		if (typeof persisted.id === "number") this.selectById(persisted.repo, persisted.id);
	}
}

/** CI badge in the Dagger icon vocabulary. */
export function ciGlyph(status: QueueItem["ciStatus"]): { glyph: string; status: SpanStatus } {
	switch (status) {
		case "success":
			return { glyph: statusIcon("success"), status: "success" };
		case "failure":
			return { glyph: statusIcon("failure"), status: "failure" };
		case "pending":
			return { glyph: GLYPH.running, status: "running" };
		default:
			return { glyph: GLYPH.pending, status: "pending" };
	}
}
