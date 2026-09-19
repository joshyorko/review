import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { BatchService } from "./batch-service.ts";
import { digest, type Batch, type SelectedItem } from "../core/batch.ts";
import type { NativeSDK, SchemaBuilder } from "./batch-native.ts";

const SHA = "a".repeat(40);
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

interface ProbeOptions { readonly root: string; readonly phase: "seed" | "resume" }

function selectedItems(): SelectedItem[] {
	return Array.from({ length: 10 }, (_, index) => {
		const repoIndex = Math.floor(index / 2) + 1;
		const itemIndex = (index % 2) + 1;
		const key = `probe/repo${repoIndex}#${itemIndex}`;
		return {
			key,
			repo: `probe/repo${repoIndex}`,
			number: itemIndex,
			kind: "issue",
			action: "inspect",
			acceptanceRevision: "probe-r1",
			acceptance: `Deterministic acceptance for ${key}`,
			base: SHA,
			head: SHA,
			overlaps: [],
		} satisfies SelectedItem;
	});
}

function fakeGitHub() {
	return {
		token: "probe-token",
		async snapshot(item: SelectedItem): Promise<SelectedItem> { return { ...item }; },
		async assertFresh(item: SelectedItem): Promise<void> { if (item.key === "probe/repo5#2") throw new Error("deterministic unavailable item"); },
		async request<T>(_path: string, _body?: unknown): Promise<T> { throw new Error("unexpected external GitHub request in packaged probe"); },
	};
}

function fakeSchema(): SchemaBuilder {
	const value = () => value;
	return { object: value, string: value, array: value, boolean: value } as unknown as SchemaBuilder;
}

function fakeSdk(root: string): NativeSDK {
	let serial = 0;
	let active = 0;
	return {
		Settings: { isolated: () => ({}) },
		SessionManager: { create: () => ({}) },
		AgentRegistry: class {},
		async createAgentSession(options: Record<string, any>) {
			const tools = options.customTools as Array<{ name: string; execute(id: string, args: any): Promise<unknown> }>;
			const report = tools.find((tool) => tool.name === "factory_report");
			if (!report) throw new Error("probe worker report tool missing");
			const sessionFile = join(root, "sessions", `probe-${++serial}.json`);
			mkdirSync(join(root, "sessions"), { recursive: true, mode: 0o700 });
			writeFileSync(sessionFile, "packaged deterministic worker session\n", { flag: "wx", mode: 0o600 });
			const listeners = new Set<(event: { type: string }) => void>();
			const session = {
				sessionFile,
				subscribe(listener: (event: { type: string }) => void) { listeners.add(listener); return () => listeners.delete(listener); },
				async prompt(prompt: string) {
					listeners.forEach((listener) => listener({ type: "turn_start" }));
					active += 1;
					await sleep(40);
					if (!prompt.includes("probe/repo4#2")) {
						await report.execute("probe-report", { report: `deterministic evidence for ${prompt.match(/Item: ([^\\n]+)/)?.[1] ?? "item"}`, tests: [], accepted: true });
					}
					active -= 1;
				},
				async abort() {},
				async dispose() {},
			};
			return { session };
		},
	} as unknown as NativeSDK;
}

function git(cwd: string, ...args: string[]): string {
	return execFileSync("git", ["-c", "user.name=Factory Probe", "-c", "user.email=probe@localhost", ...args], { cwd, encoding: "utf8" }).trim();
}

function prepareWorkspaces(root: string, batch: Batch): void {
	for (const item of batch.items) {
		if (item.stage === "BLOCKED") continue;
		const directory = join(root, "workspaces", batch.id, digest(item.selected.key).slice(0, 16));
		mkdirSync(directory, { recursive: true, mode: 0o700 });
		git(directory, "init", "--quiet");
		writeFileSync(join(directory, "README.probe"), `${item.selected.key}\n`);
		git(directory, "add", "README.probe");
		git(directory, "commit", "--quiet", "-m", "probe");
		const head = git(directory, "rev-parse", "HEAD");
		git(directory, "remote", "add", "origin", `https://github.com/${item.selected.repo}`);
		item.workspace = directory;
		item.selected.base = head;
		item.selected.head = head;
		item.ledger.subject = { repo: item.selected.repo, base: head, head };
	}
}

export async function runPackagedBatchProbe({ root, phase }: ProbeOptions): Promise<Record<string, unknown>> {
	const github = fakeGitHub();
	const service = new BatchService(root, github as never, fakeSdk(root), fakeSchema(), 2);
	const options = { capacity: 2, maxAttempts: 2, maxTotalAttempts: 20, mode: "retain" as const, dependencies: [{ item: "probe/repo5#1", requires: "probe/repo1#1", stage: "verified-patch" as const }] };
	if (phase === "seed") {
		const selected = selectedItems();
		const first = await service.submit(selected, options);
		const duplicate = await service.submit(selected, options);
		first.control = "paused";
		service.store.write(first);
		await service.shutdown();
		return { phase, batchId: first.id, tracked: first.items.length, duplicateAttached: duplicate.id === first.id, control: first.control };
	}
	const batches = service.store.list();
	if (batches.length !== 1) throw new Error(`expected one persisted batch after restart, found ${batches.length}`);
	const batch = batches[0]!;
	service.store.acquire();
	const persisted = service.store.read(batch.id);
	prepareWorkspaces(root, persisted);
	service.store.write(persisted);
	service.store.release();
	await service.resume(batch.id, { model: {}, modelRegistry: { authStorage: {} } });
	await service.waitForIdle();
	const final = service.store.read(batch.id);
	const done = final.items.filter((item) => item.stage === "DONE");
	const blocked = final.items.filter((item) => item.stage === "BLOCKED");
	const dependent = final.items.find((item) => item.selected.key === "probe/repo5#1")!;
	const failed = final.items.find((item) => item.selected.key === "probe/repo4#2")!;
	const unavailable = final.items.find((item) => item.selected.key === "probe/repo5#2")!;
	const repositories = new Set(final.items.map((item) => item.selected.repo));
	if (
		final.items.length !== 10 ||
		repositories.size !== 5 ||
		final.capacity !== 2 ||
		final.usage.peakWorkers !== 2 ||
		done.length !== 8 ||
		blocked.length !== 2 ||
		dependent.stage !== "DONE" ||
		failed.stage !== "BLOCKED" ||
		unavailable.stage !== "BLOCKED" ||
		final.items.some((item) => item.operation?.phase === "push" || item.operation?.phase === "pr") ||
		final.control !== "active"
	) throw new Error("packaged BatchService invariant failed");
	await service.shutdown();
	return {
		phase,
		batchId: final.id,
		tracked: final.items.length,
		repositories: repositories.size,
		capacity: final.capacity,
		peakWorkers: final.usage.peakWorkers,
		done: done.length,
		blocked: blocked.length,
		dependencyDone: dependent.stage === "DONE",
		failedItemStage: failed.stage,
		unavailableItemStage: unavailable.stage,
		converged: false,
		noExternalAuthority: final.items.every((item) => item.operation?.phase !== "push" && item.operation?.phase !== "pr"),
	};
}
