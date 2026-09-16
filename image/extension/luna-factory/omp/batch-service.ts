import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { batchConverged, batchSummary, createBatch, dependencyBlocker, digest, selectionIdentity, type Batch, type BatchItem, type FactoryAction, type SelectedItem, type Prerequisite } from "../core/batch.ts";
import { reduce } from "../core/reducer.ts";
import type { AttemptId, CriterionId, EvidenceReceipt, LedgerEvent, TaskId } from "../core/model.ts";
import { BatchStore, ResourceClaims } from "./batch-store.ts";
import { BatchGitHub } from "./batch-github.ts";
import { runNative, sandboxTest, type NativeContext, type NativeSDK, type SchemaBuilder } from "./batch-native.ts";

const command = promisify(execFile);
function logicalSelectionIdentity(items: readonly SelectedItem[]): string {
    return digest(JSON.stringify(items.map((item) => ({ key: item.key, action: item.action, acceptanceRevision: item.acceptanceRevision ?? "", acceptance: item.acceptance ?? "", base: item.base ?? "", head: item.head ?? "" })).sort((a, b) => a.key.localeCompare(b.key))));
}
export interface BatchOptions { capacity: number; maxAttempts: number; maxTotalAttempts: number; mode: "once" | "retain"; dependencies?: Prerequisite[] }
export class BatchService {
	readonly store: BatchStore;
	readonly claims: ResourceClaims;
	private batches = new Map<string, Batch>();
	private running = new Map<string, { batch: Batch; item: BatchItem; controller: AbortController; promise: Promise<void> }>();
    private pumping?: Promise<void>;
    private submitTail: Promise<void> = Promise.resolve();
    private changed = () => {};
    private context?: NativeContext;
    private fatal?: string;
	constructor(readonly root: string, readonly github: BatchGitHub, readonly sdk: NativeSDK | undefined, readonly schema: SchemaBuilder, readonly capacity: number) {
		this.store = new BatchStore(root);
		this.claims = new ResourceClaims(root);
	}
	onChange(callback: () => void): void { this.changed = callback; }
	private persist(batch: Batch): void {
		try { this.store.write(batch); this.changed(); }
		catch (error) { this.fatal = `persistence failed; no new effects: ${error instanceof Error ? error.message : String(error)}`; throw error; }
	}
	status(id?: string): string {
		const batches = id ? [this.batches.get(id) ?? this.store.read(id)] : this.store.list();
		return batches.length ? batches.map((batch) => batchSummary(batch, this.root)).join("\n\n") : `Factory has no batches. State: ${this.root}. Select Review items, then /factory selected inspect|patch|pr-ready.`;
	}
    async submit(selected: SelectedItem[], options: BatchOptions): Promise<Batch> {
        const run = this.submitTail.then(() => this.submitUnsafe(selected, options));
        this.submitTail = run.then(() => undefined, () => undefined);
        return run;
    }
    private async submitUnsafe(selected: SelectedItem[], options: BatchOptions): Promise<Batch> {
		this.store.acquire();
		if (this.fatal) throw new Error(this.fatal);
		const snapshot = structuredClone(selected);
        const duplicate = this.store.list().find((batch) => logicalSelectionIdentity(batch.items.map((item) => item.selected)) === logicalSelectionIdentity(snapshot) && !batchConverged(batch));
        if (duplicate) { this.batches.set(duplicate.id, duplicate); return duplicate; }
		// Admission is bounded by shared capacity too; one inaccessible repository does not discard another.
		let next = 0;
		await Promise.all(Array.from({ length: Math.min(this.capacity, snapshot.length) }, async () => {
			while (next < snapshot.length) {
				const index = next++;
				try { snapshot[index] = await this.github.snapshot(snapshot[index]!); }
				catch (error) { snapshot[index]!.blocker = error instanceof Error ? error.message : String(error); }
			}
		}));
		const batch = createBatch(snapshot, { ...options, capacity: Math.min(options.capacity, this.capacity), id: `batch-${randomUUID()}` });
		for (const item of batch.items) {
			const existing = this.store.list().find((other) => other.items.some((candidate) => candidate.selected.key === item.selected.key && candidate.stage !== "DONE" && candidate.stage !== "EXCLUDED"));
			if (existing) { item.stage = "BLOCKED"; item.blocker = `already tracked by ${existing.id}; attach there instead of duplicate execution`; }
		}
		this.persist(batch);
		this.batches.set(batch.id, batch);
		return batch;
	}
	async resume(id: string, context: NativeContext): Promise<void> {
		this.store.acquire();
		if (this.fatal) throw new Error(this.fatal);
		this.context = context;
		const batch = this.batches.get(id) ?? this.store.read(id);
		this.batches.set(id, batch);
		for (const item of batch.items) {
			if (this.running.has(`${id}:${item.selected.key}`) || item.stage === "CANCELLED" || item.stage === "EXCLUDED") continue;
			if (item.stage === "DONE") {
				if (!item.proof || item.proof.artifacts.some((artifact) => !existsSync(artifact))) { item.stage = "BLOCKED"; item.blocker = "proof artifact unavailable; restore exact artifact or explicitly reverify"; item.proof = undefined; }
				continue;
			}
			if (item.operation?.state === "intent" || item.operation?.state === "unknown" || item.stage === "RUNNING" || item.stage === "UNKNOWN") {
				if (item.operation?.phase === "push" || item.operation?.phase === "pr") {
					await this.reconcileEffect(item);
				} else {
					// Restricted native sessions cannot perform external effects. The dead store owner proves they died.
					item.stage = "BLOCKED";
					item.blocker = "interrupted native attempt; retained workspace requires inspection before explicit retry";
					if (item.operation) item.operation.state = "unknown";
				}
				this.persist(batch);
				continue;
			}
			try {
				if (item.selected.acceptanceRevision) await this.github.assertFresh(item.selected);
				else item.selected = await this.github.snapshot(item.selected);
				const overlap = item.selected.overlaps.find((key) => batch.items.some((candidate) => candidate.selected.key === key && candidate.stage !== "EXCLUDED"));
				if (overlap) throw new Error(`overlaps ${overlap}; explicitly revise scope or dependencies`);
				if (item.blocker?.includes("proof artifact") || item.blocker?.includes("already tracked") || item.operation?.state === "unknown") continue;
				item.stage = "QUEUED"; item.blocker = undefined;
			} catch (error) { item.stage = "BLOCKED"; item.proof = undefined; item.blocker = error instanceof Error ? error.message : String(error); }
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
			const active = this.running.get(`${id}:${item.selected.key}`);
			if (active) item.blocker = "cancellation requested; conflicting ownership retained until native disposal confirms";
			else if (!["DONE", "EXCLUDED", "UNKNOWN"].includes(item.stage)) { item.stage = "CANCELLED"; item.blocker = "operator stopped this item; explicit retry required"; }
		}
		this.batches.set(id, batch);
		this.persist(batch);
		if (action === "stop") for (const active of this.running.values()) if (active.batch.id === id) active.controller.abort();
	}
	exclude(id: string, key: string, reason: string): void {
		this.store.acquire();
		const batch = this.batches.get(id) ?? this.store.read(id);
		const item = batch.items.find((item) => item.selected.key === key);
		if (!item || !reason.trim()) throw new Error("explicit selected item and scope-revision reason required");
		if (this.running.has(`${id}:${key}`) || item.operation?.state === "unknown") throw new Error("cannot exclude active/uncertain work; reconcile first");
		item.stage = "EXCLUDED"; item.blocker = reason;
		batch.scopeRevisions.push({ item: key, reason, at: new Date().toISOString() });
		this.batches.set(id, batch); this.persist(batch);
	}
	async retry(id: string, key: string, context: NativeContext): Promise<void> {
		this.store.acquire();
		const batch = this.batches.get(id) ?? this.store.read(id);
		const item = batch.items.find((item) => item.selected.key === key);
		if (!item || this.running.has(`${id}:${key}`) || item.stage === "DONE" || item.stage === "EXCLUDED") throw new Error("item is not eligible for explicit retry");
		if (item.operation?.phase === "push" || item.operation?.phase === "pr") throw new Error("external effects must be reconciled, never blindly retried");
		await this.github.assertFresh(item.selected);
		if (item.ledger.tasks[0]?.attempts.at(-1)?.state === "started") this.event(item, { kind: "reconcile_attempt", expectedRevision: item.ledger.revision, taskId: "T1" as TaskId, attemptId: item.ledger.tasks[0]!.attempts.at(-1)!.id, outcome: "abandoned", reason: "operator inspected retained workspace; previous same-host native session disposed" });
		item.operation = undefined; item.stage = "QUEUED"; item.blocker = undefined;
		this.batches.set(id, batch); this.persist(batch); await this.resume(id, context);
	}
	async waitForIdle(): Promise<void> { await this.pumping; }
	async shutdown(): Promise<void> {
		try {
			for (const batch of this.batches.values()) { batch.control = "paused"; this.persist(batch); }
		} finally {
			for (const active of this.running.values()) active.controller.abort();
			await Promise.allSettled([...this.running.values()].map((active) => active.promise));
			if (!this.fatal) this.store.release();
		}
	}
	private async pump(): Promise<void> {
		if (this.pumping) return this.pumping;
		this.pumping = this.drain().finally(() => { this.pumping = undefined; });
		return this.pumping;
	}
	private async drain(): Promise<void> {
		while (!this.fatal) {
			let dispatched = false;
			for (const batch of this.batches.values()) {
				if (batch.control !== "active") continue;
				const activeCount = [...this.running.values()].filter((active) => active.batch.id === batch.id).length;
				if (this.running.size >= this.capacity) break;
				if (activeCount >= batch.capacity) continue;
				for (const item of batch.items.filter((item) => item.stage === "QUEUED").sort((a, b) => a.attempts - b.attempts)) {
                    const dependency = dependencyBlocker(batch, item.selected.key);
                    if (dependency) { item.blocker = dependency; continue; }
                    if (item.attempts >= batch.maxAttempts || batch.items.reduce((sum, candidate) => sum + candidate.attempts, 0) >= batch.maxTotalAttempts) { item.stage = "BLOCKED"; item.blocker = "original attempt budget exhausted; no retry resets it"; this.persist(batch); continue; }
                    if ([...this.running.values()].some((active) => active.item.selected.repo.toLowerCase() === item.selected.repo.toLowerCase())) continue;
                    const owner = `${batch.id}:${item.selected.key}`;
                    try {
                        this.claims.claim(`repo:${item.selected.repo.toLowerCase()}`, owner);
                        try { this.claims.claim(`item:${item.selected.key}`, owner); } catch (error) { this.claims.release(`repo:${item.selected.repo.toLowerCase()}`, owner); throw error; }
                    } catch (error) { item.stage = "BLOCKED"; item.blocker = String(error); this.persist(batch); continue; }
                    item.stage = "RUNNING"; item.blocker = undefined;
                    this.persist(batch);
                    const controller = new AbortController();
                    const promise = Promise.resolve().then(() => this.execute(batch, item, controller.signal)).catch((error) => {
                        if (item.operation?.phase === "push" || item.operation?.phase === "pr") { item.stage = "UNKNOWN"; item.operation.state = "unknown"; }
                        else item.stage = controller.signal.aborted ? "CANCELLED" : "BLOCKED";
                        item.blocker = error instanceof Error ? error.message : String(error);
                        this.persist(batch);
                    }).finally(() => {
                        this.running.delete(owner);
                        if (!this.fatal && item.stage !== "UNKNOWN") { this.claims.release(`repo:${item.selected.repo.toLowerCase()}`, owner); this.claims.release(`item:${item.selected.key}`, owner); }
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
            for (const item of batch.items) if (item.stage === "QUEUED" && item.blocker) item.stage = "BLOCKED";
            if (!this.fatal) this.persist(batch);
        }
    }
	private event(item: BatchItem, event: LedgerEvent): void {
		const result = reduce(item.ledger, event, { artifactRoots: [this.root] });
		if (!result.ok) throw new Error(result.error);
		item.ledger = result.ledger;
	}
	private async git(workspace: string, args: string[], signal?: AbortSignal): Promise<string> {
		const result = await command("git", ["-c", "core.hooksPath=/dev/null", "-c", "protocol.file.allow=never", ...args], { cwd: workspace, signal, timeout: 60_000, maxBuffer: 4 * 1024 * 1024, env: { PATH: process.env.PATH, HOME: process.env.HOME, GIT_TERMINAL_PROMPT: "0", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" } });
		return result.stdout.trim();
	}
	private async execute(batch: Batch, item: BatchItem, signal: AbortSignal): Promise<void> {
		if (!this.sdk || !this.context) throw new Error("pinned OMP public SDK unavailable; execution refused");
		await this.github.assertFresh(item.selected);
		const directory = join(this.root, "workspaces", batch.id, digest(item.selected.key).slice(0, 16));
		mkdirSync(join(this.root, "workspaces", batch.id), { recursive: true, mode: 0o700 });
		if (!item.workspace) {
			if (existsSync(directory)) throw new Error("fresh execution found a retained workspace; inspect it, never reset/delete it");
			item.workspace = directory;
			item.operation = { id: `${batch.id}:${item.selected.key}:checkout`, phase: "worker", state: "intent" };
			this.persist(batch);
			await command("gh", ["repo", "clone", item.selected.repo, directory, "--", "--no-checkout"], { timeout: 120_000, signal, env: { PATH: process.env.PATH, HOME: process.env.HOME, GH_TOKEN: this.github.token, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" } });
			if (item.selected.kind === "pr") await this.git(directory, ["fetch", "origin", `pull/${item.selected.number}/head`], signal);
			await this.git(directory, ["checkout", "--detach", item.selected.head!], signal);
		} else {
			if (item.workspace !== directory) throw new Error("workspace identity mismatch");
			if (!existsSync(directory)) throw new Error("retained workspace missing; restore it before retry");
		}
		const origin = await this.git(directory, ["remote", "get-url", "origin"], signal);
		if (origin.replace(/\.git$/, "").toLowerCase() !== `https://github.com/${item.selected.repo}`) throw new Error("workspace origin does not match selected repository; preserve and inspect");
		const head = await this.git(directory, ["rev-parse", "HEAD"], signal);
		if (head !== item.selected.head) throw new Error("workspace head differs from selected subject; preserve and inspect");
		const before = await this.git(directory, ["status", "--porcelain"], signal);
		if (before && item.attempts === 0) throw new Error("dirty reused checkout; preserve user changes and select an unused workspace");
		item.attempts += 1;
		if (!item.ledger.tasks.length) this.event(item, { kind: "record_candidate", expectedRevision: item.ledger.revision, candidate: { taskId: "T1" as TaskId, generation: item.ledger.generation, criterionId: "A1" as CriterionId, title: item.selected.key, deps: [], effect: item.selected.action === "inspect" ? "read" : "write", owner: batch.id, necessity: "explicit selected acceptance remains unproved" } });
		const attempt = `T1-a${item.attempts}` as AttemptId;
		this.event(item, { kind: "start_attempt", expectedRevision: item.ledger.revision, taskId: "T1" as TaskId, attemptId: attempt, subject: item.ledger.subject });
		item.operation = { id: `${batch.id}:${item.selected.key}:${attempt}`, phase: "worker", state: "intent" };
		this.persist(batch);
		const onSession = (session: string) => { item.sessions.push(session); this.persist(batch); };
		const worker = await runNative(this.sdk, this.schema, this.context, item, this.root, "worker", signal, onSession);
		batch.usage.modelCalls += worker.calls;
		item.stage = "VERIFY"; item.operation.phase = "verify"; this.persist(batch);
		if (item.selected.action !== "inspect" && !worker.tests.length) throw new Error("worker supplied no executable verification; inspect workspace and retry within original appetite");
		const evidenceDir = join(this.root, "evidence", batch.id, digest(item.selected.key).slice(0, 16), attempt);
		mkdirSync(evidenceDir, { recursive: true, mode: 0o700 });
		const patch = await this.git(directory, ["diff", "--binary", "HEAD"], signal);
		const patchFile = join(evidenceDir, "patch.diff");
		writeFileSync(patchFile, patch, { flag: "wx", mode: 0o600 });
		const testWorkspace = join(evidenceDir, "verification-workspace");
		cpSync(directory, testWorkspace, { recursive: true, filter: (path) => !path.endsWith("/.git") });
		const tests: EvidenceReceipt["tests"][number][] = [];
		const artifacts = [patchFile];
		let verification = "";
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
		const reviewFile = join(evidenceDir, "acceptance.txt");
		writeFileSync(reviewFile, reviewer.report, { flag: "wx", mode: 0o600 }); artifacts.push(reviewFile);
		await this.github.assertFresh(item.selected);
		const changed = (await this.git(directory, ["diff", "--name-only", "HEAD"], signal)).split("\n").filter(Boolean);
		const receipt: EvidenceReceipt = { version: 1, taskId: "T1" as TaskId, attemptId: attempt, generation: item.ledger.generation, subject: item.ledger.subject, result: worker.report, changed, evidence: artifacts, tests, cleanEnvironment: true, unresolved: reviewer.accepted ? [] : [reviewer.report], next: "", confidence: "medium", routing: { verified: false }, exitCode: tests.some((test) => test.outcome === "fail") ? 1 : 0, aborted: false, truncated: false };
		this.event(item, { kind: "record_receipt", expectedRevision: item.ledger.revision, taskId: "T1" as TaskId, attemptId: attempt, receipt });
		item.operation.state = "confirmed";
		this.persist(batch);
		if (!reviewer.accepted || receipt.exitCode !== 0) throw new Error(`acceptance unproved: ${reviewer.report}; inspect retained evidence and retry within original budget`);
		if (item.selected.action !== "inspect") this.event(item, { kind: "integrate_attempt", expectedRevision: item.ledger.revision, taskId: "T1" as TaskId, attemptId: attempt, subject: item.ledger.subject });
		this.event(item, { kind: "finish_task", expectedRevision: item.ledger.revision, taskId: "T1" as TaskId, criterionId: "A1" as CriterionId });
		item.proof = { acceptanceRevision: item.selected.acceptanceRevision!, subject: item.selected.head!, digest: digest(artifacts.map((path) => digest(readFileSync(path, "utf8"))).join("")), artifacts, stage: "verified-patch", reviewerSession: reviewer.session };
		this.persist(batch);
		if (item.selected.action === "pr-ready") await this.publish(batch, item, changed, signal);
		item.stage = "DONE"; item.blocker = undefined;
		this.persist(batch);
	}
	private async publish(batch: Batch, item: BatchItem, changed: string[], signal: AbortSignal): Promise<void> {
		if (changed.some((path) => path.startsWith(".github/workflows/"))) throw new Error("Factory refuses workflow publication; retained patch remains inspectable");
		await this.github.assertFresh(item.selected);
		const branch = `factory/${batch.id}/${item.selected.number}`;
		await this.git(item.workspace!, ["add", "--all"], signal);
		await this.git(item.workspace!, ["-c", "user.name=Luna Factory", "-c", "user.email=factory@localhost", "commit", "-m", `fix: address ${item.selected.key}`], signal);
		const sha = await this.git(item.workspace!, ["rev-parse", "HEAD"], signal);
		item.operation = { id: `${batch.id}:${item.selected.key}:push`, phase: "push", state: "intent", branch, sha };
		this.persist(batch);
		await command("git", ["-c", "core.hooksPath=/dev/null", "-c", "credential.helper=!gh auth git-credential", "push", "origin", `HEAD:refs/heads/${branch}`], { cwd: item.workspace, signal, timeout: 120_000, env: { PATH: process.env.PATH, HOME: process.env.HOME, GH_TOKEN: this.github.token, GIT_TERMINAL_PROMPT: "0", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" } });
		item.operation.state = "confirmed"; this.persist(batch);
		await this.github.assertFresh(item.selected);
		item.operation = { ...item.operation, id: `${batch.id}:${item.selected.key}:pr`, phase: "pr", state: "intent" };
		this.persist(batch);
		const repo = await this.github.request<{ default_branch: string }>(`repos/${item.selected.repo}`);
		const result = await this.github.request<{ html_url: string; head: { sha: string } }>(`repos/${item.selected.repo}/pulls`, { title: `fix: address ${item.selected.key}`, head: branch, base: repo.default_branch, body: `Selected Factory acceptance: ${item.selected.key}\n\nCloses ${item.selected.key}\n\nFactory operation: ${item.operation.id}\n\nVerified patch and independent native acceptance recorded in ${batch.id}. No merge/deploy authority.`, draft: false });
		if (result.head.sha !== sha) throw new Error("created PR head does not match verified patch");
		item.operation.state = "confirmed"; item.operation.url = result.html_url; item.proof!.stage = "pr-ready";
		this.persist(batch);
	}
	private async reconcileEffect(item: BatchItem): Promise<void> {
		const operation = item.operation!;
		try {
			const ref = await this.github.request<{ object: { sha: string } }>(`repos/${item.selected.repo}/git/ref/heads/${operation.branch}`);
			if (ref.object.sha !== operation.sha) throw new Error("remote branch does not match recorded effect");
			const pulls = await this.github.request<Array<{ html_url: string; head: { sha: string }; merged_at?: string }>>(`repos/${item.selected.repo}/pulls?state=all&head=${encodeURIComponent(`${item.selected.repo.split("/")[0]}:${operation.branch}`)}`);
			const pull = pulls.find((pull) => pull.head.sha === operation.sha);
			if (!pull || !item.proof || item.proof.artifacts.some((artifact) => !existsSync(artifact))) throw new Error("push observed but exact PR/proof unavailable; inspect authoritative state, no automatic repeat");
			operation.state = "confirmed"; operation.url = pull.html_url; item.proof.stage = pull.merged_at ? "merged-upstream" : "pr-ready"; item.stage = "DONE"; item.blocker = undefined;
		} catch (error) { operation.state = "unknown"; item.stage = "UNKNOWN"; item.blocker = `external effect unresolved: ${error instanceof Error ? error.message : String(error)}`; }
	}
}
