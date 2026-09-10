/**
 * Hive Contributor Leaderboard & Dinosaur Lore Levelling System
 *
 * Fetches the live contributor roster from Hive hub (/api/v1/contributors)
 * and maps completed work, PR landings, and trust tiers into Project Bluefin's
 * prehistoric kettle lore progression.
 */

import { fetchHiveMe, resolveHiveToken, resolveHub, type HiveFetchOptions } from "./hive.ts";
import { GLYPH, type Painter } from "./glyphs.ts";
import { truncateToWidth } from "./width.ts";

export interface HiveContributorStats {
	username: string;
	contributorId: string;
	trustTier: string;
	cliBackend: string;
	model: string;
	avatarUrl: string;
	registeredAt: string;
	totalTasksCompleted: number;
	totalTasksCompletedWithPr: number;
	totalTasksFailed: number;
	lastActive: string;
	lastCompletedTask?: {
		repo: string;
		number: number;
		title: string;
		key: string;
		url: string;
	};
}

export interface ContributorTierInfo {
	minTasks: number;
	description: string;
	color: "accent" | "success" | "warning" | "error" | "dim" | "text";
}

/**
 * Task threshold tiers with factual activity descriptions.
 * Titles and lore names left to the maintainer.
 */
export const ACTIVITY_TIERS: readonly ContributorTierInfo[] = [
	{
		minTasks: 200,
		description: "200+ completed tasks",
		color: "accent",
	},
	{
		minTasks: 100,
		description: "100-199 completed tasks",
		color: "accent",
	},
	{
		minTasks: 50,
		description: "50-99 completed tasks",
		color: "success",
	},
	{
		minTasks: 25,
		description: "25-49 completed tasks",
		color: "warning",
	},
	{
		minTasks: 10,
		description: "10-24 completed tasks",
		color: "warning",
	},
	{
		minTasks: 1,
		description: "1-9 completed tasks",
		color: "text",
	},
	{
		minTasks: 0,
		description: "Registered (no completed tasks yet)",
		color: "dim",
	},
] as const;

export function getTierInfo(tasksCompleted: number): ContributorTierInfo {
	for (const tier of ACTIVITY_TIERS) {
		if (tasksCompleted >= tier.minTasks) return tier;
	}
	return ACTIVITY_TIERS[ACTIVITY_TIERS.length - 1]!;
}

/**
 * Fetch all registered contributors from Hive hub /api/v1/contributors.
 */
export async function fetchHiveLeaderboard(options: HiveFetchOptions = {}): Promise<HiveContributorStats[]> {
	const env = options.env ?? process.env;
	const hub = resolveHub(env);
	if (!hub) return [];

	const doFetch = options.fetchImpl ?? fetch;
	const token = resolveHiveToken(env);
	const headers: Record<string, string> = {
		Accept: "application/json",
		"User-Agent": "bluefin-review-omp",
	};
	if (token) headers.Authorization = `Bearer ${token}`;

	try {
		const response = await doFetch(`${hub}/api/v1/contributors`, {
			headers,
			signal: options.signal,
			redirect: "error",
		});
		if (!response.ok) return [];
		const payload = (await response.json()) as { contributors?: unknown[] };
		if (!payload || !Array.isArray(payload.contributors)) return [];

		const items: HiveContributorStats[] = [];
		for (const raw of payload.contributors) {
			if (!raw || typeof raw !== "object") continue;
			const r = raw as Record<string, unknown>;
			const username = typeof r.github_username === "string" ? r.github_username : "";
			if (!username) continue;

			items.push({
				username,
				contributorId: typeof r.contributor_id === "string" ? r.contributor_id : "",
				trustTier: typeof r.trust_tier === "string" ? r.trust_tier : "newcomer",
				cliBackend: typeof r.cli_backend === "string" ? r.cli_backend : "unknown",
				model: typeof r.model === "string" ? r.model : "",
				avatarUrl: typeof r.avatar_url === "string" ? r.avatar_url : "",
				registeredAt: typeof r.registered_at === "string" ? r.registered_at : "",
				totalTasksCompleted: typeof r.total_tasks_completed === "number" ? r.total_tasks_completed : 0,
				totalTasksCompletedWithPr: typeof r.total_tasks_completed_with_pr === "number" ? r.total_tasks_completed_with_pr : 0,
				totalTasksFailed: typeof r.total_tasks_failed === "number" ? r.total_tasks_failed : 0,
				lastActive: typeof r.last_active === "string" ? r.last_active : "",
				lastCompletedTask: r.last_completed_task && typeof r.last_completed_task === "object"
					? {
							repo: typeof (r.last_completed_task as Record<string, unknown>).repo === "string" ? (r.last_completed_task as Record<string, unknown>).repo as string : "",
							number: typeof (r.last_completed_task as Record<string, unknown>).number === "number" ? (r.last_completed_task as Record<string, unknown>).number as number : 0,
							title: typeof (r.last_completed_task as Record<string, unknown>).title === "string" ? (r.last_completed_task as Record<string, unknown>).title as string : "",
							key: typeof (r.last_completed_task as Record<string, unknown>).key === "string" ? (r.last_completed_task as Record<string, unknown>).key as string : "",
							url: typeof (r.last_completed_task as Record<string, unknown>).url === "string" ? (r.last_completed_task as Record<string, unknown>).url as string : "",
						}
					: undefined,
			});
		}

		// Rank by totalTasksCompleted descending, then tasksWithPr descending, then name ascending
		items.sort((a, b) => {
			if (b.totalTasksCompleted !== a.totalTasksCompleted) return b.totalTasksCompleted - a.totalTasksCompleted;
			if (b.totalTasksCompletedWithPr !== a.totalTasksCompletedWithPr) return b.totalTasksCompletedWithPr - a.totalTasksCompletedWithPr;
			return a.username.localeCompare(b.username);
		});

		return items;
	} catch {
		return [];
	}
}

/**
 * Fullscreen Interactive TUI Component for the Hive Top 25 Leaderboard
 */
export class HiveLeaderboardComponent {
	private readonly tui: { requestRender(): void };
	private readonly painter: Painter;
	private readonly done: () => void;
	private items: HiveContributorStats[] = [];
	private loading = true;
	private scroll = 0;
	private cursor = 0;
	private myUsername = "";

	constructor(tui: { requestRender(): void }, painter: Painter, done: () => void, initialItems: HiveContributorStats[] = []) {
		this.tui = tui;
		this.painter = painter;
		this.done = done;
		this.items = initialItems;
		if (initialItems.length > 0) this.loading = false;
		void this.load();
	}

	private async load(): Promise<void> {
		const [roster, me] = await Promise.all([
			fetchHiveLeaderboard(),
			fetchHiveMe().catch(() => undefined),
		]);
		if (me && typeof me.github_username === "string") {
			this.myUsername = me.github_username;
		}
		if (roster.length > 0) {
			this.items = roster;
		}
		this.loading = false;
		this.tui.requestRender();
	}

	handleInput(data: string): void {
		if (data === "\x1b" || data === "q" || data === "*" || data === "escape" || data === "\r" || data === "\n") {
			this.done();
			return;
		}
		if (data === "j" || data === "\x1b[B" || data === "down") {
			this.cursor = Math.min(this.items.length - 1, this.cursor + 1);
			this.tui.requestRender();
			return;
		}
		if (data === "k" || data === "\x1b[A" || data === "up") {
			this.cursor = Math.max(0, this.cursor - 1);
			this.tui.requestRender();
			return;
		}
	}

	render(width: number): string[] {
		const p = this.painter;
		const rows: string[] = [];
		const top25 = this.items.slice(0, 25);

		// Header Banner
		const title = p.bold(p.fg("accent", `${GLYPH.hex} HIVE COMMUNITY LEADERBOARD — TOP 25`));
		const subtitle = p.fg("dim", "Weekly Factory Ranks · Press [*] or [q] to exit");
		rows.push(truncateToWidth(`${title}  │  ${subtitle}`, width));
		rows.push(p.fg("border", "─".repeat(width)));

		if (this.loading && this.items.length === 0) {
			rows.push(p.fg("warning", `  ${GLYPH.running} Querying Hive hub for contributor leaderboard & dossiers…`));
			return rows;
		}

		if (this.items.length === 0) {
			rows.push(p.fg("dim", "  No contributors registered on this Hive hub yet."));
			return rows;
		}

		// Table Header
		const header = `  ${p.fg("dim", "RNK")}  ${p.bold(p.fg("text", "CONTRIBUTOR"))}        ${p.fg("accent", "TASKS (PRs)")}   ${p.fg("dim", "TIER")}         ${p.bold(p.fg("accent", "ACTIVITY LEVEL"))}`;
		rows.push(truncateToWidth(header, width));
		rows.push(p.fg("border", "┄".repeat(width)));

		// Render Rows
		for (let i = 0; i < top25.length; i++) {
			const c = top25[i]!;
			const rankNum = i + 1;
			const isMe = this.myUsername && c.username.toLowerCase() === this.myUsername.toLowerCase();
			const active = i === this.cursor;

			// Format Rank badge
			let rnkStr = String(rankNum).padStart(2, "0");
			if (rankNum === 1) rnkStr = p.bold(p.fg("accent", "🥇"));
			else if (rankNum === 2) rnkStr = p.bold(p.fg("accent", "🥈"));
			else if (rankNum === 3) rnkStr = p.bold(p.fg("accent", "🥉"));
			else rnkStr = p.fg("dim", `#${rnkStr}`);

			const tierInfo = getTierInfo(c.totalTasksCompleted);
			const userStr = isMe ? p.bold(p.fg("accent", `@${c.username} ★`)) : p.fg("text", `@${c.username}`);
			const userPadded = fitToWidth(userStr, 18);

			const tasksStr = `${p.bold(p.fg("text", String(c.totalTasksCompleted)))} ${p.fg("dim", `(${c.totalTasksCompletedWithPr} pr)`)}`;
			const tasksPadded = fitToWidth(tasksStr, 15);

			const tierStr = p.fg(c.trustTier === "trusted" || c.trustTier === "merger" ? "accent" : "dim", c.trustTier);
			const tierPadded = fitToWidth(tierStr, 12);

			const descBadge = p.fg(tierInfo.color, tierInfo.description);
			const caret = active ? p.fg("accent", "▶") : " ";

			const line = `${caret} ${rnkStr}  ${userPadded} ${tasksPadded} ${tierPadded} ${descBadge}`;
			rows.push(truncateToWidth(line, width));
		}

		rows.push(p.fg("border", "─".repeat(width)));

		// Selected item detail footer
		const sel = top25[Math.min(this.cursor, top25.length - 1)];
		if (sel) {
			const tierInfo = getTierInfo(sel.totalTasksCompleted);
			const taskDetail = sel.lastCompletedTask ? `Latest: #${sel.lastCompletedTask.number} ${sel.lastCompletedTask.title}` : `Backend: ${sel.cliBackend}${sel.model ? ` (${sel.model})` : ""}`;
			const footer = `  ${p.bold(p.fg("accent", `@${sel.username}`))} [${p.fg(tierInfo.color, tierInfo.description)}]  │  ${p.fg("dim", taskDetail)}`;
			rows.push(truncateToWidth(footer, width));
		}

		return rows;
	}

	invalidate(): void {}
	dispose(): void {}
}

function fitToWidth(text: string, targetWidth: number): string {
	const current = visibleWidth(text);
	if (current >= targetWidth) return text;
	return text + " ".repeat(targetWidth - current);
}
