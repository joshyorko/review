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

test("escaped repository and evidence pages fit the native model transport without false coverage", async () => {
	const root = await mkdtemp(join(tmpdir(), "factory-native-wire-pages-"));
	try {
		const bytes = Buffer.alloc(128 * 1024, 0);
		const path = join(root, "escaped.txt"); await writeFile(path, bytes);
		const { createHash } = await import("node:crypto");
		const artifact = { id: "escaped-1", path, digest: createHash("sha256").update(bytes).digest("hex"), bytes: bytes.length, attemptId: "attempt-1" };
		let tools: Tool[] = [];
		const sdk = fake(async (registered) => { tools = registered; });
		await runNative(sdk.sdk, schema, { model: {}, modelRegistry: { authStorage: {}, hasConfiguredAuth: () => true } }, item(root), root, "worker", new AbortController().signal, () => {}, () => {}, "", { attemptId: "attempt-2", artifacts: [artifact] });
		for (const name of ["factory_read", "factory_evidence_read"]) {
			const read = tools.find((tool) => tool.name === name)!;
			let offset = 0, total = 0;
			for (;;) {
				const result = await read.execute("read", { path: "escaped.txt", id: "escaped-1", offset, limit: 128 * 1024 }) as { content: { text: string }[] };
				const wire = result.content[0]!.text;
				assert.ok(Buffer.byteLength(wire) <= 32 * 1024, "complete serialized JSON fits below the pinned OMP spill threshold even with sixfold escaping");
				const chunk = JSON.parse(wire);
				total += chunk.readBytes ?? chunk.bytes;
				if (chunk.eof) break; offset = chunk.nextOffset;
			}
			assert.equal(total, bytes.length);
		}
	} finally { await rm(root, { recursive: true, force: true }); }
});

test("repository and evidence pages preserve UTF-8 characters across byte boundaries", async () => {
	const root = await mkdtemp(join(tmpdir(), "factory-native-utf8-pages-"));
	try {
		const { createHash } = await import("node:crypto");
		const cases = ["é", "€", "🦕"];
		const handles = [] as { id: string; path: string; digest: string; bytes: number; attemptId: string }[];
		for (let index = 0; index < cases.length; index++) {
			const path = join(root, `utf8-${index}.txt`);
			const bytes = Buffer.from(`${"a".repeat(4095)}${cases[index]}tail`);
			await writeFile(path, bytes);
			handles.push({ id: `utf8-${index}`, path, digest: createHash("sha256").update(bytes).digest("hex"), bytes: bytes.length, attemptId: "attempt-1" });
		}
		const bomPath = join(root, "bom.txt");
		const bomBytes = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("text")]);
		await writeFile(bomPath, bomBytes);
		handles.push({ id: "bom", path: bomPath, digest: createHash("sha256").update(bomBytes).digest("hex"), bytes: bomBytes.length, attemptId: "attempt-1" });
		let tools: Tool[] = [];
		const sdk = fake(async (registered) => { tools = registered; });
		await runNative(sdk.sdk, schema, { model: {}, modelRegistry: { authStorage: {}, hasConfiguredAuth: () => true } }, item(root), root, "worker", new AbortController().signal, () => {}, () => {}, "", { attemptId: "attempt-2", artifacts: handles });
		const repositoryRead = tools.find((tool) => tool.name === "factory_read")!;
		const evidenceRead = tools.find((tool) => tool.name === "factory_evidence_read")!;
		for (let index = 0; index < cases.length; index++) {
			const prefix = "a".repeat(4095) + cases[index];
			const expectedBytes = Buffer.byteLength(prefix);
			const repositoryPage = JSON.parse((await repositoryRead.execute("id", { path: `utf8-${index}.txt`, offset: 0, limit: 4096 }) as { content: { text: string }[] }).content[0].text);
			assert.equal(repositoryPage.text, prefix);
			assert.equal(repositoryPage.bytes, expectedBytes);
			assert.equal(repositoryPage.nextOffset, expectedBytes);
			assert.equal(repositoryPage.eof, false);
			const evidencePage = JSON.parse((await evidenceRead.execute("id", { id: `utf8-${index}`, offset: 0, limit: 4096 }) as { content: { text: string }[] }).content[0].text);
			assert.equal(evidencePage.text, prefix);
			assert.equal(evidencePage.readBytes, expectedBytes);
			assert.equal(evidencePage.nextOffset, expectedBytes);
			const smallLimit = JSON.parse((await repositoryRead.execute("id", { path: `utf8-${index}.txt`, offset: 4095, limit: 1 }) as { content: { text: string }[] }).content[0].text);
			assert.equal(smallLimit.text, cases[index]);
			assert.equal(smallLimit.bytes, Buffer.byteLength(cases[index]));
		}
		const bomPage = JSON.parse((await repositoryRead.execute("id", { path: "bom.txt", offset: 0, limit: 7 }) as { content: { text: string }[] }).content[0].text);
		assert.equal(bomPage.text, "\uFEFFtext");
		const evidenceBomPage = JSON.parse((await evidenceRead.execute("id", { id: "bom", offset: 0, limit: 7 }) as { content: { text: string }[] }).content[0].text);
		assert.equal(evidenceBomPage.text, "\uFEFFtext");
	} finally { await rm(root, { recursive: true, force: true }); }
});

test("native UTF-8 reads reject invalid bytes, incomplete EOF, and continuation-byte offsets", async () => {
	const root = await mkdtemp(join(tmpdir(), "factory-native-utf8-invalid-"));
	try {
		const { createHash } = await import("node:crypto");
		const inputs = [
			{ id: "invalid", bytes: Buffer.from([0x61, 0xff, 0x62]), offset: 0 },
			{ id: "incomplete", bytes: Buffer.from([0x61, 0xf0, 0x9f]), offset: 0 },
			{ id: "continuation", bytes: Buffer.from("🦕"), offset: 1 },
		];
		const handles = [] as { id: string; path: string; digest: string; bytes: number; attemptId: string }[];
		for (const input of inputs) {
			const path = join(root, `${input.id}.txt`);
			await writeFile(path, input.bytes);
			handles.push({ id: input.id, path, digest: createHash("sha256").update(input.bytes).digest("hex"), bytes: input.bytes.length, attemptId: "attempt-1" });
		}
		let tools: Tool[] = [];
		const sdk = fake(async (registered) => { tools = registered; });
		await runNative(sdk.sdk, schema, { model: {}, modelRegistry: { authStorage: {}, hasConfiguredAuth: () => true } }, item(root), root, "worker", new AbortController().signal, () => {}, () => {}, "", { attemptId: "attempt-2", artifacts: handles });
		const repositoryRead = tools.find((tool) => tool.name === "factory_read")!;
		const evidenceRead = tools.find((tool) => tool.name === "factory_evidence_read")!;
		for (const input of inputs) {
			await assert.rejects(() => repositoryRead.execute("id", { path: `${input.id}.txt`, offset: input.offset, limit: 2 }), /UTF-8 range is invalid/);
			await assert.rejects(() => evidenceRead.execute("id", { id: input.id, offset: input.offset, limit: 2 }), /UTF-8 range is invalid/);
		}
	} finally { await rm(root, { recursive: true, force: true }); }
});

test("admitted evidence identifiers cannot overwhelm complete native JSON pages", async () => {
	const root = await mkdtemp(join(tmpdir(), "factory-native-evidence-identities-"));
	try {
		const { createHash } = await import("node:crypto");
		const path = join(root, "proof.txt"); const bytes = Buffer.from("proof"); await writeFile(path, bytes);
		const handle = { id: "evidence-0", attemptId: "attempt-1", path, bytes: bytes.length, digest: createHash("sha256").update(bytes).digest("hex") };
		for (const field of ["id", "attemptId"] as const) {
			let creations = 0;
			const sdk = fake(async () => { creations++; });
			await assert.rejects(() => runNative(sdk.sdk, schema, { model: {}, modelRegistry: { authStorage: {}, hasConfiguredAuth: () => true } }, item(root), root, "worker", new AbortController().signal, () => {}, () => {}, "", { attemptId: "attempt-2", artifacts: [{ ...handle, [field]: "x".repeat(32768) }] }), /invalid.*handle|identity|bounded/i);
			assert.equal(creations, 0);
		}
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

test("bounded escalation activates native Advisor on the same worker session and resumes the same attempt once", async () => {
	const root = await mkdtemp(join(tmpdir(), "factory-native-advisor-"));
	try {
		const events: string[] = [];
		const prompts: string[] = [];
		const listeners = new Set<(event: { type: string }) => void>();
		const model = { provider: "configured-provider", id: "configured-advisor" };
		let enabled = false;
		let assistantMessages = 0;
		let tools: Tool[] = [];
		const report = { report: "resumed after native advice", tests: ["true"], accepted: true, semanticOutcome: "none", predicates: [{ item: "same attempt", ok: true, note: "worker resumed" }], publicationBlocker: "" };
		const session = {
			sessionFile: "same-worker-session.jsonl",
			subscribe(listener: (event: { type: string }) => void) { listeners.add(listener); return () => listeners.delete(listener); },
			abort: async () => {},
			dispose: async () => {},
			setAdvisorEnabled(value: boolean) { enabled = value; events.push(value ? "advisor-on" : "advisor-off"); return value; },
			isAdvisorEnabled: () => enabled,
			isAdvisorActive: () => enabled,
			async waitForAdvisorCatchup() { events.push("advisor-catchup"); assistantMessages++; return true; },
			getAdvisorStats() {
				return {
					configured: enabled,
					active: enabled,
					model: enabled ? model : undefined,
					contextWindow: 100_000,
					contextTokens: 100,
					tokens: { input: assistantMessages * 20, output: assistantMessages * 10, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: assistantMessages * 30 },
					cost: assistantMessages * 0.02,
					messages: { user: assistantMessages, assistant: assistantMessages, total: assistantMessages * 2 },
					advisors: enabled ? [{ name: "Configured", status: "running", model, contextWindow: 100_000, contextTokens: 100, tokens: { input: assistantMessages * 20, output: assistantMessages * 10, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: assistantMessages * 30 }, cost: assistantMessages * 0.02, messages: { user: assistantMessages, assistant: assistantMessages, total: assistantMessages * 2 } }] : [],
				};
			},
			formatAdvisorStatus: () => "Advisor active on configured-provider/configured-advisor",
			formatAdvisorHistoryAsText: () => "Native advisory: compare the two supplied alternatives against the exact acceptance.",
			async prompt(text: string) {
				prompts.push(text);
				events.push(text.startsWith("Resume") ? "worker-resume" : text.startsWith("Factory judgment") ? "advisor-packet" : "worker-start");
				for (const listener of listeners) listener({ type: "turn_start" });
				if (prompts.length === 1) {
					const tool = tools.find((candidate) => candidate.name === "factory_escalate")!;
					await tool.execute("escalate", { judgment: "Which compatibility strategy preserves the contract?", reason: "The evidence supports two incompatible outcomes.", evidence: ["existing callers require stable output"], alternatives: ["preserve output", "replace output"] });
				} else if (prompts.length === 3) {
					const escalation = tools.find((candidate) => candidate.name === "factory_escalate")!;
					await assert.rejects(() => escalation.execute("again", { judgment: "second", reason: "second", evidence: ["second"] }), /already used its one native Advisor escalation/);
					await tools.find((candidate) => candidate.name === "factory_report")!.execute("report", report);
				}
			},
		};
		const sdk = {
			Settings: { isolated: (value: Record<string, unknown>) => value },
			SessionManager: { create: () => ({}) },
			AgentRegistry: class {},
			async createAgentSession(options: { customTools?: Tool[] }) { tools = options.customTools ?? []; return { session }; },
		} as unknown as NativeSDK;
		const result = await runNative(
			sdk,
			schema,
			{ model: { provider: "worker-provider", id: "worker-model" }, modelRegistry: { authStorage: {}, hasConfiguredAuth: () => true } },
			item(root),
			root,
			"worker",
			new AbortController().signal,
			() => {},
			() => {},
			"",
			{
				attemptId: "T1-a1",
				escalationIdentity: { taskId: "T1", itemKey: "example/repo#1", attemptId: "T1-a1", generation: "G1", subject: { repo: "example/repo", base: "base-sha", head: "head-sha" }, acceptanceRevision: "acceptance-v1", acceptance: "preserve stable output" },
			},
		);
		assert.equal(prompts.length, 3);
		assert.equal(result.session, "same-worker-session.jsonl");
		assert.equal(result.calls, 3);
		assert.equal(result.report, "resumed after native advice");
		assert.deepEqual(events.filter((event) => event === "advisor-on" || event === "advisor-off"), ["advisor-on", "advisor-off"]);
		assert.ok(events.indexOf("advisor-on") < events.indexOf("advisor-packet"));
		assert.ok(events.indexOf("advisor-catchup") < events.indexOf("advisor-off"));
		assert.ok(events.indexOf("advisor-off") < events.indexOf("worker-resume"));
		assert.match(prompts[1], /acceptanceSha256/);
		assert.match(prompts[1], /Which compatibility strategy/);
		assert.deepEqual(result.advisor?.effectiveModels, ["configured-provider/configured-advisor"]);
		assert.match(result.advisor?.history ?? "", /Native advisory:/);
		assert.equal(result.advisor?.usage.calls, 1);
		assert.equal(enabled, false);
	} finally { await rm(root, { recursive: true, force: true }); }
});

test("native Advisor resolution and catch-up failures block the existing attempt without worker fallback", async () => {
	for (const failure of ["no-advisor-model", "catchup"] as const) {
		const root = await mkdtemp(join(tmpdir(), `factory-native-advisor-${failure}-`));
		try {
			const events: string[] = [];
			const prompts: string[] = [];
			const listeners = new Set<(event: { type: string }) => void>();
			const configuredModel = { provider: "configured-provider", id: "configured-advisor" };
			const resolves = failure !== "no-advisor-model";
			let enabled = false;
			let tools: Tool[] = [];
			let escalations = 0;
			const session = {
				sessionFile: "blocked-worker-session.jsonl",
				subscribe(listener: (event: { type: string }) => void) { listeners.add(listener); return () => listeners.delete(listener); },
				abort: async () => {},
				dispose: async () => {},
				setAdvisorEnabled(value: boolean) { enabled = value; events.push(value ? "advisor-on" : "advisor-off"); return value && resolves; },
				isAdvisorEnabled: () => enabled,
				isAdvisorActive: () => enabled && resolves,
				async waitForAdvisorCatchup() { events.push("advisor-catchup"); return false; },
				getAdvisorStats() {
					return {
						configured: enabled,
						active: enabled && resolves,
						model: enabled && resolves ? configuredModel : undefined,
						contextWindow: 0, contextTokens: 0,
						tokens: { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
						cost: 0,
						messages: { user: 0, assistant: 0, total: 0 },
						advisors: enabled && resolves ? [{ name: "Configured", status: "running", model: configuredModel, contextWindow: 100_000, contextTokens: 0, tokens: { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 0 }, cost: 0, messages: { user: 0, assistant: 0, total: 0 } }] : [],
					};
				},
				formatAdvisorStatus: () => enabled && resolves ? "Advisor active" : "Advisor model unavailable",
				formatAdvisorHistoryAsText: () => null,
				async prompt(text: string) {
					prompts.push(text);
					for (const listener of listeners) listener({ type: "turn_start" });
					if (prompts.length === 1) {
						escalations++;
						await tools.find((tool) => tool.name === "factory_escalate")!.execute("escalate", { judgment: "resolve incompatible behavior", reason: "evidence conflicts", evidence: ["existing output contract"], alternatives: ["keep", "replace"] });
					}
				},
			};
			const sdk = {
				Settings: { isolated: (value: Record<string, unknown>) => value },
				SessionManager: { create: () => ({}) },
				AgentRegistry: class {},
				async createAgentSession(options: { customTools?: Tool[] }) { tools = options.customTools ?? []; return { session }; },
			} as unknown as NativeSDK;
			await assert.rejects(
				() => runNative(
					sdk,
					schema,
					{ model: { provider: "worker-provider", id: "worker-model" }, modelRegistry: { authStorage: {}, hasConfiguredAuth: () => true } },
					item(root),
					root,
					"worker",
					new AbortController().signal,
					() => {},
					() => {},
					"",
					{ attemptId: "T1-a1", escalationIdentity: { taskId: "T1", itemKey: "r/1", attemptId: "T1-a1", generation: "G1", subject: { repo: "r", base: "base", head: "head" }, acceptanceRevision: "acceptance-v1", acceptance: "original acceptance" } },
				),
				(error: unknown) => error instanceof Error && "code" in error && error.code === "advisor-blocked",
			);
			assert.equal(escalations, 1);
			assert.equal(enabled, false, "Advisor is disabled after the failed escalation");
			assert.ok(events.includes("advisor-off"));
			assert.equal(prompts.some((prompt) => prompt.startsWith("Resume")), false, "blocked escalation never resumes with a worker-model substitute");
			assert.equal(prompts.length, failure === "catchup" ? 2 : 1);
		} finally { await rm(root, { recursive: true, force: true }); }
	}
});
