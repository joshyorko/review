import { open as openAsync } from "node:fs/promises";
import { constants, closeSync, cpSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, rmdirSync, unlinkSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { evaluateWorkGraph } from "../core/graph.ts";
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
		return this.decode(id, readFileSync(join(this.root, `${id}.json`), "utf8"));
	}
	/** Async bounded reconstruction keeps the native loading screen responsive. */
	async readAsync(id: string): Promise<Batch> {
		if (!/^batch-[a-f0-9-]+$/.test(id)) throw new Error("invalid batch identity");
		const file = await openAsync(join(this.root, `${id}.json`), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
		try {
			const stat = await file.stat();
			// Atomic replacement can unlink this already-open snapshot. Reject hard links, not that valid old inode.
			if (!stat.isFile() || stat.nlink > 1 || stat.size > 32 * 1024 * 1024) throw new Error("batch preview requires a regular file under 32 MiB; preserve original evidence for inspection");
			const buffer = Buffer.alloc(stat.size + 1);
			let count = 0;
			while (count < buffer.length) {
				const { bytesRead } = await file.read(buffer, count, buffer.length - count, count);
				if (bytesRead === 0) break;
				count += bytesRead;
			}
			if (count > stat.size) throw new Error("batch changed while reading; reopen to read its current revision");
			return this.decode(id, buffer.subarray(0, count).toString("utf8"));
		} finally { await file.close(); }
	}
	private decode(id: string, contents: string): Batch {
		const batch = JSON.parse(contents) as Omit<Batch, "version"> & { version: number };
		if ((batch.version !== 1 && batch.version !== 2 && batch.version !== 3 && batch.version !== 4) || batch.id !== id || !Array.isArray(batch.items) || !Number.isSafeInteger(batch.revision)) {
			throw new Error("unsupported or corrupt batch; preserve original state and export for inspection");
		}
		if (!Array.isArray(batch.dependencies) || !Array.isArray(batch.scopeRevisions) || !["paused", "active", "stopped"].includes(batch.control) || !batch.usage || !Number.isSafeInteger(batch.usage.modelCalls) || batch.usage.modelCalls < 0) {
			throw new Error("unsupported or corrupt batch control/state");
		}
		const legacy = batch.version === 1;
		if (batch.version === 3) {
			if (!batch.convergence || batch.convergence.generation !== "G1") throw new Error("version-3 convergence contract is unreadable; preserve original state");
			if (batch.convergence.observation) {
				if (batch.convergence.observation.nodes.length > 42 || batch.convergence.observation.relations.length > 512) throw new Error("convergence observation exceeds its bounded contract");
				evaluateWorkGraph(batch.convergence.observation);
			}
		} else if (batch.convergence !== undefined) throw new Error("old selected batch cannot acquire convergence authority implicitly");
		createBatch(batch.items.map((item) => item.selected), { id, capacity: batch.capacity, maxAttempts: batch.maxAttempts, maxTotalAttempts: batch.maxTotalAttempts, mode: batch.mode, dependencies: batch.dependencies, converge: batch.version === 3 });
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
			if (item.checkScripts !== undefined && (typeof item.checkScripts !== "string" || item.checkScripts.length > 131072)) throw new Error("invalid captured package check definition");
			if (item.preparation && (!["clone", "checkout", "ready"].includes(item.preparation.phase) || item.preparation.owner !== `${batch.id}:${item.selected.key}` || item.preparation.head !== item.selected.head)) throw new Error("invalid workspace preparation evidence; preserve original state");
			if (item.settlement && (item.settlement.outcome !== "cancelled" || typeof item.settlement.attemptId !== "string" || !Array.isArray(item.settlement.sessionFiles) || !item.settlement.sessionFiles.every((path) => typeof path === "string" && item.sessions.includes(path)))) throw new Error("invalid native settlement evidence; preserve original state");
			if (item.repair && (typeof item.repair.generation !== "string" || typeof item.repair.head !== "string" || typeof item.repair.acceptanceRevision !== "string" || typeof item.repair.attemptId !== "string" || typeof item.repair.reason !== "string" || item.repair.reason.length > 32768 || !Array.isArray(item.repair.artifacts) || !item.repair.artifacts.every((artifact) => typeof artifact.id === "string" && typeof artifact.path === "string" && typeof artifact.digest === "string" && /^[a-f0-9]{64}$/.test(artifact.digest) && Number.isSafeInteger(artifact.bytes) && artifact.bytes >= 0 && typeof artifact.attemptId === "string"))) throw new Error("invalid repair evidence; preserve original state");
			if (item.proof && (!Array.isArray(item.proof.artifacts) || !item.proof.artifacts.every((artifact) => typeof artifact === "string") || typeof item.proof.digest !== "string" || typeof item.proof.reviewerSession !== "string" || !["verified-patch", "pr-ready", "merged-upstream"].includes(item.proof.stage))) {
				throw new Error("invalid proof record; no execution allowed");
			}
			if (batch.version < 4 && item.prLifecycle !== undefined) throw new Error("legacy retained batch cannot acquire owned-PR lifecycle authority during decode");
			if (batch.version === 4 && item.operation && ["push", "pr"].includes(item.operation.phase) && !item.prLifecycle) throw new Error("version-4 publication is missing its admitted owned-PR lifecycle");
			if (item.prLifecycle) {
				const lifecycle = item.prLifecycle;
				if (batch.version !== 4 || item.selected.action !== "pr-ready" || lifecycle.version !== 1 || lifecycle.generation !== item.ledger.generation ||
					lifecycle.owner !== `${batch.id}:${item.selected.key}` || lifecycle.outcome !== "pr-ready" || !lifecycle.target ||
					typeof lifecycle.target.ref !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(lifecycle.target.ref) || lifecycle.target.ref.includes("..") ||
					!/^([a-f0-9]{40}|[a-f0-9]{64})$/.test(lifecycle.target.sha) ||
					!["admitted", "published", "waiting", "repair-required", "repairing", "unknown", "ready"].includes(lifecycle.phase) ||
					!Number.isSafeInteger(lifecycle.observationCount) || lifecycle.observationCount < 0 || lifecycle.observationCount > 100 ||
					!Number.isFinite(Date.parse(lifecycle.deadlineAt)) ||
					!["publish", "observe-after", "repair", "repair-review", "investigate", "pr-ready"].includes(lifecycle.nextSafeAction)) {
					throw new Error("invalid owned-PR lifecycle identity or limits; preserve original state");
				}
				if (lifecycle.pullRequest && (lifecycle.phase === "admitted" || lifecycle.pullRequest.repository.toLowerCase() !== item.selected.repo ||
					!lifecycle.pullRequest.identity || !Number.isSafeInteger(lifecycle.pullRequest.number) || lifecycle.pullRequest.number < 1 ||
					lifecycle.pullRequest.url.toLowerCase() !== `https://github.com/${item.selected.repo}/pull/${lifecycle.pullRequest.number}` ||
					!/^factory\/batch-[a-f0-9-]+\/[1-9][0-9]*$/.test(lifecycle.pullRequest.branch) || !/^([a-f0-9]{40}|[a-f0-9]{64})$/.test(lifecycle.pullRequest.headSha) ||
					lifecycle.pullRequest.baseRef === undefined || lifecycle.pullRequest.baseRef !== lifecycle.target.ref || lifecycle.pullRequest.baseSha !== lifecycle.target.sha ||
					lifecycle.pullRequest.mergeSha !== undefined && !/^([a-f0-9]{40}|[a-f0-9]{64})$/.test(lifecycle.pullRequest.mergeSha) || !lifecycle.pullRequest.operationId)) {
					throw new Error("owned PR identity contradicts its operation or target; preserve original state");
				}
				if (lifecycle.observation) {
					const observation = lifecycle.observation;
					const eligible = observation.eligibleSubject;
					const invalidWorkflow = (workflow: NonNullable<typeof observation.runs[number]["workflow"]>): boolean =>
						!Number.isSafeInteger(workflow.id) || !Number.isSafeInteger(workflow.attempt) || workflow.attempt < 1 || !Number.isSafeInteger(workflow.workflowId) ||
						workflow.checkSuiteId < 1 || typeof workflow.event !== "string" || typeof workflow.path !== "string" || !["queued", "in_progress", "completed"].includes(workflow.status) ||
						(workflow.conclusion !== null && typeof workflow.conclusion !== "string");
					const invalidFailure = (failure: NonNullable<typeof observation.failures>[number]): boolean => {
						if (!/^[a-f0-9]{64}$/.test(failure.key) || failure.candidateHead !== observation.headSha || failure.checkSubjectSha !== eligible?.sha || !Number.isSafeInteger(failure.checkRun.id) || !Number.isSafeInteger(failure.checkRun.suiteId) ||
							failure.checkRun.conclusion !== "failure" || !Number.isSafeInteger(failure.checkRun.appId) || typeof failure.checkRun.name !== "string" ||
							typeof failure.checkRun.title !== "string" || failure.checkRun.title.length > 16_384 || typeof failure.checkRun.summary !== "string" || failure.checkRun.summary.length > 32_768 ||
							typeof failure.checkRun.text !== "string" || failure.checkRun.text.length > 32_768 || failure.checkRun.outputTruncated !== false || !failure.annotationsComplete ||
							!Array.isArray(failure.annotations) || failure.annotations.length > 100 || failure.annotations.some((annotation) => typeof annotation.path !== "string" ||
								annotation.startLine !== null && !Number.isSafeInteger(annotation.startLine) || annotation.endLine !== null && !Number.isSafeInteger(annotation.endLine) ||
								typeof annotation.level !== "string" || typeof annotation.title !== "string" || typeof annotation.message !== "string" || annotation.message.length > 8_192)) return true;
						const workflow = failure.workflow;
						return workflow !== undefined && (!Number.isSafeInteger(workflow.id) || !Number.isSafeInteger(workflow.attempt) || workflow.attempt < 1 || !Number.isSafeInteger(workflow.workflowId) ||
							typeof workflow.event !== "string" || typeof workflow.path !== "string" || !Array.isArray(workflow.jobs) || workflow.jobs.length > 100 || workflow.jobs.some((job) => {
								if (!Number.isSafeInteger(job.id) || typeof job.name !== "string" || job.conclusion !== null && typeof job.conclusion !== "string" || !Array.isArray(job.steps) || job.steps.length > 100 ||
									job.logStatus !== null && ![200, 302, 404].includes(job.logStatus) || job.logsAvailable !== null && typeof job.logsAvailable !== "boolean" ||
									job.conclusion === "failure" && (typeof job.logContent !== "string" || !job.logContent.trim() || Buffer.byteLength(job.logContent) > 256 * 1024 || job.logBytes !== Buffer.byteLength(job.logContent) || job.logComplete !== true || job.logTruncated !== false || job.logsAvailable !== true)) return true;
								return job.steps.some((step) => !Number.isSafeInteger(step.number) || typeof step.name !== "string" || step.conclusion !== null && typeof step.conclusion !== "string");
							}));
					};
					if (!Number.isFinite(Date.parse(observation.observedAt)) || observation.headSha !== lifecycle.pullRequest?.headSha || observation.mergeSha !== lifecycle.pullRequest?.mergeSha ||
						observation.policyFingerprint !== undefined && !/^[a-f0-9]{64}$/.test(observation.policyFingerprint) ||
						!Array.isArray(observation.policy) || observation.policy.length > 100 ||
						!observation.policy.every((check) => typeof check.context === "string" && check.context.length > 0 && (check.appId === null || Number.isSafeInteger(check.appId)) &&
							["classic", "ruleset"].includes(check.source) && (check.source !== "ruleset" || Number.isSafeInteger(check.rulesetId))) ||
						eligible !== undefined && (!/^([a-f0-9]{40}|[a-f0-9]{64})$/.test(eligible.sha) || !["head", "merge"].includes(eligible.subject) || eligible.subject === "head" && eligible.sha !== observation.headSha || eligible.subject === "merge" && eligible.sha !== observation.mergeSha) ||
						!Array.isArray(observation.runs) || observation.runs.length > 200 ||
						!observation.runs.every((run) => Number.isSafeInteger(run.id) && Number.isSafeInteger(run.suiteId) && (run.appId === null || Number.isSafeInteger(run.appId)) &&
							(run.appSlug === null || typeof run.appSlug === "string") && typeof run.name === "string" && /^([a-f0-9]{40}|[a-f0-9]{64})$/.test(run.headSha) && ["queued", "in_progress", "completed"].includes(run.status) &&
							(run.conclusion === null || typeof run.conclusion === "string") && Number.isFinite(Date.parse(run.createdAt)) && (run.startedAt === null || Number.isFinite(Date.parse(run.startedAt))) && ["head", "merge"].includes(run.subject) &&
							(run.subject === "head" ? run.headSha === observation.headSha : observation.mergeSha !== undefined && run.headSha === observation.mergeSha) && (run.workflow === undefined || !invalidWorkflow(run.workflow))) ||
						observation.retryAfter !== undefined && !Number.isFinite(Date.parse(observation.retryAfter)) ||
						observation.result === "failed" && (!Array.isArray(observation.failures) || observation.failures.length === 0) ||
						observation.failures !== undefined && (!Array.isArray(observation.failures) || observation.failures.length === 0 || observation.failures.length > 20 || observation.result !== "failed" || !eligible || observation.failures.some(invalidFailure)) ||
						!["complete", "incomplete", "unavailable"].includes(observation.coverage) || !["pending", "failed", "unknown", "passed"].includes(observation.result)) throw new Error("invalid hosted-check observation; preserve original state");
				}
				if (lifecycle.observedAt !== undefined && !Number.isFinite(Date.parse(lifecycle.observedAt)) || lifecycle.nextObservationAt !== undefined && !Number.isFinite(Date.parse(lifecycle.nextObservationAt))) throw new Error("invalid hosted-check observation schedule");
				if (lifecycle.repair && (!/^[a-f0-9]{64}$/.test(lifecycle.repair.failureKey) || lifecycle.repair.candidateHead !== lifecycle.pullRequest?.headSha || !Array.isArray(lifecycle.repair.runIds) || !lifecycle.repair.runIds.length || lifecycle.repair.runIds.length > 20 ||
					lifecycle.repair.runIds.some((runId) => !Number.isSafeInteger(runId)) || typeof lifecycle.repair.attemptId !== "string" || !["queued", "dispatched"].includes(lifecycle.repair.state))) throw new Error("invalid owned-PR repair binding; preserve original state");
				if (lifecycle.phase === "repairing") {
					const failures = lifecycle.observation?.failures;
					const failureKey = failures?.length ? digest(failures.map((failure) => failure.key).sort().join("\n")) : undefined;
					const packetName = lifecycle.repair ? `hosted-failure-${lifecycle.repair.failureKey.slice(0, 16)}.json` : "";
					if (!lifecycle.repair || lifecycle.nextSafeAction !== "repair" || !item.repair || item.repair.failureKey !== lifecycle.repair.failureKey ||
						item.repair.candidateHead !== lifecycle.repair.candidateHead || lifecycle.repair.candidateHead !== lifecycle.pullRequest?.headSha || failureKey !== lifecycle.repair.failureKey ||
						!failures || JSON.stringify([...lifecycle.repair.runIds].sort((a, b) => a - b)) !== JSON.stringify(failures.map((failure) => failure.checkRun.id).sort((a, b) => a - b)) ||
						!item.repair.artifacts.some((artifact) => artifact.attemptId === lifecycle.repair!.attemptId && artifact.path.endsWith(`/${packetName}`))) throw new Error("repair phase lacks its exact source-bound hosted failure packet");
				}
				if (lifecycle.phase === "ready" && (lifecycle.observation?.result !== "passed" || lifecycle.observation.coverage !== "complete" || !lifecycle.observation.eligibleSubject || lifecycle.nextSafeAction !== "pr-ready" || item.proof?.stage !== "pr-ready" || item.stage !== "DONE")) throw new Error("PR-ready lifecycle lacks complete eligible-subject checks and current independent acceptance");
				if (lifecycle.observation?.result === "passed") {
					const observation = lifecycle.observation;
					const eligible = observation.eligibleSubject;
					const latestSuccessful = Boolean(eligible) && observation.policy.every((check) => {
						if (check.appId === null) return false;
						const matching = observation.runs.filter((run) => run.name === check.context && run.appId === check.appId && run.headSha === eligible!.sha && run.subject === eligible!.subject);
						matching.sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt) || b.id - a.id);
						const latest = matching[0];
						const workflowValid = latest?.appSlug !== "github-actions" && latest?.appId !== 15368 || Boolean(latest?.workflow && latest.workflow.checkSuiteId === latest.suiteId &&
							["pull_request", "pull_request_target", "push"].includes(latest.workflow.event) && latest.workflow.status === "completed" && latest.workflow.conclusion === "success");
						return latest?.status === "completed" && latest.conclusion === "success" && workflowValid;
					});
					if (observation.coverage !== "complete" || !/^[a-f0-9]{64}$/.test(observation.policyFingerprint ?? "") || observation.policy.length === 0 || !eligible || !latestSuccessful) {
						throw new Error("passed hosted-check observation lacks complete policy/source/eligible-subject proof");
					}
				}
				if (lifecycle.pullRequest) {
					const currentPrBound = Boolean(item.operation && item.operation.phase === "pr" && item.operation.state === "applied" && item.operation.id === lifecycle.pullRequest.operationId &&
						item.operation.owner === lifecycle.owner && item.operation.generation === lifecycle.generation && item.operation.branch === lifecycle.pullRequest.branch && item.operation.sha === lifecycle.pullRequest.headSha);
					const repairBound = lifecycle.phase === "repairing" && lifecycle.repair?.state === "dispatched" && Boolean(item.operation && item.operation.owner === lifecycle.owner && item.operation.generation === lifecycle.generation &&
						["worker", "verify", "acceptance", "push"].includes(item.operation.phase) && item.operations.some((operation) => operation.phase === "pr" && operation.state === "applied" && operation.id === lifecycle.pullRequest!.operationId &&
							operation.owner === lifecycle.owner && operation.generation === lifecycle.generation && operation.branch === lifecycle.pullRequest!.branch && operation.url === lifecycle.pullRequest!.url));
					if (!currentPrBound && !repairBound) throw new Error("owned PR is not bound to its confirmed logical operation or dispatched same-PR repair lineage");
				}
			}
		}
		batch.version = batch.version === 3 ? 3 : batch.version === 4 ? 4 : 2;
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
