/**
 * Evidence reconciliation.
 *
 * A parsed receipt proves a shape. This module decides whether the receipt is
 * evidence *about the thing being certified*, which is a different question and
 * the one the protocol is built around. Everything here is pure so the
 * adversarial cases in the regression matrix can be driven directly.
 */

import { artifactRefError, changedPathError } from "./schema.ts";
import type { CriterionId, EvidenceReceipt, Ledger, Subject, TaskId } from "./model.ts";

export type EvidenceStatus = "proven" | "unproved" | "failed" | "contradicted";

export interface Reconciliation {
	readonly status: EvidenceStatus;
	readonly reasons: readonly string[];
}

export interface SubjectBinding {
	readonly taskId: TaskId;
	readonly attemptId: string;
	readonly subject: Subject;
	/** Roots the run owns. A reference outside them is not followed. */
	readonly artifactRoots: readonly string[];
}

function sameSubject(left: Subject, right: Subject): boolean {
	return left.repo === right.repo && left.base === right.base && left.head === right.head;
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
	if (reasons.length > 0) return { status: "failed", reasons };

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

/**
 * Whether a criterion currently holds valid proof.
 *
 * Only a DONE task certifies, and only at the run's current generation: a git
 * SHA and a semantic goal are separate identities, so an older generation's
 * proof never certifies a new one.
 */
export function criterionProven(ledger: Ledger, criterionId: CriterionId): boolean {
	return ledger.tasks.some(
		(task) => task.criterionId === criterionId && task.state === "DONE" && task.generation === ledger.generation,
	);
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
