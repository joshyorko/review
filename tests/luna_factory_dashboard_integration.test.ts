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

async function storedBatch(root: string, id = "batch-abcdef", number = 1) {
	const store = new BatchStore(root); store.acquire();
	const batch = createBatch([{ ...selected(number), action: "patch" }], { ...options, id });
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
				return new Promise<T>((resolve, reject) => {
					let component: FactoryDashboard | undefined;
					let completed = false;
					const paint = () => {
						if (!component || completed) return;
						const frame = component.render(110); frames.push(frame);
						if (frame.some((line) => line.includes("Loading"))) return;
						completed = true;
						const action = actions[calls++] ?? { kind: "close" };
						if (calls > 10) { reject(new Error("dashboard did not close")); return; }
						component.dispose(); resolve(action as T);
					};
					component = factory({ requestRender() { queueMicrotask(paint); } }, { fg: (_c: string, text: string) => text, bold: (text: string) => text, inverse: (text: string) => text }, {}, resolve) as FactoryDashboard;
					paint();
				});
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
		const loadedFrames = frames.filter((frame) => !frame.some((line) => line.includes("Loading")));
		assert.equal(loadedFrames.length, 2);
		assert.ok(loadedFrames.every((frame) => frame.join("\n").includes("#1")));
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
		assert.match(frames.find((frame) => !frame.some((line) => line.includes("Loading")))!.join("\n"), /Viewing only/);
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

test("asynchronous dashboard reconstruction uses the same store validation without acquiring ownership", async () => {
	const root = await mkdtemp(join(tmpdir(), "factory-async-reconstruct-"));
	try {
		const batch = await storedBatch(root);
		const before = readFileSync(join(root, `${batch.id}.json`), "utf8");
		const service = new BatchService(root, new BatchGitHub(undefined), undefined, {} as never, 2);
		let yielded = false;
		const reading = service.readSnapshotAsync();
		queueMicrotask(() => { yielded = true; });
		const snapshot = await reading;
		assert.equal(yielded, true);
		assert.deepEqual(snapshot, service.readSnapshot());
		assert.equal(existsSync(join(root, "owner.json")), false);
		assert.equal(readFileSync(join(root, `${batch.id}.json`), "utf8"), before);
	} finally { await rm(root, { recursive: true, force: true }); }
});

import { DASHBOARD_ENTRY, loadDashboardPresentation, saveDashboardPresentation } from "../image/extension/luna-factory/omp/session.ts";

test("native session presentation restores batch/item/view without changing Factory authority", () => {
	const entries: Array<{type: string; customType: string; data: unknown}> = [];
	saveDashboardPresentation({ appendEntry(customType, data) { entries.push({ type: "custom", customType, data }); } }, {
		batchId: "batch-ab", itemKey: "example/repo#1", view: "evidence", scroll: 5, cursor: 2,
		itemKeysByBatch: { "batch-ab": "example/repo#1", "batch-cd": "example/repo#2" }, cursorKeys: { evidence: "/state/session.jsonl" },
	});
	assert.equal(entries[0]?.customType, DASHBOARD_ENTRY);
	const restored = loadDashboardPresentation({ sessionManager: { getBranch: () => entries } });
	assert.equal(restored?.itemKey, "example/repo#1"); assert.equal(restored?.view, "evidence");
	assert.equal(restored?.itemKeysByBatch?.["batch-cd"], "example/repo#2");
	entries.push({ type: "custom", customType: DASHBOARD_ENTRY, data: { view: "execute", scroll: -1, control: "active" } });
	assert.equal(loadDashboardPresentation({ sessionManager: { getBranch: () => entries } }), undefined);
});

test("production loading, nested evidence, and pause preserve one live parent dashboard", { timeout: 10_000 }, async () => {
	const root = await mkdtemp(join(tmpdir(), "factory-native-journey-"));
	const frames: string[][] = [];
	try {
		const batch = await storedBatch(root); const store = new BatchStore(root); store.acquire();
		const session = join(root, "worker.jsonl"); await writeFile(session, "retained worker evidence ".repeat(100) + "TAIL_PROOF");
		const saved = store.read(batch.id); saved.items[0]!.sessions = [session]; store.write(saved); store.release();
		const host = extensionHost(root); let depth = 0; let mounts = 0; let viewers = 0; let phase = 0; let sawLoading = false;
		let parentPaint: (() => void) | undefined;
		const ctx = {
			hasUI: true,
			ui: {
				notify() {},
				async custom<T>(factory: (tui: unknown, theme: unknown, keys: unknown, done: (result: T) => void) => unknown): Promise<T> {
					const level = ++depth; if (level === 1) mounts++; else viewers++;
					return new Promise<T>((resolve, reject) => {
						let component: { render(width: number): string[]; handleInput(input: string): void; dispose(): void };
						let finished = false;
						const paint = () => {
							if (!component || finished) return;
							try {
								const frame = component.render(80); frames.push(frame);
								if (level === 2) {
									assert.equal(depth, 2); component.handleInput("end");
									assert.match(component.render(80).join("\n"), /TAIL_PROOF/);
									component.handleInput("q"); return;
								}
								if (frame.some((line) => line.includes("Loading"))) { sawLoading = true; assert.doesNotMatch(frame.join("\n"), /No retained/); return; }
								if (depth !== 1 || /action in progress/i.test(frame.join("\n"))) return;
								if (phase === 0) { phase = 1; component.handleInput("e"); component.handleInput("Enter"); }
								else if (phase === 1 && viewers === 1) { phase = 2; component.handleInput("q"); component.handleInput("p"); }
								else if (phase === 2 && /paused/i.test(frame.join("\n"))) { phase = 3; component.handleInput("q"); }
							} catch (error) { reject(error); }
						};
						component = factory({ requestRender() { queueMicrotask(paint); }, terminal: { rows: 12 } }, { fg: (_c: string, t: string) => t, bold: (t: string) => t, inverse: (t: string) => t }, {}, (result) => {
							finished = true; depth--; component.dispose(); resolve(result); if (level === 2) queueMicrotask(() => parentPaint?.());
						}) as typeof component;
						if (level === 1) parentPaint = paint;
						paint();
					});
				},
			},
		};
		await host.commands.get("factory")!.handler("", ctx as never);
		assert.equal(sawLoading, true); assert.equal(mounts, 1); assert.equal(viewers, 1); assert.equal(phase, 3);
		assert.equal(new BatchStore(root).read(batch.id).control, "paused");
		assert.equal(host.modelCalls(), 0);
		await host.events.get("session_shutdown")?.({}, ctx as never);
	} finally { await rm(root, { recursive: true, force: true }); }
});

test("native stop confirmation runs after the dashboard closes and restores selection", { timeout: 10_000 }, async () => {
 const root = await mkdtemp(join(tmpdir(), "factory-visible-confirm-"));
 try {
  const batch = await storedBatch(root);
  const host = extensionHost(root);
  let mounted = false; let mounts = 0; let confirmations = 0; let inputError: unknown;
  const ctx = { hasUI: true, ui: {
   notify() {},
   async confirm() { assert.equal(mounted, false, "editor confirmation must not be covered by the overlay"); confirmations++; return false; },
   custom<T>(factory: (tui: unknown, theme: unknown, keys: unknown, done: (result: T) => void) => unknown): Promise<T> {
    mounted = true; mounts++;
    return new Promise((resolve, reject) => {
     let component: FactoryDashboard | undefined; let acted = false;
     const paint = () => {
      if (!component || acted) return;
      if (/Loading/.test(component.render(100).join("\n"))) return;
      acted = true;
      try {
       assert.equal(component.selection.batchId, batch.id);
       component.handleInput(mounts === 1 ? "x" : "q");
      } catch (error) { inputError = error; reject(error); }
     };
     component = factory({ requestRender() { queueMicrotask(paint); } }, { fg: (_c: string, t: string) => t, bold: (t: string) => t, inverse: (t: string) => t }, {}, (action) => { mounted = false; component?.dispose(); resolve(action); }) as FactoryDashboard;
     queueMicrotask(paint);
    });
   }
  } };
  await host.commands.get("factory")!.handler("", ctx as never);
  assert.equal(inputError, undefined);
  assert.equal(confirmations, 1); assert.equal(mounts, 2);
  assert.equal(new BatchStore(root).read(batch.id).control, "active");
  await host.events.get("session_shutdown")?.({}, ctx as never);
 } finally { await rm(root, { recursive: true, force: true }); }
});

test("native confirmation keeps the selected batch when another active batch sorts ahead", { timeout: 10_000 }, async () => {
	const root = await mkdtemp(join(tmpdir(), "factory-confirm-selection-"));
	try {
		const store = new BatchStore(root);
		store.acquire();
		const old = createBatch([{ ...selected(1), action: "patch" }], { ...options, id: "batch-11111111" });
		old.createdAt = "2026-01-01T00:00:00.000Z";
		old.control = "active";
		old.items[0]!.stage = "BLOCKED";
		old.items[0]!.blocker = "older blocked run";
		store.write(old);
		const target = createBatch([{ ...selected(2), action: "patch" }], { ...options, id: "batch-22222222" });
		target.createdAt = "2026-02-01T00:00:00.000Z";
		target.control = "active";
		target.items[0]!.stage = "RUNNING";
		store.write(target);
		store.release();

		const host = extensionHost(root);
		const branch = [{ type: "custom", customType: DASHBOARD_ENTRY, data: {
			batchId: old.id, itemKey: old.items[0]!.selected.key, view: "roster", scroll: 0,
		} }];
		const context = { hasUI: true, sessionManager: { getBranch: () => branch } };
		await host.events.get("session_start")?.({}, context as never);
		let mounted = false;
		let mounts = 0;
		let confirmations = 0;
		let selectedTarget = false;
		let firstError: unknown;
		const ui = {
			notify() {},
			async confirm() {
				assert.equal(mounted, false, "native confirmation must be above the closed dashboard");
				confirmations++;
				return true;
			},
			custom<T>(factory: (tui: unknown, theme: unknown, keys: unknown, done: (result: T) => void) => unknown): Promise<T> {
				mounted = true;
				mounts++;
				return new Promise((resolve, reject) => {
					let component: FactoryDashboard | undefined;
					let finished = false;
					const paint = () => {
						if (!component || finished) return;
						try {
							const frame = component.render(100).join("\n");
							if (/Loading/.test(frame)) return;
							if (mounts === 1 && !selectedTarget) {
								assert.equal(component.selection.batchId, old.id);
								component.handleInput("b");
								component.handleInput("k");
								component.handleInput("Enter");
								assert.equal(component.selection.batchId, target.id);
								selectedTarget = true;
								component.handleInput("x");
							} else if (mounts === 2) {
								assert.equal(component.selection.batchId, target.id, "the confirmed action's batch remains selected after remount");
								assert.equal(component.selection.itemKey, target.items[0]!.selected.key);
								assert.equal(store.read(target.id).control, "stopped");
								assert.match(frame, /Stopped/);
								finished = true;
								component.handleInput("q");
							}
						} catch (error) {
							firstError = error;
							reject(error);
						}
					};
					component = factory({ requestRender() { queueMicrotask(paint); } }, { fg: (_c: string, text: string) => text, bold: (text: string) => text, inverse: (text: string) => text }, {}, (action) => {
						mounted = false;
						component?.dispose();
						resolve(action);
					}) as FactoryDashboard;
					queueMicrotask(paint);
				});
			},
		};
		await host.commands.get("factory")!.handler("", { ...context, ui } as never);
		assert.equal(firstError, undefined);
		assert.equal(selectedTarget, true);
		assert.equal(mounts, 2);
		assert.equal(confirmations, 1);
		assert.equal(store.read(old.id).control, "active");
		await host.events.get("session_shutdown")?.({}, context as never);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("ownership recovery checks the selected owner once and refreshes an empty dashboard", async () => {
 const root = await mkdtemp(join(tmpdir(), "factory-owner-recovery-"));
 const { ResourceClaims } = await import("../image/extension/luna-factory/omp/batch-store.ts");
 const { registerFactoryReconciler } = await import("../image/extension/luna-factory/omp/batch-bridge.ts");
 const claims = new ResourceClaims(root, join(root, "claims"));
 const owner = "review:target:0";
 claims.claim("repo:target/repo", owner); claims.claim("item:target/repo#1", owner);
 claims.claim("repo:other/repo", "review:other:0");
 const checked: string[] = [];
 const unregister = registerFactoryReconciler(async (actualOwner, resource) => {
  assert.equal(actualOwner, owner); checked.push(resource); claims.markSettled(resource, owner); return "settled";
 });
 try {
  const host = extensionHost(root); const frames: string[][] = [];
  const ctx = interactive([{ kind: "reconcile", owner, resource: "repo:target/repo" }, { kind: "close" }], frames, () => true);
  await host.commands.get("factory")!.handler("", ctx as never);
  assert.deepEqual(checked.sort(), ["item:target/repo#1", "repo:target/repo"]);
  assert.deepEqual(claims.list().map((claim) => claim.owner), ["review:other:0"]);
  assert.doesNotMatch(frames.at(-1)!.join("\n"), /target\/repo/);
  assert.match(frames.at(-1)!.join("\n"), /other\/repo/);
  await host.events.get("session_shutdown")?.({}, ctx as never);
 } finally { unregister(); await rm(root, { recursive: true, force: true }); }
});
