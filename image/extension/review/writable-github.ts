/** Trusted GitHub preparation and draft-candidate publication for Review. */

import { closeSync, constants, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, realpathSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { join } from "node:path";
import {
	checkPlanDigest,
	createCandidateCheckProof,
	snapshotCandidate,
	validateRepositoryPath,
	verifyCandidateCheckProof,
	type CandidateCheckProof,
	type CandidateSnapshot,
	type WritableCheckResult,
	type WritableRuntimeProfile,
} from "./writable-executor.ts";
import { deriveWritableCheckPlan, writableCheckPlanBlocker } from "./writable-check-plan.ts";

const API = "https://api.github.com";
const MAX_JSON_BYTES = 16 * 1024 * 1024;
const MAX_BLOB_BYTES = 8 * 1024 * 1024;
const MAX_TREE_BYTES = 64 * 1024 * 1024;
const MAX_TREE_FILES = 8_000;

export type WritableBaseFile = {
	readonly path: string;
	readonly sha: string;
	readonly mode: "100644" | "100755";
	readonly bytes: number;
	readonly content: Buffer;
};

export type WritableWorkspaceEvidence = {
	readonly version: 1;
	readonly workspaceId: string;
	readonly repository: string;
	readonly issueNumber: number;
	readonly baseRef: string;
	readonly baseSha: string;
	readonly baseTreeSha: string;
	readonly files: readonly { readonly path: string; readonly mode: "100644" | "100755"; readonly bytes: number; readonly sha256: string }[];
};

export type InspectedWritableWorkspace = {
	readonly evidence: WritableWorkspaceEvidence;
	readonly workspaceRoot: string;
	readonly candidatePaths: readonly string[];
	readonly candidate: CandidateSnapshot;
	readonly matchesExpectedDigest?: boolean;
};

export type WritableIssueSource = {
	readonly repository: string;
	readonly issueNumber: number;
	readonly issueTitle: string;
	readonly issueBody: string;
	readonly issueUpdatedAt: string;
	readonly defaultBranch: string;
	readonly baseSha: string;
	readonly baseTreeSha: string;
	readonly files: ReadonlyMap<string, WritableBaseFile>;
};

export type WritableGitHubOptions = {
	readonly token: string;
	readonly fetchImpl?: typeof fetch;
	readonly signal?: AbortSignal;
	readonly maxTreeBytes?: number;
	readonly maxTreeFiles?: number;
};

type ApiFailure = { readonly ok: false; readonly outcome: "blocked" | "unknown"; readonly message: string };
type ApiSuccess<T> = { readonly ok: true; readonly data: T };
type ApiResult<T> = ApiFailure | ApiSuccess<T>;

function validRepository(repository: string): boolean {
	return /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository);
}

function githubHeaders(token: string): HeadersInit {
	return {
		Authorization: `Bearer ${token}`,
		Accept: "application/vnd.github+json",
		"X-GitHub-Api-Version": "2022-11-28",
		"Content-Type": "application/json",
		"User-Agent": "review-writable-controller",
	};
}

async function boundedJson(response: Response, limit = MAX_JSON_BYTES): Promise<unknown> {
	const announced = Number(response.headers.get("content-length"));
	if (Number.isFinite(announced) && announced > limit) throw new Error("GitHub response exceeds its size limit");
	if (!response.body) return {};
	const reader = response.body.getReader();
	const chunks: Uint8Array[] = [];
	let total = 0;
	for (;;) {
		const part = await reader.read();
		if (part.done) break;
		total += part.value.byteLength;
		if (total > limit) {
			await reader.cancel().catch(() => {});
			throw new Error("GitHub response exceeds its size limit");
		}
		chunks.push(part.value);
	}
	return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
}

async function api<T>(
	options: WritableGitHubOptions,
	method: "GET" | "POST",
	path: string,
	body?: unknown,
	limit = MAX_JSON_BYTES,
): Promise<ApiResult<T>> {
	if (!options.token) return { ok: false, outcome: "blocked", message: "GitHub controller authentication is unavailable" };
	if (!path.startsWith("/repos/") || path.includes("..") || path.includes("\\")) return { ok: false, outcome: "blocked", message: "GitHub controller request path is invalid" };
	try {
		const response = await (options.fetchImpl ?? fetch)(`${API}${path}`, {
			method,
			headers: githubHeaders(options.token),
			...(body === undefined ? {} : { body: JSON.stringify(body) }),
			signal: options.signal,
			redirect: "error",
		});
		if (!response.ok) {
			return {
				ok: false,
				outcome: response.status >= 500 || response.status === 408 || response.status === 429 ? "unknown" : "blocked",
				message: `GitHub ${method} ${path} returned HTTP ${response.status}`,
			};
		}
		return { ok: true, data: await boundedJson(response, limit) as T };
	} catch (error) {
		return {
			ok: false,
			outcome: options.signal?.aborted ? "unknown" : "unknown",
			message: options.signal?.aborted ? "GitHub controller request was cancelled; observe the remote effect before retrying" : `GitHub ${method} ${path} transport outcome is unknown`,
		};
	}
}

function record(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function stringField(value: Record<string, unknown>, name: string): string | undefined {
	return typeof value[name] === "string" ? value[name] as string : undefined;
}

function validateBlobMode(path: string, mode: unknown, type: unknown): "100644" | "100755" {
	validateRepositoryPath(path);
	if (type !== "blob" || (mode !== "100644" && mode !== "100755")) throw new Error(`repository tree contains an unsupported symlink or submodule entry: ${path}`);
	return mode;
}

async function fetchBaseFiles(
	repository: string,
	treeSha: string,
	options: WritableGitHubOptions,
): Promise<ApiResult<ReadonlyMap<string, WritableBaseFile>>> {
	const treeResult = await api<unknown>(options, "GET", `/repos/${repository}/git/trees/${treeSha}?recursive=1`, undefined, MAX_JSON_BYTES);
	if (!treeResult.ok) return treeResult;
	if (!record(treeResult.data) || treeResult.data.truncated !== false || !Array.isArray(treeResult.data.tree)) return { ok: false, outcome: "blocked", message: "GitHub source tree is incomplete or malformed" };
	const entries: Array<{ path: string; sha: string; mode: "100644" | "100755"; size: number }> = [];
	let total = 0;
	try {
		for (const raw of treeResult.data.tree) {
			if (!record(raw) || raw.type === "tree") continue;
			const path = typeof raw.path === "string" ? validateRepositoryPath(raw.path) : "";
			const mode = validateBlobMode(path, raw.mode, raw.type);
			if (typeof raw.sha !== "string" || !/^[a-f0-9]{40}$/i.test(raw.sha) || !Number.isSafeInteger(raw.size) || (raw.size as number) < 0) throw new Error(`repository source tree has an invalid blob: ${path}`);
			const size = raw.size as number;
			if (size > MAX_BLOB_BYTES) throw new Error(`source file exceeds the supported per-file limit: ${path}`);
			total += size;
			entries.push({ path, sha: raw.sha.toLowerCase(), mode, size });
		}
	} catch (error) {
		return { ok: false, outcome: "blocked", message: error instanceof Error ? error.message : "repository source tree is unsafe" };
	}
	if (entries.length > (options.maxTreeFiles ?? MAX_TREE_FILES) || total > (options.maxTreeBytes ?? MAX_TREE_BYTES)) return { ok: false, outcome: "blocked", message: "repository source tree exceeds the credentialless workspace limit" };
	const files = new Map<string, WritableBaseFile>();
	for (let offset = 0; offset < entries.length; offset += 6) {
		const batch = entries.slice(offset, offset + 6);
		const blobs = await Promise.all(batch.map(async (entry): Promise<ApiResult<WritableBaseFile>> => {
			const result = await api<unknown>(options, "GET", `/repos/${repository}/git/blobs/${entry.sha}`, undefined, MAX_BLOB_BYTES * 2);
			if (!result.ok) return result;
			if (!record(result.data) || result.data.encoding !== "base64" || typeof result.data.content !== "string") return { ok: false, outcome: "blocked", message: `GitHub returned an unsupported blob encoding for ${entry.path}` };
			const encoded = result.data.content.replace(/\s/g, "");
			if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)) return { ok: false, outcome: "blocked", message: `GitHub returned malformed source content for ${entry.path}` };
			const content = Buffer.from(encoded, "base64");
			if (content.byteLength !== entry.size || content.byteLength > MAX_BLOB_BYTES) return { ok: false, outcome: "blocked", message: `GitHub source size does not match tree metadata for ${entry.path}` };
			return { ok: true, data: { path: entry.path, sha: entry.sha, mode: entry.mode, bytes: entry.size, content } };
		}));
		const failed = blobs.find((blob) => !blob.ok);
		if (failed && !failed.ok) return failed;
		for (const blob of blobs) if (blob.ok) files.set(blob.data.path, blob.data);
	}
	return { ok: true, data: files };
}

function privateDirectory(path: string): string {
	mkdirSync(path, { recursive: true, mode: 0o700 });
	const canonical = realpathSync(path);
	const stat = lstatSync(canonical);
	if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0) throw new Error("private writable state directory must be owner-only and canonical");
	return canonical;
}

function ensurePrivateParents(root: string, relativePath: string): string {
	const parts = relativePath.split("/");
	let current = root;
	for (const part of parts.slice(0, -1)) {
		current = join(current, part);
		try { mkdirSync(current, { mode: 0o700 }); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
		const stat = lstatSync(current);
		if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("source tree contains a symlink or non-directory parent");
	}
	return join(root, ...parts);
}

export function materializeWritableWorkspace(source: WritableIssueSource, privateStateRoot: string): { readonly root: string; readonly candidatePaths: readonly string[]; readonly workspaceId: string } {
	const stateRoot = privateDirectory(privateStateRoot);
	const workspaceId = randomUUID();
	const root = join(stateRoot, `workspace-${workspaceId}`);
	mkdirSync(root, { mode: 0o700 });
	for (const file of source.files.values()) {
		const path = validateRepositoryPath(file.path);
		const destination = ensurePrivateParents(root, path);
		const fd = openSync(destination, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), file.mode === "100755" ? 0o700 : 0o600);
		try { writeFileSync(fd, file.content); }
		finally { closeSync(fd); }
	}
	const evidence: WritableWorkspaceEvidence = {
		version: 1, workspaceId, repository: source.repository, issueNumber: source.issueNumber,
		baseRef: source.defaultBranch, baseSha: source.baseSha, baseTreeSha: source.baseTreeSha,
		files: [...source.files.values()].map((file) => ({
			path: file.path, mode: file.mode, bytes: file.bytes,
			sha256: createHash("sha256").update(file.content).digest("hex"),
		})).sort((a, b) => a.path.localeCompare(b.path)),
	};
	const evidencePath = join(stateRoot, `workspace-${workspaceId}.json`);
	const temporary = `${evidencePath}.${randomUUID()}.tmp`;
	const evidenceFd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600);
	try { writeFileSync(evidenceFd, JSON.stringify(evidence)); fsyncSync(evidenceFd); }
	catch (error) { try { unlinkSync(temporary); } catch { /* preserve original failure */ } throw error; }
	finally { closeSync(evidenceFd); }
	renameSync(temporary, evidencePath);
	const directoryFd = openSync(stateRoot, "r");
	try { fsyncSync(directoryFd); } finally { closeSync(directoryFd); }
	return { root: realpathSync(root), candidatePaths: [...source.files.keys()].sort(), workspaceId };
}

function workspaceEvidenceIsValid(value: unknown, workspaceId: string): value is WritableWorkspaceEvidence {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const record = value as Record<string, unknown>;
	if (!(record.version === 1 && record.workspaceId === workspaceId
		&& typeof record.repository === "string" && validRepository(record.repository)
		&& Number.isSafeInteger(record.issueNumber) && Number(record.issueNumber) > 0
		&& typeof record.baseRef === "string" && !!record.baseRef && record.baseRef.length <= 255
		&& typeof record.baseSha === "string" && /^[a-f0-9]{40}$/.test(record.baseSha)
		&& typeof record.baseTreeSha === "string" && /^[a-f0-9]{40}$/.test(record.baseTreeSha)
		&& Array.isArray(record.files) && record.files.length <= MAX_TREE_FILES)) return false;
	const seen = new Set<string>();
	let totalBytes = 0;
	for (const raw of record.files) {
		if (!raw || typeof raw !== "object" || Array.isArray(raw)) return false;
		const file = raw as Record<string, unknown>;
		if (typeof file.path !== "string" || typeof file.mode !== "string" || !(file.mode === "100644" || file.mode === "100755")
			|| !Number.isSafeInteger(file.bytes) || Number(file.bytes) < 0 || Number(file.bytes) > MAX_BLOB_BYTES
			|| typeof file.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(file.sha256)) return false;
		try { if (validateRepositoryPath(file.path) !== file.path) return false; } catch { return false; }
		if (seen.has(file.path)) return false;
		seen.add(file.path);
		totalBytes += Number(file.bytes);
		if (totalBytes > MAX_TREE_BYTES) return false;
	}
	return true;
}

/** Reconstruct a private candidate after restart for inspection; it never resumes or authorizes execution. */
export function inspectWritableWorkspace(privateStateRoot: string, workspaceId: string, expectedDigest?: string): InspectedWritableWorkspace {
	if (!/^[a-f0-9-]{36}$/i.test(workspaceId)) throw new Error("workspace evidence locator is invalid");
	const stateRoot = privateDirectory(privateStateRoot);
	const evidencePath = join(stateRoot, `workspace-${workspaceId}.json`);
	const evidenceStat = lstatSync(evidencePath);
	if (!evidenceStat.isFile() || evidenceStat.isSymbolicLink() || evidenceStat.nlink !== 1 || evidenceStat.size > MAX_TREE_BYTES || (evidenceStat.mode & 0o077) !== 0) throw new Error("workspace evidence sidecar is not a bounded private regular file");
	const evidenceFd = openSync(evidencePath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
	let evidence: unknown;
	try {
		const opened = fstatSync(evidenceFd);
		if (!opened.isFile() || opened.dev !== evidenceStat.dev || opened.ino !== evidenceStat.ino || opened.size !== evidenceStat.size) throw new Error("workspace evidence changed during inspection");
		evidence = JSON.parse(readFileSync(evidenceFd, "utf8")) as unknown;
		const after = fstatSync(evidenceFd);
		if (after.dev !== opened.dev || after.ino !== opened.ino || after.size !== opened.size || after.mtimeMs !== opened.mtimeMs) throw new Error("workspace evidence changed during inspection");
	} finally { closeSync(evidenceFd); }
	if (!workspaceEvidenceIsValid(evidence, workspaceId)) throw new Error("workspace evidence is malformed");
	const workspacePath = join(stateRoot, `workspace-${workspaceId}`);
	const rootStat = lstatSync(workspacePath);
	if (!rootStat.isDirectory() || rootStat.isSymbolicLink() || (rootStat.mode & 0o077) !== 0) throw new Error("workspace candidate root is not a private directory");
	const workspaceRoot = realpathSync(workspacePath);
	if (workspaceRoot !== workspacePath) throw new Error("workspace candidate root is not canonical");
	const candidatePaths = new Set(evidence.files.map((file) => file.path));
	let fileCount = 0;
	const scan = (directory: string, prefix = "") => {
		for (const entry of readdirSync(directory, { withFileTypes: true })) {
			const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
			const absolute = join(directory, entry.name);
			const stat = lstatSync(absolute);
			if (stat.isSymbolicLink()) throw new Error("workspace candidate contains a symlink or hardlink");
			if (stat.isDirectory()) {
				if ((stat.mode & 0o077) !== 0) throw new Error("workspace candidate contains a non-private directory");
				scan(absolute, relative);
			} else if (stat.isFile()) {
				if (stat.nlink !== 1) throw new Error("workspace candidate contains a symlink or hardlink");
				candidatePaths.add(validateRepositoryPath(relative));
				fileCount++;
				if (fileCount > MAX_TREE_FILES) throw new Error("workspace candidate file count exceeds its bound");
			} else throw new Error("workspace candidate contains a non-regular entry");
		}
	};
	scan(workspaceRoot);
	const paths = [...candidatePaths].sort();
	const candidate = snapshotCandidate(workspaceRoot, paths);
	return { evidence, workspaceRoot, candidatePaths: paths, candidate, ...(expectedDigest ? { matchesExpectedDigest: candidate.digest === expectedDigest } : {}) };
}

export async function loadWritableIssueSource(
	repository: string,
	issueNumber: number,
	options: WritableGitHubOptions,
): Promise<ApiResult<WritableIssueSource>> {
	if (!validRepository(repository) || !Number.isSafeInteger(issueNumber) || issueNumber < 1) return { ok: false, outcome: "blocked", message: "selected issue identity is invalid" };
	const metadata = await api<unknown>(options, "GET", `/repos/${repository}`);
	if (!metadata.ok) return metadata;
	if (!record(metadata.data) || typeof metadata.data.default_branch !== "string" || !metadata.data.default_branch || metadata.data.default_branch.length > 255) return { ok: false, outcome: "blocked", message: "repository default branch is unavailable" };
	const defaultBranch = metadata.data.default_branch;
	const encodedBranch = defaultBranch.split("/").map(encodeURIComponent).join("/");
	const ref = await api<unknown>(options, "GET", `/repos/${repository}/git/ref/heads/${encodedBranch}`);
	if (!ref.ok) return ref;
	const refData = record(ref.data) && record(ref.data.object) ? ref.data.object : undefined;
	const baseSha = refData && stringField(refData, "sha");
	if (!baseSha || !/^[a-f0-9]{40}$/i.test(baseSha) || refData?.type !== "commit") return { ok: false, outcome: "blocked", message: "repository default branch does not resolve to an exact commit" };
	const commit = await api<unknown>(options, "GET", `/repos/${repository}/git/commits/${baseSha}`);
	if (!commit.ok) return commit;
	const baseTreeSha = record(commit.data) && record(commit.data.tree) ? stringField(commit.data.tree, "sha") : undefined;
	if (!baseTreeSha || !/^[a-f0-9]{40}$/i.test(baseTreeSha)) return { ok: false, outcome: "blocked", message: "repository base tree identity is unavailable" };
	const issue = await api<unknown>(options, "GET", `/repos/${repository}/issues/${issueNumber}`);
	if (!issue.ok) return issue;
	if (!record(issue.data) || issue.data.state !== "open" || typeof issue.data.title !== "string" || typeof issue.data.updated_at !== "string") return { ok: false, outcome: "blocked", message: "selected issue is no longer open or its source is incomplete" };
	const files = await fetchBaseFiles(repository, baseTreeSha, options);
	if (!files.ok) return files;
	return { ok: true, data: {
		repository: repository.toLowerCase(), issueNumber, issueTitle: issue.data.title,
		issueBody: typeof issue.data.body === "string" ? issue.data.body.slice(0, 32_768) : "",
		issueUpdatedAt: issue.data.updated_at, defaultBranch, baseSha: baseSha.toLowerCase(), baseTreeSha: baseTreeSha.toLowerCase(), files: files.data,
	} };
}

export type WritableRevalidation = {
	readonly issueOpen: boolean;
	readonly issueUpdatedAt: string;
	readonly existingSubmittedPullRequests: readonly string[];
	readonly authorizedWrite: boolean;
};

export type DraftCandidateResult =
	| { readonly status: "submitted"; readonly number: number; readonly url: string; readonly branch: string; readonly headSha: string; readonly baseRef: string; readonly baseSha: string; readonly observed: boolean }
	| { readonly status: "unknown" | "blocked"; readonly reason: string };

export type DraftCandidateInput = {
	readonly source: WritableIssueSource;
	readonly workspaceRoot: string;
	readonly candidatePaths: readonly string[];
	readonly candidate: CandidateSnapshot;
	readonly proof: CandidateCheckProof;
	readonly commands: readonly string[];
	readonly planDigest: string;
	readonly runtimeProfile: WritableRuntimeProfile;
	readonly summary: string;
	readonly options: WritableGitHubOptions;
	readonly revalidateIssue: () => Promise<WritableRevalidation>;
};

function workflowPath(path: string): boolean {
	return path === ".github/workflows" || path.startsWith(".github/workflows/");
}

function candidateChanges(source: WritableIssueSource, snapshot: CandidateSnapshot): Array<{ path: string; mode: "100644" | "100755"; file?: CandidateSnapshot["files"][number] }> {
	const current = new Map(snapshot.files.map((file) => [file.path, file]));
	const paths = new Set([...source.files.keys(), ...snapshot.files.map((file) => file.path)]);
	const changes: Array<{ path: string; mode: "100644" | "100755"; file?: CandidateSnapshot["files"][number] }> = [];
	for (const path of [...paths].sort()) {
		const before = source.files.get(path);
		const after = current.get(path);
		if (!after) {
			if (before) changes.push({ path, mode: before.mode });
		} else if (!before || after.sha256 !== createHash("sha256").update(before.content).digest("hex") || after.mode !== before.mode) {
			changes.push({ path, mode: after.mode, file: after });
		}
	}
	return changes;
}

async function branchRef(repository: string, branch: string, options: WritableGitHubOptions): Promise<ApiResult<{ sha: string } | undefined>> {
	const path = `/repos/${repository}/git/ref/heads/${branch.split("/").map(encodeURIComponent).join("/")}`;
	const result = await api<unknown>(options, "GET", path);
	if (!result.ok && result.message.endsWith("HTTP 404")) return { ok: true, data: undefined };
	if (!result.ok) return result;
	if (!record(result.data) || !record(result.data.object) || typeof result.data.object.sha !== "string") return { ok: false, outcome: "unknown", message: "existing candidate ref is malformed" };
	return { ok: true, data: { sha: result.data.object.sha } };
}

function parsePullRows(value: unknown): Array<Record<string, unknown>> | undefined {
	return Array.isArray(value) && value.every(record) ? value as Array<Record<string, unknown>> : undefined;
}

export async function publishDraftCandidate(input: DraftCandidateInput): Promise<DraftCandidateResult> {
	const { source, options } = input;
	let checkPlan;
	try { checkPlan = deriveWritableCheckPlan(source); }
	catch (error) { return { status: "blocked", reason: error instanceof Error ? error.message : "mandatory check plan could not be derived" }; }
	if (input.planDigest !== checkPlan.digest || JSON.stringify(input.commands) !== JSON.stringify(checkPlan.commands)) return { status: "blocked", reason: "candidate does not carry the controller-derived mandatory check plan" };
	if (!verifyCandidateCheckProof({
		proof: input.proof, candidate: input.candidate, repository: source.repository, issueNumber: source.issueNumber,
		baseRef: source.defaultBranch, baseSha: source.baseSha, commands: input.commands, planDigest: checkPlan.digest, runtimeProfile: input.runtimeProfile,
	})) return { status: "blocked", reason: "candidate check proof does not match the selected issue, source head, candidate, check plan, or runtime" };
	if (input.summary.trim().length === 0 || Buffer.byteLength(input.summary) > 8_192) return { status: "blocked", reason: "candidate summary is empty or exceeds its bound" };
	const snapshot = snapshotCandidate(input.workspaceRoot, input.candidatePaths);
	if (snapshot.digest !== input.candidate.digest) return { status: "blocked", reason: "candidate changed after its last successful check" };
	const checkPlanBlocker = writableCheckPlanBlocker({ source, workspaceRoot: input.workspaceRoot, candidatePaths: input.candidatePaths, plan: checkPlan });
	if (checkPlanBlocker) return { status: "blocked", reason: checkPlanBlocker };
	const changes = candidateChanges(source, snapshot);
	if (changes.length === 0) return { status: "blocked", reason: "candidate contains no source changes" };
	if (changes.some((change) => workflowPath(change.path))) return { status: "blocked", reason: "draft publication is blocked for workflow-file changes" };
	const branch = `review/issue-${source.issueNumber}-${snapshot.digest.slice(0, 12)}`;
	const pathRoot = `/repos/${source.repository}`;

	const liveRepository = await api<unknown>(options, "GET", pathRoot);
	if (!liveRepository.ok) return { status: liveRepository.outcome, reason: liveRepository.message };
	if (!record(liveRepository.data) || liveRepository.data.default_branch !== source.defaultBranch
		|| !record(liveRepository.data.permissions) || liveRepository.data.permissions.push !== true) return { status: "blocked", reason: "repository default branch or authenticated write permission changed" };
	const liveRef = await api<unknown>(options, "GET", `${pathRoot}/git/ref/heads/${source.defaultBranch.split("/").map(encodeURIComponent).join("/")}`);
	if (!liveRef.ok) return { status: liveRef.outcome, reason: liveRef.message };
	if (!record(liveRef.data) || !record(liveRef.data.object) || liveRef.data.object.sha !== source.baseSha) return { status: "blocked", reason: "repository default branch advanced since candidate verification" };
	const revalidation = await input.revalidateIssue();
	const capturedIssueTime = Date.parse(source.issueUpdatedAt);
	const liveIssueTime = Date.parse(revalidation.issueUpdatedAt);
	if (!revalidation.issueOpen || !Number.isFinite(capturedIssueTime) || !Number.isFinite(liveIssueTime) || liveIssueTime !== capturedIssueTime
		|| revalidation.existingSubmittedPullRequests.length > 0 || !revalidation.authorizedWrite) return { status: "blocked", reason: "issue, declared Slay intent, PR association, or write permission changed before publication" };
	if (options.signal?.aborted) return { status: "unknown", reason: "publication cancelled after candidate revalidation; inspect GitHub before retrying" };

	const entries: Array<Record<string, unknown>> = [];
	for (const change of changes) {
		if (!change.file) {
			const base = source.files.get(change.path)!;
			entries.push({ path: change.path, mode: base.mode, type: "blob", sha: null });
			continue;
		}
		const blob = await api<unknown>(options, "POST", `${pathRoot}/git/blobs`, { content: change.file.content.toString("base64"), encoding: "base64" }, 1024 * 1024);
		if (!blob.ok) return { status: blob.outcome, reason: blob.message };
		if (!record(blob.data) || typeof blob.data.sha !== "string" || !/^[a-f0-9]{40}$/i.test(blob.data.sha)) return { status: "unknown", reason: "GitHub blob creation returned no exact object identity" };
		entries.push({ path: change.path, mode: change.mode, type: "blob", sha: blob.data.sha.toLowerCase() });
	}
	const tree = await api<unknown>(options, "POST", `${pathRoot}/git/trees`, { base_tree: source.baseTreeSha, tree: entries });
	if (!tree.ok) return { status: tree.outcome, reason: tree.message };
	if (!record(tree.data) || typeof tree.data.sha !== "string" || !/^[a-f0-9]{40}$/i.test(tree.data.sha)) return { status: "unknown", reason: "GitHub candidate tree identity is unavailable" };
	const commit = await api<unknown>(options, "POST", `${pathRoot}/git/commits`, {
		message: `review: prepare candidate for ${source.repository}#${source.issueNumber}`,
		tree: tree.data.sha,
		parents: [source.baseSha],
	});
	if (!commit.ok) return { status: commit.outcome, reason: commit.message };
	if (!record(commit.data) || typeof commit.data.sha !== "string" || !/^[a-f0-9]{40}$/i.test(commit.data.sha)) return { status: "unknown", reason: "GitHub candidate commit identity is unavailable" };
	const headSha = commit.data.sha.toLowerCase();

	const priorRef = await branchRef(source.repository, branch, options);
	if (!priorRef.ok) return { status: priorRef.outcome, reason: priorRef.message };
	if (priorRef.data && priorRef.data.sha.toLowerCase() !== headSha) return { status: "blocked", reason: "deterministic candidate branch already points at a different commit" };
	if (!priorRef.data) {
		const createdRef = await api<unknown>(options, "POST", `${pathRoot}/git/refs`, { ref: `refs/heads/${branch}`, sha: headSha });
		if (!createdRef.ok) {
			const observed = await branchRef(source.repository, branch, options);
			if (!observed.ok) return { status: "unknown", reason: "candidate ref creation outcome and authoritative observation are both unknown" };
			if (!observed.data || observed.data.sha.toLowerCase() !== headSha) return { status: "unknown", reason: "candidate ref creation was not confirmed; preserve the mutation claim and do not retry blindly" };
		}
	}

	const pullQuery = `?state=open&head=${encodeURIComponent(`${source.repository.split("/")[0]}:${branch}`)}&base=${encodeURIComponent(source.defaultBranch)}&per_page=100`;
	const priorPulls = await api<unknown>(options, "GET", `${pathRoot}/pulls${pullQuery}`);
	if (!priorPulls.ok) return { status: priorPulls.outcome, reason: priorPulls.message };
	const rows = parsePullRows(priorPulls.data);
	if (!rows) return { status: "unknown", reason: "GitHub candidate PR observation is malformed" };
	if (rows.length > 1) return { status: "unknown", reason: "multiple open PRs match the exact candidate branch and base" };
	if (rows.length === 1) {
		const pr = rows[0]!;
		const head = record(pr.head) ? pr.head : {};
		const base = record(pr.base) ? pr.base : {};
		const user = record(pr.user) ? pr.user : {};
		if (head.sha === headSha && head.ref === branch && base.ref === source.defaultBranch && base.sha === source.baseSha
			&& pr.draft === true && pr.state === "open" && typeof pr.number === "number" && typeof pr.html_url === "string" && user.login) {
			return { status: "submitted", number: pr.number, url: pr.html_url, branch, headSha, baseRef: source.defaultBranch, baseSha: source.baseSha, observed: true };
		}
		return { status: "unknown", reason: "an existing candidate PR has a different head, base, or draft state" };
	}
	if (options.signal?.aborted) return { status: "unknown", reason: "publication cancelled after branch creation; inspect GitHub before retrying" };
	const title = `Fix #${source.issueNumber}: ${source.issueTitle}`.slice(0, 250);
	const body = [
		`Prepares a checked candidate for ${source.repository}#${source.issueNumber}.`,
		"",
		"This pull request was created as a draft by Review's controller after isolated local checks. It is not marked ready, approved, or merged.",
		"",
		"Candidate summary:",
		input.summary.trim(),
		"",
		"Controller-recorded local checks:",
		...input.proof.checks.map((check) => `- \`${check.command.replace(/`/g, "'")}\` — exit ${check.exitCode}; output sha256 ${check.outputDigest}`),
	].join("\n").slice(0, 20_000);
	const created = await api<unknown>(options, "POST", `${pathRoot}/pulls`, { title, body, head: branch, base: source.defaultBranch, draft: true });
	if (created.ok && record(created.data) && typeof created.data.number === "number" && typeof created.data.html_url === "string") {
		const head = record(created.data.head) ? created.data.head : {};
		const base = record(created.data.base) ? created.data.base : {};
		if (created.data.state === "open" && created.data.draft === true && head.sha === headSha && head.ref === branch && base.ref === source.defaultBranch && base.sha === source.baseSha) {
			return { status: "submitted", number: created.data.number, url: created.data.html_url, branch, headSha, baseRef: source.defaultBranch, baseSha: source.baseSha, observed: false };
		}
	}
	const observed = await api<unknown>(options, "GET", `${pathRoot}/pulls${pullQuery}`);
	const observedRows = observed.ok ? parsePullRows(observed.data) : undefined;
	if (observedRows?.length === 1) {
		const pr = observedRows[0]!;
		const head = record(pr.head) ? pr.head : {};
		const base = record(pr.base) ? pr.base : {};
		if (head.sha === headSha && head.ref === branch && base.ref === source.defaultBranch && base.sha === source.baseSha
			&& pr.draft === true && pr.state === "open" && typeof pr.number === "number" && typeof pr.html_url === "string") {
			return { status: "submitted", number: pr.number, url: pr.html_url, branch, headSha, baseRef: source.defaultBranch, baseSha: source.baseSha, observed: true };
		}
	}
	return { status: "unknown", reason: "draft PR creation outcome is ambiguous; preserve claims and observe GitHub before retrying" };
}

export function proofStillMatches(input: {
	readonly source: WritableIssueSource;
	readonly workspaceRoot: string;
	readonly candidatePaths: readonly string[];
	readonly proof: CandidateCheckProof;
	readonly commands: readonly string[];
	readonly runtimeProfile: WritableRuntimeProfile;
}): boolean {
	try {
		const candidate = snapshotCandidate(input.workspaceRoot, input.candidatePaths);
		const plan = deriveWritableCheckPlan(input.source);
		if (JSON.stringify(input.commands) !== JSON.stringify(plan.commands)) return false;
		return verifyCandidateCheckProof({ proof: input.proof, candidate, repository: input.source.repository, issueNumber: input.source.issueNumber,
			baseRef: input.source.defaultBranch, baseSha: input.source.baseSha, commands: input.commands, planDigest: plan.digest, runtimeProfile: input.runtimeProfile });
	} catch { return false; }
}

export function createWritableProof(input: {
	readonly source: WritableIssueSource;
	readonly candidate: CandidateSnapshot;
	readonly commands: readonly string[];
	readonly results: readonly WritableCheckResult[];
	readonly runtimeProfile: WritableRuntimeProfile;
}): CandidateCheckProof {
	return createCandidateCheckProof({
		repository: input.source.repository,
		issueNumber: input.source.issueNumber,
		baseRef: input.source.defaultBranch,
		baseSha: input.source.baseSha,
		runtimeProfile: input.runtimeProfile,
		commands: input.commands,
		planDigest: deriveWritableCheckPlan(input.source).digest,
		results: input.results,
		candidate: input.candidate,
	});
}
