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
import type { Criterion, CriterionId, GenerationId, Ledger, RunId, Subject, TaskId, TaskRecord } from "./model.ts";

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
	if (typeof value.repo !== "string" || typeof value.base !== "string") return undefined;
	if (value.head !== undefined && typeof value.head !== "string") return undefined;
	return value.head === undefined ? { repo: value.repo, base: value.base } : { repo: value.repo, base: value.base, head: value.head };
}

function parseCriterion(value: unknown): Criterion | undefined {
	if (!isRecord(value)) return undefined;
	if (typeof value.id !== "string" || typeof value.statement !== "string" || typeof value.mandatory !== "boolean") {
		return undefined;
	}
	return { id: value.id as CriterionId, statement: value.statement, mandatory: value.mandatory };
}

function parseTask(value: unknown): TaskRecord | undefined {
	if (!isRecord(value)) return undefined;
	if (typeof value.id !== "string" || typeof value.criterionId !== "string" || typeof value.state !== "string") {
		return undefined;
	}
	if (!Array.isArray(value.attempts) || !Array.isArray(value.deps)) return undefined;
	if (typeof value.decision !== "string" || typeof value.decisionReason !== "string") return undefined;
	if (typeof value.title !== "string" || typeof value.owner !== "string" || typeof value.generation !== "string") {
		return undefined;
	}
	if (value.effect !== "read" && value.effect !== "write") return undefined;
	return {
		id: value.id as TaskId,
		generation: value.generation as GenerationId,
		criterionId: value.criterionId as CriterionId,
		title: value.title,
		deps: value.deps as readonly TaskId[],
		effect: value.effect,
		owner: value.owner,
		state: value.state as TaskRecord["state"],
		attempts: value.attempts as TaskRecord["attempts"],
		decision: value.decision as TaskRecord["decision"],
		decisionReason: value.decisionReason,
	};
}

/**
 * Parse a journal record.
 *
 * Only the fields the reducer reads are validated, and only deeply enough to
 * reject a shape the reducer would misread. Attempts are carried through as-is:
 * their receipts were already parsed and reconciled before they were stored.
 */
export function parseJournal(value: unknown): JournalRead {
	if (!isRecord(value)) return { ok: false, reason: "journal record is not an object" };
	const version = value.version;
	if (version !== JOURNAL_VERSION) {
		return { ok: false, reason: `journal version ${String(version)} is not readable by this build (expected ${JOURNAL_VERSION})` };
	}
	if (typeof value.revision !== "number" || !Number.isInteger(value.revision)) {
		return { ok: false, reason: "journal revision is not an integer" };
	}
	if (typeof value.runId !== "string" || typeof value.generation !== "string") {
		return { ok: false, reason: "journal is missing its run or generation identity" };
	}
	if (!isRecord(value.goal) || typeof value.goal.statement !== "string" || !Array.isArray(value.goal.permittedEffects)) {
		return { ok: false, reason: "journal goal is unreadable" };
	}
	if (!isRecord(value.goal.appetite) || typeof value.goal.appetite.tasks !== "number" || typeof value.goal.appetite.attemptsPerTask !== "number") {
		return { ok: false, reason: "journal appetite is unreadable" };
	}
	const subject = parseSubject(value.subject);
	if (subject === undefined) return { ok: false, reason: "journal subject is unreadable" };
	if (!Array.isArray(value.criteria) || !Array.isArray(value.tasks)) {
		return { ok: false, reason: "journal criteria or tasks are not arrays" };
	}

	const criteria: Criterion[] = [];
	for (const entry of value.criteria) {
		const criterion = parseCriterion(entry);
		if (criterion === undefined) return { ok: false, reason: "journal holds an unreadable criterion" };
		criteria.push(criterion);
	}
	const tasks: TaskRecord[] = [];
	for (const entry of value.tasks) {
		const task = parseTask(entry);
		if (task === undefined) return { ok: false, reason: "journal holds an unreadable task" };
		tasks.push(task);
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
				nonGoals: Array.isArray(value.goal.nonGoals) ? (value.goal.nonGoals as string[]).filter((item) => typeof item === "string") : [],
				permittedEffects: (value.goal.permittedEffects as unknown[]).filter(
					(effect): effect is "read" | "write" => effect === "read" || effect === "write",
				),
				appetite: { tasks: value.goal.appetite.tasks, attemptsPerTask: value.goal.appetite.attemptsPerTask },
			},
			criteria,
			tasks,
			control: typeof value.control === "string" ? (value.control as Ledger["control"]) : "active",
			subject,
			noProgressAttempts: typeof value.noProgressAttempts === "number" ? value.noProgressAttempts : 0,
			replans: typeof value.replans === "number" ? value.replans : 0,
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
		if (entry.type !== "custom" || entry.customType !== JOURNAL_ENTRY) continue;
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
