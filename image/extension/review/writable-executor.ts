/**
 * The untrusted command boundary for opt-in Review issue work.
 *
 * This module deliberately has no GitHub client and no credential lookup. The
 * parent Review controller supplies only a private source tree and command
 * text; repository code runs in a fresh Bubblewrap namespace with an empty
 * environment and a bounded tmpfs copy of that tree.
 */

import { spawn as nodeSpawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { constants, fstatSync, lstatSync, openSync, readFileSync, readdirSync, realpathSync, closeSync } from "node:fs";
import { createHash } from "node:crypto";
import { resolve, sep } from "node:path";

export type WritableRuntimeProfile = "krun" | "apptainer";
export type WritableCheckResult = {
	readonly command: string;
	readonly status: "passed" | "failed" | "unavailable" | "timed-out" | "cancelled" | "output-limit";
	readonly exitCode?: number;
	readonly stdout: string;
	readonly stderr: string;
	readonly outputDigest: string;
	readonly candidateDigestBefore: string;
	readonly candidateDigestAfter?: string;
};

export type CandidateFile = {
	readonly path: string;
	readonly mode: "100644" | "100755";
	readonly bytes: number;
	readonly sha256: string;
	readonly content: Buffer;
};

export type CandidateSnapshot = {
	readonly digest: string;
	readonly files: readonly CandidateFile[];
	readonly totalBytes: number;
};

export type CandidateCheckProof = {
	readonly version: 1;
	readonly repository: string;
	readonly issueNumber: number;
	readonly baseRef: string;
	readonly baseSha: string;
	readonly candidateDigest: string;
	readonly planDigest: string;
	readonly checksDigest: string;
	readonly runtimeProfile: WritableRuntimeProfile;
	readonly checks: readonly { readonly command: string; readonly exitCode: 0; readonly outputDigest: string }[];
	readonly verifiedAt: number;
};

export const WRITABLE_EXECUTION_LIMITS = Object.freeze({
	commandBytes: 8_192,
	checksPerAttempt: 8,
	checkTimeoutMs: 120_000,
	outputBytes: 256 * 1024,
	workspaceBytes: 64 * 1024 * 1024,
	workspaceFiles: 8_000,
	workTmpfsBytes: 256 * 1024 * 1024,
	tmpTmpfsBytes: 64 * 1024 * 1024,
	homeTmpfsBytes: 32 * 1024 * 1024,
	cpuSeconds: 120,
	addressSpaceBytes: 1_073_741_824,
	processLimit: 64,
	fileSizeBytes: 67_108_864,
	openFiles: 128,
});

export function validateRepositoryPath(input: string): string {
	if (typeof input !== "string" || !input || input.length > 4096 || input.includes("\0") || input.includes("\\")) throw new Error("repository path is invalid");
	if (input.startsWith("/") || /^[A-Za-z]:/.test(input)) throw new Error("repository path must be relative");
	const parts = input.split("/");
	if (parts.some((part) => !part || part === "." || part === "..")) throw new Error("repository path traversal is forbidden");
	if (parts[0] === ".git" || parts[0] === ".omp" || parts[0] === ".pi" || parts[0] === ".claude") throw new Error("controller-owned repository paths are unavailable");
	return parts.join("/");
}

function sha256(bytes: Uint8Array | string): string {
	return createHash("sha256").update(bytes).digest("hex");
}

/** Snapshot only paths in the immutable base tree plus controller-recorded edits. */
export function snapshotCandidate(root: string, paths: readonly string[]): CandidateSnapshot {
	const canonicalRoot = realpathSync(root);
	const rootStat = lstatSync(canonicalRoot);
	if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Error("candidate root is not a canonical directory");
	const normalized = [...new Set(paths.map(validateRepositoryPath))].sort();
	if (normalized.length > WRITABLE_EXECUTION_LIMITS.workspaceFiles) throw new Error("candidate file count exceeds the supported limit");
	const files: CandidateFile[] = [];
	let totalBytes = 0;
	const digest = createHash("sha256");
	for (const path of normalized) {
		const absolute = resolve(canonicalRoot, ...path.split("/"));
		if (absolute !== canonicalRoot && !absolute.startsWith(`${canonicalRoot}${sep}`)) throw new Error("candidate path escapes its private workspace");
		let parent = canonicalRoot;
		let missingParent = false;
		for (const part of path.split("/").slice(0, -1)) {
			parent = resolve(parent, part);
			let parentStat;
			try { parentStat = lstatSync(parent); }
			catch (error) {
				if ((error as NodeJS.ErrnoException).code === "ENOENT") { missingParent = true; break; }
				throw error;
			}
			if (!parentStat.isDirectory() || parentStat.isSymbolicLink() || (parentStat.mode & 0o022) !== 0) {
				throw new Error(`candidate parent is not a private directory: ${path}`);
			}
		}
		if (missingParent) {
			digest.update(`${path}\0deleted\0`);
			continue;
		}
		let before;
		try { before = lstatSync(absolute); } catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") {
				digest.update(`${path}\0deleted\0`);
				continue;
			}
			throw error;
		}
		if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1) throw new Error(`candidate path is not a private regular file: ${path}`);
		const fd = openSync(absolute, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
		let content: Buffer;
		let after;
		try {
			const opened = fstatSync(fd);
			if (!opened.isFile() || opened.nlink !== 1 || opened.dev !== before.dev || opened.ino !== before.ino) throw new Error(`candidate file changed during verification: ${path}`);
			content = readFileSync(fd);
			after = fstatSync(fd);
		} finally { closeSync(fd); }
		if (after!.size !== before.size || after!.mtimeMs !== before.mtimeMs || after!.ino !== before.ino || after!.nlink !== 1) throw new Error(`candidate file changed during verification: ${path}`);
		totalBytes += content!.byteLength;
		if (totalBytes > WRITABLE_EXECUTION_LIMITS.workspaceBytes) throw new Error("candidate byte size exceeds the supported limit");
		const mode: CandidateFile["mode"] = (before.mode & 0o111) !== 0 ? "100755" : "100644";
		const fileDigest = sha256(content!);
		digest.update(`${path}\0${mode}\0${content!.byteLength}\0${fileDigest}\n`);
		files.push({ path, mode, bytes: content!.byteLength, sha256: fileDigest, content: content! });
	}
	return { digest: digest.digest("hex"), files, totalBytes };
}

export function checkPlanDigest(commands: readonly string[]): string {
	if (commands.length === 0 || commands.length > WRITABLE_EXECUTION_LIMITS.checksPerAttempt) throw new Error("one to eight verification commands are required");
	for (const command of commands) {
		if (typeof command !== "string" || !command.trim() || Buffer.byteLength(command) > WRITABLE_EXECUTION_LIMITS.commandBytes || command.includes("\0")) throw new Error("verification command is empty or exceeds the supported bound");
	}
	return sha256(JSON.stringify(commands));
}

export function checkResultsDigest(checks: readonly { readonly command: string; readonly exitCode: number; readonly outputDigest: string }[]): string {
	return sha256(JSON.stringify(checks));
}

export function createCandidateCheckProof(input: {
	repository: string;
	issueNumber: number;
	baseRef: string;
	baseSha: string;
	runtimeProfile: WritableRuntimeProfile;
	commands: readonly string[];
	planDigest: string;
	results: readonly WritableCheckResult[];
	candidate: CandidateSnapshot;
	verifiedAt?: number;
}): CandidateCheckProof {
	if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(input.repository) || !Number.isSafeInteger(input.issueNumber) || input.issueNumber < 1) throw new Error("candidate proof subject is invalid");
	if (!/^[a-f0-9]{40}$/i.test(input.baseSha) || !input.baseRef || input.baseRef.length > 255) throw new Error("candidate proof base identity is invalid");
	checkPlanDigest(input.commands);
	if (!/^[a-f0-9]{64}$/.test(input.planDigest)) throw new Error("candidate proof mandatory check plan is invalid");
	if (input.results.length !== input.commands.length || input.results.some((check, index) => check.command !== input.commands[index] || check.status !== "passed" || check.exitCode !== 0 || check.candidateDigestBefore !== input.candidate.digest || check.candidateDigestAfter !== input.candidate.digest)) throw new Error("candidate proof requires every exact check to pass against an unchanged candidate");
	const checks = input.results.map((check) => ({ command: check.command, exitCode: 0 as const, outputDigest: check.outputDigest }));
	return {
		version: 1,
		repository: input.repository.toLowerCase(),
		issueNumber: input.issueNumber,
		baseRef: input.baseRef,
		baseSha: input.baseSha.toLowerCase(),
		candidateDigest: input.candidate.digest,
		planDigest: input.planDigest,
		checksDigest: checkResultsDigest(checks),
		runtimeProfile: input.runtimeProfile,
		checks,
		verifiedAt: input.verifiedAt ?? Date.now(),
	};
}

export function verifyCandidateCheckProof(input: {
	proof: CandidateCheckProof;
	candidate: CandidateSnapshot;
	repository: string;
	issueNumber: number;
	baseRef: string;
	baseSha: string;
	commands: readonly string[];
	planDigest: string;
	runtimeProfile: WritableRuntimeProfile;
}): boolean {
	try {
		return input.proof.version === 1
			&& input.proof.repository === input.repository.toLowerCase()
			&& input.proof.issueNumber === input.issueNumber
			&& input.proof.baseRef === input.baseRef
			&& input.proof.baseSha === input.baseSha.toLowerCase()
			&& input.proof.candidateDigest === input.candidate.digest
			&& input.proof.planDigest === input.planDigest
			&& checkPlanDigest(input.commands).length === 64
			&& input.proof.checksDigest === checkResultsDigest(input.proof.checks)
			&& input.proof.runtimeProfile === input.runtimeProfile
			&& input.proof.checks.length === input.commands.length
			&& input.proof.checks.every((check, index) => check.command === input.commands[index] && check.exitCode === 0 && /^[a-f0-9]{64}$/.test(check.outputDigest));
	} catch { return false; }
}

export type SandboxCommandResult = {
	readonly status: "passed" | "failed" | "unavailable" | "timed-out" | "cancelled" | "output-limit";
	readonly exitCode?: number;
	readonly stdout: string;
	readonly stderr: string;
};

type SpawnLike = (command: string, args: readonly string[], options: SpawnOptions) => ChildProcess;

/** Constructed command for contract tests; repository text occupies only bash's data argument. */
export function credentiallessSandboxArgs(workspace: string, command: string): string[] {
	if (Buffer.byteLength(command) > WRITABLE_EXECUTION_LIMITS.commandBytes || !command.trim() || command.includes("\0")) throw new Error("verification command is empty or exceeds the supported bound");
	const canonicalWorkspace = realpathSync(workspace);
	if (!lstatSync(canonicalWorkspace).isDirectory()) throw new Error("verification workspace is not a directory");
	for (const entry of readdirSync(canonicalWorkspace, { withFileTypes: true })) {
		if (entry.name === ".git" || entry.isSymbolicLink()) throw new Error("unsafe verification workspace");
	}
	const args: string[] = [
		"--unshare-all", "--unshare-user", "--die-with-parent", "--new-session", "--as-pid-1", "--clearenv",
	];
	for (const path of ["/usr", "/bin", "/lib", "/lib64"]) {
		try { if (lstatSync(path).isDirectory() || lstatSync(path).isSymbolicLink()) args.push("--ro-bind", path, path); } catch { /* optional OS path */ }
	}
	args.push(
		"--proc", "/proc", "--dev", "/dev",
		"--size", String(WRITABLE_EXECUTION_LIMITS.tmpTmpfsBytes), "--tmpfs", "/tmp",
		"--size", String(WRITABLE_EXECUTION_LIMITS.homeTmpfsBytes), "--tmpfs", "/home", "--dir", "/home/worker",
		"--ro-bind", canonicalWorkspace, "/input",
		"--size", String(WRITABLE_EXECUTION_LIMITS.workTmpfsBytes), "--tmpfs", "/work",
		"--chdir", "/work",
		"--setenv", "HOME", "/home/worker",
		"--setenv", "TMPDIR", "/tmp",
		"--setenv", "PATH", "/usr/bin:/bin",
		"--setenv", "LANG", "C.UTF-8",
		"--setenv", "LC_ALL", "C.UTF-8",
		"--setenv", "CI", "1",
		"--disable-userns", "--assert-userns-disabled", "--cap-drop", "ALL",
		"/usr/bin/bash", "--noprofile", "--norc", "-c",
		"/usr/bin/cp -a /input/. /work/ && exec /usr/bin/bash --noprofile --norc -c \"$1\"",
		"review-writable-check", command,
	);
	return args;
}

function killProcessGroup(pid: number | undefined, signal: NodeJS.Signals): void {
	if (!pid) return;
	try { process.kill(-pid, signal); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
}

/**
 * Execute one repository command. Only a tiny environment is given to prlimit;
 * bwrap clears it again and sets an explicit non-secret allowlist.
 */
export async function runCredentiallessCheck(
	workspace: string,
	command: string,
	signal: AbortSignal,
	options: { readonly spawnImpl?: SpawnLike; readonly timeoutMs?: number; readonly outputBytes?: number; readonly parentEnv?: NodeJS.ProcessEnv } = {},
): Promise<SandboxCommandResult> {
	if (process.getuid?.() === 0) return { status: "unavailable", stdout: "", stderr: "credentialless command execution refuses a root controller" };
	if (signal.aborted) return { status: "cancelled", stdout: "", stderr: "cancelled before sandbox start" };
	let bwrapArgs: string[];
	try { bwrapArgs = credentiallessSandboxArgs(workspace, command); }
	catch (error) { return { status: "unavailable", stdout: "", stderr: error instanceof Error ? error.message : "unsafe verification workspace" }; }
	const limits = WRITABLE_EXECUTION_LIMITS;
	const args = [
		`--cpu=${limits.cpuSeconds}:${limits.cpuSeconds + 1}`,
		`--as=${limits.addressSpaceBytes}:${limits.addressSpaceBytes}`,
		`--nproc=${limits.processLimit}:${limits.processLimit}`,
		`--nofile=${limits.openFiles}:${limits.openFiles}`,
		`--fsize=${limits.fileSizeBytes}:${limits.fileSizeBytes}`,
		"--core=0:0", "--", "/usr/bin/bwrap", ...bwrapArgs,
	];
	const spawnImpl = options.spawnImpl ?? (nodeSpawn as unknown as SpawnLike);
	let child: ChildProcess;
	try {
		child = spawnImpl("/usr/bin/prlimit", args, {
			detached: true,
			windowsHide: true,
			stdio: ["ignore", "pipe", "pipe"],
			env: { PATH: "/usr/bin:/bin", LANG: "C.UTF-8", LC_ALL: "C.UTF-8" },
		});
	} catch {
		return { status: "unavailable", stdout: "", stderr: "resource-limited Bubblewrap executor could not start" };
	}
	return await new Promise<SandboxCommandResult>((resolvePromise) => {
		let stdout = "";
		let stderr = "";
		let outputBytes = 0;
		let finished = false;
		let stopReason: SandboxCommandResult["status"] | undefined;
		const maxOutput = Math.min(options.outputBytes ?? limits.outputBytes, limits.outputBytes);
		const terminate = (reason: NonNullable<typeof stopReason>) => {
			if (finished || stopReason) return;
			stopReason = reason;
			try { killProcessGroup(child.pid, "SIGTERM"); } catch { /* continue to hard kill */ }
			setTimeout(() => { try { killProcessGroup(child.pid, "SIGKILL"); } catch { /* process already settled */ } }, 300).unref();
		};
		const append = (target: "stdout" | "stderr", value: Buffer | string) => {
			const buffer = Buffer.isBuffer(value) ? value : Buffer.from(value);
			outputBytes += buffer.byteLength;
			const current = target === "stdout" ? stdout : stderr;
			const retained = Buffer.byteLength(stdout) + Buffer.byteLength(stderr);
			const next = current + buffer.subarray(0, Math.max(0, maxOutput - retained)).toString("utf8");
			if (target === "stdout") stdout = next;
			else stderr = next;
			if (outputBytes > maxOutput) terminate("output-limit");
		};
		child.stdout?.on("data", (value: Buffer | string) => append("stdout", value));
		child.stderr?.on("data", (value: Buffer | string) => append("stderr", value));
		const timeout = setTimeout(() => terminate("timed-out"), Math.min(options.timeoutMs ?? limits.checkTimeoutMs, limits.checkTimeoutMs));
		timeout.unref();
		const onAbort = () => terminate("cancelled");
		signal.addEventListener("abort", onAbort, { once: true });
		const complete = (exitCode: number | null, error?: Error) => {
			if (finished) return;
			finished = true;
			clearTimeout(timeout);
			signal.removeEventListener("abort", onAbort);
			const status = stopReason ?? (error ? "unavailable" : exitCode === 0 ? "passed" : "failed");
			resolvePromise({ status, ...(typeof exitCode === "number" ? { exitCode } : {}), stdout, stderr: stderr || (error ? "resource-limited Bubblewrap executor failed" : "") });
		};
		child.once("error", (error) => complete(null, error));
		child.once("close", (code) => complete(code));
		if (signal.aborted) onAbort();
	});
}

export async function runCandidateChecks(input: {
	readonly workspace: string;
	readonly paths: readonly string[];
	readonly commands: readonly string[];
	readonly signal: AbortSignal;
	readonly runner?: typeof runCredentiallessCheck;
}): Promise<readonly WritableCheckResult[]> {
	checkPlanDigest(input.commands);
	const runner = input.runner ?? runCredentiallessCheck;
	const results: WritableCheckResult[] = [];
	for (const command of input.commands) {
		if (input.signal.aborted) break;
		const before = snapshotCandidate(input.workspace, input.paths);
		const result = await runner(input.workspace, command, input.signal);
		if (result.status !== "passed" || result.exitCode !== 0) {
			const outputDigest = sha256(`${result.stdout}\0${result.stderr}\0${result.status}\0${result.exitCode ?? "unknown"}`);
			results.push({ command, status: result.status, ...(result.exitCode === undefined ? {} : { exitCode: result.exitCode }), stdout: result.stdout, stderr: result.stderr, outputDigest, candidateDigestBefore: before.digest });
			break;
		}
		const after = snapshotCandidate(input.workspace, input.paths);
		const unchanged = before.digest === after.digest;
		const status = unchanged ? "passed" : "failed";
		const exitCode = unchanged ? 0 : 125;
		const stderr = unchanged ? result.stderr : `${result.stderr}${result.stderr ? "\n" : ""}candidate files changed while the check ran`;
		const outputDigest = sha256(`${result.stdout}\0${stderr}\0${status}\0${exitCode}`);
		results.push({ command, status, exitCode, stdout: result.stdout, stderr, outputDigest, candidateDigestBefore: before.digest, candidateDigestAfter: after.digest });
		if (!unchanged) break;
	}
	return results;
}

export function emptyCredentialEnvironment(): NodeJS.ProcessEnv {
	return { PATH: "/usr/bin:/bin", LANG: "C.UTF-8", LC_ALL: "C.UTF-8" };
}
