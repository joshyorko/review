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
import type { FactoryAction, SelectedItem } from "../image/extension/luna-factory/core/batch.ts";
import { renderCompletionReceipt } from "../image/extension/luna-factory/core/receipt.ts";
import { reduce } from "../image/extension/luna-factory/core/reducer.ts";
import { artifactRefError, changedPathError, parseCandidate, parseReceipt, parseSubject } from "../image/extension/luna-factory/core/schema.ts";
import { buildDispatchPrompt, dispatchMarker, RECEIPT_CONTRACT } from "../image/extension/luna-factory/omp/adapter.ts";
import { DISPATCH_COVERAGE, coverageFor, enforcedPaths, unsupportedPaths } from "../image/extension/luna-factory/omp/capabilities.ts";
import { renderStatus, renderStatusDetail, renderWhy } from "../image/extension/luna-factory/ui/status.ts";
import lunaFactoryExtension, { createLunaFactoryExtension } from "../image/extension/luna-factory/index.ts";
import { factoryCommand, factoryHandoffState, factoryLoadDiagnostic, registerFactoryController, registerFactorySelection, reportFactoryLoadFailure, selectedFactoryItems } from "../image/extension/luna-factory/omp/batch-bridge.ts";

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
		version: 2,
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
		assumptions: [],
		predicates: [
			{ phase: "worker", item: "verification evidence", ok: true, note: "recorded" },
			{ phase: "acceptance", item: "criterion accepted", ok: true, note: "reviewed" },
		],
	};
	return { ...base, ...overrides };
}

/** Apply one event, failing the test if the ledger rejects it. */
function step(current: Ledger, build: (revision: number) => LedgerEvent): Ledger {
	const result = reduce(current, build(current.revision), REDUCE);
	assert.equal(result.ok, true, result.ok ? "" : result.error);
	return result.ok ? result.ledger : current;
}

/** An admitted task with durable intent but no observed OMP child yet. */
function intentTask(): Ledger {
	const admitted = step(ledger(), (revision) => ({ kind: "record_candidate", expectedRevision: revision, candidate: candidate() }));
	return step(admitted, (revision) => ({
		kind: "start_attempt",
		expectedRevision: revision,
		taskId: "T1" as TaskId,
		attemptId: "T1-a1",
		subject: SUBJECT,
	}));
}
/** An admitted task whose OMP execution identity is observed and recorded. */
function runningTask(): Ledger {
	const intent = intentTask();
	const dispatched = step(intent, (revision) => ({
		kind: "record_native_job",
		expectedRevision: revision,
		taskId: "T1" as TaskId,
		attemptId: "T1-a1",
		jobId: "job-1",
	}));
	return step(dispatched, (revision) => ({
		kind: "record_native_agent_start",
		expectedRevision: revision,
		taskId: "T1" as TaskId,
		attemptId: "T1-a1",
		agentId: "agent-1",
	}));
}
function executedAttempt(current: Ledger, taskId: TaskId, attemptId: string): Ledger {
	const intent = step(current, (revision) => ({ kind: "start_attempt", expectedRevision: revision, taskId, attemptId, subject: SUBJECT }));
	const dispatched = step(intent, (revision) => ({
		kind: "record_native_job",
		expectedRevision: revision,
		taskId,
		attemptId,
		jobId: `job-${taskId}-${attemptId}`,
	}));
	return step(dispatched, (revision) => ({
		kind: "record_native_agent_start",
		expectedRevision: revision,
		taskId,
		attemptId,
		agentId: `agent-${taskId}-${attemptId}`,
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
	assert.equal(findTask(startedB, "T1" as TaskId)?.state, "READY");
	assert.equal(findTask(startedB, "T2" as TaskId)?.state, "READY");
	const dispatchedA = step(startedB, (revision) => ({ kind: "record_native_job", expectedRevision: revision, taskId: "T1" as TaskId, attemptId: "T1-a1", jobId: "job-T1" }));
	assert.equal(findTask(dispatchedA, "T1" as TaskId)?.state, "READY");
	const observedA = step(dispatchedA, (revision) => ({ kind: "record_native_agent_start", expectedRevision: revision, taskId: "T1" as TaskId, attemptId: "T1-a1", agentId: "agent-T1" }));
	const dispatchedB = step(observedA, (revision) => ({ kind: "record_native_job", expectedRevision: revision, taskId: "T2" as TaskId, attemptId: "T2-a1", jobId: "job-T2" }));
	const bothExecuted = step(dispatchedB, (revision) => ({ kind: "record_native_agent_start", expectedRevision: revision, taskId: "T2" as TaskId, attemptId: "T2-a1", agentId: "agent-T2" }));
	assert.equal(findTask(bothExecuted, "T1" as TaskId)?.state, "RUNNING");
	assert.equal(findTask(bothExecuted, "T2" as TaskId)?.state, "RUNNING");
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

	current = executedAttempt(current, "T1" as TaskId, "T1-a1");
	current = step(current, (revision) => ({ kind: "record_receipt", expectedRevision: revision, taskId: "T1" as TaskId, attemptId: "T1-a1", receipt: receipt({ taskId: "T1" as TaskId, attemptId: "T1-a1" }) }));
	current = step(current, (revision) => ({ kind: "finish_task", expectedRevision: revision, taskId: "T1" as TaskId, criterionId: "A1" as CriterionId }));
	assert.equal(findTask(current, "T3" as TaskId)?.state, "DEFERRED", "one proven dependency is not a join");

	current = executedAttempt(current, "T2" as TaskId, "T2-a1");
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

test("version-one receipts remain legacy-readable but cannot be newly recorded", () => {
	const legacy = receipt({ version: 1, assumptions: undefined, predicates: undefined });
	assert.equal(parseReceipt(legacy).ok, true);
	assert.equal(reconcileReceipt(ledger(), legacy, { taskId: "T1" as TaskId, attemptId: "T1-a1", subject: SUBJECT, artifactRoots: ROOTS }).status, "proven");

	const running = runningTask();
	const rejected = reduce(running, {
		kind: "record_receipt",
		expectedRevision: running.revision,
		taskId: "T1" as TaskId,
		attemptId: "T1-a1",
		receipt: legacy,
	}, REDUCE);
	assert.equal(rejected.ok, false);
	if (!rejected.ok) assert.match(rejected.error, /legacy-only/);

	const recorded = step(running, (revision) => ({
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
	const migratedLegacyProof = {
		...finished,
		tasks: finished.tasks.map((task) => ({
			...task,
			attempts: task.attempts.map((attempt) => ({ ...attempt, receipt: legacy })),
		})),
	} as Ledger;
	assert.equal(criterionProven(migratedLegacyProof, "A1" as CriterionId), true);
});

test("version-2 receipts retain explicit proof assumptions and non-authorizing semantic results", () => {
	const parsed = parseReceipt({
		...receipt(),
		version: 2,
		assumptions: [
			{ kind: "acceptance-revision", value: "rev-2" },
			{ kind: "dependency-outcome", taskId: "T0", value: "proven" },
		],
		predicates: [
			{ phase: "worker", item: "reference predicate", ok: true, note: "reference was checked" },
			{ phase: "worker", item: "counterexample predicate", ok: false, note: "counterexample was recorded" },
		],
		semanticResult: {
			kind: "inspection",
			outcome: "no-finding",
			summary: "The inspected path has no matching issue.",
			verified: true,
			publicationAuthority: "none",
		},
	});
	assert.equal(parsed.ok, true);
	if (parsed.ok) {
		assert.equal(parsed.value.assumptions?.length, 2);
		assert.equal(parsed.value.semanticResult?.outcome, "no-finding");
		assert.equal(parsed.value.semanticResult?.publicationAuthority, "none");
		assert.deepEqual(parsed.value.predicates?.map((predicate) => predicate.ok), [true, false], "positive and negative checks survive receipt parsing");
	}
	assert.equal(parseReceipt({
		...receipt(), version: 2, assumptions: undefined,
		predicates: [{ phase: "worker", item: "required check", ok: true, note: "checked" }],
	}).ok, false, "new records require explicit assumptions");
	assert.equal(parseReceipt({
		...receipt(), version: 2,
		assumptions: [{ kind: "acceptance-revision", value: "p1" }, { kind: "acceptance-revision", value: "p2" }],
		predicates: [{ phase: "worker", item: "required check", ok: true, note: "checked" }],
	}).ok, false, "duplicate assumption identity is ambiguous");
});

test("semantic observations need separate evidence and cannot grant publication authority", () => {
	const binding = { taskId: "T1" as TaskId, attemptId: "T1-a1", subject: SUBJECT, artifactRoots: ROOTS };
	const noEvidence = receipt({
		version: 2,
		assumptions: [],
		changed: [],
		evidence: [],
		tests: [],
		predicates: [
			{ phase: "worker", item: "inspection predicate", ok: true, note: "checked" },
			{ phase: "acceptance", item: "inspection criterion", ok: true, note: "independently accepted" },
		],
		semanticResult: { kind: "inspection", outcome: "no-finding", summary: "no match", verified: true, publicationAuthority: "none" },
	});
	const noEvidenceResult = reconcileReceipt(ledger(), noEvidence, binding);
	assert.equal(noEvidenceResult.status, "unproved");
	assert.match(noEvidenceResult.reasons.join(";"), /neither verification nor evidence/);

	const zeroFinding = receipt({
		version: 2,
		assumptions: [],
		changed: [],
		evidence: ["/artifacts/inspection.log"],
		tests: [],
		predicates: [
			{ phase: "worker", item: "inspection predicate", ok: true, note: "checked" },
			{ phase: "acceptance", item: "inspection criterion", ok: true, note: "independently accepted" },
		],
		semanticResult: { kind: "inspection", outcome: "no-finding", summary: "no match", verified: true, publicationAuthority: "none" },
	});
	assert.equal(reconcileReceipt(ledger(), zeroFinding, binding).status, "proven");
	assert.equal(parseReceipt({
		...zeroFinding,
		semanticResult: { ...zeroFinding.semanticResult!, publicationAuthority: "issue" },
	}).ok, false, "verified findings never authorize publication");
	assert.equal(parseReceipt({ ...zeroFinding, predicates: undefined }).ok, false, "version-two receipts require checked predicate rows");

	const uncertain = receipt({
		...zeroFinding,
		semanticResult: { kind: "inspection", outcome: "uncertain", summary: "evidence incomplete", verified: false, publicationAuthority: "none" },
	});
	assert.equal(reconcileReceipt(ledger(), uncertain, binding).status, "unproved");
	const restricted = receipt({
		version: 2,
		assumptions: [],
		predicates: [{ phase: "acceptance", item: "scope checked", ok: true, note: "reviewed" }],
		semanticResult: {
			kind: "finding",
			outcome: "supported",
			summary: "restricted finding retained",
			verified: true,
			publicationAuthority: "none",
			publicationBlocker: "Hold disclosure pending owner approval.",
		},
	});
	const parsedRestricted = parseReceipt(restricted);
	assert.equal(parsedRestricted.ok, true);
	if (parsedRestricted.ok) assert.equal(parsedRestricted.value.semanticResult?.publicationBlocker, "Hold disclosure pending owner approval.");
	assert.equal(reconcileReceipt(ledger(), restricted, binding).status, "proven");
	const restrictedRecorded = step(runningTask(), (revision) => ({
		kind: "record_receipt",
		expectedRevision: revision,
		taskId: "T1" as TaskId,
		attemptId: "T1-a1",
		receipt: restricted,
	}));
	assert.ok(renderCompletionReceipt(restrictedRecorded).includes("Hold disclosure pending owner approval."));
	assert.ok(renderStatusDetail(restrictedRecorded).some((row) => row.includes("publication/disclosure blocker: Hold disclosure pending owner approval.")));

	const failedAcceptance = receipt({
		version: 2,
		assumptions: [],
		predicates: [{ phase: "acceptance", item: "disclosure policy", ok: false, note: "approval missing" }],
	});
	assert.equal(reconcileReceipt(ledger(), failedAcceptance, binding).status, "failed");


	const failedGate = receipt({
		version: 2,
		assumptions: [],
		changed: [],
		evidence: ["/artifacts/verification.log"],
		tests: [],
		predicates: [
			{ phase: "verification", item: "smoke command", ok: false, note: "exit 1" },
			{ phase: "acceptance", item: "verification result", ok: true, note: "reviewed" },
		],
	});
	const gateResult = reconcileReceipt(ledger(), failedGate, binding);
	assert.equal(gateResult.status, "failed");
	assert.match(gateResult.reasons.join(";"), /verification predicates failed/);
});

test("worker-only version-two predicates cannot finish or remain current proof", () => {
	const recorded = step(runningTask(), (revision) => ({
		kind: "record_receipt",
		expectedRevision: revision,
		taskId: "T1" as TaskId,
		attemptId: "T1-a1",
		receipt: receipt({
			version: 2,
			assumptions: [],
			predicates: [{ phase: "worker", item: "worker report", ok: true, note: "worker assertion only" }],
		}),
	}));
	const finish = reduce(recorded, {
		kind: "finish_task",
		expectedRevision: recorded.revision,
		taskId: "T1" as TaskId,
		criterionId: "A1" as CriterionId,
	}, REDUCE);
	assert.equal(finish.ok, false);
	if (!finish.ok) assert.match(finish.error, /positive acceptance predicate/);

	const persistedDone = {
		...recorded,
		tasks: recorded.tasks.map((task) => ({ ...task, state: "DONE" as const })),
	} as Ledger;
	assert.equal(criterionProven(persistedDone, "A1" as CriterionId), false);
	const acceptedReceipt = receipt({
		version: 2,
		assumptions: [],
		predicates: [
			{ phase: "worker", item: "worker evidence", ok: true, note: "recorded" },
			{ phase: "acceptance", item: "criterion accepted", ok: true, note: "reviewed" },
		],
	});
	const doneWithReceipt = (replacement: EvidenceReceipt): Ledger => ({
		...persistedDone,
		tasks: persistedDone.tasks.map((task) => ({
			...task,
			attempts: task.attempts.map((attempt) => ({ ...attempt, receipt: replacement })),
		})),
	});
	assert.equal(criterionProven(doneWithReceipt(acceptedReceipt), "A1" as CriterionId), true);
	assert.equal(criterionProven(doneWithReceipt({
		...acceptedReceipt,
		exitCode: 1,
		tests: [{ command: "verification", outcome: "fail" }],
	}), "A1" as CriterionId), false);
	assert.equal(criterionProven(doneWithReceipt({
		...acceptedReceipt,
		unresolved: ["acceptance evidence is incomplete"],
	}), "A1" as CriterionId), false);
	assert.equal(criterionProven(doneWithReceipt({
		...acceptedReceipt,
		subject: { ...SUBJECT, head: "b".repeat(40) },
	}), "A1" as CriterionId), false);
	assert.ok(renderStatusDetail(persistedDone).some((line) => /A1: the fix is proven — unproven/.test(line)));
});

test("a persisted unverified semantic result cannot remain current criterion proof", () => {
	const recorded = step(runningTask(), (revision) => ({
		kind: "record_receipt",
		expectedRevision: revision,
		taskId: "T1" as TaskId,
		attemptId: "T1-a1",
		receipt: receipt({
			version: 2,
			assumptions: [],
			predicates: [
				{ phase: "worker", item: "inspection predicate", ok: true, note: "checked" },
				{ phase: "acceptance", item: "inspection criterion", ok: true, note: "independently accepted" },
			],
			semanticResult: { kind: "inspection", outcome: "no-finding", summary: "observed", verified: true, publicationAuthority: "none" },
		}),
	}));
	const finished = step(recorded, (revision) => ({
		kind: "finish_task",
		expectedRevision: revision,
		taskId: "T1" as TaskId,
		criterionId: "A1" as CriterionId,
	}));
	const stale = {
		...finished,
		tasks: finished.tasks.map((task) => ({
			...task,
			attempts: task.attempts.map((attempt) => ({
				...attempt,
				receipt: attempt.receipt === undefined ? undefined : {
					...attempt.receipt,
					semanticResult: { ...attempt.receipt.semanticResult!, verified: false },
				},
			})),
		})),
	} as Ledger;
	const restored = parseJournal(journalRecord(stale));
	assert.equal(restored.ok, true);
	assert.equal(restored.ok ? criterionProven(restored.ledger, "A1" as CriterionId) : true, false);
});

test("receipt parsing rejects a wrong version, bad enums, and a non-integer exit code", () => {
	const badVersion = parseReceipt({ ...receipt(), version: 3 });
	assert.equal(badVersion.ok, false);
	assert.match(badVersion.ok ? "" : badVersion.errors.join(";"), /version must be 1 or 2/);

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

test("proof assumptions invalidate selectively and missing current authority stays unknown", () => {
	const proof = receipt({
		version: 2,
		assumptions: [
			{ kind: "acceptance-revision", value: "rev-2" },
			{ kind: "dependency-outcome", taskId: "T0" as TaskId, value: "proven" },
		],
		predicates: [
			{ phase: "worker", item: "dependency predicate", ok: true, note: "checked" },
			{ phase: "acceptance", item: "criterion accepted", ok: true, note: "reviewed" },
		],
	});
	const binding = {
		taskId: "T1" as TaskId,
		attemptId: "T1-a1",
		subject: SUBJECT,
		artifactRoots: ROOTS,
		assumptions: [
			{ kind: "acceptance-revision", value: "rev-2" },
			{ kind: "dependency-outcome", taskId: "T0" as TaskId, value: "proven" },
			{ kind: "dependency-outcome", taskId: "T2" as TaskId, value: "unproven" },
		] as const,
	};
	assert.equal(reconcileReceipt(ledger(), proof, binding).status, "proven");
	assert.equal(reconcileReceipt(ledger(), proof, {
		...binding,
		assumptions: [{ kind: "acceptance-revision", value: "rev-3" }, binding.assumptions[1]!, binding.assumptions[2]!],
	}).status, "unproved");
	assert.equal(reconcileReceipt(ledger(), proof, {
		...binding,
		assumptions: [binding.assumptions[1]!, binding.assumptions[2]!],
	}).status, "unproved");
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
	const started = executedAttempt(admitted, "T1" as TaskId, "T1-a1");
	const returned = step(started, (revision) => ({ kind: "record_receipt", expectedRevision: revision, taskId: "T1" as TaskId, attemptId: "T1-a1", receipt: receipt({ unresolved: ["defect remains"] }) }));
	const integrated = reduce(returned, { kind: "integrate_attempt", expectedRevision: returned.revision, taskId: "T1" as TaskId, attemptId: "T1-a1", subject: { ...SUBJECT, head: "b".repeat(40) } }, REDUCE);
	assert.equal(integrated.ok, false);
	assert.match(integrated.ok ? "" : integrated.error, /not proven/);
});
test("a proven write cannot integrate without an externally changed head", () => {
	const writer = candidate({ effect: "write" });
	const admitted = step(ledger(), (revision) => ({ kind: "record_candidate", expectedRevision: revision, candidate: writer }));
	const started = executedAttempt(admitted, "T1" as TaskId, "T1-a1");
	const returned = step(started, (revision) => ({ kind: "record_receipt", expectedRevision: revision, taskId: "T1" as TaskId, attemptId: "T1-a1", receipt: receipt() }));
	const integrated = reduce(returned, { kind: "integrate_attempt", expectedRevision: returned.revision, taskId: "T1" as TaskId, attemptId: "T1-a1", subject: SUBJECT }, REDUCE);
	assert.equal(integrated.ok, false);
	assert.match(integrated.ok ? "" : integrated.error, /externally changed head|concrete changed head/);
});

test("attempt intent stays READY until a bound OMP execution identity is recorded", () => {
	const admitted = step(ledger(), (revision) => ({ kind: "record_candidate", expectedRevision: revision, candidate: candidate() }));
	const intent = step(admitted, (revision) => ({
		kind: "start_attempt",
		expectedRevision: revision,
		taskId: "T1" as TaskId,
		attemptId: "T1-a1",
		subject: SUBJECT,
	}));
	assert.equal(findTask(intent, "T1" as TaskId)?.state, "READY");
	assert.deepEqual(findTask(intent, "T1" as TaskId)?.attempts[0]?.nativeJobIds, []);
	const retry = reduce(intent, { kind: "start_attempt", expectedRevision: intent.revision, taskId: "T1" as TaskId, attemptId: "T1-a2", subject: SUBJECT }, REDUCE);
	assert.equal(retry.ok, false);
	assert.match(retry.ok ? "" : retry.error, /unreturned attempt/);
	const dispatched = step(intent, (revision) => ({
		kind: "record_native_job",
		expectedRevision: revision,
		taskId: "T1" as TaskId,
		attemptId: "T1-a1",
		jobId: "omp-job-1",
	}));
	assert.equal(findTask(dispatched, "T1" as TaskId)?.state, "READY");
	const prematureReceipt = reduce(dispatched, { kind: "record_receipt", expectedRevision: dispatched.revision, taskId: "T1" as TaskId, attemptId: "T1-a1", receipt: receipt() }, REDUCE);
	assert.equal(prematureReceipt.ok, false);
	assert.match(prematureReceipt.ok ? "" : prematureReceipt.error, /not an active dispatched attempt/);
	const running = step(dispatched, (revision) => ({
		kind: "record_native_agent_start",
		expectedRevision: revision,
		taskId: "T1" as TaskId,
		attemptId: "T1-a1",
		agentId: "omp-agent-1",
	}));
	assert.equal(findTask(running, "T1" as TaskId)?.state, "RUNNING");
	assert.deepEqual(findTask(running, "T1" as TaskId)?.attempts[0]?.nativeJobIds, ["omp-job-1"]);
	assert.deepEqual(findTask(running, "T1" as TaskId)?.attempts[0]?.nativeAgentIds, ["omp-agent-1"]);
	const duplicate = reduce(running, { kind: "record_native_agent_start", expectedRevision: running.revision, taskId: "T1" as TaskId, attemptId: "T1-a1", agentId: "omp-agent-1" }, REDUCE);
	assert.equal(duplicate.ok, true);
	assert.equal(duplicate.ok ? duplicate.ledger.revision : -1, running.revision, "a duplicate OMP start observation is idempotent");
	const replacement = reduce(running, { kind: "record_native_agent_start", expectedRevision: running.revision, taskId: "T1" as TaskId, attemptId: "T1-a1", agentId: "replacement-agent" }, REDUCE);
	assert.equal(replacement.ok, false, "a replacement child needs a new Factory attempt");
});

test("native Hub steering invalidates the receipt before the criterion can be proven", () => {
	const recorded = step(runningTask(), (revision) => ({
		kind: "record_receipt",
		expectedRevision: revision,
		taskId: "T1" as TaskId,
		attemptId: "T1-a1",
		receipt: receipt(),
	}));
	const steered = step(recorded, (revision) => ({
		kind: "record_native_agent_steering",
		expectedRevision: revision,
		taskId: "T1" as TaskId,
		attemptId: "T1-a1",
		agentId: "agent-1",
		reason: "Hub message started with user attribution",
	}));
	assert.equal(findTask(steered, "T1" as TaskId)?.state, "ESCALATE");
	assert.equal(findTask(steered, "T1" as TaskId)?.attempts[0]?.steeredAgentId, "agent-1");
	assert.equal(criterionProven(steered, "A1" as CriterionId), false);
	assert.equal(parseJournal(journalRecord(steered)).ok, true);
	const finish = reduce(steered, {
		kind: "finish_task",
		expectedRevision: steered.revision,
		taskId: "T1" as TaskId,
		criterionId: "A1" as CriterionId,
	}, REDUCE);
	assert.equal(finish.ok, false);
	const lateReceipt = reduce(steered, {
		kind: "record_receipt",
		expectedRevision: steered.revision,
		taskId: "T1" as TaskId,
		attemptId: "T1-a1",
		receipt: receipt(),
	}, REDUCE);
	assert.equal(lateReceipt.ok, false);
	assert.match(lateReceipt.ok ? "" : lateReceipt.error, /steered by OMP/);
});

test("private session identity alone is not execution; OMP turn start is persisted", () => {
	const intent = intentTask();
	const workerIdentity = step(intent, (revision) => ({
		kind: "record_private_session",
		expectedRevision: revision,
		taskId: "T1" as TaskId,
		attemptId: "T1-a1",
		phase: "worker",
		sessionFile: "/state/sessions/worker.jsonl",
	}));
	assert.equal(findTask(workerIdentity, "T1" as TaskId)?.state, "READY");
	assert.equal(findTask(workerIdentity, "T1" as TaskId)?.attempts[0]?.privateSessions[0]?.started, false);
	const workerStarted = step(workerIdentity, (revision) => ({
		kind: "record_private_session_start",
		expectedRevision: revision,
		taskId: "T1" as TaskId,
		attemptId: "T1-a1",
		phase: "worker",
	}));
	assert.equal(findTask(workerStarted, "T1" as TaskId)?.state, "RUNNING");
	const acceptanceIdentity = step(workerStarted, (revision) => ({
		kind: "record_private_session",
		expectedRevision: revision,
		taskId: "T1" as TaskId,
		attemptId: "T1-a1",
		phase: "acceptance",
		sessionFile: "/state/sessions/acceptance.jsonl",
	}));
	assert.equal(findTask(acceptanceIdentity, "T1" as TaskId)?.attempts[0]?.privateSessions[1]?.started, false);
	const acceptanceStarted = step(acceptanceIdentity, (revision) => ({
		kind: "record_private_session_start",
		expectedRevision: revision,
		taskId: "T1" as TaskId,
		attemptId: "T1-a1",
		phase: "acceptance",
	}));
	const loaded = parseJournal(journalRecord(acceptanceStarted));
	assert.equal(loaded.ok, true);
	assert.deepEqual(loaded.ok ? findTask(loaded.ledger, "T1" as TaskId)?.attempts[0]?.privateSessions : [], [
		{ phase: "worker", sessionFile: "/state/sessions/worker.jsonl", started: true },
		{ phase: "acceptance", sessionFile: "/state/sessions/acceptance.jsonl", started: true },
	]);
});
test("session restart reconciles stale RUNNING and legacy intent without inventing a live child", async () => {
	const recover = async (source: Ledger, legacy: boolean) => {
		const stored = structuredClone(journalRecord(source)) as {
			tasks: Array<{ attempts: Array<Record<string, unknown>> }>;
		};
		if (legacy) {
			for (const task of stored.tasks) for (const attempt of task.attempts) {
				delete attempt.nativeJobIds;
				delete attempt.nativeAgentIds;
				delete attempt.privateSessions;
			}
		}
		const host = fakeHost();
		createLunaFactoryExtension(host as never, { env: FULL_ENV, artifactRoots: ROOTS });
		await host.events.get("session_start")!({}, {
			hasUI: true,
			ui: { notify: (message: string) => host.notify(message) },
			sessionManager: { getBranch: () => [{ type: "custom", customType: JOURNAL_ENTRY, data: stored }] },
		});
		const latest = host.entries.at(-1)?.data as Ledger;
		assert.equal(latest.control, "interrupted");
		assert.equal(findTask(latest, "T1" as TaskId)?.state, "ESCALATE");
		assert.equal(findTask(latest, "T1" as TaskId)?.attempts[0]?.state, "abandoned");
		assert.match(findTask(latest, "T1" as TaskId)?.decisionReason ?? "", /liveness is unknown/);
		return latest;
	};

	const identity = await recover(runningTask(), false);
	assert.deepEqual(findTask(identity, "T1" as TaskId)?.attempts[0]?.nativeJobIds, ["job-1"]);
	assert.deepEqual(findTask(identity, "T1" as TaskId)?.attempts[0]?.nativeAgentIds, ["agent-1"]);

	const legacy = await recover(intentTask(), true);
	assert.deepEqual(findTask(legacy, "T1" as TaskId)?.attempts[0]?.nativeJobIds, []);
	assert.deepEqual(findTask(legacy, "T1" as TaskId)?.attempts[0]?.nativeAgentIds, []);
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
	assert.equal(findTask(retry, "T1" as TaskId)?.state, "READY");
	assert.deepEqual(findTask(retry, "T1" as TaskId)?.attempts.map((attempt) => attempt.lineage), [1, 2]);
});

test("a returned worker moves to VERIFY and never straight to DONE", () => {
	const recorded = step(runningTask(), (revision) => ({ kind: "record_receipt", expectedRevision: revision, taskId: "T1" as TaskId, attemptId: "T1-a1", receipt: receipt() }));
	assert.equal(findTask(recorded, "T1" as TaskId)?.state, "VERIFY");
	assert.equal(criterionProven(recorded, "A1" as CriterionId), false);
});

test("a returned receipt survives a journal reload", () => {
	const recorded = step(runningTask(), (revision) => ({
		kind: "record_receipt",
		expectedRevision: revision,
		taskId: "T1" as TaskId,
		attemptId: "T1-a1",
		receipt: receipt(),
	}));
	const loaded = parseJournal(journalRecord(recorded));
	assert.equal(loaded.ok, true);
	const persisted = loaded.ok
		? findTask(loaded.ledger, "T1" as TaskId)?.attempts[0]?.receipt
		: undefined;
	assert.deepEqual(persisted, receipt());
});

test("a receipt may only be recorded once per attempt", () => {
	const recorded = step(runningTask(), (revision) => ({ kind: "record_receipt", expectedRevision: revision, taskId: "T1" as TaskId, attemptId: "T1-a1", receipt: receipt() }));
	const repeat = reduce(recorded, { kind: "record_receipt", expectedRevision: recorded.revision, taskId: "T1" as TaskId, attemptId: "T1-a1", receipt: receipt() }, REDUCE);
	assert.equal(repeat.ok, false);
});

test("a write task cannot complete before its attempt is integrated", () => {
	const writer = candidate({ effect: "write" });
	const admitted = step(ledger(), (revision) => ({ kind: "record_candidate", expectedRevision: revision, candidate: writer }));
	const started = executedAttempt(admitted, "T1" as TaskId, "T1-a1");
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

test("moving one criterion assumption invalidates only its dependent proof", () => {
	const initial = ledger();
	const scoped: Ledger = {
		...initial,
		criteria: initial.criteria.map((criterion) => {
			if (criterion.id === ("A1" as CriterionId)) return { ...criterion, assumptions: [{ kind: "acceptance-revision", value: "r1" }] };
			if (criterion.id === ("A2" as CriterionId)) return { ...criterion, mandatory: true };
			return criterion;
		}),
	};
	let current = step(scoped, (revision) => ({ kind: "record_candidate", expectedRevision: revision, candidate: candidate() }));
	current = executedAttempt(current, "T1" as TaskId, "T1-a1");
	current = step(current, (revision) => ({
		kind: "record_receipt", expectedRevision: revision, taskId: "T1" as TaskId, attemptId: "T1-a1",
		receipt: receipt({ version: 2, assumptions: [{ kind: "acceptance-revision", value: "r1" }], predicates: [
			{ phase: "worker", item: "acceptance predicate", ok: true, note: "checked" },
			{ phase: "acceptance", item: "criterion accepted", ok: true, note: "independently reviewed" },
		] }),
	}));
	current = step(current, (revision) => ({ kind: "finish_task", expectedRevision: revision, taskId: "T1" as TaskId, criterionId: "A1" as CriterionId }));
	current = step(current, (revision) => ({ kind: "record_candidate", expectedRevision: revision, candidate: candidate({ taskId: "T2" as TaskId, criterionId: "A2" as CriterionId }) }));
	current = executedAttempt(current, "T2" as TaskId, "T2-a1");
	current = step(current, (revision) => ({
		kind: "record_receipt", expectedRevision: revision, taskId: "T2" as TaskId, attemptId: "T2-a1",
		receipt: receipt({ taskId: "T2" as TaskId, attemptId: "T2-a1" }),
	}));
	current = step(current, (revision) => ({ kind: "finish_task", expectedRevision: revision, taskId: "T2" as TaskId, criterionId: "A2" as CriterionId }));
	const revised = step(current, (revision) => ({
		kind: "revise_criterion_assumptions", expectedRevision: revision, criterionId: "A1" as CriterionId,
		assumptions: [{ kind: "acceptance-revision", value: "r2" }], reason: "authoritative acceptance text changed",
	}));
	assert.equal(findTask(revised, "T1" as TaskId)?.state, "READY");
	assert.equal(findTask(revised, "T2" as TaskId)?.state, "DONE");
	assert.equal(criterionProven(revised, "A1" as CriterionId), false);
	assert.equal(criterionProven(revised, "A2" as CriterionId), true);
});

test("assumptions cannot change while a READY attempt still has intent", () => {
	const admitted = step(ledger(), (revision) => ({ kind: "record_candidate", expectedRevision: revision, candidate: candidate() }));
	const intent = step(admitted, (revision) => ({
		kind: "start_attempt",
		expectedRevision: revision,
		taskId: "T1" as TaskId,
		attemptId: "T1-a1",
		subject: SUBJECT,
	}));
	assert.equal(findTask(intent, "T1" as TaskId)?.state, "READY", "persisted intent is not execution start");
	const revised = reduce(intent, {
		kind: "revise_criterion_assumptions",
		expectedRevision: intent.revision,
		criterionId: "A1" as CriterionId,
		assumptions: [{ kind: "acceptance-revision", value: "r2" }],
		reason: "the authoritative acceptance changed",
	}, REDUCE);
	assert.equal(revised.ok, false);
	assert.match(revised.ok ? "" : revised.error, /in-flight attempt/);
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
	const started = executedAttempt(admitted, "T2" as TaskId, "T2-a1");
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
	assert.equal(retry.ok ? findTask(retry.ledger, "T1" as TaskId)?.state : undefined, "READY");

	const replan = reduce(reopened, { kind: "use_replan", expectedRevision: reopened.revision, taskId: "T1" as TaskId }, REDUCE);
	assert.equal(replan.ok, false);
	assert.match(replan.ok ? "" : replan.error, /not diagnosed/);
});

test("one bounded replan is allowed after a plateau, and only once", () => {
	let current = runningTask();
	for (const attempt of ["T1-a1", "T1-a2"]) {
		if (attempt === "T1-a2") {
			current = executedAttempt(current, "T1" as TaskId, attempt);
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

test("progress reports escalated uncertainty separately from blocked work", () => {
	const base = ledger();
	const extraCriterion = { ...base.criteria[0]!, id: "A2" as CriterionId };
	const task = (id: string, criterionId: CriterionId, state: "BLOCKED" | "ESCALATE", decision: "DEFER" | "ESCALATE") => ({
		id: id as TaskId,
		generation: base.generation,
		criterionId,
		title: id,
		deps: [],
		effect: "read" as const,
		owner: "luna",
		state,
		attempts: [],
		decision,
		decisionReason: `${state} evidence`,
	});
	const mixed: Ledger = {
		...base,
		criteria: [...base.criteria, extraCriterion],
		tasks: [task("T1", "A1" as CriterionId, "ESCALATE", "ESCALATE"), task("T2", "A2" as CriterionId, "BLOCKED", "DEFER")],
	};
	const verdict = evaluateRun(mixed);
	assert.equal(verdict.blockedMandatory, 1);
	assert.equal(verdict.unknownMandatory, 1);
	assert.equal(verdict.provenMandatory, 0);
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
	current = executedAttempt(current, "T1" as TaskId, "T1-a2");
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

test("dispatch requires an admitted task and persisted attempt intent", () => {
	const admitted = step(ledger(), (revision) => ({ kind: "record_candidate", expectedRevision: revision, candidate: candidate() }));
	const notStarted = buildDispatchPrompt(admitted, "T1" as TaskId, "T1-a1");
	assert.equal(notStarted.ok, false);
	assert.match(notStarted.ok ? "" : notStarted.error, /persist the intent before the effect/);

	const intent = step(admitted, (revision) => ({
		kind: "start_attempt",
		expectedRevision: revision,
		taskId: "T1" as TaskId,
		attemptId: "T1-a1",
		subject: SUBJECT,
	}));
	const dispatched = buildDispatchPrompt(intent, "T1" as TaskId, "T1-a1");
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
	const plan = buildDispatchPrompt(intentTask(), "T1" as TaskId, "T1-a1");
	assert.equal(plan.ok, true);
	const prompt = plan.ok ? plan.prompt : "";
	assert.match(prompt, /task T1 \(attempt T1-a1, lineage 1\)/);
	assert.match(prompt, /generation G1 · revision \d+ · subject example\/repo@a{40}/);
	assert.match(prompt, /criterion A1/);
	assert.match(prompt, /Do not create successor tasks or missions/);
	assert.match(prompt, /Do not approve, merge, publish/);
	assert.ok(prompt.includes(RECEIPT_CONTRACT));
	const dispatchOnly = step(intentTask(), (revision) => ({
		kind: "record_native_job",
		expectedRevision: revision,
		taskId: "T1" as TaskId,
		attemptId: "T1-a1",
		jobId: "omp-job-1",
	}));
	const duplicateDispatch = buildDispatchPrompt(dispatchOnly, "T1" as TaskId, "T1-a1");
	assert.equal(duplicateDispatch.ok, false);
	assert.match(duplicateDispatch.ok ? "" : duplicateDispatch.error, /already has an OMP execution identity/);
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
	assert.match(line, /^Factory G1 · 0\/1 proven · 0 active · 0 blocked · 1 unknown$/);

	const detail = renderStatusDetail(ledger());
	assert.match(detail[0]!, /^Factory G1/);
	assert.ok(detail.some((row) => /\[mandatory\] A1: the fix is proven — unproven/.test(row)));
	assert.ok(detail.some((row) => /non-goals: no new dashboard/.test(row)));
});

test("status counts VERIFY as active and leaves unrepresented mandatory scope unknown", () => {
	const verifying = step(runningTask(), (revision) => ({
		kind: "record_receipt",
		expectedRevision: revision,
		taskId: "T1" as TaskId,
		attemptId: "T1-a1",
		receipt: receipt({ unresolved: ["verification remains incomplete"] }),
	}));
	assert.match(renderStatus(verifying), /0\/1 proven · 1 active · 0 blocked · 0 unknown/);
	assert.match(renderStatus(ledger()), /0\/1 proven · 0 active · 0 blocked · 1 unknown/);
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

interface FakeToolResult {
	content: Array<{ text: string; type?: string }>;
	isError?: boolean;
	details?: unknown;
}

interface FakeTool {
	name: string;
	description?: string;
	parameters?: unknown;
	execute(...args: unknown[]): Promise<FakeToolResult>;
}

interface FakeNativeAgentSession {
	subscribe(listener: (event: unknown) => void): () => void;
	emit(event: unknown): void;
}

interface FakeNativeAgentRegistry {
	get(id: string): { id: string; kind: "sub"; session: FakeNativeAgentSession } | undefined;
	onChange(listener: (event: unknown) => void): () => void;
	registerAgent(id: string): FakeNativeAgentSession;
}

function fakeNativeAgentRegistry(): FakeNativeAgentRegistry {
	const refs = new Map<string, { id: string; kind: "sub"; session: FakeNativeAgentSession }>();
	const listeners = new Set<(event: unknown) => void>();
	return {
		get(id) {
			return refs.get(id);
		},
		onChange(listener) {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		registerAgent(id) {
			const sessionListeners = new Set<(event: unknown) => void>();
			const session: FakeNativeAgentSession = {
				subscribe(listener) {
					sessionListeners.add(listener);
					return () => sessionListeners.delete(listener);
				},
				emit(event) {
					for (const listener of sessionListeners) listener(event);
				},
			};
			const ref = { id, kind: "sub" as const, session };
			refs.set(id, ref);
			for (const listener of listeners) listener({ type: "registered", ref });
			return session;
		},
	};
}

interface FakeHost {
	agentRegistry: FakeNativeAgentRegistry;
	tools: Map<string, FakeTool>;
	nativeTaskCalls: { count: number };
	events: Map<string, (event: unknown, ctx: unknown) => unknown>;
	commands: Map<string, { description?: string; handler(args: string, ctx: unknown): unknown }>;
	entries: Array<{ customType: string; data: unknown }>;
	notifications: string[];
	sentMessages: Array<{ content: string; options?: unknown }>;
	zod: {
		object: (shape: Record<string, unknown>) => unknown;
		string: () => unknown;
		number: () => unknown;
		boolean: () => unknown;
		array: (item: unknown) => unknown;
		enum: (values: readonly string[]) => unknown;
		literal: (value: string | number | boolean) => unknown;
		union: (values: readonly unknown[]) => unknown;
	};
	arktype?: (schema: unknown) => unknown;
	setLabel(): void;
	registerTool(definition: FakeTool): void;
	appendEntry(customType: string, data: unknown): void;
	on(name: string, handler: (event: unknown, ctx: unknown) => unknown): void;
	registerCommand(name: string, definition: { description?: string; handler(args: string, ctx: unknown): unknown }): void;
	sendUserMessage(content: string, options?: unknown): void;
	notify(message: string): void;
}

function fakeHost(options: { nativeTask?: boolean } = {}): FakeHost {
	const tools = new Map<string, FakeTool>();
	const events = new Map<string, (event: unknown, ctx: unknown) => unknown>();
	const commands = new Map<string, { description?: string; handler(args: string, ctx: unknown): unknown }>();
	const entries: Array<{ customType: string; data: unknown }> = [];
	const notifications: string[] = [];
	const sentMessages: Array<{ content: string; options?: unknown }> = [];
	const nativeTaskCalls = { count: 0 };
	const agentRegistry = fakeNativeAgentRegistry();
	interface FakeSchema {
		kind: string;
		[key: string]: unknown;
		optional(): FakeSchema;
		describe(description: string): FakeSchema;
	}
	const schema = (kind: string, properties: Record<string, unknown> = {}, isOptional = false): FakeSchema => ({
		kind,
		...properties,
		...(isOptional ? { isOptional: true } : {}),
		optional() {
			return schema(kind, properties, true);
		},
		describe(description: string) {
			return schema(kind, { ...properties, description }, isOptional);
		},
	});
	if (options.nativeTask) {
		tools.set("task", {
			name: "task",
			description: "Run an ordinary OMP workflowz task.",
			async execute() {
				nativeTaskCalls.count += 1;
				return { content: [{ text: "native task completed" }] };
			},
		});
	}
	return {
		tools,
		agentRegistry,
		nativeTaskCalls,
		events,
		commands,
		entries,
		notifications,
		sentMessages,
		zod: {
			object: (shape: Record<string, unknown>) => schema("object", { shape }),
			string: () => schema("string"),
			number: () => schema("number"),
			boolean: () => schema("boolean"),
			array: (item: unknown) => schema("array", { item }),
			enum: (values: readonly string[]) => schema("enum", { values }),
			literal: (value: string | number | boolean) => schema("literal", { value }),
			union: (values: readonly unknown[]) => schema("union", { values }),
		},
		arktype: options.nativeTask ? ((schema: unknown) => schema) : undefined,
		setLabel() {},
		registerTool(definition: FakeTool) {
			if (definition.name === "task") {
				tools.set(definition.name, {
					...definition,
					async execute(...args: any[]) {
						const rawContext = args[4];
						const context = typeof rawContext === "object" && rawContext !== null
							? rawContext as Record<string, unknown>
							: {};
						args[4] = { ...context, agentRegistry };
						return definition.execute(...args);
					},
				});
			} else {
				tools.set(definition.name, definition);
			}
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

function startCtx(host: FakeHost) {
	return { hasUI: true, ui: { notify: (message: string) => host.notify(message) }, sessionManager: { getBranch: () => [] } };
}

async function callTool(host: FakeHost, name: string, input: Record<string, unknown>) {
	const tool = host.tools.get(name);
	assert.ok(tool !== undefined, `${name} is not registered`);
	return tool.execute("call", input);
}
async function observeNativeStart(
	host: FakeHost,
	taskId: string,
	attemptId: string,
	generation = "G1",
	steerBeforeIdentity = false,
): Promise<FakeNativeAgentSession> {
	const task = host.tools.get("task");
	assert.ok(task, "the native OMP task wrapper is registered");
	const agentId = `agent-${taskId}-${attemptId}`;
	const details = {
		async: { state: "completed", jobId: `job-${taskId}-${attemptId}`, type: "task" },
		progress: [{ index: 0, id: agentId, status: "completed", requests: 1 }],
	};
	let childSession: FakeNativeAgentSession | undefined;
	const result = await task.execute(
		"call",
		{ agent: "task", isolated: true, task: `perform the admitted work\n${dispatchMarker(taskId, attemptId, generation)}` },
		undefined,
		undefined,
		{
			invokeTool: async (_params: unknown, options?: { onUpdate?: (update: unknown) => void }) => {
				childSession = host.agentRegistry.registerAgent(agentId);
				childSession.emit({ type: "message_start", message: { role: "user", attribution: "agent" } });
				if (steerBeforeIdentity) childSession.emit({ type: "message_start", message: { role: "user", attribution: "user" } });
				options?.onUpdate?.({ details });
				return { content: [{ type: "text", text: "native child returned" }], details };
			},
		} as never,
	);
	assert.equal(result.isError, steerBeforeIdentity ? true : undefined, result.content[0]?.text);
	assert.ok(childSession, "OMP registered the child session");
	return childSession;
}

const FULL_ENV = { LUNA_FACTORY_ENABLED: "1" };

test("the Factory handoff distinguishes not-registered, load-failed, and registered", async () => {
	const clearController = registerFactoryController(async () => "stub");
	clearController();
	assert.equal(factoryHandoffState(), "not-registered");
	assert.match(factoryLoadDiagnostic(), /never registered a controller/);
	assert.doesNotMatch(factoryLoadDiagnostic(), /LUNA_FACTORY_ENABLED/, "a missing package must not be blamed on the execution opt-in");

	reportFactoryLoadFailure("host rejected the extension surface\nwith a second line");
	assert.equal(factoryHandoffState(), "load-failed");
	assert.equal(
		factoryLoadDiagnostic(),
		"the Luna Factory extension is packaged but failed to load: host rejected the extension surface with a second line",
	);
	await assert.rejects(factoryCommand("status", {}), /failed to load: host rejected the extension surface/);

	const host = fakeHost();
	lunaFactoryExtension(host as never);
	assert.equal(factoryHandoffState(), "registered");
	assert.equal(factoryLoadDiagnostic(), "the Luna Factory controller is registered");
	await host.events.get("session_shutdown")!();
	assert.equal(factoryHandoffState(), "not-registered");
});

test("query-suffixed bridge copies share handoff state and preserve newer registrations", async () => {
	const reviewBridge = await import("../image/extension/luna-factory/omp/batch-bridge.ts?mtime=review");
	const factoryBridge = await import("../image/extension/luna-factory/omp/batch-bridge.ts?mtime=factory");
	assert.notEqual(reviewBridge, factoryBridge);
	const item = (number: number, action: FactoryAction): SelectedItem => ({ key: `example/repo#${number}`, repo: "example/repo", number, kind: "pr", action, overlaps: [] });
	const firstSelection = reviewBridge.registerFactorySelection(() => [item(1, "inspect")]);
	assert.deepEqual(factoryBridge.selectedFactoryItems("inspect"), [item(1, "inspect")]);
	const secondSelection = factoryBridge.registerFactorySelection(() => [item(2, "patch")]);
	try {
		assert.deepEqual(reviewBridge.selectedFactoryItems("inspect"), [item(2, "patch")]);
		firstSelection();
		assert.deepEqual(selectedFactoryItems("inspect"), [item(2, "patch")]);
		secondSelection();
		assert.throws(() => selectedFactoryItems("inspect"), /select exact items/);

		let received: { command: string; context: unknown } | undefined;
		const firstController = reviewBridge.registerFactoryController(async (command, context) => { received = { command, context }; return "first"; });
		const secondController = factoryBridge.registerFactoryController(async (command, context) => { received = { command, context }; return "second"; });
		try {
			const context = { source: "bridge-test" };
			assert.equal(reviewBridge.factoryControllerRegistered(), true);
			assert.equal(factoryBridge.factoryControllerRegistered(), true);
			assert.equal(await reviewBridge.factoryCommand("status", context), "second");
			assert.deepEqual(received, { command: "status", context });
			firstController();
			assert.equal(await factoryBridge.factoryCommand("status", context), "second");
		} finally {
			secondController();
			firstController();
		}
		await assert.rejects(factoryCommand("status", {}), /Factory is not loaded/);

		reviewBridge.reportFactoryLoadFailure(`${"reason ".repeat(100)}tail`);
		assert.equal(factoryBridge.factoryHandoffState(), "load-failed");
		assert.ok(factoryBridge.factoryLoadDiagnostic().length < 320);
		const clearController = factoryBridge.registerFactoryController(async () => "cleared");
		try {
			assert.equal(reviewBridge.factoryHandoffState(), "registered");
			assert.equal(await reviewBridge.factoryCommand("status", {}), "cleared");
		} finally {
			clearController();
		}
	} finally {
		firstSelection();
		secondSelection();
	}
});

test("a load failure reason is bounded, single-line, and secret-free", () => {
	reportFactoryLoadFailure(`${"LUNA_FACTORY_CAPACITY=7 ".repeat(40)}tail`);
	const diagnostic = factoryLoadDiagnostic();
	assert.ok(diagnostic.length < 320, `diagnostic was ${diagnostic.length} characters`);
	assert.ok(!diagnostic.includes("\n"), "a diagnostic is one line");
	assert.ok(diagnostic.endsWith("…"), diagnostic);
});

test("a package that throws while loading reports the reason and still fails loudly", () => {
	const exploding = fakeHost();
	exploding.zod.object = () => {
		throw new Error("host rejected the extension surface");
	};
	assert.throws(() => lunaFactoryExtension(exploding as never), /host rejected the extension surface/);
	assert.equal(factoryHandoffState(), "load-failed");
	assert.match(factoryLoadDiagnostic(), /packaged but failed to load: host rejected the extension surface/);
});

test("Factory enabled but idle preserves the native workflowz task", async () => {
	const host = fakeHost({ nativeTask: true });
	createLunaFactoryExtension(host as never, { env: FULL_ENV, artifactRoots: ROOTS });
	await host.events.get("session_start")!({}, startCtx(host));

	const task = host.tools.get("task");
	assert.ok(task);
	assert.equal(task.description, "Run an ordinary OMP workflowz task.");
	const result = await task.execute("call", { task: "ordinary Review work" });
	assert.equal(result.isError, undefined);
	assert.equal(host.nativeTaskCalls.count, 1);
});

test("Factory disabled leaves the native workflowz task unchanged", async () => {
	for (const env of [{}, { LUNA_FACTORY_ENABLED: "0" }]) {
		const host = fakeHost({ nativeTask: true });
		createLunaFactoryExtension(host as never, { env, artifactRoots: ROOTS });
		await host.events.get("session_start")!({}, startCtx(host));

		const task = host.tools.get("task");
		assert.ok(task);
		assert.equal(task.description, "Run an ordinary OMP workflowz task.");
		await task.execute("call", { task: "ordinary Review work" });
		assert.equal(host.nativeTaskCalls.count, 1);
	}
});

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
test("Factory exposes typed tool contracts and accepts an object on the first call", async () => {
	const host = fakeHost();
	createLunaFactoryExtension(host as never, { env: FULL_ENV, artifactRoots: ROOTS });
	const open = host.tools.get("luna_factory_open");
	assert.ok(open);
	const parameters = open.parameters as {
		kind: string;
		shape: Record<string, { kind: string; isOptional?: boolean; item?: { kind: string; values?: readonly unknown[] }; values?: readonly unknown[]; shape?: Record<string, { isOptional?: boolean }> }>;
	};
	assert.equal(parameters.kind, "object");
	assert.deepEqual(Object.keys(parameters.shape).sort(), [
		"appetite",
		"base",
		"criteria",
		"finishAuthority",
		"finishDeliverable",
		"head",
		"nonGoals",
		"objective",
		"options",
		"permittedEffects",
		"replace",
		"repo",
	]);
	assert.equal(parameters.shape.criteria.kind, "array");
	assert.equal(parameters.shape.permittedEffects.kind, "array");
	assert.deepEqual(parameters.shape.permittedEffects.item?.values, ["read", "write"]);
	assert.equal(parameters.shape.finishDeliverable?.isOptional, true);
	assert.equal(parameters.shape.options?.shape?.finishDeliverable?.isOptional, true);
	const receiptTool = host.tools.get("luna_factory_receipt");
	assert.ok(receiptTool);
	const receiptParameters = receiptTool.parameters as {
		kind: string;
		values: ReadonlyArray<{ shape?: Record<string, { value?: unknown; isOptional?: boolean }> }>;
	};
	assert.equal(receiptParameters.kind, "union");
	assert.deepEqual(receiptParameters.values.map((variant) => variant.shape?.version?.value), [1, 2]);
	assert.equal(receiptParameters.values[0]?.shape?.assumptions, undefined);
	assert.notEqual(receiptParameters.values[1]?.shape?.assumptions?.isOptional, true);
	assert.notEqual(receiptParameters.values[1]?.shape?.predicates?.isOptional, true);
	assert.equal(receiptParameters.values[1]?.shape?.semanticResult?.isOptional, true);
	const opened = await callTool(host, "luna_factory_open", {
		objective: "use the typed contract",
		criteria: [{ id: "A1", statement: "the first call opens the run" }],
		repo: "example/repo",
		base: "a".repeat(40),
		nonGoals: ["do not merge"],
		permittedEffects: ["read"],
		finishAuthority: "report only",
		appetite: { tasks: 1, attemptsPerTask: 1 },
	});
	assert.equal(opened.isError, undefined);
	assert.equal(host.entries.length, 1);
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
	const intent = host.entries.at(-1)!.data as { tasks: Array<{ state: string; attempts: Array<{ nativeJobIds: string[] }> }> };
	assert.equal(intent.tasks[0]!.state, "READY");
	assert.deepEqual(intent.tasks[0]!.attempts[0]!.nativeJobIds, []);
	const notStartedReceipt = await callTool(host, "luna_factory_receipt", receipt());
	assert.equal(notStartedReceipt.isError, true);
	assert.match(notStartedReceipt.content[0]!.text, /not an active dispatched attempt/);

	const task = host.tools.get("task");
	assert.ok(task, "a host with native task support gets a same-name wrapper");
	let delayedUpdate: ((update: unknown) => void) | undefined;
	const invoke = async (_params: unknown, options?: { onUpdate?: (update: unknown) => void }) => {
		nativeCalls += 1;
		const childSession = host.agentRegistry.registerAgent("agent-1");
		childSession.emit({ type: "message_start", message: { role: "user", attribution: "agent" } });
		delayedUpdate = options?.onUpdate;
		const details = {
			async: { state: "running", jobId: "job-1", type: "task" },
			progress: [{ index: 0, id: "agent-1", status: "pending" }],
		};
		return { content: [{ type: "text", text: "native task dispatched" }], details };
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
	const dispatchedRecord = host.entries.at(-1)!.data as { tasks: Array<{ state: string; attempts: Array<{ nativeJobIds: string[]; nativeAgentIds: string[] }> }> };
	assert.equal(dispatchedRecord.tasks[0]!.state, "READY");
	assert.deepEqual(dispatchedRecord.tasks[0]!.attempts[0]!.nativeJobIds, ["job-1"]);
	assert.deepEqual(dispatchedRecord.tasks[0]!.attempts[0]!.nativeAgentIds, []);
	const dispatchOnlyReceipt = await callTool(host, "luna_factory_receipt", receipt());
	assert.equal(dispatchOnlyReceipt.isError, true);
	assert.match(dispatchOnlyReceipt.content[0]!.text, /not an active dispatched attempt/);
	assert.ok(delayedUpdate);
	delayedUpdate({ details: {
		async: { state: "running", jobId: "job-1", type: "task" },
		progress: [{ index: 0, id: "agent-1", status: "running", requests: 1 }],
	} });
	const record = host.entries.at(-1)!.data as { tasks: Array<{ state: string; attempts: Array<{ nativeJobIds: string[]; nativeAgentIds: string[] }> }> };
	assert.equal(record.tasks[0]!.state, "RUNNING");
	assert.deepEqual(record.tasks[0]!.attempts[0]!.nativeJobIds, ["job-1"]);
	assert.deepEqual(record.tasks[0]!.attempts[0]!.nativeAgentIds, ["agent-1"]);
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
				for (const agentId of ["agent-1", "agent-2"]) {
					const childSession = host.agentRegistry.registerAgent(agentId);
					childSession.emit({ type: "message_start", message: { role: "user", attribution: "agent" } });
				}
				return {
					content: [{ type: "text", text: "batch completed" }],
					details: { async: { state: "completed", jobId: "batch-1", type: "task" }, results: [{ index: 0, id: "agent-1", requests: 1 }, { index: 1, id: "agent-2", requests: 1 }] },
				};
			},
		} as never,
	);
	assert.equal(result.isError, undefined);
	assert.equal(calls, 1, "one native batch owns both admitted items");
	const record = host.entries.at(-1)!.data as { tasks: Array<{ id: string; attempts: Array<{ nativeJobIds: string[]; nativeAgentIds: string[] }> }> };
	assert.deepEqual(record.tasks.map((entry) => [entry.id, entry.attempts[0]!.nativeJobIds, entry.attempts[0]!.nativeAgentIds]), [
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
		const childSession = host.agentRegistry.registerAgent("write-agent-1");
		childSession.emit({ type: "message_start", message: { role: "user", attribution: "agent" } });
		return { content: [{ type: "text", text: "isolated native task completed" }], details: { async: { state: "completed", jobId: "write-job-1", type: "task" }, results: [{ id: "write-agent-1", requests: 1 }] } };
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
test("selected batch command remains opt-in", async () => {
	const host = fakeHost();
	createLunaFactoryExtension(host as never, { env: {}, artifactRoots: ROOTS });
	const command = host.commands.get("factory");
	assert.ok(command);
	await command.handler("run {\"items\":[]}", startCtx(host));
	assert.ok(host.notifications.some((message) => /LUNA_FACTORY_ENABLED=1|Factory is disabled/.test(message)));
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
	const host = fakeHost({ nativeTask: true });
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

	await observeNativeStart(host, "T1", "T1-a1");
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

test("an explicit Hub steer invalidates a live native Factory child", async () => {
	const host = fakeHost({ nativeTask: true });
	createLunaFactoryExtension(host as never, { env: FULL_ENV, artifactRoots: ROOTS });
	host.events.get("session_start")!({}, startCtx(host));
	await callTool(host, "luna_factory_open", {
		objective: "prove the isolated child work",
		criteria: [{ id: "A1", statement: "the child work is proven" }],
		repo: "example/repo",
		base: "a".repeat(40),
	});
	await callTool(host, "luna_factory_candidate", {
		taskId: "T1",
		generation: "G1",
		criterionId: "A1",
		title: "perform the child work",
		deps: [],
		effect: "read",
		owner: "luna",
		necessity: "A1 is unproven",
	});
	await callTool(host, "luna_factory_attempt", { taskId: "T1", attemptId: "T1-a1" });
	const childSession = await observeNativeStart(host, "T1", "T1-a1");
	childSession.emit({ type: "message_start", message: { role: "user", attribution: "user" } });

	const journal = host.entries.at(-1)!.data as {
		tasks: Array<{ state: string; attempts: Array<{ steeredAgentId?: string }> }>;
	};
	assert.equal(journal.tasks[0]!.state, "ESCALATE");
	assert.equal(journal.tasks[0]!.attempts[0]!.steeredAgentId, "agent-T1-T1-a1");
	const status = await callTool(host, "luna_factory_status", {});
	assert.match(status.content[0]!.text, /Hub-steered; attempt invalidated/);
	const receiptResult = await callTool(host, "luna_factory_receipt", receipt());
	assert.equal(receiptResult.isError, true);
	assert.match(receiptResult.content.map((part) => part.text).join("\n"), /steered by OMP/);
	const finish = await callTool(host, "luna_factory_finish", { taskId: "T1" });
	assert.equal(finish.isError, true);
});

test("Hub steering before OMP identity details is retained and invalidates the attempt", async () => {
	const host = fakeHost({ nativeTask: true });
	createLunaFactoryExtension(host as never, { env: FULL_ENV, artifactRoots: ROOTS });
	host.events.get("session_start")!({}, startCtx(host));
	await callTool(host, "luna_factory_open", {
		objective: "prove the child work",
		criteria: [{ id: "A1", statement: "the child work is proven" }],
		repo: "example/repo",
		base: "a".repeat(40),
	});
	await callTool(host, "luna_factory_candidate", {
		taskId: "T1",
		generation: "G1",
		criterionId: "A1",
		title: "perform child work",
		deps: [],
		effect: "read",
		owner: "luna",
		necessity: "A1 is unproven",
	});
	await callTool(host, "luna_factory_attempt", { taskId: "T1", attemptId: "T1-a1" });
	await observeNativeStart(host, "T1", "T1-a1", "G1", true);
	const journal = host.entries.at(-1)!.data as {
		tasks: Array<{ state: string; attempts: Array<{ steeredAgentId?: string }> }>;
	};
	assert.equal(journal.tasks[0]!.state, "ESCALATE");
	assert.equal(journal.tasks[0]!.attempts[0]!.steeredAgentId, "agent-T1-T1-a1");
});

test("write integration is an explicit owner event and moves the proof subject", async () => {
	const host = fakeHost({ nativeTask: true });
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
	await observeNativeStart(host, "T1", "T1-a1");
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
	const host = fakeHost({ nativeTask: true });
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
	await observeNativeStart(host, "T1", "T1-a1");
	await callTool(host, "luna_factory_receipt", receipt({ unresolved: ["still broken"] }));
	const premature = await callTool(host, "luna_factory_replan", { taskId: "T1" });
	assert.equal(premature.isError, true);
	assert.match(premature.content[0]!.text, /not diagnosed/);

	await callTool(host, "luna_factory_attempt", { taskId: "T1", attemptId: "T1-a2" });
	await observeNativeStart(host, "T1", "T1-a2");
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
	const host = fakeHost({ nativeTask: true });
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
	await observeNativeStart(host, "T1", "T1-a1");
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

test("OMP task running status without a request remains unknown, not RUNNING", async () => {
	const host = fakeHost({ nativeTask: true });
	createLunaFactoryExtension(host as never, { env: FULL_ENV, artifactRoots: ROOTS });
	host.events.get("session_start")!({}, startCtx(host));
	await callTool(host, "luna_factory_open", {
		objective: "do not infer a child from a queued OMP task",
		criteria: [{ id: "A1", statement: "the child start is observed" }],
		repo: "example/repo",
		base: "a".repeat(40),
	});
	await callTool(host, "luna_factory_candidate", {
		taskId: "T1",
		generation: "G1",
		criterionId: "A1",
		title: "inspect the selected item",
		deps: [],
		effect: "read",
		owner: "luna",
		necessity: "A1 is unproven",
	});
	await callTool(host, "luna_factory_attempt", { taskId: "T1", attemptId: "T1-a1" });
	const task = host.tools.get("task");
	assert.ok(task);
	const marker = dispatchMarker("T1", "T1-a1", "G1");
	let stateAtUnstartedProgress = "";
	const result = await task.execute(
		"call",
		{ task: `do the work\n${marker}` },
		undefined,
		undefined,
		{
			invokeTool: async (_params: unknown, options?: { onUpdate?: (update: unknown) => void }) => {
				options?.onUpdate?.({
					details: {
						async: { state: "running", jobId: "job-setup", type: "task" },
						progress: [{ index: 0, id: "agent-setup", status: "running", requests: 0 }],
					},
				});
				const running = host.entries.at(-1)!.data as { tasks: Array<{ state: string; attempts: Array<{ nativeJobIds: string[]; nativeAgentIds: string[] }> }> };
				stateAtUnstartedProgress = running.tasks[0]!.state;
				assert.deepEqual(running.tasks[0]!.attempts[0]!.nativeAgentIds, []);
				options?.onUpdate?.({
					details: {
						async: { state: "failed", jobId: "job-setup", type: "task" },
						progress: [{ index: 0, id: "agent-setup", status: "failed", requests: 0 }],
					},
				});
				return {
					content: [{ type: "text", text: "OMP setup failed" }],
					details: {
						async: { state: "failed", jobId: "job-setup", type: "task" },
						progress: [{ index: 0, id: "agent-setup", status: "failed", requests: 0 }],
					},
				};
			},
		} as never,
	);
	assert.equal(stateAtUnstartedProgress, "READY");
	assert.equal(result.isError, true);
	assert.ok(result.content.some((part) => /escalated as unknown/.test(part.text)));
	const final = host.entries.at(-1)!.data as { tasks: Array<{ state: string; decisionReason: string; attempts: Array<{ state: string; nativeJobIds: string[]; nativeAgentIds: string[] }> }> };
	assert.equal(final.tasks[0]!.state, "ESCALATE");
	assert.match(final.tasks[0]!.decisionReason, /liveness is unknown/);
	assert.equal(final.tasks[0]!.attempts[0]!.state, "abandoned");
	assert.deepEqual(final.tasks[0]!.attempts[0]!.nativeJobIds, ["job-setup"]);
	assert.deepEqual(final.tasks[0]!.attempts[0]!.nativeAgentIds, []);
});
