/** Personal self-hosted policy: workflow PRs remain visible and may be slayed when GitHub permits it. */
import assert from "node:assert/strict";
import test from "node:test";

import { BATCH_ENTRY, createReviewExtension } from "../image/extension/bluefin-review/extension.ts";
import { ReviewMode } from "../image/extension/bluefin-review/mode.ts";

const NOW = 1_800_000_000_000;
const ENV = {
	GH_TOKEN: "t",
	HOME: "/nonexistent",
	XDG_CONFIG_HOME: "/nonexistent",
	BLUEFIN_REVIEW_ALLOW_WORKFLOW_SLAY: "1",
};

function workflowNode() {
	return {
		number: 42,
		title: "workflow change",
		url: "https://github.com/example/repo/pull/42",
		updatedAt: new Date(NOW).toISOString(),
		isDraft: false,
		mergeable: "MERGEABLE",
		reviewDecision: "REVIEW_REQUIRED",
		changedFiles: 1,
		headRefOid: "4".repeat(40),
		author: { login: "josh" },
		repository: { nameWithOwner: "example/repo" },
		labels: { nodes: [] },
		files: {
			pageInfo: { hasNextPage: false },
			nodes: [{ path: ".github/workflows/deploy.yml" }],
		},
		commits: { nodes: [{ commit: { statusCheckRollup: { state: "SUCCESS" } } }] },
		closingIssuesReferences: { nodes: [] },
	};
}

function makeFetch(scopes = "repo, workflow") {
	return (url: string | URL | Request, init?: RequestInit) => {
		const target = String(url);
		if (target === "https://api.github.com/") {
			return Promise.resolve({
				ok: true,
				status: 200,
				statusText: "OK",
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
						data: { search: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [workflowNode()] } },
					}),
				});
			}
			return Promise.resolve({ ok: true, status: 200, statusText: "OK", json: async () => ({ data: {} }) });
		}
		if (target.includes("/repos/example/repo/pulls/42/files")) {
			return Promise.resolve({
				ok: true,
				status: 200,
				statusText: "OK",
				json: async () => [
					{ filename: ".github/workflows/deploy.yml", status: "modified", additions: 1, deletions: 1 },
				],
			});
		}
		return Promise.resolve({ ok: true, status: 200, statusText: "OK", json: async () => ({}) });
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

test("autoslay dispatches a workflow-changing PR when OAuth has workflow scope", async (t) => {
	const pi = fakeHost();
	pi.flagValues.set("autoslay", true);
	const review = createReviewExtension(pi as any, { org: "example", fetchImpl: makeFetch() as typeof fetch, env: ENV });
	const ctx = fakeCtx();
	await pi.events.get("session_start")({}, ctx);
	await review.whenStarted();
	await new Promise((resolve) => setImmediate(resolve));
	t.after(() => pi.events.get("session_shutdown")?.({}, ctx));

	assert.equal(pi.messages.length, 1, JSON.stringify(ctx.notifications));
	assert.match(pi.messages[0]!, /example\/repo#42/);
	assert.equal(ctx.notifications.some((entry) => /Skipping .*workflow/.test(entry.message)), false);
});

test("personal workflow slay still fails closed when classic OAuth scope is known missing", async (t) => {
	const pi = fakeHost();
	pi.flagValues.set("autoslay", true);
	const review = createReviewExtension(pi as any, {
		org: "example",
		fetchImpl: makeFetch("repo, read:org") as typeof fetch,
		env: ENV,
	});
	const ctx = fakeCtx();
	await pi.events.get("session_start")({}, ctx);
	await review.whenStarted();
	await new Promise((resolve) => setImmediate(resolve));
	t.after(() => pi.events.get("session_shutdown")?.({}, ctx));

	assert.equal(pi.messages.length, 0);
	assert.ok(ctx.notifications.some((entry) => /lacks 'workflow' scope/.test(entry.message)));
	const batch = pi.entries.filter((entry) => entry.customType === BATCH_ENTRY).at(-1)?.data as { state?: string; error?: string } | undefined;
	assert.equal(batch?.state, "blocked");
	assert.match(batch?.error ?? "", /\.github\/workflows\/deploy\.yml/);
});
