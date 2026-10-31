/**
 * Opt-in gate for the credentialless writable Review executor.
 *
 * The qualification record is an image-baked root-owned artifact. User
 * environment variables can select the launcher profile, but they cannot
 * assert that an OS sandbox has been qualified.
 */

import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync } from "node:fs";
import type { RepositoryBatchKind } from "./extension.ts";

export const WRITABLE_QUALIFICATION_PATH = "/usr/share/review/writable-runtime-qualification.json";
export const WRITABLE_EXECUTION_CONTRACT_VERSION = 1;

export type WritableQualificationManifest = {
	readonly version: 1;
	readonly profile: "krun" | "apptainer";
	readonly qualified: true;
	readonly contractVersion: typeof WRITABLE_EXECUTION_CONTRACT_VERSION;
	readonly qualificationSuiteSha256: string;
	readonly bwrapSha256: string;
	readonly prlimitSha256: string;
};

export type WritableRuntimeQualification = Omit<WritableQualificationManifest, "version" | "qualified">;

export type WritableIsolationReport = {
	readonly mode: "disabled" | "opt-in-blocked" | "opt-in-ready" | "invalid-blocked";
	readonly runtime: "krun" | "apptainer" | "unknown";
	readonly osSandbox: "not-requested" | "unavailable" | "qualified";
	readonly taskExecutionTools: "legacy-default" | "blocked" | "credentialless-review-tools";
	readonly dependencyReadiness: "not-assessed" | "qualified";
	readonly publicationAuthorization: "not-attempted" | "controller-only";
	readonly blocker?: string;
};

const NO_QUALIFICATION_BLOCKER = "Writable Slay/Fix is blocked: the image-baked root-owned runtime qualification artifact is missing or does not match this runtime profile and Bubblewrap/prlimit binaries. No worker was started.";
const UNKNOWN_PROFILE_BLOCKER = "Writable Slay/Fix is blocked: launcher runtime profile is unavailable; no OS isolation qualification can be selected.";

function record(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function runtimeProfile(env: NodeJS.ProcessEnv): WritableIsolationReport["runtime"] {
	return env.REVIEW_RUNTIME_PROFILE === "krun" || env.REVIEW_RUNTIME_PROFILE === "apptainer"
		? env.REVIEW_RUNTIME_PROFILE
		: "unknown";
}

function sha256(bytes: Uint8Array): string {
	return createHash("sha256").update(bytes).digest("hex");
}

function secureRegularFile(path: string, maximumBytes: number): { readonly bytes: Buffer; readonly digest: string } | undefined {
	try {
		const before = lstatSync(path);
		if (!before.isFile() || before.isSymbolicLink() || before.uid !== 0 || before.nlink !== 1
			|| (before.mode & 0o022) !== 0 || (before.mode & 0o7000) !== 0 || before.size > maximumBytes) return undefined;
		const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
		try {
			const opened = fstatSync(fd);
			if (!opened.isFile() || opened.uid !== 0 || opened.nlink !== 1 || (opened.mode & 0o022) !== 0
				|| opened.dev !== before.dev || opened.ino !== before.ino || opened.size !== before.size) return undefined;
			const bytes = readFileSync(fd);
			const after = fstatSync(fd);
			if (after.dev !== opened.dev || after.ino !== opened.ino || after.size !== opened.size || after.mtimeMs !== opened.mtimeMs) return undefined;
			return { bytes, digest: sha256(bytes) };
		} finally { closeSync(fd); }
	} catch { return undefined; }
}

function secureQualificationPath(path: string): boolean {
	try {
		for (const directory of ["/usr", "/usr/share", "/usr/share/review"]) {
			const stat = lstatSync(directory);
			if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== 0 || (stat.mode & 0o022) !== 0 || (stat.mode & 0o7000) !== 0) return false;
		}
		return path === WRITABLE_QUALIFICATION_PATH;
	} catch { return false; }
}

/** Pure parser shared with tests; only the fixed-path loader supplies observed binary hashes in production. */
export function parseWritableRuntimeQualification(
	value: unknown,
	profile: "krun" | "apptainer",
	observed: { readonly bwrapSha256: string; readonly prlimitSha256: string },
): WritableRuntimeQualification | undefined {
	if (!record(value)) return undefined;
	const expectedKeys = ["version", "profile", "qualified", "contractVersion", "qualificationSuiteSha256", "bwrapSha256", "prlimitSha256"].sort();
	if (Object.keys(value).sort().join("\0") !== expectedKeys.join("\0")) return undefined;
	if (value.version !== 1 || value.profile !== profile || value.qualified !== true
		|| value.contractVersion !== WRITABLE_EXECUTION_CONTRACT_VERSION
		|| typeof value.qualificationSuiteSha256 !== "string" || !/^[a-f0-9]{64}$/.test(value.qualificationSuiteSha256)
		|| typeof value.bwrapSha256 !== "string" || !/^[a-f0-9]{64}$/.test(value.bwrapSha256)
		|| typeof value.prlimitSha256 !== "string" || !/^[a-f0-9]{64}$/.test(value.prlimitSha256)
		|| value.bwrapSha256 !== observed.bwrapSha256 || value.prlimitSha256 !== observed.prlimitSha256) return undefined;
	return {
		profile,
		contractVersion: WRITABLE_EXECUTION_CONTRACT_VERSION,
		qualificationSuiteSha256: value.qualificationSuiteSha256,
		bwrapSha256: value.bwrapSha256,
		prlimitSha256: value.prlimitSha256,
	};
}

/** Read only a fixed root-owned artifact and bind it to immutable executor binaries. */
export function readWritableRuntimeQualification(env: NodeJS.ProcessEnv): WritableRuntimeQualification | undefined {
	const profile = runtimeProfile(env);
	if (profile === "unknown" || !secureQualificationPath(WRITABLE_QUALIFICATION_PATH)) return undefined;
	const manifestFile = secureRegularFile(WRITABLE_QUALIFICATION_PATH, 16 * 1024);
	const bwrap = secureRegularFile("/usr/bin/bwrap", 16 * 1024 * 1024);
	const prlimit = secureRegularFile("/usr/bin/prlimit", 16 * 1024 * 1024);
	if (!manifestFile || !bwrap || !prlimit) return undefined;
	let manifest: unknown;
	try { manifest = JSON.parse(manifestFile.bytes.toString("utf8")) as unknown; } catch { return undefined; }
	return parseWritableRuntimeQualification(manifest, profile, { bwrapSha256: bwrap.digest, prlimitSha256: prlimit.digest });
}

export function writableIsolationReport(env: NodeJS.ProcessEnv): WritableIsolationReport {
	const setting = env.REVIEW_WRITABLE_ISOLATION;
	const runtime = runtimeProfile(env);
	if (setting === undefined || setting === "0") {
		return {
			mode: "disabled",
			runtime,
			osSandbox: "not-requested",
			taskExecutionTools: "legacy-default",
			dependencyReadiness: "not-assessed",
			publicationAuthorization: "not-attempted",
		};
	}
	if (setting === "1") {
		if (runtime !== "unknown" && readWritableRuntimeQualification(env)) {
			return {
				mode: "opt-in-ready",
				runtime,
				osSandbox: "qualified",
				taskExecutionTools: "credentialless-review-tools",
				dependencyReadiness: "qualified",
				publicationAuthorization: "controller-only",
			};
		}
		return {
			mode: "opt-in-blocked",
			runtime,
			osSandbox: "unavailable",
			taskExecutionTools: "blocked",
			dependencyReadiness: "not-assessed",
			publicationAuthorization: "not-attempted",
			blocker: runtime === "unknown" ? UNKNOWN_PROFILE_BLOCKER : NO_QUALIFICATION_BLOCKER,
		};
	}
	return {
		mode: "invalid-blocked",
		runtime,
		osSandbox: "unavailable",
		taskExecutionTools: "blocked",
		dependencyReadiness: "not-assessed",
		publicationAuthorization: "not-attempted",
		blocker: "REVIEW_WRITABLE_ISOLATION must be exactly 0 or 1; writable Slay/Fix dispatch is blocked.",
	};
}

export function writableDispatchBlocker(env: NodeJS.ProcessEnv, kind: RepositoryBatchKind): string | undefined {
	if (kind !== "slay" && kind !== "fix") return undefined;
	return writableIsolationReport(env).blocker;
}

export function writableExecutionReplayBlocker(execution: unknown): string | undefined {
	if (execution === undefined) return undefined;
	if (execution === null || typeof execution !== "object" || Array.isArray(execution)
		|| !("status" in execution) || !["running", "submitted", "blocked", "unknown"].includes(String(execution.status))) {
		return "Unrecognized isolated execution evidence is UNKNOWN; preserve claims, inspect GitHub effects, and do not resume or fall back to workflowz.";
	}
	if (execution.status === "running" || execution.status === "unknown") {
		return "Writable isolated execution is UNKNOWN after interruption; preserve claims, inspect GitHub effects, and do not resume or fall back to workflowz.";
	}
	return "This run already has isolated execution evidence; preserve its claims and start a separately admitted operation after reviewing the recorded draft.";
}
