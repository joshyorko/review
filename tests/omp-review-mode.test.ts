/**
 * Contract test for the omp review mode.
 *
 * Runs the real modules against a fake OMP host and fake GitHub/Hive APIs.
 * No terminal, network, or OMP process is required.
 *
 *   node --test tests/omp-review-mode.test.ts
 */

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test, { beforeEach, afterEach } from "node:test";
import { loadPackagedJobManager } from "./omp-async-runtime.ts";
import { createReviewerOutputSchema, reviewerDefinitionTrusted } from "../image/extension/review/reviewer-receipts.ts";
import { createReviewNoticeComponent } from "../image/extension/review/notice.ts";

import { GLYPH, PLAIN_PAINTER, formatDuration, statusIcon } from "../image/extension/review/glyphs.ts";
import { workbenchPainter } from "../image/extension/review/paint.ts";
import { renderSpanTree, traceToText, visibleSpanIds } from "../image/extension/review/trace.ts";
import { truncateToWidth, visibleWidth } from "../image/extension/review/width.ts";
import { classifyCi, fetchDiff, exactHeadVerified, fetchItemsByKey, fetchOAuthScopes, fetchPullRequestEffect, fetchQueue, isForwardHead, parseScope, searchExpression, toCiStatus } from "../image/extension/review/github.ts";
import { EMPTY_HIVE, buildRankMap, fetchHive, hiveFailureStatus, resolveHub } from "../image/extension/review/hive.ts";
import { categorize, prioritize } from "../image/extension/review/priority.ts";
import { BATCH_LIMIT, ReviewMode, ciGlyph } from "../image/extension/review/mode.ts";
import { HOLD_LABELS, isLandingReady, landingReason, landingState } from "../image/extension/review/landing.ts";
import { RAW_KEYS, canonicalKey, rawKeyMatcher } from "../image/extension/review/keys.ts";
import { ReviewDashboard, parseMouseEvent } from "../image/extension/review/dashboard.ts";
import { STALE_AFTER_MS, priorityChip, queueAge, renderRail, statusSegment } from "../image/extension/review/rail.ts";
import { SessionTrace } from "../image/extension/review/session.ts";
import {
	STATE_ENTRY,
	BATCH_ENTRY,
	COMMENT_ENTRY,
	HANDOFF_ENTRY,
	GENERIC_WORKBENCH_POLICY,
	actionPrompt,
	createReviewExtension as createReviewExtensionImpl,
	NOTICE_ENTRY,
	taskSchemaSupportsStructuredOutput,
	createCommentActionPlan,
	renderCommentActionPlan,
	validateCommentActionPlan,
	commentInvocation,
} from "../image/extension/review/extension.ts";

import lunaFactoryExtension, { createLunaFactoryExtension } from "../image/extension/luna-factory/index.ts";
import { ResourceClaims } from "../image/extension/luna-factory/omp/batch-store.ts";
import { loadWave, saveWave } from "../image/extension/review/wave-store.ts";
import { factoryHandoffState, registerFactoryController, registerFactoryBatchSubmitter, registerFactoryDashboardOpener, registeredFactoryReconciler } from "../image/extension/luna-factory/omp/batch-bridge.ts";

const NOW = 1_800_000_000_000;

// No hub, no home: these tests must not read the developer's own Hive
// registration and must never open a socket.
const ISOLATED_ENV = { GH_TOKEN: "t", HOME: "/nonexistent", XDG_CONFIG_HOME: "/nonexistent", REVIEW_MODE: "hive", LUNA_FACTORY_STATE_ROOT: "", LUNA_FACTORY_CLAIMS_ROOT: "" };
const REVIEW_EXTENSION_ROOT = fileURLToPath(new URL("../image/extension/review", import.meta.url));
let noticeFixtureSession = 0;
beforeEach(() => {
	createReviewNoticeComponent().sessionChanged(`review-mode-test-${++noticeFixtureSession}`);
	ISOLATED_ENV.LUNA_FACTORY_STATE_ROOT = mkdtempSync(join(tmpdir(), "review-state-"));
	ISOLATED_ENV.LUNA_FACTORY_CLAIMS_ROOT = mkdtempSync(join(tmpdir(), "review-claims-"));
});
afterEach(() => {
	rmSync(ISOLATED_ENV.LUNA_FACTORY_STATE_ROOT, { recursive: true, force: true });
	rmSync(ISOLATED_ENV.LUNA_FACTORY_CLAIMS_ROOT, { recursive: true, force: true });
});

test("every review extension module is reachable from its package entrypoint", () => {
	const directory = join(process.cwd(), "image/extension/review");
	const modules = new Set(readdirSync(directory).filter((name) => name.endsWith(".ts")));
	const reachable = new Set<string>();
	const pending = ["index.ts"];
	const importPattern = /(?:from\s+|import\s*)(["'])(\.\/[^"']+)\1/g;
	while (pending.length > 0) {
		const name = pending.pop();
		if (!name || reachable.has(name)) continue;
		reachable.add(name);
		const source = readFileSync(join(directory, name), "utf8");
		for (const match of source.matchAll(importPattern)) {
			const dependency = match[2]!.slice(2);
			if (modules.has(dependency) && !reachable.has(dependency)) pending.push(dependency);
		}
	}

	assert.deepEqual([...modules].filter((name) => !reachable.has(name)).sort(), []);
});

// ---------------------------------------------------------------- fixtures


function queueItem(overrides = {}) {
	return {
		id: 42,
		type: "pr",
		repo: "projectbluefin/review",
		title: "fix(launcher): resolve HIVE_HUB before mutating",
		author: "jorge",
		url: "https://github.com/projectbluefin/review/pull/42",
		updatedAt: NOW - 1000,
		draft: false,
		ciStatus: "failure",
		mergeState: "clean",
		reviewState: "review_required",
		labels: ["launcher"],
		additions: 42,
		deletions: 7,
		...overrides,
	};
}

function nativeTaskParameters(structured = true) {
	return Object.assign(() => undefined, {
		toJsonSchema: () => ({
			type: "object",
			properties: {
				context: { type: "string" },
				tasks: {
					type: "array",
					items: { type: "object", properties: {
						agent: { type: "string" },
						task: { type: "string" },
						...(structured ? { outputSchema: { type: ["object", "boolean", "string", "null"] }, schemaMode: { enum: ["permissive", "strict"] } } : {}),
					} },
				},
			},
		}),
	});
}

/**
 * Fake GitHub: one GraphQL search page, aliased by-key lookups, and one REST
 * files response.
 *
 * `known` maps `owner/repo#number` to the node returned when the queue asks for
 * that item by name — the path Hive-queued work takes when it falls outside the
 * search window.
 */
function fakeFetch(calls, known = {}) {
	return async (url, init) => {
		calls.push(String(url));
		if (String(url).includes("/graphql")) {
			const body = JSON.parse(String(init?.body ?? "{}"));
			if (body.variables?.search === undefined) {
				const data = {};
				const alias = /(\w+): repository\(owner: "([^"]+)", name: "([^"]+)"\)\s*\{\s*issueOrPullRequest\(number: (\d+)\)/g;
				for (const [, name, owner, repo, number] of body.query.matchAll(alias)) {
					const key = `${owner}/${repo}#${number}`;
					const fallback = key === "projectbluefin/review#42"
						? {
							number: 42,
							title: "fix(launcher): resolve HIVE_HUB before mutating",
							url: "https://github.com/projectbluefin/review/pull/42",
							updatedAt: new Date(NOW - 1000).toISOString(),
							isDraft: false,
							mergeable: "MERGEABLE",
							reviewDecision: "REVIEW_REQUIRED",
							headRefOid: "4".repeat(40),
							changedFiles: 0,
							author: { login: "jorge" },
							repository: { nameWithOwner: "projectbluefin/review" },
							labels: { nodes: [{ name: "launcher" }] },
							files: { pageInfo: { hasNextPage: false }, nodes: [] },
							commits: { nodes: [{ commit: {
								statusCheckRollup: null,
								checkSuites: { pageInfo: { hasNextPage: false }, nodes: [{ status: "COMPLETED", conclusion: "FAILURE" }] },
							} }] },
						}
						: key === "projectbluefin/other#7"
							? {
								number: 7,
								title: "feat(ui): dagger rail",
								url: "https://github.com/projectbluefin/other/pull/7",
								updatedAt: new Date(NOW - 5000).toISOString(),
								isDraft: false,
								mergeable: "MERGEABLE",
								reviewDecision: "APPROVED",
								headRefOid: "7".repeat(40),
								changedFiles: 0,
								author: { login: "ada" },
								repository: { nameWithOwner: "projectbluefin/other" },
								labels: { nodes: [] },
								files: { pageInfo: { hasNextPage: false }, nodes: [] },
								commits: { nodes: [{ commit: { statusCheckRollup: { state: "SUCCESS" } } }] },
							}
							: null;
					data[name] = { issueOrPullRequest: Object.hasOwn(known, key) ? known[key] : fallback };
				}
				return { ok: true, status: 200, statusText: "OK", json: async () => ({ data }) };
			}
			assert.match(body.variables.search, /^(?:org|repo):\S+/);
			if (body.variables.search.includes("is:pr")) {
				assert.doesNotMatch(body.query, /files\(first: 100\)|checkSuites\(first: 50\)|closingIssuesReferences/);
			}
			return {
				ok: true,
				status: 200,
				statusText: "OK",
				json: async () => ({
					data: {
						viewer: { login: "jorge" },
						search: {
							pageInfo: { hasNextPage: false, endCursor: null },
							nodes: [
								{
									number: 42,
									title: "fix(launcher): resolve HIVE_HUB before mutating",
									url: "https://github.com/projectbluefin/review/pull/42",
									updatedAt: new Date(NOW - 1000).toISOString(),
									isDraft: false,
									mergeable: "MERGEABLE",
									reviewDecision: "REVIEW_REQUIRED",
									additions: 42,
									deletions: 7,
									changedFiles: 3,
									author: { login: "jorge" },
									headRefOid: "4".repeat(40),
									repository: { nameWithOwner: "projectbluefin/review" },
									files: { pageInfo: { hasNextPage: false }, nodes: [{ path: "README.md" }, { path: "README.md" }, { path: "README.md" }] },
									labels: { nodes: [{ name: "launcher" }] },
									commits: { nodes: [{ commit: {
										statusCheckRollup: null,
										checkSuites: { pageInfo: { hasNextPage: false }, nodes: [{ status: "COMPLETED", conclusion: "FAILURE" }] },
									} }] },
								},
								{
									number: 7,
									title: "feat(ui): dagger rail",
									url: "https://github.com/projectbluefin/other/pull/7",
									updatedAt: new Date(NOW - 5000).toISOString(),
									isDraft: false,
									mergeable: "MERGEABLE",
									reviewDecision: "APPROVED",
									changedFiles: 2,
									author: { login: "ada" },
									headRefOid: "7".repeat(40),
									repository: { nameWithOwner: "projectbluefin/other" },
									labels: { nodes: [] },
									files: { pageInfo: { hasNextPage: false }, nodes: [{ path: "README.md" }, { path: "README.md" }] },
									commits: { nodes: [{ commit: { statusCheckRollup: { state: "SUCCESS" } } }] },
								},
							],
						},
					},
				}),
			};
		}
		return {
			ok: true,
			status: 200,
			statusText: "OK",
			json: async () => [
				{ filename: "image/entrypoint.sh", status: "modified", additions: 3, deletions: 1, patch: "@@ -1 +1 @@\n-old\n+new" },
				{ filename: "big.lock", status: "modified", additions: 900, deletions: 900, patch: "x".repeat(50_000) },
			],
		};
	};
}

function hiveBackedFetch(items, calls = []) {
	const nodes = items.map((item) => ({
		number: item.id,
		title: item.title,
		url: `https://github.com/${item.repo}/pull/${item.id}`,
		updatedAt: new Date(NOW - item.id * 1000).toISOString(),
		isDraft: false,
		mergeable: "MERGEABLE",
		reviewDecision: "REVIEW_REQUIRED",
		headRefOid: item.headSha ?? String(item.id).padStart(40, "0"),
		changedFiles: item.changedFiles ?? 1,
		files: { pageInfo: { hasNextPage: false }, nodes: [{ path: "README.md" }] },
		autoMergeRequest: item.autoMergeEnabled ? { enabledAt: new Date(NOW).toISOString() } : null,
		author: { login: "reviewer" },
		repository: { nameWithOwner: item.repo },
		labels: { nodes: [] },
		commits: { nodes: [{ commit: { statusCheckRollup: { state: (item.ciStatus ?? "success").toUpperCase() } } }] },
	}));
	return async (url, init) => {
		const target = String(url);
		calls.push(target);
		if (target.endsWith("/api/v1/status")) {
			return { ok: true, status: 200, statusText: "OK", json: async () => ({ actionable_items: items.length }) };
		}
		if (target.endsWith("/api/contribute/queue")) {
			return {
				ok: true,
				status: 200,
				statusText: "OK",
				json: async () => ({ queue: items.map((item) => ({ key: `${item.repo}#${item.id}`, repo: item.repo, number: item.id, title: item.title })) }),
			};
		}
		if (target.endsWith("/api/contribute/triage")) {
			return { ok: true, status: 200, statusText: "OK", json: async () => ({ groups: [] }) };
		}
		if (target.endsWith("/api/v1/contributors")) {
			return { ok: true, status: 200, statusText: "OK", json: async () => ({ contributors: [] }) };
		}
		if (target === "https://api.github.com/") {
			return { ok: true, status: 200, statusText: "OK", headers: { get: (name) => name.toLowerCase() === "x-oauth-scopes" ? "repo, workflow" : null }, json: async () => ({}) };
		}
		if (target.includes("/graphql")) {
			const body = JSON.parse(String(init?.body ?? "{}"));
			if (body.variables?.search !== undefined) {
				return { ok: true, status: 200, statusText: "OK", json: async () => ({ data: { search: { pageInfo: { hasNextPage: false, endCursor: null }, nodes } } }) };
			}
			const data = {};
			const aliases = /(\w+): repository\(owner: "([^"]+)", name: "([^"]+)"\)\s*\{\s*issueOrPullRequest\(number: (\d+)\)/g;
			for (const [, alias, owner, repo, number] of body.query.matchAll(aliases)) {
				data[alias] = { issueOrPullRequest: nodes.find((node) => node.number === Number(number) && node.repository.nameWithOwner === `${owner}/${repo}`) ?? null };
			}
			return { ok: true, status: 200, statusText: "OK", json: async () => ({ data }) };
		}
		return { ok: true, status: 200, statusText: "OK", json: async () => [] };
	};
}

function landingGuardFetch(items) {
	const base = hiveBackedFetch(items);
	const fetchImpl = async (url, init) => {
		const response = await base(url, init);
		if (!String(url).includes("/graphql")) return response;
		const payload = await response.json();
		const update = (node) => {
			const item = items.find((item) => item.id === node?.number && item.repo === node.repository?.nameWithOwner);
			if (!item) return node;
			return { ...node, headRefOid: item.headSha, author: { login: item.author },
				reviewDecision: ({ approved: "APPROVED", changes_requested: "CHANGES_REQUESTED", review_required: "REVIEW_REQUIRED" })[item.reviewState] ?? null,
				labels: { nodes: item.labels.map((name) => ({ name })) }, mergeable: item.mergeState === "dirty" ? "CONFLICTING" : "MERGEABLE",
				commits: { nodes: [{ commit: { statusCheckRollup: { state: item.ciStatus.toUpperCase() } } }] } };
		};
		if (payload.data.search) payload.data.search.nodes = payload.data.search.nodes.map(update);
		else for (const value of Object.values(payload.data)) if (value?.issueOrPullRequest) value.issueOrPullRequest = update(value.issueOrPullRequest);
		return { ...response, json: async () => payload };
	};
	fetchImpl.reviewItems = items;
	return fetchImpl;
}

function createReviewExtension(pi, options) {
	const observer = options.humanReviewObserver ?? (async (repository, number) => {
		const item = options.fetchImpl?.reviewItems?.find((candidate) => candidate.repo.toLowerCase() === repository.toLowerCase() && candidate.id === number);
		if (!item) return { kind: "unknown", reason: "fixture has no matching pull request" };
		const approved = item.reviewState === "approved";
		const facts = {
			repository: item.repo, number: item.id, headSha: item.headSha, baseRef: "main", authorLogin: item.author,
			viewerLogin: "maintainer", canMerge: true, requiredApprovals: 1, requiresCodeOwnerReview: false,
			requiresLastPushApproval: false, githubReviewState: item.reviewState === "changes_requested" ? "changes_requested" : approved ? "approved" : "required",
			currentHumanApprovals: approved ? [{ login: "maintainer", headSha: item.headSha, submittedAt: Date.now() }] : [],
			digest: `fixture:${repository}#${number}:${item.headSha}:${item.reviewState}`, observedAt: Date.now(),
		};
		return { kind: "observed", facts };
	});
	return createReviewExtensionImpl(pi, {
		...options,
		humanReviewObserver: observer,
		reviewerDefinitionCheck: options.reviewerDefinitionCheck ?? (input => reviewerDefinitionTrusted({ ...input, extensionPaths: [REVIEW_EXTENSION_ROOT] })),
	});
}

function issueBackedFetch(states) {
	const nodes = () => Object.entries(states).map(([key, state]) => {
		const [repo, numberText] = key.split("#");
		const number = Number(numberText);
		return {
			number,
			title: state.title ?? `issue ${number}`,
			url: `https://github.com/${repo}/issues/${number}`,
			updatedAt: new Date(NOW).toISOString(),
			author: { login: "maintainer" },
			repository: { nameWithOwner: repo },
			labels: { nodes: [] },
			closedByPullRequestsReferences: {
				nodes: (state.submittedPrs ?? []).map((ref) => {
					const hash = ref.lastIndexOf("#");
					const refRepo = ref.slice(0, hash);
					return {
						number: Number(ref.slice(hash + 1)),
						state: "OPEN",
						merged: false,
						repository: { nameWithOwner: refRepo },
					};
				}),
			},
		};
	});
	return async (url, init) => {
		if (!String(url).includes("/graphql")) return { ok: true, status: 200, statusText: "OK", json: async () => [] };
		const body = JSON.parse(String(init?.body ?? "{}"));
		const current = nodes();
		if (body.variables?.search !== undefined) {
			return {
				ok: true,
				status: 200,
				statusText: "OK",
				json: async () => ({ data: { viewer: { login: "reviewer" }, search: { pageInfo: { hasNextPage: false }, nodes: current } } }),
			};
		}
		const data = {};
		const aliases = /(\w+): repository\(owner: "([^"]+)", name: "([^"]+)"\)\s*\{\s*issueOrPullRequest\(number: (\d+)\)/g;
		for (const [, alias, owner, repo, number] of body.query.matchAll(aliases)) {
			const node = current.find((candidate) => candidate.number === Number(number) && candidate.repository.nameWithOwner === `${owner}/${repo}`);
			data[alias] = { issueOrPullRequest: node ? { ...node, closed: false } : null };
		}
		return { ok: true, status: 200, statusText: "OK", json: async () => ({ data }) };
	};
}

function recoveredPrSlayFetch(items, effects, options = {}) {
	const queueNodes = () => items.filter((item) => effects[item.id]?.state === "OPEN").map((item) => ({
		number: item.id,
		title: item.title,
		url: item.url,
		updatedAt: new Date(NOW).toISOString(),
		isDraft: false,
		mergeable: "MERGEABLE",
		reviewDecision: Object.hasOwn(effects[item.id] ?? {}, "reviewDecision") ? effects[item.id].reviewDecision : "REVIEW_REQUIRED",
		headRefOid: effects[item.id]?.headSha ?? item.headSha,
		autoMergeRequest: effects[item.id]?.autoMerge ? { enabledAt: new Date().toISOString() } : null,
		changedFiles: 1,
		files: { pageInfo: { hasNextPage: false }, nodes: [{ path: "src/change.ts" }] },
		commits: { nodes: [{ commit: { statusCheckRollup: { state: effects[item.id]?.ciState ?? "SUCCESS" } } }] },
		author: { login: item.author },
		repository: { nameWithOwner: item.repo },
		labels: { nodes: [] },
	}));
	return async (url, init) => {
		const comparison = /\/compare\/([a-f0-9]{40})\.\.\.([a-f0-9]{40})/.exec(String(url));
		if (comparison && options.forwardComparison) return { ok: true, json: async () => {
			if (options.headRace) for (const effect of Object.values(effects)) effect.headSha = (effect.headSha === "e".repeat(40) ? "f" : "e").repeat(40);
			return { status: options.diverged ? "diverged" : "ahead", ahead_by: 1, behind_by: options.diverged ? 1 : 0, base_commit: { sha: comparison[1] }, merge_base_commit: { sha: comparison[1] } };
		} };
		if (!String(url).includes("/graphql")) return { ok: true, status: 200, statusText: "OK", json: async () => [] };
		const body = JSON.parse(String(init?.body ?? "{}"));
		if (options.unreadable && body.query.includes("pullRequest(number:")) return { ok: false, status: 503, statusText: "Unavailable", json: async () => ({}) };
		const nodes = queueNodes();
		if (body.variables?.search !== undefined) {
			return { ok: true, status: 200, statusText: "OK", json: async () => ({ data: { viewer: { login: "maintainer" }, search: { pageInfo: { hasNextPage: false, endCursor: null }, nodes } } }) };
		}
		if (body.query.includes("pullRequest(number:")) {
			if (options.changeEarlierOnComparison && body.query.includes("pullRequest(number: 352)")) effects[350].headSha = effects[350].headSha === "e".repeat(40) ? "f".repeat(40) : "e".repeat(40);
			const match = /repository\(owner: "([^\"]+)", name: "([^\"]+)"\)\s*\{\s*nameWithOwner pullRequest\(number: (\d+)\)/.exec(body.query);
			const [, owner, name, numberText] = match ?? [];
			const effect = numberText ? effects[Number(numberText)] : undefined;
			const repo = `${owner}/${name}`;
			return { ok: true, status: 200, statusText: "OK", json: async () => ({ data: { repository: effect ? {
				nameWithOwner: repo,
				pullRequest: {
					id: `PR_${numberText}`,
					number: Number(numberText),
					url: `https://github.com/${repo}/pull/${numberText}`,
					state: effect.state,
					merged: effect.merged,
					mergedAt: Object.hasOwn(effect, "mergedAt") ? effect.mergedAt : effect.merged ? new Date().toISOString() : null,
				headRefOid: effect.headSha,
				autoMergeRequest: effect.autoMerge ? { enabledAt: new Date().toISOString() } : null,
					reviewDecision: Object.hasOwn(effect, "reviewDecision") ? effect.reviewDecision : "REVIEW_REQUIRED",
					author: { login: items.find((item) => item.id === Number(numberText))?.author },
					latestReviews: { pageInfo: { hasNextPage: effect.reviewsIncomplete === true }, nodes: effect.reviews ?? [] },
				},
			} : null } }) };
		}
		const data = {};
		const aliases = /(\w+): repository\(owner: "([^\"]+)", name: "([^\"]+)"\)\s*\{\s*issueOrPullRequest\(number: (\d+)\)/g;
		for (const [, alias, owner, repo, numberText] of body.query.matchAll(aliases)) {
			const item = items.find((candidate) => candidate.repo === `${owner}/${repo}` && candidate.id === Number(numberText));
			const effect = effects[Number(numberText)];
			const node = item && effect?.state === "OPEN" ? {
				number: item.id,
				title: item.title,
				url: item.url,
				updatedAt: new Date(NOW).toISOString(),
				isDraft: false,
				mergeable: "MERGEABLE",
				reviewDecision: Object.hasOwn(effect, "reviewDecision") ? effect.reviewDecision : "REVIEW_REQUIRED",
				headRefOid: effect.headSha,
				autoMergeRequest: effect.autoMerge ? { enabledAt: new Date().toISOString() } : null,
				changedFiles: 1,
				files: { pageInfo: { hasNextPage: false }, nodes: [{ path: "src/change.ts" }] },
				commits: { nodes: [{ commit: { statusCheckRollup: { state: effect.ciState ?? "SUCCESS" } } }] },
				author: { login: item.author },
				repository: { nameWithOwner: item.repo },
				labels: { nodes: [] },
				closed: false,
			} : null;
			data[alias] = { issueOrPullRequest: node };
		}
		return { ok: true, status: 200, statusText: "OK", json: async () => ({ data }) };
	};
}

/** Fake omp extension host recording every registration. */
function fakeHost({ qualifiedMcp = true, mcpShaDescription = "SHA that pull request head must match to allow merge" } = {}) {
	const zodLeaf = () => ({ optional: () => zodLeaf(), describe: () => zodLeaf(), toJsonSchema: () => ({}) });
	return {
		toolInfo: [
			{ name: "task", parameters: nativeTaskParameters() },
			...(qualifiedMcp ? [{
				name: "mcp__github_merge_pull_request",
				mcpServerName: "github",
				mcpToolName: "merge_pull_request",
				parameters: { type: "object", properties: { sha: { type: "string", description: mcpShaDescription } } },
			}] : []),
		],
		sessionShutdownLifecycleVersion: 1,
		labels: [],
		events: new Map(),
		shortcuts: new Map(),
		flags: new Map(),
		flagValues: new Map(),
		tools: new Map(),
		commands: new Map(),
		messages: [],
		messageOptions: [],
		nativeMessages: [],
		entries: [],
		execResult: { stdout: "https://github.com/projectbluefin/review/issues/42#issuecomment-1\n", stderr: "", code: 0, killed: false },
		execCalls: [],
		zod: {
			object: zodLeaf,
			string: zodLeaf,
			number: zodLeaf,
			boolean: zodLeaf,
			array: zodLeaf,
			enum: zodLeaf,
			literal: zodLeaf,
			union: zodLeaf,
		},
		setLabel(label) {
			this.labels.push(label);
		},
		on(event, handler) {
			this.events.set(event, handler);
		},
		registerShortcut(chord, options) {
			this.shortcuts.set(chord, options);
		},
		registerFlag(name, options) {
			this.flags.set(name, options);
		},
		getFlag(name) {
			return this.flagValues.get(name);
		},
		getAllTools() {
			return this.toolInfo;
		},
		registerTool(definition) {
			this.tools.set(definition.name, definition);
		},
		registerCommand(name, definition) {
			this.commands.set(name, definition);
		},
		sendUserMessage(content, options) {
			this.messages.push(content);
			this.messageOptions.push(options);
		},
		sendMessage(message, options) { this.nativeMessages.push({ message, options }); },
		async exec(command, args) {
			this.execCalls.push({ command, args });
			return this.execResult;
		},
		appendEntry(customType, data) {
			this.entries.push({ customType, data });
		},
	};
}

function savedReviewNoticeText(pi) {
	return pi.entries
		.filter((entry) => entry.customType === NOTICE_ENTRY && entry.data)
		.map(({ data }) => [data.title, data.outcome, ...(Array.isArray(data.steps) ? data.steps : []), data.details].filter((value) => typeof value === "string").join("\n"))
		.join("\n");
}

/**
 * Fake omp session context.
 *
 * `ui.custom` models the real workbench: it builds the component and resolves
 * only when that component calls `done`. Resolving immediately would hide a
 * session-start handler that blocks OMP.
 */
function observeTask(pi, ctx, id, call = `call-${id}`) {
	pi.events.get("tool_call")({ toolCallId: call, toolName: "task", input: { isolated: false } }, ctx);
	for (const job of [...ctx.asyncJobs.running, ...ctx.asyncJobs.recent]) {
		if (job.id === id) { job.agentId = id; job.type = "task"; }
	}
	pi.events.get("tool_execution_end")({ toolCallId: call, result: { details: {
		async: { type: "task", state: "running", jobId: id }, progress: [{ id, index: 0, status: "running" }],
	} }, isError: false }, ctx);
}

async function completeReviewTask(pi, ctx, count = 1, { deliver = true, prefix = "review", headOverrides = {} } = {}) {
	const batch = pi.entries.filter((entry) => entry.customType === BATCH_ENTRY).at(-1)?.data;
	const subjects = (batch?.waves?.[batch.currentWave]?.items ?? []).filter((item) => item.type === "pr").slice(0, count);
	for (const [index, item] of subjects.entries()) {
		const subject = { repository: item.repo.toLowerCase(), number: item.id, headSha: headOverrides[item.id] ?? item.headSha };
		const data = { ...subject, verdict: "clean", findings: [], summary: "Reviewed the exact admitted head." };
		const agentId = `${prefix}-agent-${index}`;
		const jobId = `${prefix}-job-${index}`;
		const toolCallId = `fresh-review-task-${prefix}-${index}`;
		const task = { agent: "reviewer", name: agentId, schemaMode: "strict", outputSchema: createReviewerOutputSchema(subject) };
		await pi.events.get("tool_call")({ toolCallId, toolName: "task", input: task }, ctx);
		const worker = { id: jobId, agentId, type: "task", status: "completed", startTime: Date.now() + 1 };
		ctx.asyncJobs.recent.push(worker);
		await pi.events.get("tool_execution_end")({ toolCallId, result: { details: {
			async: { type: "task", state: deliver ? "completed" : "running", jobId },
			progress: [{ id: agentId, index: 0, agent: "reviewer", agentSource: "user", status: deliver ? "completed" : "running" }],
			results: [],
		} }, isError: false }, ctx);
		if (deliver) await deliverTaskResults(pi, ctx, [jobId], [{ jobId, type: "task", status: "completed", agentId, schema: { source: "caller", mode: "strict", status: "valid", data } }]);
		else {
			ctx.asyncJobs.delivery.pendingJobIds.push(jobId);
			ctx.asyncJobs.delivery.pending = ctx.asyncJobs.delivery.pendingJobIds.length;
		}
	}
}

function deliverTaskResults(pi, ctx, jobIds, jobs = jobIds.map((jobId) => ({ jobId, type: "task" }))) {
	ctx.asyncJobs.delivery.pendingJobIds = ctx.asyncJobs.delivery.pendingJobIds.filter((id) => !jobIds.includes(id));
	ctx.asyncJobs.delivery.pending = ctx.asyncJobs.delivery.pendingJobIds.length;
	return pi.events.get("message_start")({ message: {
		role: "custom",
		customType: "async-result",
		details: { jobs },
	} }, ctx);
}

function fakeCtx() {
	const notifications = [];
	const statuses = new Map();
	const widgets = new Map();
	const overlays = [];
	const modalOutputs = [];
	const pasted = [];
	const confirmations = [];
	const editorResponses = [];
	const editorCalls = [];
	const inputResponses = [];
	const inputCalls = [];
	const selectResponses = [];
	const selectCalls = [];
	let renderRequests = 0;
	const ctx = {
		sessionId: "session-1",
		hasUI: true,
		notifications,
		statuses,
		widgets,
		overlays,
		modalOutputs,
		pasted,
		confirmations,
		editorResponses,
		editorCalls,
		inputResponses,
		inputCalls,
		selectResponses,
		selectCalls,
		get renderRequests() { return renderRequests; },
		asyncJobs: { running: [], recent: [], delivery: { pending: 0, pendingJobIds: [] } },
		ui: {
			notify: (message, level) => notifications.push({ message, level }),
			input: async (...args) => {
				inputCalls.push(args);
				return inputResponses.shift();
			},
			confirm: async (title, message) => {
				confirmations.push({ title, message });
				return true;
			},
			select: async (...args) => {
				selectCalls.push(args);
				return selectResponses.shift();
			},
			editor: async (...args) => {
				editorCalls.push(args);
				return editorResponses.shift();
			},
			setStatus: (key, value) => statuses.set(key, value),
			setWidget: (key, content) => widgets.set(key, content),
			setTitle: () => {},
			pasteToEditor(text) {
				pasted.push(text);
			},
			custom(factory) {
				const { promise, resolve } = Promise.withResolvers();
				const view = factory({ requestRender: () => { renderRequests++; } }, this.theme, {}, resolve);
				overlays.push(view);
				const header = view.render?.(100)?.[0] ?? "";
				if (/^Review (?:details|status) · read only/.test(header)) {
					modalOutputs.push(view.render(100).join("\n"));
					view.handleInput("q");
				}
				return promise;
			},
			theme: { fg: (_c, t) => t, bold: (t) => t, inverse: (t) => t },
		},
		getAsyncJobSnapshot() {
			return this.asyncJobs;
		},
		sessionManager: { getBranch: () => [], getSessionId() { return ctx.sessionId; } },
	};
	return ctx;
}

async function runReviewCommand(pi, ctx, args, width = 100) {
	void width;
	const before = ctx.modalOutputs?.length ?? 0;
	await pi.commands.get("review").handler(args, ctx);
	if ((ctx.modalOutputs?.length ?? 0) > before) return ctx.modalOutputs.at(-1);
	return ctx.notifications.at(-1)?.message ?? "";
}

// ---------------------------------------------------------------- vocabulary

test("explicit Review handoff exports durably, opens a child, and sends without triggering a model turn", async () => {
	const pi = fakeHost();
	const ctx = fakeCtx();
	const sourceBranch = [];
	const targetBranch = [];
	let activeBranch = sourceBranch;
	const saved = new Map();
	const newSessionCalls = [];
	let leaf = "leaf-1";
	ctx.sessionManager = {
		getBranch: () => activeBranch,
		getSessionId: () => ctx.sessionId,
		getLeafId: () => leaf,
		getSessionFile: () => ctx.sessionId === "session-1" ? "/state/parent.jsonl" : "/state/child.jsonl",
		async saveArtifact(content, toolType) { assert.equal(toolType, "review-handoff"); saved.set("7", content); return "7"; },
		async getArtifactPath(id) { return `/state/artifacts/${id}.review-handoff`; },
	};
	const targetManager = {
		getBranch: () => targetBranch,
		getSessionId: () => ctx.sessionId,
		getLeafId: () => leaf,
		getSessionFile: () => "/state/child.jsonl",
	};
	ctx.newSession = async (options) => {
		newSessionCalls.push(options);
		ctx.sessionId = "session-child"; leaf = "leaf-child"; activeBranch = targetBranch;
		await options.setup(targetManager);
		return { cancelled: false };
	};
	const append = pi.appendEntry.bind(pi);
	pi.appendEntry = (type, data) => { append(type, data); activeBranch.push({ type: "custom", customType: type, data }); };
	const review = createReviewExtension(pi, { org: "projectbluefin", fetchImpl: fakeFetch([]), env: { ...ISOLATED_ENV, REVIEW_MODE: "review" } });
	await pi.events.get("session_start")({}, ctx);
	await review.whenStarted();
	await pi.commands.get("review").handler("handoff", ctx);
	assert.equal(saved.size, 1);
	assert.match([...saved.values()][0], /explicit human authorization/i);
	assert.equal(newSessionCalls.length, 1);
	assert.equal(newSessionCalls[0].parentSession, "/state/parent.jsonl");
	assert.equal(typeof newSessionCalls[0].setup, "function", "child setup owns identity validation and message insertion");
	assert.equal(pi.nativeMessages.length, 1);
	assert.equal(pi.nativeMessages[0].options.triggerTurn, false);
	assert.ok(targetBranch.some((entry) => entry.customType === HANDOFF_ENTRY && entry.data.state === "submission-uncertain"));
	assert.equal(ctx.pasted.length, 0, "export does not depend on clipboard availability");
	assert.equal(pi.entries.filter((entry) => entry.customType === HANDOFF_ENTRY).at(-1).data.state, "submission-uncertain");
	await pi.commands.get("review").handler("handoff", ctx);
	assert.equal(pi.nativeMessages.length, 1, "stable identity prevents a blind duplicate submission");
	assert.equal(saved.size, 1);
});

test("uncertain Review session transition keeps the export and fences retry", async () => {
	const pi = fakeHost();
	const ctx = fakeCtx();
	const branch = [];
	let saves = 0;
	let transitions = 0;
	let leaf = "leaf-1";
	ctx.sessionManager = {
		getBranch: () => branch, getSessionId: () => ctx.sessionId, getLeafId: () => leaf, getSessionFile: () => "/state/parent.jsonl",
		async saveArtifact() { saves++; return "19"; }, async getArtifactPath() { return "/state/artifacts/19.review-handoff"; },
	};
	ctx.newSession = async () => { transitions++; ctx.sessionId = "session-child"; leaf = "child-leaf"; throw new Error("transition outcome uncertain"); };
	const append = pi.appendEntry.bind(pi);
	pi.appendEntry = (type, data) => { append(type, data); branch.push({ type: "custom", customType: type, data }); };
	const review = createReviewExtension(pi, { org: "projectbluefin", fetchImpl: fakeFetch([]), env: { ...ISOLATED_ENV, REVIEW_MODE: "review" } });
	await pi.commands.get("review").handler("handoff", ctx);
	assert.equal(saves, 1);
	assert.equal(pi.nativeMessages.length, 0);
	assert.equal(branch.at(-1).data.state, "transition-uncertain");
	await pi.commands.get("review").handler("handoff", ctx);
	assert.equal(transitions, 1);
	assert.equal(saves, 1);
	assert.equal(pi.nativeMessages.length, 0);
});

test("handoff target setup rejects a mismatched child and sends nothing", async () => {
	const pi = fakeHost();
	const ctx = fakeCtx();
	const sourceBranch = [];
	const targetBranch = [];
	let activeBranch = sourceBranch;
	let leaf = "source-leaf";
	ctx.sessionManager = {
		getBranch: () => activeBranch, getSessionId: () => ctx.sessionId, getLeafId: () => leaf, getSessionFile: () => "/state/source.jsonl",
		async saveArtifact() { return "21"; }, async getArtifactPath() { return "/state/artifacts/21.review-handoff"; },
	};
	ctx.newSession = async (options) => {
		ctx.sessionId = "session-child"; leaf = "child-leaf"; activeBranch = targetBranch;
		await options.setup({ getBranch: () => targetBranch, getSessionId: () => "session-1", getLeafId: () => leaf, getSessionFile: () => "/state/source.jsonl" });
		return { cancelled: false };
	};
	const append = pi.appendEntry.bind(pi);
	pi.appendEntry = (type, data) => { append(type, data); activeBranch.push({ type: "custom", customType: type, data }); };
	const review = createReviewExtension(pi, { org: "projectbluefin", fetchImpl: fakeFetch([]), env: { ...ISOLATED_ENV, REVIEW_MODE: "review" } });
	await pi.commands.get("review").handler("handoff", ctx);
	assert.equal(pi.nativeMessages.length, 0);
	assert.ok(targetBranch.some((entry) => entry.customType === HANDOFF_ENTRY && entry.data.state === "transition-uncertain"));
	await pi.commands.get("review").handler("handoff", ctx);
	assert.equal(pi.nativeMessages.length, 0, "mismatched target identity fences a later resend");
});

test("Review handoff rejects source branch changes during durable export", async () => {
	const pi = fakeHost();
	const ctx = fakeCtx();
	let leaf = "leaf-1";
	ctx.sessionManager = {
		getBranch: () => [], getSessionId: () => "session-1", getLeafId: () => leaf, getSessionFile: () => "/state/parent.jsonl",
		async saveArtifact() { leaf = "leaf-moved"; return "9"; }, async getArtifactPath() { return "/state/artifacts/9.review-handoff"; },
	};
	ctx.newSession = async () => { throw new Error("must not fork stale source"); };
	const review = createReviewExtension(pi, { org: "projectbluefin", fetchImpl: fakeFetch([]), env: { ...ISOLATED_ENV, REVIEW_MODE: "review" } });
	await pi.events.get("session_start")({}, ctx); await review.whenStarted();
	await pi.commands.get("review").handler("handoff", ctx);
	assert.equal(pi.nativeMessages.length, 0);
	assert.equal(ctx.sessionManager.getLeafId(), "leaf-moved");
	assert.equal(pi.entries.some((entry) => entry.customType === HANDOFF_ENTRY), false);
});

test("ordinary Review recap uses a read-only operator view and never enters model input", async () => {
	const pi = fakeHost();
	const ctx = fakeCtx();
	const review = createReviewExtension(pi, { org: "projectbluefin", fetchImpl: fakeFetch([]), env: { ...ISOLATED_ENV, REVIEW_MODE: "review" } });
	const pending = pi.commands.get("review").handler("recap", ctx);
	const view = ctx.overlays.at(-1);
	assert.ok(view);
	const initialView = view.render(120).join("\n");
	assert.match(initialView, /Review recap .* read only/);
	assert.match(initialView, /queue=unavailable: Review queue has not been observed/);
	assert.ok(view.render(16).every((line) => visibleWidth(line) <= 16), "the read-only recap remains within a narrow terminal width");
	assert.equal(ctx.editorCalls.length, 0, "the recap does not open the model prompt editor");
	assert.equal(ctx.pasted.length, 0);
	assert.equal(pi.nativeMessages.length, 0);
	assert.equal(pi.messages.length, 0);
	const requestsBeforeScroll = ctx.renderRequests;
	view.handleInput("j");
	assert.ok(ctx.renderRequests > requestsBeforeScroll, "scrolling invalidates the read-only overlay");
	view.handleInput("q");
	await pending;
});

test("recap bounds old branch history and uses the latest state per persisted identity", async () => {
	const pi = fakeHost();
	const ctx = fakeCtx();
	const batch = (state) => ({ id: "batch-latest", kind: "slay", state, completedItems: state === "complete" ? 1 : 0, totalItems: 1, startedAt: NOW, currentWave: 0, waves: [] });
	const comment = (state, receipts = []) => ({ version: 1, state, plan: { id: "comment-plan", targets: [{ repo: "acme/widgets", number: 17, type: "issue" }] }, receipts });
	const branch = [
		{ type: "custom", customType: BATCH_ENTRY, data: batch("running") },
		...Array.from({ length: 510 }, () => ({ type: "message", message: { role: "user", content: "old" } })),
		{ type: "custom", customType: BATCH_ENTRY, data: batch("running") },
		{ type: "custom", customType: COMMENT_ENTRY, data: comment("previewed") },
		{ type: "custom", customType: BATCH_ENTRY, data: batch("complete") },
		{ type: "custom", customType: COMMENT_ENTRY, data: comment("complete", ["https://github.com/acme/widgets/issues/17#issuecomment-19"]) },
	];
	ctx.sessionManager = { getBranch: () => branch, getSessionId: () => "session-1", getLeafId: () => "leaf-1" };
	const review = createReviewExtension(pi, { org: "projectbluefin", fetchImpl: fakeFetch([]), env: { ...ISOLATED_ENV, REVIEW_MODE: "review" } });
	const pending = pi.commands.get("review").handler("recap", ctx);
	const view = ctx.overlays.at(-1);
	const rendered = view.render(240).join("\n");
	assert.match(rendered, /batch-latest: complete/);
	assert.doesNotMatch(rendered, /batch-latest: running/);
	view.handleInput("\u0004");
	view.handleInput("q");
	await pending;
});

test("Review resolves only native truncation artifacts against the source session", async () => {
	const pi = fakeHost();
	const ctx = fakeCtx();
	const lookups = [];
	ctx.sessionManager = {
		getBranch: () => [], getSessionId: () => "session-native",
		async getArtifactPath(id) { lookups.push(id); return id === "17" ? "/state/session-native/artifacts/17.bash.log" : null; },
	};
	const review = createReviewExtension(pi, { org: "projectbluefin", fetchImpl: fakeFetch([]), env: { ...ISOLATED_ENV, REVIEW_MODE: "review" } });
	await pi.events.get("session_start")({}, ctx); await review.whenStarted();
	pi.events.get("tool_execution_start")({ toolCallId: "native-artifact", toolName: "bash", args: { command: "printf output" } }, ctx);
	await pi.events.get("tool_execution_end")({
		toolCallId: "native-artifact", isError: false,
		result: { content: [{ type: "text", text: "sample" }], details: { meta: { truncation: { direction: "tail", truncatedBy: "bytes", totalLines: 10, totalBytes: 100, outputLines: 1, outputBytes: 6, artifactId: "17" } } } },
	}, ctx);
	const trace = await pi.tools.get("review_workbench_trace").execute("trace", {});
	assert.deepEqual(lookups, ["17"]);
	assert.match(trace.content[0].text, /artifact:\/\/17.*session-native.*17\.bash\.log/);

	pi.events.get("tool_execution_start")({ toolCallId: "native-error", toolName: "bash", args: {} }, ctx);
	await pi.events.get("tool_execution_end")({
		toolCallId: "native-error", isError: false,
		result: { content: [], details: { meta: { artifactError: "storage unavailable", truncation: { direction: "tail", truncatedBy: "bytes", totalLines: 10, totalBytes: 100, outputLines: 1, outputBytes: 6, artifactId: "must-not-resolve" } } } },
	}, ctx);
	assert.deepEqual(lookups, ["17"]);
});

test("cancelled Review handoff keeps the export and sends no message", async () => {
	const pi = fakeHost();
	const ctx = fakeCtx();
	let exported = false;
	ctx.sessionManager = {
		getBranch: () => [], getSessionId: () => "session-1", getLeafId: () => "leaf-1", getSessionFile: () => "/state/parent.jsonl",
		async saveArtifact() { exported = true; return "8"; }, async getArtifactPath() { return "/state/artifacts/8.review-handoff"; },
	};
	ctx.newSession = async (options) => { assert.equal(typeof options.setup, "function"); return { cancelled: true }; };
	const review = createReviewExtension(pi, { org: "projectbluefin", fetchImpl: fakeFetch([]), env: { ...ISOLATED_ENV, REVIEW_MODE: "review" } });
	await pi.events.get("session_start")({}, ctx); await review.whenStarted();
	await pi.commands.get("review").handler("handoff", ctx);
	assert.equal(exported, true);
	assert.equal(pi.nativeMessages.length, 0);
	assert.equal(pi.entries.filter((entry) => entry.customType === HANDOFF_ENTRY).at(-1).data.state, "cancelled");
});

test("positive handoff cancellation supersedes opening in-process and after branch restoration", async () => {
	for (const restored of [false, true]) {
		const branchFile = join(ISOLATED_ENV.LUNA_FACTORY_STATE_ROOT, `handoff-${restored}.json`);
		writeFileSync(branchFile, "[]");
		const sourceCtx = fakeCtx();
		let activeBranch = JSON.parse(readFileSync(branchFile, "utf8"));
		let leaf = "source-leaf";
		let attempts = 0;
		const sourceManager = {
			getBranch: () => activeBranch, getSessionId: () => sourceCtx.sessionId,
			getLeafId: () => leaf, getSessionFile: () => sourceCtx.sessionId === "session-1" ? "/source.jsonl" : "/child.jsonl",
			saveArtifact: async () => "29", getArtifactPath: async () => "/artifacts/29",
		};
		sourceCtx.sessionManager = sourceManager;
		const attach = (pi) => {
			pi.appendEntry = (customType, data) => {
				activeBranch.push({ type: "custom", customType, data });
				writeFileSync(branchFile, JSON.stringify(activeBranch));
			};
			createReviewExtension(pi, { env: { ...ISOLATED_ENV, REVIEW_MODE: "review" } });
		};
		const first = fakeHost();
		attach(first);
		sourceCtx.newSession = async () => { attempts++; return { cancelled: true }; };
		await first.commands.get("review").handler("handoff", sourceCtx);
		assert.deepEqual(activeBranch.filter((entry) => entry.customType === HANDOFF_ENTRY).map((entry) => entry.data.state), ["opening", "cancelled"]);
		const retry = restored ? fakeHost() : first;
		if (restored) { activeBranch = JSON.parse(readFileSync(branchFile, "utf8")); attach(retry); }
		sourceCtx.newSession = async (options) => {
			attempts++;
			sourceCtx.sessionId = "child"; leaf = "child-leaf"; activeBranch = [];
			await options.setup(sourceManager);
			return { cancelled: false };
		};
		await retry.commands.get("review").handler("handoff", sourceCtx);
		assert.equal(attempts, 2);
		assert.equal(retry.nativeMessages.length, 1);
		await retry.commands.get("review").handler("handoff", sourceCtx);
		assert.equal(retry.nativeMessages.length, 1, "uncertain submission still fences duplicate delivery");
	}
});

test("artifact lookup cannot resume into a reset mutable session or its current Review wave", async () => {
	const pi = fakeHost();
	pi.flagValues.set("issues", true);
	const ctx = fakeCtx();
	const deferred = Promise.withResolvers<string>();
	const targetLookup = Promise.withResolvers<string>();
	ctx.sessionManager = {
		getBranch: () => [], getSessionId: () => ctx.sessionId,
		getArtifactPath: () => ctx.sessionId === "session-1" ? deferred.promise : targetLookup.promise,
	};
	const review = createReviewExtension(pi, { org: "projectbluefin", fetchImpl: issueBackedFetch({ "projectbluefin/review#77": { title: "target wave", submittedPrs: [] } }), env: { ...ISOLATED_ENV, REVIEW_MODE: "review" } });
	await pi.events.get("session_start")({}, ctx); await review.whenStarted();
	const result = { content: [{ text: "sample" }], details: { meta: { truncation: { artifactId: "17", totalBytes: 100, outputBytes: 6 } } } };
	pi.events.get("tool_execution_start")({ toolCallId: "reused", toolName: "bash", args: {} }, ctx);
	const pending = pi.events.get("tool_execution_end")({ toolCallId: "reused", result, isError: false }, ctx);
	ctx.sessionId = "target";
	pi.events.get("session_switch")({}, ctx);
	await pi.commands.get("review").handler("slay", ctx);
	pi.events.get("tool_execution_start")({ toolCallId: "reused", toolName: "bash", args: {} }, ctx);
	const targetPending = pi.events.get("tool_execution_end")({ toolCallId: "reused", result, isError: false }, ctx);
	const entriesBefore = JSON.stringify(pi.entries);
	assert.ok(pi.entries.some((entry) => entry.customType === BATCH_ENTRY && entry.data.state === "running"), "the target owns a new native wave");
	deferred.resolve("/source/artifact");
	await pending;
	const after = await pi.tools.get("review_workbench_trace").execute("trace", {});
	assert.equal(JSON.stringify(pi.entries), entriesBefore, "old result must not re-enter target wave bookkeeping");
	assert.doesNotMatch(after.content[0].text, /session-1|\/source\/artifact/);
	targetLookup.resolve("/target/artifact");
	await targetPending;
	const resolved = await pi.tools.get("review_workbench_trace").execute("trace", {});
	assert.match(resolved.content[0].text, /target.*\/target\/artifact/);
});

test("duration formatting follows Dagger's units", () => {
	assert.equal(formatDuration(340), "0.3s");
	assert.equal(formatDuration(1234), "1.2s");
	assert.equal(formatDuration(59_949), "59.9s");
	assert.equal(formatDuration(154_000), "2m34s");
	assert.equal(formatDuration(4_325_000), "1h12m5s");

	assert.equal(formatDuration(187_230_000), "2d4h0m30s");
	assert.equal(formatDuration(-1), "");
});
test("workbench palette changes every semantic accent with issue mode", () => {
	let mode: "prs" | "issues" = "prs";
	const theme = {
		fg: (color: string, text: string) => `<${color}>${text}`,
		bold: (text: string) => text,
		inverse: (text: string) => text,
	};
	const painter = workbenchPainter(theme, () => mode);
	assert.equal(painter.fg("accent", "mode"), "<accent>mode");
	mode = "issues";
	assert.equal(painter.fg("accent", "mode"), "<warning>mode");
	assert.equal(painter.fg("border", "─"), "<warning>─");
});

test("status icons are the Dagger glyphs and the spinner cycles", () => {
	assert.equal(statusIcon("success"), "✔");
	assert.equal(statusIcon("failure"), "✘");
	assert.equal(statusIcon("cached"), "$");
	assert.equal(statusIcon("pending"), "○");
	assert.equal(statusIcon("skipped"), "∅");
	assert.equal(statusIcon("running", 0), GLYPH.spinner[0]);
	assert.equal(statusIcon("running", 8), GLYPH.spinner[0]);
	assert.notEqual(statusIcon("running", 1), statusIcon("running", 0));
});

test("width measurement counts cells, not bytes", () => {
	assert.equal(visibleWidth("\u001b[31mred\u001b[0m"), 3);
	assert.equal(visibleWidth("中文"), 4);
	assert.equal(visibleWidth("e\u0301"), 1);
	assert.equal(visibleWidth(truncateToWidth("abcdefghij", 5)), 5);
	// Truncating inside a styled run must not leak color into the next cell.
	assert.ok(truncateToWidth("\u001b[31mabcdefghij\u001b[0m", 5).includes("\u001b[0m"));
});

// ---------------------------------------------------------------- tree

test("tree rails follow the last-child rule", () => {
	const rows = renderSpanTree(
		[
			{
				id: "root",
				label: "root",
				status: "running",
				children: [
					{ id: "a", label: "first", status: "success", children: [{ id: "a1", label: "nested", status: "success" }] },
					{ id: "b", label: "last", status: "pending" },
				],
			},
		],
		{ painter: PLAIN_PAINTER, width: 80, now: NOW, expansion: new Map([["a", true]]) },
	);
	const text = rows.map((r) => r.text);
	assert.ok(text[1].startsWith("├╴"), text[1]);
	// "first" is not the last child, so its own child keeps the parent rail.
	assert.ok(text[2].startsWith("│ ╰╴"), text[2]);
	assert.ok(text[3].startsWith("╰╴"), text[3]);
});

test("collapsed spans hide their children and logs", () => {
	const roots = [
		{
			id: "root",
			label: "root",
			status: "success",
			logs: ["hidden log"],
			children: [{ id: "child", label: "child", status: "success" }],
		},
	];
	const collapsed = renderSpanTree(roots, { painter: PLAIN_PAINTER, width: 80, now: NOW });
	assert.equal(collapsed.length, 1, "a settled span defaults to one line");
	assert.deepEqual(visibleSpanIds(roots), ["root"]);

	const expanded = renderSpanTree(roots, { painter: PLAIN_PAINTER, width: 80, now: NOW, expansion: new Map([["root", true]]) });
	assert.equal(expanded.length, 3);
	assert.ok(expanded[1].text.startsWith("┃ "), expanded[1].text);
});

test("running and failing spans open themselves", () => {
	for (const status of ["running", "failure", "findings"]) {
		const rows = renderSpanTree([{ id: "r", label: "r", status, children: [{ id: "c", label: "c", status: "pending" }] }], {
			painter: PLAIN_PAINTER,
			width: 80,
			now: NOW,
		});
		assert.equal(rows.length, 2, `${status} should expand by default`);
	}
});

test("log tails are capped with a hidden-line header", () => {
	const rows = renderSpanTree([{ id: "r", label: "r", status: "running", logs: ["a", "b", "c", "d", "e"] }], {
		painter: PLAIN_PAINTER,
		width: 80,
		now: NOW,
		maxLogLines: 2,
	});
	assert.ok(rows[1].text.includes("…3 lines hidden…"), rows[1].text);
	assert.ok(rows[2].text.endsWith("d"));
	assert.equal(rows.length, 4);
});

test("rendered rows never exceed the viewport width", () => {
	const rows = renderSpanTree(
		[{ id: "r", label: "x".repeat(400), status: "running", detail: "y".repeat(400), children: [{ id: "c", label: "z".repeat(400), status: "running" }] }],
		{ painter: PLAIN_PAINTER, width: 40, now: NOW },
	);
	for (const row of rows) assert.ok(visibleWidth(row.text) <= 40, `${visibleWidth(row.text)} > 40`);
});


test("the queue badge comes directly from GitHub checks", () => {
	const item = queueItem({ ciStatus: "failure" });
	assert.equal(ciGlyph(item.ciStatus).status, "failure");
	assert.equal(queueItem({ ciStatus: "success" }).ciStatus, "success");
});

test("native lifecycle evidence controls trace outcomes", () => {
	const success = new SessionTrace();
	success.startTurn(NOW);
	success.startTool("success", "bash", "tests", NOW);
	success.endTool("success", "Tests: 12 passed, 0 cancelled", false, NOW + 1);
	success.endTurn(NOW + 2);
	assert.equal(success.roots()[0].status, "success");

	const failure = new SessionTrace();
	failure.startTurn(NOW);
	failure.startTool("failure", "bash", "tests", NOW);
	failure.endTool("failure", "FAIL: AbortController cancellation regression", true, NOW + 1);
	failure.endTurn(NOW + 2);
	assert.equal(failure.roots()[0].status, "failure");

	const cancelled = new SessionTrace();
	cancelled.startTurn(NOW);
	cancelled.startTool("cancelled", "bash", "tests", NOW);
	cancelled.endTool("cancelled", {
		content: [{ type: "text", text: "tool call cancelled" }],
		details: { __interrupted: true, source: "interrupt_skipped", execution: "started" },
	}, true, NOW + 1);
	cancelled.endTurn(NOW + 2);
	assert.equal(cancelled.roots()[0].status, "skipped");
	assert.equal(cancelled.roots()[0].cls, "cancelled");
	assert.match(traceToText(cancelled.roots(), NOW + 2, 200), /CANCELLED/);
});

test("a foreground turn stays UNKNOWN while a native background task runs", () => {
	const trace = new SessionTrace();
	trace.startTurn(NOW);
	trace.startTool("task-call", "task", {}, NOW);
	trace.endTool("task-call", {
		details: {
			async: { type: "task", state: "running", jobId: "job-1" },
			progress: [{ id: "worker-1", index: 0, status: "running" }],
		},
	}, false, NOW + 1);
	trace.endTurn(NOW + 2);
	assert.equal(trace.roots()[0].status, "running");
	assert.equal(trace.roots()[0].cls, "unknown");
	assert.match(traceToText(trace.roots(), NOW + 2, 200), /UNKNOWN/);
	trace.syncAsyncJobs({ running: [], recent: [] }, NOW + 2.5);
	assert.equal(trace.roots()[0].status, "running", "missing terminal rows remain UNKNOWN");
	trace.syncAsyncJobs({ running: [{ id: "job-1", agentId: "worker-1", status: "running" }], recent: [] }, NOW + 2.75);
	trace.syncAsyncJobs({ running: [], recent: [{ id: "job-1", agentId: "worker-1", status: "completed" }] }, NOW + 3);
	assert.equal(trace.roots()[0].status, "success");
	assert.equal(trace.roots()[0].children[0].children?.[0].status, "success");
	trace.updateTool("task-call", {
		details: {
			async: { type: "task", state: "failed", jobId: "job-1" },
			progress: [{ id: "worker-1", index: 0, status: "failed" }],
		},
	}, NOW + 4);
	assert.equal(trace.roots()[0].status, "success", "late progress cannot regress a terminal job");
});

test("partial task details survive a plain final result", () => {
	const trace = new SessionTrace();
	trace.startTurn(NOW);
	trace.startTool("partial-task", "task", {}, NOW);
	trace.updateTool("partial-task", {
		details: {
			async: { type: "task", state: "running", jobId: "job-partial" },
			progress: [{ id: "worker-partial", index: 0, status: "running" }],
		},
	}, NOW + 1);
	trace.endTool("partial-task", "plain final result", false, NOW + 2);
	trace.endTurn(NOW + 3);
	assert.equal(trace.roots()[0].status, "running");
	trace.syncAsyncJobs({ running: [], recent: [{ id: "job-partial", agentId: "worker-partial", status: "completed" }] }, NOW + 4);
	assert.equal(trace.roots()[0].status, "success");
});

test("duplicate and late terminal events cannot regress a trace", () => {
	const trace = new SessionTrace();
	trace.startTurn(NOW);
	trace.startTool("once", "bash", {}, NOW);
	trace.endTool("once", "done", false, NOW + 1);
	trace.endTool("once", "abort", true, NOW + 2);
	trace.startTool("once", "bash", {}, NOW + 3);
	trace.endTurn(NOW + 4);
	assert.equal(trace.roots()[0].status, "success");

	trace.clear();
	trace.startTurn(NOW + 5);
	trace.startTool("once", "bash", {}, NOW + 5);
	trace.endTool("once", "reused", false, NOW + 6);
	trace.endTurn(NOW + 7);
	assert.equal(trace.roots()[0].status, "success");

	trace.clear();
	trace.endTool("once", "late failure", true, NOW + 8);
	assert.deepEqual(trace.roots(), []);

});
test("terminal markers are evicted with their retained trace roots", () => {
	const trace = new SessionTrace();
	trace.startTurn(NOW);
	trace.startTool("reusable", "bash", {}, NOW);
	trace.endTool("reusable", "first", false, NOW + 1);
	trace.endTurn(NOW + 2);
	for (let index = 0; index < 6; index++) {
		trace.startTurn(NOW + 10 + index);
		trace.startTool(`turn-${index}`, "bash", {}, NOW + 10 + index);
		trace.endTool(`turn-${index}`, "done", false, NOW + 11 + index);
		trace.endTurn(NOW + 12 + index);
	}
	trace.startTool("reusable", "bash", {}, NOW + 100);
	trace.endTool("reusable", "second", false, NOW + 101);
	assert.equal(trace.current()?.children?.some((child) => child.id === "tool/reusable"), true);
});

// ---------------------------------------------------------------- github

test("queue fetch maps CI rollup and reports auth failure", async () => {
	const calls = [];
	const ok = await fetchQueue("prs", { token: "t", scope: { kind: "org", value: "acme" }, fetchImpl: fakeFetch(calls) });
	assert.equal(ok.error, undefined);
	assert.equal(ok.items.length, 2);
	assert.equal(ok.items[0].ciStatus, "failure");
	assert.equal(ok.items[1].ciStatus, "success");
	assert.equal(ok.items[0].repo, "projectbluefin/review");
	assert.equal(ok.viewerLogin, "jorge");

	const missing = await fetchQueue("prs", { fetchImpl: fakeFetch([]) });
	assert.match(missing.error ?? "", /no GitHub credential/);

	const denied = await fetchQueue("prs", {
		token: "t",
		scope: { kind: "org", value: "acme" },
		fetchImpl: async () => ({ ok: false, status: 401, statusText: "Unauthorized", json: async () => ({}) }),
	});
	assert.match(denied.error ?? "", /401/, "a failed queue must say why, not render empty");
});

test("direct requested users govern fetched Review and Slay order, not teams or missing evidence", async () => {
	const node = (number, updatedAt, reviewRequests) => ({
		number,
		title: `change ${number}`,
		author: { login: "alice" },
		repository: { nameWithOwner: "owner/repo" },
		updatedAt: new Date(updatedAt).toISOString(),
		mergeable: "MERGEABLE",
		reviewDecision: "REVIEW_REQUIRED",
		commits: { nodes: [{ commit: { statusCheckRollup: { state: "SUCCESS" } } }] },
		files: { pageInfo: { hasNextPage: false }, nodes: [] },
		changedFiles: 0,
		reviewRequests,
	});
	const nodes = [
		node(2, NOW, { nodes: [] }),
		node(3, NOW - 1000, { nodes: [{ requestedReviewer: { __typename: "Team" } }] }),
		node(4, NOW - 2000, undefined),
		node(5, NOW - 3000, { nodes: [null, { requestedReviewer: null }, { requestedReviewer: { __typename: "User", login: "" } }] }),
		node(1, NOW - 4000, { nodes: [{ requestedReviewer: { __typename: "User", login: "JoSh" } }] }),
	];
	for (const viewerLogin of ["josh", "JOSH", undefined]) {
		const fetchImpl = async () => new Response(JSON.stringify({
			data: { viewer: { login: viewerLogin }, search: { pageInfo: { hasNextPage: false }, nodes } },
		}));
		const mode = new ReviewMode({ scope: { kind: "repo", value: "owner/repo" }, fetchImpl, env: { ...ISOLATED_ENV, REVIEW_MODE: "review" } });
		mode.setToken("t");
		const result = await mode.refreshQueue();
		assert.equal(result.error, undefined);
		const expected = viewerLogin ? [1, 2, 3, 4, 5] : [2, 3, 4, 5, 1];
		assert.deepEqual(mode.visibleItems().map((item) => item.id), expected);
		assert.deepEqual(mode.slayableItems(2).map((item) => item.id), expected.slice(0, 2));
		for (const item of result.items) {
			assert.equal(mode.priorityFor(item).category, item.id === 1 && viewerLogin ? "personal_request" : "review");
		}
		const named = await fetchItemsByKey(nodes.map((item) => `owner/repo#${item.number}`), "prs", {
			token: "t",
			fetchImpl: async () => new Response(JSON.stringify({
				data: Object.fromEntries(nodes.map((item, index) => [`w${index}`, { issueOrPullRequest: item }])),
			})),
		});
		assert.equal(named.error, undefined);
		const ranked = prioritize(named.items, { hive: EMPTY_HIVE, now: NOW, currentUserLogin: viewerLogin });
		assert.deepEqual(ranked.items.map((item) => item.id), expected, "named reads retain the same personal-request evidence");
	}
});

test("check suites surface failures and pending runs without rollup contexts", async () => {
	const fetchImpl = async (_url, init) => {
		const body = JSON.parse(String(init?.body ?? "{}"));
		assert.doesNotMatch(body.query, /files\(first: 100\)|checkSuites\(first: 50\)|closingIssuesReferences/);
		const node = (number, checkSuites) => ({
			number,
			title: `suite ${number}`,
			url: `https://github.com/projectbluefin/review/pull/${number}`,
			updatedAt: new Date(NOW).toISOString(),
			repository: { nameWithOwner: "projectbluefin/review" },
			commits: { nodes: [{ commit: { statusCheckRollup: null, checkSuites } }] },
		});
		return {
			ok: true,
			status: 200,
			statusText: "OK",
			json: async () => ({ data: { search: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [
				node(1, { pageInfo: { hasNextPage: false }, nodes: [
					{ status: "COMPLETED", conclusion: "FAILURE" },
					{ status: "IN_PROGRESS", conclusion: null },
				] }),
				node(2, { pageInfo: { hasNextPage: false }, nodes: [{ status: "IN_PROGRESS", conclusion: null }] }),
				node(3, { pageInfo: { hasNextPage: false }, nodes: [
					{ status: "COMPLETED", conclusion: "SUCCESS" },
					{ status: "COMPLETED", conclusion: "NEUTRAL" },
					{ status: "COMPLETED", conclusion: "SKIPPED" },
				] }),
			] } } }),
		};
	};
	const result = await fetchQueue("prs", { token: "t", scope: { kind: "org", value: "acme" }, fetchImpl });
	assert.deepEqual(result.items.map((item) => item.ciStatus), ["failure", "pending", "success"]);
	assert.deepEqual(result.items.map((item) => item.ciEvidenceSource), ["checkSuites", "checkSuites", "checkSuites"]);
});

test("unknown CI enum values remain incomplete instead of becoming skip-eligible", () => {
	const completeSuites = { pageInfo: { hasNextPage: false }, nodes: [{ status: "COMPLETED", conclusion: "SUCCESS" }] };
	assert.deepEqual(classifyCi("EXPECTED", completeSuites), { status: "pending", complete: true, source: "statusCheckRollup" });
	assert.deepEqual(classifyCi("FUTURE_ROLLUP_STATE", completeSuites), { complete: false, source: "statusCheckRollup" });
	assert.deepEqual(classifyCi(undefined, {
		pageInfo: { hasNextPage: false },
		nodes: [{ status: "FUTURE_SUITE_STATUS", conclusion: null }],
	}), { status: undefined, complete: false, source: "checkSuites" });
	assert.deepEqual(classifyCi(undefined, {
		pageInfo: { hasNextPage: false },
		nodes: [{ status: "COMPLETED", conclusion: "FUTURE_SUITE_CONCLUSION" }],
	}), { status: undefined, complete: false, source: "checkSuites" });
});
test("bounded named PR reads carry expensive evidence after lightweight discovery", async () => {
	let query = "";
	const result = await fetchItemsByKey(["owner/repo#1"], "prs", {
		token: "t",
		fetchImpl: async (_url, init) => {
			query = JSON.parse(String(init?.body ?? "{}")).query;
			return {
				ok: true,
				status: 200,
				statusText: "OK",
				json: async () => ({
					data: {
						w0: {
							issueOrPullRequest: {
								number: 1,
								repository: { nameWithOwner: "owner/repo" },
								headRefOid: "a".repeat(40),
								changedFiles: 1,
								files: { pageInfo: { hasNextPage: false }, nodes: [{ path: ".github/workflows/ci.yml" }] },
								commits: { nodes: [{ commit: {
									statusCheckRollup: null,
									checkSuites: { pageInfo: { hasNextPage: false }, nodes: [{ status: "COMPLETED", conclusion: "SUCCESS" }] },
								} }] },
								closingIssuesReferences: { nodes: [{ number: 2, repository: { nameWithOwner: "owner/repo" } }] },
							},
						},
					},
				}),
			};
		},
	});
	assert.match(query, /files\(first: 100\)/);
	assert.match(query, /checkSuites\(first: 50\)/);
	assert.match(query, /closingIssuesReferences\(first: 5\)/);
	assert.equal(result.items[0]?.headSha, "a".repeat(40));
	assert.deepEqual(result.items[0]?.workflowFiles, [".github/workflows/ci.yml"]);
	assert.deepEqual(result.items[0]?.closingIssues, ["owner/repo#2"]);
});

test("exact PR effect reads accept GitHub MERGED state and preserve null aggregate review decision", async () => {
	const item = queueItem({ id: 350, repo: "owner/repo", url: "https://github.com/owner/repo/pull/350", headSha: "a".repeat(40) });
	const effects = { 350: { state: "MERGED", merged: true, headSha: item.headSha, reviewDecision: null, reviews: [] } };
	const fetchImpl = recoveredPrSlayFetch([item], effects);
	const effect = await fetchPullRequestEffect("owner/repo", 350, { token: "t", fetchImpl });
	assert.equal(effect.kind, "observed");
	if (effect.kind === "observed") {
		assert.equal(effect.pullRequest.state, "MERGED");
		assert.equal(effect.pullRequest.merged, true);
		assert.equal(effect.pullRequest.reviewDecision, null);
	}
	const queue = await fetchItemsByKey(["owner/repo#350"], "prs", { token: "t", fetchImpl });
	assert.deepEqual(queue.items, [], "merged PRs remain absent from named open-queue reads");
});

test("exact PR effect reads reject contradictory GitHub state, merged, and mergedAt combinations", async () => {
	const item = queueItem({ id: 350, repo: "owner/repo", url: "https://github.com/owner/repo/pull/350", headSha: "a".repeat(40) });
	for (const effect of [
		{ state: "MERGED", merged: false, mergedAt: null },
		{ state: "MERGED", merged: true, mergedAt: null },
		{ state: "CLOSED", merged: true, mergedAt: new Date().toISOString() },
		{ state: "OPEN", merged: true, mergedAt: new Date().toISOString() },
	]) {
		const result = await fetchPullRequestEffect("owner/repo", 350, {
			token: "t",
			fetchImpl: recoveredPrSlayFetch([item], { 350: { ...effect, headSha: item.headSha, reviews: [] } }),
		});
		assert.equal(result.kind, "unknown", JSON.stringify(effect));
	}
});

test("exact PR effect reads retain closed state without changing the open queue projection", async () => {
	const item = queueItem({ id: 350, repo: "owner/repo", url: "https://github.com/owner/repo/pull/350", headSha: "a".repeat(40) });
	const effects = { 350: { state: "CLOSED", merged: false, headSha: item.headSha, reviewDecision: "REVIEW_REQUIRED", reviews: [] } };
	const fetchImpl = recoveredPrSlayFetch([item], effects);
	const effect = await fetchPullRequestEffect("owner/repo", 350, { token: "t", fetchImpl });
	assert.equal(effect.kind, "observed");
	if (effect.kind === "observed") {
		assert.equal(effect.pullRequest.state, "CLOSED");
		assert.equal(effect.pullRequest.merged, false);
	}
	const queue = await fetchItemsByKey(["owner/repo#350"], "prs", { token: "t", fetchImpl });
	assert.deepEqual(queue.items, [], "closed PRs remain absent from named open-queue reads");
});


test("successful statusCheckRollup takes precedence over unrelated queued check suites (#592)", async () => {
	const fetchImpl = async (_url, init) => {
		const node = (number, statusCheckRollup, checkSuites) => ({
			number,
			title: `suite ${number}`,
			url: `https://github.com/projectbluefin/review/pull/${number}`,
			updatedAt: new Date(NOW).toISOString(),
			repository: { nameWithOwner: "projectbluefin/review" },
			commits: { nodes: [{ commit: { statusCheckRollup, checkSuites } }] },
		});
		return {
			ok: true,
			status: 200,
			statusText: "OK",
			json: async () => ({
				data: {
					search: {
						pageInfo: { hasNextPage: false, endCursor: null },
						nodes: [
							node(
								1,
								{ state: "SUCCESS" },
								{
									pageInfo: { hasNextPage: false },
									nodes: [
										{ app: { name: "Azure Boards" }, status: "QUEUED", conclusion: null },
										{ app: { name: "Veracode Workflow App" }, status: "QUEUED", conclusion: null },
									],
								},
							),
						],
					},
				},
			}),
		};
	};
	const result = await fetchQueue("prs", { token: "t", scope: { kind: "org", value: "acme" }, fetchImpl });
	assert.equal(result.items[0].ciStatus, "success");
	assert.equal(result.items[0].ciEvidenceSource, "statusCheckRollup");
});

test("toCiStatus prioritizes decisive rollup and falls back to check suites (#592)", () => {
	// Rollup precedence over check suites
	const queuedSuites = {
		pageInfo: { hasNextPage: false },
		nodes: [
			{ status: "QUEUED", conclusion: null },
			{ status: "QUEUED", conclusion: null },
		],
	};
	assert.equal(toCiStatus("SUCCESS", queuedSuites), "success");
	assert.equal(toCiStatus("FAILURE", queuedSuites), "failure");
	assert.equal(toCiStatus("ERROR", queuedSuites), "failure");
	assert.equal(toCiStatus("PENDING", queuedSuites), "pending");

	// Fallback when rollup is absent or indeterminate
	assert.equal(toCiStatus(undefined, queuedSuites), "pending");
	assert.equal(toCiStatus(undefined, { pageInfo: { hasNextPage: true }, nodes: [] }), "pending");
	assert.equal(toCiStatus(undefined, {
		pageInfo: { hasNextPage: false },
		nodes: [{ status: "COMPLETED", conclusion: "FAILURE" }],
	}), "failure");
	assert.equal(toCiStatus(undefined, {
		pageInfo: { hasNextPage: false },
		nodes: [{ status: "COMPLETED", conclusion: "SUCCESS" }],
	}), "success");
	assert.equal(toCiStatus(undefined, {
		pageInfo: { hasNextPage: false },
		nodes: [
			{ status: "COMPLETED", conclusion: "SUCCESS" },
			{ status: "COMPLETED", conclusion: "NEUTRAL" },
			{ status: "COMPLETED", conclusion: "SKIPPED" },
		],
	}), "success");
	assert.equal(toCiStatus(undefined, null), undefined);
	assert.equal(toCiStatus(undefined, { pageInfo: { hasNextPage: false }, nodes: [] }), undefined);
});

test("managed pull request queue keeps workflow changes and incomplete file lists visible but blocked", async () => {
	const fetchImpl = async (_url, init) => {
		const body = JSON.parse(String(init?.body ?? "{}"));
		assert.doesNotMatch(body.query, /files\(first: 100\)|checkSuites\(first: 50\)|closingIssuesReferences/);
		return {
			ok: true,
			status: 200,
			statusText: "OK",
			json: async () => ({
				data: {
					search: {
						pageInfo: { hasNextPage: false, endCursor: null },
						nodes: [
							{
								number: 1,
								title: "workflow change",
								url: "https://github.com/projectbluefin/review/pull/1",
								updatedAt: new Date(NOW).toISOString(),
								repository: { nameWithOwner: "projectbluefin/review" },
								changedFiles: 1,
								files: { pageInfo: { hasNextPage: false }, nodes: [{ path: ".github/workflows/validate.yml" }] },
							},
							{
								number: 2,
								title: "ordinary change",
								url: "https://github.com/projectbluefin/review/pull/2",
								updatedAt: new Date(NOW).toISOString(),
								repository: { nameWithOwner: "projectbluefin/review" },
								changedFiles: 1,
								files: { pageInfo: { hasNextPage: false }, nodes: [{ path: "README.md" }] },
							},
							{
								number: 3,
								title: "truncated file list",
								url: "https://github.com/projectbluefin/review/pull/3",
								updatedAt: new Date(NOW).toISOString(),
								repository: { nameWithOwner: "projectbluefin/review" },
								changedFiles: 150,
								files: { pageInfo: { hasNextPage: true }, nodes: [{ path: "README.md" }] },
							},
						],
					},
				},
			}),
		};
	};
	const mode = new ReviewMode({ org: "projectbluefin", fetchImpl, env: ISOLATED_ENV, policy: { ...GENERIC_WORKBENCH_POLICY, allowWorkflowSlay: false } });
	mode.setToken("t");
	await mode.refreshQueue();

	assert.deepEqual(
		mode.items.map((item) => `${item.repo}#${item.id}`),
		["projectbluefin/review#1", "projectbluefin/review#2", "projectbluefin/review#3"],
	);
	assert.equal(mode.position(), "1/3");

	assert.equal(mode.selectById("projectbluefin/review", 1), true);
	const pr1 = mode.selected()!;
	const priority1 = mode.priorityFor(pr1);
	assert.equal(priority1?.category, "blocked");
	assert.equal(priority1?.reason, "workflow change");
	assert.match(priorityChip(PLAIN_PAINTER, priority1), /blocked · workflow change/);

	assert.equal(mode.selectById("projectbluefin/review", 2), true);
	const pr2 = mode.selected()!;
	assert.notEqual(mode.priorityFor(pr2)?.category, "blocked");

	assert.equal(mode.selectById("projectbluefin/review", 3), true);
	const pr3 = mode.selected()!;
	const priority3 = mode.priorityFor(pr3);
	assert.equal(priority3?.category, "blocked");
	assert.equal(priority3?.reason, "incomplete changed-file list");
	assert.match(priorityChip(PLAIN_PAINTER, priority3), /blocked · incomplete changed-file list/);

	// A queue containing only unsupported PRs does not say 0/0 or "nothing open"
	const unsupportedOnlyFetch = async () => ({
		ok: true,
		status: 200,
		statusText: "OK",
		json: async () => ({
			data: {
				search: {
					pageInfo: { hasNextPage: false, endCursor: null },
					nodes: [
						{
							number: 956,
							title: "build and deploy workflows",
							url: "https://github.com/projectbluefin/review/pull/956",
							updatedAt: new Date(NOW).toISOString(),
							repository: { nameWithOwner: "projectbluefin/review" },
							changedFiles: 3,
							files: { pageInfo: { hasNextPage: false }, nodes: [{ path: ".github/workflows/deploy.yml" }] },
						},
					],
				},
			},
		}),
	});
	const unsupportedMode = new ReviewMode({ org: "projectbluefin", fetchImpl: unsupportedOnlyFetch, env: ISOLATED_ENV, policy: { ...GENERIC_WORKBENCH_POLICY, allowWorkflowSlay: false } });
	unsupportedMode.setToken("t");
	await unsupportedMode.refreshQueue();

	assert.equal(unsupportedMode.items.length, 1);
	assert.equal(unsupportedMode.position(), "1/1");
	const dashboard = new ReviewDashboard({ requestRender() {} }, PLAIN_PAINTER, unsupportedMode, () => {}, () => {}, 24);
	const rendered = dashboard.render(80).join("\n");
	assert.doesNotMatch(rendered, /nothing open/);
	assert.doesNotMatch(rendered, /0\/0/);
	assert.match(rendered, /#956/);
	assert.match(rendered, /blocked · workflow change/);
	assert.match(rendered, /BLOCKED · workflow change/);
	assert.match(rendered, /changes \.github\/workflows\/deploy\.yml/);
});
test("queue cancellation is classified separately from failures", async () => {
	const controller = new AbortController();
	controller.abort();

	const cancelled = await fetchQueue("prs", {
		token: "t",
		scope: { kind: "org", value: "acme" },
		signal: controller.signal,
		fetchImpl: async () => {
			throw new Error("request was cancelled");
		},
	});
	assert.equal(cancelled.cancelled, true);
	assert.equal(cancelled.error, undefined);

	const failed = await fetchQueue("prs", {
		token: "t",
		scope: { kind: "org", value: "acme" },
		fetchImpl: async () => {
			throw new Error("network down");
		},
	});
	assert.equal(failed.cancelled, undefined);
	assert.equal(failed.error, "network down");
	const named = await fetchItemsByKey(["owner/repo#1"], "prs", {
		token: "t",
		signal: controller.signal,
		fetchImpl: async () => {
			throw new Error("named request was cancelled");
		},
	});
	assert.equal(named.cancelled, true);
	assert.equal(named.error, undefined);
});

test("scope refresh keeps the latest response when requests finish out of order", async () => {
	const requests = [];
	const fetchImpl = (_url, init) => {
		const pending = Promise.withResolvers();
		requests.push({ init, pending });
		return pending.promise;
	};
	const response = (repo, number) => ({
		ok: true,
		status: 200,
		statusText: "OK",
		json: async () => ({
			data: {
				search: {
					pageInfo: { hasNextPage: false },
					nodes: [
						{
							number,
							title: `item ${number}`,
							url: "",
							updatedAt: new Date(NOW).toISOString(),
							author: { login: "a" },
							repository: { nameWithOwner: repo },
							labels: { nodes: [] },
							isDraft: false,
							mergeable: "MERGEABLE",
							reviewDecision: "APPROVED",
							commits: { nodes: [] },
						},
					],
				},
			},
		}),
	});

	const mode = new ReviewMode({ org: "projectbluefin", fetchImpl,
		env: ISOLATED_ENV, });
	mode.setToken("t");
	const staleRefresh = mode.refreshQueue();
	assert.equal(requests.length, 1);

	mode.setScope({ kind: "repo", value: "owner/repo" });
	assert.equal(requests[0].init.signal.aborted, true);
	const currentRefresh = mode.refreshQueue();
	assert.equal(requests.length, 2);

	requests[1].pending.resolve(response("owner/repo", 2));
	await currentRefresh;
	requests[0].pending.resolve(response("projectbluefin/review", 1));
	const staleResult = await staleRefresh;

	assert.equal(staleResult.cancelled, true);
	assert.equal(mode.scopeLabel(), "owner/repo");
	assert.deepEqual(mode.items.map((item) => `${item.repo}#${item.id}`), ["owner/repo#2"]);
	assert.equal(mode.queueError, undefined);
});
test("scope refresh discards stale Hive backfill responses", async () => {
	const requests = [];
	const backfillStarted = Promise.withResolvers();
	const fetchImpl = async (_url, init) => {
		const body = JSON.parse(String(init?.body ?? "{}"));
		const pending = Promise.withResolvers();
		requests.push({ body, init, pending });
		if (body.variables?.search === undefined) backfillStarted.resolve();
		return pending.promise;
	};
	const node = (repo, number) => ({
		number,
		title: `item ${number}`,
		url: "",
		updatedAt: new Date(NOW).toISOString(),
		author: { login: "a" },
		repository: { nameWithOwner: repo },
		labels: { nodes: [] },
		isDraft: false,
		mergeable: "MERGEABLE",
		reviewDecision: "APPROVED",
		commits: { nodes: [] },
	});
	const searchResponse = (item) => ({
		ok: true,
		status: 200,
		statusText: "OK",
		json: async () => ({
			data: { search: { pageInfo: { hasNextPage: false }, nodes: item ? [item] : [] } },
		}),
	});
	const namedResponse = (item) => ({
		ok: true,
		status: 200,
		statusText: "OK",
		json: async () => ({ data: { w0: { issueOrPullRequest: { ...item, closed: false } } } }),
	});

	const mode = new ReviewMode({ org: "projectbluefin", fetchImpl,
		env: ISOLATED_ENV, });
	mode.setToken("t");
	mode.setScope({ kind: "repo", value: "owner/old" });
	const oldKey = "owner/old#9";
	mode.hive = {
		...EMPTY_HIVE,
		configured: true,
		online: true,
		hub: "https://hive.example",
		items: [{ key: oldKey, repo: "owner/old", number: 9, title: "old", url: "https://github.com/owner/old/pull/9", labels: [] }],
		ranks: new Map([[oldKey, 0]]),
	};

	const staleRefresh = mode.refreshQueue();
	assert.equal(requests.length, 1);
	requests[0].pending.resolve(searchResponse(undefined));
	await backfillStarted.promise;

	mode.setScope({ kind: "repo", value: "owner/new" });
	assert.equal(requests[0].init.signal.aborted, true);
	const currentRefresh = mode.refreshQueue();
	assert.equal(requests.length, 3);
	requests[2].pending.resolve(searchResponse(node("owner/new", 2)));
	await currentRefresh;

	requests[1].pending.resolve(namedResponse(node("owner/old", 9)));
	const staleResult = await staleRefresh;

	assert.equal(staleResult.cancelled, true);
	assert.deepEqual(mode.items.map((item) => `${item.repo}#${item.id}`), ["owner/new#2"]);
	assert.deepEqual(mode.hiveCoverage(), { present: 0, total: 0 });
	assert.equal(mode.queueError, undefined);
});



test("Hive coverage counts only work matching the active queue mode", () => {
	const mode = new ReviewMode({ org: "projectbluefin", env: ISOLATED_ENV });
	mode.hive = {
		...EMPTY_HIVE,
		configured: true,
		online: true,
		hub: "https://hive.example",
		items: [
			{ key: "projectbluefin/review#1", repo: "projectbluefin/review", number: 1, title: "issue", url: "https://github.com/projectbluefin/review/issues/1", labels: [] },
			{ key: "projectbluefin/review#2", repo: "projectbluefin/review", number: 2, title: "pull", url: "https://github.com/projectbluefin/review/pull/2", labels: [] },
			{ key: "projectbluefin/review#3", repo: "projectbluefin/review", number: 3, title: "linked", url: "https://github.com/projectbluefin/review/issues/3", labels: [], pr: { number: 4, url: "https://github.com/projectbluefin/review/pull/4", state: "open" } },
			{ key: "projectbluefin/review#5", repo: "projectbluefin/review", number: 5, title: "merged", url: "https://github.com/projectbluefin/review/issues/5", labels: [], pr: { number: 6, url: "https://github.com/projectbluefin/review/pull/6", state: "merged" } },
		],
		ranks: new Map([
			["projectbluefin/review#1", 0],
			["projectbluefin/review#2", 1],
			["projectbluefin/review#3", 2],
			["projectbluefin/review#5", 3],
		]),
	};

	mode.queueMode = "prs";
	mode.items = [queueItem({ id: 4, closingIssues: ["projectbluefin/review#3"] })];
	mode.reprioritize();
	assert.deepEqual(mode.hiveCoverage(), { present: 1, total: 2 });

	mode.queueMode = "issues";
	mode.items = [
		queueItem({ id: 1, type: "issue" }),
		queueItem({ id: 3, type: "issue" }),
		queueItem({ id: 5, type: "issue" }),
	];
	mode.reprioritize();
	assert.deepEqual(mode.hiveCoverage(), { present: 3, total: 3 });
});
test("issue queue fetch maps merged closedByPullRequestsReferences into closedByPrs", async () => {
	const issueFetch = async () => ({
		ok: true,
		status: 200,
		statusText: "OK",
		json: async () => ({
			data: {
				search: {
					pageInfo: { hasNextPage: false, endCursor: null },
					nodes: [
						{
							number: 1130,
							title: "Cache Maintenance fails on jq syntax error",
							url: "https://github.com/projectbluefin/bluefin/issues/1130",
							updatedAt: new Date(NOW - 1000).toISOString(),
							author: { login: "hive" },
							repository: { nameWithOwner: "projectbluefin/bluefin" },
							labels: { nodes: [] },
							closedByPullRequestsReferences: {
								nodes: [
									{
										number: 1203,
										state: "MERGED",
										merged: true,
										repository: { nameWithOwner: "projectbluefin/bluefin" },
									},
									{
										number: 1204,
										state: "OPEN",
										merged: false,
										repository: { nameWithOwner: "projectbluefin/bluefin" },
									},
								],
							},
						},
					],
				},
			},
		}),
	});
	const res = await fetchQueue("issues", { token: "t", scope: { kind: "org", value: "acme" }, fetchImpl: issueFetch });
	assert.equal(res.items.length, 1);
	assert.deepEqual(res.items[0].closedByPrs, ["projectbluefin/bluefin#1203"]);
	assert.deepEqual(res.items[0].submittedPrs, ["projectbluefin/bluefin#1203", "projectbluefin/bluefin#1204"]);
});

test("diff fetch is bounded but honest about it", async () => {
	const diff = await fetchDiff("projectbluefin/review", 42, { token: "t", fetchImpl: fakeFetch([]), maxPatchChars: 100 });
	assert.equal(diff.totalFiles, 2);
	assert.equal(diff.additions, 903);
	assert.ok(diff.files[0].patch, "the first patch is included");
	assert.ok(diff.files[1].patch === undefined || diff.files[1].patch.includes("truncated"));
	assert.equal(diff.truncated, true);
});

test("exactHeadVerified refuses unless the workspace is the exact expected head", () => {
	const sha = "a".repeat(40);
	assert.equal(exactHeadVerified(sha, sha), true, "an exact head match proceeds");
	assert.equal(exactHeadVerified(sha, "b".repeat(40)), false, "a different head is refused");
	assert.equal(exactHeadVerified(sha, undefined), false, "an unreadable workspace is refused");
	assert.equal(exactHeadVerified(undefined, sha), false, "a diff alone does not prove the head");
	assert.equal(exactHeadVerified(undefined, undefined), false, "nothing verifies without an expected head");
});

test("workflow capability preflight fails closed when push is true without authoritative workflow permission", async () => {
	const calls: string[] = [];
	const fetchImpl = async (url: string | URL) => {
		const target = String(url);
		calls.push(target);
		if (target === "https://api.github.com/") {
			return {
				ok: true,
				status: 200,
				statusText: "OK",
				headers: { get: () => null },
				json: async () => ({}),
			};
		}
		return {
			ok: true,
			status: 200,
			statusText: "OK",
			headers: { get: () => null },
			json: async () => ({ permissions: { push: true } }),
		};
	};
	assert.equal(await fetchOAuthScopes({ token: "fine-grained", fetchImpl }), undefined);
	assert.deepEqual(calls, ["https://api.github.com/"]);
});

test("workflow capability preflight accepts an authoritative OAuth workflow scope", async () => {
	const fetchImpl = async (url: string | URL) => ({
		ok: true,
		status: 200,
		statusText: "OK",
		headers: { get: (name: string) => name.toLowerCase() === "x-oauth-scopes" ? "repo, workflow" : null },
		json: async () => ({}),
	});
	assert.deepEqual(await fetchOAuthScopes({ token: "classic", fetchImpl }), ["repo", "workflow"]);
});

test("fetchDiff carries the PR head SHA so verification can materialize it exactly", async () => {
	const head = "c".repeat(40);
	const headFetch = (url: string | URL, init?: RequestInit) => {
		const target = String(url);
		if (target.includes("/pulls/42/files")) return fakeFetch([])(url, init);
		if (target.includes("/pulls/42")) {
			return { ok: true, status: 200, statusText: "OK", json: async () => ({ head: { sha: head } }) };
		}
		return fakeFetch([])(url, init);
	};
	const diff = await fetchDiff("projectbluefin/review", 42, { token: "t", fetchImpl: headFetch });
	assert.equal(diff.headSha, head, "the diff reports the exact PR head");
	assert.equal(diff.totalFiles, 2);
	assert.ok(exactHeadVerified(diff.headSha, head), "the reported head verifies against itself");
});

test("#440 a stale or unknown workspace head is refused before executable verification", async () => {
	// A diff proves only what GitHub reports. If the materialized workspace is not
	// the diff's exact head, verification must refuse rather than run against drift.
	const diff = await fetchDiff("projectbluefin/review", 42, { token: "t", fetchImpl: fakeFetch([]) });
	assert.equal(diff.headSha, null, "no PR payload means an unknown head");
	assert.equal(exactHeadVerified(diff.headSha, "a".repeat(40)), false, "an unknown expected head refuses");

	const head = "d".repeat(40);
	assert.equal(exactHeadVerified(head, head), true, "a matching workspace proceeds");
	assert.equal(exactHeadVerified(head, "e".repeat(40)), false, "a stale workspace head is refused");
});

test("the diff tool surfaces the exact head and status shows expected vs workspace SHA", async () => {
	const head = "4".repeat(40);
	const headFetch = (url: string | URL, init?: RequestInit) => {
		const target = String(url);
		if (target.includes("/pulls/42/files")) return fakeFetch([])(url, init);
		if (target.includes("/pulls/42")) {
			return { ok: true, status: 200, statusText: "OK", json: async () => ({ head: { sha: head } }) };
		}
		return fakeFetch([])(url, init);
	};
	const pi = fakeHost();
	const review = createReviewExtension(pi, { org: "projectbluefin", fetchImpl: headFetch, env: ISOLATED_ENV });
	const ctx = fakeCtx();
	ctx.ui.parent = ctx;
	await pi.events.get("session_start")({}, ctx);
	await review.whenStarted();

	const diff = await pi.tools.get("hive_workbench_diff").execute("id", { pull_request: 42 });
	assert.equal(diff.details.head_sha, head, "the diff tool surfaces the exact PR head");

	const status = await pi.tools.get("hive_workbench_status").execute("id", {});
	assert.match(status.content[0].text, /head: 4/, "status shows the expected head SHA");
});

// ---------------------------------------------------------------- mode + ui

test("a queue cut off by the fetch ceiling says so", async () => {
	// Two pages available, ceiling of one item: the counter must not read as total.
	const paged = async (_url, _init) => ({
		ok: true,
		status: 200,
		statusText: "OK",
		json: async () => ({
			data: {
				search: {
					pageInfo: { hasNextPage: true, endCursor: "next" },
					nodes: [
						{
							number: 1,
							title: "one",
							url: "",
							updatedAt: new Date(NOW).toISOString(),
							author: { login: "a" },
							repository: { nameWithOwner: "projectbluefin/review" },
							labels: { nodes: [] },
							commits: { nodes: [] },
						},
					],
				},
			},
		}),
	});

	const result = await fetchQueue("prs", { token: "t", scope: { kind: "org", value: "acme" }, limit: 1, fetchImpl: paged });
	assert.equal(result.truncated, true);

	const mode = new ReviewMode({ org: "projectbluefin", fetchImpl: paged });
	mode.setToken("t");
	await mode.refreshQueue();
	assert.match(mode.position(), /\+$/);

	const complete = await fetchQueue("prs", { token: "t", scope: { kind: "org", value: "acme" }, fetchImpl: fakeFetch([]) });
	assert.ok(!complete.truncated, "a complete queue does not report truncation");
});

test("without Hive the queue uses local attention order", async () => {
	const mode = new ReviewMode({ org: "projectbluefin", fetchImpl: fakeFetch([]), env: ISOLATED_ENV });
	mode.setToken("t");
	await mode.refreshQueue();
	assert.equal(mode.visibleItems().length, 2);

	assert.equal(mode.selected().id, 42, "local attention puts failing checks first");
	assert.equal(mode.priorityFor(mode.selected()).category, "fix-ci", "category explains local attention");
	assert.equal(mode.orderSource(), "local");

	mode.move(1);
	assert.equal(mode.selected().id, 7);
	assert.equal(mode.priorityFor(mode.selected()).category, "ready-for-human-merge");
	const before = mode.selectedKey();
	await mode.refreshQueue();
	assert.equal(mode.selectedKey(), before, "a refetch must not move the cursor off the item you were reading");

	mode.setFilter("launcher");
	assert.equal(mode.visibleItems().length, 1);
	assert.equal(mode.selected().id, 42);
	mode.setFilter("fix-ci");
	assert.equal(mode.selected().id, 42, "the category is part of the filter surface");
	mode.setFilter("");
	mode.skipRepos.add("other");
	assert.equal(mode.visibleItems().length, 1);
	assert.equal(mode.selected().id, 42, "skipped repo items are filtered out");
	mode.skipRepos.clear();
	assert.equal(mode.visibleItems().length, 2);

	assert.deepEqual(mode.ciTally(), { success: 1, failure: 1, pending: 0, unknown: 0 });
});

test("pull requests returned to their authenticated author precede Hive-ranked review work", () => {
	const returned = queueItem({ id: 9, author: "jorge", reviewState: "changes_requested", ciStatus: "failure" });
	const firstHive = queueItem({ id: 1, author: "ada", reviewState: "review_required", ciStatus: "success" });
	const secondHive = queueItem({ id: 2, author: "grace", reviewState: "review_required", ciStatus: "success" });
	const hive = {
		...EMPTY_HIVE,
		online: true,
		configured: true,
		ranks: new Map([
			[`${firstHive.repo}#${firstHive.id}`, 0],
			[`${secondHive.repo}#${secondHive.id}`, 1],
		]),
	};
	const ranked = prioritize([firstHive, secondHive, returned], { hive, now: NOW, currentUserLogin: "jorge" });

	assert.deepEqual(ranked.items.map((item) => item.id), [9, 1, 2]);
	assert.equal(ranked.priorities.get(`${returned.repo}#${returned.id}`)?.category, "repair-requested");
	assert.match(priorityChip(PLAIN_PAINTER, ranked.priorities.get(`${returned.repo}#${returned.id}`)), /repair/);
});

test("rail renders the queue, OMP activity, and keymap within width", () => {
	const mode = new ReviewMode({ org: "projectbluefin" });
	mode.items = [queueItem()];
	mode.fetchedAt = NOW - 3000;

	const rows = renderRail(mode, PLAIN_PAINTER, 100, NOW, 0, [{ chord: "alt+b", label: "workbench" }]);
	assert.ok(rows.some((row) => row.includes("projectbluefin/review#42") || row.includes("#42")));
	assert.ok(rows.some((row) => row.includes("alt+b: workbench")));
	for (const row of rows) assert.ok(visibleWidth(row) <= 100);

	mode.session.startTurn(NOW - 1000);
	const activeRows = renderRail(mode, PLAIN_PAINTER, 100, NOW, 0, [{ chord: "alt+b", label: "workbench" }]);
	assert.ok(activeRows.some((row) => row.includes("turn 1")), "the rail projects live OMP activity");
	for (const row of activeRows) assert.ok(visibleWidth(row) <= 100);

	assert.match(statusSegment(mode, PLAIN_PAINTER, NOW), /PR 1\/1 #42/);
	mode.selectedKeys.add("projectbluefin/review#42");
	assert.match(statusSegment(mode, PLAIN_PAINTER, NOW), /PR \[1 sel\] 1\/1 #42/);
	mode.selectedKeys.clear();

});

test("queue failures use human summaries while preserving diagnostics for Details", () => {
	const mode = new ReviewMode({ org: "projectbluefin" });
	mode.queueError = "GitHub GraphQL 503 fixture schemaMode outputSchema bookkeeping";
	for (const width of [80, 100]) {
		const rows = renderRail(mode, PLAIN_PAINTER, width, NOW, 0, []);
		assert.match(rows[0], /list unavailable/);
		assert.doesNotMatch(rows.join("\n"), /GraphQL|503|schemaMode|outputSchema/);
		assert.match(statusSegment(mode, PLAIN_PAINTER, NOW), /unavailable/);
		mode.items = [queueItem()];
		const dashboard = new ReviewDashboard({ requestRender() {} }, PLAIN_PAINTER, mode, () => {}, () => {}, 24);
		const frame = dashboard.render(width);
		dashboard.dispose();
		assert.match(frame[0], /refresh/);
		assert.doesNotMatch(frame.join("\n"), /GraphQL|503|schemaMode|outputSchema/);
		mode.items = [];
	}
	assert.match(mode.queueError, /GraphQL 503 fixture schemaMode outputSchema/, "presentation does not discard the original diagnostic");
});

test("rail and dashboard clarify an explicitly enabled empty Hive-only filter", () => {
	const mode = new ReviewMode({ org: "projectbluefin" });
	mode.hive = {
		...EMPTY_HIVE,
		configured: true,
		online: true,
		hub: "https://hive.example",
	};
	mode.items = [queueItem({ id: 10, title: "Unranked item" })];
	mode.reprioritize();
	mode.toggleHiveOnly();

	assert.equal(mode.hiveOnly, true);
	assert.equal(mode.visibleItems().length, 0);

	const railRows = renderRail(mode, PLAIN_PAINTER, 100, NOW, 0, []);
	assert.ok(railRows.some((r) => r.includes("no Hive-ranked prs")));
	assert.ok(railRows.some((r) => r.includes("H shows all")));
	const dashboard = new ReviewDashboard({ requestRender() {} }, PLAIN_PAINTER, mode, () => {}, () => {}, 24);
	const frame = dashboard.render(160);
	dashboard.dispose();
	assert.ok(frame.some((r) => r.includes("no Hive-ranked prs")));
	assert.ok(frame.some((r) => r.includes("press H to show all")));
});
test("queue age is silent while fresh and loud once stale", (t) => {
	assert.equal(queueAge(NOW - 1000, NOW), undefined, "a fresh queue must not repaint a counter every tick");
	assert.match(queueAge(NOW - STALE_AFTER_MS - 1, NOW), /^stale /);
	assert.equal(queueAge(0, NOW), "never fetched");

	const mode = new ReviewMode({ org: "projectbluefin" });
	mode.items = [queueItem()];
	mode.fetchedAt = NOW - 1000;
	assert.ok(!renderRail(mode, PLAIN_PAINTER, 100, NOW, 0, [])[0].includes("stale"));
	mode.fetchedAt = NOW - STALE_AFTER_MS - 1;
	assert.match(renderRail(mode, PLAIN_PAINTER, 100, NOW, 0, [])[0], /stale/);
});


test("dashboard navigates, folds, filters, and returns actions", (t) => {
	const root = mkdtempSync(join(tmpdir(), "workbench-test-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const mode = new ReviewMode({ org: "projectbluefin", env: { ...ISOLATED_ENV, REVIEW_MODE: "review" } });
	mode.items = [queueItem(), queueItem({ id: 7, repo: "projectbluefin/other", title: "feat(ui): dagger rail", ciStatus: "success" })];
	;

	let action;
	let refreshes = 0;
	const dashboard = new ReviewDashboard(
		{ requestRender() {} },
		PLAIN_PAINTER,
		mode,
		(result) => {
			action = result;
		},
		() => {
			refreshes += 1;
		},
		20,
	);
	t.after(() => dashboard.dispose());

	const frame = () => dashboard.render(120);
	assert.ok(frame()[0].includes("REVIEW WORKBENCH"));
	for (const row of frame()) assert.ok(visibleWidth(row) <= 120, row);

	assert.equal(mode.selected().id, 42, "failing checks come first");
	dashboard.handleInput("j");
	assert.equal(mode.selected().id, 7);
	dashboard.handleInput("k");
	assert.equal(mode.selected().id, 42);

	// Trace pane: `t` changes pane; Tab is reserved for PR/issue mode.
	dashboard.handleInput("t");
	dashboard.handleInput("h");
	const folded = frame().filter((row) => row.includes("review#42")).length;
	dashboard.handleInput("l");
	assert.ok(frame().length >= folded);

	// Filtering is inline and only commits on Enter.
	dashboard.handleInput("t");
	dashboard.handleInput("/");
	for (const ch of "dagger") dashboard.handleInput(ch);
	assert.equal(mode.filter, "", "filter is a draft until committed");
	dashboard.handleInput("\r");
	assert.equal(mode.visibleItems().length, 1);
	assert.equal(mode.selected().id, 7);
	assert.equal(mode.filter, "dagger");

	dashboard.handleInput("r");
	assert.equal(refreshes, 1);

	dashboard.handleInput("s");
	assert.equal(action.kind, "slay");
	assert.equal(action.item.id, 7);

	dashboard.handleInput("i");
	assert.equal(action.kind, "reference");
	assert.equal(action.item.id, 7);

	dashboard.handleInput("\r");
	assert.equal(action.kind, "reference");
	assert.equal(action.item.id, 7);
	dashboard.handleInput("v");
	assert.match(frame()[2], /PR READER: projectbluefin\/other#7/);
	dashboard.handleInput("q");
	dashboard.handleInput("c");
	assert.equal(action.kind, "comment");

	dashboard.handleInput("o");
	assert.equal(action.kind, "scope", "o asks for another repository");
	dashboard.handleInput("q");
	assert.equal(action.kind, "close");

	dashboard.handleInput("?");
	assert.ok(frame().some((row) => row.includes("comment")), "help lists supported actions");
	assert.ok(frame().some((row) => row.includes("slay")), "help exposes mass autoreview");
});
test("dashboard interactive search live-filters and selects items by title", (t) => {
	const root = mkdtempSync(join(tmpdir(), "workbench-test-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const mode = new ReviewMode({ org: "projectbluefin" });
	mode.items = [
		queueItem({ id: 7, repo: "projectbluefin/other", title: "token exchange fix", ciStatus: "success" }),
		queueItem({ id: 42, repo: "projectbluefin/review", title: "second item", ciStatus: "failure" }),
	];
	;
	const dashboard = new ReviewDashboard({ requestRender() {} }, PLAIN_PAINTER, mode, () => {}, () => {}, 20);
	t.after(() => dashboard.dispose());

	// Open search input with '/'
	dashboard.handleInput("/");
	assert.ok(dashboard.render(100).some((line) => line.includes("search")));

	// Type search query for title "token"
	for (const ch of "token") dashboard.handleInput(ch);
	dashboard.handleInput("\r");

	// The rendered queue shows only the matching item
	const renderedSearch = dashboard.render(100);
	assert.ok(renderedSearch.some((line) => line.includes("#7") && line.includes("token exchange fix")));
	assert.ok(!renderedSearch.some((line) => line.includes("#42") && line.includes("second item")));

	// Select it with Tab or Space
	dashboard.handleInput(" ");
	assert.ok(mode.selectedKeys.has("projectbluefin/other#7"), "selected item via search input");
	assert.equal(mode.selectedKeys.size, 1);
	assert.ok(mode.selectedKeys.has("projectbluefin/other#7"));
});

test("dashboard v reads issue body, comments, and linked pull requests without inference", async (t) => {
	const calls: string[] = [];
	const fetchImpl = async (url: string | URL | Request) => {
		const target = String(url);
		calls.push(target);
		if (target.endsWith("/issues/606/comments?per_page=100")) {
			return { ok: true, status: 200, statusText: "OK", json: async () => [{ user: { login: "reviewer" }, body: "A useful comment", created_at: "2026-09-16T00:00:00Z" }] };
		}
		if (target.endsWith("/issues/606/timeline?per_page=100")) {
			return { ok: true, status: 200, statusText: "OK", json: async () => [{ source: { issue: { number: 607, title: "linked fix", html_url: "https://github.com/projectbluefin/review/pull/607", repository: { full_name: "projectbluefin/review" }, pull_request: {}, state: "open" } } }] };
		}
		if (target.endsWith("/issues/606")) {
			return { ok: true, status: 200, statusText: "OK", json: async () => ({ number: 606, title: "keyboard actions", body: "Issue body", state: "open", html_url: "https://github.com/projectbluefin/review/issues/606", user: { login: "author" }, labels: [{ name: "bug" }] }) };
		}
		return { ok: false, status: 404, statusText: "Not Found", json: async () => ({}) };
	};
	const mode = new ReviewMode({ org: "projectbluefin", fetchImpl: fetchImpl as typeof fetch });
	mode.setToken("t");
	mode.queueMode = "issues";
	mode.items = [queueItem({ type: "issue", id: 606, title: "keyboard actions" })];
	const dashboard = new ReviewDashboard({ requestRender() {} }, PLAIN_PAINTER, mode, () => {}, () => {}, 20);
	t.after(() => dashboard.dispose());

	dashboard.handleInput("v");
	await new Promise((resolve) => setImmediate(resolve));
	const rendered = dashboard.render(160).join("\n");
	assert.match(rendered, /ISSUE READER: projectbluefin\/review#606/);
	assert.match(rendered, /Issue body/);
	assert.match(rendered, /A useful comment/);
	assert.match(rendered, /projectbluefin\/review#607/);
	assert.equal(calls.some((call) => call.includes("/pulls/606")), false);
});

test("workbench Tab switches entity mode and Alt+B selects one repository group", (t) => {
	const root = mkdtempSync(join(tmpdir(), "workbench-test-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const mode = new ReviewMode({ org: "projectbluefin", env: { ...ISOLATED_ENV, REVIEW_MODE: "review" } });
	mode.items = [
		queueItem({ id: 1, repo: "projectbluefin/a", ciStatus: "success" }),
		queueItem({ id: 2, repo: "projectbluefin/a", ciStatus: "success" }),
		queueItem({ id: 3, repo: "projectbluefin/b", ciStatus: "failure" }),
	];
	mode.reprioritize();
	mode.selectById("projectbluefin/a", 1);
	const modes: string[] = [];
	let refreshes = 0;
	const dashboard = new ReviewDashboard(
		{ requestRender() {} },
		PLAIN_PAINTER,
		mode,
		() => {},
		() => { refreshes += 1; },
		20,
		undefined,
		(next) => modes.push(next),
	);
	t.after(() => dashboard.dispose());

	dashboard.handleInput("alt+b");
	assert.deepEqual([...mode.selectedKeys].sort(), ["projectbluefin/a#1", "projectbluefin/a#2"]);
	dashboard.handleInput("alt+b");
	assert.equal(mode.selectedKeys.size, 0);

	dashboard.handleInput("\t");
	assert.equal(mode.queueMode, "issues");
	assert.deepEqual(modes, ["issues"]);
	assert.equal(refreshes, 1);
	assert.match(dashboard.render(120).join("\n"), /REVIEW WORKBENCH/);
});

test("dashboard Alt-S requests the repair-first autoslay lifecycle", (t) => {
	const root = mkdtempSync(join(tmpdir(), "workbench-test-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const mode = new ReviewMode({ org: "projectbluefin" });
	mode.items = [queueItem({ id: 1, repo: "projectbluefin/a", ciStatus: "success" })];
	mode.reprioritize();
	let emittedAction: DashboardAction | undefined;
	const dashboard = new ReviewDashboard(
		{ requestRender() {} },
		PLAIN_PAINTER,
		mode,
		(action) => { emittedAction = action; },
		() => {},
		20,
	);
	t.after(() => dashboard.dispose());

	dashboard.handleInput("alt+s");
	assert.deepEqual(emittedAction, { kind: "autoslay" });
	emittedAction = undefined;
	dashboard.handleInput("\u001bs");
	assert.deepEqual(emittedAction, { kind: "autoslay" });
});

test("repository waves preserve interleaved Hive order and pause survives session persistence", () => {
	const mode = new ReviewMode({ org: "projectbluefin" });
	mode.items = [
		queueItem({ id: 1, repo: "projectbluefin/a" }),
		queueItem({ id: 3, repo: "projectbluefin/b" }),
		queueItem({ id: 2, repo: "projectbluefin/a" }),
	];
	mode.reprioritize();
	for (const item of mode.items) mode.selectedKeys.add(`${item.repo}#${item.id}`);
	assert.deepEqual(
		mode.repositoryWaves().map((wave) => [wave.repo, wave.items.map((item) => item.id)]),
		[["projectbluefin/a", [1]], ["projectbluefin/b", [3]], ["projectbluefin/a", [2]]],
	);
	assert.equal(mode.togglePaused(), true);
	const persisted = mode.toPersisted();
	assert.equal(persisted.paused, true);
	const restored = new ReviewMode({ org: "projectbluefin" });
	restored.restore(persisted);
	assert.equal(restored.paused, true);
});

test("repository waves separate repair and issue work and cap each workflowz batch", () => {
	const mode = new ReviewMode({ org: "projectbluefin" });
	mode.currentUserLogin = "jorge";
	const repairs = [queueItem({ id: 1, author: "jorge", reviewState: "changes_requested" })];
	const issues = Array.from({ length: BATCH_LIMIT + 1 }, (_, index) => queueItem({
		id: index + 100,
		type: "issue",
		reviewState: "unknown",
	}));
	const waves = mode.repositoryWaves([...repairs, ...issues]);

	assert.deepEqual(waves.map((wave) => wave.items.length), [1, BATCH_LIMIT, 1]);
	assert.deepEqual(waves.map((wave) => wave.items[0].type), ["pr", "issue", "issue"]);
});

test("comment plans bind ordered targets and fail closed on live drift", () => {
	const targets = [
		{ repo: "projectbluefin/review", number: 42, type: "pull_request" as const, headSha: "a".repeat(40) },
		{ repo: "projectbluefin/review", number: 43, type: "issue" as const },
	];
	const plan = createCommentActionPlan(targets, "Evidence-backed comment", 123);
	assert.equal(plan.createdAt, 123);
	assert.match(renderCommentActionPlan(plan), /projectbluefin\/review#42/);
	assert.match(renderCommentActionPlan(plan), /Evidence-backed comment/);
	assert.equal(validateCommentActionPlan(plan, targets).valid, true);
	assert.equal(
		validateCommentActionPlan(plan, [{ ...targets[0], headSha: "b".repeat(40) }, targets[1]]).valid,
		false,
	);
	assert.deepEqual(commentInvocation(targets[1], plan.body), {
		command: "gh",
		args: ["issue", "comment", "43", "--repo", "projectbluefin/review", "--body", "Evidence-backed comment"],
	});
	assert.throws(() => createCommentActionPlan(targets, "   "), /comment body/i);
});

test("comment plans reject pull requests without a preview head", () => {
	const target = { repo: "projectbluefin/review", number: 42, type: "pull_request" as const };
	assert.throws(() => createCommentActionPlan([target], "Review evidence"), /Missing pull request head/);
	const plan = createCommentActionPlan([{ ...target, headSha: "a".repeat(40) }], "Review evidence");
	assert.equal(validateCommentActionPlan(plan, [target]).valid, false);
	assert.equal(validateCommentActionPlan({ ...plan, targets: [target] }, [target]).valid, false);
});
test("dashboard supports multi-selection with space, x to clear, and slay dispatch", (t) => {
	const root = mkdtempSync(join(tmpdir(), "workbench-test-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const mode = new ReviewMode({ org: "projectbluefin" });
	mode.items = [
		queueItem({ id: 7, repo: "projectbluefin/other", title: "first item", ciStatus: "success" }),
		queueItem({ id: 42, repo: "projectbluefin/review", title: "second item", ciStatus: "failure" }),
	];
	;

	let action;
	const dashboard = new ReviewDashboard(
		{ requestRender() {} },
		PLAIN_PAINTER,
		mode,
		(result) => {
			action = result;
		},
		() => {},
		20,
	);
	t.after(() => dashboard.dispose());

	// Initially both are unchecked
	assert.ok(dashboard.render(120).some((row) => row.includes("☐")));

	// Select item 7 (and cursor advances to item 42)
	assert.equal(mode.cursor, 0);
	dashboard.handleInput(" ");
	assert.ok(dashboard.render(120).some((row) => row.includes("☒")));
	assert.ok(dashboard.render(120).some((row) => row.includes("1 selected")));
	assert.equal(mode.cursor, 1, "space must advance cursor to next item");

	// Select item 42 directly without pressing j
	dashboard.handleInput(" ");
	assert.ok(dashboard.render(120).some((row) => row.includes("2 selected")));
	// Slay sends every selected item through mass autoreview.
	dashboard.handleInput("s");
	assert.equal(action.kind, "slay");
	assert.equal(action.items.length, 2);
	assert.equal(action.items[0].id, 7);
	assert.equal(action.items[1].id, 42);
	// Clear with x
	dashboard.handleInput("x");
	assert.ok(!dashboard.render(120).some((row) => row.includes("selected)")));
});

test("dashboard stacks panes on a narrow terminal", (t) => {
	const mode = new ReviewMode({ org: "projectbluefin" });
	mode.items = [queueItem()];
	const dashboard = new ReviewDashboard({ requestRender() {} }, PLAIN_PAINTER, mode, () => {}, () => {}, 20);
	t.after(() => dashboard.dispose());
	const rows = dashboard.render(70);
	assert.ok(rows.some((row) => row.startsWith("▼ QUEUE") || row.startsWith("▶ QUEUE")));
	for (const row of rows) assert.ok(visibleWidth(row) <= 70, row);
});

// ------------------------------------------------------- priority and scope

function prItem(overrides) {
	return queueItem({ ciStatus: "success", mergeState: "clean", reviewState: "review_required", ...overrides });
}

test("local governor orders every category independently of API arrival order", () => {
	const items = [
		prItem({ id: 9, workflowFiles: [".github/workflows/ci.yml"] }),
		prItem({ id: 8, ciStatus: "pending" }),
		prItem({ id: 7, type: "issue" }),
		prItem({ id: 6 }),
		prItem({ id: 5, reviewState: "approved" }),
		prItem({ id: 4, mergeState: "dirty" }),
		prItem({ id: 3, ciStatus: "failure" }),
		prItem({ id: 2, requestedReviewers: ["josh"] }),
		prItem({ id: 1, author: "josh", reviewState: "changes_requested" }),
	];
	const snapshot = structuredClone(items);
	for (const hive of [EMPTY_HIVE, { ...EMPTY_HIVE, configured: true, error: "offline", ranks: new Map([["projectbluefin/review#9", 0]]) }, { ...EMPTY_HIVE, configured: true, online: true }]) {
		for (const input of [items, [...items].reverse(), [...items.slice(4), ...items.slice(0, 4)]]) {
			const ranked = prioritize(input, { hive, now: NOW, currentUserLogin: "josh" });
			assert.deepEqual(ranked.items.map((item) => item.id), [1, 2, 3, 4, 5, 6, 7, 8, 9]);
			assert.equal(ranked.priorities.get("projectbluefin/review#9").category, "blocked");
		}
	}
	assert.deepEqual(items, snapshot, "ranking does not mutate its captured snapshot");
});

test("local governor bounds demotions within categories and breaks ties by canonical key", () => {
	for (const type of ["pr", "issue"]) {
		const items = [
			prItem({ id: 6, type, author: "dependabot[bot]", updatedAt: NOW - 30 * 86400000 }),
			prItem({ id: 5, type, updatedAt: NOW - 30 * 86400000 }),
			prItem({ id: 4, type, labels: ["dependencies"], updatedAt: NOW }),
			prItem({ id: 3, type, updatedAt: 0 }),
			prItem({ id: 2, type, updatedAt: NOW - 100 }),
			prItem({ id: 1, type, updatedAt: NOW - 100 }),
		];
		for (const input of [items, [...items].reverse()]) {
			const ranked = prioritize(input, { hive: EMPTY_HIVE, now: NOW });
			assert.deepEqual(ranked.items.map((item) => item.id), [1, 2, 3, 4, 5, 6]);
			assert.equal(ranked.priorities.get("projectbluefin/review#6").demotion, 3);
		}
	}
	const urgent = prItem({ id: 9, ciStatus: "failure", author: "renovate[bot]", updatedAt: NOW - 90 * 86400000 });
	assert.equal(prioritize([prItem({ id: 1, updatedAt: NOW }), urgent], { hive: EMPTY_HIVE, now: NOW }).items[0].id, 9);
});

test("local attention does not demote inherited bot-author names for PRs or issues", () => {
	for (const type of ["pr", "issue"]) {
		const items = [
			prItem({ id: 2, type, author: "alice", updatedAt: NOW - 1000 }),
			prItem({ id: 1, type, author: "constructor", updatedAt: NOW }),
			prItem({ id: 3, type, author: "DePeNdAbOt[bot]", updatedAt: NOW }),
			prItem({ id: 4, type, author: "alice", labels: ["dependencies"], updatedAt: NOW }),
			prItem({ id: 5, type, author: "alice", title: "chore(deps): update library", updatedAt: NOW }),
		];
		const ranked = prioritize(items, { hive: EMPTY_HIVE, now: NOW });
		assert.deepEqual(ranked.items.map((item) => item.id), [1, 2, 3, 4, 5]);
		assert.deepEqual(items.map((item) => ranked.priorities.get(`projectbluefin/review#${item.id}`).demotion), [0, 0, 1, 1, 1]);
	}
});

test("local governor shares the visible projection with Slay and preserves explicit selection", (t) => {
	const mode = new ReviewMode({ env: { ...ISOLATED_ENV, REVIEW_MODE: "review" } });
	mode.items = [prItem({ id: 3, ciStatus: "pending" }), prItem({ id: 2 }), prItem({ id: 1, ciStatus: "failure" })];
	mode.reprioritize(NOW);
	assert.deepEqual(mode.slayableItems(), mode.visibleItems());
	assert.deepEqual(mode.slayableItems(2).map((item) => item.id), [1, 2]);
	const dashboard = new ReviewDashboard({ requestRender() {} }, PLAIN_PAINTER, mode, () => {}, () => {}, 24);
	t.after(() => dashboard.dispose());
	assert.match(dashboard.render(140).join("\n"), /LOCAL · attention order/);
	assert.doesNotMatch(dashboard.render(140).join("\n"), /LOCAL · LOCAL/);
	mode.toggleSelected("projectbluefin/review#3");
	assert.deepEqual(mode.slayableItems().map((item) => item.id), [3]);
	assert.deepEqual(mode.visibleItems().map((item) => item.id), [1, 2, 3]);
});

test("without a hub local categories govern queue order", () => {
	const now = NOW;
	const items = [
		prItem({ id: 1, title: "chore(deps): bump", author: "renovate[bot]", labels: ["deps"], reviewState: "approved" }),
		prItem({ id: 2, title: "draft work", draft: true }),
		prItem({ id: 3, title: "approved change", reviewState: "approved", updatedAt: now - 1000 }),
		prItem({ id: 4, title: "broken change", ciStatus: "failure" }),
		prItem({ id: 5, title: "conflicted change", mergeState: "dirty" }),
		prItem({ id: 6, title: "running checks", ciStatus: "pending" }),
		prItem({ id: 7, title: "reviewed change" }),
	];
	const ranked = prioritize(items, { hive: EMPTY_HIVE, now });

	assert.equal(ranked.source, "local");
	assert.deepEqual(ranked.items.map((item) => item.id), [4, 5, 3, 1, 7, 2, 6]);
	assert.equal(ranked.priorities.get("projectbluefin/review#3").category, "ready-for-human-merge");
	assert.equal(ranked.priorities.get("projectbluefin/review#7").category, "review");
	assert.match(ranked.priorities.get("projectbluefin/review#7").reason, /awaiting review/);
	assert.equal(ranked.priorities.get("projectbluefin/review#5").category, "resolve-conflicts");
	assert.equal(ranked.priorities.get("projectbluefin/review#4").category, "fix-ci");
	assert.equal(ranked.priorities.get("projectbluefin/review#2").category, "investigate");
	assert.equal(ranked.priorities.get("projectbluefin/review#1").demotion, 1, "dependency bumps sink within their category");
	assert.equal(categorize(queueItem({ type: "issue" }), { hive: EMPTY_HIVE, now }).category, "triage");
});
test("local issue queues prefer recent work and delineate repository transitions", () => {
	const now = NOW;
	const items = [
		queueItem({ id: 201, type: "issue", repo: "projectbluefin/server", title: "server issue", updatedAt: now - 100 }),
		queueItem({ id: 101, type: "issue", repo: "projectbluefin/actions", title: "actions issue", updatedAt: now - 50 }),
		queueItem({ id: 202, type: "issue", repo: "projectbluefin/server", title: "another server issue", updatedAt: now - 10 }),
		queueItem({ id: 102, type: "issue", repo: "projectbluefin/actions", title: "second actions issue", updatedAt: now - 20 }),
	];
	const ranked = prioritize(items, { hive: EMPTY_HIVE, now });
	assert.deepEqual(
		ranked.items.map((item) => `${item.repo}#${item.id}`),
		["projectbluefin/server#202", "projectbluefin/actions#102", "projectbluefin/actions#101", "projectbluefin/server#201"],
	);

	const mode = new ReviewMode({ org: "projectbluefin" });
	mode.items = items;
	mode.queueMode = "issues";
	mode.reprioritize();

	const dashboard = new ReviewDashboard({ requestRender() {} }, PLAIN_PAINTER, mode, () => {}, () => {}, 24);
	const lines = dashboard.render(80);
	dashboard.dispose();

	// Divider row between projectbluefin/actions and projectbluefin/server
	assert.ok(lines.some((line) => line.includes("─── projectbluefin/server")), "dashboard delineates repo transitions with horizontal dividers");
});


test("with a hub the order is Hive's, including through a closing reference", () => {
	const hive = {
		...EMPTY_HIVE,
		configured: true,
		online: true,
		hub: "https://hive.example",
		items: [
			{ key: "projectbluefin/docs#900", repo: "projectbluefin/docs", number: 900, title: "queued", url: "", labels: [], level: "ready" },
			{ key: "projectbluefin/review#5", repo: "projectbluefin/review", number: 5, title: "queued", url: "", labels: [] },
		],
		ranks: buildRankMap(
			[
				{ key: "projectbluefin/docs#900", repo: "projectbluefin/docs", number: 900, title: "", url: "", labels: [], level: "ready" },
				{ key: "projectbluefin/review#5", repo: "projectbluefin/review", number: 5, title: "", url: "", labels: [] },
			],
			[],
		),
	};

	const items = [
		// Ordinary review follows actionable CI repair in local attention order.
		prItem({ id: 3, ciStatus: "success" }),
		// Hive queued the issue this PR closes, so the PR inherits the position.
		prItem({ id: 11, ciStatus: "failure", closingIssues: ["projectbluefin/docs#900"] }),
		prItem({ id: 5, ciStatus: "pending" }),
	];
	const ranked = prioritize(items, { hive, now: NOW });

	assert.equal(ranked.source, "hive");
	assert.equal(ranked.hiveRanked, 2);
	assert.equal(ranked.priorities.get("projectbluefin/review#11").category, "fix-ci");
	assert.match(priorityChip(PLAIN_PAINTER, ranked.priorities.get("projectbluefin/review#11")), /fix.ci.*hive#1/);
	assert.deepEqual(ranked.items.map((item) => item.id), [11, 5, 3], "Hive's positions are preserved, not recomputed");
	assert.match(ranked.priorities.get("projectbluefin/review#11").reason, /hive ready #1 via projectbluefin\/docs#900/);
	assert.equal(ranked.priorities.get("projectbluefin/review#3").source, "local");
});
test("mode defaults to the complete queue and H narrows it to Hive-ranked work", () => {
	const hive = {
		...EMPTY_HIVE,
		configured: true,
		online: true,
		hub: "https://hive.example",
		items: [{ key: "projectbluefin/review#11", repo: "projectbluefin/review", number: 11, title: "queued", url: "", labels: [] }],
		ranks: buildRankMap([{ key: "projectbluefin/review#11", repo: "projectbluefin/review", number: 11, title: "", url: "", labels: [] }], []),
	};
	const mode = new ReviewMode({ org: "projectbluefin", env: ISOLATED_ENV });
	mode.hive = hive;
	mode.items = [
		prItem({ id: 3, ciStatus: "success" }),
		prItem({ id: 11, ciStatus: "success" }),
	];
	mode.reprioritize();

	assert.equal(mode.hiveOnly, false, "default view includes the review queue");
	assert.equal(mode.visibleItems().length, 2);

	mode.toggleHiveOnly();
	assert.equal(mode.hiveOnly, true);
	assert.equal(mode.visibleItems().length, 1);
	assert.equal(mode.visibleItems()[0]?.id, 11);

	mode.toggleHiveOnly();
	assert.equal(mode.hiveOnly, false);
	assert.equal(mode.visibleItems().length, 2);
});


test("an unreachable hub degrades to local order and says why", async () => {
	const snapshot = await fetchHive({
		env: { HIVE_HUB: "wss://hive.example/contribute", GH_TOKEN: "t" },
		fetchImpl: async () => ({ ok: false, status: 503, statusText: "Service Unavailable", json: async () => ({}) }),
	});
	assert.equal(snapshot.configured, true);
	assert.equal(snapshot.online, false, "a hub that answers 503 has not answered");
	assert.match(snapshot.error, /503/);
	assert.equal(snapshot.ranks.size, 0);

	// wss:// is the registration form; token-bearing requests use https.
	// Registration names the websocket endpoint; the REST API hangs off the root.
	// Keeping the suffix is what made every call 404 against a real hub.
	assert.equal(resolveHub({ HIVE_HUB: "wss://hive.example/contribute" }), "https://hive.example");
	assert.equal(resolveHub({ HIVE_HUB: "https://hive.example" }), "https://hive.example");
	assert.equal(resolveHub({ HIVE_HUB: "https://user:pw@hive.example" }), "", "no token to a URL carrying credentials");
	assert.equal(resolveHub({ HIVE_HUB: "http://hive.example" }), "", "no token over plaintext");
	assert.equal(resolveHub({ HIVE_HUB: "https://a,https://b" }), "", "an unmade selection is not a hub");
	assert.equal(resolveHub({ HOME: "/nonexistent" }), "");
});

test("Hive read-side integration never infers a hub from contributor registration", () => {
	const home = mkdtempSync(join(tmpdir(), "review-hive-registration-"));
	try {
		const registration = join(home, ".config", "hive");
		mkdirSync(registration, { recursive: true });
		writeFileSync(join(registration, "contributor.env"), "HIVE_HUB=https://hive.example\n");
		assert.equal(resolveHub({ HOME: home }), "");
		assert.equal(resolveHub({ HOME: home, HIVE_HUB: "https://explicit.example" }), "https://explicit.example");
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});

test("a hub's queue and triage become one rank map in Hive's order", async () => {
	const calls = [];
	const snapshot = await fetchHive({
		env: { HIVE_HUB: "https://hive.example", GH_TOKEN: "t" },
		fetchImpl: async (url) => {
			calls.push(String(url));
			const path = String(url).replace("https://hive.example", "");
			const body =
				path === "/api/v1/status"
					? { hub: "online", actionable_items: 122 }
					: path === "/api/v1/contributors"
						? {
								contributors: [
									{
										github_username: "danathar",
										active: true,
										current_task: { key: "projectbluefin/review#42", repo: "projectbluefin/review", number: 42 },
									},
									// Offline workers hold nothing: their last task is history.
									{
										github_username: "ghost",
										active: false,
										current_task: { key: "projectbluefin/docs#1092", repo: "projectbluefin/docs", number: 1092 },
									},
								],
							}
					: path === "/api/contribute/queue"
						? { queue: [{ repo: "projectbluefin/docs", number: 1092, title: "fix pin state", labels: ["3-clanker-queue"] }] }
						: {
								groups: [
									{
										level: "reviewing",
										label: "Reviewing",
										count: 2,
										issues: [
											{ repo: "projectbluefin/review", number: 42, title: "under review" },
											// The same work the ready queue already listed. Hive says
											// what stage it is at and which change answers it; only
											// the queue says where it sits.
											{
												repo: "projectbluefin/docs",
												number: 1092,
												title: "fix pin state",
												pr: { number: 1170, url: "https://github.com/projectbluefin/docs/pull/1170", state: "open" },
											},
										],
									},
								],
							};
			return { ok: true, status: 200, statusText: "OK", json: async () => body };
		},
	});

	assert.equal(snapshot.online, true);
	assert.equal(snapshot.actionableItems, 122);
	assert.deepEqual([...snapshot.ranks.entries()], [
		["projectbluefin/docs#1092", 0],
		["projectbluefin/review#42", 1],
	]);
	assert.deepEqual(snapshot.triage, [{ level: "reviewing", label: "Reviewing", count: 2 }]);

	// One entry per key: the queue's position, the triage view's stage and link.
	assert.equal(snapshot.items.length, 2);
	const queued = snapshot.items.find((item) => item.key === "projectbluefin/docs#1092");
	assert.equal(queued.level, "reviewing", "an item's stage must survive being in both views");
	assert.deepEqual(queued.pr, { number: 1170, url: "https://github.com/projectbluefin/docs/pull/1170", state: "open" });
	assert.deepEqual(queued.labels, ["3-clanker-queue"], "the queue view's labels are kept");

	// Who is already on something, so a batch never duplicates a live worker.
	assert.deepEqual([...snapshot.claims.entries()], [["projectbluefin/review#42", "danathar"]]);
	assert.equal(calls.length, 4);
});

test("a repository scope is parsed strictly and reaches the search", () => {
	assert.deepEqual(parseScope("acme/widgets", ""), { kind: "repo", value: "acme/widgets" });
	assert.deepEqual(parseScope("https://github.com/acme/widgets.git", ""), { kind: "repo", value: "acme/widgets" });
	assert.deepEqual(parseScope("org:acme", ""), { kind: "org", value: "acme" });
	assert.deepEqual(parseScope("widgets", "acme"), { kind: "repo", value: "acme/widgets" });
	assert.equal(parseScope("widgets", ""), undefined);
	assert.equal(parseScope("not a repo", ""), undefined);
	assert.equal(parseScope("  ", ""), undefined);
	assert.match(searchExpression("prs", { kind: "repo", value: "acme/widgets" }), /^repo:acme\/widgets is:pr /);
	assert.match(searchExpression("issues", { kind: "org", value: "acme" }), /^org:acme is:issue /);
});
test("Review skip-repository configuration uses the canonical environment", () => {
 const configured = new ReviewMode({ org: "", env: { ...ISOLATED_ENV, REVIEW_SKIP_REPOS: "acme/skip, acme/other" } });
 assert.deepEqual([...configured.skipRepos], ["acme/skip", "acme/other"]);
 const empty = new ReviewMode({ org: "", env: { ...ISOLATED_ENV, REVIEW_SKIP_REPOS: undefined } });
 assert.deepEqual([...empty.skipRepos], []);
});

test("GitHub-only Review ignores an inherited Hive hub", async () => {
	const calls: string[] = [];
	const pi = fakeHost();
	const review = createReviewExtension(pi, {
		org: "acme",
		fetchImpl: async (url, init) => {
			calls.push(String(url));
			return fakeFetch([])(url, init);
		},
		env: { ...ISOLATED_ENV, REVIEW_MODE: "review", HIVE_HUB: "https://hive.example" },
	});
	const ctx = fakeCtx();
	ctx.ui.parent = ctx;
	await pi.events.get("session_start")({}, ctx);
	await review.whenStarted();

	assert.ok(calls.length > 0, "the explicit GitHub scope loads its queue");
	assert.ok(calls.every((url) => url.startsWith("https://api.github.com/")), calls.join("\n"));
	assert.ok(pi.tools.has("review_workbench_queue"));
	assert.equal(pi.tools.has("hive_workbench_status"), false);
});

test("fresh Review prompts for scope and makes no GitHub request before one is selected", async () => {
	const calls = [];
	const pi = fakeHost();
	const review = createReviewExtension(pi, {
		fetchImpl: async (...args) => {
			calls.push(args);
			return fakeFetch([])(...args);
		},
		env: { ...ISOLATED_ENV, REVIEW_MODE: "review", REVIEW_DEFAULT_SCOPE: undefined },
	});
	const ctx = fakeCtx();
	ctx.ui.parent = ctx;
	await pi.events.get("session_start")({}, ctx);
	await review.whenStarted();

	assert.equal(ctx.inputCalls.length, 1);
	assert.equal(ctx.inputCalls[0][0], "Review which repository?");
	assert.deepEqual(calls, []);
	assert.equal(ctx.overlays.length, 0);
});

test("headless Review without configured scope reports the requirement without contacting GitHub", async () => {
	const calls = [];
	const pi = fakeHost();
	createReviewExtension(pi, {
		fetchImpl: async (...args) => {
			calls.push(args);
			return fakeFetch([])(...args);
		},
		env: { ...ISOLATED_ENV, REVIEW_MODE: "review", REVIEW_DEFAULT_SCOPE: undefined },
	});
	const ctx = fakeCtx();
	ctx.hasUI = false;
	await pi.events.get("session_start")({}, ctx);
	const queue = await pi.tools.get("review_workbench_queue").execute("headless", {});

	assert.deepEqual(calls, []);
	assert.match(queue.content[0].text, /scope is required; supply owner\/repo or org:<name>/i);
	assert.equal(queue.isError, true);
});

test("scoping the queue to one repository refetches and persists", async () => {
	const searches = [];
	const scoped = async (url, init) => {
		const body = JSON.parse(String(init?.body ?? "{}"));
		searches.push(body.variables.search);
		return {
			ok: true,
			status: 200,
			statusText: "OK",
			json: async () => ({ data: { search: { pageInfo: { hasNextPage: false }, nodes: [] } } }),
		};
	};
	const mode = new ReviewMode({ org: "projectbluefin", fetchImpl: scoped, env: ISOLATED_ENV });
	mode.setToken("t");
	mode.setScope(parseScope("owner/repo", "projectbluefin"));
	await mode.refreshQueue();

	assert.equal(mode.scopeLabel(), "owner/repo");
	assert.match(searches[0], /repo:owner\/repo/);
	assert.deepEqual(mode.toPersisted().scope, { kind: "repo", value: "owner/repo" });
});

test("CLI flags forward parsed scope and preselected item to mode", async () => {
	const pi = fakeHost();
	const scopedFetch = async (url: string, init?: { body?: string }) => {
		const body = JSON.parse(String(init?.body ?? "{}"));
		if (body.variables?.search !== undefined) {
			return {
				ok: true,
				status: 200,
				statusText: "OK",
				json: async () => ({
					data: {
						search: {
							pageInfo: { hasNextPage: false, endCursor: null },
							nodes: [
								{
									number: 42,
									title: "fix(launcher): resolve HIVE_HUB before mutating",
									url: "https://github.com/projectbluefin/review/pull/42",
									updatedAt: new Date(NOW - 1000).toISOString(),
									isDraft: false,
									mergeable: "MERGEABLE",
									reviewDecision: "REVIEW_REQUIRED",
									additions: 42,
									deletions: 7,
									changedFiles: 3,
									author: { login: "jorge" },
									repository: { nameWithOwner: "projectbluefin/review" },
									labels: { nodes: [{ name: "launcher" }] },
									commits: { nodes: [{ commit: { statusCheckRollup: { state: "FAILURE" } } }] },
								},
							],
						},
					},
				}),
			};
		}
		return { ok: true, status: 200, statusText: "OK", json: async () => ({ data: {} }) };
	};
	const review = createReviewExtension(pi, { org: "projectbluefin", fetchImpl: scopedFetch, env: ISOLATED_ENV });
	const ctx = fakeCtx();
	ctx.ui.parent = ctx;
	;
	pi.flagValues.set("repo", "projectbluefin/review");
	pi.flagValues.set("pr", "42");
	await pi.events.get("session_start")({}, ctx);
	await review.whenStarted();

	const status = await pi.tools.get("hive_workbench_status").execute("id", {});
	assert.equal(status.details.scope.kind, "repo");
	assert.equal(status.details.scope.value, "projectbluefin/review");
	assert.equal(status.details.selected.id, 42);
});

// ---------------------------------------------------------------- session trace

test("tool executions become spans on the current turn", () => {
	const trace = new SessionTrace();
	trace.startTurn(NOW);
	trace.startTool("c1", "bash", { command: "just review-doctor\nsecond line" }, NOW + 100);
	trace.updateTool("c1", "checking podman");
	assert.equal(trace.active().label, "bash(just review-doctor)");
	trace.endTool("c1", { content: [{ type: "text", text: "ok" }] }, false, NOW + 900);
	trace.endTurn(NOW + 1000);

	const turn = trace.roots()[0];
	assert.equal(turn.status, "success");
	assert.equal(turn.children[0].status, "success");
	assert.deepEqual(turn.children[0].logs, ["ok"]);
	assert.equal(trace.active(), undefined);

	const failing = new SessionTrace();
	failing.startTool("c2", "read", { path: "AGENTS.md" }, NOW);
	failing.endTool("c2", "boom", true, NOW + 5);
	failing.endTurn(NOW + 6);
	assert.equal(failing.roots()[0].status, "failure", "a failed tool fails its turn");
});

test("native trace events reach the plain-text inspection surface with correct outcomes", async () => {
	const pi = fakeHost();
	const review = createReviewExtension(pi, { org: "projectbluefin", fetchImpl: fakeFetch([]), env: { ...ISOLATED_ENV, REVIEW_MODE: "review" } });
	const ctx = fakeCtx();
	await pi.events.get("session_start")({}, ctx);
	await review.whenStarted();

	pi.events.get("turn_start")({}, ctx);
	pi.events.get("tool_execution_start")({ toolCallId: "success", toolName: "bash", args: {} }, ctx);
	pi.events.get("tool_execution_end")({ toolCallId: "success", result: "Tests: 12 passed, 0 cancelled", isError: false }, ctx);
	pi.events.get("turn_end")({ message: { role: "assistant", stopReason: "stop" } }, ctx);
	const inspected = await pi.tools.get("review_workbench_trace").execute("id", {});
	assert.match(inspected.content[0].text, /✔ turn 1/);

	pi.events.get("turn_start")({}, ctx);
	pi.events.get("tool_execution_start")({ toolCallId: "failure", toolName: "bash", args: {} }, ctx);
	pi.events.get("tool_execution_end")({ toolCallId: "failure", result: "FAIL: AbortController cancellation regression", isError: true }, ctx);
	pi.events.get("turn_end")({ message: { role: "assistant", stopReason: "error" } }, ctx);
	const failed = await pi.tools.get("review_workbench_trace").execute("id", {});
	assert.match(failed.content[0].text, /✘ turn 2/);
});

// ---------------------------------------------------------------- extension

test("the extension registers keyboard-only surfaces and real tools", async () => {
	const pi = fakeHost();
	const review = createReviewExtension(pi, { org: "projectbluefin", fetchImpl: fakeFetch([]), env: ISOLATED_ENV });

	assert.deepEqual(pi.labels, ["Hive Workbench"]);
	assert.deepEqual([...pi.shortcuts.keys()].sort(), ["alt+b", "alt+s", "alt+u"]);
	assert.deepEqual([...pi.flags.keys()].sort(), ["all", "autoslay", "issues", "pr", "repo", "skip-repo"]);
	assert.deepEqual([...pi.tools.keys()].sort(), [
		"hive_workbench_diff",
		"hive_workbench_lookup",
		"hive_workbench_queue",
		"hive_workbench_status",
		"hive_workbench_trace",
	]);
	const completeReview = pi.commands.get("review").getArgumentCompletions;
	assert.ok(completeReview);
	assert.deepEqual(completeReview("re")?.map((item) => item.value), ["recap", "reconcile", "recover", "resume", "revise", "re-slay"]);
	assert.equal(completeReview("   ")?.length, 13, "empty argument completion offers supported Review subcommands");
	assert.ok(completeReview("d")?.some((item) => item.value === "details"), "diagnostic inspection is discoverable from /review completion");
	// Reserved chords would be silently dropped by omp.
	for (const chord of pi.shortcuts.keys()) assert.match(chord, /^alt\+[a-z]$/);

	const ctx = fakeCtx();
	ctx.ui.parent = ctx;
	await pi.events.get("session_start")({}, ctx);
	await review.whenStarted();
	assert.ok(completeReview("policy pro")?.some((item) => item.value === "policy projectbluefin/review"));
	assert.deepEqual(completeReview("policy example/widgets")?.map((item) => item.value), ["policy example/widgets solo", "policy example/widgets team"]);
	assert.deepEqual(completeReview("policy projectbluefin/review s")?.map((item) => item.value), ["policy projectbluefin/review solo"]);
	assert.ok(ctx.statuses.get("hive_workbench")?.includes("#42"), ctx.statuses.get("hive_workbench"));
	assert.equal(typeof ctx.widgets.get("hive-workbench-rail"), "function", "the rail is a component, not capped strings");
	const diff = await pi.tools.get("hive_workbench_diff").execute("id", { pull_request: 42 });
	assert.match(diff.content[0].text, /image\/entrypoint\.sh/);
	assert.equal(diff.details.pull_request, 42);
	assert.equal(diff.details.repo, "projectbluefin/review");
	const bad = await pi.tools.get("hive_workbench_diff").execute("id", { pull_request: 0 });
	assert.equal(bad.isError, true);

	const status = await pi.tools.get("hive_workbench_status").execute("id", {});
	assert.match(status.content[0].text, /selected projectbluefin\/review#42/);
	assert.match(status.content[0].text, /order: LOCAL · attention order — no hive hub configured/);
	assert.match(status.content[0].text, /priority: fix-ci/);
	assert.equal(status.details.order_source, "local");
	assert.equal(status.details.hive.configured, false);
	assert.equal(status.details.scope.value, "projectbluefin");

	const queue = await pi.tools.get("hive_workbench_queue").execute("id", {});
	assert.match(queue.content[0].text, /^\[fix-ci\] projectbluefin\/review#42/m);
	assert.equal(queue.details.order_source, "local");

	pi.events.get("tool_execution_start")({ toolCallId: "x", toolName: "grep", args: { pattern: "HIVE_HUB" } }, ctx);
	const live = await pi.tools.get("hive_workbench_status").execute("id", {});
	assert.equal(live.details.selected.id, 42);
	const lookup = await pi.tools.get("hive_workbench_lookup").execute("id", {});
	assert.match(lookup.content[0].text, /Hive read-side integration is not configured/);
	assert.equal(ctx.overlays.length, 1, "startup opens exactly one workbench");
	await pi.shortcuts.get("alt+b").handler(ctx);
	assert.equal(ctx.overlays.length, 1, "Alt+B does not stack an already-open workbench");
	assert.equal(pi.messages.length, 0, "opening the workbench never dispatches work");
	const workbench = ctx.overlays[0];
	workbench.handleInput("v");
	workbench.handleInput("o");
	await new Promise((resolve) => setImmediate(resolve));
	assert.deepEqual(pi.execCalls.at(-1), {
		command: "gh",
		args: ["pr", "view", "42", "--repo", "projectbluefin/review", "--web"],
	});
	assert.match(ctx.notifications.at(-1)?.message ?? "", /Opened https:\/\/github\.com\/projectbluefin\/review\/pull\/42/);
	workbench.handleInput("q");
	workbench.handleInput("j");
	workbench.handleInput("s");
	await new Promise((resolve) => setImmediate(resolve));
	assert.equal(pi.messages.length, 1, "slay dispatches without requiring Hive ranking");
	assert.match(pi.messages[0], /reviewer/);
	assert.ok(!ctx.notifications.some((notification) => /browse-only mode disables dispatch/.test(notification.message)));
	workbench.handleInput("i");
	await new Promise((resolve) => setImmediate(resolve));
	assert.match(ctx.pasted.at(-1) ?? "", /projectbluefin\/other#7/);
	assert.match(status.content[0].text, /review, fix, and slay remain available/, "a missing Hive must not read as browse-only: authorized actions remain available");
});

test("Review blocks PR mutation admission when the effective OMP task schema omits structured fields", async () => {
	const pi = fakeHost();
	pi.toolInfo[0].parameters = nativeTaskParameters(false);
	const ctx = fakeCtx();
	ctx.ui.parent = ctx;
	const review = createReviewExtension(pi, { org: "projectbluefin", fetchImpl: hiveBackedFetch([
		queueItem({ ciStatus: "success" }),
		queueItem({ id: 7, repo: "projectbluefin/other", ciStatus: "success" }),
	]), env: ISOLATED_ENV });
	await pi.events.get("session_start")({}, ctx);
	await review.whenStarted();
	await pi.commands.get("review").handler("slay", ctx);
	assert.equal(pi.messages.length, 0);
	assert.match(savedReviewNoticeText(pi), /Review couldn’t start this item/);
	assert.doesNotMatch(ctx.notifications.map((notice) => notice.message).join("\n"), /task\.structured|outputSchema|schemaMode/);
	assert.match(ctx.overlays[0].render(80).join("\n"), /No new work was started for projectbluefin\/other#7/);
	const recoveryCard = ctx.overlays[0].render(80).join("\n");
	assert.match(recoveryCard, /turn on Structured/);
	assert.match(recoveryCard, /Task Results/);
	const narrowDashboard = ctx.overlays[0].render(80).join("\n");
	assert.match(narrowDashboard, /Review couldn’t start this item[\s\S]*No new work was started[\s\S]*1\.[\s\S]*Message box: \/review details/);
	const narrowRows = ctx.overlays[0].render(80);
	assert.ok(narrowRows.length <= ctx.overlays[0].rows, "the notice is included in the dashboard's actual row budget");
	const otherVisibleRow = narrowRows.findIndex((line) => /#42/.test(line));
	assert.ok(otherVisibleRow >= 0, "the focused PR stays visible below the notice");
	ctx.overlays[0].handleClick(4, otherVisibleRow);
	assert.equal(ctx.overlays[0].mode.selected()?.id, 42, "mouse row mapping accounts for the same notice rows as render");
	ctx.overlays[0].handleInput("k");
	assert.equal(ctx.overlays[0].mode.selected()?.id, 7, "retry returns to the PR named in the setup notice");
	const details = await runReviewCommand(pi, ctx, "details");
	assert.match(details, /Review details · read only[\s\S]*q\/Esc close/);
	assert.match(details, /Diagnostic \(read only\):/);
	assert.match(details, /outputSchema and schemaMode/);
	assert.match(details, /No new work was started for projectbluefin\/other#7/);
	assert.ok(pi.entries.some((entry) => entry.customType === NOTICE_ENTRY && entry.data?.details?.includes("outputSchema")), "bounded diagnostics are saved to the session journal");
	assert.equal(pi.entries.filter((entry) => entry.customType === BATCH_ENTRY).length, 0, "failed capability preflight creates no admitted wave");

	pi.toolInfo[0].parameters = nativeTaskParameters(true);
	ctx.overlays[0].handleInput("s");
	await new Promise((resolve) => setImmediate(resolve));
	assert.equal(pi.messages.length, 1, `the same selected PR is admitted after effective structured output becomes available: ${savedReviewNoticeText(pi)}`);
	assert.doesNotMatch(ctx.overlays[0].render(80).join("\n"), /Review couldn’t start this item/, "the obsolete setup card clears after successful admission");
	for (const width of [80, 100]) {
		const resolvedDetails = await runReviewCommand(pi, ctx, "details", width);
		assert.match(resolvedDetails, /Resolved: Review admitted the same pull request/);
		assert.match(resolvedDetails, /Saved diagnostic from the earlier attempt \(read only\):/);
		assert.match(resolvedDetails, /outputSchema and schemaMode/, "resolving the card keeps its diagnostic history");
		assert.doesNotMatch(resolvedDetails, /Next steps:|No new work was started|press s to retry/, "resolved Details must not present old recovery instructions as current work");
	}
	const savedResolution = pi.entries.filter((entry) => entry.customType === NOTICE_ENTRY && entry.data?.resolution).at(-1).data;
	assert.match(savedResolution.outcome, /No new work was started/);
	assert.ok(savedResolution.steps.length >= 4, "the complete historical notice remains in the session journal");
});

test("structured reviewer capability reads OMP ArkType batch schemas through its wire conversion", () => {
	let conversionOptions;
	const nativeParameters = Object.assign(() => undefined, {
		toJsonSchema: (options) => {
			conversionOptions = options;
			return { type: "object", properties: { tasks: { type: "array", items: { type: "object", properties: { outputSchema: { type: "object" }, schemaMode: { type: "string" } } } } } };
		},
	});
	assert.equal(taskSchemaSupportsStructuredOutput(nativeParameters), true);
	assert.equal(conversionOptions.target, "draft-2020-12");
	assert.equal(typeof conversionOptions.fallback, "function");
});

test("Review Slay records all-CI-skipped selections as no-work, not completed work", async () => {
	const pi = fakeHost();
	const ctx = fakeCtx();
	ctx.ui.parent = ctx;
	const item = { ...queueItem(), headSha: "e".repeat(40), ciStatus: "failure" };
	const review = createReviewExtension(pi, { org: "projectbluefin", fetchImpl: hiveBackedFetch([item]), env: { ...ISOLATED_ENV, REVIEW_MODE: "review" } });
	await pi.events.get("session_start")({}, ctx);
	await review.whenStarted();
	await pi.commands.get("review").handler("slay", ctx);
	assert.match(savedReviewNoticeText(pi), /No work admitted/);
	assert.equal(pi.messages.length, 0);
	const batch = pi.entries.filter((entry) => entry.customType === BATCH_ENTRY).at(-1).data;
	assert.equal(batch.state, "blocked");
	assert.equal(batch.completedItems, 0);
	assert.equal(batch.waves.length, 0);
	assert.equal(batch.skippedItems[0].number, item.id);
	assert.match(batch.error, /no work was completed/i);
	assert.match(savedReviewNoticeText(pi), /No work was started/);
	assert.match(await runReviewCommand(pi, ctx, "details"), /No work admitted[\s\S]*no work was completed/i);
	const reconciliation = await runReviewCommand(pi, ctx, "reconcile");
	assert.match(reconciliation, /no work was admitted or completed/);
	assert.equal(pi.messages.length, 0, "no-work reconciliation never dispatches or retries a worker");
});

test("Review Slay reports an empty eligible selection without claiming admission", async () => {
	const pi = fakeHost();
	const ctx = fakeCtx();
	const env = { ...ISOLATED_ENV, REVIEW_MODE: "review", REVIEW_SKIP_REPOS: "projectbluefin/review,projectbluefin/other" };
	const review = createReviewExtension(pi, { org: "projectbluefin", fetchImpl: fakeFetch([]), env });
	await pi.events.get("session_start")({}, ctx);
	await review.whenStarted();
	await pi.commands.get("review").handler("slay", ctx);
	assert.match(savedReviewNoticeText(pi), /No items are ready to review/);
	assert.doesNotMatch(savedReviewNoticeText(pi), /admitted|complete/i);
	assert.equal(pi.messages.length, 0);
	assert.equal(pi.entries.filter((entry) => entry.customType === BATCH_ENTRY).length, 0);
});

test("session transitions clear old trace state and reject late events", async () => {
	const pi = fakeHost();
	const review = createReviewExtension(pi, { org: "projectbluefin", fetchImpl: fakeFetch([]), env: ISOLATED_ENV });
	const first = fakeCtx();
	await pi.events.get("session_start")({}, first);
	await review.whenStarted();
	pi.events.get("turn_start")({}, first);
	pi.events.get("tool_execution_start")({ toolCallId: "old", toolName: "bash", args: {} }, first);

	const next = fakeCtx();
	next.sessionId = "session-2";
	pi.events.get("session_switch")({}, next);
	pi.events.get("tool_execution_end")({ toolCallId: "old", result: "late failure", isError: true }, first);
	const empty = await pi.tools.get("hive_workbench_trace").execute("id", {});
	assert.equal(empty.details.has_state, false);

	pi.events.get("turn_start")({}, next);
	pi.events.get("tool_execution_start")({ toolCallId: "new", toolName: "bash", args: {} }, next);
	pi.events.get("tool_execution_end")({ toolCallId: "new", toolName: "bash", result: "new result", isError: false }, next);
	pi.events.get("turn_end")({ message: { role: "assistant", stopReason: "stop" } }, next);
	const current = await pi.tools.get("hive_workbench_trace").execute("id", {});
	assert.equal(current.details.has_state, true);
	assert.match(current.content[0].text, /turn 1/);
	assert.doesNotMatch(current.content[0].text, /late failure/);
});

test("dashboard reports unexpected custom-UI rejection and Alt+B can reopen it", async () => {
	const pi = fakeHost();
	const ctx = fakeCtx();
	const custom = ctx.ui.custom.bind(ctx.ui);
	let rejectOnce = true;
	ctx.ui.custom = (...args) => {
		if (rejectOnce) {
			rejectOnce = false;
			return Promise.reject(new Error(`dashboard renderer failed ${"x".repeat(280)}`));
		}
		return custom(...args);
	};
	const review = createReviewExtension(pi, { org: "projectbluefin", fetchImpl: fakeFetch([]), env: ISOLATED_ENV });
	await pi.events.get("session_start")({}, ctx);
	await review.whenStarted();
	await new Promise((resolve) => setImmediate(resolve));
	assert.match(savedReviewNoticeText(pi), /Review couldn’t confirm what finished/);
	assert.doesNotMatch(ctx.notifications.at(-1)?.message ?? "", /dashboard renderer failed/);
	await pi.shortcuts.get("alt+b").handler(ctx);
	assert.equal(ctx.overlays.length, 1, "a rejected dashboard releases ownership so Alt+B can reopen it");
	const dashboardNotice = ctx.overlays[0].render(100).join("\n");
	assert.match(dashboardNotice, /Review couldn’t confirm what finished/, "the latest unresolved failure remains visible as a compact summary");
	assert.match(dashboardNotice, /Don’t retry the selected item yet/);
	assert.doesNotMatch(dashboardNotice, /dashboard renderer failed/, "long diagnostic details stay in the transcript instead of repeating in the banner");
	assert.match(dashboardNotice, /1\. Run \/review details to inspect the error[\s\S]*2\. Check the current Review status before retrying/);
	assert.equal(ctx.notifications.filter(({ message }) => /dashboard renderer failed/.test(message)).length, 0, "technical diagnostics stay out of the transcript");
	const nativeNoticeFactory = ctx.widgets.get("review-native-notice");
	assert.equal(typeof nativeNoticeFactory, "function", "the persistent failure also registers a passive native widget");
	const nativeNotice = nativeNoticeFactory();
	assert.deepEqual(nativeNotice.describe({ supports: (kind) => kind === "toast" }), {
		k: "toast", p: { text: "Review couldn’t confirm what finished", sub: "Next: Inspect the error before retrying.", ttl: 2400 },
	});
	const status = await runReviewCommand(pi, ctx, "status");
	assert.match(status, /Review status · read only[\s\S]*q\/Esc close/);
	assert.match(status, /Notice dismissed; the issue remains unresolved[\s\S]*Next steps:[\s\S]*Run \/review details/);
	assert.doesNotMatch(ctx.overlays[0].render(100).join("\n"), /Review couldn’t confirm what finished/, "reading status acknowledges and clears the persistent notice");
	assert.equal(ctx.widgets.get("review-native-notice"), undefined, "status acknowledgement removes the native widget too");
	const details = await runReviewCommand(pi, ctx, "details");
	assert.match(details, /Review details · read only[\s\S]*dashboard renderer failed/);
	assert.match(details, /dashboard renderer failed/, "the diagnostic remains available after acknowledgement");
	const next = fakeCtx();
	next.sessionId = "session-2";
	pi.events.get("session_switch")({}, next);
	assert.doesNotMatch(ctx.overlays[0].render(100).join("\n"), /dashboard renderer failed/, "session changes clear prior-session notices");
	ctx.overlays[0].handleInput("q");
});

test("/review details recovers older saved notices without numbered steps", async () => {
	const unregisterFactory = registerFactoryController(async () => "stub");
	const pi = fakeHost();
	const ctx = fakeCtx();
	ctx.sessionManager = {
		getSessionId: () => ctx.sessionId,
		getBranch: () => [{
			type: "custom",
			customType: NOTICE_ENTRY,
			data: {
				id: "older-notice", sessionId: ctx.sessionId, level: "error",
				title: "Review couldn’t finish this step", outcome: "The result is unclear.",
				action: "Run /review status before retrying.", details: "saved diagnostic",
			},
		}],
	};
	const review = createReviewExtension(pi, { org: "projectbluefin", fetchImpl: fakeFetch([]), env: ISOLATED_ENV });
	try {
		await pi.events.get("session_start")({}, ctx);
		await review.whenStarted();
		const details = await runReviewCommand(pi, ctx, "details");
		assert.match(details, /Next steps:\n1\. Run \/review status before retrying\./);
		assert.match(details, /saved diagnostic/);
	} finally {
		unregisterFactory();
	}
});

test("dashboard treats an AbortError as cancellation and remains reopenable", async () => {
	const pi = fakeHost();
	const ctx = fakeCtx();
	const custom = ctx.ui.custom.bind(ctx.ui);
	let rejectOnce = true;
	ctx.ui.custom = (...args) => {
		if (rejectOnce) {
			rejectOnce = false;
			return Promise.reject(new DOMException("cancelled", "AbortError"));
		}
		return custom(...args);
	};
	const review = createReviewExtension(pi, { org: "projectbluefin", fetchImpl: fakeFetch([]), env: ISOLATED_ENV });
	await pi.events.get("session_start")({}, ctx);
	await review.whenStarted();
	await new Promise((resolve) => setImmediate(resolve));
	assert.ok(!ctx.notifications.some(({ message }) => /AbortError|cancelled/.test(message)));
	await pi.shortcuts.get("alt+b").handler(ctx);
	assert.equal(ctx.overlays.length, 1);
	ctx.overlays[0].handleInput("q");
});

test("dashboard browser launch exceptions preserve the draft and expose the full link through Details", async () => {
	const pi = fakeHost();
	pi.exec = async () => { throw new Error("browser launch failed"); };
	const ctx = fakeCtx();
	ctx.ui.parent = ctx;
	const review = createReviewExtension(pi, { org: "projectbluefin", fetchImpl: fakeFetch([]), env: ISOLATED_ENV });
	await pi.events.get("session_start")({}, ctx);
	await review.whenStarted();
	ctx.overlays[0].handleInput("v");
	ctx.overlays[0].handleInput("o");
	await new Promise((resolve) => setImmediate(resolve));
	assert.equal(ctx.pasted.length, 0, "browser failure does not change an existing editor draft");
	const browserCard = ctx.overlays[0].render(100).join("\n");
	assert.match(browserCard, /Couldn’t open the pull request in your browser/);
	assert.match(browserCard, /Your draft was left unchanged/);
	assert.match(browserCard, /https:\/\/github\.com\/projectbluefin\/review\/pull\/42/);
	assert.match(browserCard, /Open this link in your browser/);
	assert.match(browserCard, /press o to try again/);
	assert.doesNotMatch(ctx.notifications.at(-1)?.message ?? "", /browser launch failed/);
	const details = await runReviewCommand(pi, ctx, "details");
	assert.match(details, /https:\/\/github\.com\/projectbluefin\/review\/pull\/42/);
	assert.match(details, /browser launch failed/);
});

test("dashboard browser failure names an issue accurately", async () => {
	const pi = fakeHost();
	pi.flagValues.set("issues", true);
	pi.exec = async () => { throw new Error("browser launch failed"); };
	const ctx = fakeCtx();
	ctx.ui.parent = ctx;
	const review = createReviewExtension(pi, {
		org: "projectbluefin",
		fetchImpl: issueBackedFetch({ "projectbluefin/review#43": { title: "review issue", submittedPrs: [] } }),
		env: ISOLATED_ENV,
	});
	await pi.events.get("session_start")({}, ctx);
	await review.whenStarted();
	ctx.overlays[0].handleInput("v");
	ctx.overlays[0].handleInput("o");
	await new Promise((resolve) => setImmediate(resolve));
	const issueRows = ctx.overlays[0].render(80);
	const browserCard = issueRows.join("\n");
	assert.match(browserCard, /Couldn’t open the issue in your browser/);
	assert.match(browserCard, /https:\/\/github\.com\/projectbluefin\/review\/issues\/43/);
	assert.match(browserCard, /Open this link in your browser/);
	assert.ok(issueRows.length <= ctx.overlays[0].rows, "the warning card and focused issue fit the narrow dashboard");
	const queueIndex = issueRows.findIndex((line) => /QUEUE/.test(line));
	const traceIndex = issueRows.findIndex((line) => /TRACE/.test(line));
	const visibleQueue = issueRows.slice(queueIndex + 1, traceIndex > queueIndex ? traceIndex : issueRows.length);
	assert.ok(visibleQueue.some((line) => /#43/.test(line)), "the issue stays visible under its browser recovery card");
	assert.doesNotMatch(savedReviewNoticeText(pi), /Couldn’t open the pull request/);
	assert.equal(ctx.pasted.length, 0, "issue browser failure does not alter draft text");
	const details = await runReviewCommand(pi, ctx, "details");
	assert.match(details, /https:\/\/github\.com\/projectbluefin\/review\/issues\/43/);
	assert.match(details, /browser launch failed/);
});

test("dashboard releases its open slot before a closed dialog finishes its action", async () => {
	const pi = fakeHost();
	const ctx = fakeCtx();
	let finishInput;
	ctx.ui.input = () => new Promise((resolve) => { finishInput = resolve; });
	const review = createReviewExtension(pi, { org: "projectbluefin", fetchImpl: fakeFetch([]), env: ISOLATED_ENV });
	await pi.events.get("session_start")({}, ctx);
	await review.whenStarted();
	ctx.overlays[0].handleInput("o");
	await new Promise((resolve) => setImmediate(resolve));
	assert.equal(typeof finishInput, "function", "the first dashboard has closed and its scope action is waiting for operator input");
	await pi.shortcuts.get("alt+b").handler(ctx);
	assert.equal(ctx.overlays.length, 2, "Alt+B can open a new dashboard while the previous action finishes");
	finishInput(undefined);
	ctx.overlays[1].handleInput("q");
});

test("--autoslay repairs returned pull requests before implementing issue waves", async () => {
	let repairHead = "a".repeat(40);
	let issueHasPullRequest = false;
	const repairNode = () => ({
		number: 41,
		title: "address requested changes",
		url: "https://github.com/projectbluefin/review/pull/41",
		updatedAt: new Date(NOW).toISOString(),
		isDraft: false,
		mergeable: "MERGEABLE",
		reviewDecision: "CHANGES_REQUESTED",
		headRefOid: repairHead,
		changedFiles: 1,
		files: { pageInfo: { hasNextPage: false }, nodes: [{ path: ".github/workflows/validate.yml" }] },
		author: { login: "jorge" },
		repository: { nameWithOwner: "projectbluefin/review" },
		labels: { nodes: [] },
		commits: { nodes: [{ commit: { statusCheckRollup: { state: "FAILURE" } } }] },
	});
	const issueNode = () => ({
		number: 77,
		title: "repair existing behavior",
		url: "https://github.com/projectbluefin/review/issues/77",
		updatedAt: new Date(NOW - 1000).toISOString(),
		author: { login: "maintainer" },
		repository: { nameWithOwner: "projectbluefin/review" },
		labels: { nodes: [] },
		closedByPullRequestsReferences: { nodes: issueHasPullRequest
			? [{ number: 88, state: "OPEN", merged: false, repository: { nameWithOwner: "projectbluefin/review" } }]
			: [] },
	});
	const fetchImpl = async (url, init) => {
		const target = String(url);
		if (target === "https://api.github.com/") {
			return { ok: true, status: 200, statusText: "OK", headers: { get: () => "workflow" }, json: async () => ({}) };
		}
		if (target.includes("/repos/")) {
			return { ok: true, status: 200, statusText: "OK", json: async () => ({ permissions: { push: true } }) };
		}
		if (!target.includes("/graphql")) {
			return { ok: true, status: 200, statusText: "OK", json: async () => [] };
		}
		const body = JSON.parse(String(init?.body ?? "{}"));
		if (body.variables?.search !== undefined) {
			const nodes = body.variables.search.includes("is:pr") ? [repairNode()] : [issueNode()];
			return {
				ok: true,
				status: 200,
				statusText: "OK",
				json: async () => ({ data: { viewer: { login: "jorge" }, search: { pageInfo: { hasNextPage: false }, nodes } } }),
			};
		}
		const node = body.query.includes("... on PullRequest") ? repairNode() : issueNode();
		return {
			ok: true,
			status: 200,
			statusText: "OK",
			json: async () => ({ data: { w0: { issueOrPullRequest: { ...node, closed: false } } } }),
		};
	};
	const pi = fakeHost();
	pi.flagValues.set("autoslay", true);
	const review = createReviewExtension(pi, { org: "projectbluefin", fetchImpl, env: ISOLATED_ENV });
	const ctx = fakeCtx();
	ctx.ui.parent = ctx;

	await pi.events.get("session_start")({}, ctx);
	await review.whenStarted();
	await new Promise((resolve) => setImmediate(resolve));
	assert.equal(pi.messages.length, 1);
	assert.match(pi.messages[0], /Repair .*projectbluefin\/review#41/);
	assert.doesNotMatch(pi.messages[0], /projectbluefin\/review#77/);

	repairHead = "b".repeat(40);
	ctx.asyncJobs.recent = [{ id: "repair", status: "completed", startTime: Date.now() + 1 }];
	observeTask(pi, ctx, "repair");
	await pi.events.get("agent_end")({}, ctx);
	assert.equal(pi.messages.length, 2, JSON.stringify(pi.entries.filter((entry) => entry.customType === BATCH_ENTRY).at(-1)?.data));
	assert.match(pi.messages[1], /Implement projectbluefin\/review#77/);
	assert.match(pi.messages[1], /hive_workbench_lookup.*queue.*knowledge/);
	assert.match(pi.messages[1], /workflowz/);
	assert.match(pi.messages[1], /Closes <owner\/repo>#<number>/);


	issueHasPullRequest = true;
	ctx.asyncJobs.recent = [{ id: "issue", status: "completed", startTime: Date.now() + 1 }];
	observeTask(pi, ctx, "issue");
	await pi.events.get("agent_end")({}, ctx);
	const batch = pi.entries.filter((entry) => entry.customType === BATCH_ENTRY).at(-1).data;
	assert.equal(batch.state, "complete");
	assert.equal(batch.completedItems, 2);
});
test("host Alt-S uses issue autoslay and blocks without a submitted pull request", async () => {
	const node = {
		number: 77,
		title: "repair existing behavior",
		url: "https://github.com/projectbluefin/review/issues/77",
		updatedAt: new Date(NOW).toISOString(),
		author: { login: "maintainer" },
		repository: { nameWithOwner: "projectbluefin/review" },
		labels: { nodes: [] },
		closedByPullRequestsReferences: { nodes: [] },
	};
	const fetchImpl = async (_url, init) => {
		const body = JSON.parse(String(init?.body ?? "{}"));
		const data = body.variables?.search !== undefined
			? { viewer: { login: "jorge" }, search: { pageInfo: { hasNextPage: false }, nodes: [node] } }
			: { w0: { issueOrPullRequest: { ...node, closed: false } } };
		return { ok: true, status: 200, statusText: "OK", json: async () => ({ data }) };
	};
	const pi = fakeHost();
	pi.flagValues.set("issues", true);
	const review = createReviewExtension(pi, { org: "projectbluefin", fetchImpl, env: ISOLATED_ENV });
	const ctx = fakeCtx();
	ctx.ui.parent = ctx;

	await pi.events.get("session_start")({}, ctx);
	await review.whenStarted();
	pi.shortcuts.get("alt+s").handler(ctx);
	await new Promise((resolve) => setImmediate(resolve));
	assert.match(pi.messages[0], /Implement projectbluefin\/review#77/);
	ctx.asyncJobs.recent = [{ id: "issue", status: "completed", startTime: Date.now() + 1 }];
	observeTask(pi, ctx, "issue");
	await pi.events.get("agent_end")({}, ctx);
	const batch = pi.entries.filter((entry) => entry.customType === BATCH_ENTRY).at(-1).data;
	assert.equal(batch.state, "blocked");
	assert.match(batch.error, /no pull request was submitted/);
});


test("ordinary PR slay blocks failed CI before reviewer dispatch", async () => {
	const item = {
		id: 42,
		repo: "projectbluefin/review",
		title: "zero-job workflow failure",
		headSha: "4".repeat(40),
		ciStatus: "failure",
		changedFiles: 1,
	};
	const pi = fakeHost();
	const review = createReviewExtension(pi, { org: "projectbluefin", fetchImpl: hiveBackedFetch([item]), env: ISOLATED_ENV });
	const ctx = fakeCtx();
	ctx.ui.parent = ctx;

	await pi.events.get("session_start")({}, ctx);
	await review.whenStarted();
	ctx.overlays[0].handleInput("s");
	await new Promise((resolve) => setImmediate(resolve));
	assert.equal(pi.messages.length, 0);
	assert.match(savedReviewNoticeText(pi), /No work was started/);
	assert.match(await runReviewCommand(pi, ctx, "details"), /#42: failure checks/);
});

test("slay skips known red and pending ordinary PRs without blocking eligible waves or repairs", async () => {
	const items = [
		{ id: 41, repo: "projectbluefin/review", title: "red ordinary PR", headSha: "1".repeat(40), ciStatus: "failure" },
		{ id: 42, repo: "projectbluefin/review", title: "red requested-changes repair", headSha: "2".repeat(40), ciStatus: "failure" },
		{ id: 43, repo: "projectbluefin/review", title: "eligible same-repo PR", headSha: "3".repeat(40), ciStatus: "success" },
		{ id: 44, repo: "projectbluefin/other", title: "pending ordinary PR", headSha: "4".repeat(40), ciStatus: "pending" },
		{ id: 45, repo: "projectbluefin/other", title: "eligible later-repo PR", headSha: "5".repeat(40), ciStatus: "success" },
	];
	const baseFetch = hiveBackedFetch(items);
	const fetchImpl = async (url, init) => {
		const response = await baseFetch(url, init);
		if (!String(url).includes("/graphql")) return response;
		const result = await response.json();
		const annotate = (node) => {
			if (node?.number === 42) return { ...node, reviewDecision: "CHANGES_REQUESTED", author: { login: "reviewer" } };
			if (node?.number === 44) return {
				...node,
				commits: { nodes: [{ commit: {
					statusCheckRollup: null,
					checkSuites: { pageInfo: { hasNextPage: false }, nodes: [{ status: "IN_PROGRESS", conclusion: null }] },
				} }] },
			};
			return node;
		};
		const data = { ...result.data, viewer: { login: "reviewer" } };
		if (data.search) {
			data.search = { ...data.search, nodes: data.search.nodes.map(annotate) };
		} else {
			for (const [key, value] of Object.entries(data)) {
				if (value?.issueOrPullRequest) data[key] = { ...value, issueOrPullRequest: annotate(value.issueOrPullRequest) };
			}
		}
		return { ...response, json: async () => ({ ...result, data }) };
	};
	const pi = fakeHost();
	const review = createReviewExtension(pi, { org: "projectbluefin", fetchImpl, env: ISOLATED_ENV });
	const ctx = fakeCtx();
	ctx.ui.parent = ctx;

	await pi.events.get("session_start")({}, ctx);
	await review.whenStarted();
	ctx.overlays[0].handleInput("A");
	ctx.overlays[0].handleInput("s");
	await new Promise((resolve) => setImmediate(resolve));

	assert.equal(pi.messages.length, 1, "the repair remains the first runnable wave");
	assert.match(pi.messages[0], /#42/);
	assert.doesNotMatch(pi.messages[0], /#41|#43|#44|#45/);
	const batch = pi.entries.filter((entry) => entry.customType === BATCH_ENTRY).at(-1).data;
	assert.equal(batch.state, "running");
	assert.equal(batch.totalItems, 5, JSON.stringify(batch));
	assert.deepEqual(batch.waves.map((wave) => wave.items.map((item) => item.id)), [[42], [43], [45]]);
	assert.deepEqual(batch.skippedItems.map(({ number, headSha, ciStatus, ciEvidenceSource }) => ({ number, headSha, ciStatus, ciEvidenceSource })), [
		{ number: 41, headSha: "1".repeat(40), ciStatus: "failure", ciEvidenceSource: "statusCheckRollup" },
		{ number: 44, headSha: "4".repeat(40), ciStatus: "pending", ciEvidenceSource: "checkSuites" },
	]);
	assert.ok(batch.skippedItems.every((item) => Number.isFinite(item.observedAt)));
	assert.match(savedReviewNoticeText(pi), /2 selected items were left out/);
	const details = await runReviewCommand(pi, ctx, "details");
	assert.match(details, /#41: failure checks \(statusCheckRollup\)/);
	assert.match(details, /#44: pending checks \(checkSuites\)/);
	const status = await runReviewCommand(pi, ctx, "status");
	assert.match(status, /Review status · read only[\s\S]*Active slay run /);
	assert.match(status, /Claim repo:projectbluefin\/review:[\s\S]*held by[\s\S]*review:/);
});

test("slay blocks an auto-merge state without a recorded exact-head landing attempt", async () => {
	let firstAutoMerge = false;
	let laterCi = "success";
	const items = [
		{ id: 61, repo: "projectbluefin/review", title: "first eligible PR", headSha: "a".repeat(40), ciStatus: "success" },
		{ id: 62, repo: "projectbluefin/other", title: "later ordinary PR", headSha: "c".repeat(40), ciStatus: laterCi },
	];
	const baseFetch = hiveBackedFetch(items);
	const fetchImpl = async (url, init) => {
		const response = await baseFetch(url, init);
		if (!String(url).includes("/graphql")) return response;
		const result = await response.json();
		const updateQueueItem = (node) => {
			if (node?.number === 61) return {
				...node,
				autoMergeRequest: firstAutoMerge ? { enabledAt: new Date(NOW).toISOString() } : null,
			};
			if (node?.number === 62) return {
				...node,
				commits: { nodes: [{ commit: { statusCheckRollup: { state: laterCi.toUpperCase() } } }] },
			};
			return node;
		};
		const data = { ...result.data, viewer: { login: "reviewer" } };
		if (data.search) {
			data.search = { ...data.search, nodes: data.search.nodes.map(updateQueueItem) };
		} else {
			for (const [key, value] of Object.entries(data)) {
				if (value?.issueOrPullRequest) data[key] = { ...value, issueOrPullRequest: updateQueueItem(value.issueOrPullRequest) };
			}
		}
		return { ...response, json: async () => ({ ...result, data }) };
	};
	const pi = fakeHost();
	const review = createReviewExtension(pi, { org: "projectbluefin", fetchImpl, env: ISOLATED_ENV });
	const ctx = fakeCtx();
	ctx.ui.parent = ctx;

	await pi.events.get("session_start")({}, ctx);
	await review.whenStarted();
	ctx.overlays[0].handleInput("A");
	ctx.overlays[0].handleInput("s");
	await new Promise((resolve) => setImmediate(resolve));
	assert.equal(pi.messages.length, 1);
	assert.match(pi.messages[0], /#61/);

	firstAutoMerge = true;
	laterCi = "pending";
	await completeReviewTask(pi, ctx);
	await pi.events.get("agent_end")({}, ctx);

	assert.equal(pi.messages.length, 1, "a newly pending later wave is skipped before any dispatch");
	const batch = pi.entries.filter((entry) => entry.customType === BATCH_ENTRY).at(-1).data;
	assert.equal(batch.state, "blocked", JSON.stringify(batch));
	assert.equal(batch.currentWave, 0);
	assert.equal(batch.completedItems, 0);
	assert.equal(batch.totalItems, 2);
	assert.deepEqual(batch.skippedItems, [], "a later pending wave is not read past an unverified landing effect");
	assert.match(await runReviewCommand(pi, ctx, "details"), /unverified|reconcile/i);
});

test("all known red and pending selections persist a terminal skipped-only batch", async () => {
	const items = [
		{ id: 63, repo: "projectbluefin/review", title: "red PR", headSha: "d".repeat(40), ciStatus: "failure" },
		{ id: 64, repo: "projectbluefin/review", title: "pending PR", headSha: "e".repeat(40), ciStatus: "pending" },
	];
	const baseFetch = hiveBackedFetch(items);
	const fetchImpl = async (url, init) => {
		const response = await baseFetch(url, init);
		if (!String(url).includes("/graphql")) return response;
		const result = await response.json();
		const suitesOnlyPending = (node) => node?.number === 64
			? { ...node, commits: { nodes: [{ commit: {
				statusCheckRollup: null,
				checkSuites: { pageInfo: { hasNextPage: false }, nodes: [{ status: "IN_PROGRESS", conclusion: null }] },
			} }] } }
			: node;
		const data = { ...result.data };
		if (data.search) data.search = { ...data.search, nodes: data.search.nodes.map(suitesOnlyPending) };
		else {
			for (const [key, value] of Object.entries(data)) {
				if (value?.issueOrPullRequest) data[key] = { ...value, issueOrPullRequest: suitesOnlyPending(value.issueOrPullRequest) };
			}
		}
		return { ...response, json: async () => ({ ...result, data }) };
	};
	const pi = fakeHost();
	const review = createReviewExtension(pi, { org: "projectbluefin", fetchImpl, env: ISOLATED_ENV });
	const ctx = fakeCtx();
	ctx.ui.parent = ctx;

	await pi.events.get("session_start")({}, ctx);
	await review.whenStarted();
	ctx.overlays[0].handleInput("A");
	ctx.overlays[0].handleInput("s");
	await new Promise((resolve) => setImmediate(resolve));

	assert.equal(pi.messages.length, 0);
	const batch = pi.entries.filter((entry) => entry.customType === BATCH_ENTRY).at(-1).data;
	assert.equal(batch.state, "blocked", "a skipped-only selection is a no-work outcome, not completed work");
	assert.deepEqual(batch.waves, []);
	assert.equal(batch.completedItems, 0);
	assert.equal(batch.totalItems, 2);
	assert.match(batch.error, /No work admitted/);
	assert.deepEqual(batch.skippedItems.map(({ number, ciStatus, ciEvidenceSource }) => ({ number, ciStatus, ciEvidenceSource })), [
		{ number: 63, ciStatus: "failure", ciEvidenceSource: "statusCheckRollup" },
		{ number: 64, ciStatus: "pending", ciEvidenceSource: "checkSuites" },
	]);
});

test("slay keeps unknown CI as a hard blocker while prefiltering known red CI", async () => {
	const items = [
		{ id: 46, repo: "projectbluefin/review", title: "known red PR", headSha: "6".repeat(40), ciStatus: "failure" },
		{ id: 47, repo: "projectbluefin/review", title: "unknown CI PR", headSha: "7".repeat(40), ciStatus: "unknown" },
		{ id: 48, repo: "projectbluefin/review", title: "otherwise eligible PR", headSha: "8".repeat(40), ciStatus: "success" },
	];
	const baseFetch = hiveBackedFetch(items);
	const fetchImpl = async (url, init) => {
		const response = await baseFetch(url, init);
		if (!String(url).includes("/graphql")) return response;
		const result = await response.json();
		const makeUnknown = (node) => node?.number === 47
			? {
				...node,
				commits: { nodes: [{ commit: {
					statusCheckRollup: null,
					checkSuites: { pageInfo: { hasNextPage: true }, nodes: [] },
				} }] },
			}
			: node;
		const data = { ...result.data };
		if (data.search) {
			data.search = { ...data.search, nodes: data.search.nodes.map(makeUnknown) };
		} else {
			for (const [key, value] of Object.entries(data)) {
				if (value?.issueOrPullRequest) data[key] = { ...value, issueOrPullRequest: makeUnknown(value.issueOrPullRequest) };
			}
		}
		return { ...response, json: async () => ({ ...result, data }) };
	};
	const pi = fakeHost();
	const review = createReviewExtension(pi, { org: "projectbluefin", fetchImpl, env: ISOLATED_ENV });
	const ctx = fakeCtx();
	ctx.ui.parent = ctx;

	await pi.events.get("session_start")({}, ctx);
	await review.whenStarted();
	ctx.overlays[0].handleInput("A");
	ctx.overlays[0].handleInput("s");
	await new Promise((resolve) => setImmediate(resolve));

	assert.equal(pi.messages.length, 0);
	const batch = pi.entries.filter((entry) => entry.customType === BATCH_ENTRY).at(-1).data;
	assert.equal(batch.state, "blocked");
	assert.match(batch.error, /CI state is incomplete or unknown/);
});

test("slay does not CI-skip an item with an unresolved mutation claim", async () => {
	const items = [
		{ id: 49, repo: "projectbluefin/review", title: "claimed red PR", headSha: "9".repeat(40), ciStatus: "failure" },
		{ id: 50, repo: "projectbluefin/review", title: "eligible PR", headSha: "a".repeat(40), ciStatus: "success" },
	];
	const claims = new ResourceClaims(ISOLATED_ENV.LUNA_FACTORY_STATE_ROOT, ISOLATED_ENV.LUNA_FACTORY_CLAIMS_ROOT);
	claims.claim("item:projectbluefin/review#49", "review:other:0");
	const pi = fakeHost();
	const review = createReviewExtension(pi, { org: "projectbluefin", fetchImpl: hiveBackedFetch(items), env: ISOLATED_ENV });
	const ctx = fakeCtx();
	ctx.ui.parent = ctx;

	await pi.events.get("session_start")({}, ctx);
	await review.whenStarted();
	ctx.overlays[0].handleInput("A");
	ctx.overlays[0].handleInput("s");
	await new Promise((resolve) => setImmediate(resolve));

	assert.equal(pi.messages.length, 0);
	const batch = pi.entries.filter((entry) => entry.customType === BATCH_ENTRY).at(-1).data;
	assert.equal(batch.state, "blocked");
	assert.match(batch.error, /owned by review:other:0/);
	assert.equal(claims.list().length, 1, "the other owner's unresolved claim remains intact");
	assert.equal(ctx.notifications.some((notification) => /skipping .*#49/i.test(notification.message)), false);
});

test("slay skips red and pending PRs with incomplete fresh file evidence before unrelated work", async () => {
	const items = [
		{ id: 81, repo: "projectbluefin/red", title: "red PR with truncated live files", headSha: "8".repeat(40), ciStatus: "success" },
		{ id: 82, repo: "projectbluefin/pending", title: "pending PR with unavailable live files", headSha: "9".repeat(40), ciStatus: "success" },
		{ id: 83, repo: "projectbluefin/eligible", title: "eligible unrelated PR", headSha: "a".repeat(40), ciStatus: "success" },
	];
	const baseFetch = hiveBackedFetch(items);
	const liveReads = new Set<number>();
	const fetchImpl = async (url, init) => {
		const response = await baseFetch(url, init);
		if (!String(url).includes("/graphql")) return response;
		const result = await response.json();
		const body = JSON.parse(String(init?.body ?? "{}"));
		const search = body.variables?.search !== undefined;
		const annotate = (node) => {
			if (!node) return node;
			if (search) return { ...node, files: undefined };
			if (node.number === 83) return { ...node, files: { pageInfo: { hasNextPage: false }, nodes: [{ path: "README.md" }] } };
			if (node.number === 81 || node.number === 82) {
				liveReads.add(node.number);
				const commits = node.number === 81
					? { nodes: [{ commit: { statusCheckRollup: { state: "FAILURE" } } }] }
					: { nodes: [{ commit: {
						statusCheckRollup: null,
						checkSuites: { pageInfo: { hasNextPage: false }, nodes: [{ status: "IN_PROGRESS", conclusion: null }] },
					} }] };
				const files = { pageInfo: { hasNextPage: true }, nodes: [{ path: "README.md" }] };
				return { ...node, commits, files };
			}
			return node;
		};
		const data = { ...result.data };
		if (data.search) {
			data.search = { ...data.search, nodes: data.search.nodes.map(annotate) };
		} else {
			for (const [key, value] of Object.entries(data)) {
				if (value?.issueOrPullRequest) data[key] = { ...value, issueOrPullRequest: annotate(value.issueOrPullRequest) };
			}
		}
		return { ...response, json: async () => ({ ...result, data }) };
	};
	const pi = fakeHost();
	const review = createReviewExtension(pi, { org: "projectbluefin", fetchImpl, env: ISOLATED_ENV });
	const ctx = fakeCtx();
	ctx.ui.parent = ctx;

	await pi.events.get("session_start")({}, ctx);
	await review.whenStarted();
	ctx.overlays[0].handleInput("A");
	ctx.overlays[0].handleInput("s");
	await new Promise((resolve) => setImmediate(resolve));

	assert.ok(liveReads.has(81), "fresh exact-head failure evidence is fetched before the file-mutation gate");
	assert.ok(liveReads.has(82), "fresh exact-head pending evidence is fetched before the file-mutation gate");
	assert.equal(pi.messages.length, 1);
	assert.match(pi.messages[0], /#83/);
	assert.doesNotMatch(pi.messages[0], /#81|#82/);
	const batch = pi.entries.filter((entry) => entry.customType === BATCH_ENTRY).at(-1).data;
	assert.equal(batch.state, "running", JSON.stringify(batch));
	assert.equal(batch.totalItems, 3, "skipped selections remain in the original denominator");
	assert.deepEqual(batch.skippedItems.map(({ number, headSha, ciStatus, ciEvidenceSource }) => ({ number, headSha, ciStatus, ciEvidenceSource })), [
		{ number: 81, headSha: "8".repeat(40), ciStatus: "failure", ciEvidenceSource: "statusCheckRollup" },
		{ number: 82, headSha: "9".repeat(40), ciStatus: "pending", ciEvidenceSource: "checkSuites" },
	]);
	assert.deepEqual(batch.waves.map((wave) => wave.items.map((item) => item.id)), [[83]]);
});

test("slay reports incomplete-file candidates separately while preserving selection denominator and subject", async () => {
	const items = [
		{ id: 84, repo: "projectbluefin/incomplete", title: "PR with truncated file list", headSha: "b".repeat(40), ciStatus: "success" },
		{ id: 85, repo: "projectbluefin/eligible", title: "eligible PR", headSha: "c".repeat(40), ciStatus: "success" },
	];
	const baseFetch = hiveBackedFetch(items);
	const fetchImpl = async (url, init) => {
		const response = await baseFetch(url, init);
		if (!String(url).includes("/graphql")) return response;
		const result = await response.json();
		const body = JSON.parse(String(init?.body ?? "{}"));
		const search = body.variables?.search !== undefined;
		const annotate = (node) => {
			if (node?.number === 84) return {
				...node,
				files: { pageInfo: { hasNextPage: true }, nodes: [{ path: "README.md" }] },
			};
			if (node?.number === 85 && search) return {
				...node,
				files: { pageInfo: { hasNextPage: false }, nodes: [{ path: "README.md" }] },
			};
			return node;
		};
		const data = { ...result.data };
		if (data.search) data.search = { ...data.search, nodes: data.search.nodes.map(annotate) };
		else {
			for (const [key, value] of Object.entries(data)) {
				if (value?.issueOrPullRequest) data[key] = { ...value, issueOrPullRequest: annotate(value.issueOrPullRequest) };
			}
		}
		return { ...response, json: async () => ({ ...result, data }) };
	};
	const pi = fakeHost();
	const review = createReviewExtension(pi, { org: "projectbluefin", fetchImpl, env: ISOLATED_ENV });
	const ctx = fakeCtx();
	ctx.ui.parent = ctx;

	await pi.events.get("session_start")({}, ctx);
	await review.whenStarted();
	ctx.overlays[0].handleInput("A");
	ctx.overlays[0].handleInput("s");
	await new Promise((resolve) => setImmediate(resolve));

	assert.equal(pi.messages.length, 1);
	assert.match(pi.messages[0], /#85/);
	assert.doesNotMatch(pi.messages[0], /#84/);
	const batch = pi.entries.filter((entry) => entry.customType === BATCH_ENTRY).at(-1).data;
	assert.equal(batch.totalItems, 2, "the excluded selection remains in the original denominator");
	assert.deepEqual(batch.waves.map((wave) => wave.items.map((item) => item.id)), [[85]]);
	assert.deepEqual(batch.skippedItems ?? [], [], "incomplete file evidence is not a CI skip");
	assert.deepEqual(batch.excludedItems, [{
		repo: "projectbluefin/incomplete",
		number: 84,
		headSha: "b".repeat(40),
		reason: "incomplete changed-file list",
		observedAt: batch.excludedItems[0].observedAt,
	}]);
	assert.ok(Number.isFinite(batch.excludedItems[0].observedAt));
	assert.match(savedReviewNoticeText(pi), /1 selected item was left out/);
	assert.equal(ctx.notifications.some((notification) => /#84.*CI is/i.test(notification.message)), false);
	const details = await runReviewCommand(pi, ctx, "details");
	assert.match(details, /projectbluefin\/incomplete#84: incomplete changed-file list/);
	const status = await runReviewCommand(pi, ctx, "status");
	assert.match(status, /Review status · read only[\s\S]*Active slay run /);
});

test("slay retains incomplete-file exclusions when every remaining selected issue is already submitted", async () => {
	const incompletePr = queueItem({
		id: 86,
		repo: "projectbluefin/incomplete",
		title: "PR with unavailable file evidence",
		headSha: "d".repeat(40),
		ciStatus: "success",
		author: "reviewer",
		reviewState: "changes_requested",
		changedFilesComplete: false,
	});
	const submittedIssue = queueItem({
		id: 87,
		type: "issue",
		repo: "projectbluefin/already-submitted",
		title: "issue with an existing PR",
		submittedPrs: ["projectbluefin/already-submitted#10"],
	});
	const branch = [{
		type: "custom",
		customType: STATE_ENTRY,
		data: {
			mode: "prs",
			selectedKeys: [`${incompletePr.repo}#${incompletePr.id}`, `${submittedIssue.repo}#${submittedIssue.id}`],
			selected: [incompletePr, submittedIssue],
		},
	}];
	const pi = fakeHost();
	pi.flagValues.set("autoslay", true);
	const ctx = fakeCtx();
	ctx.ui.parent = ctx;
	ctx.sessionManager = { getBranch: () => branch, getSessionId: () => "session-1" };
	const baseFetch = hiveBackedFetch([incompletePr]);
	const issueFetch = issueBackedFetch({ [`${submittedIssue.repo}#${submittedIssue.id}`]: {
		title: submittedIssue.title,
		submittedPrs: submittedIssue.submittedPrs,
	} });
	const fetchImpl = async (url, init) => {
		const body = JSON.parse(String(init?.body ?? "{}"));
		if (typeof body.variables?.search === "string" && body.variables.search.includes("is:issue")) {
			return issueFetch(url, init);
		}
		const response = await baseFetch(url, init);
		if (!String(url).includes("/graphql")) return response;
		const result = await response.json();
		const annotate = (node) => node?.number === incompletePr.id
			? {
				...node,
				author: { login: "reviewer" },
				reviewDecision: "CHANGES_REQUESTED",
				files: { pageInfo: { hasNextPage: true }, nodes: [{ path: "README.md" }] },
			}
			: node;
		const data = { ...result.data, viewer: { login: "reviewer" } };
		if (data.search) data.search = { ...data.search, nodes: data.search.nodes.map(annotate) };
		else {
			for (const [key, value] of Object.entries(data)) {
				if (value?.issueOrPullRequest) data[key] = { ...value, issueOrPullRequest: annotate(value.issueOrPullRequest) };
			}
		}
		return { ...response, json: async () => ({ ...result, data }) };
	};
	const review = createReviewExtension(pi, {
		org: "projectbluefin",
		fetchImpl,
		env: ISOLATED_ENV,
	});

	await pi.events.get("session_start")({}, ctx);
	await review.whenStarted();

	assert.equal(pi.messages.length, 0, "no wave is dispatched after the remaining issue is filtered");
	const batch = pi.entries.filter((entry) => entry.customType === BATCH_ENTRY).at(-1)?.data;
	assert.ok(batch, "the excluded selection remains available in the Review status receipt");
	assert.equal(batch.state, "blocked", "excluded/already-submitted selections are not completed work");
	assert.equal(batch.totalItems, 2, "the original mixed selection remains the denominator");
	assert.deepEqual(batch.waves, []);
	assert.match(batch.error, /No work admitted/);
	assert.deepEqual(batch.excludedItems[0], {
		repo: incompletePr.repo,
		number: incompletePr.id,
		headSha: incompletePr.headSha,
		reason: "incomplete changed-file list",
		observedAt: batch.excludedItems[0].observedAt,
	});
	assert.deepEqual(batch.excludedItems.map(({ number, reason, detail }) => ({ number, reason, detail })), [
		{ number: incompletePr.id, reason: "incomplete changed-file list", detail: undefined },
		{ number: submittedIssue.id, reason: "pull request already submitted", detail: submittedIssue.submittedPrs.join(", ") },
	]);
	const status = await runReviewCommand(pi, ctx, "status");
	assert.match(status, /Saved slay run .*: blocked/);
	const details = await runReviewCommand(pi, ctx, "details");
	assert.match(details, /projectbluefin\/incomplete#86: incomplete changed-file list/);
	assert.match(details, /projectbluefin\/already-submitted#87: pull request already submitted\s+\(projectbluefin\/already-submitted#10\)/);
});

test("slay durably accounts for workflow-file candidates when no work is dispatched", async () => {
	const items = [{ id: 88, repo: "projectbluefin/workflow", title: "workflow PR", headSha: "e".repeat(40), ciStatus: "success" }];
	const baseFetch = hiveBackedFetch(items);
	const fetchImpl = async (url, init) => {
		const response = await baseFetch(url, init);
		if (!String(url).includes("/graphql")) return response;
		const result = await response.json();
		const markWorkflow = (node) => node?.number === 88
			? { ...node, files: { pageInfo: { hasNextPage: false }, nodes: [{ path: ".github/workflows/build.yml" }] } }
			: node;
		const data = { ...result.data };
		if (data.search) data.search = { ...data.search, nodes: data.search.nodes.map(markWorkflow) };
		else {
			for (const [key, value] of Object.entries(data)) {
				if (value?.issueOrPullRequest) data[key] = { ...value, issueOrPullRequest: markWorkflow(value.issueOrPullRequest) };
			}
		}
		return { ...response, json: async () => ({ ...result, data }) };
	};
	const pi = fakeHost();
	const review = createReviewExtension(pi, { org: "projectbluefin", fetchImpl, env: ISOLATED_ENV, policy: { ...GENERIC_WORKBENCH_POLICY, allowWorkflowSlay: false } });
	const ctx = fakeCtx();
	ctx.ui.parent = ctx;

	await pi.events.get("session_start")({}, ctx);
	await review.whenStarted();
	ctx.overlays[0].handleInput("A");
	ctx.overlays[0].handleInput("s");
	await new Promise((resolve) => setImmediate(resolve));

	assert.equal(pi.messages.length, 0);
	const batch = pi.entries.filter((entry) => entry.customType === BATCH_ENTRY).at(-1)?.data;
	assert.ok(batch, "a complete no-wave batch retains workflow selection accounting");
	assert.equal(batch.totalItems, 1);
	assert.deepEqual(batch.excludedItems.map(({ number, reason, detail }) => ({ number, reason, detail })), [
		{ number: 88, reason: "workflow file change", detail: ".github/workflows/build.yml" },
	]);
});

test("dashboard fix persists filtered PRs beside dispatched work using the original selection denominator", async () => {
	const items = [
		{ id: 89, repo: "projectbluefin/incomplete", title: "incomplete PR", headSha: "f".repeat(40), ciStatus: "success" },
		{ id: 90, repo: "projectbluefin/eligible", title: "eligible PR", headSha: "1".repeat(40), ciStatus: "success" },
	];
	const baseFetch = hiveBackedFetch(items);
	const fetchImpl = async (url, init) => {
		const response = await baseFetch(url, init);
		if (!String(url).includes("/graphql")) return response;
		const result = await response.json();
		const annotate = (node) => {
			if (node?.number === 89) return { ...node, files: { pageInfo: { hasNextPage: true }, nodes: [{ path: "README.md" }] } };
			if (node?.number === 90) return { ...node, files: { pageInfo: { hasNextPage: false }, nodes: [{ path: "README.md" }] } };
			return node;
		};
		const data = { ...result.data };
		if (data.search) data.search = { ...data.search, nodes: data.search.nodes.map(annotate) };
		else {
			for (const [key, value] of Object.entries(data)) {
				if (value?.issueOrPullRequest) data[key] = { ...value, issueOrPullRequest: annotate(value.issueOrPullRequest) };
			}
		}
		return { ...response, json: async () => ({ ...result, data }) };
	};
	const pi = fakeHost();
	const review = createReviewExtension(pi, { org: "projectbluefin", fetchImpl, env: ISOLATED_ENV, policy: { ...GENERIC_WORKBENCH_POLICY, allowWorkflowSlay: false } });
	const ctx = fakeCtx();
	ctx.ui.parent = ctx;

	await pi.events.get("session_start")({}, ctx);
	await review.whenStarted();
	ctx.overlays[0].handleInput("A");
	ctx.overlays[0].handleInput("f");
	await new Promise((resolve) => setImmediate(resolve));

	assert.equal(pi.messages.length, 1, JSON.stringify(pi.entries.filter((entry) => entry.customType === NOTICE_ENTRY).map((entry) => entry.data)));
	assert.match(pi.messages[0], /projectbluefin\/eligible#90/);
	assert.doesNotMatch(pi.messages[0], /projectbluefin\/incomplete#89/);
	const batch = pi.entries.filter((entry) => entry.customType === BATCH_ENTRY).at(-1)?.data;
	assert.ok(batch);
	assert.equal(batch.totalItems, 2, "filtered selected PR remains in the denominator");
	assert.deepEqual(batch.excludedItems.map(({ number, reason }) => ({ number, reason })), [
		{ number: 89, reason: "incomplete changed-file list" },
	]);
	assert.deepEqual(batch.waves.map((wave) => wave.items.map((item) => item.id)), [[90]]);
});

for (const [actionKey, actionName] of [["s", "Slay"], ["f", "fix"]] as const) test(`an all-excluded dashboard ${actionName} receipt does not replace an active Review wave`, async () => {
	const items = [
		{ id: 101, repo: "projectbluefin/eligible", title: "eligible PR", headSha: "2".repeat(40), ciStatus: "success" },
		{ id: 102, repo: "projectbluefin/incomplete", title: "incomplete PR", headSha: "3".repeat(40), ciStatus: "success" },
	];
	const baseFetch = hiveBackedFetch(items);
	const fetchImpl = async (url, init) => {
		const response = await baseFetch(url, init);
		if (!String(url).includes("/graphql")) return response;
		const result = await response.json();
		const annotate = (node) => node?.number === 102
			? { ...node, files: { pageInfo: { hasNextPage: true }, nodes: [{ path: "README.md" }] } }
			: node;
		const data = { ...result.data };
		if (data.search) data.search = { ...data.search, nodes: data.search.nodes.map(annotate) };
		else {
			for (const [key, value] of Object.entries(data)) {
				if (value?.issueOrPullRequest) data[key] = { ...value, issueOrPullRequest: annotate(value.issueOrPullRequest) };
			}
		}
		return { ...response, json: async () => ({ ...result, data }) };
	};
	const pi = fakeHost();
	const review = createReviewExtension(pi, { org: "projectbluefin", fetchImpl, env: ISOLATED_ENV });
	const ctx = fakeCtx();
	ctx.ui.parent = ctx;

	await pi.events.get("session_start")({}, ctx);
	await review.whenStarted();
	ctx.overlays[0].handleInput(actionKey);
	await new Promise((resolve) => setImmediate(resolve));
	const active = pi.entries.filter((entry) => entry.customType === BATCH_ENTRY).at(-1)?.data;
	assert.ok(active);
	assert.equal(active.state, "running");
	assert.deepEqual(active.waves.map((wave) => wave.items.map((item) => item.id)), [[101]]);

	ctx.overlays[0].handleInput("j");
	ctx.overlays[0].handleInput(actionKey);
	await new Promise((resolve) => setImmediate(resolve));

	assert.equal(pi.messages.length, 1, "the second all-excluded selection does not dispatch work");
	const receipt = pi.entries.filter((entry) => entry.customType === BATCH_ENTRY).at(-1)?.data;
	assert.ok(receipt);
	assert.equal(receipt.totalItems, 1);
	assert.deepEqual(receipt.excludedItems.map(({ number, reason }) => ({ number, reason })), [
		{ number: 102, reason: "incomplete changed-file list" },
	]);
	assert.equal(receipt.state, "blocked", "all-excluded work is not recorded as completed");
	assert.match(receipt.error, /No work admitted/);
	const status = await runReviewCommand(pi, ctx, "status");
	assert.match(status, new RegExp(`Active ${actionKey === "s" ? "slay" : "fix"} run `));
	assert.notEqual(receipt.id, active.id);
});

test("slay keeps workflow permission as a batch blocker after skipping failed CI", async () => {
	const items = [
		{ id: 51, repo: "projectbluefin/review", title: "red ordinary PR", headSha: "b".repeat(40), ciStatus: "failure" },
		{ id: 52, repo: "projectbluefin/review", title: "workflow PR without scope", headSha: "c".repeat(40), ciStatus: "success" },
	];
	const baseFetch = hiveBackedFetch(items);
	const fetchImpl = async (url, init) => {
		if (String(url) === "https://api.github.com/") {
			return { ok: true, status: 200, statusText: "OK", headers: { get: () => null }, json: async () => ({}) };
		}
		const response = await baseFetch(url, init);
		if (!String(url).includes("/graphql")) return response;
		const result = await response.json();
		const markWorkflow = (node) => node?.number === 52
			? { ...node, files: { pageInfo: { hasNextPage: false }, nodes: [{ path: ".github/workflows/build.yml" }] } }
			: node;
		const data = { ...result.data };
		if (data.search) {
			data.search = { ...data.search, nodes: data.search.nodes.map(markWorkflow) };
		} else {
			for (const [key, value] of Object.entries(data)) {
				if (value?.issueOrPullRequest) data[key] = { ...value, issueOrPullRequest: markWorkflow(value.issueOrPullRequest) };
			}
		}
		return { ...response, json: async () => ({ ...result, data }) };
	};
	const pi = fakeHost();
	const review = createReviewExtension(pi, {
		org: "projectbluefin",
		fetchImpl,
		env: ISOLATED_ENV,
		policy: { ...GENERIC_WORKBENCH_POLICY, allowWorkflowSlay: true },
	});
	const ctx = fakeCtx();
	ctx.ui.parent = ctx;

	await pi.events.get("session_start")({}, ctx);
	await review.whenStarted();
	ctx.overlays[0].handleInput("A");
	ctx.overlays[0].handleInput("s");
	await new Promise((resolve) => setImmediate(resolve));

	assert.equal(pi.messages.length, 0);
	const batch = pi.entries.filter((entry) => entry.customType === BATCH_ENTRY).at(-1).data;
	assert.equal(batch.state, "blocked");
	assert.match(batch.error, /workflow\/Actions write permission could not be verified/);
});

test("self-hosted slay and fix dispatch workflow pull requests while incomplete lists stay blocked", async () => {
	const workflowPr = {
		number: 10,
		title: "update deploy pipeline",
		url: "https://github.com/projectbluefin/review/pull/10",
		updatedAt: new Date(NOW).toISOString(),
		isDraft: false,
		mergeable: "MERGEABLE",
		reviewDecision: "REVIEW_REQUIRED",
		headRefOid: "1".repeat(40),
		changedFiles: 1,
		files: { pageInfo: { hasNextPage: false }, nodes: [{ path: ".github/workflows/deploy.yml" }] },
		author: { login: "contributor" },
		repository: { nameWithOwner: "projectbluefin/review" },
		labels: { nodes: [] },
		commits: { nodes: [{ commit: { statusCheckRollup: { state: "SUCCESS" } } }] },
	};
	let staleLiveHead = false;
	const truncatedPr = {
		number: 20,
		title: "massive refactor",
		url: "https://github.com/projectbluefin/review/pull/20",
		updatedAt: new Date(NOW - 1000).toISOString(),
		isDraft: false,
		mergeable: "MERGEABLE",
		reviewDecision: "REVIEW_REQUIRED",
		headRefOid: "2".repeat(40),
		changedFiles: 200,
		files: { pageInfo: { hasNextPage: true }, nodes: [{ path: "src/index.ts" }] },
		author: { login: "contributor" },
		repository: { nameWithOwner: "projectbluefin/review" },
		labels: { nodes: [] },
		commits: { nodes: [{ commit: { statusCheckRollup: { state: "SUCCESS" } } }] },
	};
	const eligiblePr = {
		number: 30,
		title: "fix typo",
		url: "https://github.com/projectbluefin/review/pull/30",
		updatedAt: new Date(NOW - 2000).toISOString(),
		isDraft: false,
		mergeable: "MERGEABLE",
		reviewDecision: "APPROVED",
		headRefOid: "3".repeat(40),
		changedFiles: 1,
		files: { pageInfo: { hasNextPage: false }, nodes: [{ path: "README.md" }] },
		author: { login: "contributor" },
		repository: { nameWithOwner: "projectbluefin/review" },
		labels: { nodes: [] },
		commits: { nodes: [{ commit: { statusCheckRollup: { state: "SUCCESS" } } }] },
	};
	const fetchImpl = async (_url, init) => {
		if (String(_url) === "https://api.github.com/") {
			return { ok: true, status: 200, statusText: "OK", headers: { get: () => "workflow" }, json: async () => ({}) };
		}
		if (String(_url).includes("/repos/")) {
			return { ok: true, status: 200, statusText: "OK", json: async () => ({ permissions: { push: true } }) };
		}
		const body = JSON.parse(String(init?.body ?? "{}"));
		if (body.variables?.search !== undefined) {
			return {
				ok: true,
				status: 200,
				statusText: "OK",
				json: async () => ({
					data: {
						viewer: { login: "maintainer" },
						search: {
							pageInfo: { hasNextPage: false, endCursor: null },
							nodes: [workflowPr, truncatedPr, eligiblePr],
						},
					},
				}),
			};
		}
		const data = {};
		const aliases = /(\w+): repository\(owner: [^,]+, name: [^)]+\)\s*\{\s*issueOrPullRequest\(number: (\d+)\)/g;
		for (const [, alias, number] of body.query.matchAll(aliases)) {
			const found = [workflowPr, truncatedPr, eligiblePr].find((n) => n.number === Number(number));
			const live = staleLiveHead && Number(number) === 10
				? { ...found, headRefOid: "9".repeat(40) }
				: found;
			data[alias] = { issueOrPullRequest: live ? { ...live, closed: false } : null };
		}
		return { ok: true, status: 200, statusText: "OK", json: async () => ({ data }) };
	};

	const pi = fakeHost();
	const review = createReviewExtension(pi, { org: "projectbluefin", fetchImpl, env: ISOLATED_ENV });
	const ctx = fakeCtx();
	ctx.ui.parent = ctx;

	await pi.events.get("session_start")({}, ctx);
	await review.whenStarted();

	// Workflow PRs remain visible and actionable on the self-hosted generic policy.
	const queue = await pi.tools.get("hive_workbench_queue").execute("id", {});
	assert.doesNotMatch(queue.content[0].text, /\[blocked\] projectbluefin\/review#10/);
	assert.match(queue.content[0].text, /projectbluefin\/review#20/);

	const dashboard = ctx.overlays[0];
	dashboard.handleInput("j"); // Move past the more recently updated ordinary PR to the workflow PR.
	dashboard.handleInput("f");
	await new Promise((resolve) => setImmediate(resolve));
	assert.equal(pi.messages.length, 1);
	assert.match(pi.messages[0], /projectbluefin\/review#10/);
	assert.equal(ctx.notifications.some((n) => /Skipping projectbluefin\/review#10/.test(n.message)), false);

	// A workflow fix must reject a head that changed after the queue snapshot,
	// even when the token's capability preflight succeeds.
	ctx.asyncJobs.recent = [{ id: "fix", status: "completed", startTime: Date.now() + 1 }];
	await pi.events.get("agent_end")({}, ctx);
	staleLiveHead = true;
	pi.messages.length = 0;
	dashboard.handleInput("f");
	await new Promise((resolve) => setImmediate(resolve));
	assert.equal(pi.messages.length, 0, "stale workflow head must not dispatch a fixer");
	assert.match(savedReviewNoticeText(pi), /Review couldn’t complete this step/);
	assert.match(await runReviewCommand(pi, ctx, "details"), /pull request head changed/);

});

test("generic PR fix revalidates every selected head and live workflow classification", async () => {
	const head = "a".repeat(40);
	let liveHead = head;
	const node = (live: boolean) => ({
		number: 10,
		title: "transition into workflow change",
		url: "https://github.com/projectbluefin/review/pull/10",
		updatedAt: new Date(NOW).toISOString(),
		isDraft: false,
		mergeable: "MERGEABLE",
		reviewDecision: "REVIEW_REQUIRED",
		headRefOid: liveHead,
		changedFiles: 1,
		files: { pageInfo: { hasNextPage: false }, nodes: [{ path: live ? ".github/workflows/deploy.yml" : "README.md" }] },
		author: { login: "contributor" },
		repository: { nameWithOwner: "projectbluefin/review" },
		labels: { nodes: [] },
		commits: { nodes: [{ commit: { statusCheckRollup: { state: "SUCCESS" } } }] },
	});
	const fetchImpl = async (_url, init) => {
		const target = String(_url);
		if (target === "https://api.github.com/") {
			return { ok: true, status: 200, statusText: "OK", headers: { get: () => "workflow" }, json: async () => ({}) };
		}
		if (!target.includes("/graphql")) return { ok: true, status: 200, statusText: "OK", json: async () => [] };
		const body = JSON.parse(String(init?.body ?? "{}"));
		if (body.variables?.search !== undefined) {
			return {
				ok: true,
				status: 200,
				statusText: "OK",
				json: async () => ({ data: { viewer: { login: "maintainer" }, search: { pageInfo: { hasNextPage: false }, nodes: [node(false)] } } }),
			};
		}
		const data = {};
		for (const [, alias] of body.query.matchAll(/(\w+): repository\(owner: [^,]+, name: [^)]+\)\s*\{\s*issueOrPullRequest\(number: 10\)/g)) {
			data[alias] = { issueOrPullRequest: { ...node(true), closed: false } };
		}
		return { ok: true, status: 200, statusText: "OK", json: async () => ({ data }) };
	};
	const pi = fakeHost();
	const review = createReviewExtension(pi, { org: "projectbluefin", fetchImpl, env: ISOLATED_ENV, policy: { ...GENERIC_WORKBENCH_POLICY, allowWorkflowSlay: false } });
	const ctx = fakeCtx();
	ctx.ui.parent = ctx;
	await pi.events.get("session_start")({}, ctx);
	await review.whenStarted();
	await new Promise((resolve) => setImmediate(resolve));
	ctx.overlays[0].handleInput("f");
	await new Promise((resolve) => setImmediate(resolve));
	assert.equal(pi.messages.length, 0, "a newly workflow-changing live PR is blocked by managed policy");
	assert.match(savedReviewNoticeText(pi), /Review couldn’t complete this step/);
	assert.match(await runReviewCommand(pi, ctx, "details"), /changes \.github\/workflows\/deploy\.yml/);

	liveHead = "b".repeat(40);
	ctx.notifications.length = 0;
	ctx.overlays[0].handleInput("f");
	await new Promise((resolve) => setImmediate(resolve));
	assert.equal(pi.messages.length, 0, "a stale generic-fix head never dispatches");
	assert.match(await runReviewCommand(pi, ctx, "details"), /pull request head changed/);
});

test("generic workflow fix rejects push-only permission", async () => {
	const node = {
		number: 10,
		title: "workflow change",
		url: "https://github.com/projectbluefin/review/pull/10",
		updatedAt: new Date(NOW).toISOString(),
		isDraft: false,
		mergeable: "MERGEABLE",
		reviewDecision: "REVIEW_REQUIRED",
		headRefOid: "a".repeat(40),
		changedFiles: 1,
		files: { pageInfo: { hasNextPage: false }, nodes: [{ path: ".github/workflows/deploy.yml" }] },
		author: { login: "contributor" },
		repository: { nameWithOwner: "projectbluefin/review" },
		labels: { nodes: [] },
		commits: { nodes: [{ commit: { statusCheckRollup: { state: "SUCCESS" } } }] },
	};
	const fetchImpl = async (_url, init) => {
		const target = String(_url);
		if (target === "https://api.github.com/") {
			return { ok: true, status: 200, statusText: "OK", headers: { get: () => null }, json: async () => ({}) };
		}
		if (!target.includes("/graphql")) return { ok: true, status: 200, statusText: "OK", json: async () => [] };
		const body = JSON.parse(String(init?.body ?? "{}"));
		if (body.variables?.search !== undefined) {
			return { ok: true, status: 200, statusText: "OK", json: async () => ({ data: { viewer: { login: "maintainer" }, search: { pageInfo: { hasNextPage: false }, nodes: [node] } } }) };
		}
		const data = {};
		for (const [, alias] of body.query.matchAll(/(\w+): repository\(owner: [^,]+, name: [^)]+\)\s*\{\s*issueOrPullRequest\(number: 10\)/g)) {
			data[alias] = { issueOrPullRequest: { ...node, closed: false } };
		}
		return { ok: true, status: 200, statusText: "OK", json: async () => ({ data }) };
	};
	const pi = fakeHost();
	const review = createReviewExtension(pi, { org: "projectbluefin", fetchImpl, env: ISOLATED_ENV, policy: GENERIC_WORKBENCH_POLICY });
	const ctx = fakeCtx();
	ctx.ui.parent = ctx;
	await pi.events.get("session_start")({}, ctx);
	await review.whenStarted();
	await new Promise((resolve) => setImmediate(resolve));
	ctx.overlays[0].handleInput("f");
	await new Promise((resolve) => setImmediate(resolve));
	assert.equal(pi.messages.length, 0);
	assert.match(savedReviewNoticeText(pi), /Review couldn’t complete this step/);
	assert.match(await runReviewCommand(pi, ctx, "details"), /workflow\/Actions write permission could not\s+be verified/);
});

test("Fix detects a later-page workflow before checking live workflow permission", async () => {
	const head = "a".repeat(40);
	const firstPaths = Array.from({ length: 100 }, (_, i) => ({ path: `src/file-${i}.ts` }));
	const node = {
		number: 10, closed: false, title: "workflow on the second page",
		url: "https://github.com/example/review/pull/10", updatedAt: new Date(NOW).toISOString(),
		isDraft: false, mergeable: "MERGEABLE", reviewDecision: "REVIEW_REQUIRED",
		headRefOid: head, baseRefOid: "b".repeat(40), changedFiles: 101,
		author: { login: "contributor" }, repository: { nameWithOwner: "example/review" },
		labels: { nodes: [] },
		files: { pageInfo: { hasNextPage: true, endCursor: "page-1" }, nodes: firstPaths },
		commits: { nodes: [{ commit: { statusCheckRollup: { state: "SUCCESS" } } }] },
	};
	let filePages = 0;
	const fetchImpl = async (url, init) => {
		const target = String(url);
		if (target === "https://api.github.com/") {
			return { ok: true, status: 200, statusText: "OK", headers: { get: () => null }, json: async () => ({}) };
		}
		if (!target.includes("/graphql")) {
			return { ok: true, status: 200, statusText: "OK", json: async () => ({ permissions: { push: true } }) };
		}
		const body = JSON.parse(String(init?.body ?? "{}"));
		let data;
		if (body.variables?.search !== undefined) {
			data = { viewer: { login: "maintainer" }, search: { pageInfo: { hasNextPage: false }, nodes: [{ ...node, files: undefined }] } };
		} else if (body.query.includes("pullRequest(number: 10)")) {
			filePages++;
			data = { w0: { nameWithOwner: "example/review", pullRequest: {
				...node, files: { pageInfo: { hasNextPage: false }, nodes: [{ path: ".github/workflows/late.yml" }] },
			} } };
		} else {
			data = { w0: { issueOrPullRequest: node } };
		}
		return { ok: true, status: 200, statusText: "OK", json: async () => ({ data }) };
	};
	const pi = fakeHost();
	const ctx = fakeCtx();
	ctx.ui.parent = ctx;
	const review = createReviewExtension(pi, {
		org: "example", fetchImpl, env: ISOLATED_ENV, policy: GENERIC_WORKBENCH_POLICY,
	});
	await pi.events.get("session_start")({}, ctx);
	await review.whenStarted();
	ctx.overlays[0].handleInput("f");
	await new Promise((resolve) => setImmediate(resolve));
	assert.equal(filePages, 1, await runReviewCommand(pi, ctx, "details"));
	assert.equal(pi.messages.length, 0, "push permission alone cannot admit this workflow Fix");
	assert.match(await runReviewCommand(pi, ctx, "details"), /workflow\/Actions write permission could not\s+be\s+verified/);
});

test("active slay blocks privileged and credential-bearing bash mutations", async () => {
	const target = queueItem({ id: 7, repo: "projectbluefin/other", headSha: "7".repeat(40), reviewState: "approved", ciStatus: "success", labels: [] });
	const pi = fakeHost();
	pi.flagValues.set("pr", "7");
	const review = createReviewExtension(pi, { org: "projectbluefin", fetchImpl: landingGuardFetch([target]), env: ISOLATED_ENV });
	const ctx = fakeCtx();
	ctx.ui.parent = ctx;

	await pi.events.get("session_start")({}, ctx);
	await review.whenStarted();
	await new Promise((resolve) => setImmediate(resolve));
	ctx.overlays[0].handleInput("s");
	await new Promise((resolve) => setImmediate(resolve));
	await completeReviewTask(pi, ctx);
	const guard = pi.events.get("tool_call");
	const call = (command) => guard({ toolName: "bash", input: { command } }, ctx);

	// Target checkout ownership is independent of OMP's coordinator-repo isolation.
	for (const input of [{ isolated: false }, {}, { isolated: true }, { tasks: [{ task: "one", solutionSpace: "bounded" }] }]) {
		assert.equal(await guard({ toolName: "task", input }, ctx), undefined);
	}

	assert.match((await call("gh pr merge 42 --repo projectbluefin/review --admin --squash")).reason, /admin merge bypass/);
	const forcePushBlock = await call("git push origin repair --force-with-lease");
	assert.match(forcePushBlock.reason, /force-pushing/);
	assert.doesNotMatch(forcePushBlock.reason, /Hive/i);
	assert.match(
		(await call("git push https://x-access-token:${GH_TOKEN}@github.com/projectbluefin/review.git repair")).reason,
		/credentials in URL userinfo/,
	);
	const batch = pi.entries.filter((entry) => entry.customType === BATCH_ENTRY).at(-1).data;
	target.ciStatus = "failure";
	const failedReviewBlock = await call("gh pr review 7 --repo projectbluefin/other --approve");
	assert.match(failedReviewBlock.reason, /CI is failure/);
	assert.doesNotMatch(failedReviewBlock.reason, /Hive/i);
	target.ciStatus = "pending";
	assert.match((await call(`gh pr merge 7 --repo projectbluefin/other --squash --match-head-commit ${target.headSha}`)).reason, /CI is pending/);
	target.ciStatus = "success";
	assert.equal(await call(`gh pr merge 7 --repo projectbluefin/other --squash --match-head-commit ${target.headSha}`), undefined);
});


test("slay gate refuses a blocked landing state and allows only complete readiness (review#461)", async () => {
	const target = queueItem({ id: 7, repo: "projectbluefin/other", headSha: "7".repeat(40), reviewState: "approved", ciStatus: "success", labels: [] });
	const pi = fakeHost();
	pi.flagValues.set("pr", "7");
	const review = createReviewExtension(pi, { org: "projectbluefin", fetchImpl: landingGuardFetch([target]), env: ISOLATED_ENV });
	const ctx = fakeCtx();
	ctx.ui.parent = ctx;

	await pi.events.get("session_start")({}, ctx);
	await review.whenStarted();
	await new Promise((resolve) => setImmediate(resolve));
	ctx.overlays[0].handleInput("s");
	await new Promise((resolve) => setImmediate(resolve));
	await completeReviewTask(pi, ctx);
	const guard = pi.events.get("tool_call");
	const call = (command) => guard({ toolName: "bash", input: { command } }, ctx);

	const batch = pi.entries.filter((entry) => entry.customType === BATCH_ENTRY).at(-1).data;


	// Green CI but a requested-changes review blocks approval and merge.
	target.reviewState = "changes_requested";
	assert.match((await call(`gh pr merge 7 --repo projectbluefin/other --squash --match-head-commit ${target.headSha}`)).reason, /changes_requested/);
	assert.match((await call("gh pr review 7 --repo projectbluefin/other --approve")).reason, /changes_requested/);

	// Green CI and approved but a hold label blocks.
	target.reviewState = "approved";
	target.labels = ["hold"];
	assert.match((await call(`gh pr merge 7 --repo projectbluefin/other --squash --match-head-commit ${target.headSha}`)).reason, /hold label/);

	// Green, approved, unheld but a dirty merge blocks.
	target.labels = [];
	target.mergeState = "dirty";
	assert.match((await call(`gh pr merge 7 --repo projectbluefin/other --squash --match-head-commit ${target.headSha}`)).reason, /conflicts/);

	// Green, approved, clean but pending CI blocks.
	target.mergeState = "clean";
	target.ciStatus = "pending";
	assert.match((await call(`gh pr merge 7 --repo projectbluefin/other --squash --match-head-commit ${target.headSha}`)).reason, /CI is pending/);

	// A green, approved, clean, unheld pull request is the only ready-to-land state.
	target.ciStatus = "success";
	assert.equal(await call(`gh pr merge 7 --repo projectbluefin/other --squash --match-head-commit ${target.headSha}`), undefined);
});

for (const scenario of [
	{ mode: "solo", requiredApprovals: 0, expected: "allow" },
	{ mode: "team", requiredApprovals: 0, expected: "team-block" },
	{ mode: "solo", requiredApprovals: 1, expected: "github-block" },
	{ mode: "solo", requiredApprovals: 0, expected: "policy-drift" },
	{ mode: "solo", requiredApprovals: 0, expected: "policy-aba" },
	{ mode: "solo", requiredApprovals: 0, expected: "head-drift" },
	{ mode: "solo", requiredApprovals: 0, expected: "undelivered" },
	{ mode: "solo", requiredApprovals: 0, expected: "repair-review" },
	{ mode: "solo", requiredApprovals: 0, expected: "mcp-unqualified" },
	{ mode: "solo", requiredApprovals: 0, expected: "mcp-sha-unsupported" },
]) test(`#79 ${scenario.mode} landing policy applies independent reviewer and GitHub gates (${scenario.expected})`, async () => {
	const target = queueItem({ id: 79, repo: "example/solo", author: "maintainer", headSha: "7".repeat(40), reviewState: "review_required", ciStatus: "success", labels: [] });
	const env = { ...ISOLATED_ENV, HOME: ISOLATED_ENV.LUNA_FACTORY_STATE_ROOT, REVIEW_MODE: "review" };
	const observer = async (repository, number) => ({ kind: "observed", facts: {
		repository, number, headSha: target.headSha, baseRef: "main", authorLogin: "maintainer", viewerLogin: "maintainer",
		canMerge: true, requiredApprovals: scenario.requiredApprovals, requiresCodeOwnerReview: false, requiresLastPushApproval: false,
		githubReviewState: scenario.requiredApprovals ? "required" : "none", currentHumanApprovals: [], digest: `#79:${scenario.mode}:${target.headSha}`, observedAt: Date.now(),
	} });
	const pi = fakeHost({
		qualifiedMcp: scenario.expected !== "mcp-unqualified",
		mcpShaDescription: scenario.expected === "mcp-sha-unsupported" ? "SHA supplied to merge API" : undefined,
	}); pi.flagValues.set("pr", "79");
	const ctx = fakeCtx(); ctx.ui.parent = ctx;
	const review = createReviewExtension(pi, { org: "example", fetchImpl: landingGuardFetch([target]), env, humanReviewObserver: observer });
	await pi.events.get("session_start")({}, ctx); await review.whenStarted();
	const changed = await runReviewCommand(pi, ctx, `policy example/solo ${scenario.mode}`);
	assert.match(changed, /Starts no work/);
	assert.equal(pi.messages.length, 0, "policy selection does not dispatch work");
	const read = await runReviewCommand(pi, ctx, "policy example/solo");
	assert.match(read, new RegExp(`${scenario.mode} \\(explicit\\)`));
	const restarted = fakeHost();
	const restartedCtx = fakeCtx(); restartedCtx.ui.parent = restartedCtx;
	const restartedReview = createReviewExtension(restarted, { org: "example", fetchImpl: landingGuardFetch([target]), env, humanReviewObserver: observer });
	await restarted.events.get("session_start")({}, restartedCtx); await restartedReview.whenStarted();
	const persistedRead = await runReviewCommand(restarted, restartedCtx, "policy example/solo");
	assert.match(persistedRead, new RegExp(`${scenario.mode} \\(explicit\\)`), "policy survives extension restart");
	ctx.overlays[0].handleInput("s"); await new Promise((resolve) => setImmediate(resolve));
	await completeReviewTask(pi, ctx, 1, { deliver: scenario.expected !== "undelivered" });
	const guard = pi.events.get("tool_call");
	if (scenario.expected === "policy-drift" || scenario.expected === "policy-aba") await pi.commands.get("review").handler("policy example/solo team", ctx);
	if (scenario.expected === "policy-aba") await pi.commands.get("review").handler("policy example/solo solo", ctx);
	if (scenario.expected === "head-drift") target.headSha = "8".repeat(40);
	if (scenario.expected === "mcp-unqualified" || scenario.expected === "mcp-sha-unsupported") {
		const result = await guard({ toolName: "mcp__github_merge_pull_request", input: { owner: "example", repo: "solo", pullNumber: 79, merge_method: "squash", sha: target.headSha } }, ctx);
		assert.equal(result?.block, true);
		assert.match(result.reason, /GitHub MCP merge has no qualified native expected-head contract; use gh pr merge --squash --match-head-commit/);
		return;
	}
	if (scenario.expected === "allow") {
		const noHead = await guard({ toolName: "bash", input: { command: "gh pr merge 79 --repo example/solo --squash" } }, ctx);
		assert.match(noHead.reason, /server-enforced head guard/);
		const mcpNoHead = await guard({ toolName: "mcp__github_merge_pull_request", input: { owner: "example", repo: "solo", pullNumber: 79, merge_method: "squash" } }, ctx);
		assert.match(mcpNoHead.reason, /server-enforced head guard/);
		const autoMerge = await guard({ toolName: "bash", input: { command: `gh pr merge 79 --repo example/solo --auto --squash --match-head-commit ${target.headSha}` } }, ctx);
		assert.match(autoMerge.reason, /direct head-bound merge only/);
		assert.equal(await guard({ toolName: "mcp__github_merge_pull_request", input: { owner: "example", repo: "solo", pullNumber: 79, merge_method: "squash", sha: target.headSha } }, ctx), undefined);
	}
	if (scenario.expected === "repair-review") {
		target.headSha = "9".repeat(40);
		const stale = await guard({ toolName: "bash", input: { command: `gh pr merge 79 --repo example/solo --squash --match-head-commit ${target.headSha}` } }, ctx);
		assert.equal(stale?.block, true, "repair invalidates the old head receipt");
		assert.match(stale.reason, /reviewer receipt for the current head/);
		await completeReviewTask(pi, ctx, 1, { prefix: "repair", headOverrides: { [target.id]: target.headSha } });
	}
	const result = await guard({ toolName: "bash", input: { command: `gh pr merge 79 --repo example/solo --squash --match-head-commit ${target.headSha}` } }, ctx);
	if (scenario.expected === "allow" || scenario.expected === "repair-review") assert.equal(result, undefined);
	else {
		assert.equal(result?.block, true);
		const expectedReason = {
			"team-block": /team policy/,
			"github-block": /GitHub requires an eligible approving review/,
			"policy-drift": /operator policy changed/,
			"policy-aba": /operator policy changed/,
			"head-drift": /(?:current PR identity or head differs|reviewer receipt for the current head)/,
			"undelivered": /await result delivery/,
		}[scenario.expected];
		assert.match(result.reason, expectedReason);
	}
});

for (const surface of ["bash", "mcp", "xd"]) for (const evidence of [
	"none", "history-only", "history-task", "stale-job", "missing-receipt", "partial", "running", "failed", "cancelled", "ambiguous", "pending-delivery", "current", "consumed",
]) test(`Slay ${surface} requires successful current-dispatch task receipts before landing: ${evidence}`, async () => {
	const target = queueItem({ id: 7, repo: "projectbluefin/other", headSha: "7".repeat(40), reviewState: "approved", ciStatus: "success", labels: [] });
	const pi = fakeHost(); pi.flagValues.set("pr", "7");
	const ctx = fakeCtx(); ctx.ui.parent = ctx;
	const oldJob = { id: "historical-job", agentId: "Review454", type: "task", status: "completed", startTime: Date.now() - 60_000 };
	if (evidence.startsWith("history")) ctx.asyncJobs.recent = [oldJob];
	const review = createReviewExtension(pi, { org: "projectbluefin", fetchImpl: landingGuardFetch([target]), env: ISOLATED_ENV });
	await pi.events.get("session_start")({}, ctx); await review.whenStarted();
	ctx.overlays[0].handleInput("s"); await new Promise((resolve) => setImmediate(resolve));
	const guard = pi.events.get("tool_call");
	if (evidence === "history-only") {
		await guard({ toolCallId: "read-old-review", toolName: "read", input: { path: "agent://Review454" } }, ctx);
	} else if (["current", "consumed", "pending-delivery", "partial"].includes(evidence)) {
		await completeReviewTask(pi, ctx);
		if (evidence === "consumed") ctx.asyncJobs.recent = [];
		if (evidence === "partial") await guard({ toolCallId: "unmapped-second-task", toolName: "task", input: { task: "Review repaired head" } }, ctx);
		if (evidence === "pending-delivery") ctx.asyncJobs.delivery.pendingJobIds = ["review-job-0"];
	} else if (evidence !== "none") {
		await guard({ toolCallId: "current-task", toolName: "task", input: { task: "Review target" } }, ctx);
		if (evidence !== "missing-receipt") {
			const status = evidence === "running" ? "running" : evidence === "failed" ? "failed" : evidence === "cancelled" ? "cancelled" : "completed";
			const worker = evidence === "history-task" || evidence === "stale-job" ? oldJob : { id: "current-job", agentId: "current-agent", type: "task", status, startTime: Date.now() + 1 };
			if (evidence === "running") ctx.asyncJobs.running = [worker];
			else ctx.asyncJobs.recent = evidence === "ambiguous" ? [worker, { ...worker, id: "second-job" }] : [worker];
			await pi.events.get("tool_execution_end")({ toolCallId: "current-task", result: { details: {
				async: { type: "task", state: status, ...(evidence === "ambiguous" ? {} : { jobId: worker.id }) },
				progress: [{ id: worker.agentId, index: 0, status: status === "cancelled" ? "aborted" : status }],
			} }, isError: false }, ctx);
		}
	}
	const claims = new ResourceClaims(ISOLATED_ENV.LUNA_FACTORY_STATE_ROOT, ISOLATED_ENV.LUNA_FACTORY_CLAIMS_ROOT);
	const before = claims.list();
	for (const action of ["approve", "merge"]) {
		const args = { owner: "projectbluefin", repo: "other", pullNumber: 7, ...(action === "approve" ? { method: "submit_pending", event: "APPROVE" } : { merge_method: "squash", sha: target.headSha }) };
		const name = action === "approve" ? "pull_request_review_write" : "merge_pull_request";
		const result = await guard(surface === "bash"
			? { toolName: "bash", input: { command: action === "approve" ? "gh pr review 7 --repo projectbluefin/other --approve" : `gh pr merge 7 --repo projectbluefin/other --squash --match-head-commit ${target.headSha}` } }
			: surface === "mcp" ? { toolName: `mcp__github_${name}`, input: args }
				: { toolName: "write", input: { path: `xd://mcp__github_${name}`, content: JSON.stringify(args) } }, ctx);
		if (evidence === "current" || evidence === "consumed") assert.equal(result, undefined, action);
		else {
			assert.equal(result?.block, true, `${action} must be blocked for ${evidence}`);
			assert.match(result.reason, /current.*(?:wave|dispatch).*workflowz|workflowz.*current.*(?:wave|dispatch)/i);
		}
	}
	assert.deepEqual(claims.list(), before, "landing admission must preserve ownership");
});

test("Slay rechecks current worker receipts after fetching live landing evidence", async () => {
	const target = queueItem({ id: 7, repo: "projectbluefin/other", headSha: "7".repeat(40), reviewState: "approved", ciStatus: "success", labels: [] });
	const pi = fakeHost(); pi.flagValues.set("pr", "7");
	const ctx = fakeCtx(); ctx.ui.parent = ctx;
	const fetch = landingGuardFetch([target]);
	let interruptLanding = false;
	const fetchImpl = async (url, init) => {
		if (interruptLanding) {
			interruptLanding = false;
			ctx.asyncJobs.running = [{ ...ctx.asyncJobs.recent[0], status: "running" }];
			ctx.asyncJobs.recent = [];
		}
		return fetch(url, init);
	};
	fetchImpl.reviewItems = [target];
	const review = createReviewExtension(pi, { org: "projectbluefin", fetchImpl, env: ISOLATED_ENV });
	await pi.events.get("session_start")({}, ctx); await review.whenStarted();
	ctx.overlays[0].handleInput("s"); await new Promise((resolve) => setImmediate(resolve));
	await completeReviewTask(pi, ctx);
	interruptLanding = true;
	const result = await pi.events.get("tool_call")({ toolName: "bash", input: { command: `gh pr merge 7 --repo projectbluefin/other --squash --match-head-commit ${target.headSha}` } }, ctx);
	assert.equal(result?.block, true);
	assert.match(result.reason, /current dispatch workflowz workers lack terminal settlement/);
});

test("landing state evaluates CI, reviews, holds, and mergeability together", () => {
	const ready = {
		id: 1, repo: "projectbluefin/review", ciStatus: "success", mergeState: "clean",
		reviewState: "approved", labels: [], type: "pr",
	};
	// Green, approved, clean, unheld is the only ready-to-land state.
	assert.equal(landingState(ready), "ready-to-land");
	// A requested-changes review blocks even with green CI and a clean merge.
	assert.equal(landingState({ ...ready, reviewState: "changes_requested" }), "review-blocked");
	// A hold label blocks even with green CI and an approval.
	assert.equal(landingState({ ...ready, labels: ["hold"] }), "held");
	assert.equal(landingState({ ...ready, labels: ["blocked"] }), "held");
	// A hold denied by a managed policy counts, not just the standard set.
	const policy = {
		managedRepositories: [{ repository: "projectbluefin/review", requiredLabels: [], deniedLabels: ["release-hold"] }],
	};
	assert.equal(landingState({ ...ready, labels: ["release-hold"] }, policy), "held");
	// Failing or pending CI blocks.
	assert.equal(landingState({ ...ready, ciStatus: "failure" }), "ci-failing");
	assert.equal(landingState({ ...ready, ciStatus: "pending" }), "ci-pending");
	// A dirty merge blocks.
	assert.equal(landingState({ ...ready, mergeState: "dirty" }), "conflicts");
	// Awaiting approval is not ready.
	assert.equal(landingState({ ...ready, reviewState: "review_required" }), "unreviewed");
	// An issue is not a landing target.
	assert.equal(landingState({ ...ready, type: "issue" }), "incomplete");
	// A hold is checked before CI, so a hold never reads as merely pending CI.
	assert.equal(landingState({ ...ready, ciStatus: "failure", labels: ["hold"] }), "held");
	// isLandingReady is true only for the complete state.
	assert.equal(isLandingReady(ready), true);
	assert.equal(isLandingReady({ ...ready, reviewState: "changes_requested" }), false);
	assert.equal(isLandingReady({ ...ready, labels: ["hold"] }), false);
	// The standard hold set is exported for callers that need it.
	assert.deepEqual([...HOLD_LABELS].sort(), ["blocked", "hold"]);
});

test("Slay landing guards cover GitHub MCP and Bash without requiring an existing approval to approve", async () => {
	const target = queueItem({ id: 7, repo: "projectbluefin/other", headSha: "7".repeat(40), reviewState: "approved", ciStatus: "success", labels: [] });
	const pi = fakeHost(); pi.flagValues.set("pr", "7");
	const ctx = fakeCtx(); ctx.ui.parent = ctx;
	const review = createReviewExtension(pi, { org: "projectbluefin", fetchImpl: landingGuardFetch([target]), env: ISOLATED_ENV });
	await pi.events.get("session_start")({}, ctx); await review.whenStarted();
	ctx.overlays[0].handleInput("s"); await new Promise((resolve) => setImmediate(resolve));
	const batch = pi.entries.filter((entry) => entry.customType === BATCH_ENTRY).at(-1).data;

	await completeReviewTask(pi, ctx);
	const guard = pi.events.get("tool_call");
	const mcp = (name, args) => guard({ toolName: "write", input: { path: `xd://mcp__github_${name}`, content: JSON.stringify({ owner: "projectbluefin", repo: "other", pullNumber: 7, ...args }) } }, ctx);
	const approve = () => mcp("pull_request_review_write", { method: "submit_pending", event: "APPROVE" });
	const merge = () => mcp("merge_pull_request", { merge_method: "squash", sha: target.headSha });
	target.ciStatus = "pending";
	for (const action of [approve, merge, () => guard({ toolName: "bash", input: { command: `gh pr merge 7 --repo projectbluefin/other --squash --match-head-commit ${target.headSha}` } }, ctx)]) {
		const blocked = await action();
		assert.equal(blocked?.block, true);
		assert.match(blocked.reason, /Review.*CI is pending/);
		assert.match(blocked.reason, /GitHub.*then.*\/review reconcile/i);
	}
	assert.equal(await mcp("pull_request_review_write", { method: "create" }), undefined, "creating a pending review is not approval");
	assert.equal(await mcp("pull_request_review_write", { method: "submit_pending", event: "COMMENT" }), undefined);
	assert.equal((await guard({ toolName: "write", input: { path: "xd://mcp__github_merge_pull_request", content: "{" } }, ctx))?.block, true);
	assert.equal(await guard({ toolName: "write", input: { path: "/tmp/notes", content: "{" } }, ctx), undefined);
	assert.equal((await guard({ toolName: "mcp__github__merge_pull_request", input: { owner: "projectbluefin", repo: "other", pullNumber: 7 } }, ctx))?.block, true);
	target.ciStatus = "success"; target.reviewState = "review_required";
	assert.equal(await approve(), undefined, "the first clean-head approval must not depend on an existing approval");
	assert.equal(await guard({ toolName: "bash", input: { command: "gh pr review 7 --repo projectbluefin/other --approve" } }, ctx), undefined);
	assert.match((await merge()).reason, /(?:approval|review)/i);
	target.reviewState = "approved";
	assert.equal(await merge(), undefined);
	for (const state of ["running", "paused", "blocked"]) {
		batch.state = state; target.labels = ["hold"];
		assert.match((await approve()).reason, /hold label/);
		assert.match((await merge()).reason, /hold label/);
	}
});

for (const surface of ["bash", "mcp", "xd"]) test(`Slay ${surface} landing guards check only the addressed PR`, async () => {
	const items = [
		queueItem({ id: 468, repo: "example/repo", headSha: "a".repeat(40), reviewState: "approved", ciStatus: "success" }),
		queueItem({ id: 467, repo: "example/repo", headSha: "b".repeat(40), ciStatus: "success" }),
	];
	const pi = fakeHost(); const ctx = fakeCtx(); ctx.ui.parent = ctx;
	const review = createReviewExtension(pi, { org: "example", fetchImpl: landingGuardFetch(items), env: ISOLATED_ENV });
	await pi.events.get("session_start")({}, ctx); await review.whenStarted();
	ctx.overlays[0].handleInput("A"); ctx.overlays[0].handleInput("s");
	await new Promise((resolve) => setImmediate(resolve));
	await completeReviewTask(pi, ctx, 2);
	const guard = pi.events.get("tool_call");
	const merge = (number) => {
		const item = items.find((candidate) => candidate.id === number);
		const args = { owner: "example", repo: "repo", pullNumber: number, merge_method: "squash", sha: item?.headSha ?? "a".repeat(40) };
		return guard(surface === "bash"
			? { toolName: "bash", input: { command: `gh pr merge ${number} --repo example/repo --squash --match-head-commit ${item?.headSha ?? "a".repeat(40)}` } }
			: surface === "mcp"
				? { toolName: "mcp__github_merge_pull_request", input: args }
				: { toolName: "write", input: { path: "xd://mcp__github_merge_pull_request", content: JSON.stringify(args) } }, ctx);
	};
	assert.equal(await merge(468), undefined, "an unrelated unreviewed PR must not block the approved target");
	assert.match((await merge(467)).reason, /example\/repo#467.*(?:approval|review)/i);
	assert.match((await merge(999)).reason, /outside the active wave/);
	if (surface === "bash") for (const command of [
		"gh pr merge 468 --repo example/repo | gh pr merge 467 --repo example/repo",
		"gh pr merge 468 --repo example/repo & gh pr merge 467 --repo example/repo",
		"gh pr merge 468 --repo example/repo -R example/other",
		"gh pr merge 468 --repo example/repo -Rother/repo",
		'gh pr merge "468"9 --repo example/repo',
		'gh pr merge 468 --repo "example/repo"other',
		'gh pr merge 468 --repo example/repo "--repo" other/repo',
		'gh pr merge 468 --repo example/repo --re"po" other/repo',
		'gh pr merge 468 --repo example/repo -"R"other/repo',
		"gh pr merge 468 --repo example/repo -sRother/repo",
		"gh pr merge https://github.com/example/repo/pull/468 --repo other/repo",
		"gh pr merge $PR --repo example/repo",
	]) assert.equal((await guard({ toolName: "bash", input: { command } }, ctx))?.block, true, command);
});

for (const scenario of ["approved", "stale", "self", "changes-requested", "incomplete", "unreadable"]) test(`Slay merge verifies exact-head review evidence when aggregate decision is absent: ${scenario}`, async () => {
	const item = queueItem({ id: 468, repo: "example/repo", author: "contributor", url: "https://github.com/example/repo/pull/468", headSha: "a".repeat(40), ciStatus: "success" });
	const effect = {
		state: "OPEN", merged: false, headSha: item.headSha, autoMerge: false, reviewDecision: null,
		reviewsIncomplete: scenario === "incomplete", reviews: [],
	};
	const pi = fakeHost(); const ctx = fakeCtx(); ctx.ui.parent = ctx;
	const humanReviewObserver = async (repository, number) => {
		if (scenario === "incomplete" || scenario === "unreadable") return { kind: "unknown", reason: "fixture does not have complete human-review evidence" };
		const current = effect.reviews.filter((review) => review.state === "APPROVED" && review.author.login.toLowerCase() !== item.author.toLowerCase() && review.commit?.oid === effect.headSha);
		return { kind: "observed", facts: {
			repository, number, headSha: effect.headSha, baseRef: "main", authorLogin: item.author, viewerLogin: "maintainer", canMerge: true,
			requiredApprovals: 0, requiresCodeOwnerReview: false, requiresLastPushApproval: false,
			githubReviewState: scenario === "changes-requested" ? "changes_requested" : "none",
			currentHumanApprovals: current.map((review) => ({ login: review.author.login, headSha: review.commit.oid, submittedAt: Date.parse(review.submittedAt) })),
			digest: `exact-head:${scenario}:${effect.headSha}`, observedAt: Date.now(),
		} };
	};
	const review = createReviewExtension(pi, { org: "example", fetchImpl: recoveredPrSlayFetch([item], { 468: effect }, { unreadable: scenario === "unreadable" }), env: ISOLATED_ENV, humanReviewObserver });
	await pi.events.get("session_start")({}, ctx); await review.whenStarted();
	ctx.overlays[0].handleInput("s"); await new Promise((resolve) => setImmediate(resolve));
	await completeReviewTask(pi, ctx);
	effect.reviews.push({ state: scenario === "changes-requested" ? "CHANGES_REQUESTED" : "APPROVED", submittedAt: new Date(Date.now() + 1).toISOString(), author: { login: scenario === "self" ? "contributor" : "maintainer" }, commit: { oid: scenario === "stale" ? "b".repeat(40) : item.headSha } });
	const result = await pi.events.get("tool_call")({ toolName: "bash", input: { command: `gh pr merge 468 --repo example/repo --squash --match-head-commit ${item.headSha}` } }, ctx);
	if (scenario === "approved") assert.equal(result, undefined, "a complete current-head approval is valid without an aggregate policy decision");
	else assert.equal(result?.block, true, "ambiguous, stale, self or blocking reviews must retain the landing gate");
});

test("landing reason names the blocker for gates and the UI", () => {
	assert.equal(landingReason("ci-failing"), "CI is failure");
	assert.equal(landingReason("ci-pending"), "CI is pending");
	assert.equal(landingReason("review-blocked"), "has a changes_requested review");
	assert.equal(landingReason("held"), "has a hold label");
	assert.equal(landingReason("conflicts"), "has conflicts with the base");
	assert.equal(landingReason("unreviewed"), "is awaiting approval");
	assert.equal(landingReason("incomplete"), "is not a pull request");
	assert.equal(landingReason("ready-to-land"), "");
});


test("RAW_KEYS normalizes Alt-S and Alt-B chords", () => {
	assert.equal(canonicalKey("\u001bs", rawKeyMatcher), "alt+s");
	assert.equal(canonicalKey("\u001bb", rawKeyMatcher), "alt+b");
	assert.equal(canonicalKey("\u001bu", rawKeyMatcher), "alt+u");
});

test("comment action previews once, revalidates live state, executes argv, and persists a receipt", async () => {
	const items = [{ id: 42, repo: "projectbluefin/review", title: "comment target", headSha: "a".repeat(40) }];
	const pi = fakeHost();
	const ctx = fakeCtx();
	ctx.ui.parent = ctx;
	ctx.editorResponses.push("Evidence-backed comment");
	const review = createReviewExtension(pi, {
		org: "projectbluefin",
		fetchImpl: hiveBackedFetch(items),
		env: { ...ISOLATED_ENV, HIVE_HUB: "wss://hive.example/contribute" },
	});
	await pi.events.get("session_start")({}, ctx);
	await review.whenStarted();
	const dashboard = ctx.overlays[0];
	dashboard.handleInput("c");
	await new Promise((resolve) => setImmediate(resolve));

	assert.equal(ctx.overlays.length, 1, "comment action keeps the workbench mounted");
	assert.equal(ctx.confirmations.length, 1, "one immutable plan is confirmed once");
	assert.match(ctx.confirmations[0].message, /projectbluefin\/review#42/);
	assert.deepEqual(pi.execCalls, [{
		command: "gh",
		args: ["pr", "comment", "42", "--repo", "projectbluefin/review", "--body", "Evidence-backed comment"],
	}]);
	const receipt = pi.entries.filter((entry) => entry.customType === COMMENT_ENTRY).at(-1).data;
	assert.equal(receipt.state, "complete");
	assert.deepEqual(receipt.receipts, [pi.execResult.stdout.trim()]);
});

test("comment batches revalidate later heads and retain partial receipts", async () => {
	const items = [
		{ id: 42, repo: "projectbluefin/review", title: "first target", headSha: "a".repeat(40) },
		{ id: 43, repo: "projectbluefin/review", title: "later target", headSha: "b".repeat(40) },
	];
	const pi = fakeHost();
	const execute = pi.exec.bind(pi);
	pi.exec = async (command, args) => {
		const result = await execute(command, args);
		items[1].headSha = "c".repeat(40);
		return result;
	};
	const ctx = fakeCtx();
	ctx.editorResponses.push("Review evidence");
	const review = createReviewExtension(pi, {
		org: "projectbluefin",
		fetchImpl: (url, init) => hiveBackedFetch(items)(url, init),
		env: { ...ISOLATED_ENV, HIVE_HUB: "wss://hive.example/contribute" },
	});
	await pi.events.get("session_start")({}, ctx);
	await review.whenStarted();
	ctx.overlays[0].handleInput("A");
	ctx.overlays[0].handleInput("c");
	const { promise, resolve } = Promise.withResolvers<void>();
	setImmediate(resolve);
	await promise;

	assert.equal(pi.execCalls.length, 1, "a changed second head must not receive the stale comment");
	assert.equal(pi.execCalls[0].args[2], "42");
	const receipt = pi.entries.filter((entry) => entry.customType === COMMENT_ENTRY).at(-1).data;
	assert.equal(receipt.state, "failed");
	assert.match(receipt.error, /PR head changed/);
	assert.deepEqual(receipt.receipts, [pi.execResult.stdout.trim()]);
});

test("pinned OMP agent_end advances repository waves only after final settlement", async () => {
	const items = {
		"projectbluefin/a#1": { title: "a one", submittedPrs: [] },
		"projectbluefin/a#2": { title: "a two", submittedPrs: [] },
		"projectbluefin/b#3": { title: "b one", submittedPrs: [] },
	};
	const pi = fakeHost();
	pi.flagValues.set("issues", true);
	const ctx = fakeCtx();
	ctx.ui.parent = ctx;
	const review = createReviewExtension(pi, {
		org: "projectbluefin",
		fetchImpl: issueBackedFetch(items),
		env: { ...ISOLATED_ENV, HIVE_HUB: "wss://hive.example/contribute" },
	});
	await pi.events.get("session_start")({}, ctx);
	await review.whenStarted();
	const dashboard = ctx.overlays[0];
	dashboard.handleInput("A");
	dashboard.handleInput("s");
	await new Promise((resolve) => setImmediate(resolve));

	assert.equal(pi.messages.length, 1);
	const dispatchedBatch = pi.entries.filter((entry) => entry.customType === BATCH_ENTRY).at(-1).data;
	assert.equal(pi.messageOptions[0]?.waveId, `${dispatchedBatch.id}:0`, "dispatch carries exact wave identity to OMP");
	pi.events.get("tool_call")({ toolCallId: "worker-1", toolName: "task", input: { isolated: false } }, ctx);
	ctx.asyncJobs.delivery.pendingJobIds = ["worker-1"];
	ctx.asyncJobs.recent = [{ id: "worker-1", status: "completed", startTime: Date.now() + 1 }];
	observeTask(pi, ctx, "worker-1", "worker-1");
	await pi.events.get("turn_end")({}, ctx);
	pi.events.get("tool_call")({ toolCallId: "worker-2", toolName: "task", input: { isolated: false } }, ctx);
	ctx.asyncJobs.delivery.pendingJobIds = ["worker-1", "worker-2"];
	ctx.asyncJobs.recent = [
		{ id: "worker-1", status: "completed", startTime: Date.now() + 1 },
		{ id: "worker-2", status: "completed", startTime: Date.now() + 2 },
	];
	observeTask(pi, ctx, "worker-2", "worker-2");
	await pi.events.get("turn_end")({}, ctx);
	const captured = pi.entries.filter((entry) => entry.customType === BATCH_ENTRY).at(-1).data;
	assert.deepEqual(captured.waveJobIds, ["worker-1", "worker-2"], "staggered workers are accumulated by exact wave identity");
	assert.match(pi.messages[0], /Implement this repository wave for projectbluefin\/a, opening one review-ready pull request per issue/);
	assert.match(pi.messages[0], /projectbluefin\/a/);
	assert.doesNotMatch(pi.messages[0], /projectbluefin\/b/);

	ctx.asyncJobs.recent = [{ id: "hive-wave", status: "completed", startTime: Date.now() + 1 }];
	await pi.events.get("agent_end")({ willContinue: true }, ctx);
	assert.equal(pi.messages.length, 1, "an OMP continuation must not admit another repository");
	ctx.asyncJobs.running = [{ id: "still-running", status: "running", startTime: Date.now() + 1 }];
	await pi.events.get("agent_end")({}, ctx);
	assert.equal(pi.messages.length, 1, "unfinished workers must settle before another repository starts");
	ctx.asyncJobs.running = [];
	await pi.events.get("agent_end")({}, ctx);
	assert.equal(pi.messages.length, 1, "pending async-result deliveries must hold repository advancement");

	dashboard.handleInput("p");
	ctx.asyncJobs.recent = [{ id: "hive-wave", status: "completed", startTime: Date.now() + 1 }];
	await pi.events.get("agent_end")({}, ctx);
	assert.equal(pi.messages.length, 1, "pause prevents the next repository from starting");
	dashboard.handleInput("p");
	await new Promise((resolve) => setImmediate(resolve));
	assert.equal(pi.messages.length, 1, "resume waits for pending async-result deliveries");
	await deliverTaskResults(pi, ctx, ["worker-1", "worker-2"]);
	await pi.events.get("agent_end")({}, ctx);
	assert.equal(pi.messages.length, 2, JSON.stringify(pi.entries.filter((entry) => entry.customType === BATCH_ENTRY).at(-1)?.data));
	assert.match(pi.messages[1], /projectbluefin\/b/);
	assert.doesNotMatch(pi.messages[1], /projectbluefin\/a/);

	ctx.asyncJobs.recent = [{ id: "hive-wave-2", status: "completed", startTime: Date.now() + 1 }];
	observeTask(pi, ctx, "hive-wave-2");
	await pi.events.get("agent_end")({}, ctx);
	const batches = pi.entries.filter((entry) => entry.customType === BATCH_ENTRY).map((entry) => entry.data);
	assert.equal(batches.at(-1).state, "complete");
	assert.equal(batches.at(-1).completedItems, 3);
	assert.ok(dashboard.render(120).some((line) => line.includes("3/3 terminal")));
});

test("a slay wave blocks when review jobs leave pull requests open", async () => {
	const item = { id: 42, repo: "projectbluefin/review", title: "reviewed but not landed", headSha: "a".repeat(40) };
	const pi = fakeHost();
	const ctx = fakeCtx();
	ctx.ui.parent = ctx;
	const review = createReviewExtension(pi, {
		org: "projectbluefin",
		fetchImpl: hiveBackedFetch([item]),
		env: { ...ISOLATED_ENV, HIVE_HUB: "wss://hive.example/contribute" },
	});
	await pi.events.get("session_start")({}, ctx);
	await review.whenStarted();
	ctx.overlays[0].handleInput("s");
	await new Promise((resolve) => setImmediate(resolve));
	ctx.asyncJobs.recent = [{ id: "review-only", status: "completed", startTime: Date.now() + 1 }];
	observeTask(pi, ctx, "review-only");
	await pi.events.get("agent_end")({}, ctx);

	const batch = pi.entries.filter((entry) => entry.customType === BATCH_ENTRY).at(-1).data;
	assert.equal(batch.state, "blocked");
	assert.match(batch.error, /projectbluefin\/review#42/);
	assert.match(savedReviewNoticeText(pi), /Review couldn’t complete this step/);
	assert.match(await runReviewCommand(pi, ctx, "details"), /remain open without auto-merge/);
});



test("a failed workflowz job blocks later repository waves", async () => {
	const items = [
		{ id: 1, repo: "projectbluefin/a", title: "a one" },
		{ id: 2, repo: "projectbluefin/a", title: "a two" },
		{ id: 3, repo: "projectbluefin/b", title: "b one" },
	];
	const pi = fakeHost();
	const ctx = fakeCtx();
	ctx.ui.parent = ctx;
	const review = createReviewExtension(pi, {
		org: "projectbluefin",
		fetchImpl: hiveBackedFetch(items),
		env: { ...ISOLATED_ENV, HIVE_HUB: "wss://hive.example/contribute" },
	});
	await pi.events.get("session_start")({}, ctx);
	await review.whenStarted();
	const dashboard = ctx.overlays[0];
	dashboard.handleInput("A");
	dashboard.handleInput("s");
	await new Promise((resolve) => setImmediate(resolve));
	ctx.asyncJobs.recent = [{ id: "failed-worker", status: "failed", startTime: Date.now() + 1 }];
	observeTask(pi, ctx, "failed-worker");
	await pi.events.get("agent_end")({}, ctx);

	assert.equal(pi.messages.length, 1, "a failed wave never advances to the next repository");
	const slay = pi.entries.filter((entry) => entry.customType === BATCH_ENTRY).at(-1).data;
	assert.equal(slay.state, "blocked");
	assert.match(slay.error, /workflowz job.*failed/);
});
test("restart blocks interrupted slays and never replays confirmed comments", async () => {
	const item = { id: 42, repo: "projectbluefin/review", title: "recover safely", headSha: "a".repeat(40) };
	const commentPlan = createCommentActionPlan([
		{ repo: item.repo, number: item.id, type: "pull_request", headSha: item.headSha },
	], "Do not replay me", 100);
	const pi = fakeHost();
	const ctx = fakeCtx();
	ctx.ui.parent = ctx;
	ctx.sessionManager = {
		getBranch: () => [
			{ type: "custom", customType: STATE_ENTRY, data: { mode: "prs" } },
			{
				type: "custom",
				customType: BATCH_ENTRY,
				data: {
					version: 1,
					id: "slay-old",
					kind: "slay",
					waves: [{ repo: item.repo, items: [{ ...item, type: "pr" }] }],
					currentWave: 0,
					completedItems: 0,
					totalItems: 1,
					state: "running",
					startedAt: 50,
					waveStartedAt: 60,
				},
			},
			{ type: "custom", customType: COMMENT_ENTRY, data: { version: 1, state: "confirmed", plan: commentPlan } },
		],
	};
	const review = createReviewExtension(pi, {
		org: "projectbluefin",
		fetchImpl: hiveBackedFetch([item]),
		env: { ...ISOLATED_ENV, HIVE_HUB: "wss://hive.example/contribute" },
	});
	await pi.events.get("session_start")({}, ctx);
	await review.whenStarted();

	assert.equal(pi.execCalls.length, 0, "confirmed comments are never replayed after restart");
	assert.equal(pi.messages.length, 0, "interrupted repository waves are never replayed");
	assert.match(savedReviewNoticeText(pi), /A planned comment was not posted/);
	assert.match(await runReviewCommand(pi, ctx, "details"), /interrupted comment plan was not replayed/);
	const recovered = pi.entries.filter((entry) => entry.customType === BATCH_ENTRY).at(-1).data;
	assert.equal(recovered.state, "blocked");
	assert.match(recovered.error, /session ended/);
	assert.ok(ctx.overlays[0].render(240).some((line) => line.includes("BLOCKED")));
});

test("pre-tool coordinator failure is durable evidence for explicit recovery without completing the wave", async () => {
	const states = { "projectbluefin/review#77": { title: "pre-tool failure", submittedPrs: [] } };
	const env = { ...ISOLATED_ENV, REVIEW_MODE: "review" };
	const pi = fakeHost();
	pi.flagValues.set("issues", true);
	const ctx = fakeCtx();
	ctx.ui.parent = ctx;
	const review = createReviewExtension(pi, { org: "projectbluefin", fetchImpl: issueBackedFetch(states), env });
	await pi.events.get("session_start")({}, ctx);
	await review.whenStarted();
	ctx.overlays[0].handleInput("A");
	ctx.overlays[0].handleInput("f");
	for (let i = 0; i < 20; i++) await Promise.resolve();
	const running = pi.entries.filter((entry) => entry.customType === BATCH_ENTRY).at(-1).data;
	const assistantError = {
		role: "assistant",
		content: [{ type: "text", text: "Fixture configuration failure before any tool invocation" }],
		stopReason: "error",
		errorMessage: "Fixture configuration failure before any tool invocation",
	};
	const userMessage = { role: "user", content: [{ type: "text", text: pi.messages.at(-1) }] };
	ctx.sessionManager = {
		getBranch: () => [
			{ type: "custom", customType: BATCH_ENTRY, data: running },
			{ type: "message", message: userMessage },
			{ type: "message", message: assistantError },
		],
	};
	await pi.events.get("agent_end")({ messages: [userMessage, assistantError] }, ctx);

	const blocked = pi.entries.filter((entry) => entry.customType === BATCH_ENTRY).at(-1).data;
	assert.equal(blocked.state, "blocked");
	assert.equal(blocked.wavePreToolTerminal, "error");
	assert.deepEqual(blocked.waveToolInvocationIds, []);
	assert.match(blocked.error, /before any tool invocation/);
	assert.equal(new ResourceClaims(env.LUNA_FACTORY_STATE_ROOT, env.LUNA_FACTORY_CLAIMS_ROOT).list().every((claim) => claim.status === "unknown"), true);

	const interruptedAfterProof = { ...blocked, state: "running" };
	saveWave(env.LUNA_FACTORY_CLAIMS_ROOT, interruptedAfterProof);
	const restarted = fakeHost();
	const next = fakeCtx();
	next.ui.parent = next;
	next.sessionManager = {
		getBranch: () => [
			...pi.entries.map((entry) => ({ type: "custom", customType: entry.customType, data: entry.data })),
			{ type: "custom", customType: BATCH_ENTRY, data: interruptedAfterProof },
		],
	};
	const restored = createReviewExtension(restarted, { org: "projectbluefin", fetchImpl: issueBackedFetch(states), env });
	await restarted.events.get("session_start")({}, next);
	await restored.whenStarted();
	assert.equal(restarted.entries.filter((entry) => entry.customType === BATCH_ENTRY).at(-1).data.state, "blocked");
	assert.equal(new ResourceClaims(env.LUNA_FACTORY_STATE_ROOT, env.LUNA_FACTORY_CLAIMS_ROOT).list().length, 2, "restart leaves pre-tool recovery for explicit operator action");
	await runReviewCommand(restarted, next, "reconcile");

	const claims = new ResourceClaims(env.LUNA_FACTORY_STATE_ROOT, env.LUNA_FACTORY_CLAIMS_ROOT);
	assert.equal(claims.list().length, 0);
	const recovered = restarted.entries.filter((entry) => entry.customType === BATCH_ENTRY).at(-1).data;
	assert.equal(recovered.state, "cancelled");
	assert.notEqual(recovered.state, "complete");
});

async function preToolFailureFixture(submittedPrs: string[] = [], fetchFactory = issueBackedFetch, kind = "fix") {
	const states = { "projectbluefin/review#77": { title: "pre-tool failure", submittedPrs } };
	const env = { ...ISOLATED_ENV, REVIEW_MODE: "review" };
	const pi = fakeHost();
	pi.flagValues.set("issues", true);
	const ctx = fakeCtx();
	ctx.ui.parent = ctx;
	const review = createReviewExtension(pi, { org: "projectbluefin", fetchImpl: fetchFactory(states), env });
	await pi.events.get("session_start")({}, ctx);
	await review.whenStarted();
	if (kind === "slay") await pi.commands.get("review").handler("slay", ctx);
	else {
		ctx.overlays[0].handleInput("A");
		ctx.overlays[0].handleInput("f");
	}
	for (let i = 0; i < 20; i++) await Promise.resolve();
	const running = pi.entries.filter((entry) => entry.customType === BATCH_ENTRY).at(-1).data;
	const assistantError = {
		role: "assistant",
		content: [{ type: "text", text: "Fixture configuration failure before any tool invocation" }],
		stopReason: "error",
		errorMessage: "Fixture configuration failure before any tool invocation",
	};
	const userMessage = { role: "user", content: [{ type: "text", text: pi.messages.at(-1) }] };
	ctx.sessionManager = {
		getBranch: () => [
			{ type: "custom", customType: BATCH_ENTRY, data: running },
			{ type: "message", message: userMessage },
			{ type: "message", message: assistantError },
		],
	};
	ctx.sessionManager.getSessionId = () => ctx.sessionId;
	return { states, env, pi, ctx, review, running, assistantError, userMessage };
}

test("retrying a claimed pre-tool failure preserves its original recovery proof", async () => {
	const fixture = await preToolFailureFixture([], issueBackedFetch, "slay");
	await fixture.pi.events.get("agent_end")({ messages: [fixture.userMessage, fixture.assistantError] }, fixture.ctx);
	const blocked = fixture.pi.entries.filter((entry) => entry.customType === BATCH_ENTRY).at(-1).data;
	const owner = `review:${blocked.waveIdentity}`;
	const saved = loadWave(fixture.env.LUNA_FACTORY_CLAIMS_ROOT, owner);
	const claims = new ResourceClaims(fixture.env.LUNA_FACTORY_STATE_ROOT, fixture.env.LUNA_FACTORY_CLAIMS_ROOT);
	const before = claims.list();
	for (let retry = 0; retry < 2; retry++) {
		await fixture.pi.commands.get("review").handler("slay", fixture.ctx);
		assert.deepEqual(loadWave(fixture.env.LUNA_FACTORY_CLAIMS_ROOT, owner), saved);
		assert.deepEqual(claims.list(), before);
		assert.equal(fixture.pi.messages.length, 1);
	}
	await runReviewCommand(fixture.pi, fixture.ctx, "reconcile");
	assert.equal(claims.list().length, 0, "the original proof still permits explicit reconciliation");
	assert.equal(loadWave(fixture.env.LUNA_FACTORY_CLAIMS_ROOT, owner).state, "cancelled");
});

test("retrying a claimed worker failure preserves its native worker evidence", async () => {
	const fixture = await preToolFailureFixture([], issueBackedFetch, "slay");
	fixture.pi.events.get("tool_call")({ toolCallId: "worker-call", toolName: "task", input: {} }, fixture.ctx);
	await fixture.pi.events.get("agent_end")({}, fixture.ctx);
	const blocked = fixture.pi.entries.filter((entry) => entry.customType === BATCH_ENTRY).at(-1).data;
	const saved = loadWave(fixture.env.LUNA_FACTORY_CLAIMS_ROOT, `review:${blocked.waveIdentity}`);
	await fixture.pi.commands.get("review").handler("slay", fixture.ctx);
	assert.deepEqual(loadWave(fixture.env.LUNA_FACTORY_CLAIMS_ROOT, `review:${blocked.waveIdentity}`), saved);
	assert.equal(fixture.pi.messages.length, 1);
	assert.equal(new ResourceClaims(fixture.env.LUNA_FACTORY_STATE_ROOT, fixture.env.LUNA_FACTORY_CLAIMS_ROOT).list().length, 2);
});

test("a live admission blocker on retry preserves the claimed dispatch evidence", async () => {
	const fixture = await preToolFailureFixture([], issueBackedFetch, "slay");
	await fixture.pi.events.get("agent_end")({ messages: [fixture.userMessage, fixture.assistantError] }, fixture.ctx);
	const owner = `review:${fixture.running.waveIdentity}`;
	const saved = loadWave(fixture.env.LUNA_FACTORY_CLAIMS_ROOT, owner);
	fixture.states["projectbluefin/review#77"].submittedPrs = ["projectbluefin/review#10"];
	await fixture.pi.commands.get("review").handler("slay", fixture.ctx);
	assert.deepEqual(loadWave(fixture.env.LUNA_FACTORY_CLAIMS_ROOT, owner), saved);
	assert.equal(fixture.pi.messages.length, 1);
	assert.match(savedReviewNoticeText(fixture.pi), /Review couldn’t complete this step/);
	assert.match(await runReviewCommand(fixture.pi, fixture.ctx, "details"), /pull request already submitted/);
	assert.equal(new ResourceClaims(fixture.env.LUNA_FACTORY_STATE_ROOT, fixture.env.LUNA_FACTORY_CLAIMS_ROOT).list().length, 2);
});

test("a Slay claim conflict never records an undispatched prompt as an owned wave", async () => {
	const env = { ...ISOLATED_ENV, REVIEW_MODE: "review" };
	const pi = fakeHost(); pi.flagValues.set("issues", true);
	const ctx = fakeCtx(); ctx.ui.parent = ctx;
	const claims = new ResourceClaims(env.LUNA_FACTORY_STATE_ROOT, env.LUNA_FACTORY_CLAIMS_ROOT);
	claims.claim("repo:projectbluefin/review", "another-owner");
	const before = claims.list();
	const review = createReviewExtension(pi, { org: "projectbluefin", fetchImpl: issueBackedFetch({ "projectbluefin/review#77": { title: "claim conflict", submittedPrs: [] } }), env });
	await pi.events.get("session_start")({}, ctx);
	await review.whenStarted();
	await pi.commands.get("review").handler("slay", ctx);
	const blocked = pi.entries.filter((entry) => entry.customType === BATCH_ENTRY).at(-1).data;
	assert.equal(blocked.state, "blocked");
	assert.equal(blocked.waveIdentity, undefined);
	assert.equal(blocked.wavePromptDigest, undefined);
	assert.equal(pi.messages.length, 0);
	assert.deepEqual(claims.list(), before);
});

test("mutation admission saves its recovery subject before acquiring claims", async () => {
	const claim = ResourceClaims.prototype.claim;
	let observed = 0;
	ResourceClaims.prototype.claim = function(resource, owner, allowExisting) {
		const pending = loadWave(ISOLATED_ENV.LUNA_FACTORY_CLAIMS_ROOT, owner);
		assert.ok(pending, "the first acquired resource must already have a durable recovery record");
		assert.equal(pending.state, "blocked");
		assert.equal(pending.waveSessionId, undefined);
		assert.equal(pending.wavePromptDigest, undefined);
		assert.ok(pending.waveEffectResources.includes(resource.toLowerCase()));
		observed++;
		return claim.call(this, resource, owner, allowExisting);
	};
	try {
		const fixture = await preToolFailureFixture([], issueBackedFetch, "slay");
		assert.equal(observed, 2);
		assert.equal(fixture.pi.messages.length, 1);
	} finally {
		ResourceClaims.prototype.claim = claim;
	}
});

test("tool invocation without a job keeps the Review claims UNKNOWN", async () => {
	const fixture = await preToolFailureFixture();
	fixture.pi.events.get("tool_call")({ toolCallId: "bash-call", toolName: "bash", input: { command: "true" } }, fixture.ctx);
	await fixture.pi.events.get("agent_end")({ messages: [fixture.userMessage, fixture.assistantError] }, fixture.ctx);

	const blocked = fixture.pi.entries.filter((entry) => entry.customType === BATCH_ENTRY).at(-1).data;
	assert.equal(blocked.state, "blocked");
	assert.equal(blocked.wavePreToolTerminal, undefined);
	assert.deepEqual(blocked.waveToolInvocationIds, ["bash-call"]);
	assert.equal(new ResourceClaims(fixture.env.LUNA_FACTORY_STATE_ROOT, fixture.env.LUNA_FACTORY_CLAIMS_ROOT).list().every((claim) => claim.status === "unknown"), true);
});

test("a started job without terminal evidence remains an unaccounted UNKNOWN worker", async () => {
	const fixture = await preToolFailureFixture();
	fixture.pi.events.get("tool_call")({ toolCallId: "task-call", toolName: "task", input: { isolated: false } }, fixture.ctx);
	fixture.ctx.asyncJobs.running = [{ id: "job-1", agentId: "Worker", type: "task", status: "running", startTime: Date.now() }];
	fixture.pi.events.get("tool_result")({ toolCallId: "task-call", details: {
		async: { type: "task", state: "running", jobId: "job-1" },
		progress: [{ id: "Worker", index: 0, status: "running" }],
	} }, fixture.ctx);
	fixture.ctx.asyncJobs.running = [];
	fixture.ctx.asyncJobs.recent = [];
	await fixture.pi.events.get("agent_end")({}, fixture.ctx);

	const blocked = fixture.pi.entries.filter((entry) => entry.customType === BATCH_ENTRY).at(-1).data;
	assert.deepEqual(blocked.waveJobIds, ["job-1"]);
	assert.deepEqual(blocked.waveTerminalJobStatuses, {});
	assert.equal(blocked.state, "blocked");
	await fixture.pi.commands.get("review").handler("cancel", fixture.ctx);
	const cancelled = fixture.ctx.notifications.at(-1)?.message ?? "";
	assert.match(cancelled, /unaccounted worker/i);
	assert.equal(new ResourceClaims(fixture.env.LUNA_FACTORY_STATE_ROOT, fixture.env.LUNA_FACTORY_CLAIMS_ROOT).list().length, 2);
});

test("an unrelated terminal assistant message cannot settle the active Review wave", async () => {
	const fixture = await preToolFailureFixture();
	const foreignUser = { role: "user", content: [{ type: "text", text: "foreign prompt with the same provider error" }] };
	fixture.ctx.sessionManager = {
		getBranch: () => [
			{ type: "custom", customType: BATCH_ENTRY, data: fixture.running },
			{ type: "message", message: foreignUser },
			{ type: "message", message: fixture.assistantError },
		],
	};
	await fixture.pi.events.get("agent_end")({ messages: [foreignUser, fixture.assistantError] }, fixture.ctx);

	const blocked = fixture.pi.entries.filter((entry) => entry.customType === BATCH_ENTRY).at(-1).data;
	assert.equal(blocked.wavePreToolTerminal, undefined);
	assert.equal(new ResourceClaims(fixture.env.LUNA_FACTORY_STATE_ROOT, fixture.env.LUNA_FACTORY_CLAIMS_ROOT).list().every((claim) => claim.status === "unknown"), true);
});

test("a foreign user message after the matched dispatch prevents pre-tool proof", async () => {
	const fixture = await preToolFailureFixture();
	const foreignUser = { role: "user", content: [{ type: "text", text: "another request" }] };
	fixture.ctx.sessionManager = {
		getBranch: () => [
			{ type: "custom", customType: BATCH_ENTRY, data: fixture.running },
			{ type: "message", message: fixture.userMessage },
			{ type: "message", message: foreignUser },
			{ type: "message", message: fixture.assistantError },
		],
	};
	await fixture.pi.events.get("agent_end")({ messages: [fixture.userMessage, foreignUser, fixture.assistantError] }, fixture.ctx);

	const blocked = fixture.pi.entries.filter((entry) => entry.customType === BATCH_ENTRY).at(-1).data;
	assert.equal(blocked.wavePreToolTerminal, undefined);
	assert.equal(new ResourceClaims(fixture.env.LUNA_FACTORY_STATE_ROOT, fixture.env.LUNA_FACTORY_CLAIMS_ROOT).list().every((claim) => claim.status === "unknown"), true);
});

test("an earlier assistant error followed by a successful final assistant cannot prove pre-tool failure", async () => {
	const fixture = await preToolFailureFixture();
	const success = { role: "assistant", content: [{ type: "text", text: "completed" }], stopReason: "stop" };
	fixture.ctx.sessionManager = {
		getBranch: () => [
			{ type: "custom", customType: BATCH_ENTRY, data: fixture.running },
			{ type: "message", message: fixture.userMessage },
			{ type: "message", message: fixture.assistantError },
			{ type: "message", message: success },
		],
	};
	await fixture.pi.events.get("agent_end")({ messages: [fixture.userMessage, fixture.assistantError, success] }, fixture.ctx);

	const blocked = fixture.pi.entries.filter((entry) => entry.customType === BATCH_ENTRY).at(-1).data;
	assert.equal(blocked.wavePreToolTerminal, undefined);
	assert.equal(new ResourceClaims(fixture.env.LUNA_FACTORY_STATE_ROOT, fixture.env.LUNA_FACTORY_CLAIMS_ROOT).list().every((claim) => claim.status === "unknown"), true);
});

test("a terminal error without the acknowledged wave prompt cannot prove pre-tool failure", async () => {
	const fixture = await preToolFailureFixture();
	await fixture.pi.events.get("agent_end")({ messages: [fixture.assistantError] }, fixture.ctx);

	const blocked = fixture.pi.entries.filter((entry) => entry.customType === BATCH_ENTRY).at(-1).data;
	assert.equal(blocked.wavePreToolTerminal, undefined);
	assert.equal(new ResourceClaims(fixture.env.LUNA_FACTORY_STATE_ROOT, fixture.env.LUNA_FACTORY_CLAIMS_ROOT).list().every((claim) => claim.status === "unknown"), true);
});

test("tools from prior conversation history do not invalidate the current wave proof", async () => {
	const fixture = await preToolFailureFixture();
	const priorReadOnlyTurn = { role: "assistant", content: [{ type: "toolCall", id: "old-read", name: "review_workbench_status", arguments: {} }] };
	fixture.ctx.sessionManager = {
		getBranch: () => [
			{ type: "custom", customType: BATCH_ENTRY, data: fixture.running },
			{ type: "message", message: priorReadOnlyTurn },
			{ type: "message", message: fixture.userMessage },
			{ type: "message", message: fixture.assistantError },
		],
	};
	await fixture.pi.events.get("agent_end")({ messages: [priorReadOnlyTurn, fixture.userMessage, fixture.assistantError] }, fixture.ctx);

	assert.equal(fixture.pi.entries.filter((entry) => entry.customType === BATCH_ENTRY).at(-1).data.wavePreToolTerminal, "error");
});

test("a pre-tool proof does not release claims after an observed external effect", async () => {
	const fixture = await preToolFailureFixture();
	await fixture.pi.events.get("agent_end")({ messages: [fixture.userMessage, fixture.assistantError] }, fixture.ctx);
	fixture.states["projectbluefin/review#77"].submittedPrs = ["projectbluefin/review#10"];

	const restarted = fakeHost();
	const next = fakeCtx();
	next.ui.parent = next;
	next.sessionManager = {
		getBranch: () => [
			...fixture.pi.entries.map((entry) => ({ type: "custom", customType: entry.customType, data: entry.data })),
			{ type: "message", message: fixture.userMessage },
			{ type: "message", message: fixture.assistantError },
		],
	};
	const restored = createReviewExtension(restarted, { org: "projectbluefin", fetchImpl: issueBackedFetch(fixture.states), env: fixture.env });
	await restarted.events.get("session_start")({}, next);
	await restored.whenStarted();
	await runReviewCommand(restarted, next, "reconcile");

	assert.equal(new ResourceClaims(fixture.env.LUNA_FACTORY_STATE_ROOT, fixture.env.LUNA_FACTORY_CLAIMS_ROOT).list().length, 2);
});

test("two submitted pull requests also keep a pre-tool wave UNKNOWN", async () => {
	const fixture = await preToolFailureFixture();
	await fixture.pi.events.get("agent_end")({ messages: [fixture.userMessage, fixture.assistantError] }, fixture.ctx);
	fixture.states["projectbluefin/review#77"].submittedPrs = ["projectbluefin/review#10", "projectbluefin/review#11"];

	const restarted = fakeHost();
	const next = fakeCtx();
	next.ui.parent = next;
	next.sessionManager = {
		getBranch: () => [
			...fixture.pi.entries.map((entry) => ({ type: "custom", customType: entry.customType, data: entry.data })),
			{ type: "message", message: fixture.userMessage },
			{ type: "message", message: fixture.assistantError },
		],
	};
	const restored = createReviewExtension(restarted, { org: "projectbluefin", fetchImpl: issueBackedFetch(fixture.states), env: fixture.env });
	await restarted.events.get("session_start")({}, next);
	await restored.whenStarted();
	await runReviewCommand(restarted, next, "reconcile");

	assert.equal(new ResourceClaims(fixture.env.LUNA_FACTORY_STATE_ROOT, fixture.env.LUNA_FACTORY_CLAIMS_ROOT).list().length, 2);
});

test("a forged pre-tool marker with worker evidence remains fenced", async () => {
	const fixture = await preToolFailureFixture();
	await fixture.pi.events.get("agent_end")({ messages: [fixture.userMessage, fixture.assistantError] }, fixture.ctx);
	const blocked = fixture.pi.entries.filter((entry) => entry.customType === BATCH_ENTRY).at(-1).data;
	saveWave(fixture.env.LUNA_FACTORY_CLAIMS_ROOT, {
		...blocked,
		wavePreToolTerminal: "forged",
		waveToolInvocationIds: [],
		waveToolCallIds: ["call-1"],
		waveTaskWorkers: { "call-1": [{ agentId: "Worker", jobId: "job-1" }] },
		waveJobIds: ["job-1"],
	} as never);

	const restarted = fakeHost();
	const next = fakeCtx();
	next.ui.parent = next;
	next.sessionManager = { getBranch: () => fixture.pi.entries.map((entry) => ({ type: "custom", customType: entry.customType, data: entry.data })) };
	const restored = createReviewExtension(restarted, { org: "projectbluefin", fetchImpl: issueBackedFetch(fixture.states), env: fixture.env });
	await restarted.events.get("session_start")({}, next);
	await restored.whenStarted();
	await runReviewCommand(restarted, next, "reconcile");

	assert.equal(new ResourceClaims(fixture.env.LUNA_FACTORY_STATE_ROOT, fixture.env.LUNA_FACTORY_CLAIMS_ROOT).list().length, 2);
});

test("removing a captured submitted pull request remains an external-effect mismatch", async () => {
	const fixture = await preToolFailureFixture(["projectbluefin/review#9"]);
	await fixture.pi.events.get("agent_end")({ messages: [fixture.userMessage, fixture.assistantError] }, fixture.ctx);
	fixture.states["projectbluefin/review#77"].submittedPrs = [];

	const restarted = fakeHost();
	const next = fakeCtx();
	next.ui.parent = next;
	next.sessionManager = {
		getBranch: () => [
			...fixture.pi.entries.map((entry) => ({ type: "custom", customType: entry.customType, data: entry.data })),
			{ type: "message", message: fixture.userMessage },
			{ type: "message", message: fixture.assistantError },
		],
	};
	const restored = createReviewExtension(restarted, { org: "projectbluefin", fetchImpl: issueBackedFetch(fixture.states), env: fixture.env });
	await restarted.events.get("session_start")({}, next);
	await restored.whenStarted();
	await runReviewCommand(restarted, next, "reconcile");

	assert.equal(new ResourceClaims(fixture.env.LUNA_FACTORY_STATE_ROOT, fixture.env.LUNA_FACTORY_CLAIMS_ROOT).list().length, 2);
});

test("a late job contradiction invalidates a recorded pre-tool proof", async () => {
	const fixture = await preToolFailureFixture();
	await fixture.pi.events.get("agent_end")({ messages: [fixture.userMessage, fixture.assistantError] }, fixture.ctx);
	assert.equal(fixture.pi.entries.filter((entry) => entry.customType === BATCH_ENTRY).at(-1).data.wavePreToolTerminal, "error");
	fixture.pi.events.get("tool_call")({ toolCallId: "late-job", toolName: "task", input: { isolated: false } }, fixture.ctx);

	const contradicted = fixture.pi.entries.filter((entry) => entry.customType === BATCH_ENTRY).at(-1).data;
	assert.equal(contradicted.wavePreToolTerminal, undefined);
	assert.deepEqual(contradicted.waveToolInvocationIds, ["late-job"]);
	assert.equal(new ResourceClaims(fixture.env.LUNA_FACTORY_STATE_ROOT, fixture.env.LUNA_FACTORY_CLAIMS_ROOT).list().length, 2);
});

test("late tool evidence during a deferred reconciliation lookup keeps claims fenced", async () => {
	let holdLookup = false;
	let lookupCount = 0;
	let markLookupStarted;
	let releaseLookup;
	const lookupStarted = new Promise((resolve) => { markLookupStarted = resolve; });
	const lookupGate = new Promise((resolve) => { releaseLookup = resolve; });
	const fixture = await preToolFailureFixture([], (states) => {
		const baseFetch = issueBackedFetch(states);
		return async (url, init) => {
			const body = JSON.parse(String(init?.body ?? "{}"));
			if (holdLookup && body.variables?.search === undefined) {
				lookupCount++;
				if (lookupCount === 3) {
					markLookupStarted();
					await lookupGate;
				}
			}
			return baseFetch(url, init);
		};
	});
	await fixture.pi.events.get("agent_end")({ messages: [fixture.userMessage, fixture.assistantError] }, fixture.ctx);
	holdLookup = true;
	const reconcile = fixture.pi.commands.get("review").handler("reconcile", fixture.ctx);
	await lookupStarted;
	fixture.pi.events.get("tool_execution_start")({ toolCallId: "late-tool", toolName: "bash", args: {} }, fixture.ctx);
	releaseLookup();
	await reconcile;

	const latest = fixture.pi.entries.filter((entry) => entry.customType === BATCH_ENTRY).at(-1).data;
	assert.equal(latest.state, "blocked");
	assert.equal(latest.wavePreToolTerminal, undefined);
	assert.deepEqual(latest.waveToolInvocationIds, ["late-tool"]);
	assert.equal(new ResourceClaims(fixture.env.LUNA_FACTORY_STATE_ROOT, fixture.env.LUNA_FACTORY_CLAIMS_ROOT).list().length, 2);
});

test("later reconciliation never completes a previously cancelled wave", async () => {
	const fixture = await preToolFailureFixture();
	const callId = "worker-call";
	const jobId = "worker-job";
	const blocked = fixture.pi.entries.filter((entry) => entry.customType === BATCH_ENTRY).at(-1).data;
	const workerBatch = {
		...blocked,
		kind: "slay",
		wavePreToolTerminal: undefined,
		waveToolInvocationIds: [callId],
		waveToolCallIds: [callId],
		waveTaskWorkers: { [callId]: [{ agentId: "Worker", jobId, resultStatus: "completed" }] },
		waveJobIds: [jobId],
		waveTerminalJobStatuses: { [jobId]: "completed" },
	};
	saveWave(fixture.env.LUNA_FACTORY_CLAIMS_ROOT, workerBatch);
	const pi = fakeHost(); pi.flagValues.set("issues", true);
	const ctx = fakeCtx(); ctx.ui.parent = ctx;
	ctx.sessionManager = { getBranch: () => [
		...fixture.pi.entries.map((entry) => ({ type: "custom", customType: entry.customType, data: entry.data })),
		{ type: "custom", customType: BATCH_ENTRY, data: workerBatch },
	] };
	const restored = createReviewExtension(pi, { org: "projectbluefin", fetchImpl: issueBackedFetch(fixture.states), env: fixture.env });
	await pi.events.get("session_start")({}, ctx);
	await restored.whenStarted();
	await pi.commands.get("review").handler("cancel", ctx);

	assert.equal(pi.entries.filter((entry) => entry.customType === BATCH_ENTRY).at(-1).data.state, "cancelled");
	assert.equal(new ResourceClaims(fixture.env.LUNA_FACTORY_STATE_ROOT, fixture.env.LUNA_FACTORY_CLAIMS_ROOT).list().length, 2);
	fixture.states["projectbluefin/review#77"].submittedPrs = ["projectbluefin/review#10"];
	await runReviewCommand(pi, ctx, "reconcile");

	const recovered = pi.entries.filter((entry) => entry.customType === BATCH_ENTRY).at(-1).data;
	assert.equal(recovered.state, "cancelled");
	assert.notEqual(recovered.state, "complete");
	assert.equal(new ResourceClaims(fixture.env.LUNA_FACTORY_STATE_ROOT, fixture.env.LUNA_FACTORY_CLAIMS_ROOT).list().length, 0);
});

test("post-dispatch running work prevents pre-tool claim release", async () => {
	const fixture = await preToolFailureFixture();
	await fixture.pi.events.get("agent_end")({ messages: [fixture.userMessage, fixture.assistantError] }, fixture.ctx);
	fixture.ctx.asyncJobs.running = [{ id: "contradictory-job", status: "running", startTime: Date.now() }];
	await runReviewCommand(fixture.pi, fixture.ctx, "reconcile");

	assert.equal(new ResourceClaims(fixture.env.LUNA_FACTORY_STATE_ROOT, fixture.env.LUNA_FACTORY_CLAIMS_ROOT).list().length, 2);
});

test("an unavailable async snapshot cannot release pre-tool claims", async () => {
	const fixture = await preToolFailureFixture();
	await fixture.pi.events.get("agent_end")({ messages: [fixture.userMessage, fixture.assistantError] }, fixture.ctx);
	fixture.ctx.getAsyncJobSnapshot = () => undefined;
	await runReviewCommand(fixture.pi, fixture.ctx, "reconcile");

	assert.equal(new ResourceClaims(fixture.env.LUNA_FACTORY_STATE_ROOT, fixture.env.LUNA_FACTORY_CLAIMS_ROOT).list().length, 2);
});

test("a non-hex 64-character prompt digest cannot release pre-tool claims", async () => {
	const fixture = await preToolFailureFixture();
	await fixture.pi.events.get("agent_end")({ messages: [fixture.userMessage, fixture.assistantError] }, fixture.ctx);
	const blocked = fixture.pi.entries.filter((entry) => entry.customType === BATCH_ENTRY).at(-1).data;
	saveWave(fixture.env.LUNA_FACTORY_CLAIMS_ROOT, { ...blocked, wavePromptDigest: "g".repeat(64) });

	const restarted = fakeHost();
	const next = fakeCtx();
	next.ui.parent = next;
	next.sessionManager = {
		getBranch: () => fixture.pi.entries.map((entry) => ({ type: "custom", customType: entry.customType, data: entry.data })),
	};
	const restored = createReviewExtension(restarted, { org: "projectbluefin", fetchImpl: issueBackedFetch(fixture.states), env: fixture.env });
	await restarted.events.get("session_start")({}, next);
	await restored.whenStarted();
	await runReviewCommand(restarted, next, "reconcile");

	assert.equal(new ResourceClaims(fixture.env.LUNA_FACTORY_STATE_ROOT, fixture.env.LUNA_FACTORY_CLAIMS_ROOT).list().length, 2);
});

test("production Review-to-Factory reconcile releases a failed wave only after exact terminal proof", async () => {
	const item = {
		id: 42,
		type: "issue",
		repo: "projectbluefin/review",
		title: "recover safely",
		author: "reviewer",
		url: "https://github.com/projectbluefin/review/issues/42",
		updatedAt: NOW,
		draft: false,
		mergeState: "unknown",
		reviewState: "unknown",
		labels: [],
		submittedPrs: [],
	};
	const owner = "review:command-wave:0";
	const claims = new ResourceClaims(ISOLATED_ENV.LUNA_FACTORY_STATE_ROOT, ISOLATED_ENV.LUNA_FACTORY_CLAIMS_ROOT);
	claims.claim("repo:projectbluefin/review", owner);
	const pi = fakeHost();
	const factory = fakeHost();
	factory.commands = new Map();
	factory.registerCommand = (name, definition) => factory.commands.set(name, definition);
	createLunaFactoryExtension(factory as never, { env: ISOLATED_ENV });
	const ctx = fakeCtx();
	ctx.ui.parent = ctx;
	ctx.asyncJobs.recent = [{ id: "worker-command", status: "failed", startTime: NOW + 1 }];
	ctx.sessionManager = { getSessionId: () => ctx.sessionId,
		getBranch: () => [{
			type: "custom",
			customType: BATCH_ENTRY,
			data: {
				version: 1,
				id: "command-wave",
				kind: "fix",
				waves: [{ repo: item.repo, items: [item] }],
				currentWave: 0,
				completedItems: 0,
				totalItems: 1,
				state: "blocked",
				startedAt: NOW,
				waveStartedAt: NOW,
				waveIdentity: "command-wave:0",
				waveToolCallIds: ["worker-command"],
				waveTaskWorkers: { "worker-command": [{ agentId: "Worker", jobId: "worker-command" }] },
				waveJobIds: ["worker-command"],
				waveEffectResources: ["item:projectbluefin/review#42", "repo:projectbluefin/review"],
			},
		}],
	};
	const review = createReviewExtension(pi, {
		org: "projectbluefin",
		fetchImpl: hiveBackedFetch([item]),
		env: { ...ISOLATED_ENV, HIVE_HUB: "wss://hive.example/contribute" },
	});
	await pi.events.get("session_start")({}, ctx);
	await review.whenStarted();
	const factoryCommand = factory.commands.get("factory");
	await factoryCommand.handler(`claims reconcile ${owner} repo:projectbluefin/review`, ctx);
	assert.ok(ctx.notifications.some((notification) => /claim released/.test(notification.message)));
	assert.equal(claims.conflict("repo:projectbluefin/review", "review:other:0"), undefined);
	const beforeRetry = pi.messages.length;
	ctx.overlays.at(-1).handleInput("A");
	ctx.overlays.at(-1).handleInput("f");
	await new Promise((resolve) => setImmediate(resolve));
	assert.ok(pi.messages.length > beforeRetry, "reconciled blocked wave can retry through Review");

});
test("restart uses persisted terminal evidence for one Factory retry", async () => {
	const item = { id: 42, repo: "projectbluefin/review", title: "recover safely", headSha: "a".repeat(40), type: "pr" };
	const env = { ...ISOLATED_ENV, HIVE_HUB: "wss://hive.example/contribute" };
	const pi1 = fakeHost();
	const ctx1 = fakeCtx();
	ctx1.ui.parent = ctx1;
	const review1 = createReviewExtension(pi1, { org: "projectbluefin", fetchImpl: hiveBackedFetch([item]), env });
	await pi1.events.get("session_start")({}, ctx1);
	await review1.whenStarted();
	ctx1.overlays[0].handleInput("A");
	ctx1.overlays[0].handleInput("f");
	await new Promise((resolve) => setImmediate(resolve));
	const first = pi1.entries.filter((entry) => entry.customType === BATCH_ENTRY).at(-1).data;
	const owner = `review:${first.id}:0`;
	pi1.events.get("tool_call")({ toolCallId: "worker-command", toolName: "task", input: { isolated: false } }, ctx1);
	ctx1.asyncJobs.delivery.pendingJobIds = ["worker-command"];
	ctx1.asyncJobs.recent = [{ id: "worker-command", status: "failed", startTime: Date.now() + 1 }];
	observeTask(pi1, ctx1, "worker-command", "worker-command");
	await pi1.events.get("turn_end")({}, ctx1);
	await pi1.events.get("agent_end")({}, ctx1);
	assert.equal(pi1.entries.filter((entry) => entry.customType === BATCH_ENTRY).at(-1).data.state, "running");
	await deliverTaskResults(pi1, ctx1, ["worker-command"]);
	await pi1.events.get("agent_end")({}, ctx1);
	const factory = fakeHost();
	factory.commands = new Map();
	factory.registerCommand = (name, definition) => factory.commands.set(name, definition);
	createLunaFactoryExtension(factory as never, { env: ISOLATED_ENV });
	const persisted = pi1.entries.filter((entry) => entry.customType === BATCH_ENTRY).at(-1).data;
	assert.equal(persisted.state, "blocked");
	assert.deepEqual(persisted.waveTerminalJobStatuses, { "worker-command": "failed" });
	const pi2 = fakeHost();
	const ctx2 = fakeCtx();
	ctx2.ui.parent = ctx2;
	ctx2.sessionManager = { getSessionId: () => ctx2.sessionId, getBranch: () => [
		{ type: "custom", customType: STATE_ENTRY, data: { mode: "prs", repo: item.repo, id: item.id } },
		...pi1.entries.map((entry) => ({ type: "custom", customType: entry.customType, data: entry.data })),
	] };
	const review2 = createReviewExtension(pi2, { org: "projectbluefin", fetchImpl: hiveBackedFetch([item]), env });
	await pi2.events.get("session_start")({}, ctx2);
	await review2.whenStarted();
	const factoryCommand = factory.commands.get("factory");
	await factoryCommand.handler(`claims reconcile ${owner} repo:projectbluefin/review`, ctx2);
	assert.ok(ctx2.notifications.some((notification) => /Reconciled .*repo:/.test(notification.message)));
	await factoryCommand.handler(`claims reconcile ${owner} item:projectbluefin/review#42`, ctx2);
	assert.ok(ctx2.notifications.some((notification) => /Reconciled .*item:/.test(notification.message)));
	const beforeRetry = pi2.messages.length;
	ctx2.overlays.at(-1).handleInput("A");
	ctx2.overlays.at(-1).handleInput("f");
	await new Promise((resolve) => setImmediate(resolve));
	assert.equal(pi2.messages.length, beforeRetry + 1);
});


async function interruptedIssueSlay(states) {
	const env = { ...ISOLATED_ENV, REVIEW_MODE: "review" };
	const pi = fakeHost();
	pi.flagValues.set("issues", true);
	pi.flagValues.set("autoslay", true);
	const ctx = fakeCtx();
	ctx.ui.parent = ctx;
	const review = createReviewExtension(pi, { org: "projectbluefin", fetchImpl: issueBackedFetch(states), env });
	await pi.events.get("session_start")({}, ctx);
	await review.whenStarted();
	const batch = pi.entries.filter((entry) => entry.customType === BATCH_ENTRY).at(-1).data;
	pi.events.get("tool_call")({ toolCallId: "issue-worker", toolName: "task", input: { isolated: false } }, ctx);
	ctx.asyncJobs.delivery.pendingJobIds = ["issue-worker"];
	ctx.asyncJobs.recent = [{ id: "issue-worker", status: "completed", startTime: Date.now() + 1 }];
	observeTask(pi, ctx, "issue-worker", "issue-worker");
	await pi.events.get("turn_end")({}, ctx);
	// Simulate abrupt process loss: no graceful shutdown lifecycle was delivered.
	return { env, entries: pi.entries, batch };
}

async function blockedPrSlayWave(beforeSettlement = (_fixture) => {}, { legacy = true, policyMode, landingObserver } = {}) {
	const env = { ...ISOLATED_ENV, REVIEW_MODE: "review", ...(policyMode ? { HOME: ISOLATED_ENV.LUNA_FACTORY_STATE_ROOT } : {}) };
	const items = [350, 352, 353, 354].map((id) => queueItem({
		id,
		repo: "projectbluefin/review",
		title: `recovery target ${id}`,
		author: "contributor",
		url: `https://github.com/projectbluefin/review/pull/${id}`,
		headSha: String(id).repeat(40).slice(0, 40),
		ciStatus: "success",
		changedFiles: 1,
		changedFilesComplete: true,
	}));
	const effects = Object.fromEntries(items.map((item) => [item.id, {
		state: item.id === 354 ? "CLOSED" : "OPEN",
		merged: false,
		headSha: item.headSha,
		autoMerge: false,
		reviewDecision: "REVIEW_REQUIRED",
		reviews: [],
	}]));
	const pi = fakeHost();
	const ctx = fakeCtx(); ctx.ui.parent = ctx;
	const humanReviewObserver = landingObserver ? async (repository, number) => {
		const item = items.find((candidate) => candidate.repo.toLowerCase() === repository.toLowerCase() && candidate.id === number);
		return { kind: "observed", facts: {
			repository, number, headSha: item.headSha, baseRef: "main", authorLogin: item.author, viewerLogin: "maintainer", canMerge: true,
			requiredApprovals: 0, requiresCodeOwnerReview: false, requiresLastPushApproval: false, githubReviewState: "none",
			currentHumanApprovals: [], digest: `solo:${repository}#${number}:${item.headSha}`, observedAt: Date.now(),
		} };
	} : undefined;
	const review = createReviewExtension(pi, { org: "projectbluefin", fetchImpl: recoveredPrSlayFetch(items, effects), env, ...(humanReviewObserver ? { humanReviewObserver } : {}) });
	await pi.events.get("session_start")({}, ctx); await review.whenStarted();
	if (policyMode) await pi.commands.get("review").handler(`policy projectbluefin/review ${policyMode}`, ctx);
	ctx.overlays.at(-1).handleInput("A");
	ctx.overlays.at(-1).handleInput("s");
	await new Promise((resolve) => setImmediate(resolve));
	assert.equal(pi.messages.length, 1);
	const dispatched = pi.entries.filter((entry) => entry.customType === BATCH_ENTRY).at(-1).data;
	assert.deepEqual(dispatched.waves[0].items.map((item) => item.id), [350, 352, 353]);
	if (legacy) {
		const workers = [350, 352, 353].map((id) => ({ id: `reviewer-${id}`, agentId: `reviewer-${id}`, type: "task", status: "completed", startTime: Date.now() + 1 }));
		ctx.asyncJobs.recent = workers;
		pi.events.get("tool_call")({ toolCallId: "review-call", toolName: "task", input: { isolated: false } }, ctx);
		await pi.events.get("tool_execution_end")({ toolCallId: "review-call", result: { details: {
			async: { type: "task", state: "completed", jobId: workers[0].id },
			progress: workers.map((worker, index) => ({ id: worker.agentId, index, status: "completed" })),
		} }, isError: false }, ctx);
	} else {
		await completeReviewTask(pi, ctx, 3);
		if (landingObserver) for (const item of items.slice(0, 3)) {
			const result = await pi.events.get("tool_call")({ toolName: "bash", input: { command: `gh pr merge ${item.id} --repo ${item.repo} --squash --match-head-commit ${item.headSha}` } }, ctx);
			assert.equal(result, undefined, "the solo exact-head guard admits the direct merge attempt");
		}
	}
	beforeSettlement({ items, effects });
	await pi.events.get("agent_end")({}, ctx);
	const blocked = pi.entries.filter((entry) => entry.customType === BATCH_ENTRY).at(-1).data;
	assert.equal(blocked.state, "blocked");
	if (legacy) {
		// Simulate abrupt loss of the legacy writer before #79 persisted policy or reviewer receipts.
		delete blocked.waveOperatorPolicy;
		delete blocked.waveReviewerReceipts;
		delete blocked.waveWriterAgents;
		saveWave(env.LUNA_FACTORY_CLAIMS_ROOT, blocked);
		pi.appendEntry(BATCH_ENTRY, blocked);
	}
	assert.ok(blocked.waveTerminalJobStatuses && Object.keys(blocked.waveTerminalJobStatuses).length === 3);
	const claims = new ResourceClaims(env.LUNA_FACTORY_STATE_ROOT, env.LUNA_FACTORY_CLAIMS_ROOT).list();
	assert.deepEqual(claims.map((claim) => claim.resource).sort(), [
		"item:projectbluefin/review#350", "item:projectbluefin/review#352", "item:projectbluefin/review#353", "repo:projectbluefin/review",
	]);
	assert.ok(claims.every((claim) => claim.owner === `review:${blocked.id}:0`));
	// Simulate abrupt process loss, preserving the pre-shutdown recovery contract.
	return { env, items, effects, entries: pi.entries, batch: blocked, pi, ctx };
}

test("Slay landing recovery explains pending repaired head and settles only after GitHub merge", async () => {
	const repairedHead = "f".repeat(40);
	const { env, items, effects, pi, ctx, batch } = await blockedPrSlayWave(({ items, effects }) => {
		effects[350] = {
			state: "OPEN", merged: false, headSha: repairedHead, autoMerge: false,
			ciState: "PENDING", reviewDecision: "APPROVED",
			reviews: [{ state: "APPROVED", submittedAt: new Date(Date.now() + 100).toISOString(), author: { login: "maintainer" }, commit: { oid: repairedHead } }],
		};
		for (const item of items.slice(1, 3)) effects[item.id] = { state: "MERGED", merged: true, headSha: item.headSha, autoMerge: false, reviewDecision: null, reviews: [] };
	});
	assert.match(batch.error, /CI is pending/);
	assert.match(batch.error, /https:\/\/github.com\/projectbluefin\/review\/pull\/350/);
	assert.match(batch.error, /GitHub.*then.*\/review reconcile/i);
	assert.doesNotMatch(batch.error, /required CI|GitHub.*reject|resume once/i);
	const claims = () => new ResourceClaims(env.LUNA_FACTORY_STATE_ROOT, env.LUNA_FACTORY_CLAIMS_ROOT).list();
	effects[350].ciState = "SUCCESS";
	const reconciliation = await runReviewCommand(pi, ctx, "reconcile");
	assert.deepEqual(claims().map((claim) => claim.resource).sort(), ["item:projectbluefin/review#350", "repo:projectbluefin/review"]);
	const warning = reconciliation;
	assert.match(warning, /still open|not.*merged/i);
	assert.match(warning, /does not.*merge/i);
	assert.match(warning, /GitHub.*then.*\/review reconcile/i);
	assert.equal(pi.messages.length, 1, "reconcile does not dispatch another worker or attempt a merge");
	effects[350].state = "MERGED";
	effects[350].merged = true;
	await runReviewCommand(pi, ctx, "reconcile");
	assert.equal(claims().length, 0);
	const recovered = pi.entries.filter((entry) => entry.customType === BATCH_ENTRY).at(-1).data;
	assert.equal(recovered.state, "complete");
	assert.equal(recovered.completedItems, 3);
	assert.equal(pi.messages.length, 1);
});

async function reconcileBlockedPrSlayWave(prepare, options = {}, beforeReconcile = () => {}) {
	const { env, items, effects, entries, batch } = await blockedPrSlayWave();
	prepare({ env, items, effects, batch });
	beforeReconcile(env, batch, items);
	const pi = fakeHost();
	const ctx = fakeCtx(); ctx.ui.parent = ctx;
	ctx.sessionManager = { getBranch: () => entries.map((entry) => ({ type: "custom", customType: entry.customType, data: entry.data })) };
	const review = createReviewExtension(pi, { org: "projectbluefin", fetchImpl: recoveredPrSlayFetch(items, effects, options), env });
	await pi.events.get("session_start")({}, ctx); await review.whenStarted();
	const reconciliation = await runReviewCommand(pi, ctx, "reconcile");
	return {
		batch,
		recovered: pi.entries.filter((entry) => entry.customType === BATCH_ENTRY).at(-1)?.data ?? batch,
		claims: new ResourceClaims(env.LUNA_FACTORY_STATE_ROOT, env.LUNA_FACTORY_CLAIMS_ROOT).list(),
		ctx, reconciliation,
	};
}

test("/review reconcile recovers a merged three-PR Slay wave and admits the next mutation", async () => {
	const { env, items, effects, entries, batch } = await blockedPrSlayWave();
	for (const item of batch.waves[0].items) {
		effects[item.id] = { state: "MERGED", merged: true, headSha: item.headSha, autoMerge: false, reviewDecision: null, reviews: [] };
	}
	const pi = fakeHost();
	const ctx = fakeCtx(); ctx.ui.parent = ctx;
	ctx.sessionManager = { getSessionId: () => ctx.sessionId, getBranch: () => entries.map((entry) => ({ type: "custom", customType: entry.customType, data: entry.data })) };
	const review = createReviewExtension(pi, { org: "projectbluefin", fetchImpl: recoveredPrSlayFetch(items, effects), env });
	await pi.events.get("session_start")({}, ctx); await review.whenStarted();
	const firstReconcile = await runReviewCommand(pi, ctx, "reconcile");
	const recovered = pi.entries.filter((entry) => entry.customType === BATCH_ENTRY).at(-1).data;
	assert.equal(recovered.state, "complete");
	assert.equal(recovered.completedItems, 3);
	assert.equal(new ResourceClaims(env.LUNA_FACTORY_STATE_ROOT, env.LUNA_FACTORY_CLAIMS_ROOT).list().length, 0);

	effects[354] = { state: "OPEN", merged: false, headSha: items[3].headSha, autoMerge: false, reviewDecision: "REVIEW_REQUIRED", reviews: [] };
	ctx.overlays.at(-1).handleInput("r");
	await new Promise((resolve) => setImmediate(resolve));
	await pi.commands.get("review").handler("slay", ctx);
	assert.equal(pi.messages.length, 1, "a new Slay dispatch is not blocked by the recovered wave's old claims");
	assert.match(firstReconcile, /Reconciled/);
});

test("#79 solo merge acknowledgement loss reconciles the recorded reviewed heads and releases the same claims", async () => {
	const { env, items, effects, entries, batch } = await blockedPrSlayWave(() => {}, { legacy: false, policyMode: "solo", landingObserver: true });
	for (const item of batch.waves[0].items) effects[item.id] = { state: "MERGED", merged: true, headSha: item.headSha, autoMerge: false, reviewDecision: null, reviews: [] };
	const pi = fakeHost();
	const ctx = fakeCtx(); ctx.ui.parent = ctx;
	ctx.sessionManager = { getSessionId: () => "restart-session", getBranch: () => entries.map((entry) => ({ type: "custom", customType: entry.customType, data: entry.data })) };
	const humanReviewObserver = async (repository, number) => {
		const item = items.find((candidate) => candidate.repo.toLowerCase() === repository.toLowerCase() && candidate.id === number);
		return { kind: "observed", facts: {
			repository, number, headSha: item.headSha, baseRef: "main", authorLogin: item.author, viewerLogin: "maintainer", canMerge: true,
			requiredApprovals: 0, requiresCodeOwnerReview: false, requiresLastPushApproval: false, githubReviewState: "none",
			currentHumanApprovals: [], digest: `solo:${repository}#${number}:${item.headSha}`, observedAt: Date.now(),
		} };
	};
	createReviewExtension(pi, { org: "projectbluefin", fetchImpl: recoveredPrSlayFetch(items, effects), env, humanReviewObserver });
	await pi.events.get("session_start")({}, ctx);
	await runReviewCommand(pi, ctx, "reconcile");
	const recovered = pi.entries.filter((entry) => entry.customType === BATCH_ENTRY).at(-1).data;
	assert.equal(recovered.state, "complete");
	assert.equal(recovered.completedItems, 3);
	assert.equal(new ResourceClaims(env.LUNA_FACTORY_STATE_ROOT, env.LUNA_FACTORY_CLAIMS_ROOT).list().length, 0);
	assert.deepEqual(batch.waveLandingHeads, Object.fromEntries(batch.waves[0].items.map((item) => [`${item.repo.toLowerCase()}#${item.id}`, item.headSha])));
});

test("stopped Slay reconciles a merged forward head for a solo operator", async () => {
	const { recovered, claims } = await reconcileBlockedPrSlayWave(({ env, items, effects, batch }) => {
		batch.waveSessionId = "stopped-session";
		batch.waveExit = { sessionId: batch.waveSessionId, waveIdentity: batch.waveIdentity, choice: "pause", requestedAt: Date.now() };
		batch.waveShutdown = { sessionId: batch.waveSessionId, waveIdentity: batch.waveIdentity, settled: true, pendingJobIds: [], observedAt: Date.now() };
		saveWave(env.LUNA_FACTORY_CLAIMS_ROOT, batch);
		for (const item of items.slice(0, 3)) effects[item.id] = {
			state: "MERGED", merged: true, headSha: "f".repeat(40), autoMerge: false, reviewDecision: null, reviews: [],
		};
	}, { forwardComparison: true });
	assert.equal(claims.length, 0);
	assert.equal(recovered.completedItems, 0);
});

test("stopped new-policy Slay retains claims when GitHub merged an unreviewed forward head", async () => {
	const { env, items, effects, entries, batch } = await blockedPrSlayWave(() => {}, {
		legacy: false,
		policyMode: "solo",
		landingObserver: true,
	});
	batch.waveSessionId = "stopped-new-policy-session";
	batch.waveExit = { sessionId: batch.waveSessionId, waveIdentity: batch.waveIdentity, choice: "pause", requestedAt: Date.now() };
	batch.waveShutdown = { sessionId: batch.waveSessionId, waveIdentity: batch.waveIdentity, settled: true, pendingJobIds: [], observedAt: Date.now() };
	saveWave(env.LUNA_FACTORY_CLAIMS_ROOT, batch);
	for (const item of items.slice(0, 3)) effects[item.id] = {
		state: "MERGED", merged: true, headSha: "f".repeat(40), autoMerge: false, reviewDecision: null, reviews: [],
	};
	const pi = fakeHost();
	const ctx = fakeCtx(); ctx.ui.parent = ctx;
	ctx.sessionManager = { getBranch: () => entries.map((entry) => ({ type: "custom", customType: entry.customType, data: entry.data })) };
	const review = createReviewExtension(pi, {
		org: "projectbluefin",
		fetchImpl: recoveredPrSlayFetch(items, effects, { forwardComparison: true }),
		env,
	});
	await pi.events.get("session_start")({}, ctx); await review.whenStarted();
	await runReviewCommand(pi, ctx, "reconcile");
	const claims = new ResourceClaims(env.LUNA_FACTORY_STATE_ROOT, env.LUNA_FACTORY_CLAIMS_ROOT).list();
	const recovered = pi.entries.filter((entry) => entry.customType === BATCH_ENTRY).at(-1)?.data;
	assert.equal(recovered.state, "blocked");
	assert.equal(recovered.completedItems, 0);
	assert.equal(claims.length, 4, "forward-head merge without a matching persisted reviewer receipt retains ownership");
	assert.ok(claims.every((claim) => claim.owner === `review:${batch.id}:0`));
});

test("stopped Slay revalidates an earlier merged PR after later resource reads", async () => {
	const { claims } = await reconcileBlockedPrSlayWave(({ env, items, effects, batch }) => {
		batch.waveSessionId = "stopped-session";
		batch.waveExit = { sessionId: batch.waveSessionId, waveIdentity: batch.waveIdentity, choice: "pause", requestedAt: Date.now() };
		batch.waveShutdown = { sessionId: batch.waveSessionId, waveIdentity: batch.waveIdentity, settled: true, pendingJobIds: [], observedAt: Date.now() };
		saveWave(env.LUNA_FACTORY_CLAIMS_ROOT, batch);
		for (const item of items.slice(0, 3)) effects[item.id] = {
			state: "MERGED", merged: true, headSha: "f".repeat(40), autoMerge: false, reviewDecision: null, reviews: [],
		};
	}, { forwardComparison: true, changeEarlierOnComparison: true });
	assert.equal(claims.length, 4, "a changed earlier terminal effect keeps all wave claims UNKNOWN");
});

for (const scenario of ["diverged", "head-race", "incomplete-reviews", "changes-requested", "unsettled"]) test(`stopped Slay retains merged changed-head claims for ${scenario}`, async () => {
	const { claims } = await reconcileBlockedPrSlayWave(({ env, items, effects, batch }) => {
		batch.waveSessionId = "stopped-session";
		batch.waveExit = { sessionId: batch.waveSessionId, waveIdentity: batch.waveIdentity, choice: "pause", requestedAt: Date.now() };
		batch.waveShutdown = { sessionId: batch.waveSessionId, waveIdentity: batch.waveIdentity, settled: scenario !== "unsettled", pendingJobIds: [], observedAt: Date.now() };
		saveWave(env.LUNA_FACTORY_CLAIMS_ROOT, batch);
		for (const item of items.slice(0, 3)) effects[item.id] = {
			state: "MERGED", merged: true, headSha: "f".repeat(40), autoMerge: false,
			reviewDecision: scenario === "changes-requested" ? "CHANGES_REQUESTED" : null,
			reviewsIncomplete: scenario === "incomplete-reviews", reviews: [],
		};
	}, { forwardComparison: true, diverged: scenario === "diverged", headRace: scenario === "head-race" });
	assert.equal(claims.length, 4);
});

test("reconcile accepts open auto-merge at a changed head with fresh head-bound review", async () => {
	const { recovered, claims } = await reconcileBlockedPrSlayWave(({ items, effects }) => {
		for (const item of items.slice(0, 3)) {
			const headSha = "f".repeat(40);
			effects[item.id] = {
				state: "OPEN", merged: false, headSha, autoMerge: true, reviewDecision: "REVIEW_REQUIRED",
				reviews: [{ state: "APPROVED", submittedAt: new Date(Date.now() + 100).toISOString(), author: { login: "maintainer" }, commit: { oid: headSha } }],
			};
		}
	});
	assert.equal(recovered.state, "complete");
	assert.equal(recovered.completedItems, 3);
	assert.equal(claims.length, 0);
});

test("reconcile accepts changed-head MERGED only with a fresh current-head approval", async () => {
	const { recovered, claims } = await reconcileBlockedPrSlayWave(({ items, effects }) => {
		for (const item of items.slice(0, 3)) {
			const headSha = "f".repeat(40);
			effects[item.id] = {
				state: "MERGED", merged: true, headSha, autoMerge: false, reviewDecision: null,
				reviews: [{ state: "APPROVED", submittedAt: new Date(Date.now() + 100).toISOString(), author: { login: "maintainer" }, commit: { oid: headSha } }],
			};
		}
	});
	assert.equal(recovered.state, "complete");
	assert.equal(recovered.completedItems, 3);
	assert.equal(claims.length, 0);
});

for (const scenario of ["unreviewed", "stale", "changes-requested"]) test(`changed-head MERGED retains UNKNOWN claims for ${scenario} review evidence`, async () => {
	const { batch, claims } = await reconcileBlockedPrSlayWave(({ items, effects }) => {
		for (const item of items.slice(0, 3)) {
			const headSha = "f".repeat(40);
			effects[item.id] = {
				state: "MERGED", merged: true, headSha, autoMerge: false,
				reviewDecision: scenario === "changes-requested" ? "CHANGES_REQUESTED" : null,
				reviews: scenario === "unreviewed" ? [] : [{
					state: "APPROVED",
					submittedAt: new Date(Date.now() + 100).toISOString(),
					author: { login: "maintainer" },
					commit: { oid: scenario === "stale" ? item.headSha : headSha },
				}],
			};
		}
	});
	assert.equal(batch.state, "blocked");
	assert.equal(claims.length, 4);
	assert.ok(claims.every((claim) => claim.owner === `review:${batch.id}:0`));
});

test("closed unmerged Slay PRs release claims without counting as completed", async () => {
	const { recovered, claims, reconciliation } = await reconcileBlockedPrSlayWave(({ items, effects }) => {
		for (const item of items.slice(0, 3)) effects[item.id] = { state: "CLOSED", merged: false, headSha: item.headSha, autoMerge: false, reviewDecision: "REVIEW_REQUIRED", reviewsIncomplete: true, reviews: [] };
	});
	assert.equal(recovered.state, "cancelled");
	assert.equal(recovered.completedItems, 0);
	assert.equal(claims.length, 0);
	assert.match(reconciliation, /terminal outcome not satisfied.*closed without merging/i);
});

for (const scenario of ["unreviewed-head-change", "stale-review-head", "unreadable"]) test(`Slay PR reconciliation retains UNKNOWN claims for ${scenario}`, async () => {
	const { batch, claims } = await reconcileBlockedPrSlayWave(({ items, effects }) => {
		for (const item of items.slice(0, 3)) {
			const changedHead = "e".repeat(40);
			effects[item.id] = {
				state: "OPEN", merged: false, headSha: changedHead, autoMerge: true, reviewDecision: "REVIEW_REQUIRED",
				reviews: scenario === "stale-review-head" ? [{ state: "APPROVED", submittedAt: new Date(Date.now() + 100).toISOString(), author: { login: "maintainer" }, commit: { oid: item.headSha } }] : [],
			};
		}
	}, { unreadable: scenario === "unreadable" });
	assert.equal(claims.length, 4);
	assert.ok(claims.every((claim) => claim.owner === `review:${batch.id}:0`));
});

test("reconcile never releases a Slay claim whose owner changed", async () => {
	const { batch, claims } = await reconcileBlockedPrSlayWave(({ items, effects }) => {
		for (const item of items.slice(0, 3)) effects[item.id] = {
			state: "MERGED", merged: true, headSha: item.headSha, autoMerge: false, reviewDecision: null, reviews: [],
		};
	}, {}, (testEnv, currentBatch, items) => {
		const store = new ResourceClaims(testEnv.LUNA_FACTORY_STATE_ROOT, testEnv.LUNA_FACTORY_CLAIMS_ROOT);
		const resource = `item:${items[0].repo}#${items[0].id}`;
		store.release(resource, `review:${currentBatch.id}:0`);
		store.claim(resource, "review:other-wave:0");
	});
	assert.equal(claims.length, 1);
	assert.equal(claims[0].owner, "review:other-wave:0");
	assert.equal(claims[0].resource, "item:projectbluefin/review#350");
	assert.equal(batch.state, "blocked");
});

for (const delivery of ["message_start", "tool_result"]) test(`issue Slay retains distinct task/job identity after result consumption via ${delivery}`, async () => {
	const states = { "projectbluefin/review#77": { title: "consumed worker", submittedPrs: [] } };
	const env = { ...ISOLATED_ENV, REVIEW_MODE: "review" };
	const pi = fakeHost();
	pi.flagValues.set("issues", true);
	pi.flagValues.set("autoslay", true);
	const ctx = fakeCtx();
	ctx.ui.parent = ctx;
	const review = createReviewExtension(pi, { org: "projectbluefin", fetchImpl: issueBackedFetch(states), env });
	await pi.events.get("session_start")({}, ctx);
	await review.whenStarted();
	pi.events.get("tool_call")({ toolCallId: "call-123", toolName: "task", input: { isolated: false } }, ctx);
	ctx.asyncJobs.running = [{ id: "FixIssue", agentId: "FixIssue", type: "task", status: "running", startTime: Date.now() }];
	await pi.events.get("tool_execution_end")({ toolCallId: "call-123", result: { details: {
		async: { type: "task", state: "running", jobId: "FixIssue" },
		progress: [{ id: "FixIssue", index: 0, status: "running" }],
	} }, isError: false }, ctx);
	ctx.asyncJobs.running = [];
	ctx.asyncJobs.recent = [{ id: "FixIssue", agentId: "FixIssue", type: "task", status: "completed", startTime: Date.now() }];
	await pi.events.get(delivery)?.({ toolCallId: "wait-call", toolName: "wait", message: { role: "custom", customType: "async-result" } }, ctx);
	ctx.asyncJobs.recent = [];
	states["projectbluefin/review#77"].submittedPrs = ["projectbluefin/review#10"];
	await pi.events.get("agent_end")({}, ctx);
	assert.equal(pi.entries.filter((entry) => entry.customType === BATCH_ENTRY).at(-1).data.state, "complete");
	assert.equal(new ResourceClaims(env.LUNA_FACTORY_STATE_ROOT, env.LUNA_FACTORY_CLAIMS_ROOT).list().length, 0);
	assert.equal(pi.messages.length, 1, "the worker is never replayed");
});

test("OMP 18.4 primary async job id survives without a transient job snapshot", async () => {
	const states = { "projectbluefin/review#77": { title: "direct job identity", submittedPrs: [] } };
	const env = { ...ISOLATED_ENV, REVIEW_MODE: "review" };
	const pi = fakeHost();
	pi.flagValues.set("issues", true);
	pi.flagValues.set("autoslay", true);
	const ctx = fakeCtx(); ctx.ui.parent = ctx;
	const review = createReviewExtension(pi, { org: "projectbluefin", fetchImpl: issueBackedFetch(states), env });
	await pi.events.get("session_start")({}, ctx); await review.whenStarted();
	pi.events.get("tool_call")({ toolCallId: "direct-call", toolName: "task", input: { isolated: false } }, ctx);
	ctx.asyncJobs.running = [];
	ctx.asyncJobs.recent = [];
	await pi.events.get("tool_execution_end")({ toolCallId: "direct-call", result: { details: {
		async: { type: "task", state: "completed", jobId: "DirectWorker-2" },
		progress: [{ id: "DirectWorker", index: 0, status: "completed" }],
	} }, isError: false }, ctx);
	const recorded = pi.entries.filter((entry) => entry.customType === BATCH_ENTRY).at(-1).data;
	assert.deepEqual(recorded.waveJobIds, ["DirectWorker-2"]);
	assert.deepEqual(recorded.waveTaskWorkers, {
		"direct-call": [{ agentId: "DirectWorker", jobId: "DirectWorker-2", resultStatus: "completed" }],
	});
	assert.deepEqual(recorded.waveTerminalJobStatuses, { "DirectWorker-2": "completed" });
	states["projectbluefin/review#77"].submittedPrs = ["projectbluefin/review#10"];
	await pi.events.get("agent_end")({}, ctx);
	assert.equal(pi.entries.filter((entry) => entry.customType === BATCH_ENTRY).at(-1).data.state, "complete");
});

test("Review recovers a consumed worker from host evidence without session entries", async () => {
	const states = { "projectbluefin/review#77": { title: "lost projection", submittedPrs: [] } };
	const env = { ...ISOLATED_ENV, REVIEW_MODE: "review" };
	const pi = fakeHost();
	pi.flagValues.set("issues", true);
	pi.flagValues.set("autoslay", true);
	const ctx = fakeCtx(); ctx.ui.parent = ctx;
	const review = createReviewExtension(pi, { org: "projectbluefin", fetchImpl: issueBackedFetch(states), env });
	await pi.events.get("session_start")({}, ctx); await review.whenStarted();
	pi.events.get("tool_call")({ toolCallId: "lost-call", toolName: "task", input: { isolated: false } }, ctx);
	ctx.asyncJobs.recent = [{ id: "LostWorker", agentId: "LostWorker", type: "task", status: "completed", startTime: Date.now() }];
	await pi.events.get("tool_execution_end")({ toolCallId: "lost-call", result: { details: {
		async: { type: "task", state: "completed", jobId: "LostWorker" }, progress: [{ id: "LostWorker", index: 0, status: "completed" }],
	} }, isError: false }, ctx);
	await pi.events.get("session_shutdown")({}, ctx);
	pi.events.get("session_shutdown_settled")({ sessionId: ctx.sessionId, settled: true, pendingJobIds: [] }, ctx);
	states["projectbluefin/review#77"].submittedPrs = ["projectbluefin/review#10"];
	const restarted = fakeHost(); restarted.flagValues.set("issues", true);
	const next = fakeCtx(); next.ui.parent = next;
	const restored = createReviewExtension(restarted, { org: "projectbluefin", fetchImpl: issueBackedFetch(states), env });
	await restarted.events.get("session_start")({}, next); await restored.whenStarted();
	await runReviewCommand(restarted, next, "reconcile");
	assert.equal(new ResourceClaims(env.LUNA_FACTORY_STATE_ROOT, env.LUNA_FACTORY_CLAIMS_ROOT).list().length, 0);
	assert.equal(restarted.messages.length, 0);
});

for (const count of [1, 8]) test(`packaged OMP current pin delivers and evicts ${count} Slay workers without losing Review evidence`, { skip: !process.env.REVIEW_OMP_SOURCE }, async () => {
	const Manager = await loadPackagedJobManager(process.env.REVIEW_OMP_SOURCE!);
	const states = Object.fromEntries(Array.from({ length: count }, (_, index) => [`projectbluefin/review#${77 + index}`, { title: `real manager ${index}`, submittedPrs: [] }]));
	const env = { ...ISOLATED_ENV, REVIEW_MODE: "review" };
	const pi = fakeHost(); pi.flagValues.set("issues", true); pi.flagValues.set("autoslay", true);
	const ctx = fakeCtx(); ctx.ui.parent = ctx;
	const manager = new Manager({ consumedResultEvictionMs: 0, onJobComplete: async (jobId) => {
		await pi.events.get("message_start")({ message: { role: "custom", customType: "async-result", details: { jobs: [{ jobId, type: "task" }] } } }, ctx);
	} });
	ctx.getAsyncJobSnapshot = () => ({ running: manager.getRunningJobs(), recent: manager.getRecentJobs(5), delivery: manager.getDeliveryState() });
	try {
		const baselineId = manager.register("bash", "pre-existing job", async () => "baseline", { id: "RealWorker0" });
		manager.watchJobs([baselineId]);
		await manager.getJob(baselineId).promise;
		const review = createReviewExtension(pi, { org: "projectbluefin", fetchImpl: issueBackedFetch(states), env });
		await pi.events.get("session_start")({}, ctx); await review.whenStarted();
		pi.events.get("tool_call")({ toolCallId: "real-call", toolName: "task", input: { isolated: false } }, ctx);
		const pending = Array.from({ length: count }, () => Promise.withResolvers<string>());
		const progress = pending.map((_, index) => ({ id: `RealWorker${index}`, index, status: "running" }));
		const jobIds = pending.map((done, index) => manager.register("task", progress[index].id, () => done.promise, { id: progress[index].id, agentId: progress[index].id }));
		assert.notEqual(jobIds[0], progress[0].id, "the real manager disambiguates a colliding job id");
		await pi.events.get("tool_result")({ toolName: "task", toolCallId: "real-call", details: {
			async: { type: "task", state: "running", jobId: jobIds[0] }, progress,
		} }, ctx);
		for (const row of progress) row.status = "completed";
		await pi.events.get("tool_execution_update")({ toolCallId: "real-call", partialResult: { details: {
			async: { type: "task", state: "completed", jobId: jobIds[0] }, progress,
		} } }, ctx);
		assert.deepEqual(pi.entries.filter((entry) => entry.customType === BATCH_ENTRY).at(-1).data.waveTerminalJobStatuses ?? {}, {}, "progress alone never proves job settlement");
		for (const done of pending) done.resolve("worker finished");
		await Promise.all(jobIds.map((id) => manager.getJob(id).promise));
		await manager.drainDeliveries();
		for (const id of jobIds) assert.equal(manager.isJobResultConsumed(id), true);
		await new Promise((resolve) => setTimeout(resolve, 5));
		assert.equal(manager.getRecentJobs(5).filter((job) => jobIds.includes(job.id)).length, 0, "the real manager evicts consumed results");
		for (let index = 0; index < count; index++) states[`projectbluefin/review#${77 + index}`].submittedPrs = [`projectbluefin/review#${10 + index}`];
		await pi.events.get("agent_end")({}, ctx);
		assert.equal(pi.entries.filter((entry) => entry.customType === BATCH_ENTRY).at(-1).data.state, "complete");
		assert.equal(new ResourceClaims(env.LUNA_FACTORY_STATE_ROOT, env.LUNA_FACTORY_CLAIMS_ROOT).list().length, 0);
		assert.equal(pi.messages.length, 1);
	} finally { await manager.dispose(); }
});

test("Review reconcile reports orphan UNKNOWN claims without inventing settlement", async () => {
	const env = { ...ISOLATED_ENV, REVIEW_MODE: "review" };
	const claims = new ResourceClaims(env.LUNA_FACTORY_STATE_ROOT, env.LUNA_FACTORY_CLAIMS_ROOT);
	claims.claim("repo:projectbluefin/review", "review:orphan:0");
	const pi = fakeHost(); const ctx = fakeCtx(); ctx.ui.parent = ctx;
	const review = createReviewExtension(pi, { org: "projectbluefin", fetchImpl: issueBackedFetch({}), env });
	await pi.events.get("session_start")({}, ctx); await review.whenStarted();
	const result = await runReviewCommand(pi, ctx, "reconcile");
	assert.match(result, /UNKNOWN.*orphan.*recovery record/i);
	assert.equal(claims.list().length, 1);
});

for (const scenario of ["failed", "cancelled", "never-started", "duplicate", "unaccounted", "missing-effect", "ambiguous-effect"]) {
	test(`consumed issue worker fails closed: ${scenario}`, async () => {
		const states = { "projectbluefin/review#77": { title: scenario, submittedPrs: [] } };
		const env = { ...ISOLATED_ENV, REVIEW_MODE: "review" };
		const pi = fakeHost(); pi.flagValues.set("issues", true); pi.flagValues.set("autoslay", true);
		const ctx = fakeCtx(); ctx.ui.parent = ctx;
		const review = createReviewExtension(pi, { org: "projectbluefin", fetchImpl: issueBackedFetch(states), env });
		await pi.events.get("session_start")({}, ctx); await review.whenStarted();
		pi.events.get("tool_call")({ toolName: "task", toolCallId: "call", input: {} }, ctx);
		if (scenario !== "never-started") {
			ctx.asyncJobs.recent = [{ id: "worker-job", agentId: "Worker", type: "task", startTime: Date.now(), status: ["failed", "cancelled"].includes(scenario) ? scenario : "completed" }];
			const details = { async: { type: "task", state: "running", jobId: "worker-job" }, progress: [{ id: "Worker", index: 0, status: "running" }] };
			pi.events.get("tool_result")({ toolName: "task", toolCallId: "call", details }, ctx);
			if (scenario === "duplicate" || scenario === "unaccounted") {
				pi.events.get("tool_call")({ toolName: "task", toolCallId: "other-call", input: {} }, ctx);
				if (scenario === "duplicate") pi.events.get("tool_result")({ toolName: "task", toolCallId: "other-call", details }, ctx);
			}
		}
		ctx.asyncJobs.recent = [];
		states["projectbluefin/review#77"].submittedPrs = scenario === "missing-effect" ? [] : scenario === "ambiguous-effect" ? ["projectbluefin/review#10", "projectbluefin/review#11"] : ["projectbluefin/review#10"];
		await pi.events.get("agent_end")({}, ctx);
		assert.equal(pi.entries.filter((entry) => entry.customType === BATCH_ENTRY).at(-1).data.state, "blocked");
		assert.equal(new ResourceClaims(env.LUNA_FACTORY_STATE_ROOT, env.LUNA_FACTORY_CLAIMS_ROOT).list().length, 2);
		assert.equal(pi.messages.length, 1);
	});
}

test("one task fan-out retains every sibling job independently across consumption", async () => {
	const states = {
		"projectbluefin/review#77": { title: "first", submittedPrs: [] },
		"projectbluefin/review#78": { title: "second", submittedPrs: [] },
	};
	const env = { ...ISOLATED_ENV, REVIEW_MODE: "review" };
	const pi = fakeHost(); pi.flagValues.set("issues", true); pi.flagValues.set("autoslay", true);
	const ctx = fakeCtx(); ctx.ui.parent = ctx;
	const review = createReviewExtension(pi, { org: "projectbluefin", fetchImpl: issueBackedFetch(states), env });
	await pi.events.get("session_start")({}, ctx); await review.whenStarted();
	pi.events.get("tool_call")({ toolName: "task", toolCallId: "fan-out", input: { tasks: [
		{ task: "first", isolated: false },
		{ task: "second", isolated: false },
	] } }, ctx);
	ctx.asyncJobs.running = ["First", "Second"].map((agentId) => ({ id: `${agentId}-2`, agentId, type: "task", status: "running", startTime: Date.now() }));
	pi.events.get("tool_result")({ toolName: "task", toolCallId: "fan-out", details: {
		async: { type: "task", state: "running", jobId: "First-2" }, progress: [{ id: "First", index: 0 }, { id: "Second", index: 1 }],
	} }, ctx);
	for (const id of ["Second-2", "First-2"]) {
		const job = ctx.asyncJobs.running.find((row) => row.id === id);
		ctx.asyncJobs.running = ctx.asyncJobs.running.filter((row) => row.id !== id);
		ctx.asyncJobs.recent = [{ ...job, status: "completed" }];
		await pi.events.get("message_start")({}, ctx);
		ctx.asyncJobs.recent = [];
	}
	const batch = pi.entries.filter((entry) => entry.customType === BATCH_ENTRY).at(-1).data;
	assert.deepEqual(batch.waveTaskWorkers, { "fan-out": [{ agentId: "First", jobId: "First-2" }, { agentId: "Second", jobId: "Second-2" }] });
	states["projectbluefin/review#77"].submittedPrs = ["projectbluefin/review#10"];
	states["projectbluefin/review#78"].submittedPrs = ["projectbluefin/review#11"];
	await pi.events.get("agent_end")({}, ctx);
	assert.equal(pi.entries.filter((entry) => entry.customType === BATCH_ENTRY).at(-1).data.state, "complete");
	assert.equal(new ResourceClaims(env.LUNA_FACTORY_STATE_ROOT, env.LUNA_FACTORY_CLAIMS_ROOT).list().length, 0);
});

test("interrupted issue Slay reconciles the exact submitted PR after restart", async () => {
	const states = {
		"projectbluefin/review#77": { title: "recover issue", submittedPrs: [] },
	};
	const { env, entries, batch } = await interruptedIssueSlay(states);
	states["projectbluefin/review#77"].submittedPrs = ["projectbluefin/review#10"];

	const pi = fakeHost();
	pi.flagValues.set("issues", true);
	const ctx = fakeCtx();
	ctx.ui.parent = ctx;
	ctx.sessionManager = {
		getBranch: () => entries.map((entry) => ({ type: "custom", customType: entry.customType, data: entry.data })),
	};
	const review = createReviewExtension(pi, { org: "projectbluefin", fetchImpl: issueBackedFetch(states), env });
	await pi.events.get("session_start")({}, ctx);
	await review.whenStarted();

	const recovered = pi.entries.filter((entry) => entry.customType === BATCH_ENTRY).at(-1).data;
	assert.equal(recovered.state, "complete");
	assert.equal(pi.messages.length, 0, "restart never replays the issue mutation");
	assert.ok(ctx.notifications.some((notification) => /observed submitted PRs projectbluefin\/review#10/.test(notification.message)));
	const claims = new ResourceClaims(env.LUNA_FACTORY_STATE_ROOT, env.LUNA_FACTORY_CLAIMS_ROOT);
	assert.equal(claims.conflict("repo:projectbluefin/review", "review:other:0"), undefined);
	assert.equal(claims.conflict("item:projectbluefin/review#77", "review:other:0"), undefined);
	assert.equal(batch.state, "running");
});

test("ambiguous submitted PR observations retain UNKNOWN issue-Slay claims", async () => {
	const states = {
		"projectbluefin/review#77": { title: "ambiguous issue", submittedPrs: [] },
	};
	const { env, entries, batch } = await interruptedIssueSlay(states);
	states["projectbluefin/review#77"].submittedPrs = ["projectbluefin/review#10", "projectbluefin/review#11"];

	const pi = fakeHost();
	pi.flagValues.set("issues", true);
	const ctx = fakeCtx();
	ctx.ui.parent = ctx;
	ctx.sessionManager = {
		getBranch: () => entries.map((entry) => ({ type: "custom", customType: entry.customType, data: entry.data })),
	};
	const review = createReviewExtension(pi, { org: "projectbluefin", fetchImpl: issueBackedFetch(states), env });
	await pi.events.get("session_start")({}, ctx);
	await review.whenStarted();
	const reconciliation = await runReviewCommand(pi, ctx, "reconcile");

	const claims = new ResourceClaims(env.LUNA_FACTORY_STATE_ROOT, env.LUNA_FACTORY_CLAIMS_ROOT);
	assert.equal(
		claims.conflict("repo:projectbluefin/review", "review:other:0"),
		`repo:projectbluefin/review is owned by review:${batch.id}:0`,
	);
	assert.match(reconciliation, /UNKNOWN/);
	assert.equal(pi.messages.length, 0);
});

test("blocked issue Slay can be revised and re-Slayed in the same Review session", async () => {
	const states = {
		"projectbluefin/review#77": { title: "wrong selection", submittedPrs: [] },
	};
	const env = { ...ISOLATED_ENV, REVIEW_MODE: "review" };
	const pi = fakeHost();
	pi.flagValues.set("issues", true);
	const ctx = fakeCtx();
	ctx.ui.parent = ctx;
	const review = createReviewExtension(pi, { org: "projectbluefin", fetchImpl: issueBackedFetch(states), env });
	await pi.events.get("session_start")({}, ctx);
	await review.whenStarted();
	ctx.overlays[0].handleInput("A");
	ctx.overlays[0].handleInput("s");
	await new Promise((resolve) => setImmediate(resolve));
	const first = pi.entries.filter((entry) => entry.customType === BATCH_ENTRY).at(-1).data;
	pi.events.get("tool_call")({ toolCallId: "failed-issue-worker", toolName: "task", input: { isolated: false } }, ctx);
	ctx.asyncJobs.delivery.pendingJobIds = ["failed-issue-worker"];
	ctx.asyncJobs.recent = [{ id: "failed-issue-worker", status: "failed", startTime: Date.now() + 1 }];
	observeTask(pi, ctx, "failed-issue-worker", "failed-issue-worker");
	await pi.events.get("turn_end")({}, ctx);
	await pi.events.get("agent_end")({}, ctx);
	assert.equal(pi.entries.filter((entry) => entry.customType === BATCH_ENTRY).at(-1).data.state, "running");
	await deliverTaskResults(pi, ctx, ["failed-issue-worker"]);
	await pi.events.get("agent_end")({}, ctx);
	assert.equal(pi.entries.filter((entry) => entry.customType === BATCH_ENTRY).at(-1).data.state, "blocked");

	states["projectbluefin/review#77"].submittedPrs = ["projectbluefin/review#10"];
	await pi.commands.get("review").handler("revise", ctx);
	const claims = new ResourceClaims(env.LUNA_FACTORY_STATE_ROOT, env.LUNA_FACTORY_CLAIMS_ROOT);
	assert.equal(claims.conflict("repo:projectbluefin/review", "review:other:0"), undefined);

	states["projectbluefin/review#78"] = { title: "revised selection", submittedPrs: [] };
	await pi.shortcuts.get("alt+u").handler(ctx);
	await new Promise((resolve) => setImmediate(resolve));
	await pi.commands.get("review").handler("slay", ctx);
	assert.match(pi.messages.at(-1), /projectbluefin\/review#78/);
	assert.notEqual(pi.entries.filter((entry) => entry.customType === BATCH_ENTRY).at(-1).id, first.id);
});


test("Review drain settles its current issue wave, then pauses later admission without cancellation", async () => {
	const states = {
		"projectbluefin/review#77": { title: "drain issue", submittedPrs: [] },
		"projectbluefin/other#78": { title: "later drain issue", submittedPrs: [] },
	};
	const env = { ...ISOLATED_ENV, REVIEW_MODE: "review" };
	const pi = fakeHost();
	pi.flagValues.set("issues", true);
	pi.flagValues.set("autoslay", true);
	const ctx = fakeCtx();
	ctx.ui.parent = ctx;
	const review = createReviewExtension(pi, { org: "projectbluefin", fetchImpl: issueBackedFetch(states), env });
	await pi.events.get("session_start")({}, ctx);
	await review.whenStarted();
	pi.events.get("tool_call")({ toolCallId: "drain-worker", toolName: "task", input: { isolated: false } }, ctx);
	ctx.asyncJobs.delivery.pendingJobIds = ["drain-worker"];
	ctx.asyncJobs.running = [{ id: "drain-worker", status: "running", startTime: Date.now() + 1 }];
	observeTask(pi, ctx, "drain-worker", "drain-worker");
	await pi.events.get("turn_end")({}, ctx);
	await pi.commands.get("review").handler("drain", ctx);
	const draining = pi.entries.filter((entry) => entry.customType === BATCH_ENTRY).at(-1).data;
	assert.equal(draining.state, "running");
	assert.equal(draining.cancelRequested, undefined);

	ctx.asyncJobs.running = [];
	ctx.asyncJobs.recent = [{ id: "drain-worker", status: "completed", startTime: Date.now() + 2 }];
	const firstWave = pi.entries.filter((entry) => entry.customType === BATCH_ENTRY).at(-1).data.waves[0];
	const firstIssue = firstWave.items[0];
	states[`${firstIssue.repo}#${firstIssue.id}`].submittedPrs = [`${firstIssue.repo}#99`];
	await deliverTaskResults(pi, ctx, ["drain-worker"]);
	await pi.events.get("agent_end")({}, ctx);
	const paused = pi.entries.filter((entry) => entry.customType === BATCH_ENTRY).at(-1).data;
	assert.equal(paused.state, "paused");
	assert.equal(paused.currentWave, 1);
	assert.equal(paused.completedItems, 1);
	assert.match(ctx.notifications.at(-1)?.message ?? "", /drain.*paused/i);
	assert.equal(pi.messages.length, 1, "drain pauses before admitting the second repository");
	const claims = new ResourceClaims(env.LUNA_FACTORY_STATE_ROOT, env.LUNA_FACTORY_CLAIMS_ROOT);
	assert.equal(claims.conflict(`repo:${firstIssue.repo}`, "review:other:0"), undefined, "settled first-wave claims are reconciled");
	assert.notEqual(paused.waves[paused.currentWave].repo, firstIssue.repo);
});

test("slay prompts require unique target checkouts and live-rule landing", () => {
	const item = queueItem();
	const sibling = queueItem({ id: 7, repo: item.repo });
	const slay = actionPrompt({ kind: "slay", item, items: [item, sibling] });
	const fix = actionPrompt({ kind: "fix", item, items: [item, sibling] });
	for (const prompt of [slay, fix]) {
		assert.match(prompt, /Never sleep or poll/);
		assert.match(prompt, /Evidence is bounded and read once/);
		assert.match(prompt, /--name-only/);
		assert.doesNotMatch(prompt, /--json [\w,]*\bbody\b/);
		assert.doesNotMatch(prompt, /isolated: true/);
	}
	assert.match(slay, /review each head with a fresh reviewer/i);
	assert.match(slay, /Do not use eval workpool/);
	assert.match(slay, /fresh fixer/);
	assert.doesNotMatch(slay, /Do not request OMP-native/);
	assert.match(slay, /distinct target checkout/);
	assert.match(slay, /both `pull_request` and explicit `repo`/);
	assert.match(slay, /\$HOME\/worktrees/);
	assert.match(slay, /rules\/branches\/<branch>/);
	assert.match(slay, /reviewed head must equal the live head/i);
	assert.match(slay, /--match-head-commit <reviewed-sha>/);
	assert.match(slay, /Never use `--admin`/);
	assert.match(slay, /do not disable and re-arm auto-merge/);
	assert.match(slay, /report the outstanding approval gate and move on/);
	assert.match(slay, /Review's local guard, not a GitHub rejection/);
	assert.match(slay, /merge or enable auto-merge in GitHub, then run \/review reconcile/);
	assert.match(slay, /Reconcile only observes GitHub effects; it does not merge or restart work/);
	const reviewerPrompt = readFileSync("image/extension/review/agents/reviewer.md", "utf8");
	assert.match(reviewerPrompt, /review_workbench_diff/);
	assert.match(reviewerPrompt, /explicit repository/);
	assert.match(reviewerPrompt, /pull-request number/);
	const reviewerTools = reviewerPrompt.match(/^tools: (.+)$/m)?.[1] ?? "";
	assert.doesNotMatch(reviewerTools, /\b(?:bash|yield)\b/);
	assert.match(reviewerPrompt, /read-only reviewer/);
	assert.match(reviewerPrompt, /clean verdict/);
	assert.doesNotMatch(reviewerPrompt, /\*\*`approve`\*\*/);
	assert.match(fix, /`task` tool once with one fresh item per issue or pull request/);
	assert.match(fix, /Never approve or merge/);
});

test("fix waves repair conflicts without landing them", () => {
	const dirty = queueItem({ ciStatus: "failure", mergeState: "dirty", reviewState: "review_required" });
	const sibling = queueItem({ id: 7, repo: dirty.repo, mergeState: "dirty" });
	const batch = actionPrompt({ kind: "fix", item: dirty, items: [dirty, sibling] });
	assert.match(batch, /merge=dirty/);
	assert.match(batch, /`task` tool once with one fresh item/);
	assert.match(batch, /Never approve or merge/);
});

test("the queue read travels with its caveat and workflowz rules are copyable", () => {
	const green = queueItem({ ciStatus: "success", mergeState: "clean", reviewState: "approved" });
	const sibling = queueItem({ id: 7, repo: green.repo, ciStatus: "failure" });
	const batch = actionPrompt({ kind: "fix", item: green, items: [green, sibling] });
	for (const line of batch.split("\n").filter((line) => line.includes("queue read:"))) {
		assert.match(line, /revalidate live before mutating/, line);
	}
	assert.match(batch, /<<<SUBAGENT-RULES[\s\S]*Never sleep or poll[\s\S]*SUBAGENT-RULES>>>/);
	assert.match(batch, /Copy this block verbatim/);
});


// The timeout is the assertion: startup registers its refreshers and returns
// before a slow GitHub read can consume OMP's extension-handler budget.
test("session_start returns while the queue is still loading", { timeout: 5000 }, async () => {
	const pi = fakeHost();
	const stalled = Promise.withResolvers();
	const review = createReviewExtension(pi, {
		org: "projectbluefin",
		fetchImpl: () => stalled.promise,
		env: ISOLATED_ENV,
	});
	const ctx = fakeCtx();
	ctx.ui.parent = ctx;

	await pi.events.get("session_start")({}, ctx);
	assert.equal(ctx.overlays.length, 0, "no second surface is mounted while data loads");
	assert.equal(typeof ctx.widgets.get("hive-workbench-rail"), "function", "the rail is mounted before the first await");

	stalled.resolve({ ok: false, status: 504, statusText: "Gateway Timeout", json: async () => ({}) });
	await review.whenStarted();
	assert.equal(ctx.overlays.length, 1, "the one workbench opens after the initial queue read");
	assert.match(savedReviewNoticeText(pi), /Couldn’t refresh the review list/, "a queue failure is described in user language");
	assert.match(await runReviewCommand(pi, ctx, "details"), /504/);
});
test("refresh cancellation is silent while replacement activity continues", async () => {
	const pi = fakeHost();
	const firstStarted = Promise.withResolvers();
	const firstCancelled = Promise.withResolvers();
	let calls = 0;
	const fetchImpl = async (_url, init) => {
		calls += 1;
		if (calls === 1) {
			firstStarted.resolve();
			const firstRequest = Promise.withResolvers();
			init.signal.addEventListener(
				"abort",
				() => {
					firstCancelled.resolve();
					firstRequest.reject(new Error("The operation was aborted"));
				},
				{ once: true },
			);
			await firstRequest.promise;
		}
		return {
			ok: true,
			status: 200,
			statusText: "OK",
			json: async () => ({ data: { search: { pageInfo: { hasNextPage: false }, nodes: [] } } }),
		};
	};
	const review = createReviewExtension(pi, { org: "projectbluefin", fetchImpl, env: ISOLATED_ENV });
	const ctx = fakeCtx();
	ctx.ui.parent = ctx;
	;

	await pi.events.get("session_start")({}, ctx);
	await firstStarted.promise;
	await pi.shortcuts.get("alt+u").handler(ctx);
	await firstCancelled.promise;
	await review.whenStarted();

	assert.equal(calls, 2);
	assert.equal(
		ctx.notifications.some((entry) => /aborted/.test(entry.message)),
		false,
		"an expected cancellation must not render as a queue error",
	);
});

test("a headless session hands the queue to the tools, not to the handler", async () => {
	const pi = fakeHost();
	createReviewExtension(pi, { org: "projectbluefin", fetchImpl: fakeFetch([]), env: ISOLATED_ENV });
	const ctx = fakeCtx();
	ctx.hasUI = false;
	ctx.ui.parent = ctx;

	await pi.events.get("session_start")({}, ctx);
	// No rail, no intro, no dashboard: there is nothing to render into.
	assert.equal(ctx.overlays.length, 0);
	assert.equal(ctx.widgets.size, 0);

	// The handler returned before the fetch landed, so the tool has to wait for
	// it. Reading the queue too early is how a print-mode run reports that a busy
	// organization has nothing open.
	const queue = await pi.tools.get("hive_workbench_queue").execute("id", {});
	assert.match(queue.content[0].text, /projectbluefin\/other#7/);
	assert.equal(queue.details.items.length, 2);
});


test("a resumed session reopens on the item it left", async () => {
	const pi = fakeHost();
	const review = createReviewExtension(pi, { org: "projectbluefin", fetchImpl: fakeFetch([]), env: ISOLATED_ENV });

	const ctx = fakeCtx();
	ctx.ui.parent = ctx;
	// The queue is empty until the fetch lands, so a selection restored at
	// session_start alone would silently fall back to the first row.
	ctx.sessionManager = {
		getBranch: () => [
			{ type: "custom", customType: STATE_ENTRY, data: { mode: "prs", repo: "projectbluefin/other", id: 7 } },
		],
	};
	;
	await pi.events.get("session_start")({}, ctx);
	await review.whenStarted();
	assert.ok(ctx.statuses.get("hive_workbench")?.includes("#7"));
});

test("the status tool names the authority that ordered the queue", async () => {
	// A hub that answers, with a queue that matches nothing in this scope.
	const hiveFetch = (ranked) => async (url, init) => {
		const target = String(url);
		if (target.includes("/graphql")) return fakeFetch([])(url, init);
		const path = target.replace("https://hive.example", "");
		const body =
			path === "/api/v1/status"
				? { hub: "online", actionable_items: 122 }
				: path === "/api/contribute/queue"
					? { queue: ranked }
					: { groups: [] };
		return { ok: true, status: 200, statusText: "OK", json: async () => body };
	};

	const statusFor = async (fetchImpl, env) => {
		const pi = fakeHost();
		const review = createReviewExtension(pi, { org: "projectbluefin", fetchImpl, env });
		const ctx = fakeCtx();
		ctx.ui.parent = ctx;
		;
		await pi.events.get("session_start")({}, ctx);
		await review.whenStarted();
		return await pi.tools.get("hive_workbench_status").execute("id", {});
	};

	const hubEnv = { ...ISOLATED_ENV, HIVE_HUB: "https://hive.example" };

	const noHub = await statusFor(fakeFetch([]), ISOLATED_ENV);
	assert.match(noHub.content[0].text, /order: LOCAL · attention order — no hive hub configured/);
	assert.equal(noHub.details.hive.configured, false);

	const quiet = await statusFor(hiveFetch([]), hubEnv);
	assert.match(quiet.content[0].text, /order: hive — 0 of 2 items ranked/);
	assert.equal(quiet.details.hive.online, true);
	assert.equal(quiet.details.order_source, "hive", "an online hub remains the ordering authority even when nothing is ranked in scope");

	// The same hub, now ranking one of the fetched pull requests.
	const ranking = await statusFor(
		hiveFetch([{ repo: "projectbluefin/review", number: 42, title: "queued" }]),
		hubEnv,
	);
	assert.match(ranking.content[0].text, /order: hive — 1 of 2 items ranked/);
	assert.match(ranking.content[0].text, /Hive owns priority; do not reorder or reassign it/);
	assert.equal(ranking.details.order_source, "hive");
	assert.match(ranking.content[0].text, /selected projectbluefin\/review#42/);

	const unreachable = await statusFor(async (url, init) => {
		if (String(url).includes("/graphql")) return fakeFetch([])(url, init);
		return { ok: false, status: 502, statusText: "Bad Gateway", json: async () => ({}) };
	}, hubEnv);
	// The header/status line is a concise fallback status, not the raw error.
	assert.match(unreachable.content[0].text, /order: LOCAL · attention order — hive unavailable; local policy remains active, and review, fix, and slay remain available/);
	// The raw diagnostic is kept behind the status, in the structured details.
	assert.match(unreachable.details.hive.error ?? "", /502/, "the raw error stays in the status details, not the header");
});

// ---------------------------------------------------------------- hive fallback

test("an optional Hive failure degrades to a concise fallback status", () => {
	// Classified by signature, so a TLS cert mismatch, a timeout, a dropped
	// connection and an auth failure each read as a distinct short label rather
	// than a raw error string, and anything unknown falls back cleanly.
	const tls = new Error("alert certificate name invalid");
	(tls as { code?: string }).code = "ERR_TLS_CERT_ALTNAME_INVALID";
	assert.equal(hiveFailureStatus(tls), "hive tls", "a TLS mismatch is a tls status");

	const timeout = new Error("read failed");
	(timeout as { code?: string }).code = "ETIMEDOUT";
	assert.equal(hiveFailureStatus(timeout), "hive network");

	const refused = new Error("connect failed");
	(refused as { code?: string }).code = "ECONNREFUSED";
	assert.equal(hiveFailureStatus(refused), "hive connection");

	const denied = new Error("403 Forbidden");
	assert.equal(hiveFailureStatus(denied), "hive unauthorized");

	const dns = new Error("getaddrinfo ENOTFOUND hub");
	assert.equal(hiveFailureStatus(dns), "hive network");

	assert.equal(hiveFailureStatus("/api/contribute/status → 502 Bad Gateway"), "hive unavailable");
});

test("the rail header shows the concise status and never the raw error", () => {
	const mode = new ReviewMode({ org: "projectbluefin" });
	mode.hive = {
		...EMPTY_HIVE,
		hub: "https://hive.example",
		configured: true,
		online: false,
		error: "getaddrinfo ENOTFOUND hive.example",
		fetchedAt: NOW,
	};
	mode.items = [queueItem()];
	mode.reprioritize();

	const rows = renderRail(mode, PLAIN_PAINTER, 120, NOW, 0, []);
	assert.match(rows[0], /hive network/, "a network failure reads as a concise status");
	assert.doesNotMatch(rows[0], /ENOTFOUND/, "the raw diagnostic must not dominate the header");
	assert.doesNotMatch(rows[0], /hive\.example/, "the hub host is not a status line");
	assert.equal(mode.orderSource(), "local", "a broken hub falls back to local order");
});

test("the status tool names all three optional-Hive states distinctly", async () => {
	const hubEnv = { ...ISOLATED_ENV, HIVE_HUB: "https://hive.example" };
	const statusFor = async (fetchImpl, env) => {
		const pi = fakeHost();
		const review = createReviewExtension(pi, { org: "projectbluefin", fetchImpl, env });
		const ctx = fakeCtx();
		ctx.ui.parent = ctx;
		;
		await pi.events.get("session_start")({}, ctx);
		await review.whenStarted();
		return await pi.tools.get("hive_workbench_status").execute("id", {});
	};

	// 1. Unconfigured: no hub at all.
	const noHub = await statusFor(fakeFetch([]), ISOLATED_ENV);
	assert.match(noHub.content[0].text, /order: LOCAL · attention order — no hive hub configured/);
	assert.equal(noHub.details.hive.configured, false);

	// 2. Online with nothing queued in this scope: not an error, just empty.
	const quiet = await statusFor(
		async (url, init) => {
			if (String(url).includes("/graphql")) return fakeFetch([])(url, init);
			const path = String(url).replace("https://hive.example", "");
			return { ok: true, status: 200, statusText: "OK", json: async () => (path === "/api/v1/status" ? { actionable_items: 3 } : { queue: [], groups: [] }) };
		},
		hubEnv,
	);
	assert.match(quiet.content[0].text, /order: hive — 0 of 2 items ranked/);
	assert.equal(quiet.details.hive.online, true);

	// 3. Configured but broken: a concise status up front, the raw error behind it.
	const broken = await statusFor(
		async (url, init) => {
			if (String(url).includes("/graphql")) return fakeFetch([])(url, init);
			return { ok: false, status: 502, statusText: "Bad Gateway", json: async () => ({}) };
		},
		hubEnv,
	);
	assert.match(broken.content[0].text, /order: LOCAL · attention order — hive unavailable; local policy remains active, and review, fix, and slay remain available/);
	assert.match(broken.details.hive.error ?? "", /502/, "the raw error is the diagnostic, kept in the status details");
	assert.equal(broken.details.hive.online, false);
});

test("a hive-only session with a broken hub still fails visibly and concisely", async () => {
	const hubEnv = { ...ISOLATED_ENV, HIVE_HUB: "https://hive.example" };
	const hiveFetch = async (url, init) => {
		if (String(url).includes("/graphql")) return fakeFetch([])(url, init);
		return { ok: false, status: 502, statusText: "Bad Gateway", json: async () => ({}) };
	};
	const pi = fakeHost();
	const review = createReviewExtension(pi, { org: "projectbluefin", fetchImpl: hiveFetch, env: hubEnv });
	const ctx = fakeCtx();
	ctx.ui.parent = ctx;
	;
	await pi.events.get("session_start")({}, ctx);
	await review.whenStarted();

	assert.match(savedReviewNoticeText(pi), /Hive context isn’t available/, `a broken hive is explained, got ${JSON.stringify(ctx.notifications)}`);
	assert.match(ctx.overlays[0].render(100).join("\n"), /GitHub review queue is still available/);
	assert.match(await runReviewCommand(pi, ctx, "details"), /502/);
});


test("action prompts reserve landing authority for slay", () => {
	const item = queueItem();
	assert.match(actionPrompt({ kind: "slay", item }), /review_workbench_diff/);
	assert.match(actionPrompt({ kind: "slay", item }), /review_workbench_trace/);
	assert.match(actionPrompt({ kind: "slay", item }), /reviewer/);
	assert.match(actionPrompt({ kind: "fix", item }), /Never approve or merge/);
	const slayAction = { kind: "slay", item, items: [item, queueItem({ id: 7, repo: item.repo })] };
	const slayPrompt = actionPrompt(slayAction);
	assert.match(slayPrompt, /review, repair, and landing/);
	assert.match(slayPrompt, /Report one terminal outcome per item/);
	assert.doesNotMatch(slayPrompt, /requires? (?:two|2) approvals?/i);
	const issue = queueItem({ id: 8, type: "issue", reviewState: "unknown" });
	assert.equal(actionPrompt({ kind: "slay", item, items: [item, issue] }), undefined);
	assert.equal(actionPrompt({ kind: "close" }), undefined);
});

test("diff prompts match the object: issues inspect discussion, pull requests diff", () => {
	// Issue #591: `d` on an issue must not send the agent to the PR-only
	// diff tool. Issue inspection reads the body, discussion, and linked PRs.
	const pr = queueItem();
	const issue = queueItem({ id: 8, type: "issue", reviewState: "unknown" });

	const prPrompt = actionPrompt({ kind: "diff", item: pr });
	assert.match(prPrompt, /review_workbench_diff/);

	const issuePrompt = actionPrompt({ kind: "diff", item: issue });
	assert.match(issuePrompt, /review_workbench_issue.*explicit.*issue.*repo/);
	assert.match(issuePrompt, /linked/);
	assert.doesNotMatch(issuePrompt, /Call review_workbench_diff/);

	const issueWave = actionPrompt({ kind: "diff", item: issue, items: [issue, queueItem({ id: 9, type: "issue", reviewState: "unknown" })] });
	assert.match(issueWave, /Inspect this issue wave/);
	assert.match(issueWave, /body, discussion, and linked pull requests/);
	assert.doesNotMatch(issueWave, /Use review_workbench_diff/);
	const prWave = actionPrompt({ kind: "diff", item: pr, items: [pr, queueItem({ id: 7, repo: pr.repo })] });
	assert.match(prWave, /review_workbench_diff/);
});


test("hive work the search never returned is still admitted to the queue", async () => {
	// Hive queues an issue that is nowhere near the top of a recency-ordered
	// search. Without admitting it by name, the tool whose purpose is burning
	// Hive's queue down would never show it.
	const queued = [
		{ repo: "projectbluefin/lab", number: 470, title: "vanilla-kde: boot KDE natively" },
		{ repo: "projectbluefin/documentation", number: 936, title: "npm test misses scripts/lib" },
		// Hive keeps ranking work after it is finished. A queue is what is left.
		{ repo: "projectbluefin/lab", number: 466, title: "Gate C soak" },
	];
	const known = {
		"projectbluefin/lab#470": {
			number: 470,
			title: "vanilla-kde: boot KDE natively",
			url: "https://github.com/projectbluefin/lab/issues/470",
			updatedAt: new Date(NOW - 90 * 24 * 3600 * 1000).toISOString(),
			author: { login: "castrojo" },
			repository: { nameWithOwner: "projectbluefin/lab" },
			labels: { nodes: [] },
			closed: false,
		},
		"projectbluefin/lab#466": {
			number: 466,
			title: "Gate C soak",
			url: "https://github.com/projectbluefin/lab/issues/466",
			updatedAt: new Date(NOW - 40 * 24 * 3600 * 1000).toISOString(),
			author: { login: "castrojo" },
			repository: { nameWithOwner: "projectbluefin/lab" },
			labels: { nodes: [] },
			closed: true,
		},
	};
	const hubFetch = async (url, init) => {
		const target = String(url);
		if (target.includes("/graphql")) return fakeFetch([], known)(url, init);
		const path = target.replace("https://hive.example", "");
		const body =
			path === "/api/v1/status"
				? { hub: "online", actionable_items: 108 }
				: path === "/api/contribute/queue"
					? { queue: queued }
					: { groups: [] };
		return { ok: true, status: 200, statusText: "OK", json: async () => body };
	};

	const pi = fakeHost();
	const review = createReviewExtension(pi, {
		org: "projectbluefin",
		fetchImpl: hubFetch,
		env: { ...ISOLATED_ENV, HIVE_HUB: "https://hive.example" },
	});
	const ctx = fakeCtx();
	ctx.ui.parent = ctx;
	;
	pi.flagValues.set("issues", true);
	await pi.events.get("session_start")({}, ctx);
	await review.whenStarted();

	const queue = await pi.tools.get("hive_workbench_queue").execute("id", {});
	assert.match(queue.content[0].text, /projectbluefin\/lab#470/, "hive work outside the search must still be queued");
	assert.equal(queue.details.order_source, "hive");

	// #936 resolved to nothing — moved or unreadable — and #466 came back closed.
	// Neither is in the queue, and the shortfall is reported rather than hidden
	// behind a list that merely looks complete.
	assert.doesNotMatch(queue.content[0].text, /#936/);
	assert.doesNotMatch(queue.content[0].text, /#466/, "finished work is not a queue");
	const status = await pi.tools.get("hive_workbench_status").execute("id", {});
	assert.equal(status.details.hive.queued.present, 1);
	assert.equal(status.details.hive.queued.total, 3);
});

test("issue Hive backfill is not capped by PR detail bound", async () => {
	const queued = Array.from({ length: BATCH_LIMIT + 1 }, (_, index) => ({
		repo: "projectbluefin/lab",
		number: 1000 + index,
		title: `issue ${1000 + index}`,
	}));
	const hubFetch = async (url, init) => {
		const target = String(url);
		if (target.includes("/graphql")) {
			const body = JSON.parse(String(init?.body ?? "{}"));
			if (body.variables?.search !== undefined) {
				return {
					ok: true,
					status: 200,
					statusText: "OK",
					json: async () => ({ data: { viewer: { login: "jorge" }, search: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] } } }),
				};
			}
			const data = {};
			const aliases = /(\w+): repository\(owner: "([^"]+)", name: "([^"]+)"\)\s*\{\s*issueOrPullRequest\(number: (\d+)\)/g;
			for (const [, alias, owner, repo, number] of body.query.matchAll(aliases)) {
				data[alias] = {
					issueOrPullRequest: {
						number: Number(number),
						title: `issue ${number}`,
						url: `https://github.com/${owner}/${repo}/issues/${number}`,
						updatedAt: new Date(NOW).toISOString(),
						author: { login: "reviewer" },
						repository: { nameWithOwner: `${owner}/${repo}` },
						labels: { nodes: [] },
						closed: false,
					},
				};
			}
			return { ok: true, status: 200, statusText: "OK", json: async () => ({ data }) };
		}
		const path = target.replace("https://hive.example", "");
		const body =
			path === "/api/v1/status"
				? { hub: "online", actionable_items: queued.length }
				: path === "/api/contribute/queue"
					? { queue: queued }
					: { groups: [] };
		return { ok: true, status: 200, statusText: "OK", json: async () => body };
	};
	const pi = fakeHost();
	const review = createReviewExtension(pi, {
		org: "projectbluefin",
		fetchImpl: hubFetch,
		env: { ...ISOLATED_ENV, HIVE_HUB: "https://hive.example" },
	});
	const ctx = fakeCtx();
	ctx.ui.parent = ctx;
	pi.flagValues.set("issues", true);
	await pi.events.get("session_start")({}, ctx);
	await review.whenStarted();

	const status = await pi.tools.get("hive_workbench_status").execute("id", {});
	assert.equal(status.details.hive.queued.present, BATCH_LIMIT + 1);
	assert.equal(status.details.hive.queued.total, BATCH_LIMIT + 1);
});

test("the dashboard drills into Hive's queue by stage and explains each item", (t) => {
	const root = mkdtempSync(join(tmpdir(), "workbench-test-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const mode = new ReviewMode({ org: "projectbluefin", env: { ...ISOLATED_ENV, REVIEW_MODE: "hive" } });

	const ready = { key: "projectbluefin/lab#470", repo: "projectbluefin/lab", number: 470, title: "vanilla-kde", url: "https://github.com/projectbluefin/lab/issues/470", labels: ["gate"], level: "ready" };
	const triaging = { key: "projectbluefin/docs#936", repo: "projectbluefin/docs", number: 936, title: "npm test gap", url: "", labels: [], level: "triaging" };
	mode.hive = {
		...EMPTY_HIVE,
		hub: "https://hive.example",
		configured: true,
		online: true,
		items: [ready, triaging],
		triage: [
			{ level: "triaging", label: "Triaging", count: 1 },
			{ level: "ready", label: "Ready to implement", count: 1 },
		],
		ranks: new Map([[ready.key, 0], [triaging.key, 1]]),
	};
	mode.items = [
		queueItem({ id: 470, type: "issue", repo: "projectbluefin/lab", title: "vanilla-kde" }),
		queueItem({ id: 936, type: "issue", repo: "projectbluefin/docs", title: "npm test gap" }),
		// A pull request that closes the ready issue: work already exists for it.
		queueItem({ id: 12, repo: "projectbluefin/lab", title: "feat: boot KDE under OVMF", ciStatus: "success", closingIssues: [ready.key] }),
	];
	;
	mode.reprioritize();

	// L steps through Hive's own stages, in the hub's order, then back to all.
	assert.equal(mode.visibleItems().length, 3);
	assert.equal(mode.cycleHiveLevel(), "triaging");
	assert.deepEqual(mode.visibleItems().map((item) => item.id), [936]);
	assert.equal(mode.cycleHiveLevel(), "ready");
	assert.deepEqual(mode.visibleItems().map((item) => item.id).sort(), [12, 470]);
	assert.equal(mode.cycleHiveLevel(), undefined, "the last stage returns to the whole queue");
	assert.equal(mode.visibleItems().length, 3);

	const dashboard = new ReviewDashboard({ requestRender() {} }, PLAIN_PAINTER, mode, () => {}, () => {}, 24);
	t.after(() => dashboard.dispose());
	dashboard.handleInput("L");
	assert.equal(mode.hiveLevel, "triaging", "L is bound to the stage walk");

	// Select the ready issue and read the detail pane: rank, stage, and the open
	// change that already answers it.
	mode.hiveLevel = undefined;
	mode.selectById("projectbluefin/lab", 470);
	const detail = dashboard.render(120).join("\n");
	assert.match(detail, /hive #1/);
	assert.match(detail, /stage ready/);
	assert.match(detail, /#12 feat: boot KDE under OVMF/, "an open change closing the issue is shown");

	// The issue nobody has answered says so instead of leaving the pane blank.
	mode.selectById("projectbluefin/docs", 936);
	const unanswered = dashboard.render(120).join("\n");
	assert.match(unanswered, /stage triaging/);
	assert.match(unanswered, /no open change closes this yet/);
});

test("a filtered slice is selected and dispatched in one wave", (t) => {
	const root = mkdtempSync(join(tmpdir(), "workbench-test-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const mode = new ReviewMode({ org: "projectbluefin" });
	mode.items = Array.from({ length: 40 }, (_, i) =>
		queueItem({ id: 100 + i, type: "issue", repo: "projectbluefin/lab", title: `queued work ${i}` }),
	);
	mode.reprioritize();

	assert.equal(mode.selectAllVisible(), 40, "selection cardinality is independent of execution capacity");
	assert.equal(mode.factorySelection("inspect").length, 40);
	assert.equal(mode.slayableItems().length, BATCH_LIMIT, "Review dispatch remains bounded");
	mode.items = mode.items.slice(0, BATCH_LIMIT);
	mode.reprioritize();
	assert.equal(mode.selectAllVisible(), 15, "hidden selections are not silently dropped");
	assert.equal(mode.factorySelection("inspect").length, 15);
	mode.clearSelected();

	// It respects the filters, so a stage or a search is what gets dispatched.
	mode.filter = "work 1";
	const narrowed = mode.selectAllVisible();
	assert.equal(narrowed, mode.visibleItems().length);
	assert.ok(narrowed > 1 && narrowed < BATCH_LIMIT, `expected a narrowed slice, got ${narrowed}`);

	const dashboard = new ReviewDashboard({ requestRender() {} }, PLAIN_PAINTER, mode, () => {}, () => {}, 24);
	t.after(() => dashboard.dispose());
	mode.clearSelected();
	dashboard.handleInput("A");
	assert.equal(mode.selectedKeys.size, narrowed, "A is bound to the slice selection");

	const batch = mode.chosenItems();
	const prompt = actionPrompt({ kind: "fix", item: batch[0], items: batch });
	assert.match(prompt, /Use the `task` tool once/);
	assert.match(prompt, /`task` tool once with one fresh item per issue through OMP workflowz/);
	assert.match(prompt, /`gh repo clone .*under `\$HOME\/worktrees`/s);
	assert.match(prompt, /Never assume the working directory is a checkout/);
	assert.doesNotMatch(prompt, /maximum of 7|fix-and-merge|approve and merge/);
});


test("Factory selection keeps inherited OMP model access live after a model switch", async () => {
	const pi = fakeHost();
	const review = createReviewExtension(pi, { org: "projectbluefin", fetchImpl: fakeFetch([]), env: ISOLATED_ENV });
	const uiContext = fakeCtx();
	let model: object | undefined;
	const modelRegistry = { authStorage: {} };
	// OMP scopes event contexts with Object.create; only ui is an own property.
	const ctx = Object.create({
		...uiContext,
		get model() { assert.equal(this, ctx, "OMP accessor retains its handler receiver"); return model; },
		modelRegistry,
	});
	Object.defineProperty(ctx, "ui", { value: uiContext.ui, enumerable: true });
	let nativeContext: { model?: unknown; modelRegistry?: unknown } | undefined;
	const unregister = registerFactoryController(async () => "unused");
	const unregisterSubmitter = registerFactoryBatchSubmitter(async (_action, context) => {
		nativeContext = context as typeof nativeContext;
		return { batchId: "batch-model-context", text: "submitted" };
	});
	const unregisterDashboard = registerFactoryDashboardOpener(async () => {});
	try {
		await pi.events.get("session_start")({}, ctx);
		await review.whenStarted();
		model = { id: "authenticated-model" };
		uiContext.overlays[0].handleInput("space");
		uiContext.selectResponses.push("Inspect only");
		uiContext.overlays[0].handleInput("F");
		for (let i = 0; i < 20; i++) await Promise.resolve();
		assert.ok(nativeContext, "the selected batch reaches Factory");
		assert.equal(nativeContext.model, model, "the authenticated model survives the scoped event context");
		assert.equal(nativeContext.modelRegistry, modelRegistry, "Factory retains the session auth registry");
		model = { id: "replacement-model" };
		assert.equal(nativeContext.model, model, "retained Factory context observes OMP model changes");
		model = undefined;
		assert.equal(nativeContext.model, undefined, "clearing the model cannot leave stale execution authority");
		assert.equal(Object.hasOwn(ctx, "reconcileMutationClaim"), false, "Review does not mutate the host context");
		uiContext.overlays.at(-1).handleInput("q");
	} finally {
		unregisterDashboard();
		unregisterSubmitter();
		unregister();
		await pi.events.get("session_shutdown")?.({}, ctx);
	}
});

for (const outcome of ["success", "error", "cancel"] as const) {
	test(`Factory picker returns to Review after ${outcome}`, async () => {
		const commands: string[] = [];
		const unregister = registerFactoryController(async (command) => {
			commands.push(command);
			if (outcome === "error") throw new Error("Factory command failed");
			return "Factory command completed";
		});
		const pi = fakeHost();
		const review = createReviewExtension(pi, { org: "projectbluefin", fetchImpl: fakeFetch([]), env: ISOLATED_ENV });
		const ctx = fakeCtx();
		try {
			await pi.events.get("session_start")({}, ctx);
			await review.whenStarted();
			ctx.overlays[0].handleInput("space");
			ctx.selectResponses.push(outcome === "cancel" ? "Cancel" : "Inspect only");
			ctx.overlays[0].handleInput("F");
			for (let i = 0; i < 20; i++) await Promise.resolve();
			assert.deepEqual(commands, outcome === "cancel" ? [] : ["start inspect"]);
			assert.equal(ctx.editorCalls.length, 0, "Factory handoff never opens a command editor");
			assert.equal(ctx.selectCalls.length, 1);
			assert.match(ctx.selectCalls[0][0], /Send 1 selected item across 1 repository to Factory/);
			assert.deepEqual(
				ctx.selectCalls[0][1].map((option) => typeof option === "string" ? option : option.label),
				["Implement locally", "Inspect only", "Implement and prepare PR", "Open Factory", "Cancel"],
			);
			if (outcome === "cancel") {
				assert.equal(ctx.overlays.length, 1, "cancel returns to the existing Review workbench");
			} else {
				assert.equal(ctx.overlays.length, 2, "one workbench reopens after handoff settles");
				ctx.overlays[1].handleInput("q");
				for (let i = 0; i < 20; i++) await Promise.resolve();
				assert.equal(ctx.overlays.length, 2, "explicit close stays closed");
			}
		} finally {
			unregister();
			await pi.events.get("session_shutdown")?.({}, ctx);
		}
	});
}
test("Factory picker maps each operator outcome to the existing command path", async () => {
	const choices = [
		["Implement locally", "start patch"],
		["Inspect only", "start inspect"],
		["Implement and prepare PR", "start pr-ready"],
	] as const;
	for (const [choice, expected] of choices) {
		const commands: string[] = [];
		const unregister = registerFactoryController(async (command) => {
			commands.push(command);
			return "Factory command completed";
		});
		const pi = fakeHost();
		const review = createReviewExtension(pi, { org: "projectbluefin", fetchImpl: fakeFetch([]), env: ISOLATED_ENV });
		const ctx = fakeCtx();
		try {
			await pi.events.get("session_start")({}, ctx);
			await review.whenStarted();
			ctx.overlays[0].handleInput("space");
			ctx.overlays[0].handleInput("down");
			ctx.overlays[0].handleInput("space");
			ctx.selectResponses.push(choice);
			ctx.overlays[0].handleInput("F");
			for (let i = 0; i < 20; i++) await Promise.resolve();
			assert.deepEqual(commands, [expected]);
			assert.equal(ctx.editorCalls.length, 0);
			assert.match(ctx.selectCalls[0][0], /Send 2 selected items across 2 repositories to Factory/);
		} finally {
			unregister();
			await pi.events.get("session_shutdown")?.({}, ctx);
		}
	}
});

test("empty Factory handoff opens the cockpit without requiring a selection", async () => {
	const commands: string[] = [];
	const unregister = registerFactoryController(async (command) => {
		commands.push(command);
		return "Factory command completed";
	});
	const unregisterDashboard = registerFactoryDashboardOpener(async () => {});
	const pi = fakeHost();
	const review = createReviewExtension(pi, { org: "projectbluefin", fetchImpl: fakeFetch([]), env: ISOLATED_ENV });
	const ctx = fakeCtx();
	try {
		await pi.events.get("session_start")({}, ctx);
		await review.whenStarted();
		ctx.selectResponses.push("Open Factory");
		ctx.overlays[0].handleInput("F");
		for (let i = 0; i < 20; i++) await Promise.resolve();
		assert.deepEqual(commands, []);
		assert.equal(ctx.selectCalls.length, 1);
		assert.deepEqual(ctx.selectCalls[0][1].map((option) => typeof option === "string" ? option : option.label), ["Open Factory", "Cancel"]);
		assert.equal(ctx.editorCalls.length, 0);
	} finally {
		unregisterDashboard();
		unregister();
	}
});

test("a Review session that offers the Factory handoff has a registered Factory controller", async () => {
	// Review alone first: nothing loaded the Factory package's entry, so the
	// workbench must not offer a handoff it cannot make, and the startup
	// diagnostic must name the cause rather than the execution flag.
	const clearController = registerFactoryController(async () => "stub");
	clearController();
	assert.equal(factoryHandoffState(), "not-registered");

	const pi = fakeHost();
	const review = createReviewExtension(pi, { org: "projectbluefin", fetchImpl: fakeFetch([]), env: ISOLATED_ENV });
	const ctx = fakeCtx();
	ctx.ui.parent = ctx;
	await pi.events.get("session_start")({}, ctx);
	await review.whenStarted();

	const alone = ctx.overlays[0];
	assert.ok(!alone.render(200).join("\n").includes("F factory"), "an unregistered Factory is not advertised as a handoff");
	assert.match(savedReviewNoticeText(pi), /Factory actions aren’t available in this session/, "startup names the unavailable action in user language");
	assert.match(alone.render(100).join("\n"), /You can still browse the GitHub review queue/);
	alone.handleInput("F");
	for (let i = 0; i < 20; i++) await Promise.resolve();
	assert.match(await runReviewCommand(pi, ctx, "details"), /never registered a controller/, "the diagnostic remains available on request");
	ctx.overlays.at(-1).handleInput("q");

	// Co-load: the real package entry registers the controller in this process.
	const factoryHost = fakeHost();
	lunaFactoryExtension(factoryHost as never);
	assert.equal(factoryHandoffState(), "registered");

	const pi2 = fakeHost();
	const review2 = createReviewExtension(pi2, { org: "projectbluefin", fetchImpl: fakeFetch([]), env: ISOLATED_ENV });
	const ctx2 = fakeCtx();
	ctx2.ui.parent = ctx2;
	await pi2.events.get("session_start")({}, ctx2);
	await review2.whenStarted();

	const coLoaded = ctx2.overlays[0];
	assert.ok(coLoaded.render(200).join("\n").includes("F factory"), "a co-loaded Factory is advertised");
	assert.ok(!ctx2.notifications.some((n) => /Factory handoff unavailable/.test(n.message)), "a co-loaded session warns about nothing");
	ctx2.overlays[0].handleInput("space");
	ctx2.selectResponses.push("Open Factory");
	coLoaded.handleInput("F");
	for (let i = 0; i < 20; i++) await Promise.resolve();
	assert.ok(
		!ctx2.notifications.some((n) => /Factory handoff unavailable/.test(n.message)),
		"the handoff reaches the co-loaded Factory surface",
	);
	ctx2.overlays.at(-1).handleInput("q");

	// Loading Factory starts no work, and the handoff is per-session.
	await factoryHost.events.get("session_shutdown")!();
	assert.equal(factoryHandoffState(), "not-registered");
});

test("issue admission gate handles positive admission, negative cases, and invariants", async () => {
	let setupSession = 0;
	const setup = async (issueAttrs, options = {}) => {
		const pi = fakeHost();
		const issues = Array.isArray(issueAttrs) ? issueAttrs : [issueAttrs];
		const issueFetch = (url, init) => {
			const target = String(url);
			if (target.includes("/graphql")) {
				const body = JSON.parse(String(init?.body ?? "{}"));
				// Distinguish search query vs admission query
				if (body.variables?.search !== undefined) {
					return {
						ok: true,
						status: 200,
						statusText: "OK",
						json: async () => ({
							data: {
								search: {
									pageInfo: { hasNextPage: false, endCursor: null },
								nodes: issues.map((it) => ({
									number: it.number ?? 485,
									title: it.title ?? "test issue",
									url: `https://github.com/${it.repo ?? "projectbluefin/review"}/${it.type === "pr" ? "pull" : "issues"}/${it.number ?? 485}`,
									updatedAt: new Date(NOW - 1000).toISOString(),
									isDraft: false,
									mergeable: "MERGEABLE",
									reviewDecision: "REVIEW_REQUIRED",
									author: { login: "someone" },
									repository: { nameWithOwner: it.repo ?? "projectbluefin/review" },
									labels: { nodes: (it.labels ?? []).map((label) => ({ name: label })) },
									changedFiles: it.type === "pr" ? 1 : undefined,
									files: it.type === "pr" ? { pageInfo: { hasNextPage: false }, nodes: [{ path: "README.md" }] } : undefined,
									headRefOid: it.headSha ?? "a".repeat(40),
								})),
								},
							},
						}),
					};
				}
				if (body.query.includes("issueOrPullRequest")) {
					const data = {};
					const exactRegex = /(\w+): repository\(owner: "([^"]+)", name: "([^"]+)"\)[\s\S]*?issueOrPullRequest\(number: (\d+)\)/g;
					for (const [, alias, owner, repo, numberStr] of body.query.matchAll(exactRegex)) {
						const num = Number(numberStr);
						const fullRepo = `${owner}/${repo}`;
						const it = issues.find((candidate) => (candidate.number ?? 485) === num && (candidate.repo ?? "projectbluefin/review") === fullRepo);
						data[alias] = it ? { issueOrPullRequest: {
							closed: false,
							number: num,
							title: it.title ?? "test pull request",
							url: `https://github.com/${fullRepo}/pull/${num}`,
							updatedAt: new Date(NOW - 1000).toISOString(),
							author: { login: "someone" },
							repository: { nameWithOwner: fullRepo },
							labels: { nodes: (it.labels ?? []).map((label) => ({ name: label })) },
							isDraft: false,
							mergeable: "MERGEABLE",
							reviewDecision: "REVIEW_REQUIRED",
							changedFiles: 1,
							files: { pageInfo: { hasNextPage: false }, nodes: [{ path: "README.md" }] },
							headRefOid: it.headSha ?? "a".repeat(40),
							commits: { nodes: [{ commit: { statusCheckRollup: { state: "SUCCESS" } } }] },
							closingIssuesReferences: { nodes: [] },
						} } : { issueOrPullRequest: null };
					}
					return { ok: true, status: 200, statusText: "OK", json: async () => ({ data }) };
				}

				// If options.fetchError is provided, simulate request failure on admission
				if (options.networkError) {
					throw new Error("network connection reset");
				}
				if (options.httpStatus) {
					return { ok: false, status: options.httpStatus, statusText: "Error", json: async () => ({}) };
				}
				if (options.graphqlErrors) {
					return { ok: true, status: 200, statusText: "OK", json: async () => ({ errors: options.graphqlErrors }) };
				}


				// Admission query by alias: parse targets from the query
				const data = {};
				const aliasRegex = /(\w+): repository\(owner: "([^"]+)", name: "([^"]+)"\)\s*\{\s*nameWithOwner\s*issue\(number: (\d+)\)/g;
				for (const [, alias, owner, repo, numberStr] of body.query.matchAll(aliasRegex)) {
					const num = Number(numberStr);
					const fullRepo = `${owner}/${repo}`;
					const it = issues.find((i) => (i.number ?? 485) === num && (i.repo ?? "projectbluefin/review") === fullRepo) ?? {
						number: num,
						repo: fullRepo,
						labels: [],
					};
					if (options.missingNode) {
						data[alias] = { nameWithOwner: fullRepo, issue: null };
						continue;
					}
					const returnedRepo = options.wrongRepo ? "projectbluefin/wrong" : fullRepo;
					const returnedNumber = options.wrongNumber ? 999 : num;
					data[alias] = {
						nameWithOwner: returnedRepo,
						issue: {
							number: returnedNumber,
							closed: options.missingClosed ? undefined : it.closed === true,
							repository: { nameWithOwner: returnedRepo },
							labels: options.missingLabelPageInfo
								? { nodes: (it.admissionLabels ?? it.labels ?? []).map((l) => ({ name: l })) }
								: {
										pageInfo: { hasNextPage: options.labelsTruncated === true },
										nodes: (it.admissionLabels ?? it.labels ?? []).map((l) => ({ name: l })),
									},
						},
					};
				}
				return { ok: true, status: 200, statusText: "OK", json: async () => ({ data }) };
			}
			return { ok: true, status: 200, statusText: "OK", json: async () => [] };
		};
		const fetchImpl = (url, init) => {
			const target = String(url);
			if (target.endsWith("/api/v1/status")) {
				return Promise.resolve({ ok: true, status: 200, statusText: "OK", json: async () => ({ actionable_items: issues.length }) });
			}
			if (target.endsWith("/api/contribute/queue")) {
				return Promise.resolve({
					ok: true,
					status: 200,
					statusText: "OK",
					json: async () => ({ queue: issues.map((item) => ({
						key: `${item.repo ?? "projectbluefin/review"}#${item.number ?? 485}`,
						repo: item.repo ?? "projectbluefin/review",
						number: item.number ?? 485,
						title: item.title ?? "test issue",
					})) }),
				});
			}
			if (target.endsWith("/api/contribute/triage")) return Promise.resolve({ ok: true, status: 200, statusText: "OK", json: async () => ({ groups: [] }) });
			if (target.endsWith("/api/v1/contributors")) return Promise.resolve({ ok: true, status: 200, statusText: "OK", json: async () => ({ contributors: [] }) });
			return (options.customFetch ?? issueFetch)(url, init);
		};

		const review = createReviewExtension(pi, {
			org: "projectbluefin",
			fetchImpl,
			env: {
				...ISOLATED_ENV,
				HIVE_HUB: "wss://hive.example/contribute",
				LUNA_FACTORY_STATE_ROOT: mkdtempSync(join(ISOLATED_ENV.LUNA_FACTORY_STATE_ROOT, "admission-state-")),
				LUNA_FACTORY_CLAIMS_ROOT: mkdtempSync(join(ISOLATED_ENV.LUNA_FACTORY_CLAIMS_ROOT, "admission-")),
			},
			policy: {
				...GENERIC_WORKBENCH_POLICY,
				managedRepositories: [
					{ repository: "projectbluefin/review", requiredLabels: ["3-clanker-queue"], deniedLabels: ["hold", "blocked"] },
					{ repository: "projectbluefin/documentation", requiredLabels: ["3-docs-queue"], deniedLabels: ["hold"] },
				],
				allowWorkflowSlay: false,
			},
		});
		const ctx = fakeCtx();
		ctx.sessionId = `issue-admission-${++setupSession}`;
		ctx.ui.parent = ctx;
		if (!options.isPr) pi.flagValues.set("issues", true);
		await pi.events.get("session_start")({}, ctx);
		await review.whenStarted();
		const dashboard = ctx.overlays[0];
		const turn = async () => {
			for (let i = 0; i < 20; i++) await Promise.resolve();
		};
		return { pi, ctx, dashboard, mode: review, turn };
	};

	// 1. Positive exact-label admission with exactly one dispatch
	{
		const { pi, dashboard, turn } = await setup({ number: 485, labels: ["3-clanker-queue"] });
		pi.messages.length = 0;
		dashboard.handleInput("f");
		await turn();

		assert.equal(pi.messages.length, 1, "admitted issue dispatches exactly once");
		assert.match(pi.messages[0], /Implement projectbluefin\/review#485/);
	}
	// Issue slay uses the same admission gate before implementation.
	{
		const { pi, dashboard, turn } = await setup({ number: 486, labels: ["3-clanker-queue"] });
		pi.messages.length = 0;
		dashboard.handleInput("s");
		await turn();
		assert.equal(pi.messages.length, 1, "admitted issue slay dispatches exactly once");
		assert.match(pi.messages[0], /hive_workbench_lookup.*queue.*knowledge/);
	}
	{
		const { pi, dashboard, ctx, turn } = await setup({ number: 487, labels: [] });
		pi.messages.length = 0;
		dashboard.handleInput("s");
		await turn();
		assert.equal(pi.messages.length, 0, "unadmitted issue slay does not dispatch");
		assert.match(await runReviewCommand(pi, ctx, "details"), /missing explicit admission label/);
	}

	// 2. No label
	{
		const { pi, dashboard, ctx, turn } = await setup({ number: 485, labels: [] });
		pi.messages.length = 0;
		dashboard.handleInput("f");
		await turn();
		assert.equal(pi.messages.length, 0, "no label -> no dispatch");
		assert.match(savedReviewNoticeText(pi), /Review couldn’t complete this step/);
		assert.match(await runReviewCommand(pi, ctx, "details"), /missing explicit admission label/);
	}

	// 3. Only 3-human-queue
	{
		const { pi, dashboard, ctx, turn } = await setup({ number: 485, labels: ["3-human-queue"] });
		pi.messages.length = 0;
		dashboard.handleInput("f");
		await turn();
		assert.equal(pi.messages.length, 0, "3-human-queue only -> no dispatch");
		assert.match(savedReviewNoticeText(pi), /Review couldn’t complete this step/);
		assert.match(await runReviewCommand(pi, ctx, "details"), /missing explicit admission label/);
	}

	// 4. Only hive/* or agent/* provenance
	{
		const { pi, dashboard, ctx, turn } = await setup({ number: 485, labels: ["hive/triage", "agent/task", "area/image"] });
		pi.messages.length = 0;
		dashboard.handleInput("f");
		await turn();
		assert.equal(pi.messages.length, 0, "hive/agent labels only -> no dispatch");
		assert.match(savedReviewNoticeText(pi), /Review couldn’t complete this step/);
		assert.match(await runReviewCommand(pi, ctx, "details"), /missing explicit admission label/);
	}

	// 5. hold label present (even if 3-clanker-queue is present)
	{
		const { pi, dashboard, ctx, turn } = await setup({ number: 485, labels: ["3-clanker-queue", "hold"] });
		pi.messages.length = 0;
		dashboard.handleInput("f");
		await turn();
		assert.equal(pi.messages.length, 0, "hold label -> no dispatch");
		assert.match(await runReviewCommand(pi, ctx, "details"), /hold label/);
	}

	// 6. blocked label present (even if 3-clanker-queue is present)
	{
		const { pi, dashboard, ctx, turn } = await setup({ number: 485, labels: ["3-clanker-queue", "blocked"] });
		pi.messages.length = 0;
		dashboard.handleInput("f");
		await turn();
		assert.equal(pi.messages.length, 0, "blocked label -> no dispatch");
		assert.match(await runReviewCommand(pi, ctx, "details"), /blocked label/);
	}

	// 7. closed issue
	{
		const { pi, dashboard, ctx, turn } = await setup({ number: 485, labels: ["3-clanker-queue"], closed: true });
		pi.messages.length = 0;
		dashboard.handleInput("f");
		await turn();
		assert.equal(pi.messages.length, 0, "closed issue -> no dispatch");
		assert.match(await runReviewCommand(pi, ctx, "details"), /issue is closed/);
	}

	// 8. Admission removed between display and dispatch
	{
		// Queue showed 3-clanker-queue, but admission check returns labels: []
		const { pi, dashboard, ctx, turn } = await setup({ number: 485, labels: ["3-clanker-queue"], admissionLabels: [] });
		pi.messages.length = 0;
		dashboard.handleInput("f");
		await turn();
		assert.equal(pi.messages.length, 0, "label removed between display and dispatch -> no dispatch");
		assert.match(await runReviewCommand(pi, ctx, "details"), /missing explicit admission label/);
	}

	// 9. Request failure (network error / HTTP error / GraphQL partial errors)
	{
		const { pi, dashboard, ctx, turn } = await setup({ number: 485, labels: ["3-clanker-queue"] }, { networkError: true });
		pi.messages.length = 0;
		dashboard.handleInput("f");
		await turn();
		assert.equal(pi.messages.length, 0, "network error -> no dispatch");
		assert.match(await runReviewCommand(pi, ctx, "details"), /Admission check failed/);
	}
	{
		const { pi, dashboard, ctx, turn } = await setup({ number: 485, labels: ["3-clanker-queue"] }, { graphqlErrors: [{ message: "rate limited" }] });
		pi.messages.length = 0;
		dashboard.handleInput("f");
		await turn();
		assert.equal(pi.messages.length, 0, "graphql error -> no dispatch");
		assert.match(await runReviewCommand(pi, ctx, "details"), /rate limited/);
	}

	// 10. Incomplete label evidence (labelsTruncated)
	{
		const { pi, dashboard, ctx, turn } = await setup({ number: 485, labels: ["3-clanker-queue"] }, { labelsTruncated: true });
		pi.messages.length = 0;
		dashboard.handleInput("f");
		await turn();
		assert.equal(pi.messages.length, 0, "truncated labels -> no dispatch");
		assert.match(await runReviewCommand(pi, ctx, "details"), /incomplete label evidence/);
	}
	// Missing freshness evidence fails closed.
	{
		const { pi, dashboard, ctx, turn } = await setup(
			{ number: 485, labels: ["3-clanker-queue"] },
			{ missingClosed: true },
		);
		pi.messages.length = 0;
		dashboard.handleInput("f");
		await turn();
		assert.equal(pi.messages.length, 0, "missing open-state evidence -> no dispatch");
		assert.match(await runReviewCommand(pi, ctx, "details"), /issue is closed/);
	}
	{
		const { pi, dashboard, ctx, turn } = await setup(
			{ number: 485, labels: ["3-clanker-queue"] },
			{ missingLabelPageInfo: true },
		);
		pi.messages.length = 0;
		dashboard.handleInput("f");
		await turn();
		assert.equal(pi.messages.length, 0, "missing label pagination evidence -> no dispatch");
		assert.match(await runReviewCommand(pi, ctx, "details"), /incomplete label evidence/);
	}

	// 11. Wrong returned repository or issue identity
	{
		const { pi, dashboard, ctx, turn } = await setup({ number: 485, labels: ["3-clanker-queue"] }, { wrongRepo: true });
		pi.messages.length = 0;
		dashboard.handleInput("f");
		await turn();
		assert.equal(pi.messages.length, 0, "wrong repo returned -> no dispatch");
		assert.match(await runReviewCommand(pi, ctx, "details"), /repository mismatch/);
	}
	{
		const { pi, dashboard, ctx, turn } = await setup({ number: 485, labels: ["3-clanker-queue"] }, { wrongNumber: true });
		pi.messages.length = 0;
		dashboard.handleInput("f");
		await turn();
		assert.equal(pi.messages.length, 0, "wrong issue number returned -> no dispatch");
		assert.match(await runReviewCommand(pi, ctx, "details"), /issue number mismatch/);
	}

	// 12. Missing node
	{
		const { pi, dashboard, ctx, turn } = await setup({ number: 485, labels: ["3-clanker-queue"] }, { missingNode: true });
		pi.messages.length = 0;
		dashboard.handleInput("f");
		await turn();
		assert.equal(pi.messages.length, 0, "missing node -> no dispatch");
		assert.match(await runReviewCommand(pi, ctx, "details"), /not found/);
	}

	// 13. Mixed batch containing one ineligible Review issue: zero dispatches (do not silently shrink)
	{
		const items = [
			{ number: 485, repo: "projectbluefin/review", labels: ["3-clanker-queue"] }, // eligible
			{ number: 486, repo: "projectbluefin/review", labels: ["hold"] }, // ineligible
		];
		const { pi, dashboard, ctx, turn } = await setup(items);
		// Select all items using 'A'
		dashboard.handleInput("A");
		pi.messages.length = 0;
		dashboard.handleInput("f");
		await turn();
		assert.equal(pi.messages.length, 0, "batch with one ineligible item yields zero dispatches");
		assert.match(await runReviewCommand(pi, ctx, "details"), /issue has hold label/);
	}

	// 14. Mixed batch containing Review issue and other repo issue: if Review issue is ineligible, zero dispatches
	{
		const items = [
			{ number: 10, repo: "projectbluefin/other", labels: [] },
			{ number: 485, repo: "projectbluefin/review", labels: [] },
		];
		const { pi, dashboard, ctx, turn } = await setup(items);
		dashboard.handleInput("A");
		pi.messages.length = 0;
		dashboard.handleInput("f");
		await turn();
		assert.equal(pi.messages.length, 0, "mixed-repo batch with ineligible review issue yields zero dispatches");
		assert.match(await runReviewCommand(pi, ctx, "details"), /missing explicit admission label/);
	}

	// 15. Unmanaged repository issue: no admission read needed, still dispatches as before
	{
		const { pi, dashboard, turn } = await setup({ number: 936, repo: "projectbluefin/utah", labels: [] });
		pi.messages.length = 0;
		dashboard.handleInput("f");
		await turn();
		assert.equal(pi.messages.length, 1, "unmanaged repository issue dispatches without any admission read");
		assert.match(pi.messages[0], /projectbluefin\/utah#936/);
	}

	// 16. Read-only actions (diff, reference), PR actions, and other issue implementation actions ('fix', 'docs')
	{
		const { pi, dashboard, turn } = await setup({ number: 485, labels: [] });
		pi.messages.length = 0;
		// 'd' for diff — on an issue it inspects the discussion, not the PR-only diff tool
		dashboard.handleInput("d");
		await turn();
		assert.equal(pi.messages.length, 1, "diff is read-only and dispatches without admission gate");
		assert.match(pi.messages[0], /gh issue view 485 --repo projectbluefin\/review --comments/);
	}
	{
		const { dashboard, ctx, turn } = await setup({ number: 485, labels: [] });
		dashboard.handleInput("i");
		await turn();
		assert.ok(ctx.pasted.length > 0, "cite/reference is read-only");
		assert.match(ctx.notifications.at(-1)?.message ?? "", /Added item to the prompt/);
	}
	// fix on an unadmitted Review issue dispatches zero messages and notifies
	{
		const { pi, dashboard, ctx, turn } = await setup({ number: 485, labels: [] });
		pi.messages.length = 0;
		dashboard.handleInput("f");
		await turn();
		assert.equal(pi.messages.length, 0, "fix on unadmitted Review issue dispatches zero messages");
		assert.match(await runReviewCommand(pi, ctx, "details"), /missing explicit admission label/);
	}
	// fix on a projectbluefin/review PR is unchanged (no admission read, dispatches)
	{
		const { pi, dashboard, turn } = await setup({ number: 42, type: "pr", repo: "projectbluefin/review", labels: [] }, { isPr: true });
		pi.messages.length = 0;
		dashboard.handleInput("f");
		await turn();
		assert.equal(pi.messages.length, 1, "fix on Review PR dispatches unchanged without admission read");
		assert.match(pi.messages[0], /Fix projectbluefin\/review#42/);
	}

	// 16b. Managed-repository policy is per repository, each with its own vocabulary
	{
		// projectbluefin/documentation is managed with a different admission label
		// and a narrower denied set than projectbluefin/review.
		const { pi, dashboard, turn } = await setup({ number: 21, repo: "projectbluefin/documentation", labels: ["3-docs-queue"] });
		pi.messages.length = 0;
		dashboard.handleInput("f");
		await turn();
		assert.equal(pi.messages.length, 1, "documentation issue admitted on its own queue label");
		assert.match(pi.messages[0], /projectbluefin\/documentation#21/);
	}
	{
		// A review vocabulary label does not admit a documentation issue.
		const { pi, dashboard, ctx, turn } = await setup({ number: 21, repo: "projectbluefin/documentation", labels: ["3-clanker-queue"] });
		pi.messages.length = 0;
		dashboard.handleInput("f");
		await turn();
		assert.equal(pi.messages.length, 0, "review queue label does not admit a documentation issue");
		assert.match(await runReviewCommand(pi, ctx, "details"), /missing explicit admission label/);
	}
	{
		// A review denied label (blocked) is not in the documentation policy, so it
		// does not block; documentation's own denied label (hold) does.
		const { pi, dashboard, ctx, turn } = await setup({ number: 21, repo: "projectbluefin/documentation", labels: ["3-docs-queue", "hold"] });
		pi.messages.length = 0;
		dashboard.handleInput("f");
		await turn();
		assert.equal(pi.messages.length, 0, "documentation hold label blocks its own dispatch");
		assert.match(await runReviewCommand(pi, ctx, "details"), /issue has hold label/);
	}
	{
		// Negative fixture in the review repository: hold blocks there too.
		const { pi, dashboard, ctx, turn } = await setup({ number: 485, repo: "projectbluefin/review", labels: ["3-clanker-queue", "hold"] });
		pi.messages.length = 0;
		dashboard.handleInput("f");
		await turn();
		assert.equal(pi.messages.length, 0, "review hold label blocks its own dispatch");
		assert.match(await runReviewCommand(pi, ctx, "details"), /issue has hold label/);
	}

	// 17. Selection changes during the read: no retargeting
	{
		const { promise, resolve } = Promise.withResolvers();
		const customFetch = (url, init) => {
			const target = String(url);
			if (target.includes("/graphql")) {
				const body = JSON.parse(String(init?.body ?? "{}"));
				if (body.variables?.search !== undefined) {
					return {
						ok: true,
						status: 200,
						statusText: "OK",
						json: async () => ({
							data: {
								search: {
									pageInfo: { hasNextPage: false, endCursor: null },
									nodes: [
										{
											number: 485,
											title: "first issue",
											url: "https://github.com/projectbluefin/review/issues/485",
											updatedAt: new Date(NOW - 1000).toISOString(),
											author: { login: "someone" },
											repository: { nameWithOwner: "projectbluefin/review" },
											labels: { nodes: [{ name: "3-clanker-queue" }] },
										},
										{
											number: 486,
											title: "second issue",
											url: "https://github.com/projectbluefin/review/issues/486",
											updatedAt: new Date(NOW - 2000).toISOString(),
											author: { login: "someone" },
											repository: { nameWithOwner: "projectbluefin/review" },
											labels: { nodes: [] },
										},
									],
								},
							},
						}),
					};
				}
				return promise;
			}
			return { ok: true, status: 200, statusText: "OK", json: async () => [] };
		};

		const { pi, dashboard, turn } = await setup([{ number: 485 }, { number: 486 }], { customFetch });
		pi.messages.length = 0;
		dashboard.handleInput(" ");
		// Trigger dispatch for the explicitly selected item 485.
		dashboard.handleInput("f");

		// While admission read is pending, navigate to item 486
		dashboard.handleInput("j");

		// Now resolve the admission read
		resolve({
			ok: true,
			status: 200,
			statusText: "OK",
			json: async () => ({
				data: {
					iss0: {
						nameWithOwner: "projectbluefin/review",
						issue: {
							number: 485,
							closed: false,
							repository: { nameWithOwner: "projectbluefin/review" },
							labels: { pageInfo: { hasNextPage: false }, nodes: [{ name: "3-clanker-queue" }] },
						},
					},
				},
			}),
		});
		await turn();
		assert.equal(pi.messages.length, 1);
		assert.match(pi.messages[0], /projectbluefin\/review#485/, "prompt must dispatch for captured item 485, not navigated item 486");
	}

	// 18. Superseded dispatch generation discard: stale in-flight admission resolution produces no dispatch
	{
		let resolveFirst;
		let resolveSecond;
		let requestCount = 0;
		const { promise: p1, resolve: r1 } = Promise.withResolvers();
		const { promise: p2, resolve: r2 } = Promise.withResolvers();
		resolveFirst = r1;
		resolveSecond = r2;

		const customFetch = (url, init) => {
			const target = String(url);
			if (target.includes("/graphql")) {
				const body = JSON.parse(String(init?.body ?? "{}"));
				if (body.variables?.search !== undefined) {
					return {
						ok: true,
						status: 200,
						statusText: "OK",
						json: async () => ({
							data: {
								search: {
									pageInfo: { hasNextPage: false, endCursor: null },
									nodes: [
										{
											number: 485,
											title: "first issue",
											url: "https://github.com/projectbluefin/review/issues/485",
											updatedAt: new Date(NOW - 1000).toISOString(),
											author: { login: "someone" },
											repository: { nameWithOwner: "projectbluefin/review" },
											labels: { nodes: [{ name: "3-clanker-queue" }] },
										},
										{
											number: 486,
											title: "second issue",
											url: "https://github.com/projectbluefin/review/issues/486",
											updatedAt: new Date(NOW - 2000).toISOString(),
											author: { login: "someone" },
											repository: { nameWithOwner: "projectbluefin/review" },
											labels: { nodes: [{ name: "3-clanker-queue" }] },
										},
									],
								},
							},
						}),
					};
				}

				requestCount++;
				if (requestCount === 1) {
					return p1;
				}
				return p2;
			}
			return { ok: true, status: 200, statusText: "OK", json: async () => [] };
		};

		const { pi, dashboard, ctx, turn } = await setup([{ number: 485 }, { number: 486 }], { customFetch });
		pi.messages.length = 0;

		// Dispatch 1 on explicitly selected item 485 (pending on p1).
		dashboard.handleInput(" ");
		dashboard.handleInput("f");
		await Promise.resolve();

		// Move to item 486 and start Dispatch 2 on the same persistent workbench.
		dashboard.handleInput("x");
		dashboard.handleInput("j");
		dashboard.handleInput(" ");
		dashboard.handleInput("f");
		await Promise.resolve();
		// Resolve Dispatch 2 first
		resolveSecond({
			ok: true,
			status: 200,
			statusText: "OK",
			json: async () => ({
				data: {
					iss0: {
						nameWithOwner: "projectbluefin/review",
						issue: {
							number: 486,
							closed: false,
							repository: { nameWithOwner: "projectbluefin/review" },
							labels: { pageInfo: { hasNextPage: false }, nodes: [{ name: "3-clanker-queue" }] },
						},
					},
				},
			}),
		});
		await turn();

		assert.equal(pi.messages.length, 1, "Dispatch 2 sends exactly one user message");
		assert.match(pi.messages[0], /projectbluefin\/review#486/);

		// Now let Dispatch 1 resolve late (superseded generation)
		resolveFirst({
			ok: true,
			status: 200,
			statusText: "OK",
			json: async () => ({
				data: {
					iss0: {
						nameWithOwner: "projectbluefin/review",
						issue: {
							number: 485,
							closed: false,
							repository: { nameWithOwner: "projectbluefin/review" },
							labels: { pageInfo: { hasNextPage: false }, nodes: [{ name: "3-clanker-queue" }] },
						},
					},
				},
			}),
		});
		await turn();

		// The stale generation must NOT authorize work or emit an extra message
		assert.equal(pi.messages.length, 1, "stale generation produced zero extra messages; total dispatches across both requests remains 1");
		assert.match(pi.messages[0], /projectbluefin\/review#486/);
	}
});

// OMP workbench mouse/click parity (#462).
test("OMP workbench mouse and click operability matches keyboard actions (#462)", (t) => {
	// Terminal mouse reporting: SGR clicks, releases, and wheel events.
	const sgrClick = parseMouseEvent("\x1b[<0;15;5M");
	assert.deepEqual(sgrClick, { button: 0, col: 14, row: 4, release: false });
	const sgrRelease = parseMouseEvent("\x1b[<0;15;5m");
	assert.deepEqual(sgrRelease, { button: 0, col: 14, row: 4, release: true });
	const sgrWheelUp = parseMouseEvent("\x1b[<64;15;5M");
	assert.equal(sgrWheelUp?.wheel, -1);

	const root = mkdtempSync(join(tmpdir(), "workbench-test-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const mode = new ReviewMode({ org: "projectbluefin", env: { ...ISOLATED_ENV, REVIEW_MODE: "hive" } });
	mode.items = [
		queueItem({ id: 7, repo: "projectbluefin/other", title: "feat(ui): dagger rail", ciStatus: "success" }),
		queueItem({ id: 42, repo: "projectbluefin/review", title: "fix(landing): review batches", ciStatus: "failure" }),
		queueItem({ id: 99, repo: "projectbluefin/review", title: "docs: update appliance", ciStatus: "pending" }),
	];
	;

	let lastAction;
	let refreshes = 0;
	const dashboard = new ReviewDashboard(
		{ requestRender() {} },
		PLAIN_PAINTER,
		mode,
		(action) => {
			lastAction = action;
		},
		() => {
			refreshes++;
		},
		22,
	);
	t.after(() => dashboard.dispose());

	// Initial layout and state
	const frame = (w = 220) => dashboard.render(w);
	assert.ok(frame()[0].includes("HIVE WORKBENCH"));
	assert.equal(mode.cursor, 0, "first item selected initially");
	assert.equal(dashboard.currentPane, "queue");

	// 2. Click selection parity: clicking queue row 2 selects item 42
	// Line 3 is item 7, Line 4 is the repo divider for projectbluefin/review,
	// Line 5 is item 42, Line 6 is item 99.
	// Passing SGR mouse sequence: x=10, y=6 (1-based -> line index 5 in 0-based)
	dashboard.handleInput("\x1b[<0;10;6M");
	assert.equal(mode.cursor, 1, "clicking row 2 selects item 42");
	assert.equal(mode.selected().id, 42);
	assert.equal(dashboard.currentPane, "queue");

	// Click row 3 (line index 6, y=7 in SGR): selects item 99
	dashboard.handleInput("\x1b[<0;10;7M");
	assert.equal(mode.cursor, 2, "clicking row 3 selects item 99");
	assert.equal(mode.selected().id, 99);

	// Click divider (line index 4, y=5 in SGR): divider click does not crash or corrupt cursor
	dashboard.handleInput("\x1b[<0;10;5M");
	assert.equal(mode.cursor, 2, "clicking divider preserves selection");

	// Click row 1 (line index 3, y=4 in SGR): selects item 7
	dashboard.handleInput("\x1b[<0;10;4M");
	assert.equal(mode.cursor, 0, "clicking row 1 selects item 7");
	assert.equal(mode.selected().id, 7);

	// Click checkbox on row 1 (columns 1..3, row 4 in 1-based coordinates)
	assert.equal(mode.selectedKeys.has("projectbluefin/other#7"), false);
	dashboard.handleInput("\x1b[<0;3;4M");
	assert.equal(mode.selectedKeys.has("projectbluefin/other#7"), true, "clicking checkbox selects item");
	assert.ok(frame().some((r) => r.includes("☒")));

	// Clicking checkbox again toggles it off
	dashboard.handleInput("\x1b[<0;3;4M");
	assert.equal(mode.selectedKeys.has("projectbluefin/other#7"), false, "clicking checkbox again deselects item");

	// 3. Panes focus parity: clicking trace pane focuses trace pane
	// Trace pane starts at col half+ (right side of split layout)
	dashboard.handleInput("\x1b[<0;151;4M");
	assert.equal(dashboard.currentPane, "trace", "clicking right pane focuses trace");
	assert.equal(dashboard.activePane, "trace");

	// Clicking queue pane focuses queue pane back
	dashboard.handleInput("\x1b[<0;15;4M");
	assert.equal(dashboard.currentPane, "queue", "clicking left pane focuses queue");

	// 4. Traces toggle parity: expanding and collapsing trace spans on click
	dashboard.handleInput("\x1b[<0;151;4M"); // focus trace pane
	const beforeFoldFrame = frame();
	// Click a trace span row (e.g. row 5 in trace pane)
	dashboard.handleClick(150, 5);
	const afterFoldFrame = frame();
	assert.ok(afterFoldFrame.length > 0);
	// Clicking again toggles expansion back
	dashboard.handleClick(150, 5);

	// 5. Mouse scrolling parity (wheel up/down)
	dashboard.handleClick(15, 4); // focus queue pane
	assert.equal(mode.cursor, 0);
	// Wheel down moves down 1 item
	dashboard.handleInput("\x1b[<65;15;5M");
	assert.equal(mode.cursor, 1, "wheel down moves cursor to next item");
	// Wheel down again
	dashboard.handleInput("\x1b[<65;15;5M");
	assert.equal(mode.cursor, 2, "wheel down moves cursor to 3rd item");
	// Wheel up moves back
	dashboard.handleInput("\x1b[<64;15;5M");
	assert.equal(mode.cursor, 1, "wheel up moves cursor up");

	// 6. Every visible keymap action has mouse parity.
	const lines = dashboard.render(400);
	const keymapLineIdx = lines.findIndex((line) => line.includes("slay") && line.includes("comment"));
	assert.ok(keymapLineIdx > 0, "keymap bar rendered");
	const keymapText = lines[keymapLineIdx];

	const sPos = keymapText.indexOf("s slay");
	assert.ok(sPos > 0);
	dashboard.handleClick(sPos + 1, keymapLineIdx);
	assert.equal(lastAction?.kind, "slay", "clicking slay dispatches autoreview");

	const cPos = keymapText.indexOf("c comment");
	assert.ok(cPos > 0);
	dashboard.handleClick(cPos + 1, keymapLineIdx);
	assert.equal(lastAction?.kind, "comment", "clicking comment emits a comment action");

	const dPos = keymapText.indexOf("d diff");
	assert.ok(dPos > 0);
	dashboard.handleClick(dPos + 1, keymapLineIdx);
	assert.equal(lastAction?.kind, "diff", "clicking diff emits a diff action");

	const fPos = keymapText.indexOf("f fix");
	assert.ok(fPos > 0);
	dashboard.handleClick(fPos + 1, keymapLineIdx);
	assert.equal(lastAction?.kind, "fix", "clicking fix emits a non-landing work action");

	const enterPos = keymapText.indexOf("enter cite");
	assert.ok(enterPos > 0);
	dashboard.handleClick(enterPos + 1, keymapLineIdx);
	assert.equal(lastAction?.kind, "reference", "clicking Enter cites the focused item");
	const vPos = keymapText.indexOf("v read");
	assert.ok(vPos > 0);
	dashboard.handleClick(vPos + 1, keymapLineIdx);
	assert.match(dashboard.render(400)[2], /PR READER:/, "clicking v opens the reader");
	dashboard.handleInput("q");
	const iPos = keymapText.indexOf("i cite");
	assert.ok(iPos > 0);
	dashboard.handleClick(iPos + 1, keymapLineIdx);
	assert.equal(lastAction?.kind, "reference", "clicking cite emits a reference action");

	const APos = keymapText.indexOf("A all");
	assert.ok(APos > 0);
	dashboard.handleClick(APos + 1, keymapLineIdx);
	assert.equal(mode.selectedKeys.size, 3, "clicking all selects every visible item");
	const xPos = keymapText.indexOf("x clear");
	assert.ok(xPos > 0);
	dashboard.handleClick(xPos + 1, keymapLineIdx);
	assert.equal(mode.selectedKeys.size, 0, "clicking clear clears selection");

	const oPos = keymapText.indexOf("o repo");
	assert.ok(oPos > 0);
	dashboard.handleClick(oPos + 1, keymapLineIdx);
	assert.equal(lastAction?.kind, "scope", "clicking repo opens the scope selector");

	const tPos = keymapText.indexOf("t trace");
	assert.ok(tPos > 0);
	const paneBefore = dashboard.currentPane;
	dashboard.handleClick(tPos + 1, keymapLineIdx);
	assert.notEqual(dashboard.currentPane, paneBefore, "clicking t switches pane");

	const tabPos = keymapText.indexOf("tab prs/issues");
	assert.ok(tabPos > 0);
	const modeBefore = mode.queueMode;
	const itemsBefore = [...mode.items];
	dashboard.handleClick(tabPos + 1, keymapLineIdx);
	assert.notEqual(mode.queueMode, modeBefore, "clicking Tab toggles queue mode");
	const issueKeymapText = dashboard.render(400)[keymapLineIdx];
	const issueTabPos = issueKeymapText.indexOf("tab prs/issues");
	assert.ok(issueTabPos > 0);
	dashboard.handleClick(issueTabPos + 1, keymapLineIdx);
	assert.equal(mode.queueMode, modeBefore);
	mode.items = itemsBefore;
	;

	const HPos = keymapText.indexOf("H hive");
	assert.ok(HPos > 0);
	const hiveBefore = mode.hiveOnly;
	dashboard.handleClick(HPos + 1, keymapLineIdx);
	assert.notEqual(mode.hiveOnly, hiveBefore, "clicking H toggles Hive-only filtering");
	dashboard.handleClick(HPos + 1, keymapLineIdx);
	assert.equal(mode.hiveOnly, hiveBefore);

	// Click 'close' (q)
	const qPos = keymapText.indexOf("q close");
	assert.ok(qPos > 0);
	dashboard.handleClick(qPos + 1, keymapLineIdx);
	assert.equal(lastAction?.kind, "close", "clicking close chord triggers close action");

	// 7. Active-turn concurrency: actions remain available during active turns
	mode.session.startTurn(NOW);
	mode.session.startTool("active-turn-tool", "bash", { command: "just review-check" }, NOW + 10);
	;
	assert.ok(mode.session.active() !== undefined, "active tool turn in flight");

	// During active turn: click selects row, expands trace, and triggers actions
	dashboard.handleClick(15, 3);
	assert.equal(mode.cursor, 0, "active turn allows click row selection");
	dashboard.handleClick(250, 4);
	assert.equal(dashboard.currentPane, "trace", "active turn allows pane focus");
	dashboard.handleClick(sPos + 1, keymapLineIdx);
	assert.equal(lastAction?.kind, "slay", "active turn allows slay dispatch");
	mode.session.endTool("active-turn-tool", { content: [{ type: "text", text: "done" }] }, false, NOW + 100);
	mode.session.endTurn(NOW + 200);

	// 8. Header and status bar clicks
	// Header row: clicking mode area toggles mode
	dashboard.handleClick(25, 0);
	assert.equal(mode.queueMode, "issues");
	dashboard.handleClick(25, 0);
	assert.equal(mode.queueMode, "prs");
	mode.items = itemsBefore;
	;

	// 9. Narrow terminal stacked layout click parity
	const narrowFrame = dashboard.render(70);
	assert.ok(narrowFrame.some((r) => r.startsWith("▼ QUEUE") || r.startsWith("▶ QUEUE")));
	// Click queue row in narrow layout (row 3 is item 7, row 4 is divider, row 5 is item 42)
	dashboard.handleClick(15, 3);
	assert.equal(mode.cursor, 0);
	dashboard.handleClick(15, 4);
	assert.equal(mode.cursor, 0, "clicking divider in stacked layout preserves selection");
	dashboard.handleClick(15, 5);
	assert.equal(mode.cursor, 1, "narrow stacked layout selects row on click");
});

// Bounded adaptive tool fallback: the queue is two sources, one truth. Search
// decides what is nearby; the by-name lookup repairs what Hive requires and is
// outside the window; the shortfall is reported instead of a row that merely
// looks complete. From the repaired queue the agent reaches a typed tool, reads
// live checks, and stops at the merge line.
test("bounded fallback repairs by name, observes live checks, and never merges", async (t) => {
	const root = mkdtempSync(join(tmpdir(), "workbench-test-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));

	const listState = () =>
		(readdirSync(root, { recursive: true }) as string[]).sort();
	const before = listState();

	// Search only surfaces one nearby PR. Hive's issue-only work must not be
	// looked up as a pull request, while its explicit open linked PR can still
	// arrive by identity. A direct Hive PR that is closed remains a shortfall.
	const byName = {
		"projectbluefin/review#937": {
			number: 937,
			title: "hold: gate the release behind soak",
			url: "https://github.com/projectbluefin/review/pull/937",
			updatedAt: new Date(NOW - 5 * 24 * 3600 * 1000).toISOString(),
			isDraft: false,
			mergeable: "MERGEABLE",
			reviewDecision: "REVIEW_REQUIRED",
			additions: 0,
			deletions: 0,
			author: { login: "castrojo" },
			repository: { nameWithOwner: "projectbluefin/review" },
			labels: { nodes: [{ name: "hold" }, { name: "review_required" }] },
			commits: { nodes: [{ commit: { statusCheckRollup: { state: "PENDING" } } }] },
			closingIssuesReferences: {
				nodes: [{ number: 936, repository: { nameWithOwner: "projectbluefin/review" } }],
			},
		},
	};
	const lookupQueries: string[] = [];

	const fetchImpl = async (url, init) => {
		const target = String(url);
		if (target.includes("/graphql")) {
			const body = JSON.parse(String(init?.body ?? "{}"));
			if (body.variables?.search) {
				return {
					ok: true,
					status: 200,
					statusText: "OK",
					json: async () => ({
						data: {
							search: {
								pageInfo: { hasNextPage: false, endCursor: null },
								nodes: [
									{
										number: 42,
										title: "fix(launcher): resolve HIVE_HUB before mutating",
										url: "https://github.com/projectbluefin/review/pull/42",
										updatedAt: new Date(NOW - 1000).toISOString(),
										isDraft: false,
										mergeable: "MERGEABLE",
										reviewDecision: "REVIEW_REQUIRED",
										additions: 42,
										deletions: 7,
										changedFiles: 3,
										author: { login: "jorge" },
										repository: { nameWithOwner: "projectbluefin/review" },
										labels: { nodes: [{ name: "launcher" }] },
										commits: { nodes: [{ commit: { statusCheckRollup: { state: "FAILURE" } } }] },
									},
								],
							},
						},
					}),
				};
			}
			lookupQueries.push(body.query);
			// Native gh repair: one aliased by-name lookup for what search missed.
			const data = {};
			const lookup = /(\w+): repository\(owner: "([^"]+)", name: "([^"]+)"\)\s*\{\s*issueOrPullRequest\(number: (\d+)\)/g;
			for (const m of body.query.matchAll(lookup)) {
				const w = m[1], owner = m[2], name = m[3], number = m[4];
				data[w] = { issueOrPullRequest: byName[`${owner}/${name}#${number}`] ?? null };
			}
			return { ok: true, status: 200, statusText: "OK", json: async () => ({ data }) };
		}
		if (target.includes("/api/v1/status")) {
			return { ok: true, status: 200, statusText: "OK", json: async () => ({ hub: "online", actionable_items: 12 }) };
		}
		if (target.includes("/api/contribute/queue")) {
			return {
				ok: true,
				status: 200,
				statusText: "OK",
				json: async () => ({
					queue: [
						{ repo: "projectbluefin/review", number: 42, title: "fix(launcher)", url: "https://github.com/projectbluefin/review/pull/42", updatedAt: new Date(NOW - 1000).toISOString(), author: { login: "jorge" }, repository: { nameWithOwner: "projectbluefin/review" }, labels: { nodes: [] }, closed: false },
						{ repo: "projectbluefin/review", number: 936, title: "hold: gate the release", url: "https://github.com/projectbluefin/review/issues/936", updatedAt: new Date(NOW - 5 * 24 * 3600 * 1000).toISOString(), author: { login: "castrojo" }, repository: { nameWithOwner: "projectbluefin/review" }, labels: { nodes: [] }, closed: false, pr: { number: 937, url: "https://github.com/projectbluefin/review/pull/937", state: "open" } },
						{ repo: "projectbluefin/review", number: 470, title: "ship the launcher", url: "https://github.com/projectbluefin/review/pull/470", updatedAt: new Date(NOW - 2 * 24 * 3600 * 1000).toISOString(), author: { login: "ada" }, repository: { nameWithOwner: "projectbluefin/review" }, labels: { nodes: [] }, closed: true },
					],
				}),
			};
		}
		if (target.includes("/api/contribute/triage") || target.includes("/api/v1/contributors")) {
			return { ok: true, status: 200, statusText: "OK", json: async () => ({ groups: [], contributors: [] }) };
		}
		if (target.includes("/pulls/")) {
			// The available typed tool, reached natively — no browser in the path.
			return { ok: true, status: 200, statusText: "OK", json: async () => [
				{ filename: "image/entrypoint.sh", status: "modified", additions: 3, deletions: 1, patch: "@@ -1 +1 @@\n-old\n+new" },
			] };
		}
		return { ok: true, status: 404, statusText: "Not Found", json: async () => ({}) };
	};

	const pi = fakeHost();
	const review = createReviewExtension(pi, {
		org: "projectbluefin",
		fetchImpl: fetchImpl as unknown as typeof fetch,
		env: { ...ISOLATED_ENV, HIVE_HUB: "https://hive.example" },
	});
	const ctx = fakeCtx();
	ctx.ui.parent = ctx;
	;
	await pi.events.get("session_start")({}, ctx);
	await review.whenStarted();

	// The fallback repairs only mode-matching identities: the nearby PR and the
	// linked PR are present, the issue-only key was never queried as a PR, and
	// the closed direct PR is reported as a shortfall.
	const queue = await pi.tools.get("hive_workbench_queue").execute("id", {});
	assert.match(queue.content[0].text, /projectbluefin\/review#42/);
	assert.match(queue.content[0].text, /projectbluefin\/review#937/, "the linked PR arrives by native repair");
	assert.doesNotMatch(queue.content[0].text, /#936/, "the source issue is not rendered as a pull request");
	assert.doesNotMatch(queue.content[0].text, /#470/, "the closed pull request is a shortfall, not a row");
	assert.equal(lookupQueries.length, 1);
	assert.doesNotMatch(lookupQueries[0]!, /number: 936/, "issue-only keys are not queried as pull requests");
	assert.match(lookupQueries[0]!, /number: 937/, "the explicit open linked pull request is queried");
	assert.equal(queue.details.order_source, "hive");

	// Queue repair is in-memory only: it writes no files.
	assert.deepEqual(listState(), before, "repair made no on-disk changes");

	// The agent reaches a typed tool from the repaired queue and reads the real
	// bounded diff — native gh, not a browser — honest about its bounds.
	const diff = await pi.tools.get("hive_workbench_diff").execute("id", { pull_request: 42, repo: "projectbluefin/review" });
	assert.match(diff.content[0].text, /entrypoint\.sh/);
	assert.match(diff.content[0].text, /\+3 -1/);
	assert.equal(diff.isError, false);

	// The status tool observes live checks and names the queue authority.
	// The selected item's review state is a blocker the tool reports.
	const status = await pi.tools.get("hive_workbench_status").execute("id", {});
	assert.match(status.content[0].text, /ci: 0 passing, 1 failing, 1 pending/);
	assert.match(status.content[0].text, /review_required/);
	assert.match(status.content[0].text, /missing from this queue/, "the unresolved item is reported, not hidden");
	assert.equal(status.details.order_source, "hive");
	assert.equal(status.details.hive.queued.present, 2);
	assert.equal(status.details.hive.queued.total, 3, "only mode-matching Hive work contributes to coverage");

	// The queue refreshes without duplicating the repaired rows.
	(pi.shortcuts.get("alt+u") as { handler: (ctx: unknown) => void }).handler(ctx);
	await review.whenStarted();
	const queue2 = await pi.tools.get("hive_workbench_queue").execute("id", {});
	const occurrences = queue2.content[0].text.match(/projectbluefin\/review#937/g) ?? [];
	assert.equal(occurrences.length, 1, "a refresh does not re-add a repaired row");
});

test("fix button dispatches workflowz wave for selected issues without requiring Hive", async () => {
	const issues = [
		{ number: 101, title: "first bug", repo: "projectbluefin/unmanaged" },
		{ number: 102, title: "second bug", repo: "projectbluefin/unmanaged" },
	];
	const fetchImpl = async (url: string | URL | Request, init?: RequestInit) => {
		const target = String(url);
		if (target.includes("/graphql")) {
			return {
				ok: true,
				status: 200,
				statusText: "OK",
				json: async () => ({
					data: {
						search: {
							pageInfo: { hasNextPage: false, endCursor: null },
							nodes: issues.map((it) => ({
								number: it.number,
								title: it.title,
								url: `https://github.com/${it.repo}/issues/${it.number}`,
								updatedAt: new Date(NOW - 1000).toISOString(),
								author: { login: "someone" },
								repository: { nameWithOwner: it.repo },
								labels: { nodes: [] },
							})),
						},
					},
				}),
			};
		}
		return { ok: true, status: 200, statusText: "OK", json: async () => [] };
	};

	const pi = fakeHost();
	pi.flagValues.set("issues", true);
	const review = createReviewExtension(pi, {
		org: "projectbluefin",
		fetchImpl: fetchImpl as unknown as typeof fetch,
		env: { ...ISOLATED_ENV, REVIEW_MODE: "review" },
	});
	const ctx = fakeCtx();
	ctx.ui.parent = ctx;

	await pi.events.get("session_start")({}, ctx);
	await review.whenStarted();
	const dashboard = ctx.overlays[0] as unknown as ReviewDashboard;

	// Select both issues using Space on row 0, Down, Space on row 1
	dashboard.handleInput(" ");
	dashboard.handleInput("j");
	dashboard.handleInput(" ");

	// Press 'f' to fix all selected issues
	pi.messages.length = 0;
	dashboard.handleInput("f");

	// Yield event loop
	for (let i = 0; i < 20; i++) await Promise.resolve();

	assert.equal(pi.messages.length, 1, "selected issues dispatched without requiring Hive");
	assert.match(pi.messages[0], /Implement this repository wave for projectbluefin\/unmanaged/);
	assert.match(pi.messages[0], /Use the `task` tool once with one fresh item/);
	assert.match(pi.messages[0], /gh repo clone <owner\/repo>/);
	assert.match(pi.messages[0], /Read the target repository's `AGENTS\.md`/);
	assert.match(pi.messages[0], /dedicated feature branch/);
	assert.match(pi.messages[0], /target base/);
	assert.match(pi.messages[0], /targeting that same base/);
	assert.match(pi.messages[0], /Do not write directly to the base branch/);
	assert.match(pi.messages[0], /never assume it is `main`/i);
	assert.match(pi.messages[0], /Before running `gh pr create`, verify the current branch/);
	assert.match(pi.messages[0], /the explicit proposed base matches that resolved target/);
	assert.match(pi.messages[0], /do not run `gh pr create`/);
	assert.match(pi.messages[0], /report BLOCKED with the observed head branch, intended and proposed bases, and the policy source/);
	assert.match(pi.messages[0], /Never force-push/);
	assert.match(pi.messages[0], /one review-ready pull request per issue/);
	assert.match(pi.messages[0], /SUBAGENT-RULES/);
	assert.match(pi.messages[0], /Never merge or approve your own pull request/);
	assert.doesNotMatch(pi.messages[0], /hive_workbench_lookup/);
	assert.equal(
		ctx.notifications.some((n) => n.message.includes("Hive is unavailable")),
		false,
		"must not block with 'Hive is unavailable'",
	);
});

async function exitFixture() {
	const fixture = await preToolFailureFixture();
	fixture.ctx.sessionManager.getSessionId = () => fixture.ctx.sessionId;
	return fixture;
}

test("forward-head proof rejects failed, malformed, or mismatched GitHub comparisons", async () => {
	const before = "a".repeat(40); const after = "b".repeat(40);
	for (const scenario of ["ahead", "http-error", "unreadable", "wrong-base", "wrong-merge-base", "diverged", "behind", "no-progress", "malformed"]) {
		const data = { status: "ahead", ahead_by: 1, behind_by: 0, base_commit: { sha: before }, merge_base_commit: { sha: before } };
		if (scenario === "wrong-base") data.base_commit.sha = after;
		if (scenario === "wrong-merge-base") data.merge_base_commit.sha = after;
		if (scenario === "diverged") Object.assign(data, { status: "diverged", behind_by: 1 });
		if (scenario === "behind") Object.assign(data, { status: "behind", ahead_by: 0, behind_by: 1 });
		if (scenario === "no-progress") data.ahead_by = 0;
		const fetchImpl = async (url, options) => {
			assert.equal(String(url), `https://api.github.com/repos/example/rcc/compare/${before}...${after}?per_page=1`);
			assert.equal(options.redirect, "error");
			if (scenario === "unreadable") throw new Error("unavailable");
			return { ok: scenario !== "http-error", json: async () => scenario === "malformed" ? null : data };
		};
		assert.equal(await isForwardHead("example/rcc", before, after, { token: "t", fetchImpl }), scenario === "ahead", scenario);
	}
});

async function pausedPrFixFixture() {
	const env = { ...ISOLATED_ENV, REVIEW_MODE: "review" };
	const items = [224, 225].map((id) => queueItem({
		id, repo: "example/rcc", author: "maintainer", title: `fix target ${id}`,
		url: `https://github.com/example/rcc/pull/${id}`, headSha: String(id === 224 ? "a" : "b").repeat(40),
		ciStatus: "failure", changedFiles: 1, changedFilesComplete: true,
	}));
	const effects = Object.fromEntries(items.map((item) => [item.id, {
		state: "OPEN", merged: false, headSha: item.headSha, autoMerge: false,
		reviewDecision: "REVIEW_REQUIRED", reviews: [],
	}]));
	const comparison = { status: "ahead", ahead_by: 1, behind_by: 0, afterRead: () => {} };
	const compareCalls: string[] = [];
	const base = recoveredPrSlayFetch(items, effects);
	const fetchImpl = async (url, init) => {
		const match = /\/compare\/([a-f0-9]{40})\.\.\.([a-f0-9]{40})/.exec(String(url));
		if (!match) return base(url, init);
		compareCalls.push(String(url));
		return { ok: true, status: 200, json: async () => {
			comparison.afterRead();
			return { status: comparison.status, ahead_by: comparison.ahead_by, behind_by: comparison.behind_by,
				base_commit: { sha: match[1] }, merge_base_commit: { sha: match[1] } };
		} };
	};
	const pi = fakeHost(); const ctx = fakeCtx(); ctx.ui.parent = ctx;
	ctx.sessionManager.getSessionId = () => ctx.sessionId;
	const review = createReviewExtension(pi, { org: "example", fetchImpl, env });
	await pi.events.get("session_start")({}, ctx); await review.whenStarted();
	ctx.overlays.at(-1).handleInput("A"); ctx.overlays.at(-1).handleInput("f");
	await new Promise((resolve) => setImmediate(resolve));
	assert.equal(pi.messages.length, 1);
	const original = pi.entries.filter((entry) => entry.customType === BATCH_ENTRY).at(-1).data;
	await completeReviewTask(pi, ctx, 2);
	const reconcile = registeredFactoryReconciler(); assert.ok(reconcile);
	ctx.selectResponses.push("Pause and exit");
	await pi.events.get("session_before_shutdown")({ sessionId: ctx.sessionId, reason: "shutdown" }, ctx);
	pi.events.get("session_shutdown")({}, ctx);
	pi.events.get("session_shutdown_settled")({ sessionId: ctx.sessionId, settled: true, pendingJobIds: [] }, ctx);
	const restart = async (choice = "Leave paused") => {
		const restarted = fakeHost(); const next = fakeCtx(); next.ui.parent = next;
		next.sessionId = "restarted-fix-session";
		next.sessionManager.getSessionId = () => next.sessionId;
		next.sessionManager.getBranch = () => pi.entries.map((entry) => ({ type: "custom", ...entry }));
		next.selectResponses.push(choice);
		const restored = createReviewExtension(restarted, { org: "example", fetchImpl, env });
		await restarted.events.get("session_start")({}, next); await restored.whenStarted();
		return { restarted, next };
	};
	return { pi, ctx, env, items, effects, comparison, compareCalls, original, restart, reconcile };
}

test("Review paused Fix resumes at verified forward heads from the saved-session popup", async () => {
	const { env, effects, original, restart, compareCalls } = await pausedPrFixFixture();
	effects[224].headSha = "c".repeat(40); effects[225].headSha = "d".repeat(40);
	const { restarted, next } = await restart("Resume saved work");
	assert.equal(restarted.messages.length, 1, next.notifications.map((n) => n.message).join("\n"));
	const resumed = restarted.entries.filter((entry) => entry.customType === BATCH_ENTRY).at(-1).data;
	assert.notEqual(resumed.id, original.id);
	assert.equal(resumed.completedItems, 0);
	assert.deepEqual(resumed.waves[0].items.map((item) => item.headSha).sort(), ["c".repeat(40), "d".repeat(40)]);
	assert.deepEqual(original.waves[0].items.map((item) => item.headSha).sort(), ["a".repeat(40), "b".repeat(40)]);
	assert.ok(compareCalls.length >= 2);
	assert.ok(new ResourceClaims(env.LUNA_FACTORY_STATE_ROOT, env.LUNA_FACTORY_CLAIMS_ROOT).list().every((claim) => claim.owner === `review:${resumed.id}:0`));
});

for (const scenario of ["diverged", "behind", "unknown-comparison", "review-changed", "auto-merge-changed", "shutdown-unsettled", "head-race", "closed-pr"]) test(`Review paused Fix retains changed-head claims for ${scenario}`, async () => {
	const { pi, ctx, env, effects, comparison, restart } = await pausedPrFixFixture();
	effects[224].headSha = "c".repeat(40);
	if (scenario === "diverged") Object.assign(comparison, { status: "diverged", behind_by: 1 });
	if (scenario === "behind") Object.assign(comparison, { status: "behind", ahead_by: 0, behind_by: 1 });
	if (scenario === "unknown-comparison") Object.assign(comparison, { status: "ahead", ahead_by: undefined });
	if (scenario === "review-changed") effects[224].reviewDecision = "APPROVED";
	if (scenario === "auto-merge-changed") effects[224].autoMerge = true;
	if (scenario === "closed-pr") effects[224].state = "CLOSED";
	if (scenario === "head-race") comparison.afterRead = () => { effects[224].headSha = (effects[224].headSha === "c".repeat(40) ? "e" : "c").repeat(40); };
	if (scenario === "shutdown-unsettled") {
		const saved = pi.entries.filter((entry) => entry.customType === BATCH_ENTRY).at(-1).data;
		const unsettled = { ...saved, waveShutdown: { ...saved.waveShutdown, settled: false, pendingJobIds: ["worker"] } };
		saveWave(env.LUNA_FACTORY_CLAIMS_ROOT, unsettled); pi.entries.push({ customType: BATCH_ENTRY, data: unsettled });
	}
	const { restarted, next } = await restart("Resume saved work");
	assert.equal(restarted.messages.length, 0);
	assert.equal(new ResourceClaims(env.LUNA_FACTORY_STATE_ROOT, env.LUNA_FACTORY_CLAIMS_ROOT).list().length, 3);
});

test("Review paused Fix releases verified stopped claims while preserving work for later resume", async () => {
	const { env, effects, original, restart } = await pausedPrFixFixture();
	effects[224].headSha = "c".repeat(40);
	const { restarted, next } = await restart();
	assert.equal(restarted.messages.length, 0);
	const paused = restarted.entries.filter((entry) => entry.customType === BATCH_ENTRY).at(-1).data;
	assert.equal(paused.id, original.id); assert.equal(paused.state, "paused"); assert.equal(paused.completedItems, 0);
	assert.equal(new ResourceClaims(env.LUNA_FACTORY_STATE_ROOT, env.LUNA_FACTORY_CLAIMS_ROOT).list().length, 0);
	await restarted.commands.get("review").handler("resume", next);
	assert.equal(restarted.messages.length, 1);
	const resumed = restarted.entries.filter((entry) => entry.customType === BATCH_ENTRY).at(-1).data;
	assert.notEqual(resumed.id, original.id);
	assert.equal(resumed.waves[0].items.find((item) => item.id === 224).headSha, "c".repeat(40));
});

for (const changed of ["none", "head", "review", "auto-merge"]) test(`Review Factory reconciliation rechecks stopped Fix progress after comparison (${changed})`, async () => {
	const { env, effects, original, comparison, reconcile } = await pausedPrFixFixture();
	effects[224].headSha = "c".repeat(40);
	comparison.afterRead = () => {
		if (changed === "head") effects[224].headSha = "e".repeat(40);
		if (changed === "review") effects[224].reviewDecision = "APPROVED";
		if (changed === "auto-merge") effects[224].autoMerge = true;
	};
	const result = await reconcile(`review:${original.id}:0`, "item:example/rcc#224");
	assert.equal(result, changed === "none" ? "settled" : "unknown");
	const claim = new ResourceClaims(env.LUNA_FACTORY_STATE_ROOT, env.LUNA_FACTORY_CLAIMS_ROOT).list().find((claim) => claim.resource === "item:example/rcc#224");
	assert.equal(claim?.status, changed === "none" ? "settled" : "unknown");
});

test("Review Fix ownership rejection preserves the saved run without creating another wave", async () => {
	const { pi, ctx, env, effects, original } = await pausedPrFixFixture();
	const other = fakeHost(); const next = fakeCtx(); next.ui.parent = next;
	const review = createReviewExtension(other, { org: "example", fetchImpl: recoveredPrSlayFetch(original.waves[0].items, effects), env });
	await other.events.get("session_start")({}, next); await review.whenStarted();
	next.overlays.at(-1).handleInput("A"); next.overlays.at(-1).handleInput("f");
	await new Promise((resolve) => setImmediate(resolve));
	assert.equal(other.messages.length, 0);
	assert.equal(other.entries.filter((entry) => entry.customType === BATCH_ENTRY).length, 0);
	assert.match(await runReviewCommand(other, next, "details"), new RegExp(`review:${original.id}:0`));
});

for (const choice of ["Stay", undefined]) test(`Review exit ${choice ?? "dismiss"} preserves wave and claims`, async () => {
	const { pi, ctx, env } = await exitFixture();
	const before = pi.entries.length;
	ctx.selectResponses.push(choice);
	assert.deepEqual(await pi.events.get("session_before_shutdown")({ sessionId: ctx.sessionId, reason: "shutdown" }, ctx), { cancel: true });
	assert.equal(pi.entries.length, before);
	assert.equal(new ResourceClaims(env.LUNA_FACTORY_STATE_ROOT, env.LUNA_FACTORY_CLAIMS_ROOT).list().length, 2);
});

for (const jobs of [0, 1, 100]) for (const choice of ["Pause and exit", "Cancel run and exit"]) test(`Review ${choice} reconciles authoritative stop of ${jobs} workers without completing work`, async () => {
	const { pi, ctx, env } = await exitFixture();
	ctx.asyncJobs.running = Array.from({ length: jobs }, (_, i) => ({ id: `worker-${i}`, status: "running", startTime: Date.now() }));
	ctx.selectResponses.push(choice);
	await pi.events.get("session_before_shutdown")({ sessionId: ctx.sessionId, reason: "shutdown" }, ctx);
	pi.events.get("session_shutdown")({}, ctx);
	ctx.asyncJobs.running = [];
	pi.events.get("session_shutdown_settled")({ sessionId: ctx.sessionId, settled: true, pendingJobIds: [] }, ctx);
	const receipt = pi.entries.filter((e) => e.customType === BATCH_ENTRY).at(-1).data;
	assert.equal(receipt.waveShutdown.settled, true);
	await runReviewCommand(pi, ctx, "reconcile");
	const saved = pi.entries.filter((e) => e.customType === BATCH_ENTRY).at(-1).data;
	assert.equal(saved.state, choice === "Pause and exit" ? "paused" : "cancelled");
	assert.equal(saved.completedItems, 0);
	assert.equal(new ResourceClaims(env.LUNA_FACTORY_STATE_ROOT, env.LUNA_FACTORY_CLAIMS_ROOT).list().length, 0);
});

test("Review signal exit defaults pause; foreign, premature and duplicate settlement cannot change ownership", async () => {
	const { pi, ctx } = await exitFixture();
	pi.events.get("session_shutdown_settled")({ sessionId: ctx.sessionId, settled: true, pendingJobIds: [] }, ctx);
	assert.equal(pi.entries.filter((e) => e.customType === BATCH_ENTRY).at(-1).data.waveShutdown, undefined);
	pi.events.get("session_shutdown")({}, ctx);
	assert.equal(ctx.selectCalls.length, 0);
	pi.events.get("session_shutdown_settled")({ sessionId: "foreign", settled: true, pendingJobIds: [] }, ctx);
	assert.equal(pi.entries.filter((e) => e.customType === BATCH_ENTRY).at(-1).data.waveShutdown, undefined);
	pi.events.get("session_shutdown_settled")({ sessionId: ctx.sessionId, settled: false, pendingJobIds: ["worker"], reason: "timeout" }, ctx);
	const count = pi.entries.length;
	pi.events.get("session_shutdown_settled")({ sessionId: ctx.sessionId, settled: true, pendingJobIds: [] }, ctx);
	assert.equal(pi.entries.length, count);
	const result = await runReviewCommand(pi, ctx, "reconcile");
	assert.match(result, /missing positive owning-session/);
});

test("Review stopped worker receipt retains changed GitHub effect claims", async () => {
	const { pi, ctx, env, states } = await exitFixture();
	pi.events.get("session_shutdown")({}, ctx);
	pi.events.get("session_shutdown_settled")({ sessionId: ctx.sessionId, settled: true, pendingJobIds: [] }, ctx);
	states["projectbluefin/review#77"].submittedPrs.push("https://github.com/projectbluefin/review/pull/99", "https://github.com/projectbluefin/review/pull/100");
	const result = await runReviewCommand(pi, ctx, "reconcile");
	assert.match(result, /execution stopped; GitHub effect proof/);
	assert.equal(new ResourceClaims(env.LUNA_FACTORY_STATE_ROOT, env.LUNA_FACTORY_CLAIMS_ROOT).list().length, 2);
	await runReviewCommand(pi, ctx, "resume");
	assert.equal(pi.messages.length, 1);
});

test("Review paused Slay resumes after an observed current-head approval without completing landing", async () => {
	const { pi, ctx, env, items, effects, batch } = await blockedPrSlayWave();
	const item = items[0];
	effects[item.id].reviewDecision = "APPROVED";
	effects[item.id].reviews = [{ state: "APPROVED", submittedAt: new Date(Date.now() + 100).toISOString(), author: { login: "maintainer" }, commit: { oid: item.headSha } }];
	pi.events.get("session_shutdown")({}, ctx);
	pi.events.get("session_shutdown_settled")({ sessionId: ctx.sessionId, settled: true, pendingJobIds: [] }, ctx);
	await runReviewCommand(pi, ctx, "reconcile");
	const paused = pi.entries.filter((entry) => entry.customType === BATCH_ENTRY).at(-1).data;
	assert.equal(paused.state, "paused");
	assert.equal(paused.completedItems, 0, "settled approval effects do not complete the landing objective");
	assert.equal(new ResourceClaims(env.LUNA_FACTORY_STATE_ROOT, env.LUNA_FACTORY_CLAIMS_ROOT).list().length, 0);
	const restarted = fakeHost();
	const next = fakeCtx(); next.ui.parent = next; next.sessionId = "resumed-session";
	next.sessionManager.getBranch = () => pi.entries.map((entry) => ({ type: "custom", ...entry }));
	const review = createReviewExtension(restarted, { org: "projectbluefin", fetchImpl: recoveredPrSlayFetch(items, effects), env });
	await restarted.events.get("session_start")({}, next); await review.whenStarted();
	await restarted.commands.get("review").handler("resume", next);
	const resumed = restarted.entries.filter((entry) => entry.customType === BATCH_ENTRY).at(-1).data;
	assert.notEqual(resumed.id, batch.id);
	assert.equal(restarted.messages.length, 1, "saved work receives a fresh admission");
	assert.equal(resumed.completedItems, 0);
});

test("Review live queue refresh cannot replace the admitted Slay head or release its claims", async () => {
	const { pi, ctx, env, items, batch } = await blockedPrSlayWave(({ items, effects }) => {
		const item = items[0];
		effects[item.id].headSha = "f".repeat(40);
		effects[item.id].reviewDecision = "APPROVED";
		effects[item.id].reviews = [{ state: "APPROVED", submittedAt: new Date(Date.now() + 100).toISOString(), author: { login: "maintainer" }, commit: { oid: "f".repeat(40) } }];
	});
	assert.equal(batch.waves[0].items.find((item) => item.id === items[0].id).headSha, items[0].headSha, "queue reconciliation preserves the captured subject");
	pi.events.get("session_shutdown")({}, ctx);
	pi.events.get("session_shutdown_settled")({ sessionId: ctx.sessionId, settled: true, pendingJobIds: [] }, ctx);
	await runReviewCommand(pi, ctx, "reconcile");
	const claims = new ResourceClaims(env.LUNA_FACTORY_STATE_ROOT, env.LUNA_FACTORY_CLAIMS_ROOT).list();
	assert.ok(claims.some((claim) => claim.resource === `item:${items[0].repo}#${items[0].id}`));
	assert.ok(claims.some((claim) => claim.resource === `repo:${items[0].repo}`));
});

for (const scenario of ["incomplete-reviews", "changed-head", "stale-review", "shutdown-unsettled"]) test(`Review paused Slay retains claims for approval recovery with ${scenario}`, async () => {
	const { pi, ctx, env, items, effects } = await blockedPrSlayWave();
	const item = items[0];
	effects[item.id].reviewDecision = "APPROVED";
	effects[item.id].reviewsIncomplete = scenario === "incomplete-reviews";
	if (scenario === "changed-head") effects[item.id].headSha = "f".repeat(40);
	effects[item.id].reviews = [{ state: "APPROVED", submittedAt: new Date(Date.now() + 100).toISOString(), author: { login: "maintainer" }, commit: { oid: scenario === "stale-review" ? "e".repeat(40) : effects[item.id].headSha } }];
	pi.events.get("session_shutdown")({}, ctx);
	pi.events.get("session_shutdown_settled")({ sessionId: ctx.sessionId, settled: scenario !== "shutdown-unsettled", pendingJobIds: scenario === "shutdown-unsettled" ? ["pending-mutation"] : [] }, ctx);
	await runReviewCommand(pi, ctx, "reconcile");
	const claims = new ResourceClaims(env.LUNA_FACTORY_STATE_ROOT, env.LUNA_FACTORY_CLAIMS_ROOT).list();
	assert.ok(claims.some((claim) => claim.resource === `item:${items[0].repo}#${items[0].id}`));
	assert.ok(claims.some((claim) => claim.resource === `repo:${items[0].repo}`));
	await runReviewCommand(pi, ctx, "resume");
	assert.equal(pi.messages.length, 1, "unresolved effects cannot dispatch replacement workers");
});

test("Review resumed stopped work uses a fresh claim owner and prompt after current evidence", async () => {
	const { pi, ctx, env, review } = await exitFixture();
	pi.events.get("session_shutdown")({}, ctx);
	pi.events.get("session_shutdown_settled")({ sessionId: ctx.sessionId, settled: true, pendingJobIds: [] }, ctx);
	const old = pi.entries.filter((e) => e.customType === BATCH_ENTRY).at(-1).data;
	ctx.sessionId = "new-session";
	ctx.sessionManager.getBranch = () => pi.entries.map((entry) => ({ type: "custom", ...entry }));
	await pi.events.get("session_start")({}, ctx); await review.whenStarted();
	await runReviewCommand(pi, ctx, "resume");
	const current = pi.entries.filter((e) => e.customType === BATCH_ENTRY).at(-1).data;
	assert.notEqual(current.id, old.id);
	assert.equal(current.waveSessionId, "new-session");
	assert.equal(current.waveShutdown, undefined);
	assert.notEqual(current.wavePromptDigest, old.wavePromptDigest);
	assert.equal(pi.messages.length, 2, JSON.stringify(pi.entries.filter((entry) => entry.customType === BATCH_ENTRY).at(-1)?.data));
	assert.ok(new ResourceClaims(env.LUNA_FACTORY_STATE_ROOT, env.LUNA_FACTORY_CLAIMS_ROOT).list().every((claim) => claim.owner.includes(current.id)));
	const restarted = fakeHost(); restarted.flagValues.set("issues", true);
	const next = fakeCtx(); next.ui.parent = next; next.sessionId = ctx.sessionId;
	next.sessionManager.getBranch = () => pi.entries.map((entry) => ({ type: "custom", ...entry }));
	const restored = createReviewExtension(restarted, { org: "projectbluefin", fetchImpl: issueBackedFetch({ "projectbluefin/review#77": { title: "issue", submittedPrs: [] } }), env });
	await restarted.events.get("session_start")({}, next); await restored.whenStarted();
	assert.equal(restarted.entries.filter((e) => e.customType === BATCH_ENTRY).at(-1).data.id, current.id);
	restarted.events.get("session_shutdown")({}, next);
	restarted.events.get("session_shutdown_settled")({ sessionId: next.sessionId, settled: true, pendingJobIds: [] }, next);
	assert.equal(restarted.entries.filter((e) => e.customType === BATCH_ENTRY).at(-1).data.waveShutdown, undefined, "reused session ID cannot certify workers owned by the previous runtime");
});

test("Review missing native lifecycle capability blocks mutation before claims", async () => {
	const pi = fakeHost();
	pi.sessionShutdownLifecycleVersion = undefined;
	pi.flagValues.set("issues", true);
	const ctx = fakeCtx(); ctx.ui.parent = ctx;
	const env = { ...ISOLATED_ENV, REVIEW_MODE: "review" };
	const review = createReviewExtension(pi, { org: "projectbluefin", fetchImpl: issueBackedFetch({ "projectbluefin/review#77": { title: "issue", submittedPrs: [] } }), env });
	await pi.events.get("session_start")({}, ctx); await review.whenStarted();
	ctx.overlays[0].handleInput("A"); ctx.overlays[0].handleInput("f");
	for (let i = 0; i < 20; i++) await Promise.resolve();
	assert.equal(pi.messages.length, 0);
	assert.equal(new ResourceClaims(env.LUNA_FACTORY_STATE_ROOT, env.LUNA_FACTORY_CLAIMS_ROOT).list().length, 0);
	assert.match(savedReviewNoticeText(pi), /Review couldn’t complete this step/);
	assert.match(await runReviewCommand(pi, ctx, "details"), /upgrade to\s+the packaged Review OMP/);
});

test("headless Review retains bounded diagnostics when a persistent notice card cannot render", async () => {
	const pi = fakeHost();
	pi.sessionShutdownLifecycleVersion = undefined;
	const ctx = fakeCtx();
	ctx.hasUI = false;
	const review = createReviewExtension(pi, { org: "projectbluefin", fetchImpl: fakeFetch([]), env: { ...ISOLATED_ENV, REVIEW_MODE: "review" } });
	await pi.events.get("session_start")({}, ctx);
	await review.whenStarted();
	await pi.commands.get("review").handler("slay", ctx);
	const output = ctx.notifications.map((notice) => notice.message).join("\n");
	assert.match(output, /Review mutations require OMP session shutdown lifecycle/);
	assert.ok(output.length < 1_500, "headless diagnostics remain bounded");
	assert.equal(pi.messages.length, 0);
	assert.equal(ctx.widgets.has("review-native-notice"), false, "headless execution does not register a visual card");
});

test("Review restart offers saved paused work and preserves stop proof across unrelated chat", async () => {
	const { pi, ctx, env, states } = await exitFixture();
	pi.events.get("session_shutdown")({}, ctx);
	pi.events.get("session_shutdown_settled")({ sessionId: ctx.sessionId, settled: true, pendingJobIds: [] }, ctx);
	const restarted = fakeHost(); restarted.flagValues.set("issues", true);
	const next = fakeCtx(); next.ui.parent = next; next.sessionId = ctx.sessionId;
	next.sessionManager.getBranch = () => pi.entries.map((entry) => ({ type: "custom", ...entry }));
	next.selectResponses.push("Leave paused");
	const review = createReviewExtension(restarted, { org: "projectbluefin", fetchImpl: issueBackedFetch(states), env });
	await restarted.events.get("session_start")({}, next); await review.whenStarted();
	assert.ok(next.selectCalls.some(([title]) => title.includes("Saved Review work")));
	assert.equal(new ResourceClaims(env.LUNA_FACTORY_STATE_ROOT, env.LUNA_FACTORY_CLAIMS_ROOT).list().length, 0, "Leave paused needs no manual reconciliation to release verified stopped ownership");
	assert.equal(restarted.entries.filter((entry) => entry.customType === BATCH_ENTRY).at(-1).data.completedItems, 0);
	assert.equal(restarted.entries.filter((entry) => entry.customType === BATCH_ENTRY).at(-1).data.state, "paused");
	restarted.events.get("tool_call")({ toolCallId: "unrelated-later-tool", toolName: "bash", input: { command: "pwd" } }, next);
	await restarted.events.get("agent_end")({ messages: [{ role: "assistant", stopReason: "error" }] }, next);
	await runReviewCommand(restarted, next, "reconcile");
	assert.equal(new ResourceClaims(env.LUNA_FACTORY_STATE_ROOT, env.LUNA_FACTORY_CLAIMS_ROOT).list().length, 0);
	assert.equal(restarted.entries.filter((entry) => entry.customType === BATCH_ENTRY).at(-1).data.state, "paused");
	assert.equal(restarted.messages.length, 0);
});

test("Review stopped issue with one linked PR releases claims and resume never duplicates publication", async () => {
	const { pi, ctx, env, states, review } = await exitFixture();
	pi.events.get("session_shutdown")({}, ctx);
	pi.events.get("session_shutdown_settled")({ sessionId: ctx.sessionId, settled: true, pendingJobIds: [] }, ctx);
	states["projectbluefin/review#77"].submittedPrs = ["projectbluefin/review#99"];
	await runReviewCommand(pi, ctx, "reconcile");
	assert.equal(new ResourceClaims(env.LUNA_FACTORY_STATE_ROOT, env.LUNA_FACTORY_CLAIMS_ROOT).list().length, 0);
	assert.equal(pi.entries.filter((entry) => entry.customType === BATCH_ENTRY).at(-1).data.completedItems, 0);
	ctx.sessionId = "session-2";
	ctx.sessionManager.getBranch = () => pi.entries.map((entry) => ({ type: "custom", ...entry }));
	await pi.events.get("session_start")({}, ctx); await review.whenStarted();
	const resumed = await runReviewCommand(pi, ctx, "resume");
	assert.equal(pi.messages.length, 1);
	assert.match(resumed, /already has submitted PRs/);
});

test("Review late same-owner tool contradicts settlement and duplicate receipt cannot revive it", async () => {
	const { pi, ctx, env } = await exitFixture();
	pi.events.get("session_shutdown")({}, ctx);
	const event = { sessionId: ctx.sessionId, settled: true, pendingJobIds: [] };
	pi.events.get("session_shutdown_settled")(event, ctx);
	pi.events.get("tool_call")({ toolCallId: "late", toolName: "bash", input: { command: "pwd" } }, ctx);
	pi.events.get("session_shutdown_settled")(event, ctx);
	await runReviewCommand(pi, ctx, "reconcile");
	assert.equal(new ResourceClaims(env.LUNA_FACTORY_STATE_ROOT, env.LUNA_FACTORY_CLAIMS_ROOT).list().length, 2);
	assert.equal(pi.entries.filter((entry) => entry.customType === BATCH_ENTRY).at(-1).data.waveShutdown.settled, false);
});

test("Review pre-exit choice is not committed when another extension vetoes", async () => {
	const { pi, ctx } = await exitFixture();
	const before = pi.entries.length;
	ctx.selectResponses.push("Cancel run and exit");
	await pi.events.get("session_before_shutdown")({ sessionId: ctx.sessionId, reason: "restart" }, ctx);
	assert.equal(pi.entries.length, before);
	pi.events.get("session_shutdown_cancelled")({ sessionId: ctx.sessionId }, ctx);
	assert.equal(pi.entries.length, before);
	pi.events.get("session_shutdown")({}, ctx);
	assert.equal(pi.entries.filter((e) => e.customType === BATCH_ENTRY).at(-1).data.waveExit.choice, "pause", "a later signal must not reuse a vetoed cancellation");
});

test("Review accepted cancel exit survives late evidence updates before shutdown", async () => {
	const { pi, ctx } = await exitFixture();
	ctx.selectResponses.push("Cancel run and exit");
	await pi.events.get("session_before_shutdown")({ sessionId: ctx.sessionId, reason: "shutdown" }, ctx);
	pi.events.get("tool_call")({ toolCallId: "still-finishing", toolName: "bash", input: {} }, ctx);
	pi.events.get("session_shutdown")({}, ctx);
	assert.equal(pi.entries.filter((e) => e.customType === BATCH_ENTRY).at(-1).data.waveExit.choice, "cancel");
});

for (const choice of ["Pause and exit", "Cancel run and exit"]) test(`Review ${choice} survives worker evidence while the exit menu is open`, async () => {
	const { pi, ctx } = await exitFixture();
	const answer = Promise.withResolvers<string>();
	ctx.ui.select = async () => answer.promise;
	const exit = pi.events.get("session_before_shutdown")({ sessionId: ctx.sessionId, reason: "shutdown" }, ctx);
	pi.events.get("tool_call")({ toolCallId: "worker-progress-during-exit", toolName: "bash", input: {} }, ctx);
	answer.resolve(choice);
	assert.equal(await exit, undefined, "same-wave worker progress must not veto the chosen exit");
	pi.events.get("session_shutdown")({}, ctx);
	const saved = pi.entries.filter((e) => e.customType === BATCH_ENTRY).at(-1).data;
	assert.equal(saved.waveExit.choice, choice === "Pause and exit" ? "pause" : "cancel");
	assert.ok(saved.waveToolInvocationIds.includes("worker-progress-during-exit"), "exit preserves the latest worker evidence");
});

test("Review exit menu cannot authorize a different session", async () => {
	const { pi, ctx } = await exitFixture();
	const answer = Promise.withResolvers<string>();
	ctx.ui.select = async () => answer.promise;
	const exit = pi.events.get("session_before_shutdown")({ sessionId: ctx.sessionId, reason: "shutdown" }, ctx);
	ctx.sessionId = "different-session";
	answer.resolve("Cancel run and exit");
	assert.deepEqual(await exit, { cancel: true });
});

test("Review between-wave exit keeps undispatched work resumable without fabricated stop proof", async () => {
	const item = queueItem({ id: 42, repo: "projectbluefin/review", headSha: "a".repeat(40) });
	const saved = { version: 1, id: "undispatched", kind: "fix", waves: [{ repo: item.repo, items: [item] }], currentWave: 0, completedItems: 0, totalItems: 1, startedAt: Date.now(), waveStartedAt: Date.now(), state: "paused" };
	const env = { ...ISOLATED_ENV, REVIEW_MODE: "review" };
	const pi = fakeHost(); const ctx = fakeCtx(); ctx.ui.parent = ctx;
	ctx.sessionManager.getBranch = () => [{ type: "custom", customType: BATCH_ENTRY, data: saved }];
	const review = createReviewExtension(pi, { org: "projectbluefin", fetchImpl: hiveBackedFetch([item]), env });
	await pi.events.get("session_start")({}, ctx); await review.whenStarted();
	ctx.selectResponses.push("Pause and exit");
	await pi.events.get("session_before_shutdown")({ sessionId: ctx.sessionId, reason: "shutdown" }, ctx);
	pi.events.get("session_shutdown")({}, ctx);
	const paused = pi.entries.filter((e) => e.customType === BATCH_ENTRY).at(-1).data;
	assert.equal(paused.state, "paused"); assert.equal(paused.waveShutdown, undefined);
	const next = fakeCtx(); next.ui.parent = next;
	next.sessionManager.getBranch = () => [{ type: "custom", customType: BATCH_ENTRY, data: paused }];
	next.selectResponses.push("Resume saved work");
	const restarted = fakeHost();
	const restored = createReviewExtension(restarted, { org: "projectbluefin", fetchImpl: hiveBackedFetch([item]), env });
	await restarted.events.get("session_start")({}, next); await restored.whenStarted();
	assert.equal(restarted.messages.length, 1);
	assert.equal(restarted.entries.filter((e) => e.customType === BATCH_ENTRY).at(-1).data.waveSessionId, next.sessionId);
});

test("Review missing native session identity blocks mutation despite lifecycle capability", async () => {
	const pi = fakeHost(); pi.flagValues.set("issues", true);
	const ctx = fakeCtx(); ctx.ui.parent = ctx; ctx.sessionManager.getSessionId = () => "";
	const env = { ...ISOLATED_ENV, REVIEW_MODE: "review" };
	const review = createReviewExtension(pi, { org: "projectbluefin", fetchImpl: issueBackedFetch({ "projectbluefin/review#77": { title: "issue", submittedPrs: [] } }), env });
	await pi.events.get("session_start")({}, ctx); await review.whenStarted();
	ctx.overlays[0].handleInput("A"); ctx.overlays[0].handleInput("f");
	for (let i = 0; i < 20; i++) await Promise.resolve();
	assert.equal(pi.messages.length, 0);
	assert.equal(new ResourceClaims(env.LUNA_FACTORY_STATE_ROOT, env.LUNA_FACTORY_CLAIMS_ROOT).list().length, 0);
});

test("Review undispatched issue fix resume excludes a PR published while paused", async () => {
	const item = queueItem({ type: "issue", id: 77, repo: "projectbluefin/independent", submittedPrs: [] });
	const saved = { version: 1, id: "undispatched-issue", kind: "fix", waves: [{ repo: item.repo, items: [item] }], currentWave: 0, completedItems: 0, totalItems: 1, startedAt: Date.now(), waveStartedAt: Date.now(), state: "paused" };
	const env = { ...ISOLATED_ENV, REVIEW_MODE: "review" };
	const pi = fakeHost(); pi.flagValues.set("issues", true);
	const ctx = fakeCtx(); ctx.ui.parent = ctx;
	ctx.sessionManager.getBranch = () => [{ type: "custom", customType: BATCH_ENTRY, data: saved }];
	ctx.selectResponses.push("Resume saved work");
	const review = createReviewExtension(pi, { org: "projectbluefin", fetchImpl: issueBackedFetch({ "projectbluefin/independent#77": { title: "issue", submittedPrs: ["projectbluefin/independent#99"] } }), env });
	await pi.events.get("session_start")({}, ctx); await review.whenStarted();
	assert.equal(pi.messages.length, 0);
	assert.ok(ctx.notifications.some((notice) => /already has submitted PRs/.test(notice.message)));
});

test("Review failed resume capability check retains saved paused selection", async () => {
	const { pi, ctx, review } = await exitFixture();
	pi.events.get("session_shutdown")({}, ctx);
	pi.events.get("session_shutdown_settled")({ sessionId: ctx.sessionId, settled: true, pendingJobIds: [] }, ctx);
	await runReviewCommand(pi, ctx, "reconcile");
	const saved = pi.entries.filter((e) => e.customType === BATCH_ENTRY).at(-1).data;
	ctx.sessionManager.getBranch = () => pi.entries.map((entry) => ({ type: "custom", ...entry }));
	await pi.events.get("session_start")({}, ctx); await review.whenStarted();
	pi.sessionShutdownLifecycleVersion = undefined;
	await runReviewCommand(pi, ctx, "resume");
	assert.equal(pi.messages.length, 1);
	assert.equal(pi.entries.filter((e) => e.customType === BATCH_ENTRY).at(-1).data.id, saved.id);
	assert.equal(pi.entries.filter((e) => e.customType === BATCH_ENTRY).at(-1).data.state, "paused");
});

for (const ambiguous of [false, true]) test(`Review startup reconciles cancelled stopped work without resume picker (ambiguous=${ambiguous})`, async () => {
	const { pi, ctx, env, states } = await exitFixture();
	ctx.selectResponses.push("Cancel run and exit");
	await pi.events.get("session_before_shutdown")({ sessionId: ctx.sessionId, reason: "shutdown" }, ctx);
	pi.events.get("session_shutdown")({}, ctx);
	pi.events.get("session_shutdown_settled")({ sessionId: ctx.sessionId, settled: true, pendingJobIds: [] }, ctx);
	if (ambiguous) states["projectbluefin/review#77"].submittedPrs = ["projectbluefin/review#99", "projectbluefin/review#100"];
	const restarted = fakeHost(); restarted.flagValues.set("issues", true);
	const next = fakeCtx(); next.ui.parent = next; next.sessionId = "reopened";
	next.sessionManager.getBranch = () => pi.entries.map((entry) => ({ type: "custom", ...entry }));
	const review = createReviewExtension(restarted, { org: "projectbluefin", fetchImpl: issueBackedFetch(states), env });
	await restarted.events.get("session_start")({}, next); await review.whenStarted();
	assert.ok(!next.selectCalls.some(([title]) => title.includes("Saved Review work")));
	assert.equal(restarted.messages.length, 0);
	const saved = restarted.entries.filter((entry) => entry.customType === BATCH_ENTRY).at(-1).data;
	assert.equal(saved.completedItems, 0);
	assert.equal(saved.state, ambiguous ? "blocked" : "cancelled");
	assert.equal(new ResourceClaims(env.LUNA_FACTORY_STATE_ROOT, env.LUNA_FACTORY_CLAIMS_ROOT).list().length, ambiguous ? 2 : 0);
	if (ambiguous) assert.match(saved.error, /GitHub effect proof remains unresolved for .*projectbluefin\/review/);
});
