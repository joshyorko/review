import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NativeExecutionError, sandboxPreflight, sandboxTest } from "./batch-native.ts";

type VerifierProbeResult = {
	kind: "review-factory-verifier";
	status: "available";
	uid: number;
	gid: number;
	uidMap: string;
	maxUserNamespaces: string;
	bwrapVersion: string;
	checks: ["sandboxPreflight", "sandboxTest:true"];
};

function readOptional(path: string): string {
	try { return readFileSync(path, "utf8").trim() || "unavailable"; }
	catch { return "unavailable"; }
}

function message(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** Exercise the packaged verifier implementation without repository commands or persistent state. */
export async function probeFactoryVerifier(): Promise<VerifierProbeResult> {
	const workspace = mkdtempSync(join(tmpdir(), "review-factory-verifier-"));
	try {
		const signal = new AbortController().signal;
		const preflight = await sandboxPreflight(workspace, [], signal);
		if (preflight.missing.includes("bash")) {
			throw new NativeExecutionError("capability-unavailable", "task readiness: verifier lacks required executable(s): bash");
		}
		const smoke = await sandboxTest(workspace, "true", signal);
		if (smoke.exitCode !== 0) {
			throw new NativeExecutionError("capability-unavailable", `verification sandbox smoke test failed with exit ${smoke.exitCode}: ${smoke.output}`);
		}
		return {
			kind: "review-factory-verifier",
			status: "available",
			uid: process.getuid(),
			gid: process.getgid(),
			uidMap: readOptional("/proc/self/uid_map"),
			maxUserNamespaces: readOptional("/proc/sys/user/max_user_namespaces"),
			bwrapVersion: execFileSync("bwrap", ["--version"], { encoding: "utf8" }).trim(),
			checks: ["sandboxPreflight", "sandboxTest:true"],
		};
	} finally {
		rmSync(workspace, { recursive: true, force: true });
	}
}

if (import.meta.main) {
	try {
		process.stdout.write(`${JSON.stringify(await probeFactoryVerifier())}\n`);
	} catch (error) {
		process.stderr.write(`${JSON.stringify({ kind: "review-factory-verifier", status: "blocked", reason: message(error) })}\n`);
		process.exitCode = 1;
	}
}
