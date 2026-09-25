import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBatch, type SelectedItem } from "../image/extension/luna-factory/core/batch.ts";
import { BatchGitHub } from "../image/extension/luna-factory/omp/batch-github.ts";
import { BatchService } from "../image/extension/luna-factory/omp/batch-service.ts";
import { BatchStore } from "../image/extension/luna-factory/omp/batch-store.ts";
import { registerFactoryBatchSubmitter, submitFactoryBatch } from "../image/extension/luna-factory/omp/batch-bridge.ts";

const selected = (number: number): SelectedItem => ({
	key: `example/repo#${number}`,
	repo: "example/repo",
	number,
	kind: "issue",
	action: "inspect",
	overlaps: [],
	acceptanceRevision: "r1",
	base: "a".repeat(40),
	head: "a".repeat(40),
});

const options = { capacity: 2, maxAttempts: 2, maxTotalAttempts: 4, mode: "retain" as const };

test("dashboard snapshots are local, read-only, and retain healthy batches beside corrupt stores", async () => {
	const root = await mkdtemp(join(tmpdir(), "factory-dashboard-integration-"));
	try {
		const store = new BatchStore(root);
		store.acquire();
		store.write(createBatch([selected(1)], { ...options, id: "batch-aaaaaaaa" }));
		store.release();
		await writeFile(join(root, "batch-bbbbbbbb.json"), "{not-json");
		let networkCalls = 0;
		const github = new BatchGitHub(undefined, (async () => { networkCalls += 1; throw new Error("dashboard must not call GitHub"); }) as unknown as typeof fetch);
		const service = new BatchService(root, github, undefined, {} as never, 2);
		let resumed = 0;
		service.resume = (async () => { resumed += 1; }) as typeof service.resume;
		const snapshot = service.readSnapshot();
		assert.equal(snapshot.batches[0]?.id, "batch-aaaaaaaa");
		assert.equal(snapshot.errors[0]?.id, "batch-bbbbbbbb");
		assert.equal(snapshot.activeItemKeys.length, 0);
		assert.equal(networkCalls, 0);
		assert.equal(resumed, 0);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("BatchService change observers are independent and unsubscribe cleanly", async () => {
	const root = await mkdtemp(join(tmpdir(), "factory-dashboard-events-"));
	try {
		const github = new BatchGitHub(undefined, (async () => { throw new Error("snapshot should be local in this test"); }) as unknown as typeof fetch);
		const service = new BatchService(root, github, undefined, {} as never, 2);
		let first = 0;
		let second = 0;
		const removeFirst = service.onChange(() => { first += 1; });
		service.onChange(() => { second += 1; });
		await service.submit([selected(1)], options);
		removeFirst();
		await service.submit([selected(2)], options);
		assert.equal(first, 1);
		assert.equal(second, 2);
		assert.equal(service.isWriterAcquired(), true);
		await service.shutdown();
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("Review handoff returns the authoritative batch identity without parsing status text", async () => {
	const unregister = registerFactoryBatchSubmitter(async (action, context) => ({
		batchId: "batch-handoff",
		text: `${action} ${String((context as { source?: string }).source ?? "")}`,
	}));
	try {
		const result = await submitFactoryBatch("patch", { source: "review" });
		assert.deepEqual(result, { batchId: "batch-handoff", text: "patch review" });
	} finally {
		unregister();
	}
});

import { createLunaFactoryExtension, type FactoryHost } from "../image/extension/luna-factory/index.ts";
import { factoryBatchSubmitterRegistered, factoryDashboardOpenerRegistered, factoryCommand, openFactoryDashboard, readFactoryDashboardSnapshot } from "../image/extension/luna-factory/omp/batch-bridge.ts";
import type { FactoryDashboard, FactoryDashboardAction } from "../image/extension/luna-factory/ui/dashboard.ts";
import { existsSync, readFileSync } from "node:fs";

type Command = Parameters<NonNullable<FactoryHost["registerCommand"]>>[1];
function extensionHost(root: string, enabled = true) {
	const commands = new Map<string, Command>();
	const events = new Map<string, Parameters<FactoryHost["on"]>[1]>();
	const schema = { optional() { return this; }, describe() { return this; } };
	let modelCalls = 0;
	const host: FactoryHost = {
		zod: { object: () => schema, string: () => schema, number: () => schema, boolean: () => schema, array: () => schema, enum: () => schema, literal: () => schema, union: () => schema },
		registerTool() {}, setLabel() {}, appendEntry() {},
		on(name, handler) { events.set(name, handler); },
		registerCommand(name, definition) { commands.set(name, definition); },
		sendUserMessage() { modelCalls++; throw new Error("render started a model turn"); },
	};
	createLunaFactoryExtension(host, { env: { LUNA_FACTORY_STATE_ROOT: root, LUNA_FACTORY_CLAIMS_ROOT: join(root, "claims"), ...(enabled ? { LUNA_FACTORY_ENABLED: "1" } : {}) } });
	return { commands, events, modelCalls: () => modelCalls };
}

async function storedBatch(root: string) {
	const store = new BatchStore(root); store.acquire();
	const batch = createBatch([{ ...selected(1), action: "patch" }], { ...options, id: "batch-abcdef" });
	batch.control = "active";
	store.write(batch); store.release(); return batch;
}

function interactive(actions: FactoryDashboardAction[], frames: string[][], confirmations?: () => boolean) {
	let calls = 0;
	const messages: string[] = [];
	return {
		hasUI: true,
		ui: {
			notify(message: string) { messages.push(message); },
			confirm: confirmations ? async () => confirmations() : undefined,
			async custom<T>(factory: (tui: unknown, theme: unknown, keys: unknown, done: (result: T) => void) => unknown, options?: unknown): Promise<T> {
				assert.deepEqual(options, { overlay: true, overlayOptions: { fullscreen: true, width: "100%", maxHeight: "100%", anchor: "top-left", mouseTracking: false } });
				let result: T | undefined;
				const component = factory({ requestRender() {} }, { fg: (_c: string, text: string) => text, bold: (text: string) => text, inverse: (text: string) => text }, {}, (value) => { result = value; }) as FactoryDashboard;
				frames.push(component.render(110));
				const action = actions[calls++] ?? { kind: "close" };
				if (calls > 10) throw new Error("dashboard did not close");
				component.dispose();
				return action as T;
			},
		},
		messages,
	};
}

test("loaded extension retains typed handoff seams; dashboard reopen does not write or call a model", async () => {
	const root = await mkdtemp(join(tmpdir(), "factory-live-ui-"));
	try {
		const batch = await storedBatch(root);
		const file = join(root, `${batch.id}.json`); const before = readFileSync(file, "utf8");
		const host = extensionHost(root); const frames: string[][] = [];
		assert.equal(factoryBatchSubmitterRegistered(), true);
		assert.equal(factoryDashboardOpenerRegistered(), true);
		assert.equal(readFactoryDashboardSnapshot().batches[0]?.id, batch.id);
		const ctx = interactive([{ kind: "close" }], frames);
		await host.commands.get("factory")!.handler("", ctx as never);
		await openFactoryDashboard(ctx, batch.id);
		assert.equal(frames.length, 2);
		assert.ok(frames.every((frame) => frame.join("\n").includes(batch.id)));
		assert.equal(readFileSync(file, "utf8"), before);
		assert.equal(existsSync(join(root, "owner.json")), false);
		assert.equal(host.modelCalls(), 0);
		await host.events.get("session_shutdown")?.({}, ctx as never);
		assert.equal(readFileSync(file, "utf8"), before);
	} finally { await rm(root, { recursive: true, force: true }); }
});

test("dashboard pause and textual pause use the same retained controller", async () => {
	const root = await mkdtemp(join(tmpdir(), "factory-controls-"));
	try {
		const batch = await storedBatch(root); const host = extensionHost(root);
		const ctx = interactive([{ kind: "pause", batchId: batch.id }, { kind: "close" }], []);
		await host.commands.get("factory")!.handler("", ctx as never);
		assert.equal(new BatchStore(root).read(batch.id).control, "paused");
		assert.match(await factoryCommand(`pause ${batch.id}`, ctx), /paused/);
		await host.events.get("session_shutdown")?.({}, ctx as never);
	} finally { await rm(root, { recursive: true, force: true }); }
});

test("stop is fail closed without confirmation and cancelled confirmation preserves work", async () => {
	for (const confirmation of [undefined, () => false]) {
		const root = await mkdtemp(join(tmpdir(), "factory-confirm-"));
		try {
			const batch = await storedBatch(root); const host = extensionHost(root);
			const ctx = interactive([{ kind: "stop", batchId: batch.id }, { kind: "close" }], [], confirmation);
			await host.commands.get("factory")!.handler("", ctx as never);
			assert.equal(new BatchStore(root).read(batch.id).control, "active");
			assert.equal(existsSync(join(root, "owner.json")), false);
			await host.events.get("session_shutdown")?.({}, ctx as never);
		} finally { await rm(root, { recursive: true, force: true }); }
	}
});

test("disabled Factory still inspects retained history and refuses emitted mutation", async () => {
	const root = await mkdtemp(join(tmpdir(), "factory-disabled-ui-"));
	try {
		const batch = await storedBatch(root); const host = extensionHost(root, false); const frames: string[][] = [];
		const ctx = interactive([{ kind: "pause", batchId: batch.id }, { kind: "close" }], frames);
		await host.commands.get("factory")!.handler("", ctx as never);
		assert.match(frames[0]!.join("\n"), /read-only/);
		assert.equal(new BatchStore(root).read(batch.id).control, "active");
		assert.equal(existsSync(join(root, "owner.json")), false);
		await host.events.get("session_shutdown")?.({}, ctx as never);
	} finally { await rm(root, { recursive: true, force: true }); }
});

test("persistence failures repaint a fail-closed snapshot without overwriting the retained batch", async () => {
	const root = await mkdtemp(join(tmpdir(), "factory-disk-failure-"));
	try {
		const batch = await storedBatch(root);
		const service = new BatchService(root, new BatchGitHub(undefined), undefined, {} as never, 2);
		let problem = "";
		service.onChange(() => { problem = service.readSnapshot().fatal ?? ""; });
		service.store.write = () => { throw new Error("disk full"); };
		await assert.rejects(service.control(batch.id, "pause"), /disk full/);
		assert.match(problem, /persistence failed.*disk full/);
		assert.equal(new BatchStore(root).read(batch.id).control, "active");
		service.store.release();
	} finally { await rm(root, { recursive: true, force: true }); }
});
