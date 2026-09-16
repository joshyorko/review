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
import { BatchStore, ResourceClaims } from "../image/extension/luna-factory/omp/batch-store.ts";

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
		const claims = new ResourceClaims(root); claims.claim("repo:Org/A", "owner-1"); assert.match(claims.conflict("repo:org/a", "owner-2")!, /owner-1/); claims.release("repo:ORG/A", "owner-1"); assert.equal(claims.conflict("repo:org/a", "owner-2"), undefined);
	} finally { await rm(root, { recursive: true, force: true }); await rm(outside, { recursive: true, force: true }); }
});
