import { lstat as lstatAsync, readdir as readdirAsync } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { batchConverged, batchItemProofCurrent, batchSummary, createBatch, dependencyBlocker, digest, evaluateBatchGraph, selectionIdentity, type Batch, type BatchItem, type SelectedItem, type Prerequisite } from "../core/batch.ts";
import { criterionProven, currentAssumptionsFor, reconcileCurrentVerification, reconcileReceipt } from "../core/evidence.ts";
import { reduce } from "../core/reducer.ts";
import type { AttemptId, CriterionId, CurrentVerificationReceipt, EvidenceReceipt, LedgerEvent, OperationReceipt, PredicateEvidence, ProofAssumption, TaskId } from "../core/model.ts";
import { BatchStore, ResourceClaims } from "./batch-store.ts";
import { requiredChecks, packageCheckScripts } from "./batch-checks.ts";
import { BatchGitHub } from "./batch-github.ts";
import { runNative, sandboxTest, sandboxPreflight, NativeExecutionError, resolveNativeBinding, validateNativeSDK, type NativeBinding, type NativeContext, type NativeSDK, type SchemaBuilder, type SemanticOutcome } from "./batch-native.ts";

const command = promisify(execFile);
const message = (error: unknown): string => error instanceof Error ? error.message : String(error);
function canonicalPullUrl(url: string, repo: string, number: number): boolean {
	try { const parsed = new URL(url); return parsed.origin === "https://github.com" && parsed.pathname.toLowerCase() === `/${repo.toLowerCase()}/pull/${number}`; }
	catch { return false; }
}
function operationReceipt(
	batch: Batch,
	item: BatchItem,
	phase: OperationReceipt["phase"],
	state: OperationReceipt["state"],
	id: string,
	extra: Partial<Pick<OperationReceipt, "attemptId" | "branch" | "sha" | "url" | "resultHandle" | "subject">> = {},
): OperationReceipt {
	return {
		id,
		generation: item.ledger.generation,
		subject: item.ledger.subject,
		effect: phase === "push" ? "git-push" : phase === "pr" ? "pull-request-create" : "repository-work",
		phase,
		owner: `${batch.id}:${item.selected.key}`,
		state,
		...extra,
	};
}
/** Semantic outcomes exist only for read-only inspections; absence is uncertain there, neutral elsewhere. */
export function semanticOutcomeFor(action: SelectedItem["action"], reported: SemanticOutcome): SemanticOutcome {
	return action === "inspect" ? (reported === "none" ? "uncertain" : reported) : "none";
}
function transitionOperation(item: BatchItem, update: Partial<OperationReceipt>): void {
	if (!item.operation) throw new Error("operation receipt unavailable");
	item.operation = { ...item.operation, ...update };
}
function hasPreparationRecoveryEvidence(batch: Batch, item: BatchItem): boolean {
	const owner = `${batch.id}:${item.selected.key}`;
	const noWorker = item.attempts === 0 && item.sessions.length === 0 && item.ledger.tasks.every((task) => task.attempts.length === 0);
	const preparation = item.preparation;
	if (!noWorker || preparation === undefined || preparation.owner !== owner || preparation.head !== item.selected.head) return false;
	return [...item.operations, ...(item.operation === undefined ? [] : [item.operation])].some((operation) =>
		operation.owner === owner && operation.generation === item.ledger.generation && operation.phase === "worker" &&
		["not-applied", "unknown", "intent"].includes(operation.state) &&
		operation.subject.repo === item.ledger.subject.repo && operation.subject.base === item.ledger.subject.base &&
		operation.subject.head === item.ledger.subject.head);
}
export interface BatchOptions { capacity: number; maxAttempts: number; maxTotalAttempts: number; mode: "once" | "retain"; dependencies?: Prerequisite[]; converge?: boolean }
export interface BatchTiming {
	now: () => Date;
	wait: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
}
interface Running { batch: Batch; item: BatchItem; controller: AbortController; promise: Promise<void> }

export interface BatchSnapshotError {
	readonly id: string;
	readonly error: string;
}

/** A side-effect-free view of retained Factory state. */
export interface BatchSnapshot {
	readonly root: string;
	readonly batches: readonly Batch[];
	readonly errors: readonly BatchSnapshotError[];
	readonly activeItemKeys: readonly string[];
	readonly fatal?: string;
}

export interface BatchHistoryCursor {
	readonly ids: readonly string[];
	readonly offset: number;
}

export interface BatchHistoryPage {
	readonly snapshot: BatchSnapshot;
	readonly next?: BatchHistoryCursor;
}

export type BatchChangeListener = (event: { readonly batchId?: string }) => void;

/** One owner and one slot bound for worker, verification and independent acceptance. */
export class BatchService {
	readonly store: BatchStore;
	readonly claims: ResourceClaims;
	readonly root: string;
	readonly github: BatchGitHub;
	readonly sdk: NativeSDK | undefined;
	readonly schema: SchemaBuilder;
	readonly capacity: number;
	private batches = new Map<string, Batch>();
	private running = new Map<string, Running>();
	private observing = new Map<string, AbortController>();
	private pumping?: Promise<void>;
	private submitTail: Promise<void> = Promise.resolve();
	private changed = new Set<BatchChangeListener>();
	private bindings = new Map<string, { binding: NativeBinding } | { error: string }>();
	private fatal?: string;
	private readonly preflight: typeof sandboxPreflight;
	private readonly runVerification: typeof sandboxTest;
	private readonly timing: BatchTiming;
	private readonly continuationWakeups = new Set<() => void>();

	constructor(root: string, github: BatchGitHub, sdk: NativeSDK | undefined, schema: SchemaBuilder, capacity: number, claimsRoot = root, preflight: typeof sandboxPreflight = sandboxPreflight, runVerification: typeof sandboxTest = sandboxTest, timing: BatchTiming = {
		now: () => new Date(),
		wait: (milliseconds, signal) => new Promise<void>((resolve) => {
			let timer: ReturnType<typeof setTimeout> | undefined;
			const finish = () => { if (timer) clearTimeout(timer); signal?.removeEventListener("abort", finish); resolve(); };
			timer = setTimeout(finish, Math.min(milliseconds, 2_147_000_000));
			signal?.addEventListener("abort", finish, { once: true });
			if (signal?.aborted) finish();
		}),
	}) {
		this.root = root;
		this.github = github;
		this.sdk = sdk;
		this.schema = schema;
		this.capacity = capacity;
		this.preflight = preflight;
		this.runVerification = runVerification;
		this.timing = timing;
		if (!Number.isSafeInteger(capacity) || capacity < 1 || capacity > 100) throw new Error("invalid shared Factory capacity");
		this.store = new BatchStore(root);
		this.claims = new ResourceClaims(root, claimsRoot);
	}
	onChange(callback: BatchChangeListener): () => void {
		this.changed.add(callback);
		return () => { this.changed.delete(callback); };
	}
	isWriterAcquired(): boolean { return this.store.isAcquired(); }
	activeItemKeys(): readonly string[] { return [...this.running.values()].map((active) => active.item.selected.key); }
	private notifyChanged(batchId?: string): void {
		for (const callback of [...this.changed]) {
			try { callback({ batchId }); } catch { /* observers never make a durable mutation fail */ }
		}
	}
	private persist(batch: Batch): void {
		if (this.fatal) throw new Error(this.fatal);
		try { this.store.write(batch); }
		catch (error) {
			this.fatal = `persistence failed; no new effects: ${message(error)}`;
			for (const active of this.running.values()) active.controller.abort();
			this.notifyChanged(batch.id);
			throw error;
		}
		this.notifyChanged(batch.id);
	}
	/**
	 * Read persisted state without acquiring the writer lock, resuming work, or
	 * touching GitHub/OMP. Each corrupt store is retained as a fail-closed error
	 * while healthy batches remain available for inspection.
	 */
	readSnapshot(id?: string): BatchSnapshot {
		const batches: Batch[] = [];
		const errors: BatchSnapshotError[] = [];
		let ids: string[];
		try {
			ids = id === undefined
				? readdirSync(this.root).filter((name) => /^batch-[a-f0-9-]+\.json$/.test(name)).map((name) => name.slice(0, -5))
				: [id];
		} catch (error) {
			return { root: this.root, batches, errors: [{ id: id ?? this.root, error: message(error) }], activeItemKeys: this.activeItemKeys(), ...(this.fatal ? { fatal: this.fatal } : {}) };
		}
		for (const batchId of ids) {
			try {
				if (!/^batch-[a-f0-9-]+$/.test(batchId)) throw new Error("invalid batch identity");
				const file = join(this.root, `${batchId}.json`);
				const stat = lstatSync(file);
				if (!stat.isFile() || stat.nlink !== 1 || stat.size > 32 * 1024 * 1024) throw new Error("batch preview requires a regular file under 32 MiB; preserve original evidence for inspection");
				batches.push(this.store.read(batchId));
			}
			catch (error) { errors.push({ id: batchId, error: message(error) }); }
		}
		return { root: this.root, batches, errors, activeItemKeys: this.activeItemKeys(), ...(this.fatal ? { fatal: this.fatal } : {}) };
	}
	async readSnapshotAsync(id?: string): Promise<BatchSnapshot> {
		const batches: Batch[] = [];
		const errors: BatchSnapshotError[] = [];
		let ids: string[];
		try { ids = id === undefined ? (await readdirAsync(this.root)).filter((name) => /^batch-[a-f0-9-]+\.json$/.test(name)).map((name) => name.slice(0, -5)) : [id]; }
		catch (error) { return { root: this.root, batches, errors: [{ id: id ?? this.root, error: message(error) }], activeItemKeys: this.activeItemKeys(), ...(this.fatal ? { fatal: this.fatal } : {}) }; }
		for (const batchId of ids) {
			try { batches.push(await this.store.readAsync(batchId)); }
			catch (error) { errors.push({ id: batchId, error: message(error) }); }
		}
		return { root: this.root, batches, errors, activeItemKeys: this.activeItemKeys(), ...(this.fatal ? { fatal: this.fatal } : {}) };
	}
	/** Read a stable, bounded page of retained history without acquiring ownership. */
	async readHistoryPage(cursor?: BatchHistoryCursor, focusId?: string): Promise<BatchHistoryPage> {
		const batches: Batch[] = [];
		const errors: BatchSnapshotError[] = [];
		const maxRecords = 25;
		const maxBytes = 32 * 1024 * 1024;
		let ids: string[];
		let offset = 0;
		try {
			if (cursor) {
				if (!Number.isSafeInteger(cursor.offset) || cursor.offset < 0 || cursor.offset > cursor.ids.length || cursor.ids.some((id) => !/^batch-[a-f0-9-]+$/.test(id))) throw new Error("invalid batch history cursor");
				ids = [...cursor.ids];
				offset = cursor.offset;
			} else {
				const entries = (await readdirAsync(this.root)).filter((name) => /^batch-[a-f0-9-]+\.json$/.test(name));
				const dated = await Promise.all(entries.map(async (name) => {
					const id = name.slice(0, -5);
					try { return { id, mtimeMs: (await lstatAsync(join(this.root, name))).mtimeMs }; }
					catch (error) { errors.push({ id, error: message(error) }); return undefined; }
				}));
				ids = dated.filter((entry): entry is { id: string; mtimeMs: number } => entry !== undefined)
					.sort((a, b) => b.mtimeMs - a.mtimeMs || a.id.localeCompare(b.id)).map((entry) => entry.id);
				if (focusId !== undefined) {
					if (!/^batch-[a-f0-9-]+$/.test(focusId)) throw new Error("invalid focused batch identity");
					ids = [focusId, ...ids.filter((id) => id !== focusId)];
				}
			}
		} catch (error) {
			return { snapshot: { root: this.root, batches, errors: [...errors, { id: this.root, error: message(error) }], activeItemKeys: this.activeItemKeys(), ...(this.fatal ? { fatal: this.fatal } : {}) } };
		}
		let sourceBytes = 0;
		while (offset < ids.length && batches.length < maxRecords) {
			const batchId = ids[offset++]!;
			let size: number;
			try { size = (await lstatAsync(join(this.root, `${batchId}.json`))).size; }
			catch (error) { errors.push({ id: batchId, error: message(error) }); continue; }
			if (size > maxBytes || (sourceBytes > 0 && sourceBytes + size > maxBytes)) {
				if (sourceBytes > 0 && size <= maxBytes) { offset--; break; }
				errors.push({ id: batchId, error: "batch history page source-byte limit exceeded" });
				continue;
			}
			sourceBytes += size;
			try { batches.push(await this.store.readAsync(batchId)); }
			catch (error) { errors.push({ id: batchId, error: message(error) }); }
		}
		const snapshot: BatchSnapshot = { root: this.root, batches, errors, activeItemKeys: this.activeItemKeys(), ...(this.fatal ? { fatal: this.fatal } : {}) };
		return { snapshot, ...(offset < ids.length ? { next: { ids, offset } } : {}) };
	}
	status(id?: string): string {
		const batches = id ? [this.store.read(id)] : this.store.list();
		return [this.fatal, batches.length ? batches.map((batch) => batchSummary(batch, this.root)).join("\n\n") : `Factory has no batches. State: ${this.root}. Select Review items, then /factory start inspect|patch|pr-ready.`].filter(Boolean).join("\n");
	}
	async submit(selected: SelectedItem[], options: BatchOptions): Promise<Batch> {
		// Capture before any await; later Review changes cannot alter this request.
		const captured = structuredClone(selected);
		const settings = structuredClone(options);
		const result = this.submitTail.then(() => this.submitCaptured(captured, settings));
		this.submitTail = result.then(() => {}, () => {});
		return result;
	}
	private async submitCaptured(selected: SelectedItem[], options: BatchOptions): Promise<Batch> {
		this.store.acquire();
		if (this.fatal) throw new Error(this.fatal);
		const preliminary = createBatch(selected, { ...options, capacity: Math.min(options.capacity, this.capacity), id: `batch-${randomUUID()}` });
		const existing = this.store.list();
		const duplicate = existing.find((batch) => batch.selection === preliminary.selection && !batchConverged(batch) && batch.scopeRevisions.length === 0);
			if (duplicate) {
				if (preliminary.version === 4 && duplicate.version < 4) throw new Error(`selection is already retained by legacy ${duplicate.id} without owned-PR lifecycle authority; inspect it rather than upgrading its outcome`);
				if (Boolean(duplicate.convergence) !== Boolean(options.converge)) throw new Error(`selection is already tracked by ${duplicate.id} with a different outcome contract`);
			for (const proposed of preliminary.items) {
					const prior = duplicate.items.find((item) => item.selected.key === proposed.selected.key);
					if (prior?.selected.observe !== proposed.selected.observe || proposed.selected.targetRef !== undefined && prior?.selected.targetRef !== proposed.selected.targetRef) throw new Error(`selection is already tracked by ${duplicate.id} with a different target or mechanical acceptance; preserve original generation`);
				if (proposed.selected.requiredChecks && JSON.stringify(prior?.selected.requiredChecks) !== JSON.stringify(proposed.selected.requiredChecks)) throw new Error(`selection is already tracked by ${duplicate.id} with different required checks; inspect existing contract`);
			}
			if (JSON.stringify(duplicate.dependencies) !== JSON.stringify(preliminary.dependencies)) throw new Error(`selection is already tracked by ${duplicate.id} with different prerequisites; inspect existing scope`);
			const current = this.batches.get(duplicate.id) ?? duplicate;
			this.batches.set(current.id, current);
			return current;
		}
		const snapshot = preliminary.items.map((item) => item.selected);
		let next = 0;
		await Promise.all(Array.from({ length: Math.min(this.capacity, snapshot.length) }, async () => {
			while (next < snapshot.length) {
				const index = next++;
				try { snapshot[index] = await this.github.snapshot(snapshot[index]!); }
				catch (error) { snapshot[index]!.blocker = message(error); }
			}
		}));
		const batch = createBatch(snapshot, { ...options, capacity: preliminary.capacity, id: preliminary.id });
		for (const item of batch.items) {
			const conflict = existing.find((other) => other.items.some((candidate) => candidate.stage !== "EXCLUDED" && candidate.stage !== "DONE" && (candidate.selected.key === item.selected.key || candidate.selected.overlaps.includes(item.selected.key) || item.selected.overlaps.includes(candidate.selected.key))));
			if (conflict) { item.stage = "BLOCKED"; item.blocker = `already tracked by ${conflict.id}; attach there instead of competing execution`; }
		}
			this.persist(batch);
			this.batches.set(batch.id, batch);
			if (batch.convergence) await this.observeConvergence(batch);
			return batch;
		}

		private async observeConvergence(batch: Batch): Promise<void> {
			if (!batch.convergence) return;
			const observation = await this.github.observeGraph(batch.items.map((item) => item.selected), batch.convergence.generation);
			batch.convergence.observation = observation;
			for (const item of batch.items) {
				if (!this.running.has(`${batch.id}:${item.selected.key}`)) {
					const graph = evaluateBatchGraph(batch);
					const prerequisites = [...observation.relations.filter((edge) => edge.from === item.selected.key && edge.authority === "authoritative" && (edge.kind === "requires" || edge.kind === "stacked-on")), ...batch.dependencies.filter((edge) => edge.item === item.selected.key).map((edge) => ({ to: edge.requires, stage: edge.stage }))];
					const values = new Map<string, ProofAssumption>();
					for (const edge of prerequisites) {
						const node = graph.nodes.find((entry) => entry.key === edge.to);
						const previous = batch.items.find((entry) => entry.selected.key === edge.to);
						const stage = edge.stage ?? "verified-patch";
						const satisfied = node?.decision === "DONE" && ["verified-patch", "pr-ready", "merged-upstream"].indexOf(node.proof ?? "verified-patch") >= ["verified-patch", "pr-ready", "merged-upstream"].indexOf(stage);
						const taskId = `graph-${digest(`${edge.to}:${stage}`).slice(0, 16)}` as TaskId;
						values.set(taskId, { kind: "dependency-outcome", taskId, value: satisfied ? "proven" : "unproven", ...(node?.subject ? { binding: { subject: node.subject, stage, ...(previous?.proof?.tree ? { tree: previous.proof.tree } : {}) } } : {}) });
					}
					if (values.size > 15) {
						batch.convergence.observation = { ...batch.convergence.observation!, nodes: batch.convergence.observation!.nodes.map((node) => node.key === item.selected.key ? { ...node, state: "UNKNOWN", blocker: "bounded canonical proof assumption capacity exceeded; preserve the original scope and explicitly resolve its prerequisite representation" } : node) };
						continue;
					}
					item.ledger = { ...item.ledger, assumptionValues: [...values.values()] };
					const criterion = item.ledger.criteria[0]!;
					const assumptions = [...(criterion.assumptions ?? []).filter((entry) => entry.kind !== "dependency-outcome" || !entry.taskId.startsWith("graph-")), ...values.values()];
					if (JSON.stringify(criterion.assumptions ?? []) !== JSON.stringify(assumptions)) {
						this.event(item, { kind: "revise_criterion_assumptions", expectedRevision: item.ledger.revision, criterionId: criterion.id, assumptions, reason: "current authoritative graph prerequisite outcome changed" });
						if (item.stage === "DONE" && !batchItemProofCurrent(item)) { item.stage = "QUEUED"; item.blocker = "dependency proof moved; bounded re-verification under original limits"; }
					}
				}
				const criterion = item.ledger.criteria.find((entry) => entry.observation);
				if (!criterion?.observation || this.running.has(`${batch.id}:${item.selected.key}`)) continue;
				const current = observation.nodes.find((node) => node.key === item.selected.key);
				const same = current !== undefined && current.subject?.base === item.selected.base && current.subject?.head === item.selected.head && current.acceptanceRevision === item.selected.acceptanceRevision;
				const status = current?.state === "UNKNOWN" || !same ? "unknown" : current.proofCurrent && current.proof === "merged-upstream" ? "proven" : "unproved";
				this.event(item, { kind: "record_observation", expectedRevision: item.ledger.revision, observation: {
					criterionId: criterion.id, generation: item.ledger.generation, subject: item.ledger.subject, source: criterion.observation,
					revision: item.selected.head!, status, note: current?.blocker ?? `${criterion.observation.identity} ${status} at the captured subject`, assumptions: criterion.assumptions ?? [],
				} });
				item.stage = status === "proven" ? "DONE" : status === "unknown" ? "UNKNOWN" : "BLOCKED";
				item.blocker = status === "proven" ? undefined : `graph observation ${status}; resume after ${criterion.observation.identity} is authoritatively ${criterion.observation.predicate}`;
			}
			this.persist(batch);
		}
		/** Read-only current-state reconciliation consumes no worker slot or model call. */
		async reconcile(id: string, clock: () => Date = this.timing.now): Promise<void> {
			this.store.acquire();
			const batch = this.batches.get(id) ?? this.store.read(id);
			this.batches.set(id, batch);
			for (const item of batch.items) {
				if (item.selected.action !== "pr-ready" || !item.prLifecycle) continue;
				if (item.operation && (item.operation.phase === "push" && item.operation.state === "applied" || ["push", "pr"].includes(item.operation.phase) && ["intent", "unknown"].includes(item.operation.state))) await this.reconcileEffect(batch, item);
				if (item.prLifecycle.pullRequest && item.prLifecycle.phase !== "repair-required" && item.operation?.phase === "pr" && item.operation.state === "applied") await this.observeOwnedPullRequest(batch, item, clock());
			}
			await this.observeConvergence(batch);
			this.persist(batch);
			if (batch.control === "active") void this.pump();
		}
	private async observeOwnedPullRequest(batch: Batch, item: BatchItem, now: Date, signal?: AbortSignal): Promise<void> {
		const wasActive = batch.control === "active";
		const cancelled = () => signal?.aborted === true || batch.control === "stopped" || item.stage === "CANCELLED" ||
			(signal !== undefined && batch.control !== "active") || (signal === undefined && wasActive && batch.control !== "active");
		if (cancelled()) return;
		const lifecycle = item.prLifecycle!;
		const pull = lifecycle.pullRequest;
		if (!pull) return;
		const nowText = now.toISOString();
		if (lifecycle.phase !== "ready" && Date.parse(nowText) >= Date.parse(lifecycle.deadlineAt) || lifecycle.observationCount >= 100) {
			item.prLifecycle = { ...lifecycle, phase: "unknown", nextSafeAction: "investigate" };
			item.stage = "UNKNOWN"; item.blocker = "hosted-check observation deadline or bound exhausted; preserve the owned PR and explicitly reconcile";
			this.persist(batch); return;
		}
		if (lifecycle.nextObservationAt && Date.parse(nowText) < Date.parse(lifecycle.nextObservationAt)) return;
		try { await this.validateProof(item, signal); }
		catch (error) {
			if (cancelled()) return;
			item.prLifecycle = { ...lifecycle, phase: "unknown", nextSafeAction: "investigate" };
			item.stage = "UNKNOWN"; item.blocker = `owned PR proof is stale: ${message(error)}`;
			this.persist(batch); return;
		}
		let observation = await this.github.observeHostedChecks(item.selected.repo, {
			repository: pull.repository, identity: pull.identity, number: pull.number, url: pull.url,
			branch: pull.branch, headSha: pull.headSha, baseRef: lifecycle.target.ref, baseSha: lifecycle.target.sha,
			...(pull.mergeSha ? { mergeSha: pull.mergeSha } : {}),
		}, nowText, item.selected.sourceDefaultRef, signal);
		if (cancelled()) return;
		const observedLifecycle = observation.mergeSha && !pull.mergeSha
			? { ...lifecycle, pullRequest: { ...pull, mergeSha: observation.mergeSha } }
			: lifecycle;
		const observedPull = observedLifecycle.pullRequest ?? pull;
		if (observation.result === "passed" && (!observation.eligibleSubject || observation.eligibleSubject.sha !== (observation.eligibleSubject.subject === "head" ? observedPull.headSha : observedPull.mergeSha))) {
			observation = { ...observation, result: "unknown", reason: "GitHub did not establish one exact eligible PR check subject" };
		}
		if (observation.result !== "unknown") {
			try {
				await this.validateProof(item, signal);
				await this.github.assertFresh(item.selected, observedPull, signal);
			} catch (error) {
				if (cancelled()) return;
				observation = { ...observation, result: "unknown", reason: `subject changed during hosted-check observation: ${message(error)}` };
			}
		}
		if (["passed", "failed"].includes(observation.result) && (!observation.policyFingerprint || typeof this.github.hostedCheckPolicyCurrent !== "function" || !await this.github.hostedCheckPolicyCurrent(item.selected.repo, lifecycle.target.ref, item.selected.sourceDefaultRef, observation.policyFingerprint, signal))) {
			if (cancelled()) return;
			observation = { ...observation, result: "unknown", failures: undefined, reason: "effective classic/ruleset check policy changed or became unavailable before the hosted result was persisted" };
		}
		if (cancelled()) return;
		const observationCount = lifecycle.observationCount + 1;
		const delayMs = Math.min(5 * 60_000, 15_000 * (2 ** Math.min(observationCount - 1, 5)));
		const retryAfter = observation.retryAfter && Number.isFinite(Date.parse(observation.retryAfter)) ? Date.parse(observation.retryAfter) : undefined;
		const requestedAt = Math.max(now.getTime() + (observation.result === "passed" ? 5 * 60_000 : delayMs), retryAfter ?? 0);
		const schedule = { observedAt: nowText, nextObservationAt: new Date(Math.min(requestedAt, Date.parse(lifecycle.deadlineAt))).toISOString() };
		if (observation.result === "passed" && observation.coverage === "complete" && observation.eligibleSubject !== undefined && observation.eligibleSubject.sha === (observation.eligibleSubject.subject === "head" ? observedPull.headSha : observedPull.mergeSha) && observation.headSha === observedPull.headSha && ["verified-patch", "pr-ready"].includes(item.proof?.stage ?? "")) {
			try {
				if (item.ledger.subject.head !== observedPull.headSha || item.proof?.subject !== observedPull.headSha) throw new Error("current proof receipt is not bound to the exact passing PR head");
				const task = item.ledger.tasks[0];
				if (!task) throw new Error("current Factory task is unavailable for canonical PR-ready completion");
				const currentAttempt = task.attempts.at(-1);
				if (currentAttempt?.currentVerification?.subject.head !== observedPull.headSha || currentAttempt.currentVerification.generation !== item.ledger.generation) throw new Error("fresh current-subject verification receipt is unavailable for the exact passing PR head");
				if (task.state === "VERIFY") this.event(item, { kind: "finish_task", expectedRevision: item.ledger.revision, taskId: task.id, criterionId: task.criterionId });
				if (item.ledger.tasks[0]?.state !== "DONE" || !item.ledger.tasks[0]?.attempts.at(-1)?.receipt || item.ledger.subject.head !== observedPull.headSha || !criterionProven(item.ledger, task.criterionId)) throw new Error("current-subject reducer proof did not reach canonical DONE");
			} catch (error) {
				observation = { ...observation, result: "unknown", reason: `hosted checks passed but canonical current-subject proof could not finish: ${message(error)}` };
			}
		}
		if (observation.result === "passed" && observation.coverage === "complete" && observation.eligibleSubject !== undefined && observation.eligibleSubject.sha === (observation.eligibleSubject.subject === "head" ? observedPull.headSha : observedPull.mergeSha) && observation.headSha === observedPull.headSha && ["verified-patch", "pr-ready"].includes(item.proof?.stage ?? "")) {
			item.prLifecycle = { ...observedLifecycle, ...schedule, observationCount, observation, phase: "ready", nextSafeAction: "pr-ready" };
			if (item.proof) item.proof.stage = "pr-ready";
			item.stage = "DONE";
			if (!batchItemProofCurrent(item)) {
				item.prLifecycle = { ...item.prLifecycle, phase: "unknown", nextSafeAction: "investigate" };
				item.stage = "UNKNOWN"; item.blocker = "hosted checks passed without current canonical batch proof; preserve UNKNOWN";
				this.persist(batch); return;
			}
			item.blocker = undefined; this.persist(batch); return;
		}
		if (item.proof?.stage === "pr-ready") item.proof.stage = "verified-patch";
		if (observation.result === "pending") {
			item.prLifecycle = { ...observedLifecycle, ...schedule, observationCount, observation, phase: "waiting", nextSafeAction: "observe-after" };
			item.stage = "VERIFY"; item.blocker = `hosted checks pending; next bounded observation ${schedule.nextObservationAt}`;
		} else if (observation.result === "failed") {
			const failures = observation.failures;
			const candidateCurrent = observation.headSha === observedPull.headSha && observation.eligibleSubject?.sha !== undefined && failures?.length && failures.every((failure) =>
				failure.classification === "repairable-code" && failure.candidateHead === observedPull.headSha && observation.runs.some((run) => run.id === failure.checkRun.id && run.headSha === failure.checkSubjectSha && run.conclusion === "failure" && run.appId === failure.checkRun.appId) && failure.annotationsComplete);
			const failureKey = candidateCurrent ? digest(failures.map((failure) => failure.key).sort().join("\n")) : undefined;
			const duplicate = failureKey !== undefined && (lifecycle.repair?.failureKey === failureKey || item.repair?.failureKey === failureKey);
			item.prLifecycle = { ...observedLifecycle, ...schedule, observationCount, observation, phase: "repair-required", nextSafeAction: candidateCurrent && !duplicate ? "repair" : "repair-review" };
			item.stage = "VERIFY";
			item.blocker = duplicate ? "the exact current check-run/attempt failure was already dispatched; preserve the existing repair lineage" : candidateCurrent
				? `owned PR has complete current required-check diagnostics; bounded same-PR repair is queued: ${observation.reason ?? "required check failed"}`
				: `required check failed but source-bound repair evidence is incomplete; keep UNKNOWN for explicit investigation: ${observation.reason ?? "diagnostics unavailable"}`;
		} else if (observation.retryAfter && Date.parse(observation.retryAfter) > now.getTime()) {
			item.prLifecycle = { ...observedLifecycle, ...schedule, observationCount, observation, phase: "waiting", nextSafeAction: "observe-after" };
			item.stage = "VERIFY"; item.blocker = `GitHub requested a bounded read retry; next observation ${schedule.nextObservationAt}`;
		} else {
			item.prLifecycle = { ...observedLifecycle, ...schedule, observationCount, observation, phase: "unknown", nextSafeAction: "investigate" };
			item.stage = "UNKNOWN"; item.blocker = `hosted check coverage or independent acceptance is inconclusive: ${observation.reason ?? "current verified-patch proof unavailable"}`;
		}
		this.persist(batch);
	}
	private artifactDigest(item: BatchItem): string {
		if (!item.proof || !item.proof.artifacts.length || !item.sessions.includes(item.proof.reviewerSession)) throw new Error("independent proof/session unavailable");
		return digest(item.proof.artifacts.map((path) => {
			const actual = realpathSync(path);
			const child = relative(resolve(this.root), actual);
			if (!child || child === ".." || child.startsWith(`..${sep}`) || actual !== resolve(path) || !lstatSync(actual).isFile() || lstatSync(actual).nlink !== 1) throw new Error("proof artifact escapes owned state");
			return digest(readFileSync(actual, "utf8"));
		}).join(""));
	}
	private async validateProof(item: BatchItem, signal?: AbortSignal): Promise<void> {
		const task = item.ledger.tasks[0];
		const attempt = task?.attempts.at(-1);
		const expectedSubject = attempt?.currentVerification?.subject.head ?? attempt?.subject.head ?? item.selected.head ?? attempt?.subject.base ?? item.selected.base;
		if (!item.proof || item.proof.acceptanceRevision !== item.selected.acceptanceRevision || item.proof.subject !== expectedSubject || this.artifactDigest(item) !== item.proof.digest) {
			throw new Error("proof artifact unavailable, modified or stale; restore exact evidence or explicitly reverify");
		}
		if (!task || !attempt?.receipt) throw new Error("current Factory proof receipt unavailable");
		if (attempt.currentVerification && (item.proof.tree !== attempt.currentVerification.tree || item.proof.subject !== attempt.currentVerification.subject.head)) {
			throw new Error("current Factory proof SHA/tree differs from its separate current-subject verification receipt");
		}
		const current = attempt.currentVerification
			? reconcileCurrentVerification(item.ledger, attempt.currentVerification, {
				taskId: task.id,
				attemptId: attempt.id,
				subject: item.ledger.subject,
				acceptanceRevision: item.selected.acceptanceRevision ?? "",
				assumptions: currentAssumptionsFor(item.ledger, task.id),
			})
			: reconcileReceipt(item.ledger, attempt.receipt, {
				taskId: task.id,
				attemptId: attempt.id,
				subject: attempt.subject,
				artifactRoots: [this.root],
			});
		if (current.status !== "proven") throw new Error(`Factory proof is ${current.status}: ${current.reasons.join("; ")}`);
		await this.github.assertFresh(item.selected, item.prLifecycle?.pullRequest, signal);
		if (!item.workspace || !item.proof.tree) throw new Error("verified workspace tree unavailable");
		if (await this.git(item.workspace, ["write-tree"], signal) !== item.proof.tree || await this.git(item.workspace, ["diff", "--no-ext-diff", "--no-textconv", "--name-only"], signal) || await this.git(item.workspace, ["ls-files", "--others", "--exclude-standard"], signal)) {
			throw new Error("retained workspace differs from verified tree; preserve and explicitly reverify");
		}
	}
	async resume(id: string, context: NativeContext): Promise<void> {
		this.store.acquire();
		if (this.fatal) throw new Error(this.fatal);
		// Snapshot only the approved execution references, never a handler's UI/signal.
		try { this.bindings.set(id, { binding: resolveNativeBinding(context) }); }
		catch (error) { this.bindings.set(id, { error: message(error) }); }
		const batch = this.batches.get(id) ?? this.store.read(id);
		this.batches.set(id, batch);
		batch.control = "active";
		this.persist(batch);
		for (const item of batch.items) {
			const owner = `${id}:${item.selected.key}`;
			if (this.running.has(owner) || item.stage === "CANCELLED" || item.stage === "EXCLUDED") continue;
			try {
				if (item.selected.observe) continue;
				if (item.prLifecycle?.phase === "repairing" && item.prLifecycle.repair?.state === "queued" && item.operation?.phase === "pr" && item.operation.state === "applied" && item.prLifecycle.pullRequest) {
					const latest = item.ledger.tasks[0]?.attempts.at(-1);
					if (latest?.id !== item.prLifecycle.repair.attemptId || latest.state !== "returned" || item.ledger.tasks[0]?.attempts.some((attempt) => attempt.state === "started")) throw new Error("queued repair has an unexpected current attempt; preserve UNKNOWN and inspect");
					item.stage = "VERIFY"; item.blocker = "retained hosted repair packet is queued; resume will reacquire claims before attempt allocation";
				}
				if (item.stage === "DONE") {
					await this.validateProof(item);
					if (item.operation?.phase === "pr" && !item.prLifecycle?.pullRequest) await this.reconcileEffect(batch, item);
					continue;
				}
				if (item.operation?.state === "not-applied") {
					item.operations.push(item.operation);
					item.operation = undefined;
				}
				if (item.operation?.phase === "push" || item.operation?.phase === "pr") {
					if (item.operation.phase === "pr" && item.operation.state === "applied" && item.prLifecycle?.pullRequest) continue;
					await this.reconcileEffect(batch, item);
					if (this.mayQueueConfirmedPush(batch, item)) {
						item.stage = "QUEUED"; item.blocker = "confirmed publication recovered; executing the admitted PR effect under active claims";
					}
					continue;
				}
				if (item.stage === "VERIFY" && item.proof && item.operation?.state === "applied" && !(item.prLifecycle?.phase === "repair-required" && item.prLifecycle.nextSafeAction === "repair")) {
					await this.validateProof(item);
					continue;
				}
				if (item.operation?.state === "unknown" || item.operation?.state === "intent" || item.stage === "RUNNING" || item.stage === "VERIFY") {
					// The store has proved the previous same-host owner dead. Native file-only
					// sessions cannot push; writes still require explicit retained-patch inspection.
					if (item.selected.action !== "inspect") throw new Error("interrupted native attempt; inspect retained workspace then explicitly retry");
					this.abandon(item, "previous same-host native owner is dead; read-only attempt can resume");
					if (item.operation) {
						item.operations.push(item.operation.state === "intent" ? { ...item.operation, state: "unknown" } : item.operation);
						item.operation = undefined;
					}
					item.proof = undefined;
					this.release(item, owner);
				}
				if (item.blocker?.startsWith("already tracked") || item.blocker?.startsWith("proof artifact") || item.proof) continue;
				if (item.selected.acceptanceRevision) await this.github.assertFresh(item.selected);
				else {
					item.selected = await this.github.snapshot(item.selected);
					// No attempt exists yet: fill unavailable admission without resetting lineage.
					if (item.attempts === 0) item.ledger = createBatch([item.selected], { id: batch.id, capacity: batch.capacity, maxAttempts: batch.maxAttempts, maxTotalAttempts: batch.maxTotalAttempts, mode: batch.mode }).items[0]!.ledger;
				}
				const overlap = item.selected.overlaps.find((key) => batch.items.some((candidate) => candidate.selected.key === key && candidate.stage !== "EXCLUDED"));
				if (overlap) throw new Error(`overlaps ${overlap}; explicitly revise scope before execution`);
				item.stage = "QUEUED"; item.blocker = undefined;
			} catch (error) {
				item.stage = item.operation?.state === "unknown" || item.operation?.state === "intent" || item.stage === "UNKNOWN" ? "UNKNOWN" : "BLOCKED";
				item.blocker = message(error);
				if (item.proof) item.proof = undefined;
			}
		}
		// A dependent cannot retain success after its prerequisite loses its required proof.
		for (let pass = 0; pass < batch.items.length; pass++) {
			let demoted = false;
			for (const item of batch.items) if (item.stage === "DONE") {
				const blocker = dependencyBlocker(batch, item.selected.key);
				if (blocker) { item.stage = "BLOCKED"; item.blocker = blocker; item.proof = undefined; demoted = true; }
			}
			if (!demoted) break;
		}
			this.persist(batch);
			if (batch.convergence) await this.observeConvergence(batch);
		void this.pump();
	}
	async control(id: string, action: "pause" | "stop"): Promise<void> {
		this.store.acquire();
		const batch = this.batches.get(id) ?? this.store.read(id);
		batch.control = action === "pause" ? "paused" : "stopped";
		if (action === "stop") for (const item of batch.items) {
			if (this.running.has(`${id}:${item.selected.key}`)) item.blocker = "cancellation requested; ownership retained until native disposal confirms";
			else if (!["DONE", "EXCLUDED", "UNKNOWN"].includes(item.stage)) { item.stage = "CANCELLED"; item.blocker = "operator stopped item; explicit retry required"; }
		}
		this.batches.set(id, batch); this.persist(batch);
		for (const [owner, controller] of this.observing) if (owner.startsWith(`${id}:`)) controller.abort();
		for (const wake of [...this.continuationWakeups]) wake();
		if (action === "stop") for (const active of this.running.values()) if (active.batch.id === id) active.controller.abort();
	}
	exclude(id: string, key: string, reason: string): void {
		this.store.acquire();
		const batch = this.batches.get(id) ?? this.store.read(id);
		const item = batch.items.find((candidate) => candidate.selected.key === key.toLowerCase());
		if (!item || !reason.trim()) throw new Error("explicit item and scope-revision reason required");
		if (this.running.has(`${id}:${item.selected.key}`) || item.operation?.state === "unknown" || item.operation?.state === "intent") throw new Error("cannot exclude active/uncertain work; reconcile first");
		item.stage = "EXCLUDED"; item.blocker = reason;
		batch.scopeRevisions.push({ item: item.selected.key, reason, at: new Date().toISOString() });
		this.batches.set(id, batch); this.persist(batch);
	}
	async retry(id: string, key: string, context: NativeContext): Promise<void> {
		this.store.acquire();
		const batch = this.batches.get(id) ?? this.store.read(id);
		const item = batch.items.find((candidate) => candidate.selected.key === key.toLowerCase());
		if (!item || this.running.has(`${id}:${item.selected.key}`) || item.stage === "DONE" || item.stage === "EXCLUDED") throw new Error("item not eligible for explicit retry");
		if (item.operation?.phase === "push" || item.operation?.phase === "pr") throw new Error("external effects must be reconciled, never blindly retried");
		if (item.attempts >= batch.maxAttempts || batch.items.reduce((total, entry) => total + entry.attempts, 0) >= batch.maxTotalAttempts) throw new Error("original attempt budget exhausted; retry never resets it");
		const owner = `${id}:${item.selected.key}`;
		for (const resource of [`repo:${item.selected.repo}`, `item:${item.selected.key}`]) {
			const conflict = this.claims.conflict(resource, owner); if (conflict) throw new Error(conflict);
		}
		const preparationRecovery = hasPreparationRecoveryEvidence(batch, item);
		const archivedPreparation = item.operation === undefined && item.operations.some((operation) =>
			operation.phase === "worker" && ["not-applied", "unknown", "intent"].includes(operation.state));
		if ((item.operation?.state === "not-applied" || archivedPreparation) && item.attempts === 0 && !preparationRecovery) {
			throw new Error("retained workspace initialization evidence is missing or mismatched; preserve and inspect before retry");
		}
		if ((item.operation?.state === "unknown" || item.operation?.state === "intent") && !preparationRecovery) {
			const attempt = item.ledger.tasks[0]?.attempts.at(-1);
			const subject = item.ledger.subject;
			const operation = item.operation;
			const sessionFiles = attempt?.privateSessions.map((session) => session.sessionFile) ?? [];
			if (!attempt || attempt.state !== "abandoned" || item.settlement?.outcome !== "cancelled" || !sessionFiles.length ||
				item.settlement.sessionFiles.length !== sessionFiles.length || item.settlement.attemptId !== attempt.id || attempt.generation !== item.ledger.generation ||
				attempt.subject.repo !== subject.repo || attempt.subject.base !== subject.base || attempt.subject.head !== subject.head ||
				item.settlement.sessionFiles.some((path, index) => path !== sessionFiles[index] || !item.sessions.includes(path)) ||
				operation.phase !== "worker" || operation.owner !== owner || operation.attemptId !== attempt.id ||
				operation.generation !== attempt.generation || operation.subject.repo !== attempt.subject.repo ||
				operation.subject.base !== attempt.subject.base || operation.subject.head !== attempt.subject.head) {
				throw new Error("native settlement is unproved; preserve claims and inspect before retry");
			}
		}
		await this.github.assertFresh(item.selected);
		this.abandon(item, "operator requested retry after inspecting retained workspace; original budgets retained");
		if (item.ledger.tasks[0]?.state === "DONE") throw new Error("completed proof cannot be reset by retry; restore evidence or explicitly revise scope");
		if (item.operation) {
			item.operations.push(item.operation.state === "intent" ? { ...item.operation, state: "unknown" } : item.operation);
			item.operation = undefined;
		}
		item.proof = undefined; item.stage = "QUEUED"; item.blocker = undefined;
		this.release(item, `${id}:${item.selected.key}`);
		this.batches.set(id, batch); this.persist(batch); await this.resume(id, context);
	}
	async waitForIdle(): Promise<void> { await this.pumping; if (this.fatal) throw new Error(this.fatal); }
	async shutdown(): Promise<void> {
		try { for (const batch of this.batches.values()) { batch.control = "paused"; this.persist(batch); } }
		finally {
			for (const controller of this.observing.values()) controller.abort();
			for (const wake of [...this.continuationWakeups]) wake();
			for (const active of this.running.values()) active.controller.abort();
			await Promise.allSettled([...this.running.values()].map((active) => active.promise));
			await this.pumping;
			this.bindings.clear();
			if (!this.fatal) this.store.release();
		}
	}
	private pump(): Promise<void> {
		if (!this.pumping) this.pumping = this.drain().catch((error) => {
			this.fatal ??= `Factory dispatch stopped: ${message(error)}`;
			for (const active of this.running.values()) active.controller.abort();
		}).finally(() => { this.pumping = undefined; });
		return this.pumping;
	}
	private release(item: BatchItem, owner: string): void {
		if (item.selected.action === "inspect") return;
		this.claims.markSettled(`item:${item.selected.key}`, owner);
		this.claims.markSettled(`repo:${item.selected.repo}`, owner);
		this.claims.release(`item:${item.selected.key}`, owner);
		this.claims.release(`repo:${item.selected.repo}`, owner);
	}
	private async drain(): Promise<void> {
		while (!this.fatal) {
			let dispatched = false;
				for (const batch of this.batches.values()) {
					if (batch.control !== "active") continue;
					if (batch.convergence) await this.observeConvergence(batch);
					for (const item of batch.items) {
						const lifecycle = item.prLifecycle;
						if (!lifecycle?.pullRequest || !["published", "waiting"].includes(lifecycle.phase) || lifecycle.nextSafeAction !== "observe-after") continue;
						const now = this.timing.now();
						if (lifecycle.nextObservationAt && Date.parse(lifecycle.nextObservationAt) > now.getTime() && Date.parse(lifecycle.deadlineAt) > now.getTime()) continue;
						const owner = `${batch.id}:${item.selected.key}`;
						const observer = new AbortController();
						this.observing.set(owner, observer);
						try { await this.observeOwnedPullRequest(batch, item, now, observer.signal); }
						finally { if (this.observing.get(owner) === observer) this.observing.delete(owner); }
					}
					if (batch.control !== "active") continue;
				if (this.running.size >= this.capacity) break;
				if ([...this.running.values()].filter((active) => active.batch.id === batch.id).length >= batch.capacity) continue;
					for (const item of batch.items.filter((candidate) => candidate.stage === "QUEUED" || candidate.stage === "VERIFY" && (candidate.prLifecycle?.phase === "repair-required" && candidate.prLifecycle.nextSafeAction === "repair" || candidate.prLifecycle?.phase === "repairing" && candidate.prLifecycle.repair?.state === "queued")).sort((a, b) => a.attempts - b.attempts)) {
						if (batch.convergence) {
							const decision = evaluateBatchGraph(batch).nodes.find((node) => node.key === item.selected.key);
							if (decision?.decision !== "READY") { item.blocker = decision?.blockers.join("; ") || "current graph transition is not READY"; continue; }
						}
					const publishOnly = item.selected.action === "pr-ready" && item.operation?.phase === "push" && item.operation.state === "applied" && item.prLifecycle?.nextSafeAction === "publish";
					const automaticRepair = item.prLifecycle?.phase === "repair-required" && item.prLifecycle.nextSafeAction === "repair" || item.prLifecycle?.phase === "repairing" && item.prLifecycle.repair?.state === "queued";
					const dependency = dependencyBlocker(batch, item.selected.key);
						if (dependency) { item.blocker = dependency; continue; }
						if (!publishOnly && (item.attempts >= batch.maxAttempts || batch.items.reduce((sum, candidate) => sum + candidate.attempts, 0) >= batch.maxTotalAttempts)) { item.stage = "BLOCKED"; item.blocker = "original attempt budget exhausted; retry never resets it"; this.persist(batch); continue; }
					const approved = this.bindings.get(batch.id);
					const binding = approved && "binding" in approved ? approved.binding : undefined;
					const bindingError = approved && "error" in approved ? approved.error : "OMP execution binding unavailable; explicitly resume from the current session";
					const mutation = item.selected.action !== "inspect";
					if ([...this.running.values()].some((active) => mutation && active.item.selected.repo === item.selected.repo && active.item.selected.action !== "inspect")) continue;
					const owner = `${batch.id}:${item.selected.key}`;
					if (this.running.has(owner)) continue;
					try {
						if (mutation) {
							this.claims.claim(`repo:${item.selected.repo}`, owner);
							try { this.claims.claim(`item:${item.selected.key}`, owner); }
							catch (error) { this.claims.release(`repo:${item.selected.repo}`, owner); throw error; }
						}
					} catch (error) { item.stage = "BLOCKED"; item.blocker = message(error); this.persist(batch); continue; }
					item.stage = publishOnly || automaticRepair ? "RUNNING" : "QUEUED"; item.blocker = undefined; this.persist(batch);
					const controller = new AbortController();
					let advisorEscalationBlocked = false;
					const promise = Promise.resolve().then(() => publishOnly ? this.createPRFromConfirmedPush(batch, item, controller.signal) : this.execute(batch, item, controller.signal, binding, bindingError)).catch((error) => {
						if (error instanceof NativeExecutionError && error.code === "advisor-blocked") {
							advisorEscalationBlocked = true;
							if (item.operation?.state === "intent") transitionOperation(item, { state: "unknown" });
							item.stage = "BLOCKED";
							item.blocker = `native Advisor escalation blocked: ${message(error)}`;
							if (!this.fatal) this.persist(batch);
							return;
						}
						if (item.operation?.phase === "push" && item.operation.state === "applied") {
							if (item.prLifecycle?.phase === "repairing") {
								item.stage = "UNKNOWN";
							item.blocker = `same-PR repair push is confirmed but its original PR effect remains unresolved: ${message(error)}`;
							} else {
								item.stage = controller.signal.aborted ? "CANCELLED" : "BLOCKED";
								item.prLifecycle = item.prLifecycle ? { ...item.prLifecycle, nextSafeAction: "publish" } : undefined;
							}
					} else if (item.operation?.phase === "push" || item.operation?.phase === "pr" || item.operation?.state === "unknown") {
							item.stage = "UNKNOWN";
							if (item.operation.state !== "unknown") transitionOperation(item, { state: "unknown" });
						} else if (controller.signal.aborted && !(error instanceof NativeExecutionError && error.code === "cancellation-settled")) {
							item.stage = "UNKNOWN";
							if (item.operation) transitionOperation(item, { state: "unknown" });
						} else {
							const executionStarted = item.stage === "RUNNING" || item.stage === "VERIFY";
							this.abandon(item, `native attempt settled without proof: ${message(error)}`);
							item.stage = controller.signal.aborted ? "CANCELLED" : "BLOCKED";
							if (item.operation?.state === "intent") {
								transitionOperation(item, { state: executionStarted ? "unknown" : "not-applied" });
								if (executionStarted) item.stage = "UNKNOWN";
							}
							const attempt = item.ledger.tasks[0]?.attempts.at(-1);
							if (error instanceof NativeExecutionError && error.code === "cancellation-settled" && attempt) {
								item.settlement = { attemptId: attempt.id, sessionFiles: attempt.privateSessions.map((entry) => entry.sessionFile), outcome: "cancelled" };
								item.stage = "CANCELLED";
							} else if (error instanceof NativeExecutionError && ["report-missing", "report-invalid"].includes(error.code) && executionStarted && attempt) {
								item.repair = { generation: item.ledger.generation, head: item.selected.head!, acceptanceRevision: item.selected.acceptanceRevision!, attemptId: attempt.id, reason: message(error).slice(0, 32768), artifacts: item.repair?.artifacts ?? [] };
								if (item.operation) transitionOperation(item, { state: "applied" });
								item.stage = "QUEUED";
							}
						}
						if (!(error instanceof NativeExecutionError && error.code === "advisor-blocked")) item.blocker = message(error);
						if (!this.fatal) this.persist(batch);
					}).finally(() => {
						this.running.delete(owner);
						if (!this.fatal && !advisorEscalationBlocked && item.stage !== "UNKNOWN" && item.operation?.state !== "unknown") this.release(item, owner);
						this.notifyChanged(batch.id);
					});
					this.running.set(owner, { batch, item, controller, promise });
					batch.usage.peakWorkers = Math.max(batch.usage.peakWorkers, this.running.size);
					dispatched = true;
					break;
				}
			}
			if (dispatched && this.running.size < this.capacity) continue;
			if (!this.running.size) {
				const now = this.timing.now().getTime();
				const next = [...this.batches.values()].filter((batch) => batch.control === "active").flatMap((batch) => batch.items)
					.filter((item) => item.prLifecycle?.pullRequest && ["published", "waiting"].includes(item.prLifecycle.phase) && item.prLifecycle.nextSafeAction === "observe-after")
					.map((item) => Math.max(now + 1, Math.min(Date.parse(item.prLifecycle!.nextObservationAt ?? new Date(now).toISOString()), Date.parse(item.prLifecycle!.deadlineAt))))
					.sort((a, b) => a - b)[0];
				if (next === undefined) break;
				await this.waitForContinuation(Math.max(1, next - now));
				continue;
			}
			await Promise.race([...this.running.values()].map((active) => active.promise));
		}
		for (const batch of this.batches.values()) {
			if (!this.fatal) this.persist(batch);
		}
	}
	private async waitForContinuation(milliseconds: number): Promise<void> {
		let wake!: () => void;
		const controller = new AbortController();
		const interrupted = new Promise<void>((resolve) => { wake = resolve; this.continuationWakeups.add(resolve); });
		try { await Promise.race([this.timing.wait(milliseconds, controller.signal), interrupted]); }
		finally { controller.abort(); this.continuationWakeups.delete(wake); }
	}
	private event(item: BatchItem, event: LedgerEvent): void {
		const result = reduce(item.ledger, event, { artifactRoots: [this.root] });
		if (!result.ok) throw new Error(result.error);
		item.ledger = result.ledger;
	}
	private abandon(item: BatchItem, reason: string): void {
		const attempt = item.ledger.tasks[0]?.attempts.at(-1);
		if (attempt?.state === "started") this.event(item, { kind: "reconcile_attempt", expectedRevision: item.ledger.revision, taskId: "T1" as TaskId, attemptId: attempt.id, outcome: "abandoned", reason });
	}
	private async git(workspace: string, args: string[], signal?: AbortSignal): Promise<string> {
		const fetching = args[0] === "fetch";
		const credential = fetching ? ["-c", "credential.https://github.com.helper=!gh auth git-credential"] : [];
		const result = await command("git", ["-c", "core.hooksPath=/dev/null", "-c", "protocol.file.allow=never", ...credential, ...args], { cwd: workspace, signal, timeout: 60_000, maxBuffer: 4 * 1024 * 1024, env: { PATH: process.env.PATH, HOME: this.root, GIT_TERMINAL_PROMPT: "0", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", ...(fetching ? { GH_TOKEN: this.github.token } : {}) } });
		return result.stdout.trimEnd();
	}
	private async pushOwnedBranch(workspace: string, branch: string, signal: AbortSignal): Promise<void> {
		await command("git", ["-c", "core.hooksPath=/dev/null", "-c", "credential.helper=!gh auth git-credential", "push", "origin", `HEAD:refs/heads/${branch}`], { cwd: workspace, signal, timeout: 120_000, env: { PATH: process.env.PATH, HOME: this.root, GH_TOKEN: this.github.token, GIT_TERMINAL_PROMPT: "0", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" } });
	}
	private async cloneWorkspace(item: BatchItem, directory: string, signal: AbortSignal): Promise<void> {
		await command("gh", ["repo", "clone", item.selected.repo, directory, "--", "--no-checkout"], { timeout: 120_000, signal, env: { PATH: process.env.PATH, HOME: this.root, GH_TOKEN: this.github.token, GH_PROMPT_DISABLED: "1", GIT_TERMINAL_PROMPT: "0", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" } });
	}
	private async prepareWorkspace(batch: Batch, item: BatchItem, signal: AbortSignal): Promise<string> {
		const directory = join(this.root, "workspaces", batch.id, digest(item.selected.key).slice(0, 16));
		const owner = `${batch.id}:${item.selected.key}`;
		const repairPull = item.prLifecycle?.pullRequest && (item.prLifecycle.phase === "repair-required" || item.prLifecycle.phase === "repairing") ? item.prLifecycle.pullRequest : undefined;
		let expectedHead = repairPull?.headSha ?? item.selected.head!;
		const noWorker = item.attempts === 0 && item.sessions.length === 0 && item.ledger.tasks.every((task) => task.attempts.length === 0);
		const evidenced = [...item.operations, ...(item.operation ? [item.operation] : [])].some((operation) =>
			operation.owner === owner && operation.generation === item.ledger.generation && operation.phase === "worker" && (operation.state === "not-applied" || operation.state === "unknown" && item.preparation?.phase !== undefined && item.preparation.phase !== "ready") && operation.subject.repo === item.ledger.subject.repo && operation.subject.head === item.ledger.subject.head && operation.subject.base === item.ledger.subject.base);
		if (item.workspace && item.workspace !== directory) throw new Error("retained workspace identity mismatch; preserve and inspect");
		if (item.preparation && (item.preparation.owner !== owner || item.preparation.head !== item.selected.head)) throw new Error("workspace initialization evidence differs from selected owner/head; preserve and inspect");
		if (!item.workspace) {
			if (existsSync(directory)) throw new Error("fresh execution found retained workspace; inspect, never reset/delete it");
			item.workspace = directory;
			item.preparation = { phase: "clone", owner, head: item.selected.head! };
			item.operation = operationReceipt(batch, item, "worker", "intent", `${owner}:work`);
			this.persist(batch);
		} else if (!existsSync(directory) && (!noWorker || !evidenced)) {
			throw new Error("retained workspace is absent without positive no-worker-start initialization evidence; preserve and inspect");
		}
		for (const parent of [join(this.root, "workspaces"), join(this.root, "workspaces", batch.id)]) {
			const existing = lstatSync(parent, { throwIfNoEntry: false });
			if (existing?.isSymbolicLink()) throw new Error("workspace parent is a symlink; preserve and inspect before cloning");
			if (!existing) mkdirSync(parent, { mode: 0o700 });
			if (realpathSync(parent) !== parent || !lstatSync(parent).isDirectory() || (process.getuid && lstatSync(parent).uid !== process.getuid())) throw new Error("workspace parent is not the canonical runtime-owned directory; inspect ownership before cloning");
		}
		if (lstatSync(directory, { throwIfNoEntry: false })?.isSymbolicLink()) throw new Error("retained workspace is a symlink; preserve and inspect before cloning");
		if (!existsSync(directory)) {
			item.operation = operationReceipt(batch, item, "worker", "intent", `${owner}:work`);
			item.preparation = { phase: "clone", owner, head: item.selected.head! }; this.persist(batch);
			await this.cloneWorkspace(item, directory, signal);
			item.preparation = { phase: "checkout", owner, head: item.selected.head! }; this.persist(batch);
		}
		if (realpathSync(directory) !== directory || lstatSync(directory).isSymbolicLink() || !lstatSync(directory).isDirectory()) throw new Error("retained workspace identity mismatch; preserve and inspect");
		const metadata = join(directory, ".git");
		if (!existsSync(metadata) || lstatSync(metadata).isSymbolicLink() || !lstatSync(metadata).isDirectory()) throw new Error("partial workspace has no owned Git directory; preserve files and inspect initialization");
		if (process.getuid && (lstatSync(directory).uid !== process.getuid() || lstatSync(metadata).uid !== process.getuid())) throw new Error("Git workspace ownership differs from the executing user; inspect runtime ownership before retry");
		const origin = await this.git(directory, ["config", "--get", "remote.origin.url"], signal);
		if (origin.replace(/\.git$/, "").toLowerCase() !== `https://github.com/${item.selected.repo}`) throw new Error("workspace origin mismatch; preserve and inspect");
		let head: string | undefined;
		try { head = await this.git(directory, ["rev-parse", "HEAD"], signal); } catch { /* An evidenced partial clone may have no checked-out HEAD. */ }
		if (!repairPull) expectedHead = item.selected.head!;
		const initializing = item.preparation?.phase !== "ready" && noWorker && (evidenced || item.operation?.state === "intent");
		const entries = readdirSync(directory).filter((name) => name !== ".git");
		if (initializing && entries.length === 0) {
			item.operation = operationReceipt(batch, item, "worker", "intent", `${owner}:work`);
			item.preparation = { phase: "checkout", owner, head: item.selected.head! }; this.persist(batch);
			if (item.selected.kind === "pr") await this.git(directory, ["fetch", "origin", `pull/${item.selected.number}/head`], signal);
			await this.git(directory, ["checkout", "--detach", item.selected.head!], signal);
			head = await this.git(directory, ["rev-parse", "HEAD"], signal);
		} else if (head !== expectedHead) {
			throw new Error("partial workspace or selected head mismatch with retained files; preserve and inspect before preparation");
		}
		if (repairPull) {
			if (repairPull.repository !== item.selected.repo || repairPull.branch !== `factory/${batch.id}/${item.selected.number}` || repairPull.baseRef !== item.prLifecycle?.target.ref || repairPull.baseSha !== item.prLifecycle?.target.sha || expectedHead !== item.prLifecycle?.observation?.headSha) throw new Error("repair workspace is not bound to the exact admitted PR identity, base and observed candidate head");
			const remote = await this.github.request<{ object: { sha: string } }>(`repos/${item.selected.repo}/git/ref/heads/${encodeURIComponent(repairPull.branch)}`);
			if (remote.object.sha !== expectedHead) throw new Error("owned PR branch moved after failure observation; repair remains UNKNOWN");
			await this.git(directory, ["fetch", "origin", `refs/heads/${repairPull.branch}:refs/remotes/origin/${repairPull.branch}`], signal);
			if (await this.git(directory, ["rev-parse", `refs/remotes/origin/${repairPull.branch}`], signal) !== expectedHead) throw new Error("fetched owned branch differs from the observed PR head; preserve the workspace");
		}
		if (head !== expectedHead) throw new Error("workspace head differs from selected/owned-PR subject; preserve and inspect");
		if (noWorker && await this.git(directory, ["status", "--porcelain"], signal)) throw new Error("partial or dirty reused checkout; preserve user files");
		item.preparation = { phase: "ready", owner, head: item.selected.head! }; this.persist(batch);
		return directory;
	}
	private async queueAutomaticRepair(batch: Batch, item: BatchItem, signal: AbortSignal): Promise<void> {
		const lifecycle = item.prLifecycle;
		const pull = lifecycle?.pullRequest;
		const observation = lifecycle?.observation;
		const owner = `${batch.id}:${item.selected.key}`;
		const claims = this.claims.list();
		if (!lifecycle || lifecycle.phase !== "repair-required" || lifecycle.nextSafeAction !== "repair" || !pull || !observation || observation.result !== "failed" || observation.coverage !== "complete" ||
			!observation.eligibleSubject || !observation.failures?.length || observation.failures.some((failure) => !failure.annotationsComplete || failure.candidateHead !== pull.headSha) ||
			batch.control !== "active" || signal.aborted || this.running.get(owner)?.item !== item || Date.parse(this.timing.now().toISOString()) >= Date.parse(lifecycle.deadlineAt) || lifecycle.observationCount >= 100 ||
			!claims.some((claim) => claim.resource === `repo:${item.selected.repo}` && claim.owner === owner) || !claims.some((claim) => claim.resource === `item:${item.selected.key}` && claim.owner === owner) ||
			item.attempts >= batch.maxAttempts || batch.items.reduce((sum, candidate) => sum + candidate.attempts, 0) >= batch.maxTotalAttempts) {
			throw new Error("hosted repair authority expired before dispatch; preserve the owned PR and failure evidence");
		}
		const failureKey = digest(observation.failures.map((failure) => failure.key).sort().join("\n"));
		if (lifecycle.repair?.failureKey === failureKey) throw new Error("exact hosted failure attempt was already dispatched; preserve its repair lineage");
		await this.github.assertFresh(item.selected, pull, signal);
		if (!observation.policyFingerprint || typeof this.github.hostedCheckPolicyCurrent !== "function" || !await this.github.hostedCheckPolicyCurrent(item.selected.repo, lifecycle.target.ref, item.selected.sourceDefaultRef, observation.policyFingerprint, signal)) throw new Error("hosted check policy changed before automatic repair; keep UNKNOWN for investigation");
		await this.validateProof(item, signal);
		const freshClaims = this.claims.list();
		if (signal.aborted || batch.control !== "active" || Date.parse(this.timing.now().toISOString()) >= Date.parse(lifecycle.deadlineAt) ||
			!freshClaims.some((claim) => claim.resource === `repo:${item.selected.repo}` && claim.owner === owner) || !freshClaims.some((claim) => claim.resource === `item:${item.selected.key}` && claim.owner === owner)) throw new Error("hosted repair lost active authority before its packet was queued");
		const attempt = item.ledger.tasks[0]?.attempts.at(-1);
		if (!attempt?.receipt || attempt.generation !== item.ledger.generation) throw new Error("current admitted repair attempt/receipt is unavailable");
		const packet = {
			version: 1, batch: batch.id, item: item.selected.key, generation: item.ledger.generation,
			acceptanceRevision: item.selected.acceptanceRevision, target: lifecycle.target, pullRequest: pull,
			candidateHead: pull.headSha, observedAt: observation.observedAt, failureKey, failures: observation.failures,
		};
		const bytes = Buffer.from(`${JSON.stringify(packet, null, 2)}\n`);
		if (bytes.length > 1024 * 1024) throw new Error("hosted repair packet exceeds its immutable evidence bound");
		const directory = join(this.root, "evidence", batch.id, digest(item.selected.key).slice(0, 16), attempt.id);
		mkdirSync(directory, { recursive: true, mode: 0o700 });
		const path = join(directory, `hosted-failure-${failureKey.slice(0, 16)}.json`);
		if (existsSync(path)) {
			const existing = readFileSync(path);
			if (!existing.equals(bytes)) throw new Error("hosted repair artifact path already contains different failure evidence");
		} else writeFileSync(path, bytes, { flag: "wx", mode: 0o600 });
		const handle = { id: `evidence-${item.repair?.artifacts.length ?? 0}`, path, digest: createHash("sha256").update(bytes).digest("hex"), bytes: bytes.length, attemptId: attempt.id };
		item.repair = {
			generation: item.ledger.generation, head: item.ledger.subject.head ?? item.ledger.subject.base, acceptanceRevision: item.selected.acceptanceRevision!, attemptId: attempt.id,
			reason: `Hosted failure packet ${handle.id} binds candidate ${pull.headSha} to check-run/attempt evidence; read the complete retained artifact.`,
			candidateHead: pull.headSha, failureKey, artifacts: [...(item.repair?.artifacts ?? []), handle],
		};
		item.prLifecycle = { ...lifecycle, phase: "repairing", nextSafeAction: "repair", repair: { failureKey, candidateHead: pull.headSha, runIds: observation.failures.map((failure) => failure.checkRun.id), attemptId: attempt.id, state: "queued" } };
		const task = item.ledger.tasks[0];
		if (task?.state === "VERIFY" || task?.state === "DONE") this.event(item, { kind: "reopen_task", expectedRevision: item.ledger.revision, taskId: "T1" as TaskId, attemptId: attempt.id as AttemptId, subject: item.ledger.subject, reason: `complete current hosted check diagnostics ${failureKey} require a bounded same-PR repair` });
		this.persist(batch);
	}
	private async execute(batch: Batch, item: BatchItem, signal: AbortSignal, binding?: NativeBinding, bindingError?: string): Promise<void> {
		validateNativeSDK(this.sdk);
		if (!binding) throw new Error(bindingError ?? "OMP execution binding unavailable");
		await this.github.assertFresh(item.selected, undefined, signal);
		const directory = await this.prepareWorkspace(batch, item, signal);
		const mandatory = requiredChecks(item.selected, directory);
		if (mandatory.length) {
			const executables = mandatory.map((check) => {
				const executable = /^([A-Za-z0-9][A-Za-z0-9._+-]*)(?:\s|$)/.exec(check.trim())?.[1];
				if (!executable) throw new Error("task readiness: verification command needs an explicit executable name");
				return executable;
			});
			const capability = await this.preflight(directory, executables, signal);
			const missing = [...new Set(executables)].filter((name) => !capability.available.includes(name));
			if (missing.length) throw new Error(`task readiness: verifier lacks required executable(s): ${missing.join(", ")}; prepare the supported toolchain before retry`);
		}
		if (item.prLifecycle?.phase === "repair-required" && item.prLifecycle.nextSafeAction === "repair") await this.queueAutomaticRepair(batch, item, signal);
		if (item.prLifecycle?.phase === "repairing") {
			const lifecycle = item.prLifecycle;
			this.assertRepairAuthority(batch, item, signal);
			await this.github.assertFresh(item.selected, lifecycle.pullRequest, signal);
			const fingerprint = lifecycle.observation?.policyFingerprint;
			if (!lifecycle.pullRequest || !fingerprint || typeof this.github.hostedCheckPolicyCurrent !== "function" ||
				!await this.github.hostedCheckPolicyCurrent(item.selected.repo, lifecycle.target.ref, item.selected.sourceDefaultRef, fingerprint, signal)) throw new Error("hosted check policy or owned PR changed before repair worker dispatch");
			const branch = await this.github.request<{ object: { sha: string } }>(`repos/${item.selected.repo}/git/ref/heads/${encodeURIComponent(lifecycle.pullRequest.branch)}`, undefined, signal);
			if (branch.object.sha !== lifecycle.pullRequest.headSha) throw new Error("owned PR branch moved before repair worker dispatch; preserve and reconcile");
		}
		if (mandatory.includes("npm test") && item.checkScripts === undefined) {
			if (item.attempts > 0) throw new Error("original package check definition is unavailable for this retained attempt; inspect and declare explicit requiredChecks before retry");
			item.checkScripts = packageCheckScripts(directory); this.persist(batch);
		}
		if (!item.selected.requiredChecks && mandatory.length) { item.selected.requiredChecks = mandatory; this.persist(batch); }
		const previous = item.ledger.tasks.flatMap((task) => task.attempts).filter((attempt) => attempt.generation === item.ledger.generation && attempt.subject.head === item.ledger.subject.head).at(-1);
		const previousReceipt = previous?.receipt;
		const protocolRepair = item.repair && item.repair.generation === item.ledger.generation && item.repair.head === (item.ledger.subject.head ?? item.ledger.subject.base) && item.repair.acceptanceRevision === item.selected.acceptanceRevision ? item.repair : undefined;
			if (protocolRepair && !item.ledger.tasks.some((task) => task.attempts.some((attempt) => attempt.id === protocolRepair.attemptId && attempt.generation === item.ledger.generation && attempt.privateSessions.some((session) => session.phase === "worker" && session.started)))) throw new NativeExecutionError("repair-packet-invalid", "retained repair packet has no matching admitted item/attempt execution; quarantine foreign recovery input");
		const repairFeedback = previousReceipt ? JSON.stringify({ attempt: previous!.id, subject: previousReceipt.subject, acceptanceRevision: item.selected.acceptanceRevision, result: previousReceipt.result, failed: previousReceipt.predicates?.filter((predicate) => !predicate.ok), tests: previousReceipt.tests.filter((test) => test.outcome !== "pass"), unresolved: previousReceipt.unresolved }).slice(0, 32768) : protocolRepair?.reason ?? "";
		if (item.ledger.noProgressAttempts >= 2) {
			if (item.ledger.replans >= 1) throw new Error("plateau after one bounded replan; new evidence or explicit scope decision required");
			this.event(item, { kind: "use_replan", expectedRevision: item.ledger.revision, taskId: "T1" as TaskId });
		}
		if (!item.ledger.tasks.length) this.event(item, { kind: "record_candidate", expectedRevision: item.ledger.revision, candidate: { taskId: "T1" as TaskId, generation: item.ledger.generation, criterionId: "A1" as CriterionId, title: item.selected.key, deps: [], effect: item.selected.action === "inspect" ? "read" : "write", owner: batch.id, necessity: "explicit selected acceptance remains unproved" } });
		if (item.prLifecycle?.phase === "repairing") this.assertRepairAuthority(batch, item, signal);
		item.settlement = undefined;
		item.attempts += 1;
		const attempt = `T1-a${item.attempts}` as AttemptId;
		this.event(item, { kind: "start_attempt", expectedRevision: item.ledger.revision, taskId: "T1" as TaskId, attemptId: attempt, subject: item.ledger.subject });
		const workOperationId = `${batch.id}:${item.selected.key}:work`;
		if (item.operation?.id === workOperationId && item.operation.state === "intent") {
			transitionOperation(item, { attemptId: attempt, phase: "worker" });
		} else {
			if (item.operation) item.operations.push(item.operation);
			item.operation = operationReceipt(batch, item, "worker", "intent", workOperationId, { attemptId: attempt });
		}
		if (item.prLifecycle?.phase === "repairing" && item.prLifecycle.repair?.state === "queued") item.prLifecycle = { ...item.prLifecycle, repair: { ...item.prLifecycle.repair, state: "dispatched" } };
		this.persist(batch);
		if (item.prLifecycle?.phase === "repairing") this.assertRepairAuthority(batch, item, signal);
		const onSession = (phase: "worker" | "acceptance", attemptId: AttemptId) => (sessionFile: string) => {
			if (!item.sessions.includes(sessionFile)) item.sessions.push(sessionFile);
			this.event(item, { kind: "record_private_session", expectedRevision: item.ledger.revision, taskId: "T1" as TaskId, attemptId, phase, sessionFile });
			this.persist(batch);
		};
		const onExecutionStart = (phase: "worker" | "acceptance", attemptId: AttemptId) => (_sessionFile: string) => {
			this.event(item, { kind: "record_private_session_start", expectedRevision: item.ledger.revision, taskId: "T1" as TaskId, attemptId, phase });
			if (phase === "worker") item.stage = "RUNNING";
			this.persist(batch);
		};
		const worker = await runNative(this.sdk, this.schema, binding, item, this.root, "worker", signal, onSession("worker", attempt), onExecutionStart("worker", attempt), repairFeedback, {
			attemptId: attempt,
			repairFeedback,
				artifacts: protocolRepair?.artifacts,
				evidenceRoot: join(this.root, "evidence", batch.id, digest(item.selected.key).slice(0, 16)),
			escalationIdentity: {
				taskId: "T1",
				itemKey: item.selected.key,
				attemptId: attempt,
				generation: item.ledger.generation,
				subject: item.ledger.subject,
				acceptanceRevision: item.selected.acceptanceRevision ?? "",
				acceptance: item.selected.acceptance ?? "",
			},
		});
		batch.usage.modelCalls += worker.calls + (worker.advisor?.usage.calls ?? 0);
		item.stage = "VERIFY"; transitionOperation(item, { phase: "verify", state: "applied" }); this.persist(batch);
		if (item.checkScripts !== undefined && packageCheckScripts(directory) !== item.checkScripts) throw new NativeExecutionError("report-checks-changed", "Worker changed the captured mandatory package test scripts; restore the original checks. A changed verification contract requires explicit operator selection.");
		if (item.selected.action !== "inspect" && !mandatory.length && !worker.tests.length) throw new Error("worker supplied no executable verification; inspect and retry within original appetite");
		await this.git(directory, ["add", "--all"], signal);
		const tree = await this.git(directory, ["write-tree"], signal);
		const evidenceDir = join(this.root, "evidence", batch.id, digest(item.selected.key).slice(0, 16), attempt);
		mkdirSync(evidenceDir, { recursive: true, mode: 0o700 });
		const patch = await this.git(directory, ["diff", "--cached", "--no-ext-diff", "--no-textconv", "--binary", item.selected.head!], signal);
		const patchFile = join(evidenceDir, "patch.diff"); writeFileSync(patchFile, patch, { flag: "wx", mode: 0o600 });
		const artifacts = [patchFile];
		if (worker.advisor) {
			const advisorFile = join(evidenceDir, "advisor-escalation.json");
			writeFileSync(advisorFile, JSON.stringify({
				taskId: "T1",
				attemptId: attempt,
				generation: item.ledger.generation,
				subject: item.ledger.subject,
				acceptanceRevision: item.selected.acceptanceRevision,
				...worker.advisor,
			}, null, 2), { flag: "wx", mode: 0o600 });
			artifacts.push(advisorFile);
		}
		const testWorkspace = join(evidenceDir, "verification-workspace");
		cpSync(directory, testWorkspace, { recursive: true, dereference: false, filter: (path) => !path.endsWith("/.git") });
		const tests: EvidenceReceipt["tests"][number][] = [];
		const verificationPredicates: PredicateEvidence[] = [];
		let verification = `Verified tree: ${tree}\nPatch preview (${Math.min(patch.length, 131072)} of ${patch.length} characters; full content is retained as evidence-0):\n${patch.slice(0, 131072)}\n`;
		for (const [index, test] of [...new Set([...mandatory, ...worker.tests])].entries()) {
			const result = await this.runVerification(testWorkspace, test, signal);
			const artifact = join(evidenceDir, `test-${index}.txt`);
			writeFileSync(artifact, `command: ${test}\nexit: ${result.exitCode}\n${result.output}`, { flag: "wx", mode: 0o600 });
			artifacts.push(artifact); tests.push({ command: test, outcome: result.exitCode === 0 ? "pass" : "fail", artifact });
			verificationPredicates.push({
				phase: "verification",
				item: test,
				ok: result.exitCode === 0,
				note: `exit ${result.exitCode}; artifact ${artifact}`,
			});
			verification += `\n${test}: exit ${result.exitCode}; preview is the last ${Math.min(result.output.length, 16384)} of ${result.output.length} characters. Read the complete retained test artifact.\n${result.output.slice(-16384)}`;
		}
		const handleOffset = protocolRepair?.failureKey ? protocolRepair.artifacts.length : 0;
		const handles = artifacts.map((path, index) => { const bytes = readFileSync(path); return { id: `evidence-${handleOffset + index}`, path, digest: createHash("sha256").update(bytes).digest("hex"), bytes: bytes.length, attemptId: attempt }; });
		item.repair = { generation: item.ledger.generation, head: item.selected.head!, acceptanceRevision: item.selected.acceptanceRevision!, attemptId: attempt, reason: `${protocolRepair?.reason ?? ""}\nAcceptance pending for retained candidate`, ...(protocolRepair?.candidateHead ? { candidateHead: protocolRepair.candidateHead } : {}), ...(protocolRepair?.failureKey ? { failureKey: protocolRepair.failureKey } : {}), artifacts: [...(protocolRepair?.artifacts ?? []), ...handles] };
		transitionOperation(item, { phase: "acceptance" }); this.persist(batch);
			const reviewer = await runNative(this.sdk, this.schema, binding, item, this.root, "acceptance", signal, onSession("acceptance", attempt), onExecutionStart("acceptance", attempt), verification, { attemptId: attempt, artifacts: handles, evidenceRoot: evidenceDir });
		batch.usage.modelCalls += reviewer.calls;
		if (reviewer.accepted && reviewer.evidenceCoverageComplete !== true) throw new NativeExecutionError("report-invalid", "acceptance did not establish full coverage of the retained candidate artifacts");
		for (const artifact of handles) if (createHash("sha256").update(readFileSync(artifact.path)).digest("hex") !== artifact.digest) throw new Error("retained evidence changed during acceptance; proof stale");
		const reviewFile = join(evidenceDir, "acceptance.txt"); writeFileSync(reviewFile, reviewer.report, { flag: "wx", mode: 0o600 }); artifacts.push(reviewFile);
		await this.github.assertFresh(item.selected, undefined, signal);
		if (await this.git(directory, ["write-tree"], signal) !== tree || await this.git(directory, ["diff", "--no-ext-diff", "--no-textconv", "--name-only"], signal) || await this.git(directory, ["ls-files", "--others", "--exclude-standard"], signal)) throw new Error("workspace changed during verification; proof stale");
		const changed = (await this.git(directory, ["diff", "--cached", "--name-only", item.selected.head!], signal)).split("\n").filter(Boolean);
		const workerReportFile = join(evidenceDir, "worker-report.txt");
		writeFileSync(workerReportFile, worker.report, { flag: "wx", mode: 0o600 });
		artifacts.push(workerReportFile);
		const resultSummary = worker.report.length > 1_900 ? `${worker.report.slice(0, 1_900)} … [full report in worker-report.txt]` : worker.report;
		const semanticOutcome = semanticOutcomeFor(item.selected.action, worker.semanticOutcome);
		const unresolved = [
			...(reviewer.accepted ? [] : [reviewer.report]),
			...(semanticOutcome === "uncertain" ? ["semantic result remains uncertain"] : []),
		];
			const assumptions = item.ledger.criteria[0]?.assumptions ?? [];
		const receipt: EvidenceReceipt = {
			version: 2,
			taskId: "T1" as TaskId,
			attemptId: attempt,
			generation: item.ledger.generation,
			subject: item.ledger.subject,
			result: resultSummary,
			changed,
			evidence: artifacts,
			tests,
			predicates: [...worker.predicates, ...verificationPredicates, ...reviewer.predicates],
			cleanEnvironment: true,
			unresolved,
			next: "",
			confidence: "medium",
			routing: { ...(binding.model.provider && binding.model.id ? { requested: `${binding.model.provider}/${binding.model.id}` } : {}), ...(worker.model ? { effective: worker.model } : {}), verified: Boolean(worker.model) },
			exitCode: tests.some((test) => test.outcome === "fail") ? 1 : 0,
			aborted: false,
			truncated: false,
			assumptions,
			...(item.selected.action === "inspect" ? {
				semanticResult: {
					kind: semanticOutcome === "supported" || semanticOutcome === "disproven" ? "finding" as const : "inspection" as const,
					outcome: semanticOutcome === "none" ? "uncertain" : semanticOutcome,
					summary: resultSummary,
					verified: reviewer.accepted === true && semanticOutcome !== "uncertain",
					publicationAuthority: "none" as const,
					...(worker.publicationBlocker === undefined ? {} : { publicationBlocker: worker.publicationBlocker }),
				},
			} : {}),
		};
		this.event(item, { kind: "record_receipt", expectedRevision: item.ledger.revision, taskId: "T1" as TaskId, attemptId: attempt, receipt });
		transitionOperation(item, { state: "applied" }); this.persist(batch);
		if (!reviewer.accepted || receipt.exitCode !== 0) {
			item.stage = "QUEUED"; item.blocker = `acceptance unproved: ${reviewer.report}; repair only selected gap`;
			item.repair.reason = JSON.stringify({ reviewer: reviewer.report, failed: receipt.predicates?.filter((predicate) => !predicate.ok), tests: receipt.tests.filter((test) => test.outcome !== "pass") }).slice(0, 32768);
			this.persist(batch); return;
		}
		const verifiedProof: NonNullable<Batch["items"][number]["proof"]> = { acceptanceRevision: item.selected.acceptanceRevision!, subject: item.ledger.subject.head ?? item.selected.head ?? item.ledger.subject.base, tree, digest: digest(artifacts.map((path) => digest(readFileSync(path, "utf8"))).join("")), artifacts, stage: "verified-patch", reviewerSession: reviewer.session };
			if (item.selected.action === "inspect" || batch.convergence && item.selected.action === "patch") {
			this.event(item, { kind: "finish_task", expectedRevision: item.ledger.revision, taskId: "T1" as TaskId, criterionId: "A1" as CriterionId });
			item.proof = verifiedProof;
			item.stage = "DONE"; item.blocker = undefined; this.persist(batch);
			return;
		}
		item.proof = verifiedProof;
		item.stage = "VERIFY"; item.blocker = "verified patch retained; explicit owner integration is required before completion";
		this.persist(batch);
		if (item.selected.action === "pr-ready") {
			if (item.prLifecycle?.phase === "repairing") await this.publishRepair(batch, item, changed, signal, binding);
			else await this.publish(batch, item, changed, signal, binding);
			item.blocker = item.prLifecycle?.phase === "repairing" ? "same owned PR branch fast-forwarded; hosted checks are being observed automatically" : "owned PR created; hosted checks are being observed automatically";
			this.persist(batch);
		}
	}
	private integrateLatestAttempt(item: BatchItem, head: string): void {
		const task = item.ledger.tasks[0];
		const attempt = task?.attempts.at(-1);
		if (item.ledger.subject.head === head && attempt?.integrated) return;
		if (task?.state === "DONE") throw new Error("completed task cannot be rebound to a publication head without fresh current verification");
		if (!attempt?.receipt || attempt.generation !== item.ledger.generation || attempt.subject.head !== item.ledger.subject.head) throw new Error("current accepted Factory attempt cannot be integrated into the confirmed PR head");
		this.event(item, { kind: "integrate_attempt", expectedRevision: item.ledger.revision, taskId: "T1" as TaskId, attemptId: attempt.id, subject: { ...attempt.subject, head } });
	}
	private async verifyCommittedHead(batch: Batch, item: BatchItem, binding: NativeBinding, head: string, expectedTree: string, signal: AbortSignal): Promise<void> {
		if (!item.workspace || !item.proof || item.proof.tree !== expectedTree) throw new Error("committed candidate lacks the previously accepted tree and workspace");
		const task = item.ledger.tasks[0];
		const attempt = task?.attempts.at(-1);
		if (!task || !attempt?.receipt || attempt.state !== "returned" || attempt.generation !== item.ledger.generation || !attempt.integrated || item.ledger.subject.head !== head) throw new Error("post-commit verification is not bound to the latest integrated admitted attempt");
		if (await this.git(item.workspace, ["rev-parse", "HEAD"], signal) !== head || await this.git(item.workspace, ["rev-parse", "HEAD^{tree}"], signal) !== expectedTree) throw new Error("committed workspace identity changed before current-subject verification");
		const checks = [...new Set([...(item.selected.requiredChecks ?? []), ...attempt.receipt.tests.filter((claim) => claim.outcome === "pass").map((claim) => claim.command)])];
		if (!checks.length || checks.length > 32) throw new Error("current-subject verification has no bounded deterministic check set");
		const executables = checks.map((check) => /^([A-Za-z0-9][A-Za-z0-9._+-]*)(?:\s|$)/.exec(check.trim())?.[1]);
		if (executables.some((name) => !name)) throw new Error("current-subject verifier command lacks an explicit executable name");
		const preflight = await this.preflight(item.workspace, executables as string[], signal);
		if (executables.some((name) => !preflight.available.includes(name!))) throw new Error("current-subject verifier capability is unavailable after commit");
		const evidenceDir = join(this.root, "evidence", batch.id, digest(item.selected.key).slice(0, 16), attempt.id, `current-head-${head.slice(0, 12)}`);
		mkdirSync(evidenceDir, { recursive: true, mode: 0o700 });
		const testWorkspace = join(evidenceDir, "verification-workspace");
		if (existsSync(testWorkspace)) throw new Error("retained current-subject verification workspace exists; preserve and inspect before retry");
		cpSync(item.workspace, testWorkspace, { recursive: true, dereference: false, filter: (path) => !path.endsWith("/.git") });
		const predicates: PredicateEvidence[] = [];
		const handles: { id: string; path: string; digest: string; bytes: number; attemptId: string }[] = [];
		const verificationText: string[] = [`Exact committed subject: ${item.selected.repo}@${head}`, `Exact tree: ${expectedTree}`, `Acceptance revision: ${item.selected.acceptanceRevision}`];
		for (const [index, check] of checks.entries()) {
			const result = await this.runVerification(testWorkspace, check, signal);
			const bytes = Buffer.from(`command: ${check}\nexit: ${result.exitCode}\n${result.output}`);
			const path = join(evidenceDir, `current-test-${index}.txt`);
			writeFileSync(path, bytes, { flag: "wx", mode: 0o600 });
			const id = `evidence-${item.proof.artifacts.length + index}`;
			handles.push({ id, path, digest: createHash("sha256").update(bytes).digest("hex"), bytes: bytes.length, attemptId: attempt.id });
			predicates.push({ phase: "verification", item: check, ok: result.exitCode === 0, note: `exit ${result.exitCode}; retained artifact ${path}` });
			verificationText.push(`${check}: exit ${result.exitCode}; complete output is retained as ${id}.`);
			if (result.exitCode !== 0) throw new Error(`deterministic verification failed on exact committed head ${head}: ${check}`);
		}
		if (item.prLifecycle?.phase === "repairing") this.assertRepairAuthority(batch, item, signal);
		else this.assertPublicationAuthority(batch, item, signal, this.timing.now());
		if (await this.git(item.workspace, ["rev-parse", "HEAD"], signal) !== head || await this.git(item.workspace, ["rev-parse", "HEAD^{tree}"], signal) !== expectedTree || await this.git(item.workspace, ["status", "--porcelain", "--untracked-files=all"], signal)) throw new Error("workspace changed during current-subject verification; proof is stale");
		const onSession = (session: string) => { if (!item.sessions.includes(session)) item.sessions.push(session); this.persist(batch); };
		const reviewer = await runNative(this.sdk!, this.schema, binding, item, this.root, "acceptance", signal, onSession, () => {}, verificationText.join("\n"), { attemptId: attempt.id, artifacts: handles, evidenceRoot: evidenceDir });
		batch.usage.modelCalls += reviewer.calls;
		if (item.prLifecycle?.phase === "repairing") this.assertRepairAuthority(batch, item, signal);
		else this.assertPublicationAuthority(batch, item, signal, this.timing.now());
		if (!reviewer.accepted || reviewer.evidenceCoverageComplete !== true || !reviewer.predicates.some((predicate) => predicate.phase === "acceptance" && predicate.ok) || reviewer.predicates.some((predicate) => predicate.phase === "acceptance" && !predicate.ok)) throw new NativeExecutionError("report-invalid", "fresh acceptance did not positively cover every exact committed-head verification artifact");
		for (const handle of handles) if (createHash("sha256").update(readFileSync(handle.path)).digest("hex") !== handle.digest) throw new Error("current-subject verification artifact changed during independent acceptance");
		const acceptancePath = join(evidenceDir, "current-acceptance.txt");
		writeFileSync(acceptancePath, reviewer.report, { flag: "wx", mode: 0o600 });
		const criterionAssumptions = item.ledger.criteria.find((criterion) => criterion.id === task.criterionId)?.assumptions ?? [];
		const assumptions = criterionAssumptions.map((assumption) => {
			if (assumption.kind !== "dependency-outcome") return assumption;
			const observed = item.ledger.assumptionValues?.find((entry) => entry.kind === "dependency-outcome" && entry.taskId === assumption.taskId);
			if (observed) return observed;
			const dependency = item.ledger.tasks.find((candidate) => candidate.id === assumption.taskId);
			return { ...assumption, value: dependency && criterionProven(item.ledger, dependency.criterionId) ? "proven" : "unproven" };
		});
		const current: CurrentVerificationReceipt = {
			version: 1, taskId: task.id, attemptId: attempt.id, generation: item.ledger.generation,
			subject: { ...item.ledger.subject, head }, tree: expectedTree,
			acceptanceRevision: item.selected.acceptanceRevision!, assumptions,
			predicates: [...predicates, ...reviewer.predicates], acceptanceSession: reviewer.session, checkedAt: this.timing.now().toISOString(),
		};
		this.event(item, { kind: "record_current_verification", expectedRevision: item.ledger.revision, taskId: task.id, attemptId: attempt.id, receipt: current });
		if (task.state === "VERIFY") this.event(item, { kind: "finish_task", expectedRevision: item.ledger.revision, taskId: task.id, criterionId: task.criterionId });
		const artifacts = [...new Set([...item.proof.artifacts, ...handles.map((handle) => handle.path), acceptancePath])];
		item.proof = { ...item.proof, subject: head, tree: expectedTree, artifacts, reviewerSession: reviewer.session, digest: digest(artifacts.map((path) => digest(readFileSync(path, "utf8"))).join("")) };
		if (!item.sessions.includes(reviewer.session)) item.sessions.push(reviewer.session);
		if (!item.ledger.tasks[0]?.attempts.at(-1)?.currentVerification || item.ledger.tasks[0]?.attempts.at(-1)?.receipt?.subject.head === head) throw new Error("current verification failed to preserve a distinct worker receipt and proof identity");
		this.persist(batch);
		await this.validateProof(item, signal);
	}
	private assertRepairAuthority(batch: Batch, item: BatchItem, signal: AbortSignal): void {
		const owner = `${batch.id}:${item.selected.key}`;
		const lifecycle = item.prLifecycle;
		const claims = this.claims.list();
		const packet = item.repair?.artifacts.find((artifact) => lifecycle?.repair && artifact.path.endsWith(`/hosted-failure-${lifecycle.repair.failureKey.slice(0, 16)}.json`));
		let packetCurrent = false;
		if (packet) {
			try {
				const actual = realpathSync(packet.path); const stat = lstatSync(actual); const bytes = readFileSync(actual);
				packetCurrent = actual === resolve(packet.path) && stat.isFile() && stat.nlink === 1 && stat.size === packet.bytes && bytes.length === packet.bytes && createHash("sha256").update(bytes).digest("hex") === packet.digest;
			} catch { packetCurrent = false; }
		}
		if (signal.aborted || batch.control !== "active" || this.running.get(owner)?.item !== item || item.stage !== "RUNNING" && item.stage !== "VERIFY" ||
			!lifecycle || lifecycle.phase !== "repairing" || lifecycle.nextSafeAction !== "repair" || !lifecycle.repair || !["queued", "dispatched"].includes(lifecycle.repair.state) || !lifecycle.pullRequest ||
			lifecycle.owner !== owner || lifecycle.generation !== item.ledger.generation || lifecycle.target.ref !== item.selected.baseRef || lifecycle.target.sha !== item.selected.base ||
			Date.parse(this.timing.now().toISOString()) >= Date.parse(lifecycle.deadlineAt) || lifecycle.observationCount >= 100 ||
			!packetCurrent ||
			!claims.some((claim) => claim.resource === `repo:${item.selected.repo}` && claim.owner === owner) || !claims.some((claim) => claim.resource === `item:${item.selected.key}` && claim.owner === owner)) {
			throw new Error("same-PR repair authority expired or lost; preserve the confirmed branch and resume only through active claimed execution");
		}
	}
	private async publishRepair(batch: Batch, item: BatchItem, changed: string[], signal: AbortSignal, binding: NativeBinding): Promise<void> {
		const lifecycle = item.prLifecycle;
		const pull = lifecycle?.pullRequest;
		if (!changed.length || changed.some((path) => path.startsWith(".github/workflows/"))) throw new Error("repair produced no publishable source change or touched workflow policy; preserve the verified workspace");
		if (!pull || lifecycle?.phase !== "repairing" || item.workspace === undefined) throw new Error("same-PR repair lacks its original pull request and workspace binding");
		await this.validateProof(item, signal);
		this.assertRepairAuthority(batch, item, signal);
		const checks = requiredChecks(item.selected, item.workspace);
		if (checks.length) {
			const executables = checks.map((check) => {
				const executable = /^([A-Za-z0-9][A-Za-z0-9._+-]*)(?:\s|$)/.exec(check.trim())?.[1];
				if (!executable) throw new Error("repair verifier capability cannot be revalidated before the same-PR push");
				return executable;
			});
			const available = await this.preflight(item.workspace, executables, signal);
			if ([...new Set(executables)].some((name) => !available.available.includes(name))) throw new Error("repair verifier capability changed before the same-PR push");
		}
		const parent = await this.git(item.workspace, ["rev-parse", "HEAD"], signal);
		if (parent !== pull.headSha) throw new Error("repair workspace parent differs from the exact observed PR head; no fast-forward attempted");
		await this.git(item.workspace, ["-c", "user.name=Luna Factory", "-c", "user.email=factory@localhost", "commit", "-m", `fix: repair ${item.selected.key} hosted check failure`], signal);
		const sha = await this.git(item.workspace, ["rev-parse", "HEAD"], signal);
		const tree = await this.git(item.workspace, ["rev-parse", "HEAD^{tree}"], signal);
		if (tree !== item.proof!.tree) throw new Error("repair publication tree differs from independently verified candidate");
		this.integrateLatestAttempt(item, sha);
		await this.verifyCommittedHead(batch, item, binding, sha, tree, signal);
		await this.github.assertFresh(item.selected, pull, signal);
		const remote = await this.github.request<{ object: { sha: string } }>(`repos/${item.selected.repo}/git/ref/heads/${encodeURIComponent(pull.branch)}`, undefined, signal);
		if (remote.object.sha !== pull.headSha) throw new Error("owned PR branch moved before repair push; preserve and reconcile");
		if (!item.operation) throw new Error("repair worker operation receipt unavailable");
		item.operations.push(item.operation);
		item.operation = operationReceipt(batch, item, "push", "intent", `${batch.id}:${item.selected.key}:push`, { branch: pull.branch, sha, subject: { ...item.ledger.subject, head: sha } });
		this.persist(batch);
		this.assertRepairAuthority(batch, item, signal);
		await this.validateProof(item, signal);
		await this.github.assertFresh(item.selected, pull, signal);
		const policyFingerprint = item.prLifecycle?.observation?.policyFingerprint;
		if (!policyFingerprint || typeof this.github.hostedCheckPolicyCurrent !== "function" || !await this.github.hostedCheckPolicyCurrent(item.selected.repo, lifecycle.target.ref, item.selected.sourceDefaultRef, policyFingerprint, signal)) throw new Error("hosted check policy changed before the same-PR push; preserve the verified candidate");
		const currentBranch = await this.github.request<{ object: { sha: string } }>(`repos/${item.selected.repo}/git/ref/heads/${encodeURIComponent(pull.branch)}`, undefined, signal);
		if (currentBranch.object.sha !== pull.headSha) throw new Error("owned PR branch moved immediately before repair push; do not overwrite it");
		this.assertRepairAuthority(batch, item, signal);
		await this.pushOwnedBranch(item.workspace, pull.branch, signal);
		transitionOperation(item, { state: "applied" }); this.persist(batch);
		await this.reconcileEffect(batch, item, signal);
		if (item.operation?.phase !== "pr" || item.operation.state !== "applied" || item.prLifecycle?.pullRequest?.identity !== pull.identity || item.prLifecycle.pullRequest.headSha !== sha) throw new Error("same-PR repair push could not be confirmed on the original PR; preserve claims and reconcile");
		item.prLifecycle = { ...item.prLifecycle, phase: "published", nextSafeAction: "observe-after", repair: undefined, observedAt: undefined, observation: undefined, nextObservationAt: this.timing.now().toISOString(), pullRequest: { ...item.prLifecycle.pullRequest, mergeSha: undefined } };
		item.stage = "VERIFY";
		this.persist(batch);
	}
	private async publish(batch: Batch, item: BatchItem, changed: string[], signal: AbortSignal, binding: NativeBinding): Promise<void> {
		if (!changed.length) throw new Error("no patch to publish; retained inspection is not PR-ready");
		if (changed.some((path) => path.startsWith(".github/workflows/"))) throw new Error("Factory refuses workflow publication; retained patch remains inspectable");
		const lifecycle = item.prLifecycle;
		if (!lifecycle || lifecycle.phase !== "admitted" || lifecycle.generation !== item.ledger.generation || lifecycle.owner !== `${batch.id}:${item.selected.key}` ||
			lifecycle.outcome !== "pr-ready" || lifecycle.target.ref !== item.selected.baseRef || lifecycle.target.sha !== item.selected.base) {
			throw new Error("PR publication lacks an admitted exact target/outcome lifecycle; preserve the verified patch");
		}
		await this.validateProof(item, signal);
		this.assertPublicationAuthority(batch, item, signal, new Date());
		const branch = `factory/${batch.id}/${item.selected.number}`;
		await this.git(item.workspace!, ["-c", "user.name=Luna Factory", "-c", "user.email=factory@localhost", "commit", "-m", `fix: address ${item.selected.key}`], signal);
		const sha = await this.git(item.workspace!, ["rev-parse", "HEAD"], signal);
		const tree = await this.git(item.workspace!, ["rev-parse", "HEAD^{tree}"], signal);
		if (tree !== item.proof!.tree) throw new Error("publication tree differs from verified patch");
		this.integrateLatestAttempt(item, sha);
		await this.verifyCommittedHead(batch, item, binding, sha, tree, signal);
		if (!item.operation) throw new Error("verified work operation receipt unavailable");
		item.operations.push(item.operation);
		const subject = { ...item.ledger.subject, head: sha };
		item.operation = operationReceipt(batch, item, "push", "intent", `${batch.id}:${item.selected.key}:push`, { branch, sha, subject });
		this.persist(batch);
		await this.validateProof(item, signal);
		this.assertPublicationAuthority(batch, item, signal, new Date());
		await this.pushOwnedBranch(item.workspace!, branch, signal);
		transitionOperation(item, { state: "applied" }); this.persist(batch);
		await this.createPRFromConfirmedPush(batch, item, signal);
	}
	private assertPublicationAuthority(batch: Batch, item: BatchItem, signal: AbortSignal, now: Date): void {
		const owner = `${batch.id}:${item.selected.key}`;
		const lifecycle = item.prLifecycle;
		const claims = this.claims.list();
		if (signal.aborted || batch.control !== "active" || this.running.get(owner)?.batch !== batch || this.running.get(owner)?.item !== item ||
			item.selected.action !== "pr-ready" || item.stage !== "RUNNING" && item.stage !== "VERIFY" || !lifecycle || lifecycle.phase !== "admitted" ||
			lifecycle.owner !== owner || lifecycle.generation !== item.ledger.generation || lifecycle.outcome !== "pr-ready" || lifecycle.nextSafeAction !== "publish" ||
			lifecycle.target.ref !== item.selected.baseRef || lifecycle.target.sha !== item.selected.base || Date.parse(now.toISOString()) >= Date.parse(lifecycle.deadlineAt) || lifecycle.observationCount >= 100 ||
			!claims.some((claim) => claim.resource === `repo:${item.selected.repo}` && claim.owner === owner) ||
			!claims.some((claim) => claim.resource === `item:${item.selected.key}` && claim.owner === owner)) {
			throw new Error("PR publication authority expired or lost; preserve the confirmed branch and resume only through the active claimed effect lane");
		}
	}
	private mayQueueConfirmedPush(batch: Batch, item: BatchItem): boolean {
		return batch.control === "active" && !["CANCELLED", "EXCLUDED"].includes(item.stage) && item.operation?.phase === "push" && item.operation.state === "applied" && item.prLifecycle?.nextSafeAction === "publish";
	}
	private async createPRFromConfirmedPush(batch: Batch, item: BatchItem, signal: AbortSignal): Promise<void> {
		const operation = item.operation;
		const lifecycle = item.prLifecycle;
		const owner = `${batch.id}:${item.selected.key}`;
		const branch = `factory/${batch.id}/${item.selected.number}`;
		if (!operation || operation.phase !== "push" || operation.state !== "applied" || operation.id !== `${owner}:push` || operation.owner !== owner || operation.generation !== item.ledger.generation ||
			operation.subject.repo !== item.selected.repo || operation.subject.base !== item.ledger.subject.base || operation.subject.head !== operation.sha || operation.branch !== branch || !lifecycle) {
			throw new Error("confirmed push is not bound to the original admitted outcome, generation and branch");
		}
		this.assertPublicationAuthority(batch, item, signal, new Date());
		await this.validateProof(item, signal);
		const ref = await this.github.request<{ object: { sha: string } }>(`repos/${item.selected.repo}/git/ref/heads/${operation.branch}`, undefined, signal);
		if (ref.object.sha !== operation.sha) throw new Error("remote branch differs from the confirmed push; preserve and reconcile");
		const existing = await this.github.request<Array<unknown>>(`repos/${item.selected.repo}/pulls?state=all&head=${encodeURIComponent(`${item.selected.repo.split("/")[0]}:${operation.branch}`)}&per_page=100`, undefined, signal);
		if (existing.length >= 100 || existing.length > 0) throw new Error("a PR candidate or incomplete search exists on the owned branch; reconcile it before publication");
		await this.validateProof(item, signal);
		this.assertPublicationAuthority(batch, item, signal, new Date());
		const localHead = await this.git(item.workspace!, ["rev-parse", "HEAD"], signal);
		const localTree = await this.git(item.workspace!, ["rev-parse", "HEAD^{tree}"], signal);
		if (localHead !== operation.sha || !item.proof?.tree || localTree !== item.proof.tree) throw new Error("confirmed initial branch does not preserve its independently accepted tree");
		if (item.ledger.subject.head !== operation.sha || !item.ledger.tasks[0]?.attempts.at(-1)?.currentVerification) throw new Error("confirmed branch has no persisted exact current-subject verification; do not promote it during reconciliation");
		this.persist(batch);
		item.operations.push(operation);
		item.operation = operationReceipt(batch, item, "pr", "intent", `${owner}:pr`, { branch, sha: operation.sha, subject: operation.subject });
		this.persist(batch);
		await this.createOwnedPullRequest(batch, item, lifecycle, branch, operation.sha!, signal);
	}
	private async createOwnedPullRequest(batch: Batch, item: BatchItem, lifecycle: NonNullable<BatchItem["prLifecycle"]>, branch: string, sha: string, signal: AbortSignal): Promise<void> {
		const operation = item.operation;
		if (!operation || operation.phase !== "pr" || operation.state !== "intent" || operation.owner !== lifecycle.owner || operation.generation !== lifecycle.generation ||
			operation.id !== `${batch.id}:${item.selected.key}:pr` || operation.branch !== branch || operation.sha !== sha || item.selected.action !== lifecycle.outcome) throw new Error("PR create intent is not bound to the admitted owned lifecycle");
		this.assertPublicationAuthority(batch, item, signal, new Date());
		const result = await this.github.request<{ id: number; node_id: string; number: number; html_url: string; state: string; merged: boolean; draft: boolean; head: { sha: string; ref: string; repo: { full_name: string } | null }; base: { sha: string; ref: string; repo: { full_name: string } | null }; merge_commit_sha?: string | null }>(`repos/${item.selected.repo}/pulls`, { title: `fix: address ${item.selected.key}`, head: branch, base: lifecycle.target.ref, body: `Selected Factory acceptance: ${item.selected.key}\n\n${item.selected.kind === "issue" ? "Closes" : "Related to"} ${item.selected.key}\n\nFactory operation: ${operation.id}\n\nVerified tree: ${item.proof?.tree ?? "unavailable"}\nIndependent native acceptance recorded in ${batch.id}. No merge/deploy authority.`, draft: false }, signal);
		if (!Number.isSafeInteger(result.id) || typeof result.node_id !== "string" || !Number.isSafeInteger(result.number) || result.number < 1 ||
			result.head.sha !== sha || result.head.ref !== branch || result.head.repo?.full_name.toLowerCase() !== item.selected.repo ||
			result.base.sha !== lifecycle.target.sha || result.base.ref !== lifecycle.target.ref || result.base.repo?.full_name.toLowerCase() !== item.selected.repo ||
			!canonicalPullUrl(result.html_url, item.selected.repo, result.number) || result.state !== "open" || result.merged || result.draft !== false) throw new Error("created PR identity or subject differs from the admitted same-repository operation");
		transitionOperation(item, { state: "applied", url: result.html_url, resultHandle: result.html_url });
		item.prLifecycle = { ...lifecycle, phase: "published", pullRequest: {
			repository: item.selected.repo, identity: result.node_id, number: result.number, url: result.html_url, branch, headSha: sha,
			baseRef: result.base.ref, baseSha: result.base.sha, ...(result.merge_commit_sha ? { mergeSha: result.merge_commit_sha } : {}), operationId: operation.id,
		}, nextSafeAction: "observe-after" };
		item.stage = "VERIFY"; item.blocker = "owned PR created; hosted checks require bounded reconciliation before PR-ready";
		this.persist(batch);
	}
	private async reconcileEffect(batch: Batch, item: BatchItem, signal?: AbortSignal): Promise<void> {
		const operation = item.operation!;
		try {
			const separator = operation.owner?.indexOf(":") ?? -1;
			const batchId = separator > 0 ? operation.owner!.slice(0, separator) : "";
			if (!batchId || operation.owner !== `${batchId}:${item.selected.key}` || operation.id !== `${batchId}:${item.selected.key}:${operation.phase}` || operation.generation !== item.ledger.generation || operation.subject.repo !== item.selected.repo ||
				operation.subject.base !== item.ledger.subject.base || operation.subject.head !== operation.sha || operation.branch !== `factory/${batchId}/${item.selected.number}` ||
				!item.prLifecycle || item.prLifecycle.owner !== operation.owner || item.prLifecycle.generation !== operation.generation || item.prLifecycle.outcome !== "pr-ready") {
				throw new Error("publication effect is not bound to the original admitted owner, generation, target and outcome");
			}
			const ref = await this.github.request<{ object: { sha: string } }>(`repos/${item.selected.repo}/git/ref/heads/${operation.branch}`, undefined, signal);
			if (ref.object.sha !== operation.sha) throw new Error("remote branch differs from recorded effect");
			const pulls = await this.github.request<Array<{ id: number; node_id: string; number: number; html_url: string; state: string; draft: boolean; head: { sha: string; ref: string; repo: { full_name: string } | null }; base: { sha: string; ref: string; repo: { full_name: string } | null }; merge_commit_sha?: string | null; body: string; merged_at?: string | null }>>(`repos/${item.selected.repo}/pulls?state=all&head=${encodeURIComponent(`${item.selected.repo.split("/")[0]}:${operation.branch}`)}&per_page=100`, undefined, signal);
			if (pulls.length >= 100) throw new Error("owned PR search reached its bound; exact operation reconciliation remains UNKNOWN");
			const marker = operation.id.replace(/:push$/, ":pr");
			const markerText = `Factory operation: ${marker}`;
			const matches = pulls.filter((pull) => Number.isSafeInteger(pull.id) && Number.isSafeInteger(pull.number) && pull.number > 0 && typeof pull.node_id === "string" && pull.node_id.length > 0 && pull.draft === false &&
				canonicalPullUrl(pull.html_url, item.selected.repo, pull.number) && pull.head.sha === operation.sha && pull.head.ref === operation.branch && pull.head.repo?.full_name.toLowerCase() === item.selected.repo &&
				pull.base.ref === item.prLifecycle!.target.ref && pull.base.sha === item.prLifecycle!.target.sha && pull.base.repo?.full_name.toLowerCase() === item.selected.repo &&
				pull.body?.split(/\r?\n/).includes(markerText));
			if (pulls.length === 0 && operation.phase === "push" && operation.state === "applied" && item.prLifecycle?.phase === "repairing") {
				throw new Error("the existing owned PR is not yet visible on its confirmed repair branch; preserve UNKNOWN and reconcile before retry");
			}
			if (pulls.length === 0 && operation.phase === "push" && operation.state === "applied") {
				if (item.stage !== "CANCELLED" && item.stage !== "EXCLUDED") item.stage = "VERIFY";
				item.prLifecycle = { ...item.prLifecycle!, phase: "admitted", nextSafeAction: "publish" };
				if (item.stage !== "CANCELLED" && item.stage !== "EXCLUDED") item.blocker = "confirmed owned branch has no PR; awaiting the admitted effect lane";
				if (!this.running.has(`${batch.id}:${item.selected.key}`)) this.release(item, operation.owner!);
				return;
			}
			if (pulls.length !== 1 || matches.length !== 1) throw new Error("same-repository PR, owned branch, target, head, and logical operation identity are not uniquely reconciled; do not repeat publication");
			const pull = matches[0]!;
			if (pull.state !== "open" || pull.merged_at) throw new Error("owned PR is no longer open; preserve its exact state for explicit reconciliation");
			const repairPush = operation.phase === "push" && item.prLifecycle!.phase === "repairing" && item.prLifecycle!.repair?.state === "dispatched";
			if (operation.phase === "push") {
				const currentVerification = item.ledger.tasks[0]?.attempts.at(-1)?.currentVerification;
				if (item.ledger.subject.head !== operation.sha || currentVerification?.subject.head !== operation.sha) throw new Error("confirmed branch lacks persisted exact current-subject verification; preserve UNKNOWN rather than promoting a prior receipt");
				if (!item.workspace || !item.proof) throw new Error("confirmed branch cannot be reconciled without retained proof and workspace");
				await this.validateProof(item);
				const localHead = await this.git(item.workspace, ["rev-parse", "HEAD"]);
				const localTree = await this.git(item.workspace, ["rev-parse", "HEAD^{tree}"]);
				if (localHead !== operation.sha || localTree !== item.proof.tree || localTree !== currentVerification.tree) throw new Error("confirmed branch tree differs from its persisted current-subject verification");
				item.operations.push(operation.state === "applied" ? operation : { ...operation, state: "applied" });
			}
			if (operation.phase === "push") {
				item.operation = {
					...operation, id: marker, phase: "pr", effect: "pull-request-create", state: "applied",
					url: pull.html_url, resultHandle: pull.html_url,
				};
			} else {
				transitionOperation(item, { state: "applied", url: pull.html_url, resultHandle: pull.html_url });
			}
			item.prLifecycle = { ...item.prLifecycle!, phase: "published", nextSafeAction: "observe-after", ...(repairPush ? { repair: undefined, observedAt: undefined, observation: undefined, nextObservationAt: this.timing.now().toISOString() } : {}), pullRequest: {
				repository: item.selected.repo, identity: pull.node_id, number: pull.number, url: pull.html_url, branch: pull.head.ref, headSha: pull.head.sha,
				baseRef: pull.base.ref, baseSha: pull.base.sha, ...(pull.merge_commit_sha ? { mergeSha: pull.merge_commit_sha } : {}), operationId: marker,
			} };
			if (item.stage !== "CANCELLED" && item.stage !== "EXCLUDED") {
				item.stage = "VERIFY";
				item.blocker = "owned same-repository PR effect is reconciled; bounded hosted-check observation is next";
			}
			if (!this.running.has(`${batch.id}:${item.selected.key}`)) this.release(item, operation.owner!);
		} catch (error) {
			if (!(operation.phase === "push" && operation.state === "applied" && item.operation === operation)) transitionOperation(item, { state: "unknown" });
			item.stage = "UNKNOWN"; item.blocker = `external effect unresolved: ${message(error)}`;
		}
	}
}
