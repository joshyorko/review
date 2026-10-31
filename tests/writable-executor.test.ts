import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { type ChildProcess } from "node:child_process";
import { linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
	checkPlanDigest,
	createCandidateCheckProof,
	credentiallessSandboxArgs,
	runCandidateChecks,
	runCredentiallessCheck,
	snapshotCandidate,
	validateRepositoryPath,
	verifyCandidateCheckProof,
	WRITABLE_EXECUTION_LIMITS,
	type WritableCheckResult,
} from "../image/extension/review/writable-executor.ts";
import {
	loadWritableIssueSource,
	materializeWritableWorkspace,
	proofStillMatches,
	publishDraftCandidate,
	type WritableIssueSource,
} from "../image/extension/review/writable-github.ts";
import { runWritableIssueWorkflow } from "../image/extension/review/writable-worker.ts";
import { loadWave, saveWave } from "../image/extension/review/wave-store.ts";

const sha = (value: string) => createHash("sha256").update(value).digest("hex");
const baseSha = "a".repeat(40);
const treeSha = "b".repeat(40);
const blobSha = "c".repeat(40);
const commitSha = "d".repeat(40);

function tempRoot(): string {
	return mkdtempSync(join(tmpdir(), "review-writable-test-"));
}

function source(content = "base\n"): WritableIssueSource {
	const buffer = Buffer.from(content);
	return {
		repository: "example/repo",
		issueNumber: 42,
		issueTitle: "Repair a thing",
		issueBody: "Issue body is untrusted.",
		issueUpdatedAt: "2026-10-31T12:00:00Z",
		defaultBranch: "main",
		baseSha,
		baseTreeSha: treeSha,
		files: new Map([["src/file.txt", { path: "src/file.txt", sha: blobSha, mode: "100644", bytes: buffer.byteLength, content: buffer }]]),
	};
}

function changedWorkspace() {
	const root = tempRoot();
	mkdirSync(join(root, "src"));
	writeFileSync(join(root, "src/file.txt"), "candidate\n");
	return root;
}

function makeProof(root: string) {
	const paths = ["src/file.txt"];
	const candidate = snapshotCandidate(root, paths);
	const commands = ["node --test"];
	const results: WritableCheckResult[] = [{
		command: commands[0]!, status: "passed", exitCode: 0, stdout: "ok\n", stderr: "",
		outputDigest: sha("output"), candidateDigestBefore: candidate.digest, candidateDigestAfter: candidate.digest,
	}];
	const proof = createCandidateCheckProof({
		repository: "example/repo", issueNumber: 42, baseRef: "main", baseSha,
		runtimeProfile: "krun", commands, results, candidate,
	});
	return { paths, candidate, commands, results, proof };
}

function response(data: unknown, status = 200): Response {
	return new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });
}

test("repository paths reject traversal, absolute paths, controller state, and Windows separators", () => {
	assert.equal(validateRepositoryPath("src/file.ts"), "src/file.ts");
	for (const path of ["../secret", "src/../secret", "/etc/passwd", "C:/secret", ".git/config", ".omp/state", "src\\file.ts", "src//file.ts"]) {
		assert.throws(() => validateRepositoryPath(path), path);
	}
});

test("candidate snapshots are content-bound and reject symlink and hardlink escape forms", () => {
	const root = tempRoot();
	try {
		mkdirSync(join(root, "src"));
		writeFileSync(join(root, "src/file.txt"), "one\n");
		const first = snapshotCandidate(root, ["src/file.txt"]);
		writeFileSync(join(root, "src/file.txt"), "two\n");
		const second = snapshotCandidate(root, ["src/file.txt"]);
		assert.notEqual(first.digest, second.digest);
		writeFileSync(join(root, "src/secret.txt"), "synthetic canary\n");
		symlinkSync("secret.txt", join(root, "src/link.txt"));
		assert.throws(() => snapshotCandidate(root, ["src/link.txt"]), /regular file/);
		rmSync(join(root, "src/link.txt"));
		mkdirSync(join(root, "outside"));
		writeFileSync(join(root, "outside/secret.txt"), "parent symlink canary\n");
		symlinkSync("../outside", join(root, "src/parent-link"));
		assert.throws(() => snapshotCandidate(root, ["src/parent-link/secret.txt"]), /symlink|private directory/i);
		rmSync(join(root, "src/parent-link"));
		linkSync(join(root, "src/secret.txt"), join(root, "src/hardlink.txt"));
		assert.throws(() => snapshotCandidate(root, ["src/hardlink.txt"]), /regular file/);
	} finally { rmSync(root, { recursive: true, force: true }); }
});

test("candidate proof binds exact issue, base, candidate, commands, profile, and unchanged files", () => {
	const root = changedWorkspace();
	try {
		const { paths, candidate, commands, proof } = makeProof(root);
		const valid = { proof, candidate, repository: "example/repo", issueNumber: 42, baseRef: "main", baseSha, commands, runtimeProfile: "krun" as const };
		assert.equal(verifyCandidateCheckProof(valid), true);
		assert.equal(verifyCandidateCheckProof({ ...valid, issueNumber: 43 }), false);
		assert.equal(verifyCandidateCheckProof({ ...valid, baseSha: "f".repeat(40) }), false);
		assert.equal(verifyCandidateCheckProof({ ...valid, commands: ["npm test"] }), false);
		assert.equal(verifyCandidateCheckProof({ ...valid, runtimeProfile: "apptainer" }), false);
	assert.equal(verifyCandidateCheckProof({ ...valid, proof: { ...proof, checks: proof.checks.map((check) => ({ ...check, outputDigest: "f".repeat(64) })) } }), false);
		writeFileSync(join(root, "src/file.txt"), "edited after check\n");
		assert.equal(proofStillMatches({ source: source(), workspaceRoot: root, candidatePaths: paths, proof, commands, runtimeProfile: "krun" }), false);
	} finally { rmSync(root, { recursive: true, force: true }); }
});

test("sandbox arguments clear the environment, isolate namespaces and use a bounded tmpfs copy", () => {
	const root = changedWorkspace();
	try {
		const args = credentiallessSandboxArgs(root, "printf '%s' \"$GH_TOKEN\"");
		assert.ok(args.includes("--unshare-all"));
		assert.ok(args.includes("--unshare-user"));
		assert.ok(args.includes("--clearenv"));
		assert.ok(args.includes("--as-pid-1"));
		assert.ok(args.includes("--disable-userns"));
		assert.ok(args.includes("--assert-userns-disabled"));
		assert.ok(args.includes("--ro-bind"));
		assert.ok(args.includes("--tmpfs"));
		assert.ok(args.includes(String(WRITABLE_EXECUTION_LIMITS.workTmpfsBytes)));
		assert.equal(args.at(-1), "printf '%s' \"$GH_TOKEN\"");
		assert.ok(args.includes("/input"));
		assert.ok(!args.some((arg) => arg === "--share-net" || arg.includes("HTTP_PROXY")));
		assert.throws(() => credentiallessSandboxArgs(root, "x".repeat(WRITABLE_EXECUTION_LIMITS.commandBytes + 1)), /bound/);
	} finally { rmSync(root, { recursive: true, force: true }); }
});

test("appliance packages and stages the resource-limit launcher required by writable checks", () => {
	const containerfile = readFileSync(new URL("../image/appliance/Containerfile", import.meta.url), "utf8");
	assert.match(containerfile, /bubblewrap\s+util-linux\s/);
	assert.ok(containerfile.includes("/usr/bin/prlimit \\"));
});

test("resource-limited launch does not inherit synthetic or parent credentials", async () => {
	const root = changedWorkspace();
	try {
		let captured: { command: string; args: readonly string[]; options: Record<string, unknown> } | undefined;
		const fake = new EventEmitter() as EventEmitter & { pid: number; stdout: EventEmitter; stderr: EventEmitter };
		fake.pid = 100_000;
		fake.stdout = new EventEmitter();
		fake.stderr = new EventEmitter();
		const resultPromise = runCredentiallessCheck(root, "true", new AbortController().signal, {
			parentEnv: { GH_TOKEN: "synthetic-canary", HOME: "/home/secret" },
			spawnImpl: ((command: string, args: readonly string[], options: Record<string, unknown>) => {
				captured = { command, args, options };
				queueMicrotask(() => fake.emit("close", 0));
				return fake as unknown as ChildProcess;
			}) as never,
		});
		const result = await resultPromise;
		assert.equal(result.status, "passed");
		assert.equal(captured?.command, "/usr/bin/prlimit");
		assert.ok(captured?.args.includes("--as=1073741824:1073741824"));
		assert.ok(captured?.args.includes("--nproc=64:64"));
		assert.deepEqual(captured?.options.env, { PATH: "/usr/bin:/bin", LANG: "C.UTF-8", LC_ALL: "C.UTF-8" });
		assert.equal(JSON.stringify(captured?.options).includes("synthetic-canary"), false);
		assert.equal(JSON.stringify(captured?.options).includes("/home/secret"), false);
	} finally { rmSync(root, { recursive: true, force: true }); }
});

test("candidate checks bind stdout/stderr and fail if a tracked source file changes during a check", async () => {
	const root = changedWorkspace();
	try {
		const paths = ["src/file.txt"];
		const before = snapshotCandidate(root, paths);
		const passed = await runCandidateChecks({
			workspace: root, paths, commands: ["node --test"], signal: new AbortController().signal,
			runner: async () => ({ status: "passed", exitCode: 0, stdout: "stdout", stderr: "stderr" }),
		});
		assert.equal(passed[0]?.status, "passed");
		assert.equal(passed[0]?.candidateDigestBefore, before.digest);
		const tampered = await runCandidateChecks({
			workspace: root, paths, commands: ["node --test"], signal: new AbortController().signal,
			runner: async () => {
				writeFileSync(join(root, "src/file.txt"), "test mutated candidate\n");
				return { status: "passed", exitCode: 0, stdout: "forged pass marker", stderr: "" };
			},
		});
		assert.equal(tampered[0]?.status, "failed");
		assert.notEqual(tampered[0]?.candidateDigestBefore, tampered[0]?.candidateDigestAfter);
		assert.throws(() => checkPlanDigest([]), /required/);
	} finally { rmSync(root, { recursive: true, force: true }); }
});

test("GitHub source acquisition materializes only complete regular blobs without running repository scripts", async () => {
	const calls: string[] = [];
	const fetchImpl = (async (url: URL | RequestInfo, init?: RequestInit) => {
		const target = String(url);
		calls.push(`${init?.method ?? "GET"} ${target}`);
		assert.equal(new Headers(init?.headers).get("authorization"), "Bearer synthetic-token");
		if (target.endsWith("/repos/example/repo")) return response({ default_branch: "main" });
		if (target.includes("/git/ref/heads/main")) return response({ object: { sha: baseSha, type: "commit" } });
		if (target.includes(`/git/commits/${baseSha}`)) return response({ tree: { sha: treeSha } });
		if (target.includes("/issues/42")) return response({ state: "open", title: "Repair", body: "untrusted", updated_at: "2026-10-31T12:00:00Z" });
		if (target.includes(`/git/trees/${treeSha}`)) return response({ truncated: false, tree: [{ path: "src/file.txt", mode: "100644", type: "blob", sha: blobSha, size: 5 }] });
		if (target.includes(`/git/blobs/${blobSha}`)) return response({ encoding: "base64", content: Buffer.from("base\n").toString("base64") });
		throw new Error(`unexpected request ${target}`);
	}) as typeof fetch;
	const loaded = await loadWritableIssueSource("example/repo", 42, { token: "synthetic-token", fetchImpl });
	assert.equal(loaded.ok, true);
	if (!loaded.ok) return;
	assert.deepEqual([...loaded.data.files.keys()], ["src/file.txt"]);
	assert.equal(loaded.data.baseSha, baseSha);
	assert.equal(loaded.data.files.get("src/file.txt")?.bytes, 5);
	assert.equal(calls.filter((call) => call.includes("/git/blobs/")).length, 1);
	assert.ok(calls.every((call) => !call.includes("/contents/")));
	const root = tempRoot();
	try {
		const workspace = materializeWritableWorkspace(loaded.data, root);
		assert.equal(readFileSync(join(workspace.root, "src/file.txt"), "utf8"), "base\n");
		assert.equal(lstatSync(workspace.root).mode & 0o077, 0);
	} finally { rmSync(root, { recursive: true, force: true }); }
});

test("GitHub source acquisition rejects symlink entries and truncated trees before any blob access", async () => {
	for (const entry of [
		{ path: "src/link", mode: "120000", type: "blob", sha: blobSha, size: 5 },
		{ path: "src/module", mode: "160000", type: "commit", sha: blobSha, size: 0 },
	]) {
		let blobs = 0;
		const fetchImpl = (async (url: URL | RequestInfo) => {
			const target = String(url);
			if (target.endsWith("/repos/example/repo")) return response({ default_branch: "main" });
			if (target.includes("/git/ref/heads/main")) return response({ object: { sha: baseSha, type: "commit" } });
			if (target.includes(`/git/commits/${baseSha}`)) return response({ tree: { sha: treeSha } });
			if (target.includes("/issues/42")) return response({ state: "open", title: "Repair", updated_at: "time" });
			if (target.includes(`/git/trees/${treeSha}`)) return response({ truncated: false, tree: [entry] });
			if (target.includes("/git/blobs/")) { blobs++; return response({}); }
			throw new Error("unexpected request");
		}) as typeof fetch;
		const result = await loadWritableIssueSource("example/repo", 42, { token: "canary", fetchImpl });
		assert.equal(result.ok, false);
		if (!result.ok) assert.match(result.message, /unsupported symlink or submodule/);
		assert.equal(blobs, 0);
	}
	let blobs = 0;
	const incompleteFetch = (async (url: URL | RequestInfo) => {
		const target = String(url);
		if (target.endsWith("/repos/example/repo")) return response({ default_branch: "main" });
		if (target.includes("/git/ref/heads/main")) return response({ object: { sha: baseSha, type: "commit" } });
		if (target.includes(`/git/commits/${baseSha}`)) return response({ tree: { sha: treeSha } });
		if (target.includes("/issues/42")) return response({ state: "open", title: "Repair", updated_at: "time" });
		if (target.includes(`/git/trees/${treeSha}`)) return response({ tree: [{ path: "src/file.txt", mode: "100644", type: "blob", sha: blobSha, size: 5 }] });
		if (target.includes("/git/blobs/")) { blobs++; return response({ encoding: "base64", content: Buffer.from("base\n").toString("base64") }); }
		throw new Error("unexpected request");
	}) as typeof fetch;
	const incomplete = await loadWritableIssueSource("example/repo", 42, { token: "canary", fetchImpl: incompleteFetch });
	assert.equal(incomplete.ok, false);
	if (!incomplete.ok) assert.match(incomplete.message, /incomplete or malformed/);
	assert.equal(blobs, 0);
});

function publishFake(fetchLog: Array<{ method: string; path: string; body?: Record<string, unknown> }>, overrides: { staleBase?: boolean; unauthorized?: boolean; branchMismatch?: boolean; ambiguousPost?: boolean } = {}): typeof fetch {
	let refCreated = false;
	let prCreated = false;
	let branchName = "";
	return (async (url: URL | RequestInfo, init?: RequestInit) => {
		const target = new URL(String(url));
		const method = init?.method ?? "GET";
		const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : undefined;
		fetchLog.push({ method, path: `${target.pathname}${target.search}`, ...(body ? { body } : {}) });
		const path = target.pathname;
		if (path === "/repos/example/repo" && method === "GET") return response({ default_branch: "main", permissions: { push: !overrides.unauthorized } });
		if (path.endsWith("/git/ref/heads/main")) return response({ object: { sha: overrides.staleBase ? "e".repeat(40) : baseSha, type: "commit" } });
		if (path.includes("/git/blobs/") && method === "GET") return response({ encoding: "base64", content: Buffer.from("base\n").toString("base64") });
		if (path.endsWith("/git/blobs") && method === "POST") return response({ sha: "f".repeat(40) });
		if (path.endsWith("/git/trees") && method === "POST") return response({ sha: "9".repeat(40) });
		if (path.endsWith("/git/commits") && method === "POST") return response({ sha: commitSha });
		if (path.endsWith("/git/refs") && method === "POST") {
			refCreated = true;
			branchName = String(body?.ref).replace(/^refs\/heads\//, "");
			return response({ ref: body?.ref, object: { sha: body?.sha } }, 201);
		}
		if (path.includes("/git/ref/heads/review/issue-42-")) {
			if (method === "GET") return refCreated
				? response({ object: { sha: overrides.branchMismatch ? "8".repeat(40) : commitSha } })
				: response({ message: "Not Found" }, 404);
		}
		if (path.endsWith("/pulls") && method === "GET") return response(prCreated ? [{ number: 51, html_url: "https://github.com/example/repo/pull/51", state: "open", draft: true,
			head: { sha: commitSha, ref: branchName }, base: { sha: baseSha, ref: "main" }, user: { login: "controller" } }] : []);
		if (path.endsWith("/pulls") && method === "POST") {
			if (overrides.ambiguousPost) { prCreated = true; throw new Error("connection dropped after commit"); }
			return response({ number: 51, html_url: "https://github.com/example/repo/pull/51", state: "open", draft: true,
				head: { sha: commitSha, ref: body?.head }, base: { sha: baseSha, ref: "main" } }, 201);
		}
		throw new Error(`unexpected fake GitHub call ${method} ${path}`);
	}) as typeof fetch;
}

async function publishFixture(options: { staleBase?: boolean; unauthorized?: boolean; branchMismatch?: boolean; ambiguousPost?: boolean; workflowChange?: boolean; revalidatedUpdatedAt?: string } = {}) {
	const root = changedWorkspace();
	const fetchLog: Array<{ method: string; path: string; body?: Record<string, unknown> }> = [];
	const src = source();
	const paths = ["src/file.txt"];
	if (options.workflowChange) {
		mkdirSync(join(root, ".github/workflows"), { recursive: true });
		writeFileSync(join(root, ".github/workflows/ci.yml"), "name: unsafe\n");
		paths.push(".github/workflows/ci.yml");
	}
	const candidate = snapshotCandidate(root, paths);
	const commands = ["node --test"];
	const results: WritableCheckResult[] = [{ command: commands[0]!, status: "passed", exitCode: 0, stdout: "ok", stderr: "", outputDigest: sha("output"), candidateDigestBefore: candidate.digest, candidateDigestAfter: candidate.digest }];
	const proof = createCandidateCheckProof({ repository: src.repository, issueNumber: src.issueNumber, baseRef: src.defaultBranch, baseSha: src.baseSha, runtimeProfile: "krun", commands, results, candidate });
	const fetchImpl = publishFake(fetchLog, options);
	const call = () => publishDraftCandidate({
		source: src, workspaceRoot: root, candidatePaths: paths, candidate, proof, commands, runtimeProfile: "krun", summary: "Applied the source correction.",
		options: { token: "synthetic-canary", fetchImpl },
		revalidateIssue: async () => ({ issueOpen: true, issueUpdatedAt: options.revalidatedUpdatedAt ?? src.issueUpdatedAt, existingSubmittedPullRequests: [], authorizedWrite: true }),
	});
	return { root, fetchLog, call };
}

test("controller publisher creates only a deterministic draft on the exact verified base and candidate", async () => {
	const fixture = await publishFixture();
	try {
		const result = await fixture.call();
		assert.equal(result.status, "submitted", JSON.stringify(result));
		if (result.status !== "submitted") return;
		assert.equal(result.number, 51);
		assert.equal(result.baseRef, "main");
		assert.equal(result.baseSha, baseSha);
		assert.equal(result.headSha, commitSha);
		const createRef = fixture.fetchLog.find((request) => request.method === "POST" && request.path.endsWith("/git/refs"));
		assert.equal(createRef?.body?.sha, commitSha);
		assert.match(String(createRef?.body?.ref), /^refs\/heads\/review\/issue-42-/);
		const createPr = fixture.fetchLog.find((request) => request.method === "POST" && request.path.endsWith("/pulls"));
		assert.equal(createPr?.body?.draft, true);
		assert.equal(createPr?.body?.base, "main");
		assert.equal(createPr?.body?.head, result.branch);
		assert.equal(String(createPr?.body?.body).includes("Closes"), false);
		assert.equal(JSON.stringify(fixture.fetchLog).includes("synthetic-canary"), false);
	} finally { rmSync(fixture.root, { recursive: true, force: true }); }
});

test("publisher compares GitHub updated_at instants independent of millisecond formatting", async () => {
	const fixture = await publishFixture({ revalidatedUpdatedAt: "2026-10-31T12:00:00.000Z" });
	try {
		const result = await fixture.call();
		assert.equal(result.status, "submitted", JSON.stringify(result));
	} finally { rmSync(fixture.root, { recursive: true, force: true }); }
});

test("publisher blocks stale base, lost write authority, and workflow changes before public branch/PR writes", async () => {
	for (const options of [{ staleBase: true }, { unauthorized: true }, { workflowChange: true }]) {
		const fixture = await publishFixture(options);
		try {
			const result = await fixture.call();
			assert.equal(result.status, "blocked");
			assert.equal(fixture.fetchLog.some((request) => request.method === "POST" && (request.path.endsWith("/git/refs") || request.path.endsWith("/pulls"))), false);
		} finally { rmSync(fixture.root, { recursive: true, force: true }); }
	}
});

test("publisher reconciles an ambiguous PR create by exact observation and never retries POST", async () => {
	const fixture = await publishFixture({ ambiguousPost: true });
	try {
		const result = await fixture.call();
		assert.equal(result.status, "submitted", JSON.stringify(result));
		if (result.status === "submitted") assert.equal(result.observed, true);
		assert.equal(fixture.fetchLog.filter((request) => request.method === "POST" && request.path.endsWith("/pulls")).length, 1);
	} finally { rmSync(fixture.root, { recursive: true, force: true }); }
});

test("wave persistence validates isolated execution evidence separately from workflowz receipts", () => {
	const root = tempRoot();
	const now = Date.now();
	const batch = {
		version: 2 as const, issueOutcome: "pr-ready" as const, issuePrDeadlineAt: now + 60_000, issuePrRepairLimit: 1,
		id: "batch-writable-test", kind: "fix" as const, waves: [{ repo: "example/repo", items: [{ repo: "example/repo", id: 42, type: "issue" as const }] }],
		currentWave: 0, completedItems: 0, totalItems: 1, state: "running" as const, startedAt: now, waveStartedAt: now,
		waveIdentity: "batch-writable-test:0", writableExecution: { version: 1 as const, status: "running" as const, issueKey: "example/repo#42", runtimeProfile: "krun" as const, startedAt: now },
	};
	try {
		saveWave(root, batch as never);
		assert.deepEqual(loadWave(root, "review:batch-writable-test:0")?.writableExecution, batch.writableExecution);
		saveWave(root, { ...batch, writableExecution: { ...batch.writableExecution, issueKey: "example/repo#43" } } as never);
		assert.equal(loadWave(root, "review:batch-writable-test:0"), undefined);
	} finally { rmSync(root, { recursive: true, force: true }); }
});

test("restricted native issue worker uses only Review read/write/check tools before controller draft publication", async () => {
	const root = tempRoot();
	const requests: Array<{ method: string; path: string; body?: Record<string, unknown> }> = [];
	let baseRefCreated = false;
	let capturedOptions: Record<string, unknown> | undefined;
	const fetchImpl = (async (url: URL | RequestInfo, init?: RequestInit) => {
		const target = new URL(String(url));
		const method = init?.method ?? "GET";
		const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : undefined;
		requests.push({ method, path: `${target.pathname}${target.search}`, ...(body ? { body } : {}) });
		const path = target.pathname;
		if (path === "/repos/example/repo" && method === "GET") return response({ default_branch: "main", permissions: { push: true } });
		if (path.endsWith("/git/ref/heads/main")) return response({ object: { sha: baseSha, type: "commit" } });
		if (path.includes(`/git/commits/${baseSha}`)) return response({ tree: { sha: treeSha } });
		if (path.endsWith("/issues/42")) return response({ state: "open", title: "Repair", body: "Fix the sample source.", updated_at: "2026-10-31T12:00:00Z" });
		if (path.includes(`/git/trees/${treeSha}`) && method === "GET") return response({ truncated: false, tree: [{ path: "src/file.txt", mode: "100644", type: "blob", sha: blobSha, size: 5 }] });
		if (path.includes(`/git/blobs/${blobSha}`) && method === "GET") return response({ encoding: "base64", content: Buffer.from("base\n").toString("base64") });
		if (path.endsWith("/git/blobs") && method === "POST") return response({ sha: "f".repeat(40) });
		if (path.endsWith("/git/trees") && method === "POST") return response({ sha: "9".repeat(40) });
		if (path.endsWith("/git/commits") && method === "POST") return response({ sha: commitSha });
		if (path.endsWith("/git/refs") && method === "POST") { baseRefCreated = true; return response({ ref: body?.ref, object: { sha: body?.sha } }, 201); }
		if (path.includes("/git/ref/heads/review/issue-42-")) return baseRefCreated ? response({ object: { sha: commitSha } }) : response({}, 404);
		if (path.endsWith("/pulls") && method === "GET") return response([]);
		if (path.endsWith("/pulls") && method === "POST") return response({ number: 51, html_url: "https://github.com/example/repo/pull/51", state: "open", draft: true,
			head: { sha: commitSha, ref: body?.head }, base: { sha: baseSha, ref: "main" } }, 201);
		throw new Error(`unexpected fake GitHub request ${method} ${path}`);
	}) as typeof fetch;
	const customRunner = async (input: Parameters<typeof runCandidateChecks>[0]): Promise<readonly WritableCheckResult[]> => {
		const candidate = snapshotCandidate(input.workspace, input.paths);
		return input.commands.map((command) => ({ command, status: "passed", exitCode: 0, stdout: "fixture check passed", stderr: "", outputDigest: sha("fixture output"), candidateDigestBefore: candidate.digest, candidateDigestAfter: candidate.digest }));
	};
	const sdk = {
		Settings: { isolated: (settings: Record<string, unknown>) => settings },
		SessionManager: { create: (cwd: string, sessionPath: string) => ({ cwd, sessionPath }) },
		async createAgentSession(options: Record<string, unknown>) {
			capturedOptions = options;
			const tools = options.customTools as Array<{ name: string; execute(_id: string, args: Record<string, unknown>): Promise<{ content: Array<{ text: string }> }> }>;
			const byName = new Map(tools.map((tool) => [tool.name, tool]));
			return { session: {
				sessionFile: "/private/session.jsonl",
				model: { provider: "fixture", id: "fixed" },
				async prompt() {
					assert.deepEqual((await byName.get("review_writable_files")!.execute("1", { path: ".", offset: 0, limit: 20 })).content.length, 1);
					const read = await byName.get("review_writable_read")!.execute("2", { path: "src/file.txt", offset: 0, limit: 100 });
					assert.match(read.content[0]!.text, /base/);
					await byName.get("review_writable_write")!.execute("3", { path: "src/file.txt", content: "candidate\n" });
					await byName.get("review_writable_check")!.execute("4", { commands: ["node --test"] });
					await byName.get("review_writable_report")!.execute("5", { summary: "Updated the sample implementation." });
				},
				async abort() {},
				async dispose() {},
			} };
		},
	};
	const schema = { object: (shape: Record<string, unknown>) => shape, string: () => "string", number: () => "number", array: (item: unknown) => [item] };
	try {
		const workflow = await runWritableIssueWorkflow({
			repository: "example/repo", issueNumber: 42, privateStateRoot: join(root, "state"), sessionRoot: join(root, "sessions"),
			token: "synthetic-canary", runtimeProfile: "krun", sdk, schema, context: { model: { provider: "fixture", id: "fixed" }, modelRegistry: { authStorage: {}, hasConfiguredAuth: () => true } },
			signal: new AbortController().signal, fetchImpl, checkRunner: customRunner,
			revalidateIssue: async () => ({ issueOpen: true, issueUpdatedAt: "2026-10-31T12:00:00Z", existingSubmittedPullRequests: [], authorizedWrite: true }),
		});
		assert.equal(workflow.status, "submitted");
		assert.equal(workflow.publication?.status, "submitted");
		assert.equal(workflow.publication?.status === "submitted" && workflow.publication.observed, false);
		assert.equal(capturedOptions?.disableExtensionDiscovery, true);
		assert.equal(capturedOptions?.enableMCP, false);
		assert.equal(capturedOptions?.restrictToolNames, true);
		assert.equal(capturedOptions?.allowRestrictedCustomTools, true);
		assert.equal(capturedOptions?.authStorage === (capturedOptions?.modelRegistry as { authStorage?: unknown }).authStorage, true);
		const names = capturedOptions?.toolNames as string[];
		assert.deepEqual(names, ["review_writable_files", "review_writable_read", "review_writable_write", "review_writable_delete", "review_writable_check", "review_writable_report"]);
		assert.equal(names.some((name) => /bash|shell|task|github|publish|network/i.test(name)), false);
		assert.equal(requests.some((request) => request.method === "POST" && request.path.endsWith("/pulls") && request.body?.draft === true), true);
	} finally { rmSync(root, { recursive: true, force: true }); }
});
