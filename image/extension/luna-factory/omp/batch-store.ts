import { closeSync, cpSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, rmdirSync, unlinkSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { randomUUID } from "node:crypto";
import { createBatch, digest, type Batch } from "../core/batch.ts";
import { parseJournal, type JournalRead } from "../core/journal.ts";
import { parseOperationReceipt } from "../core/schema.ts";
import type { Ledger, OperationReceipt } from "../core/model.ts";


function migrateLegacyOperation(batchId: string, item: Batch["items"][number], ledger: Ledger): void {
	const legacy = item.operation as unknown as {
		id?: unknown; phase?: unknown; state?: unknown; branch?: unknown; sha?: unknown; url?: unknown;
	} | undefined;
	item.operations ??= [];
	if (!legacy) return;
	if (typeof legacy.id !== "string" || !["worker", "verify", "acceptance", "push", "pr"].includes(String(legacy.phase)) ||
		!["intent", "confirmed", "unknown"].includes(String(legacy.state))) {
		throw new Error("unsupported legacy operation receipt; preserve original evidence");
	}
	const phase = legacy.phase as OperationReceipt["phase"];
	if ((phase === "push" || phase === "pr") && (typeof legacy.branch !== "string" || typeof legacy.sha !== "string")) {
		throw new Error("legacy publication operation lacks its exact branch/SHA; preserve original evidence");
	}
	const subject = phase === "push" || phase === "pr" ? { ...ledger.subject, head: legacy.sha as string } : ledger.subject;
	item.operation = {
		id: legacy.id,
		generation: ledger.generation,
		subject,
		effect: phase === "push" ? "git-push" : phase === "pr" ? "pull-request-create" : "repository-work",
		phase,
		owner: `${batchId}:${item.selected.key}`,
		...(ledger.tasks[0]?.attempts.at(-1)?.id ? { attemptId: ledger.tasks[0]!.attempts.at(-1)!.id } : {}),
		state: legacy.state === "confirmed" ? "applied" : legacy.state as OperationReceipt["state"],
		...(typeof legacy.branch === "string" ? { branch: legacy.branch } : {}),
		...(typeof legacy.sha === "string" ? { sha: legacy.sha } : {}),
		...(typeof legacy.url === "string" ? { url: legacy.url, resultHandle: legacy.url } : {}),
	};
}

interface Owner { host: string; pid: number; start: string; token: string }
function processStart(pid: number): string {
	try { return readFileSync(`/proc/${pid}/stat`, "utf8").split(") ")[1]!.split(" ")[19]!; }
	catch { return "unavailable"; }
}
function syncDirectory(path: string): void {
	const fd = openSync(path, "r");
	try { fsyncSync(fd); } finally { closeSync(fd); }
}
function inside(root: string, path: string): string {
	const actual = realpathSync(path);
	const child = relative(root, actual);
	if (!child || child === ".." || child.startsWith(`..${sep}`) || actual !== resolve(path)) throw new Error("artifact path escapes Factory state root or follows a symlink");
	return child;
}
function validateItemLedger(item: Batch["items"][number], allowUnavailableBlocked = false): JournalRead {
	const parsed = parseJournal(item.ledger);
	const unavailableBlockedItem = allowUnavailableBlocked && !parsed.ok && item.attempts === 0 && item.stage === "BLOCKED" && Boolean(item.selected.blocker) && item.ledger.tasks.length === 0;
	if (!parsed.ok && !unavailableBlockedItem) throw new Error(`invalid item ledger: ${parsed.reason}; original state preserved`);
	return parsed;
}

export class BatchStore {
	readonly root: string;
	private owner: Owner = { host: hostname(), pid: process.pid, start: processStart(process.pid), token: randomUUID() };
	private held = false;
	private failed = false;
	constructor(root: string) {
		this.root = resolve(root);
		mkdirSync(this.root, { recursive: true, mode: 0o700 });
		if (realpathSync(this.root) !== this.root || lstatSync(this.root).isSymbolicLink()) throw new Error("Factory state root must be a real local directory, not a symlink");
	}
	acquire(): void {
		if (this.held) return;
		const recovery = join(this.root, ".owner-recovery");
		const file = join(this.root, "owner.json");
		const candidate = join(this.root, `.owner-recovery.${this.owner.token}`);
		const marker = join(candidate, this.owner.token);
		const live = (previous: Owner): void => {
			if (previous.host !== hostname()) throw new Error("Factory supports one same-host local state root, not shared/network storage");
			if (previous.start === "unavailable" || processStart(previous.pid) === previous.start) throw new Error(`Factory state is owned by process ${previous.pid}; attach with status, do not start a second writer`);
		};
		const publishOwner = (): void => {
			const temporary = join(this.root, `.owner.${this.owner.token}.tmp`);
			const fd = openSync(temporary, "wx", 0o600);
			try { writeFileSync(fd, JSON.stringify(this.owner)); fsyncSync(fd); }
			finally { closeSync(fd); }
			try { renameSync(temporary, file); }
			catch (error) { try { rmSync(temporary); } catch { /* preserve the original failure */ } throw error; }
			syncDirectory(this.root);
		};
		let heldRecovery = false;
		while (!heldRecovery) {
			mkdirSync(candidate, { mode: 0o700 });
			const fd = openSync(marker, "wx", 0o600);
			try { writeFileSync(fd, JSON.stringify(this.owner)); fsyncSync(fd); }
			finally { closeSync(fd); }
			syncDirectory(candidate);
			try {
				renameSync(candidate, recovery);
				heldRecovery = true;
			} catch (error: unknown) {
				try { rmSync(candidate, { recursive: true, force: true }); } catch { /* another contender owns the recovery path */ }
				const code = (error as NodeJS.ErrnoException).code;
				if (!["EEXIST", "ENOTEMPTY", "EISDIR"].includes(code ?? "")) throw error;
				let entries: string[];
				try { entries = readdirSync(recovery); } catch (readError: unknown) { if ((readError as NodeJS.ErrnoException).code === "ENOENT") continue; throw readError; }
				if (entries.length === 0) {
					if (existsSync(file)) live(JSON.parse(readFileSync(file, "utf8")) as Owner);
					try { rmdirSync(recovery); } catch (removeError: unknown) { if (!["ENOENT", "ENOTEMPTY"].includes((removeError as NodeJS.ErrnoException).code ?? "")) throw removeError; }
					continue;
				}
				if (entries.length !== 1) throw new Error("Factory recovery mutex has unexpected metadata");
				const staleToken = entries[0]!;
				const stalePath = join(recovery, staleToken);
				const previous = JSON.parse(readFileSync(stalePath, "utf8")) as Owner;
				if (previous.token !== staleToken) throw new Error("Factory recovery metadata token mismatch");
				live(previous);
				if (existsSync(file)) live(JSON.parse(readFileSync(file, "utf8")) as Owner);
				try { unlinkSync(stalePath); } catch (removeError: unknown) { if ((removeError as NodeJS.ErrnoException).code === "ENOENT") continue; throw removeError; }
				try { rmdirSync(recovery); } catch (removeError: unknown) { if (["ENOENT", "ENOTEMPTY"].includes((removeError as NodeJS.ErrnoException).code ?? "")) continue; throw removeError; }
			}
		}
		try {
			if (existsSync(file)) live(JSON.parse(readFileSync(file, "utf8")) as Owner);
			publishOwner();
			this.held = true;
		} finally {
			try { unlinkSync(join(recovery, this.owner.token)); } catch { /* crash recovery may have already claimed this entry */ }
			try { rmdirSync(recovery); } catch { /* a delayed reclaimer or next owner owns the directory */ }
		}
	}
	release(): void {
		if (!this.held) return;
		const file = join(this.root, "owner.json");
		if (JSON.parse(readFileSync(file, "utf8")).token === this.owner.token) rmSync(file);
		this.held = false;
	}
	isAcquired(): boolean { return this.held; }
	list(): Batch[] {
		return readdirSync(this.root).filter((name) => /^batch-[a-f0-9-]+\.json$/.test(name)).map((name) => this.read(name.slice(0, -5)));
	}
	read(id: string): Batch {
		if (!/^batch-[a-f0-9-]+$/.test(id)) throw new Error("invalid batch identity");
		const batch = JSON.parse(readFileSync(join(this.root, `${id}.json`), "utf8")) as Omit<Batch, "version"> & { version: number };
		if ((batch.version !== 1 && batch.version !== 2) || batch.id !== id || !Array.isArray(batch.items) || !Number.isSafeInteger(batch.revision)) {
			throw new Error("unsupported or corrupt batch; preserve original state and export for inspection");
		}
		if (!Array.isArray(batch.dependencies) || !Array.isArray(batch.scopeRevisions) || !["paused", "active", "stopped"].includes(batch.control) || !batch.usage || !Number.isSafeInteger(batch.usage.modelCalls) || batch.usage.modelCalls < 0) {
			throw new Error("unsupported or corrupt batch control/state");
		}
		const legacy = batch.version === 1;
		createBatch(batch.items.map((item) => item.selected), { id, capacity: batch.capacity, maxAttempts: batch.maxAttempts, maxTotalAttempts: batch.maxTotalAttempts, mode: batch.mode, dependencies: batch.dependencies });
		for (const item of batch.items) {
			if (!item.selected || !Array.isArray(item.sessions) || !item.sessions.every((session) => typeof session === "string") || !Number.isSafeInteger(item.attempts) || item.attempts < 0 || !["QUEUED", "RUNNING", "VERIFY", "DONE", "BLOCKED", "UNKNOWN", "CANCELLED", "EXCLUDED"].includes(item.stage)) {
				throw new Error("invalid item state; no execution allowed");
			}
			const parsed = validateItemLedger(item, true);
			if (parsed.ok) item.ledger = parsed.ledger;
			if (legacy) {
				if (item.operations !== undefined && !Array.isArray(item.operations)) throw new Error("invalid legacy operation history; preserve original evidence");
				item.operations ??= [];
				if (parsed.ok) migrateLegacyOperation(batch.id, item, parsed.ledger);
				else if (item.operation !== undefined) throw new Error("legacy operation cannot be reconciled without a valid ledger; preserve original evidence");
			} else if (!Array.isArray(item.operations)) {
				throw new Error("version-2 batch is missing operation history; preserve original evidence");
			}
			if (item.operation !== undefined) {
				const parsedOperation = parseOperationReceipt(item.operation);
				if (!parsedOperation.ok) throw new Error(`invalid operation receipt: ${parsedOperation.errors.join("; ")}; preserve original evidence`);
				item.operation = parsedOperation.value;
			}
			item.operations = item.operations.map((operation) => {
				const parsedOperation = parseOperationReceipt(operation);
				if (!parsedOperation.ok) throw new Error(`invalid operation history: ${parsedOperation.errors.join("; ")}; preserve original evidence`);
				return parsedOperation.value;
			});
			if (item.proof && (!Array.isArray(item.proof.artifacts) || !item.proof.artifacts.every((artifact) => typeof artifact === "string") || typeof item.proof.digest !== "string" || typeof item.proof.reviewerSession !== "string" || !["verified-patch", "pr-ready", "merged-upstream"].includes(item.proof.stage))) {
				throw new Error("invalid proof record; no execution allowed");
			}
		}
		batch.version = 2;
		return batch as Batch;
	}
	write(batch: Batch): void {
		if (!this.held || this.failed) throw new Error("Factory persistence is not writable; new effects refused");
		if (!/^batch-[a-f0-9-]+$/.test(batch.id)) throw new Error("invalid batch identity");
		for (const item of batch.items) validateItemLedger(item);
		const file = join(this.root, `${batch.id}.json`);
		if (existsSync(file) && this.read(batch.id).revision !== batch.revision) throw new Error("stale batch revision");
		const next = { ...batch, revision: batch.revision + 1 };
		const temporary = `${file}.${this.owner.token}.tmp`;
		try {
			const fd = openSync(temporary, "wx", 0o600);
			try { writeFileSync(fd, `${JSON.stringify(next)}\n`); fsyncSync(fd); }
			finally { closeSync(fd); }
			renameSync(temporary, file);
			const directory = openSync(this.root, "r");
			try { fsyncSync(directory); } finally { closeSync(directory); }
			batch.revision = next.revision;
		} catch (error) { this.failed = true; throw error; }
	}
	export(id: string, destination: string): string {
		const batch = this.read(id);
		if (batch.items.some((item) => item.stage === "RUNNING" || item.stage === "VERIFY" || item.operation?.state === "intent")) throw new Error("pause and reconcile active work before export");
		const output = resolve(destination);
		const sources = [...new Set(batch.items.flatMap((item) => [item.workspace, ...item.sessions, ...(item.proof?.artifacts ?? [])]).filter((path): path is string => path !== undefined))];
		const inventory = sources.map((source) => {
			const child = inside(this.root, source);
			if (output === source || output.startsWith(`${source}${sep}`)) throw new Error("export destination cannot be inside an owned source");
			return { source, child };
		});
		mkdirSync(output, { mode: 0o700 });
		for (const { source, child } of inventory) {
			const target = join(output, "files", child);
			mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
			cpSync(source, target, { recursive: true, errorOnExist: true, force: false, dereference: false });
		}
		writeFileSync(join(output, `${id}.json`), `${JSON.stringify(batch, null, 2)}\n`, { flag: "wx", mode: 0o600 });
		writeFileSync(join(output, "references.json"), JSON.stringify(inventory, null, 2), { flag: "wx", mode: 0o600 });
		return output;
	}
	discard(id: string): void {
		if (!this.held) throw new Error("acquire Factory writer before disposal");
		const batch = this.read(id);
		if (batch.items.some((item) => item.stage !== "DONE" || item.operation?.state === "unknown" || item.proof?.stage === "verified-patch")) throw new Error("unfinished work or the only unintegrated patch must be retained; export/land it first");
		if (this.list().some((other) => other.id !== id && other.dependencies.some((edge) => batch.items.some((item) => item.selected.key === edge.requires)))) throw new Error("dependency receipts are still required");
		// Archive minimal receipts instead of deleting native sessions or user workspaces.
		mkdirSync(join(this.root, "discarded"), { mode: 0o700, recursive: true });
		renameSync(join(this.root, `${id}.json`), join(this.root, "discarded", `${id}.json`));
		syncDirectory(this.root);
		syncDirectory(join(this.root, "discarded"));
	}
}

/** Same-host resource ownership shared with Review. Claims survive uncertain cancellation. */
interface ClaimRecord { version: 1; resource: string; owner: string; createdAt: string; status: "unknown" | "settled" }
export interface ResourceClaim {
	readonly resource: string;
	readonly owner: string;
	readonly createdAt: string;
	readonly status: "unknown" | "settled";
}
export type ClaimReleaseStatus = "settled" | "unknown";
export class ResourceClaims {
	readonly root: string;
	constructor(stateRoot: string, claimsRoot = join(stateRoot, "claims")) {
		this.root = resolve(claimsRoot);
		mkdirSync(this.root, { recursive: true, mode: 0o700 });
	}
	private file(resource: string): string {
		return join(this.root, `${digest(resource.toLowerCase())}.json`);
	}
	private read(resource: string): ClaimRecord {
		return JSON.parse(readFileSync(this.file(resource), "utf8")) as ClaimRecord;
	}
	claim(resource: string, owner: string, allowExisting = true): void {
		const canonical = resource.toLowerCase();
		const file = this.file(canonical);
		try {
			const fd = openSync(file, "wx", 0o600);
			try {
				writeFileSync(fd, JSON.stringify({ version: 1, resource: canonical, owner, createdAt: new Date().toISOString(), status: "unknown" } satisfies ClaimRecord));
				fsyncSync(fd);
			} finally { closeSync(fd); }
			syncDirectory(this.root);
		}
		catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
			const current = this.read(canonical);
			if (current.owner !== owner) throw new Error(`${resource} is owned by ${current.owner}; inspect/reconcile that work before resuming`);
			if (!allowExisting) throw new Error(`${resource} is already owned by ${current.owner}; inspect/reconcile that work before retrying`);
		}
	}
	list(): ResourceClaim[] {
		return readdirSync(this.root)
			.filter((name) => name.endsWith(".json"))
			.map((name) => JSON.parse(readFileSync(join(this.root, name), "utf8")) as ClaimRecord)
			.map((claim) => ({ resource: claim.resource, owner: claim.owner, createdAt: claim.createdAt, status: claim.status }));
	}
	conflict(resource: string, owner?: string): string | undefined {
		const file = this.file(resource);
		if (!existsSync(file)) return;
		const current = this.read(resource);
		return current.owner === owner ? undefined : `${resource} is owned by ${current.owner}`;
	}
	markSettled(resource: string, owner: string): void {
		const file = this.file(resource);
		if (!existsSync(file)) return;
		const current = this.read(resource);
		if (current.owner !== owner) throw new Error(`${resource} is owned by ${current.owner}; only the logical owner may reconcile it`);
		if (current.status === "settled") return;
		const fd = openSync(file, "w", 0o600);
		try { writeFileSync(fd, JSON.stringify({ ...current, status: "settled" } satisfies ClaimRecord)); fsyncSync(fd); }
		finally { closeSync(fd); }
		syncDirectory(this.root);
	}
	release(resource: string, owner: string, status: ClaimReleaseStatus = "settled"): void {
		if (status === "unknown") return;
		const file = this.file(resource);
		if (existsSync(file) && this.read(resource).owner === owner) rmSync(file);
		syncDirectory(this.root);
	}
	reconcile(resource: string, owner: string): void {
		const file = this.file(resource);
		if (!existsSync(file)) return;
		const current = this.read(resource);
		if (current.owner !== owner) throw new Error(`${resource} is owned by ${current.owner}; only the logical owner may reconcile it`);
		if (current.status !== "settled") throw new Error(`${resource} remains UNKNOWN; authoritative worker/external-effect reconciliation is required before release`);
		this.release(resource, owner);
	}
}
export function factoryClaimsRoot(env: NodeJS.ProcessEnv = process.env): string {
	return resolve(env.LUNA_FACTORY_CLAIMS_ROOT ?? join(env.XDG_STATE_HOME ?? join(env.HOME ?? ".", ".local/state"), "review/mutation-claims"));
}
export function factoryStateRoot(env: NodeJS.ProcessEnv = process.env): string {
	return resolve(env.LUNA_FACTORY_STATE_ROOT ?? join(env.XDG_STATE_HOME ?? join(env.HOME ?? ".", ".local/state"), "review/factory"));
}
