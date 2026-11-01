/** Controller-owned mandatory checks derived only from the captured base tree. */

import { createHash } from "node:crypto";
import type { WritableIssueSource } from "./writable-github.ts";
import { checkPlanDigest, snapshotCandidate, validateRepositoryPath } from "./writable-executor.ts";

export type WritableCheckPlan = {
	readonly commands: readonly string[];
	readonly definitionFiles: readonly string[];
	readonly requiredFiles: readonly string[];
	readonly requiredFileFingerprints: readonly { readonly path: string; readonly mode: "100644" | "100755"; readonly bytes: number; readonly sha256: string }[];
	readonly digest: string;
};

const sha256 = (value: Uint8Array | string): string => createHash("sha256").update(value).digest("hex");
const testFile = /(?:^|\/)(?:__tests__\/.*|[^/]+\.(?:test|spec)\.(?:[cm]?js|[cm]?ts))$/i;

function shellQuote(value: string): string {
	return `'${value.replaceAll("'", "'\\''")}'`;
}

function sourceTestFiles(source: WritableIssueSource): string[] {
	return [...source.files.keys()].filter((path) => testFile.test(path)).sort();
}

function packageTest(source: WritableIssueSource): { command: string; definitionFiles: string[] } | undefined {
	const manifestFile = source.files.get("package.json");
	if (!manifestFile) return undefined;
	if (manifestFile.bytes > 128 * 1024) throw new Error("mandatory check plan blocked: package.json exceeds its bound");
	let manifest: unknown;
	try { manifest = JSON.parse(manifestFile.content.toString("utf8")) as unknown; }
	catch { throw new Error("mandatory check plan blocked: package.json is malformed"); }
	if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) throw new Error("mandatory check plan blocked: package.json is malformed");
	const scripts = (manifest as { scripts?: unknown }).scripts;
	const test = scripts && typeof scripts === "object" && !Array.isArray(scripts)
		? (scripts as Record<string, unknown>).test
		: undefined;
	if (typeof test !== "string" || !test.trim()) return undefined;
	if (/^(?:true|:|echo(?:\s|$)|exit\s+0)$/i.test(test.trim())) throw new Error("mandatory check plan blocked: package test command is a no-op");
	return { command: "npm test", definitionFiles: ["package.json"] };
}

export function deriveWritableCheckPlan(source: WritableIssueSource, candidateFiles: readonly string[] = [...source.files.keys()]): WritableCheckPlan {
	let commands: string[];
	let definitionFiles: string[];
	let requiredFiles: string[];
	if (source.files.has("go.mod")) {
		commands = ["go test ./..."];
		definitionFiles = ["go.mod", ...["go.sum", "go.work"].filter((path) => source.files.has(path))];
		requiredFiles = [...source.files.keys()].filter((path) => path.endsWith("_test.go")).sort();
		if (requiredFiles.length === 0) requiredFiles = ["go.mod"];
	} else {
		const npm = packageTest(source);
		if (npm) {
			commands = [npm.command];
			definitionFiles = npm.definitionFiles;
			requiredFiles = sourceTestFiles(source);
			if (requiredFiles.length === 0) requiredFiles = ["package.json"];
		} else {
			const pythonTests = [...source.files.keys()].filter((path) => /(?:^|\/)test[^/]*\.py$/i.test(path) && path.startsWith("tests/")).sort();
			if (pythonTests.length > 0) {
				commands = ["python3 -m unittest discover -s tests"];
				definitionFiles = [];
				requiredFiles = pythonTests;
			} else {
				const nodeTests = sourceTestFiles(source);
				if (nodeTests.length === 0) throw new Error("mandatory check plan blocked: no controller-derived repository test plan is available");
				const candidateTests = candidateFiles
					.map(validateRepositoryPath)
					.filter((path) => testFile.test(path) && !source.files.has(path));
				commands = [`node --test ${[...new Set([...nodeTests, ...candidateTests])].sort().map(shellQuote).join(" ")}`];
				definitionFiles = [];
				requiredFiles = nodeTests;
			}
		}
	}
	checkPlanDigest(commands);
	const definitions = definitionFiles.map((path) => {
		const file = source.files.get(validateRepositoryPath(path));
		if (!file) throw new Error(`mandatory check plan blocked: base definition ${path} is unavailable`);
		return { path, mode: file.mode, bytes: file.bytes, sha256: sha256(file.content) };
	});
	const requiredFileFingerprints = [...new Set(requiredFiles)].sort().map((path) => {
		const file = source.files.get(validateRepositoryPath(path));
		if (!file) throw new Error(`mandatory check plan blocked: captured test input ${path} is unavailable`);
		return { path, mode: file.mode, bytes: file.bytes, sha256: sha256(file.content) };
	});
	const digest = sha256(JSON.stringify({ commands, definitions, requiredFileFingerprints }));
	return { commands, definitionFiles: [...new Set(definitionFiles)].sort(), requiredFiles: [...new Set(requiredFiles)].sort(), requiredFileFingerprints, digest };
}

/** Return a blocker when the candidate changed a check definition or removed a required test input. */
export function writableCheckPlanBlocker(input: {
	readonly source: WritableIssueSource;
	readonly workspaceRoot: string;
	readonly candidatePaths: readonly string[];
	readonly plan: WritableCheckPlan;
}): string | undefined {
	try {
		const paths = [...new Set([...input.candidatePaths, ...input.plan.definitionFiles, ...input.plan.requiredFiles])];
		const tracked = new Set(input.candidatePaths);
		for (const path of [...input.plan.definitionFiles, ...input.plan.requiredFiles]) if (!tracked.has(path)) return `mandatory check plan blocked: captured check input is missing from the candidate index (${path})`;
		const snapshot = snapshotCandidate(input.workspaceRoot, paths);
		const files = new Map(snapshot.files.map((file) => [file.path, file]));
		for (const path of input.plan.definitionFiles) {
			const base = input.source.files.get(path);
			const candidate = files.get(path);
			if (!base || !candidate || candidate.sha256 !== sha256(base.content) || candidate.mode !== base.mode) {
				return `mandatory check plan blocked: captured check definition changed (${path})`;
			}
		}
		for (const path of input.plan.requiredFiles) {
			if (!files.has(path)) return `mandatory check plan blocked: captured test input was deleted (${path})`;
		}
		for (const inputFile of input.plan.requiredFileFingerprints) {
			const base = input.source.files.get(inputFile.path);
			const candidate = files.get(inputFile.path);
			if (!base || !candidate || candidate.sha256 !== inputFile.sha256 || candidate.sha256 !== sha256(base.content)
				|| candidate.bytes !== inputFile.bytes || candidate.bytes !== base.bytes || candidate.mode !== inputFile.mode || candidate.mode !== base.mode) {
				return `mandatory check plan blocked: captured test input changed (${inputFile.path})`;
			}
		}
		const derived = deriveWritableCheckPlan(input.source, snapshot.files.map((file) => file.path));
		if (input.plan.commands.length === 0 || input.plan.digest !== derived.digest
			|| JSON.stringify(input.plan.commands) !== JSON.stringify(derived.commands)
			|| JSON.stringify(input.plan.definitionFiles) !== JSON.stringify(derived.definitionFiles)
			|| JSON.stringify(input.plan.requiredFiles) !== JSON.stringify(derived.requiredFiles)
			|| JSON.stringify(input.plan.requiredFileFingerprints) !== JSON.stringify(derived.requiredFileFingerprints)) return "mandatory check plan blocked: controller check plan identity changed";
		return undefined;
	} catch (error) {
		return error instanceof Error ? error.message : "mandatory check plan could not be verified";
	}
}
