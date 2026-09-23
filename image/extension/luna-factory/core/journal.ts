/**
 * The durable journal.
 *
 * The ledger is versioned and namespaced, and it is read back through native
 * session storage rather than a new database. Reading is deliberately defensive:
 * a missing, corrupt, or unknown-version record fails safely and reports why,
 * because deleting a record the code cannot parse destroys the only evidence
 * that the run happened.
 *
 * Durability is also reported honestly. If the session exposes no history, this
 * package cannot claim a resumable run, and it says so instead of pretending.
 */

import { isRecord } from "./guard.ts";
import { DEFAULT_FINISH_AUTHORITY } from "./model.ts";
import { parseProofAssumptions, parseReceipt } from "./schema.ts";
import type {
	AdmissionDecision,
	Attempt,
	Criterion,
	CriterionId,
	GenerationId,
	Ledger,
	RunControl,
	RunId,
	Subject,
	TaskId,
	TaskRecord,
	TaskState,
	NativeAgentId,
} from "./model.ts";

/** Namespaced custom entry. A new key means a different shape, not a migration. */
export const JOURNAL_ENTRY = "com.joshyorko.luna-factory.run";

export const JOURNAL_VERSION = 1;

export interface BranchEntry {
	readonly type?: string;
	readonly customType?: string;
	readonly data?: unknown;
}

export type JournalRead =
	| { readonly ok: true; readonly ledger: Ledger }
	| { readonly ok: false; readonly reason: string };

export type Durability = "durable" | "unavailable";

const IDENTITY_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const REPO_RE = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;
const REVISION_RE = /^[0-9a-f]{7,64}$/;
const MAX_TEXT = 2_000;
const MAX_ITEMS = 64;

const TASK_STATES: readonly TaskState[] = ["CANDIDATE", "READY", "BLOCKED", "DEFERRED", "ESCALATE", "RUNNING", "VERIFY", "DONE"];
const ADMISSION_DECISIONS: readonly AdmissionDecision[] = ["ADMIT", "DEFER", "DISMISS", "ESCALATE"];
const RUN_CONTROLS: readonly RunControl[] = ["active", "paused", "draining", "interrupted"];

function identity(value: unknown): value is string {
	return typeof value === "string" && IDENTITY_RE.test(value);
}

function boundedText(value: unknown, allowEmpty = false): value is string {
	return typeof value === "string" && value.length <= MAX_TEXT && (allowEmpty || value.trim().length > 0);
}

function integer(value: unknown): value is number {
	return typeof value === "number" && Number.isInteger(value);
}

function stringList(value: unknown, allowEmptyItems = false): value is readonly string[] {
	return (
		Array.isArray(value) &&
		value.length <= MAX_ITEMS &&
		value.every((entry) => boundedText(entry, allowEmptyItems))
	);
}

/**
 * Whether the session can carry a run across restarts at all.
 *
 * History is the signal; a session that exposes none cannot resume, and claiming
 * otherwise would be a durability claim with nothing behind it.
 */
export function durabilityOf(entries: readonly BranchEntry[] | undefined): Durability {
	return Array.isArray(entries) ? "durable" : "unavailable";
}

function parseSubject(value: unknown): Subject | undefined {
	if (!isRecord(value)) return undefined;
	if (typeof value.repo !== "string" || !REPO_RE.test(value.repo)) return undefined;
	if (typeof value.base !== "string" || !REVISION_RE.test(value.base)) return undefined;
	if (value.head !== undefined && (typeof value.head !== "string" || !REVISION_RE.test(value.head))) return undefined;
	return value.head === undefined ? { repo: value.repo, base: value.base } : { repo: value.repo, base: value.base, head: value.head };
}

function parseCriterion(value: unknown): Criterion | undefined {
	if (!isRecord(value)) return undefined;
	if (!identity(value.id) || !boundedText(value.statement) || typeof value.mandatory !== "boolean") return undefined;
	if (value.assumptions === undefined) return { id: value.id as CriterionId, statement: value.statement, mandatory: value.mandatory };
	const parsed = parseProofAssumptions(value.assumptions);
	if (!parsed.ok) return undefined;
	return { id: value.id as CriterionId, statement: value.statement, mandatory: value.mandatory, assumptions: parsed.value };
}

function parseTask(value: unknown): TaskRecord | undefined {
	if (!isRecord(value)) return undefined;
	if (!identity(value.id) || !identity(value.criterionId) || !identity(value.generation) || !TASK_STATES.includes(value.state as TaskState)) {
		return undefined;
	}
	if (!Array.isArray(value.attempts) || !Array.isArray(value.deps)) return undefined;
	if (!ADMISSION_DECISIONS.includes(value.decision as AdmissionDecision) || !boundedText(value.decisionReason)) return undefined;
	if (!boundedText(value.title) || !identity(value.owner) || !stringList(value.deps)) {
		return undefined;
	}
	if (value.effect !== "read" && value.effect !== "write") return undefined;
	if (new Set(value.deps).size !== value.deps.length || !value.deps.every((dep) => identity(dep))) return undefined;
	if (value.attempts.length > MAX_ITEMS) return undefined;
	const attempts: Attempt[] = [];
	const attemptIds = new Set<string>();
	for (const rawAttempt of value.attempts) {
		if (!isRecord(rawAttempt)) return undefined;
		if (
			!identity(rawAttempt.id) ||
			!integer(rawAttempt.lineage) ||
			rawAttempt.lineage < 1 ||
			!identity(rawAttempt.taskId) ||
			!identity(rawAttempt.generation) ||
			!isRecord(rawAttempt.subject) ||
			typeof rawAttempt.state !== "string" ||
			typeof rawAttempt.integrated !== "boolean"
		) return undefined;
		// Version-1 journals predate OMP identity fields. Missing identities stay empty;
		// session-start reconciliation treats their unfinished attempts as unknown.
		const nativeJobIds = rawAttempt.nativeJobIds === undefined ? [] : rawAttempt.nativeJobIds;
		const legacyAgentIds = rawAttempt.nativeResultIds;
		const nativeAgentIds = rawAttempt.nativeAgentIds === undefined ? (legacyAgentIds === undefined ? [] : legacyAgentIds) : rawAttempt.nativeAgentIds;
		if (!Array.isArray(nativeJobIds) || !Array.isArray(nativeAgentIds)) return undefined;
		if (!nativeJobIds.every((id) => identity(id)) || !nativeAgentIds.every((id) => identity(id))) return undefined;
		if (new Set(nativeJobIds).size !== nativeJobIds.length || new Set(nativeAgentIds).size !== nativeAgentIds.length) return undefined;
		const rawPrivateSessions = rawAttempt.privateSessions === undefined ? [] : rawAttempt.privateSessions;
		const steeredAgentId = rawAttempt.steeredAgentId;
		if (steeredAgentId !== undefined && (!identity(steeredAgentId) || !nativeAgentIds.includes(steeredAgentId))) return undefined;
		if (!Array.isArray(rawPrivateSessions) || rawPrivateSessions.length > 2) return undefined;
		const privateSessions: Attempt["privateSessions"][number][] = [];
		for (const session of rawPrivateSessions) {
			if (!isRecord(session) || (session.phase !== "worker" && session.phase !== "acceptance") || !boundedText(session.sessionFile) || (session.started !== undefined && typeof session.started !== "boolean")) return undefined;
			if (privateSessions.some((current) => current.phase === session.phase)) return undefined;
			privateSessions.push({ phase: session.phase, sessionFile: session.sessionFile, started: session.started === true });
		}
		const parsedSubject = parseSubject(rawAttempt.subject);
		if (parsedSubject === undefined || attemptIds.has(rawAttempt.id)) return undefined;
		if (rawAttempt.state !== "started" && rawAttempt.state !== "returned" && rawAttempt.state !== "abandoned") return undefined;
		let receipt: Attempt["receipt"];
		if (rawAttempt.receipt !== undefined) {
			const parsedReceipt = parseReceipt(rawAttempt.receipt);
			if (!parsedReceipt.ok) return undefined;
			receipt = parsedReceipt.value;
		}
		attemptIds.add(rawAttempt.id);
		attempts.push({
			id: rawAttempt.id as Attempt["id"],
			lineage: rawAttempt.lineage,
			taskId: rawAttempt.taskId as TaskId,
			generation: rawAttempt.generation as GenerationId,
			subject: parsedSubject,
			state: rawAttempt.state as Attempt["state"],
			nativeJobIds: nativeJobIds as Attempt["nativeJobIds"],
			nativeAgentIds: nativeAgentIds as Attempt["nativeAgentIds"],
			privateSessions,
			...(receipt === undefined ? {} : { receipt }),
			...(steeredAgentId === undefined ? {} : { steeredAgentId: steeredAgentId as NativeAgentId }),
			integrated: rawAttempt.integrated,
		});
	}
	return {
		id: value.id as TaskId,
		generation: value.generation as GenerationId,
		criterionId: value.criterionId as CriterionId,
		title: value.title,
		deps: value.deps as readonly TaskId[],
		effect: value.effect,
		owner: value.owner,
		state: value.state as TaskRecord["state"],
		attempts,
		decision: value.decision as TaskRecord["decision"],
		decisionReason: value.decisionReason,
	};
}

/**
 * Parse a journal record.
 *
 * The journal is local durable input, not a trusted database. Validate every
 * field the reducer reads and re-parse stored receipts before resuming.
 */
export function parseJournal(value: unknown): JournalRead {
	if (!isRecord(value)) return { ok: false, reason: "journal record is not an object" };
	const version = value.version;
	if (version !== JOURNAL_VERSION) {
		return { ok: false, reason: `journal version ${String(version)} is not readable by this build (expected ${JOURNAL_VERSION})` };
	}
	if (!integer(value.revision) || value.revision < 0) {
		return { ok: false, reason: "journal revision is not an integer" };
	}
	if (!identity(value.runId) || !identity(value.generation)) {
		return { ok: false, reason: "journal is missing its run or generation identity" };
	}
	if (!isRecord(value.goal) || !boundedText(value.goal.statement) || !Array.isArray(value.goal.permittedEffects) || !Array.isArray(value.goal.nonGoals) || typeof value.goal.finishAuthority !== "string" || value.goal.finishAuthority.trim().length === 0) {
		return { ok: false, reason: "journal goal is unreadable" };
	}
	const nonGoals = value.goal.nonGoals;
	if (!stringList(nonGoals)) return { ok: false, reason: "journal non-goals are unreadable" };
	const permittedEffects = value.goal.permittedEffects;
	if (
		!permittedEffects.every((effect) => effect === "read" || effect === "write") ||
		new Set(permittedEffects).size !== permittedEffects.length
	) {
		return { ok: false, reason: "journal permitted effects are unreadable" };
	}
	if (value.goal.finishAuthority !== undefined && (typeof value.goal.finishAuthority !== "string" || value.goal.finishAuthority.trim().length === 0)) {
		return { ok: false, reason: "journal finish authority is unreadable" };
	}
	if (!isRecord(value.goal.appetite)) {
		return { ok: false, reason: "journal appetite is unreadable" };
	}
	const appetiteTasks = value.goal.appetite.tasks;
	const appetiteAttempts = value.goal.appetite.attemptsPerTask;
	if (
		!integer(appetiteTasks) ||
		!integer(appetiteAttempts) ||
		appetiteTasks < 1 ||
		appetiteTasks > MAX_ITEMS ||
		appetiteAttempts < 1 ||
		appetiteAttempts > MAX_ITEMS
	) {
		return { ok: false, reason: "journal appetite is unreadable" };
	}
	if (!RUN_CONTROLS.includes(value.control as RunControl)) return { ok: false, reason: "journal control is unreadable" };
	const noProgressAttempts = value.noProgressAttempts;
	const replans = value.replans;
	if (!integer(noProgressAttempts) || noProgressAttempts < 0 || !integer(replans) || replans < 0 || replans > 1) {
		return { ok: false, reason: "journal convergence counters are unreadable" };
	}
	const subject = parseSubject(value.subject);
	if (subject === undefined) return { ok: false, reason: "journal subject is unreadable" };
	if (!Array.isArray(value.criteria) || value.criteria.length === 0 || value.criteria.length > MAX_ITEMS || !Array.isArray(value.tasks) || value.tasks.length > MAX_ITEMS) {
		return { ok: false, reason: "journal criteria or tasks are not arrays" };
	}

	const criteria: Criterion[] = [];
	const criterionIds = new Set<string>();
	for (const entry of value.criteria) {
		const criterion = parseCriterion(entry);
		if (criterion === undefined || criterionIds.has(criterion.id)) return { ok: false, reason: "journal holds an unreadable or duplicate criterion" };
		criterionIds.add(criterion.id);
		criteria.push(criterion);
	}
	const tasks: TaskRecord[] = [];
	const taskIds = new Set<string>();
	for (const entry of value.tasks) {
		const task = parseTask(entry);
		if (task === undefined || taskIds.has(task.id)) return { ok: false, reason: "journal holds an unreadable or duplicate task" };
		taskIds.add(task.id);
		tasks.push(task);
	}
	for (const task of tasks) {
		if (["READY", "RUNNING", "VERIFY", "DONE"].includes(task.state) && !criterionIds.has(task.criterionId)) return { ok: false, reason: "journal task criterion is inconsistent" };
		if (!task.attempts.every((attempt) => attempt.taskId === task.id)) return { ok: false, reason: "journal attempt identity is inconsistent" };
		if (task.state === "DONE" && !task.attempts.some((attempt) => attempt.state === "returned" && attempt.receipt !== undefined)) return { ok: false, reason: "journal DONE task has no returned receipt" };
	}

	return {
		ok: true,
		ledger: {
			version: 1,
			revision: value.revision,
			runId: value.runId as RunId,
			generation: value.generation as GenerationId,
			goal: {
				statement: value.goal.statement,
				nonGoals: nonGoals as readonly string[],
				permittedEffects: permittedEffects as readonly ("read" | "write")[],
				finishAuthority:
					typeof value.goal.finishAuthority === "string" ? value.goal.finishAuthority : DEFAULT_FINISH_AUTHORITY,
				appetite: { tasks: appetiteTasks, attemptsPerTask: appetiteAttempts },
			},
			criteria,
			tasks,
			control: value.control as Ledger["control"],
			subject,
			noProgressAttempts,
			replans,
		},
	};
}

/**
 * Read the newest journal record from a session branch.
 *
 * A corrupt newest record is reported rather than skipped: silently falling back
 * to an older record would resurrect state the run has already moved past.
 */
export function readJournal(entries: readonly BranchEntry[] | undefined): JournalRead | undefined {
	if (!Array.isArray(entries)) return undefined;
	let latest: unknown;
	let found = false;
	for (const entry of entries) {
		if (!isRecord(entry) || entry.type !== "custom" || entry.customType !== JOURNAL_ENTRY) continue;
		latest = entry.data;
		found = true;
	}
	if (!found) return undefined;
	return parseJournal(latest);
}

/** The record to persist. Small derived checkpoint, not an event log. */
export function journalRecord(ledger: Ledger): unknown {
	return { ...ledger };
}
