import assert from "node:assert/strict";
import test from "node:test";
import {
	createBatch,
	type Batch,
	type BatchItem,
	type SelectedItem,
} from "../image/extension/luna-factory/core/batch.ts";
import type { AttemptId, EvidenceReceipt, TaskId } from "../image/extension/luna-factory/core/model.ts";
import { projectBatch, projectItem } from "../image/extension/luna-factory/ui/projection.ts";

const selected = (key: string, action: SelectedItem["action"] = "patch", extra: Partial<SelectedItem> = {}): SelectedItem => {
	const match = /^([^#]+)#(\d+)$/.exec(key);
	if (!match) throw new Error(`invalid selected identity ${key}`);
	const repo = match[1]!.toLowerCase();
	const number = Number(match[2]);
	return {
		key: `${repo}#${number}`,
		repo,
		number,
		kind: "issue",
		action,
		overlaps: [],
		acceptanceRevision: "r1",
		base: "a".repeat(40),
		head: "a".repeat(40),
		...extra,
	};
};

const makeBatch = (items: SelectedItem[], extra: Partial<Parameters<typeof createBatch>[1]> = {}): Batch =>
	createBatch(items, {
		id: "batch-projection",
		capacity: 2,
		maxAttempts: 3,
		maxTotalAttempts: 10,
		mode: "retain",
		...extra,
	});

function prove(item: BatchItem, stage: "verified-patch" | "pr-ready" = "verified-patch"): void {
	const taskId = "T1" as TaskId;
	const attemptId = "T1-a1" as AttemptId;
	const criterion = item.ledger.criteria[0]!;
	const receipt: EvidenceReceipt = {
		version: 2,
		taskId,
		attemptId,
		generation: item.ledger.generation,
		subject: item.ledger.subject,
		result: "verified",
		changed: ["src/change.ts"],
		evidence: ["/factory/evidence/test.log"],
		tests: [{ command: "npm test", outcome: "pass", artifact: "/factory/evidence/test.log" }],
		cleanEnvironment: true,
		unresolved: [],
		next: "",
		confidence: "high",
		routing: { requested: "lf-worker", verified: false },
		exitCode: 0,
		aborted: false,
		truncated: false,
		assumptions: criterion.assumptions ?? [],
		predicates: [
			{ phase: "verification", item: "npm test", ok: true, note: "exit 0" },
			{ phase: "acceptance", item: "acceptance", ok: true, note: "reviewed" },
		],
	};
	item.ledger = {
		...item.ledger,
		tasks: [{
			id: taskId,
			generation: item.ledger.generation,
			criterionId: criterion.id,
			title: item.selected.key,
			deps: [],
			effect: "write",
			owner: item.ledger.runId,
			state: "DONE",
			attempts: [{
				id: attemptId,
				lineage: 1,
				taskId,
				generation: item.ledger.generation,
				subject: item.ledger.subject,
				state: "returned",
				nativeJobIds: ["job-1"],
				nativeAgentIds: ["agent-1"],
				privateSessions: [{ phase: "worker", sessionFile: "/factory/sessions/worker.jsonl", started: true }],
				receipt,
				integrated: true,
			}],
			decision: "ADMIT",
			decisionReason: "selected",
		}],
	};
	item.attempts = 1;
	item.stage = "DONE";
	item.proof = {
		acceptanceRevision: item.selected.acceptanceRevision!,
		subject: item.selected.head!,
		tree: "tree-1",
		digest: "digest-1",
		artifacts: ["/factory/evidence/test.log"],
		stage,
		reviewerSession: "/factory/sessions/reviewer.jsonl",
	};
}

test("empty batches project without inventing progress or usage", () => {
	const batch = makeBatch([selected("org/a#1")]);
	batch.items.length = 0;
	const projection = projectBatch(batch);
	assert.equal(projection.total, 0);
	assert.equal(projection.proven, 0);
	assert.equal(projection.converged, false);
	assert.equal(projection.items.length, 0);
	assert.equal(projection.usage.inputTokens, "unknown");
	assert.equal(projection.usage.cost, "unknown");
});

test("projection keeps stable key order and reports observed running identities", () => {
	const batch = makeBatch([selected("org/z#2"), selected("org/a#1")]);
	const running = batch.items.find((item) => item.selected.key === "org/z#2")!;
	running.stage = "RUNNING";
	running.attempts = 1;
	running.ledger = {
		...running.ledger,
		tasks: [{
			id: "T1", generation: running.ledger.generation, criterionId: "A1", title: "running", deps: [], effect: "write", owner: batch.id,
			state: "RUNNING", decision: "ADMIT", decisionReason: "selected", attempts: [{
				id: "T1-a1", lineage: 1, taskId: "T1", generation: running.ledger.generation, subject: running.ledger.subject,
				state: "started", nativeJobIds: ["job-1"], nativeAgentIds: ["agent-1"], privateSessions: [{ phase: "worker", sessionFile: "/s/worker.jsonl", started: true }], integrated: false,
			}],
		}],
	};
	const projection = projectBatch(batch);
	assert.deepEqual(projection.items.map((item) => item.key), ["org/a#1", "org/z#2"]);
	assert.equal(projection.running, 1);
	assert.match(projection.items[1]!.detail.join("\n"), /agent-1/);
});

test("mixed retained ten-item batches preserve every terminal state and honest counts", () => {
	const batch = makeBatch(Array.from({ length: 10 }, (_, index) => selected(`org/repo-${index % 5}#${index + 1}`)));
	prove(batch.items[0]!);
	batch.items[1]!.stage = "RUNNING";
	batch.items[2]!.stage = "VERIFY";
	batch.items[3]!.stage = "QUEUED";
	batch.items[4]!.stage = "BLOCKED";
	batch.items[4]!.blocker = "auth expired";
	batch.items[5]!.stage = "UNKNOWN";
	batch.items[5]!.blocker = "effect requires reconciliation";
	batch.items[6]!.stage = "CANCELLED";
	batch.items[7]!.stage = "EXCLUDED";
	const projection = projectBatch(JSON.parse(JSON.stringify(batch)) as Batch);
	assert.equal(projection.total, 10);
	assert.equal(projection.proven, 1);
	assert.equal(projection.running, 1);
	assert.equal(projection.blocked, 1);
	assert.equal(projection.unknown, 1);
	assert.deepEqual(new Set(projection.items.map((item) => item.stage)), new Set(["DONE", "RUNNING", "VERIFY", "QUEUED", "BLOCKED", "UNKNOWN", "CANCELLED", "EXCLUDED"]));
	assert.match(projection.items.find((item) => item.key === "org/repo-4#5")!.nextSafeAction, /auth|retry/i);
});

test("DONE with stale proof projects as UNKNOWN and never offers retry", () => {
	const batch = makeBatch([selected("org/a#1")]);
	prove(batch.items[0]!);
	batch.items[0]!.selected.acceptanceRevision = "r2";
	const item = projectItem(batch, batch.items[0]!);
	assert.equal(item.stage, "UNKNOWN");
	assert.equal(item.proof.current, false);
	assert.equal(item.actions.includes("retry"), false);
	assert.match(item.nextSafeAction, /reverify|inspect|proof/i);
});

test("dependency blockers and scope revisions remain visible and prevent convergence", () => {
	const batch = makeBatch([selected("org/a#1"), selected("org/b#2")], {
		dependencies: [{ item: "org/b#2", requires: "org/a#1", stage: "pr-ready" }],
	});
	prove(batch.items[0]!, "verified-patch");
	batch.items[1]!.stage = "BLOCKED";
	batch.items[1]!.blocker = "waiting on dependency";
	const item = projectItem(batch, batch.items[1]!);
	assert.match(item.nextSafeAction, /org\/a#1.*pr-ready/);
	assert.equal(item.actions.includes("retry"), false);
	batch.items[1]!.stage = "EXCLUDED";
	batch.scopeRevisions.push({ item: "org/b#2", reason: "explicitly out of scope", at: "now" });
	const projection = projectBatch(batch);
	assert.equal(projection.converged, false);
	assert.equal(projection.items.find((entry) => entry.key === "org/b#2")!.actions.includes("retry"), false);
});

test("each dependency edge is projected independently, including missing prerequisites", () => {
	const batch = makeBatch([selected("org/a#1"), selected("org/b#2"), selected("org/c#3")], {
		dependencies: [
			{ item: "org/c#3", requires: "org/a#1", stage: "verified-patch" },
			{ item: "org/c#3", requires: "org/b#2", stage: "pr-ready" },
		],
	});
	const item = batch.items.find((candidate) => candidate.selected.key === "org/c#3")!;
	item.stage = "BLOCKED";
	const projected = projectItem(batch, item);
	assert.deepEqual(projected.dependencies.map((edge) => edge.satisfied), [false, false]);
	const missing = { ...batch, dependencies: [...batch.dependencies, { item: "org/c#3", requires: "org/missing#9", stage: "verified-patch" as const }] };
	const missingProjection = projectItem(missing, item);
	assert.equal(missingProjection.dependencies.at(-1)!.satisfied, false);
	assert.match(missingProjection.dependencyBlocker!, /org\/a#1|org\/missing#9/);
});

test("unknown external effects expose reconciliation only, while read-only mode omits mutations", () => {
	const batch = makeBatch([selected("org/a#1")]);
	const item = batch.items[0]!;
	item.stage = "UNKNOWN";
	item.operation = {
		id: "op-pr",
		generation: item.ledger.generation,
		subject: item.ledger.subject,
		effect: "pull-request-create",
		phase: "pr",
		state: "unknown",
		owner: `${batch.id}:${item.selected.key}`,
	};
	const projection = projectItem(batch, item);
	assert.equal(projection.actions.includes("retry"), false);
	assert.equal(projection.actions.includes("reconcile"), true);
	assert.match(projection.nextSafeAction, /reconcile/i);
	const readOnly = projectItem(batch, item, { readOnly: true });
	assert.equal(readOnly.actions.includes("exclude"), false);
	assert.equal(readOnly.actions.includes("retry"), false);
});

test("budgets and conflicting claims suppress retry without resetting attempts", () => {
	const batch = makeBatch([selected("org/a#1")]);
	const item = batch.items[0]!;
	item.stage = "BLOCKED";
	item.blocker = "original attempt budget exhausted; retry never resets it";
	item.attempts = batch.maxAttempts;
	assert.equal(projectItem(batch, item).actions.includes("retry"), false);
	item.attempts = 1;
	const conflict = projectItem(batch, item, { claims: [{ resource: "repo:org/a", owner: "other-batch:org/a#9", createdAt: "now", status: "unknown" }] });
	assert.equal(conflict.actions.includes("retry"), false);
	assert.match(conflict.nextSafeAction, /claim|reconcile/i);
});

test("completed ledger proof and uncertain operations remain fenced", () => {
	const batch = makeBatch([selected("org/a#1")]);
	const item = batch.items[0]!;
	prove(item);
	item.stage = "BLOCKED";
	item.blocker = "repair requested";
	assert.equal(projectItem(batch, item).actions.includes("retry"), false);
	item.operation = {
		id: "op-push",
		generation: item.ledger.generation,
		subject: item.ledger.subject,
		effect: "git-push",
		phase: "push",
		state: "intent",
		owner: `${batch.id}:${item.selected.key}`,
	};
	item.stage = "BLOCKED";
	const uncertain = projectItem(batch, item);
	assert.equal(uncertain.actions.includes("exclude"), false);
	assert.equal(uncertain.actions.includes("retry"), false);
	assert.equal(uncertain.actions.includes("reconcile"), true);
	assert.equal(projectItem(batch, item, { readOnly: true }).actions.includes("reconcile"), false);
});

test("current recorded PR URL wins over older operation history", () => {
	const batch = makeBatch([selected("org/a#1", "pr-ready")]);
	const item = batch.items[0]!;
	const operation = (id: string, url?: string) => ({
		id,
		generation: item.ledger.generation,
		subject: item.ledger.subject,
		effect: "pull-request-create" as const,
		phase: "pr" as const,
		state: "applied" as const,
		owner: `${batch.id}:${item.selected.key}`,
		...(url === undefined ? {} : { url }),
	});
	item.operations = [operation("old", "https://github.com/org/repo/pull/1")];
	item.operation = operation("current", "https://github.com/org/repo/pull/2");
	assert.equal(projectItem(batch, item).prUrl, "https://github.com/org/repo/pull/2");
});

test("persisted running state exposes liveness only when supplied by the active service", () => {
	const batch = makeBatch([selected("org/a#1")]);
	batch.items[0]!.stage = "RUNNING";
	assert.equal(projectItem(batch, batch.items[0]!).executionLiveness, "unknown");
	assert.equal(projectItem(batch, batch.items[0]!, { activeItemKeys: ["org/a#1"] }).executionLiveness, "active");
});

test("converged batches expose only safe export/discard controls", () => {
	const batch = makeBatch([selected("org/a#1")]);
	prove(batch.items[0]!, "pr-ready");
	const projection = projectBatch(batch);
	assert.equal(projection.converged, true);
	assert.equal(projection.actions.includes("pause"), false);
	assert.equal(projection.actions.includes("stop"), false);
	assert.equal(projection.actions.includes("export"), true);
	assert.equal(projection.actions.includes("discard"), true);
	assert.equal(projectBatch(batch, { readOnly: true }).actions.includes("export"), false);
	const dependent = makeBatch([selected("org/a#1"), selected("org/b#2")], { id: "batch-dependent", dependencies: [{ item: "org/b#2", requires: "org/a#1", stage: "pr-ready" }] });
	assert.equal(projectBatch(batch, { retainedBatches: [dependent] }).actions.includes("discard"), false);
});

test("items without an execution receipt explicitly display unknown model and effort", () => {
	const batch = makeBatch([selected("org/a#1")]);
	assert.match(projectItem(batch, batch.items[0]!).detail.join("\n"), /model: unknown.*effort: unknown/);
});
