import assert from "node:assert/strict";
import test from "node:test";
import { buildReviewRecap, type ReviewRecapInput } from "../image/extension/bluefin-review/recap.ts";

const base = (): ReviewRecapInput => ({
	source: { sessionId: "source-session", branchId: "branch-a", authoritySource: "Review persisted state" },
	observedAt: 1_790_000_000_000,
	scope: "acme/widgets",
	queue: { kind: "available", observedAt: 1_789_999_000_000, itemCount: 2 },
	selection: [
		{ repo: "acme/widgets", id: 17, type: "issue", title: "Bound trace output", url: "https://github.com/acme/widgets/issues/17" },
		{ repo: "acme/widgets", id: 18, type: "pr", title: "Add bounded capture", url: "https://github.com/acme/widgets/pull/18", headSha: "head-18" },
	],
	observations: [],
	operations: [{
		id: "batch-1",
		kind: "slay",
		state: "blocked",
		completedItems: 1,
		totalItems: 2,
		startedAt: 1_789_998_000_000,
		items: [
			{ repo: "acme/widgets", id: 17, type: "issue" },
			{ repo: "acme/widgets", id: 18, type: "pr", headSha: "head-18" },
		],
		error: "uncertain worker result",
	}],
	comments: [{ state: "complete", targets: ["acme/widgets#17"], receipts: ["https://github.com/acme/widgets/issues/17#issuecomment-5"], body: "private comment text" }],
	trace: [{
		id: "turn/1",
		label: "turn 1",
		status: "failure",
		logs: ["Tests passed but native result is failed", "GH_TOKEN=never-export-this"],
		children: [{ id: "tool/1", label: "bash(secret command value)", status: "failure", logs: ["ghp_super_secret_value"] }],
	}],
	artifacts: [
		{ kind: "available", sessionId: "source-session", uri: "artifact://42", path: "/state/omp/sessions/source/artifacts/42.bash.log" },
		{ kind: "unavailable", sessionId: "source-session", uri: "artifact://43", reason: "expired" },
	],
	verification: [],
	remaining: ["refresh the current repository and head", "reconcile the blocked worker effect"],
});

test("the deterministic recap keeps source identities and truthful blocked/unknown outcomes", () => {
	const recap = buildReviewRecap(base());
	assert.match(recap.text, /source-session/);
	assert.match(recap.text, /acme\/widgets#18.*head-18/);
	assert.match(recap.text, /blocked/i);
	assert.match(recap.text, /verification.*unknown|no.*verification receipt/i);
	assert.match(recap.text, /refresh the current repository and head/i);
	assert.doesNotMatch(recap.text, /Tests passed/);
	assert.doesNotMatch(recap.text, /private comment text/);
});

test("a failed native result and unavailable publication evidence cannot produce a false-green recap", () => {
	const input = base();
	input.queue = { kind: "unavailable", reason: "offline", observedAt: input.observedAt };
	input.comments = [{ state: "failed", targets: ["acme/widgets#17"], receipts: [], body: "private comment text" }];
	input.verification = [];
	const recap = buildReviewRecap(input);
	assert.match(recap.text, /offline/i);
	assert.match(recap.text, /failed/i);
	assert.match(recap.text, /unknown/i);
	assert.doesNotMatch(recap.text, /verified successfully|all checks passed|published successfully/i);
});

test("expired native artifacts are identified as unavailable, never as retained evidence", () => {
	const input = base();
	const recap = buildReviewRecap(input);
	assert.match(recap.text, /artifact:\/\/42.*complete/i);
	assert.match(recap.text, /artifact:\/\/43.*expired|unavailable/i);
	assert.match(recap.handoffText, /source-session/);
	assert.match(recap.handoffText, /revalidate|refresh/i);
});

test("stable IDs distinguish source sessions and changed selections without depending on render time", () => {
	const first = buildReviewRecap(base());
	const sameFactsLater = base();
	sameFactsLater.observedAt += 60_000;
	assert.equal(buildReviewRecap(sameFactsLater).id, first.id);

	const otherSession = base();
	otherSession.source = { ...otherSession.source, sessionId: "another-session" };
	assert.notEqual(buildReviewRecap(otherSession).id, first.id);
	const otherBranch = base();
	otherBranch.source = { ...otherBranch.source, branchId: "branch-b" };
	assert.notEqual(buildReviewRecap(otherBranch).id, first.id);

	const movedSelection = base();
	movedSelection.selection = [{ ...movedSelection.selection[1]!, headSha: "head-moved" }];
	assert.notEqual(buildReviewRecap(movedSelection).id, first.id);
});

test("recap identity includes native outcomes, artifact facts, publication receipts, verification and its persisted source", () => {
	const original = base();
	const recap = buildReviewRecap(original);
	assert.match(recap.text, /Review persisted state/);
	assert.match(recap.text, /issuecomment-5/);
	assert.doesNotMatch(recap.text, /private comment text/);

	const changedTrace = base();
	changedTrace.trace[0]!.status = "success";
	assert.notEqual(buildReviewRecap(changedTrace).id, recap.id);
	const changedArtifact = base();
	changedArtifact.artifacts[0] = { ...changedArtifact.artifacts[0]!, path: "/state/new-source.bash.log" };
	assert.notEqual(buildReviewRecap(changedArtifact).id, recap.id);
	const changedReceipt = base();
	changedReceipt.comments[0]!.receipts = ["https://github.com/acme/widgets/issues/17#issuecomment-6"];
	assert.notEqual(buildReviewRecap(changedReceipt).id, recap.id);
	const verified = base();
	verified.verification = [{ subject: "acme/widgets#18", status: "passed", receipt: "checks://run/17" }];
	assert.notEqual(buildReviewRecap(verified).id, recap.id);
});

test("queue CI and PR states are timestamped observations, never verification or receipts", () => {
	const input = base();
	input.observations = [{ subject: "acme/widgets#18 head=head-18", observedAt: input.queue.observedAt, status: "current queue observation; ci=success; review=approved; merge=clean", sourceUrl: "https://github.com/acme/widgets/pull/18" }];
	const recap = buildReviewRecap(input);
	assert.match(recap.text, /timestamped queue observations \(not verification\)/i);
	assert.match(recap.text, new RegExp(`observed=${new Date(input.queue.observedAt).toISOString()}`));
	assert.match(recap.text, /queue source URL=https:\/\/github.com\/acme\/widgets\/pull\/18/);
	assert.match(recap.text, /verification: unknown; no verification receipt observed/i);
	assert.doesNotMatch(recap.text, /verified successfully|receipt=https:\/\/github.com\/acme\/widgets\/pull\/18/i);
	assert.notEqual(buildReviewRecap(input).id, buildReviewRecap({ ...input, observations: [{ ...input.observations[0]!, status: "current queue observation; ci=failure; review=changes_requested; merge=dirty" }] }).id);
});

test("handoff content excludes raw logs, common credentials, and unselected session data", () => {
	const input = base();
	input.selection = [{ ...input.selection[0]!, title: "Build uses GH_TOKEN=top-secret-value" }];
	const recap = buildReviewRecap(input);
	assert.doesNotMatch(recap.text, /top-secret-value|never-export-this|ghp_super_secret_value/);
	assert.doesNotMatch(recap.handoffText, /top-secret-value|never-export-this|ghp_super_secret_value/);
	assert.doesNotMatch(recap.handoffText, /private comment text/);
});

test("recap and handoff payloads stay finite under oversized issue and tool data", () => {
	const input = base();
	input.selection = Array.from({ length: 1_000 }, (_, id) => ({
		repo: "acme/widgets",
		id: id + 1,
		type: "issue" as const,
		title: "x".repeat(16_384),
		url: `https://github.com/acme/widgets/issues/${id + 1}`,
	}));
	input.trace = Array.from({ length: 1_000 }, (_, id) => ({ id: `span/${id}`, label: "bash", status: "success" as const, logs: ["large".repeat(4_096)] }));
	const recap = buildReviewRecap(input);
	assert.ok(Buffer.byteLength(recap.text, "utf8") <= 16 * 1024);
	assert.ok(Buffer.byteLength(recap.handoffText, "utf8") <= 16 * 1024);
	assert.match(recap.text, /omitted/i);
});
