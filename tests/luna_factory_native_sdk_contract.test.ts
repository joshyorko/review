import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runNative, type NativeSDK, type SchemaBuilder } from "../image/extension/luna-factory/omp/batch-native.ts";

const schema = {
	object: (value: Record<string, unknown>) => value,
	string: () => ({}),
	number: () => ({}),
	array: (value: unknown) => value,
	boolean: () => ({}),
} as unknown as SchemaBuilder;

function item(workspace: string) {
	return {
		workspace,
		selected: {
			key: "example/repo#1",
			repo: "example/repo",
			number: 1,
			kind: "issue",
			action: "patch",
			overlaps: [],
			acceptance: "write the smallest safe patch",
		},
		sessions: [],
		attempts: 0,
		stage: "QUEUED",
		ledger: {},
	} as never;
}

type Tool = {
	name: string;
	execute(id: string, args: Record<string, unknown>): Promise<unknown>;
};

class PrivateAgentRegistry {}

function sdkContract(capture: (options: Record<string, unknown>) => void): NativeSDK {
	const sdk = {
		Settings: {
			isolated(settings: Record<string, unknown>) {
				if ("memory.enabled" in settings) throw new Error('Unknown setting "memory.enabled"');
				return settings;
			},
		},
		SessionManager: { create: () => ({}) },
		AgentRegistry: PrivateAgentRegistry,
		async createAgentSession(options: Record<string, unknown>) {
			capture(options);
			const tools = options.customTools as Tool[];
			const report = tools.find((tool) => tool.name === "factory_report");
			if (!report) throw new Error("factory_report was not registered through the SDK contract");
			const listeners = new Set<(event: { type: string }) => void>();
			return {
				session: {
					sessionFile: "native.log",
					subscribe(listener: (event: { type: string }) => void) {
						listeners.add(listener);
						return () => listeners.delete(listener);
					},
					async prompt() {
						for (const listener of listeners) listener({ type: "turn_start" });
						await report.execute("report", {
							report: "observed",
							tests: ["true"],
							accepted: true,
							semanticOutcome: "none",
							predicates: [{ item: "native SDK contract", ok: true, note: "reported" }],
							publicationBlocker: "",
						});
					},
					abort: async () => {},
					dispose: async () => {},
				},
			};
		},
	};
	return sdk as unknown as NativeSDK;
}

test("native adapter uses the OMP 18.3.2 restricted custom-tool contract", async () => {
	const workspace = await mkdtemp(join(tmpdir(), "factory-native-sdk-"));
	try {
		let captured: Record<string, unknown> | undefined;
		const sdk = sdkContract((options) => { captured = options; });
		await runNative(
			sdk,
			schema,
			{ model: {}, modelRegistry: { authStorage: {}, hasConfiguredAuth: () => true } },
			item(workspace),
			workspace,
			"worker",
			new AbortController().signal,
			() => {},
			() => {},
		);

		assert.ok(captured);
		assert.ok(captured.agentRegistry instanceof PrivateAgentRegistry);
		assert.equal(captured.restrictToolNames, true);
		assert.equal(captured.allowRestrictedCustomTools, true);
		assert.equal(captured.enableMCP, false);
		assert.equal(captured.enableLsp, false);
		assert.equal(captured.enableIrc, false);
		assert.deepEqual(captured.toolNames, ["factory_read", "factory_files", "factory_report", "factory_write"]);
		const tools = captured.customTools as Tool[];
		assert.deepEqual(tools.map((tool) => tool.name), captured.toolNames);
		assert.ok(tools.every((tool) => typeof tool.execute === "function"));
		assert.equal(tools.some((tool) => ["bash", "task", "web_search", "github", "browser"].includes(tool.name)), false);
	} finally {
		await rm(workspace, { recursive: true, force: true });
	}
});
