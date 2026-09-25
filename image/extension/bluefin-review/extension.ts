/**
 * Review and optional Hive read-side workbench extension wiring.
 *
 * Review uses GitHub as its queue; Hive is optional read-side context, never an
 * assignment source. OMP owns sessions, tools, and workflowz execution. This file
 * only joins those seams to the workbench UI.
 */

import { type DashboardAction, ReviewDashboard } from "./dashboard.ts";
import { loadWave, saveWave } from "./wave-store.ts";
import type { QueueItem } from "./github.ts";
import { exactHeadVerified, fetchDiff, fetchIssueAdmission, fetchItemsByKey, fetchOAuthScopes, orgScope, parseScope, resolveToken } from "./github.ts";
import { isRepairRequested, type Priority } from "./priority.ts";
import { BATCH_LIMIT, ReviewMode, type PersistedSelection, type WorkbenchMode } from "./mode.ts";
import { registerFactoryReconciler, registerFactorySelection, factoryCommand, factoryControllerRegistered, factoryLoadDiagnostic } from "../luna-factory/omp/batch-bridge.ts";
import { ResourceClaims, factoryClaimsRoot, factoryStateRoot } from "../luna-factory/omp/batch-store.ts";
import { workbenchPainter } from "./paint.ts";
import { type RailKey, ReviewRail, statusSegment } from "./rail.ts";
import type { KeyMatcher } from "./keys.ts";
import { type ToolHost, registerTools } from "./tools.ts";
import { hiveFailureStatus } from "./hive.ts";
import { landingState, landingReason } from "./landing.ts";
import { GENERIC_WORKBENCH_POLICY, managedPolicyFor, type WorkbenchPolicy } from "./policy.ts";
import {
	commentInvocation,
	createCommentActionPlan,
	renderCommentActionPlan,
	validateCommentActionPlan,
	type CommentActionPlan,
	type CommentTargetSnapshot,
} from "./mutations.ts";
export {
	type CommentTargetSnapshot,
	type CommentActionPlan,
	type CommentPlanValidation,
	type NativeInvocation,
	createCommentActionPlan,
	renderCommentActionPlan,
	validateCommentActionPlan,
	commentInvocation,
} from "./mutations.ts";
export {
	GENERIC_WORKBENCH_POLICY,
	managedPolicyFor,
	type ManagedRepoPolicy,
	type WorkbenchPolicy,
} from "./policy.ts";
export const STATE_ENTRY = "com.hive.workbench.selection";
export const BATCH_ENTRY = "com.hive.workbench.batch";
export const COMMENT_ENTRY = "com.hive.workbench.comment";

export type RepositoryBatchKind = "slay" | "fix" | "diff";
export type RepositoryBatchState = "running" | "paused" | "blocked" | "complete" | "cancelled";

export interface PersistedRepositoryBatch {
	readonly version: 1;
	readonly id: string;
	readonly kind: RepositoryBatchKind;
	readonly waves: ReadonlyArray<{ readonly repo: string; readonly items: readonly QueueItem[] }>;
	readonly currentWave: number;
	readonly completedItems: number;
	readonly totalItems: number;
	readonly state: RepositoryBatchState;
	readonly startedAt: number;
	readonly waveStartedAt: number;
	readonly waveIdentity?: string;
	readonly waveToolCallIds?: readonly string[];
	readonly waveTaskWorkers?: Readonly<Record<string, readonly { agentId: string; jobId?: string; resultStatus?: "completed" | "failed" | "cancelled" }[]>>;
	readonly waveJobBaselineIds?: readonly string[];
	readonly waveJobIds?: readonly string[];
	readonly waveTerminalJobStatuses?: Readonly<Record<string, "completed" | "failed" | "cancelled" | "canceled">>;
	readonly waveEffectResources?: readonly string[];
	/** Baseline issue submissions captured before this wave was dispatched. */
	readonly issueSubmittedPrs?: Readonly<Record<string, readonly string[]>>;
	/** Operator requested cancellation; the current wave must drain before archive. */
	readonly cancelRequested?: boolean;
	readonly error?: string;
}

export interface PersistedCommentResult {
	readonly version: 1;
	readonly state: "previewed" | "confirmed" | "complete" | "failed" | "aborted";
	readonly plan: CommentActionPlan;
	readonly receipts?: readonly string[];
	readonly error?: string;
}

/** Queue refetch cadence. GitHub search is rate limited. */
const QUEUE_POLL_MS = 60_000;
// Hive's queue moves with the project, not with the terminal. Polling it on the
// queue's cadence keeps one hub request per refresh instead of one per repaint.
const HIVE_POLL_MS = 120_000;

function slayBashBlockReason(command: string): string | undefined {
	if (/\b[a-z][a-z0-9+.-]*:\/\/[^/\s:@]+:[^/\s@]+@/i.test(command)) {
		return "credentials in URL userinfo would be exposed through process arguments";
	}
	for (const segment of command.split(/\r?\n|&&|\|\||;/)) {
		if (/\bgh\s+pr\s+merge\b/.test(segment) && /(?:^|\s)--admin(?:[=\s]|$)/.test(segment)) {
			return "admin merge bypass is forbidden; use GitHub's ordinary rules";
		}
		if (
			/\bgit(?:\s+(?!push(?:\s|$))\S+)*\s+push(?:\s|$)/.test(segment)
			&& /(?:^|\s)(?:-f|--force(?:-with-lease)?)(?:=[^\s]+)?(?:\s|$)/.test(segment)
		) {
			return "force-pushing a slay target is forbidden";
		}
	}
	return undefined;
}

function slayLandingBlockReason(
	command: string,
	items: readonly QueueItem[],
	policy?: WorkbenchPolicy,
): string | undefined {
	const mutatesLanding = command.split(/\r?\n|&&|\|\||;/).some((segment) =>
		/\bgh\s+pr\s+merge\b/.test(segment)
		|| (/\bgh\s+pr\s+review\b/.test(segment) && /(?:^|\s)--approve(?:[=\s]|$)/.test(segment)),
	);
	if (!mutatesLanding) return undefined;
	// Never approve or merge a pull request that is not genuinely ready to land:
	// CI alone never implies ready. Every policy input blocks, so a queued hold or
	// a requested-changes review stops the mutation just as a failing check does.
	for (const item of items) {
		if (item.type !== "pr") continue;
		const state = landingState(item, policy);
		if (state === "ready-to-land") continue;
		return `${item.repo}#${item.id} ${landingReason(state)}; refresh and clear it before approval or merge`;
	}
	return undefined;
}

export const RAIL_KEYS: readonly RailKey[] = [
	{ chord: "alt+b", label: "workbench" },
	{ chord: "alt+s", label: "autoslay" },
	{ chord: "alt+u", label: "refresh" },
];

export interface ExtensionOptions {
	/** Injected by `index.ts` so the overlay understands kitty-protocol chords. */
	matchKey?: KeyMatcher;
	org?: string;
	fetchImpl?: typeof fetch;
	env?: NodeJS.ProcessEnv;
	policy?: WorkbenchPolicy;
}

/** Loose structural types: the extension must build without omp's declarations. */
interface UiLike {
	notify(message: string, level?: "info" | "warning" | "error"): void;
	input(title: string, placeholder?: string): Promise<string | undefined>;
	select(title: string, options: Array<string | { label: string; description?: string }>): Promise<string | undefined>;
	confirm(title: string, message: string): Promise<boolean>;
	editor(title: string, prefill?: string, options?: unknown, editorOptions?: { promptStyle?: boolean }): Promise<string | undefined>;
	setStatus(key: string, value: string | undefined): void;
	setWidget(key: string, content: unknown, options?: { placement?: string }): void;
	setTitle(title: string): void;
	pasteToEditor(text: string): void;
	custom<T>(factory: (tui: unknown, theme: unknown, keybindings: unknown, done: (result: T) => void) => unknown, options?: unknown): Promise<T>;
	readonly theme: { fg(color: string, text: string): string; bold(text: string): string; inverse(text: string): string };
}

interface CtxLike {
	hasUI: boolean;
	ui: UiLike;
	sessionManager?: { getBranch(): Array<{ type?: string; customType?: string; data?: unknown }> };
	getAsyncJobSnapshot?(): {
		running: Array<{ id: string; agentId?: string; type?: string; status: string; startTime: number; waveId?: string }>;
		recent: Array<{ id: string; agentId?: string; type?: string; status: string; startTime: number; waveId?: string }>;
		delivery?: { pendingJobIds: readonly string[] };
	} | null;
}

/** The slice of omp's `ExtensionAPI` this mode uses. */
export interface ReviewExtensionHost {
	exec(command: string, args: string[], options?: { timeout?: number }): Promise<{ stdout: string; stderr: string; code: number; killed: boolean }>;
	zod: unknown;
	setLabel(label: string): void;
	on(event: string, handler: (event: unknown, ctx: CtxLike) => unknown): void;
	registerShortcut(chord: string, options: { description?: string; handler: (ctx: CtxLike) => void }): void;
	registerFlag(name: string, options: { description?: string; type: "string" | "boolean"; default?: string | boolean }): void;
	getFlag(name: string): string | boolean | undefined;
	registerTool(definition: unknown): void;
	registerCommand?(name: string, definition: { description?: string; handler(args: string, ctx: CtxLike): unknown }): void;
	appendEntry(customType: string, data?: unknown): void;
	sendUserMessage(content: string, options?: { deliverAs?: string; waveId?: string }): void;
}

function readLatestCustom<T>(ctx: CtxLike, customType: string): T | undefined {
	let latest: T | undefined;
	for (const entry of ctx.sessionManager?.getBranch() ?? []) {
		if (entry.type === "custom" && entry.customType === customType && entry.data) latest = entry.data as T;
	}
	return latest;
}

function readPersistedBatches(ctx: CtxLike): PersistedRepositoryBatch[] {
	return (ctx.sessionManager?.getBranch() ?? [])
		.filter((entry) => entry.type === "custom" && entry.customType === BATCH_ENTRY && entry.data)
		.map((entry) => entry.data as PersistedRepositoryBatch);
}

function readPersisted(ctx: CtxLike): PersistedSelection | undefined {
	return readLatestCustom<PersistedSelection>(ctx, STATE_ENTRY);
}

function readPersistedComment(ctx: CtxLike): PersistedCommentResult | undefined {
	return readLatestCustom<PersistedCommentResult>(ctx, COMMENT_ENTRY);
}
export async function reconcileBlockedRepositoryClaim(
	claims: ResourceClaims,
	batch: PersistedRepositoryBatch,
	owner: string,
	resource: string,
	authoritative: () => Promise<"settled" | "unknown">,
): Promise<"settled" | "unknown"> {
	const wave = batch.waves[batch.currentWave];
	const resources = wave ? [`repo:${wave.repo.toLowerCase()}`, ...wave.items.map((item) => `item:${item.repo.toLowerCase()}#${item.id}`)] : [];
	if (!["blocked", "cancelled"].includes(batch.state) || !wave || owner !== `review:${batch.id}:${batch.currentWave}` || !resources.includes(resource.toLowerCase())) return "unknown";
	if (await authoritative() !== "settled") return "unknown";
	claims.markSettled(resource, owner);
	return "settled";
}
export function waveWorkersSettled(
	snapshot: { running: readonly { id: string; status: string }[]; recent: readonly { id: string; status: string }[] } | null | undefined,
	ids: readonly string[] | undefined,
	persisted?: Readonly<Record<string, "completed" | "failed" | "cancelled" | "canceled">>,
): boolean {
	if (!ids?.length) return false;
	const observed = new Map([...(snapshot?.running ?? []), ...(snapshot?.recent ?? [])].map((job) => [job.id, job]));
	return ids.every((id) => {
		const job = observed.get(id);
		if (job) return (job.status === "completed" || job.status === "failed" || job.status === "cancelled" || job.status === "canceled") && !(snapshot?.running ?? []).some((running) => running.id === id);
		const status = persisted?.[id];
		return status === "completed" || status === "failed" || status === "cancelled" || status === "canceled";
	});
}
export function captureWaveJobIds(
	snapshot: { running: readonly { id: string }[]; recent: readonly { id: string }[] } | null | undefined,
	baseline: readonly string[] | undefined,
): string[] {
	if (!snapshot) return [];
	const excluded = new Set(baseline ?? []);
	return [...snapshot.running, ...snapshot.recent]
		.map((job) => job.id)
		.filter((id, index, all) => !excluded.has(id) && all.indexOf(id) === index)
		.sort();
}
export function waveWorkerCoverageComplete(jobIds: readonly string[] | undefined, toolCallIds: readonly string[] | undefined, workers?: PersistedRepositoryBatch["waveTaskWorkers"]): boolean {
	if (!jobIds?.length || !toolCallIds?.length || !workers) return false;
	if (Object.keys(workers).length !== toolCallIds.length) return false;
	const mapped: string[] = [];
	const agents: string[] = [];
	for (const call of toolCallIds) {
		if (!workers[call]?.length) return false;
		for (const worker of workers[call]) {
			if (!worker.jobId) return false;
			mapped.push(worker.jobId);
			agents.push(worker.agentId);
		}
	}
	return new Set(agents).size === agents.length && new Set(mapped).size === mapped.length
		&& JSON.stringify([...mapped].sort()) === JSON.stringify([...jobIds].sort());
}


/**
 * Open a pull request or issue in the local browser (PR Reader `o`).
 *
 * The reader header already shows the URL, so a failure to find a browser is
 * not catastrophic: the shortcut is best-effort and never silently blocks.
 */
/** Slay, autoslay, and fix may change pull-request heads; PR slay may also land reviewed heads. */
export function isImplementationAction(action: DashboardAction): boolean {
	return action.kind === "fix" || action.kind === "slay" || action.kind === "autoslay";
}
/**
 * Prompts the action keys send. Each one names the evidence the agent must use.
 *
 * When Hive ranked the item, the prompt says so and names the queued work it
 * serves: the point of running this tool against an orchestrated project is that
 * the review contributes to what the project decided matters, and an agent that
 * is not told the link cannot honor it.
 */
export function actionPrompt(
	action: DashboardAction,
	priority?: Priority,
	options?: { workbenchMode?: WorkbenchMode },
): string | undefined {
	if (
		action.kind === "close"
		|| action.kind === "scope"
		|| action.kind === "comment"
		|| action.kind === "reference"
		|| action.kind === "autoslay"
	) return undefined;

	const selected = action.items && action.items.length > 0 ? action.items : [action.item];
	const reviewerAgent = "reviewer";
	const toolPrefix = options?.workbenchMode === "hive" ? "hive" : "review";
	const traceTool = `${toolPrefix}_workbench_trace`;
	const evidenceTool = selected.every((item) => item.type === "issue")
		? toolPrefix === "review"
			? "review_workbench_issue"
			: "hive_workbench_diff"
		: `${toolPrefix}_workbench_diff`;
	const cite = (item: QueueItem) => `${item.repo}#${item.id} (${item.title})`;
	const stateOf = (item: QueueItem) => {
		const parts = [
			item.ciStatus ? `ci=${item.ciStatus}` : "",
			item.mergeState === "unknown" ? "" : `merge=${item.mergeState}`,
			item.reviewState === "unknown" ? "" : `review=${item.reviewState}`,
			item.draft ? "draft" : "",
		].filter(Boolean);
		return parts.length > 0 ? ` [queue read: ${parts.join(" ")} — revalidate live before mutating]` : "";
	};
	const authority = priority?.hiveRank === undefined
		? ""
		: `Hive ranked this work (${priority.reason}); preserve that intent. `;
	const allIssues = selected.every((item) => item.type === "issue");
	const allPullRequests = selected.every((item) => item.type === "pr");
	if (action.kind === "slay" && !allIssues && !allPullRequests) return undefined;
	const repairWave = allPullRequests && priority?.category === "repair-requested";
	const evidence = `Evidence is bounded and read once. Start with \`${evidenceTool}\` using both \`pull_request\` and explicit \`repo\`; child agents do not inherit the coordinator's selected repository. Use \`gh pr diff <n> --repo <r> --name-only\` only to confirm filenames, inspect only relevant hunks or failing logs, and cite file:line evidence. Never sleep or poll. Never assume a checkout exists. Check a repository-specific validator once; if the minimal appliance lacks that toolchain, use hosted check evidence and report the local verification gap instead of installing packages or retrying the absent command. Treat \`merge=dirty\` as repair work: merge the base into the branch, resolve deliberately, and never rebase, force-push, or choose \`--ours\`/\`--theirs\` wholesale. Revalidate live state before any comment, label, assignment, close, push, approval, or merge.`;
	const reviewFinish = "Report one terminal outcome per item, then stop. The workbench owns the next repository wave. Never approve or merge.";
	const slayContinuation = "Review Slay coordinator ownership persists through the selected lifecycle's declared terminal condition. Review completion, a fixer return, a push, green checks, or knowing the next action is progress, not completion. Continue already-authorized in-scope work without asking for confirmation already supplied by the objective; authorized actions need no second confirmation, while new scope or effects still require authority. A partial status report is not terminal. If one lane is blocked, finish independent authorized work before reporting that lane's exact blocker and evidence. Stop only when the requested terminal outcome is satisfied and verified, a concrete external blocker prevents further authorized progress, or continuing requires authority or scope the operator did not grant. Existing live GitHub policy, permissions, exact-head checks, holds, self-review rules, and mutation guards still bind terminal conditions. Workers remain bounded and return to the coordinator.";
	const slayFinish = `The maintainer's slay action authorizes review, repair, and landing for exactly these pull requests and their captured heads. Review each head with a fresh ${reviewerAgent}. If it has findings, dispatch one fresh isolated fixer with the exact repository, pull-request number, and head. Fixers use \`gh repo clone\` and \`gh pr checkout\` under \`$HOME/worktrees\`; never assume the working directory is a checkout, clone into \`/tmp/\`, or assume a fork branch exists on the base remote. Push without force, read the new head, and run a fresh review of that head. Before landing, re-read the live head, base, labels, reviews, checks, mergeability, and effective rules via \`gh api repos/<owner>/<repo>/rules/branches/<branch>\`. The reviewed head must equal the live head. Submit the current maintainer's approval only for a clean PR they did not author; never fabricate reviewers or a fixed approval threshold. Then run \`gh pr merge <n> --repo <r> --auto --squash\`; GitHub rules remain authoritative and may leave it queued or blocked on additional required human reviews. If GitHub says the merge queue owns the strategy, its effective squash rule wins: do not disable and re-arm auto-merge because \`autoMergeRequest.mergeMethod\` says \`MERGE\`. An accepted auto-merge request is terminal for this wave: report the outstanding approval gate and move on. Never use \`--admin\`, remove holds, weaken protections, or force-push. Report one terminal outcome per item, then stop. The workbench owns the next repository wave.`;
	const repairFinish = "These pull requests were returned to their authenticated author with requested changes. Read the review threads and failing checks, diagnose every requested correction, then dispatch one fresh isolated fixer per pull request. Fixers use `gh repo clone` and `gh pr checkout` under `$HOME/worktrees`, make the smallest complete correction, run focused verification, and push a new head without force. Never review, approve, auto-merge, or merge the author's own pull request. A repair is terminal only after GitHub shows a new head SHA. Report the pushed head and pull-request URL for every item, then stop; the workbench owns the next repository wave.";
	const issueContext = options?.workbenchMode === "hive"
		? "Inspect the complete issue description and the supplied Hive queue and knowledge evidence before deciding how to implement it."
		: "Inspect the complete GitHub issue description before deciding how to implement it.";
	const issueEvidence = `Evidence is bounded and read once. ${issueContext} Never assume the working directory is a checkout: use \`gh repo clone <owner/repo> $HOME/worktrees/<owner>-<repo>-issue-<number>\` to materialize one unique workspace per issue under \`$HOME/worktrees\`, then enter that checkout before examining relevant source files and tests. Never clone into \`/tmp\`. Cite file:line evidence, never sleep or poll, diagnose the root cause, make the smallest complete change, run focused verification, and open a review-ready pull request whose body contains \`Closes <owner/repo>#<number>\`. Never merge or approve your own pull request.`;
	const issueWorkflow = options?.workbenchMode === "hive"
		? "Before dispatching, call `hive_workbench_lookup` with target `queue` and then target `knowledge`. Match every issue key to Hive's entry and include the relevant queue and knowledge evidence in that worker's prompt; report unavailable Hive evidence instead of inventing it. Use the `task` tool once with one fresh item per issue through OMP workflowz. Each worker must use the unique checkout named in its prompt; do not share a checkout or conversation between items."
		: "Use the `task` tool once with one fresh item per issue through OMP workflowz. Each worker must use the unique checkout named in its prompt; do not share a checkout or conversation between items.";
	const issueInspectSource = toolPrefix === "review"
		? "Call `review_workbench_issue` with explicit `issue` and `repo` to read the complete issue body, discussion, and linked pull requests."
		: "Read the complete issue body and discussion with `gh issue view <n> --repo <r> --comments`, and list the pull requests linked to it.";
	const issueInspectEvidence = `Evidence is bounded and read once. ${issueInspectSource} Inspect only the relevant source files, citing file:line evidence. Do not call pull-request diff tools for an issue. Never sleep or poll. Never assume a checkout exists. Report the request, its current state, and concrete risks.`;

	if (selected.length > 1) {
		const repository = selected[0]!.repo;
		if (selected.some((item) => item.repo !== repository)) return undefined;
		const list = selected.map((item) => `- ${cite(item)}: ${item.url}${stateOf(item)}`).join("\n");
		const reviewRules = `<<<SUBAGENT-RULES\n${evidence} ${reviewFinish}\nSUBAGENT-RULES>>>`;
		const slayRules = `<<<SUBAGENT-RULES\n${evidence} ${slayFinish}\nSUBAGENT-RULES>>>`;
		const repairRules = `<<<SUBAGENT-RULES\n${evidence} ${repairFinish}\nSUBAGENT-RULES>>>`;
		const issueRules = `<<<SUBAGENT-RULES\n${issueEvidence} ${reviewFinish}\nSUBAGENT-RULES>>>`;
		const issueInspectRules = `<<<SUBAGENT-RULES\n${issueInspectEvidence} ${reviewFinish}\nSUBAGENT-RULES>>>`;
		switch (action.kind) {
			case "slay":
				if (allIssues) {
					return `Implement this issue wave for ${repository}, opening one review-ready pull request per issue:\n\n${list}\n\n${slayContinuation} ${issueWorkflow} Copy this block verbatim into every worker prompt:\n${issueRules}`;
				}
				if (repairWave) {
					return `Repair this returned pull-request wave for ${repository}:\n\n${list}\n\nUse the \`task\` tool once with one fresh isolated fixer per pull request through OMP workflowz. Do not share a checkout or conversation between items. Copy this block verbatim into every worker prompt:\n${repairRules}`;
				}
				return `Slay this repository wave for ${repository} through review, repair, and landing:\n\n${list}\n\n${slayContinuation} Use the \`task\` tool once with one fresh reviewer item per pull request through OMP workflowz. Do not use eval workpool: its generated boolean output schema is rejected by the current Copilot provider. Keep repair agents isolated, and never reuse a reviewer for the post-fix head. Coordinate the complete lifecycle after the review workers return. Copy this block verbatim into every worker prompt:\n${slayRules}`;
			case "diff":
				return allIssues
					? `Inspect this issue wave for ${repository}:\n\n${list}\n\nUse the \`task\` tool once with one fresh item per issue through OMP workflowz. Do not reuse a worker across repositories. Read each issue's body, discussion, and linked pull requests, and report the request, its current state, and concrete risks. Copy this block verbatim into every worker prompt:\n${issueInspectRules}`
					: `Inspect this repository wave for ${repository}:\n\n${list}\n\nUse the \`task\` tool once with one fresh item per issue or pull request through OMP workflowz. Do not reuse a worker across repositories. Use ${evidenceTool} and report the object evidence and concrete risks. Copy this block verbatim into every worker prompt:\n${reviewRules}`;
			case "fix":
				return allIssues
					? `Implement this repository wave for ${repository}, opening one review-ready pull request per issue:\n\n${list}\n\nUse the \`task\` tool once with one fresh item per issue through OMP workflowz. Each worker must use its unique checkout under \`$HOME/worktrees\`; do not share a checkout or conversation between write-capable items. Diagnose each root cause, implement the smallest complete fix, and run focused verification. Copy this block verbatim into every worker prompt:\n${issueRules}`
					: `Fix this repository wave for ${repository}:\n\n${list}\n\nUse the \`task\` tool once with one fresh item per issue or pull request through OMP workflowz. Each worker must use its unique checkout under \`$HOME/worktrees\`; do not share a checkout or conversation between write-capable items. Address findings at source, run focused verification, and push repaired heads for independent review. Copy this block verbatim into every worker prompt:\n${reviewRules}`;
		}
	}

	const item = selected[0]!;
	const workflow = action.kind === "fix"
		? "Use the OMP workflowz `task` tool with one fresh item for this target."
		: action.kind === "slay"
			? repairWave || allIssues
				? "Use the OMP workflowz `task` tool with one fresh implementation item for this target."
				: `Use the OMP workflowz \`task\` tool with one fresh ${reviewerAgent} item for this target; do not use eval workpool.`
			: "Use the OMP workflowz `task` tool with one fresh item for this target.";
	switch (action.kind) {
		case "review":
			return `Review ${cite(action.item)}. Read bounded diffs and recorded pipelines before judging. Report findings by severity with file:line evidence, covering correctness, security, tests, and simplicity. State explicitly what you verified and what you could not. ${authority} ${reviewFinish}`;
		case "slay":
			if (allIssues) {
				return `Implement ${cite(item)} as an issue. ${slayContinuation} ${issueWorkflow} ${authority} ${issueEvidence} ${reviewFinish}`;
			}
			if (repairWave) {
				return `Repair ${cite(item)} after requested changes. Use ${evidenceTool} and read the review threads, then push a corrected head. ${workflow} ${authority} ${repairFinish}`;
			}
			return `Slay ${cite(item)} through review, repair, and landing. ${slayContinuation} Use ${evidenceTool} and ${traceTool}, then run the complete lifecycle with fresh review and isolated fix agents. ${workflow} ${authority} ${slayFinish}`;
		case "diff":
			return item.type === "issue"
				? `Inspect ${cite(item)} as an issue. ${issueInspectEvidence.replace("<n>", String(item.id)).replace("<r>", item.repo)} ${workflow} ${authority} ${reviewFinish}`
				: `Call ${evidenceTool} for ${cite(item)} and summarize the changed files and concrete risks. ${workflow} ${authority} ${reviewFinish}`;
		case "fix":
			return item.type === "issue"
				? `Implement ${cite(item)}. ${issueWorkflow} ${authority} ${issueEvidence} ${reviewFinish}`
				: `Fix ${cite(item)} in an isolated workspace. Re-read the live diff and failing checks, diagnose each root cause, run focused verification, and push one clean commit for independent review. ${workflow} ${authority} ${reviewFinish}`;
		case "request_reviewer":
			return `Request review on ${cite(action.item)} from repository collaborators. Use \`gh pr edit ${action.item.id} --repo ${action.item.repo} --add-reviewer <reviewer>\` to assign reviewers and prioritize in their maintainer queue.`;
	}
}

/**
 * What the caller keeps after wiring the mode into a host.
 *
 * `session_start` returns before its own work is finished, so "the session has
 * started" and "the queue is on screen" are two different moments. Anything that
 * needs the second one — a test, a headless caller — awaits this.
 */
export interface ReviewExtension {
	whenStarted(): Promise<void>;
}

export function createReviewExtension(pi: ReviewExtensionHost, options: ExtensionOptions = {}): ReviewExtension {
	const env = options.env ?? process.env;
	const policy = options.policy ?? GENERIC_WORKBENCH_POLICY;
	const matchKey = options.matchKey;
	const configuredScope = options.org
		? orgScope(options.org)
		: parseScope(env.REVIEW_DEFAULT_SCOPE ?? (env.BLUEFIN_REVIEW_ORG ? `org:${env.BLUEFIN_REVIEW_ORG}` : ""), "");
	const mode = new ReviewMode({
		org: options.org ?? (configuredScope?.kind === "org" ? configuredScope.value : ""),
		scope: configuredScope ?? orgScope(""),
		fetchImpl: options.fetchImpl,
		env,
		policy,
	});
	const statusKey = mode.isReviewMode() ? "review_workbench" : "hive_workbench";

	let tui: { requestRender(): void } | undefined;
	const timers: Array<() => void> = [];
	let dashboardOpen = false;
	let activeDashboard: ReviewDashboard | undefined;
	let activeCtx: CtxLike | undefined;
	let started: Promise<void> = Promise.resolve();
	const recoveryBatches = new Map<string, PersistedRepositoryBatch>();
	let activeBatch: PersistedRepositoryBatch | undefined;
	let batchRequestGeneration = 0;
	let commentInFlight = false;
	pi.setLabel(mode.isReviewMode() ? "Review Workbench" : "Hive Workbench");
	pi.registerFlag("pr", { description: "Preselect a pull request or issue number", type: "string" });
	pi.registerFlag("issues", { description: "Start in issues mode instead of pull requests", type: "boolean", default: false });
	pi.registerFlag("all", { description: "Show all queue items instead of filtering to Hive-assigned work", type: "boolean", default: false });
	pi.registerFlag("repo", { description: "Review one repository: owner/repo, or org:name for a whole organization", type: "string" });
	pi.registerFlag("skip-repo", { description: "Comma-separated repositories to skip", type: "string" });
	pi.registerFlag("autoslay", { description: "Slay the selected or visible queue", type: "boolean", default: false });
	registerTools(pi as unknown as ToolHost, mode, () => started);
	const unregisterFactorySelection = registerFactorySelection((action) => mode.factorySelection(action));
	let claims: ResourceClaims | undefined;
	const resourceClaims = () => claims ??= new ResourceClaims(factoryStateRoot(env), factoryClaimsRoot(env));
	const resourcesForBatch = (batch: PersistedRepositoryBatch): string[] => {
		const wave = batch.waves[batch.currentWave];
		if (!wave || batch.kind === "diff") return [];
		return [...new Set(wave.items.flatMap((item) => [
			`repo:${item.repo.toLowerCase()}`,
			`item:${item.repo.toLowerCase()}#${item.id}`,
		]))].sort();
	};
	const expectedIssueSubmission = (
		batch: PersistedRepositoryBatch,
		item: QueueItem,
		current: QueueItem,
	): string[] | undefined => {
		const key = `${item.repo.toLowerCase()}#${item.id}`;
		const baseline = batch.issueSubmittedPrs?.[key] ?? item.submittedPrs ?? [];
		const currentPrs = current.submittedPrs ?? [];
		const delta = currentPrs.filter((submittedPr) => !baseline.includes(submittedPr));
		return delta.length === 1 ? delta : undefined;
	};
	const rememberRecoveryBatch = (batch: PersistedRepositoryBatch): void => {
		if (batch.state === "blocked" || batch.state === "cancelled") recoveryBatches.set(batch.id, batch);
		else recoveryBatches.delete(batch.id);
	};
	const restoreClaimWaves = (): string[] => {
		const missing: string[] = [];
		for (const owner of new Set(resourceClaims().list().filter((claim) => claim.owner.startsWith("review:")).map((claim) => claim.owner))) {
			if (activeBatch && owner === `review:${activeBatch.id}:${activeBatch.currentWave}`) continue;
			const stored = loadWave(factoryClaimsRoot(env), owner);
			if (stored) rememberRecoveryBatch({ ...stored, state: stored.state === "cancelled" ? "cancelled" : "blocked" });
			else if (!batchForOwner(owner)) missing.push(owner);
		}
		return missing;
	};
	const batchForOwner = (owner: string): PersistedRepositoryBatch | undefined => {
		const candidates = [activeBatch, ...recoveryBatches.values()].filter(
			(batch): batch is PersistedRepositoryBatch => batch !== undefined,
		);
		return candidates.find((batch) => owner === `review:${batch.id}:${batch.currentWave}`);
	};
	const claimItems = (items: readonly QueueItem[], owner: string, allowExisting = true): void => {
		const resources = [...new Set(items.flatMap((item) => [`repo:${item.repo.toLowerCase()}`, `item:${item.repo.toLowerCase()}#${item.id}`]))];
		const acquired: string[] = [];
		try { for (const resource of resources) { resourceClaims().claim(resource, owner, allowExisting); acquired.push(resource); } }
		catch (error) { for (const resource of acquired) resourceClaims().release(resource, owner); throw error; }
	};
	const releaseItems = (items: readonly QueueItem[], owner: string): void => {
		for (const item of items) {
			const claimsForItem = resourceClaims();
			claimsForItem.markSettled(`item:${item.repo.toLowerCase()}#${item.id}`, owner);
			claimsForItem.markSettled(`repo:${item.repo.toLowerCase()}`, owner);
			claimsForItem.release(`item:${item.repo.toLowerCase()}#${item.id}`, owner);
			claimsForItem.release(`repo:${item.repo.toLowerCase()}`, owner);
		}
	};
	const reconcileMutationClaim = async (owner: string, resource: string): Promise<"settled" | "unknown"> => {
		const batch = batchForOwner(owner);
		const ctx = activeCtx;
		if (!batch || !ctx || !batch.waves[batch.currentWave]) return "unknown";
		return reconcileBlockedRepositoryClaim(
			resourceClaims(),
			batch,
			owner,
			resource,
			() => authoritativeReconcile(ctx, batch, resource),
		);
	};
	const unregisterFactoryReconciler = registerFactoryReconciler(reconcileMutationClaim);

	const repaint = () => tui?.requestRender();

	const syncStatus = (ctx: CtxLike) => {
		if (!ctx.hasUI) return;
		const painter = workbenchPainter(ctx.ui.theme, () => mode.queueMode);
		if (dashboardOpen) ctx.ui.setStatus(statusKey, undefined);
		else ctx.ui.setStatus(statusKey, statusSegment(mode, painter, Date.now()));
		const activeItem = mode.selected();
		if (activeItem) {
			const kind = activeItem.type === "pr" ? "PR" : "ISSUE";
			const repo = activeItem.repo.includes("/") ? activeItem.repo.split("/")[1] : activeItem.repo;
			ctx.ui.setTitle(`${mode.isReviewMode() ? "review workbench" : "hive workbench"} · ${kind} #${activeItem.id} (${repo}) ${activeItem.title}`);
		} else {
			ctx.ui.setTitle(`${mode.isReviewMode() ? "review workbench" : "hive workbench"} · ${mode.queueMode} (${mode.position()})`);
		}
		repaint();
	};
	const authoritativeReconcile = async (
		ctx: CtxLike,
		batch: PersistedRepositoryBatch,
		resource: string,
	): Promise<"settled" | "unknown"> => {
		const wave = batch.waves[batch.currentWave];
		const expectedResources = resourcesForBatch(batch);
		if (
			!["blocked", "cancelled"].includes(batch.state)
			|| !wave
			|| !batch.waveEffectResources
			|| JSON.stringify(batch.waveEffectResources) !== JSON.stringify(expectedResources)
			|| !waveWorkerCoverageComplete(batch.waveJobIds, batch.waveToolCallIds, batch.waveTaskWorkers)
			|| !expectedResources.includes(resource.toLowerCase())
		) return "unknown";
		const jobs = ctx.getAsyncJobSnapshot?.();
		if (!waveWorkersSettled(jobs, batch.waveJobIds, batch.waveTerminalJobStatuses)) return "unknown";
		if (batch.kind === "diff") return "settled";

		const targetItems = resource.toLowerCase().startsWith("repo:")
			? wave.items
			: wave.items.filter((item) => `item:${item.repo.toLowerCase()}#${item.id}` === resource.toLowerCase());
		if (targetItems.length === 0) return "unknown";
		for (const type of ["pr", "issue"] as const) {
			const items = targetItems.filter((item) => item.type === type);
			if (items.length === 0) continue;
			const live = await fetchItemsByKey(
				items.map((item) => `${item.repo}#${item.id}`),
				type === "pr" ? "prs" : "issues",
				mode.tokenOptions(),
			);
			if (live.error) return "unknown";
			for (const item of items) {
				const current = live.items.find((candidate) => candidate.repo === item.repo && candidate.id === item.id);
				if (!current) return "unknown";
				if (
					type === "pr"
					&& (current.headSha !== item.headSha
						|| current.autoMergeEnabled !== item.autoMergeEnabled
						|| current.reviewState !== item.reviewState)
				) return "unknown";
				if (type === "issue" && batch.kind === "slay" && expectedIssueSubmission(batch, item, current) === undefined) return "unknown";
			}
		}
		return "settled";
	};

	const every = (intervalMs: number, work: () => void) => {
		const handle = setInterval(() => {
			try {
				work();
			} catch {
				// Extensions share the session process; a throw from a timer is fatal.
			}
		}, intervalMs);
		(handle as { unref?(): void }).unref?.();
		timers.push(() => clearInterval(handle));
	};

	const refreshQueue = async (ctx: CtxLike) => {
		syncStatus(ctx);
		const result = await mode.refreshQueue();
		if (result.error && !result.cancelled && result.items.length === 0 && ctx.hasUI) {
			ctx.ui.notify(`${mode.isReviewMode() ? "Review" : "Hive"} workbench queue: ${result.error}`, "error");
		}
		syncStatus(ctx);
		return result;
	};

	const persist = () => pi.appendEntry(STATE_ENTRY, mode.toPersisted());

	const syncBatchProgress = (ctx: CtxLike) => {
		if (!activeBatch) {
			mode.setBatchProgress(undefined);
			return;
		}
		const wave = activeBatch.waves[Math.min(activeBatch.currentWave, activeBatch.waves.length - 1)];
		const jobs = ctx.getAsyncJobSnapshot?.();
		const runningJobs = jobs?.running.filter((job) => job.startTime >= activeBatch!.waveStartedAt).length ?? 0;
		const failedJobs = jobs?.recent.filter(
			(job) => job.startTime >= activeBatch!.waveStartedAt && job.status === "failed",
		).length ?? 0;
		mode.setBatchProgress({
			state: activeBatch.state,
			repository: wave?.repo ?? "complete",
			wave: Math.min(activeBatch.currentWave + 1, activeBatch.waves.length),
			waves: activeBatch.waves.length,
			completedItems: activeBatch.completedItems,
			totalItems: activeBatch.totalItems,
			runningJobs,
			failedJobs,
		});
		repaint();
	};
	const rememberWaveEvidence = (ctx: CtxLike): void => {
		if (!activeBatch || !["running", "paused", "blocked"].includes(activeBatch.state) || !activeBatch.waveIdentity) return;
		const jobs = ctx.getAsyncJobSnapshot?.();
		if (!jobs) return;
		const baseline = new Set(activeBatch.waveJobBaselineIds ?? []);
		const observed = [...jobs.running, ...jobs.recent];
		const workers = Object.fromEntries(Object.entries(activeBatch.waveTaskWorkers ?? {}).map(([call, workers]) => [call, workers.map((worker) => {
			if (worker.jobId) return worker;
			const matches = observed.filter((job) => job.type === "task" && job.agentId === worker.agentId && !baseline.has(job.id));
			return matches.length === 1 ? { ...worker, jobId: matches[0].id } : worker;
		})]));
		const mapped = new Set(Object.values(workers).flatMap((workers) => workers.flatMap((worker) => worker.jobId ? [worker.jobId] : [])));
		const associated = observed.filter((job) => mapped.has(job.id));
		const ids = [...new Set([...(activeBatch.waveJobIds ?? []), ...associated.map((job) => job.id)])].sort();
		const terminal = { ...(activeBatch.waveTerminalJobStatuses ?? {}) };
		const runningIds = new Set(jobs.running.map((job) => job.id));
		for (const id of runningIds) delete terminal[id];
		for (const job of associated) {
			if (!runningIds.has(job.id) && (job.status === "completed" || job.status === "failed" || job.status === "cancelled" || job.status === "canceled")) terminal[job.id] = job.status;
		}
		const wave = activeBatch.waves[activeBatch.currentWave];
		const resources = activeBatch.kind === "diff" || !wave
			? []
			: [...new Set(wave.items.flatMap((item) => [`repo:${item.repo.toLowerCase()}`, `item:${item.repo.toLowerCase()}#${item.id}`]))].sort();
		if (JSON.stringify(activeBatch.waveTaskWorkers ?? {}) === JSON.stringify(workers) && JSON.stringify(activeBatch.waveJobIds ?? []) === JSON.stringify(ids) && JSON.stringify(activeBatch.waveTerminalJobStatuses ?? {}) === JSON.stringify(terminal) && JSON.stringify(activeBatch.waveEffectResources ?? []) === JSON.stringify(resources)) return;
		persistBatch(ctx, { ...activeBatch, waveTaskWorkers: workers, waveJobIds: ids, waveTerminalJobStatuses: terminal, waveEffectResources: resources });
	};
	// OMP 18.3 task results identify each spawned agent in progress; snapshots
	// expose the actual job id, including the manager's collision suffix.
	const rememberTaskResult = (ctx: CtxLike, call: string, result: unknown): void => {
		if (!activeBatch?.waveToolCallIds?.includes(call) || !result || typeof result !== "object" || !("details" in result)) return;
		const details = result.details;
		if (!details || typeof details !== "object" || !("async" in details) || !details.async || typeof details.async !== "object" || !("type" in details.async) || details.async.type !== "task" || !("progress" in details) || !Array.isArray(details.progress)) return;
		const workers: { agentId: string; jobId?: string; resultStatus?: "completed" | "failed" | "cancelled" }[] = [];
		for (const row of details.progress) {
			if (!row || typeof row !== "object" || typeof row.id !== "string" || !row.id) return;
			workers.push({ agentId: row.id, ...(row.status === "completed" || row.status === "failed" ? { resultStatus: row.status } : row.status === "aborted" ? { resultStatus: "cancelled" } : {}) });
		}
		const previous = activeBatch.waveTaskWorkers?.[call];
		if (previous && JSON.stringify(previous.map((worker) => worker.agentId)) !== JSON.stringify(workers.map((worker) => worker.agentId))) {
			persistBatch(ctx, { ...activeBatch, waveTaskWorkers: { ...activeBatch.waveTaskWorkers, [call]: [] } });
			return;
		}
		const updated = workers.map((worker, index) => ({ ...previous?.[index], ...worker }));
		if (JSON.stringify(previous) !== JSON.stringify(updated)) persistBatch(ctx, { ...activeBatch, waveTaskWorkers: { ...activeBatch.waveTaskWorkers, [call]: updated } });
		rememberWaveEvidence(ctx);
	};
	const rememberDeliveredJobs = (event: unknown, ctx: CtxLike): void => {
		if (!activeBatch || !event || typeof event !== "object" || !("message" in event)) return;
		const message = event.message;
		if (!message || typeof message !== "object" || !("customType" in message) || message.customType !== "async-result" || !("details" in message)) return;
		const details = message.details;
		if (!details || typeof details !== "object" || !("jobs" in details) || !Array.isArray(details.jobs)) return;
		const delivered = new Set(details.jobs.filter((job) => job?.type === "task" && typeof job.jobId === "string").map((job) => job.jobId));
		const terminal = { ...activeBatch.waveTerminalJobStatuses };
		// Task progress alone is provisional. OMP's delivery proves the job has
		// settled, including jobs omitted by the five-row recent snapshot limit.
		for (const worker of Object.values(activeBatch.waveTaskWorkers ?? {}).flat()) {
			if (worker.jobId && worker.resultStatus && delivered.has(worker.jobId) && !terminal[worker.jobId]) terminal[worker.jobId] = worker.resultStatus;
		}
		if (JSON.stringify(terminal) !== JSON.stringify(activeBatch.waveTerminalJobStatuses ?? {})) persistBatch(ctx, { ...activeBatch, waveTerminalJobStatuses: terminal });
	};

	const persistBatch = (ctx: CtxLike, batch: PersistedRepositoryBatch) => {
		saveWave(factoryClaimsRoot(env), batch);
		activeBatch = batch;
		rememberRecoveryBatch(batch);
		pi.appendEntry(BATCH_ENTRY, batch);
		syncBatchProgress(ctx);
	};

	const observedSubmittedPrs = async (ctx: CtxLike, batch: PersistedRepositoryBatch): Promise<string[]> => {
		const wave = batch.waves[batch.currentWave];
		const issues = wave?.items.filter((item) => item.type === "issue") ?? [];
		if (issues.length === 0) return [];
		const live = await fetchItemsByKey(
			issues.map((item) => `${item.repo}#${item.id}`),
			"issues",
			mode.tokenOptions(),
		);
		if (live.error) return [];
		const refs: string[] = [];
		for (const item of issues) {
			const current = live.items.find((candidate) => candidate.repo === item.repo && candidate.id === item.id);
			const submission = current ? expectedIssueSubmission(batch, item, current) : undefined;
			if (submission) refs.push(...submission);
		}
		return [...new Set(refs)].sort();
	};

	const reconcileBatchClaims = async (ctx: CtxLike, batch: PersistedRepositoryBatch) => {
		const owner = `review:${batch.id}:${batch.currentWave}`;
		const settled: string[] = [];
		const unknown: string[] = [];
		for (const resource of resourcesForBatch(batch)) {
			if (resourceClaims().conflict(resource, owner)) {
				unknown.push(resource);
				continue;
			}
			const result = await reconcileBlockedRepositoryClaim(
				resourceClaims(),
				batch,
				owner,
				resource,
				() => authoritativeReconcile(ctx, batch, resource),
			);
			if (result === "settled") {
				resourceClaims().reconcile(resource, owner);
				settled.push(resource);
			} else {
				unknown.push(resource);
			}
		}
		return {
			settled,
			unknown,
			submittedPrs: settled.length > 0 ? await observedSubmittedPrs(ctx, batch) : [],
		};
	};

	const finishRecoveredBatch = async (
		ctx: CtxLike,
		batch: PersistedRepositoryBatch,
		result: { settled: string[]; unknown: string[]; submittedPrs: string[] },
	): Promise<void> => {
		if (result.unknown.length > 0 || activeBatch?.id !== batch.id) return;
		const nextWave = batch.currentWave + 1;
		const completedItems = batch.completedItems + (batch.waves[batch.currentWave]?.items.length ?? 0);
		const evidence = result.submittedPrs.length > 0
			? `; observed submitted PRs ${result.submittedPrs.join(", ")}`
			: "";
		if (nextWave >= batch.waves.length) {
			persistBatch(ctx, {
				...batch,
				currentWave: nextWave,
				completedItems,
				state: "complete",
				waveIdentity: undefined,
				waveToolCallIds: undefined,
				waveTaskWorkers: undefined,
				waveJobBaselineIds: undefined,
				waveJobIds: undefined,
				waveTerminalJobStatuses: undefined,
				waveEffectResources: undefined,
			});
			if (ctx.hasUI) ctx.ui.notify(`Recovered ${batch.id} without replaying its external effect${evidence}`, "info");
			return;
		}
		persistBatch(ctx, {
			...batch,
			currentWave: nextWave,
			completedItems,
			state: mode.paused ? "paused" : "running",
			waveStartedAt: Date.now(),
			waveIdentity: undefined,
			waveToolCallIds: undefined,
			waveTaskWorkers: undefined,
			waveJobBaselineIds: undefined,
			waveJobIds: undefined,
			waveTerminalJobStatuses: undefined,
			waveEffectResources: undefined,
		});
		if (ctx.hasUI) ctx.ui.notify(`Recovered ${batch.id} without replaying its external effect${evidence}`, "info");
		if (!mode.paused) await dispatchCurrentWave(ctx, "followUp");
	};

	const archiveCancelledBatch = (
		ctx: CtxLike,
		batch: PersistedRepositoryBatch,
		action: "cancel" | "revise",
		result: { settled: string[]; unknown: string[]; submittedPrs: string[] },
	): string => {
		const evidence = result.submittedPrs.length > 0
			? `; observed submitted PRs ${result.submittedPrs.join(", ")}`
			: "";
		const message = result.unknown.length > 0
			? `${action === "revise" ? "Revision" : "Cancellation"} recorded for ${batch.id}; UNKNOWN claims remain fenced: ${result.unknown.join(", ")}${evidence}`
			: `${action === "revise" ? "Revision" : "Cancellation"} recorded for ${batch.id}; settled claims released${evidence}`;
		persistBatch(ctx, {
			...batch,
			state: "cancelled",
			error: message,
			cancelRequested: undefined,
		});
		activeBatch = undefined;
		mode.setBatchProgress(undefined);
		syncStatus(ctx);
		return message;
	};

	const drainCancelledBatch = async (ctx: CtxLike, batch: PersistedRepositoryBatch): Promise<void> => {
		const result = batch.waveIdentity
			? await reconcileBatchClaims(ctx, batch)
			: { settled: [], unknown: [], submittedPrs: [] };
		const message = archiveCancelledBatch(ctx, batch, "cancel", result);
		if (ctx.hasUI) ctx.ui.notify(message, result.unknown.length > 0 ? "warning" : "info");
	};

	const cancelBlockedBatch = async (ctx: CtxLike, action: "cancel" | "revise"): Promise<string> => {
		const batch = activeBatch;
		if (!batch) return "No Review wave is active";
		if (batch.state === "running" || batch.state === "paused") {
			if (!batch.waveIdentity) {
				return archiveCancelledBatch(ctx, batch, action, { settled: [], unknown: [], submittedPrs: [] });
			}
			mode.setPaused(true);
			persistBatch(ctx, {
				...batch,
				state: "paused",
				cancelRequested: true,
				error: `Cancellation requested; waiting for ${batch.id} to drain`,
			});
			return `Cancellation requested for ${batch.id}; current work will drain before claims are reconciled`;
		}
		if (batch.state !== "blocked") return "No blocked Review wave is active";
		const workersSettled = !batch.waveIdentity
			|| waveWorkersSettled(ctx.getAsyncJobSnapshot?.(), batch.waveJobIds, batch.waveTerminalJobStatuses);
		if (!workersSettled) return `Run ${batch.id} still has an unaccounted worker; wait for it to drain before ${action}`;
		const result = batch.waveIdentity
			? await reconcileBatchClaims(ctx, batch)
			: { settled: [], unknown: [], submittedPrs: [] };
		return archiveCancelledBatch(ctx, batch, action, result);
	};

	const reviewCommand = async (rawArgs: string, ctx: CtxLike): Promise<string> => {
		const args = rawArgs.trim().toLowerCase();
		if (args === "slay" || args === "re-slay") {
			activeCtx = ctx;
			await startSlay(ctx, mode.slayableItems(BATCH_LIMIT));
			return "Review Slay requested";
		}
		if (args === "cancel" || args === "drain" || args === "revise") {
			return cancelBlockedBatch(ctx, args === "revise" ? "revise" : "cancel");
		}
		if (args === "reconcile" || args === "recover") {
			const missing = restoreClaimWaves();
			const candidates = [...new Map(
				[...recoveryBatches.values(), activeBatch]
					.filter((batch): batch is PersistedRepositoryBatch => batch !== undefined)
					.map((batch) => [batch.id, batch]),
			).values()];
			if (candidates.length === 0 && missing.length === 0) return "No interrupted or blocked Review waves need reconciliation";
			const lines: string[] = missing.map((owner) => `Retained UNKNOWN claims for ${owner}: missing or invalid durable recovery record; worker and external-effect evidence required`);
			for (const batch of candidates) {
				const result = await reconcileBatchClaims(ctx, batch);
				if (result.settled.length > 0) lines.push(`Reconciled ${result.settled.join(", ")} for ${batch.id}`);
				if (result.submittedPrs.length > 0) lines.push(`Observed submitted PRs ${result.submittedPrs.join(", ")}`);
				if (result.unknown.length > 0) lines.push(`Retained UNKNOWN claims ${result.unknown.join(", ")} for ${batch.id}`);
				if (activeBatch?.id === batch.id && result.unknown.length === 0) await finishRecoveredBatch(ctx, batch, result);
				else if (result.unknown.length === 0 && result.settled.length > 0) {
					recoveryBatches.delete(batch.id);
					const currentWave = batch.currentWave + 1;
					pi.appendEntry(BATCH_ENTRY, { ...batch, currentWave, completedItems: batch.completedItems + batch.waves[batch.currentWave].items.length, state: currentWave === batch.waves.length ? "complete" : "paused", waveIdentity: undefined });
				}
			}
			return lines.length > 0 ? lines.join("; ") : "No Review claims were released";
		}
		if (args === "" || args === "status") {
			restoreClaimWaves();
			const claims = resourceClaims().list().filter((claim) => claim.owner.startsWith("review:"));
			const batches = [...recoveryBatches.values()].map((batch) =>
				`${batch.id} ${batch.state}${batch.error ? ` — ${batch.error}` : ""}`);
			return [
				activeBatch ? `Active Review wave: ${activeBatch.id} ${activeBatch.state}` : "No active Review wave",
				...batches,
				claims.length > 0
					? claims.map((claim) => `${claim.resource} is owned by ${claim.owner} [${claim.status}]`).join("\n")
					: "No Review mutation claims",
			].join("\n");
		}
		return "usage: /review status | reconcile | drain | cancel | revise | slay";
	};
	pi.registerCommand?.("review", {
		description: "Inspect or recover an interrupted Review repository wave",
		handler: async (args, ctx) => {
			try {
				const message = await reviewCommand(args, ctx);
				if (ctx.hasUI) ctx.ui.notify(message, /UNKNOWN|unaccounted|No blocked/.test(message) ? "warning" : "info");
			} catch (error) {
				if (ctx.hasUI) ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
			}
		},
	});

	const batchBlocker = async (kind: RepositoryBatchKind, items: readonly QueueItem[]): Promise<string | undefined> => {
		if (kind === "diff") return undefined;
		const allPullRequests = items.every((item) => item.type === "pr");
		const allIssues = items.every((item) => item.type === "issue");
		if (kind === "slay" && !allPullRequests && !allIssues) return "Slay waves must not mix pull requests and issues";

		if (kind === "slay" && allPullRequests) {
			for (const item of items) {
				const wasRepair = isRepairRequested(item, mode.currentUserLogin);
				if (!wasRepair && !policy.allowWorkflowSlay && (item.workflowFiles?.length ?? 0) > 0) {
					return `Cannot dispatch ${item.repo}#${item.id}: changes ${item.workflowFiles![0]}`;
				}
				if (!wasRepair && item.changedFilesComplete === false) {
					return `Cannot dispatch ${item.repo}#${item.id}: complete changed-file list unavailable`;
				}
			}
			const workflowPermission = await workflowPermissionBlocker(items);
			if (workflowPermission) return workflowPermission;
			const live = await fetchItemsByKey(
				items.map((item) => `${item.repo}#${item.id}`),
				"prs",
				mode.tokenOptions(),
			);
			if (live.error) return `Live pull-request check failed: ${live.error}`;
			for (const item of items) {
				const current = live.items.find((candidate) => candidate.repo === item.repo && candidate.id === item.id);
				if (!current) return `Cannot dispatch ${item.repo}#${item.id}: pull request is closed or unreadable`;
				if (!exactHeadVerified(item.headSha, current.headSha)) return `Cannot dispatch ${item.repo}#${item.id}: pull request head changed`;
				const wasRepair = isRepairRequested(item, mode.currentUserLogin);
				if (wasRepair !== isRepairRequested(current, mode.currentUserLogin)) {
					return `Cannot dispatch ${item.repo}#${item.id}: requested-changes state changed`;
				}
				if (current.changedFilesComplete !== true) {
					return `Cannot dispatch ${item.repo}#${item.id}: complete changed-file list unavailable`;
				}
				if (!wasRepair && (current.ciEvidenceComplete === false || current.ciStatus === undefined)) {
					return `Cannot dispatch ${item.repo}#${item.id}: CI state is incomplete or unknown`;
				}
				if (!wasRepair && (current.ciStatus === "failure" || current.ciStatus === "pending")) {
					return `Cannot dispatch ${item.repo}#${item.id}: CI is ${current.ciStatus}`;
				}
			}
			for (const current of live.items) {
				const wasRepair = isRepairRequested(current, mode.currentUserLogin);
				if (!wasRepair && !policy.allowWorkflowSlay && (current.workflowFiles?.length ?? 0) > 0) {
					return `Cannot dispatch ${current.repo}#${current.id}: changes ${current.workflowFiles![0]}`;
				}
			}
			const liveWorkflowPermission = await workflowPermissionBlocker(live.items);
			if (liveWorkflowPermission) return liveWorkflowPermission;
			return undefined;
		}

		if (kind === "fix") {
			const pullRequests = items.filter((item): item is QueueItem & { type: "pr" } => item.type === "pr");
			let livePullRequests: QueueItem[] = [];
			if (pullRequests.length > 0) {
				const live = await fetchItemsByKey(
					pullRequests.map((item) => `${item.repo}#${item.id}`),
					"prs",
					mode.tokenOptions(),
				);
				if (live.error) return `Live pull-request check failed: ${live.error}`;
				for (const item of pullRequests) {
					const current = live.items.find((candidate) => candidate.repo === item.repo && candidate.id === item.id);
					if (!current) return `Cannot dispatch ${item.repo}#${item.id}: pull request is closed or unreadable`;
					if (!exactHeadVerified(item.headSha, current.headSha)) return `Cannot dispatch ${item.repo}#${item.id}: pull request head changed`;
					const wasRepair = isRepairRequested(item, mode.currentUserLogin);
					if (wasRepair !== isRepairRequested(current, mode.currentUserLogin)) {
						return `Cannot dispatch ${item.repo}#${item.id}: requested-changes state changed`;
					}
					if (current.changedFilesComplete !== true) {
						return `Cannot dispatch ${item.repo}#${item.id}: complete changed-file list unavailable`;
					}
				}
				livePullRequests = live.items;
				for (const item of pullRequests) {
					const current = livePullRequests.find((candidate) => candidate.repo === item.repo && candidate.id === item.id)!;
					const wasRepair = isRepairRequested(item, mode.currentUserLogin);
					if (!wasRepair && !policy.allowWorkflowSlay && (current.workflowFiles?.length ?? 0) > 0) {
						return `Cannot dispatch ${item.repo}#${item.id}: changes ${current.workflowFiles![0]}`;
					}
				}
			}
			const workflowPermission = await workflowPermissionBlocker(livePullRequests);
			if (workflowPermission) return workflowPermission;
		}

		if (kind === "slay" && allIssues) {
			const live = await fetchItemsByKey(
				items.map((item) => `${item.repo}#${item.id}`),
				"issues",
				mode.tokenOptions(),
			);
			if (live.error) return `Live issue check failed: ${live.error}`;
			for (const item of items) {
				const current = live.items.find((candidate) => candidate.repo === item.repo && candidate.id === item.id);
				if (!current) return `Cannot dispatch ${item.repo}#${item.id}: issue is closed or unreadable`;
				if ((current.submittedPrs?.length ?? 0) > 0) {
					return `Cannot dispatch ${item.repo}#${item.id}: pull request already submitted (${current.submittedPrs!.join(", ")})`;
				}
			}
		}

		const claimed = items.find((item) => mode.claimFor(item));
		if (claimed) return `${claimed.repo}#${claimed.id} is already claimed by ${mode.claimFor(claimed)}`;
		if (kind !== "fix" && !(kind === "slay" && allIssues)) return undefined;

		const managedIssues = items.filter((item) => item.type === "issue" && managedPolicyFor(item.repo, policy));
		if (managedIssues.length > 0) {
			const result = await fetchIssueAdmission(
				managedIssues.map((item) => {
					const [owner, repo] = item.repo.split("/") as [string, string];
					return { owner, repo, number: item.id };
				}),
				{ token: mode.tokenOptions().token ?? resolveToken(env), fetchImpl: options.fetchImpl },
			);
			if (result.error) return `Admission check failed: ${result.error}`;
			for (const admitted of result.issues) {
				const key = `${admitted.owner}/${admitted.repo}#${admitted.number}`;
				const admissionPolicy = managedPolicyFor(`${admitted.owner}/${admitted.repo}`, policy);
				if (!admissionPolicy) return `Cannot dispatch ${key}: no managed-repository policy`;
				if (admitted.closed) return `Cannot dispatch ${key}: issue is closed`;
				if (admitted.labelsTruncated) return `Cannot dispatch ${key}: incomplete label evidence`;
				for (const denied of admissionPolicy.deniedLabels) {
					if (admitted.labels.includes(denied)) return `Cannot dispatch ${key}: issue has ${denied} label`;
				}
				for (const required of admissionPolicy.requiredLabels) {
					if (!admitted.labels.includes(required)) return `Cannot dispatch ${key}: missing explicit admission label '${required}'`;
				}
			}
		}
		if (kind === "slay") return undefined;

		const managedPullRequests = items.filter((item) => item.type === "pr" && managedPolicyFor(item.repo, policy));
		if (managedPullRequests.length > 0) {
			const live = await fetchItemsByKey(
				managedPullRequests.map((item) => `${item.repo}#${item.id}`),
				"prs",
				mode.tokenOptions(),
			);
			if (live.error) return `Live pull-request check failed: ${live.error}`;
			const capturedHeads = new Map(managedPullRequests.map((item) => [`${item.repo}#${item.id}`, item.headSha]));
			mode.reconcileItems(live.items);
			for (const item of managedPullRequests) {
				const current = live.items.find((candidate) => candidate.repo === item.repo && candidate.id === item.id);
				if (!current) return `Cannot dispatch ${item.repo}#${item.id}: pull request is closed or unreadable`;
				if (!exactHeadVerified(item.headSha, current.headSha)) return `Cannot dispatch ${item.repo}#${item.id}: pull request head changed`;
				const denied = managedPolicyFor(item.repo, policy)?.deniedLabels.find((label) => current.labels.includes(label));
				if (denied) return `Cannot dispatch ${item.repo}#${item.id}: pull request has ${denied} label`;
			}
		}
		return undefined;
	};

	const dispatchCurrentWave = async (ctx: CtxLike, deliverAs?: "steer" | "followUp", prevalidated = false) => {
		if (!activeBatch) return;
		if (mode.paused) {
			persistBatch(ctx, { ...activeBatch, state: "paused" });
			return;
		}
		const wave = activeBatch.waves[activeBatch.currentWave];
		if (!wave) {
			persistBatch(ctx, { ...activeBatch, state: "complete" });
			ctx.ui.notify(activeBatch.kind === "slay" ? "Slay complete" : "Repository run complete", "info");
			return;
		}
		if (!prevalidated) {
			const blocker = await batchBlocker(activeBatch.kind, wave.items);
			if (blocker) {
				persistBatch(ctx, { ...activeBatch, state: "blocked", error: blocker });
				ctx.ui.notify(blocker, "error");
				return;
			}
		}
		const retryingBlockedWave = activeBatch.state === "blocked";
		const startedAt = Date.now();
		persistBatch(ctx, { ...activeBatch, state: "running", waveStartedAt: startedAt, error: undefined, cancelRequested: undefined });
		const waveAction = {
			kind: activeBatch.kind,
			item: wave.items[0]!,
			items: wave.items.length > 1 ? [...wave.items] : undefined,
		} as DashboardAction;
		const first = wave.items[0]!;
		const priority: Priority | undefined = isRepairRequested(first, mode.currentUserLogin)
			? { category: "repair-requested", source: "local", reason: "changes requested on your pull request", demotion: 0 }
			: mode.priorityFor(first);
		const prompt = actionPrompt(waveAction, priority, { workbenchMode: mode.workbenchMode });
		if (!prompt) {
			persistBatch(ctx, { ...activeBatch!, state: "blocked", error: "wave action produced no prompt" });
			return;
		}
		const before = ctx.getAsyncJobSnapshot?.();
		const baseline = [...new Set([...(before?.delivery?.pendingJobIds ?? []), ...(before?.running ?? []).map((job) => job.id), ...(before?.recent ?? []).map((job) => job.id)])].sort();
		const resources = activeBatch.kind === "diff"
			? []
			: [...new Set(wave.items.flatMap((item) => [`repo:${item.repo.toLowerCase()}`, `item:${item.repo.toLowerCase()}#${item.id}`]))].sort();
		persistBatch(ctx, { ...activeBatch, waveIdentity: `${activeBatch.id}:${activeBatch.currentWave}`, waveToolCallIds: undefined, waveTaskWorkers: undefined, waveJobBaselineIds: baseline, waveJobIds: undefined, waveTerminalJobStatuses: undefined, waveEffectResources: resources });
		if (activeBatch.kind !== "diff") {
			try { claimItems(wave.items, `review:${activeBatch.id}:${activeBatch.currentWave}`, !retryingBlockedWave); }
			catch (error) { persistBatch(ctx, { ...activeBatch, state: "blocked", error: String(error) }); ctx.ui.notify(String(error), "error"); return; }
		}
		ctx.ui.notify(`Dispatching ${wave.repo} wave ${activeBatch.currentWave + 1}/${activeBatch.waves.length}`, "info");
		pi.sendUserMessage(prompt, { ...(deliverAs ? { deliverAs } : {}), waveId: `${activeBatch.id}:${activeBatch.currentWave}` });
		rememberWaveEvidence(ctx);
	};

	const startRepositoryBatch = async (ctx: CtxLike, kind: RepositoryBatchKind, items: readonly QueueItem[]) => {
		const generation = ++batchRequestGeneration;
		if (activeBatch?.state === "running" || activeBatch?.state === "paused") {
			ctx.ui.notify(`Run ${activeBatch.id} is already ${activeBatch.state}`, "warning");
			return;
		}
		if (activeBatch?.state === "blocked") {
			const wave = activeBatch.waves[activeBatch.currentWave];
			const requested = mode.repositoryWaves(items)[0];
			if (activeBatch.kind !== kind || !wave || !requested || requested.repo !== wave.repo || requested.items.length !== wave.items.length || requested.items.some((item, index) => item.repo !== wave.items[index]!.repo || item.id !== wave.items[index]!.id)) {
				ctx.ui.notify(`Run ${activeBatch.id} is blocked; inspect/reconcile its claims before dispatching another mutation`, "warning");
				return;
			}
			await dispatchCurrentWave(ctx);
			return;
		}
		const waves = mode.repositoryWaves(items);
		if (waves.length === 0) return;
		const startedAt = Date.now();
		const issueSubmittedPrs = Object.fromEntries(
			items
				.filter((item) => item.type === "issue")
				.map((item) => [`${item.repo.toLowerCase()}#${item.id}`, [...(item.submittedPrs ?? [])]]),
		);
		const batch: PersistedRepositoryBatch = {
			version: 1,
			id: `batch-${startedAt.toString(36)}`,
			kind,
			waves,
			currentWave: 0,
			completedItems: 0,
			totalItems: items.length,
			state: mode.paused ? "paused" : "running",
			startedAt,
			waveStartedAt: startedAt,
			issueSubmittedPrs,
		};
		const blockers = await Promise.all(waves.map((wave) => batchBlocker(kind, wave.items)));
		const blocker = blockers.find((reason) => reason !== undefined);
		if (generation !== batchRequestGeneration) return;
		if (activeBatch?.state === "running" || activeBatch?.state === "paused") return;
		if (blocker) {
			persistBatch(ctx, { ...batch, state: "blocked", error: blocker });
			ctx.ui.notify(blocker, "error");
			return;
		}
		mode.clearSelected();
		persist();
		persistBatch(ctx, batch);
		await dispatchCurrentWave(ctx, undefined, true);
	};
	const workflowPermissionBlocker = async (items: readonly QueueItem[]): Promise<string | undefined> => {
		const workflowItem = items.find((item) => item.type === "pr" && (item.workflowFiles?.length ?? 0) > 0);
		if (!workflowItem) return undefined;
		const scopes = await fetchOAuthScopes(mode.tokenOptions());
		if (scopes !== undefined) {
			if (!scopes.includes("workflow")) {
				return `Cannot dispatch ${workflowItem.repo}#${workflowItem.id}: GitHub token lacks workflow/Actions write permission; grant workflow scope or Actions/Contents write access`;
			}
			return undefined;
		}
		return `Cannot dispatch ${workflowItem.repo}#${workflowItem.id}: GitHub token workflow/Actions write permission could not be verified; grant workflow scope or Actions/Contents write access`;
	};

	const filterUnsupportedSlayItems = (ctx: CtxLike, items: readonly QueueItem[]): QueueItem[] => {
		const eligible: QueueItem[] = [];
		for (const item of items) {
			if (item.type !== "pr") {
				eligible.push(item);
				continue;
			}
			const wasRepair = isRepairRequested(item, mode.currentUserLogin);
			if (!wasRepair && (item.workflowFiles?.length ?? 0) > 0 && !policy.allowWorkflowSlay) {
				ctx.ui.notify(`Skipping ${item.repo}#${item.id}: changes ${item.workflowFiles![0]}`, "warning");
				continue;
			}
			if (item.changedFilesComplete === false) {
				ctx.ui.notify(`Skipping ${item.repo}#${item.id}: complete changed-file list unavailable`, "warning");
				continue;
			}
			eligible.push(item);
		}
		return eligible;
	};

	const filterCompletedIssueSlayItems = (ctx: CtxLike, items: readonly QueueItem[]): QueueItem[] => {
		const eligible: QueueItem[] = [];
		for (const item of items) {
			if (item.type === "issue" && (item.submittedPrs?.length ?? 0) > 0) {
				ctx.ui.notify(
					`Skipping ${item.repo}#${item.id}: pull request already submitted (${item.submittedPrs!.join(", ")})`,
					"warning",
				);
				continue;
			}
			eligible.push(item);
		}
		return eligible;
	};

	const startSlay = async (ctx: CtxLike, candidates: readonly QueueItem[] = mode.slayableItems(BATCH_LIMIT)) => {
		if (candidates.length === 0) {
			ctx.ui.notify("No queue items available to slay", "warning");
			return;
		}
		const supported = filterUnsupportedSlayItems(ctx, candidates);
		if (supported.length === 0) return;
		const items = filterCompletedIssueSlayItems(ctx, supported);
		if (items.length === 0) return;
		await startRepositoryBatch(ctx, "slay", items);
	};

	const startAutoslay = async (ctx: CtxLike) => {
		if (mode.queueMode === "issues") {
			await startSlay(ctx, mode.visibleItems());
			return;
		}
		if (mode.isReviewMode()) {
			await startSlay(ctx);
			return;
		}
		const repairs = mode.repairRequestedItems();
		mode.toggleMode();
		await refreshQueue(ctx);
		await startSlay(ctx, [...repairs, ...mode.visibleItems()]);
	};

	/**
	 * Point the queue at another repository.
	 *
	 * Accepts `owner/repo`, a bare repository name in the configured
	 * organization, a GitHub URL, or `org:<name>` to go back to a whole
	 * organization. Anything else is rejected rather than silently searched for.
	 */
	const promptForScope = async (ctx: CtxLike): Promise<boolean> => {
		if (!ctx.hasUI) return false;
		const answer = await ctx.ui.input("Review which repository?", "owner/repo, or org:name");
		if (answer === undefined || !answer.trim()) return false;
		const scope = parseScope(answer, mode.org);
		if (!scope) {
			ctx.ui.notify(`Not a repository: ${answer.trim()}`, "error");
			return false;
		}
		mode.setScope(scope);
		ctx.ui.notify(`Queue scoped to ${mode.scopeLabel()}`, "info");
		await refreshQueue(ctx);
		persist();
		return true;
	};
	const dispatch = async (ctx: CtxLike, action: DashboardAction): Promise<void> => {

		if (action.kind === "close") return;
		if (action.kind === "factory") {
			// The dashboard hides the chord when Factory is unavailable; this is
			// the residual path (a stale frame, or a caller that drives the action
			// directly). Name the cause instead of reporting a bare "not loaded".
			if (!factoryControllerRegistered()) {
				ctx.ui.notify(`Factory handoff unavailable: ${factoryLoadDiagnostic()}`, "warning");
				return;
			}
			const items = mode.chosenItems();
			if (items.length === 0) {
				ctx.ui.notify("Select at least one Review item before sending it to Factory", "warning");
				return;
			}
			const repositories = new Set(items.map((item) => item.repo));
			const title = `Send ${items.length} selected item${items.length === 1 ? "" : "s"} across ${repositories.size} repositor${repositories.size === 1 ? "y" : "ies"} to Factory`;
			const options: Array<string | { label: string; description?: string }> = [
				{ label: "Patch selected items", description: "Start Factory patch work for the selection" },
				{ label: "Inspect selected items", description: "Run the read-only Factory inspection" },
				{ label: "Prepare PR-ready patches", description: "Prepare patches for review-ready pull requests" },
				{ label: "Factory status", description: "Show current Factory capacity and batches" },
				"Cancel",
			];
			const choice = await ctx.ui.select(title, options);
			const command = choice === "Patch selected items"
				? "start patch"
				: choice === "Inspect selected items"
					? "start inspect"
					: choice === "Prepare PR-ready patches"
						? "start pr-ready"
						: choice === "Factory status"
							? "status"
							: undefined;
			if (command === undefined) return;
			try {
				const factoryCtx = { ...ctx, reconcileMutationClaim };
				ctx.ui.notify(await factoryCommand(command, factoryCtx), "info");
			} catch (error) { ctx.ui.notify(error instanceof Error ? error.message : String(error), "error"); }
			return;
		}
		if (action.kind === "open_browser") {
			const result = await pi.exec(
				"gh",
				[action.item.type === "pr" ? "pr" : "issue", "view", String(action.item.id), "--repo", action.item.repo, "--web"],
				{ timeout: 15_000 },
			);
			if (result.code === 0 && !result.killed) {
				ctx.ui.notify(`Opened ${action.item.url}`, "info");
			} else {
				ctx.ui.pasteToEditor(action.item.url);
				ctx.ui.notify(`Browser unavailable; added ${action.item.url} to the prompt`, "warning");
			}
			return;
		}
		if (action.kind === "scope") {
			await promptForScope(ctx);
			return;
		}
		if (action.kind === "autoslay") {
			activeCtx = ctx;
			await startAutoslay(ctx);
			return;
		}
		if (action.kind === "reference") {
			const items = action.items?.length ? action.items : [action.item];
			ctx.ui.pasteToEditor(items.map((item) => `${item.repo}#${item.id} — ${item.title}\n${item.url}\n`).join("\n"));
			ctx.ui.notify(`Added ${items.length === 1 ? "item" : `${items.length} items`} to the prompt`, "info");
			return;
		}
		const capturedItems = action.items && action.items.length > 0 ? [...action.items] : [action.item];



		if (action.kind === "comment") {
			if (commentInFlight) {
				ctx.ui.notify("A comment action is already in progress", "warning");
				return;
			}
			commentInFlight = true;
			let commentPlan: CommentActionPlan | undefined;
			const receipts: string[] = [];
			const commentOwner = `review:comment:${Date.now()}:${Math.random()}`;
			let claimed = false;
			let uncertain = false;
			try {
				const body = await ctx.ui.editor("Comment on selected work", "");
				if (body === undefined || !body.trim()) return;
				const targets: CommentTargetSnapshot[] = capturedItems.map((item) => ({
					repo: item.repo,
					number: item.id,
					type: item.type === "pr" ? "pull_request" : "issue",
					headSha: item.headSha,
				}));
				commentPlan = createCommentActionPlan(targets, body);
				pi.appendEntry(COMMENT_ENTRY, { version: 1, state: "previewed", plan: commentPlan } satisfies PersistedCommentResult);
				if (!(await ctx.ui.confirm("Post comment batch?", renderCommentActionPlan(commentPlan)))) {
					pi.appendEntry(COMMENT_ENTRY, { version: 1, state: "aborted", plan: commentPlan } satisfies PersistedCommentResult);
					return;
				}

				const queueMode = capturedItems[0]!.type === "pr" ? "prs" : "issues";
				const live = await fetchItemsByKey(
					targets.map((target) => `${target.repo}#${target.number}`),
					queueMode,
					mode.tokenOptions(),
				);
				if (live.error) throw new Error(`live revalidation failed: ${live.error}`);
					mode.reconcileItems(live.items);
					const liveTargets: CommentTargetSnapshot[] = live.items.map((item) => ({
					repo: item.repo,
					number: item.id,
					type: item.type === "pr" ? "pull_request" : "issue",
					headSha: item.headSha,
				}));
				const validation = validateCommentActionPlan(commentPlan, liveTargets);
				if (!validation.valid) throw new Error(validation.errors.join("; "));
				claimItems(capturedItems, commentOwner); claimed = true;
				pi.appendEntry(COMMENT_ENTRY, { version: 1, state: "confirmed", plan: commentPlan } satisfies PersistedCommentResult);

				for (const target of commentPlan.targets) {
					if (receipts.length > 0) {
						const current = await fetchItemsByKey(
							[`${target.repo}#${target.number}`],
							target.type === "pull_request" ? "prs" : "issues",
							mode.tokenOptions(),
						);
						if (current.error) throw new Error(`live revalidation failed: ${current.error}`);
						mode.reconcileItems(current.items);
						const validation = validateCommentActionPlan(
							{ ...commentPlan, targets: [target] },
							current.items.map((item) => ({
								repo: item.repo,
								number: item.id,
								type: item.type === "pr" ? "pull_request" : "issue",
								headSha: item.headSha,
							})),
						);
						if (!validation.valid) throw new Error(validation.errors.join("; "));
					}
					const invocation = commentInvocation(target, commentPlan.body);
					uncertain = true;
					const result = await pi.exec(invocation.command, [...invocation.args], { timeout: 30_000 });
					if (result.code !== 0 || result.killed) {
						throw new Error(result.stderr.trim() || `gh comment exited ${result.code}`);
					}
					receipts.push(result.stdout.trim() || `${target.repo}#${target.number}`);
					pi.appendEntry(COMMENT_ENTRY, { version: 1, state: "confirmed", plan: commentPlan, receipts: [...receipts] } satisfies PersistedCommentResult);
					uncertain = false;
				}
				pi.appendEntry(COMMENT_ENTRY, { version: 1, state: "complete", plan: commentPlan, receipts } satisfies PersistedCommentResult);
				ctx.ui.notify(`Posted ${receipts.length} GitHub-confirmed comment${receipts.length === 1 ? "" : "s"}`, "info");
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				if (commentPlan) pi.appendEntry(COMMENT_ENTRY, { version: 1, state: "failed", plan: commentPlan, receipts, error: message } satisfies PersistedCommentResult);
				ctx.ui.notify(`Comment action stopped: ${message}`, "error");
			} finally {
				if (claimed && !uncertain) releaseItems(capturedItems, commentOwner);
				commentInFlight = false;
			}
			return;
		}

		if (action.kind === "slay") {
			activeCtx = ctx;
			await startSlay(ctx, capturedItems);
			return;
		}
		if (action.kind === "fix") {
			activeCtx = ctx;
			const supported = filterUnsupportedSlayItems(ctx, capturedItems);
			if (supported.length === 0) return;
			await startRepositoryBatch(ctx, action.kind, supported);
			return;
		}
		if (action.kind === "diff") {
			activeCtx = ctx;
			await startRepositoryBatch(ctx, action.kind, capturedItems);
		}
	};
	const openDashboard = async (ctx: CtxLike) => {
		if (!ctx.hasUI || dashboardOpen) return;
		dashboardOpen = true;
		let reopen = false;
		try {
			const action = await ctx.ui.custom<DashboardAction>(
				(hostTui, theme, _keybindings, done) => {
					tui = hostTui as { requestRender(): void };
					activeDashboard = new ReviewDashboard(
						tui,
						workbenchPainter(theme as UiLike["theme"], () => mode.queueMode),
						mode,
						done,
						() => void refreshQueue(ctx),
						Math.max(14, Math.min(30, (process.stdout.rows ?? 30) - 8)),
						matchKey,
						() => {
							persist();
							syncStatus(ctx);
						},
						(nextAction) => void dispatch(ctx, nextAction),
						(paused) => {
							persist();
							if (!paused && activeBatch?.state === "paused") void dispatchCurrentWave(ctx, "followUp");
							syncBatchProgress(ctx);
						},
						// The dashboard advertises the Factory handoff only while a
						// controller is registered, so "Factory is not loaded" is not
						// reachable from a key the workbench offers.
						() => factoryControllerRegistered(),
					);
					return activeDashboard;
				},
				{ overlay: false },
			);
			if (action.kind !== "close") await dispatch(ctx, action);
			if (action.kind === "scope" || action.kind === "factory") reopen = true;
		} catch {
			// OMP cancellation closes the workbench without changing batch state.
		} finally {
			dashboardOpen = false;
			activeDashboard = undefined;
			persist();
			syncStatus(ctx);
		}
		if (reopen) void openDashboard(ctx);
	};

	const startSession = async (ctx: CtxLike, persisted: PersistedSelection | undefined) => {
		if (!mode.scope.value) {
			await promptForScope(ctx);
			if (!mode.scope.value) return;
		}
		const hive = await mode.refreshHive();
		if (hive.configured && hive.error) {
			ctx.ui.notify(
				`${hiveFailureStatus(hive.error)}; local attention order remains active, and review, fix, and slay remain available`,
				"warning",
			);
		}
		await refreshQueue(ctx);
		if (persisted?.id) mode.selectById(persisted.repo, persisted.id);

		const persistedBatches = readPersistedBatches(ctx);
		for (const batch of persistedBatches) rememberRecoveryBatch(batch);
		restoreClaimWaves();
		const latest = persistedBatches.at(-1);
		const latestOwner = latest ? `review:${latest.id}:${latest.currentWave}` : undefined;
		const recoveredBatch = latestOwner && resourceClaims().list().some((claim) => claim.owner === latestOwner)
			? loadWave(factoryClaimsRoot(env), latestOwner) ?? latest : latest;
		if (recoveredBatch) {
			activeBatch = recoveredBatch.state === "running" || (recoveredBatch.state === "paused" && recoveredBatch.cancelRequested === true)
				? {
					...recoveredBatch,
					state: "blocked",
					error: recoveredBatch.cancelRequested === true
						? "session ended while cancellation was draining the repository wave"
						: "session ended before the repository wave reached a terminal state",
				}
				: ["blocked", "paused"].includes(recoveredBatch.state)
					? recoveredBatch
					: undefined;
			if (activeBatch?.state === "blocked") rememberRecoveryBatch(activeBatch);
			if (recoveredBatch.state === "running") {
				pi.appendEntry(BATCH_ENTRY, activeBatch);
				ctx.ui.notify(`Recovered blocked run ${recoveredBatch.id}; use /review reconcile or /review revise after inspecting the settled external effect`, "warning");
			}
			if (activeBatch?.state === "paused") mode.setPaused(true);
			syncBatchProgress(ctx);
			if (recoveredBatch.state === "running" && activeBatch?.state === "blocked") {
				const result = await reconcileBatchClaims(ctx, activeBatch);
				const resources = resourcesForBatch(activeBatch);
				if (result.unknown.length === 0 && result.settled.length === resources.length && resources.length > 0) {
					await finishRecoveredBatch(ctx, activeBatch, result);
				}
			}
		}
		const recoveredComment = readPersistedComment(ctx);
		if (recoveredComment?.state === "previewed" || recoveredComment?.state === "confirmed") {
			ctx.ui.notify("An interrupted comment plan was not replayed; inspect it before retrying", "warning");
		}

		const preselect = pi.getFlag("pr");
		if (typeof preselect === "string" && preselect.trim()) {
			const number = Number.parseInt(preselect.trim().replace(/^#/, ""), 10);
			if (Number.isInteger(number) && !mode.selectById(undefined, number)) {
				ctx.ui.notify(`#${number} is not in the open ${mode.queueMode} queue`, "warning");
			}
		}
		syncStatus(ctx);
		if (pi.getFlag("autoslay") === true) await startAutoslay(ctx);
		void openDashboard(ctx);
	};

	const advanceRepositoryBatch = async (ctx: CtxLike) => {
		if (!activeBatch || (activeBatch.state !== "running" && !(activeBatch.state === "paused" && activeBatch.cancelRequested))) return;
		const batchAtEntry = activeBatch;
		const wave = batchAtEntry.waves[batchAtEntry.currentWave];
		const jobs = ctx.getAsyncJobSnapshot?.();
		rememberWaveEvidence(ctx);
		if (jobs?.running.some((job) => job.startTime >= activeBatch!.waveStartedAt)) return;
		const covered = waveWorkerCoverageComplete(activeBatch.waveJobIds, activeBatch.waveToolCallIds, activeBatch.waveTaskWorkers);
		const settled = waveWorkersSettled(jobs, activeBatch.waveJobIds, activeBatch.waveTerminalJobStatuses);
		const failed = (activeBatch.waveJobIds ?? []).filter((id) => ["failed", "cancelled", "canceled"].includes(activeBatch!.waveTerminalJobStatuses?.[id] ?? ""));
		if (!covered || !settled || failed.length > 0) {
			if (batchAtEntry.cancelRequested) {
				await drainCancelledBatch(ctx, activeBatch);
				return;
			}
			const error = failed.length > 0
				? `${failed.length} workflowz job${failed.length === 1 ? "" : "s"} failed or were cancelled`
				: !covered ? "workflowz task-to-job evidence is missing or ambiguous for the repository wave"
					: "workflowz workers lack terminal settlement evidence for the repository wave";
			persistBatch(ctx, { ...activeBatch, state: "blocked", error });
			ctx.ui.notify(`Repository wave stopped: ${error}`, "error");
			return;
		}
		if (batchAtEntry.cancelRequested) {
			await drainCancelledBatch(ctx, activeBatch);
			return;
		}
		if (activeBatch.kind === "slay" && wave.items.every((item) => item.type === "pr")) {
			const live = await fetchItemsByKey(
				wave.items.map((item) => `${item.repo}#${item.id}`),
				"prs",
				mode.tokenOptions(),
			);
			if (live.error) {
				persistBatch(ctx, { ...activeBatch, state: "blocked", error: live.error });
				ctx.ui.notify(`Slay wave stopped: ${live.error}`, "error");
				return;
			}
			mode.reconcileItems(live.items);
			const repairs = wave.items.every((item) => isRepairRequested(item, mode.currentUserLogin));
			const unfinished = wave.items.filter((item) => {
				const current = live.items.find((candidate) => candidate.repo === item.repo && candidate.id === item.id);
				if (!current) return false;
				return repairs ? current.headSha === item.headSha : current.autoMergeEnabled !== true;
			});
			if (unfinished.length > 0) {
				const targets = unfinished.map((item) => `${item.repo}#${item.id}`).join(", ");
				const error = repairs
					? `slay repair jobs settled but targets have no new head: ${targets}`
					: `slay review jobs settled but targets remain open without auto-merge: ${targets}`;
				persistBatch(ctx, { ...activeBatch, state: "blocked", error });
				ctx.ui.notify(`Slay wave stopped: ${error}`, "error");
				return;
			}
		}
		if (activeBatch.kind === "slay" && wave.items.every((item) => item.type === "issue")) {
			const live = await fetchItemsByKey(
				wave.items.map((item) => `${item.repo}#${item.id}`),
				"issues",
				mode.tokenOptions(),
			);
			if (live.error) {
				persistBatch(ctx, { ...activeBatch, state: "blocked", error: live.error });
				ctx.ui.notify(`Slay wave stopped: ${live.error}`, "error");
				return;
			}
			const unfinished = wave.items.filter((item) => {
				const current = live.items.find((candidate) => candidate.repo === item.repo && candidate.id === item.id);
				return !current || expectedIssueSubmission(activeBatch!, item, current) === undefined;
			});
			if (unfinished.length > 0) {
				const targets = unfinished.map((item) => `${item.repo}#${item.id}`).join(", ");
				const error = `issue slay jobs settled without exactly one new submitted pull request (no pull request was submitted or the effect was ambiguous): ${targets}`;
				persistBatch(ctx, { ...activeBatch, state: "blocked", error });
				ctx.ui.notify(`Slay wave stopped: ${error}`, "error");
				return;
			}
		}
		const refreshed = await refreshQueue(ctx);
		if (refreshed.error) {
			persistBatch(ctx, { ...activeBatch, state: "blocked", error: refreshed.error });
			ctx.ui.notify(`Repository wave stopped: ${refreshed.error}`, "error");
			return;
		}
		if (activeBatch.kind !== "diff") releaseItems(wave.items, `review:${activeBatch.id}:${activeBatch.currentWave}`);
		const nextWave = activeBatch.currentWave + 1;
		const completedItems = activeBatch.completedItems + wave.items.length;
		if (nextWave >= activeBatch.waves.length) {
			persistBatch(ctx, { ...activeBatch, currentWave: nextWave, completedItems, state: "complete" });
			ctx.ui.notify(activeBatch.kind === "slay" ? "Slay complete" : "Repository run complete", "info");
			return;
		}
		persistBatch(ctx, {
			...activeBatch,
			currentWave: nextWave,
			completedItems,
			state: mode.paused ? "paused" : "running",
			waveIdentity: undefined,
			waveToolCallIds: undefined,
			waveTaskWorkers: undefined,
			waveJobBaselineIds: undefined,
			waveJobIds: undefined,
			waveTerminalJobStatuses: undefined,
		});
		if (!mode.paused) await dispatchCurrentWave(ctx, "followUp");
	};

	pi.on("session_start", async (_event, ctx) => {
		activeCtx = ctx;
		// One bounded startup diagnostic, by cause. Without it a Factory handoff
		// that cannot be reached only surfaces as a mystery on Shift+F, and the
		// absent LUNA_FACTORY_ENABLED opt-in is blamed for a load failure.
		if (!factoryControllerRegistered()) {
			ctx.ui.notify(`Factory handoff unavailable: ${factoryLoadDiagnostic()}`, "warning");
		}
		mode.setToken(resolveToken(env));
		// Mode, scope and filter apply immediately; the remembered item can only be
		// found once the queue has actually been fetched, so restore runs twice.
		const persisted = readPersisted(ctx);
		mode.restore(persisted);

		const flagIssues = pi.getFlag("issues");
		if (flagIssues === true) mode.queueMode = "issues";

		const flagAll = pi.getFlag("all");
		if (flagAll === true) mode.hiveOnly = false;
		if (pi.getFlag("autoslay") === true) mode.hiveOnly = false;
		// An explicit scope beats a remembered one: you asked for it on the
		// command line, this run.
		const flagRepo = pi.getFlag("repo");
		if (typeof flagRepo === "string" && flagRepo.trim()) {
			const scope = parseScope(flagRepo, mode.org);
			if (scope) mode.setScope(scope);
			else if (ctx.hasUI) ctx.ui.notify(`--repo is not a repository: ${flagRepo}`, "error");
		}
		const flagSkipRepo = pi.getFlag("skip-repo");
		if (typeof flagSkipRepo === "string" && flagSkipRepo.trim()) {
			for (const r of flagSkipRepo.split(",")) {
				const trimmed = r.trim().toLowerCase();
				if (trimmed) mode.skipRepos.add(trimmed);
			}
		}
		if (!ctx.hasUI) {
			if (!mode.scope.value) {
				started = mode.refreshQueue().then(() => undefined);
				return;
			}
			started = Promise.all([mode.refreshHive(), refreshQueue(ctx)])
				.then(() => {
					mode.restore(persisted);
				})
				.catch(() => {
					// fetchHive and fetchQueue report failure in their results; a
					// throw here must still leave `started` resolvable for the tools.
				});
			return;
		}

		ctx.ui.setTitle(mode.isReviewMode() ? "review workbench" : "hive workbench");
		ctx.ui.setWidget(
			"hive-workbench-rail",
			(hostTui: unknown, theme: unknown) => {
				tui = hostTui as { requestRender(): void };
				return new ReviewRail(
					tui,
					workbenchPainter(theme as UiLike["theme"], () => mode.queueMode),
					mode,
					RAIL_KEYS,
					() => dashboardOpen,
				);
			},
			{ placement: "belowEditor" },
		);

		syncStatus(ctx);

		// Before the first await: a startup that fails or drags must still leave a
		// session that refreshes itself.
		every(QUEUE_POLL_MS, () => {
			void refreshQueue(ctx);
		});
		if (mode.isHiveMode()) {
			every(HIVE_POLL_MS, () => {
				void mode.refreshHive().then(() => {
					syncStatus(ctx);
				});
			});
		}

		// Detached: nothing awaits this, so an escaping rejection would take the
		// whole session process down with it.
		started = startSession(ctx, persisted).catch((error: unknown) => {
			ctx.ui.notify(`${mode.isReviewMode() ? "Review" : "Hive"} workbench startup: ${error instanceof Error ? error.message : String(error)}`, "error");
		});
	});

	pi.on("session_shutdown", () => {
		unregisterFactorySelection();
		unregisterFactoryReconciler();
		for (const stop of timers.splice(0)) stop();
	});

	// ---- live turn trace -----------------------------------------------------

	pi.on("turn_start", (_event, eventCtx) => {
		mode.session.startTurn(Date.now());
		const ctxToUse = (eventCtx as CtxLike | undefined) ?? activeCtx;
		if (ctxToUse) syncBatchProgress(ctxToUse);
		repaint();
	});
	pi.on("turn_end", (_event, eventCtx) => {
		mode.session.endTurn(Date.now());
		const ctxToUse = (eventCtx as CtxLike | undefined) ?? activeCtx;
		if (ctxToUse) {
			rememberWaveEvidence(ctxToUse);
			syncBatchProgress(ctxToUse);
		}
		repaint();
	});
	pi.on("agent_end", async (event, eventCtx) => {
		if (event && typeof event === "object" && "willContinue" in event && event.willContinue === true) return;
		const ctxToUse = (eventCtx as CtxLike | undefined) ?? activeCtx;
		if (ctxToUse) await advanceRepositoryBatch(ctxToUse);
	});
	pi.on("message_start", (event, ctx) => { rememberDeliveredJobs(event, ctx); rememberWaveEvidence(ctx); });
	pi.on("tool_result", (event, ctx) => {
		if (event && typeof event === "object" && "toolCallId" in event && typeof event.toolCallId === "string") rememberTaskResult(ctx, event.toolCallId, event);
		rememberWaveEvidence(ctx);
	});
	pi.on("tool_call", (event) => {
		const { toolCallId, toolName, input } = event as { toolCallId?: string; toolName?: string; input?: { command?: unknown } };
		if (toolName === "task" && toolCallId && activeBatch?.state === "running" && activeCtx) {
			const ids = [...new Set([...(activeBatch.waveToolCallIds ?? []), toolCallId])].sort();
			persistBatch(activeCtx, { ...activeBatch, waveToolCallIds: ids });
		}
		if (
			activeBatch?.kind !== "slay"
			|| (activeBatch.state !== "running" && activeBatch.state !== "paused")
		) return;
		if (toolName !== "bash") return;
		const command = String(input?.command ?? "");
		const reason = slayBashBlockReason(command);
		if (reason) return { block: true, reason: `Review Slay guard: ${reason}` };
		const wave = activeBatch.waves[activeBatch.currentWave];
		const visible = mode.visibleItems();
		const currentItems = (wave?.items ?? []).map((item) =>
			visible.find((candidate) => candidate.repo === item.repo && candidate.id === item.id) ?? item,
		);
		const landingBlocker = slayLandingBlockReason(command, currentItems, policy);
		if (landingBlocker) return { block: true, reason: `Review Slay guard: ${landingBlocker}` };
	});

	pi.on("tool_execution_start", (event) => {
		const { toolCallId, toolName, args } = event as { toolCallId: string; toolName: string; args: unknown };
		mode.session.startTool(toolCallId, toolName, args, Date.now());
		repaint();
	});
	pi.on("tool_execution_update", (event, ctx) => {
		const { toolCallId, partialResult } = event as { toolCallId: string; partialResult: unknown };
		mode.session.updateTool(toolCallId, partialResult);
		const ctxToUse = ctx ?? activeCtx;
		if (ctxToUse) rememberTaskResult(ctxToUse, toolCallId, partialResult);
		repaint();
	});
	pi.on("tool_execution_end", (event, eventCtx) => {
		const { toolCallId, result, isError } = event as { toolCallId: string; result: unknown; isError: boolean };
		mode.session.endTool(toolCallId, result, isError === true, Date.now());
		const ctxToUse = (eventCtx as CtxLike | undefined) ?? activeCtx;
		if (ctxToUse) { rememberTaskResult(ctxToUse, toolCallId, result); rememberWaveEvidence(ctxToUse); syncBatchProgress(ctxToUse); }
		repaint();
	});

	// ---- keyboard ------------------------------------------------------------

	pi.registerShortcut("alt+b", {
		description: mode.isReviewMode() ? "Open the Review workbench" : "Open the Hive workbench",
		handler: (ctx) => void openDashboard(ctx),
	});
	pi.registerShortcut("alt+s", {
		description: "Repair returned pull requests, then implement issue waves",
		handler: (ctx) => void startAutoslay(ctx),
	});
	pi.registerShortcut("alt+u", {
		description: mode.isReviewMode() ? "Refetch the Review workbench queue" : "Refetch the Hive workbench queue",
		handler: (ctx) => void refreshQueue(ctx),
	});

	return { whenStarted: () => started };
}
