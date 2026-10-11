import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";

const FAILURE = "DISTINCTIVE_OWNED_PR_HOSTED_FAILURE";

function git(root: string, ...args: string[]): string {
	return execFileSync("git", ["-c", "user.name=Luna Factory Acceptance", "-c", "user.email=fixture@localhost", ...args], { cwd: root, encoding: "utf8" }).trim();
}

async function waitFor(predicate: () => boolean, label: string, timeoutMs = 45_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (predicate()) return;
		await new Promise((resolveWait) => setTimeout(resolveWait, 20));
	}
	throw new Error(`timed out waiting for ${label}`);
}

async function run(pi: ExtensionAPI, context: Parameters<Parameters<ExtensionAPI["on"]>[1]>[1]): Promise<void> {
	const root = process.env.OWNED_PR_ROOT;
	if (!root) throw new Error("OWNED_PR_ROOT is required");
	const production = process.env.REVIEW_TEST_FACTORY_ROOT ?? resolve(join(import.meta.dirname, "../../image/extension/luna-factory"));
	const [{ BatchService }, { batchConverged, batchItemProofCurrent, createBatch, digest }] = await Promise.all([
		import(join(production, "omp/batch-service.ts")),
		import(join(production, "core/batch.ts")),
	]);
	const now = { value: new Date("2026-10-06T12:00:00.000Z") };
	const repo = "example/a";
	const independentRepo = "example/b";
	const base = readFileSync(join(root, "subject.sha"), "utf8").trim();
	const branchName = (batchId: string, number: number) => `factory/${batchId}/${number}`;
	const bare = join(root, "repos", "a.git");
	const independentBare = join(root, "repos", "b.git");
	const remoteHead = (): string => git(root, "--git-dir", bare, "rev-parse", `refs/heads/${branchName(batch.id, 1)}`);
	const items = [
		{
			key: `${repo}#1`, repo, number: 1, kind: "issue" as const, action: "pr-ready" as const, overlaps: [],
			acceptance: "Set value.txt to one, keep the original executable check passing, then repair the scripted hosted CI failure on this same owned PR.",
			acceptanceRevision: "owned-pr-r1", base, head: base, baseRef: "main", targetRef: "main", requiredChecks: ["bash ./tests/acceptance.sh"],
		},
		{
			key: `${independentRepo}#2`, repo: independentRepo, number: 2, kind: "issue" as const, action: "inspect" as const, overlaps: [],
			acceptance: "Inspect the captured independent repository and report whether the selected files expose a finding.",
			acceptanceRevision: "independent-r1", base, head: base,
		},
	];
	const batch = createBatch(items, { id: "batch-1770a11", capacity: 1, maxAttempts: 2, maxTotalAttempts: 3, mode: "retain" });
	for (const item of batch.items) {
		const owner = `${batch.id}:${item.selected.key}`;
		item.workspace = join(root, "state", "workspaces", batch.id, digest(item.selected.key).slice(0, 16));
		item.preparation = { phase: "ready", owner, head: item.selected.head! };
	}
	const pendingSeen = join(root, "pending-check-seen");
	let hostedPolls = 0;
	let prCreates = 0;
	let pushes = 0;
	let mergeRequests = 0;
	let resumeCalls = 0;
	let initialPrHead: string | undefined;
	let pr: { id: number; node_id: string; number: number; html_url: string; state: string; merged: boolean; draft: boolean; head: { sha: string; ref: string; repo: { full_name: string } }; base: { sha: string; ref: string; repo: { full_name: string } }; body: string } | undefined;
	const policy = [{ context: "CI", appId: 42, source: "classic" as const }];
	const fingerprint = digest(JSON.stringify(policy));
	const github = {
		token: "scripted-github-boundary",
		async snapshot<T>(selected: T): Promise<T> { return selected; },
		async assertFresh(_selected: unknown, pull?: { identity?: string; headSha: string }): Promise<void> {
			if (pull && (!pr || pr.node_id !== pull.identity || pr.head.sha !== pull.headSha || remoteHead() !== pull.headSha)) throw new Error("scripted owned PR changed during acceptance");
		},
		async hostedCheckPolicyCurrent(_repo: string, _baseRef: string, _defaultBranch: string | undefined, current: string): Promise<boolean> { return current === fingerprint; },
		async observeHostedChecks(_repo: string, pull: { headSha: string }, observedAt: string) {
			hostedPolls++;
			const baseObservation = {
				observedAt, headSha: pull.headSha, eligibleSubject: { sha: pull.headSha, subject: "head" as const }, policyFingerprint: fingerprint, policy,
			};
			if (hostedPolls === 1) {
				writeFileSync(pendingSeen, "pending required CI observed\n");
				return { ...baseObservation, runs: [{ id: 501, suiteId: 5, appId: 42, appSlug: null, name: "CI", headSha: pull.headSha, status: "in_progress", conclusion: null, createdAt: observedAt, startedAt: observedAt, subject: "head" as const }], coverage: "complete" as const, result: "pending" as const };
			}
			if (hostedPolls === 2) {
				assert.equal(pr?.head.sha, pull.headSha, "the concrete code failure belongs to the first PR head");
				initialPrHead = pull.headSha;
				const failure = {
					key: digest(`owned-pr-failure:${pull.headSha}`), candidateHead: pull.headSha, checkSubjectSha: pull.headSha, classification: "repairable-code" as const,
					checkRun: { id: 501, suiteId: 5, name: "CI", appId: 42, conclusion: "failure" as const, title: "Typecheck failed", summary: "A source-bound scripted compiler failure", text: `src/runtime.ts:10: error TS2322 ${FAILURE}`, outputTruncated: false },
					annotations: [{ path: "src/runtime.ts", startLine: 10, endLine: 10, level: "failure", title: "Typecheck", message: FAILURE }], annotationsComplete: true,
				};
				return { ...baseObservation, runs: [{ id: 501, suiteId: 5, appId: 42, appSlug: null, name: "CI", headSha: pull.headSha, status: "completed", conclusion: "failure", createdAt: observedAt, startedAt: observedAt, subject: "head" as const }], coverage: "complete" as const, result: "failed" as const, failures: [failure], reason: "captured required CI failed on a source location" };
			}
			assert.notEqual(pull.headSha, batch.items[0]!.selected.head, "repair must publish a new exact head");
			return { ...baseObservation, runs: [{ id: 503, suiteId: 6, appId: 42, appSlug: null, name: "CI", headSha: pull.headSha, status: "completed", conclusion: "success", createdAt: observedAt, startedAt: observedAt, subject: "head" as const }], coverage: "complete" as const, result: "passed" as const };
		},
		async request(path: string, body?: unknown): Promise<unknown> {
			if (path.includes("/merges")) { mergeRequests++; throw new Error("merge endpoint is forbidden in this qualification"); }
			if (path.includes("/git/ref/heads/")) return { object: { sha: remoteHead() } };
			if (path.includes("/pulls?state=all")) {
				if (!pr) return [];
				pr = { ...pr, head: { ...pr.head, sha: remoteHead() } };
				return [{ ...pr, merged_at: null }];
			}
			if (path.endsWith("/pulls") && body && typeof body === "object") {
				prCreates++;
				if (prCreates !== 1) throw new Error("same-PR repair must not create a second PR");
				const request = body as { head: string; base: string; body: string };
				pr = {
					id: 177, node_id: "PR_node_177", number: 1, html_url: `https://github.com/${repo}/pull/1`, state: "open", merged: false, draft: false,
					head: { sha: remoteHead(), ref: request.head, repo: { full_name: repo } }, base: { sha: base, ref: request.base, repo: { full_name: repo } }, body: request.body,
				};
				return pr;
			}
			throw new Error(`unexpected scripted GitHub request ${path}`);
		},
	};
	const timing = {
		now: () => now.value,
		async wait(milliseconds: number, signal?: AbortSignal): Promise<void> {
			await waitFor(() => signal?.aborted === true || batch.items[1]?.stage === "DONE", "independent inspection to complete during hosted CI wait");
			if (signal?.aborted) return;
			now.value = new Date(now.value.getTime() + milliseconds);
			writeFileSync(join(root, "independent-progress-during-wait"), "complete\n");
		},
	};
	const service = new BatchService(join(root, "state"), github as never, pi.pi, pi.zod, 1, join(root, "claims"), undefined, undefined, timing);
	const realGit = service.git.bind(service);
	service.git = async (workspace: string, args: string[], signal?: AbortSignal) => {
		if (args[0] === "fetch" && args[1] === "origin") {
			if (signal?.aborted) throw new Error("scripted local bare fetch was cancelled");
			return execFileSync("git", ["-C", workspace, "-c", "protocol.file.allow=always", "fetch", bare, args[2]!], { encoding: "utf8" }).trimEnd();
		}
		return realGit(workspace, args, signal);
	};
	service.pushOwnedBranch = async (workspace: string, branch: string, signal: AbortSignal) => {
		if (signal.aborted || branch !== branchName(batch.id, 1)) throw new Error("invalid scripted owned-branch push");
		execFileSync("git", ["-C", workspace, "push", bare, `HEAD:refs/heads/${branch}`], { encoding: "utf8" });
		pushes++;
	};
	service.store.acquire(); service.store.write(batch); service.store.release();
	resumeCalls++;
	await service.resume(batch.id, { model: context.model, modelRegistry: context.modelRegistry });
	await service.waitForIdle();
	const final = service.store.read(batch.id);
	const owned = final.items.find((item: any) => item.selected.key === `${repo}#1`)!;
	const independent = final.items.find((item: any) => item.selected.key === `${independentRepo}#2`)!;
	const attempt = owned.ledger.tasks[0]?.attempts.at(-1);
	const repairAuthorizationHead = owned.ledger.tasks[0]?.attempts[0]?.currentVerification?.subject.head;
	assert.equal(owned.stage, "DONE", owned.blocker);
	assert.equal(owned.prLifecycle?.phase, "ready");
	assert.equal(owned.prLifecycle?.observation?.result, "passed");
	assert.equal(owned.proof?.stage, "pr-ready");
	assert.equal(owned.prLifecycle?.pullRequest?.identity, "PR_node_177");
	assert.equal(owned.prLifecycle?.pullRequest?.branch, branchName(batch.id, 1));
	assert.equal(owned.prLifecycle?.target.sha, base);
	assert.equal(owned.operation?.phase, "pr");
	assert.equal(batchItemProofCurrent(owned), true);
	assert.equal(batchConverged(final), true);
	assert.equal(owned.attempts, 2); assert.equal(owned.ledger.tasks[0]?.attempts.length, 2);
	assert.equal(owned.ledger.goal.appetite.attemptsPerTask, 2);
	assert.equal(final.maxAttempts, 2); assert.equal(final.maxTotalAttempts, 3);
	assert.equal(final.items.reduce((total: number, item: any) => total + item.attempts, 0), 3);
	assert.equal(independent.stage, "DONE"); assert.equal(independent.attempts, 1);
	assert.ok(existsSync(join(root, "independent-progress-during-wait")), "independent selected inspection completed during the persisted hosted-check wait");
	assert.equal(hostedPolls, 3); assert.equal(prCreates, 1); assert.equal(pushes, 2); assert.equal(mergeRequests, 0); assert.equal(resumeCalls, 1);
	assert.ok(final.usage.modelCalls >= 6, "native worker and independent/current acceptance turns are accounted");
	assert.ok(attempt?.receipt && attempt.currentVerification);
	assert.equal(owned.ledger.tasks[0]?.attempts[0]?.currentVerification?.subject.head, initialPrHead);
	assert.equal(attempt.subject.head, initialPrHead, "repair is authorized for the PR head that produced the current CI failure");
	assert.equal(attempt.currentVerification.subject.head, pr?.head.sha);
	assert.equal(attempt.currentVerification.tree, owned.proof?.tree);
	assert.equal(attempt.currentVerification.acceptanceRevision, owned.selected.acceptanceRevision);
	assert.equal(attempt.subject.head, repairAuthorizationHead, "repair authorization remains bound to the PR head that produced the hosted failure");
	assert.equal(attempt.receipt.subject.head, repairAuthorizationHead, "the immutable worker receipt stays bound to its authorization subject");
	assert.notEqual(attempt.currentVerification.subject.head, attempt.receipt.subject.head, "fresh current proof is distinct from the original worker receipt");
	assert.ok(owned.operations.some((operation: any) => operation.phase === "push" && operation.state === "applied" && operation.sha === attempt.currentVerification.subject.head));
	writeFileSync(join(root, "result.json"), JSON.stringify({
		status: "passed", scenario: "scripted-owned-pr-ready", batchId: batch.id, selected: final.items.map((item: any) => ({ key: item.selected.key, action: item.selected.action, stage: item.stage, attempts: item.attempts })),
		checkSequence: ["pending", "repairable-code-failure", "passed"], prIdentity: owned.prLifecycle.pullRequest?.identity, initialAndRepairPushes: pushes, prCreates, mergeRequests, hostedPolls,
		capacity: final.capacity, maxAttempts: final.maxAttempts, maxTotalAttempts: final.maxTotalAttempts, modelCalls: final.usage.modelCalls,
		operatorFollowups: resumeCalls - 1, scriptedGitHub: true, localBareGit: true, runtimeKind: process.env.OWNED_PR_RUNTIME_KIND ?? "unknown",
	}, null, 2));
	await service.shutdown();
	console.log(JSON.stringify({ status: "passed", scenario: "scripted-owned-pr-ready", attempts: owned.attempts, hostedPolls, prCreates, pushes, mergeRequests, operatorFollowups: 0 }));
	process.exit(0);
}

export default function ownedPrAcceptanceRuntime(pi: ExtensionAPI) {
	pi.on("session_start", (_event, context) => {
		void run(pi, context).catch((error) => {
			const root = process.env.OWNED_PR_ROOT ?? "/tmp";
			const reason = error instanceof Error ? error.message : String(error);
			try { mkdirSync(root, { recursive: true }); writeFileSync(join(root, "runtime-error.txt"), reason); } catch { /* preserve the primary runtime result */ }
			console.error(reason);
			process.exit(1);
		});
	});
}
