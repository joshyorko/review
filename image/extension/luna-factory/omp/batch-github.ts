import { digest, type SelectedItem } from "../core/batch.ts";
import { deadlineSignal } from "../../bluefin-review/deadline.ts";
import type { GraphNodeObservation, GraphRelation, WorkGraphObservation } from "../core/graph.ts";
import { inflateRawSync } from "node:zlib";

interface Connection<T> { nodes: T[]; pageInfo: { hasNextPage: boolean } }
interface Link { number: number; state?: string; repository: { nameWithOwner: string }; id?: string; merged?: boolean; baseRefOid?: string; headRefOid?: string; baseRefName?: string; closingIssuesReferences?: Connection<Link> }
interface GitHubItem {
	id: string; __typename: string; title: string; body: string; closed: boolean; merged?: boolean; url: string;
	baseRefOid?: string; headRefOid?: string; baseRefName?: string; labels: Connection<{ name: string }>;
	files?: Connection<{ path: string }>; closingIssuesReferences?: Connection<Link>;
	timelineItems?: Connection<{ source?: Link }>;
}
interface SnapshotResponse {
	data?: { repository?: { id: string; nameWithOwner: string; defaultBranchRef?: { name: string; target: { oid: string } }; issueOrPullRequest?: GitHubItem } };
}

export interface OwnedPullRequest {
	readonly repository: string;
	readonly identity: string;
	readonly number: number;
	readonly url: string;
	readonly branch: string;
	readonly headSha: string;
	readonly baseRef: string;
	readonly baseSha: string;
	readonly mergeSha?: string;
}
export interface HostedChecksObservation {
	readonly observedAt: string;
	readonly headSha: string;
	readonly mergeSha?: string;
	readonly eligibleSubject?: { readonly sha: string; readonly subject: "head" | "merge" };
	readonly policyFingerprint?: string;
	readonly policy: { readonly context: string; readonly appId: number | null; readonly source: "classic" | "ruleset"; readonly rulesetId?: number }[];
	readonly runs: { readonly id: number; readonly suiteId: number; readonly appId: number | null; readonly appSlug: string | null; readonly name: string; readonly headSha: string; readonly status: string; readonly conclusion: string | null; readonly createdAt: string; readonly startedAt: string | null; readonly subject: "head" | "merge"; readonly workflow?: { readonly id: number; readonly attempt: number; readonly workflowId: number; readonly event: string; readonly path: string; readonly checkSuiteId: number; readonly status: string; readonly conclusion: string | null } }[];
	readonly coverage: "complete" | "incomplete" | "unavailable";
	readonly result: "pending" | "failed" | "unknown" | "passed";
	readonly retryAfter?: string;
	readonly failures?: NonNullable<NonNullable<import("../core/batch.ts").OwnedPullRequestLifecycle["observation"]>["failures"]>;
	readonly reason?: string;
}
interface CurrentOwnedPullRequest {
	id: number; node_id: string; number: number; html_url: string; state: string; merged: boolean; draft: boolean;
	head: { ref: string; sha: string; repo: { full_name: string } | null };
	base: { ref: string; sha: string; repo: { full_name: string } | null };
	merge_commit_sha?: string | null;
}
interface RequiredCheckPolicyEntry { readonly context: string; readonly appId: number | null; readonly source: "classic" | "ruleset"; readonly rulesetId?: number }
interface EffectiveRequiredCheckPolicy { readonly checks: readonly RequiredCheckPolicyEntry[]; readonly fingerprint: string }
interface ClassicRequiredChecks { strict?: boolean; contexts?: string[]; checks?: { context: string; app_id: number | null }[] }
interface RulesetSummary { id: number; enforcement: string }
interface RulesetDetail {
	id: number; enforcement: string; target: string; source: string; source_type: string;
	conditions?: { ref_name?: { include?: string[]; exclude?: string[] } };
	rules: { type: string; parameters?: { required_status_checks?: { context: string; integration_id: number | null }[] } }[];
}
interface DiagnosticBudget { requests: number; bytes: number }
const MAX_REPAIR_FAILURES = 20;
const MAX_DIAGNOSTIC_REQUESTS = 256;
const MAX_DIAGNOSTIC_BYTES = 1024 * 1024;
const MAX_API_RESPONSE_BYTES = 4 * 1024 * 1024;
async function boundedResponseBytes(response: Response, maximum: number): Promise<Buffer> {
	if (response.body) {
		const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let bytes = 0;
		for (;;) {
			const next = await reader.read();
			if (next.done) break;
			bytes += next.value.byteLength;
			if (bytes > maximum) { await reader.cancel(); throw new Error("GitHub response exceeded its bounded evidence size"); }
			chunks.push(next.value);
		}
		return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)), bytes);
	}
	const bytes = Buffer.from(await response.arrayBuffer());
	if (bytes.length > maximum) throw new Error("GitHub response exceeded its bounded evidence size");
	return bytes;
}
function stableJson(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
	if (value !== null && typeof value === "object") {
		const record = value as Record<string, unknown>;
		return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(",")}}`;
	}
	return JSON.stringify(value) ?? "null";
}
function rulesetPatternMatches(pattern: string, ref: string, defaultBranch?: string): boolean {
	if (pattern === "~ALL") return true;
	if (pattern === "~DEFAULT_BRANCH") {
		if (!defaultBranch) throw new Error("active ruleset targets the default branch but its canonical name is unavailable");
		return ref === defaultBranch;
	}
	if (pattern.startsWith("~")) throw new Error(`active ruleset uses unsupported ref selector ${pattern}`);
	const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*\*/g, "\u0000").replace(/\*/g, "[^/]*").replace(/\u0000/g, ".*");
	const expression = new RegExp(`^${escaped}$`);
	return expression.test(ref) || expression.test(`refs/heads/${ref}`);
}
function rulesetBranchApplies(condition: { include?: string[]; exclude?: string[] } | undefined, ref: string, defaultBranch?: string): boolean {
	if (!condition) return true;
	if (!Array.isArray(condition.include) || !Array.isArray(condition.exclude)) throw new Error("active ruleset ref conditions are incomplete");
	const included = condition.include.length === 0 || condition.include.some((pattern) => rulesetPatternMatches(pattern, ref, defaultBranch));
	if (condition.include.length === 0) throw new Error("active ruleset has no bounded ref include patterns");
	return included && !condition.exclude.some((pattern) => rulesetPatternMatches(pattern, ref, defaultBranch));
}
const infrastructureFailure = /(?:cancelled|canceled|timed?\s*out|timeout|runner.{0,32}(?:lost|unavailable|offline|failed)|no space left|resource temporarily unavailable|could not resolve|connection (?:reset|refused|timed?\s*out)|network (?:unreachable|error)|\bHTTP 5\d\d\b|rate limit|failed to download|setup[- ](?:node|python|java|go)|checkout action)/i;
const codeFailure = /(?:error\s+TS\d+|AssertionError|\bFAIL(?:ED)?\b|assertion failed|compilation failed|typecheck failed|lint (?:error|failed)|build failed|test (?:failed|failure)|checks? failed)/i;
const sourceLocation = /(?:^|\s)(?:\.\.?\/)?[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*\.[A-Za-z0-9]+:\d+(?::\d+)?/m;
function crc32(bytes: Buffer): number {
	let value = 0xffffffff;
	for (const byte of bytes) {
		value ^= byte;
		for (let bit = 0; bit < 8; bit++) value = (value >>> 1) ^ (value & 1 ? 0xedb88320 : 0);
	}
	return (value ^ 0xffffffff) >>> 0;
}
function actionLogText(archive: Buffer): string {
	const searchFrom = Math.max(0, archive.length - 65_557);
	let end = -1;
	for (let offset = archive.length - 22; offset >= searchFrom; offset--) if (archive.readUInt32LE(offset) === 0x06054b50) { end = offset; break; }
	if (end < 0) throw new Error("Actions job log archive has no bounded ZIP directory");
	const count = archive.readUInt16LE(end + 10);
	const directorySize = archive.readUInt32LE(end + 12);
	const directoryStart = archive.readUInt32LE(end + 16);
	let cursor = directoryStart;
	if (count > 100 || cursor + directorySize > end) throw new Error("Actions job log archive exceeds its entry/directory bound");
	const files: string[] = [];
	let expandedTotal = 0;
	for (let index = 0; index < count; index++) {
		if (cursor + 46 > archive.length || archive.readUInt32LE(cursor) !== 0x02014b50) throw new Error("Actions job log archive has a malformed central directory");
		const flags = archive.readUInt16LE(cursor + 8);
		const method = archive.readUInt16LE(cursor + 10);
		const expectedCrc = archive.readUInt32LE(cursor + 16);
		const compressedSize = archive.readUInt32LE(cursor + 20);
		const expandedSize = archive.readUInt32LE(cursor + 24);
		const nameLength = archive.readUInt16LE(cursor + 28);
		const extraLength = archive.readUInt16LE(cursor + 30);
		const commentLength = archive.readUInt16LE(cursor + 32);
		const localOffset = archive.readUInt32LE(cursor + 42);
		const centralName = archive.subarray(cursor + 46, cursor + 46 + nameLength);
		const name = centralName.toString("utf8");
		cursor += 46 + nameLength + extraLength + commentLength;
		if (!name || name.startsWith("/") || name.split(/[\\/]/).includes("..") || flags & 1 || ![0, 8].includes(method) || expandedSize > 256 * 1024 || compressedSize > 2 * 1024 * 1024) throw new Error("Actions job log archive contains unsupported, unsafe, or oversized content");
		if (name.endsWith("/")) continue;
		if (localOffset + 30 > archive.length || archive.readUInt32LE(localOffset) !== 0x04034b50) throw new Error("Actions job log archive has a malformed local entry");
		const localNameLength = archive.readUInt16LE(localOffset + 26);
		const localExtraLength = archive.readUInt16LE(localOffset + 28);
		const localName = archive.subarray(localOffset + 30, localOffset + 30 + localNameLength);
		if (archive.readUInt16LE(localOffset + 6) !== flags || archive.readUInt16LE(localOffset + 8) !== method || localNameLength !== nameLength || !localName.equals(centralName)) throw new Error("Actions job log central/local metadata do not match");
		const dataStart = localOffset + 30 + localNameLength + localExtraLength;
		const dataEnd = dataStart + compressedSize;
		if (dataEnd > archive.length) throw new Error("Actions job log archive entry exceeds its retained bytes");
		const compressed = archive.subarray(dataStart, dataEnd);
		const expanded = method === 0 ? Buffer.from(compressed) : inflateRawSync(compressed, { maxOutputLength: 256 * 1024 });
		if (expanded.length !== expandedSize || crc32(expanded) !== expectedCrc) throw new Error("Actions job log entry failed size/CRC validation");
		expandedTotal += expanded.length + name.length + 16;
		if (expandedTotal > 256 * 1024) throw new Error("Actions job logs exceed the complete diagnostic bound");
		files.push(`===== ${name} =====\n${expanded.toString("utf8")}`);
	}
	if (!files.length || cursor !== directoryStart + directorySize) throw new Error("Actions job log archive has incomplete text diagnostics");
	const result = files.join("\n");
	if (Buffer.byteLength(result) > 256 * 1024) throw new Error("Actions job logs exceed the complete diagnostic bound");
	return result;
}

/** Uses the existing Review credential, never a per-repository substitute. */
export class BatchGitHub {
	readonly token: string | undefined;
	readonly fetchImpl: typeof fetch;
	constructor(token: string | undefined, fetchImpl: typeof fetch = fetch) { this.token = token; this.fetchImpl = fetchImpl; }
	private retryDate(response: Response): string | undefined {
		const raw = response.headers?.get("retry-after");
		if (!raw) return undefined;
		const seconds = Number(raw);
		const timestamp = Number.isFinite(seconds) && seconds >= 0 ? Date.now() + seconds * 1000 : Date.parse(raw);
		return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : undefined;
	}
	async request<T>(path: string, body?: unknown, signal?: AbortSignal, diagnosticBudget?: DiagnosticBudget): Promise<T> {
		if (!this.token) throw new Error("no GitHub credential; configure the existing Review connection and resume");
		if (diagnosticBudget && (++diagnosticBudget.requests > MAX_DIAGNOSTIC_REQUESTS || diagnosticBudget.bytes >= MAX_DIAGNOSTIC_BYTES)) throw new Error("hosted failure diagnostics exceeded their aggregate request/byte budget");
		const response = await this.fetchImpl(`https://api.github.com/${path}`, {
			method: body === undefined ? "GET" : "POST", redirect: "error", signal: signal ? AbortSignal.any([deadlineSignal(30_000), signal]) : deadlineSignal(30_000),
			headers: { Authorization: `Bearer ${this.token}`, Accept: "application/vnd.github+json", "Content-Type": "application/json" },
			...(body === undefined ? {} : { body: JSON.stringify(body) }),
		});
		if (!response.ok) {
			const retryAfter = this.retryDate(response);
			throw Object.assign(new Error(`GitHub ${response.status}; affected item blocked, restore access/rate limit then resume`), { retryAfter });
		}
		if (response.headers?.get("link")?.includes('rel="next"')) throw new Error("incomplete paginated relationship evidence; bounded observation cannot prove absence");
		let result: unknown;
		if (response.body) {
			const max = Math.min(MAX_API_RESPONSE_BYTES, diagnosticBudget ? MAX_DIAGNOSTIC_BYTES - diagnosticBudget.bytes : MAX_API_RESPONSE_BYTES);
			const bytes = await boundedResponseBytes(response, max);
			if (diagnosticBudget) diagnosticBudget.bytes += bytes.length;
			try { result = JSON.parse(bytes.toString("utf8")); }
			catch { throw new Error("invalid GitHub JSON response"); }
		} else {
			result = await response.json();
			if (diagnosticBudget) {
				const bytes = Buffer.byteLength(JSON.stringify(result));
				if (diagnosticBudget.bytes + bytes > MAX_DIAGNOSTIC_BYTES) throw new Error("hosted failure diagnostics exceeded their aggregate byte budget");
				diagnosticBudget.bytes += bytes;
			}
		}
		if (!result || typeof result !== "object") throw new Error("invalid GitHub response");
		if ("errors" in result && Array.isArray(result.errors) && result.errors.length) throw new Error("GitHub returned incomplete item evidence; restore access then resume");
		return result as T;
	}
	private async readRequiredCheckPolicy(repo: string, baseRef: string, defaultBranch?: string, signal?: AbortSignal): Promise<EffectiveRequiredCheckPolicy> {
		const classic = await this.request<ClassicRequiredChecks>(`repos/${repo}/branches/${encodeURIComponent(baseRef)}/protection/required_status_checks`, undefined, signal);
		if (!Array.isArray(classic.contexts) || !Array.isArray(classic.checks) || classic.contexts.length + classic.checks.length > 100 ||
			classic.contexts.some((context) => typeof context !== "string" || !context.trim()) ||
			classic.checks.some((check) => typeof check.context !== "string" || !check.context.trim() || check.app_id !== null && !Number.isSafeInteger(check.app_id))) throw new Error("classic required-check policy is malformed or incomplete");
		const checkedContexts = new Set(classic.checks.map((check) => check.context));
		if (classic.checks.length && classic.contexts.some((context) => !checkedContexts.has(context))) throw new Error("classic required-check policy contains an unbound status context");
		const checks: RequiredCheckPolicyEntry[] = classic.checks.length
			? classic.checks.map((check) => ({ context: check.context, appId: check.app_id, source: "classic" }))
			: classic.contexts.map((context) => ({ context, appId: null, source: "classic" }));
		const summaries = await this.request<RulesetSummary[]>(`repos/${repo}/rulesets?includes_parents=true&per_page=100`, undefined, signal);
		if (!Array.isArray(summaries) || summaries.length >= 100) throw new Error("applicable repository/parent ruleset policy page is incomplete");
		const snapshots: unknown[] = [];
		const knownNonCheckRules = new Set([
			"creation", "update", "deletion", "required_linear_history", "required_signatures", "non_fast_forward", "pull_request",
			"commit_message_pattern", "commit_author_email_pattern", "committer_email_pattern", "branch_name_pattern",
			"file_path_restriction", "max_file_path_length", "max_file_size",
		]);
		for (const summary of summaries.sort((a, b) => a.id - b.id)) {
			if (!Number.isSafeInteger(summary.id) || !["active", "evaluate", "disabled"].includes(summary.enforcement)) throw new Error("ruleset summary is malformed; effective check policy is incomplete");
			if (summary.enforcement !== "active") { snapshots.push({ id: summary.id, enforcement: summary.enforcement }); continue; }
			const ruleset = await this.request<RulesetDetail>(`repos/${repo}/rulesets/${summary.id}`, undefined, signal);
			if (ruleset.id !== summary.id || ruleset.enforcement !== "active" || !["repository", "organization", "enterprise"].includes(ruleset.source_type?.toLowerCase()) || typeof ruleset.source !== "string" || !Array.isArray(ruleset.rules)) throw new Error(`active ruleset ${summary.id} policy is malformed or incomplete`);
			const snapshot = { id: ruleset.id, enforcement: ruleset.enforcement, target: ruleset.target, source: ruleset.source, source_type: ruleset.source_type, conditions: ruleset.conditions ?? null, rules: ruleset.rules };
			snapshots.push(snapshot);
			if (!ruleset.rules.length) continue;
			if (ruleset.target !== "branch") throw new Error(`active check-bearing ruleset ${summary.id} has unsupported target ${ruleset.target}`);
			const conditions = ruleset.conditions?.ref_name;
			if (!rulesetBranchApplies(conditions, baseRef, defaultBranch)) continue;
			const unclassified = ruleset.rules.find((rule) => rule.type !== "required_status_checks" && !knownNonCheckRules.has(rule.type));
			if (unclassified) throw new Error(`active applicable ruleset ${summary.id} uses unproved policy rule ${unclassified.type}`);
			for (const rule of ruleset.rules) {
				if (rule.type !== "required_status_checks") {
					if (!knownNonCheckRules.has(rule.type)) throw new Error(`active applicable ruleset ${summary.id} uses unclassified rule ${rule.type}`);
					continue;
				}
				const statuses = rule.parameters?.required_status_checks;
				if (!Array.isArray(statuses) || checks.length + statuses.length > 100) throw new Error(`applicable required-check ruleset ${summary.id} lacks complete bounded source policy`);
				for (const status of statuses) {
					if (typeof status.context !== "string" || !status.context.trim() || status.integration_id !== null && !Number.isSafeInteger(status.integration_id)) throw new Error(`applicable required-check ruleset ${summary.id} has an unbound or malformed source`);
					checks.push({ context: status.context, appId: status.integration_id, source: "ruleset", rulesetId: ruleset.id });
				}
			}
		}
		return { checks, fingerprint: digest(stableJson({ classic: { strict: classic.strict ?? null, contexts: classic.contexts, checks: classic.checks }, rulesets: snapshots })) };
	}
	async hostedCheckPolicyCurrent(repo: string, baseRef: string, defaultBranch: string | undefined, fingerprint: string, signal?: AbortSignal): Promise<boolean> {
		try { return (await this.readRequiredCheckPolicy(repo, baseRef, defaultBranch, signal)).fingerprint === fingerprint; }
		catch { return false; }
	}
	async observeHostedChecks(repo: string, pull: OwnedPullRequest, observedAt: string, defaultBranch?: string, signal?: AbortSignal): Promise<HostedChecksObservation> {
		let mergeSha = pull.mergeSha;
		let policyFingerprint: string | undefined;
		const unknown = (reason: string, coverage: HostedChecksObservation["coverage"] = "unavailable", policy: HostedChecksObservation["policy"] = [], runs: HostedChecksObservation["runs"] = [], eligibleSubject?: HostedChecksObservation["eligibleSubject"], retryAfter?: string): HostedChecksObservation => ({
			observedAt, headSha: pull.headSha, ...(mergeSha ? { mergeSha } : {}), ...(eligibleSubject ? { eligibleSubject } : {}), ...(policyFingerprint ? { policyFingerprint } : {}), policy, runs, coverage, result: "unknown", reason, ...(retryAfter ? { retryAfter } : {}),
		});
		try {
			const current = await this.readOwnedPullRequest(repo, pull, signal);
			mergeSha = current.merge_commit_sha ?? pull.mergeSha;
			let initialPolicy: EffectiveRequiredCheckPolicy;
			try { initialPolicy = await this.readRequiredCheckPolicy(repo, pull.baseRef, defaultBranch, signal); }
			catch (error) { return unknown(`effective classic/ruleset check policy is unavailable or unsupported: ${error instanceof Error ? error.message : String(error)}`, "unavailable", [], [], undefined, (error as { retryAfter?: string }).retryAfter); }
			policyFingerprint = initialPolicy.fingerprint;
			const required = [...initialPolicy.checks];
			if (!required.length) return unknown("GitHub returned no declared required-check policy");
			if (required.some((check) => check.appId === null)) return unknown("required-check policy does not bind every check to an exact GitHub App source", "complete", required);
			// GitHub's check run placement selects the PR subject: use the merge SHA when a declared context ran there, otherwise the head SHA.
			const subjects = [{ sha: pull.headSha, subject: "head" as const }, ...(mergeSha && mergeSha !== pull.headSha ? [{ sha: mergeSha, subject: "merge" as const }] : [])];
			const runs: HostedChecksObservation["runs"][number][] = [];
			for (const subject of subjects) {
				let result: { total_count: number; check_runs: { id: number; name: string; head_sha: string; status: string; conclusion: string | null; created_at: string; started_at: string | null; app: { id: number; slug?: string } | null; check_suite: { id: number } }[] };
				try { result = await this.request(`repos/${repo}/commits/${subject.sha}/check-runs?per_page=100`, undefined, signal); }
				catch (error) { return unknown(`required check-run evidence for ${subject.subject} SHA ${subject.sha} is unavailable: ${error instanceof Error ? error.message : String(error)}`, "unavailable", required, runs, undefined, (error as { retryAfter?: string }).retryAfter); }
				if (!Number.isSafeInteger(result.total_count) || !Array.isArray(result.check_runs) || result.check_runs.length >= 100 || result.total_count !== result.check_runs.length) return unknown("check-run page is incomplete; continue only after complete coverage", "incomplete", required, runs);
				for (const run of result.check_runs) {
					if (!Number.isSafeInteger(run.id) || !Number.isSafeInteger(run.check_suite?.id) || typeof run.name !== "string" || run.head_sha !== subject.sha || !["queued", "in_progress", "completed"].includes(run.status) || run.status === "completed" && typeof run.conclusion !== "string" || run.app !== null && !Number.isSafeInteger(run.app?.id) || !Number.isFinite(Date.parse(run.created_at))) return unknown("check-run evidence is malformed or bound to another subject", "incomplete", required, runs);
					runs.push({ id: run.id, suiteId: run.check_suite.id, appId: run.app?.id ?? null, appSlug: run.app?.slug ?? null, name: run.name, headSha: run.head_sha, status: run.status, conclusion: run.conclusion, createdAt: run.created_at, startedAt: run.started_at, subject: subject.subject });
				}
			}
			const policyContexts = new Set(required.map((check) => check.context));
			const mergeSubject = subjects.find((subject) => subject.subject === "merge");
			const eligible = mergeSubject && runs.some((run) => run.subject === "merge" && policyContexts.has(run.name)) ? mergeSubject : subjects[0]!;
			let failureCount = 0;
			for (const check of required) {
				const candidates = runs.filter((run) => run.name === check.context && run.headSha === eligible.sha && run.subject === eligible.subject && run.appId === check.appId)
					.sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt) || b.id - a.id);
				if (candidates[0]?.status === "completed" && candidates[0].conclusion === "failure") failureCount++;
			}
			if (failureCount > MAX_REPAIR_FAILURES) return unknown("current failed required-check cardinality exceeds the retained repair bound", "incomplete", required, runs, eligible);
			type WorkflowRuns = { total_count: number; workflow_runs: { id: number; check_suite_id: number; workflow_id: number; run_attempt: number; event: string; status: string; conclusion: string | null; head_sha: string; path: string }[] };
			const workflowCache = new Map<string, WorkflowRuns>();
			const diagnosticBudget: DiagnosticBudget = { requests: 0, bytes: 0 };
			const workflowFor = async (run: HostedChecksObservation["runs"][number]): Promise<NonNullable<HostedChecksObservation["runs"][number]["workflow"]> | undefined> => {
				if (run.appSlug !== "github-actions" && run.appId !== 15368) return;
				if (run.appSlug !== "github-actions") return;
				let listed = workflowCache.get(run.headSha);
				if (!listed) {
					try { listed = await this.request<WorkflowRuns>(`repos/${repo}/actions/runs?head_sha=${run.headSha}&per_page=100`, undefined, signal, diagnosticBudget); }
					catch (error) { throw Object.assign(new Error(`GitHub Actions workflow event/attempt evidence is unavailable: ${error instanceof Error ? error.message : String(error)}`), { retryAfter: (error as { retryAfter?: string }).retryAfter }); }
					if (!Array.isArray(listed.workflow_runs) || listed.workflow_runs.length >= 100 || listed.total_count !== listed.workflow_runs.length) throw new Error("Actions workflow-run page is incomplete; expected event and attempt source remain UNKNOWN");
					workflowCache.set(run.headSha, listed);
				}
				const matches = listed.workflow_runs.filter((candidate) => candidate.check_suite_id === run.suiteId && candidate.head_sha === run.headSha);
				if (!matches.length) return;
				matches.sort((a, b) => b.run_attempt - a.run_attempt || b.id - a.id);
				const latest = matches[0]!;
				if (!Number.isSafeInteger(latest.id) || !Number.isSafeInteger(latest.workflow_id) || !Number.isSafeInteger(latest.run_attempt) || latest.run_attempt < 1 || typeof latest.event !== "string" || typeof latest.path !== "string" || !["queued", "in_progress", "completed"].includes(latest.status) || latest.status === "completed" && typeof latest.conclusion !== "string") return;
				if (!["pull_request", "pull_request_target", "push"].includes(latest.event)) return;
				return { id: latest.id, attempt: latest.run_attempt, workflowId: latest.workflow_id, event: latest.event, path: latest.path, checkSuiteId: latest.check_suite_id, status: latest.status, conclusion: latest.conclusion };
			};
			let pending = false;
			const failures: NonNullable<HostedChecksObservation["failures"]> = [];
			for (const check of required) {
				const matching = runs.filter((run) => run.name === check.context && run.headSha === eligible.sha && run.subject === eligible.subject && run.appId === check.appId);
				if (!matching.length) {
					const exactNameAndSubject = runs.some((run) => run.name === check.context && run.headSha === eligible.sha && run.subject === eligible.subject);
					return unknown(exactNameAndSubject ? `required check ${check.context} has no exact-source run on the eligible ${eligible.subject} SHA` : `required check ${check.context} has no execution on the eligible ${eligible.subject} SHA`, "complete", required, runs, eligible);
				}
				matching.sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt) || b.id - a.id);
				const latest = matching[0]!;
				if (latest.appSlug === "github-actions" || latest.appId === 15368) {
					const workflow = await workflowFor(latest);
					if (!workflow) return unknown(`required check ${check.context} lacks an eligible GitHub Actions workflow event/attempt binding`, "complete", required, runs, eligible);
					const index = runs.findIndex((run) => run.id === latest.id);
					runs[index] = { ...latest, workflow };
					if (workflow.status !== "completed" || workflow.conclusion !== "success") {
						if (workflow.status !== "completed") pending = true;
						else if (latest.conclusion !== "failure" || workflow.conclusion !== "failure") return unknown(`GitHub Actions workflow ${workflow.event} attempt ${workflow.attempt} did not complete as a source-bound code failure`, "complete", required, runs, eligible);
					}
				}
				if (latest.status !== "completed") pending = true;
				else if (latest.conclusion !== "success") {
					if (latest.conclusion === "failure") {
						try { failures.push(await this.readFailureEvidence(repo, pull.headSha, eligible.sha, eligible.subject, runs.find((run) => run.id === latest.id)!, signal, diagnosticBudget)); }
						catch (error) { return unknown(`required check ${check.context} failed but its source-bound repair diagnostics are incomplete: ${error instanceof Error ? error.message : String(error)}`, "incomplete", required, runs, eligible, (error as { retryAfter?: string }).retryAfter); }
						continue;
					}
					return unknown(`required check ${check.context} completed as ${latest.conclusion ?? "unknown"} on the eligible ${eligible.subject} SHA; execution proof is incomplete`, "complete", required, runs, eligible);
				}
			}
			if (failures.length) return { observedAt, headSha: pull.headSha, ...(mergeSha ? { mergeSha } : {}), eligibleSubject: eligible, policyFingerprint, policy: required, runs, coverage: "complete", result: "failed", failures, reason: `${failures.length} current required check(s) failed with complete source-bound diagnostics` };
			if (!pending) {
				let currentPolicy: EffectiveRequiredCheckPolicy;
				try { currentPolicy = await this.readRequiredCheckPolicy(repo, pull.baseRef, defaultBranch, signal); }
				catch (error) { return unknown(`effective policy recheck failed before PR-ready: ${error instanceof Error ? error.message : String(error)}`, "unavailable", required, runs, eligible); }
				if (currentPolicy.fingerprint !== policyFingerprint) return unknown("effective classic/ruleset check policy changed during hosted observation", "complete", required, runs, eligible);
			}
			return { observedAt, headSha: pull.headSha, ...(mergeSha ? { mergeSha } : {}), eligibleSubject: eligible, policyFingerprint, policy: required, runs, coverage: "complete", result: pending ? "pending" : "passed" };
		} catch (error) {
			return unknown(error instanceof Error ? error.message : String(error), "unavailable", [], [], undefined, (error as { retryAfter?: string }).retryAfter);
		}
	}
	private async readOwnedPullRequest(repo: string, pull: OwnedPullRequest, signal?: AbortSignal): Promise<CurrentOwnedPullRequest> {
		const current = await this.request<CurrentOwnedPullRequest>(`repos/${repo}/pulls/${pull.number}`, undefined, signal);
		if (!Number.isSafeInteger(current.id) || current.node_id !== pull.identity || current.number !== pull.number || current.html_url !== pull.url ||
			current.head.repo?.full_name.toLowerCase() !== repo.toLowerCase() || current.base.repo?.full_name.toLowerCase() !== repo.toLowerCase() ||
			current.head.ref !== pull.branch || current.head.sha !== pull.headSha || current.base.ref !== pull.baseRef || current.base.sha !== pull.baseSha || current.draft !== false ||
			pull.mergeSha !== undefined && (current.merge_commit_sha ?? undefined) !== pull.mergeSha || current.state !== "open" || current.merged) throw new Error("owned PR identity, target, or head changed; reconcile ownership before continuing");
		return current;
	}
	private async readActionsJobLog(repo: string, jobId: number, signal?: AbortSignal, budget?: DiagnosticBudget): Promise<{ status: number; available: boolean; content: string; bytes: number; complete: boolean; truncated: boolean }> {
		const headers = { Authorization: `Bearer ${this.token}`, Accept: "application/vnd.github+json" };
		const apiUrl = `https://api.github.com/repos/${repo}/actions/jobs/${jobId}/logs`;
		const requestSignal = signal ? AbortSignal.any([deadlineSignal(30_000), signal]) : deadlineSignal(30_000);
		if (budget && (++budget.requests > MAX_DIAGNOSTIC_REQUESTS || budget.bytes >= MAX_DIAGNOSTIC_BYTES)) throw new Error("hosted failure diagnostics exceeded their aggregate request/byte budget");
		const initial = await this.fetchImpl(apiUrl, { method: "GET", redirect: "manual", signal: requestSignal, headers });
		if (initial.status === 404) return { status: initial.status, available: false, content: "", bytes: 0, complete: false, truncated: false };
		if (![200, 302].includes(initial.status)) throw Object.assign(new Error(`Actions job log availability returned HTTP ${initial.status}`), { retryAfter: this.retryDate(initial) });
		let response = initial;
		if (initial.status === 302) {
			const location = initial.headers.get("location");
			if (!location) throw new Error("Actions job log redirect omitted its download target");
			const target = new URL(location, apiUrl);
			if (target.protocol !== "https:" || target.username || target.password) throw new Error("Actions job log redirect target is not a bounded HTTPS URL");
			if (budget && (++budget.requests > MAX_DIAGNOSTIC_REQUESTS || budget.bytes >= MAX_DIAGNOSTIC_BYTES)) throw new Error("hosted failure diagnostics exceeded their aggregate request/byte budget");
			response = await this.fetchImpl(target, { method: "GET", redirect: "error", signal: requestSignal });
		}
		if (response.status !== 200) throw Object.assign(new Error(`Actions job log content returned HTTP ${response.status}`), { retryAfter: this.retryDate(response) });
		const advertisedSize = Number(response.headers.get("content-length"));
		const remaining = budget ? MAX_DIAGNOSTIC_BYTES - budget.bytes : MAX_DIAGNOSTIC_BYTES;
		// Reserve the complete per-log expanded bound before downloading its archive.
		// Otherwise the archive may fit, then its expansion can push the aggregate
		// over the limit after the expensive response has already been consumed.
		const expandedLogReserve = budget ? 256 * 1024 : 0;
		const archiveLimit = Math.min(2 * 1024 * 1024, Math.max(0, remaining - expandedLogReserve));
		if (Number.isFinite(advertisedSize) && advertisedSize > archiveLimit) throw new Error("Actions job log archive exceeds its aggregate compressed-byte bound");
		const chunks: Uint8Array[] = [];
		let total = 0;
		if (response.body) {
			const reader = response.body.getReader();
			for (;;) {
				const part = await reader.read();
				if (part.done) break;
				total += part.value.byteLength;
				if (total > archiveLimit) { await reader.cancel(); throw new Error("Actions job log archive exceeded its aggregate compressed-byte bound"); }
				chunks.push(part.value);
			}
		} else {
			const bytes = Buffer.from(await response.arrayBuffer());
			if (bytes.length > archiveLimit) throw new Error("Actions job log archive exceeded its aggregate compressed-byte bound");
			chunks.push(bytes); total = bytes.length;
		}
		if (budget) budget.bytes += total;
		const bytes = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)), total);
		const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
		const content = contentType.includes("zip") || bytes.length >= 4 && bytes.readUInt32LE(0) === 0x04034b50 ? actionLogText(bytes) : bytes.toString("utf8");
		if (!content.trim() || Buffer.byteLength(content) > 256 * 1024) throw new Error("Actions job log content is empty or exceeds its complete diagnostic bound");
		if (budget && budget.bytes + Buffer.byteLength(content) > MAX_DIAGNOSTIC_BYTES) throw new Error("hosted failure diagnostics exceeded their aggregate expanded-byte bound");
		if (budget) budget.bytes += Buffer.byteLength(content);
		return { status: response.status, available: true, content, bytes: Buffer.byteLength(content), complete: true, truncated: false };
	}
	private async readFailureEvidence(repo: string, candidateHead: string, checkSubjectSha: string, subject: "head" | "merge", run: HostedChecksObservation["runs"][number], signal?: AbortSignal, budget?: DiagnosticBudget): Promise<NonNullable<HostedChecksObservation["failures"]>[number]> {
		const detail = await this.request<{ id: number; name: string; head_sha: string; conclusion: string; app: { id: number } | null; output: { title: string | null; summary: string | null; text: string | null }; annotations_count: number }>(`repos/${repo}/check-runs/${run.id}`, undefined, signal, budget);
		const output = detail.output;
		if (detail.id !== run.id || detail.name !== run.name || detail.head_sha !== checkSubjectSha || detail.conclusion !== "failure" || detail.app?.id !== run.appId ||
			typeof output?.title !== "string" || typeof output.summary !== "string" || typeof output.text !== "string" ||
			output.title.length > 16_384 || output.summary.length > 32_768 || output.text.length > 32_768 || !Number.isSafeInteger(detail.annotations_count) || detail.annotations_count < 0 || detail.annotations_count > 100) {
			throw new Error("failed check-run detail is incomplete, oversized, or bound to another source attempt");
		}
		const rawAnnotations = await this.request<{ path: string; start_line: number | null; end_line: number | null; annotation_level: string; title: string | null; message: string }[]>(`repos/${repo}/check-runs/${run.id}/annotations?per_page=100`, undefined, signal, budget);
		if (!Array.isArray(rawAnnotations) || rawAnnotations.length !== detail.annotations_count || rawAnnotations.length > 100 || rawAnnotations.some((annotation) =>
			typeof annotation.path !== "string" || annotation.start_line !== null && !Number.isSafeInteger(annotation.start_line) || annotation.end_line !== null && !Number.isSafeInteger(annotation.end_line) ||
			typeof annotation.annotation_level !== "string" || annotation.title !== null && typeof annotation.title !== "string" || typeof annotation.message !== "string" || annotation.message.length > 8_192)) {
			throw new Error("failed check annotations are incomplete or malformed");
		}
		const annotations = rawAnnotations.map((annotation) => ({ path: annotation.path, startLine: annotation.start_line, endLine: annotation.end_line, level: annotation.annotation_level, title: annotation.title ?? "", message: annotation.message }));
		let workflow: NonNullable<NonNullable<HostedChecksObservation["failures"]>[number]["workflow"]> | undefined;
		if (run.workflow) {
			const jobs = await this.request<{ total_count: number; jobs: { id: number; name: string; conclusion: string | null; steps?: { number: number; name: string; conclusion: string | null }[] }[] }>(`repos/${repo}/actions/runs/${run.workflow.id}/attempts/${run.workflow.attempt}/jobs?per_page=100`, undefined, signal, budget);
			if (!Array.isArray(jobs.jobs) || jobs.jobs.length >= 100 || jobs.total_count !== jobs.jobs.length || jobs.jobs.some((job) =>
				!Number.isSafeInteger(job.id) || typeof job.name !== "string" || job.conclusion !== null && typeof job.conclusion !== "string" || !Array.isArray(job.steps) || job.steps.length > 100 || job.steps.some((step) => !Number.isSafeInteger(step.number) || typeof step.name !== "string" || step.conclusion !== null && typeof step.conclusion !== "string"))) {
				throw new Error("failed Actions attempt jobs/steps are incomplete or malformed");
			}
			const failingJobs = jobs.jobs.filter((job) => job.conclusion === "failure");
			if (!failingJobs.length) throw new Error("failed Actions check has no exact failing job in its recorded run attempt");
			const withLogs: NonNullable<NonNullable<HostedChecksObservation["failures"]>[number]["workflow"]>["jobs"] = [];
			for (const job of jobs.jobs) {
				const log = job.conclusion === "failure" ? await this.readActionsJobLog(repo, job.id, signal, budget) : undefined;
				if (job.conclusion === "failure" && (!log?.available || !log.complete || log.truncated)) throw new Error(`failed Actions job ${job.id} has no complete diagnostic log content`);
				withLogs.push({ id: job.id, name: job.name, conclusion: job.conclusion, steps: job.steps!.map((step) => ({ number: step.number, name: step.name, conclusion: step.conclusion })), logStatus: log?.status ?? null, logsAvailable: log?.available ?? null, ...(log ? { logContent: log.content, logBytes: log.bytes, logComplete: log.complete, logTruncated: log.truncated } : {}) });
			}
			workflow = { id: run.workflow.id, attempt: run.workflow.attempt, workflowId: run.workflow.workflowId, event: run.workflow.event, path: run.workflow.path, jobs: withLogs };
		}
		const diagnostics = [output.title, output.summary, output.text, ...annotations.map((annotation) => `${annotation.path}:${annotation.startLine ?? ""}: ${annotation.message}`), ...(workflow?.jobs.map((job) => job.logContent ?? "") ?? [])].join("\n");
		if (infrastructureFailure.test(diagnostics)) throw new Error("failed check is classified as setup, runner, network, cancellation, transient infrastructure, or otherwise non-repairable evidence");
		if (workflow) {
			const failedSteps = workflow.jobs.flatMap((job) => job.conclusion === "failure" ? job.steps.filter((step) => step.conclusion === "failure") : []);
			const codeStep = failedSteps.some((step) => /(?:test|lint|type.?check|compile|build|verify|acceptance|check)/i.test(step.name));
			if (!codeStep || !codeFailure.test(diagnostics)) throw new Error("Actions failure lacks a declared failing code/acceptance step and concrete diagnostic");
		} else if (!codeFailure.test(diagnostics) || !sourceLocation.test(diagnostics)) {
			throw new Error("required check failure lacks a repairable source/acceptance diagnostic");
		}
		const identity = { candidateHead, checkSubjectSha, subject, checkRunId: run.id, suiteId: run.suiteId, appId: run.appId, workflowId: run.workflow?.id, workflowAttempt: run.workflow?.attempt };
		return {
			key: digest(stableJson(identity)), candidateHead, checkSubjectSha, classification: "repairable-code",
			checkRun: { id: run.id, suiteId: run.suiteId, name: run.name, appId: run.appId!, conclusion: "failure", title: output.title, summary: output.summary, text: output.text, outputTruncated: false },
			annotations, annotationsComplete: true, ...(workflow ? { workflow } : {}),
		};
	}
	async snapshot(selected: SelectedItem, dependencyObservation = false, signal?: AbortSignal): Promise<SelectedItem> {
		if (selected.graphObservation && (typeof selected.targetRef !== "string" || !selected.targetRef.trim())) throw new Error("convergence requires an explicit target ref; select it before observation or dispatch");
		if (!/^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.test(selected.repo) || !Number.isSafeInteger(selected.number) || selected.number < 1 || selected.kind === "unknown") throw new Error("resolve selected canonical repository, number and kind in Review");
		const [owner, name] = selected.repo.split("/");
		const result = await this.request<SnapshotResponse>("graphql", { query: `query($owner:String!,$name:String!,$number:Int!){ repository(owner:$owner,name:$name){ id nameWithOwner defaultBranchRef{name target{oid}} issueOrPullRequest(number:$number){ __typename ... on Issue{id title body closed url labels(first:100){nodes{name} pageInfo{hasNextPage}} timelineItems(first:100,itemTypes:[CROSS_REFERENCED_EVENT]){nodes{... on CrossReferencedEvent{source{... on PullRequest{id number state merged baseRefOid headRefOid baseRefName repository{nameWithOwner} closingIssuesReferences(first:100){nodes{number repository{nameWithOwner}} pageInfo{hasNextPage}}}}}} pageInfo{hasNextPage}}} ... on PullRequest{id title body closed merged url baseRefOid headRefOid baseRefName labels(first:100){nodes{name} pageInfo{hasNextPage}} files(first:100){nodes{path} pageInfo{hasNextPage}} closingIssuesReferences(first:100){nodes{number repository{nameWithOwner}} pageInfo{hasNextPage}}}}}}`, variables: { owner, name, number: selected.number } }, signal);
		const repo = result.data?.repository;
		const item = repo?.issueOrPullRequest;
		if (!repo || !item) throw new Error("selected repository/item unavailable; restore access or explicitly revise scope");
		if (typeof repo.id !== "string" || typeof repo.nameWithOwner !== "string" || typeof item.id !== "string" || typeof item.title !== "string" || typeof item.body !== "string" || !Array.isArray(item.labels?.nodes)) throw new Error("malformed canonical item evidence");
		if (repo.nameWithOwner.toLowerCase() !== selected.repo.toLowerCase()) throw new Error(`repository renamed to ${repo.nameWithOwner}; explicitly reselect canonical identity`);
		if ((selected.kind === "pr" ? "PullRequest" : "Issue") !== item.__typename) throw new Error("selected item kind changed; explicitly reselect");
		if (selected.repositoryId && selected.repositoryId !== repo.id || selected.itemId && selected.itemId !== item.id) throw new Error("canonical identity changed; refusing to bind another repository/item");
		if (item.closed && !item.merged && !dependencyObservation) throw new Error("selected item is closed; inspect and explicitly revise scope");
		if (item.labels.pageInfo.hasNextPage || item.files?.pageInfo.hasNextPage || item.closingIssuesReferences?.pageInfo.hasNextPage || item.timelineItems?.pageInfo.hasNextPage) throw new Error("incomplete policy/overlap evidence; resolve item before dispatch");
		if (item.labels.nodes.some((label: { name: string }) => ["hold", "blocked"].includes(label.name))) throw new Error("selected item has hold/blocked policy label");
		if (selected.action === "pr-ready" && item.files?.nodes.some((file: { path: string }) => file.path.startsWith(".github/workflows/"))) throw new Error("workflow-changing PR remains inspectable; Factory refuses workflow push/landing");
		let base = item.baseRefOid ?? repo.defaultBranchRef?.target.oid;
		let head = item.headRefOid ?? repo.defaultBranchRef?.target.oid;
		let baseRef = item.baseRefName ?? repo.defaultBranchRef?.name;
		if (selected.targetRef !== undefined) {
			if (!/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(selected.targetRef) || selected.targetRef.includes("..") || selected.targetRef.endsWith(".lock")) throw new Error("explicit target ref is unsupported");
			if (selected.kind === "pr" && selected.targetRef !== item.baseRefName) throw new Error("selected PR targets a different branch; explicit target authority cannot be redirected");
			const target = await this.request<{ object: { sha: string } }>(`repos/${selected.repo}/git/ref/heads/${encodeURIComponent(selected.targetRef)}`, undefined, signal);
			if (!target.object || !/^[a-f0-9]{40,64}$/.test(target.object.sha)) throw new Error("explicit target branch subject is unavailable");
			baseRef = selected.targetRef;
			base = target.object.sha;
			if (selected.kind === "issue") head = target.object.sha;
		}
		if (!base || !head || !baseRef || !/^[a-f0-9]{40,64}$/.test(base) || !/^[a-f0-9]{40,64}$/.test(head)) throw new Error("selected repository subject unavailable; resolve its base/head before execution");
		const sourcePullRequests: NonNullable<SelectedItem["sourcePullRequests"]> = [];
		if (selected.graphObservation) for (const entry of item.timelineItems?.nodes ?? []) {
			const pull = entry.source;
			if (!pull) continue;
			if (!pull.id || !pull.baseRefOid || !pull.headRefOid || !pull.baseRefName || !pull.closingIssuesReferences || pull.closingIssuesReferences.pageInfo.hasNextPage) throw new Error("incomplete PR implementation relationship evidence");
			sourcePullRequests.push({ key: `${pull.repository.nameWithOwner.toLowerCase()}#${pull.number}`, identity: pull.id, base: pull.baseRefOid, head: pull.headRefOid, baseRef: pull.baseRefName,
				state: pull.merged ? "merged" : pull.state === "OPEN" ? "open" : "closed", implements: pull.closingIssuesReferences.nodes.some((issue) => issue.number === selected.number && issue.repository.nameWithOwner.toLowerCase() === selected.repo.toLowerCase()) });
		}
		const overlaps = [
			...(item.closingIssuesReferences?.nodes ?? []).map((issue) => `${issue.repository.nameWithOwner}#${issue.number}`.toLowerCase()),
			...(selected.graphObservation ? sourcePullRequests.filter((pull) => pull.implements && pull.state === "open").map((pull) => pull.key) : (item.timelineItems?.nodes ?? []).flatMap((entry) => entry.source?.state === "OPEN" ? [`${entry.source.repository.nameWithOwner}#${entry.source.number}`.toLowerCase()] : [])),
		];
		return { ...selected, repo: repo.nameWithOwner.toLowerCase(), key: `${repo.nameWithOwner.toLowerCase()}#${selected.number}`, repositoryId: repo.id, itemId: item.id, url: item.url, acceptance: `${item.title}\n\n${item.body}`, acceptanceRevision: digest(`${item.title}\n${item.body}`), base, head, baseRef, overlaps, ...(repo.defaultBranchRef?.name ? { sourceDefaultRef: repo.defaultBranchRef.name } : {}), ...(selected.graphObservation ? { sourcePullRequests } : {}), sourceState: item.merged ? "merged" : item.closed ? "closed" : "open", blocker: undefined };
	}

	/** Bounded named observation. External prerequisites are read-only nodes, never membership. */
	async observeGraph(selected: readonly SelectedItem[], generation: string): Promise<WorkGraphObservation> {
		const nodes = new Map<string, GraphNodeObservation>();
		const relations: GraphRelation[] = [];
		const selectedKeys = new Set(selected.map((item) => item.key));
		const observe = async (item: SelectedItem): Promise<SelectedItem | undefined> => {
			if (nodes.size >= 42 && !nodes.has(item.key)) throw new Error("bounded prerequisite observation exceeded; unresolved lanes remain unknown");
			try {
				const current = await this.snapshot({ ...item, graphObservation: true }, !selectedKeys.has(item.key));
				const implementation = !selectedKeys.has(item.key) ? current.sourcePullRequests?.find((pull) => pull.implements && pull.state === "merged" && pull.baseRef === current.baseRef) : undefined;
				const proven = current.kind === "pr" && current.sourceState === "merged" || implementation !== undefined;
				nodes.set(current.key, { key: current.key, generation, acceptanceRevision: current.acceptanceRevision, subject: { repo: current.repo, base: current.base!, head: current.head }, required: selectedKeys.has(current.key), selected: selectedKeys.has(current.key), target: current.observe ?? "merged-upstream", state: proven ? "DONE" : current.sourceState === "closed" ? "UNKNOWN" : "QUEUED", proof: proven ? "merged-upstream" : undefined, proofCurrent: proven, blocker: current.sourceState === "closed" && !proven ? "closed issue alone does not prove implementation; observe its actual outcome" : undefined });
				for (const pull of current.sourcePullRequests ?? []) {
					if (!nodes.has(pull.key)) nodes.set(pull.key, { key: pull.key, generation, subject: { repo: pull.key.split("#")[0]!, base: pull.base, head: pull.head }, required: selectedKeys.has(pull.key), selected: selectedKeys.has(pull.key), target: "merged-upstream", state: pull.state === "merged" ? "DONE" : pull.state === "open" ? "QUEUED" : "UNKNOWN", proof: pull.state === "merged" ? "merged-upstream" : undefined, proofCurrent: pull.state === "merged" });
					relations.push({ from: pull.key, to: current.key, kind: "implements", authority: pull.implements ? "authoritative" : "inferred", source: `github:closing-reference:${pull.identity}` });
					if (pull.implements && pull.state === "open") relations.push({ from: current.key, to: pull.key, kind: "overlaps", authority: "authoritative", source: `github:open-implementation:${pull.identity}` });
				}
				if (current.kind === "pr") for (const key of current.overlaps) {
					relations.push({ from: current.key, to: key, kind: "implements", authority: "authoritative", source: `github:closing-reference:${current.itemId}` });
					if (!nodes.has(key) && nodes.size < 42) { const [repo, number] = key.split("#"); await observe({ key, repo: repo!, number: Number(number), kind: "issue", action: "inspect", overlaps: [] }); }
				}
				if (current.kind === "pr" && current.sourceDefaultRef && current.baseRef !== current.sourceDefaultRef) {
					const lower = await this.request<Array<{ number: number; head: { sha: string } }>>(`repos/${current.repo}/pulls?state=open&head=${encodeURIComponent(`${current.repo.split("/")[0]}:${current.baseRef}`)}&per_page=100`);
					if (!Array.isArray(lower) || lower.length > 1) throw new Error("stack ancestry is ambiguous; restore canonical base-branch observation");
					const ancestor = lower[0];
					if (ancestor) {
						if (ancestor.head.sha !== current.base || !Number.isSafeInteger(ancestor.number)) throw new Error("stack base ancestry does not match captured PR base");
						const key = `${current.repo}#${ancestor.number}`;
						relations.push({ from: current.key, to: key, kind: "stacked-on", authority: "authoritative", stage: "merged-upstream", source: `github:base-head-ancestry:${current.itemId}:${current.base}` });
						if (!nodes.has(key)) await observe({ key, repo: current.repo, number: ancestor.number, kind: "pr", action: "inspect", overlaps: [] });
					}
				}
				return current;
			} catch (error) {
				nodes.set(item.key, { key: item.key, generation, required: selectedKeys.has(item.key), selected: selectedKeys.has(item.key), target: "merged-upstream", state: "UNKNOWN", blocker: error instanceof Error ? error.message : String(error) });
				return undefined;
			}
		};
		for (const item of selected) {
			const current = await observe(item);
			if (!current || item.kind !== "issue") continue;
			try {
				for (const [endpoint, kind] of [["dependencies/blocked_by", "requires"], ["sub_issues", "contains"]] as const) {
					const entries = await this.request<Array<{ number: number; repository_url: string }>>(`repos/${item.repo}/issues/${item.number}/${endpoint}?per_page=100`);
					if (!Array.isArray(entries) || entries.length >= 100) throw new Error("incomplete bounded relationship evidence; restore coverage before dispatch");
					for (const entry of entries) {
						const repo = /^https:\/\/api\.github\.com\/repos\/([A-Za-z0-9._-]+\/[A-Za-z0-9._-]+)$/.exec(entry.repository_url)?.[1]?.toLowerCase();
						if (!repo || !Number.isSafeInteger(entry.number) || entry.number < 1) throw new Error("malformed canonical relationship evidence");
						const key = `${repo}#${entry.number}`;
						relations.push({ from: item.key, to: key, kind, authority: "authoritative", source: `github:${endpoint}:${current.itemId}`, ...(kind === "requires" ? { stage: "merged-upstream" as const } : {}) });
						if (!nodes.has(key)) await observe({ key, repo, number: entry.number, kind: "issue", action: "inspect", overlaps: [], ...(repo === item.repo ? { targetRef: current.baseRef } : {}) });
					}
				}
			} catch (error) {
				const node = nodes.get(item.key)!;
				nodes.set(item.key, { ...node, state: "UNKNOWN", blocker: error instanceof Error ? error.message : String(error) });
			}
		}
		return { generation, nodes: [...nodes.values()], relations };
	}
	async assertFresh(selected: SelectedItem, ownedPullRequest?: OwnedPullRequest, signal?: AbortSignal): Promise<void> {
		const current = await this.snapshot(selected, false, signal);
		const currentOverlaps = [...new Set(current.overlaps.map((overlap) => overlap.toLowerCase()))].sort();
		const selectedOverlaps = [...new Set(selected.overlaps.map((overlap) => overlap.toLowerCase()))].sort();
		const ownKey = ownedPullRequest ? `${selected.repo.toLowerCase()}#${ownedPullRequest.number}` : undefined;
		const expectedOverlaps = ownKey && currentOverlaps.includes(ownKey) && !selectedOverlaps.includes(ownKey) ? [...selectedOverlaps, ownKey].sort() : selectedOverlaps;
		if (current.acceptanceRevision !== selected.acceptanceRevision || current.head !== selected.head || current.base !== selected.base || current.baseRef !== selected.baseRef || JSON.stringify(currentOverlaps) !== JSON.stringify(expectedOverlaps)) throw new Error("selected head/base/target/acceptance or overlap scope changed; proof stale, explicitly rebase/reselect instead of chasing moving work");
		if (ownedPullRequest) await this.readOwnedPullRequest(selected.repo, ownedPullRequest, signal);
	}
}
