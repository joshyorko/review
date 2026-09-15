/**
 * The dispatch adapter.
 *
 * Factory's one enforced boundary is the work it emits. This module builds that
 * work and refuses to build it for anything the ledger has not admitted, for a
 * paused run, or for an execution path whose coverage the evidence does not
 * support.
 *
 * The refusal is the point: an adapter that cannot enforce its boundary is
 * reported as unsupported and kept disabled rather than routed through quietly,
 * because a silently unenforced path is worse than a missing feature — it looks
 * like the guarantee the objective asked for.
 */

import { coverageFor } from "./capabilities.ts";
import type { Ledger, TaskRecord } from "../core/model.ts";
import { findTask } from "../core/model.ts";
import { evaluateRun } from "../core/convergence.ts";

export type DispatchPlan =
	| { readonly ok: true; readonly prompt: string }
	| { readonly ok: false; readonly error: string };

/** Stable marker copied into the native task assignment before OMP is invoked. */
export const DISPATCH_MARKER = "LUNA_FACTORY_DISPATCH";

export function dispatchMarker(taskId: string, attemptId: string, generation: string): string {
	return `${DISPATCH_MARKER} task=${taskId} attempt=${attemptId} generation=${generation}`;
}

/** The receipt contract every dispatched worker is asked to return. */
export const RECEIPT_CONTRACT = [
	"Return one structured receipt with exactly these keys:",
	"  version (1), taskId, attemptId, generation, subject {repo, base, head}, result,",
	"  changed[], evidence[], tests[{command, outcome: pass|fail|not-run, artifact?}],",
	"  cleanEnvironment (true|false|unknown), unresolved[], next, confidence (low|medium|high),",
	"  routing {requested?, effective?, effort?, verified}, exitCode, aborted, truncated.",
	"Use the task and attempt ids exactly as given; do not assign yourself another identity.",
	"Reference artifacts only inside the run's artifact roots.",
].join("\n");

/**
 * Build the bounded prompt for an admitted task.
 *
 * Identity is stamped by the adapter from the ledger rather than accepted from
 * the caller, so a worker can never be handed a task/attempt pairing that does
 * not exist in the ledger.
 */
export function buildDispatchPrompt(
	ledger: Ledger,
	taskId: TaskRecord["id"],
	attemptId: string,
	path = "factory.admitted-dispatch",
): DispatchPlan {
	const coverage = coverageFor(path);
	if (coverage === undefined) return { ok: false, error: `unknown execution path '${path}'` };
	if (coverage.status !== "enforced") {
		return {
			ok: false,
			error: `execution path '${path}' is ${coverage.status}, not enforced: ${coverage.reason}`,
		};
	}

	const task = findTask(ledger, taskId);
	if (task === undefined) return { ok: false, error: `unknown task ${taskId}` };
	if (ledger.control !== "active") {
		return { ok: false, error: `run is ${ledger.control}; admission is closed and admitted work is only drained` };
	}
	if (task.state !== "RUNNING") {
		return {
			ok: false,
			error:
				task.state === "READY"
					? `task ${task.id} is READY; start_attempt must persist an attempt before dispatch`
					: `task ${task.id} is ${task.state}; only an admitted RUNNING task may be dispatched`,
		};
	}
	const attempt = task.attempts.find((candidate) => candidate.id === attemptId);
	if (attempt === undefined) {
		return { ok: false, error: `attempt ${attemptId} is not recorded on ${task.id}; persist the intent before the effect` };
	}
	if (attempt.state !== "started") {
		return { ok: false, error: `attempt ${attemptId} is ${attempt.state} and cannot be dispatched` };
	}
	if (
		attempt.subject.repo !== ledger.subject.repo ||
		attempt.subject.base !== ledger.subject.base ||
		attempt.subject.head !== ledger.subject.head
	) {
		return { ok: false, error: `attempt ${attemptId} is bound to a stale subject and cannot be dispatched` };
	}

	const criterion = ledger.criteria.find((candidate) => candidate.id === task.criterionId);
	const verdict = evaluateRun(ledger);
	const subject = attempt.subject;
	const lines = [
		`Luna Factory task ${task.id} (attempt ${attempt.id}, lineage ${attempt.lineage}) — ${task.title}`,
		`generation ${ledger.generation} · revision ${ledger.revision} · subject ${subject.repo}@${subject.head ?? subject.base}`,
		`criterion ${task.criterionId}${criterion ? `: ${criterion.statement}` : ""} (unproven)`,
		`permitted effect: ${task.effect}`,
		`finish authority: ${ledger.goal.finishAuthority}`,
		`non-goals: ${ledger.goal.nonGoals.length > 0 ? ledger.goal.nonGoals.join("; ") : "none recorded"}`,
		`run status: ${verdict.control} · ${verdict.provenMandatory}/${verdict.totalMandatory} mandatory criteria proven`,
		`native task binding: ${dispatchMarker(task.id, attempt.id, ledger.generation)}`,
		"",
		"Work only this task. Do not create successor tasks or missions.",
		"Do not approve, merge, publish, or push to a protected branch.",
		"",
		RECEIPT_CONTRACT,
	];
	return { ok: true, prompt: lines.join("\n") };
}
