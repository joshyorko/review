import { stripVTControlCharacters } from "node:util";
import type { Batch } from "../core/batch.ts";
import type { ClaimOwnerObservation } from "../omp/batch-bridge.ts";
import type { ResourceClaim } from "../omp/batch-store.ts";
import { fitToWidth, truncateToWidth, visibleWidth } from "../../bluefin-review/width.ts";
import { canonicalKey, rawKeyMatcher, type KeyMatcher } from "../../bluefin-review/keys.ts";
import { itemOverview, itemTitle } from "./operator.ts";
import { projectBatch, type ProjectedBatch, type ProjectedItem } from "./projection.ts";
import { claimIdentity, inspectClaim } from "./claims.ts";

export interface FactoryDashboardSnapshot {
	readonly batches: readonly Batch[];
	readonly claims: readonly ResourceClaim[];
	readonly root?: string;
	readonly error?: string;
	readonly loading?: boolean;
	readonly hasMoreHistory?: boolean;
	readonly notice?: string;
	readonly busy?: boolean;
	readonly activeItemKeys?: readonly string[];
	readonly canReconcileClaims?: boolean;
	readonly claimOwners?: readonly ClaimOwnerObservation[];
	readonly evidenceWarnings?: Readonly<Record<string, string>>;
	readonly readOnly: boolean;
}
export type FactoryDashboardAction =
	| { kind: "close" }
	| { kind: "older-runs" }
	| { kind: "inspect"; batchId: string; itemKey: string }
	| { kind: "pause" | "resume" | "stop"; batchId: string }
	| { kind: "retry" | "reconcile-effect"; batchId: string; itemKey: string }
	| { kind: "open"; batchId: string; itemKey: string; url: string }
	| { kind: "evidence-preview"; batchId: string; itemKey: string; path: string }
	| { kind: "reconcile"; resource: string; owner: string }
	| { kind: "exclude" | "discard" | "export" | "workspace" | "session"; batchId: string; itemKey?: string }
	| { kind: "claims" | "evidence" | "help" | "palette" }
	| { kind: "batch"; batchId: string };
export interface FactoryDashboardTheme {
	fg(color: string, text: string): string;
	bold(text: string): string;
	inverse(text: string): string;
}
export interface FactoryDashboardPrimitives {
	panelRows?: (title: string, rows: readonly string[], width: number) => readonly string[];
	splitPane?: (left: readonly string[], right: readonly string[], width: number) => readonly string[];
}
type View = "roster" | "detail" | "batches" | "claims" | "claim-detail" | "evidence" | "help" | "palette" | "evidence-detail" | "debug" | "claim-debug";
export interface FactoryDashboardPresentation {
	readonly batchId?: string;
	readonly itemKey?: string;
	readonly view: View;
	readonly scroll: number;
	readonly cursor?: number;
	readonly itemKeysByBatch?: Readonly<Record<string, string>>;
	readonly cursorKeys?: Readonly<Record<string, string>>;
}
export interface FactoryDashboardOptions {
	readonly tui: { requestRender(): void; terminal?: { rows?: number } };
	readonly theme: FactoryDashboardTheme;
	readonly done: (action: FactoryDashboardAction) => void;
	readonly onAction?: (action: FactoryDashboardAction) => Promise<void>;
	readonly primitives?: FactoryDashboardPrimitives;
	readonly rows?: number;
	readonly source?: FactoryDashboardSnapshot;
	readonly presentation?: FactoryDashboardPresentation;
	readonly focusBatchId?: string;
	readonly matchKey?: KeyMatcher;
}
type Choice = { label: string; view: View } | { label: string; action: FactoryDashboardAction };
interface EvidenceChoice { label: string; path?: string; text?: readonly string[] }
const EMPTY: FactoryDashboardSnapshot = { batches: [], claims: [], readOnly: true };
const clean = (value: unknown): string => stripVTControlCharacters(String(value ?? "unknown"))
	.replace(/[\x00-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/g, " ").replace(/\s+/g, " ").trim();
function wrapped(lines: readonly string[], width: number): string[] {
	const result: string[] = [];
	for (const value of lines) {
		let line = clean(value);
		if (!line) { result.push(""); continue; }
		while (visibleWidth(line) > width) {
			const fitted = truncateToWidth(line, width, "");
			const boundary = fitted.lastIndexOf(" ");
			const part = boundary > width / 3 ? fitted.slice(0, boundary) : fitted;
			if (!part) break;
			result.push(part); line = line.slice(part.length).trimStart();
		}
		result.push(line);
	}
	return result;
}

/** Presentation only. The parent executes emitted actions through the existing controller. */
export class FactoryDashboard {
	private source: FactoryDashboardSnapshot;
	private batchId?: string;
	private itemKey?: string;
	private view: View;
	private scroll: number;
	private cursor = 0;
	private readonly itemKeysByBatch = new Map<string, string>();
	private readonly cursorKeys = new Map<string, string>();
	private disposed = false;
	private readonly options: FactoryDashboardOptions;
	private readonly projections = new Map<string, ProjectedBatch>();
	private readonly batchById = new Map<string, Batch>();
	private batchIndex = 0;
	constructor(options: FactoryDashboardOptions) {
		this.options = options;
		this.source = options.source ?? EMPTY;
		this.batchId = options.focusBatchId ?? options.presentation?.batchId;
		for (const [batchId, itemKey] of Object.entries(options.presentation?.itemKeysByBatch ?? {})) this.itemKeysByBatch.set(batchId, itemKey);
		if (this.batchId !== undefined && options.presentation?.itemKey !== undefined) this.itemKeysByBatch.set(this.batchId, options.presentation.itemKey);
		this.itemKey = this.batchId === undefined ? options.presentation?.itemKey : this.itemKeysByBatch.get(this.batchId);
		for (const [key, value] of Object.entries(options.presentation?.cursorKeys ?? {})) this.cursorKeys.set(key, value);
		this.view = options.focusBatchId ? "roster" : options.presentation?.view ?? "roster";
		this.scroll = options.presentation?.scroll ?? 0;
		this.cursor = options.presentation?.cursor ?? 0;
		this.indexBatches();
		this.reselect();
		if (!options.presentation && !options.focusBatchId && this.source.batches.length && !this.source.batches.some((b) => b.control === "active")) this.view = "batches";
	}
	get selection(): { batchId?: string; itemKey?: string } { return { batchId: this.batchId, itemKey: this.itemKey }; }
	get presentation(): FactoryDashboardPresentation {
		return {
			...this.selection,
			view: this.view,
			scroll: this.scroll,
			cursor: this.cursor,
			itemKeysByBatch: Object.fromEntries(this.itemKeysByBatch),
			cursorKeys: Object.fromEntries(this.cursorKeys),
		};
	}
	setSource(source: FactoryDashboardSnapshot): void {
		if (this.disposed) return;
		const firstLoad = this.source.loading === true && source.loading !== true;
		this.source = source; this.projections.clear(); this.indexBatches(); this.reselect(); this.syncCursor();
		if (firstLoad && !this.options.presentation && !this.options.focusBatchId && source.batches.length && !source.batches.some((b) => b.control === "active")) this.view = "batches";
		this.options.tui.requestRender();
	}
	update(source: FactoryDashboardSnapshot): void { this.setSource(source); }
	private readOnly(): boolean { return this.source.readOnly || Boolean(this.source.error) || this.source.loading === true; }
	private mutationsAvailable(): boolean { return !this.readOnly() && this.source.busy !== true; }
	private indexBatches(): void { this.batchById.clear(); for (const batch of this.source.batches) this.batchById.set(batch.id, batch); }
	private batch(): Batch | undefined { return this.batchId ? this.batchById.get(this.batchId) : undefined; }
	private project(batch: Batch | undefined = this.batch()): ProjectedBatch | undefined {
		if (!batch) return undefined;
		let projection = this.projections.get(batch.id);
		if (!projection) {
			projection = projectBatch(batch, { readOnly: this.readOnly(), claims: this.source.claims, retainedBatches: this.source.batches, activeItemKeys: this.source.activeItemKeys });
			this.projections.set(batch.id, projection);
		}
		return projection;
	}
	private item(): ProjectedItem | undefined { return this.project()?.items.find((item) => item.key === this.itemKey); }
	private reselect(): void {
		if (!this.batch() && this.source.batches.length > 0 && !this.source.loading) this.batchId = this.source.batches.find((b) => b.control === "active")?.id ?? this.source.batches[0]?.id;
		this.batchIndex = Math.max(0, this.source.batches.findIndex((b) => b.id === this.batchId));
		const items = this.project()?.items ?? [];
		const remembered = this.batchId === undefined ? undefined : this.itemKeysByBatch.get(this.batchId);
		if (remembered !== undefined && items.some((item) => item.key === remembered)) this.itemKey = remembered;
		else if (!items.some((item) => item.key === this.itemKey)) this.itemKey = items[0]?.key;
		if (this.batchId !== undefined && this.itemKey !== undefined) this.itemKeysByBatch.set(this.batchId, this.itemKey);
		this.cursor = Math.max(0, this.cursor);
	}
	private cursorScope(view = this.view): string {
		const list = view === "claim-detail" || view === "claim-debug" ? "claims" : view === "evidence-detail" ? "evidence" : view;
		return `${list}:${this.batchId ?? ""}:${this.itemKey ?? ""}`;
	}
	private cursorIdentity(view = this.view): string | undefined { return this.cursorKeys.get(this.cursorScope(view)); }
	private setCursorIdentity(identity: string | undefined, view = this.view): void {
		const scope = this.cursorScope(view);
		if (identity === undefined) this.cursorKeys.delete(scope); else this.cursorKeys.set(scope, identity);
	}
	private syncCursor(): void {
		const entries = this.view === "claims" || this.view === "claim-detail" || this.view === "claim-debug" ? this.relevantClaims() : this.view === "evidence" || this.view === "evidence-detail" ? this.evidenceChoices() : this.view === "palette" ? this.choices() : [];
		if (!entries.length) { this.cursor = 0; return; }
		const identities = this.view === "claims" || this.view === "claim-detail" || this.view === "claim-debug"
			? (entries as ReturnType<typeof this.relevantClaims>).map(claimIdentity)
			: this.view === "evidence" || this.view === "evidence-detail"
				? (entries as EvidenceChoice[]).map((entry) => entry.path ?? entry.label)
				: (entries as Choice[]).map((entry) => "view" in entry ? `view:${entry.view}` : `action:${entry.action.kind}`);
		const remembered = this.cursorIdentity();
		const index = remembered === undefined ? this.cursor : identities.indexOf(remembered);
		this.cursor = Math.max(0, Math.min(identities.length - 1, index < 0 ? 0 : index));
		this.setCursorIdentity(identities[this.cursor]);
	}
	private enter(view: View): void { this.view = view; this.scroll = 0; this.syncCursor(); }
	private emit(action: FactoryDashboardAction): void {
		if (this.disposed) return;
		if (action.kind === "close" || this.options.onAction === undefined) this.options.done(action);
		else void this.options.onAction(action).catch(() => {});
	}
	private key(input: string): string {
		const named: Record<string, string> = { Enter: "return", Tab: "tab", ArrowDown: "down", ArrowUp: "up", Escape: "escape" };
		return named[input] ?? canonicalKey(input, this.options.matchKey ?? rawKeyMatcher);
	}
	handleInput(input: string): void {
		if (this.disposed) return;
		const key = this.key(input);
		if (key === "q" || key === "escape") {
			if (this.view === "roster" || this.view === "batches") this.emit({ kind: "close" });
			else if (this.view === "evidence-detail") this.enter("evidence");
			else if (this.view === "claim-detail") this.enter("claims");
			else if (this.view === "claim-debug") this.enter("claim-detail");
			else if (this.view === "debug") this.enter("detail");
			else this.enter("roster");
		} else if (key === "j" || key === "down") this.move(1);
		else if (key === "k" || key === "up") this.move(-1);
		else if (key === "return") this.activate();
		else if (key === "tab") this.enter(this.view === "detail" ? "roster" : "detail");
		else if (key === "a") this.enter("palette");
		else if (key === "b") this.enter("batches");
		else if (key === "m" && this.view === "batches" && this.source.hasMoreHistory && !this.source.busy) this.emit({ kind: "older-runs" });
		else if (key === "e") this.enter("evidence");
		else if (key === "c") this.enter("claims");
		else if (key === "?") this.enter(this.view === "help" ? "roster" : "help");
		else if (key === "p") this.batchControl(this.batch()?.control === "active" ? "pause" : "resume");
		else if (key === "x") this.batchControl("stop");
		else if (key === "r" && this.view === "claim-detail") this.reconcileSelectedClaim();
		else if (key === "r") { const primary = this.primaryChoice(); if (primary && "action" in primary && ["retry", "reconcile", "reconcile-effect"].includes(primary.action.kind)) this.emit(primary.action); }
		else if (key === "o") this.openPR();
		else if (key === "v" && this.item()?.actions.includes("view-session") && this.batchId && this.itemKey) this.emit({ kind: "session", batchId: this.batchId, itemKey: this.itemKey });
		else if (key === "d") this.enter(this.view === "claim-detail" ? "claim-debug" : "debug");
		this.options.tui.requestRender();
	}
	private move(delta: number): void {
		if (this.view === "detail" || this.view === "help" || this.view === "claim-detail" || this.view === "evidence-detail" || this.view === "debug" || this.view === "claim-debug") { this.scroll = Math.max(0, this.scroll + delta); return; }
		if (this.view === "roster") {
			const items = this.project()?.items ?? [];
			const current = Math.max(0, items.findIndex((item) => item.key === this.itemKey));
			this.itemKey = items[Math.max(0, Math.min(items.length - 1, current + delta))]?.key;
			if (this.batchId !== undefined && this.itemKey !== undefined) this.itemKeysByBatch.set(this.batchId, this.itemKey);
		} else if (this.view === "batches") {
			this.batchIndex = Math.max(0, Math.min(this.source.batches.length - 1, this.batchIndex + delta));
			this.batchId = this.source.batches[this.batchIndex]?.id;
			this.reselect();
		} else {
			const count = this.view === "palette" ? this.choices().length : this.view === "evidence" ? this.evidenceChoices().length : this.relevantClaims().length;
			this.cursor = Math.max(0, Math.min(count - 1, this.cursor + delta));
			this.setCursorIdentity(undefined);
			this.syncCursor();
		}
	}
	private activate(): void {
		if (this.view === "roster") this.enter("detail");
		else if (this.view === "batches") this.enter("roster");
		else if (this.view === "palette") {
			const choice = this.choices()[this.cursor];
			if (choice && "view" in choice) this.enter(choice.view);
			else if (choice && "action" in choice) this.emit(choice.action);
		} else if (this.view === "evidence") {
			const entry = this.evidenceChoices()[this.cursor];
			if (entry?.path && this.batchId && this.itemKey) this.emit({ kind: "evidence-preview", batchId: this.batchId, itemKey: this.itemKey, path: entry.path });
			else if (entry?.text) { this.enter("evidence-detail"); }
		} else if (this.view === "claims") {
			if (this.relevantClaims()[this.cursor]) this.enter("claim-detail");
		}
	}
	private selectedClaim(): ReturnType<typeof this.relevantClaims>[number] | undefined { return this.relevantClaims()[this.cursor]; }
	private reconcileSelectedClaim(): void {
		const claim = this.selectedClaim();
		if (claim && this.claimCanReconcile(claim)) this.emit({ kind: "reconcile", resource: claim.resource, owner: claim.owner });
	}
	private batchControl(kind: "pause" | "resume" | "stop"): void {
		if (this.batchId && this.project()?.actions.includes(kind)) this.emit({ kind, batchId: this.batchId });
	}
	private openPR(): void {
		const item = this.item();
		if (this.batchId && item?.prUrl && item.actions.includes("open-pr")) this.emit({ kind: "open", batchId: this.batchId, itemKey: item.key, url: item.prUrl });
	}
	private primaryChoice(): Choice | undefined {
		const item = this.item(); if (!item || !this.batchId) return;
		const conflict = this.relevantClaims().find((claim) => item.claims.some((p) => p.conflict && p.resource === claim.resource && p.owner === claim.owner));
		if (conflict) return this.claimCanReconcile(conflict)
			? { label: "Reconcile ownership", action: { kind: "reconcile", resource: conflict.resource, owner: conflict.owner } }
			: { label: "Inspect owner", view: "claims" };
		if (this.mutationsAvailable() && item.actions.includes("reconcile")) return { label: "Reconcile effect", action: { kind: "reconcile-effect", batchId: this.batchId, itemKey: item.key } };
		if (this.mutationsAvailable() && item.actions.includes("retry") && ["BLOCKED", "UNKNOWN", "CANCELLED"].includes(item.stage)) return { label: "Retry", action: { kind: "retry", batchId: this.batchId, itemKey: item.key } };
		if (item.prUrl && item.actions.includes("open-pr")) return { label: "Open PR", action: { kind: "open", batchId: this.batchId, itemKey: item.key, url: item.prUrl } };
		if (item.stage === "DONE" && this.evidenceChoices().length) return { label: "Inspect evidence", view: "evidence" };
		if (item.actions.includes("view-session")) return { label: "View worker", action: { kind: "session", batchId: this.batchId, itemKey: item.key } };
		if (this.evidenceChoices().length) return { label: "Inspect evidence", view: "evidence" };
		if (this.mutationsAvailable() && this.project()?.actions.includes("resume")) return { label: "Resume", action: { kind: "resume", batchId: this.batchId } };
		return { label: "Inspect item", view: "detail" };
	}
	private primaryLabel(): string {
		const choice = this.primaryChoice(); if (!choice) return "";
		if ("view" in choice) return `${choice.view === "claims" ? "c" : choice.view === "evidence" ? "e" : "Enter"} ${choice.label}`;
		return `${choice.action.kind === "open" ? "o" : choice.action.kind === "resume" ? "p" : choice.action.kind === "session" ? "v" : "r"} ${choice.label}`;
	}
	private choices(): Choice[] {
		const item = this.item(); const batch = this.project();
		const primary = this.primaryChoice();
		const choices: Choice[] = [...(primary ? [primary] : []), { label: "Inspect item", view: "detail" }];
		if (item) {
			if (this.evidenceChoices().length) choices.push({ label: "Evidence and sessions", view: "evidence" });
			if (this.relevantClaims().length) choices.push({ label: "Claims / ownership", view: "claims" });
			if (this.batchId) {
				for (const action of item.actions) {
					if (this.mutationsAvailable() && action === "retry") choices.push({ label: "Retry", action: { kind: "retry", batchId: this.batchId, itemKey: item.key } });
					if (this.mutationsAvailable() && action === "reconcile") choices.push({ label: "Reconcile effect", action: { kind: "reconcile-effect", batchId: this.batchId, itemKey: item.key } });
					if (this.mutationsAvailable() && action === "exclude") choices.push({ label: "Remove from this run…", action: { kind: "exclude", batchId: this.batchId, itemKey: item.key } });
					if (action === "open-pr" && item.prUrl) choices.push({ label: "Open PR", action: { kind: "open", batchId: this.batchId, itemKey: item.key, url: item.prUrl } });
					if (action === "view-session") choices.push({ label: "View worker", action: { kind: "session", batchId: this.batchId, itemKey: item.key } });
					if (action === "open-workspace") choices.push({ label: "Show workspace", action: { kind: "workspace", batchId: this.batchId, itemKey: item.key } });
				}
			}
		}
		if (batch && this.batchId) for (const kind of batch.actions) {
			if (kind === "pause" || kind === "resume" || kind === "stop" || kind === "export" || kind === "discard") {
				const labels = { pause: "Pause run", resume: "Resume run", stop: "Stop run…", export: "Export evidence…", discard: "Archive run…" };
				if (this.mutationsAvailable() && !(kind === "discard" && (this.source.hasMoreHistory || Object.keys(this.source.evidenceWarnings ?? {}).some((key) => key.startsWith(`${this.batchId}:`))))) choices.push({ label: labels[kind], action: { kind, batchId: this.batchId } });
			}
		}
		if (this.source.hasMoreHistory && this.view === "palette") choices.push({ label: "Older runs", action: { kind: "older-runs" } });
		choices.push({ label: "Debug details", view: "debug" }, { label: "Help", view: "help" });
		const identity = (choice: Choice) => "view" in choice ? `view:${choice.view}` : `action:${choice.action.kind}`;
		return choices.filter((choice, i) => choices.findIndex((other) => identity(other) === identity(choice)) === i);
	}
	private relevantClaims(): readonly ResourceClaim[] {
		const item = this.item();
		if (!item) return this.source.claims;
		return this.source.claims.filter((claim) => claim.resource.toLowerCase() === `repo:${item.repo}` || claim.resource.toLowerCase() === `item:${item.key}`);
	}
	private claimInspection(): ReturnType<typeof inspectClaim> | undefined {
		const claim = this.selectedClaim();
		return claim === undefined ? undefined : inspectClaim(claim, this.source.batches, this.source.activeItemKeys ?? [], this.source.canReconcileClaims === true && this.mutationsAvailable());
	}
	private evidenceChoices(): EvidenceChoice[] {
		const item = this.item(); if (!item) return [];
		const entries: EvidenceChoice[] = [];
		const paths = new Set<string>();
		const add = (label: string, path: string): void => { if (!paths.has(path)) { paths.add(path); entries.push({ label, path }); } };
		for (const path of item.evidence) add(/\.patch$|\.diff$/.test(path) ? "Patch" : "Proof / worker result", path);
		for (const test of item.tests) if (test.artifact) add(`Test ${test.outcome}: ${test.command}`, test.artifact);
		for (const session of item.attemptHistory.flatMap((attempt) => attempt.sessions)) add(`${session.phase} session`, session.path);
		for (const session of item.sessions) add("Session", session);
		if (item.operations.length) entries.push({ label: "Operation receipts", text: item.operations.flatMap((op) => [`${op.phase}: ${op.state}`, `Receipt: ${op.id}`, `Owner: ${op.owner ?? "unknown"}`, `Attempt: ${op.attemptId ?? "unknown"}`, `Branch: ${op.branch ?? "unknown"}`, `Commit: ${op.sha ?? "unknown"}`, `Result: ${op.resultHandle ?? op.url ?? "unknown"}`]) });
		if (item.predicates.length) entries.push({ label: "Acceptance / predicate results", text: item.detail });
		if (this.batch()?.scopeRevisions.length) entries.push({ label: "Scope revisions", text: this.batch()!.scopeRevisions.map((revision) => `${revision.item}: ${revision.reason}`) });
		return entries;
	}
	private height(): number { return Math.max(6, this.options.rows ?? this.options.tui.terminal?.rows ?? 24); }
	private selectedRows(rows: readonly string[], selected: number, height: number): string[] {
		const start = Math.max(0, Math.min(selected - height + 1, Math.max(0, rows.length - height)));
		return rows.slice(start, start + height).map((row, index) => `${start + index === selected ? ">" : " "} ${row}`);
	}
	private textRows(lines: readonly string[], width: number, height: number): string[] {
		const rows = wrapped(lines, width);
		this.scroll = Math.min(this.scroll, Math.max(0, rows.length - height));
		return rows.slice(this.scroll, this.scroll + height);
	}
	private active(item: ProjectedItem): boolean { return this.source.activeItemKeys?.includes(item.key) === true && ["RUNNING", "VERIFY"].includes(item.stage); }
	private focusCard(width: number, height: number): string[] {
		const item = this.item(); if (!item) return [];
		const copy = itemOverview(item, this.active(item));
		const heading = copy.needsYou ? "NEEDS YOU" : item.stage === "DONE" ? "PROVEN" : this.active(item) ? "WORKING" : "SELECTED";
		const intro = [heading, `#${item.number} · ${copy.heading}`];
		const middle = wrapped(["", copy.explanation, "", `Next: ${copy.next}`], width);
		return [...intro.map((line) => truncateToWidth(line, width)), ...middle.slice(0, Math.max(0, height - 3)), truncateToWidth(`[${this.primaryLabel()}]`, width)];
	}
	private details(): string[] {
		const item = this.item(); const batch = this.batch();
		if (!item || !batch) return ["Select an item to inspect."];
		const copy = itemOverview(item, this.active(item));
		const selected = batch.items.find((entry) => entry.selected.key === item.key)!;
		return [
			`#${item.number} · ${itemTitle(batch, item)}`, item.repo, "", copy.heading, copy.explanation, `Next: ${copy.next}`, "", this.primaryLabel(), "",
			...(this.source.evidenceWarnings?.[`${batch.id}:${item.key}`] ? ["Evidence is unavailable. Recorded proof needs revalidation before this run can be archived.", ""] : []),
			"Acceptance", selected.selected.acceptance ?? "Use the captured issue's acceptance.", "",
			`Attempts: ${item.attempts} of ${item.maxAttempts}`, `Run limit: ${batch.capacity} workers at once`, `Proof: ${item.proof.current ? "recorded current for this revision" : item.proof.stage === "unknown" ? "not yet proven" : "awaiting owner acceptance"}`,
			...(item.dependencies.length ? ["", "Waiting for", ...item.dependencies.map((edge) => `${edge.satisfied ? "✓" : "○"} ${edge.requires} — ${edge.stage === "verified-patch" ? "verified patch" : edge.stage === "pr-ready" ? "PR ready" : "merged upstream"}`)] : []),
			...(item.operation ? ["", `Last operation: ${item.operation.phase} · ${item.operation.state}`] : []),
			...(batch.scopeRevisions.length ? ["", "Scope was changed. The original run is not complete."] : []),
			"", "d Debug details · e Evidence · a Actions",
		];
	}
	private debugDetails(): string[] {
		const item = this.item(); const batch = this.batch();
		return [
			`Batch: ${batch?.id ?? "unknown"}`, `State location: ${this.source.root ?? "unknown"}`, `Capacity: ${batch?.capacity ?? "unknown"}`,
			...(item?.detail ?? []),
			...(batch?.scopeRevisions.map((revision) => `Scope revision ${revision.item}: ${revision.reason} (${revision.at})`) ?? []),
			`Observed calls: ${batch?.usage.modelCalls ?? "unknown"}; input: ${batch?.usage.inputTokens ?? "unknown"}; output: ${batch?.usage.outputTokens ?? "unknown"}; cost: ${batch?.usage.cost ?? "unknown"}`,
			...(this.source.error ? [`Read error: ${this.source.error}`] : []),
			...Object.entries(this.source.evidenceWarnings ?? {}).map(([key, message]) => `Evidence unavailable ${key}: ${message}`),
		];
	}

	private help(): string[] {
		return [
			"/factory opens this dashboard. No global shortcut overrides your OMP bindings.",
			"j/k or arrows select; Enter opens; Tab switches roster/detail; q/Esc goes back or closes. Closing does not stop work.",
			"Enter: item inspector. d: exact IDs, paths, and debug evidence. v: worker session.",
			"a: safe actions for the selected state. b: retained batches. c: mutation ownership. e: evidence. o: recorded PR.",
			"p: pause/resume. x: stop with confirmation. r: eligible retry within original budgets.",
			"UNKNOWN push/PR effects require reconciliation, never blind retry. Reconciliation can contact GitHub; rendering cannot.",
			"Stop prevents new dispatch; it is not rollback. Exclude records a scope revision and prevents original-scope convergence.",
			"/factory start inspect|patch|pr-ready — submit the explicit Review selection.",
			"/factory status — retained batches; /factory inspect <batch> — item evidence and state.",
			"/factory pause <batch> | resume <batch> | stop <batch>",
			"/factory retry <batch> <item> — preserve lineage and original budgets.",
			"/factory exclude <batch> <item> <reason> — explicit scope revision.",
			"/factory claims status | claims reconcile <owner> <resource> — release only after authoritative settlement.",
			"/factory export <batch> <directory> — copy retained evidence to an unused destination.",
			"/factory discard <batch> — archive eligible settled receipts; retain workspaces and native logs.",
			"Workspace paths are shown/copied; they are not executed. Evidence/session previews are read-only and byte bounded.",
			"Private Factory workers stay outside Agent Hub. Recorded start/session identity is not proof of current liveness.",
			`State location: ${this.source.root ?? "unknown"}`,
			...(this.source.notice ? [`NOTICE: ${clean(this.source.notice)}`] : []),
			...(this.source.error ? [`STATE ERROR: ${this.source.error}`, "Original evidence preserved. Inspect the affected store; no automatic repair or deletion."] : []),
		];
	}
	private footer(width = 120): string {
		if (this.view === "roster") return this.item() ? "j/k Select   Enter Inspect   a Actions   b Runs   q Close" : this.source.batches.length ? "b Runs   ? Help   q Close" : this.source.claims.length ? "c Inspect ownership   ? Help   q Close" : "? Help   q Close";
		if (this.view === "batches") return this.source.hasMoreHistory ? "j/k Select   Enter Open   m Older   q Close" : "j/k Select   Enter Open   a Actions   q Close";
		if (this.view === "palette" || this.view === "evidence" || this.view === "claims") return "j/k Select   Enter Open   q Back";
		if (this.view === "claim-detail") return this.claimCanReconcile() ? "r Reconcile   j/k Scroll   d Debug   q Back" : "j/k Scroll   d Debug   q Back";
		if (this.view === "debug" || this.view === "claim-debug" || this.view === "help" || this.view === "evidence-detail") return "j/k Scroll   q Back";
		return width < 62 ? "j/k Scroll   a Actions   d Debug   q Back" : "j/k Scroll   a Actions   e Evidence   d Debug   q Back";
	}
	private ownerObservation(claim = this.selectedClaim()): ClaimOwnerObservation | undefined {
		return claim ? this.source.claimOwners?.find((owner) => owner.owner === claim.owner && owner.resource.toLowerCase() === claim.resource.toLowerCase()) : undefined;
	}
	private claimCanReconcile(claim = this.selectedClaim()): boolean {
		if (!claim || !this.mutationsAvailable() || this.source.canReconcileClaims !== true) return false;
		const observed = this.ownerObservation(claim);
		return observed ? observed.matches && observed.reconcileAvailable : claim.owner.startsWith("review:");
	}
	private humanClaimDetails(): string[] {
		const claim = this.selectedClaim(); const inspection = this.claimInspection(); const observed = this.ownerObservation();
		if (!claim || !inspection) return ["No ownership record selected."];
		const ownerLabel = claim.owner.startsWith("review:") ? "Review run" : inspection.batchId === this.batchId ? "This Factory run" : inspection.batchId ? "Another Factory run" : "Another run";
		const stopped = observed?.worker.coverageComplete && observed.worker.settled;
		const live = observed?.worker.runningJobIds?.length || inspection.liveness === "active";
		const beforeTools = observed?.coordinatorTerminal;
		const state = beforeTools ? "Stopped before work started" : live ? "Worker running" : stopped ? observed?.effectReconciliation === "settled" ? "Work settled" : "Worker stopped; effect needs checking" : claim.status === "settled" ? "Recorded settled; awaiting verification" : "Outcome unknown";
		const why = beforeTools ? "The coordinator stopped before any tool ran. Reconcile to check that no external effects need attention."
			: live ? "The owning worker is still running. Its repository stays protected until that work settles."
			: stopped ? "The worker has finished. Reconciliation must check what changed before ownership can be released."
			: observed?.missingWorkerReason ? this.humanWorkerReason(observed.missingWorkerReason)
			: "There isn't enough evidence to confirm that the owning work and its effects have settled.";
		const next = this.claimCanReconcile() ? "Reconcile to check the worker and its effects. Ownership will be released only if that check confirms it is safe."
			: observed?.matches === false ? "Reopen the owning Review session or restore its retained run evidence. This session cannot verify a missing run."
			: "Inspect the owning session and retained evidence. Reconciliation is not available for this owner in this session.";
		return [
			"Repository locked", claim.resource.replace(/^(repo|item):/, ""), "",
			`Owned by: ${ownerLabel}`, `State: ${state}`,
			...(observed?.itemKeys.length ? [`Work: ${observed.itemKeys.map((key) => `#${key.split("#").at(-1)}`).join(", ")}`] : inspection.itemKey ? [`Work: #${inspection.itemKey.split("#").at(-1)}`] : ["Work: not yet identified"]),
			...(observed?.kind ? [`Operation: ${observed.kind === "fix" ? "repairing selected work" : observed.kind === "slay" ? "reviewing and landing selected work" : "inspecting changes"}`] : inspection.operation ? [`Operation: ${inspection.operation.phase === "pr" ? "creating a pull request" : inspection.operation.phase === "push" ? "pushing a commit" : inspection.operation.phase}`] : ["Operation: not yet confirmed"]),
			"", "Why it stays locked", why, "", "Next safe action", next,
			"", ...(this.claimCanReconcile() ? ["[r Reconcile ownership]"] : []), "[d Debug details]",
			...(live ? ["To stop the owner, return to its Review session. This view cannot cancel a different session's worker."] : []),
		];
	}
	private humanWorkerReason(reason: string): string {
		if (/no matching.*record|no matching.*batch/.test(reason)) return "The ownership record survived, but the owning run's evidence could not be found.";
		if (/no.*identity|no persisted|missing or ambiguous|unavailable after/.test(reason)) return "A dispatched worker has no accounted final result. Reconciliation cannot safely assume that it stopped.";
		return "The worker is still running or its final result has not been confirmed.";
	}
	private rosterRows(width: number, height: number): string[] {
		const items = this.project()?.items ?? [];
		const rows: Array<{ key?: string; text: string }> = [];
		let repo: string | undefined;
		for (const item of items) {
			if (repo !== item.repo) { repo = item.repo; rows.push({ text: repo }); }
			const reason = clean(itemOverview(item, this.active(item)).caption);
			rows.push({ key: item.key, text: `${item.key === this.itemKey ? "›" : " "} ${item.glyph} ${fitToWidth(`#${item.number}`, 6)} ${fitToWidth(item.stage, 9)} ${reason}` });
		}
		const selected = rows.findIndex((row) => row.key === this.itemKey);
		const start = Math.max(0, selected - height + 1);
		return rows.slice(start, start + height).map((row) => truncateToWidth(row.text, width));
	}
	render(requestedWidth: number): string[] {
		const width = Math.max(1, Math.floor(requestedWidth)); const height = this.height(); const batch = this.project();
		const status = this.source.loading ? "Loading" : batch?.converged ? "Complete" : batch?.control === "active" ? "Active" : batch?.control === "paused" ? "Paused" : batch?.control === "stopped" ? "Stopped" : !batch && this.source.claims.length ? "Needs attention" : "Ready";
		const title = `${fitToWidth("Luna Factory", Math.max(0, width - visibleWidth(status) - 1))} ${status}`;
		const running = batch?.items.filter((item) => this.active(item)).length ?? 0;
		const needsYou = batch?.items.filter((item) => itemOverview(item, this.active(item)).needsYou).length ?? 0;
		const summary = this.source.loading ? "Opening your runs…" : batch ? `${running} running   ${batch.proven} proven   ${needsYou} need${needsYou === 1 ? "s" : ""} you${batch.inScope !== batch.total ? "   · scope changed" : ""}` : "";
		const header = [this.options.theme.bold(title), summary, ""];
		if (this.source.busy) header.splice(2, 0, "Action in progress…");
		else if (this.source.notice) header.splice(2, 0, truncateToWidth(clean(this.source.notice), width));
		else if (this.source.error) header.splice(2, 0, "Some saved work couldn't be read. Viewing only; ? has details.");
		if (this.readOnly() && !this.source.loading && !this.source.error) header.splice(2, 0, "Viewing only");
		const bodyHeight = Math.max(1, height - header.length - 2);
		let body: readonly string[];
		if (this.source.loading) body = ["Loading retained work…"];
		else if (this.source.error && !batch && this.view !== "help") body = ["Saved work needs attention", "", "Factory couldn't read this run. The original evidence is preserved.", "Open Help for the affected location and exact error."];
		else if (this.view === "debug") body = ["DEBUG", ...this.textRows(this.debugDetails(), width, bodyHeight - 1)];
		else if (this.view === "claim-debug") body = ["OWNERSHIP DEBUG", ...this.textRows([...(this.claimInspection()?.rows ?? []), ...(this.ownerObservation() ? [JSON.stringify(this.ownerObservation(), null, 2)] : [])], width, bodyHeight - 1)];
		else if (this.view === "evidence-detail") body = [this.evidenceChoices()[this.cursor]?.label ?? "Evidence", ...this.textRows(this.evidenceChoices()[this.cursor]?.text ?? ["This evidence is no longer available."], width, bodyHeight - 1)];
		else if (this.view === "claim-detail") body = this.textRows(this.humanClaimDetails(), width, bodyHeight);
		else if (this.view === "help") body = ["HELP", ...this.textRows(this.help(), width, bodyHeight - 1)];
		else if (this.view === "palette") body = [`Actions${this.item() ? ` for #${this.item()!.number}` : ""}`, "", ...this.selectedRows(this.choices().map((choice) => clean(choice.label)), this.cursor, bodyHeight - 2)];
		else if (this.view === "claims") {
			const claims = this.relevantClaims();
			body = ["Ownership", "", ...(claims.length ? this.selectedRows(claims.map((claim) => `${claim.resource.replace(/^(repo|item):/, "")} · ${claim.owner.startsWith("review:") ? "Review run" : "Factory run"} · ${claim.status === "settled" ? "settled" : "needs checking"}`), this.cursor, bodyHeight - 2) : ["No ownership is blocking this work."])];
		} else if (this.view === "evidence") {
			const entries = this.evidenceChoices();
			body = [`Evidence${this.item() ? ` for #${this.item()!.number}` : ""}`, "", ...(entries.length ? this.selectedRows(entries.map((entry) => entry.label), this.cursor, bodyHeight - 2) : ["No evidence has been recorded yet."])];
		} else if (this.view === "batches") {
			const visible = Math.max(1, Math.floor((bodyHeight - 2) / 2)); const start = Math.max(0, this.batchIndex - visible + 1);
			body = ["Recent runs", "", ...this.source.batches.slice(start, start + visible).flatMap((run, index) => {
				const projected = this.project(run)!;
				const ageMs = Date.now() - Date.parse(run.createdAt); const age = !Number.isFinite(ageMs) ? "date unknown" : ageMs < 3_600_000 ? `${Math.max(0, Math.floor(ageMs / 60_000))}m ago` : ageMs < 86_400_000 ? `${Math.floor(ageMs / 3_600_000)}h ago` : `${Math.floor(ageMs / 86_400_000)}d ago`;
				const repos = [...new Set(run.items.map((item) => item.selected.repo))];
				const label = run.items.every((item) => item.selected.action === "inspect") ? "Inspection" : run.items.some((item) => item.selected.action === "pr-ready") ? "PR work" : "Patch work";
				const needed = projected.items.filter((item) => itemOverview(item, this.active(item)).needsYou).length;
				return [`${start + index === this.batchIndex ? "›" : " "} ${label} · ${projected.converged ? "complete" : run.control} · ${age}`, `    ${repos.join(", ")} · ${projected.proven} proven${needed ? ` · ${needed} needs attention` : ""}${run.scopeRevisions.length ? " · scope changed" : ""}`];
			})];
		} else if (!batch && this.source.claims.length) body = [
			"Repository protected", "",
			...[...new Set(this.source.claims.map((claim) => claim.resource.replace(/^(repo|item):/, "").split("#")[0]))].slice(0, 3),
			"", ...wrapped(["Another run has retained ownership. Inspect it before starting work in that repository."], width),
			"", "[c Inspect ownership]",
		];
		else if (!batch) body = ["Ready when you are", "", "Select work in Review and press Shift+F.", "Your runs and evidence will appear here."];
		else if (this.view === "detail") body = this.textRows(this.details(), width, bodyHeight);
		else if (width >= 100) {
			const leftWidth = Math.floor((width - 3) / 2); const rightWidth = width - leftWidth - 3;
			const left = this.rosterRows(leftWidth, bodyHeight); const right = this.focusCard(rightWidth, bodyHeight);
			body = this.options.primitives?.splitPane?.(left, right, width) ?? Array.from({ length: Math.max(left.length, right.length) }, (_, i) => `${fitToWidth(left[i] ?? "", leftWidth)}   ${truncateToWidth(right[i] ?? "", rightWidth)}`);
		} else {
			const cardHeight = Math.min(11, Math.max(5, Math.floor(bodyHeight / 2))); const rosterHeight = Math.max(1, bodyHeight - cardHeight - 1);
			body = [...this.rosterRows(width, rosterHeight), "", ...this.focusCard(width, cardHeight)];
		}
		const bounded = body.slice(0, bodyHeight).map((line) => {
			// Preserve layout whitespace; collapse only untrusted fields before composition.
			const safe = truncateToWidth(stripVTControlCharacters(line).replace(/[\x00-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/g, ""), width);
			return safe.startsWith("›") || safe.startsWith(">") ? this.options.theme.bold(safe) : safe;
		});
		const panel = this.options.primitives?.panelRows?.("", bounded, width) ?? bounded;
		return [...header.map((line) => truncateToWidth(line, width)), ...panel.slice(0, bodyHeight), "", truncateToWidth(this.footer(width), width)].slice(0, height);
	}

	invalidate(): void {}
	dispose(): void { this.disposed = true; this.projections.clear(); this.batchById.clear(); }
}
