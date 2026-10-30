/**
 * LLM-callable tools.
 *
 * Each one returns real data or an explicit failure. A tool that claims to have
 * fetched a diff and returns prose is worse than no tool: the model believes it.
 */

import { diffToText, fetchDiff, fetchIssueDetail } from "./github.ts";
import type { ReviewMode } from "./mode.ts";
import { sanitizeMarkdown } from "./reader.ts";
import { traceToText } from "./trace.ts";

interface ToolContent {
	type: "text";
	text: string;
}

interface ToolResult {
	content: ToolContent[];
	details?: unknown;
	isError?: boolean;
}

interface ZodLike {
	object(shape: Record<string, unknown>): unknown;
	string(): { optional(): unknown; describe(text: string): { optional(): unknown } };
	number(): { describe(text: string): { optional(): unknown } };
}

export interface ToolHost {
	zod: ZodLike;
	registerTool(definition: {
		name: string;
		label: string;
		description: string;
		parameters: unknown;
		execute(toolCallId: string, params: Record<string, unknown>): Promise<ToolResult>;
	}): void;
}

function text(value: string): ToolContent[] {
	return [{ type: "text", text: value }];
}

type ToolDefinition = Parameters<ToolHost["registerTool"]>[0];

/** Resolve the repository for a tool call: explicit, else the selection, else org default. */
function resolveRepo(mode: ReviewMode, params: Record<string, unknown>, field: "pull_request" | "issue" = "pull_request"): string | undefined {
	const explicit = typeof params.repo === "string" ? params.repo : undefined;
	if (explicit) return explicit.includes("/") ? explicit : `${mode.org}/${explicit}`;
	const number = typeof params[field] === "number" ? params[field] : undefined;
	const match = number === undefined ? mode.selected() : mode.items.find((item) => item.id === number);
	return match?.repo;
}

function issueDetailToText(detail: Awaited<ReturnType<typeof fetchIssueDetail>>["detail"]): string {
	if (!detail) return "issue unavailable";
	const clean = (value: string): string => sanitizeMarkdown(value);
	const lines = [
		`${clean(detail.repo)}#${detail.number}: ${clean(detail.title)} [${clean(detail.state)}]`,
		`author @${clean(detail.author)} labels=${detail.labels.map(clean).join(",") || "none"}`,
		clean(detail.url),
		"",
		clean(detail.body) || "(no description)",
	];
	if (detail.comments.length > 0) {
		lines.push("", "comments:");
		for (const comment of detail.comments) {
			lines.push(`@${clean(comment.author)} ${clean(comment.createdAt)}`, clean(comment.body) || "(comment)", "");
		}
	}
	if (detail.linkedPullRequests.length > 0) {
		lines.push("linked pull requests:");
		for (const pull of detail.linkedPullRequests) {
			lines.push(`${clean(pull.repo)}#${pull.number} [${clean(pull.state)}] ${clean(pull.title)} ${clean(pull.url)}`);
		}
	}
	return lines.join("\n");
}


/** The queue order comes from the current GitHub snapshot and local policy. */
function orderLine(): string {
	return "order: LOCAL · attention order — repository scope and filters";
}

export function registerTools(pi: ToolHost, mode: ReviewMode, whenReady: () => Promise<void>): void {
	const z = pi.zod;
	const registerTool = (definition: ToolDefinition): void => pi.registerTool(definition);

	registerTool({
		name: "review_workbench_status",
		label: "Workbench Status",
		description:
			"Current GitHub Review queue, selection, ordering, and available execution evidence.",
		parameters: z.object({}),
		async execute() {
			await whenReady();
			const now = Date.now();
			const item = mode.selected();
			const tally = mode.ciTally();
			const priority = item ? mode.priorityFor(item) : undefined;
			const lines = [
				`mode=${mode.queueMode} scope=${mode.scopeLabel()} items=${mode.visibleItems().length}/${mode.items.length}`,
				`ci: ${tally.success} passing, ${tally.failure} failing, ${tally.pending} pending, ${tally.unknown} unknown`,
				orderLine(),
			];
			if (mode.queueError) lines.push(`queue error: ${mode.queueError}`);
			if (item) {
				lines.push(
					"",
					`selected ${item.repo}#${item.id} — ${item.title}`,
					`author @${item.author}${item.draft ? " (draft)" : ""} ci=${item.ciStatus ?? "unknown"} merge=${item.mergeState} review=${item.reviewState} labels=${item.labels.join(",") || "none"}`,
					priority ? `priority: ${priority.category} (${priority.reason})` : "priority: unranked",
					`landing: ${mode.landingStateFor(item)}`,
					`human review policy: ${mode.operatorPolicyFor(item.repo)?.mode ?? "team"} (${mode.operatorPolicyFor(item.repo)?.source ?? "default"})${mode.operatorLandingReasonFor(item) ? `; ${mode.operatorLandingReasonFor(item)}` : ""}`,
					`head: ${item.headSha ? `${item.headSha.slice(0, 12)}...${item.headSha}` : "unknown"}`,
					item.url,
					"",
					traceToText(mode.session.roots(), now, 180),
				);
			} else {
				lines.push("", "no item selected");
			}

			return {
				content: text(lines.join("\n")),
				details: {
					mode: mode.queueMode,
					org: mode.org,
					scope: mode.scope,
					order_source: mode.orderSource(),
					selected_priority: priority ?? null,
				landing_state: item ? mode.landingStateFor(item) : null,
				operator_policy: item ? mode.operatorPolicyFor(item.repo) ?? null : null,
				landing_policy_reason: item ? mode.operatorLandingReasonFor(item) ?? null : null,
					total_items: mode.items.length,
					visible_items: mode.visibleItems().length,
					queue_error: mode.queueError ?? null,
					ci: tally,
					selected: { ...item, head_sha: item.headSha ?? null },
				},
			};
		},
	});

	registerTool({
		name: "review_workbench_queue",
		label: "Workbench Queue",
		description:
			"List the live workbench queue of open pull requests or issues, optionally filtered by title, repository, author, label, or number.",
		parameters: z.object({
			filter: z.string().describe("substring matched against title, repo, author, labels, number").optional(),
			limit: z.number().describe("maximum rows to return (default 30)").optional(),
		}),
		async execute(_id, params) {
			await whenReady();
			const limit = typeof params.limit === "number" ? Math.max(1, Math.min(100, params.limit)) : 30;
			const needle = typeof params.filter === "string" ? params.filter.toLowerCase() : "";
			const rows = mode.visibleItems()
				.filter(
					(item) =>
						!needle ||
						item.title.toLowerCase().includes(needle) ||
						item.repo.toLowerCase().includes(needle) ||
						item.author.toLowerCase().includes(needle) ||
						String(item.id).includes(needle) ||
						item.labels.some((label) => label.toLowerCase().includes(needle)),
				)
				.slice(0, limit);

			if (rows.length === 0) {
				return {
					content: text(mode.queueError ? `queue unavailable: ${mode.queueError}` : "no matching items"),
					details: { items: [], queue_error: mode.queueError ?? null },
					isError: Boolean(mode.queueError),
				};
			}

			const body = rows
				.map((item) => {
					const priority = mode.priorityFor(item);
					const chip = priority ? `[${priority.category}]` : "[unranked]";
					return `${chip} ${item.repo}#${item.id} [ci:${item.ciStatus ?? "unknown"}] ${item.title} (@${item.author})`;
				})
				.join("\n");
			return {
				content: text(body),
				details: {
					items: rows,
					order_source: mode.orderSource(),
					priorities: Object.fromEntries(
						rows.map((item) => [`${item.repo}#${item.id}`, mode.priorityFor(item) ?? null]),
					),
					queue_error: mode.queueError ?? null,
				},
			};
		},
	});

	registerTool({
		name: "review_workbench_diff",
		label: "Review Diff",
		description:
			"Fetch the bounded diff for a pull request from the GitHub API. Pass repo explicitly in child sessions because they do not inherit the parent selection.",
		parameters: z.object({
			pull_request: z.number().describe("Pull request number to inspect"),
			repo: z.string().describe("owner/repo; required in child sessions, otherwise defaults to the selected item's repository").optional(),
			max_files: z.number().describe("files whose patch text is included (default 20)").optional(),
		}),
		async execute(_id, params) {
			const pullRequest = typeof params.pull_request === "number" ? params.pull_request : Number.NaN;
			if (!Number.isInteger(pullRequest) || pullRequest < 1) {
				return { content: text("pull_request must be a positive integer"), isError: true };
			}
			const repo = resolveRepo(mode, params);
			if (!repo) {
				return { content: text("no repository: pass repo as owner/name, or select a queue item first"), isError: true };
			}

			const diff = await fetchDiff(repo, pullRequest, {
				...mode.tokenOptions(),
				maxPatchFiles: typeof params.max_files === "number" ? params.max_files : undefined,
			});
			return {
				content: text(diffToText(diff)),
				details: {
					repo,
					pull_request: pullRequest,
					files: diff.files.map(({ path, status, additions, deletions }) => ({ path, status, additions, deletions })),
					total_files: diff.totalFiles,
					additions: diff.additions,
					deletions: diff.deletions,
					truncated: diff.truncated,
					head_sha: diff.headSha,
					error: diff.error ?? null,
				},
				isError: Boolean(diff.error),
			};
		},
	});

	registerTool({
			name: "review_workbench_issue",
			label: "Review Issue",
			description: "Fetch the issue body, comments, labels, state, and linked pull requests from GitHub.",
			parameters: z.object({
				issue: z.number().describe("Issue number to inspect"),
				repo: z.string().describe("owner/repo; required in child sessions, otherwise defaults to the selected item's repository").optional(),
			}),
			async execute(_id, params) {
				const issue = typeof params.issue === "number" ? params.issue : Number.NaN;
				if (!Number.isInteger(issue) || issue < 1) {
					return { content: text("issue must be a positive integer"), isError: true };
				}
				const repo = resolveRepo(mode, params, "issue");
				if (!repo) {
					return { content: text("no repository: pass repo as owner/name, or select a queue item first"), isError: true };
				}
				const result = await fetchIssueDetail(repo, issue, mode.tokenOptions());
				return {
					content: text(result.detail ? issueDetailToText(result.detail) : `issue unavailable for ${repo}#${issue}: ${result.error ?? "unknown error"}`),
					details: { repo, issue, issue_detail: result.detail ?? null, error: result.error ?? null },
					isError: Boolean(result.error),
				};
			},
	});

	registerTool({
		name: "review_workbench_trace",
		label: "Review Trace",
		description: "Render the current OMP session and workflowz execution trace.",
		parameters: z.object({}),
		async execute() {
			const now = Date.now();
			const spans = mode.session.roots();
			return {
				content: text(traceToText(spans, now, 180)),
				details: { has_state: spans.length > 0 },
			};
		},
	});
}
