/**
 * The pure reducer.
 *
 * Every mutation is an event carrying the revision it was computed against, so a
 * stale writer is rejected instead of overwriting a newer decision. Nothing here
 * touches a host, a clock, or a model: the whole state machine is exercised by
 * driving events in a test.
 *
 * Two rules are load-bearing and easy to lose:
 *
 * - A returned worker moves to VERIFY. Only `finish_task` against a receipt that
 *   reconciles as proven at the *current* subject reaches DONE, so a worker can
 *   never certify itself.
 * - Integration moves the certified subject, which invalidates proof taken
 *   against the old head. That demotion is what stops a stale green run from
 *   certifying an integrated change it never saw.
 */

import { admit } from "./admission.ts";
import { receiptAcceptable, reconcileReceipt } from "./evidence.ts";
import type {
	Attempt,
	Ledger,
	LedgerEvent,
	NativeJobId,
	ReduceResult,
	Subject,
	TaskId,
	TaskRecord,
	TaskState,
} from "./model.ts";
import { findTask } from "./model.ts";

export interface ReduceContext {
	/** Roots the run owns; artifact references outside them are rejected. */
	readonly artifactRoots: readonly string[];
}

function bump(ledger: Ledger): ReduceResult {
	return { ok: true, ledger: { ...ledger, revision: ledger.revision + 1 } };
}

function replaceTask(ledger: Ledger, id: TaskId, update: (task: TaskRecord) => TaskRecord): Ledger {
	return { ...ledger, tasks: ledger.tasks.map((task) => (task.id === id ? update(task) : task)) };
}

function replaceAttempt(ledger: Ledger, id: TaskId, attemptId: string, update: (attempt: Attempt) => Attempt): Ledger {
	return replaceTask(ledger, id, (task) => ({
		...task,
		attempts: task.attempts.map((attempt) => (attempt.id === attemptId ? update(attempt) : attempt)),
	}));
}

/** The last attempt that actually reported back, which is what a verdict is about. */
function lastReturned(task: TaskRecord): Attempt | undefined {
	return [...task.attempts].reverse().find((attempt) => attempt.state === "returned");
}

function subjectChanged(from: Subject, to: Subject): boolean {
	return from.repo !== to.repo || from.base !== to.base || from.head !== to.head;
}

export function reduce(ledger: Ledger, event: LedgerEvent, context: ReduceContext): ReduceResult {
	if (event.expectedRevision !== ledger.revision) {
		return {
			ok: false,
			error: `stale revision: event was computed against ${event.expectedRevision}, ledger is at ${ledger.revision}`,
		};
	}

	switch (event.kind) {
		case "record_candidate": {
			const verdict = admit(ledger, event.candidate);
			// A dismissed candidate tracks nothing: it either duplicates existing
			// work or is already proven. `admit` remains the explainable rule.
			if (verdict.decision === "DISMISS") return { ok: true, ledger };
			const state: TaskState = verdict.decision === "ADMIT" ? "READY" : verdict.decision === "DEFER" ? "DEFERRED" : "ESCALATE";
			const task: TaskRecord = {
				id: event.candidate.taskId,
				generation: event.candidate.generation,
				criterionId: event.candidate.criterionId,
				title: event.candidate.title,
				deps: event.candidate.deps,
				effect: event.candidate.effect,
				owner: event.candidate.owner,
				state,
				attempts: [],
				decision: verdict.decision,
				decisionReason: verdict.reason,
			};
			return bump({ ...ledger, tasks: [...ledger.tasks, task] });
		}

		case "start_attempt": {
			const task = findTask(ledger, event.taskId);
			if (task === undefined) return { ok: false, error: `unknown task ${event.taskId}` };
			if (task.state !== "READY") {
				return { ok: false, error: `task ${task.id} is ${task.state}; only READY tasks may start` };
			}
			if (task.attempts.some((attempt) => attempt.id === event.attemptId)) {
				return { ok: false, error: `attempt ${event.attemptId} already exists on ${task.id}` };
			}
			const attempt: Attempt = {
				id: event.attemptId,
				lineage: task.attempts.length + 1,
				taskId: task.id,
				generation: ledger.generation,
				subject: event.subject,
				state: "started",
				nativeJobIds: [],
				integrated: false,
			};
			return bump(replaceTask(ledger, task.id, (current) => ({ ...current, state: "RUNNING", attempts: [...current.attempts, attempt] })));
		}

		case "record_native_job": {
			const task = findTask(ledger, event.taskId);
			const attempt = task?.attempts.find((candidate) => candidate.id === event.attemptId);
			if (task === undefined || attempt === undefined) {
				return { ok: false, error: `unknown attempt ${event.taskId}#${event.attemptId}` };
			}
			if (attempt.nativeJobIds.includes(event.jobId)) return { ok: true, ledger };
			return bump(
				replaceAttempt(ledger, task.id, attempt.id, (current) => ({
					...current,
					nativeJobIds: [...current.nativeJobIds, event.jobId as NativeJobId],
				})),
			);
		}

		case "record_receipt": {
			const task = findTask(ledger, event.taskId);
			if (task === undefined) return { ok: false, error: `unknown task ${event.taskId}` };
			const attempt = task.attempts.find((candidate) => candidate.id === event.attemptId);
			if (attempt === undefined) return { ok: false, error: `unknown attempt ${event.attemptId}` };

			const unacceptable = receiptAcceptable(ledger, event.receipt);
			if (unacceptable !== undefined) return { ok: false, error: unacceptable };

			const authorized = attempt.subject;
			const superseded = subjectChanged(authorized, ledger.subject);
			const reconciliation = superseded
				? { status: "unproved" as const, reasons: ["attempt was authorized for a subject the run has since moved past"] }
				: reconcileReceipt(ledger, event.receipt, {
						taskId: task.id,
						attemptId: attempt.id,
						subject: authorized,
						artifactRoots: context.artifactRoots,
					});

			const progressed = reconciliation.status === "proven";
			const next = replaceAttempt(ledger, task.id, attempt.id, (current) => ({
				...current,
				state: "returned",
				receipt: event.receipt,
			}));
			return bump({
				...next,
				tasks: next.tasks.map((candidate) =>
					candidate.id === task.id ? { ...candidate, state: "VERIFY" as TaskState } : candidate,
				),
				noProgressAttempts: progressed ? 0 : ledger.noProgressAttempts + 1,
			});
		}

		case "integrate_attempt": {
			const task = findTask(ledger, event.taskId);
			const attempt = task?.attempts.find((candidate) => candidate.id === event.attemptId);
			if (task === undefined || attempt === undefined) {
				return { ok: false, error: `unknown attempt ${event.taskId}#${event.attemptId}` };
			}
			if (attempt.receipt === undefined) {
				return { ok: false, error: `attempt ${attempt.id} has no receipt to integrate` };
			}
			if (event.subject.repo !== attempt.subject.repo) {
				return { ok: false, error: `integration subject ${event.subject.repo} is not the attempt's repository` };
			}

			const integrated = replaceAttempt(ledger, task.id, attempt.id, (current) => ({ ...current, integrated: true }));
			// Proof is about a head. Moving the head leaves earlier proof stale, so
			// every task certified at the old subject returns to VERIFY.
			const demoted = integrated.tasks.map((candidate) => {
				if (candidate.state !== "DONE") return candidate;
				const proof = lastReturned(candidate);
				if (proof === undefined || !subjectChanged(proof.subject, event.subject)) return candidate;
				return { ...candidate, state: "VERIFY" as TaskState };
			});
			return bump({ ...integrated, subject: event.subject, tasks: demoted });
		}

		case "finish_task": {
			const task = findTask(ledger, event.taskId);
			if (task === undefined) return { ok: false, error: `unknown task ${event.taskId}` };
			if (task.state !== "VERIFY") {
				return { ok: false, error: `task ${task.id} is ${task.state}; only a returned attempt can complete` };
			}
			if (task.criterionId !== event.criterionId) {
				return {
					ok: false,
					error: `task ${task.id} proves criterion ${task.criterionId}, not ${event.criterionId}`,
				};
			}
			const attempt = lastReturned(task);
			if (attempt?.receipt === undefined) return { ok: false, error: `task ${task.id} has no receipt to certify` };
			if (task.effect === "write" && !attempt.integrated) {
				return { ok: false, error: `write task ${task.id} must be integrated before it can complete` };
			}
			if (subjectChanged(attempt.subject, ledger.subject)) {
				return { ok: false, error: `proof for ${task.id} is at an older subject; reverify before completing` };
			}
			const reconciliation = reconcileReceipt(ledger, attempt.receipt, {
				taskId: task.id,
				attemptId: attempt.id,
				subject: ledger.subject,
				artifactRoots: context.artifactRoots,
			});
			if (reconciliation.status !== "proven") {
				return { ok: false, error: `evidence is ${reconciliation.status}: ${reconciliation.reasons.join("; ")}` };
			}
			const next = replaceTask(ledger, task.id, (current) => ({ ...current, state: "DONE" as TaskState }));
			return bump({ ...next, noProgressAttempts: 0 });
		}

		case "reopen_task": {
			const task = findTask(ledger, event.taskId);
			if (task === undefined) return { ok: false, error: `unknown task ${event.taskId}` };
			if (task.state !== "DONE") return { ok: false, error: `task ${task.id} is ${task.state}, not DONE` };
			if (event.reason.trim().length === 0) {
				return { ok: false, error: "a reopen must name the new evidence that justifies it" };
			}
			return bump(replaceTask(ledger, task.id, (current) => ({ ...current, state: "VERIFY" as TaskState })));
		}

		case "use_replan": {
			const task = findTask(ledger, event.taskId);
			if (task === undefined) return { ok: false, error: `unknown task ${event.taskId}` };
			if (ledger.noProgressAttempts < 2) {
				return { ok: false, error: `task ${task.id} has ${ledger.noProgressAttempts} no-progress attempt(s); replan is not diagnosed` };
			}
			if (ledger.replans >= 1) {
				return { ok: false, error: "the one bounded replan for this goal has already been used" };
			}
			// The plateau count survives the replan: a new approach that also stalls
			// must diagnose on its own second attempt, not start the count over.
			const reopened = replaceTask(ledger, task.id, (current) => ({ ...current, state: "READY" as TaskState }));
			return bump({ ...reopened, replans: ledger.replans + 1 });
		}

		case "set_control": {
			if (event.control === "active" && ledger.control === "interrupted") {
				// Resuming an interrupted run is reconciliation, not a status write.
				return { ok: false, error: "an interrupted run must be reconciled before it is active again" };
			}
			return bump({ ...ledger, control: event.control });
		}

		case "new_generation": {
			if (event.generation === ledger.generation) {
				return { ok: false, error: `generation ${event.generation} is already current` };
			}
			// In-flight work is reconciled rather than erased: attempts and lineage
			// survive, but nothing carries authority into the new generation.
			const reconciled = ledger.tasks.map((task) => ({
				...task,
				state: "CANDIDATE" as TaskState,
				decision: "DEFER" as const,
				decisionReason: `awaiting advertisement against ${event.generation}`,
			}));
			return bump({
				...ledger,
				generation: event.generation,
				goal: event.goal,
				criteria: event.criteria,
				subject: ledger.subject,
				tasks: reconciled,
				control: "active",
				noProgressAttempts: ledger.noProgressAttempts,
			});
		}
	}
}
