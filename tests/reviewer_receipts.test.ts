import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
	admitReviewerTask,
	captureReviewerDelivery,
	captureReviewerResult,
	createReviewerOutputSchema,
	createReviewerReceiptState,
	getCleanReviewerReceipt,
	parseReviewerReceiptState,
	reviewerDefinitionTrusted,
	type ReviewerPayload,
	type ReviewerReceiptState,
	type ReviewSubject,
} from "../image/extension/review/reviewer-receipts.ts";

const subject: ReviewSubject = { repository: "acme/widgets", number: 42, headSha: "deadbeef" };
const payload: ReviewerPayload = { ...subject, verdict: "clean", findings: [], summary: "No findings." };

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
		structuredOutput: { status: "valid", data: payload },
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

	const asyncAdmission = admit(createReviewerReceiptState());
	assert.ok(asyncAdmission.admitted);
	let state = captureReviewerResult(asyncAdmission.state, {
		waveIdentity: "wave-a", subject, toolCallId: "call-a", result: result(),
		jobId: "job-42", deliveryRequired: true,
	});
	assert.equal(getCleanReviewerReceipt(state, { waveIdentity: "wave-a", subject }), undefined);
	state = captureReviewerResult(admission.state, { waveIdentity: "wave-a", subject, toolCallId: "call-a", result: result(), deliveryRequired: true });
	state = captureReviewerDelivery(state, {
		waveIdentity: "wave-a", subject, toolCallId: "call-a",
		details: { jobs: [{ jobId: "job-42", type: "task", status: "completed", agentId: "reviewer-42", schema: { status: "valid", data: payload } }] },
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
		details: { jobs: [{ jobId: "wrong", type: "task", status: "failed", agentId: "reviewer-42", schema: { status: "valid", data: payload } }] },
	});
	assert.equal(getCleanReviewerReceipt(state, { waveIdentity: "wave-a", subject }), undefined);
	state = captureReviewerResult(admission.state, { waveIdentity: "wave-a", subject, toolCallId: "call-a", result: result(), deliveryRequired: true });
	state = captureReviewerDelivery(state, {
		waveIdentity: "wave-a", subject, toolCallId: "call-a",
		details: { jobs: [{ jobId: "job-42", type: "task", status: "completed", agentId: "reviewer-42", schema: { status: "valid", data: payload } }] },
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
		result: result({ structuredOutput: { status: "valid", data: findings } }),
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
