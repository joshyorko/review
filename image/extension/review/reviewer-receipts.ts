/** Native, exact-subject receipts for the packaged Review reviewer. */
import { lstatSync, readdirSync, readFileSync, realpathSync } from "node:fs";
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
	nativeJob?: { jobId: string; agentId: string; agent: "reviewer"; agentSource: "user"; status: "pending" | "running" | "completed" };
	rejected?: true;
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
	structuredOutput?: { source?: unknown; mode?: unknown; status?: unknown; data?: unknown; error?: unknown };
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

function shadowedInDirectory(directory: string): boolean {
	try {
		const directoryInfo = lstatSync(directory);
		if (!directoryInfo.isDirectory() || directoryInfo.isSymbolicLink()) return true;
		// Supported isolation has no custom agents. Refuse every potential native
		// definition, without approximating YAML names, comments, aliases or tools.
		return readdirSync(directory, { withFileTypes: true }).some(entry => entry.name.endsWith(".md"));
	} catch (error) {
		return !(error && typeof error === "object" && "code" in error && error.code === "ENOENT");
	}
}

function presentOrAmbiguous(filePath: string): boolean {
	try {
		lstatSync(filePath);
		return true;
	} catch (error) {
		return !(error && typeof error === "object" && "code" in error && error.code === "ENOENT");
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
	extensionPaths?: readonly string[];
	argv?: readonly string[];
	env?: Readonly<Record<string, string | undefined>>;
}): ReviewerTrustResult {
	const env = input.env ?? process.env;
	const argv = input.argv ?? process.argv;
	const home = input.home ?? homedir();
	const projectDirectory = nearestOmpAgentDirectory(input.cwd);
	const rawProfile = input.profile === undefined ? env.OMP_PROFILE ?? env.PI_PROFILE : input.profile ?? undefined;
	const profile = rawProfile?.trim() === "default" ? undefined : rawProfile?.trim() || undefined;
	if (profile && (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(profile) || profile.endsWith("."))) {
		return { trusted: false, reason: "custom OMP profile path is unsupported" };
	}
	const configDir = env.PI_CONFIG_DIR || ".omp";
	if (configDir !== ".omp" || env.CLAUDE_CONFIG_DIR?.trim() || argv.some(arg => arg === "--plugin-dir" || arg.startsWith("--plugin-dir="))) {
		return { trusted: false, reason: "custom OMP configuration roots or injected plugin directories are unsupported for reviewer trust" };
	}
	const agentDir = path.join(
		home,
		configDir,
		...(profile ? ["profiles", profile] : []),
		"agent",
	);
	const configuredAgentDir = input.agentDir ?? env.PI_CODING_AGENT_DIR;
	if (configuredAgentDir && path.resolve(configuredAgentDir) !== path.resolve(agentDir)) {
		return { trusted: false, reason: "custom OMP agent directory is unsupported; native task discovery uses the active profile root" };
	}
	const userDirectory = path.join(agentDir, "agents");
	if (shadowedInDirectory(projectDirectory)) return { trusted: false, reason: "project OMP reviewer trust unavailable: custom agent definitions or ambiguous roots are unsupported" };
	if (shadowedInDirectory(userDirectory)) return { trusted: false, reason: "user OMP reviewer trust unavailable: custom agent definitions or ambiguous roots are unsupported" };
	// If omp-plugins is disabled at runtime, discovery can still select a
	// marketplace agent with user provenance. Require every fallback registry to
	// be absent instead of inferring the live capability setting from disk.
	const registryRoots = [path.join(home, ".claude"), path.join(home, configDir), path.dirname(agentDir)];
	if (env.XDG_DATA_HOME) {
		registryRoots.push(path.join(env.XDG_DATA_HOME, "omp"));
		if (profile) registryRoots.push(path.join(env.XDG_DATA_HOME, "omp", "profiles", profile));
	}
	let ancestor = path.resolve(input.cwd);
	while (true) {
		registryRoots.push(path.join(ancestor, configDir));
		const parent = path.dirname(ancestor);
		if (parent === ancestor) break;
		ancestor = parent;
	}
	if (registryRoots.some(root => presentOrAmbiguous(path.join(root, "plugins", "installed_plugins.json")))) {
		return { trusted: false, reason: "marketplace agent registries are unsupported for isolated packaged reviewer trust" };
	}
	const definitionPath = input.reviewerPath ?? path.join(path.dirname(fileURLToPath(import.meta.url)), "agents", "reviewer.md");
	try {
		const extensionPaths = input.extensionPaths ?? explicitExtensionPaths(argv);
		// Native resolution places explicit roots before configured extensions and
		// plugins. SDK/configured-only sessions need separate qualification.
		if (!extensionPaths[0] || realpathSync(path.resolve(input.cwd, extensionPaths[0])) !== realpathSync(path.dirname(fileURLToPath(import.meta.url)))) {
			return { trusted: false, reason: "reviewer trust requires Review as the first explicit CLI extension; custom runtime layouts are unsupported" };
		}
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

function explicitExtensionPaths(argv: readonly string[]): string[] {
	const roots: string[] = [];
	for (let index = 0; index < argv.length; index += 1) {
		const arg = argv[index]!;
		if (arg === "--") break;
		if (arg === "--extension" || arg === "-e") roots.push(argv[++index] ?? "");
		else if (arg.startsWith("--extension=")) roots.push(arg.slice("--extension=".length));
	}
	return roots;
}

function nearestOmpAgentDirectory(cwd: string): string {
	let current = path.resolve(cwd);
	while (true) {
		const candidate = path.join(current, ".omp", "agents");
		try {
			// Native discovery follows directory symlinks. Return them for refusal
			// rather than skipping to an ancestor and overlooking their definitions.
			lstatSync(candidate);
			return candidate;
		} catch (error) {
			if (!(error && typeof error === "object" && "code" in error && error.code === "ENOENT")) return candidate;
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
			[toolCallId]: { ...admission, rejected: true, result: undefined, deliveredJobIds: [] },
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
	if (!admission || admission.rejected || admission.waveIdentity !== input.waveIdentity || canonical(admission.subject) !== canonical(input.subject) ||
		result.id !== admission.agentId || result.agent !== "reviewer" || result.agentSource !== "user" ||
		result.exitCode !== 0 || result.error || result.aborted || result.structuredOutput?.status !== "valid" ||
		result.structuredOutput.source !== "caller" || result.structuredOutput.mode !== "strict" || result.structuredOutput.error !== undefined ||
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

/** Persist native async resolution; asynchronous spawns do not enter results[]. */
export function captureReviewerTaskProgress(
	state: ReviewerReceiptState,
	input: { waveIdentity: string; subject: ReviewSubject; toolCallId: string; details: unknown },
): ReviewerReceiptState {
	const admission = state.admissions[input.toolCallId];
	if (!admission || admission.rejected || admission.waveIdentity !== input.waveIdentity || canonical(admission.subject) !== canonical(input.subject)) return state;
	if (!input.details || typeof input.details !== "object" || Array.isArray(input.details)) return state;
	const details = input.details as Record<string, unknown>;
	if (!details.async || typeof details.async !== "object" || Array.isArray(details.async)) return state;
	const async = details.async as Record<string, unknown>;
	const rows = details.progress;
	if (async.type !== "task" || typeof async.jobId !== "string" || !async.jobId ||
		!Array.isArray(rows) || rows.length !== 1 || !rows[0] || typeof rows[0] !== "object" || Array.isArray(rows[0])) {
		return invalidateAdmission(state, input.toolCallId, admission);
	}
	const row = rows[0] as Record<string, unknown>;
	if (row.id !== admission.agentId || row.agent !== "reviewer" || row.agentSource !== "user" ||
		(row.status !== "pending" && row.status !== "running" && row.status !== "completed") ||
		(async.state !== "running" && async.state !== "completed") ||
		(async.state === "completed" && row.status !== "completed") ||
		(admission.nativeJob && (admission.nativeJob.jobId !== async.jobId ||
			admission.nativeJob.status === "completed" && row.status !== "completed"))) {
		return invalidateAdmission(state, input.toolCallId, admission);
	}
	const nativeJob: NonNullable<ReviewerAdmission["nativeJob"]> = {
		jobId: async.jobId, agentId: admission.agentId, agent: "reviewer", agentSource: "user", status: row.status,
	};
	return { ...state, admissions: { ...state.admissions, [input.toolCallId]: { ...admission, nativeJob } } };
}

/** Accept only the completed delivered schema for the previously resolved native task job. */
export function captureReviewerDelivery(
	state: ReviewerReceiptState,
	input: { waveIdentity: string; subject: ReviewSubject; toolCallId: string; details: unknown },
): ReviewerReceiptState {
	const admission = state.admissions[input.toolCallId];
	if (!admission || admission.rejected || admission.waveIdentity !== input.waveIdentity || canonical(admission.subject) !== canonical(input.subject)) return state;
	if (!input.details || typeof input.details !== "object" || Array.isArray(input.details)) return state;
	const jobs = (input.details as Record<string, unknown>).jobs;
	if (!Array.isArray(jobs)) return state;
	const nativeJobs = jobs.filter((job): job is Record<string, unknown> => !!job && typeof job === "object" && !Array.isArray(job));
	const native = admission.nativeJob;
	if (!native) return state;
	const matching = nativeJobs.filter(job => job.agentId === admission.agentId || job.jobId === native.jobId);
	if (matching.length === 0) return state;
	const job = matching[0]!;
	if (matching.length !== 1 || job.agentId !== admission.agentId || job.jobId !== native.jobId ||
		job.type !== "task" || job.status !== "completed" || native.status !== "completed" ||
		!job.schema || typeof job.schema !== "object" || Array.isArray(job.schema)) return invalidateAdmission(state, input.toolCallId, admission);
	const schema = job.schema as Record<string, unknown>;
	if (schema.source !== "caller" || schema.mode !== "strict" || schema.status !== "valid" || schema.error !== undefined || !validPayload(schema.data, admission.subject) ||
		admission.result && canonical(admission.result.payload) !== canonical(schema.data)) return invalidateAdmission(state, input.toolCallId, admission);
	const receipt: ReviewerReceipt = {
		version: 1, waveIdentity: admission.waveIdentity, toolCallId: admission.toolCallId, agentId: admission.agentId,
		jobId: native.jobId, agentSource: "user", subject: { ...admission.subject }, verdict: schema.data.verdict, payload: schema.data,
	};
	return {
		...state,
		admissions: {
			...state.admissions,
			[input.toolCallId]: { ...admission, result: receipt, deliveredJobIds: [native.jobId] },
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
		!state.admissions[receipt.toolCallId]?.rejected && state.admissions[receipt.toolCallId]?.deliveredJobIds.includes(receipt.jobId));
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
		if (admission.rejected !== undefined && admission.rejected !== true) return undefined;
		if (admission.rejected && (admission.result !== undefined || admission.deliveredJobIds.length > 0)) return undefined;
		if (admission.nativeJob !== undefined) {
			if (!admission.nativeJob || typeof admission.nativeJob !== "object" || Array.isArray(admission.nativeJob)) return undefined;
			const native = admission.nativeJob as Record<string, unknown>;
			if (typeof native.jobId !== "string" || !native.jobId || native.agentId !== admission.agentId || native.agent !== "reviewer" ||
				native.agentSource !== "user" || !["pending", "running", "completed"].includes(String(native.status))) return undefined;
		}
		if (admission.result === undefined) continue;
		if (!admission.result || typeof admission.result !== "object" || Array.isArray(admission.result)) return undefined;
		const receipt = admission.result as Record<string, unknown>;
		if (admission.nativeJob) {
			const native = admission.nativeJob as Record<string, unknown>;
			if (native.status !== "completed" || receipt.jobId !== native.jobId ||
				admission.deliveredJobIds.some(id => id !== native.jobId)) return undefined;
		}
		if (receipt.version !== 1 || receipt.waveIdentity !== admission.waveIdentity || receipt.toolCallId !== key ||
			receipt.agentId !== admission.agentId || receipt.agentSource !== "user" || typeof receipt.jobId !== "string" ||
			!exactSubject(receipt.subject, admission.subject as ReviewSubject) ||
			!validPayload(receipt.payload, admission.subject as ReviewSubject) || receipt.verdict !== (receipt.payload as ReviewerPayload).verdict) return undefined;
	}
	return value as ReviewerReceiptState;
}
