/**
 * Evidence reconciliation.
 *
 * A parsed receipt proves a shape. This module decides whether the receipt is
 * evidence *about the thing being certified*, which is a different question and
 * the one the protocol is built around. Everything here is pure so the
 * adversarial cases in the regression matrix can be driven directly.
 */

import { artifactRefError, changedPathError } from "./schema.ts";
import type { CriterionId, EvidenceReceipt, Ledger, ProofAssumption, Subject, TaskId } from "./model.ts";

export type EvidenceStatus = "proven" | "unproved" | "failed" | "contradicted";

export interface Reconciliation {
	readonly status: EvidenceStatus;
	readonly reasons: readonly string[];
}

export interface SubjectBinding {
	readonly taskId: TaskId;
	readonly attemptId: string;
	readonly subject: Subject;
	/** Current authoritative values for assumptions declared by this receipt. */
	readonly assumptions?: readonly ProofAssumption[];
	/** Assumptions required by the acceptance criterion; omitting one is UNKNOWN. */
	readonly requiredAssumptions?: readonly ProofAssumption[];
	/** Roots the run owns. A reference outside them is not followed. */
	readonly artifactRoots: readonly string[];
}

function assumptionKey(assumption: ProofAssumption): string {
	return assumption.kind === "dependency-outcome" ? `${assumption.kind}:${assumption.taskId}` : assumption.kind;
}

function sameAssumption(left: ProofAssumption, right: ProofAssumption): boolean {
	return assumptionKey(left) === assumptionKey(right) && left.value === right.value;

}
function sameSubject(left: Subject, right: Subject): boolean {
	return left.repo === right.repo && left.base === right.base && left.head === right.head;
}

function currentAssumptionsFor(ledger: Ledger, taskId: TaskId): readonly ProofAssumption[] {
	const task = ledger.tasks.find((entry) => entry.id === taskId);
	const criterion = task && ledger.criteria.find((entry) => entry.id === task.criterionId);
	return (criterion?.assumptions ?? []).flatMap((assumption) => {
		if (assumption.kind !== "dependency-outcome") return [assumption];
		const dependency = ledger.tasks.find((entry) => entry.id === assumption.taskId);
		if (dependency === undefined) return [];
		return [{ ...assumption, value: criterionProven(ledger, dependency.criterionId) ? "proven" : "unproven" }];
	});
}
/**
 * Reconcile a receipt against the exact identity it claims to certify.
 *
 * Binding is checked first: a receipt for another task, attempt, generation, or
 * subject is not weak evidence, it is not evidence, and reporting it as
 * "unproved" would understate the problem.
 */
export function reconcileReceipt(ledger: Ledger, receipt: EvidenceReceipt, binding: SubjectBinding): Reconciliation {
	const reasons: string[] = [];

	if (receipt.taskId !== binding.taskId) {
		return { status: "contradicted", reasons: [`receipt names task ${receipt.taskId}, not ${binding.taskId}`] };
	}
	if (receipt.attemptId !== binding.attemptId) {
		return { status: "contradicted", reasons: [`receipt names attempt ${receipt.attemptId}, not ${binding.attemptId}`] };
	}
	if (receipt.generation !== ledger.generation) {
		return {
			status: "contradicted",
			reasons: [`receipt is for generation ${receipt.generation}, run is at ${ledger.generation}`],
		};
	}
	if (!sameSubject(receipt.subject, binding.subject)) {
		return {
			status: "contradicted",
			reasons: [`receipt subject ${receipt.subject.repo}@${receipt.subject.head ?? receipt.subject.base} is not the certified subject`],
		};
	}
	const assumptionReasons: string[] = [];
	const criterion = ledger.criteria.find((entry) => entry.id === ledger.tasks.find((task) => task.id === binding.taskId)?.criterionId);
	const currentAssumptions = binding.assumptions ?? currentAssumptionsFor(ledger, binding.taskId);
	const requiredAssumptions = binding.requiredAssumptions ?? criterion?.assumptions ?? [];
	for (const declared of receipt.assumptions ?? []) {
		const current = currentAssumptions.find((assumption) => assumptionKey(assumption) === assumptionKey(declared));
		if (current === undefined) assumptionReasons.push(`load-bearing assumption ${assumptionKey(declared)} is unavailable`);
		else if (!sameAssumption(declared, current)) assumptionReasons.push(`load-bearing assumption ${assumptionKey(declared)} changed`);
	}
	for (const required of requiredAssumptions) {
		if (!(receipt.assumptions ?? []).some((declared) => assumptionKey(declared) === assumptionKey(required))) {
			assumptionReasons.push(`required load-bearing assumption ${assumptionKey(required)} was not declared`);
		}
	}

	for (const reference of receipt.evidence) {
		const error = artifactRefError(reference, binding.artifactRoots);
		if (error !== undefined) reasons.push(`${error}: ${reference}`);
	}
	for (const reference of receipt.changed) {
		const error = changedPathError(reference);
		if (error !== undefined) reasons.push(`${error}: ${reference}`);
	}
	for (const claim of receipt.tests) {
		if (claim.artifact === undefined) continue;
		const error = artifactRefError(claim.artifact, binding.artifactRoots);
		if (error !== undefined) reasons.push(`${error}: ${claim.artifact}`);
	}
	const failedPredicates = (receipt.predicates ?? []).filter((predicate) =>
		(predicate.phase === "verification" || predicate.phase === "acceptance") && !predicate.ok,
	);
	if (reasons.length > 0) return { status: "failed", reasons };
	if (failedPredicates.length > 0) return { status: "failed", reasons: [`acceptance/verification predicates failed: ${failedPredicates.map((predicate) => predicate.item).join(", ")}`] };
	if (receipt.version === 2 && (receipt.predicates?.length ?? 0) === 0) return { status: "unproved", reasons: ["version-2 receipt has no predicate evidence"] };
	if (assumptionReasons.length > 0) return { status: "unproved", reasons: assumptionReasons };

	if (receipt.aborted) return { status: "unproved", reasons: ["attempt was aborted"] };
	if (receipt.truncated) return { status: "unproved", reasons: ["attempt output was truncated"] };

	const passing = receipt.tests.filter((claim) => claim.outcome === "pass");
	const failing = receipt.tests.filter((claim) => claim.outcome === "fail");
	const unrun = receipt.tests.filter((claim) => claim.outcome === "not-run");

	if (failing.length > 0 && passing.length > 0 && receipt.exitCode === 0) {
		return {
			status: "contradicted",
			reasons: [`receipt claims both passing and failing verification: ${failing.map((claim) => claim.command).join(", ")}`],
		};
	}
	if (receipt.exitCode !== 0) {
		if (passing.length > 0) {
			return {
				status: "contradicted",
				reasons: [`exit code ${receipt.exitCode} contradicts claimed passing verification`],
			};
		}
		return { status: "failed", reasons: [`attempt exited ${receipt.exitCode}`] };
	}
	if (receipt.semanticResult !== undefined && (!receipt.semanticResult.verified || receipt.semanticResult.outcome === "uncertain")) {
		reasons.push("semantic result is unverified or uncertain");
	}
	if (failing.length > 0) {
		return { status: "failed", reasons: [`verification failed: ${failing.map((claim) => claim.command).join(", ")}`] };
	}

	if (receipt.cleanEnvironment !== true) {
		reasons.push(
			receipt.cleanEnvironment === false
				? "attempt did not run in a clean environment"
				: "clean-environment status is unknown",
		);
	}
	if (unrun.length > 0) reasons.push(`verification not run: ${unrun.map((claim) => claim.command).join(", ")}`);
	if (receipt.unresolved.length > 0) reasons.push(`unresolved: ${receipt.unresolved.join("; ")}`);
	if (passing.length > 0 && receipt.evidence.length === 0) {
		reasons.push("verification is claimed with no evidence reference");
	}
	if (receipt.tests.length === 0 && receipt.evidence.length === 0) {
		reasons.push("receipt carries neither verification nor evidence");
	}

	return reasons.length === 0 ? { status: "proven", reasons: [] } : { status: "unproved", reasons };
}

function taskProofCurrentIn(ledger: Ledger, task: Ledger["tasks"][number], visiting: Set<string>): boolean {
	if (task.state !== "DONE" || task.generation !== ledger.generation || visiting.has(task.id)) return false;
	visiting.add(task.id);
	const criterion = ledger.criteria.find((entry) => entry.id === task.criterionId);
	const receipt = task.attempts.at(-1)?.receipt;
	if (receipt === undefined) { visiting.delete(task.id); return false; }
	if (receipt.semanticResult !== undefined && (!receipt.semanticResult.verified || receipt.semanticResult.outcome === "uncertain")) {
		visiting.delete(task.id);
		return false;
	}
	const declared = receipt.assumptions ?? [];
	if (!(criterion?.assumptions ?? []).every((required) => declared.some((assumption) => assumptionKey(assumption) === assumptionKey(required)))) {
		visiting.delete(task.id);
		return false;
	}
	const current = declared.every((assumption) => {
		const expected = criterion?.assumptions?.find((candidate) => assumptionKey(candidate) === assumptionKey(assumption));
		if (expected === undefined || !sameAssumption(assumption, expected)) return false;
		if (assumption.kind !== "dependency-outcome") return true;
		const dependency = ledger.tasks.find((candidate) => candidate.id === assumption.taskId);
		if (dependency === undefined) return false;
		const proven = criterionProofCurrentIn(ledger, dependency.criterionId, visiting);
		return (assumption.value === "proven") === proven;
	});
	visiting.delete(task.id);
	return current;
}

function criterionProofCurrentIn(ledger: Ledger, criterionId: CriterionId, visiting: Set<string>): boolean {
	return ledger.tasks.some((task) => task.criterionId === criterionId && taskProofCurrentIn(ledger, task, visiting));
}

export function taskProofCurrent(ledger: Ledger, task: Ledger["tasks"][number]): boolean {
	return taskProofCurrentIn(ledger, task, new Set<string>());
}

export function criterionProven(ledger: Ledger, criterionId: CriterionId): boolean {
	return criterionProofCurrentIn(ledger, criterionId, new Set<string>());
}
/** Mandatory criteria still lacking current proof. */
export function unprovenMandatory(ledger: Ledger): readonly CriterionId[] {
	return ledger.criteria
		.filter((criterion) => criterion.mandatory && !criterionProven(ledger, criterion.id))
		.map((criterion) => criterion.id);
}

/**
 * Reject a receipt that arrives after the attempt it describes was superseded,
 * or that repeats one already recorded for the same attempt.
 */
export function receiptAcceptable(ledger: Ledger, receipt: EvidenceReceipt): string | undefined {
	if (receipt.generation !== ledger.generation) {
		return `receipt is for generation ${receipt.generation}; run is at ${ledger.generation}`;
	}
	for (const task of ledger.tasks) {
		for (const attempt of task.attempts) {
			if (attempt.id !== receipt.attemptId) continue;
			if (attempt.receipt !== undefined) return `attempt ${attempt.id} already has a recorded receipt`;
			if (attempt.state === "abandoned") return `attempt ${attempt.id} was abandoned before this receipt arrived`;
		}
	}
	return undefined;
}
