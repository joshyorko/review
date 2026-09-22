/** Personal self-hosted policy: workflow PRs are actionable when permissions allow. */
import assert from "node:assert/strict";
import test, { beforeEach, afterEach } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { actionPrompt, createReviewExtension } from "../image/extension/bluefin-review/extension.ts";
import { ReviewDashboard } from "../image/extension/bluefin-review/dashboard.ts";
import { PLAIN_PAINTER } from "../image/extension/bluefin-review/glyphs.ts";
import { fetchQueue } from "../image/extension/bluefin-review/github.ts";
import { EMPTY_HIVE } from "../image/extension/bluefin-review/hive.ts";
import { ReviewMode } from "../image/extension/bluefin-review/mode.ts";
import { renderRail } from "../image/extension/bluefin-review/rail.ts";
import { registerTools } from "../image/extension/bluefin-review/tools.ts";

const NOW = 1_800_000_000_000;
const ENV = {
	GH_TOKEN: "t",
	HOME: "/nonexistent",
	XDG_CONFIG_HOME: "/nonexistent",
	BLUEFIN_REVIEW_ALLOW_WORKFLOW_SLAY: "1",
	BLUEFIN_REVIEW_PERSONAL_MODE: "1",
	LUNA_FACTORY_STATE_ROOT: "",
	LUNA_FACTORY_CLAIMS_ROOT: "",
	BLUEFIN_REVIEW_MODE: "review",
};
beforeEach(() => {
	ENV.LUNA_FACTORY_STATE_ROOT = mkdtempSync(join(tmpdir(), "personal-state-"));
	ENV.LUNA_FACTORY_CLAIMS_ROOT = mkdtempSync(join(tmpdir(), "personal-claims-"));
});
afterEach(() => {
	rmSync(ENV.LUNA_FACTORY_STATE_ROOT, { recursive: true, force: true });
	rmSync(ENV.LUNA_FACTORY_CLAIMS_ROOT, { recursive: true, force: true });
});

function workflowNode(workflow = true, includeChangedFiles = true, requestedChanges = false) {
	return {
		number: 42,
		title: "workflow change",
		url: "https://github.com/example/repo/pull/42",
		updatedAt: new Date(NOW).toISOString(),
		isDraft: false,
		mergeable: "MERGEABLE",
		reviewDecision: requestedChanges ? "CHANGES_REQUESTED" : "REVIEW_REQUIRED",
		changedFiles: 1,
		headRefOid: "4".repeat(40),
		author: { login: "josh" },
		repository: { nameWithOwner: "example/repo" },
		labels: { nodes: [] },
		files: includeChangedFiles ? {
			pageInfo: { hasNextPage: false },
			nodes: [{ path: workflow ? ".github/workflows/deploy.yml" : "README.md" }],
		} : undefined,
		commits: {
			nodes: [{
				commit: {
					statusCheckRollup: { state: "SUCCESS" },
					checkSuites: { pageInfo: { hasNextPage: false }, nodes: [{ status: "COMPLETED", conclusion: "SUCCESS" }] },
				},
			}],
		},
		closingIssuesReferences: { nodes: [] },
	};
}

function makeFetch(
	scopes: string | null = "repo, workflow",
	liveHeadSha = "4".repeat(40),
	workflow = true,
	scopeResponseOk = true,
	includeChangedFiles = true,
	repositoryPushPermission?: boolean,
	requestedChanges = false,
	searchIncludeChangedFiles = includeChangedFiles,
) {
	return (url: string | URL | Request, init?: RequestInit) => {
		const target = String(url);
		if (target === "https://api.github.com/") {
			return Promise.resolve({
				ok: scopeResponseOk,
				status: scopeResponseOk ? 200 : 500,
				statusText: scopeResponseOk ? "OK" : "Internal Server Error",
				headers: { get: (name: string) => name.toLowerCase() === "x-oauth-scopes" ? scopes : null },
				json: async () => ({}),
			});
		}
		if (target.includes("/graphql")) {
			const body = JSON.parse(String(init?.body ?? "{}"));
			if (body.variables?.search !== undefined) {
				return Promise.resolve({
					ok: true,
					status: 200,
					statusText: "OK",
					json: async () => ({
						data: {
							viewer: { login: "josh" },
							search: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [workflowNode(workflow, searchIncludeChangedFiles, requestedChanges)] },
						},
					}),
				});
			}
			const data: Record<string, unknown> = {};
			for (const [, alias] of body.query.matchAll(/(\w+): repository\(owner: "[^"]+", name: "[^"]+"\)/g)) {
				data[alias] = {
					issueOrPullRequest: {
						...workflowNode(workflow, includeChangedFiles, requestedChanges),
						headRefOid: liveHeadSha,
					},
				};
			}
			return Promise.resolve({ ok: true, status: 200, statusText: "OK", json: async () => ({ data }) });
		}
		if (target.includes("/repos/example/repo/pulls/42/files")) {
			return Promise.resolve({
				ok: true,
				status: 200,
				statusText: "OK",
				json: async () => [
					{ filename: workflow ? ".github/workflows/deploy.yml" : "README.md", status: "modified", additions: 1, deletions: 1 },
				],
			});
		}
		return Promise.resolve({
			ok: true,
			status: 200,
			statusText: "OK",
			json: async () => repositoryPushPermission === undefined ? {} : { permissions: { push: repositoryPushPermission } },
		});
	};
}

function fakeHost() {
	const leaf = (): any => ({ optional: () => leaf(), describe: () => leaf() });
	return {
		events: new Map<string, any>(),
		flags: new Map<string, any>(),
		flagValues: new Map<string, unknown>(),
		shortcuts: new Map<string, any>(),
		tools: new Map<string, any>(),
		messages: [] as string[],
		entries: [] as Array<{ customType: string; data: unknown }>,
		zod: { object: () => ({}), string: leaf, number: leaf },
		setLabel() {},
		on(name: string, handler: any) { this.events.set(name, handler); },
		registerFlag(name: string, options: any) { this.flags.set(name, options); },
		getFlag(name: string) { return this.flagValues.get(name); },
		registerShortcut(name: string, options: any) { this.shortcuts.set(name, options); },
		registerTool(definition: any) { this.tools.set(definition.name, definition); },
		sendUserMessage(content: string) { this.messages.push(content); },
		appendEntry(customType: string, data: unknown) { this.entries.push({ customType, data }); },
		async exec() { return { stdout: "", stderr: "", code: 0, killed: false }; },
	};
}

function fakeCtx() {
	const notifications: Array<{ message: string; level: string }> = [];
	return {
		hasUI: true,
		notifications,
		ui: {
			theme: { fg: (_color: string, text: string) => text, bold: (text: string) => text, inverse: (text: string) => text },
			notify: (message: string, level: string) => notifications.push({ message, level }),
			setTitle() {},
			setStatus() {},
			setWidget() {},
			pasteToEditor() {},
			input: async () => undefined,
			editor: async () => undefined,
			confirm: async () => true,
			custom(factory: any) {
				factory({ requestRender() {} }, this.theme, {}, () => {});
				return Promise.resolve();
			},
		},
		getAsyncJobSnapshot: () => ({ running: [], recent: [], delivery: { pending: 0 } }),
		sessionManager: { getBranch: () => [] },
	};
}

test("workflow-changing pull requests stay visible in the personal queue", async () => {
	const mode = new ReviewMode({ org: "example", fetchImpl: makeFetch() as typeof fetch, env: ENV });
	mode.setToken("t");
	await mode.refreshQueue();
	assert.deepEqual(mode.items.map((item) => `${item.repo}#${item.id}`), ["example/repo#42"]);
	assert.equal(mode.selectById("example/repo", 42), true);
});

test("personal autoslay dispatches a workflow-changing PR with OAuth workflow scope", async (t) => {
	const pi = fakeHost();
	pi.flagValues.set("autoslay", true);
	const review = createReviewExtension(pi as unknown as Parameters<typeof createReviewExtension>[0], { org: "example", fetchImpl: makeFetch() as typeof fetch, env: ENV });
	const ctx = fakeCtx();
	await pi.events.get("session_start")({}, ctx);
	await review.whenStarted();
	await new Promise((resolve) => setImmediate(resolve));
	t.after(() => pi.events.get("session_shutdown")?.({}, ctx));

	assert.equal(pi.messages.length, 1);
	assert.match(pi.messages[0], /example\/repo#42/);
	assert.equal(ctx.notifications.some((notification) => /Skipping .*workflow/.test(notification.message)), false);
	const queue = await pi.tools.get("review_workbench_queue").execute("id", {});
	assert.match(queue.content[0].text, /example\/repo#42/);
});

test("personal workflow dispatch rejects push-only permission when workflow scope is omitted", async (t) => {
	const pi = fakeHost();
	pi.flagValues.set("autoslay", true);
	const review = createReviewExtension(pi as unknown as Parameters<typeof createReviewExtension>[0], {
		org: "example",
		fetchImpl: makeFetch(null, "4".repeat(40), true, true, true, true) as typeof fetch,
		env: ENV,
	});
	const ctx = fakeCtx();
	await pi.events.get("session_start")({}, ctx);
	await review.whenStarted();
	await new Promise((resolve) => setImmediate(resolve));
	t.after(() => pi.events.get("session_shutdown")?.({}, ctx));

	assert.equal(pi.messages.length, 0);
	assert.ok(ctx.notifications.some((notification) => /workflow\/Actions write permission could not be verified/.test(notification.message)));
});

test("personal workflow dispatch rechecks named workflow paths when queue omits files", async (t) => {
	const pi = fakeHost();
	pi.flagValues.set("autoslay", true);
	const review = createReviewExtension(pi as unknown as Parameters<typeof createReviewExtension>[0], {
		org: "example",
		fetchImpl: makeFetch("repo", "4".repeat(40), true, true, true, undefined, false, false) as typeof fetch,
		env: ENV,
	});
	const ctx = fakeCtx();
	await pi.events.get("session_start")({}, ctx);
	await review.whenStarted();
	await new Promise((resolve) => setImmediate(resolve));
	t.after(() => pi.events.get("session_shutdown")?.({}, ctx));

	assert.equal(pi.messages.length, 0);
	assert.ok(ctx.notifications.some((notification) => /workflow\/Actions write permission/.test(notification.message)));
});

test("returned workflow PR repair still requires capability when scopes are omitted", async (t) => {
	const pi = fakeHost();
	pi.flagValues.set("autoslay", true);
	const review = createReviewExtension(pi as unknown as Parameters<typeof createReviewExtension>[0], {
		org: "example",
		fetchImpl: makeFetch(null, "4".repeat(40), true, true, true, undefined, true) as typeof fetch,
		env: ENV,
	});
	const ctx = fakeCtx();
	await pi.events.get("session_start")({}, ctx);
	await review.whenStarted();
	await new Promise((resolve) => setImmediate(resolve));
	t.after(() => pi.events.get("session_shutdown")?.({}, ctx));

	assert.equal(pi.messages.length, 0);
	assert.ok(ctx.notifications.some((notification) => /workflow\/Actions write permission could not be verified/.test(notification.message)));
});

test("returned workflow repair fails closed without named file evidence", async (t) => {
	const pi = fakeHost();
	pi.flagValues.set("autoslay", true);
	const review = createReviewExtension(pi as unknown as Parameters<typeof createReviewExtension>[0], {
		org: "example",
		fetchImpl: makeFetch(null, "4".repeat(40), true, true, false, undefined, true, false) as typeof fetch,
		env: ENV,
	});
	const ctx = fakeCtx();
	await pi.events.get("session_start")({}, ctx);
	await review.whenStarted();
	await new Promise((resolve) => setImmediate(resolve));
	t.after(() => pi.events.get("session_shutdown")?.({}, ctx));

	assert.equal(pi.messages.length, 0);
	assert.ok(ctx.notifications.some((notification) => /complete changed-file list unavailable/.test(notification.message)));
});

test("personal workflow dispatch reports missing workflow write permission", async (t) => {
	const pi = fakeHost();
	pi.flagValues.set("autoslay", true);
	const review = createReviewExtension(pi as unknown as Parameters<typeof createReviewExtension>[0], { org: "example", fetchImpl: makeFetch("repo") as typeof fetch, env: ENV });
	const ctx = fakeCtx();
	await pi.events.get("session_start")({}, ctx);
	await review.whenStarted();
	await new Promise((resolve) => setImmediate(resolve));
	t.after(() => pi.events.get("session_shutdown")?.({}, ctx));

	assert.equal(pi.messages.length, 0);
	assert.ok(ctx.notifications.some((notification) => /lacks workflow\/Actions write permission/.test(notification.message)));
});

test("personal workflow dispatch fails closed when OAuth scopes are unavailable", async (t) => {
	const pi = fakeHost();
	pi.flagValues.set("autoslay", true);
	const review = createReviewExtension(pi as unknown as Parameters<typeof createReviewExtension>[0], { org: "example", fetchImpl: makeFetch(null) as typeof fetch, env: ENV });
	const ctx = fakeCtx();
	await pi.events.get("session_start")({}, ctx);
	await review.whenStarted();
	await new Promise((resolve) => setImmediate(resolve));
	t.after(() => pi.events.get("session_shutdown")?.({}, ctx));

	assert.equal(pi.messages.length, 0);
	assert.ok(ctx.notifications.some((notification) => /workflow\/Actions write permission could not be verified/.test(notification.message)));
});

test("personal workflow dispatch fails closed when scope lookup fails", async (t) => {
	const pi = fakeHost();
	pi.flagValues.set("autoslay", true);
	const review = createReviewExtension(pi as unknown as Parameters<typeof createReviewExtension>[0], { org: "example", fetchImpl: makeFetch("repo", "4".repeat(40), true, false) as typeof fetch, env: ENV });
	const ctx = fakeCtx();
	await pi.events.get("session_start")({}, ctx);
	await review.whenStarted();
	await new Promise((resolve) => setImmediate(resolve));
	t.after(() => pi.events.get("session_shutdown")?.({}, ctx));

	assert.equal(pi.messages.length, 0);
	assert.ok(ctx.notifications.some((notification) => /workflow\/Actions write permission could not be verified/.test(notification.message)));
});

test("personal workflow dispatch fails closed when changed-file evidence is unavailable", async (t) => {
	const pi = fakeHost();
	pi.flagValues.set("autoslay", true);
	const review = createReviewExtension(pi as unknown as Parameters<typeof createReviewExtension>[0], { org: "example", fetchImpl: makeFetch("repo, workflow", "4".repeat(40), true, true, false) as typeof fetch, env: ENV });
	const ctx = fakeCtx();
	await pi.events.get("session_start")({}, ctx);
	await review.whenStarted();
	await new Promise((resolve) => setImmediate(resolve));
	t.after(() => pi.events.get("session_shutdown")?.({}, ctx));

	assert.equal(pi.messages.length, 0);
	assert.ok(ctx.notifications.some((notification) => /complete changed-file list unavailable/.test(notification.message)));
});

test("Issue s and Alt-S dispatch issue implementation, while d requests issue evidence", () => {
	const mode = new ReviewMode({ org: "example", env: ENV });
	mode.queueMode = "issues";
	const issue = {
		id: 933,
		type: "issue" as const,
		repo: "example/repo",
		title: "issue work",
		author: "josh",
		url: "https://github.com/example/repo/issues/933",
		updatedAt: NOW,
		draft: false,
		mergeState: "unknown" as const,
		reviewState: "unknown" as const,
		labels: [],
	};
	mode.items = [issue];
	mode.reprioritize();
	const actions: any[] = [];
	const dashboard = new ReviewDashboard({ requestRender() {} }, PLAIN_PAINTER, mode, action => actions.push(action), () => {});
	try {
		dashboard.handleInput("s");
		dashboard.handleInput("alt+s");
		dashboard.handleInput("d");
		assert.deepEqual(actions.map(action => action.kind), ["fix", "fix", "diff"]);
		const implementation = actionPrompt(actions[0], undefined, { workbenchMode: mode.workbenchMode }) ?? "";
		assert.match(implementation, /gh repo clone <owner\/repo>/);
		assert.match(implementation, /\$HOME\/worktrees\/<owner>-<repo>-issue-<number>/);
		assert.doesNotMatch(implementation, /Hive|hive_workbench_lookup/);
		assert.doesNotMatch(actionPrompt(actions[2], undefined, { workbenchMode: mode.workbenchMode }), /hive_workbench_diff/);
		assert.match(actionPrompt(actions[2], undefined, { workbenchMode: mode.workbenchMode }), /review_workbench_issue/);
	} finally {
		dashboard.dispose();
	}
});

test("Issue inspection uses issue evidence and never calls the PR diff endpoint", async () => {
	const calls: string[] = [];
	const fetchImpl = async (url: string | URL | Request) => {
		const target = String(url);
		calls.push(target);
		if (target.endsWith("/issues/933/comments?per_page=100")) {
			return { ok: true, status: 200, statusText: "OK", json: async () => [{ user: { login: "maintainer" }, body: "Please investigate", created_at: "2026-09-15T00:00:00Z" }] };
		}
		if (target.endsWith("/issues/933/timeline?per_page=100")) {
			return { ok: true, status: 200, statusText: "OK", json: async () => [] };
		}
		if (target.endsWith("/issues/933")) {
			return {
				ok: true,
				status: 200,
				statusText: "OK",
				json: async () => ({
					number: 933,
					title: "issue work",
					body: "Investigate the failure",
					state: "open",
					user: { login: "reporter" },
					labels: [{ name: "bug" }],
					html_url: "https://github.com/example/repo/issues/933",
				}),
			};
		}
		throw new Error(`unexpected GitHub request: ${target}`);
	};
	const pi = fakeHost();
	const mode = new ReviewMode({ org: "example", fetchImpl: fetchImpl as typeof fetch, env: ENV });
	mode.setToken("t");
	registerTools(pi as any, mode, async () => {});
	const result = await pi.tools.get("review_workbench_issue").execute("id", { repo: "example/repo", issue: 933 });
	assert.equal(result.isError, false, JSON.stringify(result));
	assert.match(result.content[0].text, /issue work/);
	assert.match(result.content[0].text, /Please investigate/);
	assert.equal(calls.some(call => call.includes("/pulls/933")), false, calls.join("\n"));
});

test("Review mode registers only GitHub workbench tools and contains no Hive affordance", async () => {
	const pi = fakeHost();
	const mode = new ReviewMode({ org: "example", env: ENV });
	mode.hive = EMPTY_HIVE;
	mode.items = [{
		id: 933,
		type: "issue",
		repo: "example/repo",
		title: "issue work",
		author: "josh",
		url: "https://github.com/example/repo/issues/933",
		updatedAt: NOW,
		draft: false,
		mergeState: "unknown",
		reviewState: "unknown",
		labels: [],
	}];
	mode.reprioritize();
	registerTools(pi as any, mode, async () => {});
	for (const name of ["review_workbench_status", "review_workbench_queue", "review_workbench_diff", "review_workbench_trace"]) {
		assert.ok(pi.tools.has(name), name);
	}
	for (const name of pi.tools.keys()) assert.doesNotMatch(name, /^hive_/);
	const status = await pi.tools.get("review_workbench_status").execute("id", {});
	assert.match(status.content[0].text, /order: GitHub\/local/);
	assert.doesNotMatch(status.content[0].text, /Hive|hive|browse-only/);
});

test("Review mode never contacts Hive even when HIVE_HUB is inherited", async () => {
	const calls: string[] = [];
	const mode = new ReviewMode({
		org: "example",
		env: { ...ENV, HIVE_HUB: "https://hive.example" },
		fetchImpl: (async (url: string | URL | Request) => {
			calls.push(String(url));
			throw new Error("Review mode must not fetch Hive");
		}) as typeof fetch,
	});
	const hive = await mode.refreshHive();
	assert.equal(hive.configured, false);
	assert.deepEqual(calls, []);
});

test("personal UI presents a local Review surface without Hive-only controls", () => {
	const mode = new ReviewMode({ org: "example", env: ENV });
	mode.queueMode = "issues";
	mode.items = [{
		id: 933,
		type: "issue",
		repo: "example/repo",
		title: "issue work",
		author: "josh",
		url: "https://github.com/example/repo/issues/933",
		updatedAt: NOW,
		draft: false,
		mergeState: "unknown",
		reviewState: "unknown",
		labels: [],
	}];
	mode.reprioritize();
	const dashboard = new ReviewDashboard({ requestRender() {} }, PLAIN_PAINTER, mode, () => {}, () => {}, 24);
	try {
		const frame = dashboard.render(160).join("\n");
		assert.match(frame, /REVIEW WORKBENCH/);
		assert.doesNotMatch(frame, /HIVE WORKBENCH/);
		assert.match(frame, /implement/);
		dashboard.handleInput("?");
		const help = dashboard.render(160).join("\n");
		assert.match(help, /REVIEW WORKBENCH/);
		assert.equal(help.includes("H / L"), false);
		assert.doesNotMatch(help, /Hive/i);
		dashboard.handleInput("H");
		assert.equal(mode.hiveOnly, false);
		assert.match(renderRail(mode, PLAIN_PAINTER, 160, NOW, 0, []).join("\n"), /LOCAL/);
	} finally {
		dashboard.dispose();
	}
});

test("personal reviewer selection is generic outside Project Bluefin", () => {
	const generic = {
		...workflowNode(),
		type: "pr" as const,
		id: 42,
		repo: "example/repo",
		repository: { nameWithOwner: "example/repo" },
		url: "https://github.com/example/repo/pull/42",
	};
	const bluefin = { ...workflowNode(), type: "pr" as const, id: 42, repo: "projectbluefin/review" };
	assert.match(actionPrompt({ kind: "slay", item: generic as any }) ?? "", /generic-reviewer/);
	assert.doesNotMatch(actionPrompt({ kind: "slay", item: generic as any }) ?? "", /bluefin-reviewer/);
	assert.match(actionPrompt({ kind: "slay", item: bluefin as any }) ?? "", /bluefin-reviewer/);
});

test("Review mode keeps Bluefin policy without exposing Hive", () => {
	const bluefin = { ...workflowNode(), type: "pr" as const, id: 42, repo: "projectbluefin/review" };
	const prompt = actionPrompt({ kind: "slay", item: bluefin as any }, undefined, { workbenchMode: "review" }) ?? "";
	assert.match(prompt, /bluefin-reviewer/);
	assert.match(prompt, /review_workbench_diff/);
	assert.doesNotMatch(prompt, /hive_workbench|Hive/);
});

function ciNode(rollup: string | null, checkSuites: unknown) {
	return {
		...workflowNode(),
		commits: {
			nodes: [{
				commit: {
					statusCheckRollup: rollup === null ? null : { state: rollup },
					checkSuites,
				},
			}],
		},
	};
}

function ciFetch(node: unknown) {
	return async (url: string | URL | Request, init?: RequestInit) => {
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
								nodes: [node],
							},
						},
					}),
				};
			}
		}
		throw new Error("unexpected CI fixture request: " + target);
	};
}

test("authoritative successful rollup wins over queued ambient enterprise suites", async () => {
	const result = await fetchQueue("prs", {
		token: "t",
		fetchImpl: ciFetch(ciNode("SUCCESS", {
			pageInfo: { hasNextPage: false },
			nodes: [
				{ status: "QUEUED", conclusion: null, app: { name: "Azure Pipelines" } },
				{ status: "QUEUED", conclusion: null, app: { name: "Veracode Workflow App" } },
				{ status: "QUEUED", conclusion: null, app: { name: "Tenable Cloud Security" } },
			],
		})) as typeof fetch,
	});
	assert.equal(result.items[0]?.ciStatus, "success");
});

test("successful rollup stays successful with terminal successful suite conclusions", async () => {
	const result = await fetchQueue("prs", {
		token: "t",
		fetchImpl: ciFetch(ciNode("SUCCESS", {
			pageInfo: { hasNextPage: false },
			nodes: [
				{ status: "COMPLETED", conclusion: "SUCCESS" },
				{ status: "COMPLETED", conclusion: "NEUTRAL" },
				{ status: "COMPLETED", conclusion: "SKIPPED" },
			],
		})) as typeof fetch,
	});
	assert.equal(result.items[0]?.ciStatus, "success");
});

test("failed rollup wins over unrelated suite noise", async () => {
	const result = await fetchQueue("prs", {
		token: "t",
		fetchImpl: ciFetch(ciNode("FAILURE", {
			pageInfo: { hasNextPage: false },
			nodes: [{ status: "QUEUED", conclusion: null }],
		})) as typeof fetch,
	});
	assert.equal(result.items[0]?.ciStatus, "failure");
});

test("completed failing suites provide failure evidence when rollup is absent", async () => {
	const result = await fetchQueue("prs", {
		token: "t",
		fetchImpl: ciFetch(ciNode(null, {
			pageInfo: { hasNextPage: false },
			nodes: [{ status: "COMPLETED", conclusion: "FAILURE" }],
		})) as typeof fetch,
	});
	assert.equal(result.items[0]?.ciStatus, "failure");
});

test("active suites provide pending fallback evidence when rollup is absent", async () => {
	const result = await fetchQueue("prs", {
		token: "t",
		fetchImpl: ciFetch(ciNode(null, {
			pageInfo: { hasNextPage: false },
			nodes: [{ status: "IN_PROGRESS", conclusion: null }],
		})) as typeof fetch,
	});
	assert.equal(result.items[0]?.ciStatus, "pending");
});

test("terminal successful suites are nonblocking when rollup is absent", async () => {
	const result = await fetchQueue("prs", {
		token: "t",
		fetchImpl: ciFetch(ciNode(null, {
			pageInfo: { hasNextPage: false },
			nodes: [
				{ status: "COMPLETED", conclusion: "SUCCESS" },
				{ status: "COMPLETED", conclusion: "NEUTRAL" },
				{ status: "COMPLETED", conclusion: "SKIPPED" },
			],
		})) as typeof fetch,
	});
	assert.equal(result.items[0]?.ciStatus, "success");
});

test("incomplete fallback suite evidence is explicit unknown state", async () => {
	const result = await fetchQueue("prs", {
		token: "t",
		fetchImpl: ciFetch(ciNode(null, {
			pageInfo: { hasNextPage: true },
			nodes: [{ status: "COMPLETED", conclusion: "SUCCESS" }],
		})) as typeof fetch,
	});
	assert.equal(result.items[0]?.ciStatus, undefined);
	assert.equal(result.items[0]?.ciEvidenceComplete, false);
});

test("live PR revalidation reconciles current mutable state into ReviewMode", () => {
	const mode = new ReviewMode({ org: "example", env: ENV });
	const previous = {
		id: 42,
		type: "pr" as const,
		repo: "example/repo",
		title: "workflow change",
		author: "josh",
		url: "https://github.com/example/repo/pull/42",
		updatedAt: NOW,
		draft: false,
		ciStatus: "pending" as const,
		mergeState: "unknown" as const,
		reviewState: "review_required" as const,
		labels: ["old"],
		headSha: "4".repeat(40),
	};
	mode.items = [previous];
	mode.reprioritize();
	mode.reconcileItems([{
		...previous,
		headSha: "5".repeat(40),
		ciStatus: "success",
		mergeState: "clean",
		reviewState: "approved",
		labels: ["new"],
	}]);
	assert.equal(mode.items[0]?.headSha, "5".repeat(40));
	assert.equal(mode.items[0]?.ciStatus, "success");
	assert.equal(mode.items[0]?.mergeState, "clean");
	assert.equal(mode.items[0]?.reviewState, "approved");
	assert.deepEqual(mode.items[0]?.labels, ["new"]);
});

test("live head changes still block the captured pull request", async (t) => {
	const pi = fakeHost();
	pi.flagValues.set("autoslay", true);
	const review = createReviewExtension(pi as unknown as Parameters<typeof createReviewExtension>[0], {
		org: "example",
		fetchImpl: makeFetch("repo, workflow", "5".repeat(40), false) as typeof fetch,
		env: ENV,
	});
	const ctx = fakeCtx();
	await pi.events.get("session_start")({}, ctx);
	await review.whenStarted();
	await new Promise((resolve) => setImmediate(resolve));
	t.after(() => pi.events.get("session_shutdown")?.({}, ctx));
	assert.equal(pi.messages.length, 0);
	assert.ok(ctx.notifications.some((entry) => /pull request head changed/.test(entry.message)));
});
