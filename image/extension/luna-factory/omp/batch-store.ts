import { closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { digest, type Batch } from "../core/batch.ts";
import { parseJournal } from "../core/journal.ts";

interface Owner { host: string; pid: number; start: string; token: string }
function processStart(pid: number): string {
	try { return readFileSync(`/proc/${pid}/stat`, "utf8").split(") ")[1]!.split(" ")[19]!; }
	catch { return "unavailable"; }
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
		mkdirSync(recovery, { mode: 0o700 });
		try {
			const file = join(this.root, "owner.json");
			if (existsSync(file)) {
				const previous = JSON.parse(readFileSync(file, "utf8")) as Owner;
				if (previous.host !== hostname()) throw new Error("Factory supports one same-host local state root, not shared/network storage");
				if (previous.start === "unavailable" || processStart(previous.pid) === previous.start) throw new Error(`Factory state is owned by process ${previous.pid}; attach with status, do not start a second writer`);
				rmSync(file);
			}
			const fd = openSync(file, "wx", 0o600);
			try { writeFileSync(fd, JSON.stringify(this.owner)); fsyncSync(fd); }
			finally { closeSync(fd); }
			this.held = true;
		} finally { rmSync(recovery, { recursive: true }); }
	}
	release(): void {
		if (!this.held) return;
		const file = join(this.root, "owner.json");
		if (JSON.parse(readFileSync(file, "utf8")).token === this.owner.token) rmSync(file);
		this.held = false;
	}
	list(): Batch[] {
		return readdirSync(this.root).filter((name) => /^batch-[a-f0-9-]+\.json$/.test(name)).map((name) => this.read(name.slice(0, -5)));
	}
	read(id: string): Batch {
		if (!/^batch-[a-f0-9-]+$/.test(id)) throw new Error("invalid batch identity");
		const batch = JSON.parse(readFileSync(join(this.root, `${id}.json`), "utf8")) as Batch;
		if (batch.version !== 1 || batch.id !== id || !Array.isArray(batch.items) || !Number.isSafeInteger(batch.revision)) throw new Error("unsupported or corrupt batch; preserve original state and export for inspection");
		for (const item of batch.items) {
			if (!item.selected || !Array.isArray(item.sessions) || !Number.isSafeInteger(item.attempts)) throw new Error("invalid item state; no execution allowed");
			const parsed = parseJournal(item.ledger);
			if (!parsed.ok) throw new Error("invalid item ledger; original state preserved");
		}
		return batch;
	}
	write(batch: Batch): void {
		if (!this.held || this.failed) throw new Error("Factory persistence is not writable; new effects refused");
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
		const output = resolve(destination);
		mkdirSync(output, { mode: 0o700 });
		writeFileSync(join(output, `${id}.json`), `${JSON.stringify(batch, null, 2)}\n`, { flag: "wx", mode: 0o600 });
		// Export is a receipt inventory, not permission to remove the only workspace/patch.
		writeFileSync(join(output, "references.json"), JSON.stringify(batch.items.map((item) => ({ key: item.selected.key, workspace: item.workspace, sessions: item.sessions, artifacts: item.proof?.artifacts })), null, 2), { flag: "wx", mode: 0o600 });
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
	}
}

/** Same-host resource ownership shared with Review. Claims survive uncertain cancellation. */
export class ResourceClaims {
	constructor(readonly root: string) { mkdirSync(join(root, "claims"), { recursive: true, mode: 0o700 }); }
	claim(resource: string, owner: string): void {
		const file = join(this.root, "claims", `${digest(resource.toLowerCase())}.json`);
		try { writeFileSync(file, JSON.stringify({ resource: resource.toLowerCase(), owner }), { flag: "wx", mode: 0o600 }); }
		catch (error) {
			if (!existsSync(file)) throw error;
			const current = JSON.parse(readFileSync(file, "utf8"));
			if (current.owner !== owner) throw new Error(`${resource} is owned by ${current.owner}; inspect/reconcile that work before resuming`);
		}
	}
	conflict(resource: string, owner?: string): string | undefined {
		const file = join(this.root, "claims", `${digest(resource.toLowerCase())}.json`);
		if (!existsSync(file)) return;
		const current = JSON.parse(readFileSync(file, "utf8"));
		return current.owner === owner ? undefined : `${resource} is owned by ${current.owner}`;
	}
	release(resource: string, owner: string): void {
		const file = join(this.root, "claims", `${digest(resource.toLowerCase())}.json`);
		if (existsSync(file) && JSON.parse(readFileSync(file, "utf8")).owner === owner) rmSync(file);
	}
}
export function factoryStateRoot(env: NodeJS.ProcessEnv = process.env): string {
	return resolve(env.LUNA_FACTORY_STATE_ROOT ?? join(env.XDG_STATE_HOME ?? join(env.HOME ?? ".", ".local/state"), "review/factory"));
}
