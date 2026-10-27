/** Native, exact-subject receipts for the packaged Review reviewer. */
import { existsSync, lstatSync, readdirSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import path from "node:path";

export interface ReviewSubject {
	repository: string;
	number: number;
	headSha: string;
}

export type ReviewerVerdict = "clean" | "findings" | "unknown";

export interface ReviewerPayload extends ReviewSubject {
	verdict: ReviewerVerdict;
	findings: Array<{ title: string; body: string; file: string; line: number }>;
	summary: string;
}

export interface ReviewerReceipt {
	version: 1;
	waveIdentity: string;
	toolCallId: string;
	agentId: string;
	jobId: string;
	agentSource: "user";
	subject: ReviewSubject;
	verdict: ReviewerVerdict;
	payload: ReviewerPayload;
}

export interface ReviewerAdmission {
	waveIdentity: string;
	toolCallId: string;
	agentId: string;
	subject: ReviewSubject;
	outputSchema: unknown;
	result?: ReviewerReceipt;
	deliveredJobIds: string[];
}

export interface ReviewerReceiptState {
	version: 1;
	admissions: Record<string, ReviewerAdmission>;
}

export interface ReviewerTaskInput {
	agent?: unknown;
	name?: unknown;
	outputSchema?: unknown;
	schemaMode?: unknown;
	tools?: unknown;
	[extra: string]: unknown;
}

export interface ReviewerResult {
	id?: unknown;
	agent?: unknown;
	agentSource?: unknown;
	exitCode?: unknown;
	error?: unknown;
	aborted?: unknown;
	structuredOutput?: { status?: unknown; data?: unknown };
}

export function createReviewerOutputSchema(subject: ReviewSubject): Record<string, unknown> {
	return {
		type: "object",
		additionalProperties: false,
		properties: {
			repository: { type: "string", const: subject.repository },
			number: { type: "integer", const: subject.number },
			headSha: { type: "string", const: subject.headSha },
			verdict: { type: "string", enum: ["clean", "findings", "unknown"] },
			findings: {
				type: "array",
				maxItems: 100,
				items: {
					type: "object",
					additionalProperties: false,
					properties: {
						title: { type: "string", maxLength: 500 },
						body: { type: "string", maxLength: 4_000 },
						file: { type: "string", maxLength: 1_000 },
						line: { type: "integer", minimum: 1 },
					},
					required: ["title", "body", "file", "line"],
				},
			},
			summary: { type: "string", maxLength: 4_000 },
		},
		required: ["repository", "number", "headSha", "verdict", "findings", "summary"],
	};
}

export function createReviewerReceiptState(): ReviewerReceiptState {
	return { version: 1, admissions: {} };
}

export interface ReviewerTrustResult {
	trusted: boolean;
	reason?: string;
	definitionPath?: string;
}

const PACKAGED_REVIEWER_SHA256 = "d2e5e1e7f46183bf72fabf6dd45c11820b431751ac5d038f9f2b4f90b586ebde";

function declaresReviewer(filePath: string): boolean {
	try {
		const source = readFileSync(filePath, "utf8");
		return /^\s*name\s*:\s*["']?reviewer["']?\s*$/m.test(source.split("---", 3)[1] ?? "");
	} catch {
		return false;
	}
}

function shadowedInDirectory(directory: string): boolean {
	if (!existsSync(directory)) return false;
	try {
		return readdirSync(directory, { withFileTypes: true }).some(entry => {
			if (!entry.name.endsWith(".md")) return false;
			const filePath = path.join(directory, entry.name);
			try {
				if (lstatSync(filePath).isSymbolicLink()) return true;
			} catch {
				return true;
			}
			return declaresReviewer(filePath);
		});
	} catch {
		return true;
	}
}

/**
 * Check the exact OMP 18.13.2 collision roots that precede CLI extension agents:
 * nearest project `.omp/agents`, then `~/.omp/agent/agents`. Review's `--extension`
 * root is an explicit user-level extension and its shipped reviewer is the file
 * next to this module. OMP task results expose only `agentSource`, not filePath.
 */
export function reviewerDefinitionTrusted(input: {
	cwd: string;
	home?: string;
	agentDir?: string;
	profile?: string | null;
	reviewerPath?: string;
}): ReviewerTrustResult {
	const home = input.home ?? homedir();
	const projectDirectory = nearestOmpAgentDirectory(input.cwd);
	const profile = input.profile === undefined ? process.env.OMP_PROFILE ?? process.env.PI_PROFILE : input.profile ?? undefined;
	const configDir = process.env.PI_CONFIG_DIR || ".omp";
	const agentDir = input.agentDir ?? (input.profile === undefined ? process.env.PI_CODING_AGENT_DIR : undefined) ?? path.join(
		home,
		configDir,
		...(profile ? ["profiles", profile] : []),
		"agent",
	);
	const userDirectory = path.join(agentDir, "agents");
	if (shadowedInDirectory(projectDirectory)) return { trusted: false, reason: "project OMP reviewer shadows the packaged reviewer" };
	if (shadowedInDirectory(userDirectory)) return { trusted: false, reason: "user OMP reviewer shadows the packaged reviewer" };
	const definitionPath = input.reviewerPath ?? path.join(path.dirname(fileURLToPath(import.meta.url)), "agents", "reviewer.md");
	try {
		if (lstatSync(definitionPath).isSymbolicLink()) return { trusted: false, reason: "packaged reviewer definition is a symlink" };
		const source = readFileSync(definitionPath, "utf8");
		if (createHash("sha256").update(source).digest("hex") !== PACKAGED_REVIEWER_SHA256) {
			return { trusted: false, reason: "packaged reviewer definition hash changed" };
		}
		const frontmatter = source.split("---", 3)[1] ?? "";
		if (!/^\s*name\s*:\s*reviewer\s*$/m.test(frontmatter) ||
			!/^\s*tools\s*:\s*read, grep, glob, review_workbench_diff, review_workbench_issue, review_workbench_trace\s*$/m.test(frontmatter)) {
			return { trusted: false, reason: "packaged reviewer identity or read-only tool allowlist changed" };
		}
		return { trusted: true, definitionPath };
	} catch {
		return { trusted: false, reason: "packaged reviewer definition is unavailable" };
	}
}

function nearestOmpAgentDirectory(cwd: string): string {
	let current = path.resolve(cwd);
	while (true) {
		const candidate = path.join(current, ".omp", "agents");
		try {
			if (lstatSync(candidate).isDirectory()) return candidate;
		} catch {
			// Continue to the next ancestor, matching OMP's nearest-config lookup.
		}
		const parent = path.dirname(current);
		if (parent === current) return candidate;
		current = parent;
	}
}

function canonical(value: unknown): string | undefined {
	if (value === null || typeof value !== "object") return JSON.stringify(value);
	if (Array.isArray(value)) {
		const items = value.map(canonical);
		return items.some(item => item === undefined) ? undefined : `[${items.join(",")}]`;
	}
	const record = value as Record<string, unknown>;
	const fields = Object.keys(record).sort().map(key => {
		const item = canonical(record[key]);
		return item === undefined ? undefined : `${JSON.stringify(key)}:${item}`;
	});
	return fields.some(item => item === undefined) ? undefined : `{${fields.join(",")}}`;
}

function exactSubject(left: unknown, right: ReviewSubject): boolean {
	if (!left || typeof left !== "object" || Array.isArray(left)) return false;
	const value = left as Record<string, unknown>;
	return value.repository === right.repository && value.number === right.number && value.headSha === right.headSha;
}

function validSubject(value: ReviewSubject): boolean {
	return !!value && typeof value.repository === "string" && value.repository.length > 0 &&
		Number.isInteger(value.number) && value.number > 0 && typeof value.headSha === "string" && value.headSha.length > 0;
}

function validPayload(value: unknown, subject: ReviewSubject): value is ReviewerPayload {
	if (!value || typeof value !== "object" || Array.isArray(value) || !exactSubject(value, subject)) return false;
	const payload = value as Record<string, unknown>;
	return (payload.verdict === "clean" || payload.verdict === "findings" || payload.verdict === "unknown") &&
		typeof payload.summary === "string" && Array.isArray(payload.findings) &&
		payload.findings.length <= 100 &&
		payload.findings.every(item => !!item && typeof item === "object" && !Array.isArray(item) &&
			typeof (item as Record<string, unknown>).title === "string" && ((item as Record<string, unknown>).title as string).length <= 500 &&
			typeof (item as Record<string, unknown>).body === "string" && ((item as Record<string, unknown>).body as string).length <= 4_000 &&
			typeof (item as Record<string, unknown>).file === "string" && ((item as Record<string, unknown>).file as string).length <= 1_000 &&
			Number.isInteger((item as Record<string, unknown>).line) &&
			((item as Record<string, unknown>).line as number) > 0) &&
		payload.summary.length <= 4_000 &&
		(payload.verdict !== "clean" || payload.findings.length === 0);
}

function taskItems(input: unknown): ReviewerTaskInput[] | undefined {
	if (!input || typeof input !== "object" || Array.isArray(input)) return undefined;
	const value = input as Record<string, unknown>;
	if (Array.isArray(value.tasks)) return value.tasks.length === 1 ? value.tasks as ReviewerTaskInput[] : undefined;
	return [value as ReviewerTaskInput];
}

function invalidateAdmission(state: ReviewerReceiptState, toolCallId: string, admission: ReviewerAdmission): ReviewerReceiptState {
	return {
		...state,
		admissions: {
			...state.admissions,
			[toolCallId]: { ...admission, result: undefined, deliveredJobIds: [] },
		},
	};
}

/** Admit only the one native task item whose output is pinned to this subject. */
export function admitReviewerTask(
	state: ReviewerReceiptState,
	input: { waveIdentity: string; subject: ReviewSubject; toolCallId: string; taskInput: unknown; agentId: string },
): { state: ReviewerReceiptState; admitted: boolean; reason?: string } {
	const items = taskItems(input.taskInput);
	if (!items || items.length !== 1) return { state, admitted: false, reason: "expected exactly one reviewer task" };
	if (!validSubject(input.subject)) return { state, admitted: false, reason: "invalid review subject" };
	const item = items[0]!;
	const expectedSchema = createReviewerOutputSchema(input.subject);
	if (item.agent !== "reviewer" || item.name !== input.agentId || !input.agentId) {
		return { state, admitted: false, reason: "reviewer task identity mismatch" };
	}
	if (item.schemaMode !== "strict" || canonical(item.outputSchema) !== canonical(expectedSchema)) {
		return { state, admitted: false, reason: "reviewer schema is not the exact strict subject schema" };
	}
	if (Object.hasOwn(item, "tools")) return { state, admitted: false, reason: "reviewer task tool override is forbidden" };
	const prior = state.admissions[input.toolCallId];
	if (prior) {
		const same = prior.waveIdentity === input.waveIdentity && prior.agentId === input.agentId &&
			canonical(prior.subject) === canonical(input.subject) && canonical(prior.outputSchema) === canonical(expectedSchema);
		return same
			? { state, admitted: true }
			: { state, admitted: false, reason: "tool call identity was already admitted for another subject" };
	}
	return {
		state: {
			version: 1,
			admissions: {
				...state.admissions,
				[input.toolCallId]: {
					waveIdentity: input.waveIdentity,
					toolCallId: input.toolCallId,
					agentId: input.agentId,
					subject: { ...input.subject },
					outputSchema: expectedSchema,
					deliveredJobIds: [],
				},
			},
		},
		admitted: true,
	};
}

/** Capture a settled sync result only when its OMP identity and schema receipt match. */
export function captureReviewerResult(
	state: ReviewerReceiptState,
	input: { waveIdentity: string; subject: ReviewSubject; toolCallId: string; result: ReviewerResult; jobId?: string; deliveryRequired?: boolean },
): ReviewerReceiptState {
	const admission = state.admissions[input.toolCallId];
	const result = input.result;
	const data = result.structuredOutput?.data;
	if (!admission || admission.waveIdentity !== input.waveIdentity || canonical(admission.subject) !== canonical(input.subject) ||
		result.id !== admission.agentId || result.agent !== "reviewer" || result.agentSource !== "user" ||
		result.exitCode !== 0 || result.error || result.aborted || result.structuredOutput?.status !== "valid" ||
		!validPayload(data, input.subject)) {
		return admission && result.id === admission.agentId
			? invalidateAdmission(state, input.toolCallId, admission)
			: state;
	}
	const jobId = input.jobId ?? admission.agentId;
	const receipt: ReviewerReceipt = {
		version: 1,
		waveIdentity: input.waveIdentity,
		toolCallId: input.toolCallId,
		agentId: admission.agentId,
		jobId,
		agentSource: "user",
		subject: { ...input.subject },
		verdict: data.verdict,
		payload: data,
	};
	return {
		...state,
		admissions: {
			...state.admissions,
			[input.toolCallId]: {
				...admission,
			result: receipt,
				deliveredJobIds: input.deliveryRequired ? admission.deliveredJobIds : [...new Set([...admission.deliveredJobIds, jobId])],
			},
		},
	};
}

/** Record async delivery only for a previously captured result and matching native job. */
export function captureReviewerDelivery(
	state: ReviewerReceiptState,
	input: { waveIdentity: string; subject: ReviewSubject; toolCallId: string; details: unknown },
): ReviewerReceiptState {
	const admission = state.admissions[input.toolCallId];
	if (!admission || admission.waveIdentity !== input.waveIdentity || canonical(admission.subject) !== canonical(input.subject)) return state;
	if (!input.details || typeof input.details !== "object" || Array.isArray(input.details)) return state;
	const jobs = (input.details as Record<string, unknown>).jobs;
	if (!Array.isArray(jobs)) return state;
	const nativeJobs = jobs.filter((job): job is Record<string, unknown> => !!job && typeof job === "object" && !Array.isArray(job));
	const forAgent = nativeJobs.filter(job => job.agentId === admission.agentId);
	const delivered = forAgent
		.filter(job => job.type === "task" && job.status === "completed" &&
			typeof job.jobId === "string" && job.schema && typeof job.schema === "object" &&
			(job.schema as Record<string, unknown>).status === "valid" &&
			canonical((job.schema as Record<string, unknown>).data) === canonical(admission.result?.payload));
	if (!admission.result || admission.result.verdict === "unknown") return state;
	if (forAgent.length > 0 && delivered.length !== 1) return invalidateAdmission(state, input.toolCallId, admission);
	if (delivered.length !== 1) return state;
	const jobId = delivered[0]!.jobId as string;
	const receipt = { ...admission.result, jobId };
	return {
		...state,
		admissions: {
			...state.admissions,
			[input.toolCallId]: { ...admission, result: receipt, deliveredJobIds: [...new Set([...admission.deliveredJobIds, jobId])] },
		},
	};
}

export function getCleanReviewerReceipt(
	state: ReviewerReceiptState,
	input: { waveIdentity: string; subject: ReviewSubject; excludedAgentIds?: readonly string[] },
): ReviewerReceipt | undefined {
	if (!validSubject(input.subject) || !input.waveIdentity) return undefined;
	return Object.values(state.admissions).map(admission => admission.result).find(receipt =>
		receipt && receipt.verdict === "clean" && receipt.waveIdentity === input.waveIdentity &&
		canonical(receipt.subject) === canonical(input.subject) && receipt.agentSource === "user" &&
		receipt.agentId !== undefined && !input.excludedAgentIds?.includes(receipt.agentId) &&
		state.admissions[receipt.toolCallId]?.deliveredJobIds.includes(receipt.jobId));
}

/** Parse durable wave-store data without accepting partial or forged receipts. */
export function parseReviewerReceiptState(value: unknown): ReviewerReceiptState | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	const state = value as Record<string, unknown>;
	if (state.version !== 1 || !state.admissions || typeof state.admissions !== "object" || Array.isArray(state.admissions)) return undefined;
	for (const [key, raw] of Object.entries(state.admissions as Record<string, unknown>)) {
		if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
		const admission = raw as Record<string, unknown>;
		if (key !== admission.toolCallId || typeof admission.waveIdentity !== "string" || typeof admission.agentId !== "string" ||
		!admission.subject || typeof admission.subject !== "object" || Array.isArray(admission.subject) ||
		!validSubject(admission.subject as ReviewSubject) ||
		canonical(admission.outputSchema) !== canonical(createReviewerOutputSchema(admission.subject as ReviewSubject)) ||
			!Array.isArray(admission.deliveredJobIds) || !admission.deliveredJobIds.every(id => typeof id === "string")) return undefined;
		if (admission.result === undefined) continue;
		if (!admission.result || typeof admission.result !== "object" || Array.isArray(admission.result)) return undefined;
		const receipt = admission.result as Record<string, unknown>;
		if (receipt.version !== 1 || receipt.waveIdentity !== admission.waveIdentity || receipt.toolCallId !== key ||
			receipt.agentId !== admission.agentId || receipt.agentSource !== "user" || typeof receipt.jobId !== "string" ||
			!exactSubject(receipt.subject, admission.subject as ReviewSubject) ||
			!validPayload(receipt.payload, admission.subject as ReviewSubject) || receipt.verdict !== (receipt.payload as ReviewerPayload).verdict) return undefined;
	}
	return value as ReviewerReceiptState;
}
