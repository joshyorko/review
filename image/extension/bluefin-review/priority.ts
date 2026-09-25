/**
 * What to look at first.
 *
 * Pull requests returned to the authenticated author form a local repair-only
 * lane before other work. Hive rank is authoritative within that lane and for
 * the remaining queue. Local categories, demotion, recency, and item key order
 * work without an external rank. This module never selects or assigns work.
 */

import type { QueueItem } from "./github.ts";
import type { HiveSnapshot } from "./hive.ts";

export type PriorityCategory =
	| "blocked"
	| "repair-requested"
	| "personal_request"
	| "ready-for-human-merge"
	| "review"
	| "resolve-conflicts"
	| "fix-ci"
	| "investigate"
	| "triage";
export interface Priority {
	category: PriorityCategory;
	source: "hive" | "local";
	/** Short human reason, shown next to the item. */
	reason: string;
	/** Hive's own position, when Hive supplied it. */
	hiveRank?: number;
	/** Sinks bot bumps and abandoned branches within their category. */
	demotion: number;
}

export interface PrioritizeContext {
	hive: HiveSnapshot;
	now: number;
	currentUserLogin?: string;
	/** Personal/self-hosted policy may explicitly permit workflow PR actions. */
	allowWorkflowSlay?: boolean;
}
export interface PrioritizedQueue {
	items: QueueItem[];
	priorities: ReadonlyMap<string, Priority>;
	source: "hive" | "local";
	/** How many items Hive ranked, for the headline. */
	hiveRanked: number;
}


/** Local attention precedence. Demotion never crosses a category boundary. */
const LOCAL_ATTENTION_ORDER: Record<PriorityCategory, number> = {
	"repair-requested": 0,
	personal_request: 1,
	"fix-ci": 2,
	"resolve-conflicts": 3,
	"ready-for-human-merge": 4,
	review: 5,
	triage: 6,
	investigate: 7,
	blocked: 8,
};

const STALE_AFTER_MS = 21 * 24 * 60 * 60 * 1000;

const BOT_AUTHORS: Record<string, true> = {
	renovate: true,
	"renovate[bot]": true,
	dependabot: true,
	"dependabot[bot]": true,
	mergeraptor: true,
	"github-actions[bot]": true,
};

const DEPENDENCY_LABELS = /(^|[/-])(deps|dependencies|dependency)([/-]|$)/i;

export function itemKey(item: QueueItem): string {
	return `${item.repo}#${item.id}`;
}

export function isDependencyBump(item: QueueItem): boolean {
	if (Object.hasOwn(BOT_AUTHORS, item.author.toLowerCase())) return true;
	if (item.labels.some((label) => DEPENDENCY_LABELS.test(label))) return true;
	return /^chore\(deps\)/i.test(item.title);
}

/** A pull request the authenticated author must revise before review can continue. */
export function isRepairRequested(item: QueueItem, currentUserLogin?: string): boolean {
	return item.type === "pr"
		&& item.reviewState === "changes_requested"
		&& Boolean(currentUserLogin)
		&& item.author.toLowerCase() === currentUserLogin!.toLowerCase();
}

/** Why an open pull request is unsupported for automated action. */
export function unsupportedReason(item: QueueItem, allowWorkflowSlay = false): string | undefined {
	if (item.type !== "pr") return undefined;
	if (!allowWorkflowSlay && (item.workflowFiles?.length ?? 0) > 0) {
		return "workflow change";
	}
	if (item.changedFilesComplete === false) {
		return "incomplete changed-file list";
	}
	return undefined;
}

/**
 * The local attention policy: the dashboard's classifier, first match wins.
 *
 * A failing check is actionable before a conflict is, and only a green,
 * approved pull request is ready for a human merge. A draft waits on its
 * author.
 */
export function categorize(item: QueueItem, context: PrioritizeContext): { category: PriorityCategory; reason: string } {
	if (item.type === "issue") return { category: "triage", reason: "issue awaiting triage" };
	if (isRepairRequested(item, context.currentUserLogin)) {
		return { category: "repair-requested", reason: "changes requested on your pull request" };
	}
	const blockedReason = unsupportedReason(item, context.allowWorkflowSlay);
	if (blockedReason) {
		return { category: "blocked", reason: blockedReason };
	}
	if (context.currentUserLogin && item.requestedReviewers?.some((login) => login.toLowerCase() === context.currentUserLogin!.toLowerCase())) {
		return { category: "personal_request", reason: "review requested from you" };
	}
	if (item.draft) return { category: "investigate", reason: "draft, waiting on its author" };
	if (item.ciStatus === "failure") return { category: "fix-ci", reason: "checks failing" };
	if (item.mergeState === "dirty") return { category: "resolve-conflicts", reason: "conflicts with the base" };
	if (item.ciStatus === undefined || item.ciStatus === "pending") {
		return { category: "investigate", reason: item.ciStatus === "pending" ? "checks still running" : "no checks reported" };
	}
	if (item.mergeState === "unknown" || item.reviewState === "unknown") {
		return { category: "investigate", reason: "incomplete evidence from GitHub" };
	}
	if (item.reviewState === "approved") return { category: "ready-for-human-merge", reason: "green and approved" };
	return { category: "review", reason: "green, awaiting review" };
}

/**
 * Within a category, what sinks.
 *
 * A dependency bump is real work but it is never the thing a maintainer should
 * read first, and a branch nobody has touched in three weeks is not urgent
 * because its checks happen to be green.
 */
export function demotionFor(item: QueueItem, now: number): number {
	let demotion = 0;
	if (isDependencyBump(item)) demotion += 1;
	if (item.updatedAt > 0 && now - item.updatedAt > STALE_AFTER_MS) demotion += 2;
	return demotion;
}

/**
 * Hive's rank for an item.
 *
 * A pull request is rarely queued by Hive directly — Hive queues the issue. The
 * link is the pull request's own closing references, so a change that closes
 * prioritized work inherits that priority instead of sinking into date order.
 */
export function hiveRankFor(item: QueueItem, hive: HiveSnapshot): number | undefined {
	const candidates = [itemKey(item), ...(item.closingIssues ?? [])];
	let best: number | undefined;
	for (const key of candidates) {
		const rank = hive.ranks.get(key);
		if (rank === undefined) continue;
		if (best === undefined || rank < best) best = rank;
	}
	return best;
}

function hiveReason(item: QueueItem, hive: HiveSnapshot, rank: number): string {
	const match = hive.items.find(
		(candidate) => candidate.key === itemKey(item) || (item.closingIssues ?? []).includes(candidate.key),
	);
	const level = match?.level;
	const via = match && match.key !== itemKey(item) ? ` via ${match.key}` : "";
	return level ? `hive ${level} #${rank + 1}${via}` : `hive #${rank + 1}${via}`;
}

/**
 * Put returned author work first, preserve Hive order inside each lane, and
 * otherwise apply deterministic local attention order to the captured snapshot.
 */
export function prioritize(items: readonly QueueItem[], context: PrioritizeContext): PrioritizedQueue {
	const priorities = new Map<string, Priority>();
	let hiveRanked = 0;

	for (const item of items) {
		const key = itemKey(item);
		const demotion = demotionFor(item, context.now);
		const rank = context.hive.online ? hiveRankFor(item, context.hive) : undefined;
		const local = categorize(item, context);
		if (rank !== undefined) hiveRanked += 1;
		priorities.set(key, {
			...local,
			source: rank === undefined ? "local" : "hive",
			reason: rank === undefined ? local.reason : `${local.reason} · ${hiveReason(item, context.hive, rank)}`,
			hiveRank: rank,
			demotion,
		});
	}

	const ordered = [...items].sort((left, right) => {
		const a = priorities.get(itemKey(left))!;
		const b = priorities.get(itemKey(right))!;
		const aRepair = a.category === "repair-requested";
		const bRepair = b.category === "repair-requested";
		if (aRepair !== bRepair) return aRepair ? -1 : 1;
		if (a.hiveRank !== undefined || b.hiveRank !== undefined) {
			// Preserve Hive's relative order inside each lane.
			if (a.hiveRank === undefined) return 1;
			if (b.hiveRank === undefined) return -1;
			if (a.hiveRank !== b.hiveRank) return a.hiveRank - b.hiveRank;
		}
		const category = LOCAL_ATTENTION_ORDER[a.category] - LOCAL_ATTENTION_ORDER[b.category];
		if (category !== 0) return category;
		if (a.demotion !== b.demotion) return a.demotion - b.demotion;
		if (left.updatedAt !== right.updatedAt) return right.updatedAt - left.updatedAt;
		const leftKey = itemKey(left).toLowerCase();
		const rightKey = itemKey(right).toLowerCase();
		return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
	});

	if (!context.hive.online) {
		return { items: ordered, priorities, source: "local", hiveRanked: 0 };
	}

	return {
		items: ordered,
		priorities,
		source: "hive",
		hiveRanked,
	};
}
/** Counts per category, for the headline. */
export function categoryTally(priorities: ReadonlyMap<string, Priority>): Record<PriorityCategory, number> {
	const tally: Record<PriorityCategory, number> = {
		blocked: 0,
		"repair-requested": 0,
		personal_request: 0,
		"ready-for-human-merge": 0,
		review: 0,
		"resolve-conflicts": 0,
		"fix-ci": 0,
		investigate: 0,
		triage: 0,
	};
	for (const priority of priorities.values()) tally[priority.category] += 1;
	return tally;
}
