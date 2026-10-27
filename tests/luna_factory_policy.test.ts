import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { batchSummary, createBatch } from "../image/extension/luna-factory/core/batch.ts";
import { BatchStore } from "../image/extension/luna-factory/omp/batch-store.ts";
import { BatchService } from "../image/extension/luna-factory/omp/batch-service.ts";
import { createRequestPolicyExtension } from "../image/extension/luna-factory/omp/batch-native.ts";
import { createExecutionPolicy, reserveProviderRequest, routeForModel, settleProviderUsage, usageObservationFromOmp, type RequestAccounting } from "../image/extension/luna-factory/omp/policy.ts";
import { readOperatorPolicy } from "../image/extension/review/operator-policy.ts";

const route = routeForModel({ provider: "anthropic", id: "claude-test", api: "anthropic-messages", baseUrl: "https://api.example.test" });
const payload = { model: "claude-test", messages: [{ role: "user", content: "hi" }] };
const usage = { input: 12, output: 3, cost: { input: 0.0004, output: 0.0006, cacheRead: 0, cacheWrite: 0, total: 0.001 } };

test("payload bytes and aggregate output-token reservations use separate limits", () => {
	const policy = createExecutionPolicy(route, 1_000, { maxRequests: 2, deadlineAt: 10_000, maxInputBytes: 4_096, maxOutputTokens: 32, maxReservedOutputTokens: 32 });
	const empty: RequestAccounting = { sequence: 0, reservations: [] };
	assert.equal(Object.hasOwn(policy, "effort"), false, "execution policy must not claim an unenforced thinking effort");
	const summaryBatch = createBatch([{ key: "org/repo#3", repo: "org/repo", number: 3, kind: "issue", action: "inspect", overlaps: [], base: "c".repeat(40) }], {
		id: "batch-acde9012", capacity: 1, maxAttempts: 1, maxTotalAttempts: 1, mode: "once",
	});
	summaryBatch.executionPolicy = policy;
	assert.doesNotMatch(batchSummary(summaryBatch, "/tmp"), /low effort/i, "Factory summary must not claim unenforced thinking effort");
	const allowed = reserveProviderRequest(policy, empty, route, payload, 2_000);
	assert.equal(allowed.ok, true);
	if (!allowed.ok) return;
	const encodedBytes = Buffer.byteLength(JSON.stringify(payload), "utf8");
	assert.ok(encodedBytes > policy.maxOutputTokens);
	assert.equal(allowed.reservation.reservedPayloadBytes, encodedBytes);
	assert.equal(allowed.reservation.reservedOutputTokens, 32);
	assert.equal(allowed.payload.max_tokens, 32);
	assert.equal(allowed.reservation.status, "reserved");
	const refused = reserveProviderRequest(policy, allowed.accounting, route, payload, 2_001);
	assert.equal(refused.ok, false);
	if (!refused.ok) assert.match(refused.reason, /aggregate reserved-output-token limit/);
	assert.equal(reserveProviderRequest(policy, empty, routeForModel({ provider: "anthropic", id: "claude-test", api: "anthropic-messages", baseUrl: "https://other.example.test" }), payload, 2_000).ok, false);
});

test("oversized serialized payload refuses on its byte limit alone", () => {
	const policy = createExecutionPolicy(route, 1_000, { maxInputBytes: 8, maxOutputTokens: 4, maxReservedOutputTokens: 4 });
	const result = reserveProviderRequest(policy, { sequence: 0, reservations: [] }, route, payload, 2_000);
	assert.equal(result.ok, false);
	if (!result.ok) assert.match(result.reason, /input byte limit/);
});

test("batch-store validates optional operator-policy snapshots and keeps legacy batches readable", async () => {
	const root = await mkdtemp(join(tmpdir(), "factory-policy-store-"));
	try {
		const selected = { key: "org/repo#3", repo: "org/repo", number: 3, kind: "issue" as const, action: "inspect" as const, overlaps: [], base: "c".repeat(40), operatorPolicy: readOperatorPolicy("org/repo", { HOME: root }) };
		const batch = createBatch([selected], { id: "batch-acde9012", capacity: 1, maxAttempts: 1, maxTotalAttempts: 1, mode: "once" });
		batch.operatorPolicy = { "org/repo": selected.operatorPolicy };
		const store = new BatchStore(root); store.acquire(); store.write(batch);
		assert.equal(store.read(batch.id).items[0]?.selected.operatorPolicy?.mode, "team");
		const path = join(root, `${batch.id}.json`);
		const tampered = JSON.parse(await readFile(path, "utf8"));
		tampered.items[0].selected.operatorPolicy.digest = "0".repeat(64);
		await writeFile(path, JSON.stringify(tampered));
		assert.throws(() => store.read(batch.id), /operator policy snapshot/i);
		store.release();
		const legacy = createBatch([{ key: "org/legacy#4", repo: "org/legacy", number: 4, kind: "issue", action: "inspect", overlaps: [], base: "d".repeat(40) }], { id: "batch-acde9013", capacity: 1, maxAttempts: 1, maxTotalAttempts: 1, mode: "once" });
		const legacyStore = new BatchStore(join(root, "legacy")); legacyStore.acquire(); legacyStore.write(legacy);
		assert.equal(legacyStore.read(legacy.id).items[0]?.selected.operatorPolicy, undefined);
		legacyStore.release();
	} finally { await rm(root, { recursive: true, force: true }); }
});

test("durable reservation refusal maps to the native policy denial discriminant", () => {
	const root = join(tmpdir(), "factory-policy-denial");
	const batch = createBatch([{ key: "org/repo#2", repo: "org/repo", number: 2, kind: "issue", action: "inspect", overlaps: [], base: "b".repeat(40) }], {
		id: "batch-acde5678", capacity: 1, maxAttempts: 1, maxTotalAttempts: 1, mode: "once",
	});
	const now = Date.now();
	const policy = createExecutionPolicy(route, now, { maxRequests: 1, deadlineAt: now + 10_000 });
	const first = reserveProviderRequest(policy, batch.requestAccounting, route, payload, now + 1);
	assert.equal(first.ok, true);
	if (!first.ok) return;
	batch.executionPolicy = policy;
	batch.requestAccounting = first.accounting;
	const service = new BatchService(root, { snapshot: async (value) => value, assertFresh: async () => {} } as never, undefined, {} as never, 1);
	const requestPolicy = (service as unknown as { requestPolicy(value: typeof batch): { before(route: typeof route, payload: unknown): unknown } }).requestPolicy(batch);
	assert.deepEqual(requestPolicy.before(route, payload), { allowed: false, reason: "Factory provider request limit exhausted; original reservations remain charged" });
});

test("Google output cap uses the OMP provider config field", () => {
	const googleRoute = routeForModel({ provider: "google", id: "gemini-test", api: "google-generative-ai" });
	const policy = createExecutionPolicy(googleRoute, 1_000, { maxOutputTokens: 24 });
	const result = reserveProviderRequest(policy, { sequence: 0, reservations: [] }, googleRoute, { contents: [], config: { maxOutputTokens: 4096 } }, 2_000);
	assert.equal(result.ok, true);
	if (result.ok) assert.equal((result.payload.config as Record<string, unknown>).maxOutputTokens, 24);
});

test("OpenAI completion cap clamps max_completion_tokens when selected by OMP compatibility", () => {
	const openAIRoute = routeForModel({ provider: "openai", id: "gpt-test", api: "openai-completions" });
	const policy = createExecutionPolicy(openAIRoute, 1_000, { maxOutputTokens: 24 });
	const result = reserveProviderRequest(policy, { sequence: 0, reservations: [] }, openAIRoute, { model: "gpt-test", max_completion_tokens: 4096, messages: [] }, 2_000);
	assert.equal(result.ok, true);
	if (result.ok) assert.equal(result.payload.max_completion_tokens, 24);
});

test("denied provider hook aborts Advisor-local work before the primary session", () => {
	const controller = new AbortController();
	let advisorAborts = 0;
	let primaryAborts = 0;
	let beforeProviderRequest: ((event: unknown, ctx: unknown) => unknown) | undefined;
	const policy = {
		before: () => ({ allowed: false as const, reason: "request policy refused" }),
		response: () => {},
		usage: () => {},
		blocked: () => {},
	};
	const extension = createRequestPolicyExtension(policy, () => { advisorAborts++; controller.abort(); });
	extension({ on: (name: string, handler: (event: unknown, ctx: unknown) => unknown) => { if (name === "before_provider_request") beforeProviderRequest = handler; } } as never);
	assert.ok(beforeProviderRequest);
	beforeProviderRequest({ payload }, { model: { provider: route.provider, id: route.model, api: route.api }, abort: () => { assert.equal(controller.signal.aborted, true); primaryAborts++; } });
	assert.equal(advisorAborts, 1);
	assert.equal(primaryAborts, 1);
	assert.throws(() => controller.signal.throwIfAborted(), /aborted/i);
});

test("an assistant message without a route leaves usage unresolved", () => {
	const handlers = new Map<string, (event: unknown, ctx: unknown) => unknown>();
	let settlements = 0;
	let blocks = 0;
	const extension = createRequestPolicyExtension({ before: () => ({ allowed: true, payload: {} }), response() {}, usage() { settlements++; }, blocked() { blocks++; } }, () => {});
	extension({ on: (name: string, handler: (event: unknown, ctx: unknown) => unknown) => handlers.set(name, handler) } as never);
	handlers.get("assistant_message")!({ message: { usage } }, { model: undefined });
	assert.equal(settlements, 0);
	assert.equal(blocks, 0);
});

test("usage settles the oldest response reservation and missing usage stays reserved", () => {
	const policy = createExecutionPolicy(route, 1_000, { maxRequests: 3, deadlineAt: 10_000 });
	const first = reserveProviderRequest(policy, { sequence: 0, reservations: [] }, route, payload, 2_000);
	assert.equal(first.ok, true);
	if (!first.ok) return;
	const response = { ...first.accounting, reservations: first.accounting.reservations.map((row) => ({ ...row, status: "response" as const })) };
	const normalizedUsage = usageObservationFromOmp(usage);
	assert.equal(normalizedUsage.cost, 0.001);
	const settled = settleProviderUsage(response, route, normalizedUsage);
	assert.equal(settled.reservations[0]?.status, "settled");
	assert.equal(settled.reservations[0]?.usage?.inputTokens, 12);
	const unchanged = settleProviderUsage(response, route, { input: null, output: null, cost: null });
	assert.equal(unchanged.reservations[0]?.status, "response");
});

test("fake provider sends zero requests after the durable pre-request gate refuses", async () => {
	const policy = createExecutionPolicy(route, 1_000, { maxRequests: 1, deadlineAt: 10_000 });
	const controller = new AbortController();
	let providerSends = 0;
	const reservation = reserveProviderRequest(policy, { sequence: 0, reservations: [] }, route, payload, 2_000);
	assert.equal(reservation.ok, true);
	if (!reservation.ok) return;
	const fakeProvider = async () => {
		const admission = reserveProviderRequest(policy, reservation.accounting, route, payload, 2_001);
		if (!admission.ok) controller.abort(new Error(admission.reason));
		controller.signal.throwIfAborted();
		providerSends++;
	};
	await assert.rejects(fakeProvider(), /request limit/);
	assert.equal(providerSends, 0);
});

test("batch-store restart preserves unresolved request reservations and refuses replenishment", async () => {
	const root = await mkdtemp(join(tmpdir(), "factory-policy-"));
	try {
		const store = new BatchStore(root);
		const batch = createBatch([{ key: "org/repo#1", repo: "org/repo", number: 1, kind: "issue", action: "inspect", overlaps: [], base: "a".repeat(40) }], {
			id: "batch-acde1234", capacity: 1, maxAttempts: 1, maxTotalAttempts: 1, mode: "once",
		});
		batch.executionPolicy = createExecutionPolicy(route, 1_000, { maxRequests: 1, deadlineAt: 10_000, maxInputBytes: 4_096, maxOutputTokens: 32, maxReservedOutputTokens: 32 });
		store.acquire();
		store.write(batch);
		const admission = reserveProviderRequest(batch.executionPolicy, batch.requestAccounting, route, payload, 2_000);
		assert.equal(admission.ok, true);
		if (!admission.ok) return;
		batch.requestAccounting = admission.accounting;
		store.write(batch);
		store.release();
		const restarted = new BatchStore(root);
		const retained = restarted.read(batch.id);
		assert.equal(retained.requestAccounting.reservations[0]?.status, "reserved");
		assert.equal(reserveProviderRequest(retained.executionPolicy!, retained.requestAccounting, route, payload, 2_001).ok, false);
	} finally { await rm(root, { recursive: true, force: true }); }
});
