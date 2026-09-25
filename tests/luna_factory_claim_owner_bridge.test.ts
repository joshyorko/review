import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	registerFactoryClaimInspector,
	registeredFactoryClaimInspector,
	type ClaimOwnerObservation,
} from "../image/extension/luna-factory/omp/batch-bridge.ts";
import { ResourceClaims } from "../image/extension/luna-factory/omp/batch-store.ts";
import { saveWave } from "../image/extension/bluefin-review/wave-store.ts";
import { BATCH_ENTRY, createReviewExtension, observeReviewWaveWorkers } from "../image/extension/bluefin-review/extension.ts";

test("claim inspector registration is synchronous and identity-safe", () => {
	const first = (): ClaimOwnerObservation => ({
		source: "review",
		owner: "review:batch-one:0",
		resource: "repo:example/review",
		matches: true,
		batchId: "batch-one",
		runId: "batch-one",
		wave: 0,
		itemKeys: ["example/review#1"],
		recordedControllerState: "blocked",
		worker: {
			jobIds: [],
			toolCallIds: [],
			runningJobIds: [],
			unobservedJobIds: [],
			taskWorkers: {},
			terminalJobStatuses: {},
			coverageComplete: false,
			settled: false,
			source: "unknown",
		},
		missingWorkerReason: "worker evidence is unavailable",
		effectReconciliation: "awaiting",
		releaseCondition: "worker and external-effect evidence must settle this exact owner/resource",
		reconcileAvailable: true,
		kind: "slay",
		evidenceRefs: [],
		sessionRefs: [],
	});
	const second = (): ClaimOwnerObservation => ({ ...first(), owner: "review:batch-two:0" });
	const unregisterFirst = registerFactoryClaimInspector(first);
	assert.equal(registeredFactoryClaimInspector(), first);
	const unregisterSecond = registerFactoryClaimInspector(second);
	assert.equal(registeredFactoryClaimInspector(), second);
	unregisterFirst();
	assert.equal(registeredFactoryClaimInspector(), second);
	unregisterSecond();
	assert.equal(registeredFactoryClaimInspector(), undefined);
});

function host() {
	const events = new Map<string, (event: unknown, ctx: unknown) => unknown>();
	return {
		events,
		setLabel() {},
		on(name: string, handler: (event: unknown, ctx: unknown) => unknown) { events.set(name, handler); },
		registerShortcut() {},
		registerFlag() {},
		getFlag() { return undefined; },
		registerTool() {},
		registerCommand() {},
		appendEntry() {},
		sendUserMessage() {},
		zod: { object: () => leaf(), string: () => leaf(), number: () => leaf(), boolean: () => leaf(), array: () => leaf(), enum: () => leaf(), literal: () => leaf(), union: () => leaf() },
	};
}
function leaf() { return { optional: () => leaf(), describe: () => leaf() }; }
function context(branch: readonly { type: string; customType?: string; data?: unknown }[], snapshot: unknown) {
	return { hasUI: false, ui: { notify() {} }, sessionManager: { getBranch: () => [...branch] }, getAsyncJobSnapshot: () => snapshot };
}
function wave(state: "blocked" | "cancelled", overrides: Record<string, unknown> = {}) {
	return {
		version: 1,
		id: "batch-mugs4x61",
		kind: "slay",
		waves: [{ repo: "example/review", items: [{ id: 42, type: "pr", repo: "example/review", title: "recovery", headSha: "head", reviewState: "review_required", autoMergeEnabled: false }] }],
		currentWave: 0,
		completedItems: 0,
		totalItems: 1,
		state,
		startedAt: 1,
		waveStartedAt: 1,
		waveIdentity: "batch-mugs4x61:0",
		waveToolCallIds: ["call-1"],
		waveTaskWorkers: { "call-1": [{ agentId: "worker-1", jobId: "job-1" }] },
		waveJobIds: ["job-1"],
		waveTerminalJobStatuses: { "job-1": "completed" },
		waveEffectResources: ["item:example/review#42", "repo:example/review"],
		...overrides,
	};
}
async function recoveredInspector(batch: ReturnType<typeof wave>, snapshot: unknown) {
	const stateRoot = mkdtempSync(join(tmpdir(), "review-owner-state-"));
	const claimsRoot = mkdtempSync(join(tmpdir(), "review-owner-claims-"));
	try {
		const owner = "review:batch-mugs4x61:0";
		const claims = new ResourceClaims(stateRoot, claimsRoot);
		claims.claim("repo:example/review", owner);
		claims.claim("item:example/review#42", owner);
		saveWave(claimsRoot, batch as never);
		const pi = host();
		const branch = [{ type: "custom", customType: BATCH_ENTRY, data: batch }];
		const review = createReviewExtension(pi as never, { org: "example", env: { REVIEW_MODE: "review", REVIEW_DEFAULT_SCOPE: "org:example", HOME: "/nonexistent", XDG_STATE_HOME: stateRoot, LUNA_FACTORY_CLAIMS_ROOT: claimsRoot }, fetchImpl: async () => ({ ok: true, status: 200, statusText: "OK", json: async () => ({ data: { viewer: { login: "reviewer" }, search: { pageInfo: { hasNextPage: false }, nodes: [] } } }) }) });
		const ctx = context(branch, snapshot);
		await pi.events.get("session_start")?.({}, ctx);
		await review.whenStarted();
		const inspector = registeredFactoryClaimInspector();
		assert.ok(inspector);
		return { observation: inspector(owner, "repo:example/review"), shutdown: () => { pi.events.get("session_shutdown")?.({}, ctx); rmSync(stateRoot, { recursive: true, force: true }); rmSync(claimsRoot, { recursive: true, force: true }); } };
	} finally {
		// The caller reads the observation before these roots are removed.
	}
}

test("matching recovered owner reports persisted settled workers while external effects await reconciliation", async () => {
	const result = await recoveredInspector(wave("cancelled"), null);
	assert.equal(result.observation.matches, true);
	assert.equal(result.observation.source, "review");
	assert.equal(result.observation.batchId, "batch-mugs4x61");
	assert.equal(result.observation.runId, "batch-mugs4x61");
	assert.deepEqual(result.observation.itemKeys, ["example/review#42"]);
	assert.equal(result.observation.recordedControllerState, "cancelled");
	assert.equal(result.observation.worker.source, "persisted");
	assert.deepEqual(result.observation.worker.runningJobIds, []);
	assert.deepEqual(result.observation.worker.unobservedJobIds, []);
	assert.equal(result.observation.kind, "slay");
	assert.deepEqual(result.observation.evidenceRefs, []);
	assert.deepEqual(result.observation.sessionRefs, []);
	assert.equal(result.observation.worker.coverageComplete, true);
	assert.equal(result.observation.worker.settled, true);
	assert.equal(result.observation.effectReconciliation, "awaiting");
	assert.equal(result.observation.reconcileAvailable, true);
	assert.match(result.observation.releaseCondition, /exact owner\/resource/);
	await result.shutdown();
});

test("a persisted running controller is never presented as live after restart", async () => {
	const result = await recoveredInspector(wave("blocked", { state: "running" }), null);
	assert.equal(result.observation.recordedControllerState, "running");
	assert.equal(result.observation.worker.source, "persisted");
	assert.equal(result.observation.worker.settled, true);
	await result.shutdown();
});

test("mismatching resource does not inherit the recovered owner facts", async () => {
	const result = await recoveredInspector(wave("blocked"), null);
	const observation = registeredFactoryClaimInspector()!("review:batch-mugs4x61:0", "repo:other/review");
	assert.equal(observation.matches, false);
	assert.equal(observation.batchId, undefined);
	assert.deepEqual(observation.itemKeys, []);
	assert.equal(observation.reconcileAvailable, false);
	await result.shutdown();
});

test("missing worker record remains unknown after restart", async () => {
	const result = await recoveredInspector(wave("blocked", { waveTaskWorkers: undefined, waveJobIds: ["job-1"], waveTerminalJobStatuses: undefined }), null);
	assert.equal(result.observation.worker.source, "persisted");
	assert.equal(result.observation.worker.coverageComplete, false);
	assert.equal(result.observation.worker.settled, false);
	assert.match(result.observation.missingWorkerReason ?? "", /task-to-worker/);
	assert.equal(result.observation.effectReconciliation, "unknown");
	await result.shutdown();
});

test("live worker facts expose only matching running jobs", async () => {
	const worker = observeReviewWaveWorkers(["job-1"], ["call-1"], { "call-1": [{ agentId: "worker-1", jobId: "job-1" }] }, undefined, { running: [{ id: "job-1", status: "running" }], recent: [] });
	assert.equal(worker.source, "live");
	assert.deepEqual(worker.runningJobIds, ["job-1"]);
	assert.deepEqual(worker.unobservedJobIds, []);
	assert.equal(worker.settled, false);
});

test("live snapshot omission remains unknown instead of implying a running worker", async () => {
	const worker = observeReviewWaveWorkers(["job-1"], ["call-1"], { "call-1": [{ agentId: "worker-1", jobId: "job-1" }] }, undefined, { running: [], recent: [] });
	assert.equal(worker.source, "live");
	assert.deepEqual(worker.runningJobIds, []);
	assert.deepEqual(worker.unobservedJobIds, ["job-1"]);
	assert.equal(worker.settled, false);
});

test("pre-tool terminal proof is presented without inventing worker completion", async () => {
 const result = await recoveredInspector(wave("blocked", {
  wavePromptDigest: "a".repeat(64), wavePreToolTerminal: "error",
  waveToolInvocationIds: [], waveToolCallIds: [], waveTaskWorkers: {},
  waveJobIds: [], waveTerminalJobStatuses: {},
 }), { running: [], recent: [] });
 try {
  assert.equal(result.observation.coordinatorTerminal, "error");
  assert.equal(result.observation.missingWorkerReason, undefined);
  assert.equal(result.observation.effectReconciliation, "awaiting");
  assert.equal(result.observation.worker.coverageComplete, false);
 } finally { result.shutdown(); }
});
