/**
 * Hive, read-only.
 *
 * When a hub is configured, Hive owns what matters and in what order. This
 * module reads that order and nothing else: it never assigns, never completes,
 * never re-sorts, and never writes. The maintainer still decides what to review
 * and what to merge; Hive decides what the project needs first, and the queue
 * follows it.
 *
 * The endpoints and the rank semantics mirror the Textual dashboard
 * (`image/tui/bluefin_review_tui.py`) so both surfaces agree about priority
 * rather than inventing two orders for the same hub.
 */

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** One item Hive has queued, in Hive's own order. */
export interface HiveWorkItem {
	key: string;
	repo: string;
	number: number;
	title: string;
	url: string;
	labels: string[];
	/** Triage level this item was found under, when it came from the triage view. */
	level?: string;
}

export interface HiveTriageGroup {
	level: string;
	label: string;
	count: number;
}

export interface HiveSnapshot {
	/** The hub this came from, for display. Never a token, never a path. */
	hub: string;
	configured: boolean;
	online: boolean;
	actionableItems?: number;
	items: HiveWorkItem[];
	triage: HiveTriageGroup[];
	/** `owner/repo#number` → position in Hive's order. */
	ranks: ReadonlyMap<string, number>;
	error?: string;
	fetchedAt: number;
}

export const EMPTY_HIVE: HiveSnapshot = {
	hub: "",
	configured: false,
	online: false,
	items: [],
	triage: [],
	ranks: new Map(),
	fetchedAt: 0,
};

/**
 * The hub's HTTPS root.
 *
 * A token-bearing request never travels over plaintext, and a comma-separated
 * list is a selection the launcher has not made yet — both resolve to "not
 * configured" rather than to a guess.
 */
export function resolveHub(env: NodeJS.ProcessEnv = process.env): string {
	let hub = (env.HIVE_HUB ?? "").trim();
	if (!hub) hub = readHubFromContributorEnv(env);
	if (!hub || hub.includes(",")) return "";

	const http = hub.startsWith("wss://") ? `https://${hub.slice("wss://".length)}` : hub;
	if (!http.startsWith("https://")) return "";

	let parsed: URL;
	try {
		parsed = new URL(http);
	} catch {
		return "";
	}
	// A URL carrying user information is not a hub this tool will send a token to.
	if (!parsed.hostname || parsed.username || parsed.password) return "";

	// Registration names the websocket endpoint (`…/contribute`); the REST API
	// hangs off the root. Stripping the suffix is what makes a registered hub
	// reachable at all — without it every call 404s.
	return http.endsWith("/contribute") ? http.slice(0, -"/contribute".length) : http;
}

/** The launcher mounts the contributor registration; read the hub out of it. */
function readHubFromContributorEnv(env: NodeJS.ProcessEnv): string {
	const configHome = env.XDG_CONFIG_HOME || join(env.HOME ?? homedir(), ".config");
	try {
		const text = readFileSync(join(configHome, "hive", "contributor.env"), "utf8");
		for (const line of text.split("\n")) {
			const match = /^\s*(?:export\s+)?HIVE_HUB\s*=\s*(.*)$/.exec(line);
			if (!match) continue;
			return match[1]!.trim().replace(/^(['"])(.*)\1$/, "$2");
		}
	} catch {
		// Not registered with a hub. That is a supported way to run.
	}
	return "";
}

/**
 * The hub's bearer token is the maintainer's GitHub token.
 *
 * Requiring a second, separately exported credential is how a connected hub
 * reads as unreachable.
 */
export function resolveHiveToken(env: NodeJS.ProcessEnv = process.env): string {
	const direct = (env.GH_TOKEN || env.GITHUB_TOKEN || "").trim();
	if (direct) return direct;
	try {
		return execFileSync("gh", ["auth", "token"], {
			encoding: "utf8",
			timeout: 3000,
			stdio: ["ignore", "pipe", "ignore"],
		}).trim();
	} catch {
		return "";
	}
}

function toWorkItem(raw: unknown, level?: string): HiveWorkItem | undefined {
	if (!raw || typeof raw !== "object") return undefined;
	const record = raw as Record<string, unknown>;
	const repo = typeof record.repo === "string" ? record.repo : typeof record.repository === "string" ? record.repository : "";
	const number = typeof record.number === "number" ? record.number : Number.NaN;
	if (!repo || !Number.isInteger(number) || number < 1) return undefined;
	return {
		key: `${repo}#${number}`,
		repo,
		number,
		title: typeof record.title === "string" ? record.title : "",
		url: typeof record.url === "string" ? record.url : "",
		labels: Array.isArray(record.labels) ? record.labels.filter((label): label is string => typeof label === "string") : [],
		level,
	};
}

/** `{queue|items: [...]}`, or a bare list. */
function parseQueue(payload: unknown): HiveWorkItem[] {
	const list = Array.isArray(payload)
		? payload
		: payload && typeof payload === "object"
			? ((payload as Record<string, unknown>).queue ?? (payload as Record<string, unknown>).items)
			: undefined;
	if (!Array.isArray(list)) return [];
	return list.map((entry) => toWorkItem(entry)).filter((item): item is HiveWorkItem => item !== undefined);
}

/** `{groups|stages: [...]}`, each group carrying `issues|items`. */
function parseTriage(payload: unknown): { groups: HiveTriageGroup[]; items: HiveWorkItem[] } {
	const list = Array.isArray(payload)
		? payload
		: payload && typeof payload === "object"
			? ((payload as Record<string, unknown>).groups ??
				(payload as Record<string, unknown>).stages ??
				(payload as Record<string, unknown>).triage)
			: undefined;
	if (!Array.isArray(list)) return { groups: [], items: [] };

	const groups: HiveTriageGroup[] = [];
	const items: HiveWorkItem[] = [];
	for (const raw of list) {
		if (!raw || typeof raw !== "object") continue;
		const group = raw as Record<string, unknown>;
		const level = typeof group.level === "string" ? group.level : typeof group.name === "string" ? group.name : "";
		const nested = group.issues ?? group.items;
		if (Array.isArray(nested)) {
			for (const entry of nested) {
				const item = toWorkItem(entry, level);
				if (item) items.push(item);
			}
		}
		groups.push({
			level,
			label: typeof group.label === "string" ? group.label : level,
			count: typeof group.count === "number" ? group.count : Array.isArray(nested) ? nested.length : 0,
		});
	}
	return { groups, items };
}

/**
 * Hive's order, as a rank map.
 *
 * The ready queue comes first, then the triage groups; first mention wins. The
 * positions are Hive's, not ours — this function only records them.
 */
export function buildRankMap(queue: readonly HiveWorkItem[], triage: readonly HiveWorkItem[]): Map<string, number> {
	const ranks = new Map<string, number>();
	let rank = 0;
	for (const item of [...queue, ...triage]) {
		if (ranks.has(item.key)) continue;
		ranks.set(item.key, rank);
		rank += 1;
	}
	return ranks;
}

export interface HiveFetchOptions {
	env?: NodeJS.ProcessEnv;
	signal?: AbortSignal;
	fetchImpl?: typeof fetch;
	timeoutMs?: number;
}

/**
 * Read the hub. Never throws, never fatal.
 *
 * Consulting Hive must not be able to break a review session: an unreachable or
 * unauthorized hub degrades to local ordering with the reason attached, which is
 * the difference between "Hive says nothing is urgent" and "we could not ask".
 */
export async function fetchHive(options: HiveFetchOptions = {}): Promise<HiveSnapshot> {
	const env = options.env ?? process.env;
	const hub = resolveHub(env);
	if (!hub) return { ...EMPTY_HIVE, fetchedAt: Date.now() };

	const doFetch = options.fetchImpl ?? fetch;
	const token = resolveHiveToken(env);
	const headers: Record<string, string> = {
		Accept: "application/json",
		"User-Agent": "bluefin-review-omp",
	};
	if (token) headers.Authorization = `Bearer ${token}`;

	const get = async (path: string): Promise<unknown> => {
		const response = await doFetch(`${hub}${path}`, { headers, signal: options.signal, redirect: "error" });
		if (!response.ok) throw new Error(`${path} → ${response.status} ${response.statusText}`);
		return await response.json();
	};

	try {
		const [statusPayload, queuePayload, triagePayload] = await Promise.all([
			get("/api/v1/status").catch(() => get("/api/contribute/status")),
			get("/api/contribute/queue"),
			get("/api/contribute/triage"),
		]);

		const status = (statusPayload ?? {}) as Record<string, unknown>;
		const queue = parseQueue(queuePayload);
		const { groups, items: triageItems } = parseTriage(triagePayload);

		return {
			hub,
			configured: true,
			online: true,
			actionableItems: typeof status.actionable_items === "number" ? status.actionable_items : undefined,
			items: [...queue, ...triageItems],
			triage: groups,
			ranks: buildRankMap(queue, triageItems),
			fetchedAt: Date.now(),
		};
	} catch (error) {
		return {
			...EMPTY_HIVE,
			hub,
			configured: true,
			error: error instanceof Error ? error.message : String(error),
			fetchedAt: Date.now(),
		};
	}
}

/**
 * Authenticated GET to Hive's knowledge base markdown endpoint.
 */
export async function fetchHiveKnowledge(options: HiveFetchOptions = {}): Promise<string | undefined> {
	const env = options.env ?? process.env;
	const hub = resolveHub(env);
	if (!hub) return undefined;

	const doFetch = options.fetchImpl ?? fetch;
	const token = resolveHiveToken(env);
	const headers: Record<string, string> = {
		Accept: "text/markdown, text/plain",
		"User-Agent": "bluefin-review-omp",
	};
	if (token) headers.Authorization = `Bearer ${token}`;

	try {
		const response = await doFetch(`${hub}/api/v1/knowledge`, {
			headers,
			signal: options.signal,
			redirect: "error",
		});
		if (!response.ok) return undefined;
		return await response.text();
	} catch {
		return undefined;
	}
}

/**
 * Authenticated GET to /api/v1/me.
 */
export async function fetchHiveMe(options: HiveFetchOptions = {}): Promise<Record<string, unknown> | undefined> {
	const env = options.env ?? process.env;
	const hub = resolveHub(env);
	if (!hub) return undefined;

	const doFetch = options.fetchImpl ?? fetch;
	const token = resolveHiveToken(env);
	const headers: Record<string, string> = {
		Accept: "application/json",
		"User-Agent": "bluefin-review-omp",
	};
	if (token) headers.Authorization = `Bearer ${token}`;

	try {
		const response = await doFetch(`${hub}/api/v1/me`, {
			headers,
			signal: options.signal,
			redirect: "error",
		});
		if (!response.ok) return undefined;
		return (await response.json()) as Record<string, unknown>;
	} catch {
		return undefined;
	}
}
