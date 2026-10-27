import { createHash } from "node:crypto";
import { deadlineSignal } from "./deadline.ts";
import { QUEUE_TIMEOUT_MS, type FetchOptions } from "./github.ts";

export interface HumanReviewFacts {
	readonly repository: string;
	readonly number: number;
	readonly headSha: string;
	readonly baseRef: string;
	readonly authorLogin: string;
	readonly viewerLogin: string;
	readonly canMerge: boolean;
	readonly requiredApprovals: number;
	readonly requiresCodeOwnerReview: boolean;
	readonly requiresLastPushApproval: boolean;
	readonly githubReviewState: "approved" | "required" | "changes_requested" | "none";
	readonly currentHumanApprovals: readonly { login: string; headSha: string; submittedAt: number }[];
	readonly digest: string;
	readonly observedAt: number;
}

export type HumanReviewObservation = { kind: "observed"; facts: HumanReviewFacts } | { kind: "unknown"; reason: string };

type RecordValue = Record<string, unknown>;
const isRecord = (value: unknown): value is RecordValue => typeof value === "object" && value !== null && !Array.isArray(value);
const OTHER_KNOWN_RULE_TYPES = new Set(["creation", "update", "deletion", "non_fast_forward", "required_status_checks", "required_signatures", "required_deployments", "required_linear_history", "file_path_restriction", "max_file_path_length", "max_branch_name_length", "commit_message_pattern", "commit_author_email_pattern", "committer_email_pattern", "branch_name_pattern", "max_file_size"]);
const MAX_REVIEW_PAGES = 10;

/** Read the effective GitHub human-review gate for one exact PR head. */
export async function observeHumanReviewPolicy(repository: string, number: number, options: FetchOptions = {}): Promise<HumanReviewObservation> {
	const token = options.token;
	if (!token) return unknown("no GitHub credential (set GH_TOKEN or run gh auth login)");
	const [owner, name, extra] = repository.split("/");
	if (!owner || !name || extra !== undefined || !Number.isSafeInteger(number) || number < 1) return unknown("invalid pull-request identity");
	const fetchImpl = options.fetchImpl ?? fetch;
	const signal = deadlineSignal(options.timeoutMs ?? QUEUE_TIMEOUT_MS, options.signal);
	const api = async (url: string, init?: RequestInit): Promise<Response> => fetchImpl(url, { ...init, headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28", ...(init?.headers ?? {}) }, signal, redirect: "error" });
	const graph = async (query: string, variables?: Record<string, unknown>): Promise<RecordValue> => {
		const response = await api("https://api.github.com/graphql", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ query, variables }) });
		if (!response.ok) throw new Error(`GitHub GraphQL ${response.status} ${response.statusText}`);
		const payload: unknown = await response.json();
		if (!isRecord(payload) || !isRecord(payload.data) || ("errors" in payload && (!Array.isArray(payload.errors) || payload.errors.length > 0))) throw new Error("GitHub GraphQL returned errors or incomplete data");
		return payload.data;
	};
	try {
		const data = await graph(`query($owner:String!, $name:String!, $number:Int!) {
			viewer { login }
			repository(owner:$owner,name:$name) { nameWithOwner pullRequest(number:$number) {
				number headRefOid baseRefName author { login }
				reviewDecision
				baseRef { name branchProtectionRule { pattern requiresApprovingReviews requiredApprovingReviewCount requiresCodeOwnerReviews requireLastPushApproval dismissesStaleReviews } }
				latestReviews(first:100) { pageInfo { hasNextPage endCursor } nodes { state submittedAt author { __typename login } commit { oid } } }
			} }
		}`, { owner, name, number });
		const viewer = isRecord(data.viewer) ? data.viewer : undefined;
		const repo = isRecord(data.repository) ? data.repository : undefined;
		const pr = repo && isRecord(repo.pullRequest) ? repo.pullRequest : undefined;
		if (!viewer || typeof viewer.login !== "string" || !repo || typeof repo.nameWithOwner !== "string" || repo.nameWithOwner.toLowerCase() !== repository.toLowerCase() || !pr || pr.number !== number || typeof pr.headRefOid !== "string" || !/^[0-9a-f]{40}$/i.test(pr.headRefOid) || typeof pr.baseRefName !== "string" || !isRecord(pr.author) || typeof pr.author.login !== "string" || !isRecord(pr.baseRef) || pr.baseRef.name !== pr.baseRefName) throw new Error("GitHub returned ambiguous pull-request identity evidence");
		const headSha = pr.headRefOid;
		const baseRef = pr.baseRefName;
		const canonicalRepository = repo.nameWithOwner;
		const authorLogin = pr.author.login;
		const decision = pr.reviewDecision;
		if (decision !== null && decision !== "APPROVED" && decision !== "REVIEW_REQUIRED" && decision !== "CHANGES_REQUESTED") throw new Error("GitHub returned an unsupported aggregate review decision");
		const classic = pr.baseRef.branchProtectionRule;
		if (classic !== null && (!isRecord(classic) || typeof classic.pattern !== "string" || typeof classic.requiresApprovingReviews !== "boolean" || typeof classic.requiredApprovingReviewCount !== "number" || !Number.isSafeInteger(classic.requiredApprovingReviewCount) || classic.requiredApprovingReviewCount < 0 || typeof classic.requiresCodeOwnerReviews !== "boolean" || typeof classic.requireLastPushApproval !== "boolean" || typeof classic.dismissesStaleReviews !== "boolean")) throw new Error("GitHub returned incomplete classic branch-protection evidence");
		const restRepo = await api(`https://api.github.com/repos/${repository}`);
		if (!restRepo.ok) throw new Error(`GitHub repository permission lookup ${restRepo.status} ${restRepo.statusText}`);
		const repoInfo: unknown = await restRepo.json();
		if (!isRecord(repoInfo) || typeof repoInfo.full_name !== "string" || repoInfo.full_name.toLowerCase() !== repository.toLowerCase() || !isRecord(repoInfo.permissions) || ["admin", "maintain", "push"].some(key => typeof repoInfo.permissions?.[key] !== "boolean")) throw new Error("GitHub returned incomplete viewer-permission evidence");
		const canMerge = repoInfo.permissions.admin === true || repoInfo.permissions.maintain === true || repoInfo.permissions.push === true;
		const rules = await fetchRules(api, repository, baseRef);
		let requiredApprovals = classic?.requiresApprovingReviews === true ? classic.requiredApprovingReviewCount : 0;
		let requiresCodeOwnerReview = classic?.requiresApprovingReviews === true && classic.requiresCodeOwnerReviews;
		let requiresLastPushApproval = classic?.requiresApprovingReviews === true && classic.requireLastPushApproval;
		for (const rule of rules) {
			if (!isRecord(rule) || typeof rule.type !== "string") throw new Error("GitHub returned malformed effective branch-rule evidence");
			if (OTHER_KNOWN_RULE_TYPES.has(rule.type)) continue;
			if (rule.type !== "pull_request") throw new Error(`unsupported applicable branch rule: ${rule.type}`);
			if (!isRecord(rule.parameters) || typeof rule.parameters.required_approving_review_count !== "number" || !Number.isSafeInteger(rule.parameters.required_approving_review_count) || rule.parameters.required_approving_review_count < 0 || typeof rule.parameters.dismiss_stale_reviews !== "boolean" || typeof rule.parameters.require_code_owner_review !== "boolean" || typeof rule.parameters.require_last_push_approval !== "boolean") throw new Error("GitHub returned incomplete pull-request rule parameters");
			const knownPullRequestParameters = new Set(["required_approving_review_count", "dismiss_stale_reviews", "require_code_owner_review", "require_last_push_approval", "required_review_thread_resolution", "allowed_merge_methods"]);
			if (Object.keys(rule.parameters).some(key => !knownPullRequestParameters.has(key)) || ("required_review_thread_resolution" in rule.parameters && typeof rule.parameters.required_review_thread_resolution !== "boolean") || ("allowed_merge_methods" in rule.parameters && (!Array.isArray(rule.parameters.allowed_merge_methods) || !rule.parameters.allowed_merge_methods.every(value => typeof value === "string")))) throw new Error("GitHub returned unsupported pull-request rule parameters");
			requiredApprovals = Math.max(requiredApprovals, rule.parameters.required_approving_review_count);
			requiresCodeOwnerReview ||= rule.parameters.require_code_owner_review;
			requiresLastPushApproval ||= rule.parameters.require_last_push_approval;
		}
		const approvals: HumanReviewFacts["currentHumanApprovals"][number][] = [];
		const seen = new Set<string>();
		let after: string | null = null;
		const seenCursors = new Set<string>();
		let reviewPages = 0;
		let hasBlockingChangesRequested = false;
		let reviewPage = isRecord(pr.latestReviews) ? pr.latestReviews : undefined;
		for (;;) {
			if (++reviewPages > MAX_REVIEW_PAGES) throw new Error("latest-review pagination exceeded its bounded page limit");
			if (!reviewPage || !isRecord(reviewPage.pageInfo) || typeof reviewPage.pageInfo.hasNextPage !== "boolean" || !Array.isArray(reviewPage.nodes)) throw new Error("GitHub returned incomplete latest-review evidence");
			for (const item of reviewPage.nodes) {
				if (!isRecord(item) || typeof item.state !== "string" || typeof item.submittedAt !== "string" || !Number.isFinite(Date.parse(item.submittedAt)) || !isRecord(item.author) || typeof item.author.__typename !== "string" || typeof item.author.login !== "string" || (item.commit !== null && (!isRecord(item.commit) || typeof item.commit.oid !== "string"))) throw new Error("GitHub returned malformed latest-review evidence");
				const login = item.author.login;
				if (item.state === "CHANGES_REQUESTED") hasBlockingChangesRequested = true;
				if (item.author.__typename === "User" && login.toLowerCase() !== authorLogin.toLowerCase() && item.state === "APPROVED" && isRecord(item.commit) && item.commit.oid === headSha && !seen.has(login.toLowerCase())) {
					seen.add(login.toLowerCase());
					const permissionResponse = await api(`https://api.github.com/repos/${repository}/collaborators/${encodeURIComponent(login)}/permission`);
					if (!permissionResponse.ok) throw new Error(`reviewer permission lookup for ${login} returned ${permissionResponse.status}`);
					const permissionData: unknown = await permissionResponse.json();
					if (!isRecord(permissionData) || typeof permissionData.permission !== "string") throw new Error(`reviewer permission lookup for ${login} was incomplete`);
					if (["admin", "maintain", "write"].includes(permissionData.permission)) approvals.push({ login, headSha, submittedAt: Date.parse(item.submittedAt) });
				}
			}
			if (!reviewPage.pageInfo.hasNextPage) break;
			after = typeof reviewPage.pageInfo.endCursor === "string" ? reviewPage.pageInfo.endCursor : null;
			if (!after) throw new Error("GitHub latest-review pagination cursor is missing");
			if (seenCursors.has(after)) throw new Error("GitHub repeated a latest-review pagination cursor");
			seenCursors.add(after);
			const next = await graph(`query($owner:String!, $name:String!, $number:Int!, $after:String!) { repository(owner:$owner,name:$name) { nameWithOwner pullRequest(number:$number) { number headRefOid latestReviews(first:100,after:$after) { pageInfo { hasNextPage endCursor } nodes { state submittedAt author { __typename login } commit { oid } } } } } }`, { owner, name, number, after });
			const nextRepo = isRecord(next.repository) ? next.repository : undefined;
			const nextPr = nextRepo && isRecord(nextRepo.pullRequest) ? nextRepo.pullRequest : undefined;
			if (typeof nextRepo?.nameWithOwner !== "string" || nextRepo.nameWithOwner.toLowerCase() !== repository.toLowerCase() || !nextPr || nextPr.number !== number || nextPr.headRefOid !== headSha) throw new Error("pull-request identity changed during review pagination");
			reviewPage = isRecord(nextPr.latestReviews) ? nextPr.latestReviews : undefined;
		}
		if (requiredApprovals > 0 && decision === null) throw new Error("GitHub aggregate review decision is null despite an active approval requirement");
		const githubReviewState = hasBlockingChangesRequested || decision === "CHANGES_REQUESTED" ? "changes_requested" : decision === "APPROVED" ? "approved" : decision === "REVIEW_REQUIRED" ? "required" : requiredApprovals > 0 || requiresCodeOwnerReview || requiresLastPushApproval ? "required" : "none";
		const stable = { repository: canonicalRepository, number, headSha, baseRef, authorLogin, viewerLogin: viewer.login, canMerge, requiredApprovals, requiresCodeOwnerReview, requiresLastPushApproval, githubReviewState, currentHumanApprovals: approvals };
		const digest = createHash("sha256").update(stableJson({ facts: stable, classic, rules, credential: token })).digest("hex");
		return { kind: "observed", facts: { ...stable, digest, observedAt: Date.now() } };
	} catch (error) {
		return unknown(options.signal?.aborted ? "human-review policy read cancelled" : error instanceof Error ? error.message : String(error));
	}
}

async function fetchRules(api: (url: string, init?: RequestInit) => Promise<Response>, repository: string, baseRef: string): Promise<unknown[]> {
	const out: unknown[] = [];
	let url: string | undefined = `https://api.github.com/repos/${repository}/rules/branches/${encodeURIComponent(baseRef)}?per_page=100`;
	for (let page = 0; url; page++) {
		if (page >= 10) throw new Error("effective branch-rule pagination exceeded its bounded page limit");
		const response = await api(url);
		if (!response.ok) throw new Error(`GitHub effective branch-rule lookup ${response.status} ${response.statusText}`);
		const payload: unknown = await response.json();
		if (!Array.isArray(payload)) throw new Error("GitHub returned incomplete effective branch-rule evidence");
		out.push(...payload);
		const link = response.headers.get("link");
		const next = link?.split(",").map(part => part.match(/<([^>]+)>;\s*rel="next"/)).find(Boolean)?.[1];
		if (next && new URL(next).origin !== "https://api.github.com") throw new Error("GitHub returned an off-origin branch-rule pagination link");
		url = next;
	}
	return out;
}

function unknown(reason: string): HumanReviewObservation { return { kind: "unknown", reason }; }

function stableJson(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
	if (isRecord(value)) return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
	return JSON.stringify(value) ?? "null";
}
