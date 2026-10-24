import { createHash, randomUUID } from "node:crypto";
import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { PersistedRepositoryBatch } from "./extension.ts";

const digest = (value: string): string => createHash("sha256").update(value).digest("hex");
const filename = (root: string, owner: string): string => join(root, "review-waves", `${digest(owner)}.json`);

/** One durable record per claim owner, independent of the OMP branch projection. */
export function saveWave(root: string, batch: PersistedRepositoryBatch): void {
	if (!batch.waveIdentity || batch.waveIdentity !== `${batch.id}:${batch.currentWave}`) return;
	const owner = `review:${batch.waveIdentity}`;
	const directory = join(root, "review-waves");
	mkdirSync(directory, { recursive: true, mode: 0o700 });
	const payload = JSON.stringify(batch);
	const target = filename(root, owner);
	const temporary = `${target}.${randomUUID()}.tmp`;
	const fd = openSync(temporary, "wx", 0o600);
	try { writeFileSync(fd, JSON.stringify({ owner, payload, digest: digest(payload) })); fsyncSync(fd); }
	finally { closeSync(fd); }
	renameSync(temporary, target);
	const directoryFd = openSync(directory, "r");
	try { fsyncSync(directoryFd); } finally { closeSync(directoryFd); }
}

/** Corrupt/missing records cannot authorize release. Claims remain fenced. */
export function loadWave(root: string, owner: string): PersistedRepositoryBatch | undefined {
	try {
		const record = JSON.parse(readFileSync(filename(root, owner), "utf8"));
		if (record.owner !== owner || typeof record.payload !== "string" || digest(record.payload) !== record.digest) return;
		const batch = JSON.parse(record.payload);
		if (batch.version !== 1 || typeof batch.id !== "string" || !Number.isInteger(batch.currentWave)
			|| owner !== `review:${batch.id}:${batch.currentWave}` || batch.waveIdentity !== `${batch.id}:${batch.currentWave}`
			|| !["running", "paused", "blocked", "cancelled"].includes(batch.state)
			|| !["slay", "fix", "diff"].includes(batch.kind) || !Array.isArray(batch.waves)
			|| !batch.waves[batch.currentWave]?.items?.length) return;
		if (batch.waveSessionId !== undefined && (typeof batch.waveSessionId !== "string" || !batch.waveSessionId)) return;
		if (batch.waveExit !== undefined) {
			const exit = batch.waveExit;
			if (!exit || typeof exit.sessionId !== "string" || !exit.sessionId || typeof exit.waveIdentity !== "string" || !exit.waveIdentity || exit.sessionId !== batch.waveSessionId || exit.waveIdentity !== batch.waveIdentity
				|| !["pause", "cancel"].includes(exit.choice) || !Number.isFinite(exit.requestedAt)) return;
		}
		if (batch.waveShutdown !== undefined) {
			const receipt = batch.waveShutdown;
			if (!receipt || !batch.waveExit || typeof receipt.sessionId !== "string" || !receipt.sessionId || typeof receipt.waveIdentity !== "string" || !receipt.waveIdentity || receipt.sessionId !== batch.waveSessionId || receipt.waveIdentity !== batch.waveIdentity
				|| typeof receipt.settled !== "boolean" || !Array.isArray(receipt.pendingJobIds)
				|| !receipt.pendingJobIds.every((id: unknown) => typeof id === "string")
				|| (receipt.settled && receipt.pendingJobIds.length > 0) || !Number.isFinite(receipt.observedAt)
				|| (receipt.reason !== undefined && typeof receipt.reason !== "string")) return;
		}
		return batch;
	} catch { return undefined; }
}
