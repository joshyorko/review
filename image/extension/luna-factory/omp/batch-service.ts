import { lstat as lstatAsync, readdir as readdirAsync } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { batchConverged, batchSummary, createBatch, dependencyBlocker, digest, selectionIdentity, type Batch, type BatchItem, type SelectedItem, type Prerequisite } from "../core/batch.ts";
import { reconcileReceipt } from "../core/evidence.ts";
import { reduce } from "../core/reducer.ts";
import type { AttemptId, CriterionId, EvidenceReceipt, LedgerEvent, OperationReceipt, PredicateEvidence, TaskId } from "../core/model.ts";
import { BatchStore, ResourceClaims } from "./batch-store.ts";
import { requiredChecks, packageCheckScripts } from "./batch-checks.ts";
import { BatchGitHub } from "./batch-github.ts";
import { runNative, sandboxTest, sandboxPreflight, NativeExecutionError, resolveNativeBinding, validateNativeSDK, type NativeBinding, type NativeContext, type NativeSDK, type SchemaBuilder, type SemanticOutcome } from "./batch-native.ts";

const command = promisify(execFile);
const message = (error: unknown): string => error instanceof Error ? error.message : String(error);
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
export interface BatchOptions { capacity: number; maxAttempts: number; maxTotalAttempts: number; mode: "once" | "retain"; dependencies?: Prerequisite[] }
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
	private pumping?: Promise<void>;
	private submitTail: Promise<void> = Promise.resolve();
	private changed = new Set<BatchChangeListener>();
	private bindings = new Map<string, { binding: NativeBinding } | { error: string }>();
	private fatal?: string;

	constructor(root: string, github: BatchGitHub, sdk: NativeSDK | undefined, schema: SchemaBuilder, capacity: number, claimsRoot = root) {
		this.root = root;
		this.github = github;
		this.sdk = sdk;
		this.schema = schema;
		this.capacity = capacity;
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
			for (const proposed of preliminary.items) {
				const prior = duplicate.items.find((item) => item.selected.key === proposed.selected.key);
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
		return batch;
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
	private async validateProof(item: BatchItem): Promise<void> {
		if (!item.proof || item.proof.acceptanceRevision !== item.selected.acceptanceRevision || item.proof.subject !== item.selected.head || this.artifactDigest(item) !== item.proof.digest) {
			throw new Error("proof artifact unavailable, modified or stale; restore exact evidence or explicitly reverify");
		}
		const task = item.ledger.tasks[0];
		const attempt = task?.attempts.at(-1);
		if (!task || !attempt?.receipt) throw new Error("current Factory proof receipt unavailable");
		const current = reconcileReceipt(item.ledger, attempt.receipt, {
			taskId: task.id,
			attemptId: attempt.id,
			subject: attempt.subject,
			artifactRoots: [this.root],
		});
		if (current.status !== "proven") throw new Error(`Factory proof is ${current.status}: ${current.reasons.join("; ")}`);
		await this.github.assertFresh(item.selected);
		if (!item.workspace || !item.proof.tree) throw new Error("verified workspace tree unavailable");
		if (await this.git(item.workspace, ["write-tree"]) !== item.proof.tree || await this.git(item.workspace, ["diff", "--no-ext-diff", "--no-textconv", "--name-only"]) || await this.git(item.workspace, ["ls-files", "--others", "--exclude-standard"])) {
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
		for (const item of batch.items) {
			const owner = `${id}:${item.selected.key}`;
			if (this.running.has(owner) || item.stage === "CANCELLED" || item.stage === "EXCLUDED") continue;
			try {
				if (item.stage === "DONE") {
					await this.validateProof(item);
					if (item.operation?.phase === "pr") await this.reconcileEffect(item);
					continue;
				}
				if (item.operation?.state === "not-applied") {
					item.operations.push(item.operation);
					item.operation = undefined;
				}
				if (item.operation?.phase === "push" || item.operation?.phase === "pr") {
					await this.reconcileEffect(item);
					if (item.stage === "DONE") this.release(item, owner);
					continue;
				}
				if (item.stage === "VERIFY" && item.proof && item.operation?.state === "applied") {
					await this.validateProof(item);
					if (item.operation.phase === "pr") await this.reconcileEffect(item);
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
		batch.control = "active";
		this.persist(batch);
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
		if ((item.operation?.state === "unknown" || item.operation?.state === "intent") && !(item.attempts === 0 && item.sessions.length === 0 && item.preparation && item.preparation.phase !== "ready" && item.preparation.owner === owner && item.preparation.head === item.selected.head && item.operation.phase === "worker" && item.operation.owner === owner && item.operation.generation === item.ledger.generation)) {
			const attempt = item.ledger.tasks[0]?.attempts.at(-1);
			if (!attempt || item.settlement?.outcome !== "cancelled" || item.settlement.attemptId !== attempt.id || !item.settlement.sessionFiles.length || item.settlement.sessionFiles.some((path) => !attempt.privateSessions.some((session) => session.sessionFile === path))) throw new Error("native settlement is unproved; preserve claims and inspect before retry");
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
			for (const active of this.running.values()) active.controller.abort();
			await Promise.allSettled([...this.running.values()].map((active) => active.promise));
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
				if (this.running.size >= this.capacity) break;
				if ([...this.running.values()].filter((active) => active.batch.id === batch.id).length >= batch.capacity) continue;
				for (const item of batch.items.filter((candidate) => candidate.stage === "QUEUED").sort((a, b) => a.attempts - b.attempts)) {
					const dependency = dependencyBlocker(batch, item.selected.key);
					if (dependency) { item.blocker = dependency; continue; }
					if (item.attempts >= batch.maxAttempts || batch.items.reduce((sum, candidate) => sum + candidate.attempts, 0) >= batch.maxTotalAttempts) { item.stage = "BLOCKED"; item.blocker = "original attempt budget exhausted; retry never resets it"; this.persist(batch); continue; }
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
					item.stage = "QUEUED"; item.blocker = undefined; this.persist(batch);
					const controller = new AbortController();
					const promise = Promise.resolve().then(() => this.execute(batch, item, controller.signal, binding, bindingError)).catch((error) => {
						if (item.operation?.phase === "push" || item.operation?.phase === "pr" || item.operation?.state === "unknown") {
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
						item.blocker = message(error);
						if (!this.fatal) this.persist(batch);
					}).finally(() => {
						this.running.delete(owner);
						if (!this.fatal && item.stage !== "UNKNOWN" && item.operation?.state !== "unknown") this.release(item, owner);
						this.notifyChanged(batch.id);
					});
					this.running.set(owner, { batch, item, controller, promise });
					batch.usage.peakWorkers = Math.max(batch.usage.peakWorkers, this.running.size);
					dispatched = true;
					break;
				}
			}
			if (dispatched && this.running.size < this.capacity) continue;
			if (!this.running.size) break;
			await Promise.race([...this.running.values()].map((active) => active.promise));
		}
		for (const batch of this.batches.values()) {
			if (!this.fatal) this.persist(batch);
		}
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
		const result = await command("git", ["-c", "core.hooksPath=/dev/null", "-c", "protocol.file.allow=never", ...args], { cwd: workspace, signal, timeout: 60_000, maxBuffer: 4 * 1024 * 1024, env: { PATH: process.env.PATH, HOME: this.root, GIT_TERMINAL_PROMPT: "0", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" } });
		return result.stdout.trimEnd();
	}
	private async cloneWorkspace(item: BatchItem, directory: string, signal: AbortSignal): Promise<void> {
		await command("gh", ["repo", "clone", item.selected.repo, directory, "--", "--no-checkout"], { timeout: 120_000, signal, env: { PATH: process.env.PATH, HOME: this.root, GH_TOKEN: this.github.token, GH_PROMPT_DISABLED: "1", GIT_TERMINAL_PROMPT: "0", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" } });
	}
	private async prepareWorkspace(batch: Batch, item: BatchItem, signal: AbortSignal): Promise<string> {
		const directory = join(this.root, "workspaces", batch.id, digest(item.selected.key).slice(0, 16));
		const owner = `${batch.id}:${item.selected.key}`;
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
		const parent = join(this.root, "workspaces", batch.id);
		mkdirSync(parent, { recursive: true, mode: 0o700 });
		if (realpathSync(parent) !== parent || (process.getuid && lstatSync(parent).uid !== process.getuid())) throw new Error("workspace parent is not the canonical runtime-owned directory; inspect ownership before cloning");
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
		const origin = await this.git(directory, ["remote", "get-url", "origin"], signal);
		if (origin.replace(/\.git$/, "").toLowerCase() !== `https://github.com/${item.selected.repo}`) throw new Error("workspace origin mismatch; preserve and inspect");
		let head: string | undefined;
		try { head = await this.git(directory, ["rev-parse", "HEAD"], signal); } catch { /* An evidenced partial clone may have no checked-out HEAD. */ }
		const initializing = item.preparation?.phase !== "ready" && noWorker && (evidenced || item.operation?.state === "intent");
		const entries = readdirSync(directory).filter((name) => name !== ".git");
		if (initializing && entries.length === 0) {
			item.operation = operationReceipt(batch, item, "worker", "intent", `${owner}:work`);
			item.preparation = { phase: "checkout", owner, head: item.selected.head! }; this.persist(batch);
			if (item.selected.kind === "pr") await this.git(directory, ["fetch", "origin", `pull/${item.selected.number}/head`], signal);
			await this.git(directory, ["checkout", "--detach", item.selected.head!], signal);
			head = await this.git(directory, ["rev-parse", "HEAD"], signal);
		} else if (head !== item.selected.head) {
			throw new Error("partial workspace or selected head mismatch with retained files; preserve and inspect before preparation");
		}
		if (head !== item.selected.head) throw new Error("workspace head differs from selected subject; preserve and inspect");
		if (noWorker && await this.git(directory, ["status", "--porcelain"], signal)) throw new Error("partial or dirty reused checkout; preserve user files");
		item.preparation = { phase: "ready", owner, head: item.selected.head! }; this.persist(batch);
		return directory;
	}
	private async execute(batch: Batch, item: BatchItem, signal: AbortSignal, binding?: NativeBinding, bindingError?: string): Promise<void> {
		validateNativeSDK(this.sdk);
		if (!binding) throw new Error(bindingError ?? "OMP execution binding unavailable");
		await this.github.assertFresh(item.selected);
		const directory = await this.prepareWorkspace(batch, item, signal);
		const mandatory = requiredChecks(item.selected, directory);
		if (mandatory.length) {
			const executables = mandatory.map((check) => {
				const executable = /^([A-Za-z0-9][A-Za-z0-9._+-]*)(?:\s|$)/.exec(check.trim())?.[1];
				if (!executable) throw new Error("task readiness: verification command needs an explicit executable name");
				return executable;
			});
			const capability = await sandboxPreflight(directory, executables, signal);
			const missing = [...new Set(executables)].filter((name) => !capability.available.includes(name));
			if (missing.length) throw new Error(`task readiness: verifier lacks required executable(s): ${missing.join(", ")}; prepare the supported toolchain before retry`);
		}
		if (mandatory.includes("npm test") && item.checkScripts === undefined) {
			if (item.attempts > 0) throw new Error("original package check definition is unavailable for this retained attempt; inspect and declare explicit requiredChecks before retry");
			item.checkScripts = packageCheckScripts(directory); this.persist(batch);
		}
		if (!item.selected.requiredChecks && mandatory.length) { item.selected.requiredChecks = mandatory; this.persist(batch); }
		const previous = item.ledger.tasks.flatMap((task) => task.attempts).filter((attempt) => attempt.generation === item.ledger.generation && attempt.subject.head === item.selected.head).at(-1);
		const previousReceipt = previous?.receipt;
		const protocolRepair = item.repair && item.repair.generation === item.ledger.generation && item.repair.head === item.selected.head && item.repair.acceptanceRevision === item.selected.acceptanceRevision ? item.repair : undefined;
		const repairFeedback = previousReceipt ? JSON.stringify({ attempt: previous!.id, subject: previousReceipt.subject, acceptanceRevision: item.selected.acceptanceRevision, result: previousReceipt.result, failed: previousReceipt.predicates?.filter((predicate) => !predicate.ok), tests: previousReceipt.tests.filter((test) => test.outcome !== "pass"), unresolved: previousReceipt.unresolved }).slice(0, 32768) : protocolRepair?.reason ?? "";
		if (item.ledger.noProgressAttempts >= 2) {
			if (item.ledger.replans >= 1) throw new Error("plateau after one bounded replan; new evidence or explicit scope decision required");
			this.event(item, { kind: "use_replan", expectedRevision: item.ledger.revision, taskId: "T1" as TaskId });
		}
		if (!item.ledger.tasks.length) this.event(item, { kind: "record_candidate", expectedRevision: item.ledger.revision, candidate: { taskId: "T1" as TaskId, generation: item.ledger.generation, criterionId: "A1" as CriterionId, title: item.selected.key, deps: [], effect: item.selected.action === "inspect" ? "read" : "write", owner: batch.id, necessity: "explicit selected acceptance remains unproved" } });
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
		this.persist(batch);
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
		const worker = await runNative(this.sdk, this.schema, binding, item, this.root, "worker", signal, onSession("worker", attempt), onExecutionStart("worker", attempt), repairFeedback, { attemptId: attempt, repairFeedback, artifacts: protocolRepair?.artifacts });
		batch.usage.modelCalls += worker.calls;
		item.stage = "VERIFY"; transitionOperation(item, { phase: "verify", state: "applied" }); this.persist(batch);
		if (item.checkScripts !== undefined && packageCheckScripts(directory) !== item.checkScripts) throw new NativeExecutionError("report-invalid", "Worker changed the captured mandatory package test scripts; restore the original checks. A changed verification contract requires explicit operator selection.");
		if (item.selected.action !== "inspect" && !mandatory.length && !worker.tests.length) throw new Error("worker supplied no executable verification; inspect and retry within original appetite");
		await this.git(directory, ["add", "--all"], signal);
		const tree = await this.git(directory, ["write-tree"], signal);
		const evidenceDir = join(this.root, "evidence", batch.id, digest(item.selected.key).slice(0, 16), attempt);
		mkdirSync(evidenceDir, { recursive: true, mode: 0o700 });
		const patch = await this.git(directory, ["diff", "--cached", "--no-ext-diff", "--no-textconv", "--binary", item.selected.head!], signal);
		const patchFile = join(evidenceDir, "patch.diff"); writeFileSync(patchFile, patch, { flag: "wx", mode: 0o600 });
		const testWorkspace = join(evidenceDir, "verification-workspace");
		cpSync(directory, testWorkspace, { recursive: true, dereference: false, filter: (path) => !path.endsWith("/.git") });
		const tests: EvidenceReceipt["tests"][number][] = [];
		const verificationPredicates: PredicateEvidence[] = [];
		const artifacts = [patchFile];
		let verification = `Verified tree: ${tree}\nPatch preview (${Math.min(patch.length, 131072)} of ${patch.length} characters; full content is retained as evidence-0):\n${patch.slice(0, 131072)}\n`;
		for (const [index, test] of [...new Set([...mandatory, ...worker.tests])].entries()) {
			const result = await sandboxTest(testWorkspace, test, signal);
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
		const handles = artifacts.map((path, index) => { const bytes = readFileSync(path); return { id: `evidence-${index}`, path, digest: createHash("sha256").update(bytes).digest("hex"), bytes: bytes.length, attemptId: attempt }; });
		item.repair = { generation: item.ledger.generation, head: item.selected.head!, acceptanceRevision: item.selected.acceptanceRevision!, attemptId: attempt, reason: "Acceptance pending for retained candidate", artifacts: handles };
		transitionOperation(item, { phase: "acceptance" }); this.persist(batch);
		const reviewer = await runNative(this.sdk, this.schema, binding, item, this.root, "acceptance", signal, onSession("acceptance", attempt), onExecutionStart("acceptance", attempt), verification, { attemptId: attempt, artifacts: handles });
		batch.usage.modelCalls += reviewer.calls;
		if (reviewer.accepted && reviewer.evidenceCoverageComplete !== true) throw new NativeExecutionError("report-invalid", "acceptance did not establish full coverage of the retained candidate artifacts");
		for (const artifact of handles) if (createHash("sha256").update(readFileSync(artifact.path)).digest("hex") !== artifact.digest) throw new Error("retained evidence changed during acceptance; proof stale");
		const reviewFile = join(evidenceDir, "acceptance.txt"); writeFileSync(reviewFile, reviewer.report, { flag: "wx", mode: 0o600 }); artifacts.push(reviewFile);
		await this.github.assertFresh(item.selected);
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
		const assumptions = item.selected.acceptanceRevision
			? [{ kind: "acceptance-revision" as const, value: item.selected.acceptanceRevision }]
			: [];
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
					outcome: semanticOutcome,
					summary: resultSummary,
					verified: reviewer.accepted && semanticOutcome !== "uncertain",
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
		const verifiedProof: NonNullable<Batch["items"][number]["proof"]> = { acceptanceRevision: item.selected.acceptanceRevision!, subject: item.selected.head!, tree, digest: digest(artifacts.map((path) => digest(readFileSync(path, "utf8"))).join("")), artifacts, stage: "verified-patch", reviewerSession: reviewer.session };
		if (item.selected.action === "inspect") {
			this.event(item, { kind: "finish_task", expectedRevision: item.ledger.revision, taskId: "T1" as TaskId, criterionId: "A1" as CriterionId });
			item.proof = verifiedProof;
			item.stage = "DONE"; item.blocker = undefined; this.persist(batch);
			return;
		}
		item.proof = verifiedProof;
		item.stage = "VERIFY"; item.blocker = "verified patch retained; explicit owner integration is required before completion";
		this.persist(batch);
		if (item.selected.action === "pr-ready") {
			await this.publish(batch, item, changed, signal);
			item.blocker = "PR created; explicit owner integration and fresh acceptance are required before completion";
			this.persist(batch);
		}
	}
	private async publish(batch: Batch, item: BatchItem, changed: string[], signal: AbortSignal): Promise<void> {
		if (!changed.length) throw new Error("no patch to publish; retained inspection is not PR-ready");
		if (changed.some((path) => path.startsWith(".github/workflows/"))) throw new Error("Factory refuses workflow publication; retained patch remains inspectable");
		await this.validateProof(item);
		const branch = `factory/${batch.id}/${item.selected.number}`;
		await this.git(item.workspace!, ["-c", "user.name=Luna Factory", "-c", "user.email=factory@localhost", "commit", "-m", `fix: address ${item.selected.key}`], signal);
		const sha = await this.git(item.workspace!, ["rev-parse", "HEAD"], signal);
		if (await this.git(item.workspace!, ["rev-parse", "HEAD^{tree}"], signal) !== item.proof!.tree) throw new Error("publication tree differs from verified patch");
		if (!item.operation) throw new Error("verified work operation receipt unavailable");
		item.operations.push(item.operation);
		const subject = { ...item.ledger.subject, head: sha };
		item.operation = operationReceipt(batch, item, "push", "intent", `${batch.id}:${item.selected.key}:push`, { branch, sha, subject });
		this.persist(batch);
		await command("git", ["-c", "core.hooksPath=/dev/null", "-c", "credential.helper=!gh auth git-credential", "push", "origin", `HEAD:refs/heads/${branch}`], { cwd: item.workspace, signal, timeout: 120_000, env: { PATH: process.env.PATH, HOME: this.root, GH_TOKEN: this.github.token, GIT_TERMINAL_PROMPT: "0", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" } });
		transitionOperation(item, { state: "applied" }); this.persist(batch);
		await this.github.assertFresh(item.selected);
		item.operations.push(item.operation);
		item.operation = operationReceipt(batch, item, "pr", "intent", `${batch.id}:${item.selected.key}:pr`, { branch, sha, subject });
		this.persist(batch);
		const result = await this.github.request<{ html_url: string; head: { sha: string }; base: { ref: string } }>(`repos/${item.selected.repo}/pulls`, { title: `fix: address ${item.selected.key}`, head: branch, base: item.selected.baseRef, body: `Selected Factory acceptance: ${item.selected.key}\n\n${item.selected.kind === "issue" ? "Closes" : "Related to"} ${item.selected.key}\n\nFactory operation: ${item.operation.id}\n\nVerified tree: ${item.proof!.tree}\nIndependent native acceptance recorded in ${batch.id}. No merge/deploy authority.`, draft: false });
		if (result.head.sha !== sha || result.base.ref !== item.selected.baseRef) throw new Error("created PR subject differs from recorded operation");
		transitionOperation(item, { state: "applied", url: result.html_url, resultHandle: result.html_url });
		item.proof!.stage = "pr-ready"; this.persist(batch);
	}
	private async reconcileEffect(item: BatchItem): Promise<void> {
		const operation = item.operation!;
		try {
			await this.validateProof(item);
			const ref = await this.github.request<{ object: { sha: string } }>(`repos/${item.selected.repo}/git/ref/heads/${operation.branch}`);
			if (ref.object.sha !== operation.sha) throw new Error("remote branch differs from recorded effect");
			const pulls = await this.github.request<Array<{ html_url: string; head: { sha: string }; base: { ref: string }; body: string; merged_at?: string }>>(`repos/${item.selected.repo}/pulls?state=all&head=${encodeURIComponent(`${item.selected.repo.split("/")[0]}:${operation.branch}`)}`);
			const marker = operation.id.replace(/:push$/, ":pr");
			const markerText = `Factory operation: ${marker}`;
			const matches = pulls.filter((pull) => pull.head.sha === operation.sha && pull.base.ref === item.selected.baseRef && pull.body?.split(/\r?\n/).includes(markerText));
			if (matches.length !== 1) throw new Error("exact PR/effect identity unproven; inspect GitHub, do not repeat");
			const pull = matches[0]!;
			if (operation.phase === "push") {
				item.operation = {
					...operation, id: marker, phase: "pr", effect: "pull-request-create", state: "applied",
					url: pull.html_url, resultHandle: pull.html_url,
				};
			} else {
				transitionOperation(item, { state: "applied", url: pull.html_url, resultHandle: pull.html_url });
			}
			item.proof!.stage = pull.merged_at ? "merged-upstream" : "pr-ready";
			item.stage = "VERIFY";
			item.blocker = "external effect is identified; explicit owner integration and fresh acceptance are required before completion";
		} catch (error) { transitionOperation(item, { state: "unknown" }); item.stage = "UNKNOWN"; item.blocker = `external effect unresolved: ${message(error)}`; }
	}
}
