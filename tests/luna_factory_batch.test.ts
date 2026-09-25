import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync, readdirSync } from "node:fs";
import { execFileSync, spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
	batchConverged,
	batchSummary,
	createBatch,
	dependencyBlocker,
	digest,
	selectionIdentity,
	type Batch,
	type SelectedItem,
} from "../image/extension/luna-factory/core/batch.ts";
import type { AttemptId, EvidenceReceipt, TaskId } from "../image/extension/luna-factory/core/model.ts";
import { createLunaFactoryExtension } from "../image/extension/luna-factory/index.ts";
import { BatchStore, ResourceClaims } from "../image/extension/luna-factory/omp/batch-store.ts";
import { captureWaveJobIds, reconcileBlockedRepositoryClaim, waveWorkerCoverageComplete, waveWorkersSettled } from "../image/extension/bluefin-review/extension.ts";
import { BatchService, semanticOutcomeFor } from "../image/extension/luna-factory/omp/batch-service.ts";
import { BatchGitHub } from "../image/extension/luna-factory/omp/batch-github.ts";

const selected = (key: string, action: SelectedItem["action"] = "patch", extra: Partial<SelectedItem> = {}): SelectedItem => {
	const match = /^([^#]+)#(\d+)$/.exec(key);
	if (!match) throw new Error(`invalid test identity ${key}`);
	const repo = match[1]!.toLowerCase();
	const number = Number(match[2]);
	return { key: `${repo}#${number}`, repo, number, kind: "issue", action, overlaps: [], acceptanceRevision: "r1", base: "a".repeat(40), head: "a".repeat(40), ...extra };
};
const options = (id = "a") => ({ id: `batch-${id.replace(/[^a-f0-9-]/gi, "a")}`, capacity: 2, maxAttempts: 3, maxTotalAttempts: 10, mode: "once" as const });
const done = (batch: Batch, key: string, stage: "verified-patch" | "pr-ready" | "merged-upstream" = "verified-patch"): void => {
	const item = batch.items.find((candidate) => candidate.selected.key === key)!;
	const taskId = "T1" as TaskId;
	const attemptId = "T1-a1" as AttemptId;
	const criterion = item.ledger.criteria[0]!;
	const receipt: EvidenceReceipt = {
		version: 2,
		taskId,
		attemptId,
		generation: item.ledger.generation,
		subject: item.ledger.subject,
		result: "verified selected work",
		changed: [],
		evidence: ["/factory/proof.txt"],
		tests: [{ command: "deterministic verification", outcome: "pass", artifact: "/factory/test.log" }],
		cleanEnvironment: true,
		unresolved: [],
		next: "",
		confidence: "high",
		routing: { verified: false },
		exitCode: 0,
		aborted: false,
		truncated: false,
		assumptions: criterion.assumptions ?? [],
		predicates: [
			{ phase: "verification", item: "deterministic verification", ok: true, note: "exit 0" },
			{ phase: "worker", item: "selected acceptance", ok: true, note: "reviewed" },
			{ phase: "acceptance", item: "reported evidence", ok: true, note: "reviewed" },
		],
		...(item.selected.action === "inspect" ? {
			semanticResult: {
				kind: "inspection" as const,
				outcome: "no-finding" as const,
				summary: "deterministic inspection completed",
				verified: true,
				publicationAuthority: "none" as const,
			},
		} : {}),
	};
	item.ledger = {
		...item.ledger,
		tasks: [
			...item.ledger.tasks.filter((task) => task.criterionId !== criterion.id),
			{
				id: taskId,
				generation: item.ledger.generation,
				criterionId: criterion.id,
				title: key,
				deps: [],
				effect: item.selected.action === "inspect" ? "read" : "write",
				owner: batch.id,
				state: "DONE",
				attempts: [{
					id: attemptId,
					lineage: 1,
					taskId,
					generation: item.ledger.generation,
					subject: item.ledger.subject,
					state: "returned",
					nativeJobIds: [],
					nativeAgentIds: [],
					privateSessions: [{ phase: "worker", sessionFile: "/state/sessions/probe.jsonl", started: true }],
					receipt,
					integrated: true,
				}],
				decision: "ADMIT",
				decisionReason: "deterministic test proof",
			},
		],
	};
	item.stage = "DONE";
	item.proof = { acceptanceRevision: item.selected.acceptanceRevision!, subject: item.selected.head!, digest: "d", artifacts: [], stage, reviewerSession: "reviewer" };
};

test("selection identity is canonical, duplicate selected keys are refused, and retained batches keep all ten items", () => {
	const items = Array.from({ length: 10 }, (_, index) => selected(`org/repo-${Math.floor(index / 2)}#${index % 2 + 1}`));
	const batch = createBatch(items, options("ten"));
	assert.equal(batch.items.length, 10);
	assert.equal(new Set(batch.items.map((item) => item.selected.repo)).size, 5);
	assert.equal(selectionIdentity(items), selectionIdentity([...items].reverse()));
	assert.throws(() => createBatch([items[0]!, items[0]!], options("dead")), /duplicate selected identity/);
	assert.equal(createBatch(items, { ...options("beef"), mode: "retain" }).mode, "retain");
});
test("absence of a semantic result is neutral for patches but uncertain for inspections", () => {
	assert.equal(semanticOutcomeFor("patch", "none"), "none");
	assert.equal(semanticOutcomeFor("pr-ready", "none"), "none");
	assert.equal(semanticOutcomeFor("inspect", "none"), "uncertain");
	assert.equal(semanticOutcomeFor("inspect", "disproven"), "disproven");
});
test("batch status exposes Factory-private session role and stable identity without claiming Hub visibility", () => {
	const batch = createBatch([selected("org/a#1", "inspect")], options("session"));
	const item = batch.items[0]!;
	item.operation = {
		id: "batch-session-worker",
		generation: item.ledger.generation,
		subject: item.ledger.subject,
		effect: "repository-work",
		phase: "worker",
		owner: `${batch.id}:${item.selected.key}`,
		state: "intent",
	};
	item.ledger = {
		...item.ledger,
		tasks: [{
			id: "T1", generation: item.ledger.generation, criterionId: "A1", title: "inspect", deps: [],
			effect: "read", owner: batch.id, state: "READY", attempts: [{
				id: "T1-a1", lineage: 1, taskId: "T1", generation: item.ledger.generation, subject: item.ledger.subject,
				state: "started", nativeJobIds: [], nativeAgentIds: [],
				privateSessions: [{ phase: "worker", sessionFile: "/state/sessions/worker.jsonl", started: false }],
				integrated: false,
			}], decision: "ADMIT", decisionReason: "selected",
		}],
	} as never;
	const status = batchSummary(batch, "/state");
	assert.match(status, /worker intent/);
	assert.ok(status.includes("batch-session-worker"));
	assert.ok(status.includes("Factory-private worker session T1/T1-a1 (identity recorded; turn start not observed): /state/sessions/worker.jsonl"));
	assert.match(status, /do not appear in Ctrl\+A/);
});


test("dependencies enforce verified patch, PR-ready, and merged-upstream stages", () => {
	const items = [selected("org/a#1"), selected("org/b#2", "pr-ready"), selected("org/c#3", "pr-ready")];
	const batch = createBatch(items, { ...options("cafe"), dependencies: [{ item: "org/b#2", requires: "org/a#1", stage: "verified-patch" }, { item: "org/c#3", requires: "org/b#2", stage: "pr-ready" }] });
	assert.match(dependencyBlocker(batch, "org/b#2")!, /org\/a#1 must reach verified-patch/);
	done(batch, "org/a#1"); assert.equal(dependencyBlocker(batch, "org/b#2"), undefined);
	assert.match(dependencyBlocker(batch, "org/c#3")!, /org\/b#2 must reach pr-ready/);
	done(batch, "org/b#2", "pr-ready"); assert.equal(dependencyBlocker(batch, "org/c#3"), undefined);
	const merged = createBatch([selected("org/a#1"), selected("org/b#2")], { ...options("cede"), dependencies: [{ item: "org/b#2", requires: "org/a#1", stage: "merged-upstream" }] });
	done(merged, "org/a#1", "pr-ready"); assert.match(dependencyBlocker(merged, "org/b#2")!, /human\/Review landing required/);
	done(merged, "org/a#1", "merged-upstream"); assert.equal(dependencyBlocker(merged, "org/b#2"), undefined);
	assert.throws(() => createBatch(items, { ...options("fade"), dependencies: [{ item: "org/a#1", requires: "org/nope#9", stage: "verified-patch" }] }), /missing prerequisite/);
	assert.throws(() => createBatch(items, { ...options("face"), dependencies: [{ item: "org/a#1", requires: "org/b#2", stage: "verified-patch" }, { item: "org/b#2", requires: "org/a#1", stage: "verified-patch" }] }), /dependency cycle/);
});

test("freshness rejects a newly introduced GitHub overlap", async () => {
	const oid = "a".repeat(40);
	const repository = { id: "repo-1", nameWithOwner: "org/repo", defaultBranchRef: { name: "main", target: { oid } } };
	const issue = (withOverlap: boolean) => ({
		id: "item-1",
		__typename: "Issue",
		title: "same title",
		body: "same body",
		closed: false,
		url: "https://github.com/org/repo/issues/1",
		labels: { nodes: [], pageInfo: { hasNextPage: false } },
		timelineItems: {
			nodes: withOverlap ? [{ source: { number: 2, state: "OPEN", repository: { nameWithOwner: "org/repo" } } }] : [],
			pageInfo: { hasNextPage: false },
		},
	});
	const responses = [issue(false), issue(true)];
	const github = new BatchGitHub("token", (async () => ({
		ok: true,
		status: 200,
		json: async () => ({ data: { repository: { ...repository, issueOrPullRequest: responses.shift() } } }),
	})) as unknown as typeof fetch);
	const snapshot = await github.snapshot(selected("org/repo#1", "inspect"));
	await assert.rejects(() => github.assertFresh(snapshot), /overlap|scope|stale/i);
});

test("selected batches preserve oversized GitHub acceptance through persistence", async () => {
	const root = await mkdtemp(join(tmpdir(), "factory-batch-long-"));
	try {
		const body = `${"acceptance ".repeat(2_100)}LONG-ACCEPTANCE-SENTINEL`;
		const repository = { id: "repo-long", nameWithOwner: "org/repo", defaultBranchRef: { name: "main", target: { oid: "a".repeat(40) } } };
		const github = new BatchGitHub("token", (async () => ({
			ok: true,
			status: 200,
			json: async () => ({
				data: {
					repository: {
						...repository,
						issueOrPullRequest: {
							id: "item-long",
							__typename: "Issue",
							title: "large acceptance",
							body,
							closed: false,
							url: "https://github.com/org/repo/issues/1",
							labels: { nodes: [], pageInfo: { hasNextPage: false } },
						},
					},
				},
			}),
		})) as unknown as typeof fetch);
		const snapshot = await github.snapshot(selected("org/repo#1"));
		assert.ok(snapshot.acceptance?.endsWith("LONG-ACCEPTANCE-SENTINEL"));
		const batch = createBatch([snapshot], options("long"));

		const store = new BatchStore(root);
		store.acquire();
		store.write(batch);
		const loaded = store.read(batch.id);
		assert.equal(loaded.items[0]!.selected.acceptance, snapshot.acceptance);
		const statement = loaded.items[0]!.ledger.goal.statement;
		assert.equal(statement, loaded.items[0]!.ledger.criteria[0]!.statement);
		assert.ok(statement.length <= 2_000);
		assert.match(statement, new RegExp(snapshot.key));
		assert.ok(statement.includes(snapshot.acceptanceRevision!));
		assert.equal(statement.includes("LONG-ACCEPTANCE-SENTINEL"), false);
		store.release();
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
test("changing complete acceptance changes its revision and invalidates old proof", async () => {
	const bodies = ["old acceptance", "new acceptance with a changed sentinel"];
	const repository = { id: "repo-revision", nameWithOwner: "org/repo", defaultBranchRef: { name: "main", target: { oid: "a".repeat(40) } } };
	const github = new BatchGitHub("token", (async () => ({
		ok: true,
		status: 200,
		json: async () => ({
			data: {
				repository: {
					...repository,
					issueOrPullRequest: {
						id: "item-revision",
						__typename: "Issue",
						title: "acceptance revision",
						body: bodies.shift()!,
						closed: false,
						url: "https://github.com/org/repo/issues/2",
						labels: { nodes: [], pageInfo: { hasNextPage: false } },
					},
				},
			},
		}),
	})) as unknown as typeof fetch);
	const original = await github.snapshot(selected("org/repo#2"));
	const batch = createBatch([original], options("revision"));
	done(batch, original.key);
	const changed = await github.snapshot(original);
	assert.notEqual(changed.acceptanceRevision, original.acceptanceRevision);
	batch.items[0]!.selected = changed;
	assert.equal(batchConverged(batch), false);
});


test("cancellation, exclusion, and scope revisions never falsely converge", () => {
	const batch = createBatch([selected("org/a#1"), selected("org/b#2")], options("dead"));
	batch.items[0]!.stage = "CANCELLED"; batch.items[1]!.stage = "EXCLUDED"; assert.equal(batchConverged(batch), false);
	done(batch, "org/a#1"); done(batch, "org/b#2"); assert.equal(batchConverged(batch), true);
	batch.scopeRevisions.push({ item: "org/a#1", reason: "changed", at: "now" }); assert.equal(batchConverged(batch), false);
});


test("batch progress distinguishes proof, active, blocked, unknown, cancelled, and excluded scope", () => {
	const batch = createBatch([
		selected("org/a#1"),
		selected("org/b#2"),
		selected("org/c#3"),
		selected("org/d#4"),
		selected("org/e#5"),
		selected("org/f#6"),
	], options("counts"));
	done(batch, "org/a#1");
	batch.items.find((item) => item.selected.key === "org/c#3")!.stage = "BLOCKED";
	batch.items.find((item) => item.selected.key === "org/d#4")!.stage = "UNKNOWN";
	batch.items.find((item) => item.selected.key === "org/e#5")!.stage = "CANCELLED";
	batch.items.find((item) => item.selected.key === "org/f#6")!.stage = "EXCLUDED";
	batch.scopeRevisions.push({ item: "org/f#6", reason: "operator revised scope", at: "now" });

	assert.equal(batchConverged(batch), false);
	assert.match(batchSummary(batch, "/state"), /Current scope: 1 proven · 1 active · 1 blocked · 1 unknown\/unresolved · 1 cancelled · 1 excluded \(5\/6 items\)/);
	assert.match(batchSummary(batch, "/state"), /Original scope NOT converged/);
});

test("stale selected acceptance never counts as current batch proof", () => {
	const batch = createBatch([selected("org/a#1", "inspect")], options("stale"));
	done(batch, "org/a#1");
	batch.items[0]!.selected.acceptanceRevision = "r2";

	assert.equal(batchConverged(batch), false);
	assert.match(batchSummary(batch, "/state"), /0\/1 proven/);
	assert.match(batchSummary(batch, "/state"), /UNKNOWN \(stored proof is not current\)/);
});
test("BatchStore isolates ledgers, rejects stale revisions, and preserves corrupt originals", async () => {
	const root = await mkdtemp(join(tmpdir(), "factory-batch-"));
	try {
		const first = new BatchStore(root); const second = new BatchStore(root); first.acquire();
		const a = createBatch([selected("org/a#1")], options("a")); const b = createBatch([selected("org/b#2")], options("b")); first.write(a); first.write(b);
		const aa = first.read(a.id), bb = first.read(b.id); assert.notEqual(aa.items[0]!.ledger, bb.items[0]!.ledger); aa.items[0]!.ledger.runId = "mutated" as never; assert.notEqual(first.read(b.id).items[0]!.ledger.runId, "mutated");
		assert.throws(() => second.acquire(), /owned by process/); assert.throws(() => first.write({ ...a, revision: 0 }), /stale batch revision/);
		await writeFile(join(root, `${b.id}.json`), "{\"version\":999}"); assert.throws(() => first.read(b.id), /unsupported or corrupt/); assert.match(await readFile(join(root, `${b.id}.json`), "utf8"), /999/); first.release();
	} finally { await rm(root, { recursive: true, force: true }); }
});
test("BatchStore rejects an invalid new ledger before creating durable state", async () => {
	const root = await mkdtemp(join(tmpdir(), "factory-batch-invalid-"));
	try {
		const store = new BatchStore(root);
		store.acquire();
		const batch = createBatch([selected("org/a#1")], options("invalid"));
		batch.items[0]!.ledger = {
			...batch.items[0]!.ledger,
			goal: { ...batch.items[0]!.ledger.goal, statement: "x".repeat(2_001) },
		};
		assert.throws(() => store.write(batch), /invalid item ledger: journal goal is unreadable/);
		assert.equal(existsSync(join(root, `${batch.id}.json`)), false);
		assert.deepEqual(readdirSync(root).filter((name) => name.startsWith(`${batch.id}.json.`) && name.endsWith(".tmp")), []);
		store.release();
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});


test("BatchStore migrates version-one operations before persisting version two", async () => {
	const root = await mkdtemp(join(tmpdir(), "factory-batch-migration-"));
	const store = new BatchStore(root);
	try {
		store.acquire();
		const batch = createBatch([selected("org/a#1")], options("migrate"));
		const legacy = structuredClone(batch) as unknown as {
			version: number;
			id: string;
			revision: number;
			items: Array<{ operation?: unknown; operations?: unknown }>;
		};
		legacy.version = 1;
		legacy.items[0]!.operation = {
			id: `${batch.id}:org/a#1:push`,
			phase: "push",
			state: "confirmed",
			branch: `factory/${batch.id}/1`,
			sha: "b".repeat(40),
		};
		delete legacy.items[0]!.operations;
		const path = join(root, `${batch.id}.json`);
		await writeFile(path, `${JSON.stringify(legacy)}\n`);

		const migrated = store.read(batch.id);
		const operation = migrated.items[0]!.operation;
		assert.equal(migrated.version, 2);
		assert.equal(operation?.effect, "git-push");
		assert.equal(operation?.state, "applied");
		assert.equal(operation?.subject.head, "b".repeat(40));
		assert.deepEqual(migrated.items[0]!.operations, []);
		assert.equal(JSON.parse(await readFile(path, "utf8")).version, 1, "reading preserves the original version until a durable write");

		store.write(migrated);
		const persisted = JSON.parse(await readFile(path, "utf8"));
		assert.equal(persisted.version, 2);
		assert.equal(persisted.items[0].operation.state, "applied");
	} finally {
		store.release();
		await rm(root, { recursive: true, force: true });
	}
});
test("ambiguous PR settlement reconciles only one exact marker/head/base match and refuses duplicates", async () => {
	const root = await mkdtemp(join(tmpdir(), "factory-pr-reconcile-"));
	try {
		const run = async (duplicate: boolean) => {
			const key = "org/a#1";
			const selectedItem = selected(key, "pr-ready", { baseRef: "main" });
			const batch = createBatch([selectedItem], options(duplicate ? "dupe" : "exact"));
			const item = batch.items[0]!;
			done(batch, key, "pr-ready");
			const branch = `factory/${batch.id}/1`;
			const sha = "b".repeat(40);
			const marker = `${batch.id}:${key}:pr`;
			item.operation = {
				id: `${batch.id}:${key}:push`,
				generation: item.ledger.generation,
				subject: { ...item.ledger.subject, head: sha },
				effect: "git-push",
				phase: "push",
				owner: `${batch.id}:${key}`,
				state: "unknown",
				branch,
				sha,
			};
			item.stage = "UNKNOWN";
			let requests = 0;
			const exactPull = { html_url: "https://github.com/org/a/pull/7", head: { sha }, base: { ref: "main" }, body: `Factory operation: ${marker}` };
			const decoys = [
				{ ...exactPull, head: { sha: "c".repeat(40) } },
				{ ...exactPull, base: { ref: "release" } },
				{ ...exactPull, body: "Factory operation: unrelated" },
				{ ...exactPull, body: `Factory operation: ${marker}:extra` },
				{ ...exactPull, body: `prefix Factory operation: ${marker}` },
			];
			const github = {
				request: async (path: string) => {
					requests += 1;
					return path.includes("/git/ref/heads/")
						? { object: { sha } }
						: duplicate ? [exactPull, { ...exactPull, html_url: "https://github.com/org/a/pull/8" }] : [...decoys, exactPull];
				},
			};
			const service = new BatchService(root, github as never, undefined, {} as never, 1);
			// Exercise exact-effect reconciliation while bypassing only artifact revalidation.
			const internals = service as unknown as {
				validateProof(item: Batch["items"][number]): Promise<void>;
				reconcileEffect(item: Batch["items"][number]): Promise<void>;
			};
			internals.validateProof = async () => {};
			await internals.reconcileEffect(item);
			return { item, requests, marker };
		};

		const exact = await run(false);
		assert.equal(exact.requests, 2);
		assert.equal(exact.item.stage, "VERIFY");
		assert.equal(exact.item.operation?.phase, "pr");
		assert.equal(exact.item.operation?.state, "applied");
		assert.equal(exact.item.operation?.id, exact.marker);
		assert.equal(exact.item.operation?.url, "https://github.com/org/a/pull/7");

		const duplicate = await run(true);
		assert.equal(duplicate.requests, 2, "ambiguous settlement does not repeat publication");
		assert.equal(duplicate.item.stage, "UNKNOWN");
		assert.equal(duplicate.item.operation?.state, "unknown");
		assert.ok(duplicate.item.blocker?.includes("exact PR/effect identity unproven"));
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("an orphaned acquisition mutex is recovered without admitting a live owner", async () => {
	const root = await mkdtemp(join(tmpdir(), "factory-recovery-"));
	try {
		const moduleUrl = new URL("../image/extension/luna-factory/omp/batch-store.ts", import.meta.url).href;
		const child = spawn(process.execPath, ["-e", `import fs from "node:fs"; import { syncBuiltinESMExports } from "node:module"; import { basename } from "node:path"; const originalRename = fs.renameSync; fs.renameSync = ((source, destination) => { const result = originalRename(source, destination); if (basename(String(destination)) === ".owner-recovery") process.kill(process.pid, "SIGKILL"); return result; }); syncBuiltinESMExports(); const { BatchStore } = await import(${JSON.stringify(moduleUrl)}); const store = new BatchStore(process.argv[1]); store.acquire();`, root], { stdio: ["ignore", "ignore", "pipe"] });
		await new Promise<void>((resolve, reject) => { child.once("error", reject); child.once("exit", (code, signal) => signal === "SIGKILL" ? resolve() : reject(new Error(`acquisition child exited with ${signal ?? code}`))); });
		const workerCode = `import { BatchStore } from ${JSON.stringify(moduleUrl)}; const store = new BatchStore(process.argv[1]); process.send?.("ready"); process.on("message", (message) => { if (message === "go") { try { store.acquire(); process.send?.("acquired"); } catch { process.send?.("refused"); process.disconnect?.(); process.exit(0); } } else if (message === "release") { store.release(); process.disconnect?.(); process.exit(0); } });`;
		const workers = [1, 2].map(() => spawn(process.execPath, ["-e", workerCode, root], { stdio: ["ignore", "ignore", "ignore", "ipc"] }));
		await Promise.all(workers.map((worker) => new Promise<void>((resolve, reject) => { worker.once("error", reject); worker.once("message", (message) => message === "ready" ? resolve() : reject(new Error(`worker was not ready: ${String(message)}`))); })));
		const exits = workers.map((worker) => new Promise<void>((resolve) => worker.once("exit", () => resolve())));
		const outcomes = workers.map((worker) => new Promise<string>((resolve, reject) => { worker.once("error", reject); worker.on("message", (message) => { if (message === "acquired" || message === "refused") resolve(message); }); }));
		workers.forEach((worker) => worker.send("go"));
		const settled = await Promise.all(outcomes);
		assert.deepEqual([...settled].sort(), ["acquired", "refused"]);
		workers.find((_, index) => settled[index] === "acquired")!.send("release");
		await Promise.all(exits);
		const store = new BatchStore(root); store.acquire();
		assert.throws(() => new BatchStore(root).acquire(), /owned by process/);
		store.release();
		await mkdir(join(root, ".owner-recovery"));
		const compatibility = new BatchStore(root); compatibility.acquire(); compatibility.release();
	} finally { await rm(root, { recursive: true, force: true }); }
});

test("a killed writer can be reacquired, claims overlap only by canonical resource, and exports stay rooted", async () => {
	const root = await mkdtemp(join(tmpdir(), "factory-claims-"));
	const outside = await mkdtemp(join(tmpdir(), "factory-outside-"));
	try {
		const moduleUrl = new URL("../image/extension/luna-factory/omp/batch-store.ts", import.meta.url).href;
		const child = spawn(process.execPath, ["-e", `import { BatchStore } from ${JSON.stringify(moduleUrl)}; const s=new BatchStore(process.argv[1]); s.acquire(); console.log("ready"); setInterval(()=>{},1000);`, root], { stdio: ["ignore", "pipe", "pipe"] });
		await new Promise<void>((resolve, reject) => { let settled = false; const finish = (error?: Error) => { if (settled) return; settled = true; error ? reject(error) : resolve(); }; const timer = setTimeout(() => finish(new Error("writer readiness timeout")), 5000); child.stdout.once("data", (data) => { clearTimeout(timer); if (!data.toString().includes("ready")) finish(new Error("writer did not become ready")); else finish(); }); child.once("error", (error) => finish(error)); child.once("exit", (code) => { if (code !== null && code !== 0) finish(new Error(`writer exited ${code}`)); }); });
		child.kill("SIGKILL"); await new Promise<void>((resolve) => child.once("exit", () => resolve()));
		const store = new BatchStore(root); store.acquire(); const batch = createBatch([selected("org/a#1")], options("face"));
		const artifact = join(root, "artifact.txt"); await writeFile(artifact, "proof-bytes"); batch.items[0]!.workspace = artifact; store.write(batch);
		const destination = join(root, "exports"); assert.equal(store.export(batch.id, destination), destination); assert.equal(await readFile(join(destination, "files", "artifact.txt"), "utf8"), "proof-bytes");
		const escaped = join(outside, "artifact.txt"); await writeFile(escaped, "outside"); batch.items[0]!.workspace = escaped; store.write(batch); assert.throws(() => store.export(batch.id, join(root, "export-again")), /escapes Factory state root/); store.release();
		const claims = new ResourceClaims(root); claims.claim("repo:Org/A", "owner-1"); assert.match(claims.conflict("repo:org/a", "owner-2")!, /owner-1/); claims.markSettled("repo:ORG/A", "owner-1"); claims.release("repo:ORG/A", "owner-1"); assert.equal(claims.conflict("repo:org/a", "owner-2"), undefined);
	} finally { await rm(root, { recursive: true, force: true }); await rm(outside, { recursive: true, force: true }); }
});

test("mutation claims are host-wide across state roots and unknown effects remain fenced", async () => {
	const stateA = await mkdtemp(join(tmpdir(), "factory-state-a-"));
	const stateB = await mkdtemp(join(tmpdir(), "factory-state-b-"));
	const claimsRoot = await mkdtemp(join(tmpdir(), "factory-claims-shared-"));
	try {
		const first = new ResourceClaims(stateA, claimsRoot);
		const second = new ResourceClaims(stateB, claimsRoot);
		first.claim("repo:Org/Review", "review:batch-a:0");
		assert.match(second.conflict("repo:org/review", "review:batch-b:0")!, /review:batch-a:0/);
		assert.throws(() => second.reconcile("repo:org/review", "review:batch-a:0"), /remains UNKNOWN/);
		assert.ok(second.conflict("repo:org/review", "review:batch-b:0"));
		second.markSettled("repo:org/review", "review:batch-a:0");
		second.reconcile("repo:org/review", "review:batch-a:0");
		assert.equal(second.conflict("repo:org/review", "review:batch-b:0"), undefined);
	} finally {
		await Promise.all([rm(stateA, { recursive: true, force: true }), rm(stateB, { recursive: true, force: true }), rm(claimsRoot, { recursive: true, force: true })]);
	}
});

test("blocked repository wave needs authoritative proof before reconcile and retry", async () => {
	const state = await mkdtemp(join(tmpdir(), "factory-reconcile-state-"));
	const claimsRoot = await mkdtemp(join(tmpdir(), "factory-reconcile-claims-"));
	try {
		const claims = new ResourceClaims(state, claimsRoot);
		const owner = "review:batch-reconcile:0";
		const batch = {
			id: "batch-reconcile",
			currentWave: 0,
			state: "blocked",
			waves: [{ repo: "org/review", items: [{ repo: "org/review", id: 1 }] }],
		} as never;
		claims.claim("repo:org/review", owner);
		claims.claim("item:org/review#1", owner);
		let mutationInFlight = true;
		const authoritative = async () => mutationInFlight ? "unknown" as const : "settled" as const;
		assert.equal(await reconcileBlockedRepositoryClaim(claims, batch, owner, "repo:org/review", authoritative), "unknown");
		assert.deepEqual(captureWaveJobIds({ running: [{ id: "new-wave" }], recent: [{ id: "expired-old" }, { id: "new-wave" }, { id: "unrelated" }] }, ["expired-old", "unrelated"]), ["new-wave"]);
		assert.deepEqual(captureWaveJobIds({ running: [], recent: [{ id: "unrelated" }] }, ["new-wave"]), ["unrelated"]);
		assert.equal(waveWorkersSettled({ running: [], recent: [{ id: "worker-a", status: "failed" }] }, ["worker-a"]), true);
		assert.equal(waveWorkersSettled({ running: [{ id: "worker-a", status: "running" }], recent: [{ id: "worker-a", status: "failed" }] }, ["worker-a"]), false);
		assert.equal(waveWorkersSettled({ running: [{ id: "worker-a", status: "running" }], recent: [{ id: "worker-a", status: "failed" }] }, ["worker-a"], { "worker-a": "failed" }), false);
		assert.equal(waveWorkersSettled({ running: [], recent: [] }, ["worker-a"], { "worker-a": "failed" }), true);
		assert.match(claims.conflict("repo:org/review", "review:other:0")!, /batch-reconcile/);
		mutationInFlight = false;
		assert.equal(await reconcileBlockedRepositoryClaim(claims, batch, owner, "repo:org/review", authoritative), "settled");
		claims.reconcile("repo:org/review", owner);
		assert.match(claims.conflict("item:org/review#1", "review:other:0")!, /batch-reconcile/);
		assert.equal(await reconcileBlockedRepositoryClaim(claims, batch, owner, "item:org/review#1", async () => "settled"), "settled");
		claims.reconcile("item:org/review#1", owner);
		claims.claim("repo:org/review", "review:retry:0", false);
	} finally {
		await Promise.all([rm(state, { recursive: true, force: true }), rm(claimsRoot, { recursive: true, force: true })]);
	}
});

test("crash/restart with missing runtime jobs retains the stale wave claim", async () => {
	const state = await mkdtemp(join(tmpdir(), "factory-crash-state-"));
	const claimsRoot = await mkdtemp(join(tmpdir(), "factory-crash-claims-"));
	try {
		const claims = new ResourceClaims(state, claimsRoot);
		const owner = "review:batch-crashed:0";
		const batch = {
			id: "batch-crashed",
			currentWave: 0,
			state: "blocked",
			waves: [{ repo: "org/review", items: [{ repo: "org/review", id: 1 }] }],
		} as never;
		claims.claim("repo:org/review", owner);
		const runtimeAfterRestart = { running: [], recent: [] };
		const proof = async () => waveWorkersSettled(runtimeAfterRestart, ["missing-worker"]) ? "settled" as const : "unknown" as const;
		assert.equal(await reconcileBlockedRepositoryClaim(claims, batch, owner, "repo:org/review", proof), "unknown");
		assert.match(claims.conflict("repo:org/review", "review:other:0")!, /batch-crashed/);
	} finally {
		await Promise.all([rm(state, { recursive: true, force: true }), rm(claimsRoot, { recursive: true, force: true })]);
	}
});
test("crash/restart with persisted terminal evidence releases and retries exactly once", async () => {
	const state = await mkdtemp(join(tmpdir(), "factory-recover-state-"));
	const claimsRoot = await mkdtemp(join(tmpdir(), "factory-recover-claims-"));
	try {
		const claims = new ResourceClaims(state, claimsRoot);
		const owner = "review:batch-recovered:0";
		const batch = {
			id: "batch-recovered",
			currentWave: 0,
			state: "blocked",
			waves: [{ repo: "org/review", items: [{ repo: "org/review", id: 1 }] }],
			waveToolCallIds: ["worker-recovered"],
			waveJobIds: ["worker-recovered"],
			waveTerminalJobStatuses: { "worker-recovered": "failed" },
		} as never;
		claims.claim("repo:org/review", owner);
		const runtimeAfterRestart = { running: [], recent: [] };
		const proof = async () => waveWorkersSettled(runtimeAfterRestart, batch.waveJobIds, batch.waveTerminalJobStatuses) ? "settled" as const : "unknown" as const;
		assert.equal(await reconcileBlockedRepositoryClaim(claims, batch, owner, "repo:org/review", proof), "settled");
		claims.reconcile("repo:org/review", owner);
		claims.claim("repo:org/review", "review:retry-recovered:0", false);
	} finally {
		await Promise.all([rm(state, { recursive: true, force: true }), rm(claimsRoot, { recursive: true, force: true })]);
	}
});

test("production Factory reconcile command retains UNKNOWN then permits exact retry", async () => {
	const state = await mkdtemp(join(tmpdir(), "factory-command-state-"));
	const claimsRoot = await mkdtemp(join(tmpdir(), "factory-command-claims-"));
	try {
		const claims = new ResourceClaims(state, claimsRoot);
		const owner = "review:batch-command:0";
		claims.claim("repo:org/review", owner);
		const callable = () => {};
		const leaf = new Proxy(callable, { get: () => leaf, apply: () => leaf });
		const commands = new Map<string, { handler(raw: string, ctx: unknown): Promise<string> }>();
		const host = {
			zod: new Proxy({}, { get: () => leaf }),
			registerTool() {},
			registerCommand(name: string, definition: { handler(raw: string, ctx: unknown): Promise<string> }) { commands.set(name, definition); },
			appendEntry() {},
			setLabel() {},
			on() {},
		};
		createLunaFactoryExtension(host as never, { env: { LUNA_FACTORY_STATE_ROOT: state, LUNA_FACTORY_CLAIMS_ROOT: claimsRoot } });
		const command = commands.get("factory")!;
		let runtime: { running: Array<{ id: string; status: string }>; recent: Array<{ id: string; status: string }> } = { running: [], recent: [] };
		const notifications: string[] = [];
		const context = {
			ui: { notify(message: string) { notifications.push(message); } },
			reconcileMutationClaim: async (claimOwner: string, resource: string) => {
				if (!waveWorkersSettled(runtime, ["worker-command"])) return "unknown" as const;
				claims.markSettled(resource, claimOwner);
				return "settled" as const;
			},
		};
		await command.handler(`claims reconcile ${owner} repo:org/review`, context);
		assert.match(notifications.at(-1)!, /Retained .*UNKNOWN/);
		assert.match(claims.conflict("repo:org/review", "review:other:0")!, /batch-command/);
		runtime = { running: [], recent: [{ id: "worker-command", status: "failed" }] };
		await command.handler(`claims reconcile ${owner} repo:org/review`, context);
		assert.match(notifications.at(-1)!, /claim released/);
		claims.claim("repo:org/review", "review:retry:0", false);
	} finally {
		await Promise.all([rm(state, { recursive: true, force: true }), rm(claimsRoot, { recursive: true, force: true })]);
	}
});

test("dependency-deferred work remains queued when an unrelated prerequisite is blocked", async () => {
	const root = await mkdtemp(join(tmpdir(), "factory-service-"));
	try {
		const prerequisite = selected("org/a#1", "inspect");
		const dependent = selected("org/b#2", "inspect");
		const batch = createBatch([prerequisite, dependent], {
			...options("feed"),
			capacity: 1,
			dependencies: [{ item: dependent.key, requires: prerequisite.key, stage: "verified-patch" }],
		});
		batch.items[0]!.stage = "BLOCKED";
		batch.items[0]!.blocker = "selected repository is temporarily inaccessible";
		const github = {
			snapshot: async (item: SelectedItem) => item,
			assertFresh: async (item: SelectedItem) => {
				if (item.key === prerequisite.key) throw new Error("repository temporarily inaccessible");
			},
		};
		const service = new BatchService(root, github as never, undefined, {} as never, 1);
		service.store.acquire();
		service.store.write(batch);
		await service.resume(batch.id, {});
		const resumed = service.store.read(batch.id);
		assert.equal(resumed.items.find((item) => item.selected.key === prerequisite.key)?.stage, "BLOCKED");
		const dependentState = resumed.items.find((item) => item.selected.key === dependent.key)!;
		assert.equal(dependentState.stage, "QUEUED");
		assert.match(dependentState.blocker!, /must reach verified-patch/);
		await service.shutdown();
	} finally { await rm(root, { recursive: true, force: true }); }
});

test("an unconfirmed stop keeps the item unknown and the repository claim", async () => {
	const root = await mkdtemp(join(tmpdir(), "factory-cancel-"));
	try {
		const item = selected("org/a#1", "patch");
		const batch = createBatch([item], options("cafe"));
		const github = { snapshot: async (value: SelectedItem) => value, assertFresh: async () => {} };
		const service = new BatchService(root, github as never, undefined, {} as never, 1);
		service.store.acquire();
		service.store.write(batch);
		let startedResolve!: () => void;
		const started = new Promise<void>((resolve) => { startedResolve = resolve; });
		const internal = service as unknown as {
			execute: (current: Batch, currentItem: Batch["items"][number], signal: AbortSignal) => Promise<void>;
			persist: (current: Batch) => void;
		};
		internal.execute = async (current, currentItem, signal) => {
			currentItem.operation = {
				id: `${current.id}:${currentItem.selected.key}:work`,
				generation: currentItem.ledger.generation,
				subject: currentItem.ledger.subject,
				effect: "repository-work",
				phase: "worker",
				owner: `${current.id}:${currentItem.selected.key}`,
				state: "intent",
			};
			internal.persist(current);
			startedResolve();
			await new Promise<never>((_resolve, reject) => {
				signal.addEventListener("abort", () => reject(new Error("native cancellation outcome unknown")), { once: true });
			});
		};
		await service.resume(batch.id, {});
		await started;
		await service.control(batch.id, "stop");
		await service.waitForIdle();
		const stopped = service.store.read(batch.id).items[0]!;
		assert.equal(stopped.stage, "UNKNOWN");
		assert.equal(stopped.operation?.state, "unknown");
		assert.match(stopped.blocker!, /cancellation outcome unknown/);
		assert.match(service.claims.conflict("repo:org/a", "another-owner")!, /batch-cafe/);
		await service.shutdown();
	} finally { await rm(root, { recursive: true, force: true }); }
});

test("drain does not reschedule a queued item while its OMP session start is pending", async () => {
	const batchModule = new URL("../image/extension/luna-factory/core/batch.ts", import.meta.url).href;
	const serviceModule = new URL("../image/extension/luna-factory/omp/batch-service.ts", import.meta.url).href;
	const source = `
		import { mkdtemp, rm } from "node:fs/promises";
		import { tmpdir } from "node:os";
		import { join } from "node:path";
		import { createBatch } from ${JSON.stringify(batchModule)};
		import { BatchService } from ${JSON.stringify(serviceModule)};
		const root = await mkdtemp(join(tmpdir(), "factory-drain-"));
		const selected = { key: "org/a#1", repo: "org/a", number: 1, kind: "issue", action: "inspect", overlaps: [], acceptanceRevision: "r1", base: "a".repeat(40), head: "a".repeat(40) };
		const batch = createBatch([selected], { id: "batch-dead", capacity: 2, maxAttempts: 3, maxTotalAttempts: 10, mode: "once" });
		const service = new BatchService(root, { snapshot: async value => value, assertFresh: async () => {} }, undefined, {}, 2);
		const pendingStart = Promise.withResolvers();
		const releaseExecution = pendingStart.resolve;
		try {
			service.store.acquire();
			service.store.write(batch);
			let executions = 0;
			const startedSignal = Promise.withResolvers();
			const started = startedSignal.promise;
			const internal = service;
			internal.execute = async (current, item) => {
				executions += 1;
				item.operation = {
					id: "batch-dead:org/a#1:work",
					generation: item.ledger.generation,
					subject: item.ledger.subject,
					effect: "repository-work",
					phase: "worker",
					owner: "batch-dead:org/a#1",
					state: "intent",
				};
				internal.persist(current);
				startedSignal.resolve();
				await pendingStart.promise;
				item.stage = "BLOCKED";
				item.operation.state = "applied";
				item.blocker = "native session start reconciled";
				internal.persist(current);
			};
			await service.resume(batch.id, {});
			await started;
			const beforeResume = service.store.read(batch.id).items[0];
			if (beforeResume.stage !== "QUEUED" || beforeResume.operation?.state !== "intent") throw new Error("the first session start must remain pending and owned");
			await service.resume(batch.id, {});
			const duringResume = service.store.read(batch.id).items[0];
			if (executions !== 1) throw new Error("a queued item with a pending OMP start was redispatched");
			if (duringResume.stage !== "QUEUED" || duringResume.operation?.state !== "intent") throw new Error("resume changed the pending operation state");
			releaseExecution();
			await service.waitForIdle();
			const settled = service.store.read(batch.id).items[0];
			if (executions !== 1) throw new Error("the same queued owner was executed more than once");
			if (settled.stage !== "BLOCKED" || settled.blocker !== "native session start reconciled") throw new Error("the pending owner did not settle exactly once");
		} finally {
			releaseExecution();
			await service.shutdown();
			await rm(root, { recursive: true, force: true });
		}
	`;
	const child = spawn(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", source], { stdio: ["ignore", "pipe", "pipe"] });
	let output = "";
	child.stdout.setEncoding("utf8").on("data", (chunk) => { output += chunk; });
	child.stderr.setEncoding("utf8").on("data", (chunk) => { output += chunk; });
	let timedOut = false;
	// A real timeout is necessary: the regression is a synchronous infinite loop in a child process, so fake timers cannot interrupt it.
	const timer = setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, 3_000);
	const exit = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolveExit) => {
		child.once("exit", (code, signal) => resolveExit({ code, signal }));
	});
	clearTimeout(timer);
	assert.equal(timedOut, false, "drain must yield while its only queued item is already in flight");
	assert.equal(exit.code, 0, output);
});

test("accepted aggregate cannot override a false native acceptance predicate", async () => {
	const root = await mkdtemp(join(tmpdir(), "factory-acceptance-predicate-"));
	const selectedItem = selected("org/a#2", "inspect");
	const batch = createBatch([selectedItem], { ...options("predicate"), capacity: 1, maxAttempts: 1, maxTotalAttempts: 1 });
	const item = batch.items[0]!;
	const workspace = join(root, "workspaces", batch.id, digest(item.selected.key).slice(0, 16));
	let service: BatchService | undefined;
	let sessionCount = 0;
	let publicationRequests = 0;
	const sdk = {
		Settings: { isolated: () => ({}) },
		SessionManager: { create: () => ({}) },
		AgentRegistry: class {},
		async createAgentSession(options: Record<string, unknown>) {
			const tools = options.customTools as Array<{ name: string; execute(id: string, args: Record<string, unknown>): Promise<unknown> }>;
			const report = tools.find((tool) => tool.name === "factory_report");
			assert.ok(report);
			const sessionFile = join(root, "sessions", `acceptance-${++sessionCount}.jsonl`);
			await mkdir(join(root, "sessions"), { recursive: true, mode: 0o700 });
			await writeFile(sessionFile, "private acceptance session\n", { flag: "wx", mode: 0o600 });
			const listeners = new Set<(event: { type: string }) => void>();
			return {
				session: {
					sessionFile,
					subscribe(listener: (event: { type: string }) => void) {
						listeners.add(listener);
						return () => listeners.delete(listener);
					},
					async prompt(prompt: string) {
						for (const listener of listeners) listener({ type: "turn_start" });
						const worker = prompt.startsWith("Implement/inspect");
						await report.execute(worker ? "worker-report" : "acceptance-report", {
							report: worker ? "inspected exact subject" : "aggregate says accepted but a checked item failed",
							tests: [],
							accepted: true,
							semanticOutcome: worker ? "no-finding" : "none",
							predicates: [{ item: "acceptance predicate", ok: worker, note: worker ? "worker observation" : "acceptance evidence contradicts aggregate" }],
							publicationBlocker: "",
						});
					},
					async abort() {},
					async dispose() {},
				},
			};
		},
	};
	const github = {
		snapshot: async (value: SelectedItem) => value,
		assertFresh: async () => {},
		request: async () => { publicationRequests += 1; throw new Error("unexpected publication request"); },
	};
	try {
		await mkdir(workspace, { recursive: true, mode: 0o700 });
		const git = (...args: string[]): string => execFileSync("git", [
			"-c", "user.name=Factory Predicate", "-c", "user.email=predicate@localhost", ...args,
		], { cwd: workspace, encoding: "utf8" }).trim();
		execFileSync("git", ["init", "--quiet"], { cwd: workspace });
		await writeFile(join(workspace, "README.probe"), "read-only inspection subject\n");
		git("add", "README.probe");
		git("commit", "--quiet", "-m", "probe");
		const head = git("rev-parse", "HEAD");
		git("remote", "add", "origin", `https://github.com/${item.selected.repo}`);
		item.selected.base = head;
		item.selected.head = head;
		item.selected.baseRef = "main";
		item.ledger = { ...item.ledger, subject: { repo: item.selected.repo, base: head, head } };
		item.workspace = workspace;

		service = new BatchService(root, github as never, sdk as never, {
			object: () => ({}), string: () => ({}), array: () => ({}), boolean: () => ({}),
		} as never, 1);
		service.store.acquire();
		service.store.write(batch);
		await service.resume(batch.id, { model: {}, modelRegistry: { authStorage: {} } });
		await service.waitForIdle();
		const rejected = service.store.read(batch.id).items[0]!;
		assert.notEqual(rejected.stage, "DONE");
		assert.equal(rejected.proof, undefined);
		assert.equal(rejected.operation?.state, "applied", "execution completion is not acceptance proof");
		assert.ok(rejected.ledger.tasks[0]!.attempts.at(-1)!.receipt!.predicates!.some((predicate) => predicate.phase === "acceptance" && !predicate.ok));
		assert.ok(rejected.operation?.phase !== "push" && rejected.operation?.phase !== "pr");
		assert.equal(publicationRequests, 0);
	} finally {
		if (service) await service.shutdown();
		await rm(root, { recursive: true, force: true });
	}
});


test("a replacement inspection worker reuses its operation identity and retains disproven findings", async () => {
	const root = await mkdtemp(join(tmpdir(), "factory-operation-reuse-"));
	const selectedItem = selected("org/a#1", "inspect");
	const batch = createBatch([selectedItem], { ...options("beef"), capacity: 1 });
	const item = batch.items[0]!;
	const workspace = join(root, "workspaces", batch.id, digest(item.selected.key).slice(0, 16));
	let service: BatchService | undefined;
	let workers = 0;
	let sessions = 0;
	const sdk = {
		Settings: { isolated: () => ({}) },
		SessionManager: { create: () => ({}) },
		AgentRegistry: class {},
		async createAgentSession(options: Record<string, unknown>) {
			const tools = options.customTools as Array<{ name: string; execute(id: string, args: Record<string, unknown>): Promise<unknown> }>;
			const report = tools.find((tool) => tool.name === "factory_report");
			assert.ok(report, "the private inspection session has its evidence tool");
			const sessionFile = join(root, "sessions", `inspection-${++sessions}.jsonl`);
			await mkdir(join(root, "sessions"), { recursive: true, mode: 0o700 });
			await writeFile(sessionFile, "private deterministic session\n", { flag: "wx", mode: 0o600 });
			const listeners = new Set<(event: { type: string }) => void>();
			return {
				session: {
					sessionFile,
					subscribe(listener: (event: { type: string }) => void) {
						listeners.add(listener);
						return () => listeners.delete(listener);
					},
					async prompt(prompt: string) {
						if (prompt.startsWith("Implement/inspect")) {
							workers += 1;
							if (workers === 1) throw new Error("worker setup failed before turn_start");
							for (const listener of listeners) listener({ type: "turn_start" });
							await report.execute("worker-report", {
								report: `inspection attempt ${workers}`,
								tests: [],
								accepted: true,
								semanticOutcome: workers === 2 ? "uncertain" : "disproven",
								predicates: [
									{ item: "selected acceptance inspected", ok: true, note: "the exact selected item was read" },
									{ item: "candidate finding supported", ok: workers !== 3, note: workers === 3 ? "the hypothesis was disproven" : "insufficient evidence on this attempt" },
								],
								publicationBlocker: workers === 3 ? "Disproven result retained privately; no disclosure is authorized." : "",
							});
						} else {
							for (const listener of listeners) listener({ type: "turn_start" });
							await report.execute("acceptance-report", {
								report: "the inspection result is supported by retained evidence",
								tests: [],
								accepted: true,
								semanticOutcome: "none",
								predicates: [{ item: "worker evidence matches the exact subject", ok: true, note: "independent review checked the retained artifacts" }],
								publicationBlocker: "",
							});
						}
					},
					async abort() {},
					async dispose() {},
				},
			};
		},
	};
	const schema = { object: () => ({}), string: () => ({}), array: () => ({}), boolean: () => ({}) };
	const github = { token: "probe-token", snapshot: async (value: SelectedItem) => value, assertFresh: async () => {} };
	const context = { model: {}, modelRegistry: { authStorage: {} } };
	try {
		await mkdir(workspace, { recursive: true, mode: 0o700 });
		const git = (...args: string[]): string => execFileSync("git", [
			"-c", "user.name=Factory Probe", "-c", "user.email=probe@localhost", ...args,
		], { cwd: workspace, encoding: "utf8" }).trim();
		execFileSync("git", ["init", "--quiet"], { cwd: workspace });
		await writeFile(join(workspace, "README.probe"), "stable inspection workspace\n");
		git("add", "README.probe");
		git("commit", "--quiet", "-m", "probe");
		const head = git("rev-parse", "HEAD");
		git("remote", "add", "origin", `https://github.com/${item.selected.repo}`);
		item.selected.base = head;
		item.selected.head = head;
		item.selected.baseRef = "main";
		item.ledger = { ...item.ledger, subject: { repo: item.selected.repo, base: head, head } };
		item.workspace = workspace;

		service = new BatchService(root, github as never, sdk as never, schema as never, 1);
		service.store.acquire();
		service.store.write(batch);
		await service.resume(batch.id, context as never);
		await service.waitForIdle();
		const first = service.store.read(batch.id).items[0]!;
		assert.equal(first.stage, "BLOCKED", "a confirmed pre-start failure can be retried safely");
		assert.equal(first.operation?.state, "not-applied");
		assert.equal(first.ledger.tasks[0]!.attempts[0]!.privateSessions[0]!.started, false);
		assert.equal(first.ledger.tasks[0]!.attempts[0]!.receipt, undefined);
		assert.equal(batchConverged(service.store.read(batch.id)), false);

		await service.retry(batch.id, item.selected.key, context as never);
		await service.waitForIdle();
		const uncertain = service.store.read(batch.id).items[0]!;
		assert.equal(uncertain.stage, "BLOCKED", "uncertain semantic evidence cannot complete the inspection");
		assert.equal(uncertain.operation?.state, "applied", "completed execution is distinct from acceptance proof");
		assert.equal(uncertain.ledger.tasks[0]!.attempts.at(-1)!.receipt!.semanticResult?.outcome, "uncertain");
		assert.equal(batchConverged(service.store.read(batch.id)), false);

		await service.retry(batch.id, item.selected.key, context as never);
		await service.waitForIdle();
		const final = new BatchStore(root).read(batch.id);
		const completed = final.items[0]!;
		assert.equal(workers, 3);
		assert.equal(final.items.length, 1, "a disproven finding never becomes successor work");
		assert.equal(completed.stage, "DONE");
		assert.equal(completed.ledger.tasks[0]!.attempts.at(-1)!.receipt!.semanticResult?.outcome, "disproven");
		assert.equal(completed.ledger.tasks[0]!.attempts.at(-1)!.receipt!.semanticResult?.publicationBlocker, "Disproven result retained privately; no disclosure is authorized.");
		const finalPredicates = completed.ledger.tasks[0]!.attempts.at(-1)!.receipt!.predicates!;
		assert.ok(finalPredicates.some((predicate) => predicate.phase === "worker" && predicate.ok));
		assert.ok(finalPredicates.some((predicate) => predicate.phase === "worker" && !predicate.ok));
		assert.ok(finalPredicates.some((predicate) => predicate.phase === "acceptance" && predicate.ok));
		assert.ok(batchSummary(final, root).includes("Disproven result retained privately; no disclosure is authorized."));
		assert.deepEqual(completed.operations.map((operation) => operation.state), ["not-applied", "applied"]);
		assert.deepEqual(completed.operations.map((operation) => operation.attemptId), ["T1-a1", "T1-a2"]);
		assert.equal(completed.operations[0]!.id, completed.operations[1]!.id);
		assert.equal(completed.operations[0]!.id, completed.operation!.id, "replacement workers retain one logical operation identity");
		assert.equal(completed.operation!.attemptId, "T1-a3");
		assert.equal(batchConverged(final), true);
		assert.ok([...completed.operations, completed.operation!].every((operation) => operation.phase !== "push" && operation.phase !== "pr"));
	} finally {
		if (service) await service.shutdown();
		await rm(root, { recursive: true, force: true });
	}
});


test("read-only inspection bypasses mutation claims and runs concurrently", async () => {
	const root = await mkdtemp(join(tmpdir(), "factory-inspect-"));
	const claimsRoot = await mkdtemp(join(tmpdir(), "factory-inspect-claims-"));
	try {
		const items = [selected("org/a#1", "inspect"), selected("org/a#2", "inspect")];
		const batch = createBatch(items, { ...options("reads"), capacity: 2 });
		const github = { snapshot: async (value: SelectedItem) => value, assertFresh: async () => {} };
		const service = new BatchService(root, github as never, undefined, {} as never, 2, claimsRoot);
		service.store.acquire();
		service.store.write(batch);
		const started: string[] = [];
		const internal = service as unknown as {
			execute: (current: Batch, currentItem: Batch["items"][number], signal: AbortSignal) => Promise<void>;
		};
		internal.execute = async (_current, currentItem) => {
			started.push(currentItem.selected.key);
			currentItem.stage = "DONE";
		};
		service.claims.claim("repo:org/a", "review:writer");
		await service.resume(batch.id, {});
		await service.waitForIdle();
		const resumed = service.store.read(batch.id);
		assert.deepEqual(started.sort(), items.map((item) => item.key).sort());
		assert.deepEqual(resumed.items.map((item) => item.stage), ["DONE", "DONE"]);
		assert.equal(service.claims.conflict("item:org/a#1", "another-owner"), undefined);
		assert.match(service.claims.conflict("repo:org/a", "another-owner")!, /review:writer/);
		await service.shutdown();
	} finally {
		await Promise.all([rm(root, { recursive: true, force: true }), rm(claimsRoot, { recursive: true, force: true })]);
	}
});

test("patch and pr-ready remain fenced by a conflicting repository claim", async () => {
	const root = await mkdtemp(join(tmpdir(), "factory-writes-"));
	const claimsRoot = await mkdtemp(join(tmpdir(), "factory-writes-claims-"));
	try {
		const items = [selected("org/a#3", "patch"), selected("org/a#4", "pr-ready")];
		const batch = createBatch(items, { ...options("writes"), capacity: 2 });
		const github = { snapshot: async (value: SelectedItem) => value, assertFresh: async () => {} };
		const service = new BatchService(root, github as never, undefined, {} as never, 2, claimsRoot);
		service.store.acquire();
		service.store.write(batch);
		const internal = service as unknown as {
			execute: () => Promise<void>;
		};
		internal.execute = async () => { throw new Error("writer should remain fenced"); };
		service.claims.claim("repo:org/a", "review:writer");
		await service.resume(batch.id, {});
		await service.waitForIdle();
		const resumed = service.store.read(batch.id);
		assert.deepEqual(resumed.items.map((item) => item.stage), ["BLOCKED", "BLOCKED"]);
		assert.match(resumed.items[0]!.blocker!, /review:writer/);
		assert.match(resumed.items[1]!.blocker!, /review:writer/);
		assert.equal(service.claims.conflict("item:org/a#3", "another-owner"), undefined);
		assert.match(service.claims.conflict("repo:org/a", "another-owner")!, /review:writer/);
		await service.shutdown();
	} finally {
		await Promise.all([rm(root, { recursive: true, force: true }), rm(claimsRoot, { recursive: true, force: true })]);
	}
});

test("mixed inspection and mutation work keeps the read lane available", async () => {
	const root = await mkdtemp(join(tmpdir(), "factory-mixed-"));
	const claimsRoot = await mkdtemp(join(tmpdir(), "factory-mixed-claims-"));
	try {
		const items = [selected("org/a#5", "inspect"), selected("org/a#6", "patch")];
		const batch = createBatch(items, { ...options("mixed"), capacity: 2 });
		const github = { snapshot: async (value: SelectedItem) => value, assertFresh: async () => {} };
		const service = new BatchService(root, github as never, undefined, {} as never, 2, claimsRoot);
		service.store.acquire();
		service.store.write(batch);
		const started: string[] = [];
		const internal = service as unknown as {
			execute: (current: Batch, currentItem: Batch["items"][number], signal: AbortSignal) => Promise<void>;
		};
		internal.execute = async (_current, currentItem) => {
			started.push(currentItem.selected.key);
			currentItem.stage = "DONE";
		};
		service.claims.claim("repo:org/a", "review:writer");
		await service.resume(batch.id, {});
		await service.waitForIdle();
		const resumed = service.store.read(batch.id);
		assert.deepEqual(started, ["org/a#5"]);
		assert.equal(resumed.items[0]!.stage, "DONE");
		assert.equal(resumed.items[1]!.stage, "BLOCKED");
		assert.match(resumed.items[1]!.blocker!, /review:writer/);
		await service.shutdown();
	} finally {
		await Promise.all([rm(root, { recursive: true, force: true }), rm(claimsRoot, { recursive: true, force: true })]);
	}
});

test("failed inspection leaves no mutation claim behind", async () => {
	const root = await mkdtemp(join(tmpdir(), "factory-inspect-failure-"));
	const claimsRoot = await mkdtemp(join(tmpdir(), "factory-inspect-failure-claims-"));
	try {
		const batch = createBatch([selected("org/a#7", "inspect")], options("inspect-failure"));
		const github = { snapshot: async (value: SelectedItem) => value, assertFresh: async () => {} };
		const service = new BatchService(root, github as never, undefined, {} as never, 1, claimsRoot);
		service.store.acquire();
		service.store.write(batch);
		const internal = service as unknown as { execute: () => Promise<void> };
		internal.execute = async () => { throw new Error("inspect failed"); };
		await service.resume(batch.id, {});
		await service.waitForIdle();
		const resumed = service.store.read(batch.id).items[0]!;
		assert.equal(resumed.stage, "BLOCKED");
		assert.equal(service.claims.conflict("repo:org/a", "another-owner"), undefined);
		assert.equal(service.claims.conflict("item:org/a#7", "another-owner"), undefined);
		await service.shutdown();
	} finally {
		await Promise.all([rm(root, { recursive: true, force: true }), rm(claimsRoot, { recursive: true, force: true })]);
	}
});
