/**
 * Run convergence.
 *
 * Two different facts are easy to conflate and must not be:
 *
 * - CONVERGED: every mandatory acceptance criterion holds current valid proof.
 * - QUIESCENT: there is no currently authorized autonomous progress left, which
 *   is entirely compatible with being unconverged.
 *
 * An empty queue, an exhausted budget, and a returned worker are all compatible
 * with QUIESCENT and none of them is evidence of success, so nothing in this
 * module derives success from the absence of work.
 */

import { unprovenMandatory } from "./evidence.ts";
import type { CriterionId, Ledger, RunControl } from "./model.ts";

export interface RunVerdict {
	/** Control reflects the operator's state; the verdict never overrides a pause. */
	readonly control: RunControl;
	readonly converged: boolean;
	readonly quiescent: boolean;
	readonly provenMandatory: number;
	readonly activeMandatory: number;
	readonly blockedMandatory: number;
	readonly unknownMandatory: number;
	readonly totalMandatory: number;
	readonly remaining: readonly CriterionId[];
	readonly blockers: readonly string[];
	readonly plateau: boolean;
	/** The exact condition that would resume useful work, when there is one. */
	readonly resumption?: string;
}

const BLOCKED_PROGRESS_STATES: Record<string, true> = { BLOCKED: true, DEFERRED: true };
const BLOCKER_STATES: Record<string, true> = { BLOCKED: true, DEFERRED: true, ESCALATE: true };
const AUTHORIZED_STATES: Record<string, true> = { READY: true, RUNNING: true, VERIFY: true };

/**
 * Evaluate the run.
 *
 * Pure: it reads the ledger and decides nothing else, so the same ledger always
 * produces the same verdict and a test can pin the difference between
 * "unconverged but still working" and "unconverged and out of authorized work".
 */
export function evaluateRun(ledger: Ledger): RunVerdict {
	const remaining = unprovenMandatory(ledger);
	const totalMandatory = ledger.criteria.filter((criterion) => criterion.mandatory).length;
	const activeCriteria = new Set(ledger.tasks.filter((task) => AUTHORIZED_STATES[task.state] === true).map((task) => task.criterionId));
	const blockedCriteria = new Set(ledger.tasks.filter((task) => BLOCKED_PROGRESS_STATES[task.state] === true).map((task) => task.criterionId));
	const activeMandatory = remaining.filter((id) => activeCriteria.has(id)).length;
	const blockedMandatory = remaining.filter((id) => !activeCriteria.has(id) && blockedCriteria.has(id)).length;
	const unknownMandatory = remaining.length - activeMandatory - blockedMandatory;
	const converged = remaining.length === 0;
	const authorized = ledger.tasks.some((task) => AUTHORIZED_STATES[task.state] === true);

	const blockers: string[] = [];
	for (const task of ledger.tasks) {
		if (BLOCKER_STATES[task.state] !== true) continue;
		blockers.push(`${task.id} (${task.state}): ${task.decisionReason}`);
	}
	const plateau = ledger.noProgressAttempts >= 2;
	if (plateau) {
		blockers.push(
			`${ledger.noProgressAttempts} consecutive no-progress attempt(s) on the current line of work`,
		);
	}
	if (ledger.tasks.filter((task) => task.decision === "ADMIT").length >= ledger.goal.appetite.tasks && !converged) {
		blockers.push(`objective appetite of ${ledger.goal.appetite.tasks} admitted tasks is exhausted`);
	}

	let control: RunControl = ledger.control;
	if (ledger.control === "active") {
		if (converged) control = "converged";
		else if (!authorized) control = "quiescent";
	}

	let resumption: string | undefined;
	if (!converged) {
		if (plateau && ledger.replans >= 1) {
			resumption =
				"no bounded progress remains on this line of work: the plateau is diagnosed and the one materially different replan is used. " +
				"Resume with new evidence, a changed objective, or an explicit decision to stop.";
		} else if (!authorized) {
			resumption = `admit or advertise work for ${remaining.join(", ")}, or supply the missing authority named above`;
		} else {
			resumption = `finish the authorized work for ${remaining.join(", ")}`;
		}
	}

	return {
		control,
		converged,
		quiescent: control === "quiescent",
		provenMandatory: totalMandatory - remaining.length,
		activeMandatory,
		blockedMandatory,
		unknownMandatory,
		totalMandatory,
		remaining,
		blockers,
		plateau,
		resumption,
	};
}
