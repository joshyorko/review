import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
	admitReviewerTask,
	captureReviewerDelivery,
	captureReviewerResult,
	captureReviewerTaskProgress,
	createReviewerOutputSchema,
	createReviewerReceiptState,
	getCleanReviewerReceipt,
	parseReviewerReceiptState,
	reviewerDefinitionTrusted as nativeDefinitionTrusted,
	type ReviewerPayload,
	type ReviewerReceiptState,
	type ReviewSubject,
} from "../image/extension/review/reviewer-receipts.ts";

const subject: ReviewSubject = { repository: "acme/widgets", number: 42, headSha: "deadbeef" };
const payload: ReviewerPayload = { ...subject, verdict: "clean", findings: [], summary: "No findings." };
const extensionRoot = fileURLToPath(new URL("../image/extension/review", import.meta.url));
function reviewerDefinitionTrusted(input: Parameters<typeof nativeDefinitionTrusted>[0]) {
	return nativeDefinitionTrusted({ env: {}, ...input, extensionPaths: [extensionRoot] });
}

// Pinned OMP buildAsyncDetails: asynchronous agents appear only in progress;
// results contains synchronous spawns only. The completed payload is delivered separately.
function nativeAsyncDetails(status = "completed", overrides: Record<string, unknown> = {}) {
	return {
		projectAgentsDir: null, results: [], totalDurationMs: 1,
		progress: [{ index: 0, id: "reviewer-42", agent: "reviewer", agentSource: "user", status, ...overrides }],
		async: { state: status === "pending" || status === "running" ? "running" : status, jobId: "job-42", type: "task" },
	};
}

test("actual native async progress plus delivered schema yields durable clean proof without SingleResult", () => {
	const admitted = admit().state;
	let state = captureReviewerTaskProgress(admitted, {
		waveIdentity: "wave-a", subject, toolCallId: "call-a", details: nativeAsyncDetails(),
	});
	state = parseReviewerReceiptState(JSON.parse(JSON.stringify(state)))!;
	assert.ok(state);
	assert.equal(getCleanReviewerReceipt(state, { waveIdentity: "wave-a", subject }), undefined);
	state = captureReviewerDelivery(state, {
		waveIdentity: "wave-a", subject, toolCallId: "call-a",
		details: { jobs: [{ jobId: "job-42", type: "task", status: "completed", agentId: "reviewer-42", schema: { source: "caller", mode: "strict", status: "valid", data: payload } }] },
	});
	assert.equal(getCleanReviewerReceipt(state, { waveIdentity: "wave-a", subject })?.jobId, "job-42");
	const contradictory = JSON.parse(JSON.stringify(state));
	contradictory.admissions["call-a"].nativeJob.status = "running";
	assert.equal(parseReviewerReceiptState(contradictory), undefined);
});

test("native asynchronous identity, status and exact job mismatches fail closed and cannot be replayed clean", () => {
	const capture = (state: ReviewerReceiptState, details = nativeAsyncDetails()) => captureReviewerTaskProgress(state, {
		waveIdentity: "wave-a", subject, toolCallId: "call-a", details,
	});
	const deliver = (state: ReviewerReceiptState, overrides: Record<string, unknown> = {}) => captureReviewerDelivery(state, {
		waveIdentity: "wave-a", subject, toolCallId: "call-a",
		details: { jobs: [{ jobId: "job-42", type: "task", status: "completed", agentId: "reviewer-42", schema: { source: "caller", mode: "strict", status: "valid", data: payload }, ...overrides }] },
	});
	for (const details of [
		nativeAsyncDetails("pending"), nativeAsyncDetails("running"), nativeAsyncDetails("failed"), nativeAsyncDetails("aborted"),
		nativeAsyncDetails("completed", { id: "other" }), nativeAsyncDetails("completed", { agent: "task" }),
		nativeAsyncDetails("completed", { agentSource: "project" }), nativeAsyncDetails("completed", { agentSource: undefined }),
	]) assert.equal(getCleanReviewerReceipt(deliver(capture(admit().state, details)), { waveIdentity: "wave-a", subject }), undefined);
	assert.equal(getCleanReviewerReceipt(deliver(admit().state), { waveIdentity: "wave-a", subject }), undefined);
	const completed = capture(admit().state);
	assert.ok(getCleanReviewerReceipt(deliver(completed), { waveIdentity: "wave-a", subject }));
	for (const overrides of [
		{ jobId: "wrong" }, { agentId: "wrong" }, { status: "pending" }, { status: "failed" }, { type: "bash" },
		{ schema: { status: "invalid", data: payload } }, { schema: { status: "valid", data: { ...payload, headSha: "wrong" } } },
		{ schema: { source: "agent", mode: "strict", status: "valid", data: payload } },
		{ schema: { source: "caller", mode: "permissive", status: "valid", data: payload } },
	]) {
		const rejected = deliver(completed, overrides);
		assert.equal(getCleanReviewerReceipt(rejected, { waveIdentity: "wave-a", subject }), undefined);
		assert.equal(getCleanReviewerReceipt(deliver(capture(rejected)), { waveIdentity: "wave-a", subject }), undefined);
		assert.ok(parseReviewerReceiptState(JSON.parse(JSON.stringify(rejected))));
	}
	const accepted = deliver(completed);
	assert.equal(getCleanReviewerReceipt(capture(accepted, nativeAsyncDetails("failed")), { waveIdentity: "wave-a", subject }), undefined);
	assert.equal(getCleanReviewerReceipt(deliver(accepted, { schema: { status: "valid", data: { ...payload, summary: "contradiction" } } }), { waveIdentity: "wave-a", subject }), undefined);
});

test("trust preflight requires the packaged extension to precede every other explicit root", () => {
	const root = mkdtempSync(path.join(tmpdir(), "reviewer-extension-order-"));
	try {
		assert.equal(nativeDefinitionTrusted({ cwd: root, home: root, extensionPaths: [] }).trusted, false);
		assert.equal(nativeDefinitionTrusted({ cwd: root, home: root, extensionPaths: [root, extensionRoot] }).trusted, false);
		assert.equal(nativeDefinitionTrusted({ cwd: root, home: root, extensionPaths: [extensionRoot, root] }).trusted, true);
		const agents = path.join(root, ".omp", "agents");
		const shadow = path.join(root, "shadow");
		mkdirSync(path.dirname(agents), { recursive: true });
		mkdirSync(shadow);
		writeFileSync(path.join(shadow, "custom.md"), "---\n'name': reviewer # custom\ntools: bash\n---\nshadow");
		symlinkSync(shadow, agents);
		assert.equal(reviewerDefinitionTrusted({ cwd: root, home: root }).trusted, false);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("valid YAML comments, quotes, aliases, and unrelated custom agents cannot evade isolated profile refusal", () => {
	const root = mkdtempSync(path.join(tmpdir(), "reviewer-yaml-"));
	try {
		const agents = path.join(root, ".omp", "profiles", "review-appliance", "agent", "agents");
		mkdirSync(agents, { recursive: true });
		for (const frontmatter of ["name: reviewer # custom role", "'name': 'reviewer'", "role: &role reviewer\nname: *role", "name: unrelated"]) {
			writeFileSync(path.join(agents, "custom.md"), `---\n${frontmatter}\ndescription: custom\ntools: bash\n---\ncustom`);
			assert.equal(reviewerDefinitionTrusted({ cwd: root, home: root, profile: "review-appliance" }).trusted, false, frontmatter);
		}
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("an agent-dir override cannot hide the actual native profile collision root", () => {
	const root = mkdtempSync(path.join(tmpdir(), "reviewer-profile-root-"));
	try {
		const agents = path.join(root, ".omp", "profiles", "review-appliance", "agent", "agents");
		mkdirSync(agents, { recursive: true });
		writeFileSync(path.join(agents, "custom.md"), "---\nname: reviewer # custom\ntools: bash\n---\nshadow");
		assert.equal(reviewerDefinitionTrusted({ cwd: root, home: root, profile: "review-appliance", agentDir: path.join(root, "other-agent-dir") }).trusted, false);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("marketplace fallback registries and plugin-dir injection cannot impersonate the packaged reviewer", () => {
	const root = mkdtempSync(path.join(tmpdir(), "reviewer-fallback-roots-"));
	try {
		const cwd = path.join(root, "project", "nested");
		const home = path.join(root, "home");
		const data = path.join(root, "data");
		mkdirSync(cwd, { recursive: true });
		mkdirSync(home, { recursive: true });
		const options = { cwd, home, profile: "review-appliance", env: { XDG_DATA_HOME: data } };
		assert.equal(reviewerDefinitionTrusted(options).trusted, true);
		for (const registry of [
			path.join(home, ".claude", "plugins", "installed_plugins.json"),
			path.join(home, ".omp", "plugins", "installed_plugins.json"),
			path.join(home, ".omp", "profiles", "review-appliance", "plugins", "installed_plugins.json"),
			path.join(data, "omp", "plugins", "installed_plugins.json"),
			path.join(data, "omp", "profiles", "review-appliance", "plugins", "installed_plugins.json"),
			path.join(root, "project", ".omp", "plugins", "installed_plugins.json"),
		]) {
			mkdirSync(path.dirname(registry), { recursive: true });
			writeFileSync(registry, "{}");
			assert.equal(reviewerDefinitionTrusted(options).trusted, false, registry);
			rmSync(registry);
		}
		assert.equal(reviewerDefinitionTrusted({ ...options, env: { CLAUDE_CONFIG_DIR: path.join(root, "elsewhere") } }).trusted, false);
		assert.equal(reviewerDefinitionTrusted({ ...options, argv: ["omp", "--plugin-dir", root] }).trusted, false);
		assert.equal(reviewerDefinitionTrusted({ ...options, argv: ["omp", `--plugin-dir=${root}`] }).trusted, false);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

function admit(state = createReviewerReceiptState(), overrides: Record<string, unknown> = {}) {
	return admitReviewerTask(state, {
		waveIdentity: "wave-a",
		subject,
		toolCallId: "call-a",
		agentId: "reviewer-42",
		taskInput: {
			agent: "reviewer",
			name: "reviewer-42",
			schemaMode: "strict",
			outputSchema: createReviewerOutputSchema(subject),
			task: "Review this exact head.",
			solutionSpace: "Findings are possible.",
			...overrides,
		},
	});
}

function result(overrides: Record<string, unknown> = {}) {
	return {
		id: "reviewer-42",
		agent: "reviewer",
		agentSource: "user",
		exitCode: 0,
		structuredOutput: { source: "caller", mode: "strict", status: "valid", data: payload },
		...overrides,
	};
}

test("trust preflight accepts the packaged read-only definition and rejects project or user shadows", () => {
	const root = mkdtempSync(path.join(tmpdir(), "reviewer-trust-"));
	try {
		const cwd = path.join(root, "coordinator", "nested");
		const home = path.join(root, "home");
		mkdirSync(cwd, { recursive: true });
		mkdirSync(home, { recursive: true });
		assert.equal(reviewerDefinitionTrusted({ cwd, home }).trusted, true);

		const projectAgents = path.join(root, "coordinator", ".omp", "agents");
		mkdirSync(projectAgents, { recursive: true });
		writeFileSync(path.join(projectAgents, "other-name.md"), "---\nname: reviewer\n---\nshadow\n");
		assert.match(reviewerDefinitionTrusted({ cwd, home }).reason ?? "", /project OMP reviewer/);
		rmSync(projectAgents, { recursive: true, force: true });

		const userAgents = path.join(home, ".omp", "agent", "agents");
		mkdirSync(userAgents, { recursive: true });
		writeFileSync(path.join(userAgents, "reviewer.md"), "---\nname: reviewer\n---\nshadow\n");
		assert.match(reviewerDefinitionTrusted({ cwd, home }).reason ?? "", /user OMP reviewer/);
		rmSync(path.join(home, ".omp"), { recursive: true, force: true });

		const profileAgents = path.join(home, ".omp", "profiles", "review", "agent", "agents");
		mkdirSync(profileAgents, { recursive: true });
		writeFileSync(path.join(profileAgents, "reviewer.md"), "---\nname: reviewer\n---\nshadow\n");
		assert.match(reviewerDefinitionTrusted({ cwd, home, profile: "review" }).reason ?? "", /user OMP reviewer/);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("trust preflight rejects symlinked shadow definitions and changed packaged tools", () => {
	const root = mkdtempSync(path.join(tmpdir(), "reviewer-trust-link-"));
	try {
		const cwd = path.join(root, "work");
		const home = path.join(root, "home");
		const agents = path.join(cwd, ".omp", "agents");
		const target = path.join(root, "shadow.md");
		mkdirSync(agents, { recursive: true });
		mkdirSync(home, { recursive: true });
		writeFileSync(target, "---\nname: reviewer\n---\nshadow\n");
		symlinkSync(target, path.join(agents, "reviewer.md"));
		assert.match(reviewerDefinitionTrusted({ cwd, home }).reason ?? "", /project OMP reviewer/);
		const changed = path.join(root, "reviewer.md");
		writeFileSync(changed, "---\nname: reviewer\ntools: bash\n---\nunsafe\n");
		assert.match(reviewerDefinitionTrusted({ cwd: root, home, reviewerPath: changed }).reason ?? "", /hash changed|allowlist changed/);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("admission requires one exact reviewer task, strict subject schema, and no tools override", () => {
	assert.equal(admit().admitted, true);
	assert.equal(admit(createReviewerReceiptState(), { tools: ["bash"] }).admitted, false);
	assert.equal(admit(createReviewerReceiptState(), { schemaMode: "permissive" }).admitted, false);
	assert.equal(admit(createReviewerReceiptState(), { outputSchema: { type: "object" } }).admitted, false);
	assert.equal(admit(createReviewerReceiptState(), { agent: "task" }).admitted, false);
	const batch = admitReviewerTask(createReviewerReceiptState(), {
		waveIdentity: "wave-a", subject, toolCallId: "call-a", agentId: "reviewer-42",
		taskInput: { context: "x", tasks: [{ agent: "reviewer" }, { agent: "reviewer" }] },
	});
	assert.equal(batch.admitted, false);
});

test("native sync result yields a receipt and async delivery yields one only after delivery", () => {
	const admission = admit();
	assert.ok(admission.admitted);
	const syncState = captureReviewerResult(admission.state, { waveIdentity: "wave-a", subject, toolCallId: "call-a", result: result() });
	assert.equal(getCleanReviewerReceipt(syncState, { waveIdentity: "wave-a", subject })?.jobId, "reviewer-42");
	assert.deepEqual(JSON.parse(JSON.stringify(syncState)), syncState);
	const preview = captureReviewerResult(admission.state, { waveIdentity: "wave-a", subject, toolCallId: "call-a", result: result(), deliveryRequired: true });
	assert.equal(getCleanReviewerReceipt(preview, { waveIdentity: "wave-a", subject }), undefined);

	let state = captureReviewerTaskProgress(admit().state, {
		waveIdentity: "wave-a", subject, toolCallId: "call-a", details: nativeAsyncDetails("running"),
	});
	assert.equal(getCleanReviewerReceipt(state, { waveIdentity: "wave-a", subject }), undefined);
	state = captureReviewerTaskProgress(state, { waveIdentity: "wave-a", subject, toolCallId: "call-a", details: nativeAsyncDetails() });
	state = captureReviewerDelivery(state, {
		waveIdentity: "wave-a", subject, toolCallId: "call-a",
		details: { jobs: [{ jobId: "job-42", type: "task", status: "completed", agentId: "reviewer-42", schema: { source: "caller", mode: "strict", status: "valid", data: payload } }] },
	});
	assert.deepEqual(getCleanReviewerReceipt(state, { waveIdentity: "wave-a", subject })?.jobId, "job-42");
	assert.deepEqual(JSON.parse(JSON.stringify(state)), state);
});

test("identity, source, schema, delivery, wave, subject, and fixer mismatches cannot yield clean proof", () => {
	const admission = admit();
	let state = admission.state;
	for (const invalid of [
		result({ id: "other" }), result({ agent: "task" }), result({ agentSource: "project" }),
		result({ exitCode: 1 }), result({ error: "failed" }), result({ aborted: true }),
		result({ structuredOutput: { status: "invalid", data: payload } }),
		result({ structuredOutput: { status: "valid", data: "Looks good." } }),
	]) {
		const rejected = captureReviewerResult(state, { waveIdentity: "wave-a", subject, toolCallId: "call-a", result: invalid, deliveryRequired: true });
		assert.equal(getCleanReviewerReceipt(rejected, { waveIdentity: "wave-a", subject }), undefined);
	}
	state = captureReviewerResult(state, { waveIdentity: "stale-wave", subject, toolCallId: "call-a", result: result() });
	state = captureReviewerResult(state, { waveIdentity: "wave-a", subject: { ...subject, headSha: "new-head" }, toolCallId: "call-a", result: result() });
	assert.equal(state.admissions["call-a"]?.result, undefined);
	state = captureReviewerResult(state, { waveIdentity: "wave-a", subject, toolCallId: "call-a", result: result(), deliveryRequired: true });
	state = captureReviewerDelivery(state, {
		waveIdentity: "wave-a", subject, toolCallId: "call-a",
		details: { jobs: [{ jobId: "wrong", type: "task", status: "failed", agentId: "reviewer-42", schema: { source: "caller", mode: "strict", status: "valid", data: payload } }] },
	});
	assert.equal(getCleanReviewerReceipt(state, { waveIdentity: "wave-a", subject }), undefined);
	state = captureReviewerTaskProgress(admission.state, { waveIdentity: "wave-a", subject, toolCallId: "call-a", details: nativeAsyncDetails() });
	state = captureReviewerDelivery(state, {
		waveIdentity: "wave-a", subject, toolCallId: "call-a",
		details: { jobs: [{ jobId: "job-42", type: "task", status: "completed", agentId: "reviewer-42", schema: { source: "caller", mode: "strict", status: "valid", data: payload } }] },
	});
	assert.equal(getCleanReviewerReceipt(state, { waveIdentity: "wave-a", subject })?.agentId, "reviewer-42");
	assert.equal(getCleanReviewerReceipt(state, { waveIdentity: "wave-a", subject, excludedAgentIds: ["reviewer-42"] }), undefined);
	assert.equal(getCleanReviewerReceipt(state, { waveIdentity: "other-wave", subject }), undefined);
	assert.equal(getCleanReviewerReceipt(state, { waveIdentity: "wave-a", subject: { ...subject, headSha: "new-head" } }), undefined);
});

test("findings and unknown verdicts never produce clean verification", () => {
	const admission = admit();
	const findings = { ...payload, verdict: "findings" as const, findings: [{ title: "Bug", body: "Fails", file: "a.ts", line: 3 }] };
	const state = captureReviewerResult(admission.state, {
		waveIdentity: "wave-a", subject, toolCallId: "call-a",
		result: result({ structuredOutput: { source: "caller", mode: "strict", status: "valid", data: findings } }),
	});
	assert.equal(getCleanReviewerReceipt(state, { waveIdentity: "wave-a", subject }), undefined);
});

test("receipt state rejects malformed records defensively", () => {
	const state: ReviewerReceiptState = { version: 1, admissions: {} };
	assert.equal(getCleanReviewerReceipt(state, { waveIdentity: "wave-a", subject }), undefined);
	assert.deepEqual(parseReviewerReceiptState(JSON.parse(JSON.stringify(state))), state);
	const admitted = admit().state;
	assert.deepEqual(parseReviewerReceiptState(JSON.parse(JSON.stringify(admitted))), admitted);
	const forged = JSON.parse(JSON.stringify(admitted));
	forged.admissions["call-a"].outputSchema = { type: "object" };
	assert.equal(parseReviewerReceiptState(forged), undefined);
});
