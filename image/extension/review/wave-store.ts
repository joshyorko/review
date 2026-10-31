import { createHash, randomUUID } from "node:crypto";
import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { PersistedRepositoryBatch } from "./extension.ts";
import { isOperatorPolicySnapshot } from "./operator-policy.ts";
import { parseReviewerReceiptState } from "./reviewer-receipts.ts";
import { checkPlanDigest, checkResultsDigest, WRITABLE_EXECUTION_LIMITS } from "./writable-executor.ts";

const digest = (value: string): string => createHash("sha256").update(value).digest("hex");
const filename = (root: string, owner: string): string => join(root, "review-waves", `${digest(owner)}.json`);

function isRecord(value: unknown): value is Record<string, any> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function validWritableChecks(checks: unknown, commands: unknown): boolean {
	if (!Array.isArray(checks) || !Array.isArray(commands) || checks.length > commands.length || checks.length > WRITABLE_EXECUTION_LIMITS.checksPerAttempt) return false;
	let retainedOutputBytes = 0;
	for (let index = 0; index < checks.length; index++) {
		const check = checks[index];
		if (!isRecord(check) || check.command !== commands[index]
			|| !["passed", "failed", "unavailable", "timed-out", "cancelled", "output-limit"].includes(check.status)
			|| check.exitCode !== undefined && !Number.isSafeInteger(check.exitCode)
			|| typeof check.outputDigest !== "string" || !/^[a-f0-9]{64}$/.test(check.outputDigest)
			|| check.status === "passed" && check.exitCode !== 0) return false;
		if (check.stdout !== undefined || check.stderr !== undefined) {
			if (typeof check.stdout !== "string" || typeof check.stderr !== "string") return false;
			const bytes = Buffer.byteLength(check.stdout) + Buffer.byteLength(check.stderr);
			if (bytes > WRITABLE_EXECUTION_LIMITS.outputBytes) return false;
			retainedOutputBytes += bytes;
			if (retainedOutputBytes > WRITABLE_EXECUTION_LIMITS.outputBytes * WRITABLE_EXECUTION_LIMITS.checksPerAttempt) return false;
			const expected = digest(`${check.stdout}\0${check.stderr}\0${check.status}\0${check.exitCode ?? "unknown"}`);
			if (check.outputDigest !== expected) return false;
		}
	}
	return true;
}

function validWritableExecution(value: unknown, batch: any): boolean {
	if (!isRecord(value) || value.version !== 1 || !["running", "submitted", "blocked", "unknown"].includes(value.status)
		|| !["krun", "apptainer"].includes(value.runtimeProfile) || !Number.isFinite(value.startedAt)
		|| value.finishedAt !== undefined && (!Number.isFinite(value.finishedAt) || value.finishedAt < value.startedAt)
		|| typeof value.issueKey !== "string" || !batch.waves[batch.currentWave].items.some((item: any) => item.type === "issue" && `${item.repo.toLowerCase()}#${item.id}` === value.issueKey)) return false;
	if (value.reason !== undefined && (typeof value.reason !== "string" || value.reason.length > 8192)) return false;
	if (value.baseRef !== undefined && (typeof value.baseRef !== "string" || !value.baseRef || value.baseRef.length > 255)) return false;
	if (value.baseSha !== undefined && (typeof value.baseSha !== "string" || !/^[a-f0-9]{40}$/.test(value.baseSha))) return false;
	if ((value.baseRef === undefined) !== (value.baseSha === undefined)) return false;
	if (value.candidateDigest !== undefined && (typeof value.candidateDigest !== "string" || !/^[a-f0-9]{64}$/.test(value.candidateDigest))) return false;
	if (value.checksDigest !== undefined && (typeof value.checksDigest !== "string" || !/^[a-f0-9]{64}$/.test(value.checksDigest))) return false;
	if (value.workspaceId !== undefined && (typeof value.workspaceId !== "string" || !/^[a-f0-9-]{36}$/i.test(value.workspaceId))) return false;
	if (value.commands !== undefined && (!Array.isArray(value.commands) || value.commands.length < 1 || value.commands.length > WRITABLE_EXECUTION_LIMITS.checksPerAttempt
		|| !value.commands.every((command: unknown) => typeof command === "string" && command.trim() && Buffer.byteLength(command) <= WRITABLE_EXECUTION_LIMITS.commandBytes))) return false;
	if (value.checks !== undefined && !validWritableChecks(value.checks, value.commands)) return false;
	if (value.proof !== undefined) {
		const proof = value.proof;
		try {
			if (!isRecord(proof) || proof.version !== 1 || proof.repository !== value.issueKey.split("#")[0]
				|| proof.issueNumber !== Number(value.issueKey.split("#")[1]) || proof.baseRef !== value.baseRef || proof.baseSha !== value.baseSha
				|| proof.candidateDigest !== value.candidateDigest || proof.checksDigest !== value.checksDigest
				|| typeof proof.planDigest !== "string" || !/^[a-f0-9]{64}$/.test(proof.planDigest)
				|| proof.runtimeProfile !== value.runtimeProfile || !Number.isFinite(proof.verifiedAt)
				|| !Array.isArray(proof.checks) || !value.commands || proof.checks.length !== value.commands.length
				|| proof.checks.some((check: any, index: number) => !isRecord(check) || check.command !== value.commands[index] || check.exitCode !== 0
					|| typeof check.outputDigest !== "string" || !/^[a-f0-9]{64}$/.test(check.outputDigest))
				|| checkPlanDigest(value.commands).length !== 64 || checkResultsDigest(proof.checks) !== value.checksDigest) return false;
		} catch { return false; }
	}
	if (value.pullRequest !== undefined) {
		const pr = value.pullRequest;
		if (value.status !== "submitted" || !isRecord(pr) || !Number.isSafeInteger(pr.number) || pr.number < 1
			|| typeof pr.url !== "string" || !/^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/pull\/[1-9][0-9]*$/.test(pr.url)
			|| typeof pr.branch !== "string" || !/^review\/issue-[1-9][0-9]*-[a-f0-9]{12}$/.test(pr.branch)
			|| typeof pr.headSha !== "string" || !/^[a-f0-9]{40}$/.test(pr.headSha)
			|| typeof pr.baseRef !== "string" || !pr.baseRef || typeof pr.baseSha !== "string" || !/^[a-f0-9]{40}$/.test(pr.baseSha)
			|| typeof pr.observed !== "boolean" || !value.candidateDigest || !value.proof
			|| pr.branch !== `review/issue-${Number(value.issueKey.split("#")[1])}-${value.candidateDigest.slice(0, 12)}`) return false;
	}
	if (value.status === "submitted" && !value.pullRequest) return false;
	return true;
}

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
			|| batch.issueDispatchPromptedKeys !== undefined || batch.issueTaskAssignments !== undefined || batch.issueWorkerReceipts !== undefined || batch.issuePrReadiness !== undefined)) return;
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
			if (batch.issueDispatchPromptedKeys !== undefined && (!Array.isArray(batch.issueDispatchPromptedKeys)
				|| !batch.issueDispatchPromptedKeys.every((key: unknown) => typeof key === "string" && keys.has(key)))) return;
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
						|| typeof receipt.pullRequest.branch !== "string" || !receipt.pullRequest.branch.trim() || typeof receipt.pullRequest.baseRef !== "string" || !receipt.pullRequest.baseRef.trim()
						|| typeof receipt.pullRequest.baseSha !== "string" || !/^[a-f0-9]{40}$/.test(receipt.pullRequest.baseSha)
						|| typeof receipt.pullRequest.headSha !== "string" || !/^[a-f0-9]{40}$/.test(receipt.pullRequest.headSha))))) return;
			if (batch.issuePrReadiness !== undefined && (!batch.issuePrReadiness || typeof batch.issuePrReadiness !== "object" || Array.isArray(batch.issuePrReadiness)
				|| Object.entries(batch.issuePrReadiness).some(([key, readiness]) => !keys.has(key) || readiness.issueKey !== key
					|| !["unknown", "waiting", "repair-required", "repairing", "review-required", "ready"].includes(readiness.state)
					|| !Number.isFinite(readiness.admittedAt) || !Number.isFinite(readiness.deadlineAt) || readiness.deadlineAt !== batch.issuePrDeadlineAt
					|| !Number.isSafeInteger(readiness.observationCount) || readiness.observationCount < 0 || readiness.observationCount > 100
					|| !Number.isSafeInteger(readiness.repairCount) || readiness.repairCount < 0 || readiness.repairCount > batch.issuePrRepairLimit
					|| readiness.nextObservationAt !== undefined && !Number.isFinite(readiness.nextObservationAt)
					|| readiness.repairPromptSentAt !== undefined && !Number.isFinite(readiness.repairPromptSentAt)
					|| readiness.reviewerPromptSentAt !== undefined && !Number.isFinite(readiness.reviewerPromptSentAt)
					|| readiness.reviewerDeadlineAt !== undefined && !Number.isFinite(readiness.reviewerDeadlineAt)
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
		if (batch.writableExecution !== undefined && (batch.version !== 2 || !validWritableExecution(batch.writableExecution, batch))) return;
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
