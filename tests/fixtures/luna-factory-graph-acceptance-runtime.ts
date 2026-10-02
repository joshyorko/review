import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { factoryCommand } from "../../image/extension/luna-factory/omp/batch-bridge.ts";
import { selected } from "./luna-factory-graph-acceptance-support.mjs";

type Item = (typeof selected)[number];
type FetchRecord = { url: string; repo?: string; number?: number; outcome?: string };

function response(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

export default function graphAcceptanceRuntime(pi: ExtensionAPI) {
	pi.on("session_start", (_event, context) => {
		void (async () => {
		const root = process.env.GRAPH130_ROOT;
		if (!root) throw new Error("GRAPH130_ROOT is required");
		const mark = (name: string, value = "ok") => writeFileSync(join(root, `progress-${name}`), `${value}\n`);
		const state = join(root, "state"); const claims = join(root, "claims");
		mkdirSync(state, { recursive: true }); mkdirSync(claims, { recursive: true });
		const originalFetch = globalThis.fetch;
		const calls = new Map<string, number>(); const audit: FetchRecord[] = [];
		const sha = readFileSync(join(root, "subject.sha"), "utf8").trim();
		globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
			const url = String(input); const path = new URL(url).pathname;
			if (url.startsWith("http://127.0.0.1:")) return originalFetch(input, init);
			if (!url.startsWith("https://api.github.com/")) throw new Error(`unexpected network destination in graph acceptance: ${new URL(url).host}`);
			if (path === "/graphql") {
				const variables = JSON.parse(String(init?.body ?? "{}")).variables as { owner: string; name: string; number: number };
				const repo = `${variables.owner}/${variables.name}`; const number = variables.number; const key = `${repo}#${number}`;
				const count = (calls.get(key) ?? 0) + 1; calls.set(key, count);
				if (key === "example/observed#1" && process.env.GRAPH130_UNKNOWN === "1") {
					audit.push({ url, repo, number, outcome: "unknown-after-explicit-reobservation" });
					writeFileSync(join(root, "github-audit.json"), JSON.stringify(audit, null, 2));
					return response({ message: "captured authoritative observation temporarily unavailable" }, 503);
				}
				const isPull = repo === "example/observed";
				const item = isPull ? {
					id: "PR_observed_1", __typename: "PullRequest", title: "Observe an already merged exact PR", body: "Mechanical proof only", closed: true, merged: true,
					url: "https://github.com/example/observed/pull/1", baseRefOid: sha, headRefOid: sha, baseRefName: "main",
					labels: { nodes: [], pageInfo: { hasNextPage: false } }, files: { nodes: [], pageInfo: { hasNextPage: false } },
					closingIssuesReferences: { nodes: [], pageInfo: { hasNextPage: false } },
				} : {
					id: `I_${repo.replace("/", "_")}_${number}`, __typename: "Issue", title: `Set value to one for ${key}`, body: "Set value.txt to one and pass tests/acceptance.sh", closed: false,
					url: `https://github.com/${repo}/issues/${number}`, labels: { nodes: [], pageInfo: { hasNextPage: false } },
					timelineItems: { nodes: [], pageInfo: { hasNextPage: false } },
				};
				audit.push({ url, repo, number, outcome: isPull ? `merged-observation-${count}` : "captured-open-item" });
				writeFileSync(join(root, "github-audit.json"), JSON.stringify(audit, null, 2));
				return response({ data: { repository: { id: `R_${variables.owner}_${variables.name}`, nameWithOwner: repo, defaultBranchRef: { name: "main", target: { oid: sha } }, issueOrPullRequest: item } } });
			}
			const dependency = /^\/repos\/([^/]+\/[^/]+)\/issues\/(\d+)\/dependencies\/blocked_by$/.exec(path);
			if (dependency) {
				const [, repo, rawNumber] = dependency; const number = Number(rawNumber);
				const entries: Array<{ number: number; repository_url: string }> = [];
				audit.push({ url, repo, number, outcome: "captured-empty-GitHub-blocked-by-list; selected verified-patch dependency is authoritative" });
				writeFileSync(join(root, "github-audit.json"), JSON.stringify(audit, null, 2));
				return response(entries);
			}
			if (/\/sub_issues$/.test(path)) return response([]);
			if (/\/git\/ref\/heads\/main$/.test(path)) return response({ object: { sha } });
			throw new Error(`unhandled captured GitHub observation ${path}`);
		}) as typeof fetch;
		try {
			const items = selected as unknown as Item[];
			const contextForCommand = { hasUI: true, model: context.model, modelRegistry: context.modelRegistry, ui: { notify() {} } };
			const first = await factoryCommand(`run ${JSON.stringify({ items, converge: true, capacity: 2, maxAttempts: 2, maxTotalAttempts: 7, mode: "retain", dependencies: [{ item: "example/a#2", requires: "example/a#1", stage: "verified-patch" }] })}`, contextForCommand);
			mark("submitted-main", first.slice(0, 120));
			assert.match(first, /READY example\/a#1, example\/b#1/, "the original captured graph exposes the independent READY pair");
			const id = /Factory (batch-[a-f0-9-]+)/.exec(first)?.[1];
			assert.ok(id, "shipped /factory run command returns its durable batch identity");
			writeFileSync(join(root, "batch-id"), `${id}\n`);

			const batchFile = join(state, `${id}.json`);
			const waitFor = async (predicate: (batch: any) => boolean, label: string, batchId = id) => {
				const deadline = Date.now() + 75_000;
				while (Date.now() < deadline) {
					const path = join(state, `${batchId}.json`);
					const batch = JSON.parse(readFileSync(path, "utf8"));
					if (predicate(batch)) return batch;
					await new Promise((resolve) => setTimeout(resolve, 100));
				}
				throw new Error(`timed out waiting for ${label}`);
			};
			const active = await waitFor((batch) => batch.items.some((item: any) => item.selected.key === "example/a#1" && item.stage === "RUNNING"), "first selected worker to own example/a");
			mark("first-writer-active", active.id);
			const competing: Item = { key: "example/a#99", repo: "example/a", number: 99, kind: "issue", action: "patch", overlaps: [], requiredChecks: ["bash ./tests/acceptance.sh"], targetRef: "main" };
			const competingText = await factoryCommand(`run ${JSON.stringify({ items: [competing], capacity: 2, maxAttempts: 1, maxTotalAttempts: 1, mode: "retain" })}`, contextForCommand);
			mark("competing-submitted", competingText.slice(0, 120));
			const competingId = /Factory (batch-[a-f0-9-]+)/.exec(competingText)?.[1];
			assert.ok(competingId, "same-repository control is a separate explicit batch");
			const competingQueued = JSON.parse(readFileSync(join(state, `${competingId}.json`), "utf8"));
			assert.equal(competingQueued.items[0].stage, "QUEUED", "same-repository writer waits while another selected item owns the repository");
			assert.equal(competingQueued.items[0].attempts, 0); assert.deepEqual(competingQueued.items[0].sessions, []);
			mark("competing-serialized", competingId);
			writeFileSync(join(root, "release-a"), "same-repository contention proved\n");

			const dependentRunning = await waitFor((batch) => batch.items.some((item: any) => item.selected.key === "example/a#2" && item.stage === "RUNNING"), "true prerequisite to release the dependent lane");
			mark("dependent-running", dependentRunning.id);
			assert.ok(dependentRunning.items.find((item: any) => item.selected.key === "example/a#1")?.proof, "dependent begins only after prerequisite proof is current");
			process.env.GRAPH130_UNKNOWN = "1";
			await factoryCommand(`reconcile ${id}`, contextForCommand);
			mark("unknown-reconciled", id);
			writeFileSync(join(root, "unknown-reobserved"), "yes\n");
			writeFileSync(join(root, "release-c"), "re-observation complete\n");
			const settled = await waitFor((batch) => batch.items.filter((item: any) => ["DONE", "UNKNOWN", "BLOCKED"].includes(item.stage)).length === 4, "all selected graph lanes to settle");
			const competingSettled = await waitFor((batch) => batch.items[0]?.stage === "VERIFY" && batch.items[0]?.proof !== undefined, "queued same-repository writer after the selected graph settles", competingId);
			assert.equal(competingSettled.items[0].attempts, 1);
			assert.equal(competingSettled.items[0].proof?.stage, "verified-patch");
			const inspected = await factoryCommand(`inspect ${id}`, contextForCommand);
			const final = JSON.parse(readFileSync(batchFile, "utf8"));
			const byKey = new Map(final.items.map((item: any) => [item.selected.key, item]));
			const a = byKey.get("example/a#1") as any; const b = byKey.get("example/b#1") as any; const c = byKey.get("example/a#2") as any; const d = byKey.get("example/observed#1") as any;
			assert.equal(a.stage, "DONE"); assert.equal(a.attempts, 2, "the original failed first attempt and bounded repair are retained");
			assert.equal(b.stage, "DONE"); assert.equal(b.attempts, 1);
			assert.equal(c.stage, "DONE"); assert.equal(c.attempts, 1);
			assert.equal(final.items.length, 4, "the graph stays within its explicit four-item selection");
			assert.equal(final.capacity, 2); assert.equal(final.usage.peakWorkers, 2, "independent different-repository READY work uses the existing capacity bound");
			assert.equal(d.stage, "UNKNOWN"); assert.equal(d.attempts, 0); assert.equal(d.sessions.length, 0); assert.deepEqual(d.ledger.tasks, []);
			assert.ok(final.usage.modelCalls > 0, "worker and independent acceptance calls use the existing OMP model accounting");
			const observed = d.ledger.observations ?? [];
			assert.ok(observed.some((entry: any) => entry.status === "proven"), "the exact merged PR has an observed-only proof before the later UNKNOWN state");
			assert.equal(observed.at(-1)?.status, "unknown", "current state re-observation supersedes prior observed proof");
			assert.match(inspected, /AUTONOMOUSLY_QUIESCENT/); assert.match(inspected, /example\/observed#1.*UNKNOWN/);
			assert.match(inspected, /graph observation unknown|captured acceptance revision is missing or changed/i);
			assert.match(inspected, /observed model calls/);
			assert.equal(a.proof?.subject, a.selected.head); assert.equal(a.proof?.acceptanceRevision, a.selected.acceptanceRevision);
			assert.equal(c.proof?.subject, c.selected.head); assert.equal(c.ledger.criteria[0]?.assumptions?.some((entry: any) => entry.kind === "dependency-outcome" && entry.value === "proven"), true);
			assert.equal(a.ledger.tasks[0]?.attempts.at(-1)?.generation, a.ledger.generation); assert.equal(c.ledger.tasks[0]?.attempts.at(-1)?.generation, c.ledger.generation);
			for (const item of [a, b, c]) {
				const checks = item.proof.artifacts.map((path: string) => readFileSync(path, "utf8")).filter((text: string) => text.includes("command: bash ./tests/acceptance.sh"));
				assert.ok(checks.some((text: string) => /exit: 0/.test(text)), `${item.selected.key} retains the actual mandatory bwrap acceptance result`);
			}
			assert.equal(readFileSync(join(a.workspace, "value.txt"), "utf8"), "1\n", "the repaired mutation exists in the actual Git workspace");
			writeFileSync(join(root, "result.json"), JSON.stringify({ status: "passed", outcome: "AUTONOMOUSLY_QUIESCENT", blocker: "example/observed#1 exact merged-PR observation became UNKNOWN; restore authoritative GitHub access and reconcile", batchId: id, competingBatchId: competingId, selected: final.items.map((item: any) => ({ key: item.selected.key, stage: item.stage, attempts: item.attempts, subject: item.selected.head, acceptanceRevision: item.selected.acceptanceRevision })), capacity: final.capacity, peakWorkers: final.usage.peakWorkers, modelCalls: final.usage.modelCalls, observedProof: observed, sourceSnapshot: "captured local GitHub responses; not live GitHub evidence", actualGitAndVerifier: true, operatorFollowups: 0 }, null, 2));
			console.log(JSON.stringify({ status: "passed", batchId: id, outcome: "AUTONOMOUSLY_QUIESCENT", attempts: [a.attempts, b.attempts, c.attempts], peakWorkers: final.usage.peakWorkers, modelCalls: final.usage.modelCalls, operatorFollowups: 0 }));
		} finally { globalThis.fetch = originalFetch; }
		process.exit(0);
		})().catch((error) => {
			const message = error instanceof Error ? error.message : String(error);
			try { writeFileSync(join(process.env.GRAPH130_ROOT ?? "/tmp", "runtime-error.txt"), message); } catch {}
			console.error(message); process.exit(1);
		});
	});
}
