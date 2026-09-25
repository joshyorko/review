import { createHash } from "node:crypto";
import { emptyLedger, type Ledger, type OperationReceipt, type RunId, type CriterionId } from "./model.ts";
import { criterionProven } from "./evidence.ts";

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
	operation?: OperationReceipt;
	operations: OperationReceipt[];
	proof?: { acceptanceRevision: string; subject: string; tree?: string; digest: string; artifacts: string[]; stage: OutcomeStage; reviewerSession: string };
	sessions: string[];
}
export interface Batch {
	version: 2;
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
		version: 2, id: options.id, revision: 0, selection: selectionIdentity(items), createdAt: new Date().toISOString(),
		mode: options.mode, control: "paused", capacity: options.capacity, maxAttempts: options.maxAttempts, maxTotalAttempts: options.maxTotalAttempts,
		dependencies, scopeRevisions: [], usage: { modelCalls: 0, peakWorkers: 0, inputTokens: null, outputTokens: null, cost: null },
		items: items.map((selected) => {
			const overlap = selected.overlaps.find((key) => items.some((item) => item.key === key));
			const blocker = selected.blocker ?? (overlap ? `overlapping selected work ${overlap}; resolve scope explicitly before execution` : undefined);
			const acceptanceReference = `Satisfy ${selected.key} acceptance @ ${selected.acceptanceRevision ?? "unresolved"}`;
			return {
				selected, stage: blocker ? "BLOCKED" : "QUEUED", blocker, attempts: 0, operation: undefined, operations: [], sessions: [],
				ledger: emptyLedger(`${options.id}:${digest(selected.key).slice(0, 16)}` as RunId, {
					statement: acceptanceReference, nonGoals: ["unselected work", "merge", "deploy", "publish"],
					permittedEffects: selected.action === "inspect" ? ["read"] : ["read", "write"],
					finishAuthority: selected.action, appetite: { tasks: 1, attemptsPerTask: options.maxAttempts },
				}, [{
					id: "A1" as CriterionId, statement: acceptanceReference, mandatory: true,
					...(selected.acceptanceRevision ? { assumptions: [{ kind: "acceptance-revision" as const, value: selected.acceptanceRevision }] } : {}),
				}], {
					repo: selected.repo,
					base: selected.base ?? "unavailable",
					...(selected.head === undefined ? {} : { head: selected.head }),
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
export function batchItemProofCurrent(item: BatchItem): boolean {
	const proof = item.proof;
	if (item.stage !== "DONE" || proof === undefined || proof.acceptanceRevision !== item.selected.acceptanceRevision || proof.subject !== item.selected.head) return false;
	return item.ledger.tasks.some((task) => task.state === "DONE" && criterionProven(item.ledger, task.criterionId));
}

export function batchConverged(batch: Batch): boolean {
	return batch.items.length > 0 && batch.scopeRevisions.length === 0 && batch.items.every((item) =>
		batchItemProofCurrent(item) && dependencyBlocker(batch, item.selected.key) === undefined,
	);
}
export function batchSummary(batch: Batch, root: string): string {
	const excluded = batch.items.filter((item) => item.stage === "EXCLUDED").length;
	const scope = batch.items.length - excluded;
	const proven = batch.items.filter(batchItemProofCurrent).length;
	const active = batch.items.filter((item) => ["QUEUED", "RUNNING", "VERIFY"].includes(item.stage)).length;
	const blocked = batch.items.filter((item) => item.stage === "BLOCKED").length;
	const unknown = batch.items.filter((item) => item.stage === "UNKNOWN" || (item.stage === "DONE" && !batchItemProofCurrent(item))).length;
	const cancelled = batch.items.filter((item) => item.stage === "CANCELLED").length;
	const lines = [
		`Factory ${batch.id}: ${batchConverged(batch) ? "CONVERGED" : batch.control} · ${proven}/${scope} proven · capacity ${batch.capacity}`,
		`Current scope: ${proven} proven · ${active} active · ${blocked} blocked · ${unknown} unknown/unresolved · ${cancelled} cancelled · ${excluded} excluded (${scope}/${batch.items.length} items)`,
		`State: ${root}; ${batch.mode === "once" ? "run once (unfinished work retained)" : "keep for resume"}. No detached service; process termination interrupts work.`,
		...batch.items.flatMap((item) => {
			const attempts = item.ledger.tasks.flatMap((task) => task.attempts.map((attempt) => ({ task, attempt })));
			const stage = item.stage === "DONE" && !batchItemProofCurrent(item) ? "UNKNOWN (stored proof is not current)" : item.stage;
			return [
				`${item.selected.key} ${item.selected.action}: ${stage}${item.blocker ? ` — ${item.blocker}` : ""}${item.workspace ? ` · ${item.workspace}` : ""}${item.operation ? ` · ${item.operation.phase} ${item.operation.state} (${item.operation.id})` : ""}`,
				...attempts.flatMap(({ task, attempt }) => {
					const identities: string[] = [];
					if (attempt.nativeJobIds.length > 0) identities.push(`  OMP task dispatch ${task.id}/${attempt.id}: ${attempt.nativeJobIds.join(", ")}`);
					if (attempt.nativeAgentIds.length > 0) identities.push(`  OMP agent identity (start observed; liveness not inferred) ${task.id}/${attempt.id}: ${attempt.nativeAgentIds.join(", ")}`);
					identities.push(...attempt.privateSessions.map((session) =>
						`  Factory-private ${session.phase} session ${task.id}/${attempt.id} (${session.started ? "turn start observed; liveness not inferred" : "identity recorded; turn start not observed"}): ${session.sessionFile}`,
					));
					const semantic = attempt.receipt?.semanticResult;
					if (semantic) {
						identities.push(`  Semantic result ${task.id}/${attempt.id}: ${semantic.outcome}; verified ${semantic.verified}; publication authority none`);
						if (semantic.publicationBlocker) identities.push(`  Publication/disclosure blocker: ${semantic.publicationBlocker}`);
					}
					return identities;
				}),
			];
		}),
		...(batch.scopeRevisions.length ? [`Original scope NOT converged: ${batch.scopeRevisions.map((entry) => `${entry.item}: ${entry.reason}`).join("; ")}`] : []),
		"Factory-private SDK sessions are not globally registered OMP agents and do not appear in Ctrl+A.",
		`Usage: ${batch.usage.modelCalls} observed model calls; tokens/cost ${batch.usage.cost === null ? "unknown" : batch.usage.cost}. Stop-dispatch limits do not bound in-flight cost.`,
		`/factory resume ${batch.id} · /factory inspect ${batch.id} · /factory pause ${batch.id} · /factory stop ${batch.id}`,
	];
	return lines.join("\n");
}
