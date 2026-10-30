import { createHash, randomUUID } from "node:crypto";
import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { PersistedRepositoryBatch } from "./extension.ts";
import { isOperatorPolicySnapshot } from "./operator-policy.ts";
import { parseReviewerReceiptState } from "./reviewer-receipts.ts";

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
		if (![1, 2].includes(batch.version) || typeof batch.id !== "string" || !Number.isInteger(batch.currentWave)
			|| owner !== `review:${batch.id}:${batch.currentWave}` || batch.waveIdentity !== `${batch.id}:${batch.currentWave}`
			|| !["running", "paused", "blocked", "cancelled"].includes(batch.state)
			|| !["slay", "fix", "diff"].includes(batch.kind) || !Array.isArray(batch.waves)
			|| !batch.waves[batch.currentWave]?.items?.length) return;
		if (batch.version === 1 && (batch.issueOutcome !== undefined || batch.issuePrDeadlineAt !== undefined || batch.issuePrRepairLimit !== undefined
			|| batch.issueTaskAssignments !== undefined || batch.issueWorkerReceipts !== undefined || batch.issuePrReadiness !== undefined)) return;
		if (batch.version === 2 && (batch.issueOutcome !== "pr-ready" || batch.kind === "diff"
			|| !Number.isFinite(batch.issuePrDeadlineAt) || !Number.isSafeInteger(batch.issuePrRepairLimit) || batch.issuePrRepairLimit < 1 || batch.issuePrRepairLimit > 3
			|| !batch.waves.every((wave: { items?: Array<{ type?: string }> }) => Array.isArray(wave.items) && wave.items.length > 0 && wave.items.every((item) => item.type === "issue")))) return;
		if (batch.version === 2) {
			const issues = batch.waves[batch.currentWave].items as Array<{ type: string; repo: string; id: number }>;
			const keys = new Set(issues.map((item) => `${item.repo.toLowerCase()}#${item.id}`));
			if (batch.issueTaskAssignments !== undefined && (!batch.issueTaskAssignments || typeof batch.issueTaskAssignments !== "object" || Array.isArray(batch.issueTaskAssignments)
				|| Object.entries(batch.issueTaskAssignments).some(([key, assignment]) => !keys.has(key) || assignment.issueKey !== key
					|| typeof assignment.toolCallId !== "string" || !assignment.toolCallId || typeof assignment.agentId !== "string" || !assignment.agentId
					|| typeof assignment.assignmentDigest !== "string" || !/^[a-f0-9]{64}$/.test(assignment.assignmentDigest)
					|| !Number.isSafeInteger(assignment.attempt) || assignment.attempt < 0 || assignment.attempt > batch.issuePrRepairLimit
					|| assignment.jobId !== undefined && (typeof assignment.jobId !== "string" || !assignment.jobId)))) return;
			if (batch.issueWorkerReceipts !== undefined && (!batch.issueWorkerReceipts || typeof batch.issueWorkerReceipts !== "object" || Array.isArray(batch.issueWorkerReceipts)
				|| Object.entries(batch.issueWorkerReceipts).some(([key, receipt]) => !keys.has(key) || receipt.issueKey !== key
					|| typeof receipt.toolCallId !== "string" || !receipt.toolCallId || typeof receipt.agentId !== "string" || !receipt.agentId
					|| receipt.jobId !== undefined && (typeof receipt.jobId !== "string" || !receipt.jobId)
					|| typeof receipt.assignmentDigest !== "string" || !/^[a-f0-9]{64}$/.test(receipt.assignmentDigest)
					|| typeof receipt.resultDigest !== "string" || !/^[a-f0-9]{64}$/.test(receipt.resultDigest) || !Number.isFinite(receipt.deliveredAt)
					|| !Number.isSafeInteger(receipt.attempt) || receipt.attempt < 0 || receipt.attempt > batch.issuePrRepairLimit
					|| !["pr-ready", "blocked"].includes(receipt.outcome) || !Array.isArray(receipt.checks) || receipt.checks.length > 64
					|| receipt.checks.some((check: { command?: unknown; exitCode?: unknown }) => typeof check.command !== "string" || !check.command.trim() || check.command.length > 4096 || !Number.isInteger(check.exitCode))
					|| !receipt.acceptance || typeof receipt.acceptance.summary !== "string" || receipt.acceptance.summary.length > 4096
					|| !Array.isArray(receipt.acceptance.criteria) || receipt.acceptance.criteria.length > 100
					|| receipt.acceptance.criteria.some((criterion: { id?: unknown; evidence?: unknown }) => typeof criterion.id !== "string" || !criterion.id.trim() || criterion.id.length > 256 || typeof criterion.evidence !== "string" || !criterion.evidence.trim() || criterion.evidence.length > 4096)
					|| receipt.outcome === "pr-ready" && (!receipt.pullRequest || !Number.isSafeInteger(receipt.pullRequest.number) || receipt.pullRequest.number < 1
						|| typeof receipt.pullRequest.url !== "string" || !/^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/pull\/[1-9][0-9]*$/.test(receipt.pullRequest.url)
						|| typeof receipt.pullRequest.headSha !== "string" || !/^[a-f0-9]{40}$/.test(receipt.pullRequest.headSha))))) return;
			if (batch.issuePrReadiness !== undefined && (!batch.issuePrReadiness || typeof batch.issuePrReadiness !== "object" || Array.isArray(batch.issuePrReadiness)
				|| Object.entries(batch.issuePrReadiness).some(([key, readiness]) => !keys.has(key) || readiness.issueKey !== key
					|| !["unknown", "waiting", "repair-required", "repairing", "ready"].includes(readiness.state)
					|| !Number.isFinite(readiness.admittedAt) || !Number.isFinite(readiness.deadlineAt) || readiness.deadlineAt !== batch.issuePrDeadlineAt
					|| !Number.isSafeInteger(readiness.repairCount) || readiness.repairCount < 0 || readiness.repairCount > batch.issuePrRepairLimit
					|| readiness.nextObservationAt !== undefined && !Number.isFinite(readiness.nextObservationAt)
					|| readiness.repairPromptSentAt !== undefined && !Number.isFinite(readiness.repairPromptSentAt)
					|| readiness.reason !== undefined && (typeof readiness.reason !== "string" || readiness.reason.length > 8192)
					|| readiness.failureKey !== undefined && (typeof readiness.failureKey !== "string" || !/^[a-f0-9]{64}$/.test(readiness.failureKey))
					|| readiness.workerReceiptDigest !== undefined && (typeof readiness.workerReceiptDigest !== "string" || !/^[a-f0-9]{64}$/.test(readiness.workerReceiptDigest))
					|| readiness.pullRequest !== undefined && (!readiness.pullRequest || typeof readiness.pullRequest.repo !== "string" || typeof readiness.pullRequest.number !== "number" || !Number.isSafeInteger(readiness.pullRequest.number)
						|| typeof readiness.pullRequest.url !== "string" || typeof readiness.pullRequest.nodeId !== "string" || typeof readiness.pullRequest.branch !== "string"
						|| typeof readiness.pullRequest.headSha !== "string" || !/^[a-f0-9]{40}$/.test(readiness.pullRequest.headSha)
						|| typeof readiness.pullRequest.baseRef !== "string" || typeof readiness.pullRequest.baseSha !== "string" || !/^[a-f0-9]{40}$/.test(readiness.pullRequest.baseSha)
						|| readiness.pullRequest.mergeSha !== undefined && (typeof readiness.pullRequest.mergeSha !== "string" || !/^[a-f0-9]{40}$/.test(readiness.pullRequest.mergeSha)))
					|| readiness.observation !== undefined && (!readiness.observation || !["pending", "failed", "unknown", "passed"].includes(readiness.observation.result)
						|| !["complete", "incomplete", "unavailable"].includes(readiness.observation.coverage) || !Number.isFinite(Date.parse(readiness.observation.observedAt))
						|| typeof readiness.observation.headSha !== "string" || !/^[a-f0-9]{40}$/.test(readiness.observation.headSha))
					|| readiness.state === "ready" && (!readiness.pullRequest || !readiness.workerReceiptDigest || readiness.observation?.result !== "passed" && readiness.reason !== "no-required-checks-with-local-acceptance")))) return;
		}
		if (batch.waveSessionId !== undefined && (typeof batch.waveSessionId !== "string" || !batch.waveSessionId)) return;
		if (batch.waveOperatorPolicy !== undefined && (!isOperatorPolicySnapshot(batch.waveOperatorPolicy) || batch.waveOperatorPolicy.repository !== batch.waves[batch.currentWave].repo.toLowerCase())) return;
		if (batch.waveReviewerReceipts !== undefined && !parseReviewerReceiptState(batch.waveReviewerReceipts)) return;
		if (batch.waveWriterAgents !== undefined && (!Array.isArray(batch.waveWriterAgents) || !batch.waveWriterAgents.every((id: unknown) => typeof id === "string" && id.length > 0))) return;
		if (batch.waveLandingHeads !== undefined && (!batch.waveLandingHeads || typeof batch.waveLandingHeads !== "object" || Array.isArray(batch.waveLandingHeads) || Object.entries(batch.waveLandingHeads).some(([key, value]) => !batch.waves[batch.currentWave].items.some((item: { repo: string; id: number }) => `${item.repo.toLowerCase()}#${item.id}` === key) || typeof value !== "string" || !/^[a-f0-9]{40}$/.test(value)))) return;
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
