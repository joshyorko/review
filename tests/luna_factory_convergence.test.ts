import assert from "node:assert/strict";
import test from "node:test";
import { emptyLedger, type CriterionId, type RunId } from "../image/extension/luna-factory/core/model.ts";
import { reduce } from "../image/extension/luna-factory/core/reducer.ts";
import { criterionProven } from "../image/extension/luna-factory/core/evidence.ts";
import { parseJournal, journalRecord } from "../image/extension/luna-factory/core/journal.ts";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { BatchService } from "../image/extension/luna-factory/omp/batch-service.ts";
import { BatchGitHub } from "../image/extension/luna-factory/omp/batch-github.ts";
import { type SelectedItem } from "../image/extension/luna-factory/core/batch.ts";
import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { digest } from "../image/extension/luna-factory/core/batch.ts";
import { projectBatch } from "../image/extension/luna-factory/ui/projection.ts";
import { createLunaFactoryExtension } from "../image/extension/luna-factory/index.ts";
import { registerFactorySelection } from "../image/extension/luna-factory/omp/batch-bridge.ts";

const subject = { repo: "example/repo", base: "a".repeat(40), head: "b".repeat(40) };
const source = { kind: "github-pull-request" as const, identity: "PR_example_1", predicate: "merged-upstream" as const };
const initial = () => emptyLedger("run-observed" as RunId, {
	statement: "Observe the declared PR outcome", nonGoals: ["implementation", "merge"], permittedEffects: ["read"],
	finishAuthority: "observed outcome", appetite: { tasks: 1, attemptsPerTask: 1 },
}, [{ id: "A1" as CriterionId, statement: "The explicitly named PR is merged", mandatory: true, observation: source,
	assumptions: [{ kind: "acceptance-revision" as const, value: "acceptance-1" }] }], subject);
const observed = (ledger: ReturnType<typeof initial>, status: "proven" | "unproved" | "unknown" = "proven") => ({
	criterionId: "A1" as CriterionId, generation: ledger.generation, subject: ledger.subject, source,
	revision: ledger.subject.head!, status, note: "Authoritative exact-head PR state", assumptions: ledger.criteria[0]!.assumptions ?? [],
});
const record = (ledger: ReturnType<typeof initial>, status: "proven" | "unproved" | "unknown" = "proven") => {
	const result = reduce(ledger, { kind: "record_observation", expectedRevision: ledger.revision, observation: observed(ledger, status) } as never, { artifactRoots: [] });
	assert.ok(result?.ok, "trusted mechanical observation is a revision-checked canonical ledger transition");
	if (!result?.ok) throw new Error("observation was refused");
	return result.ledger;
};

test("mechanical proof reaches current acceptance with no candidate, attempt or worker", () => {
	const ledger = record(initial());
	assert.equal(criterionProven(ledger, "A1" as CriterionId), true);
	assert.deepEqual(ledger.tasks, []);
	const restored = parseJournal(journalRecord(ledger));
	assert.ok(restored.ok);
	if (restored.ok) { assert.equal(criterionProven(restored.ledger, "A1" as CriterionId), true); assert.deepEqual(restored.ledger.tasks, []); }
});

test("negative and UNKNOWN re-observation suppress older positive mechanical proof", () => {
	for (const status of ["unproved", "unknown"] as const) {
		const proven = record(initial());
		const latest = record(proven, status);
		assert.equal(criterionProven(latest, "A1" as CriterionId), false);
		assert.equal(criterionProven(proven, "A1" as CriterionId), true);
	}
});

test("observed proof becomes stale only when its exact subject or declared assumptions move", () => {
	const ledger = record(initial());
	assert.equal(criterionProven({ ...ledger, subject: { ...subject, head: "c".repeat(40) } }, "A1" as CriterionId), false);
	assert.equal(criterionProven({ ...ledger, criteria: ledger.criteria.map((criterion) => ({ ...criterion, assumptions: [{ kind: "acceptance-revision" as const, value: "acceptance-2" }] })) }, "A1" as CriterionId), false);
	assert.equal(criterionProven({ ...ledger, replans: 1 }, "A1" as CriterionId), true);
});

test("observation refuses undeclared source and preserves unsupported retained evidence", () => {
	const ledger = initial();
	const result = reduce(ledger, { kind: "record_observation", expectedRevision: ledger.revision, observation: { ...observed(ledger), source: { ...source, identity: "PR_foreign" } } } as never, { artifactRoots: [] });
	assert.equal(result?.ok, false);
	const unreadable = parseJournal({ ...journalRecord(ledger) as object, observations: [{ ...observed(ledger), status: "invented" }] });
	assert.equal(unreadable.ok, false);
});

test("explicit non-default target is resolved through the GitHub observation seam", async () => {
	const paths: string[] = [];
	const github = new BatchGitHub("fixture", (async (url: string | URL | Request) => {
		paths.push(String(url));
		return { ok: true, json: async () => String(url).endsWith("graphql") ? { data: { repository: {
			id: "R_repo", nameWithOwner: "example/repo", defaultBranchRef: { name: "main", target: { oid: "a".repeat(40) } },
			issueOrPullRequest: { id: "I_1", __typename: "Issue", title: "Explicit acceptance", body: "Keep the target", closed: false, url: "https://github.com/example/repo/issues/1", labels: { nodes: [], pageInfo: { hasNextPage: false } } },
		} } } : { object: { sha: "c".repeat(40) } } };
	}) as typeof fetch);
	const captured = await github.snapshot({ key: "example/repo#1", repo: "example/repo", number: 1, kind: "issue", action: "patch", targetRef: "self-hosted", overlaps: [] } as SelectedItem);
	assert.equal(captured.baseRef, "self-hosted");
	assert.equal(captured.base, "c".repeat(40));
	assert.equal(captured.head, "c".repeat(40));
	assert.ok(paths.some((path) => path.endsWith("git/ref/heads/self-hosted")));
});

test("selected mechanical convergence completes and re-observes without SDK or mutation claims", async () => {
	const root = await mkdtemp(join(tmpdir(), "factory-observed-convergence-"));
	let merged = true;
	const selected: SelectedItem = { key: "example/repo#1", repo: "example/repo", number: 1, kind: "pr", action: "inspect", overlaps: [], repositoryId: "R_repo", itemId: source.identity, acceptanceRevision: "acceptance-1", base: subject.base, head: subject.head, baseRef: "self-hosted", observe: "merged-upstream" };
	const github = { snapshot: async () => selected, assertFresh: async () => {}, observeGraph: async () => ({ generation: "G1", relations: [], nodes: [{ key: selected.key, generation: "G1", subject, acceptanceRevision: selected.acceptanceRevision, required: true, target: "merged-upstream", state: merged ? "DONE" : "QUEUED", proof: merged ? "merged-upstream" : undefined, proofCurrent: merged }] }) };
	const service = new BatchService(root, github as never, undefined, {} as never, 2, join(root, "claims"));
	try {
		const batch = await service.submit([selected], { capacity: 2, maxAttempts: 1, maxTotalAttempts: 1, mode: "retain", converge: true } as never);
		await service.resume(batch.id, {}); await service.waitForIdle();
		const proven = service.store.read(batch.id);
		assert.equal(proven.items[0]!.stage, "DONE");
		assert.equal(proven.items[0]!.attempts, 0);
		assert.deepEqual(proven.items[0]!.ledger.tasks, []);
		assert.equal(proven.usage.modelCalls, 0);
		assert.equal(proven.usage.peakWorkers, 0);
		assert.deepEqual(service.claims.list(), []);
		assert.match(service.status(batch.id), /observed.*merged-upstream/i);
		merged = false;
		await service.reconcile(batch.id);
		assert.notEqual(service.store.read(batch.id).items[0]!.stage, "DONE");
		assert.match(service.status(batch.id), /AUTONOMOUSLY_QUIESCENT/);
	} finally { await service.shutdown(); await rm(root, { recursive: true, force: true }); }
});

test("one selected graph drives real native sessions, verification and bounded repair without follow-up", async () => {
	const root = await mkdtemp(join(tmpdir(), "factory-convergence-vertical-"));
	const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-c", "user.name=Fixture", "-c", "user.email=fixture@localhost", ...args], { cwd, encoding: "utf8" }).trim();
	const seed = join(root, "seed"); mkdirSync(join(seed, "tests"), { recursive: true });
	writeFileSync(join(seed, "value.txt"), "0\n");
	writeFileSync(join(seed, "tests/acceptance.sh"), 'test "$(cat value.txt)" = 1\n');
	git(seed, "init", "-q"); git(seed, "add", "."); git(seed, "commit", "-qm", "fixed repair fixture");
	const sha = git(seed, "rev-parse", "HEAD");
	const items: SelectedItem[] = ["a", "b", "c", "held"].map((repo, index) => ({ key: `example/${repo}#${index + 1}`, repo: `example/${repo}`, number: index + 1, kind: "issue", action: "patch", overlaps: [], itemId: `I_${index}`, repositoryId: `R_${repo}`, acceptance: "Set value to one and pass the original executable check", acceptanceRevision: "acceptance-1", head: sha, base: sha, baseRef: "self-hosted", targetRef: "self-hosted", requiredChecks: ["bash ./tests/acceptance.sh"] }));
	const starts: string[] = [], prompts: string[] = [];
	let heldUnavailable = true;
	const workerCounts = new Map<string, number>();
	let sessions = 0;
	const schema = { object: () => ({}), string: () => ({}), array: () => ({}), number: () => ({}), boolean: () => ({}) };
	type Tool = { name: string; execute(id: string, args: unknown): Promise<{ content: { text: string }[] }> };
	const sdk = { Settings: { isolated: () => ({}) }, SessionManager: { create: () => ({}) }, AgentRegistry: class {}, async createAgentSession(options: { customTools: Tool[] }) {
		const file = join(root, `native-${++sessions}.jsonl`); writeFileSync(file, "native fixture session\n");
		const listeners = new Set<(event: { type: string }) => void>();
		return { session: { sessionFile: file, subscribe(fn: (event: { type: string }) => void) { listeners.add(fn); return () => listeners.delete(fn); }, async abort() {}, async dispose() {}, async prompt(prompt: string) {
			for (const listener of listeners) listener({ type: "turn_start" });
			const key = /Item: ([^\n]+)/.exec(prompt)?.[1]!;
			const worker = prompt.startsWith("Implement/inspect");
			let accepted = true;
			if (worker) {
				starts.push(key); prompts.push(prompt);
				const count = (workerCounts.get(key) ?? 0) + 1; workerCounts.set(key, count);
				const value = key === items[0]!.key && count === 1 ? "0\n" : "1\n";
				await options.customTools.find((tool) => tool.name === "factory_write")!.execute("write", { path: "value.txt", content: value });
			} else {
				for (const match of prompt.matchAll(/- (evidence-\d+) \[attempt/g)) {
					let offset = 0;
					for (;;) {
						const result = await options.customTools.find((tool) => tool.name === "factory_evidence_read")!.execute("read", { id: match[1], offset, limit: 16384 });
						const chunk = JSON.parse(result.content[0]!.text);
						if (chunk.text.includes("exit: 1")) accepted = false;
						if (chunk.eof) break; offset = chunk.nextOffset;
					}
				}
			}
			await options.customTools.find((tool) => tool.name === "factory_report")!.execute("report", { report: accepted ? "Original acceptance verified" : "Original executable check failed; repair value", tests: [], accepted, semanticOutcome: "none", predicates: [{ item: "Original acceptance", ok: accepted, note: accepted ? "Observed complete artifacts" : "Actual exit 1" }], publicationBlocker: "" });
		} } };
	} };
	const github = { snapshot: async (item: SelectedItem) => item, assertFresh: async () => {}, observeGraph: async () => ({ generation: "G1", nodes: items.map((item) => ({ key: item.key, generation: "G1", required: true, target: "verified-patch", acceptanceRevision: item.acceptanceRevision, subject: { repo: item.repo, base: sha, head: sha }, state: item.repo.endsWith("/held") && heldUnavailable ? "UNKNOWN" : "QUEUED", blocker: item.repo.endsWith("/held") && heldUnavailable ? "authoritative held fixture is unavailable; restore its source" : undefined })), relations: [{ from: items[1]!.key, to: items[0]!.key, kind: "requires", authority: "authoritative", source: "captured native dependency", stage: "verified-patch" }] }) };
	const service = new BatchService(root, github as never, sdk as never, schema as never, 2, join(root, "claims"));
	try {
		const batch = await service.submit(items, { capacity: 2, maxAttempts: 3, maxTotalAttempts: 8, mode: "retain", converge: true });
		for (const item of batch.items) {
			const workspace = join(root, "workspaces", batch.id, digest(item.selected.key).slice(0, 16));
			mkdirSync(join(root, "workspaces", batch.id), { recursive: true });
			execFileSync("git", ["clone", "--quiet", seed, workspace]); git(workspace, "remote", "set-url", "origin", `https://github.com/${item.selected.repo}`);
			item.workspace = workspace; item.preparation = { phase: "ready", owner: `${batch.id}:${item.selected.key}`, head: sha };
		}
		service.store.write(batch);
		await service.resume(batch.id, { model: { provider: "fixture", id: "fixture" }, modelRegistry: { authStorage: {}, hasConfiguredAuth: () => true } } as never);
		await service.waitForIdle();
		const final = service.store.read(batch.id);
		assert.deepEqual(final.items.slice(0, 3).map((item) => item.stage), ["DONE", "DONE", "DONE"]);
		assert.equal(final.items[0]!.attempts, 2);
		assert.equal(final.items[1]!.attempts, 1);
		assert.ok(starts.indexOf(items[1]!.key) > starts.lastIndexOf(items[0]!.key));
		assert.equal(workerCounts.has(items[3]!.key), false);
		assert.equal(final.usage.peakWorkers, 2);
		assert.match(prompts.find((prompt) => prompt.includes("Current attempt: T1-a2"))!, /failed|fail|exit/i);
		assert.ok(final.items[0]!.proof!.artifacts.some((path) => readFileSync(path, "utf8").includes("exit: 0")));
		assert.match(service.status(batch.id), /AUTONOMOUSLY_QUIESCENT/);
		assert.ok(final.items[1]!.ledger.tasks[0]!.attempts[0]!.receipt!.assumptions?.some((assumption) => assumption.kind === "dependency-outcome"), "dependent proof declares its canonical load-bearing graph assumption");
		assert.equal(projectBatch(final).items.find((item) => item.key === items[3]!.key)?.stage, "UNKNOWN");
		heldUnavailable = false;
		await service.reconcile(batch.id); await service.waitForIdle();
		assert.match(service.status(batch.id), /CONVERGED/);
		assert.equal(service.store.read(batch.id).items.length, 4);
	} finally { await service.shutdown(); await rm(root, { recursive: true, force: true }); }
});

test("headless and selected Review commands enter the same explicit convergence contract", async () => {
	const root = await mkdtemp(join(tmpdir(), "factory-convergence-command-"));
	const originalFetch = globalThis.fetch;
	const selected: SelectedItem = { key: "example/repo#1", repo: "example/repo", number: 1, kind: "pr", action: "inspect", overlaps: [], observe: "merged-upstream" };
	const notices: string[] = [];
	const commands = new Map<string, { handler(raw: string, context: unknown): Promise<void> }>();
	const shutdowns: Array<() => Promise<void>> = [];
	const fluent = new Proxy(() => fluent, { get: () => fluent, apply: () => fluent });
	const unregister = registerFactorySelection(() => [selected]);
	try {
		globalThis.fetch = (async () => ({ ok: true, json: async () => ({ data: { repository: {
			id: "R_repo", nameWithOwner: "example/repo", defaultBranchRef: { name: "self-hosted", target: { oid: subject.base } },
			issueOrPullRequest: { id: source.identity, __typename: "PullRequest", title: "Declared mechanical acceptance", body: "Observe only the named merge", closed: true, merged: true, url: "https://github.com/example/repo/pull/1", baseRefOid: subject.base, headRefOid: subject.head, baseRefName: "self-hosted", labels: { nodes: [], pageInfo: { hasNextPage: false } }, files: { nodes: [], pageInfo: { hasNextPage: false } }, closingIssuesReferences: { nodes: [], pageInfo: { hasNextPage: false } } },
		} } }) })) as typeof fetch;
		createLunaFactoryExtension({ zod: new Proxy({}, { get: () => fluent }), registerTool() {}, registerCommand(name: string, definition: { handler(raw: string, context: unknown): Promise<void> }) { commands.set(name, definition); }, appendEntry() {}, setLabel() {}, on(name: string, callback: () => Promise<void>) { if (name === "session_shutdown") shutdowns.push(callback); } } as never,
			{ env: { LUNA_FACTORY_ENABLED: "1", LUNA_FACTORY_STATE_ROOT: root, LUNA_FACTORY_CLAIMS_ROOT: join(root, "claims"), GH_TOKEN: "fixture-local-only" } });
		const command = commands.get("factory")!;
		const context = { hasUI: false, ui: { notify(message: string) { notices.push(message); } } };
		await command.handler(`run ${JSON.stringify({ items: [selected], converge: true })}`, context);
		assert.match(notices.at(-1)!, /CONVERGED/);
		assert.match(notices.at(-1)!, /Mechanically observed/);
		await command.handler("converge inspect", context);
		assert.match(notices.at(-1)!, /CONVERGED/);
		assert.match(notices.at(-1)!, /0 observed model calls/);
	} finally { for (const shutdown of shutdowns) await shutdown(); unregister(); globalThis.fetch = originalFetch; await rm(root, { recursive: true, force: true }); }
});
