import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBatch, type SelectedItem } from "../image/extension/luna-factory/core/batch.ts";
import { BatchGitHub } from "../image/extension/luna-factory/omp/batch-github.ts";
import { BatchService } from "../image/extension/luna-factory/omp/batch-service.ts";
import { BatchStore } from "../image/extension/luna-factory/omp/batch-store.ts";

const options = { capacity: 1, maxAttempts: 2, maxTotalAttempts: 2, mode: "retain" as const };
const selected = (number: number, blocker?: string): SelectedItem => ({
	key: `example/repo#${number}`, repo: "example/repo", number, kind: "issue", action: "inspect", overlaps: [],
	acceptanceRevision: "r1", base: "a".repeat(40), head: "a".repeat(40), ...(blocker ? { blocker } : {}),
});

async function batches(root: string, count: number, size = 0): Promise<string[]> {
	const store = new BatchStore(root);
	store.acquire();
	const ids: string[] = [];
	for (let index = 0; index < count; index += 1) {
		const id = `batch-${index.toString(16).padStart(8, "0")}`;
		store.write(createBatch([selected(index + 1, size ? "x".repeat(size) : undefined)], { ...options, id }));
		ids.push(id);
	}
	store.release();
	return ids;
}

test("history pages decode at most 25 records and keep a stable cursor", async () => {
	const root = await mkdtemp(join(tmpdir(), "factory-history-page-"));
	try {
		const ids = await batches(root, 101);
		const service = new BatchService(root, new BatchGitHub(undefined), undefined, {} as never, 2);
		let reads = 0;
		const read = service.store.readAsync.bind(service.store);
		service.store.readAsync = async (id) => { reads += 1; return read(id); };
		const first = await service.readHistoryPage();
		assert.equal(first.snapshot.batches.length, 25);
		assert.equal(reads, 25);
		await utimes(join(root, `${ids[0]}.json`), new Date(), new Date(Date.now() + 60_000));
		const seen = new Set(first.snapshot.batches.map((batch) => batch.id));
		let cursor = first.next;
		while (cursor) {
			const page = await service.readHistoryPage(cursor);
			for (const batch of page.snapshot.batches) assert.equal(seen.has(batch.id), false);
			for (const batch of page.snapshot.batches) seen.add(batch.id);
			cursor = page.next;
		}
		assert.deepEqual([...seen].sort(), ids.sort());
	} finally { await rm(root, { recursive: true, force: true }); }
});

test("history isolates corruption and puts a focused older run on the first page", async () => {
	const root = await mkdtemp(join(tmpdir(), "factory-history-focus-"));
	try {
		const ids = await batches(root, 30);
		await writeFile(join(root, "batch-00000001.json"), "{corrupt");
		await utimes(join(root, "batch-00000001.json"), new Date(), new Date(Date.now() + 60_000));
		const old = new Date(Date.now() - 60_000);
		await utimes(join(root, "batch-00000000.json"), old, old);
		const service = new BatchService(root, new BatchGitHub(undefined), undefined, {} as never, 2);
		const page = await service.readHistoryPage(undefined, ids[0]);
		assert.equal(page.snapshot.batches[0]?.id, ids[0]);
		assert.equal(page.snapshot.errors.some((error) => error.id === ids[1]), true);
		assert.equal(new Set(page.snapshot.batches.map((batch) => batch.id)).size, page.snapshot.batches.length);
	} finally { await rm(root, { recursive: true, force: true }); }
});

test("history page source bytes stay bounded", async () => {
	const root = await mkdtemp(join(tmpdir(), "factory-history-bytes-"));
	try {
		const ids = await batches(root, 20, 2_000_000);
		const service = new BatchService(root, new BatchGitHub(undefined), undefined, {} as never, 2);
		const page = await service.readHistoryPage();
		const bytes = await Promise.all(page.snapshot.batches.map(async (batch) => (await import("node:fs/promises")).stat(join(root, `${batch.id}.json`)).then((stat) => stat.size)));
		assert.ok(bytes.reduce((sum, value) => sum + value, 0) <= 32 * 1024 * 1024);
		assert.ok(page.next);
	} finally { await rm(root, { recursive: true, force: true }); }
});
