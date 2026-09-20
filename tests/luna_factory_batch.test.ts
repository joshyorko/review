import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
	batchConverged,
	createBatch,
	dependencyBlocker,
	selectionIdentity,
	type Batch,
	type SelectedItem,
} from "../image/extension/luna-factory/core/batch.ts";
import { createLunaFactoryExtension } from "../image/extension/luna-factory/index.ts";
import { BatchStore, ResourceClaims } from "../image/extension/luna-factory/omp/batch-store.ts";
import { captureWaveJobIds, reconcileBlockedRepositoryClaim, waveWorkerCoverageComplete, waveWorkersSettled } from "../image/extension/bluefin-review/extension.ts";
import { BatchService } from "../image/extension/luna-factory/omp/batch-service.ts";
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

test("cancellation, exclusion, and scope revisions never falsely converge", () => {
	const batch = createBatch([selected("org/a#1"), selected("org/b#2")], options("dead"));
	batch.items[0]!.stage = "CANCELLED"; batch.items[1]!.stage = "EXCLUDED"; assert.equal(batchConverged(batch), false);
	done(batch, "org/a#1"); done(batch, "org/b#2"); assert.equal(batchConverged(batch), true);
	batch.scopeRevisions.push({ item: "org/a#1", reason: "changed", at: "now" }); assert.equal(batchConverged(batch), false);
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
		const item = selected("org/a#1", "inspect");
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
			currentItem.operation = { id: `${current.id}:${currentItem.selected.key}:attempt`, phase: "worker", state: "intent" };
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
