import { stripVTControlCharacters } from "node:util";
import type { Batch } from "../core/batch.ts";
import type { ResourceClaim } from "../omp/batch-store.ts";
import { fitToWidth, truncateToWidth, visibleWidth } from "../../bluefin-review/width.ts";
import { canonicalKey, rawKeyMatcher, type KeyMatcher } from "../../bluefin-review/keys.ts";
import { projectBatch, type ProjectedBatch, type ProjectedItem } from "./projection.ts";

export interface FactoryDashboardSnapshot {
	readonly batches: readonly Batch[];
	readonly claims: readonly ResourceClaim[];
	readonly root?: string;
	readonly error?: string;
	readonly loading?: boolean;
	readonly activeItemKeys?: readonly string[];
	readonly readOnly: boolean;
}
export type FactoryDashboardAction =
	| { kind: "close" }
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
type View = "roster" | "detail" | "batches" | "claims" | "evidence" | "help" | "palette" | "evidence-detail";
export interface FactoryDashboardPresentation {
	readonly batchId?: string;
	readonly itemKey?: string;
	readonly view: View;
	readonly scroll: number;
	readonly cursor?: number;
}
export interface FactoryDashboardOptions {
	readonly tui: { requestRender(): void; terminal?: { rows?: number } };
	readonly theme: FactoryDashboardTheme;
	readonly done: (action: FactoryDashboardAction) => void;
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
			const part = truncateToWidth(line, width, "");
			if (!part) break;
			result.push(part); line = line.slice(part.length);
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
	private disposed = false;
	private readonly options: FactoryDashboardOptions;
	private readonly projections = new Map<string, ProjectedBatch>();
	private readonly batchById = new Map<string, Batch>();
	private batchIndex = 0;
	constructor(options: FactoryDashboardOptions) {
		this.options = options;
		this.source = options.source ?? EMPTY;
		this.batchId = options.focusBatchId ?? options.presentation?.batchId;
		this.itemKey = options.focusBatchId ? undefined : options.presentation?.itemKey;
		this.view = options.focusBatchId ? "roster" : options.presentation?.view ?? "roster";
		this.scroll = options.presentation?.scroll ?? 0;
		this.cursor = options.presentation?.cursor ?? 0;
		this.indexBatches();
		this.reselect();
		if (!options.presentation && !options.focusBatchId && this.source.batches.length && !this.source.batches.some((b) => b.control === "active")) this.view = "batches";
	}
	get selection(): { batchId?: string; itemKey?: string } { return { batchId: this.batchId, itemKey: this.itemKey }; }
	get presentation(): FactoryDashboardPresentation { return { ...this.selection, view: this.view, scroll: this.scroll, cursor: this.cursor }; }
	setSource(source: FactoryDashboardSnapshot): void {
		if (this.disposed) return;
		this.source = source; this.projections.clear(); this.indexBatches(); this.reselect(); this.options.tui.requestRender();
	}
	update(source: FactoryDashboardSnapshot): void { this.setSource(source); }
	private readOnly(): boolean { return this.source.readOnly || Boolean(this.source.error) || this.source.loading === true; }
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
		if (!this.batch()) this.batchId = this.source.batches.find((b) => b.control === "active")?.id ?? this.source.batches[0]?.id;
		this.batchIndex = Math.max(0, this.source.batches.findIndex((b) => b.id === this.batchId));
		const items = this.project()?.items ?? [];
		if (!items.some((item) => item.key === this.itemKey)) this.itemKey = items[0]?.key;
		this.cursor = Math.max(0, this.cursor);
	}
	private enter(view: View): void { this.view = view; this.scroll = 0; this.cursor = 0; }
	private emit(action: FactoryDashboardAction): void { if (!this.disposed) this.options.done(action); }
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
			else this.enter("roster");
		} else if (key === "j" || key === "down") this.move(1);
		else if (key === "k" || key === "up") this.move(-1);
		else if (key === "return") this.activate();
		else if (key === "tab") this.enter(this.view === "detail" ? "roster" : "detail");
		else if (key === "a") this.enter("palette");
		else if (key === "b") this.enter("batches");
		else if (key === "e") this.enter("evidence");
		else if (key === "c") this.enter("claims");
		else if (key === "?") this.enter(this.view === "help" ? "roster" : "help");
		else if (key === "p") this.batchControl(this.batch()?.control === "active" ? "pause" : "resume");
		else if (key === "x") this.batchControl("stop");
		else if (key === "r" && this.item()?.actions.includes("retry") && this.batchId && this.itemKey) this.emit({ kind: "retry", batchId: this.batchId, itemKey: this.itemKey });
		else if (key === "o") this.openPR();
		else if (key === "d" && this.view === "batches" && this.project()?.actions.includes("discard") && this.batchId) this.emit({ kind: "discard", batchId: this.batchId });
		this.options.tui.requestRender();
	}
	private move(delta: number): void {
		if (this.view === "detail" || this.view === "help" || this.view === "evidence-detail") { this.scroll = Math.max(0, this.scroll + delta); return; }
		if (this.view === "roster") {
			const items = this.project()?.items ?? [];
			const current = Math.max(0, items.findIndex((item) => item.key === this.itemKey));
			this.itemKey = items[Math.max(0, Math.min(items.length - 1, current + delta))]?.key;
		} else if (this.view === "batches") {
			this.batchIndex = Math.max(0, Math.min(this.source.batches.length - 1, this.batchIndex + delta));
			this.batchId = this.source.batches[this.batchIndex]?.id;
			this.itemKey = this.project()?.items[0]?.key;
		} else {
			const count = this.view === "palette" ? this.choices().length : this.view === "evidence" ? this.evidenceChoices().length : this.relevantClaims().length;
			this.cursor = Math.max(0, Math.min(count - 1, this.cursor + delta));
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
			else if (entry?.text) { this.view = "evidence-detail"; this.scroll = 0; }
		} else if (this.view === "claims" && !this.readOnly()) {
			const claim = this.relevantClaims()[this.cursor];
			if (claim) this.emit({ kind: "reconcile", resource: claim.resource, owner: claim.owner });
		}
	}
	private batchControl(kind: "pause" | "resume" | "stop"): void {
		if (this.batchId && this.project()?.actions.includes(kind)) this.emit({ kind, batchId: this.batchId });
	}
	private openPR(): void {
		const item = this.item();
		if (this.batchId && item?.prUrl && item.actions.includes("open-pr")) this.emit({ kind: "open", batchId: this.batchId, itemKey: item.key, url: item.prUrl });
	}
	private choices(): Choice[] {
		const item = this.item(); const batch = this.project();
		const choices: Choice[] = [{ label: "Inspect evidence and detail", view: "detail" }];
		if (item) {
			choices.push({ label: "Evidence and sessions", view: "evidence" }, { label: "Claims / ownership", view: "claims" });
			if (this.batchId) {
				for (const action of item.actions) {
					if (action === "retry") choices.push({ label: "Retry within original budget…", action: { kind: "retry", batchId: this.batchId, itemKey: item.key } });
					if (action === "reconcile") choices.push({ label: "Reconcile external effect…", action: { kind: "reconcile-effect", batchId: this.batchId, itemKey: item.key } });
					if (action === "exclude") choices.push({ label: "Exclude from scope…", action: { kind: "exclude", batchId: this.batchId, itemKey: item.key } });
					if (action === "open-pr" && item.prUrl) choices.push({ label: "Open / copy PR", action: { kind: "open", batchId: this.batchId, itemKey: item.key, url: item.prUrl } });
					if (action === "open-workspace") choices.push({ label: "Show / copy workspace", action: { kind: "workspace", batchId: this.batchId, itemKey: item.key } });
				}
			}
		}
		if (batch && this.batchId) for (const kind of batch.actions) {
			if (kind === "pause" || kind === "resume" || kind === "stop" || kind === "export" || kind === "discard") {
				const labels = { pause: "Pause new dispatch", resume: "Resume batch…", stop: "Stop batch…", export: "Export evidence…", discard: "Discard retained batch…" };
				choices.push({ label: labels[kind], action: { kind, batchId: this.batchId } });
			}
		}
		choices.push({ label: "Factory help", view: "help" });
		return choices;
	}
	private relevantClaims(): readonly ResourceClaim[] {
		const item = this.item();
		if (!item) return this.source.claims;
		return this.source.claims.filter((claim) => claim.resource.toLowerCase() === `repo:${item.repo}` || claim.resource.toLowerCase() === `item:${item.key}`);
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
		if (item.operations.length) entries.push({ label: "Operation receipts", text: item.operations.map((op) => `${op.phase}: ${op.state} ${op.id}`) });
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
	private details(): string[] {
		const item = this.item(); const batch = this.batch();
		if (!item || !batch) return ["Select an item to inspect its evidence."];
		return [
			`State: ${item.stage} · ${item.key}`,
			`Execution liveness: ${item.executionLiveness}`,
			...(item.blocker ? [`BLOCKER: ${item.blocker}`] : []),
			`NEXT SAFE ACTION: ${item.nextSafeAction}`,
			...item.detail,
			...batch.scopeRevisions.map((revision) => `Scope revision ${revision.item}: ${revision.reason} (${revision.at})`),
			`State location: ${this.source.root ?? "unknown"}`,
			`Observed model calls: ${batch.usage.modelCalls}; input tokens: ${batch.usage.inputTokens ?? "unknown"}; output tokens: ${batch.usage.outputTokens ?? "unknown"}; cost: ${batch.usage.cost ?? "unknown"}`,
		];
	}
	private help(): string[] {
		return [
			"/factory opens this dashboard. No global shortcut overrides your OMP bindings.",
			"j/k or arrows select; Enter opens; Tab switches roster/detail; q/Esc goes back or closes. Closing does not stop work.",
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
			...(this.source.error ? [`STATE ERROR: ${this.source.error}`, "Original evidence preserved. Inspect the affected store; no automatic repair or deletion."] : []),
		];
	}
	private footer(width = 120): string {
		if (width < 62) return this.view === "roster" || this.view === "batches" ? "j/k · Enter · a · ? · q" : "j/k · Enter · q back";
		if (this.view === "detail" || this.view === "help" || this.view === "evidence-detail") return "j/k scroll · Tab roster · ? help · q back";
		if (this.view === "palette" || this.view === "evidence") return "j/k select · Enter open · q back";
		if (this.view === "claims") return `j/k select${this.readOnly() ? "" : " · Enter reconcile…"} · q back`;
		if (this.view === "batches") return "j/k batches · Enter open · a actions · ? help · q close";
		const pause = this.project()?.actions.find((a) => a === "pause" || a === "resume");
		return `j/k move · Enter detail · a actions · e evidence${pause ? ` · p ${pause}` : ""} · b batches · ? help · q close`;
	}
	render(requestedWidth: number): string[] {
		const width = Math.max(1, Math.floor(requestedWidth)); const height = this.height();
		const batch = this.project();
		const shortId = this.batchId && this.batchId.length > 20 ? `${this.batchId.slice(0, 17)}…` : this.batchId;
		const title = `FACTORY ${shortId ?? "—"} · ${batch?.converged ? "CONVERGED" : batch?.control ?? "idle"}`;
		const summary = batch ? `${batch.proven}/${batch.total} proven · ${batch.running} recorded RUNNING · ${batch.blocked} blocked · ${batch.unknown} unknown · cap ${batch.capacity}` : "No retained Factory batches";
		const header = [this.options.theme.bold(this.options.theme.fg(batch?.converged ? "success" : "accent", clean(title))), summary, this.readOnly() ? "read-only · /factory · ? help" : "/factory · ? help"];
		const bodyHeight = Math.max(1, height - header.length - 1);
		let body: readonly string[];
		if (this.source.loading) body = ["Loading retained Factory state…"];
		else if (this.source.error && this.view !== "help") body = this.textRows([`STATE ERROR: ${this.source.error}`, "Original evidence preserved; controls disabled. ? shows full error and help."], width, bodyHeight);
		else if (this.view === "evidence-detail") body = [this.evidenceChoices()[this.cursor]?.label ?? "EVIDENCE", ...this.textRows(this.evidenceChoices()[this.cursor]?.text ?? ["Evidence reference no longer available."], width, bodyHeight - 1)];
		else if (this.view === "help") body = ["HELP", ...this.textRows(this.help(), width, bodyHeight - 1)];
		else if (this.view === "palette") body = ["ACTIONS", ...this.selectedRows(this.choices().map((c) => clean(c.label)), this.cursor, bodyHeight - 1)];
		else if (this.view === "claims") {
			const claims = this.relevantClaims();
			body = ["CLAIMS / MUTATION OWNERSHIP", ...this.selectedRows(claims.map((c) => `${c.resource} · owner ${c.owner} · ${c.status} · since ${c.createdAt}`), this.cursor, Math.max(1, bodyHeight - 3)), "Release requires authoritative worker/effect settlement.", "Unknown ownership must not be deleted or blindly released."];
		} else if (this.view === "evidence") {
			const entries = this.evidenceChoices();
			body = ["EVIDENCE", ...(entries.length ? this.selectedRows(entries.map((e) => `${e.label}${e.path ? ` · ${e.path}` : ""}`), this.cursor, bodyHeight - 1) : ["No retained evidence recorded."])];
		} else if (this.view === "batches") {
			const selected = this.batchIndex;
			const visible = Math.max(1, Math.floor((bodyHeight - 1) / 2));
			const start = Math.max(0, selected - visible + 1);
			const rows = this.source.batches.slice(start, start + visible).flatMap((b, i) => {
				const p = this.project(b)!;
				const elapsed = Date.now() - Date.parse(b.createdAt);
				const age = Number.isFinite(elapsed) && elapsed >= 0 ? (elapsed < 3_600_000 ? `${Math.floor(elapsed / 60_000)}m` : elapsed < 86_400_000 ? `${Math.floor(elapsed / 3_600_000)}h` : `${Math.floor(elapsed / 86_400_000)}d`) : "unknown age";
				const id = b.id.length > 20 ? `${b.id.slice(0, 17)}…` : b.id;
				const blocker = p.items.find((item) => item.blocker)?.blocker;
				return [
					`${start + i === selected ? ">" : " "} ${id} ${p.converged ? "CONVERGED" : b.control} · ${p.proven}/${p.total} proven · ${p.running} RUNNING · ${p.blocked} blocked · ${p.unknown} UNKNOWN · cap ${b.capacity} · ${age}`,
					`  ${[...new Set(b.items.map((item) => item.selected.action))].join("/")} · ${[...new Set(b.items.map((item) => item.selected.repo))].join(", ")}${blocker ? ` · ${blocker}` : ""}`,
				];
			});
			body = ["BATCHES · retained history", ...rows];
		} else if (!batch) body = ["No retained Factory batches.", "Select work in Review and press Shift+F,", "or use /factory start inspect|patch|pr-ready."];
		else if (this.view === "detail") body = ["DETAIL", ...this.textRows(this.details(), width, bodyHeight - 1)];
		else {
			const split = width >= 100; const leftWidth = split ? Math.floor((width - 3) / 2) : width;
			const index = batch.items.findIndex((i) => i.key === this.itemKey);
			const roster = [`ITEMS ${batch.total}`, ...this.selectedRows(batch.items.map((item) => `${item.glyph} ${item.key} ${item.stage} ${item.blocker ?? item.nextSafeAction}`), index, bodyHeight - 1)];
			const left = roster.map((line) => truncateToWidth(clean(line), leftWidth));
			if (split) {
				const rightWidth = width - leftWidth - 3;
				const right = ["DETAIL", ...wrapped(this.details(), rightWidth).slice(0, bodyHeight - 1)];
				body = this.options.primitives?.splitPane?.(left, right, width) ?? Array.from({ length: Math.max(left.length, right.length) }, (_, i) => `${fitToWidth(left[i] ?? "", leftWidth)} │ ${truncateToWidth(right[i] ?? "", rightWidth)}`);
			} else body = left;
		}
		const bounded = body.slice(0, bodyHeight).map((line) => {
			const safe = truncateToWidth(clean(line), width);
			return safe.startsWith(">") ? this.options.theme.bold(safe) : safe;
		});
		const panel = this.options.primitives?.panelRows?.("", bounded, width) ?? bounded;
		return [...header.map((line) => truncateToWidth(line, width)), ...panel.slice(0, bodyHeight), truncateToWidth(this.footer(width), width)].slice(0, height);
	}
	invalidate(): void {}
	dispose(): void { this.disposed = true; this.projections.clear(); this.batchById.clear(); }
}
