import assert from "node:assert/strict";
import test from "node:test";
import { operatorLandingDecision } from "../image/extension/review/operator-landing.ts";
import { readOperatorPolicy } from "../image/extension/review/operator-policy.ts";

const item = { type: "pr", repo: "owner/repo", id: 1, author: "owner", draft: false, labels: [], ciStatus: "success", ciEvidenceComplete: true, mergeState: "clean", reviewState: "unknown", headSha: "a".repeat(40) };
const facts = { repository: item.repo, number: 1, headSha: item.headSha, baseRef: "main", authorLogin: "owner", viewerLogin: "owner", canMerge: true, requiredApprovals: 0, requiresCodeOwnerReview: false, requiresLastPushApproval: false, githubReviewState: "none", currentHumanApprovals: [], digest: "d".repeat(64), observedAt: Date.now() };
const policy = readOperatorPolicy(item.repo, {});
const decide = (overrides = {}) => operatorLandingDecision({ item, operatorPolicy: { ...policy, mode: "solo" }, github: facts, reviewerClean: true, action: "merge", ...overrides });

test("solo author may land after independent acceptance without spoofing GitHub approval", () => {
	assert.equal(decide().allowed, true);
	assert.equal(item.reviewState, "unknown");
	assert.equal(decide({ operatorPolicy: policy }).allowed, false);
	assert.match(decide({ operatorPolicy: policy }).reason, /team.*human/i);
	assert.equal(decide({ operatorPolicy: policy, github: { ...facts, currentHumanApprovals: [{ login: "peer", headSha: item.headSha, submittedAt: Date.now() }] } }).allowed, true);
});

test("both presets require current independent review and retain GitHub requirements", () => {
	assert.equal(decide({ reviewerClean: false }).allowed, false);
	for (const change of [{ requiredApprovals: 1 }, { requiresCodeOwnerReview: true }, { requiresLastPushApproval: true }]) {
		const blocked = decide({ github: { ...facts, ...change } });
		assert.equal(blocked.allowed, false);
		assert.match(blocked.reason, /GitHub.*review/i);
	}
	assert.equal(decide({ github: { ...facts, requiredApprovals: 1, githubReviewState: "approved" } }).allowed, true);
});

test("subject, credential, holds and CI cannot be waived by solo", () => {
	for (const github of [{ ...facts, canMerge: false }, { ...facts, headSha: "b".repeat(40) }, { ...facts, number: 2 }, { ...facts, githubReviewState: "changes_requested" }]) assert.equal(decide({ github }).allowed, false);
	for (const change of [{ labels: ["hold"] }, { ciStatus: "pending" }, { ciStatus: "failure" }, { ciEvidenceComplete: false }, { mergeState: "dirty" }, { draft: true }]) assert.equal(decide({ item: { ...item, ...change } }).allowed, false);
	assert.equal(decide({ action: "approve" }).allowed, false, "never self-approve");
});
