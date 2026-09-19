import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { cpSync, existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { randomUUID } from "node:crypto";
import { batchConverged, batchSummary, createBatch, dependencyBlocker, digest, selectionIdentity, type Batch, type BatchItem, type SelectedItem, type Prerequisite } from "../core/batch.ts";
import { reduce } from "../core/reducer.ts";
import type { AttemptId, CriterionId, EvidenceReceipt, LedgerEvent, TaskId } from "../core/model.ts";
import { BatchStore, ResourceClaims } from "./batch-store.ts";
import { BatchGitHub } from "./batch-github.ts";
import { runNative, sandboxTest, type NativeContext, type NativeSDK, type SchemaBuilder } from "./batch-native.ts";

const command = promisify(execFile);
const message = (error: unknown): string => error instanceof Error ? error.message : String(error);
export interface BatchOptions { capacity: number; maxAttempts: number; maxTotalAttempts: number; mode: "once" | "retain"; dependencies?: Prerequisite[] }
interface Running { batch: Batch; item: BatchItem; controller: AbortController; promise: Promise<void> }

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
	private changed = () => {};
	private context?: NativeContext;
	private fatal?: string;

	constructor(root: string, github: BatchGitHub, sdk: NativeSDK | undefined, schema: SchemaBuilder, capacity: number) {
		this.root = root;
		this.github = github;
		this.sdk = sdk;
		this.schema = schema;
		this.capacity = capacity;
		if (!Number.isSafeInteger(capacity) || capacity < 1 || capacity > 100) throw new Error("invalid shared Factory capacity");
		this.store = new BatchStore(root);
		this.claims = new ResourceClaims(root);
	}
	onChange(callback: () => void): void { this.changed = callback; }
	private persist(batch: Batch): void {
		if (this.fatal) throw new Error(this.fatal);
		try { this.store.write(batch); }
		catch (error) {
			this.fatal = `persistence failed; no new effects: ${message(error)}`;
			for (const active of this.running.values()) active.controller.abort();
			throw error;
		}
		this.changed();
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
		if (!item.proof || item.proof.acceptanceRevision !== item.selected.acceptanceRevision || item.proof.subject !== item.selected.head || this.artifactDigest(item) !== item.proof.digest) throw new Error("proof artifact unavailable, modified or stale; restore exact evidence or explicitly reverify");
		await this.github.assertFresh(item.selected);
		if (!item.workspace || !item.proof.tree) throw new Error("verified workspace tree unavailable");
		if (await this.git(item.workspace, ["write-tree"]) !== item.proof.tree || await this.git(item.workspace, ["diff", "--no-ext-diff", "--no-textconv", "--name-only"]) || await this.git(item.workspace, ["ls-files", "--others", "--exclude-standard"])) throw new Error("retained workspace differs from verified tree; preserve and explicitly reverify");
	}
	async resume(id: string, context: NativeContext): Promise<void> {
		this.store.acquire();
		if (this.fatal) throw new Error(this.fatal);
		this.context = context;
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
				if (item.operation?.phase === "push" || item.operation?.phase === "pr") {
					await this.reconcileEffect(item);
					if (item.stage === "DONE") this.release(item, owner);
					continue;
				}
				if (item.stage === "VERIFY" && item.proof && item.operation?.state === "confirmed") {
					await this.validateProof(item);
					if (item.operation.phase === "pr") await this.reconcileEffect(item);
					continue;
				}
				if (item.operation?.state === "unknown" || item.operation?.state === "intent" || item.stage === "RUNNING" || item.stage === "VERIFY") {
					// The store has proved the previous same-host owner dead. Native file-only
					// sessions cannot push; writes still require explicit retained-patch inspection.
					if (item.selected.action !== "inspect") throw new Error("interrupted native attempt; inspect retained workspace then explicitly retry");
					this.abandon(item, "previous same-host native owner is dead; read-only attempt can resume");
					item.operation = undefined;
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
			} catch (error) { item.stage = "BLOCKED"; item.blocker = message(error); if (item.proof) item.proof = undefined; }
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
		await this.github.assertFresh(item.selected);
		this.abandon(item, "operator requested retry after inspecting retained workspace; original budgets retained");
		if (item.ledger.tasks[0]?.state === "DONE") throw new Error("completed proof cannot be reset by retry; restore evidence or explicitly revise scope");
		item.operation = undefined; item.proof = undefined; item.stage = "QUEUED"; item.blocker = undefined;
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
					if ([...this.running.values()].some((active) => active.item.selected.repo === item.selected.repo)) continue;
					const owner = `${batch.id}:${item.selected.key}`;
					try {
						this.claims.claim(`repo:${item.selected.repo}`, owner);
						try { this.claims.claim(`item:${item.selected.key}`, owner); }
						catch (error) { this.claims.release(`repo:${item.selected.repo}`, owner); throw error; }
					} catch (error) { item.stage = "BLOCKED"; item.blocker = message(error); this.persist(batch); continue; }
					item.stage = "RUNNING"; item.blocker = undefined; this.persist(batch);
					const controller = new AbortController();
					const promise = Promise.resolve().then(() => this.execute(batch, item, controller.signal)).catch((error) => {
						if (item.operation?.phase === "push" || item.operation?.phase === "pr") { item.stage = "UNKNOWN"; item.operation.state = "unknown"; }
						else if (controller.signal.aborted && !message(error).includes("cancellation confirmed after native session settled")) { item.stage = "UNKNOWN"; if (item.operation) item.operation.state = "unknown"; }
						else {
							this.abandon(item, `native attempt settled without proof: ${message(error)}`);
							item.stage = controller.signal.aborted ? "CANCELLED" : "BLOCKED";
							if (item.operation) item.operation.state = "confirmed";
						}
						item.blocker = message(error);
						if (!this.fatal) this.persist(batch);
					}).finally(() => {
						this.running.delete(owner);
						if (!this.fatal && item.stage !== "UNKNOWN") this.release(item, owner);
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
	private async execute(batch: Batch, item: BatchItem, signal: AbortSignal): Promise<void> {
		if (!this.sdk || !this.context) throw new Error("pinned OMP public SDK unavailable; execution refused");
		await this.github.assertFresh(item.selected);
		const directory = join(this.root, "workspaces", batch.id, digest(item.selected.key).slice(0, 16));
		mkdirSync(join(this.root, "workspaces", batch.id), { recursive: true, mode: 0o700 });
		if (!item.workspace) {
			if (existsSync(directory)) throw new Error("fresh execution found retained workspace; inspect, never reset/delete it");
			item.workspace = directory;
			item.operation = { id: `${batch.id}:${item.selected.key}:checkout`, phase: "worker", state: "intent" }; this.persist(batch);
			await command("gh", ["repo", "clone", item.selected.repo, directory, "--", "--no-checkout"], { timeout: 120_000, signal, env: { PATH: process.env.PATH, HOME: this.root, GH_TOKEN: this.github.token, GH_PROMPT_DISABLED: "1", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" } });
			if (item.selected.kind === "pr") await this.git(directory, ["fetch", "origin", `pull/${item.selected.number}/head`], signal);
			await this.git(directory, ["checkout", "--detach", item.selected.head!], signal);
		} else if (item.workspace !== directory || realpathSync(directory) !== directory) throw new Error("retained workspace identity mismatch; preserve and inspect");
		const origin = await this.git(directory, ["remote", "get-url", "origin"], signal);
		if (origin.replace(/\.git$/, "").toLowerCase() !== `https://github.com/${item.selected.repo}`) throw new Error("workspace origin mismatch; preserve and inspect");
		if (await this.git(directory, ["rev-parse", "HEAD"], signal) !== item.selected.head) throw new Error("workspace head differs from selected subject; preserve and inspect");
		if (item.attempts === 0 && await this.git(directory, ["status", "--porcelain"], signal)) throw new Error("dirty reused checkout; preserve user files");
		if (item.ledger.noProgressAttempts >= 2) {
			if (item.ledger.replans >= 1) throw new Error("plateau after one bounded replan; new evidence or explicit scope decision required");
			this.event(item, { kind: "use_replan", expectedRevision: item.ledger.revision, taskId: "T1" as TaskId });
		}
		if (!item.ledger.tasks.length) this.event(item, { kind: "record_candidate", expectedRevision: item.ledger.revision, candidate: { taskId: "T1" as TaskId, generation: item.ledger.generation, criterionId: "A1" as CriterionId, title: item.selected.key, deps: [], effect: item.selected.action === "inspect" ? "read" : "write", owner: batch.id, necessity: "explicit selected acceptance remains unproved" } });
		item.attempts += 1;
		const attempt = `T1-a${item.attempts}` as AttemptId;
		this.event(item, { kind: "start_attempt", expectedRevision: item.ledger.revision, taskId: "T1" as TaskId, attemptId: attempt, subject: item.ledger.subject });
		item.operation = { id: `${batch.id}:${item.selected.key}:${attempt}`, phase: "worker", state: "intent" }; this.persist(batch);
		const onSession = (session: string) => { item.sessions.push(session); this.persist(batch); };
		const worker = await runNative(this.sdk, this.schema, this.context, item, this.root, "worker", signal, onSession, item.blocker ?? "");
		batch.usage.modelCalls += worker.calls;
		item.stage = "VERIFY"; item.operation.phase = "verify"; this.persist(batch);
		if (item.selected.action !== "inspect" && !worker.tests.length) throw new Error("worker supplied no executable verification; inspect and retry within original appetite");
		await this.git(directory, ["add", "--all"], signal);
		const tree = await this.git(directory, ["write-tree"], signal);
		const evidenceDir = join(this.root, "evidence", batch.id, digest(item.selected.key).slice(0, 16), attempt);
		mkdirSync(evidenceDir, { recursive: true, mode: 0o700 });
		const patch = await this.git(directory, ["diff", "--cached", "--no-ext-diff", "--no-textconv", "--binary", item.selected.head!], signal);
		const patchFile = join(evidenceDir, "patch.diff"); writeFileSync(patchFile, patch, { flag: "wx", mode: 0o600 });
		const testWorkspace = join(evidenceDir, "verification-workspace");
		cpSync(directory, testWorkspace, { recursive: true, dereference: false, filter: (path) => !path.endsWith("/.git") });
		const tests: EvidenceReceipt["tests"][number][] = [];
		const artifacts = [patchFile];
		let verification = `Verified tree: ${tree}\nPatch:\n${patch.slice(0, 131072)}\n`;
		for (const [index, test] of worker.tests.entries()) {
			const result = await sandboxTest(testWorkspace, test, signal);
			const artifact = join(evidenceDir, `test-${index}.txt`);
			writeFileSync(artifact, `command: ${test}\nexit: ${result.exitCode}\n${result.output}`, { flag: "wx", mode: 0o600 });
			artifacts.push(artifact); tests.push({ command: test, outcome: result.exitCode === 0 ? "pass" : "fail", artifact });
			verification += `\n${test}: exit ${result.exitCode}\n${result.output.slice(-16384)}`;
		}
		item.operation.phase = "acceptance"; this.persist(batch);
		const reviewer = await runNative(this.sdk, this.schema, this.context, item, this.root, "acceptance", signal, onSession, verification);
		batch.usage.modelCalls += reviewer.calls;
		const reviewFile = join(evidenceDir, "acceptance.txt"); writeFileSync(reviewFile, reviewer.report, { flag: "wx", mode: 0o600 }); artifacts.push(reviewFile);
		await this.github.assertFresh(item.selected);
		if (await this.git(directory, ["write-tree"], signal) !== tree || await this.git(directory, ["diff", "--no-ext-diff", "--no-textconv", "--name-only"], signal) || await this.git(directory, ["ls-files", "--others", "--exclude-standard"], signal)) throw new Error("workspace changed during verification; proof stale");
		const changed = (await this.git(directory, ["diff", "--cached", "--name-only", item.selected.head!], signal)).split("\n").filter(Boolean);
		const receipt: EvidenceReceipt = { version: 1, taskId: "T1" as TaskId, attemptId: attempt, generation: item.ledger.generation, subject: item.ledger.subject, result: worker.report, changed, evidence: artifacts, tests, cleanEnvironment: true, unresolved: reviewer.accepted ? [] : [reviewer.report], next: "", confidence: "medium", routing: { verified: false }, exitCode: tests.some((test) => test.outcome === "fail") ? 1 : 0, aborted: false, truncated: false };
		this.event(item, { kind: "record_receipt", expectedRevision: item.ledger.revision, taskId: "T1" as TaskId, attemptId: attempt, receipt });
		item.operation.state = "confirmed"; this.persist(batch);
		if (!reviewer.accepted || receipt.exitCode !== 0) {
			item.stage = "QUEUED"; item.blocker = `acceptance unproved: ${reviewer.report}; repair only selected gap`;
			this.persist(batch); return;
		}
		item.proof = { acceptanceRevision: item.selected.acceptanceRevision!, subject: item.selected.head!, tree, digest: digest(artifacts.map((path) => digest(readFileSync(path, "utf8"))).join("")), artifacts, stage: "verified-patch", reviewerSession: reviewer.session };
		if (item.selected.action === "inspect") {
			this.event(item, { kind: "finish_task", expectedRevision: item.ledger.revision, taskId: "T1" as TaskId, criterionId: "A1" as CriterionId });
			item.stage = "DONE"; item.blocker = undefined; this.persist(batch);
			return;
		}
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
		item.operation = { id: `${batch.id}:${item.selected.key}:push`, phase: "push", state: "intent", branch, sha }; this.persist(batch);
		await command("git", ["-c", "core.hooksPath=/dev/null", "-c", "credential.helper=!gh auth git-credential", "push", "origin", `HEAD:refs/heads/${branch}`], { cwd: item.workspace, signal, timeout: 120_000, env: { PATH: process.env.PATH, HOME: this.root, GH_TOKEN: this.github.token, GIT_TERMINAL_PROMPT: "0", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" } });
		item.operation.state = "confirmed"; this.persist(batch);
		await this.github.assertFresh(item.selected);
		item.operation = { ...item.operation, id: `${batch.id}:${item.selected.key}:pr`, phase: "pr", state: "intent" }; this.persist(batch);
		const result = await this.github.request<{ html_url: string; head: { sha: string }; base: { ref: string } }>(`repos/${item.selected.repo}/pulls`, { title: `fix: address ${item.selected.key}`, head: branch, base: item.selected.baseRef, body: `Selected Factory acceptance: ${item.selected.key}\n\n${item.selected.kind === "issue" ? "Closes" : "Related to"} ${item.selected.key}\n\nFactory operation: ${item.operation.id}\n\nVerified tree: ${item.proof!.tree}\nIndependent native acceptance recorded in ${batch.id}. No merge/deploy authority.`, draft: false });
		if (result.head.sha !== sha || result.base.ref !== item.selected.baseRef) throw new Error("created PR subject differs from recorded operation");
		item.operation.state = "confirmed"; item.operation.url = result.html_url; item.proof!.stage = "pr-ready"; this.persist(batch);
	}
	private async reconcileEffect(item: BatchItem): Promise<void> {
		const operation = item.operation!;
		try {
			await this.validateProof(item);
			const ref = await this.github.request<{ object: { sha: string } }>(`repos/${item.selected.repo}/git/ref/heads/${operation.branch}`);
			if (ref.object.sha !== operation.sha) throw new Error("remote branch differs from recorded effect");
			const pulls = await this.github.request<Array<{ html_url: string; head: { sha: string }; base: { ref: string }; body: string; merged_at?: string }>>(`repos/${item.selected.repo}/pulls?state=all&head=${encodeURIComponent(`${item.selected.repo.split("/")[0]}:${operation.branch}`)}`);
			const marker = operation.id.replace(/:push$/, ":pr");
			const matches = pulls.filter((pull) => pull.head.sha === operation.sha && pull.base.ref === item.selected.baseRef && pull.body?.includes(`Factory operation: ${marker}`));
			if (matches.length !== 1) throw new Error("exact PR/effect identity unproven; inspect GitHub, do not repeat");
			const pull = matches[0]!;
			operation.state = "confirmed";
			operation.url = pull.html_url;
			operation.phase = "pr";
			operation.id = marker;
			item.proof!.stage = pull.merged_at ? "merged-upstream" : "pr-ready";
			item.stage = "VERIFY";
			item.blocker = "external effect is identified; explicit owner integration and fresh acceptance are required before completion";
		} catch (error) { operation.state = "unknown"; item.stage = "UNKNOWN"; item.blocker = `external effect unresolved: ${message(error)}`; }
	}
}
