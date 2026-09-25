import assert from "node:assert/strict";
import test from "node:test";
import { createBatch, type Batch } from "../image/extension/luna-factory/core/batch.ts";
import { FactoryDashboard, type FactoryDashboardAction, type FactoryDashboardSnapshot } from "../image/extension/luna-factory/ui/dashboard.ts";

const source = (): FactoryDashboardSnapshot => ({
	readOnly: false,
	root: "/tmp/factory",
	claims: [{ resource: "repo:acme/app", owner: "batch-a", createdAt: "now", status: "settled" }],
	batches: [{ ...createBatch([
		{ key: "acme/app#1", repo: "acme/app", number: 1, kind: "pr", action: "patch", overlaps: [], url: "https://github.com/acme/app/pull/1" },
		{ key: "acme/app#2", repo: "acme/app", number: 2, kind: "issue", action: "inspect", overlaps: [], blocker: "waiting" },
	], { id: "batch-aaaaaaaa", capacity: 2, maxAttempts: 3, maxTotalAttempts: 4, mode: "retain" }), control: "active" }],
});

function dashboard(actions: FactoryDashboardAction[] = []) {
	return new FactoryDashboard({ tui: { requestRender() {} }, theme: { fg: (_c, t) => t, bold: (t) => t, inverse: (t) => t }, done: (action) => actions.push(action), source: source(), rows: 14 });
}

test("dashboard renders wide and narrow layouts and emits typed controls", () => {
	const actions: FactoryDashboardAction[] = [];
	const view = dashboard(actions);
	assert.match(view.render(120).join("\n"), /Luna Factory/);
	assert.match(view.render(70).join("\n"), /#1/);
	view.handleInput("Enter");
	assert.equal(actions.length, 0);
	assert.match(view.render(70).join("\n"), /#1/);
	view.handleInput("o");
	assert.deepEqual(actions[0], { kind: "open", batchId: "batch-aaaaaaaa", itemKey: "acme/app#1", url: "https://github.com/acme/app/pull/1" });
});

test("live updates retain selection by stable keys", () => {
	const view = dashboard();
	view.handleInput("j");
	assert.equal(view.selection.itemKey, "acme/app#2");
	const next = source();
	const batch = next.batches[0]!;
	batch.items.reverse();
	view.setSource(next);
	assert.equal(view.selection.itemKey, "acme/app#2");
});

test("loading, empty, errors, and unknown values render honestly", () => {
	const view = new FactoryDashboard({ tui: { requestRender() {} }, theme: { fg: (_c, t) => t, bold: (t) => t, inverse: (t) => t }, done: () => {}, source: { batches: [], claims: [], readOnly: true, error: "ledger unavailable" }, rows: 10 });
	const frame = view.render(48).join("\n");
	assert.match(frame, /Saved work needs attention/);
	assert.match(frame, /Viewing only/i);
	view.handleInput("?"); for (let i = 0; i < 100; i++) view.handleInput("j");
	assert.match(view.render(48).join("\n"), /ledger unavailable/);
});

test("claims, evidence, help, palette and close are local views/actions", () => {
	const actions: FactoryDashboardAction[] = [];
	const view = dashboard(actions);
	view.handleInput("c"); assert.match(view.render(80).join("\n"), /Ownership/);
	view.handleInput("q"); assert.match(view.render(80).join("\n"), /Luna Factory/);
	view.handleInput("?"); assert.match(view.render(80).join("\n"), /HELP/);
	view.handleInput("q"); view.handleInput("a"); assert.match(view.render(80).join("\n"), /Actions/);
	view.handleInput("q"); view.handleInput("q");
	assert.deepEqual(actions.at(-1), { kind: "close" });
});


const plainTheme = { fg: (_c: string, text: string) => text, bold: (text: string) => text, inverse: (text: string) => text };
function makeView(snapshot: FactoryDashboardSnapshot, actions: FactoryDashboardAction[] = [], extra = {}) {
	return new FactoryDashboard({ tui: { requestRender() {} }, theme: plainTheme, done: (a) => actions.push(a), source: snapshot, rows: 12, ...extra });
}

test("stale DONE is never counted as proven in header or batch list", () => {
	const snapshot = source(); snapshot.batches[0]!.items[0]!.stage = "DONE";
	const view = makeView(snapshot);
	assert.match(view.render(120).join("\n"), /0 proven/);
	view.handleInput("b");
	assert.doesNotMatch(view.render(120).join("\n"), /1 proven/);
});

test("roster follows selection and details scroll without moving the selected item", () => {
	const snapshot = source(); const batch = snapshot.batches[0]!;
	batch.items = Array.from({ length: 30 }, (_, i) => ({ ...structuredClone(batch.items[0]!), selected: { ...batch.items[0]!.selected, key: `acme/app#${i + 1}`, number: i + 1, acceptance: "acceptance ".repeat(100) } }));
	const view = makeView(snapshot);
	for (let i = 0; i < 20; i++) view.handleInput("j");
	assert.ok(view.render(70).some((row) => row.includes(`›`) && row.includes(`#${view.selection.itemKey!.split("#")[1]}`)));
	view.handleInput("Enter"); const selected = view.selection.itemKey;
	const before = view.render(70).join("\n"); view.handleInput("j");
	assert.equal(view.selection.itemKey, selected);
	assert.notEqual(view.render(70).join("\n"), before);
});

test("batch picker opens exact selected batch and presentation restores focus", () => {
	const snapshot = source(); const second = structuredClone(snapshot.batches[0]!); second.id = "batch-bbbbbbbb";
	const combined = { ...snapshot, batches: [snapshot.batches[0]!, second] };
	const view = makeView(combined); view.handleInput("b"); view.handleInput("j"); view.handleInput("Enter");
	assert.equal(view.selection.batchId, second.id);
	view.handleInput("j");
	const restored = makeView(combined, [], { presentation: view.presentation });
	assert.deepEqual(restored.selection, view.selection);
	const focused = makeView(combined, [], { presentation: view.presentation, focusBatchId: snapshot.batches[0]!.id });
	assert.equal(focused.selection.batchId, snapshot.batches[0]!.id);
});

test("action palette is keyboard selectable and read-only inspection stays usable", () => {
	const actions: FactoryDashboardAction[] = []; const snapshot = source();
	const view = makeView(snapshot, actions); view.handleInput("a"); view.handleInput("j"); view.handleInput("Enter");
	assert.match(view.render(90).join("\n"), /#1/); assert.equal(actions.length, 0);
	const readonly = makeView({ ...snapshot, readOnly: true }, actions); readonly.handleInput("a");
	assert.match(readonly.render(90).join("\n"), /Inspect/);
	readonly.handleInput("x"); readonly.handleInput("r"); readonly.handleInput("p");
	assert.equal(actions.length, 0);
});

test("evidence chooses the selected artifact and claims target the displayed owner", () => {
	const snapshot = source(); const item = snapshot.batches[0]!.items[0]!;
	item.sessions = ["/tmp/factory/one.jsonl", "/tmp/factory/two.jsonl"];
	const actions: FactoryDashboardAction[] = [];
	const view = makeView({ ...snapshot, canReconcileClaims: true, claims: [
		{ resource: "repo:other/repo", owner: "other", createdAt: "now", status: "unknown" },
		{ resource: "repo:acme/app", owner: "review:displayed:0", createdAt: "now", status: "unknown" },
	] }, actions);
	view.handleInput("e"); view.handleInput("j"); view.handleInput("Enter");
	assert.equal(actions.at(-1)?.kind, "evidence-preview");
	assert.equal((actions.at(-1) as {path?:string}).path, "/tmp/factory/two.jsonl");
	view.handleInput("q"); view.handleInput("c"); view.handleInput("Enter");
	view.handleInput("r");
	assert.deepEqual(actions.at(-1), { kind: "reconcile", resource: "repo:acme/app", owner: "review:displayed:0" });
	const readonly = makeView({ ...snapshot, readOnly: true }, actions); const count = actions.length;
	readonly.handleInput("c"); readonly.handleInput("Enter"); assert.equal(actions.length, count);
});

test("loading and corrupt state fail closed with bounded terminal-safe rows", async () => {
	const { visibleWidth } = await import("../image/extension/bluefin-review/width.ts");
	const actions: FactoryDashboardAction[] = []; const snapshot = source();
	const loading = makeView({ ...snapshot, loading: true }, actions);
	assert.match(loading.render(40).join("\n"), /Loading/);
	const view = makeView({ ...snapshot, error: "bad store \x1b]52;c;attack\x07 界".repeat(20) }, actions);
	view.handleInput("x"); view.handleInput("p"); view.handleInput("r");
	assert.equal(actions.length, 0);
	for (const width of [28, 40, 70, 120]) {
		const rows = view.render(width); assert.ok(rows.length <= 12);
		assert.ok(rows.every((row) => visibleWidth(row) <= width));
		assert.ok(rows.every((row) => !row.includes("\x1b]")));
	}
});

test("large retained history projects only the visible viewport during navigation", () => {
	const base = source().batches[0]!; const accessed = new Set<number>();
	const batches = Array.from({ length: 500 }, (_, index) => {
		const batch = { ...base, id: `batch-${index.toString(16).padStart(8, "0")}`, control: "paused" as const };
		Object.defineProperty(batch, "items", { get() { accessed.add(index); return base.items; } });
		return batch;
	});
	const view = makeView({ batches, claims: [], readOnly: true });
	view.render(120); view.handleInput("j"); view.render(60);
	assert.ok(accessed.size < 20, `projected ${accessed.size} retained batches for a bounded viewport`);
	assert.match(view.render(120).join("\n"), /Recent runs/);
});

test("native panel and split primitives are exercised without widening rows", () => {
	let panels = 0; let splits = 0;
	const view = makeView(source(), [], { primitives: {
		panelRows: (_title: string, rows: string[]) => { panels++; return rows; },
		splitPane: (left: string[], right: string[]) => { splits++; return [...left, ...right]; },
	} });
	view.render(120); assert.equal(splits, 1); assert.equal(panels, 1);
	view.render(60); assert.equal(splits, 1); assert.equal(panels, 2);
});

test("claim Enter opens an inspector and reconciliation is advertised only when available", () => {
	const actions: FactoryDashboardAction[] = [];
	const snapshot = source();
	snapshot.canReconcileClaims = true;
	snapshot.claims = [{ resource: "repo:acme/app", owner: "review:batch-other:0", createdAt: "2026-09-25T10:00:00Z", status: "unknown" }];
	const view = makeView(snapshot, actions, { rows: 30 });
	view.handleInput("c");
	view.handleInput("Enter");
	assert.match(view.render(80).join("\n"), /Repository locked/);
	assert.match(view.render(80).join("\n"), /Next safe action/);
	assert.match(view.render(80).join("\n"), /reconcile/i);
	view.handleInput("r");
	assert.deepEqual(actions.at(-1), { kind: "reconcile", resource: "repo:acme/app", owner: "review:batch-other:0" });

	const unavailableActions: FactoryDashboardAction[] = [];
	const unavailable = makeView({ ...snapshot, canReconcileClaims: false }, unavailableActions);
	unavailable.handleInput("c");
	unavailable.handleInput("Enter");
	assert.doesNotMatch(unavailable.render(80).join("\n"), /r Reconcile/i);
	unavailable.handleInput("r");
	assert.equal(unavailableActions.length, 0);
});

test("batch and evidence cursors stay keyed to identities across switching and updates", () => {
	const snapshot = source();
	const actions: FactoryDashboardAction[] = [];
	const first = snapshot.batches[0]!;
	first.items[0]!.sessions = ["/evidence/a", "/evidence/b"];
	first.items[1]!.sessions = ["/evidence/a", "/evidence/b"];
	const second = structuredClone(first);
	second.id = "batch-bbbbbbbb";
	second.items[0]!.selected.key = "acme/app#1";
	second.items[1]!.selected.key = "acme/app#2";
	snapshot.batches = [first, second];
	const view = makeView(snapshot, actions);
	view.handleInput("j");
	assert.equal(view.selection.itemKey, "acme/app#2");
	view.handleInput("b");
	view.handleInput("j");
	view.handleInput("Enter");
	view.handleInput("j");
	assert.equal(view.selection.itemKey, "acme/app#2");
	view.handleInput("b");
	view.handleInput("k");
	view.handleInput("Enter");
	assert.equal(view.selection.itemKey, "acme/app#2");
	view.handleInput("e");
	view.handleInput("j");
	const refreshed = structuredClone(snapshot);
	refreshed.batches[0]!.items[0]!.sessions = ["/evidence/b", "/evidence/a"];
	view.setSource(refreshed);
	view.handleInput("Enter");
	assert.deepEqual(actions.at(-1), { kind: "evidence-preview", batchId: first.id, itemKey: "acme/app#2", path: "/evidence/b" });
});

test("empty dashboard footer exposes only contextual actions", () => {
	const view = makeView({ batches: [], claims: [], readOnly: true });
	const frame = view.render(80).join("\n");
	assert.match(frame, /\? Help.*q Close/);
	assert.doesNotMatch(frame, /e evidence/);
});

test("focused retained batch survives the loading snapshot before reconstruction", () => {
	const batch = source().batches[0]!;
	const view = makeView({ batches: [], claims: [], readOnly: true, loading: true }, [], { focusBatchId: batch.id, presentation: { batchId: batch.id, itemKey: "acme/app#2", view: "roster", scroll: 0 } });
	view.setSource({ batches: [batch], claims: [], readOnly: true });
	assert.deepEqual(view.selection, { batchId: batch.id, itemKey: "acme/app#2" });
});

test("async action handling keeps the dashboard open while close still uses done", async () => {
	const actions: FactoryDashboardAction[] = [];
	const closed: FactoryDashboardAction[] = [];
	const view = new FactoryDashboard({
		tui: { requestRender() {} },
		theme: plainTheme,
		done: (action) => closed.push(action),
		onAction: async (action) => { actions.push(action); },
		source: { ...source(), canReconcileClaims: true, claims: [{ resource: "repo:acme/app", owner: "review:owner:0", createdAt: "now", status: "unknown" }] },
		rows: 20,
	});
	view.handleInput("c"); view.handleInput("Enter"); view.handleInput("r");
	await Promise.resolve();
	assert.deepEqual(actions.at(-1), { kind: "reconcile", resource: "repo:acme/app", owner: "review:owner:0" });
	assert.equal(closed.length, 0);
	view.handleInput("q"); view.handleInput("q"); view.handleInput("q");
	assert.deepEqual(closed.at(-1), { kind: "close" });
});

test("busy snapshots keep navigation available and hide mutation controls", () => {
	const actions: FactoryDashboardAction[] = [];
	const view = makeView({ ...source(), busy: true, canReconcileClaims: true, claims: [{ resource: "repo:acme/app", owner: "review:owner:0", createdAt: "now", status: "unknown" }] }, actions, { rows: 20 });
	view.handleInput("c"); view.handleInput("Enter");
	assert.match(view.render(80).join("\n"), /Action in progress/i);
	assert.doesNotMatch(view.render(80).join("\n"), /reconcile/i);
	view.handleInput("r");
	assert.equal(actions.length, 0);
});

test("overview stays human while inspector and debug progressively disclose exact evidence", () => {
	const snapshot = source(); const b = snapshot.batches[0]!; const item = b.items[0]!;
	item.stage = "BLOCKED"; item.blocker = "auth expired; refresh operator credentials";
	item.selected.base = "a".repeat(40); item.selected.head = "b".repeat(40);
	item.workspace = "/private/workspaces/fixture";
	const view = makeView({ ...snapshot, claims: [] }, [], { rows: 32 });
	for (const width of [60, 120]) {
		const overview = view.render(width).join("\n");
		assert.match(overview, /Luna Factory/); assert.match(overview, /NEEDS YOU/); assert.match(overview, /Reconnect GitHub/);
		assert.doesNotMatch(overview, /batch-aaaaaaaa|private\/workspaces|aaaaaaaaaaaaaaaa|bbbbbbbbbbbbbbbb|model: unknown|cost:/);
		assert.match(overview, /\[r Retry\]/);
	}
	view.handleInput("Enter"); const inspector = view.render(120).join("\n");
	assert.match(inspector, /Acceptance|Attempts/); assert.doesNotMatch(inspector, /aaaaaaaaaaaaaaaa|private\/workspaces/);
	view.handleInput("d"); const debug = view.render(120).join("\n");
	assert.match(debug, /batch-aaaaaaaa/); assert.match(debug, /aaaaaaaaaaaaaaaa/); assert.match(debug, /private\/workspaces/);
});

test("overview preserves the native split's column spacing", () => {
	const view = makeView(source(), [], { rows: 30, primitives: { splitPane: () => ["left                       right"] } });
	assert.ok(view.render(120).includes("left                       right"));
});

test("older runs are discoverable without batch IDs and unavailable when history is complete", () => {
	const actions: FactoryDashboardAction[] = [];
	const view = makeView({ ...source(), hasMoreHistory: true }, actions);
	view.handleInput("b"); assert.match(view.render(100).join("\n"), /m Older/);
	view.handleInput("m"); assert.deepEqual(actions.at(-1), { kind: "older-runs" });
	view.setSource({ ...source(), hasMoreHistory: false }); const count = actions.length;
	view.handleInput("m"); assert.equal(actions.length, count);
});

test("inline evidence opens its text and returns to the evidence list", () => {
 const snapshot = source();
 snapshot.batches[0]!.scopeRevisions.push({ item: "acme/app#1", reason: "Operator deferred the migration", at: "2026-09-25T00:00:00Z" });
 const view = makeView(snapshot);
 view.handleInput("e");
 assert.match(view.render(80).join("\n"), /Scope revisions/);
 view.handleInput("Enter");
 assert.match(view.render(80).join("\n"), /Operator deferred the migration/);
 view.handleInput("q");
 assert.match(view.render(80).join("\n"), /Scope revisions/);
 assert.doesNotMatch(view.render(80).join("\n"), /Operator deferred the migration/);
});

test("retained ownership is actionable when no Factory batch exists", () => {
 const view = makeView({ ...source(), batches: [] });
 for (const width of [120, 60]) {
  const frame = view.render(width).join("\n");
  assert.match(frame, /Needs attention/);
  assert.match(frame, /Repository protected/);
  assert.match(frame, /acme\/app/);
  assert.match(frame, /c Inspect ownership/);
  assert.doesNotMatch(frame, /Ready when you are/);
 }
 view.handleInput("c");
 view.handleInput("Enter");
 assert.match(view.render(80).join("\n"), /Repository locked/);
 assert.doesNotMatch(view.render(80).join("\n"), /e Inspect evidence/);
});
