/**
 * Luna Factory ledger vocabulary.
 *
 * The protocol this package implements asks for admission, evidence binding,
 * repair lineage, and completion to be decided by code instead of conversational
 * memory. That is only possible if those decisions are plain data plus pure
 * functions, so this module carries no host, no terminal, and no model.
 *
 * Identity is branded rather than a bare `string` on purpose: a worker receipt
 * is untrusted input, and the failure this package exists to prevent is a
 * receipt certifying a task, attempt, generation, or subject that is not the one
 * it was produced for. Brands make those mix-ups a type error instead of a
 * ledger mutation.
 */

export type RunId = string & { readonly __identity: "RunId" };
export type TaskId = string & { readonly __identity: "TaskId" };
export type AttemptId = string & { readonly __identity: "AttemptId" };
export type CriterionId = string & { readonly __identity: "CriterionId" };
export type GenerationId = string & { readonly __identity: "GenerationId" };
export type NativeAgentId = string & { readonly __identity: "NativeAgentId" };

/**
 * Task lifecycle.
 *
 * A returned worker moves to VERIFY, never to DONE: proof and the judgment of
 * that proof are different acts.
 */
export type TaskState =
	| "CANDIDATE"
	| "READY"
	| "BLOCKED"
	| "DEFERRED"
	| "ESCALATE"
	| "RUNNING"
	| "VERIFY"
	| "DONE";

/**
 * Run-level control.
 *
 * Kept separate from `TaskState` because every control condition would otherwise
 * become another task state and the reducer would have to reason about
 * combinations that never happen.
 */
export type RunControl = "active" | "paused" | "draining" | "interrupted" | "quiescent" | "converged";

/** The only effects a candidate may request. Nothing here grants merge or deploy authority. */
export type Effect = "read" | "write";

/** Safe default when an objective does not grant an external finish action. */
export const DEFAULT_FINISH_AUTHORITY =
	"report the verified result; no merge, deploy, publish, or protected-branch authority";

export type AdmissionDecision = "ADMIT" | "DEFER" | "DISMISS" | "ESCALATE";

export interface Criterion {
	readonly id: CriterionId;
	readonly statement: string;
	/** Mandatory criteria gate CONVERGED; optional ones never manufacture successor work. */
	readonly mandatory: boolean;
}

/** The exact thing evidence is about. A git SHA and a semantic goal are different identities. */
export interface Subject {
	readonly repo: string;
	readonly base: string;
	readonly head?: string;
}

export interface Goal {
	readonly statement: string;
	readonly nonGoals: readonly string[];
	/** Effects the objective permits. Absent means read-only. */
	readonly permittedEffects: readonly Effect[];
	/** The explicitly authorized deliverable at the end of this run. */
	readonly finishAuthority: string;
	readonly appetite: Appetite;
}

export interface Appetite {
	readonly attemptsPerTask: number;
	readonly tasks: number;
}

export interface TestClaim {
	readonly command: string;
	readonly outcome: "pass" | "fail" | "not-run";
	readonly artifact?: string;
}

/**
 * Requested and effective routing are recorded separately because the requested
 * model is not the model that ran, and an omitted field is unknown rather than
 * evidence of a default.
 */
export interface Routing {
	readonly requested?: string;
	readonly effective?: string;
	readonly effort?: string;
	/** True only when a native record was read; never inferred from a prompt. */
	readonly verified: boolean;
}

/**
 * The worker receipt, as structured data.
 *
 * `version` is part of the contract so a future shape can be rejected instead of
 * silently misread.
 */
export interface EvidenceReceipt {
	readonly version: 1;
	readonly taskId: TaskId;
	readonly attemptId: AttemptId;
	readonly generation: GenerationId;
	readonly subject: Subject;
	readonly result: string;
	readonly changed: readonly string[];
	readonly evidence: readonly string[];
	readonly tests: readonly TestClaim[];
	readonly cleanEnvironment: boolean | "unknown";
	readonly unresolved: readonly string[];
	readonly next: string;
	readonly confidence: "low" | "medium" | "high";
	readonly routing: Routing;
	readonly exitCode: number;
	readonly aborted: boolean;
	readonly truncated: boolean;
}

/** A discovery. Discovery creates candidates, never authority. */
export interface Candidate {
	readonly taskId: TaskId;
	readonly generation: GenerationId;
	readonly criterionId: CriterionId;
	readonly title: string;
	readonly deps: readonly TaskId[];
	readonly effect: Effect;
	readonly owner: string;
	/** Recorded Luna judgment. Code checks necessity's dependencies, not its semantics. */
	readonly necessity: string;
}

export interface FactoryPrivateSession {
	readonly phase: "worker" | "acceptance";
	readonly sessionFile: string;
	/** Set only after OMP reports this private session's first turn_start. */
	readonly started: boolean;
}

export interface Attempt {
	readonly id: AttemptId;
	/** 1-based, preserved across new workers, branches, and goal changes. */
	readonly lineage: number;
	readonly taskId: TaskId;
	readonly generation: GenerationId;
	readonly subject: Subject;
	readonly state: "started" | "returned" | "abandoned";
	readonly nativeJobIds: readonly NativeJobId[];
	/** OMP child agent identities recorded from native task execution details. */
	readonly nativeAgentIds: readonly NativeAgentId[];
	/** Factory-private SDK sessions; these have no global OMP Agent Hub ID. */
	readonly privateSessions: readonly FactoryPrivateSession[];
	readonly receipt?: EvidenceReceipt;
	/** Integration is an explicit owner act; auto-apply is never assumed. */
	readonly integrated: boolean;
}

export interface TaskRecord {
	readonly id: TaskId;
	readonly generation: GenerationId;
	readonly criterionId: CriterionId;
	readonly title: string;
	readonly deps: readonly TaskId[];
	readonly effect: Effect;
	readonly owner: string;
	readonly state: TaskState;
	readonly attempts: readonly Attempt[];
	readonly decision: AdmissionDecision;
	readonly decisionReason: string;
}

export interface Ledger {
	readonly version: 1;
	readonly revision: number;
	readonly runId: RunId;
	readonly generation: GenerationId;
	readonly goal: Goal;
	readonly criteria: readonly Criterion[];
	readonly tasks: readonly TaskRecord[];
	readonly control: RunControl;
	/**
	 * The exact subject current proof is about.
	 *
	 * Integration moves this, and moving it is what invalidates older proof: a
	 * head that no longer matches is stale evidence, not a smaller change.
	 */
	readonly subject: Subject;
	/** Consecutive attempts that closed a task without changing any criterion's proof. */
	readonly noProgressAttempts: number;
	/** A materially different same-goal replan is allowed once; this counts the ones used. */
	readonly replans: number;
}

/**
 * Ledger events.
 *
 * Every mutating event carries the revision it was computed against, so a stale
 * writer is rejected instead of overwriting a newer decision.
 */
export type LedgerEvent =
	| { readonly kind: "record_candidate"; readonly expectedRevision: number; readonly candidate: Candidate }
	| {
			readonly kind: "start_attempt";
			readonly expectedRevision: number;
			readonly taskId: TaskId;
			readonly attemptId: AttemptId;
			readonly subject: Subject;
		}
	| {
			readonly kind: "record_private_session";
			readonly expectedRevision: number;
			readonly taskId: TaskId;
			readonly attemptId: AttemptId;
			readonly phase: FactoryPrivateSession["phase"];
			readonly sessionFile: string;
		}
	| {
			readonly kind: "record_private_session_start";
			readonly expectedRevision: number;
			readonly taskId: TaskId;
			readonly attemptId: AttemptId;
			readonly phase: FactoryPrivateSession["phase"];
		}
	| {
			readonly kind: "record_native_job";
			readonly expectedRevision: number;
			readonly taskId: TaskId;
			readonly attemptId: AttemptId;
			readonly jobId: NativeJobId;
		}
	| {
			readonly kind: "record_native_agent_start";
			readonly expectedRevision: number;
			readonly taskId: TaskId;
			readonly attemptId: AttemptId;
			readonly agentId: NativeAgentId;
		}
	| {
			readonly kind: "reconcile_attempt";
			readonly expectedRevision: number;
			readonly taskId: TaskId;
			readonly attemptId: AttemptId;
			readonly outcome: "abandoned" | "unknown";
			readonly reason: string;
		}
	| {
			readonly kind: "record_receipt";
			readonly expectedRevision: number;
			readonly taskId: TaskId;
			readonly attemptId: AttemptId;
			readonly receipt: EvidenceReceipt;
		}
	| {
			readonly kind: "integrate_attempt";
			readonly expectedRevision: number;
			readonly taskId: TaskId;
			readonly attemptId: AttemptId;
			readonly subject: Subject;
		}
	| {
			readonly kind: "finish_task";
			readonly expectedRevision: number;
			readonly taskId: TaskId;
			readonly criterionId: CriterionId;
		}
	| { readonly kind: "reopen_task"; readonly expectedRevision: number; readonly taskId: TaskId; readonly reason: string }
	| { readonly kind: "use_replan"; readonly expectedRevision: number; readonly taskId: TaskId }
	| { readonly kind: "reevaluate_candidate"; readonly expectedRevision: number; readonly taskId: TaskId }
	| {
			readonly kind: "set_control";
			readonly expectedRevision: number;
			readonly control: "active" | "paused" | "draining" | "interrupted";
		}
	| {
			readonly kind: "new_generation";
			readonly expectedRevision: number;
			readonly generation: GenerationId;
			readonly goal: Goal;
			readonly criteria: readonly Criterion[];
		};

export type ReduceResult =
	| { readonly ok: true; readonly ledger: Ledger }
	| { readonly ok: false; readonly error: string };

/** The ledger a run starts from. Nothing here authorizes work; it only names the objective. */
export function emptyLedger(runId: RunId, goal: Goal, criteria: readonly Criterion[], subject: Subject): Ledger {
	return {
		version: 1,
		revision: 0,
		runId,
		generation: "G1" as GenerationId,
		goal,
		criteria,
		tasks: [],
		control: "active",
		subject,
		noProgressAttempts: 0,
		replans: 0,
	};
}

export function findTask(ledger: Ledger, id: TaskId): TaskRecord | undefined {
	return ledger.tasks.find((task) => task.id === id);
}

export function findCriterion(ledger: Ledger, id: CriterionId): Criterion | undefined {
	return ledger.criteria.find((criterion) => criterion.id === id);
}
