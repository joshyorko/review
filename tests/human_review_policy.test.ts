import assert from "node:assert/strict";
import test from "node:test";
import { observeHumanReviewPolicy } from "../image/extension/review/human-review-policy.ts";

const HEAD = "a".repeat(40);
const response = (body: unknown, status = 200, headers: Record<string, string> = {}) => ({
	ok: status >= 200 && status < 300, status, statusText: status === 200 ? "OK" : "Not Found",
	headers: { get: (name: string) => headers[name.toLowerCase()] ?? null }, json: async () => body,
}) as Response;

function fixture(options: { classic?: unknown; decision?: unknown; rules?: unknown; rulesPages?: unknown[][]; ruleStatus?: number; permission?: string; reviewerPermission?: string; reviewerStatus?: number; reviewPages?: unknown[]; graphError?: boolean; graphErrorsValue?: unknown; head?: string; base?: string } = {}) {
	const calls: string[] = [];
	let reviewPageIndex = 1;
	const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
		const url = String(input);
		calls.push(url);
		if (url.endsWith("/graphql")) {
			const body = JSON.parse(String(init?.body));
			if (options.graphError) return response({ data: {}, errors: options.graphErrorsValue ?? [{ message: "forbidden field" }] });
			if (body.variables?.after) {
				const reviews = options.reviewPages?.[reviewPageIndex++] ?? { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] };
				return response({ data: { repository: { nameWithOwner: "acme/widget", pullRequest: { number: 7, headRefOid: options.head ?? HEAD, latestReviews: reviews } } } });
			}
			return response({ data: { viewer: { login: "maintainer" }, repository: { nameWithOwner: "acme/widget", pullRequest: {
				number: 7, headRefOid: options.head ?? HEAD, baseRefName: options.base ?? "main", author: { login: "author" }, reviewDecision: options.decision ?? null,
				baseRef: { name: options.base ?? "main", branchProtectionRule: options.classic ?? null },
				latestReviews: options.reviewPages?.[0] ?? { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] },
			} } } });
		}
		if (url === "https://api.github.com/repos/acme/widget") return response({ full_name: "acme/widget", ...(options.permission === "missing" ? {} : { permissions: { admin: options.permission === "admin", maintain: options.permission === "maintain", push: options.permission !== "read" } }) });
		if (url.includes("/rules/branches/")) {
			if ((options.ruleStatus ?? 200) !== 200) return response({}, options.ruleStatus);
			if (options.rulesPages) return response(options.rulesPages[url.includes("page=2") ? 1 : 0] ?? [], 200, url.includes("page=2") ? {} : { link: '<https://api.github.com/repos/acme/widget/rules/branches/main?per_page=100&page=2>; rel="next"' });
			return response(options.rules ?? []);
		}
		if (url.includes("/collaborators/")) return response({ permission: options.reviewerPermission ?? "write" }, options.reviewerStatus ?? 200);
		throw new Error(`unexpected URL ${url}`);
	};
	return { calls, fetchImpl };
}

const reviewPage = (reviews: unknown[], hasNextPage = false, endCursor: string | null = null) => ({ pageInfo: { hasNextPage, endCursor }, nodes: reviews });
const approval = (login: string, oid = HEAD, type = "User") => ({ state: "APPROVED", submittedAt: "2026-10-27T12:00:00Z", author: { __typename: type, login }, commit: { oid } });
const review = (state: string, login: string, oid = HEAD) => ({ state, submittedAt: "2026-10-27T12:00:00Z", author: { __typename: "User", login }, commit: { oid } });

test("combines classic protection and inherited active rules with exact PR identity", async () => {
	const { fetchImpl } = fixture({
		decision: "REVIEW_REQUIRED",
		classic: { pattern: "main", requiresApprovingReviews: true, requiredApprovingReviewCount: 1, requiresCodeOwnerReviews: true, requireLastPushApproval: false, dismissesStaleReviews: true },
		rules: [{ type: "pull_request", parameters: { required_approving_review_count: 2, dismiss_stale_reviews: true, require_code_owner_review: false, require_last_push_approval: true } }, { type: "required_status_checks", parameters: { required_status_checks: [] } }, { type: "creation" }, { type: "update" }, { type: "deletion" }, { type: "non_fast_forward" }],
	});
	const result = await observeHumanReviewPolicy("acme/widget", 7, { token: "test", fetchImpl });
	assert.equal(result.kind, "observed");
	if (result.kind !== "observed") return;
	assert.deepEqual({ repo: result.facts.repository, number: result.facts.number, head: result.facts.headSha, base: result.facts.baseRef, viewer: result.facts.viewerLogin }, { repo: "acme/widget", number: 7, head: HEAD, base: "main", viewer: "maintainer" });
	assert.equal(result.facts.requiredApprovals, 2);
	assert.equal(result.facts.requiresCodeOwnerReview, true);
	assert.equal(result.facts.requiresLastPushApproval, true);
	assert.equal(result.facts.githubReviewState, "required");
});

test("only current-head approvals by non-author human users with write access count", async () => {
	const { fetchImpl } = fixture({ reviewPages: [reviewPage([approval("author"), approval("bot", HEAD, "Bot"), approval("old", "b".repeat(40)), approval("reviewer")])] });
	const result = await observeHumanReviewPolicy("acme/widget", 7, { token: "test", fetchImpl });
	assert.equal(result.kind, "observed");
	if (result.kind === "observed") assert.deepEqual(result.facts.currentHumanApprovals.map(item => item.login), ["reviewer"]);
});

test("complete absence plus null aggregate is no required human review", async () => {
	const { fetchImpl } = fixture();
	const result = await observeHumanReviewPolicy("acme/widget", 7, { token: "test", fetchImpl });
	assert.equal(result.kind, "observed");
	if (result.kind === "observed") assert.equal(result.facts.githubReviewState, "none");
});

test("a current blocking aggregate decision is preserved", async () => {
	const { fetchImpl } = fixture({ decision: "CHANGES_REQUESTED" });
	const result = await observeHumanReviewPolicy("acme/widget", 7, { token: "test", fetchImpl });
	assert.equal(result.kind, "observed");
	if (result.kind === "observed") assert.equal(result.facts.githubReviewState, "changes_requested");
});

test("latest non-dismissed changes-requested review blocks even without aggregate policy", async () => {
	for (const decision of [null, "APPROVED"]) {
		const { fetchImpl } = fixture({ decision, reviewPages: [reviewPage([review("CHANGES_REQUESTED", "reviewer"), review("DISMISSED", "other")])] });
		const result = await observeHumanReviewPolicy("acme/widget", 7, { token: "test", fetchImpl });
		assert.equal(result.kind, "observed");
		if (result.kind === "observed") assert.equal(result.facts.githubReviewState, "changes_requested");
	}
});

test("null aggregate with active approval requirement is unknown", async () => {
	const { fetchImpl } = fixture({ classic: { pattern: "main", requiresApprovingReviews: true, requiredApprovingReviewCount: 1, requiresCodeOwnerReviews: false, requireLastPushApproval: false, dismissesStaleReviews: false } });
	const result = await observeHumanReviewPolicy("acme/widget", 7, { token: "test", fetchImpl });
	assert.equal(result.kind, "unknown");
	const invalid = fixture({ decision: "REVIEW_REQUIRED", classic: { pattern: "main", requiresApprovingReviews: true, requiredApprovingReviewCount: -1, requiresCodeOwnerReviews: false, requireLastPushApproval: false, dismissesStaleReviews: false } });
	assert.equal((await observeHumanReviewPolicy("acme/widget", 7, { token: "test", fetchImpl: invalid.fetchImpl })).kind, "unknown");
});

test("classic configured count is ignored when requiresApprovingReviews is false", async () => {
	const { fetchImpl } = fixture({ classic: { pattern: "main", requiresApprovingReviews: false, requiredApprovingReviewCount: 2, requiresCodeOwnerReviews: true, requireLastPushApproval: true, dismissesStaleReviews: true } });
	const result = await observeHumanReviewPolicy("acme/widget", 7, { token: "test", fetchImpl });
	assert.equal(result.kind, "observed");
	if (result.kind === "observed") {
		assert.equal(result.facts.requiredApprovals, 0);
		assert.equal(result.facts.requiresCodeOwnerReview, false);
		assert.equal(result.facts.requiresLastPushApproval, false);
		assert.equal(result.facts.githubReviewState, "none");
	}
});

test("inaccessible effective rules, partial GraphQL errors, and unsupported rules fail closed", async () => {
	for (const options of [{ ruleStatus: 404 }, { graphError: true }, { graphError: true, graphErrorsValue: "unexpected" }, { rules: [{ type: "new_unknown_rule", parameters: {} }] }, { rules: [{ type: "merge_queue", parameters: {} }] }, { rules: [{ type: "workflows", parameters: {} }] }]) {
		const { fetchImpl } = fixture(options);
		assert.equal((await observeHumanReviewPolicy("acme/widget", 7, { token: "test", fetchImpl })).kind, "unknown");
	}
});

test("pull_request rule review fields are parsed and dismissal policy binds the digest", async () => {
	const base = { type: "pull_request", parameters: { required_approving_review_count: 1, dismiss_stale_reviews: false, require_code_owner_review: true, require_last_push_approval: true } };
	const one = fixture({ decision: "REVIEW_REQUIRED", rules: [base] });
	const two = fixture({ decision: "REVIEW_REQUIRED", rules: [{ ...base, parameters: { ...base.parameters, dismiss_stale_reviews: true } }] });
	const a = await observeHumanReviewPolicy("acme/widget", 7, { token: "test", fetchImpl: one.fetchImpl });
	const b = await observeHumanReviewPolicy("acme/widget", 7, { token: "test", fetchImpl: two.fetchImpl });
	assert.equal(a.kind, "observed"); assert.equal(b.kind, "observed");
	if (a.kind === "observed" && b.kind === "observed") {
		assert.equal(a.facts.requiredApprovals, 1);
		assert.equal(a.facts.requiresCodeOwnerReview, true);
		assert.equal(a.facts.requiresLastPushApproval, true);
		assert.notEqual(a.facts.digest, b.facts.digest);
	}
});

test("repeated review cursors and more than ten review pages are unknown", async () => {
	const repeated = fixture({ decision: "REVIEW_REQUIRED", reviewPages: [reviewPage([], true, "same"), reviewPage([], true, "same")] });
	assert.equal((await observeHumanReviewPolicy("acme/widget", 7, { token: "test", fetchImpl: repeated.fetchImpl })).kind, "unknown");
	const many = fixture({ decision: "REVIEW_REQUIRED", reviewPages: Array.from({ length: 11 }, (_, index) => reviewPage([], true, `cursor-${index}`)) });
	assert.equal((await observeHumanReviewPolicy("acme/widget", 7, { token: "test", fetchImpl: many.fetchImpl })).kind, "unknown");
});

test("review and rule pages are walked to completion", async () => {
	const { fetchImpl, calls } = fixture({
		decision: "REVIEW_REQUIRED",
		rulesPages: [[{ type: "pull_request", parameters: { required_approving_review_count: 1, dismiss_stale_reviews: false, require_code_owner_review: false, require_last_push_approval: false } }], []],
		reviewPages: [reviewPage([], true, "cursor-1"), reviewPage([approval("reviewer")])],
	});
	const result = await observeHumanReviewPolicy("acme/widget", 7, { token: "test", fetchImpl });
	assert.equal(result.kind, "observed");
	assert.equal(calls.filter(url => url.endsWith("/graphql")).length, 2);
	assert.equal(calls.filter(url => url.includes("/rules/branches/")).length, 2);
});

test("missing viewer permission fails closed; read permission is not merge-capable", async () => {
	const missing = fixture({ permission: "missing" });
	assert.equal((await observeHumanReviewPolicy("acme/widget", 7, { token: "test", fetchImpl: missing.fetchImpl })).kind, "unknown");
	const read = fixture({ permission: "read" });
	const result = await observeHumanReviewPolicy("acme/widget", 7, { token: "test", fetchImpl: read.fetchImpl });
	assert.equal(result.kind, "observed");
	if (result.kind === "observed") assert.equal(result.facts.canMerge, false);
});

test("digest binds the viewer and policy but excludes observation time", async () => {
	const one = fixture({ permission: "write" });
	const two = fixture({ permission: "read" });
	const a = await observeHumanReviewPolicy("acme/widget", 7, { token: "test", fetchImpl: one.fetchImpl });
	const b = await observeHumanReviewPolicy("acme/widget", 7, { token: "test", fetchImpl: two.fetchImpl });
	const c = await observeHumanReviewPolicy("acme/widget", 7, { token: "other-credential", fetchImpl: one.fetchImpl });
	await new Promise(resolve => setTimeout(resolve, 2));
	const d = await observeHumanReviewPolicy("acme/widget", 7, { token: "test", fetchImpl: one.fetchImpl });
	assert.equal(a.kind, "observed"); assert.equal(b.kind, "observed"); assert.equal(c.kind, "observed"); assert.equal(d.kind, "observed");
	if (a.kind === "observed" && b.kind === "observed" && c.kind === "observed" && d.kind === "observed") {
		assert.notEqual(a.facts.digest, b.facts.digest);
		assert.notEqual(a.facts.digest, c.facts.digest);
		assert.equal(a.facts.digest, d.facts.digest);
		assert.notEqual(a.facts.observedAt, d.facts.observedAt);
	}
});
