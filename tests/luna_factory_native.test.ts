import assert from "node:assert/strict";
import test from "node:test";
import { link, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runNative, sandboxTest, type NativeSDK, type SchemaBuilder } from "../image/extension/luna-factory/omp/batch-native.ts";

const schema: SchemaBuilder = { object: (x: Record<string, unknown>) => x, string: () => ({}), array: (x: unknown) => x, boolean: () => ({}) };
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
	const sdk: NativeSDK = { Settings: { isolated: (x: Record<string, unknown>) => x }, SessionManager: { create: () => ({}) }, AgentRegistry: class {}, createAgentSession: async (options) => { tools = options.customTools as Tool[]; await invoke(tools); return { session }; } };
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
			{ model: {}, modelRegistry: { authStorage: {} } },
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
				{ model: {}, modelRegistry: { authStorage: {} } },
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
				{ model: {}, modelRegistry: { authStorage: {} } },
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
