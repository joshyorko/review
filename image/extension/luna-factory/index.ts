/**
 * Luna Factory — an opt-in OMP extension.
 *
 * Luna owns the objective and the semantic judgment; this package owns the
 * validated ledger and its mechanical transitions; OMP owns execution, agents,
 * jobs, and isolation; GitHub and repository policy still own external
 * authority. Loading the extension does none of that: it registers a surface and
 * waits. Execution is opt-in behind `LUNA_FACTORY_ENABLED=1`.
 *
 * The command surface the objective describes is exposed as LLM-callable tools
 * rather than slash commands. The appliance's pinned OMP host slice registers
 * flags, shortcuts, tools, and events — not commands — so a `/factory` command
 * is not a supported seam here. Advertising one would be exactly the invented
 * API the objective forbids; the tool names are the supported equivalent and the
 * README records the gap.
 */

import { evaluateRun } from "./core/convergence.ts";
import { emptyLedger } from "./core/model.ts";
import type { Criterion, Ledger, ReduceResult, RunId, Subject, TaskId } from "./core/model.ts";
import { findTask } from "./core/model.ts";
import { renderCompletionReceipt } from "./core/receipt.ts";
import { reduce } from "./core/reducer.ts";
import { parseCandidate, parseReceipt } from "./core/schema.ts";
import { buildDispatchPrompt } from "./omp/adapter.ts";
import { coverageFor, enforcedPaths, unsupportedPaths } from "./omp/capabilities.ts";
import { type SessionCtx, loadRun, saveRun } from "./omp/session.ts";
import { renderStatusDetail, renderWhy, truncatePlain } from "./ui/status.ts";

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
}

/** The tool definition shape the host accepts. Named here so consumers do not rebuild it. */
export interface FactoryToolDefinition {
	readonly name: string;
	readonly label: string;
	readonly description: string;
	readonly parameters: unknown;
	execute(toolCallId: string, params: Record<string, unknown>): Promise<ToolResult>;
}

/** What the entry point returns to the host. */
export interface LunaFactoryExtension {
	/** `session_start` returns before its own work is finished; this awaits the second moment. */
	whenStarted(): Promise<void>;
}

export interface FactoryHost {
	zod: ZodLike;
	registerTool(definition: FactoryToolDefinition): void;
	appendEntry(customType: string, data?: unknown): void;
	setLabel(label: string): void;
	on(event: string, handler: (event: unknown, ctx: FactoryCtx) => unknown): void;
}

interface FactoryCtx extends SessionCtx {
	hasUI?: boolean;
	ui?: { notify(message: string, level?: string): void };
}

export interface FactoryOptions {
	/** Execution is opt-in; loading the extension never starts work. */
	env?: NodeJS.ProcessEnv;
	/** Roots the run owns. Artifact references outside them are rejected. */
	artifactRoots?: readonly string[];
}

const ENABLE_FLAG = "LUNA_FACTORY_ENABLED";

function text(value: string): ToolContent[] {
	return [{ type: "text", text: value }];
}

/** Read a JSON-string argument. Tools take one string so the package needs no schema library. */
function parseArgument(params: Record<string, unknown>): { readonly ok: true; readonly value: unknown } | { readonly ok: false; readonly error: string } {
	const raw = params.input;
	if (typeof raw !== "string" || raw.trim().length === 0) return { ok: false, error: "input must be a non-empty JSON string" };
	try {
		return { ok: true, value: JSON.parse(raw) };
	} catch (error) {
		return { ok: false, error: `input is not valid JSON: ${error instanceof Error ? error.message : String(error)}` };
	}
}

export function createLunaFactoryExtension(host: FactoryHost, options: FactoryOptions = {}): LunaFactoryExtension {
	const env = options.env ?? process.env;
	const artifactRoots = options.artifactRoots ?? [];
	let ledger: Ledger | undefined;
	let loadProblem: string | undefined;

	const enabled = (): boolean => env[ENABLE_FLAG] === "1";

	/** Persist only through the journal, so every mutation survives a reload. */
	const commit = (next: Ledger): void => {
		ledger = next;
		saveRun(host, next);
	};

	const z = host.zod;
	const jsonParameters = z.object({ input: z.string().describe("JSON payload for this command") });

	const registerTool = (definition: FactoryToolDefinition): void => {
		host.registerTool({ ...definition, parameters: jsonParameters });
	};

	/** Every mutating command runs through here so the gate and the journal cannot drift apart. */
	const mutate = (
		action: (current: Ledger) => ReduceResult,
		describe: (next: Ledger) => string,
	): ToolResult => {
		if (!enabled()) {
			return { content: text(`${ENABLE_FLAG}=1 is required to run Factory work; the extension is loaded but idle.`), isError: true };
		}
		if (ledger === undefined) {
			return { content: text(loadProblem ?? "no Factory run is open; use luna_factory_open first"), isError: true };
		}
		const result = action(ledger);
		if (!result.ok) return { content: text(result.error), isError: true };
		commit(result.ledger);
		return { content: text(describe(result.ledger)) };
	};

	registerTool({
		name: "luna_factory_status",
		label: "Factory Status",
		description:
			"Report the current Luna Factory run: proven criteria, owned activity, blockers, dependencies, and routing. Reading status never starts work or changes a model.",
		async execute() {
			if (ledger === undefined) {
				const lines = [loadProblem ?? "no Factory run is open"];
				lines.push(`execution: ${enabled() ? "enabled" : `idle (${ENABLE_FLAG}=1 to enable)`}`);
				lines.push(`enforced: ${enforcedPaths().join(", ")}`);
				lines.push(`unsupported: ${unsupportedPaths().join(", ")}`);
				return { content: text(lines.join("\n")) };
			}
			const detail = renderStatusDetail(ledger);
			const boundary = [
				"",
				`execution: ${enabled() ? "enabled" : `idle (${ENABLE_FLAG}=1 to enable)`}`,
				`enforced: ${enforcedPaths().join(", ")}`,
				`observed/unsupported: ${unsupportedPaths().join(", ")}`,
			];
			return { content: text([...detail, ...boundary].join("\n")) };
		},
	});

	registerTool({
		name: "luna_factory_open",
		label: "Factory Open",
		description:
			"Establish a Factory run from an objective the user already agreed to. Pass objective, criteria, and the subject repository/base. Refuses to silently replace an open run.",
		async execute(_toolCallId, params) {
			const parsed = parseArgument(params);
			if (!parsed.ok) return { content: text(parsed.error), isError: true };
			if (!enabled()) {
				return { content: text(`${ENABLE_FLAG}=1 is required to open a Factory run.`), isError: true };
			}
			const payload = parsed.value as {
				objective?: unknown;
				criteria?: unknown;
				repo?: unknown;
				base?: unknown;
				head?: unknown;
				replace?: unknown;
				appetite?: unknown;
			};
			if (typeof payload.objective !== "string" || payload.objective.trim().length === 0) {
				return { content: text("objective must be a non-empty string"), isError: true };
			}
			if (!Array.isArray(payload.criteria) || payload.criteria.length === 0) {
				return { content: text("criteria must be a non-empty array of {id, statement, mandatory}"), isError: true };
			}
			if (typeof payload.repo !== "string" || typeof payload.base !== "string") {
				return { content: text("repo and base are required: evidence is bound to an exact subject"), isError: true };
			}
			if (ledger !== undefined && payload.replace !== true) {
				return {
					content: text(
						`a Factory run is already open for '${ledger.goal.statement}'. A new objective must replace it explicitly with replace: true; a quoted objective is not authority to overwrite the current one.`,
					),
					isError: true,
				};
			}
			const criteria: Criterion[] = [];
			for (const entry of payload.criteria as unknown[]) {
				if (typeof entry !== "object" || entry === null) {
					return { content: text("each criterion must be an object"), isError: true };
				}
				const record = entry as Record<string, unknown>;
				if (typeof record.id !== "string" || typeof record.statement !== "string") {
					return { content: text("each criterion needs string id and statement"), isError: true };
				}
				criteria.push({
					id: record.id as Criterion["id"],
					statement: record.statement,
					mandatory: record.mandatory !== false,
				});
			}
			const appetite = (payload.appetite ?? {}) as { tasks?: unknown; attemptsPerTask?: unknown };
			const subject: Subject =
				typeof payload.head === "string"
					? { repo: payload.repo, base: payload.base, head: payload.head }
					: { repo: payload.repo, base: payload.base };
			const next = emptyLedger(`lf-${Date.now().toString(36)}` as RunId, {
				statement: payload.objective,
				nonGoals: [],
				permittedEffects: ["read", "write"],
				appetite: {
					tasks: typeof appetite.tasks === "number" ? appetite.tasks : 8,
					attemptsPerTask: typeof appetite.attemptsPerTask === "number" ? appetite.attemptsPerTask : 2,
				},
			}, criteria, subject);
			commit(next);
			return { content: text(`Factory run open: ${renderStatusDetail(next)[0]}`) };
		},
	});

	registerTool({
		name: "luna_factory_candidate",
		label: "Factory Candidate",
		description:
			"Submit a discovered candidate for admission. Discovery creates candidates, never authority: the ledger decides ADMIT, DEFER, DISMISS, or ESCALATE and records the reason.",
		async execute(_toolCallId, params) {
			const parsed = parseArgument(params);
			if (!parsed.ok) return { content: text(parsed.error), isError: true };
			const candidate = parseCandidate(parsed.value);
			if (!candidate.ok) return { content: text(`candidate rejected: ${candidate.errors.join("; ")}`), isError: true };
			return mutate(
				(current) =>
					reduce(current, { kind: "record_candidate", expectedRevision: current.revision, candidate: candidate.value }, { artifactRoots }),
				(next) => {
					const task = findTask(next, candidate.value.taskId);
					return task === undefined
						? `${candidate.value.taskId} was dismissed: it duplicates existing work or its criterion already holds proof`
						: `${task.id}: ${task.decision} — ${task.decisionReason}`;
				},
			);
		},
	});

	registerTool({
		name: "luna_factory_attempt",
		label: "Factory Attempt",
		description:
			"Persist the intent to run an admitted task before any external effect, opening a new attempt on the task's lineage.",
		async execute(_toolCallId, params) {
			const parsed = parseArgument(params);
			if (!parsed.ok) return { content: text(parsed.error), isError: true };
			const payload = parsed.value as { taskId?: unknown; attemptId?: unknown };
			if (typeof payload.taskId !== "string" || typeof payload.attemptId !== "string") {
				return { content: text("taskId and attemptId are required"), isError: true };
			}
			return mutate(
				(current) =>
					reduce(
						current,
						{
							kind: "start_attempt",
							expectedRevision: current.revision,
							taskId: payload.taskId as TaskId,
							attemptId: payload.attemptId,
							subject: current.subject,
						},
						{ artifactRoots },
					),
				(next) => {
					const task = findTask(next, payload.taskId as TaskId)!;
					const attempt = task.attempts.at(-1)!;
					return `attempt ${attempt.id} opened on ${task.id} (lineage ${attempt.lineage}) at ${next.subject.head ?? next.subject.base}`;
				},
			);
		},
	});

	registerTool({
		name: "luna_factory_dispatch",
		label: "Factory Dispatch",
		description:
			"Build the bounded prompt for an admitted task. Factory's enforced boundary is the work it emits: it refuses an unadmitted task, a closed run, and any execution path whose admission gate is unproven.",
		async execute(_toolCallId, params) {
			const parsed = parseArgument(params);
			if (!parsed.ok) return { content: text(parsed.error), isError: true };
			if (ledger === undefined) return { content: text(loadProblem ?? "no Factory run is open"), isError: true };
			const payload = parsed.value as { taskId?: unknown; attemptId?: unknown; path?: unknown };
			if (typeof payload.taskId !== "string" || typeof payload.attemptId !== "string") {
				return { content: text("taskId and attemptId are required"), isError: true };
			}
			const path = typeof payload.path === "string" ? payload.path : "factory.admitted-dispatch";
			const plan = buildDispatchPrompt(ledger, payload.taskId as TaskId, payload.attemptId, path);
			if (!plan.ok) return { content: text(plan.error), isError: true };
			const coverage = coverageFor(path)!;
			return {
				content: text(`${plan.prompt}\n\nadmission boundary: ${coverage.status} via ${coverage.seam}`),
				details: { path, status: coverage.status },
			};
		},
	});

	registerTool({
		name: "luna_factory_receipt",
		label: "Factory Receipt",
		description:
			"Record a worker's structured receipt and reconcile it against the exact task, attempt, generation, and subject it claims to certify.",
		async execute(_toolCallId, params) {
			const parsed = parseArgument(params);
			if (!parsed.ok) return { content: text(parsed.error), isError: true };
			const receipt = parseReceipt(parsed.value);
			if (!receipt.ok) return { content: text(`receipt rejected: ${receipt.errors.join("; ")}`), isError: true };
			return mutate(
				(current) =>
					reduce(
						current,
						{
							kind: "record_receipt",
							expectedRevision: current.revision,
							taskId: receipt.value.taskId,
							attemptId: receipt.value.attemptId,
							receipt: receipt.value,
						},
						{ artifactRoots },
					),
				(next) => {
					const task = findTask(next, receipt.value.taskId)!;
					return `${task.id} is ${task.state}; a returned worker is not acceptance proof — run the receipt through luna_factory_finish against the current subject`;
				},
			);
		},
	});

	registerTool({
		name: "luna_factory_finish",
		label: "Factory Finish",
		description:
			"Certify an admitted task against a receipt that reconciles as proven at the current subject. Refuses unproven, stale, or unintegrated write work.",
		async execute(_toolCallId, params) {
			const parsed = parseArgument(params);
			if (!parsed.ok) return { content: text(parsed.error), isError: true };
			const payload = parsed.value as { taskId?: unknown };
			if (typeof payload.taskId !== "string") return { content: text("taskId is required"), isError: true };
			return mutate(
				(current) => {
					const task = findTask(current, payload.taskId as TaskId);
					if (task === undefined) return { ok: false, error: `unknown task ${payload.taskId}` };
					return reduce(
						current,
						{
							kind: "finish_task",
							expectedRevision: current.revision,
							taskId: task.id,
							criterionId: task.criterionId,
						},
						{ artifactRoots },
					);
				},
				(next) => renderCompletionReceipt(next, evaluateRun(next)),
			);
		},
	});

	registerTool({
		name: "luna_factory_why",
		label: "Factory Why",
		description: "Explain why one task was admitted, deferred, dismissed, or escalated, with the evidence recorded for it.",
		async execute(_toolCallId, params) {
			const parsed = parseArgument(params);
			if (!parsed.ok) return { content: text(parsed.error), isError: true };
			const payload = parsed.value as { taskId?: unknown };
			if (typeof payload.taskId !== "string") return { content: text("taskId is required"), isError: true };
			if (ledger === undefined) return { content: text(loadProblem ?? "no Factory run is open"), isError: true };
			return { content: text(renderWhy(ledger, payload.taskId as TaskId).join("\n")) };
		},
	});

	registerTool({
		name: "luna_factory_control",
		label: "Factory Control",
		description:
			"Pause admission, resume after reconciliation, or abort. Pause drains admitted work without claiming rollback; abort requests cancellation of owned work and never retracts external effects.",
		async execute(_toolCallId, params) {
			const parsed = parseArgument(params);
			if (!parsed.ok) return { content: text(parsed.error), isError: true };
			const payload = parsed.value as { action?: unknown };
			const control = payload.action === "pause" ? "paused" : payload.action === "resume" ? "active" : payload.action === "abort" ? "interrupted" : undefined;
			if (control === undefined) return { content: text("action must be pause, resume, or abort"), isError: true };
			const result = mutate(
				(current) => reduce(current, { kind: "set_control", expectedRevision: current.revision, control }, { artifactRoots }),
				(next) => {
					const owned = next.tasks.filter((task) => task.state === "RUNNING" || task.state === "VERIFY");
					const jobs = owned.flatMap((task) => task.attempts.flatMap((attempt) => attempt.nativeJobIds));
					if (control !== "interrupted") return `run is ${next.control}`;
					const lines = ["run is interrupted; no new admission will start."];
					lines.push(
						jobs.length === 0
							? "no recorded native job ids to cancel; reconcile with luna_factory_status before resuming."
							: `recorded native job ids to cancel through OMP: ${jobs.join(", ")}. Factory does not cancel them itself, and no external effect is rolled back.`,
					);
					return lines.join("\n");
				},
			);
			return result;
		},
	});

	registerTool({
		name: "luna_factory_completion",
		label: "Factory Completion",
		description:
			"Render the Factory-verified completion receipt. This is a distinct artifact derived only from ledger records, so a premature success sentence in prose has nothing to attach to.",
		async execute() {
			if (ledger === undefined) return { content: text(loadProblem ?? "no Factory run is open"), isError: true };
			return { content: text(renderCompletionReceipt(ledger, evaluateRun(ledger))) };
		},
	});

	const settle = (ctx: FactoryCtx): void => {
		if (ledger === undefined) return;
		const verdict = evaluateRun(ledger);
		// A final settlement check only. It never dispatches, continues a turn, or
		// rescues a hung job: the documented continuation ceiling and background-job
		// deferral make that someone else's mechanism.
		host.appendEntry("com.joshyorko.luna-factory.settlement", {
			runId: ledger.runId,
			generation: ledger.generation,
			revision: ledger.revision,
			control: verdict.control,
			converged: verdict.converged,
			remaining: verdict.remaining,
		});
		if (ctx.hasUI) {
			ctx.ui?.notify?.(truncatePlain(renderStatusDetail(ledger)[0]!, 120), verdict.converged ? "info" : "warning");
		}
	};

	host.setLabel("Luna Factory");
	host.on("session_start", (_event, ctx) => {
		const loaded = loadRun(ctx);
		ledger = loaded.ledger;
		loadProblem = loaded.problem;
		if (loaded.problem !== undefined && ctx.hasUI) {
			ctx.ui?.notify?.(`Factory journal is unreadable: ${loaded.problem}`, "error");
		}
	});
	host.on("session_stop", (_event, ctx) => settle(ctx));

	return {
		async whenStarted() {
			return;
		},
	};
}
