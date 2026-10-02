import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { Batch } from "../../image/extension/luna-factory/core/batch.ts";
import type { NativeSDK, SchemaBuilder } from "../../image/extension/luna-factory/omp/batch-native.ts";

const source = process.env.REVIEW_TEST_SOURCE ?? resolve(import.meta.dirname, "../..");
const factory = process.env.REVIEW_TEST_FACTORY_ROOT ?? join(source, "image/extension/luna-factory");
export const { createBatch, digest } = await import(join(factory, "core/batch.ts"));
export const { BatchService } = await import(join(factory, "omp/batch-service.ts"));
export const { runNative } = await import(join(factory, "omp/batch-native.ts"));

export type FixtureTool = { name: string; execute(id: string, args: unknown): Promise<unknown> };
export const schema = { object: (value: unknown) => value, string: () => ({}), number: () => ({}), array: (value: unknown) => value, boolean: () => ({}) } as unknown as SchemaBuilder;
export const binding = { model: { provider: "fixture", id: "fixture" }, modelRegistry: { authStorage: {}, hasConfiguredAuth: () => true } } as never;

export function tool(tools: readonly FixtureTool[], name: string): FixtureTool {
	const found = tools.find((candidate) => candidate.name === name);
	assert.ok(found, `required production tool ${name} was not registered`);
	return found;
}

export function toolText(value: unknown): string {
	assert.ok(value && typeof value === "object" && "content" in value && Array.isArray(value.content));
	const first = value.content[0];
	assert.ok(first && typeof first === "object" && "text" in first && typeof first.text === "string");
	return first.text;
}

export function fixtureSDK(root: string, respond: (tools: readonly FixtureTool[], prompt: string) => Promise<void>): NativeSDK {
	let serial = 0;
	return {
		Settings: { isolated: (overrides: unknown) => overrides }, SessionManager: { create: () => ({}) }, AgentRegistry: class {},
		async createAgentSession(options: { customTools: FixtureTool[] }) {
			const listeners = new Set<(event: { type: string }) => void>();
			const sessionFile = join(root, `fixture-session-${++serial}.jsonl`);
			writeFileSync(sessionFile, "deterministic provider fixture\n");
			return { session: {
				sessionFile,
				subscribe(listener: (event: { type: string }) => void) { listeners.add(listener); return () => listeners.delete(listener); },
				async prompt(prompt: string) { for (const listener of listeners) listener({ type: "turn_start" }); await respond(options.customTools, prompt); },
				abort: async () => {}, dispose: async () => {},
			} };
		},
	} as unknown as NativeSDK;
}

export async function report(tools: readonly FixtureTool[], options: { accepted?: boolean; tests?: string[]; text?: string; ok?: boolean } = {}): Promise<void> {
	await tool(tools, "factory_report").execute("report", {
		report: options.text ?? "Checked the unchanged original acceptance against retained evidence.",
		tests: options.tests ?? [], accepted: options.accepted ?? true, semanticOutcome: "none",
		predicates: [{ item: "original acceptance", ok: options.ok ?? true, note: options.text ?? "actual retained evidence inspected" }], publicationBlocker: "",
	});
}

export function repairFixture(respond: (tools: readonly FixtureTool[], prompt: string) => Promise<void>, options: { acceptanceScript?: string; maxAttempts?: number; root?: string; sdk?: NativeSDK; schema?: SchemaBuilder; additionalItems?: number[] } = {}) {
	const root = options.root ?? mkdtempSync(join(tmpdir(), "factory-repair-acceptance-"));
	mkdirSync(root, { recursive: true });
	const batch = createBatch([1, ...(options.additionalItems ?? [])].map((number) => ({
		key: `example/repo#${number}`, repo: "example/repo", number, kind: "issue" as const, action: "patch" as const, overlaps: [],
		acceptance: "The selected calculation returns one; retain the mandatory executable check.",
		acceptanceRevision: "original-r1", base: "a".repeat(40), head: "a".repeat(40),
		requiredChecks: ["bash ./tests/acceptance.sh"],
	})), { id: "batch-abcdef", capacity: 1, maxAttempts: options.maxAttempts ?? 3, maxTotalAttempts: options.maxAttempts ?? 3, mode: "retain" });
	const item = batch.items[0]!;
	const workspace = join(root, "workspaces", batch.id, digest(item.selected.key).slice(0, 16));
	mkdirSync(join(workspace, "tests"), { recursive: true });
	writeFileSync(join(workspace, "value.txt"), "0\n");
	writeFileSync(join(workspace, "tests", "acceptance.sh"), options.acceptanceScript ?? "#!/usr/bin/env bash\nset -euo pipefail\ntest \"$(cat value.txt)\" = 1\n");
	git(workspace, "init", "--quiet"); git(workspace, "add", "value.txt", "tests/acceptance.sh"); git(workspace, "commit", "--quiet", "-m", "fixture");
	git(workspace, "remote", "add", "origin", "https://github.com/example/repo");
	const head = git(workspace, "rev-parse", "HEAD");
	item.workspace = workspace; item.selected.head = head; item.selected.base = head;
	item.ledger.subject = { repo: "example/repo", head, base: head };
	for (const extra of batch.items.slice(1)) {
		const path = join(root, "workspaces", batch.id, digest(extra.selected.key).slice(0, 16));
		cpSync(workspace, path, { recursive: true });
		extra.workspace = path; extra.selected.head = head; extra.selected.base = head;
		extra.ledger.subject = { repo: "example/repo", head, base: head };
	}
	const github = { assertFresh: async () => {}, snapshot: async (selected: unknown) => selected } as never;
	const sdk = options.sdk ?? fixtureSDK(root, respond);
	const service = new BatchService(root, github, sdk, options.schema ?? schema, 1);
	service.store.acquire(); service.store.write(batch);
	return { root, workspace, batch, item, github, sdk, service, async cleanup() { if (service.isWriterAcquired()) await service.shutdown(); rmSync(root, { recursive: true, force: true }); } };
}

export function git(workspace: string, ...args: string[]): string {
	return execFileSync("git", ["-c", "user.name=Acceptance Fixture", "-c", "user.email=fixture@localhost", ...args], { cwd: workspace, encoding: "utf8" }).trim();
}

export async function readArtifacts(tools: readonly FixtureTool[], prompt: string): Promise<Map<string, string>> {
	const output = new Map<string, string>();
	const handleIds = [...prompt.matchAll(/^- (evidence-\d+) \[attempt /gm)].map((match) => match[1]!);
	for (const id of handleIds) {
		let offset = 0;
		let text = "";
		for (;;) {
			const value: unknown = JSON.parse(toolText(await tool(tools, "factory_evidence_read").execute("read", { id, offset, limit: 128 * 1024 })));
			assert.ok(value && typeof value === "object" && "text" in value && typeof value.text === "string" && "nextOffset" in value);
			text += value.text;
			if (value.nextOffset === null) break;
			assert.ok(typeof value.nextOffset === "number"); offset = value.nextOffset;
		}
		output.set(id, text);
	}
	return output;
}

export function currentItem(batch: Batch) { const item = batch.items[0]; assert.ok(item); return item; }
