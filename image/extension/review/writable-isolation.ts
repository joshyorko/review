/**
 * Opt-in guard for writable Review batches.
 *
 * A separate OMP worktree is not an OS isolation boundary. Until Review has a
 * credentialless worker session and a qualified command executor, opting in
 * must block Slay/Fix before the coordinator starts any OMP task. This module
 * intentionally does not invoke Bubblewrap or fall back to native task tools.
 */

import type { RepositoryBatchKind } from "./extension.ts";

export type WritableIsolationReport = {
	readonly mode: "disabled" | "opt-in-blocked" | "invalid-blocked";
	readonly runtime: "krun" | "apptainer" | "unknown";
	readonly osSandbox: "not-requested" | "unavailable";
	readonly taskExecutionTools: "legacy-default" | "blocked";
	readonly dependencyReadiness: "not-assessed";
	readonly publicationAuthorization: "not-attempted";
	readonly blocker?: string;
};

const OPT_IN_BLOCKER = "Writable Slay/Fix is blocked: the credentialless executor is not integrated and qualified. No task was dispatched, no repository command ran, and no GitHub publication was attempted.";

function runtimeProfile(env: NodeJS.ProcessEnv): WritableIsolationReport["runtime"] {
	return env.REVIEW_RUNTIME_PROFILE === "krun" || env.REVIEW_RUNTIME_PROFILE === "apptainer"
		? env.REVIEW_RUNTIME_PROFILE
		: "unknown";
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
		return {
			mode: "opt-in-blocked",
			runtime,
			osSandbox: "unavailable",
			taskExecutionTools: "blocked",
			dependencyReadiness: "not-assessed",
			publicationAuthorization: "not-attempted",
			blocker: OPT_IN_BLOCKER,
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
