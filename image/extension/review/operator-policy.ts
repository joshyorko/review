import { createHash, randomUUID } from "node:crypto";
import { chmodSync, closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export type OperatorReviewMode = "solo" | "team";

export interface OperatorPolicySnapshot {
	readonly version: 2;
	readonly repository: string;
	readonly mode: OperatorReviewMode;
	readonly source: "explicit" | "default";
	readonly revision: number;
	readonly digest: string;
}

interface StoredPolicyEntry {
	repository: string;
	mode: OperatorReviewMode;
	revision: number;
}
interface StoredPolicy {
	version: 2;
	repositories: StoredPolicyEntry[];
}

export function operatorPolicyPath(env: NodeJS.ProcessEnv = process.env): string {
	const home = env.HOME;
	if (!home || !home.startsWith("/")) throw new Error("Operator policy requires an absolute HOME path");
	return join(home, ".config", "review", "operator-policy.json");
}

function normalizeRepository(repository: string): string {
	if (typeof repository !== "string" || !/^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/.test(repository)) {
		throw new Error(`Invalid repository for operator policy: ${String(repository)}`);
	}
	const [owner, name] = repository.toLowerCase().split("/");
	if ([owner, name].some((part) => part === "." || part === "..")) {
		throw new Error(`Invalid repository for operator policy: ${repository}`);
	}
	return `${owner}/${name}`;
}

function isMode(value: unknown): value is OperatorReviewMode {
	return value === "solo" || value === "team";
}

function digestFor(repository: string, mode: OperatorReviewMode, source: OperatorPolicySnapshot["source"], revision: number): string {
	return createHash("sha256").update(JSON.stringify({ version: 2, repository, mode, source, revision })).digest("hex");
}

function snapshot(repository: string, mode: OperatorReviewMode, source: OperatorPolicySnapshot["source"], revision: number): OperatorPolicySnapshot {
	return { version: 2, repository, mode, source, revision, digest: digestFor(repository, mode, source, revision) };
}

export function isOperatorPolicySnapshot(value: unknown): value is OperatorPolicySnapshot {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const record = value as Record<string, unknown>;
	if (Object.keys(record).sort().join(",") !== "digest,mode,repository,revision,source,version") return false;
	if (record.version !== 2 || !isMode(record.mode) || (record.source !== "explicit" && record.source !== "default")) return false;
	if (!Number.isSafeInteger(record.revision) || (record.source === "default" && (record.mode !== "team" || record.revision !== 0)) || (record.source === "explicit" && (record.revision as number) < 1)) return false;
	if (typeof record.repository !== "string" || typeof record.digest !== "string") return false;
	try {
		const repository = normalizeRepository(record.repository);
		return repository === record.repository && record.digest === digestFor(repository, record.mode, record.source, record.revision as number);
	} catch {
		return false;
	}
}

function readStore(path: string): StoredPolicyEntry[] {
	let raw: string;
	try {
		raw = readFileSync(path, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
		throw new Error(`Cannot read operator policy at ${path}: ${(error as Error).message}`);
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch (error) {
		throw new Error(`Corrupt operator policy at ${path}: ${(error as Error).message}`);
	}
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error(`Invalid operator policy at ${path}`);
	const root = parsed as Record<string, unknown>;
	if (Object.keys(root).sort().join(",") !== "repositories,version" || root.version !== 2 || !Array.isArray(root.repositories)) {
		throw new Error(`Invalid operator policy schema at ${path}`);
	}
	const seen = new Set<string>();
	const entries: StoredPolicyEntry[] = [];
	for (const item of root.repositories) {
		if (!item || typeof item !== "object" || Array.isArray(item)) throw new Error(`Invalid operator policy entry at ${path}`);
		const entry = item as Record<string, unknown>;
		if (Object.keys(entry).sort().join(",") !== "mode,repository,revision" || typeof entry.repository !== "string" || !isMode(entry.mode) || !Number.isSafeInteger(entry.revision) || (entry.revision as number) < 1) {
			throw new Error(`Invalid operator policy entry at ${path}`);
		}
		const repository = normalizeRepository(entry.repository);
		if (repository !== entry.repository || seen.has(repository)) throw new Error(`Duplicate or non-normalized repository in operator policy at ${path}`);
		seen.add(repository);
		entries.push({ repository, mode: entry.mode, revision: entry.revision as number });
	}
	return entries;
}

export function readOperatorPolicy(repository: string, env: NodeJS.ProcessEnv = process.env): OperatorPolicySnapshot {
	const normalized = normalizeRepository(repository);
	if (!env.HOME) return snapshot(normalized, "team", "default", 0);
	const path = operatorPolicyPath(env);
	const found = readStore(path).find((entry) => entry.repository === normalized);
	return found ? snapshot(normalized, found.mode, "explicit", found.revision) : snapshot(normalized, "team", "default", 0);
}

export function writeOperatorPolicy(repository: string, mode: OperatorReviewMode, env: NodeJS.ProcessEnv = process.env): OperatorPolicySnapshot {
	const normalized = normalizeRepository(repository);
	if (!isMode(mode)) throw new Error(`Invalid operator policy mode: ${String(mode)}`);
	const path = operatorPolicyPath(env);
	const directory = dirname(path);
	const lockPath = `${path}.lock`;
	mkdirSync(directory, { recursive: true, mode: 0o700 });
	chmodSync(directory, 0o700);
	try {
		mkdirSync(lockPath, { mode: 0o700 });
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new Error(`Operator policy writer lock is held at ${lockPath}`);
		throw new Error(`Cannot lock operator policy at ${path}: ${(error as Error).message}`);
	}
	try {
		const entries = readStore(path);
		const existing = entries.find((entry) => entry.repository === normalized);
		const revision = existing ? existing.mode === mode ? existing.revision : existing.revision + 1 : 1;
		const preserved = entries.filter((entry) => entry.repository !== normalized);
		preserved.push({ repository: normalized, mode, revision });
		preserved.sort((a, b) => a.repository.localeCompare(b.repository));
		const data: StoredPolicy = { version: 2, repositories: preserved };
		const tempPath = `${path}.${randomUUID()}.tmp`;
		let fd: number | undefined;
		try {
			fd = openSync(tempPath, "wx", 0o600);
			writeFileSync(fd, `${JSON.stringify(data, null, 2)}\n`);
			fsyncSync(fd);
			closeSync(fd);
			fd = undefined;
			chmodSync(tempPath, 0o600);
			renameSync(tempPath, path);
			const directoryFd = openSync(directory, "r");
			try { fsyncSync(directoryFd); } finally { closeSync(directoryFd); }
		} finally {
			if (fd !== undefined) closeSync(fd);
			if (existsSync(tempPath)) rmSync(tempPath, { force: true });
		}
		return snapshot(normalized, mode, "explicit", revision);
	} catch (error) {
		if (error instanceof Error && /operator policy/.test(error.message)) throw error;
		throw new Error(`Cannot write operator policy at ${path}: ${(error as Error).message}`);
	} finally {
		rmSync(lockPath, { recursive: true, force: true });
	}
}

export function operatorPolicyCurrent(snapshotValue: OperatorPolicySnapshot, env: NodeJS.ProcessEnv = process.env): boolean {
	if (!isOperatorPolicySnapshot(snapshotValue)) return false;
	try {
		const current = readOperatorPolicy(snapshotValue.repository, env);
		return current.digest === snapshotValue.digest;
	} catch {
		return false;
	}
}
