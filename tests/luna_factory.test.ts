/**
 * Contract tests for the Luna Factory extension.
 *
 * The pure core is driven directly, because the decisions this package exists to
 * make — admission, evidence binding, convergence, repair lineage — are exactly
 * the ones that must not depend on a terminal, a model, or a live OMP process.
 * The extension surface is driven against a fake host for the same reason.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { admit } from "../image/extension/luna-factory/core/admission.ts";
import { evaluateRun } from "../image/extension/luna-factory/core/convergence.ts";
import { criterionProven, reconcileReceipt } from "../image/extension/luna-factory/core/evidence.ts";
import { JOURNAL_ENTRY, durabilityOf, journalRecord, parseJournal, readJournal } from "../image/extension/luna-factory/core/journal.ts";
import { emptyLedger, findTask } from "../image/extension/luna-factory/core/model.ts";
import type {
	Candidate,
	CriterionId,
	EvidenceReceipt,
	GenerationId,
	Ledger,
	LedgerEvent,
	RunId,
	Subject,
	TaskId,
} from "../image/extension/luna-factory/core/model.ts";
import { renderCompletionReceipt } from "../image/extension/luna-factory/core/receipt.ts";
import { reduce } from "../image/extension/luna-factory/core/reducer.ts";
import { artifactRefError, changedPathError, parseCandidate, parseReceipt, parseSubject } from "../image/extension/luna-factory/core/schema.ts";
import { buildDispatchPrompt, dispatchMarker, RECEIPT_CONTRACT } from "../image/extension/luna-factory/omp/adapter.ts";
import { DISPATCH_COVERAGE, coverageFor, enforcedPaths, unsupportedPaths } from "../image/extension/luna-factory/omp/capabilities.ts";
import { renderStatus, renderStatusDetail, renderWhy } from "../image/extension/luna-factory/ui/status.ts";
import lunaFactoryExtension, { createLunaFactoryExtension } from "../image/extension/luna-factory/index.ts";

const ROOTS = ["/artifacts"];
const REDUCE = { artifactRoots: ROOTS };
const SUBJECT: Subject = { repo: "example/repo", base: "a".repeat(40) };

function ledger(): Ledger {
	return emptyLedger(
		"lf-test" as RunId,
		{
			statement: "ship the small fix",
			nonGoals: ["no new dashboard"],
			permittedEffects: ["read", "write"],
			finishAuthority: "report the verified result",
			appetite: { tasks: 8, attemptsPerTask: 2 },
		},
		[
			{ id: "A1" as CriterionId, statement: "the fix is proven", mandatory: true },
			{ id: "A2" as CriterionId, statement: "docs mention it", mandatory: false },
		],
		SUBJECT,
	);
}

function candidate(overrides: Partial<Candidate> = {}): Candidate {
	return {
		taskId: "T1" as TaskId,
		generation: "G1" as GenerationId,
		criterionId: "A1" as CriterionId,
		title: "fix it",
		deps: [],
		effect: "read",
		owner: "luna",
		necessity: "A1 is unproven",
		...overrides,
	};
}

function receipt(overrides: Partial<EvidenceReceipt> = {}): EvidenceReceipt {
	const base: EvidenceReceipt = {
		version: 1,
		taskId: "T1" as TaskId,
		attemptId: "T1-a1",
		generation: "G1" as GenerationId,
		subject: SUBJECT,
		result: "fixed",
		changed: ["src/x.ts"],
		evidence: ["/artifacts/run.log"],
		tests: [{ command: "bash tests/x.sh", outcome: "pass", artifact: "/artifacts/x.log" }],
		cleanEnvironment: true,
		unresolved: [],
		next: "none",
		confidence: "high",
		routing: { requested: "lf-worker", verified: false },
		exitCode: 0,
		aborted: false,
		truncated: false,
	};
	return { ...base, ...overrides };
}

/** Apply one event, failing the test if the ledger rejects it. */
function step(current: Ledger, build: (revision: number) => LedgerEvent): Ledger {
	const result = reduce(current, build(current.revision), REDUCE);
	assert.equal(result.ok, true, result.ok ? "" : result.error);
	return result.ok ? result.ledger : current;
}

/** An admitted, running task with one attempt already opened. */
function runningTask(): Ledger {
	const admitted = step(ledger(), (revision) => ({ kind: "record_candidate", expectedRevision: revision, candidate: candidate() }));
	return step(admitted, (revision) => ({
		kind: "start_attempt",
		expectedRevision: revision,
		taskId: "T1" as TaskId,
		attemptId: "T1-a1",
		subject: SUBJECT,
	}));
}

// ----------------------------------------------------------------- admission

test("a candidate tied to an unproven criterion with satisfied dependencies is admitted", () => {
	const verdict = admit(ledger(), candidate());
	assert.equal(verdict.decision, "ADMIT");
	assert.match(verdict.reason, /A1/);
});

test("a candidate that proves an unknown criterion escalates rather than admitting", () => {
	const verdict = admit(ledger(), candidate({ criterionId: "A9" as CriterionId }));
	assert.equal(verdict.decision, "ESCALATE");
	assert.match(verdict.reason, /unknown criterion A9/);
});

test("a candidate for an already-proven criterion is dismissed", () => {
	const proven = step(runningTask(), (revision) => ({ kind: "record_receipt", expectedRevision: revision, taskId: "T1" as TaskId, attemptId: "T1-a1", receipt: receipt() }));
	const finished = step(proven, (revision) => ({ kind: "finish_task", expectedRevision: revision, taskId: "T1" as TaskId, criterionId: "A1" as CriterionId }));
	const verdict = admit(finished, candidate({ taskId: "T2" as TaskId }));
	assert.equal(verdict.decision, "DISMISS");
	assert.match(verdict.reason, /already holds current proof/);
});

test("a candidate whose dependency is unknown defers, and whose dependency is unproven also defers", () => {
	const unknown = admit(ledger(), candidate({ deps: ["T9" as TaskId] }));
	assert.equal(unknown.decision, "DEFER");
	assert.match(unknown.reason, /not in the ledger/);

	const pending = step(ledger(), (revision) => ({ kind: "record_candidate", expectedRevision: revision, candidate: candidate({ taskId: "T0" as TaskId }) }));
	const dependent = admit(pending, candidate({ taskId: "T2" as TaskId, deps: ["T0" as TaskId] }));
	assert.equal(dependent.decision, "DEFER");
	assert.match(dependent.reason, /T0 is READY, not proven/);
});

test("a dependency cycle escalates instead of dispatching a tangle", () => {
	const nested = step(
		ledger(),
		(revision) => ({ kind: "record_candidate", expectedRevision: revision, candidate: candidate({ taskId: "T0" as TaskId }) }),
	);
	const chained = step(nested, (revision) => ({
		kind: "record_candidate",
		expectedRevision: revision,
		candidate: candidate({ taskId: "T2" as TaskId, deps: ["T0" as TaskId] }),
	}));
	const cyclic = {
		...chained,
		tasks: chained.tasks.map((task) => (task.id === ("T2" as TaskId) ? { ...task, deps: ["T3" as TaskId] } : task)),
	};
	const verdict = admit(cyclic, candidate({ taskId: "T3" as TaskId, deps: ["T2" as TaskId] }));
	assert.equal(verdict.decision, "ESCALATE");
	assert.match(verdict.reason, /depends on itself/);
});

test("an effect the objective does not permit escalates", () => {
	const readOnly = emptyLedger(
		"lf-test" as RunId,
		{ statement: "inspect only", nonGoals: [], permittedEffects: ["read"], appetite: { tasks: 4, attemptsPerTask: 1 } },
		[{ id: "A1" as CriterionId, statement: "report", mandatory: true }],
		SUBJECT,
	);
	const verdict = admit(readOnly, candidate({ effect: "write" }));
	assert.equal(verdict.decision, "ESCALATE");
	assert.match(verdict.reason, /does not permit 'write'/);
});

test("a second active writer on the same subject defers", () => {
	const writer = candidate({ taskId: "T1" as TaskId, effect: "write" });
	const first = step(ledger(), (revision) => ({ kind: "record_candidate", expectedRevision: revision, candidate: writer }));
	const second = admit(first, candidate({ taskId: "T2" as TaskId, criterionId: "A2" as CriterionId, effect: "write" }));
	assert.equal(second.decision, "DEFER");
	assert.match(second.reason, /conflicting writer T1/);
});

test("independent admitted tasks can run in parallel on the same subject", () => {
	const withA = step(ledger(), (revision) => ({ kind: "record_candidate", expectedRevision: revision, candidate: candidate() }));
	const withB = step(withA, (revision) => ({
		kind: "record_candidate",
		expectedRevision: revision,
		candidate: candidate({ taskId: "T2" as TaskId, criterionId: "A2" as CriterionId }),
	}));
	const startedA = step(withB, (revision) => ({
		kind: "start_attempt",
		expectedRevision: revision,
		taskId: "T1" as TaskId,
		attemptId: "T1-a1",
		subject: SUBJECT,
	}));
	const startedB = step(startedA, (revision) => ({
		kind: "start_attempt",
		expectedRevision: revision,
		taskId: "T2" as TaskId,
		attemptId: "T2-a1",
		subject: SUBJECT,
	}));
	assert.equal(findTask(startedB, "T1" as TaskId)?.state, "RUNNING");
	assert.equal(findTask(startedB, "T2" as TaskId)?.state, "RUNNING");
});

test("a deferred dependency join becomes READY only after every dependency is proven", () => {
	const joined = emptyLedger(
		"lf-join" as RunId,
		ledger().goal,
		[
			{ id: "A1" as CriterionId, statement: "A is proven", mandatory: true },
			{ id: "A2" as CriterionId, statement: "B is proven", mandatory: true },
			{ id: "A3" as CriterionId, statement: "the join is proven", mandatory: true },
		],
		SUBJECT,
	);
	let current = step(joined, (revision) => ({
		kind: "record_candidate",
		expectedRevision: revision,
		candidate: candidate({ taskId: "T1" as TaskId, criterionId: "A1" as CriterionId }),
	}));
	current = step(current, (revision) => ({
		kind: "record_candidate",
		expectedRevision: revision,
		candidate: candidate({ taskId: "T2" as TaskId, criterionId: "A2" as CriterionId }),
	}));
	current = step(current, (revision) => ({
		kind: "record_candidate",
		expectedRevision: revision,
		candidate: candidate({ taskId: "T3" as TaskId, criterionId: "A3" as CriterionId, deps: ["T1" as TaskId, "T2" as TaskId] }),
	}));
	assert.equal(findTask(current, "T3" as TaskId)?.state, "DEFERRED");

	current = step(current, (revision) => ({ kind: "start_attempt", expectedRevision: revision, taskId: "T1" as TaskId, attemptId: "T1-a1", subject: SUBJECT }));
	current = step(current, (revision) => ({ kind: "record_receipt", expectedRevision: revision, taskId: "T1" as TaskId, attemptId: "T1-a1", receipt: receipt({ taskId: "T1" as TaskId, attemptId: "T1-a1" }) }));
	current = step(current, (revision) => ({ kind: "finish_task", expectedRevision: revision, taskId: "T1" as TaskId, criterionId: "A1" as CriterionId }));
	assert.equal(findTask(current, "T3" as TaskId)?.state, "DEFERRED", "one proven dependency is not a join");

	current = step(current, (revision) => ({ kind: "start_attempt", expectedRevision: revision, taskId: "T2" as TaskId, attemptId: "T2-a1", subject: SUBJECT }));
	current = step(current, (revision) => ({ kind: "record_receipt", expectedRevision: revision, taskId: "T2" as TaskId, attemptId: "T2-a1", receipt: receipt({ taskId: "T2" as TaskId, attemptId: "T2-a1" }) }));
	current = step(current, (revision) => ({ kind: "finish_task", expectedRevision: revision, taskId: "T2" as TaskId, criterionId: "A2" as CriterionId }));
	assert.equal(findTask(current, "T3" as TaskId)?.state, "READY");
	assert.equal(findTask(current, "T3" as TaskId)?.decision, "ADMIT");
});

test("an exhausted objective appetite defers further admission", () => {
	const tight = emptyLedger(
		"lf-test" as RunId,
		{ statement: "one small thing", nonGoals: [], permittedEffects: ["read"], appetite: { tasks: 1, attemptsPerTask: 1 } },
		[{ id: "A1" as CriterionId, statement: "prove it", mandatory: true }],
		SUBJECT,
	);
	const taken = step(tight, (revision) => ({ kind: "record_candidate", expectedRevision: revision, candidate: candidate() }));
	const verdict = admit(taken, candidate({ taskId: "T2" as TaskId, criterionId: "A1" as CriterionId }));
	assert.equal(verdict.decision, "DEFER");
	assert.match(verdict.reason, /appetite of 1 admitted tasks is exhausted/);
});

test("a candidate for an older generation escalates to the owner", () => {
	const verdict = admit(ledger(), candidate({ generation: "G2" as GenerationId }));
	assert.equal(verdict.decision, "ESCALATE");
	assert.match(verdict.reason, /only the owner may change the objective/);
});

test("a converged objective dismisses a post-success successor candidate", () => {
	const recorded = step(runningTask(), (revision) => ({
		kind: "record_receipt",
		expectedRevision: revision,
		taskId: "T1" as TaskId,
		attemptId: "T1-a1",
		receipt: receipt(),
	}));
	const finished = step(recorded, (revision) => ({
		kind: "finish_task",
		expectedRevision: revision,
		taskId: "T1" as TaskId,
		criterionId: "A1" as CriterionId,
	}));
	const successor = admit(finished, candidate({ taskId: "T2" as TaskId, criterionId: "A2" as CriterionId }));
	assert.equal(successor.decision, "DISMISS");
	assert.match(successor.reason, /objective is already converged/);
});

test("three fresh matched trials keep the post-success trap closed but admit a genuine defect repair", () => {
	for (let trial = 1; trial <= 3; trial += 1) {
		const recorded = step(runningTask(), (revision) => ({
			kind: "record_receipt",
			expectedRevision: revision,
			taskId: "T1" as TaskId,
			attemptId: "T1-a1",
			receipt: receipt(),
		}));
		const finished = step(recorded, (revision) => ({
			kind: "finish_task",
			expectedRevision: revision,
			taskId: "T1" as TaskId,
			criterionId: "A1" as CriterionId,
		}));

		const postSuccessCleanup = admit(finished, candidate({ taskId: `cleanup-${trial}` as TaskId, criterionId: "A2" as CriterionId }));
		assert.equal(postSuccessCleanup.decision, "DISMISS", `trial ${trial} admitted successor work after convergence`);

		const defect = step(finished, (revision) => ({
			kind: "reopen_task",
			expectedRevision: revision,
			taskId: "T1" as TaskId,
			reason: `trial ${trial}: reproduced a data-loss defect after the green result`,
		}));
		assert.equal(findTask(defect, "T1" as TaskId)?.state, "READY");
		const repair = admit(defect, candidate({ taskId: `repair-${trial}` as TaskId, criterionId: "A1" as CriterionId }));
		assert.equal(repair.decision, "ADMIT", `trial ${trial} dismissed a legitimate defect repair`);
	}
});

// -------------------------------------------------------------------- schema

test("receipt shape is validated, and a valid one round-trips", () => {
	const parsed = parseReceipt(receipt());
	assert.equal(parsed.ok, true);
	assert.equal(parsed.ok ? parsed.value.taskId : "", "T1");
});

test("receipt parsing rejects a wrong version, bad enums, and a non-integer exit code", () => {
	const badVersion = parseReceipt({ ...receipt(), version: 2 });
	assert.equal(badVersion.ok, false);
	assert.match(badVersion.ok ? "" : badVersion.errors.join(";"), /version must be 1/);

	const badOutcome = parseReceipt({ ...receipt(), tests: [{ command: "x", outcome: "maybe" }] });
	assert.equal(badOutcome.ok, false);
	assert.match(badOutcome.ok ? "" : badOutcome.errors.join(";"), /outcome must be pass, fail, or not-run/);

	const badExit = parseReceipt({ ...receipt(), exitCode: 1.5 });
	assert.equal(badExit.ok, false);
	assert.match(badExit.ok ? "" : badExit.errors.join(";"), /exitCode must be an integer/);
});

test("receipt parsing rejects an unbounded payload", () => {
	const oversized = parseReceipt({ ...receipt(), result: "x".repeat(3_000) });
	assert.equal(oversized.ok, false);
	assert.match(oversized.ok ? "" : oversized.errors.join(";"), /exceeds 2000 characters/);
});

test("candidate parsing rejects an unknown effect and a malformed dependency identity", () => {
	const badEffect = parseCandidate({ ...candidate(), effect: "deploy" });
	assert.equal(badEffect.ok, false);

	const badDep = parseCandidate({ ...candidate(), deps: ["not a task id!"] });
	assert.equal(badDep.ok, false);
	assert.match(badDep.ok ? "" : badDep.errors.join(";"), /not a bounded identity/);
});

test("subject parsing binds a run to a repository and git object identity", () => {
	assert.equal(parseSubject({ repo: "example/repo", base: "a".repeat(40) }).ok, true);
	const badRepo = parseSubject({ repo: "../../outside", base: "a".repeat(40) });
	assert.equal(badRepo.ok, false);
	const badBase = parseSubject({ repo: "example/repo", base: "main" });
	assert.equal(badBase.ok, false);
});

test("artifact references outside the run's roots are rejected, not followed", () => {
	assert.match(artifactRefError("https://example.test/log", ROOTS) ?? "", /remote artifact references/);
	assert.match(artifactRefError("/artifacts/../etc/passwd", ROOTS) ?? "", /escapes its artifact root/);
	assert.match(artifactRefError("~/secrets", ROOTS) ?? "", /home-directory expansion/);
	assert.match(artifactRefError("/tmp/log", ROOTS) ?? "", /outside the run's artifact roots/);
	assert.equal(artifactRefError("/artifacts/run.log", ROOTS), undefined);
	assert.equal(artifactRefError("/artifacts", ROOTS), undefined);
	assert.equal(artifactRefError("artifact://run.log", ["artifact://"]), undefined);
	assert.match(artifactRefError("artifact://../outside.log", ["artifact://"]) ?? "", /escapes its artifact root/);
	assert.equal(changedPathError("src/x.ts"), undefined);
	assert.match(changedPathError("../outside.ts") ?? "", /escapes the repository root/);
	assert.match(changedPathError("/etc/passwd") ?? "", /repository-relative/);
	assert.match(changedPathError("https://example.test/log") ?? "", /remote/);
	assert.match(changedPathError("src/..\\secret") ?? "", /path separators/);
});

// ------------------------------------------------------------------ evidence

test("a clean, complete receipt at the certified identity reconciles as proven", () => {
	const result = reconcileReceipt(ledger(), receipt(), { taskId: "T1" as TaskId, attemptId: "T1-a1", subject: SUBJECT, artifactRoots: ROOTS });
	assert.equal(result.status, "proven");
	assert.deepEqual(result.reasons, []);
});

test("a receipt for another task, attempt, generation, or subject is contradicted, not merely weak", () => {
	const wrongTask = reconcileReceipt(ledger(), receipt({ taskId: "T2" as TaskId }), { taskId: "T1" as TaskId, attemptId: "T1-a1", subject: SUBJECT, artifactRoots: ROOTS });
	assert.equal(wrongTask.status, "contradicted");

	const wrongAttempt = reconcileReceipt(ledger(), receipt({ attemptId: "T1-a2" }), { taskId: "T1" as TaskId, attemptId: "T1-a1", subject: SUBJECT, artifactRoots: ROOTS });
	assert.equal(wrongAttempt.status, "contradicted");

	const wrongGeneration = reconcileReceipt(ledger(), receipt({ generation: "G2" as GenerationId }), { taskId: "T1" as TaskId, attemptId: "T1-a1", subject: SUBJECT, artifactRoots: ROOTS });
	assert.equal(wrongGeneration.status, "contradicted");

	const wrongSubject = reconcileReceipt(ledger(), receipt({ subject: { ...SUBJECT, head: "b".repeat(40) } }), { taskId: "T1" as TaskId, attemptId: "T1-a1", subject: SUBJECT, artifactRoots: ROOTS });
	assert.equal(wrongSubject.status, "contradicted");
});

test("a nonzero exit contradicts claimed passing verification and fails an unclaimed one", () => {
	const contradicted = reconcileReceipt(ledger(), receipt({ exitCode: 1 }), { taskId: "T1" as TaskId, attemptId: "T1-a1", subject: SUBJECT, artifactRoots: ROOTS });
	assert.equal(contradicted.status, "contradicted");

	const failed = reconcileReceipt(ledger(), receipt({ exitCode: 1, tests: [{ command: "bash tests/x.sh", outcome: "not-run" }] }), {
		taskId: "T1" as TaskId,
		attemptId: "T1-a1",
		subject: SUBJECT,
		artifactRoots: ROOTS,
	});
	assert.equal(failed.status, "failed");
});

test("aborted, truncated, unresolved, or unclean receipts are unproved rather than successful", () => {
	for (const patch of [{ aborted: true }, { truncated: true }, { unresolved: ["could not run the suite"] }, { cleanEnvironment: "unknown" as const }]) {
		const result = reconcileReceipt(ledger(), receipt(patch), { taskId: "T1" as TaskId, attemptId: "T1-a1", subject: SUBJECT, artifactRoots: ROOTS });
		assert.equal(result.status, "unproved", JSON.stringify(patch));
		assert.ok(result.reasons.length > 0, JSON.stringify(patch));
	}
});

test("a receipt claiming verification with no evidence reference is unproved", () => {
	const result = reconcileReceipt(ledger(), receipt({ evidence: [], changed: [] }), { taskId: "T1" as TaskId, attemptId: "T1-a1", subject: SUBJECT, artifactRoots: ROOTS });
	assert.equal(result.status, "unproved");
	assert.match(result.reasons.join(";"), /no evidence reference/);
});

test("a receipt referencing an artifact outside the roots fails", () => {
	const result = reconcileReceipt(ledger(), receipt({ evidence: ["/tmp/other.log"] }), {
		taskId: "T1" as TaskId,
		attemptId: "T1-a1",
		subject: SUBJECT,
		artifactRoots: ROOTS,
	});
	assert.equal(result.status, "failed");
});

// ------------------------------------------------------------------- reducer

test("a stale revision is rejected instead of overwriting a newer decision", () => {
	const current = runningTask();
	const stale = reduce(current, { kind: "set_control", expectedRevision: current.revision - 1, control: "paused" }, REDUCE);
	assert.equal(stale.ok, false);
	assert.match(stale.ok ? "" : stale.error, /stale revision/);
});

test("pause and drain close admission but allow already-started work to return", () => {
	const paused = step(ledger(), (revision) => ({ kind: "set_control", expectedRevision: revision, control: "paused" }));
	const candidateWhilePaused = reduce(paused, { kind: "record_candidate", expectedRevision: paused.revision, candidate: candidate() }, REDUCE);
	assert.equal(candidateWhilePaused.ok, true);
	assert.equal(candidateWhilePaused.ok ? findTask(candidateWhilePaused.ledger, "T1" as TaskId)?.decision : "", "DEFER");
	const startWhilePaused = reduce(paused, { kind: "start_attempt", expectedRevision: paused.revision, taskId: "T1" as TaskId, attemptId: "T1-a1", subject: SUBJECT }, REDUCE);
	assert.equal(startWhilePaused.ok, false);
	assert.match(startWhilePaused.ok ? "" : startWhilePaused.error, /admission is closed/);

	const draining = step(runningTask(), (revision) => ({ kind: "set_control", expectedRevision: revision, control: "draining" }));
	const startWhileDraining = reduce(draining, { kind: "start_attempt", expectedRevision: draining.revision, taskId: "T1" as TaskId, attemptId: "T1-a2", subject: SUBJECT }, REDUCE);
	assert.equal(startWhileDraining.ok, false);
	assert.match(startWhileDraining.ok ? "" : startWhileDraining.error, /admission is closed/);
	const drained = step(draining, (revision) => ({ kind: "record_receipt", expectedRevision: revision, taskId: "T1" as TaskId, attemptId: "T1-a1", receipt: receipt() }));
	assert.equal(drained.control, "paused");
});

test("an interrupted attempt must be reconciled before resume and keeps retry lineage", () => {
	const interrupted = step(runningTask(), (revision) => ({ kind: "set_control", expectedRevision: revision, control: "interrupted" }));
	const refused = reduce(interrupted, { kind: "set_control", expectedRevision: interrupted.revision, control: "active" }, REDUCE);
	assert.equal(refused.ok, false);
	assert.match(refused.ok ? "" : refused.error, /must be reconciled/);

	const reconciled = step(interrupted, (revision) => ({
		kind: "reconcile_attempt",
		expectedRevision: revision,
		taskId: "T1" as TaskId,
		attemptId: "T1-a1",
		outcome: "abandoned",
		reason: "native cancellation was acknowledged",
	}));
	assert.equal(findTask(reconciled, "T1" as TaskId)?.state, "READY");
	assert.equal(findTask(reconciled, "T1" as TaskId)?.attempts[0]?.state, "abandoned");
	const resumed = step(reconciled, (revision) => ({ kind: "set_control", expectedRevision: revision, control: "active" }));
	const retry = step(resumed, (revision) => ({ kind: "start_attempt", expectedRevision: revision, taskId: "T1" as TaskId, attemptId: "T1-a2", subject: SUBJECT }));
	assert.deepEqual(findTask(retry, "T1" as TaskId)?.attempts.map((attempt) => attempt.lineage), [1, 2]);
});

test("an unproven write cannot be integrated as if it were accepted", () => {
	const writer = candidate({ effect: "write" });
	const admitted = step(ledger(), (revision) => ({ kind: "record_candidate", expectedRevision: revision, candidate: writer }));
	const started = step(admitted, (revision) => ({ kind: "start_attempt", expectedRevision: revision, taskId: "T1" as TaskId, attemptId: "T1-a1", subject: SUBJECT }));
	const returned = step(started, (revision) => ({ kind: "record_receipt", expectedRevision: revision, taskId: "T1" as TaskId, attemptId: "T1-a1", receipt: receipt({ unresolved: ["defect remains"] }) }));
	const integrated = reduce(returned, { kind: "integrate_attempt", expectedRevision: returned.revision, taskId: "T1" as TaskId, attemptId: "T1-a1", subject: { ...SUBJECT, head: "b".repeat(40) } }, REDUCE);
	assert.equal(integrated.ok, false);
	assert.match(integrated.ok ? "" : integrated.error, /not proven/);
});
test("a proven write cannot integrate without an externally changed head", () => {
	const writer = candidate({ effect: "write" });
	const admitted = step(ledger(), (revision) => ({ kind: "record_candidate", expectedRevision: revision, candidate: writer }));
	const started = step(admitted, (revision) => ({ kind: "start_attempt", expectedRevision: revision, taskId: "T1" as TaskId, attemptId: "T1-a1", subject: SUBJECT }));
	const returned = step(started, (revision) => ({ kind: "record_receipt", expectedRevision: revision, taskId: "T1" as TaskId, attemptId: "T1-a1", receipt: receipt() }));
	const integrated = reduce(returned, { kind: "integrate_attempt", expectedRevision: returned.revision, taskId: "T1" as TaskId, attemptId: "T1-a1", subject: SUBJECT }, REDUCE);
	assert.equal(integrated.ok, false);
	assert.match(integrated.ok ? "" : integrated.error, /externally changed head|concrete changed head/);
});

test("only a READY task may start, and an attempt id is not reused", () => {
	const admitted = step(ledger(), (revision) => ({ kind: "record_candidate", expectedRevision: revision, candidate: candidate() }));
	const started = step(admitted, (revision) => ({
		kind: "start_attempt",
		expectedRevision: revision,
		taskId: "T1" as TaskId,
		attemptId: "T1-a1",
		subject: SUBJECT,
	}));
	const again = reduce(started, { kind: "start_attempt", expectedRevision: started.revision, taskId: "T1" as TaskId, attemptId: "T1-a2", subject: SUBJECT }, REDUCE);
	assert.equal(again.ok, false);
	assert.match(again.ok ? "" : again.error, /only READY or VERIFY tasks may start/);

	const duplicate = reduce(admitted, { kind: "start_attempt", expectedRevision: admitted.revision, taskId: "T1" as TaskId, attemptId: "T1-a1", subject: SUBJECT }, REDUCE);
	assert.equal(duplicate.ok, true);

	const reused = reduce(started, { kind: "start_attempt", expectedRevision: started.revision, taskId: "T1" as TaskId, attemptId: "T1-a1", subject: SUBJECT }, REDUCE);
	assert.equal(reused.ok, false);
	assert.match(reused.ok ? "" : reused.error, /already exists/);
});

test("an unproven VERIFY task can open one bounded retry on the same lineage", () => {
	const returned = step(runningTask(), (revision) => ({
		kind: "record_receipt",
		expectedRevision: revision,
		taskId: "T1" as TaskId,
		attemptId: "T1-a1",
		receipt: receipt({ unresolved: ["still broken"] }),
	}));
	const retry = step(returned, (revision) => ({
		kind: "start_attempt",
		expectedRevision: revision,
		taskId: "T1" as TaskId,
		attemptId: "T1-a2",
		subject: SUBJECT,
	}));
	assert.equal(findTask(retry, "T1" as TaskId)?.state, "RUNNING");
	assert.deepEqual(findTask(retry, "T1" as TaskId)?.attempts.map((attempt) => attempt.lineage), [1, 2]);
});

test("a returned worker moves to VERIFY and never straight to DONE", () => {
	const recorded = step(runningTask(), (revision) => ({ kind: "record_receipt", expectedRevision: revision, taskId: "T1" as TaskId, attemptId: "T1-a1", receipt: receipt() }));
	assert.equal(findTask(recorded, "T1" as TaskId)?.state, "VERIFY");
	assert.equal(criterionProven(recorded, "A1" as CriterionId), false);
});

test("a receipt may only be recorded once per attempt", () => {
	const recorded = step(runningTask(), (revision) => ({ kind: "record_receipt", expectedRevision: revision, taskId: "T1" as TaskId, attemptId: "T1-a1", receipt: receipt() }));
	const repeat = reduce(recorded, { kind: "record_receipt", expectedRevision: recorded.revision, taskId: "T1" as TaskId, attemptId: "T1-a1", receipt: receipt() }, REDUCE);
	assert.equal(repeat.ok, false);
	assert.match(repeat.ok ? "" : repeat.error, /already has a recorded receipt/);
});

test("a write task cannot complete before its attempt is integrated", () => {
	const writer = candidate({ effect: "write" });
	const admitted = step(ledger(), (revision) => ({ kind: "record_candidate", expectedRevision: revision, candidate: writer }));
	const started = step(admitted, (revision) => ({ kind: "start_attempt", expectedRevision: revision, taskId: "T1" as TaskId, attemptId: "T1-a1", subject: SUBJECT }));
	const recorded = step(started, (revision) => ({ kind: "record_receipt", expectedRevision: revision, taskId: "T1" as TaskId, attemptId: "T1-a1", receipt: receipt() }));
	const finish = reduce(recorded, { kind: "finish_task", expectedRevision: recorded.revision, taskId: "T1" as TaskId, criterionId: "A1" as CriterionId }, REDUCE);
	assert.equal(finish.ok, false);
	assert.match(finish.ok ? "" : finish.error, /must be integrated/);
});

test("proven evidence completes a task and converges the run", () => {
	const recorded = step(runningTask(), (revision) => ({ kind: "record_receipt", expectedRevision: revision, taskId: "T1" as TaskId, attemptId: "T1-a1", receipt: receipt() }));
	const finished = step(recorded, (revision) => ({ kind: "finish_task", expectedRevision: revision, taskId: "T1" as TaskId, criterionId: "A1" as CriterionId }));
	assert.equal(findTask(finished, "T1" as TaskId)?.state, "DONE");
	const verdict = evaluateRun(finished);
	assert.equal(verdict.converged, true);
	assert.equal(verdict.provenMandatory, 1);
});

test("unproven evidence is refused at completion", () => {
	const recorded = step(runningTask(), (revision) => ({
		kind: "record_receipt",
		expectedRevision: revision,
		taskId: "T1" as TaskId,
		attemptId: "T1-a1",
		receipt: receipt({ unresolved: ["the suite could not run"] }),
	}));
	const finish = reduce(recorded, { kind: "finish_task", expectedRevision: recorded.revision, taskId: "T1" as TaskId, criterionId: "A1" as CriterionId }, REDUCE);
	assert.equal(finish.ok, false);
	assert.match(finish.ok ? "" : finish.error, /evidence is unproved/);
});

test("a task cannot certify a criterion it never targeted", () => {
	const recorded = step(runningTask(), (revision) => ({ kind: "record_receipt", expectedRevision: revision, taskId: "T1" as TaskId, attemptId: "T1-a1", receipt: receipt() }));
	const finish = reduce(recorded, { kind: "finish_task", expectedRevision: recorded.revision, taskId: "T1" as TaskId, criterionId: "A2" as CriterionId }, REDUCE);
	assert.equal(finish.ok, false);
	assert.match(finish.ok ? "" : finish.error, /proves criterion A1, not A2/);
});

test("integrating a moved head demotes proof taken against the old subject", () => {
	const firstRecorded = step(runningTask(), (revision) => ({ kind: "record_receipt", expectedRevision: revision, taskId: "T1" as TaskId, attemptId: "T1-a1", receipt: receipt() }));
	const firstFinished = step(firstRecorded, (revision) => ({ kind: "finish_task", expectedRevision: revision, taskId: "T1" as TaskId, criterionId: "A1" as CriterionId }));
	const writer = candidate({ taskId: "T2" as TaskId, criterionId: "A2" as CriterionId, effect: "write" });
	const stillOpen = { ...firstFinished, criteria: firstFinished.criteria.map((criterion) => criterion.id === ("A2" as CriterionId) ? { ...criterion, mandatory: true } : criterion) };
	const admitted = step(stillOpen, (revision) => ({ kind: "record_candidate", expectedRevision: revision, candidate: writer }));
	const started = step(admitted, (revision) => ({ kind: "start_attempt", expectedRevision: revision, taskId: "T2" as TaskId, attemptId: "T2-a1", subject: SUBJECT }));
	const recorded = step(started, (revision) => ({ kind: "record_receipt", expectedRevision: revision, taskId: "T2" as TaskId, attemptId: "T2-a1", receipt: receipt({ taskId: "T2" as TaskId, attemptId: "T2-a1" }) }));
	const moved = step(recorded, (revision) => ({
		kind: "integrate_attempt",
		expectedRevision: revision,
		taskId: "T2" as TaskId,
		attemptId: "T2-a1",
		subject: { ...SUBJECT, head: "c".repeat(40) },
	}));
	assert.equal(findTask(moved, "T1" as TaskId)?.state, "VERIFY");
	assert.equal(criterionProven(moved, "A1" as CriterionId), false);
});

test("proof at an older subject cannot be completed", () => {
	const recorded = step(runningTask(), (revision) => ({ kind: "record_receipt", expectedRevision: revision, taskId: "T1" as TaskId, attemptId: "T1-a1", receipt: receipt() }));
	const moved = { ...recorded, subject: { ...SUBJECT, head: "e".repeat(40) } };
	const finish = reduce(moved, { kind: "finish_task", expectedRevision: moved.revision, taskId: "T1" as TaskId, criterionId: "A1" as CriterionId }, REDUCE);
	assert.equal(finish.ok, false);
	assert.match(finish.ok ? "" : finish.error, /older subject/);
});

test("a receipt arriving for a superseded subject is unproved, not accepted late", () => {
	const recorded = step(runningTask(), (revision) => ({
		kind: "record_native_job",
		expectedRevision: revision,
		taskId: "T1" as TaskId,
		attemptId: "T1-a1",
		jobId: "job-1",
	}));
	const moved = { ...recorded, subject: { ...SUBJECT, head: "f".repeat(40) } };
	const result = reduce(moved, { kind: "record_receipt", expectedRevision: moved.revision, taskId: "T1" as TaskId, attemptId: "T1-a1", receipt: receipt() }, REDUCE);
	assert.equal(result.ok, true);
	assert.equal(findTask(result.ok ? result.ledger : moved, "T1" as TaskId)?.state, "VERIFY");
	assert.equal(result.ok ? result.ledger.noProgressAttempts : -1, 1);
});

test("native job ids are recorded once and are the only correlation key", () => {
	const recorded = step(runningTask(), (revision) => ({
		kind: "record_native_job",
		expectedRevision: revision,
		taskId: "T1" as TaskId,
		attemptId: "T1-a1",
		jobId: "job-1",
	}));
	const again = reduce(recorded, { kind: "record_native_job", expectedRevision: recorded.revision, taskId: "T1" as TaskId, attemptId: "T1-a1", jobId: "job-1" }, REDUCE);
	assert.equal(again.ok, true);
	assert.equal(again.ok ? again.ledger.revision : -1, recorded.revision, "a duplicate observation does not advance the ledger");
	assert.deepEqual(findTask(recorded, "T1" as TaskId)?.attempts[0]?.nativeJobIds, ["job-1"]);
});

test("reopening requires new evidence and replanning requires a diagnosed plateau", () => {
	const recorded = step(runningTask(), (revision) => ({ kind: "record_receipt", expectedRevision: revision, taskId: "T1" as TaskId, attemptId: "T1-a1", receipt: receipt() }));
	const finished = step(recorded, (revision) => ({ kind: "finish_task", expectedRevision: revision, taskId: "T1" as TaskId, criterionId: "A1" as CriterionId }));

	const unexplained = reduce(finished, { kind: "reopen_task", expectedRevision: finished.revision, taskId: "T1" as TaskId, reason: "   " }, REDUCE);
	assert.equal(unexplained.ok, false);
	assert.match(unexplained.ok ? "" : unexplained.error, /must name the new evidence/);

	const reopened = step(finished, (revision) => ({ kind: "reopen_task", expectedRevision: revision, taskId: "T1" as TaskId, reason: "reproduced data loss" }));
	assert.equal(findTask(reopened, "T1" as TaskId)?.state, "READY");
	assert.match(findTask(reopened, "T1" as TaskId)?.decisionReason ?? "", /reproduced data loss/);
	const retry = reduce(reopened, {
		kind: "start_attempt",
		expectedRevision: reopened.revision,
		taskId: "T1" as TaskId,
		attemptId: "T1-a2",
		subject: SUBJECT,
	}, REDUCE);
	assert.equal(retry.ok, true, retry.ok ? "" : retry.error);
	assert.equal(retry.ok ? findTask(retry.ledger, "T1" as TaskId)?.state : undefined, "RUNNING");

	const replan = reduce(reopened, { kind: "use_replan", expectedRevision: reopened.revision, taskId: "T1" as TaskId }, REDUCE);
	assert.equal(replan.ok, false);
	assert.match(replan.ok ? "" : replan.error, /not diagnosed/);
});

test("one bounded replan is allowed after a plateau, and only once", () => {
	let current = runningTask();
	for (const attempt of ["T1-a1", "T1-a2"]) {
		if (attempt === "T1-a2") {
			current = step(current, (revision) => ({ kind: "start_attempt", expectedRevision: revision, taskId: "T1" as TaskId, attemptId: attempt, subject: SUBJECT }));
		}
		current = step(current, (revision) => ({
			kind: "record_receipt",
			expectedRevision: revision,
			taskId: "T1" as TaskId,
			attemptId: attempt,
			receipt: receipt({ attemptId: attempt, unresolved: ["still broken"] }),
		}));
	}
	assert.equal(current.noProgressAttempts, 2);

	const replanned = step(current, (revision) => ({ kind: "use_replan", expectedRevision: revision, taskId: "T1" as TaskId }));
	assert.equal(replanned.replans, 1);
	assert.equal(replanned.noProgressAttempts, 2, "the plateau count survives the replan");
	assert.equal(findTask(replanned, "T1" as TaskId)?.state, "READY");

	const second = reduce(replanned, { kind: "use_replan", expectedRevision: replanned.revision, taskId: "T1" as TaskId }, REDUCE);
	assert.equal(second.ok, false);
	assert.match(second.ok ? "" : second.error, /already been used/);
});

test("a new generation reconciles in-flight work and keeps lineage", () => {
	const recorded = step(runningTask(), (revision) => ({ kind: "record_receipt", expectedRevision: revision, taskId: "T1" as TaskId, attemptId: "T1-a1", receipt: receipt() }));
	const next = step(recorded, (revision) => ({
		kind: "new_generation",
		expectedRevision: revision,
		generation: "G2" as GenerationId,
		goal: {
			statement: "narrowed objective",
			nonGoals: [],
			permittedEffects: ["read", "write"],
			finishAuthority: "report the narrowed result",
			appetite: { tasks: 8, attemptsPerTask: 2 },
		},
		criteria: [{ id: "A1" as CriterionId, statement: "the narrowed fix is proven", mandatory: true }],
	}));
	const task = findTask(next, "T1" as TaskId);
	assert.equal(task?.state, "CANDIDATE");
	assert.equal(task?.generation, "G2");
	assert.equal(task?.attempts.length, 1, "lineage survives the objective change");
	assert.equal(criterionProven(next, "A1" as CriterionId), false);
	assert.equal(evaluateRun(next).converged, false);
	const rechecked = reduce(next, { kind: "reevaluate_candidate", expectedRevision: next.revision, taskId: "T1" as TaskId }, REDUCE);
	assert.equal(rechecked.ok, true);
	assert.equal(rechecked.ok ? findTask(rechecked.ledger, "T1" as TaskId)?.state : "", "READY");
});
test("new-generation journal round-trip preserves retained attempt lineage", () => {
	const recorded = step(runningTask(), (revision) => ({ kind: "record_receipt", expectedRevision: revision, taskId: "T1" as TaskId, attemptId: "T1-a1", receipt: receipt() }));
	const next = step(recorded, (revision) => ({
		kind: "new_generation",
		expectedRevision: revision,
		generation: "G2" as GenerationId,
		goal: { statement: "narrowed objective", nonGoals: [], permittedEffects: ["read", "write"], finishAuthority: "report", appetite: { tasks: 8, attemptsPerTask: 2 } },
		criteria: [{ id: "A1" as CriterionId, statement: "narrowed proof", mandatory: true }],
	}));
	const parsed = parseJournal(journalRecord(next));
	assert.equal(parsed.ok, true);
	assert.equal(parsed.ok ? parsed.ledger.tasks[0]?.generation : "", "G2");
	assert.equal(parsed.ok ? parsed.ledger.tasks[0]?.attempts.length : -1, 1);
});

test("an interrupted run cannot be reactivated by a status write", () => {
	const interrupted = step(runningTask(), (revision) => ({ kind: "set_control", expectedRevision: revision, control: "interrupted" }));
	const resume = reduce(interrupted, { kind: "set_control", expectedRevision: interrupted.revision, control: "active" }, REDUCE);
	assert.equal(resume.ok, false);
	assert.match(resume.ok ? "" : resume.error, /must be reconciled/);
});

// --------------------------------------------------------------- convergence

test("convergence requires current proof for every mandatory criterion", () => {
	const base = ledger();
	const verdict = evaluateRun(base);
	assert.equal(verdict.converged, false);
	assert.deepEqual(verdict.remaining, ["A1"]);
	assert.equal(verdict.provenMandatory, 0);
});

test("an empty queue is quiescent, not successful, and names the resumption condition", () => {
	const verdict = evaluateRun(ledger());
	assert.equal(verdict.converged, false);
	assert.equal(verdict.quiescent, true);
	assert.match(verdict.resumption ?? "", /admit or advertise work for A1/);
});

test("a user pause is never overridden by a converged verdict", () => {
	const recorded = step(runningTask(), (revision) => ({ kind: "record_receipt", expectedRevision: revision, taskId: "T1" as TaskId, attemptId: "T1-a1", receipt: receipt() }));
	const finished = step(recorded, (revision) => ({ kind: "finish_task", expectedRevision: revision, taskId: "T1" as TaskId, criterionId: "A1" as CriterionId }));
	const paused = step(finished, (revision) => ({ kind: "set_control", expectedRevision: revision, control: "paused" }));
	const verdict = evaluateRun(paused);
	assert.equal(verdict.converged, true);
	assert.equal(verdict.control, "paused");
	assert.equal(verdict.quiescent, false);
});

test("a diagnosed, exhausted plateau is reported as a blocker with no silent retry", () => {
	let current = runningTask();
	current = step(current, (revision) => ({ kind: "record_receipt", expectedRevision: revision, taskId: "T1" as TaskId, attemptId: "T1-a1", receipt: receipt({ unresolved: ["still broken"] }) }));
	current = step(current, (revision) => ({ kind: "start_attempt", expectedRevision: revision, taskId: "T1" as TaskId, attemptId: "T1-a2", subject: SUBJECT }));
	current = step(current, (revision) => ({ kind: "record_receipt", expectedRevision: revision, taskId: "T1" as TaskId, attemptId: "T1-a2", receipt: receipt({ attemptId: "T1-a2", unresolved: ["still broken"] }) }));
	current = step(current, (revision) => ({ kind: "use_replan", expectedRevision: revision, taskId: "T1" as TaskId }));
	const verdict = evaluateRun(current);
	assert.equal(verdict.plateau, true);
	assert.match(verdict.resumption ?? "", /no bounded progress remains/);
});

// -------------------------------------------------------------- capabilities

test("probed execution paths are classified, and every other path stays conservative", () => {
	assert.deepEqual(enforcedPaths(), ["factory.admitted-dispatch", "native.task", "eval.tool-task"]);
	assert.equal(unsupportedPaths().includes("native.task"), false);
	assert.equal(unsupportedPaths().includes("eval.tool-task"), false);
	assert.ok(unsupportedPaths().includes("eval.agent"));
	assert.equal(coverageFor("child.tools")?.status, "observed");
	for (const entry of DISPATCH_COVERAGE) {
		assert.ok(entry.reason.length > 20, `${entry.path} needs a real reason`);
		if (entry.status !== "enforced") assert.ok(entry.upstream !== undefined || entry.seam.length > 0, entry.path);
	}
});

test("an unproven execution path is refused rather than routed through silently", () => {
	const run = runningTask();
	const refused = buildDispatchPrompt(run, "T1" as TaskId, "T1-a1", "eval.agent");
	assert.equal(refused.ok, false);
	assert.match(refused.ok ? "" : refused.error, /is unsupported, not enforced/);

	const unknown = buildDispatchPrompt(run, "T1" as TaskId, "T1-a1", "made.up");
	assert.equal(unknown.ok, false);
	assert.match(unknown.ok ? "" : unknown.error, /unknown execution path/);
});

test("dispatch refuses a task that is not admitted and running", () => {
	const admitted = step(ledger(), (revision) => ({ kind: "record_candidate", expectedRevision: revision, candidate: candidate() }));
	const notStarted = buildDispatchPrompt(admitted, "T1" as TaskId, "T1-a1");
	assert.equal(notStarted.ok, false);
	assert.match(notStarted.ok ? "" : notStarted.error, /start_attempt must persist an attempt/);

	const started = step(admitted, (revision) => ({
		kind: "start_attempt",
		expectedRevision: revision,
		taskId: "T1" as TaskId,
		attemptId: "T1-a1",
		subject: SUBJECT,
	}));
	const dispatched = buildDispatchPrompt(started, "T1" as TaskId, "T1-a1");
	assert.equal(dispatched.ok, true);

	const deferred = step(ledger(), (revision) => ({ kind: "record_candidate", expectedRevision: revision, candidate: candidate({ taskId: "T2" as TaskId, deps: ["T9" as TaskId] }) }));
	const blocked = buildDispatchPrompt(deferred, "T2" as TaskId, "T2-a1");
	assert.equal(blocked.ok, false);
	assert.match(blocked.ok ? "" : blocked.error, /is DEFERRED/);
});

test("a closed run admits no new dispatch", () => {
	const paused = step(runningTask(), (revision) => ({ kind: "set_control", expectedRevision: revision, control: "paused" }));
	const refused = buildDispatchPrompt(paused, "T1" as TaskId, "T1-a1");
	assert.equal(refused.ok, false);
	assert.match(refused.ok ? "" : refused.error, /admission is closed/);
});

test("the dispatched prompt carries the ledger's identity, never a caller-supplied one", () => {
	const plan = buildDispatchPrompt(runningTask(), "T1" as TaskId, "T1-a1");
	assert.equal(plan.ok, true);
	const prompt = plan.ok ? plan.prompt : "";
	assert.match(prompt, /task T1 \(attempt T1-a1, lineage 1\)/);
	assert.match(prompt, /generation G1 · revision \d+ · subject example\/repo@a{40}/);
	assert.match(prompt, /criterion A1/);
	assert.match(prompt, /Do not create successor tasks or missions/);
	assert.match(prompt, /Do not approve, merge, publish/);
	assert.ok(prompt.includes(RECEIPT_CONTRACT));
});

// -------------------------------------------------------------------- journal

test("a journal record round-trips through the versioned entry", () => {
	const run = runningTask();
	const read = parseJournal(journalRecord(run));
	assert.equal(read.ok, true);
	assert.equal(read.ok ? read.ledger.runId : "", run.runId);
	assert.equal(read.ok ? read.ledger.revision : -1, run.revision);
	assert.deepEqual(read.ok ? read.ledger.subject : {}, run.subject);
});

test("an unknown journal version or a corrupt record fails safely and says why", () => {
	const wrongVersion = parseJournal({ ...journalRecord(ledger()), version: 99 });
	assert.equal(wrongVersion.ok, false);
	assert.match(wrongVersion.ok ? "" : wrongVersion.reason, /not readable by this build/);

	const corrupt = parseJournal({ version: 1, revision: 3 });
	assert.equal(corrupt.ok, false);
	assert.match(corrupt.ok ? "" : corrupt.reason, /run or generation identity/);
});

test("journal corruption in authority, control, or task state never resumes", () => {
	const base = journalRecord(ledger()) as Record<string, any>;
	const badEffects = parseJournal({ ...base, goal: { ...base.goal, permittedEffects: ["deploy"] } });
	assert.equal(badEffects.ok, false);
	assert.match(badEffects.ok ? "" : badEffects.reason, /permitted effects/);

	const badControl = parseJournal({ ...base, control: "converged" });
	assert.equal(badControl.ok, false);
	assert.match(badControl.ok ? "" : badControl.reason, /control/);

	const run = runningTask();
	const badTask = parseJournal({
		...journalRecord(run),
		tasks: [{ ...run.tasks[0], state: "BOGUS" }],
	});
	assert.equal(badTask.ok, false);
	assert.match(badTask.ok ? "" : badTask.reason, /unreadable .* task/);
});

test("reading prefers the newest record and reports an unreadable one instead of skipping it", () => {
	const run = runningTask();
	const entries = [
		{ type: "custom", customType: JOURNAL_ENTRY, data: journalRecord(run) },
		{ type: "custom", customType: JOURNAL_ENTRY, data: { version: 7 } },
	];
	const read = readJournal(entries);
	assert.equal(read?.ok, false);
	assert.match(read && !read.ok ? read.reason : "", /version 7/);

	assert.equal(readJournal([]), undefined);
	assert.equal(readJournal(undefined), undefined);
});

test("durability is unavailable when the session exposes no history", () => {
	assert.equal(durabilityOf(undefined), "unavailable");
	assert.equal(durabilityOf([]), "durable");
});

// ------------------------------------------------------------------------- ui

test("the status indicator is namespaced and reports gates without a dashboard", () => {
	const line = renderStatus(ledger());
	assert.match(line, /^Factory G1 · 0\/1 proven · 0 running · 0 blocked$/);

	const detail = renderStatusDetail(ledger());
	assert.match(detail[0]!, /^Factory G1/);
	assert.ok(detail.some((row) => /\[mandatory\] A1: the fix is proven — unproven/.test(row)));
	assert.ok(detail.some((row) => /non-goals: no new dashboard/.test(row)));
});

test("status detail marks unread routing as unverified rather than assuming a model", () => {
	const recorded = step(runningTask(), (revision) => ({ kind: "record_receipt", expectedRevision: revision, taskId: "T1" as TaskId, attemptId: "T1-a1", receipt: receipt() }));
	const detail = renderStatusDetail(recorded);
	assert.ok(detail.some((row) => /routing: requested lf-worker · effective unverified/.test(row)));
});

test("why explains the decision, the dependencies, and the recorded evidence", () => {
	const recorded = step(runningTask(), (revision) => ({ kind: "record_receipt", expectedRevision: revision, taskId: "T1" as TaskId, attemptId: "T1-a1", receipt: receipt() }));
	const lines = renderWhy(recorded, "T1" as TaskId);
	assert.ok(lines.some((row) => /decision ADMIT — necessary for unproven criterion A1/.test(row)));
	assert.ok(lines.some((row) => /test pass: bash tests\/x\.sh/.test(row)));
	assert.ok(lines.some((row) => /evidence \/artifacts\/run\.log/.test(row)));
	assert.deepEqual(renderWhy(recorded, "T9" as TaskId), ["T9 is not in the ledger"]);
});

test("narrow output degrades by truncation, not by losing the line", () => {
	const line = renderStatus(ledger(), 18);
	assert.equal(line.length, 18);
	assert.ok(line.endsWith("…"));
});

// -------------------------------------------------------------- completion

test("the completion receipt is explicit about a run that has not converged", () => {
	const text = renderCompletionReceipt(ledger());
	assert.match(text, /^FACTORY NOT CONVERGED/);
	assert.match(text, /mandatory criteria proven: 0\/1/);
	assert.match(text, /not a completion/i);
	assert.doesNotMatch(text, /objective met/);
});

test("a converged receipt states its scope and disclaims merge authority", () => {
	const recorded = step(runningTask(), (revision) => ({ kind: "record_receipt", expectedRevision: revision, taskId: "T1" as TaskId, attemptId: "T1-a1", receipt: receipt() }));
	const finished = step(recorded, (revision) => ({ kind: "finish_task", expectedRevision: revision, taskId: "T1" as TaskId, criterionId: "A1" as CriterionId }));
	const text = renderCompletionReceipt(finished);
	assert.match(text, /^FACTORY VERIFIED — objective met/);
	assert.match(text, /no merge or deploy authority/);
});

// ------------------------------------------------------------ extension host

function fakeHost(options: { nativeTask?: boolean } = {}) {
	const tools = new Map<string, { name: string; execute(...args: any[]): Promise<{ content: Array<{ text: string }>; isError?: boolean; details?: unknown }> }>();
	const events = new Map<string, (event: unknown, ctx: unknown) => unknown>();
	const commands = new Map<string, { description?: string; handler(args: string, ctx: unknown): unknown }>();
	const entries: Array<{ customType: string; data: unknown }> = [];
	const notifications: string[] = [];
	const sentMessages: Array<{ content: string; options?: unknown }> = [];
	const leaf = (): unknown => ({ optional: () => leaf(), describe: () => leaf() });
	return {
		tools,
		events,
		commands,
		entries,
		notifications,
		sentMessages,
		zod: { object: () => ({}), string: leaf },
		arktype: options.nativeTask ? ((schema: unknown) => schema) : undefined,
		setLabel() {},
			registerTool(definition: { name: string; execute(...args: any[]): Promise<{ content: Array<{ text: string }>; isError?: boolean; details?: unknown }> }) {
			tools.set(definition.name, definition);
		},
		appendEntry(customType: string, data: unknown) {
			entries.push({ customType, data });
		},
		on(name: string, handler: (event: unknown, ctx: unknown) => unknown) {
			events.set(name, handler);
		},
		registerCommand(name: string, definition: { description?: string; handler(args: string, ctx: unknown): unknown }) {
			commands.set(name, definition);
		},
		sendUserMessage(content: string, options?: unknown) {
			sentMessages.push({ content, options });
		},
		notify(message: string) {
			notifications.push(message);
		},
	};
}

function startCtx(host: ReturnType<typeof fakeHost>) {
	return { hasUI: true, ui: { notify: (message: string) => host.notify(message) }, sessionManager: { getBranch: () => [] } };
}

async function callTool(host: ReturnType<typeof fakeHost>, name: string, input: unknown) {
	const tool = host.tools.get(name);
	assert.ok(tool !== undefined, `${name} is not registered`);
	return tool.execute("call", { input: JSON.stringify(input) });
}

const FULL_ENV = { LUNA_FACTORY_ENABLED: "1" };

test("loading the extension registers its surface and starts no work", async () => {
	const host = fakeHost();
	const extension = createLunaFactoryExtension(host as never, { env: {}, artifactRoots: ROOTS });
	await extension.whenStarted();
	assert.deepEqual(
		[...host.tools.keys()].sort(),
		[
			"luna_factory_attempt",
			"luna_factory_candidate",
			"luna_factory_completion",
			"luna_factory_control",
			"luna_factory_dispatch",
			"luna_factory_finish",
			"luna_factory_integrate",
			"luna_factory_open",
			"luna_factory_receipt",
			"luna_factory_reconcile",
			"luna_factory_reopen",
			"luna_factory_replan",
			"luna_factory_status",
			"luna_factory_why",
		],
	);
	assert.equal(host.entries.length, 0, "loading writes no journal record");
	assert.equal(host.notifications.length, 0, "loading is silent");
});


test("the native task seam admits only a ledger-stamped assignment and journals OMP identities", async () => {
	let nativeCalls = 0;
	const host = fakeHost({ nativeTask: true });
	createLunaFactoryExtension(host as never, { env: FULL_ENV, artifactRoots: ROOTS });
	host.events.get("session_start")!({}, startCtx(host));
	await callTool(host, "luna_factory_open", {
		objective: "prove the fix",
		criteria: [{ id: "A1", statement: "the fix is proven" }],
		repo: "example/repo",
		base: "a".repeat(40),
	});
	await callTool(host, "luna_factory_candidate", {
		taskId: "T1",
		generation: "G1",
		criterionId: "A1",
		title: "fix it",
		deps: [],
		effect: "read",
		owner: "luna",
		necessity: "A1 is unproven",
	});
	await callTool(host, "luna_factory_attempt", { taskId: "T1", attemptId: "T1-a1" });

	const task = host.tools.get("task");
	assert.ok(task, "a host with native task support gets a same-name wrapper");
	const invoke = async () => {
		nativeCalls += 1;
		return {
			content: [{ type: "text", text: "native task completed" }],
			details: { async: { state: "completed", jobId: "job-1", type: "task" }, results: [{ id: "agent-1" }] },
		};
	};
	const context = { invokeTool: invoke };
	const refused = await task.execute("call", { task: "unbound work" }, undefined, undefined, context);
	assert.equal(refused.isError, true);
	assert.match(refused.content[0]!.text, /ledger-stamped/);
	assert.equal(nativeCalls, 0);

	const marker = dispatchMarker("T1", "T1-a1", "G1");
	const accepted = await task.execute("call", { task: `do the work\n${marker}` }, undefined, undefined, context);
	assert.equal(accepted.isError, undefined);
	assert.equal(nativeCalls, 1);
	const record = host.entries.at(-1)!.data as { tasks: Array<{ attempts: Array<{ nativeJobIds: string[]; nativeResultIds: string[] }> }> };
	assert.deepEqual(record.tasks[0]!.attempts[0]!.nativeJobIds, ["job-1"]);
	assert.deepEqual(record.tasks[0]!.attempts[0]!.nativeResultIds, ["agent-1"]);
});

test("the native task seam validates and correlates an independent batch without partial authority", async () => {
	const host = fakeHost({ nativeTask: true });
	createLunaFactoryExtension(host as never, { env: FULL_ENV, artifactRoots: ROOTS });
	host.events.get("session_start")!({}, startCtx(host));
	await callTool(host, "luna_factory_open", {
		objective: "inspect two independent criteria",
		criteria: [
			{ id: "A1", statement: "first report exists" },
			{ id: "A2", statement: "second report exists" },
		],
		repo: "example/repo",
		base: "a".repeat(40),
	});
	for (const [taskId, criterionId] of [["T1", "A1"], ["T2", "A2"]]) {
		await callTool(host, "luna_factory_candidate", {
			taskId,
			generation: "G1",
			criterionId,
			title: `inspect ${taskId}`,
			deps: [],
			effect: "read",
			owner: "luna",
			necessity: `${criterionId} is unproven`,
		});
		await callTool(host, "luna_factory_attempt", { taskId, attemptId: `${taskId}-a1` });
	}
	const task = host.tools.get("task");
	assert.ok(task);
	const marker1 = dispatchMarker("T1", "T1-a1", "G1");
	const marker2 = dispatchMarker("T2", "T2-a1", "G1");
	let calls = 0;
	const result = await task.execute(
		"call",
		{ tasks: [{ agent: "task", task: `first\n${marker1}` }, { agent: "task", task: `second\n${marker2}` }] },
		undefined,
		undefined,
		{
			invokeTool: async () => {
				calls += 1;
				return {
					content: [{ type: "text", text: "batch completed" }],
					details: { async: { state: "completed", jobId: "batch-1", type: "task" }, results: [{ index: 0, id: "agent-1" }, { index: 1, id: "agent-2" }] },
				};
			},
		} as never,
	);
	assert.equal(result.isError, undefined);
	assert.equal(calls, 1, "one native batch owns both admitted items");
	const record = host.entries.at(-1)!.data as { tasks: Array<{ id: string; attempts: Array<{ nativeJobIds: string[]; nativeResultIds: string[] }> }> };
	assert.deepEqual(record.tasks.map((entry) => [entry.id, entry.attempts[0]!.nativeJobIds, entry.attempts[0]!.nativeResultIds]), [
		["T1", ["batch-1"], ["agent-1"]],
		["T2", ["batch-1"], ["agent-2"]],
	]);
	const refused = await task.execute(
		"call",
		{ tasks: [{ agent: "task", task: `first\n${marker1}` }, { agent: "task", task: "unbound" }] },
		undefined,
		undefined,
		{ invokeTool: async () => ({ content: [{ type: "text", text: "must not run" }] }) } as never,
	);
	assert.equal(refused.isError, true);
	assert.equal(calls, 1, "a partially invalid batch never reaches native OMP");
});

test("a write task must request native isolation before delegation", async () => {
	let nativeCalls = 0;
	const host = fakeHost({ nativeTask: true });
	createLunaFactoryExtension(host as never, { env: FULL_ENV, artifactRoots: ROOTS });
	host.events.get("session_start")!({}, startCtx(host));
	await callTool(host, "luna_factory_open", {
		objective: "apply the authorized isolated fix",
		criteria: [{ id: "A1", statement: "the isolated fix is proven" }],
		repo: "example/repo",
		base: "a".repeat(40),
		options: { permittedEffects: ["read", "write"] },
	});
	await callTool(host, "luna_factory_candidate", {
		taskId: "T1",
		generation: "G1",
		criterionId: "A1",
		title: "apply the isolated fix",
		deps: [],
		effect: "write",
		owner: "luna",
		necessity: "A1 is unproven",
	});
	await callTool(host, "luna_factory_attempt", { taskId: "T1", attemptId: "T1-a1" });
	const task = host.tools.get("task");
	assert.ok(task);
	const marker = dispatchMarker("T1", "T1-a1", "G1");
	const invoke = async () => {
		nativeCalls += 1;
		return { content: [{ type: "text", text: "isolated native task completed" }], details: { async: { state: "completed", jobId: "write-job-1", type: "task" }, results: [{ id: "write-agent-1" }] } };
	};
	const refused = await task.execute("call", { agent: "task", task: `write work\n${marker}` }, undefined, undefined, { invokeTool: invoke } as never);
	assert.equal(refused.isError, true);
	assert.match(refused.content[0]!.text, /requires isolated:true/);
	assert.equal(nativeCalls, 0);
	const accepted = await task.execute("call", { agent: "task", isolated: true, task: `write work\n${marker}` }, undefined, undefined, { invokeTool: invoke } as never);
	assert.equal(accepted.isError, undefined);
	assert.equal(nativeCalls, 1);
});

test("status works while idle and reports the enforced boundary", async () => {
	const host = fakeHost();
	createLunaFactoryExtension(host as never, { env: {}, artifactRoots: ROOTS });
	host.events.get("session_start")!({}, startCtx(host));
	const result = await callTool(host, "luna_factory_status", {});
	assert.equal(result.isError, undefined);
	assert.match(result.content[0]!.text, /no Factory run is open/);
	assert.match(result.content[0]!.text, /LUNA_FACTORY_ENABLED=1 to enable/);
	assert.match(result.content[0]!.text, /enforced: factory\.admitted-dispatch/);
});

test("execution is refused while the opt-in flag is absent", async () => {
	const host = fakeHost();
	createLunaFactoryExtension(host as never, { env: {}, artifactRoots: ROOTS });
	host.events.get("session_start")!({}, startCtx(host));
	const opened = await callTool(host, "luna_factory_open", { objective: "x", criteria: [{ id: "A1", statement: "y" }], repo: "example/repo", base: "a".repeat(40) });
	assert.equal(opened.isError, true);
	assert.match(opened.content[0]!.text, /LUNA_FACTORY_ENABLED=1/);
	assert.equal(host.entries.length, 0);
});

test("an open run is not silently replaced by a new objective", async () => {
	const host = fakeHost();
	createLunaFactoryExtension(host as never, { env: FULL_ENV, artifactRoots: ROOTS });
	host.events.get("session_start")!({}, startCtx(host));
	const payload = { objective: "one", criteria: [{ id: "A1", statement: "prove one" }], repo: "example/repo", base: "a".repeat(40) };
	await callTool(host, "luna_factory_open", payload);
	const replaced = await callTool(host, "luna_factory_open", { ...payload, objective: "two" });
	assert.equal(replaced.isError, true);
	assert.match(replaced.content[0]!.text, /already open for 'one'/);
	const explicit = await callTool(host, "luna_factory_open", { ...payload, objective: "two", replace: true });
	assert.equal(explicit.isError, undefined);
});

test("opening captures explicit authority and never defaults a read-only run to writes", async () => {
	const host = fakeHost();
	createLunaFactoryExtension(host as never, { env: FULL_ENV, artifactRoots: ROOTS });
	host.events.get("session_start")!({}, startCtx(host));
	const opened = await callTool(host, "luna_factory_open", {
		objective: "inspect the failure",
		criteria: [{ id: "A1", statement: "the failure is explained" }],
		repo: "example/repo",
		base: "a".repeat(40),
		options: {
			nonGoals: ["do not edit source"],
			permittedEffects: ["read"],
			finishAuthority: "report findings only",
			appetite: { tasks: 3, attemptsPerTask: 1 },
		},
	});
	assert.equal(opened.isError, undefined);
	const record = host.entries.at(-1)!.data as { goal: { nonGoals: string[]; permittedEffects: string[]; finishAuthority: string; appetite: { tasks: number; attemptsPerTask: number } } };
	assert.deepEqual(record.goal.nonGoals, ["do not edit source"]);
	assert.deepEqual(record.goal.permittedEffects, ["read"]);
	assert.equal(record.goal.finishAuthority, "report findings only");
	assert.deepEqual(record.goal.appetite, { tasks: 3, attemptsPerTask: 1 });

	const write = await callTool(host, "luna_factory_candidate", {
		taskId: "T1",
		generation: "G1",
		criterionId: "A1",
		title: "edit source",
		deps: [],
		effect: "write",
		owner: "luna",
		necessity: "the failure is unproven",
	});
	assert.equal(write.isError, undefined);
	assert.match(write.content[0]!.text, /ESCALATE/);
});

test("opening without options records a safe read-only authority", async () => {
	const host = fakeHost();
	createLunaFactoryExtension(host as never, { env: FULL_ENV, artifactRoots: ROOTS });
	host.events.get("session_start")!({}, startCtx(host));
	await callTool(host, "luna_factory_open", {
		objective: "inspect only",
		criteria: [{ id: "A1", statement: "the report is complete" }],
		repo: "example/repo",
		base: "a".repeat(40),
	});
	const record = host.entries.at(-1)!.data as { goal: { permittedEffects: string[]; finishAuthority: string } };
	assert.deepEqual(record.goal.permittedEffects, ["read"]);
	assert.match(record.goal.finishAuthority, /no merge|report/i);
});

test("opening rejects malformed objective and criteria before journaling", async () => {
	const cases = [
		{
			objective: "x".repeat(2_001),
			criteria: [{ id: "A1", statement: "prove one" }],
		},
		{
			objective: "duplicate criteria",
			criteria: [{ id: "A1", statement: "prove one" }, { id: "A1", statement: "prove twice" }],
		},
		{
			objective: "invalid mandatory flag",
			criteria: [{ id: "A1", statement: "prove one", mandatory: "yes" }],
		},
	];
	for (const payload of cases) {
		const host = fakeHost();
		createLunaFactoryExtension(host as never, { env: FULL_ENV, artifactRoots: ROOTS });
		host.events.get("session_start")!({}, startCtx(host));
		const opened = await callTool(host, "luna_factory_open", {
			...payload,
			repo: "example/repo",
			base: "a".repeat(40),
		});
		assert.equal(opened.isError, true);
		assert.equal(host.entries.length, 0, "invalid authority must not create a journal record");
	}
});

test("the admitted vertical runs end to end and finishes on proof", async () => {
	const host = fakeHost();
	createLunaFactoryExtension(host as never, { env: FULL_ENV, artifactRoots: ROOTS });
	host.events.get("session_start")!({}, startCtx(host));

	await callTool(host, "luna_factory_open", {
		objective: "prove the fix",
		criteria: [{ id: "A1", statement: "the fix is proven" }],
		repo: "example/repo",
		base: "a".repeat(40),
	});
	const admitted = await callTool(host, "luna_factory_candidate", {
		taskId: "T1",
		generation: "G1",
		criterionId: "A1",
		title: "fix it",
		deps: [],
		effect: "read",
		owner: "luna",
		necessity: "A1 is unproven",
	});
	assert.match(admitted.content[0]!.text, /T1: ADMIT/);

	await callTool(host, "luna_factory_attempt", { taskId: "T1", attemptId: "T1-a1" });
	const dispatched = await callTool(host, "luna_factory_dispatch", { taskId: "T1", attemptId: "T1-a1" });
	assert.equal(dispatched.isError, undefined);
	assert.match(dispatched.content[0]!.text, /admission boundary: enforced/);

	const recorded = await callTool(host, "luna_factory_receipt", {
		...receipt(),
		taskId: "T1",
		attemptId: "T1-a1",
		generation: "G1",
		subject: { repo: "example/repo", base: "a".repeat(40) },
	});
	assert.equal(recorded.isError, undefined);
	assert.match(recorded.content[0]!.text, /not acceptance proof/);

	const finished = await callTool(host, "luna_factory_finish", { taskId: "T1" });
	assert.equal(finished.isError, undefined);
	assert.match(finished.content[0]!.text, /^FACTORY VERIFIED — objective met/);

	const completion = await callTool(host, "luna_factory_completion", {});
	assert.match(completion.content[0]!.text, /no merge or deploy authority/);
	assert.ok(host.entries.some((entry) => entry.customType === JOURNAL_ENTRY), "the ledger is journalled");
});

test("write integration is an explicit owner event and moves the proof subject", async () => {
	const host = fakeHost();
	createLunaFactoryExtension(host as never, { env: FULL_ENV, artifactRoots: ROOTS });
	host.events.get("session_start")!({}, startCtx(host));
	await callTool(host, "luna_factory_open", {
		objective: "apply the authorized fix",
		criteria: [{ id: "A1", statement: "the fix is proven" }],
		repo: "example/repo",
		base: "a".repeat(40),
		options: { permittedEffects: ["read", "write"], finishAuthority: "report the verified fix" },
	});
	await callTool(host, "luna_factory_candidate", {
		taskId: "T1",
		generation: "G1",
		criterionId: "A1",
		title: "apply the fix",
		deps: [],
		effect: "write",
		owner: "luna",
		necessity: "A1 is unproven",
	});
	await callTool(host, "luna_factory_attempt", { taskId: "T1", attemptId: "T1-a1" });
	await callTool(host, "luna_factory_receipt", receipt());
	const integrated = await callTool(host, "luna_factory_integrate", {
		taskId: "T1",
		attemptId: "T1-a1",
		subject: { repo: "example/repo", base: "a".repeat(40), head: "b".repeat(40) },
	});
	assert.equal(integrated.isError, undefined);
	assert.match(integrated.content[0]!.text, /integrated explicitly/);
	const record = host.entries.at(-1)!.data as { subject: Subject; tasks: Array<{ attempts: Array<{ integrated: boolean }> }> };
	assert.equal(record.subject.head, "b".repeat(40));
	assert.equal(record.tasks[0]!.attempts[0]!.integrated, true);
	const finish = await callTool(host, "luna_factory_finish", { taskId: "T1" });
	assert.equal(finish.isError, true);
	assert.match(finish.content[0]!.text, /older subject/);
});

test("the replan adapter exposes only the one diagnosed same-goal replan", async () => {
	const host = fakeHost();
	createLunaFactoryExtension(host as never, { env: FULL_ENV, artifactRoots: ROOTS });
	host.events.get("session_start")!({}, startCtx(host));
	await callTool(host, "luna_factory_open", {
		objective: "diagnose a stalled fix",
		criteria: [{ id: "A1", statement: "the fix is proven" }],
		repo: "example/repo",
		base: "a".repeat(40),
		options: { appetite: { tasks: 2, attemptsPerTask: 2 } },
	});
	await callTool(host, "luna_factory_candidate", {
		taskId: "T1",
		generation: "G1",
		criterionId: "A1",
		title: "diagnose the stalled fix",
		deps: [],
		effect: "read",
		owner: "luna",
		necessity: "A1 is unproven",
	});
	await callTool(host, "luna_factory_attempt", { taskId: "T1", attemptId: "T1-a1" });
	await callTool(host, "luna_factory_receipt", receipt({ unresolved: ["still broken"] }));
	const premature = await callTool(host, "luna_factory_replan", { taskId: "T1" });
	assert.equal(premature.isError, true);
	assert.match(premature.content[0]!.text, /not diagnosed/);

	await callTool(host, "luna_factory_attempt", { taskId: "T1", attemptId: "T1-a2" });
	await callTool(host, "luna_factory_receipt", receipt({ attemptId: "T1-a2", unresolved: ["still broken differently"] }));
	const replanned = await callTool(host, "luna_factory_replan", { taskId: "T1" });
	assert.equal(replanned.isError, undefined);
	assert.match(replanned.content[0]!.text, /bounded replan/);
	const record = host.entries.at(-1)!.data as { replans: number; tasks: Array<{ state: string }> };
	assert.equal(record.replans, 1);
	assert.equal(record.tasks[0]!.state, "READY");

	const second = await callTool(host, "luna_factory_replan", { taskId: "T1" });
	assert.equal(second.isError, true);
	assert.match(second.content[0]!.text, /already been used/);
});

test("the reopen adapter records explicit post-success defect evidence", async () => {
	const host = fakeHost();
	createLunaFactoryExtension(host as never, { env: FULL_ENV, artifactRoots: ROOTS });
	host.events.get("session_start")!({}, startCtx(host));
	await callTool(host, "luna_factory_open", {
		objective: "repair a reproduced defect without authorizing successor cleanup",
		criteria: [
			{ id: "A1", statement: "the defect is repaired" },
			{ id: "A2", statement: "optional cleanup is documented", mandatory: false },
		],
		repo: "example/repo",
		base: "a".repeat(40),
	});
	await callTool(host, "luna_factory_candidate", {
		taskId: "T1",
		generation: "G1",
		criterionId: "A1",
		title: "initial repair",
		deps: [],
		effect: "read",
		owner: "luna",
		necessity: "A1 is unproven",
	});
	await callTool(host, "luna_factory_attempt", { taskId: "T1", attemptId: "T1-a1" });
	await callTool(host, "luna_factory_receipt", receipt());
	await callTool(host, "luna_factory_finish", { taskId: "T1" });
	const cleanup = await callTool(host, "luna_factory_candidate", {
		taskId: "T2",
		generation: "G1",
		criterionId: "A2",
		title: "optional cleanup",
		deps: [],
		effect: "read",
		owner: "luna",
		necessity: "cleanup would be convenient",
	});
	assert.match(cleanup.content[0]!.text, /dismissed/);
	const reopened = await callTool(host, "luna_factory_reopen", { taskId: "T1", reason: "reproduced a legitimate data-loss defect after the green result" });
	assert.equal(reopened.isError, undefined);
	assert.match(reopened.content[0]!.text, /reopened/);
	const repair = await callTool(host, "luna_factory_candidate", {
		taskId: "T3",
		generation: "G1",
		criterionId: "A1",
		title: "repair the reproduced defect",
		deps: [],
		effect: "read",
		owner: "luna",
		necessity: "the owner reproduced a mandatory defect",
	});
	assert.match(repair.content[0]!.text, /T3: ADMIT/);
});

test("dispatch through an unproven path is refused at the tool boundary", async () => {
	const host = fakeHost();
	createLunaFactoryExtension(host as never, { env: FULL_ENV, artifactRoots: ROOTS });
	host.events.get("session_start")!({}, startCtx(host));
	await callTool(host, "luna_factory_open", {
		objective: "prove the fix",
		criteria: [{ id: "A1", statement: "the fix is proven" }],
		repo: "example/repo",
		base: "a".repeat(40),
	});
	await callTool(host, "luna_factory_candidate", {
		taskId: "T1",
		generation: "G1",
		criterionId: "A1",
		title: "fix it",
		deps: [],
		effect: "read",
		owner: "luna",
		necessity: "A1 is unproven",
	});
	await callTool(host, "luna_factory_attempt", { taskId: "T1", attemptId: "T1-a1" });
	const refused = await callTool(host, "luna_factory_dispatch", { taskId: "T1", attemptId: "T1-a1", path: "workpool.push" });
	assert.equal(refused.isError, true);
	assert.match(refused.content[0]!.text, /workpool\.push' is unsupported/);
});

test("abort records the owned native jobs and claims no rollback", async () => {
	const host = fakeHost();
	createLunaFactoryExtension(host as never, { env: FULL_ENV, artifactRoots: ROOTS });
	host.events.get("session_start")!({}, startCtx(host));
	await callTool(host, "luna_factory_open", {
		objective: "prove the fix",
		criteria: [{ id: "A1", statement: "the fix is proven" }],
		repo: "example/repo",
		base: "a".repeat(40),
	});
	await callTool(host, "luna_factory_candidate", {
		taskId: "T1",
		generation: "G1",
		criterionId: "A1",
		title: "fix it",
		deps: [],
		effect: "read",
		owner: "luna",
		necessity: "A1 is unproven",
	});
	await callTool(host, "luna_factory_attempt", { taskId: "T1", attemptId: "T1-a1" });
	const aborted = await callTool(host, "luna_factory_control", { action: "abort" });
	assert.match(aborted.content[0]!.text, /interrupted/);
	assert.match(aborted.content[0]!.text, /no external effect is rolled back/);
	const resumed = await callTool(host, "luna_factory_control", { action: "resume" });
	assert.equal(resumed.isError, true);
	assert.match(resumed.content[0]!.text, /reconciled/);
	const reconciled = await callTool(host, "luna_factory_reconcile", {
		taskId: "T1",
		attemptId: "T1-a1",
		outcome: "abandoned",
		reason: "OMP cancellation was acknowledged",
	});
	assert.equal(reconciled.isError, undefined);
	const active = await callTool(host, "luna_factory_control", { action: "resume" });
	assert.equal(active.isError, undefined);
});

test("an unreadable journal is surfaced instead of being started over", async () => {
	const host = fakeHost();
	createLunaFactoryExtension(host as never, { env: FULL_ENV, artifactRoots: ROOTS });
	host.events.get("session_start")!({}, {
		hasUI: true,
		ui: { notify: (message: string) => host.notify(message) },
		sessionManager: { getBranch: () => [{ type: "custom", customType: JOURNAL_ENTRY, data: { version: 4 } }] },
	});
	assert.ok(host.notifications.some((message) => /journal is unreadable/.test(message)));
	const status = await callTool(host, "luna_factory_status", {});
	assert.match(status.content[0]!.text, /version 4 is not readable/);
	const opened = await callTool(host, "luna_factory_open", {
		objective: "replace the unreadable run",
		criteria: [{ id: "A1", statement: "the replacement is proven" }],
		repo: "example/repo",
		base: "a".repeat(40),
	});
	assert.equal(opened.isError, true);
	assert.match(opened.content[0]!.text, /preserve the original evidence/);
	assert.equal(host.entries.length, 0, "an unreadable journal must not be overwritten");
});
test("session settlement records a verdict and never dispatches", () => {
	const host = fakeHost();
	createLunaFactoryExtension(host as never, { env: FULL_ENV, artifactRoots: ROOTS });
	host.events.get("session_start")!({}, startCtx(host));
	host.events.get("session_stop")!({}, startCtx(host));
	assert.equal(host.notifications.some((message) => /no Factory run is open/.test(message)), false);
	host.events.get("session_stop")!({}, { hasUI: false, sessionManager: { getBranch: () => [] } });
	assert.equal(host.entries.filter((entry) => entry.customType === "com.joshyorko.luna-factory.settlement").length, 0, "an idle session settles nothing");
});
