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

import { admit, attemptsRemaining } from "./admission.ts";
import { receiptAcceptable, reconcileReceipt } from "./evidence.ts";
import type {
	Attempt,
	Candidate,
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

function hasInFlightAttempt(ledger: Ledger): boolean {
	return ledger.tasks.some((task) => task.attempts.some((attempt) => attempt.state === "started"));
}

function candidateForTask(task: TaskRecord, generation: Ledger["generation"]): Candidate {
	return {
		taskId: task.id,
		generation,
		criterionId: task.criterionId,
		title: task.title,
		deps: task.deps,
		effect: task.effect,
		owner: task.owner,
		necessity: task.decisionReason,
	};
}

/** Re-run the same admission rule without treating the task being refreshed as a duplicate. */
function admissionForExisting(ledger: Ledger, task: TaskRecord) {
	const candidate = candidateForTask(task, ledger.generation);
	const withoutTask = { ...ledger, tasks: ledger.tasks.filter((entry) => entry.id !== task.id) };
	return admit(withoutTask, candidate);
}

function refreshDeferred(ledger: Ledger): Ledger {
	let next = ledger;
	let changed = true;
	while (changed) {
		changed = false;
		for (const task of next.tasks) {
			if (task.generation !== next.generation || (task.state !== "DEFERRED" && task.state !== "BLOCKED" && task.state !== "ESCALATE")) continue;
			const verdict = admissionForExisting(next, task);
			const state: TaskState = verdict.decision === "ADMIT" ? "READY" : verdict.decision === "ESCALATE" ? "ESCALATE" : "DEFERRED";
			if (task.decision === verdict.decision && task.decisionReason === verdict.reason && task.state === state) continue;
			next = replaceTask(next, task.id, (current) => ({
				...current,
				state,
				decision: verdict.decision,
				decisionReason: verdict.reason,
			}));
			changed = true;
		}
	}
	return next;
}

function settleDraining(ledger: Ledger): Ledger {
	return ledger.control === "draining" && !hasInFlightAttempt(ledger) ? { ...ledger, control: "paused" } : ledger;
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
			if (ledger.control !== "active") {
				return { ok: false, error: `run is ${ledger.control}; admission is closed until the run is active` };
			}
			const task = findTask(ledger, event.taskId);
			if (task === undefined) return { ok: false, error: `unknown task ${event.taskId}` };
			if (task.attempts.some((attempt) => attempt.id === event.attemptId)) {
				return { ok: false, error: `attempt ${event.attemptId} already exists on ${task.id}` };
			}
			if (subjectChanged(event.subject, ledger.subject)) {
				return {
					ok: false,
					error: `attempt subject ${event.subject.repo}@${event.subject.head ?? event.subject.base} is not the current run subject`,
				};
			}
			if (task.state !== "READY" && task.state !== "VERIFY") {
				return { ok: false, error: `task ${task.id} is ${task.state}; only READY or VERIFY tasks may start` };
			}
			if (task.decision !== "ADMIT") {
				return { ok: false, error: `task ${task.id} has no ADMIT decision` };
			}
			if (attemptsRemaining(ledger, task) <= 0) {
				return { ok: false, error: `task ${task.id} has exhausted its attempt appetite` };
			}
			if (task.state === "VERIFY") {
				const previous = lastReturned(task);
				if (previous?.receipt === undefined) {
					return { ok: false, error: `task ${task.id} is VERIFY without a returned receipt to repair` };
				}
				const reconciliation = reconcileReceipt(ledger, previous.receipt, {
					taskId: task.id,
					attemptId: previous.id,
					subject: ledger.subject,
					artifactRoots: context.artifactRoots,
				});
				if (reconciliation.status === "proven" && (task.effect !== "write" || previous.integrated)) {
					return { ok: false, error: `task ${task.id} already has current proven evidence; finish it before another attempt` };
				}
			}
			const attempt: Attempt = {
				id: event.attemptId,
				lineage: task.attempts.length + 1,
				taskId: task.id,
				generation: ledger.generation,
				subject: event.subject,
				state: "started",
				nativeJobIds: [],
				nativeResultIds: [],
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
			const resultIds = event.resultIds ?? [];
			if (attempt.nativeJobIds.includes(event.jobId) && resultIds.every((id) => attempt.nativeResultIds.includes(id))) {
				return { ok: true, ledger };
			}
			return bump(
				replaceAttempt(ledger, task.id, attempt.id, (current) => ({
					...current,
					nativeJobIds: current.nativeJobIds.includes(event.jobId) ? current.nativeJobIds : [...current.nativeJobIds, event.jobId as NativeJobId],
					nativeResultIds: [...current.nativeResultIds, ...resultIds.filter((id) => !current.nativeResultIds.includes(id))],
				})),
			);
		}

		case "record_native_result": {
			const task = findTask(ledger, event.taskId);
			const attempt = task?.attempts.find((candidate) => candidate.id === event.attemptId);
			if (task === undefined || attempt === undefined) {
				return { ok: false, error: `unknown attempt ${event.taskId}#${event.attemptId}` };
			}
			if (attempt.nativeResultIds.includes(event.resultId)) return { ok: true, ledger };
			return bump(
				replaceAttempt(ledger, task.id, attempt.id, (current) => ({
					...current,
					nativeResultIds: [...current.nativeResultIds, event.resultId],
				})),
			);
		}

		case "reconcile_attempt": {
			const task = findTask(ledger, event.taskId);
			const attempt = task?.attempts.find((candidate) => candidate.id === event.attemptId);
			if (task === undefined || attempt === undefined) {
				return { ok: false, error: `unknown attempt ${event.taskId}#${event.attemptId}` };
			}
			if (event.reason.trim().length === 0) return { ok: false, error: "attempt reconciliation must name the observed outcome" };
			if (attempt.state !== "started") {
				return attempt.state === "abandoned"
					? { ok: true, ledger }
					: { ok: false, error: `attempt ${attempt.id} already returned and cannot be reconciled as ${event.outcome}` };
			}
			const abandoned = replaceAttempt(ledger, task.id, attempt.id, (current) => ({ ...current, state: "abandoned" }));
			const next = replaceTask(abandoned, task.id, (current) =>
				event.outcome === "unknown"
					? {
							...current,
							state: "ESCALATE" as TaskState,
							decision: "ESCALATE" as const,
							decisionReason: `attempt ${attempt.id} liveness is unknown: ${event.reason}`,
						}
					: {
							...current,
							state: "READY" as TaskState,
							decision: "ADMIT" as const,
							decisionReason: `attempt ${attempt.id} was reconciled as abandoned: ${event.reason}`,
						},
			);
			return bump(settleDraining(next));
		}

		case "record_receipt": {
			const task = findTask(ledger, event.taskId);
			if (task === undefined) return { ok: false, error: `unknown task ${event.taskId}` };
			const attempt = task.attempts.find((candidate) => candidate.id === event.attemptId);
			if (attempt === undefined) return { ok: false, error: `unknown attempt ${event.attemptId}` };

			const unacceptable = receiptAcceptable(ledger, event.receipt);
			if (unacceptable !== undefined) return { ok: false, error: unacceptable };
			if (task.state !== "RUNNING" || attempt.state !== "started") {
				return { ok: false, error: `attempt ${attempt.id} is not an active dispatched attempt` };
			}

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
			return bump(settleDraining({
				...next,
				tasks: next.tasks.map((candidate) =>
					candidate.id === task.id ? { ...candidate, state: "VERIFY" as TaskState } : candidate,
				),
				noProgressAttempts: progressed ? 0 : ledger.noProgressAttempts + 1,
			}));
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
			if (task.effect !== "write") return { ok: false, error: `read task ${task.id} has no write integration to apply` };
			if (task.state !== "VERIFY") return { ok: false, error: `task ${task.id} is ${task.state}; only a returned task can be integrated` };
			if (subjectChanged(attempt.subject, ledger.subject)) {
				return { ok: false, error: `attempt ${attempt.id} is bound to a stale subject and cannot be integrated` };
			}
			if (event.subject.repo !== attempt.subject.repo) {
				return { ok: false, error: `integration subject ${event.subject.repo} is not the attempt's repository` };
			}
			if (event.subject.base !== attempt.subject.base) {
				return { ok: false, error: `integration subject ${event.subject.base} is not the attempt's base` };
			}
			const reconciliation = reconcileReceipt(ledger, attempt.receipt, {
				taskId: task.id,
				attemptId: attempt.id,
				subject: attempt.subject,
				artifactRoots: context.artifactRoots,
			});
			if (reconciliation.status !== "proven") {
				return { ok: false, error: `attempt ${attempt.id} is ${reconciliation.status}, not proven: ${reconciliation.reasons.join("; ")}` };
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
			return bump({ ...refreshDeferred(next), noProgressAttempts: 0 });
		}

		case "reopen_task": {
			const task = findTask(ledger, event.taskId);
			if (task === undefined) return { ok: false, error: `unknown task ${event.taskId}` };
			if (task.state !== "DONE") return { ok: false, error: `task ${task.id} is ${task.state}, not DONE` };
			if (event.reason.trim().length === 0) {
				return { ok: false, error: "a reopen must name the new evidence that justifies it" };
			}
			return bump(
				replaceTask(ledger, task.id, (current) => ({
					...current,
					// Reopening invalidates the completed state while preserving the
					// old receipt for audit. READY lets the owner start a fresh
					// attempt; VERIFY is reserved for a worker that has just returned.
					state: "READY" as TaskState,
					decisionReason: `reopened after explicit owner evidence: ${event.reason.trim()}`,
				})),
			);
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

		case "reevaluate_candidate": {
			const task = findTask(ledger, event.taskId);
			if (task === undefined) return { ok: false, error: `unknown task ${event.taskId}` };
			if (task.generation !== ledger.generation) return { ok: false, error: `task ${task.id} belongs to generation ${task.generation}, not ${ledger.generation}` };
			if (task.state !== "CANDIDATE" && task.state !== "DEFERRED" && task.state !== "BLOCKED" && task.state !== "ESCALATE") {
				return { ok: false, error: `task ${task.id} is ${task.state}; only candidates may be reevaluated` };
			}
			const verdict = admissionForExisting(ledger, task);
			const state: TaskState = verdict.decision === "ADMIT" ? "READY" : verdict.decision === "ESCALATE" ? "ESCALATE" : "DEFERRED";
			return bump(replaceTask(ledger, task.id, (current) => ({ ...current, state, decision: verdict.decision, decisionReason: verdict.reason })));
		}

		case "set_control": {
			if (event.control === "active") {
				if (ledger.control === "interrupted" && hasInFlightAttempt(ledger)) {
					// Resuming an interrupted run is reconciliation, not a status write.
					return { ok: false, error: "an interrupted run must be reconciled before it is active again" };
				}
				if ((ledger.control === "paused" || ledger.control === "draining") && hasInFlightAttempt(ledger)) {
					return { ok: false, error: "a paused run must drain its admitted attempts before it is active again" };
				}
			}
			const next = { ...ledger, control: event.control };
			return bump(event.control === "active" ? refreshDeferred(next) : next);
		}

		case "new_generation": {
			if (event.generation === ledger.generation) {
				return { ok: false, error: `generation ${event.generation} is already current` };
			}
			if (hasInFlightAttempt(ledger)) {
				return { ok: false, error: "in-flight attempts must be reconciled before changing the goal generation" };
			}
			// In-flight work is reconciled rather than erased: attempts and lineage
			// survive, but nothing carries authority into the new generation.
			const reconciled = ledger.tasks.map((task) => ({
				...task,
				// The task is re-advertised under the new goal generation, while its
				// attempts keep their original generation identities for audit and
				// retry lineage.
				generation: event.generation,
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
