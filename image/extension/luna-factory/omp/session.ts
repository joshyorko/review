/**
 * Session persistence for the ledger.
 *
 * The run is stored as one versioned, namespaced custom entry through native
 * OMP session storage. Reading is defensive and reports the reason a record
 * could not be used, because a run that cannot be read back is a different
 * situation from a run that never existed.
 */

import { JOURNAL_ENTRY, type BranchEntry, type Durability, type JournalRead, durabilityOf, journalRecord, readJournal } from "../core/journal.ts";
import type { Ledger } from "../core/model.ts";

export interface SessionCtx {
	readonly sessionManager?: { getBranch(): readonly BranchEntry[] };
}

export interface JournalHost {
	appendEntry(customType: string, data?: unknown): void;
}

export interface LoadedRun {
	readonly ledger?: Ledger;
	readonly durability: Durability;
	/** Present when a record existed but could not be used. */
	readonly problem?: string;
}

/**
 * Load the run for this session.
 *
 * `undefined` from `readJournal` means no record exists yet, which is a fresh
 * run. A returned failure means a record exists and is unusable: the caller must
 * surface that rather than starting over on top of unread evidence.
 */
export function loadRun(ctx: SessionCtx): LoadedRun {
	const branch = ctx.sessionManager?.getBranch();
	const durability = durabilityOf(branch);
	const read: JournalRead | undefined = readJournal(branch);
	if (read === undefined) return { durability };
	if (!read.ok) return { durability, problem: read.reason };
	return { durability, ledger: read.ledger };
}

/** Persist the ledger checkpoint. Callers persist intent before any external effect. */
export function saveRun(host: JournalHost, ledger: Ledger): void {
	host.appendEntry(JOURNAL_ENTRY, journalRecord(ledger));
}
