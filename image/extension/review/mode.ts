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
import { type PrioritizedQueue, type Priority, isRepairRequested, itemKey, prioritize } from "./priority.ts";
import { type LandingState, landingState } from "./landing.ts";
import { GENERIC_WORKBENCH_POLICY, type WorkbenchPolicy } from "./policy.ts";
import { readOperatorPolicy, type OperatorPolicySnapshot } from "./operator-policy.ts";
import type { OperatorLandingDecision } from "./operator-landing.ts";
import { SessionTrace } from "./session.ts";
import type { FactoryAction, SelectedItem } from "../luna-factory/core/batch.ts";

export interface ReviewModeOptions {
	org: string;
	scope?: QueueScope;
	token?: string;
	fetchImpl?: typeof fetch;
	env?: NodeJS.ProcessEnv;
	/** Repository policy, so landing state honours the same holds as the gate. */
	policy?: WorkbenchPolicy;
}
/**
 * Most items one dispatch may carry.
 *
 * A batch is fanned out one agent per item, so this is a concurrency ceiling
 * wearing a selection's clothes. Past it the wave stops being a burn-down and
 * starts being a queue of its own, with a context window to match.
 */
export const BATCH_LIMIT = 25;

function canonicalSelectedKey(repo: string, number: number): string {
	return `${repo.toLowerCase()}#${number}`;
}

/** A contiguous slice of work targeting a single repository. */
export interface RepositoryWave {
	readonly repo: string;
	readonly items: readonly QueueItem[];
}

export interface WorkbenchBatchProgress {
	readonly state: "running" | "paused" | "blocked" | "complete";
	readonly repository: string;
	readonly wave: number;
	readonly waves: number;
	readonly completedItems: number;
	readonly totalItems: number;
	readonly runningJobs: number;
	readonly failedJobs: number;
}

/** Shape persisted to the session so a resumed session reopens where it left off. */
export interface PersistedSelection {
	mode: QueueMode;
	repo?: string;
	id?: number;
	filter?: string;
	scope?: QueueScope;
	paused?: boolean;
	selected?: QueueItem[];
	selectedKeys?: string[];
}

export class ReviewMode {
	readonly org: string;

	queueMode: QueueMode = "prs";
	scope: QueueScope;
	items: QueueItem[] = [];
	cursor = 0;
	filter = "";
	queueError?: string;
	queueTruncated = false;
	fetchedAt = 0;
	loading = false;
	selectedKeys = new Set<string>();
	private selectedSnapshots = new Map<string, QueueItem>();
	currentUserLogin?: string;
	viewMode: "default" | "ci" = "default";
	paused = false;
	batchProgress?: WorkbenchBatchProgress;

	readonly session = new SessionTrace();

	private token?: string;
	private fetchImpl?: typeof fetch;
	private env: NodeJS.ProcessEnv;
	private policy: WorkbenchPolicy;
	private operatorPolicies = new Map<string, OperatorPolicySnapshot>();
	private operatorLanding = new Map<string, { head: string | undefined; decision: OperatorLandingDecision }>();
	private inflight?: AbortController;
	private ranked: PrioritizedQueue = { items: [], priorities: new Map(), source: "local" };
	skipRepos: Set<string>;

	constructor(options: ReviewModeOptions) {
		this.org = options.org;
		this.scope = options.scope ?? orgScope(options.org);
		this.fetchImpl = options.fetchImpl;
		this.env = options.env ?? process.env;
		this.policy = options.policy ?? GENERIC_WORKBENCH_POLICY;
		const envSkip = (this.env.REVIEW_SKIP_REPOS ?? "")
			.split(",")
			.map((s) => s.trim().toLowerCase())
			.filter(Boolean);
		this.skipRepos = new Set(envSkip);
	}

	setToken(token: string | undefined): void {
		this.token = token;
	}


	/** Credential and transport for one-off calls that bypass the queue poll. */
	tokenOptions(): FetchOptions {
		return { token: this.token, org: this.org, scope: this.scope, fetchImpl: this.fetchImpl };
	}

	scopeLabel(): string {
		return this.scope.value || "choose scope";
	}
	/** Point the queue at another organization or repository. */
	setScope(scope: QueueScope): void {
		this.inflight?.abort();
		this.inflight = undefined;
		this.loading = false;
		this.scope = scope;
		this.cursor = 0;
		this.items = [];
		this.ranked = { items: [], priorities: new Map(), source: "local" };
		this.queueError = undefined;
		this.queueTruncated = false;
	}

	/** Remove items the workbench cannot act on from every visible/selected view. */
	excludeItems(items: readonly QueueItem[]): void {
		if (items.length === 0) return;
		const excluded = new Set(items.map(itemKey));
		this.items = this.items.filter((item) => !excluded.has(itemKey(item)));
		for (const key of excluded) this.selectedKeys.delete(key);
		this.cursor = Math.min(this.cursor, Math.max(0, this.visibleItems().length - 1));
		this.reprioritize();
	}


	/** Why this item sits where it sits. */
	priorityFor(item: QueueItem): Priority | undefined {
		return this.ranked.priorities.get(itemKey(item));
	}

	priorities(): ReadonlyMap<string, Priority> {
		return this.ranked.priorities;
	}

	/**
	 * Authoritative landing state for a pull request: CI, reviews, holds, and
	 * mergeability evaluated together. Only the extension and the status tool
	 * project this, so the UI maps to the same state the slay gate enforces.
	 */
	landingStateFor(item: QueueItem): LandingState {
		const state = landingState(item, this.policy);
		const observed = this.operatorLanding.get(itemKey(item));
		if (observed && observed.head === item.headSha && !observed.decision.allowed && state === "ready-to-land") return "incomplete";
		return state === "unreviewed" && observed && observed.head === item.headSha && observed.decision.allowed ? "ready-to-land" : state;
	}

	operatorPolicyFor(repository: string): OperatorPolicySnapshot | undefined {
		return this.operatorPolicies.get(repository.toLowerCase());
	}

	refreshOperatorPolicies(): void {
		this.operatorLanding.clear();
		for (const repository of new Set(this.items.map((item) => item.repo.toLowerCase()))) this.operatorPolicies.set(repository, readOperatorPolicy(repository, this.env));
	}

	recordOperatorLanding(item: QueueItem, decision: OperatorLandingDecision): void {
		this.operatorLanding.set(itemKey(item), { head: item.headSha, decision });
	}

	operatorLandingReasonFor(item: QueueItem): string | undefined {
		const observed = this.operatorLanding.get(itemKey(item));
		return observed && observed.head === item.headSha && !observed.decision.allowed ? observed.decision.reason : undefined;
	}

	/** The queue uses deterministic local attention categories. */
	orderSource(): "local" {
		return this.ranked.source;
	}

	/** Reconcile a successful live read into the canonical queue model. */
	reconcileItems(updates: readonly QueueItem[]): void {
		if (updates.length === 0) return;
		const byKey = new Map(updates.map((item) => [itemKey(item), item]));
		let changed = false;
		this.items = this.items.map((item) => {
			const update = byKey.get(itemKey(item));
			if (!update || update.type !== item.type) return item;
			Object.assign(item, update);
			if (this.selectedKeys.has(itemKey(item))) this.selectedSnapshots.set(itemKey(item), structuredClone(item));
			changed = true;
			return item;
		});
		if (changed) this.reprioritize();
	}

	/**
	 * Recompute the order.
	 *
	 * Cheap and idempotent, so every input that can change priority — a queue
	 * refetch, a hub poll, a new receipt on disk — ends by calling it.
	 */
	reprioritize(now = Date.now()): void {
		this.ranked = prioritize(this.items, {
			now,
			currentUserLogin: this.currentUserLogin,
			allowWorkflowSlay: this.policy.allowWorkflowSlay,
		});
	}

	/** Items in priority order, after the substring filter. */
	visibleItems(): QueueItem[] {
		let base = this.ranked.items.length === this.items.length ? this.ranked.items : this.items;
		if (this.skipRepos.size > 0) {
			base = base.filter((item) => {
				const repoLower = item.repo.toLowerCase();
				const shortName = repoLower.includes("/") ? repoLower.split("/")[1]! : repoLower;
				return !this.skipRepos.has(repoLower) && !this.skipRepos.has(shortName);
			});
		}
		const candidates = base;
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
		return item ? itemKey(item) : undefined;
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
	setPaused(paused: boolean): void {
		this.paused = paused;
	}
	togglePaused(): boolean {
		this.paused = !this.paused;
		return this.paused;
	}
	setBatchProgress(progress: WorkbenchBatchProgress | undefined): void {
		this.batchProgress = progress;
	}
	toggleMode(): QueueMode {
		this.queueMode = this.queueMode === "prs" ? "issues" : "prs";
		this.items = [];
		this.cursor = 0;
		return this.queueMode;
	}
	toggleViewMode(): "default" | "ci" {
		this.viewMode = this.viewMode === "default" ? "ci" : "default";
		return this.viewMode;
	}



	toggleSelected(key?: string): boolean {
		const targetKey = key ?? this.selectedKey();
		if (!targetKey) return false;
		if (this.selectedKeys.has(targetKey)) {
			this.selectedKeys.delete(targetKey);
			this.selectedSnapshots.delete(targetKey);
			return false;
		}
		this.selectedKeys.add(targetKey);
		const item = this.items.find((candidate) => itemKey(candidate) === targetKey);
		if (item) this.selectedSnapshots.set(targetKey, structuredClone(item));
		return true;
	}

	/** Toggle the visible selection independently of Factory execution capacity. */
	selectAllVisible(_limit = BATCH_LIMIT): number {
		const visible = this.visibleItems();
		const everySelected = visible.length > 0 && visible.every((item) => this.selectedKeys.has(itemKey(item)));
		if (everySelected) {
			for (const item of visible) {
				const key = itemKey(item);
				this.selectedKeys.delete(key);
				this.selectedSnapshots.delete(key);
			}
			return this.selectedKeys.size;
		}
		for (const item of visible) {
			const key = itemKey(item);
			this.selectedKeys.add(key);
			this.selectedSnapshots.set(key, structuredClone(item));
		}
		return this.selectedKeys.size;
	}

	/** Toggle all visible items in the current repository; selection is unbounded. */
	selectCurrentRepository(_limit = BATCH_LIMIT): number {
		const current = this.selected();
		if (!current) return this.selectedKeys.size;
		const repoVisible = this.visibleItems().filter((item) => item.repo.toLowerCase() === current.repo.toLowerCase());
		const allRepoSelected = repoVisible.length > 0 && repoVisible.every((item) => this.selectedKeys.has(itemKey(item)));
		for (const item of repoVisible) {
			const key = itemKey(item);
			if (allRepoSelected) {
				this.selectedKeys.delete(key);
				this.selectedSnapshots.delete(key);
			} else {
				this.selectedKeys.add(key);
				this.selectedSnapshots.set(key, structuredClone(item));
			}
		}
		return this.selectedKeys.size;
	}

	/**
	 * Partition items into bounded, type-homogeneous repository waves without
	 * moving any item ahead of work ordered before it. Returned PR repairs stay
	 * separate from ordinary PR review/landing waves.
	 */
	repositoryWaves(items: readonly QueueItem[] = this.chosenItems()): RepositoryWave[] {
		const waves: Array<{ repo: string; items: QueueItem[] }> = [];
		for (const item of items) {
			const previous = waves.at(-1);
			const first = previous?.items[0];
			const sameIntent = first !== undefined
				&& first.type === item.type
				&& isRepairRequested(first, this.currentUserLogin) === isRepairRequested(item, this.currentUserLogin);
			if (previous?.repo === item.repo && sameIntent && previous.items.length < BATCH_LIMIT) {
				previous.items.push(item);
				continue;
			}
			waves.push({ repo: item.repo, items: [item] });
		}
		return waves;
	}

	clearSelected(): void {
		this.selectedKeys.clear();
		this.selectedSnapshots.clear();
	}

	chosenItems(): QueueItem[] {
		return [...this.selectedKeys].map((key) => this.items.find((item) => itemKey(item) === key) ?? this.selectedSnapshots.get(key)).filter((item): item is QueueItem => item !== undefined);
	}

	/** The evidence provider that ordered the queue. */
	orderSource(): "local" { return this.ranked.source; }

	factorySelection(action: FactoryAction): SelectedItem[] {
		return [...this.selectedKeys].map((key) => {
			const item = this.items.find((candidate) => itemKey(candidate) === key) ?? this.selectedSnapshots.get(key);
			if (!item) return { key: key.toLowerCase(), repo: key.slice(0, key.indexOf("#")).toLowerCase(), number: Number(key.slice(key.indexOf("#") + 1)), kind: "unknown" as const, action, overlaps: [], blocker: "selected item is unavailable; refresh and inspect before execution" };
			return {
				key: canonicalSelectedKey(item.repo, item.id), repo: item.repo.toLowerCase(), number: item.id,
				kind: item.type, action, head: item.headSha, overlaps: item.closingIssues ?? [],
				url: item.url,
			};
		});
	}


	/** Pull requests authored by the active user after a requested-changes review. */
	repairRequestedItems(): QueueItem[] {
		return this.visibleItems().filter((item) => isRepairRequested(item, this.currentUserLogin));
	}
	/**
	 * Items available for slay execution: chosen items first, then visible items,
	 * falling back to local priority order when filters leave zero items.
	 */
	slayableItems(limit = BATCH_LIMIT): QueueItem[] {
		const chosen = this.chosenItems();
		if (chosen.length > 0) return chosen.slice(0, limit);
		const visible = this.visibleItems();
		if (visible.length > 0) return visible.slice(0, limit);
		let base = this.ranked.items.length === this.items.length ? this.ranked.items : this.items;
		if (this.skipRepos.size > 0) base = base.filter((item) => !this.skipRepos.has(item.repo.toLowerCase()) && !this.skipRepos.has(item.repo.split("/")[1]!.toLowerCase()));
		return base.slice(0, limit);
	}




	/**
	 * Fetch the queue, cancelling any fetch still in flight.
	 * The GitHub search is the complete source for this scoped queue.
	 */
	async refreshQueue(): Promise<QueueResult> {
		if (!this.scope.value) {
			const result = { items: [], error: "GitHub scope is required; supply owner/repo or org:<name>", fetchedAt: Date.now() };
			this.queueError = result.error;
			this.items = [];
			this.loading = false;
			return result;
		}
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
			if (result.cancelled || this.inflight !== controller || controller.signal.aborted) {
				return { items: result.items, cancelled: true, fetchedAt: result.fetchedAt };
			}

			if (result.error && result.items.length === 0) {
				this.queueError = result.error;
				this.queueTruncated = result.truncated === true;
				this.fetchedAt = result.fetchedAt;
				return result;
			}

			this.queueError = result.error;
			this.queueTruncated = result.truncated === true;
			this.fetchedAt = result.fetchedAt;
			if (result.viewerLogin) this.currentUserLogin = result.viewerLogin;
			const previousKey = this.selectedKey();
			this.items = result.items;
			this.refreshOperatorPolicies();
			this.reprioritize();
			if (previousKey) {
				const index = this.visibleItems().findIndex((item) => itemKey(item) === previousKey);
				this.cursor = index >= 0 ? index : Math.min(this.cursor, Math.max(0, this.visibleItems().length - 1));
			}
			return result;
		} finally {
			if (this.inflight === controller) {
				this.loading = false;
				this.inflight = undefined;
			}
		}
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
		return { mode: this.queueMode, repo: item?.repo, id: item?.id, filter: this.filter || undefined, scope: this.scope, paused: this.paused ? true : undefined, selectedKeys: [...this.selectedKeys], selected: [...this.selectedSnapshots.values()].map((value) => structuredClone(value)) };
	}

	restore(persisted: PersistedSelection | undefined): void {
		if (!persisted) return;
		if (persisted.mode === "prs" || persisted.mode === "issues") this.queueMode = persisted.mode;
		if (persisted.scope?.value && (persisted.scope.kind === "org" || persisted.scope.kind === "repo")) this.scope = persisted.scope;
		if (persisted.filter) this.filter = persisted.filter;
		for (const key of persisted.selectedKeys ?? []) if (typeof key === "string") this.selectedKeys.add(key);
		for (const item of persisted.selected ?? []) {
			const key = itemKey(item);
			this.selectedKeys.add(key);
			this.selectedSnapshots.set(key, structuredClone(item));
		}
		if (typeof persisted.id === "number") this.selectById(persisted.repo, persisted.id);
		if (typeof persisted.paused === "boolean") this.paused = persisted.paused;
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
