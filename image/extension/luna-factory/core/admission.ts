/**
 * Admission.
 *
 * Discovery creates candidates; it never creates authority. Every candidate —
 * whether it came from the initial plan, a worker's NEXT, a review finding, or
 * the owner's own idea — passes the same executable rule before any
 * implementation, delegated or owner-local.
 *
 * The checks that can be decided mechanically are decided here. Semantic
 * necessity is a recorded Luna judgment (`Candidate.necessity`); code does not
 * pretend to be that oracle, and the admission reason always names which kind of
 * test produced the decision.
 */

import { criterionProven } from "./evidence.ts";
import { findCriterion, findTask } from "./model.ts";
import type { AdmissionDecision, Candidate, Ledger, TaskId, TaskRecord } from "./model.ts";

export interface Admission {
	readonly decision: AdmissionDecision;
	readonly reason: string;
}

const ACTIVE_STATES: Record<string, true> = { READY: true, RUNNING: true, VERIFY: true };

function admittedTasks(ledger: Ledger): TaskRecord[] {
	return ledger.tasks.filter((task) => task.decision === "ADMIT");
}

/** A dependency is satisfied only when its own work is proven, not merely returned. */
function dependencySatisfied(ledger: Ledger, id: TaskId): boolean {
	const task = findTask(ledger, id);
	return task !== undefined && task.state === "DONE" && task.generation === ledger.generation;
}

/**
 * Detect a cycle through the candidate's dependencies.
 *
 * A candidate naming an unknown dependency is not a cycle; it is a deferral, and
 * the two are reported differently so the owner can tell a typo from a tangle.
 */
function reachesSelf(ledger: Ledger, candidate: Candidate): boolean {
	const seen = new Set<TaskId>();
	const pending: TaskId[] = [...candidate.deps];
	while (pending.length > 0) {
		const current = pending.pop()!;
		if (current === candidate.taskId) return true;
		if (seen.has(current)) continue;
		seen.add(current);
		const task = findTask(ledger, current);
		if (task === undefined) continue;
		pending.push(...task.deps);
	}
	return false;
}

/**
 * The admission rule.
 *
 * Checked in a fixed order so the reported reason is the first real obstacle
 * rather than whichever check happened to run last.
 */
export function admit(ledger: Ledger, candidate: Candidate): Admission {
	if (candidate.generation !== ledger.generation) {
		return {
			decision: "ESCALATE",
			reason: `candidate targets generation ${candidate.generation}; the run is at ${ledger.generation} and only the owner may change the objective`,
		};
	}
	if (findTask(ledger, candidate.taskId) !== undefined) {
		return { decision: "DISMISS", reason: `task ${candidate.taskId} is already in the ledger` };
	}

	const criterion = findCriterion(ledger, candidate.criterionId);
	if (criterion === undefined) {
		return {
			decision: "ESCALATE",
			reason: `candidate names unknown criterion ${candidate.criterionId}; a task that proves nothing is not admissible`,
		};
	}
	if (criterionProven(ledger, criterion.id)) {
		return { decision: "DISMISS", reason: `criterion ${criterion.id} already holds current proof` };
	}
	if (ledger.criteria.filter((entry) => entry.mandatory).every((entry) => criterionProven(ledger, entry.id))) {
		return { decision: "DISMISS", reason: "objective is already converged; no successor work is authorized" };
	}
	if (ledger.control !== "active") {
		return { decision: "DEFER", reason: `run is ${ledger.control}; admission is closed until the run is active` };
	}

	if (reachesSelf(ledger, candidate)) {
		return { decision: "ESCALATE", reason: `candidate depends on itself through ${candidate.deps.join(" → ")}` };
	}

	const unknownDep = candidate.deps.find((dep) => findTask(ledger, dep) === undefined);
	if (unknownDep !== undefined) {
		return { decision: "DEFER", reason: `dependency ${unknownDep} is not in the ledger` };
	}
	const unmetDep = candidate.deps.find((dep) => !dependencySatisfied(ledger, dep));
	if (unmetDep !== undefined) {
		const task = findTask(ledger, unmetDep)!;
		return { decision: "DEFER", reason: `dependency ${unmetDep} is ${task.state}, not proven` };
	}

	const permitted = ledger.goal.permittedEffects;
	const allowed = permitted.includes(candidate.effect) || (candidate.effect === "read" && permitted.length === 0);
	if (!allowed) {
		return {
			decision: "ESCALATE",
			reason: `objective does not permit '${candidate.effect}' effects`,
		};
	}

	if (candidate.effect === "write") {
		const conflicting = ledger.tasks.find(
			(task) => task.effect === "write" && task.criterionId !== candidate.criterionId && ACTIVE_STATES[task.state] === true,
		);
		if (conflicting !== undefined) {
			return {
				decision: "DEFER",
				reason: `conflicting writer ${conflicting.id} holds an active '${conflicting.state}' write on this subject`,
			};
		}
	}

	if (admittedTasks(ledger).length >= ledger.goal.appetite.tasks) {
		return {
			decision: "DEFER",
			reason: `objective appetite of ${ledger.goal.appetite.tasks} admitted tasks is exhausted`,
		};
	}

	return { decision: "ADMIT", reason: `necessary for unproven criterion ${criterion.id}` };
}

/**
 * Appetite left on one task's lineage.
 *
 * Explicit user limits are carried in the goal, so a repair that exceeds them is
 * reported as a blocker rather than silently retried.
 */
export function attemptsRemaining(ledger: Ledger, task: TaskRecord): number {
	return Math.max(0, ledger.goal.appetite.attemptsPerTask - task.attempts.length);
}
