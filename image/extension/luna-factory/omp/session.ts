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

import type { FactoryDashboardPresentation } from "../ui/dashboard.ts";
export const DASHBOARD_ENTRY = "com.joshyorko.luna-factory.dashboard";
const DASHBOARD_VIEWS = ["roster", "detail", "batches", "claims", "claim-detail", "evidence", "help", "palette", "evidence-detail", "debug", "claim-debug"] as const;

/** Presentation is disposable native session metadata, never Factory authority. */
function dashboardPresentation(value: unknown): FactoryDashboardPresentation | undefined {
	if (typeof value !== "object" || value === null) return;
	const data = value as Record<string, unknown>;
	const view = DASHBOARD_VIEWS.find((candidate) => candidate === data.view);
	if (!view || !Number.isSafeInteger(data.scroll) || Number(data.scroll) < 0 || Number(data.scroll) > 100_000) return;
	const text = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= 512;
	const mapping = (value: unknown): Record<string, string> | undefined => {
		if (typeof value !== "object" || value === null || Array.isArray(value)) return;
		return Object.fromEntries(Object.entries(value).slice(-128).filter((entry): entry is [string, string] => text(entry[0]) && text(entry[1])));
	};
	return {
		view, scroll: Number(data.scroll),
		...(text(data.batchId) ? { batchId: data.batchId } : {}),
		...(text(data.itemKey) ? { itemKey: data.itemKey } : {}),
		...(Number.isSafeInteger(data.cursor) && Number(data.cursor) >= 0 && Number(data.cursor) <= 100_000 ? { cursor: Number(data.cursor) } : {}),
		itemKeysByBatch: mapping(data.itemKeysByBatch), cursorKeys: mapping(data.cursorKeys),
	};
}
export function loadDashboardPresentation(ctx: SessionCtx): FactoryDashboardPresentation | undefined {
	const entry = ctx.sessionManager?.getBranch().findLast((entry) => entry.type === "custom" && entry.customType === DASHBOARD_ENTRY);
	return dashboardPresentation(entry?.data);
}
export function saveDashboardPresentation(host: JournalHost, presentation: FactoryDashboardPresentation): void {
	const bounded = dashboardPresentation(presentation);
	if (bounded) host.appendEntry(DASHBOARD_ENTRY, bounded);
}
