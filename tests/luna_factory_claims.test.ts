import assert from "node:assert/strict";
import test from "node:test";
import { createBatch } from "../image/extension/luna-factory/core/batch.ts";
import { inspectClaim } from "../image/extension/luna-factory/ui/claims.ts";

const item = {
	key: "example/repository#42",
	repo: "example/repository",
	number: 42,
	kind: "pr" as const,
	action: "patch" as const,
	overlaps: [],
	base: "base",
	head: "head",
	acceptanceRevision: "r1",
};

test("claim inspection exposes owner, Factory identity, liveness, operation and release condition", () => {
	const batch = createBatch([item], { id: "batch-claim1234", capacity: 1, maxAttempts: 2, maxTotalAttempts: 2, mode: "retain" });
	const batchItem = batch.items[0]!;
	batchItem.operation = {
		id: "receipt-push-42",
		generation: batchItem.ledger.generation,
		subject: batchItem.ledger.subject,
		effect: "git-push",
		phase: "push",
		owner: `${batch.id}:${item.key}`,
		state: "unknown",
		resultHandle: "push-result-42",
	};
	const claim = { resource: `item:${item.key}`, owner: `${batch.id}:${item.key}`, createdAt: "2026-09-25T10:00:00Z", status: "unknown" as const };
	const inspected = inspectClaim(claim, [batch], [item.key], true);
	assert.equal(inspected.batchId, batch.id);
	assert.equal(inspected.itemKey, item.key);
	assert.equal(inspected.liveness, "active");
	assert.equal(inspected.operation?.id, "receipt-push-42");
	assert.equal(inspected.operation?.effect, "git-push");
	assert.equal(inspected.reconcileAvailable, true);
	assert.match(inspected.releaseCondition, /authoritative worker\/external-effect reconciliation/);
	assert.match(inspected.rows.join("\n"), /push-result-42/);
});

test("unknown claim inspection does not infer ownership or release safety", () => {
	const claim = { resource: "repo:missing/repository", owner: "review:wave-unknown-owner", createdAt: "unknown", status: "unknown" as const };
	const inspected = inspectClaim(claim, [], [], false);
	assert.equal(inspected.batchId, undefined);
	assert.equal(inspected.liveness, "unknown");
	assert.equal(inspected.reconcileAvailable, false);
	assert.match(inspected.rows.join("\n"), /batch\/wave identity: unknown/);
	assert.match(inspected.releaseCondition, /must mark this claim settled/);
});

test("claim inspector retains long owner, operation receipt, and release text for scrolling", () => {
	const batch = createBatch([item], { id: "batch-claim1234", capacity: 1, maxAttempts: 2, maxTotalAttempts: 2, mode: "retain" });
	const batchItem = batch.items[0]!;
	const owner = `review:${"wave-owner-".repeat(14)}`;
	batchItem.operation = {
		id: "receipt-long-operation",
		generation: batchItem.ledger.generation,
		subject: batchItem.ledger.subject,
		effect: "pull-request-create",
		phase: "pr",
		owner,
		state: "unknown",
		resultHandle: "long-receipt-result",
	};
	const inspected = inspectClaim({ resource: `item:${item.key}`, owner, createdAt: "now", status: "unknown" }, [batch], [], false);
	assert.ok(inspected.rows.some((row) => row.includes(owner)));
	assert.ok(inspected.rows.some((row) => row.includes("release condition")));
});

test("conflicting owner does not inherit Factory liveness or receipts", () => {
	const batch = createBatch([item], { id: "batch-claim1234", capacity: 1, maxAttempts: 2, maxTotalAttempts: 2, mode: "retain" });
	const batchItem = batch.items[0]!;
	batchItem.operation = {
		id: "factory-receipt",
		generation: batchItem.ledger.generation,
		subject: batchItem.ledger.subject,
		effect: "git-push",
		phase: "push",
		owner: `${batch.id}:${item.key}`,
		state: "unknown",
	};
	const inspected = inspectClaim({ resource: `repo:${item.repo}`, owner: "review:other-wave", createdAt: "now", status: "unknown" }, [batch], [item.key], true);
	assert.equal(inspected.batchId, undefined);
	assert.equal(inspected.liveness, "unknown");
	assert.equal(inspected.operation, undefined);
	assert.match(inspected.rows.join("\n"), /claim owner does not match/);
});
