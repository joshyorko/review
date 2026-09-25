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
	assert.match(view.render(120).join("\n"), /FACTORY batch-aaaaaaaa/);
	assert.match(view.render(70).join("\n"), /ITEMS 2/);
	view.handleInput("Enter");
	assert.equal(actions.length, 0);
	assert.match(view.render(70).join("\n"), /DETAIL/);
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
	assert.match(frame, /No retained Factory batches/);
	assert.match(frame, /ledger unavailable/);
	assert.match(frame, /read-only/);
});

test("claims, evidence, help, palette and close are local views/actions", () => {
	const actions: FactoryDashboardAction[] = [];
	const view = dashboard(actions);
	view.handleInput("c"); assert.match(view.render(80).join("\n"), /CLAIMS/);
	view.handleInput("q"); assert.match(view.render(80).join("\n"), /FACTORY/);
	view.handleInput("?"); assert.match(view.render(80).join("\n"), /HELP/);
	view.handleInput("q"); view.handleInput("a"); assert.match(view.render(80).join("\n"), /ACTIONS/);
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
	assert.match(view.render(120).join("\n"), /0\/2 proven/);
	view.handleInput("b");
	assert.doesNotMatch(view.render(120).join("\n"), /1\/2 proven/);
});

test("roster follows selection and details scroll without moving the selected item", () => {
	const snapshot = source(); const batch = snapshot.batches[0]!;
	batch.items = Array.from({ length: 30 }, (_, i) => ({ ...structuredClone(batch.items[0]!), selected: { ...batch.items[0]!.selected, key: `acme/app#${i + 1}`, number: i + 1, acceptance: "acceptance ".repeat(100) } }));
	const view = makeView(snapshot);
	for (let i = 0; i < 20; i++) view.handleInput("j");
	assert.ok(view.render(70).some((row) => row.includes(`>`) && row.includes(view.selection.itemKey!)));
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
	const view = makeView(snapshot, actions); view.handleInput("a"); view.handleInput("Enter");
	assert.match(view.render(90).join("\n"), /DETAIL/); assert.equal(actions.length, 0);
	const readonly = makeView({ ...snapshot, readOnly: true }, actions); readonly.handleInput("a");
	assert.match(readonly.render(90).join("\n"), /Inspect/);
	readonly.handleInput("x"); readonly.handleInput("r"); readonly.handleInput("p");
	assert.equal(actions.length, 0);
});

test("evidence chooses the selected artifact and claims target the displayed owner", () => {
	const snapshot = source(); const item = snapshot.batches[0]!.items[0]!;
	item.sessions = ["/tmp/factory/one.jsonl", "/tmp/factory/two.jsonl"];
	const actions: FactoryDashboardAction[] = [];
	const view = makeView({ ...snapshot, claims: [
		{ resource: "repo:other/repo", owner: "other", createdAt: "now", status: "unknown" },
		{ resource: "repo:acme/app", owner: "displayed", createdAt: "now", status: "unknown" },
	] }, actions);
	view.handleInput("e"); view.handleInput("j"); view.handleInput("Enter");
	assert.equal(actions.at(-1)?.kind, "evidence-preview");
	assert.equal((actions.at(-1) as {path?:string}).path, "/tmp/factory/two.jsonl");
	view.handleInput("q"); view.handleInput("c"); view.handleInput("Enter");
	assert.deepEqual(actions.at(-1), { kind: "reconcile", resource: "repo:acme/app", owner: "displayed" });
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
	assert.match(view.render(120).join("\n"), /BATCHES/);
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
