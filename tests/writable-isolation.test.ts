import assert from "node:assert/strict";
import test from "node:test";
import { parseWritableRuntimeQualification, writableDispatchBlocker, writableExecutionReplayBlocker, writableIsolationReport } from "../image/extension/review/writable-isolation.ts";

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
		assert.match(report.blocker ?? "", /image-baked root-owned runtime qualification artifact/i);
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

test("writable isolation cannot be enabled by a forged environment qualification flag", () => {
	const env = {
		REVIEW_WRITABLE_ISOLATION: "1",
		REVIEW_RUNTIME_PROFILE: "krun",
		REVIEW_WRITABLE_ISOLATION_QUALIFIED: "1",
	};
	const report = writableIsolationReport(env);
	assert.equal(report.mode, "opt-in-blocked");
	assert.equal(writableDispatchBlocker(env, "fix"), report.blocker);
	assert.match(report.blocker ?? "", /qualification artifact/i);
});

test("runtime qualification binds the packaged profile, binaries, contract and qualification suite", () => {
	const hashes = { bwrapSha256: "a".repeat(64), prlimitSha256: "b".repeat(64) };
	const manifest = {
		version: 1,
		profile: "krun",
		qualified: true,
		contractVersion: 1,
		qualificationSuiteSha256: "c".repeat(64),
		...hashes,
	};
	assert.deepEqual(parseWritableRuntimeQualification(manifest, "krun", hashes), {
		profile: "krun", contractVersion: 1, qualificationSuiteSha256: "c".repeat(64), ...hashes,
	});
	assert.equal(parseWritableRuntimeQualification({ ...manifest, profile: "apptainer" }, "krun", hashes), undefined);
	assert.equal(parseWritableRuntimeQualification({ ...manifest, prlimitSha256: "d".repeat(64) }, "krun", hashes), undefined);
	assert.equal(parseWritableRuntimeQualification({ ...manifest, qualified: false }, "krun", hashes), undefined);
});

test("a persisted isolated attempt can never be replayed through either worker path", () => {
	assert.equal(writableExecutionReplayBlocker(undefined), undefined);
	assert.match(writableExecutionReplayBlocker({ status: "running" }) ?? "", /UNKNOWN.*do not resume/i);
	assert.match(writableExecutionReplayBlocker({ status: "submitted" }) ?? "", /already has isolated execution evidence/i);
	assert.match(writableExecutionReplayBlocker({ status: "unknown" }) ?? "", /UNKNOWN.*do not resume/i);
	assert.match(writableExecutionReplayBlocker(null as never) ?? "", /unrecognized isolated execution evidence.*do not resume/i);
});
