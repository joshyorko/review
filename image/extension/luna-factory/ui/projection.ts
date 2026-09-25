/**
 * Pure, read-only projection of a persisted Factory batch.
 *
 * The dashboard is a view over BatchStore/BatchService state. It deliberately
 * has no host, clock, model, or mutation path. In particular, this module does
 * not decide proof or convergence: those answers come from the core helpers.
 */

import {
	batchConverged,
	batchItemProofCurrent,
	dependencyBlocker,
	type Batch,
	type BatchItem,
	type OutcomeStage,
} from "../core/batch.ts";
import type {
	Attempt,
	EvidenceReceipt,
	OperationReceipt,
	PredicateEvidence,
	SemanticResult,
} from "../core/model.ts";
import type { ResourceClaim } from "../omp/batch-store.ts";

export interface ProjectionOptions {
	/** Omit all actions that would change Factory state. */
	readonly readOnly?: boolean;
	/** A snapshot of host-wide claims, if the caller has read one. */
	readonly claims?: readonly ResourceClaim[];
	/** Current in-process item identities, when the owning service can provide them. */
	readonly activeItemKeys?: readonly string[];
	/** Other retained batches, used only to guard destructive discard visibility. */
	readonly retainedBatches?: readonly Batch[];
}

export type ProjectedStage = BatchItem["stage"];
export type ProjectionGlyph = "✓" | "▶" | "◆" | "○" | "!" | "?" | "×";
export type ProjectionAction =
	| "inspect"
	| "evidence"
	| "reconcile"
	| "retry"
	| "exclude"
	| "open-pr"
	| "open-workspace"
	| "view-session"
	| "pause"
	| "resume"
	| "stop"
	| "export"
	| "discard";

export interface ProjectedPredicate {
	readonly phase: PredicateEvidence["phase"];
	readonly item: string;
	readonly ok: boolean;
	readonly note: string;
}

export interface ProjectedTest {
	readonly command: string;
	readonly outcome: EvidenceReceipt["tests"][number]["outcome"];
	readonly artifact?: string;
}

export interface ProjectedSemanticResult extends SemanticResult {
	readonly attemptId: string;
}

export interface ProjectedSession {
	readonly phase: "worker" | "acceptance";
	readonly path: string;
	readonly started: boolean;
	/** This records a turn-start observation; it does not claim current liveness. */
	readonly observation: "turn-start-observed" | "identity-recorded-turn-start-unknown";
}

export interface ProjectedAttempt {
	readonly id: string;
	readonly lineage: number;
	readonly state: Attempt["state"];
	readonly subject: string;
	readonly integrated: boolean;
	readonly nativeJobIds: readonly string[];
	readonly nativeAgentIds: readonly string[];
	readonly sessions: readonly ProjectedSession[];
	readonly observedExecution: boolean;
	readonly routing?: {
		readonly requested: string;
		readonly effective: string;
		readonly effort: string;
		readonly verified: boolean;
	};
	readonly evidence: readonly string[];
	readonly tests: readonly ProjectedTest[];
	readonly predicates: readonly ProjectedPredicate[];
	readonly semanticResult?: ProjectedSemanticResult;
}

export interface ProjectedProof {
	readonly current: boolean;
	readonly acceptanceRevision: string;
	readonly subject: string;
	readonly tree?: string;
	readonly digest: string;
	readonly stage: OutcomeStage | "unknown";
	readonly artifacts: readonly string[];
	readonly reviewerSession: string;
}

export interface ProjectedOperation {
	readonly id: string;
	readonly phase: OperationReceipt["phase"];
	readonly effect: OperationReceipt["effect"];
	readonly state: OperationReceipt["state"];
	readonly owner?: string;
	readonly attemptId?: string;
	readonly branch?: string;
	readonly sha?: string;
	readonly url?: string;
	readonly resultHandle?: string;
}

export interface ProjectedClaim {
	readonly resource: string;
	readonly owner: string;
	readonly status: ResourceClaim["status"];
	readonly conflict: boolean;
}

export interface ProjectedItem {
	readonly key: string;
	readonly repo: string;
	readonly number: number;
	readonly action: BatchItem["selected"]["action"];
	readonly stage: ProjectedStage;
	readonly storedStage: BatchItem["stage"];
	readonly glyph: ProjectionGlyph;
	readonly summary: string;
	readonly nextSafeAction: string;
	readonly blocker?: string;
	readonly dependencyBlocker?: string;
	readonly dependencies: readonly { readonly requires: string; readonly stage: OutcomeStage; readonly satisfied: boolean }[];
	readonly proof: ProjectedProof;
	readonly evidence: readonly string[];
	readonly evidenceRefs: readonly string[];
	readonly predicates: readonly ProjectedPredicate[];
	readonly tests: readonly ProjectedTest[];
	readonly semanticResults: readonly ProjectedSemanticResult[];
	readonly attempts: number;
	readonly maxAttempts: number;
	readonly attemptHistory: readonly ProjectedAttempt[];
	readonly operations: readonly ProjectedOperation[];
	readonly operation?: ProjectedOperation;
	readonly sessions: readonly string[];
	readonly workspace?: string;
	readonly prUrl?: string;
	readonly claims: readonly ProjectedClaim[];
	readonly actions: readonly ProjectionAction[];
	readonly executionLiveness: "active" | "unknown" | "not-running";
	/** Detail is intentionally plain text so narrow and wide UIs can reuse it. */
	readonly detail: readonly string[];
}

export interface ProjectedUsage {
	readonly modelCalls: number;
	readonly peakWorkers: number;
	readonly inputTokens: number | "unknown";
	readonly outputTokens: number | "unknown";
	readonly cost: number | "unknown";
}

export interface ProjectedBatch {
	readonly id: string;
	readonly control: Batch["control"];
	readonly converged: boolean;
	readonly proven: number;
	readonly total: number;
	readonly inScope: number;
	readonly running: number;
	readonly blocked: number;
	readonly unknown: number;
	readonly capacity: number;
	readonly attempts: number;
	readonly maxAttempts: number;
	readonly maxTotalAttempts: number;
	readonly usage: ProjectedUsage;
	readonly items: readonly ProjectedItem[];
	readonly actions: readonly ProjectionAction[];
}

const GLYPHS: Record<ProjectedStage, ProjectionGlyph> = {
	DONE: "✓",
	RUNNING: "▶",
	VERIFY: "◆",
	QUEUED: "○",
	BLOCKED: "!",
	UNKNOWN: "?",
	CANCELLED: "×",
	EXCLUDED: "×",
};

function subjectText(subject: { readonly repo: string; readonly base: string; readonly head?: string }): string {
	return `${subject.repo}@${subject.head ?? subject.base}`;
}

function projectedOperation(operation: OperationReceipt): ProjectedOperation {
	return {
		id: operation.id,
		phase: operation.phase,
		effect: operation.effect,
		state: operation.state,
		...(operation.owner === undefined ? {} : { owner: operation.owner }),
		...(operation.attemptId === undefined ? {} : { attemptId: operation.attemptId }),
		...(operation.branch === undefined ? {} : { branch: operation.branch }),
		...(operation.sha === undefined ? {} : { sha: operation.sha }),
		...(operation.url === undefined ? {} : { url: operation.url }),
		...(operation.resultHandle === undefined ? {} : { resultHandle: operation.resultHandle }),
	};
}

function receiptRows(receipt: EvidenceReceipt | undefined): {
	readonly evidence: readonly string[];
	readonly tests: readonly ProjectedTest[];
	readonly predicates: readonly ProjectedPredicate[];
	readonly semantic?: SemanticResult;
	readonly routing?: EvidenceReceipt["routing"];
} {
	if (receipt === undefined) return { evidence: [], tests: [], predicates: [] };
	return {
		evidence: [...receipt.evidence],
		tests: receipt.tests.map((claim) => ({ ...claim })),
		predicates: (receipt.predicates ?? []).map((predicate) => ({ ...predicate })),
		...(receipt.semanticResult === undefined ? {} : { semantic: receipt.semanticResult }),
		routing: receipt.routing,
	};
}

function attemptsFor(item: BatchItem): Array<{ readonly taskId: string; readonly attempt: Attempt }> {
	return item.ledger.tasks.flatMap((task) => task.attempts.map((attempt) => ({ taskId: task.id, attempt })));
}

function projectedAttempt(taskId: string, attempt: Attempt): ProjectedAttempt {
	const rows = receiptRows(attempt.receipt);
	const sessions = attempt.privateSessions.map((session) => ({
		phase: session.phase,
		path: session.sessionFile,
		started: session.started,
		observation: session.started ? "turn-start-observed" as const : "identity-recorded-turn-start-unknown" as const,
	}));
	const routing = rows.routing === undefined ? undefined : {
		requested: rows.routing.requested ?? "unknown",
		effective: rows.routing.verified ? (rows.routing.effective ?? "unknown") : "unknown",
		effort: rows.routing.verified ? (rows.routing.effort ?? "unknown") : "unknown",
		verified: rows.routing.verified,
	};
	return {
		id: attempt.id,
		lineage: attempt.lineage,
		state: attempt.state,
		subject: subjectText(attempt.subject),
		integrated: attempt.integrated,
		nativeJobIds: [...attempt.nativeJobIds].map(String),
		nativeAgentIds: [...attempt.nativeAgentIds].map(String),
		sessions,
		observedExecution: attempt.nativeAgentIds.length > 0 || sessions.some((session) => session.started),
		...(routing === undefined ? {} : { routing }),
		evidence: rows.evidence,
		tests: rows.tests,
		predicates: rows.predicates,
		...(rows.semantic === undefined ? {} : { semanticResult: { ...rows.semantic, attemptId: attempt.id } }),
	};
}

function claimSnapshot(batch: Batch, item: BatchItem, claims: readonly ResourceClaim[] | undefined): ProjectedClaim[] {
	if (claims === undefined) return [];
	const resources = new Set([`item:${item.selected.key}`.toLowerCase(), `repo:${item.selected.repo}`.toLowerCase()]);
	const owner = `${batch.id}:${item.selected.key}`;
	return claims
		.filter((claim) => resources.has(claim.resource.toLowerCase()))
		.sort((left, right) => left.resource.localeCompare(right.resource))
		.map((claim) => ({ ...claim, conflict: item.selected.action !== "inspect" && claim.owner !== owner }));
}

function externalEffect(item: BatchItem): boolean {
	return item.operation?.phase === "push" || item.operation?.phase === "pr";
}

function unique(values: readonly string[]): string[] {
	return [...new Set(values)];
}

function retryEligible(
	batch: Batch,
	item: BatchItem,
	stage: ProjectedStage,
	dependency: string | undefined,
	claims: readonly ProjectedClaim[],
	readOnly: boolean,
): boolean {
	if (readOnly || item.selected.action === "inspect" || dependency !== undefined || item.stage === "DONE" || item.stage === "EXCLUDED") return false;
	if (externalEffect(item) || claims.some((claim) => claim.conflict || claim.status === "unknown")) return false;
	if (item.ledger.tasks.some((task) => task.state === "DONE")) return false;
	if (!(item.stage === "BLOCKED" || item.stage === "CANCELLED" || item.stage === "UNKNOWN" || item.stage === "QUEUED")) return false;
	if (stage === "DONE" || stage === "EXCLUDED") return false;
	if (item.attempts >= batch.maxAttempts) return false;
	if (batch.items.reduce((total, candidate) => total + candidate.attempts, 0) >= batch.maxTotalAttempts) return false;
	return true;
}

function blockerFor(item: BatchItem, dependency: string | undefined, claims: readonly ProjectedClaim[]): string | undefined {
	if (item.selected.action !== "inspect" && claims.some((claim) => claim.conflict || claim.status === "unknown")) {
		const conflict = claims.find((claim) => claim.conflict || claim.status === "unknown")!;
		return `${conflict.resource} is claimed by ${conflict.owner} (${conflict.status}); reconcile ownership before resuming`;
	}
	if (dependency !== undefined) return dependency;
	if (item.blocker !== undefined) return item.blocker;
	if (item.stage === "DONE" && !batchItemProofCurrent(item)) return "stored DONE proof is stale or unavailable";
	return undefined;
}

function nextSafeAction(
	batch: Batch,
	item: BatchItem,
	stage: ProjectedStage,
	dependency: string | undefined,
	claims: readonly ProjectedClaim[],
	readOnly: boolean,
	active: boolean,
): string {
	if (item.stage === "DONE" && !batchItemProofCurrent(item)) return "stored DONE proof is stale; reverify proof; retry unavailable";
	if (stage === "DONE") {
		if (item.selected.action === "inspect" || item.proof?.stage === "merged-upstream") return "no action required";
		return item.proof?.stage === "pr-ready" ? "human review and landing required; inspect the recorded PR" : "owner integration required for verified-patch";
	}
	if (item.stage === "EXCLUDED") return "scope revision recorded; no execution";
	if (externalEffect(item) && (item.operation?.state === "unknown" || item.operation?.state === "intent" || stage === "UNKNOWN")) return readOnly ? "inspect external effect; reconciliation required; retry unavailable" : "reconcile external effect; retry unavailable";
	if (item.selected.action !== "inspect" && claims.some((claim) => claim.conflict)) return "inspect ownership / reconcile claim before resuming";
	if (stage === "RUNNING") return active ? "wait for the observed worker; inspect execution evidence" : "inspect recorded execution; current worker liveness is unknown";
	if (stage === "VERIFY") return active ? "wait for verification / independent acceptance; inspect evidence" : "inspect verification evidence and the resumption condition";
	if (item.selected.action !== "inspect" && claims.some((claim) => claim.status === "unknown")) return "inspect ownership / reconcile claim before resuming";
	if (dependency !== undefined) return `wait for ${dependency}`;
	if (item.attempts >= batch.maxAttempts || batch.items.reduce((total, candidate) => total + candidate.attempts, 0) >= batch.maxTotalAttempts) return "original attempt budget exhausted; no retry";
	const retry = retryEligible(batch, item, stage, dependency, claims, readOnly);
	if (stage === "UNKNOWN") return retry ? "inspect retained work, then retry within original budget" : "inspect retained work and reconcile its outcome; retry unavailable";
	if (stage === "BLOCKED" && retry) return "retry item within original budget";
	if (stage === "QUEUED") return readOnly ? "inspect queued work; execution controls unavailable in this context" : batch.control === "paused" ? "resume the batch when ready to dispatch" : "wait for Factory dispatch";
	if (stage === "CANCELLED") return retry ? "explicitly retry after inspecting retained work" : "inspect retained work; retry unavailable in this context";
	return item.blocker ?? "inspect Factory evidence";
}

function detailRows(
	batch: Batch,
	item: BatchItem,
	stage: ProjectedStage,
	proof: ProjectedProof,
	dependency: string | undefined,
	claims: readonly ProjectedClaim[],
	attemptHistory: readonly ProjectedAttempt[],
	operations: readonly ProjectedOperation[],
	readOnly: boolean,
): string[] {
	const rows = [
		`identity: ${item.selected.key} · action ${item.selected.action} · stage ${stage}`,
		`subject: ${item.ledger.subject.repo}@${item.ledger.subject.head ?? item.ledger.subject.base}`,
		`captured base/head: ${item.selected.base ?? "unknown"} / ${item.selected.head ?? "unknown"}`,
		`acceptance: ${item.selected.acceptance ?? item.ledger.goal.statement}`,
		`acceptance revision: ${item.selected.acceptanceRevision ?? "unknown"}`,
		`model: ${attemptHistory.at(-1)?.routing?.effective ?? "unknown"} · effort: ${attemptHistory.at(-1)?.routing?.effort ?? "unknown"}`,
		`attempts: ${item.attempts}/${batch.maxAttempts} · original batch budget ${batch.items.reduce((total, candidate) => total + candidate.attempts, 0)}/${batch.maxTotalAttempts}`,
		`proof: ${proof.current ? "current" : "stale or unavailable"}${proof.stage ? ` · ${proof.stage}` : ""}`,
		`proof subject: ${proof.subject || "unknown"}`,
		`proof artifacts: ${proof.artifacts.length ? proof.artifacts.join(", ") : "none"}`,
	];
	if (item.workspace !== undefined) rows.push(`workspace: ${item.workspace}`);
	if (item.operation !== undefined) rows.push(`operation: ${item.operation.phase} ${item.operation.state} · ${item.operation.id}`);
	if (dependency !== undefined) rows.push(`dependency blocker: ${dependency}`);
	if (item.blocker !== undefined) rows.push(`blocker: ${item.blocker}`);
	if (claims.length > 0) for (const claim of claims) rows.push(`claim ${claim.resource}: ${claim.owner} · ${claim.status}${claim.conflict ? " · conflict" : ""}`);
	if (item.selected.url !== undefined) rows.push(`source URL: ${item.selected.url}`);
	for (const attempt of attemptHistory) {
		rows.push(`attempt ${attempt.id} lineage ${attempt.lineage}: ${attempt.state} · ${attempt.subject}${attempt.integrated ? " · integrated" : ""}`);
		rows.push(`  native jobs: ${attempt.nativeJobIds.length ? `${attempt.nativeJobIds.join(", ")} (observed)` : "unknown"}`);
		rows.push(`  native agents: ${attempt.nativeAgentIds.length ? `${attempt.nativeAgentIds.join(", ")} (start observed; liveness not inferred)` : "unknown"}`);
		for (const session of attempt.sessions) rows.push(`  ${session.phase} session: ${session.path} · ${session.observation}`);
		if (attempt.routing !== undefined) rows.push(`  routing: requested ${attempt.routing.requested} · effective ${attempt.routing.effective} · effort ${attempt.routing.effort}`);
		for (const test of attempt.tests) rows.push(`  test ${test.outcome}: ${test.command}${test.artifact === undefined ? "" : ` · ${test.artifact}`}`);
		for (const predicate of attempt.predicates) rows.push(`  predicate ${predicate.phase} ${predicate.ok ? "PASS" : "FAIL"}: ${predicate.item} — ${predicate.note}`);
		if (attempt.semanticResult !== undefined) {
			rows.push(`  semantic result: ${attempt.semanticResult.outcome} · verified ${attempt.semanticResult.verified} · publication authority none`);
			if (attempt.semanticResult.publicationBlocker !== undefined) rows.push(`  publication/disclosure blocker: ${attempt.semanticResult.publicationBlocker}`);
		}
	}
	for (const operation of operations) rows.push(`operation history: ${operation.phase} ${operation.state} · ${operation.id}`);
	if (readOnly) rows.push("dashboard context: inspect-only; state-changing actions omitted");
	return rows;
}

function exportEligible(batch: Batch): boolean {
	return !batch.items.some((item) => item.stage === "RUNNING" || item.stage === "VERIFY" || item.operation?.state === "intent");
}

function discardEligible(batch: Batch, options: ProjectionOptions): boolean {
	if (batch.items.length === 0) return false;
	if (options.claims !== undefined) {
		const resources = new Set(batch.items.flatMap((item) => [`item:${item.selected.key}`, `repo:${item.selected.repo}`].map((resource) => resource.toLowerCase())));
		if (options.claims.some((claim) => resources.has(claim.resource.toLowerCase()) && (claim.status === "unknown" || (!claim.owner.startsWith(`${batch.id}:`) && claim.owner !== batch.id)))) return false;
	}
	if (batch.items.some((item) => item.stage !== "DONE" || !batchItemProofCurrent(item) || item.operation?.state === "unknown" || item.proof?.stage === "verified-patch")) return false;
	const keys = new Set(batch.items.map((item) => item.selected.key));
	return !(options.retainedBatches ?? []).some((other) => other.id !== batch.id && other.dependencies.some((edge) => keys.has(edge.requires)));
}

/** Project one persisted item without performing any Factory action. */
export function projectItem(batch: Batch, item: BatchItem, options: ProjectionOptions = {}): ProjectedItem {
	const proofCurrent = batchItemProofCurrent(item);
	const storedStage = item.stage;
	const stage: ProjectedStage = storedStage === "DONE" && !proofCurrent ? "UNKNOWN" : storedStage;
	const dependency = dependencyBlocker(batch, item.selected.key);
	const dependencies = batch.dependencies
		.filter((edge) => edge.item === item.selected.key)
		.map((edge) => ({
			requires: edge.requires,
			stage: edge.stage,
			// Ask the authoritative helper about this edge alone. The aggregate
			// blocker intentionally reports only the first unmet prerequisite.
			satisfied: dependencyBlocker({ ...batch, dependencies: [edge] }, item.selected.key) === undefined,
		}));
	const claims = claimSnapshot(batch, item, options.claims);
	const blocker = blockerFor(item, dependency, claims);
	const attemptEntries = attemptsFor(item);
	const attemptHistory = attemptEntries.map(({ taskId, attempt }) => projectedAttempt(taskId, attempt));
	const receipts = attemptEntries.flatMap(({ attempt }) => attempt.receipt === undefined ? [] : [attempt.receipt]);
	const evidence = unique([
		...receipts.flatMap((receipt) => receipt.evidence),
		...(item.proof?.artifacts ?? []),
	]);
	const predicates = attemptHistory.flatMap((attempt) => attempt.predicates);
	const tests = attemptHistory.flatMap((attempt) => attempt.tests);
	const semanticResults = attemptHistory.flatMap((attempt) => attempt.semanticResult === undefined ? [] : [attempt.semanticResult]);
	const proof: ProjectedProof = {
		current: proofCurrent,
		acceptanceRevision: item.proof?.acceptanceRevision ?? item.selected.acceptanceRevision ?? "unknown",
		subject: item.proof?.subject ?? item.selected.head ?? item.selected.base ?? "unknown",
		digest: item.proof?.digest ?? "unknown",
		stage: item.proof?.stage ?? "unknown",
		artifacts: [...(item.proof?.artifacts ?? [])],
		reviewerSession: item.proof?.reviewerSession ?? "unknown",
		...(item.proof?.tree === undefined ? {} : { tree: item.proof.tree }),
	};
	const historicalOperations = item.operations.map(projectedOperation);
	const currentOperation = item.operation === undefined ? undefined : projectedOperation(item.operation);
	const operationMap = new Map(historicalOperations.map((operation) => [operation.id, operation]));
	if (currentOperation !== undefined) operationMap.set(currentOperation.id, currentOperation);
	const operations = [...operationMap.values()];
	const historyForDetails = historicalOperations.filter((operation) => currentOperation === undefined || operation.id !== currentOperation.id);
	const prUrl = [
		...(item.operation === undefined ? [] : [item.operation]),
		...item.operations.slice().reverse(),
	].find((operation) => operation.phase === "pr" && operation.url !== undefined)?.url
		?? (item.selected.kind === "pr" ? item.selected.url : undefined);
	const actions: ProjectionAction[] = ["inspect"];
	if (evidence.length > 0) actions.push("evidence");
	if (!options.readOnly && externalEffect(item) && (item.operation?.state === "unknown" || item.operation?.state === "intent" || stage === "UNKNOWN")) actions.push("reconcile");
	if (item.workspace !== undefined) actions.push("open-workspace");
	if (prUrl !== undefined) actions.push("open-pr");
	if (attemptHistory.some((attempt) => attempt.sessions.length > 0) || item.sessions.length > 0) actions.push("view-session");
	if (retryEligible(batch, item, stage, dependency, claims, options.readOnly === true)) actions.push("retry");
	const uncertainOperation = item.operation !== undefined && ["unknown", "intent"].includes(item.operation.state);
	if (!options.readOnly && item.selected.action !== "inspect" && ["BLOCKED", "QUEUED", "CANCELLED"].includes(item.stage) && !uncertainOperation) actions.push("exclude");
	const next = nextSafeAction(batch, item, stage, dependency, claims, options.readOnly === true, options.activeItemKeys?.includes(item.selected.key) === true);
	const details = detailRows(batch, item, stage, proof, dependency, claims, attemptHistory, historyForDetails, options.readOnly === true);
	const activeKeys = options.activeItemKeys?.map((key) => key.toLowerCase());
	const executionLiveness = stage !== "RUNNING"
		? "not-running" as const
		: activeKeys === undefined
			? "unknown" as const
			: activeKeys.includes(item.selected.key.toLowerCase()) ? "active" as const : "unknown" as const;
	return {
		key: item.selected.key,
		repo: item.selected.repo,
		number: item.selected.number,
		action: item.selected.action,
		stage,
		storedStage,
		glyph: GLYPHS[stage],
		summary: `${item.selected.key} ${stage}${blocker === undefined ? "" : ` — ${blocker}`}`,
		nextSafeAction: next,
		...(blocker === undefined ? {} : { blocker }),
		...(dependency === undefined ? {} : { dependencyBlocker: dependency }),
		proof,
		evidence,
		evidenceRefs: evidence,
		predicates,
		tests,
		semanticResults,
		attempts: item.attempts,
		maxAttempts: batch.maxAttempts,
		attemptHistory,
		operations,
		...(item.operation === undefined ? {} : { operation: projectedOperation(item.operation) }),
		sessions: [...item.sessions],
		...(item.workspace === undefined ? {} : { workspace: item.workspace }),
		...(prUrl === undefined ? {} : { prUrl }),
		claims,
		actions,
		executionLiveness,
		detail: details,
		dependencies,
	};
}

/** Project a retained or active batch in stable item-key order. */
export function projectBatch(batch: Batch, options: ProjectionOptions = {}): ProjectedBatch {
	const items = [...batch.items]
		.sort((left, right) => left.selected.key.localeCompare(right.selected.key))
		.map((item) => projectItem(batch, item, options));
	const attempts = batch.items.reduce((total, item) => total + item.attempts, 0);
	const converged = batchConverged(batch);
	const actions: ProjectionAction[] = ["inspect"];
	if (!converged && batch.control === "active") actions.push("pause", "stop");
	else if (!converged && batch.control === "paused") actions.push("resume", "stop");
	if (!options.readOnly && exportEligible(batch)) actions.push("export");
	if (!options.readOnly && discardEligible(batch, options)) actions.push("discard");
	return {
		id: batch.id,
		control: batch.control,
		converged,
		proven: batch.items.filter(batchItemProofCurrent).length,
		total: batch.items.length,
		inScope: batch.items.filter((item) => item.stage !== "EXCLUDED").length,
		running: batch.items.filter((item) => item.stage === "RUNNING").length,
		blocked: batch.items.filter((item) => item.stage === "BLOCKED").length,
		unknown: items.filter((item) => item.stage === "UNKNOWN").length,
		capacity: batch.capacity,
		attempts,
		maxAttempts: batch.maxAttempts,
		maxTotalAttempts: batch.maxTotalAttempts,
		usage: {
			modelCalls: batch.usage.modelCalls,
			peakWorkers: batch.usage.peakWorkers,
			inputTokens: batch.usage.inputTokens ?? "unknown",
			outputTokens: batch.usage.outputTokens ?? "unknown",
			cost: batch.usage.cost ?? "unknown",
		},
		items,
		actions: options.readOnly ? ["inspect"] : actions,
	};
}

/** Safe retry predicate exposed for UIs that render an action palette. */
export function canRetryItem(batch: Batch, item: BatchItem, options: ProjectionOptions = {}): boolean {
	const projection = projectItem(batch, item, options);
	return projection.actions.includes("retry");
}

/** True when an item has a push/PR effect that requires reconciliation. */
export function requiresExternalReconciliation(item: BatchItem): boolean {
	return externalEffect(item) && (item.operation?.state === "unknown" || item.stage === "UNKNOWN");
}
