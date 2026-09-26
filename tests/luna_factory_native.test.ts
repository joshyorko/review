import assert from "node:assert/strict";
import test from "node:test";
import { link, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveNativeBinding, runNative, sandboxPreflight, sandboxTest, type NativeSDK, type SchemaBuilder } from "../image/extension/luna-factory/omp/batch-native.ts";

const schema = { object: (x: Record<string, unknown>) => x, string: () => ({}), number: () => ({}), array: (x: unknown) => x, boolean: () => ({}) } as unknown as SchemaBuilder;
function item(workspace: string, acceptance = "inspect") { return { workspace, selected: { key: "r/1", repo: "r", number: 1, kind: "issue", action: "patch", overlaps: [], acceptance }, sessions: [], attempts: 0, stage: "QUEUED", ledger: {} } as never; }
type Tool = { name: string; execute(_id: string, args: unknown): Promise<unknown> };
function fake(invoke: (tools: Tool[]) => Promise<void>, startsTurn = true, onPrompt: (prompt: string) => void = () => {}) {
	let disposed = false;
	let tools: Tool[] = [];
	const listeners = new Set<(event: { type: string }) => void>();
	const session = {
		sessionFile: "native.log",
		subscribe(listener: (event: { type: string }) => void) { listeners.add(listener); return () => listeners.delete(listener); },
		abort: async () => {},
		dispose: async () => { disposed = true; },
		prompt: async (text: string) => {
			onPrompt(text);
			if (!startsTurn) return;
			for (const listener of listeners) listener({ type: "turn_start" });
			await tools.find((tool) => tool.name === "factory_report")?.execute("id", {
				report: "observed",
				tests: ["true"],
				accepted: true,
				semanticOutcome: "none",
				predicates: [{ item: "native verification command", ok: true, note: "reported" }],
				publicationBlocker: "",
			});
		},
	};
	const sdk = { Settings: { isolated: (x: Record<string, unknown>) => x }, SessionManager: { create: () => ({}) }, AgentRegistry: class {}, createAgentSession: async (options: { customTools?: unknown[] }) => { tools = options.customTools as Tool[]; await invoke(tools); return { session }; } } as unknown as NativeSDK;
	return { sdk, get disposed() { return disposed; } };
}

test("native file tools reject traversal, URI, symlink, and hardlink paths", async () => {
	const root = await mkdtemp(join(tmpdir(), "factory-native-"));
	try {
		await mkdir(join(root, "src")); await writeFile(join(root, "src", "x"), "x");
		await symlink("/tmp", join(root, "escape"));
		const outside = join(root, "outside"); await writeFile(outside, "outside"); await link(outside, join(root, "hard"));
		let tools: Tool[] = [];
		const sdk = fake(async (registered) => { tools = registered; });
		const transitions: string[] = [];
		await runNative(
			sdk.sdk,
			schema,
			{ model: {}, modelRegistry: { authStorage: {}, hasConfiguredAuth: () => true } },
			item(root),
			root,
			"worker",
			new AbortController().signal,
			(session) => transitions.push(`identity:${session}`),
			(session) => transitions.push(`started:${session}`),
		);
		assert.deepEqual(transitions, ["identity:native.log", "started:native.log"]);
		const read = tools.find((x) => x.name === "factory_read")!;
		for (const path of ["../outside", "/etc/passwd", "file:///etc/passwd", "escape/x", "hard"]) await assert.rejects(() => read.execute("id", { path }));
		assert.equal(sdk.disposed, true);
	} finally { await rm(root, { recursive: true, force: true }); }
});

test("a persisted private session path does not report execution before turn_start", async () => {
	const root = await mkdtemp(join(tmpdir(), "factory-native-start-"));
	try {
		const sdk = fake(async () => {}, false);
		const sessionIds: string[] = [];
		const startedIds: string[] = [];
		await assert.rejects(
			() => runNative(
				sdk.sdk,
				schema,
				{ model: {}, modelRegistry: { authStorage: {}, hasConfiguredAuth: () => true } },
				item(root),
				root,
				"worker",
				new AbortController().signal,
				(session) => sessionIds.push(session),
				(session) => startedIds.push(session),
			),
			/native worker returned without an evidence candidate/,
		);
		assert.deepEqual(sessionIds, ["native.log"]);
		assert.deepEqual(startedIds, []);
		assert.equal(sdk.disposed, true);
	} finally { await rm(root, { recursive: true, force: true }); }
});
test("native worker and reviewer prompts retain complete selected acceptance", async () => {
	const root = await mkdtemp(join(tmpdir(), "factory-native-acceptance-"));
	try {
		const acceptance = `${"long acceptance ".repeat(1_500)}LONG-ACCEPTANCE-SENTINEL`;
		const prompts: string[] = [];
		for (const phase of ["worker", "acceptance"] as const) {
			const sdk = fake(async () => {}, true, (prompt) => prompts.push(prompt));
			await runNative(
				sdk.sdk,
				schema,
				{ model: {}, modelRegistry: { authStorage: {}, hasConfiguredAuth: () => true } },
				item(root, acceptance),
				root,
				phase,
				new AbortController().signal,
				() => {},
				() => {},
			);
		}
		assert.equal(prompts.length, 2);
		for (const prompt of prompts) {
			assert.ok(prompt.includes(acceptance));
			assert.ok(prompt.includes("LONG-ACCEPTANCE-SENTINEL"));
		}
	} finally { await rm(root, { recursive: true, force: true }); }
});

test("sandbox refuses symlinked verification workspace before invoking bwrap", async () => {
	const root = await mkdtemp(join(tmpdir(), "factory-native-"));
	try {
		await symlink("/tmp", join(root, "link"));
		await assert.rejects(() => sandboxTest(root, "true", new AbortController().signal), /unsafe verification workspace/);
	} finally { await rm(root, { recursive: true, force: true }); }
});

test("native binding snapshots inherited live OMP model and registry exactly once", () => {
	let model: object | undefined = { id: "first" };
	const registry = { authStorage: {}, hasConfiguredAuth: () => true };
	let modelReads = 0;
	let registryReads = 0;
	const context = Object.create({
		get model() { modelReads++; return model; },
		get modelRegistry() { registryReads++; return registry; },
	});
	const binding = resolveNativeBinding(context);
	model = { id: "second" };
	assert.deepEqual(binding.model, { id: "first" });
	assert.equal(binding.modelRegistry, registry);
	assert.equal(modelReads, 1);
	assert.equal(registryReads, 1);
});

test("native binding distinguishes missing model, registry, and auth storage", () => {
	assert.throws(() => resolveNativeBinding({ modelRegistry: { authStorage: {}, hasConfiguredAuth: () => true } }), /No active OMP model/);
	assert.throws(() => resolveNativeBinding({ model: {} }), /OMP model registry unavailable/);
	assert.throws(() => resolveNativeBinding({ model: {}, modelRegistry: { authStorage: null, hasConfiguredAuth: () => true } }), /no auth storage/);
	assert.throws(() => resolveNativeBinding({ model: {}, modelRegistry: { authStorage: {} } }), /hasConfiguredAuth unavailable/);
	assert.throws(() => resolveNativeBinding({ model: {}, modelRegistry: { authStorage: {}, hasConfiguredAuth: () => false } }), /No configured authentication/);
});

test("repository file tools return bounded byte ranges and truthful directory continuation", async () => {
	const root = await mkdtemp(join(tmpdir(), "factory-native-pages-"));
	try {
		await writeFile(join(root, "large.txt"), "0123456789");
		for (let i = 0; i < 4; i++) await writeFile(join(root, `entry-${i}`), "x");
		let tools: Tool[] = [];
		const sdk = fake(async (registered) => { tools = registered; });
		await runNative(sdk.sdk, schema, { model: {}, modelRegistry: { authStorage: {}, hasConfiguredAuth: () => true } }, item(root), root, "worker", new AbortController().signal, () => {}, () => {});
		const read = tools.find((tool) => tool.name === "factory_read")!;
		const first = JSON.parse((await read.execute("id", { path: "large.txt", offset: 0, limit: 4 }) as { content: { text: string }[] }).content[0].text);
		assert.equal(first.text, "0123");
		assert.equal(first.nextOffset, 4);
		assert.equal(first.eof, false);
		const second = JSON.parse((await read.execute("id", { path: "large.txt", offset: 4, limit: 20 }) as { content: { text: string }[] }).content[0].text);
		assert.equal(second.text, "456789");
		assert.equal(second.nextOffset, null);
		assert.equal(second.eof, true);
		const files = tools.find((tool) => tool.name === "factory_files")!;
		const page = JSON.parse((await files.execute("id", { path: ".", offset: 0, limit: 2 }) as { content: { text: string }[] }).content[0].text);
		assert.equal(page.entries.length, 2);
		assert.equal(page.nextOffset, 2);
		const last = JSON.parse((await files.execute("id", { path: ".", offset: page.nextOffset, limit: 2 }) as { content: { text: string }[] }).content[0].text);
		assert.equal(last.entries.length, 2);
		assert.equal(last.nextOffset, 4);
		const final = JSON.parse((await files.execute("id", { path: ".", offset: last.nextOffset, limit: 2 }) as { content: { text: string }[] }).content[0].text);
		assert.equal(final.entries.length, 1);
		assert.equal(final.nextOffset, null);
	} finally { await rm(root, { recursive: true, force: true }); }
});

test("evidence handles are attempt-scoped, digest-checked, and ranged", async () => {
	const root = await mkdtemp(join(tmpdir(), "factory-native-evidence-"));
	try {
		const path = join(root, "failed-check.txt");
		const bytes = Buffer.from("prefix-failure-sentinel-suffix");
		await writeFile(path, bytes);
		const { createHash } = await import("node:crypto");
		const artifact = { id: "failure-1", path, digest: createHash("sha256").update(bytes).digest("hex"), bytes: bytes.length, attemptId: "attempt-1" };
		let tools: Tool[] = [];
		let prompt = "";
		const sdk = fake(async (registered) => { tools = registered; }, true, (text) => { prompt = text; });
		await runNative(sdk.sdk, schema, { model: {}, modelRegistry: { authStorage: {}, hasConfiguredAuth: () => true } }, item(root), root, "worker", new AbortController().signal, () => {}, () => {}, "", { attemptId: "attempt-2", repairFeedback: "repair the failed assertion", artifacts: [artifact] });
		assert.match(prompt, /repair the failed assertion/);
		assert.match(prompt, /failure-1/);
		assert.doesNotMatch(prompt, new RegExp(path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
		const evidenceRead = tools.find((tool) => tool.name === "factory_evidence_read")!;
		const result = JSON.parse((await evidenceRead.execute("id", { id: "failure-1", offset: 7, limit: 7 }) as { content: { text: string }[] }).content[0].text);
		assert.equal(result.text, "failure");
		assert.equal(result.offset, 7);
		assert.equal(result.nextOffset, 14);
		await writeFile(path, "changed");
		await assert.rejects(() => evidenceRead.execute("id", { id: "failure-1", offset: 0, limit: 4 }), /evidence changed or unavailable/);
	} finally { await rm(root, { recursive: true, force: true }); }
});

test("missing worker report has a typed correctable protocol failure", async () => {
	const root = await mkdtemp(join(tmpdir(), "factory-native-report-"));
	try {
		const sdk = fake(async () => {}, false, () => {});
		await assert.rejects(
			() => runNative(sdk.sdk, schema, { model: {}, modelRegistry: { authStorage: {}, hasConfiguredAuth: () => true } }, item(root), root, "worker", new AbortController().signal, () => {}, () => {}),
			(error: unknown) => error instanceof Error && "code" in error && error.code === "report-missing",
		);
	} finally { await rm(root, { recursive: true, force: true }); }
});

test("a second factory report cannot overwrite the authoritative first submission", async () => {
	const root = await mkdtemp(join(tmpdir(), "factory-native-report-once-"));
	try {
		let reportTool: Tool | undefined;
		const listeners = new Set<(event: { type: string }) => void>();
		const session = {
			sessionFile: "native.log",
			subscribe(listener: (event: { type: string }) => void) { listeners.add(listener); return () => listeners.delete(listener); },
			abort: async () => {},
			dispose: async () => {},
			async prompt() {
				for (const listener of listeners) listener({ type: "turn_start" });
				const first = { report: "first", tests: ["true"], accepted: true, semanticOutcome: "none", predicates: [{ item: "first", ok: true, note: "first" }], publicationBlocker: "" };
				const second = { ...first, report: "second", predicates: [{ item: "second", ok: false, note: "second" }] };
				await reportTool!.execute("one", first);
				await assert.rejects(() => reportTool!.execute("two", second), /already submitted/);
			},
		};
		const sdk = { Settings: { isolated: () => ({}) }, SessionManager: { create: () => ({}) }, AgentRegistry: class {}, async createAgentSession(options: { customTools?: Tool[] }) { reportTool = options.customTools!.find((tool) => tool.name === "factory_report"); return { session }; } } as unknown as NativeSDK;
		const result = await runNative(sdk, schema, { model: {}, modelRegistry: { authStorage: {}, hasConfiguredAuth: () => true } }, item(root), root, "worker", new AbortController().signal, () => {}, () => {});
		assert.equal(result.report, "first");
	} finally { await rm(root, { recursive: true, force: true }); }
});

test("sandbox preflight distinguishes a missing tool from an absent sandbox without running repository commands", async () => {
	const root = await mkdtemp(join(tmpdir(), "factory-native-preflight-"));
	try {
		await assert.rejects(() => sandboxPreflight(root, ["tool; unexpected-command"], new AbortController().signal), /invalid required executable name/);
		try {
			const result = await sandboxPreflight(root, ["definitely-not-a-real-factory-tool"], new AbortController().signal);
			assert.deepEqual(result.missing, ["definitely-not-a-real-factory-tool"]);
			assert.ok(result.available.includes("bash"));
		} catch (error) {
			// Hermetic CI does not install bwrap; require the precise missing-boundary diagnostic.
			assert.ok(error instanceof Error && "code" in error && error.code === "capability-unavailable");
			assert.match(error.message, /spawn bwrap ENOENT/);
		}
	} finally { await rm(root, { recursive: true, force: true }); }
});

test("failed native abort still disposes and never certifies cancellation settlement", async () => {
 const root = await mkdtemp(join(tmpdir(), "factory-native-abort-fail-"));
 try {
  const controller = new AbortController();let disposed = false;
  const session = { sessionFile: "native.log", subscribe: () => () => {}, async prompt() { controller.abort(); }, async abort() { throw new Error("abort transport failed"); }, async dispose() { disposed = true; } };
  const sdk = { Settings: { isolated: () => ({}) }, SessionManager: { create: () => ({}) }, AgentRegistry: class {}, createAgentSession: async () => ({session}) } as unknown as NativeSDK;
  await assert.rejects(() => runNative(sdk, schema, {model: {}, modelRegistry: {authStorage: {}, hasConfiguredAuth: () => true}}, item(root), root, "worker", controller.signal, () => {}, () => {}), /abort transport failed/);
  assert.equal(disposed, true, "dispose remains required when abort fails");
 } finally { await rm(root, {recursive: true, force: true}); }
});
