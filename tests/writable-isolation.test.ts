import assert from "node:assert/strict";
import test from "node:test";
import { writableDispatchBlocker, writableIsolationReport } from "../image/extension/review/writable-isolation.ts";

test("the default Review path stays unchanged and makes no isolation claim", () => {
	const report = writableIsolationReport({});
	assert.equal(report.mode, "disabled");
	assert.equal(report.runtime, "unknown");
	assert.equal(report.osSandbox, "not-requested");
	assert.equal(report.taskExecutionTools, "legacy-default");
	assert.equal(report.dependencyReadiness, "not-assessed");
	assert.equal(report.publicationAuthorization, "not-attempted");
	assert.equal(writableDispatchBlocker({}, "slay"), undefined);
	assert.equal(writableDispatchBlocker({ REVIEW_WRITABLE_ISOLATION: "0" }, "fix"), undefined);
});

test("the opt-in path fails closed for every writable Slay/Fix batch before dispatch", () => {
	for (const kind of ["slay", "fix"] as const) {
		const env = { REVIEW_WRITABLE_ISOLATION: "1", REVIEW_RUNTIME_PROFILE: "krun" };
		const report = writableIsolationReport(env);
		assert.equal(report.mode, "opt-in-blocked");
		assert.equal(report.runtime, "krun");
		assert.equal(report.osSandbox, "unavailable");
		assert.equal(report.taskExecutionTools, "blocked");
		assert.equal(report.dependencyReadiness, "not-assessed");
		assert.equal(report.publicationAuthorization, "not-attempted");
		assert.equal(writableDispatchBlocker(env, kind), report.blocker);
		assert.match(report.blocker ?? "", /credentialless executor.*not integrated and qualified/i);
	}
});

test("read-only batches remain available while writable isolation is opted in", () => {
	const env = { REVIEW_WRITABLE_ISOLATION: "1", REVIEW_RUNTIME_PROFILE: "apptainer" };
	assert.equal(writableDispatchBlocker(env, "diff"), undefined);
	assert.equal(writableIsolationReport(env).runtime, "apptainer");
});

test("invalid opt-in values fail closed for writable dispatch", () => {
	const env = { REVIEW_WRITABLE_ISOLATION: "true" };
	const report = writableIsolationReport(env);
	assert.equal(report.mode, "invalid-blocked");
	assert.equal(report.osSandbox, "unavailable");
	assert.match(writableDispatchBlocker(env, "fix") ?? "", /must be exactly 0 or 1/);
	assert.equal(writableDispatchBlocker(env, "diff"), undefined);
});
