/**
 * The dispatch coverage table.
 *
 * This is the honest core of the package. Intercepting one tool does not prove
 * control over every spawn, and a regex over arbitrary shell or eval text is not
 * an authorization boundary. So each execution path is recorded with the status
 * the *evidence* supports:
 *
 * - `enforced`     — Factory itself refuses to emit the work, and the refusal is
 *                    driven by the ledger and covered by a test.
 * - `observed`     — the boundary exists but is cooperative; it is reported, not
 *                    claimed as enforcement.
 * - `unsupported`  — no supported seam was established. The adapter refuses
 *                    rather than routing silently and pretending otherwise.
 *
 * The native task seam has been probed against the exact packaged OMP used by
 * the personal appliance. The remaining entries stay conservative until their
 * own executable probe exists; a successful native-task run is not evidence
 * about eval, pools, hub steering, or child-tool policy.
 */

export type CoverageStatus = "enforced" | "observed" | "unsupported";

export interface DispatchCoverage {
	/** Stable identifier used by the adapter; not a user-facing string. */
	readonly path: string;
	readonly status: CoverageStatus;
	/** What the boundary actually is, when there is one. */
	readonly seam: string;
	readonly reason: string;
	/** Upstream issue that would have to ship for this path to become enforced. */
	readonly upstream?: string;
}

export const DISPATCH_COVERAGE: readonly DispatchCoverage[] = [
	{
		path: "factory.admitted-dispatch",
		status: "enforced",
		seam: "the prompt Factory itself emits",
		reason:
			"Factory emits work only for a task the ledger admitted, and the emitted prompt carries the ledger-stamped task, attempt, generation, and subject identity. Covered by tests/luna_factory.test.ts.",
	},
	{
		path: "native.task",
		status: "enforced",
		seam: "same-name OMP task wrapper plus ctx.invokeTool delegation",
		reason:
			"The wrapper refuses an unbound task and delegates only a ledger-stamped, RUNNING attempt through OMP's native task. Executed against omp/18.1.22 (source 23a5b9ae38864d3f785dc6cbc96eb6d674a1d32d; binary SHA-256 9ccddf1091e01e08fea1f8e1208f8901cc90d5d098b16581672eeab03f118b81) with the local deterministic provider; the journal correlated the returned native result identity. Background job IDs and cancellation were not exercised by the synchronous probe.",
	},
	{
		path: "eval.tool-task",
		status: "unsupported",
		seam: "eval's tool.task bridge",
		reason: "Not probed for the same reason; whether it passes through a wrapped gate is unknown.",
	},
	{
		path: "eval.agent",
		status: "unsupported",
		seam: "eval's structured-subagent bridge",
		reason:
			"Not probed. Eval calls the structured-subagent path through its own host bridge, so a task-shaped hook is not evidence of coverage here.",
	},
	{
		path: "workpool.push",
		status: "unsupported",
		seam: "workpool item admission and correlation",
		reason:
			"Not probed. The documented workpool signature is also not an isolation API, so pool items are not treated as isolated writers.",
	},
	{
		path: "hub.steer",
		status: "unsupported",
		seam: "hub send/revive and Agent Hub steering",
		reason: "Not probed; whether a redirection is task continuation or a new mission is unresolved.",
	},
	{
		path: "root.local-effects",
		status: "observed",
		seam: "the coordinator's own write/edit/bash/eval effects",
		reason:
			"Cooperative scope only. The ledger records the intent before the effect and the receipt is verified afterwards; this is attribution and verification, not a sandbox.",
	},
	{
		path: "child.tools",
		status: "observed",
		seam: "effective tool policy inherited by child tasks",
		reason:
			"The packaged probe logged child provider tool rosters: one worker request had no Factory tools, while later child turns inherited the installed Factory namespace. This is observation only; no child-tool restriction is claimed.",
	},
	{
		path: "session_stop",
		status: "observed",
		seam: "bounded main-session settlement hook",
		reason:
			"Used only as a final settlement check. The documented eight-continuation ceiling and background-job deferral are real limits, so it is not a scheduler or a liveness watchdog.",
	},
];

const BY_PATH: Record<string, DispatchCoverage> = Object.fromEntries(
	DISPATCH_COVERAGE.map((entry) => [entry.path, entry]),
);

export function coverageFor(path: string): DispatchCoverage | undefined {
	return BY_PATH[path];
}

/** Paths whose admission boundary Factory actually enforces today. */
export function enforcedPaths(): readonly string[] {
	return DISPATCH_COVERAGE.filter((entry) => entry.status === "enforced").map((entry) => entry.path);
}

/** Paths that need a shipped upstream seam before they may be advertised. */
export function unsupportedPaths(): readonly string[] {
	return DISPATCH_COVERAGE.filter((entry) => entry.status === "unsupported").map((entry) => entry.path);
}
