import assert from "node:assert/strict";
import test from "node:test";

import { fetchItemsByKey } from "../image/extension/review/github.ts";

const HEAD = "a".repeat(40);
const BASE = "b".repeat(40);
const CHANGED_FILES = 528;
const PATHS = Array.from({ length: CHANGED_FILES }, (_, index) => `src/file-${index}.ts`);
PATHS[527] = ".github/workflows/late.yml";

function pageNodes(start: number, size: number): Array<{ path: string }> {
	return PATHS.slice(start, start + size).map((path) => ({ path }));
}

function initialPayload() {
	return {
		data: {
			w0: {
				issueOrPullRequest: {
					number: 35,
					closed: false,
					title: "large PR",
					url: "https://github.com/joshyorko/job-hunt-tracker/pull/35",
					updatedAt: "2026-10-29T12:00:00Z",
					repository: { nameWithOwner: "joshyorko/job-hunt-tracker" },
					author: { login: "author" },
					headRefOid: HEAD,
					baseRefOid: BASE,
					changedFiles: CHANGED_FILES,
					files: { pageInfo: { hasNextPage: true, endCursor: "cursor-1" }, nodes: pageNodes(0, 100) },
				},
			},
		},
	};
}

function continuationPayload(
	start: number,
	endCursor: string,
	options: { headRefOid?: string; baseRefOid?: string; hasNextPage?: boolean } = {},
) {
	const nextIndex = start + 100;
	return {
		data: {
			w0: {
				nameWithOwner: "joshyorko/job-hunt-tracker",
				pullRequest: {
					number: 35,
					closed: false,
					headRefOid: options.headRefOid ?? HEAD,
					baseRefOid: options.baseRefOid ?? BASE,
					changedFiles: CHANGED_FILES,
					files: {
						pageInfo: {
							hasNextPage: options.hasNextPage ?? nextIndex < CHANGED_FILES,
							endCursor,
						},
						nodes: pageNodes(start, Math.min(100, CHANGED_FILES - start)),
					},
				},
			},
		},
	};
}

function response(payload: unknown, status = 200): Response {
	return new Response(JSON.stringify(payload), { status, statusText: status === 200 ? "OK" : "Unavailable" });
}

function initialWith(overrides: Record<string, unknown>) {
	const payload = initialPayload();
	return { data: { w0: { issueOrPullRequest: { ...payload.data.w0.issueOrPullRequest, ...overrides } } } };
}

test("named PR read paginates every changed path and sees a later workflow file", async () => {
	const requests: string[] = [];
	const result = await fetchItemsByKey(["joshyorko/job-hunt-tracker#35"], "prs", {
		token: "test-token",
		fetchImpl: async (_url, init) => {
			const query = JSON.parse(String(init?.body ?? "{}")).query as string;
			requests.push(query);
			if (requests.length === 1) return response(initialPayload());
			const page = requests.length - 1;
			return response(continuationPayload(page * 100, `cursor-${page + 1}`));
		},
	});

	assert.equal(result.error, undefined);
	assert.equal(requests.length, 6, "528 changed files require six 100-file pages");
	assert.equal(result.items[0]?.changedFilesComplete, true);
	assert.deepEqual(result.items[0]?.workflowFiles, [".github/workflows/late.yml"]);
});

test("named PR read keeps incomplete evidence blocked on a page error", async () => {
	let requests = 0;
	const result = await fetchItemsByKey(["joshyorko/job-hunt-tracker#35"], "prs", {
		token: "test-token",
		fetchImpl: async () => ++requests === 1 ? response(initialPayload()) : response({}, 503),
	});

	assert.match(result.error ?? "", /503/);
	assert.equal(result.items[0]?.changedFilesComplete, false);
});

test("named PR read rejects head or base drift during file pagination", async (t) => {
	for (const drift of ["headRefOid", "baseRefOid"] as const) {
		await t.test(drift, async () => {
			let requests = 0;
			const result = await fetchItemsByKey(["joshyorko/job-hunt-tracker#35"], "prs", {
				token: "test-token",
				fetchImpl: async () => {
					requests += 1;
					if (requests === 1) return response(initialPayload());
					return response(continuationPayload(100, "cursor-2", { [drift]: "c".repeat(40) }));
				},
			});

			assert.match(result.error ?? "", new RegExp(drift === "headRefOid" ? "head changed" : "base changed"));
			assert.equal(result.items[0]?.changedFilesComplete, false);
		});
	}
});

test("named PR read rejects duplicate paths, stalled cursors, and partial final pages", async (t) => {
	const cases: Array<{ name: string; page: () => Response; expected: RegExp }> = [
		{
			name: "duplicate path",
			page: () => {
				const payload = continuationPayload(100, "cursor-2");
				payload.data.w0.pullRequest.files.nodes[0] = { path: PATHS[0] };
				return response(payload);
			},
			expected: /duplicate changed-file paths/,
		},
		{
			name: "stalled cursor",
			page: () => response(continuationPayload(100, "cursor-1")),
			expected: /cursor did not advance/,
		},
		{
			name: "partial final page",
			page: () => response(continuationPayload(100, "cursor-2", { hasNextPage: false })),
			expected: /count did not match/,
		},
	];
	for (const scenario of cases) {
		await t.test(scenario.name, async () => {
			let requests = 0;
			const result = await fetchItemsByKey(["joshyorko/job-hunt-tracker#35"], "prs", {
				token: "test-token",
				fetchImpl: async () => ++requests === 1 ? response(initialPayload()) : scenario.page(),
			});

			assert.match(result.error ?? "", scenario.expected);
			assert.equal(result.items[0]?.changedFilesComplete, false);
		});
	}
});

test("named PR read keeps file-page response bytes bounded", async () => {
	let requests = 0;
	const result = await fetchItemsByKey(["joshyorko/job-hunt-tracker#35"], "prs", {
		token: "test-token",
		fetchImpl: async () => {
			requests += 1;
			if (requests === 1) return response(initialPayload());
			return new Response(JSON.stringify({
				...continuationPayload(100, "cursor-2"),
				padding: "x".repeat(1_100_000),
			}));
		},
	});

	assert.match(result.error ?? "", /byte limit/);
	assert.equal(result.items[0]?.changedFilesComplete, false);
});

test("named PR read requires a valid total even when the first page is terminal", async (t) => {
	for (const count of [undefined, null, -1, 1.5, "1"]) {
		await t.test(`count ${String(count)}`, async () => {
			const result = await fetchItemsByKey(["joshyorko/job-hunt-tracker#35"], "prs", {
				token: "test-token",
				fetchImpl: async () => response(initialWith({
					changedFiles: count,
					files: { pageInfo: { hasNextPage: false }, nodes: [{ path: "README.md" }] },
				})),
			});
			assert.equal(result.items[0]?.changedFilesComplete, false);
			assert.match(result.error ?? "", /changed-file count/);
		});
	}
});

test("partial named responses preserve readable items without certifying missing file evidence", async () => {
	const payload = initialWith({ changedFiles: undefined, files: { pageInfo: { hasNextPage: false }, nodes: [] } });
	const result = await fetchItemsByKey(["joshyorko/job-hunt-tracker#35", "other/repo#7"], "prs", {
		token: "test-token",
		fetchImpl: async () => response({
			data: { ...payload.data, w1: null },
			errors: [{ message: "changedFiles unavailable", path: ["w0", "issueOrPullRequest", "changedFiles"] }],
		}),
	});
	assert.equal(result.items.length, 1);
	assert.equal(result.items[0]?.changedFilesComplete, false);
	assert.match(result.error ?? "", /changedFiles unavailable/);
});

test("malformed first-page paths do not discard another readable named PR", async () => {
	const bad = initialWith({ files: { pageInfo: { hasNextPage: false }, nodes: [null] } });
	const good = initialWith({
		number: 36, changedFiles: 1,
		files: { pageInfo: { hasNextPage: false }, nodes: [{ path: "README.md" }] },
	}).data.w0;
	const result = await fetchItemsByKey(["joshyorko/job-hunt-tracker#35", "joshyorko/job-hunt-tracker#36"], "prs", {
		token: "test-token",
		fetchImpl: async () => response({ data: { ...bad.data, w1: good } }),
	});
	assert.equal(result.items.find((item) => item.id === 35)?.changedFilesComplete, false);
	assert.equal(result.items.find((item) => item.id === 36)?.changedFilesComplete, true);
	assert.match(result.error ?? "", /without a path/);
});

test("named PR read rejects continuation identity, state, and count changes", async (t) => {
	for (const [name, overrides, expected] of [
		["number", { number: 36 }, /identity or open state changed/],
		["closed", { closed: true }, /identity or open state changed/],
		["count", { changedFiles: 529 }, /count changed/],
	] as const) {
		await t.test(name, async () => {
			let requests = 0;
			const page = continuationPayload(100, "cursor-2");
			Object.assign(page.data.w0.pullRequest, overrides);
			const result = await fetchItemsByKey(["joshyorko/job-hunt-tracker#35"], "prs", {
				token: "test-token",
				fetchImpl: async () => response(++requests === 1 ? initialPayload() : page),
			});
			assert.equal(result.items[0]?.changedFilesComplete, false);
			assert.match(result.error ?? "", expected);
		});
	}
});

test("named PR read rejects a continuation from another repository", async () => {
	let requests = 0;
	const page = continuationPayload(100, "cursor-2");
	page.data.w0.nameWithOwner = "other/repository";
	const result = await fetchItemsByKey(["joshyorko/job-hunt-tracker#35"], "prs", {
		token: "test-token",
		fetchImpl: async () => response(++requests === 1 ? initialPayload() : page),
	});
	assert.equal(result.items[0]?.changedFilesComplete, false);
	assert.match(result.error ?? "", /no longer identifies/);
});

test("partial GraphQL continuation data never completes the file list", async () => {
	let requests = 0;
	const result = await fetchItemsByKey(["joshyorko/job-hunt-tracker#35"], "prs", {
		token: "test-token",
		fetchImpl: async () => response(++requests === 1 ? initialPayload() : {
			...continuationPayload(100, "cursor-2"),
			errors: [{ message: "file page unavailable" }],
		}),
	});
	assert.equal(result.items[0]?.changedFilesComplete, false);
	assert.match(result.error ?? "", /file page unavailable/);
});

test("missing and cycling continuation cursors stop within a bounded number of requests", async (t) => {
	for (const cursor of [undefined, "", "cursor-1"]) {
		await t.test(`cursor ${String(cursor)}`, async () => {
			let requests = 0;
			const page = continuationPayload(100, "cursor-2");
			Object.assign(page.data.w0.pullRequest.files.pageInfo, { endCursor: cursor });
			const result = await fetchItemsByKey(["joshyorko/job-hunt-tracker#35"], "prs", {
				token: "test-token",
				fetchImpl: async () => response(++requests === 1 ? initialPayload() : page),
			});
			assert.equal(requests, 2);
			assert.equal(result.items[0]?.changedFilesComplete, false);
			assert.match(result.error ?? "", /cursor did not advance/);
		});
	}
});

test("named PR read leaves more than thirty file pages incomplete", async () => {
	let requests = 0;
	const result = await fetchItemsByKey(["joshyorko/job-hunt-tracker#35"], "prs", {
		token: "test-token",
		fetchImpl: async () => {
			const start = requests++ * 100;
			const files = {
				pageInfo: { hasNextPage: true, endCursor: `cursor-${requests}` },
				nodes: Array.from({ length: 100 }, (_, i) => ({ path: `src/file-${start + i}.ts` })),
			};
			if (requests === 1) return response(initialWith({ changedFiles: 3001, files }));
			const page = continuationPayload(start, `cursor-${requests}`);
			Object.assign(page.data.w0.pullRequest, { changedFiles: 3001, files });
			return response(page);
		},
	});
	assert.equal(requests, 30);
	assert.equal(result.items[0]?.changedFilesComplete, false);
});
