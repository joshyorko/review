import { createHash } from "node:crypto";
import { emptyLedger, type Ledger, type RunId, type CriterionId } from "./model.ts";

export type FactoryAction = "inspect" | "patch" | "pr-ready";
export type OutcomeStage = "verified-patch" | "pr-ready" | "merged-upstream";
export interface SelectedItem {
	key: string;
	repo: string;
	number: number;
	kind: "issue" | "pr" | "unknown";
	action: FactoryAction;
	repositoryId?: string;
	itemId?: string;
	acceptanceRevision?: string;
	acceptance?: string;
	base?: string;
	baseRef?: string;
	head?: string;
	url?: string;
	overlaps: string[];
	blocker?: string;
}
export interface Prerequisite { item: string; requires: string; stage: OutcomeStage }
export interface BatchItem {
	selected: SelectedItem;
	ledger: Ledger;
	stage: "QUEUED" | "RUNNING" | "VERIFY" | "DONE" | "BLOCKED" | "UNKNOWN" | "CANCELLED" | "EXCLUDED";
	blocker?: string;
	workspace?: string;
	attempts: number;
	operation?: { id: string; phase: "worker" | "verify" | "acceptance" | "push" | "pr"; state: "intent" | "confirmed" | "unknown"; branch?: string; sha?: string; url?: string };
	proof?: { acceptanceRevision: string; subject: string; tree?: string; digest: string; artifacts: string[]; stage: OutcomeStage; reviewerSession: string };
	sessions: string[];
}
export interface Batch {
	version: 1;
	id: string;
	revision: number;
	selection: string;
	createdAt: string;
	mode: "once" | "retain";
	control: "paused" | "active" | "stopped";
	capacity: number;
	maxAttempts: number;
	maxTotalAttempts: number;
	items: BatchItem[];
	dependencies: Prerequisite[];
	scopeRevisions: { item: string; reason: string; at: string }[];
	usage: { modelCalls: number; peakWorkers: number; inputTokens: number | null; outputTokens: number | null; cost: number | null };
}
export function digest(value: string): string { return createHash("sha256").update(value).digest("hex"); }
export function selectionIdentity(items: readonly SelectedItem[]): string {
	return digest(JSON.stringify(items.map(({ repo, number, action }) => ({ key: `${repo.toLowerCase()}#${number}`, action })).sort((a, b) => a.key.localeCompare(b.key))));
}
export function validateDependencies(items: readonly SelectedItem[], dependencies: readonly Prerequisite[]): void {
	const keys = new Set(items.map((item) => item.key));
	const visiting = new Set<string>();
	const visited = new Set<string>();
	for (const edge of dependencies) {
		if (!keys.has(edge.item) || !keys.has(edge.requires)) throw new Error(`missing prerequisite: ${edge.item} requires ${edge.requires}`);
		if (!["verified-patch", "pr-ready", "merged-upstream"].includes(edge.stage)) throw new Error("unknown prerequisite stage");
	}
	function visit(key: string): void {
		if (visiting.has(key)) throw new Error(`dependency cycle at ${key}`);
		if (visited.has(key)) return;
		visiting.add(key);
		for (const edge of dependencies.filter((edge) => edge.item === key)) visit(edge.requires);
		visiting.delete(key);
		visited.add(key);
	}
	for (const key of keys) visit(key);
}
export function createBatch(items: SelectedItem[], options: { id: string; capacity: number; maxAttempts: number; maxTotalAttempts: number; mode: "once" | "retain"; dependencies?: Prerequisite[] }): Batch {
	if (!items.length || items.length > 100) throw new Error("select between 1 and 100 explicit items");
	items = structuredClone(items);
	for (const item of items) {
		if (!/^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.test(item.repo) || !Number.isSafeInteger(item.number) || item.number < 1 || !["inspect", "patch", "pr-ready"].includes(item.action) || !["issue", "pr", "unknown"].includes(item.kind) || !Array.isArray(item.overlaps)) throw new Error("invalid selected identity/action; explicitly resolve selection");
		const key = `${item.repo.toLowerCase()}#${item.number}`;
		if (item.key.toLowerCase() !== key) throw new Error("selected key does not match repository/item identity");
		item.repo = item.repo.toLowerCase(); item.key = key;
		item.overlaps = item.overlaps.map((overlap) => overlap.toLowerCase());
	}
	if (new Set(items.map((item) => item.key)).size !== items.length) throw new Error("duplicate selected identity");
	if (options.mode !== "once" && options.mode !== "retain") throw new Error("unsupported lifetime mode");
	for (const [name, value] of Object.entries({ capacity: options.capacity, maxAttempts: options.maxAttempts, maxTotalAttempts: options.maxTotalAttempts })) {
		if (!Number.isSafeInteger(value) || value < 1 || value > 1000) throw new Error(`${name} must be a positive bounded integer`);
	}
	const dependencies = (options.dependencies ?? []).map((edge) => ({ ...edge, item: edge.item.toLowerCase(), requires: edge.requires.toLowerCase() }));
	validateDependencies(items, dependencies);
	return {
		version: 1, id: options.id, revision: 0, selection: selectionIdentity(items), createdAt: new Date().toISOString(),
		mode: options.mode, control: "paused", capacity: options.capacity, maxAttempts: options.maxAttempts, maxTotalAttempts: options.maxTotalAttempts,
		dependencies, scopeRevisions: [], usage: { modelCalls: 0, peakWorkers: 0, inputTokens: null, outputTokens: null, cost: null },
		items: items.map((selected) => {
			const overlap = selected.overlaps.find((key) => items.some((item) => item.key === key));
			const blocker = selected.blocker ?? (overlap ? `overlapping selected work ${overlap}; resolve scope explicitly before execution` : undefined);
			return {
				selected, stage: blocker ? "BLOCKED" : "QUEUED", blocker, attempts: 0, sessions: [],
				ledger: emptyLedger(`${options.id}:${digest(selected.key).slice(0, 16)}` as RunId, {
					statement: selected.acceptance ?? selected.key, nonGoals: ["unselected work", "merge", "deploy", "publish"],
					permittedEffects: selected.action === "inspect" ? ["read"] : ["read", "write"],
					finishAuthority: selected.action, appetite: { tasks: 1, attemptsPerTask: options.maxAttempts },
				}, [{ id: "A1" as CriterionId, statement: selected.acceptance ?? selected.key, mandatory: true }], {
					repo: selected.repo, base: selected.base ?? "unavailable", head: selected.head,
				}),
			};
		}),
	};
}
export function dependencyBlocker(batch: Batch, key: string): string | undefined {
	for (const edge of batch.dependencies.filter((edge) => edge.item === key)) {
		const prerequisite = batch.items.find((item) => item.selected.key === edge.requires);
		if (!prerequisite) return `missing prerequisite ${edge.requires}`;
		const proof = prerequisite.proof;
		const stages: OutcomeStage[] = ["verified-patch", "pr-ready", "merged-upstream"];
		if (prerequisite.stage !== "DONE" || !proof || proof.acceptanceRevision !== prerequisite.selected.acceptanceRevision || proof.subject !== prerequisite.selected.head || stages.indexOf(proof.stage) < stages.indexOf(edge.stage)) {
			return `${edge.requires} must reach ${edge.stage}${edge.stage === "merged-upstream" ? "; human/Review landing required" : ""}`;
		}
	}
	return undefined;
}
export function batchConverged(batch: Batch): boolean {
	return batch.items.length > 0 && batch.scopeRevisions.length === 0 && batch.items.every((item) => item.stage === "DONE" && item.proof !== undefined && item.proof.acceptanceRevision === item.selected.acceptanceRevision && item.proof.subject === item.selected.head && dependencyBlocker(batch, item.selected.key) === undefined);
}
export function batchSummary(batch: Batch, root: string): string {
	const done = batch.items.filter((item) => item.stage === "DONE").length;
	const lines = [
		`Factory ${batch.id}: ${batchConverged(batch) ? "CONVERGED" : batch.control} · ${done}/${batch.items.length} proven · capacity ${batch.capacity}`,
		`State: ${root}; ${batch.mode === "once" ? "run once (unfinished work retained)" : "keep for resume"}. No detached service; process termination interrupts work.`,
		...batch.items.flatMap((item) => {
			const attempts = item.ledger.tasks.flatMap((task) => task.attempts.map((attempt) => ({ task, attempt })));
			return [
				`${item.selected.key} ${item.selected.action}: ${item.stage}${item.blocker ? ` — ${item.blocker}` : ""}${item.workspace ? ` · ${item.workspace}` : ""}${item.operation ? ` · ${item.operation.phase} ${item.operation.state} (${item.operation.id})` : ""}${item.operation?.url ? ` · ${item.operation.url}` : ""}`,
				...attempts.flatMap(({ task, attempt }) => attempt.privateSessions.map((session) => `  Factory-private ${session.phase} session ${task.id}/${attempt.id}: ${session.sessionFile}`)),
			];
		}),
		...(batch.scopeRevisions.length ? [`Original scope NOT converged: ${batch.scopeRevisions.map((entry) => `${entry.item}: ${entry.reason}`).join("; ")}`] : []),
		"Factory-private SDK sessions are not globally registered OMP agents and do not appear in Ctrl+A.",
		`Usage: ${batch.usage.modelCalls} observed model calls; tokens/cost ${batch.usage.cost === null ? "unknown" : batch.usage.cost}. Stop-dispatch limits do not bound in-flight cost.`,
		`/factory resume ${batch.id} · /factory inspect ${batch.id} · /factory pause ${batch.id} · /factory stop ${batch.id}`,
	];
	return lines.join("\n");
}
