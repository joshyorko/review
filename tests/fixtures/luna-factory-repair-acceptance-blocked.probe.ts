import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { NativeSDK } from "../../image/extension/luna-factory/omp/batch-native.ts";
import { BatchService, binding, createBatch, currentItem, digest, readArtifacts, portableRepairFixture, report, runNative, schema, tool, toolText, withMissingBwrap } from "./luna-factory-repair-acceptance-support.ts";

type FixtureTool = { name: string; execute(id: string, args: unknown): Promise<unknown> };

test("a supplied repair handle from another admitted item cannot be read", async () => {
	const root = await mkdtemp(join(tmpdir(), "factory-repair-ownership-"));
	try {
		const head = "a".repeat(40);
		const batch = createBatch([1, 2].map((number) => ({
			key: `example/repo#${number}`, repo: "example/repo", number, kind: "issue" as const,
			action: "inspect" as const, overlaps: [], acceptance: "Inspect the exact admitted item.",
			acceptanceRevision: "shared-original-contract", base: head, head,
		})), { id: "batch-abcdef", capacity: 1, maxAttempts: 2, maxTotalAttempts: 4, mode: "retain" });
		const item = batch.items[0]!;
		item.workspace = join(root, "workspace");
		await mkdir(item.workspace);
		const foreignDirectory = join(root, "evidence", batch.id, digest("example/repo#2").slice(0, 16), "T1-a1");
		await mkdir(foreignDirectory, { recursive: true });
		const bytes = Buffer.from("FOREIGN_ITEM_UNRESOLVED_FAILURE");
		const path = join(foreignDirectory, "test-0.txt");
		await writeFile(path, bytes);
		const artifact = { id: "evidence-0", path, bytes: bytes.length, digest: createHash("sha256").update(bytes).digest("hex"), attemptId: "T1-a1" };
		const sdk = {
			Settings: { isolated: () => ({}) }, SessionManager: { create: () => ({}) }, AgentRegistry: class {},
			async createAgentSession(options: { customTools: FixtureTool[] }) {
				return { session: {
					sessionFile: join(root, "session.jsonl"), subscribe: () => () => {}, abort: async () => {}, dispose: async () => {},
					async prompt() {
						const read = options.customTools.find((tool) => tool.name === "factory_evidence_read");
						assert.ok(read);
						await read.execute("read", { id: "evidence-0", offset: 0, limit: 128 });
						await options.customTools.find((tool) => tool.name === "factory_report")!.execute("report", {
							report: "Evidence was readable.", tests: [], accepted: true, semanticOutcome: "no-finding",
							predicates: [{ item: "original acceptance", ok: true, note: "inspected" }], publicationBlocker: "",
						});
					},
				} };
			},
		} as unknown as NativeSDK;
		await assert.rejects(() => runNative(sdk, schema, {
			model: { provider: "fixture", id: "fixture" }, modelRegistry: { authStorage: {}, hasConfiguredAuth: () => true },
		} as never, item, root, "worker", new AbortController().signal, () => {}, () => {}, "", {
			attemptId: "T1-a2", repairFeedback: "Only the current item's prior failure is relevant.", artifacts: [artifact],
		}), /evidence.*(?:ownership|unavailable|attempt|item)|foreign/i);
	} finally { await rm(root, { recursive: true, force: true }); }
});

test("long hostile repository names keep directory pages below the native spill boundary", async () => {
	const fixture = portableRepairFixture(async (tools) => {
		const raw = toolText(await tool(tools, "factory_files").execute("files", { path: "hostile-names", offset: 0, limit: 100 }));
		assert.ok(Buffer.byteLength(raw, "utf8") <= 32_768, "an advertised directory page must reach the model as complete JSON, not a native head/tail spill");
		const page = JSON.parse(raw);
		assert.ok(page.entries.length > 0); assert.equal(page.eof, false); assert.ok(page.nextOffset > 0);
		await report(tools);
	});
	try {
		const directory = join(fixture.workspace, "hostile-names"); await mkdir(directory);
		for (let index = 0; index < 101; index += 1) await writeFile(join(directory, `${"\u001b".repeat(190)}-${index}`), "entry\n");
		await runNative(fixture.sdk, schema, binding, fixture.item, fixture.root, "worker", new AbortController().signal, () => {}, () => {});
	} finally { await fixture.cleanup(); }
});

test("UTF-8 continuation preserves the complete source at a multibyte page boundary", async () => {
	const expected = `${"a".repeat(4095)}🦕${"b".repeat(9000)}`;
	const fixture = portableRepairFixture(async (tools) => {
		let actual = ""; let offset = 0;
		for (;;) {
			const page = JSON.parse(toolText(await tool(tools, "factory_read").execute("read", { path: "unicode-source.txt", offset, limit: 131072 })));
			actual += page.text;
			if (page.eof) break;
			assert.ok(page.nextOffset > offset); offset = page.nextOffset;
		}
		assert.equal(actual, expected, "full page coverage must not replace valid source bytes with decoder replacement characters");
		await report(tools);
	});
	try {
		await writeFile(join(fixture.workspace, "unicode-source.txt"), expected);
		await runNative(fixture.sdk, schema, binding, fixture.item, fixture.root, "worker", new AbortController().signal, () => {}, () => {});
	} finally { await fixture.cleanup(); }
});

test("persist and reload quarantine a repair packet copied from another admitted item", async () => {
	let paused = false;
	let foreignFeedbackDelivered = false;
	let foreignArtifactDelivered = false;
	const fixture = portableRepairFixture(async (tools, prompt) => {
		const foreign = prompt.includes("Item: example/repo#2");
		if (prompt.startsWith("Implement/inspect")) {
			if (!foreign) {
				await tool(tools, "factory_write").execute("foreign-marker", { path: "foreign-note.txt", content: "FOREIGN_ITEM_ARTIFACT\n" });
			} else {
				foreignFeedbackDelivered ||= prompt.includes("FOREIGN_ITEM_REJECTION");
				if (tools.some((candidate) => candidate.name === "factory_evidence_read")) {
					const artifacts = await readArtifacts(tools, prompt);
					foreignArtifactDelivered ||= [...artifacts.values()].some((text) => text.includes("FOREIGN_ITEM_ARTIFACT"));
				}
				await tool(tools, "factory_write").execute("correct-value", { path: "value.txt", content: "1\n" });
			}
			await report(tools);
		} else {
			await readArtifacts(tools, prompt);
			await report(tools, foreign ? {} : { accepted: false, ok: false, text: "FOREIGN_ITEM_REJECTION: this failure belongs only to item one." });
		}
	}, { additionalItems: [2] });
	let resumed: InstanceType<typeof BatchService> | undefined;
	try {
		const remove = fixture.service.onChange(() => {
			const item = currentItem(fixture.service.store.read(fixture.batch.id));
			if (!paused && item.stage === "QUEUED" && item.attempts === 1 && item.repair) {
				paused = true; void fixture.service.control(fixture.batch.id, "pause");
			}
		});
		await fixture.service.resume(fixture.batch.id, binding); await fixture.service.waitForIdle(); remove();
		assert.equal(paused, true);
		fixture.service.exclude(fixture.batch.id, "example/repo#1", "The acceptance probe now exercises independently admitted item two.");
		const saved = fixture.service.store.read(fixture.batch.id);
		assert.equal(saved.items[1]!.attempts, 0);
		// Inject only a packet misbinding at the supported recovery-input boundary.
		// Neither native file tools nor repository code can write this state root.
		await fixture.service.shutdown();
		const recovered = fixture.service.store.read(fixture.batch.id);
		recovered.items[1]!.repair = structuredClone(recovered.items[0]!.repair);
		await writeFile(join(fixture.root, `${fixture.batch.id}.json`), `${JSON.stringify(recovered)}\n`);
		await withMissingBwrap(fixture.root, async () => {
			resumed = fixture.createService();
			try { await resumed.resume(fixture.batch.id, binding); await resumed.waitForIdle(); }
			catch (error) { assert.ok(error instanceof Error); assert.match(error.message, /repair|ownership|foreign|packet|artifact/i); }
		});
		assert.equal(foreignFeedbackDelivered, false, "reload must not bind another item's repair feedback to this worker");
		assert.equal(foreignArtifactDelivered, false, "reload must not expose another item's retained artifacts");
	} finally { if (resumed?.isWriterAcquired()) await resumed.shutdown(); await fixture.cleanup(); }
});

test("an empty worker verification command receives bounded repair without operator follow-up", async () => {
	let workers = 0;
	const repairPrompts: string[] = [];
	const fixture = portableRepairFixture(async (tools, prompt) => {
		if (prompt.startsWith("Implement/inspect")) {
			workers += 1; repairPrompts.push(prompt);
			await tool(tools, "factory_write").execute("write", { path: "value.txt", content: "1\n" });
			await report(tools, { tests: workers === 1 ? ["   "] : [] });
		} else {
			await readArtifacts(tools, prompt);
			await report(tools);
		}
	});
	try {
		await fixture.service.resume(fixture.batch.id, binding);
		await fixture.service.waitForIdle();
		const item = currentItem(fixture.service.store.read(fixture.batch.id));
		assert.equal(workers, 2, "correctable empty commands must not require an operator retry");
		assert.match(repairPrompts[1]!, /verification command|required|blank|empty/i);
		assert.equal(item.attempts, 2);
		assert.equal(item.ledger.tasks[0]!.attempts.length, 2);
		assert.deepEqual(item.selected.requiredChecks, ["bash ./tests/acceptance.sh"]);
		assert.equal(item.stage, "VERIFY", "a verified patch still needs explicit owner integration");
		assert.equal(item.proof?.stage, "verified-patch");
	} finally { await fixture.cleanup(); }
});

test("an independent transport failure after a rejected report cannot become a protocol retry", async () => {
	let workers = 0;
	const fixture = portableRepairFixture(async (tools, prompt) => {
		assert.ok(prompt.startsWith("Implement/inspect")); workers += 1;
		await assert.rejects(() => tool(tools, "factory_report").execute("invalid-report", {
			report: "A malformed report was handled by the SDK.", tests: [], accepted: "invalid", semanticOutcome: "none",
			predicates: [{ item: "original acceptance", ok: true, note: "observed" }], publicationBlocker: "",
		}), /accepted must be a boolean/);
		throw new Error("FIXTURE_TRANSPORT_RESET_AFTER_REJECTED_REPORT");
	});
	try {
		await fixture.service.resume(fixture.batch.id, binding); await fixture.service.waitForIdle();
		const item = currentItem(fixture.service.store.read(fixture.batch.id));
		assert.equal(workers, 1, "an independent transport failure must not spend repair attempts");
		assert.equal(item.attempts, 1); assert.equal(item.proof, undefined);
		assert.ok(item.stage === "UNKNOWN" || item.stage === "BLOCKED");
		assert.match(item.blocker!, /FIXTURE_TRANSPORT_RESET_AFTER_REJECTED_REPORT/);
	} finally { await fixture.cleanup(); }
});
