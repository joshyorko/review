import assert from "node:assert/strict";
import test from "node:test";
import { createBatch } from "../image/extension/luna-factory/core/batch.ts";
import { dashboardActionAllowed } from "../image/extension/luna-factory/ui/actions.ts";
import type { FactoryDashboardSnapshot } from "../image/extension/luna-factory/ui/dashboard.ts";
const snapshot = (): FactoryDashboardSnapshot => ({ readOnly: false, claims: [], batches: [createBatch([
	{ key: "a/b#1", repo: "a/b", number: 1, action: "patch", kind: "pr", overlaps: [], url: "https://github.com/a/b/pull/1", base: "a", head: "a", acceptanceRevision: "r1" },
], { id: "batch-ab", capacity: 2, maxAttempts: 3, maxTotalAttempts: 3, mode: "retain" })] });
test("fresh dashboard action checks reject stale retry and missing subjects", () => {
	const state = snapshot(); const item = state.batches[0]!.items[0]!;
	item.stage = "BLOCKED";
	const action = { kind: "retry" as const, batchId: "batch-ab", itemKey: "a/b#1" };
	assert.equal(dashboardActionAllowed(action, state), true);
	item.stage = "DONE";
	assert.equal(dashboardActionAllowed(action, state), false);
	assert.equal(dashboardActionAllowed({ ...action, itemKey: "a/b#2" }, state), false);
});
test("read-only and corrupt snapshots prohibit all mutating controls but preserve navigation", () => {
	for (const state of [{ ...snapshot(), readOnly: true }, { ...snapshot(), error: "corrupt" }]) {
		const item = state.batches[0]!.items[0]!; item.workspace = "/state/work";
		assert.equal(dashboardActionAllowed({ kind: "resume", batchId: "batch-ab" }, state), false);
		assert.equal(dashboardActionAllowed({ kind: "workspace", batchId: "batch-ab", itemKey: "a/b#1" }, state), true);
		assert.equal(dashboardActionAllowed({ kind: "open", batchId: "batch-ab", itemKey: "a/b#1", url: item.selected.url! }, state), true);
	}
});
test("evidence and URL actions must still name authoritative recorded references", () => {
	const state = snapshot(); state.batches[0]!.items[0]!.sessions = ["/state/session.jsonl"];
	assert.equal(dashboardActionAllowed({ kind: "evidence-preview", batchId: "batch-ab", itemKey: "a/b#1", path: "/state/session.jsonl" }, state), true);
	assert.equal(dashboardActionAllowed({ kind: "evidence-preview", batchId: "batch-ab", itemKey: "a/b#1", path: "/state/unrelated.json" }, state), false);
	assert.equal(dashboardActionAllowed({ kind: "open", batchId: "batch-ab", itemKey: "a/b#1", url: "https://other.example/" }, state), false);
});
test("claim reconciliation must still match the captured resource and owner", () => {
	const state = { ...snapshot(), canReconcileClaims: true, claims: [{ resource: "repo:a/b", owner: "owner", status: "unknown" as const, createdAt: "now" }] };
	assert.equal(dashboardActionAllowed({ kind: "reconcile", resource: "repo:a/b", owner: "owner" }, state), true);
	assert.equal(dashboardActionAllowed({ kind: "reconcile", resource: "repo:a/b", owner: "stale-owner" }, state), false);
	assert.equal(dashboardActionAllowed({ kind: "reconcile", resource: "repo:a/b", owner: "owner" }, { ...state, canReconcileClaims: false }), false);
	assert.equal(dashboardActionAllowed({ kind: "reconcile", resource: "repo:a/b", owner: "owner" }, { ...state, readOnly: true }), false);
});
