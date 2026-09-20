/**
 * Luna Factory — an opt-in OMP extension.
 *
 * Luna owns the objective and the semantic judgment; this package owns the
 * validated ledger and its mechanical transitions; OMP owns execution, agents,
 * jobs, and isolation; GitHub and repository policy still own external
 * authority. Loading the extension does none of that: it registers a surface and
 * waits. Execution is opt-in behind `LUNA_FACTORY_ENABLED=1`.
 *
 * The command surface is registered when the host exposes OMP's native command
 * seam. The same package also keeps namespaced tools for headless and older-host
 * callers; loading either surface starts no work.
 */

import { evaluateRun } from "./core/convergence.ts";
import { emptyLedger } from "./core/model.ts";
import { DEFAULT_FINISH_AUTHORITY } from "./core/model.ts";
import type { Appetite, Criterion, Effect, Ledger, NativeJobId, ReduceResult, RunId, Subject, TaskId } from "./core/model.ts";
import { findTask } from "./core/model.ts";
import { renderCompletionReceipt } from "./core/receipt.ts";
import { reduce } from "./core/reducer.ts";
import { parseCandidate, parseReceipt, parseSubject } from "./core/schema.ts";
import { buildDispatchPrompt, DISPATCH_MARKER, dispatchMarker } from "./omp/adapter.ts";
import { coverageFor, enforcedPaths, unsupportedPaths } from "./omp/capabilities.ts";
import { type SessionCtx, loadRun, saveRun } from "./omp/session.ts";
import { renderStatusDetail, renderWhy, truncatePlain } from "./ui/status.ts";
import { BatchService, type BatchOptions } from "./omp/batch-service.ts";
import { BatchGitHub } from "./omp/batch-github.ts";
import { factoryClaimsRoot, factoryStateRoot, ResourceClaims } from "./omp/batch-store.ts";
import { registerFactoryController, reportFactoryLoadFailure, selectedFactoryItems } from "./omp/batch-bridge.ts";
import type { NativeSDK, NativeContext, SchemaBuilder } from "./omp/batch-native.ts";
import type { FactoryAction, SelectedItem } from "./core/batch.ts";
import { resolveToken } from "../bluefin-review/github.ts";
import { runPackagedBatchProbe } from "./omp/batch-probe.ts";

interface ToolContent {
	type: "text";
	text: string;
}

interface ToolResult {
	content: ToolContent[];
	details?: unknown;
	isError?: boolean;
}

interface ToolUpdate {
	readonly content?: readonly ToolContent[];
	readonly [key: string]: unknown;
}

interface NativeInvokeContext extends FactoryCtx {
	invokeTool?<TDetails = unknown>(
		params: Record<string, unknown>,
		options?: { signal?: AbortSignal; onUpdate?: (update: ToolUpdate) => void },
	): Promise<ToolResult & { details?: TDetails }>;
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
	readonly defaultInactive?: boolean;
	readonly loadMode?: "essential" | "discoverable";
	execute(
		toolCallId: string,
		params: Record<string, unknown>,
		signal?: AbortSignal,
		onUpdate?: (update: ToolUpdate) => void,
		ctx?: NativeInvokeContext,
	): Promise<ToolResult>;
}

/** What the entry point returns to the host. */
export interface LunaFactoryExtension {
	/** `session_start` returns before its own work is finished; this awaits the second moment. */
	whenStarted(): Promise<void>;
}

export interface FactoryHost {
	zod: ZodLike;
	pi?: NativeSDK;
	/** OMP's native schema builder; required to register a same-name task wrapper. */
	arktype?(definition: unknown): unknown;
	registerTool(definition: FactoryToolDefinition): void;
	/** OMP 18.x tool activation seam. Optional for older/headless test hosts. */
	getActiveTools?(): string[];
	setActiveTools?(toolNames: string[]): Promise<void> | void;
	registerCommand?(name: string, definition: { description: string; handler(args: string, ctx: FactoryCtx): unknown }): void;
	appendEntry(customType: string, data?: unknown): void;
	setLabel(label: string): void;
	on(event: string, handler: (event: unknown, ctx: FactoryCtx) => unknown): void;
	sendUserMessage?(content: string, options?: { deliverAs?: string }): void;
}

interface FactoryCtx extends SessionCtx, NativeContext {
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
const CRITERION_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

const FACTORY_TOOL_NAMES = [
	"luna_factory_status",
	"luna_factory_open",
	"luna_factory_candidate",
	"luna_factory_attempt",
	"luna_factory_dispatch",
	"luna_factory_receipt",
	"luna_factory_integrate",
	"luna_factory_reconcile",
	"luna_factory_replan",
	"luna_factory_reopen",
	"luna_factory_finish",
	"luna_factory_why",
	"luna_factory_control",
	"luna_factory_completion",
] as const;

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

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

interface OpenContract {
	readonly nonGoals: readonly string[];
	readonly permittedEffects: readonly Effect[];
	readonly finishAuthority: string;
	readonly appetite: Appetite;
}

type OpenContractResult = { readonly ok: true; readonly value: OpenContract } | { readonly ok: false; readonly error: string };

function optionValue(payload: Record<string, unknown>, options: Record<string, unknown>, name: string): unknown {
	return options[name] === undefined ? payload[name] : options[name];
}

function boundedOptionText(value: unknown, field: string): { readonly ok: true; readonly value: string } | { readonly ok: false; readonly error: string } {
	if (typeof value !== "string" || value.trim().length === 0) return { ok: false, error: `${field} must be a non-empty string` };
	if (value.length > 2_000) return { ok: false, error: `${field} exceeds 2000 characters` };
	return { ok: true, value };
}

function optionStringList(value: unknown, field: string): { readonly ok: true; readonly value: readonly string[] } | { readonly ok: false; readonly error: string } {
	if (!Array.isArray(value)) return { ok: false, error: `${field} must be an array of non-empty strings` };
	if (value.length > 64) return { ok: false, error: `${field} exceeds 64 entries` };
	const values: string[] = [];
	for (const [index, entry] of value.entries()) {
		const parsed = boundedOptionText(entry, `${field}[${index}]`);
		if (!parsed.ok) return parsed;
		values.push(parsed.value);
	}
	return { ok: true, value: values };
}

function optionEffects(value: unknown): { readonly ok: true; readonly value: readonly Effect[] } | { readonly ok: false; readonly error: string } {
	if (!Array.isArray(value)) return { ok: false, error: "permittedEffects must be an array containing only read and write" };
	if (value.length > 2) return { ok: false, error: "permittedEffects may contain at most read and write" };
	const effects: Effect[] = [];
	for (const entry of value) {
		if (entry !== "read" && entry !== "write") return { ok: false, error: "permittedEffects may contain only read and write" };
		if (effects.includes(entry)) return { ok: false, error: `permittedEffects contains duplicate '${entry}'` };
		effects.push(entry);
	}
	return { ok: true, value: effects };
}

function optionAppetite(value: unknown): { readonly ok: true; readonly value: Appetite } | { readonly ok: false; readonly error: string } {
	if (value === undefined) return { ok: true, value: { tasks: 8, attemptsPerTask: 2 } };
	if (!isRecord(value)) return { ok: false, error: "appetite must be {tasks, attemptsPerTask}" };
	const tasks = value.tasks;
	const attemptsPerTask = value.attemptsPerTask;
	if (!Number.isInteger(tasks) || !Number.isInteger(attemptsPerTask) || tasks < 1 || attemptsPerTask < 1 || tasks > 64 || attemptsPerTask > 64) {
		return { ok: false, error: "appetite.tasks and appetite.attemptsPerTask must be integers from 1 through 64" };
	}
	return { ok: true, value: { tasks, attemptsPerTask } };
}

function parseOpenContract(payload: Record<string, unknown>): OpenContractResult {
	const rawOptions = payload.options;
	const options = rawOptions === undefined ? {} : rawOptions;
	if (!isRecord(options)) return { ok: false, error: "options must be an object when supplied" };

	const rawNonGoals = optionValue(payload, options, "nonGoals");
	const nonGoals = rawNonGoals === undefined ? { ok: true as const, value: [] as readonly string[] } : optionStringList(rawNonGoals, "nonGoals");
	if (!nonGoals.ok) return nonGoals;

	const rawEffects = optionValue(payload, options, "permittedEffects");
	const permittedEffects = rawEffects === undefined ? { ok: true as const, value: ["read"] as readonly Effect[] } : optionEffects(rawEffects);
	if (!permittedEffects.ok) return permittedEffects;

	const rawFinish = optionValue(payload, options, "finishAuthority") ?? optionValue(payload, options, "finishDeliverable");
	const finishAuthority = rawFinish === undefined ? { ok: true as const, value: DEFAULT_FINISH_AUTHORITY } : boundedOptionText(rawFinish, "finishAuthority");
	if (!finishAuthority.ok) return finishAuthority;

	const appetite = optionAppetite(optionValue(payload, options, "appetite"));
	if (!appetite.ok) return appetite;

	return { ok: true, value: { nonGoals: nonGoals.value, permittedEffects: permittedEffects.value, finishAuthority: finishAuthority.value, appetite: appetite.value } };
}

interface NativeTaskBinding {
	readonly taskId: TaskId;
	readonly attemptId: string;
	readonly index: number;
}

const NATIVE_IDENTITY_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const DISPATCH_MARKER_RE = new RegExp(
	`${DISPATCH_MARKER}\\s+task=([A-Za-z0-9][A-Za-z0-9._:-]{0,127})\\s+attempt=([A-Za-z0-9][A-Za-z0-9._:-]{0,127})\\s+generation=([A-Za-z0-9][A-Za-z0-9._:-]{0,127})`,
);

function nativeTaskBindings(params: Record<string, unknown>, current: Ledger): { readonly ok: true; readonly bindings: readonly NativeTaskBinding[] } | { readonly ok: false; readonly error: string } {
	const rawItems: unknown[] = Array.isArray(params.tasks) ? params.tasks : [params];
	if (rawItems.length === 0) return { ok: false, error: "native task call must contain at least one assignment" };
	const bindings: NativeTaskBinding[] = [];
	for (const [index, rawItem] of rawItems.entries()) {
		if (!isRecord(rawItem) || typeof rawItem.task !== "string" || rawItem.task.trim().length === 0) {
			return { ok: false, error: `native task item ${index + 1} has no assignment` };
		}
		const match = rawItem.task.match(DISPATCH_MARKER_RE);
		if (match === null) {
			return { ok: false, error: `native task item ${index + 1} must carry a ledger-stamped ${dispatchMarker("task", "attempt", "generation")} assignment` };
		}
		const [, taskId, attemptId, generation] = match;
		if (generation !== current.generation) return { ok: false, error: `native task item ${index + 1} is for stale generation ${generation}` };
		const task = findTask(current, taskId as TaskId);
		const attempt = task?.attempts.find((candidate) => candidate.id === attemptId);
		if (task === undefined || attempt === undefined) return { ok: false, error: `native task item ${index + 1} names an unknown Factory task or attempt` };
		if (task.effect === "write" && rawItem.isolated !== true) {
			return { ok: false, error: `native task item ${index + 1} is a write task and requires isolated:true before delegation` };
		}
		if (current.control !== "active") return { ok: false, error: `run is ${current.control}; native task admission is closed` };
		if (task.state !== "RUNNING" || task.decision !== "ADMIT" || attempt.state !== "started") {
			return { ok: false, error: `native task item ${index + 1} is not bound to an admitted running attempt` };
		}
		if (attempt.subject.repo !== current.subject.repo || attempt.subject.base !== current.subject.base || attempt.subject.head !== current.subject.head) {
			return { ok: false, error: `native task item ${index + 1} is bound to a stale Factory subject` };
		}
		bindings.push({ taskId: task.id, attemptId: attempt.id, index });
	}
	return { ok: true, bindings };
}

interface NativeTaskIdentities {
	readonly jobId?: NativeJobId;
	readonly resultIdsByIndex: ReadonlyMap<number, NativeJobId>;
	readonly unindexedResultIds: readonly NativeJobId[];
}

function nativeTaskIdentities(details: unknown): NativeTaskIdentities {
	if (!isRecord(details)) return { resultIdsByIndex: new Map(), unindexedResultIds: [] };
	let jobId: NativeJobId | undefined;
	if (isRecord(details.async) && typeof details.async.jobId === "string" && NATIVE_IDENTITY_RE.test(details.async.jobId)) {
		jobId = details.async.jobId as NativeJobId;
	}
	const resultIdsByIndex = new Map<number, NativeJobId>();
	const unindexedResultIds: NativeJobId[] = [];
	if (Array.isArray(details.results)) {
		for (const result of details.results) {
			if (!isRecord(result) || typeof result.id !== "string" || !NATIVE_IDENTITY_RE.test(result.id)) continue;
			const id = result.id as NativeJobId;
			if (typeof result.index === "number" && Number.isInteger(result.index) && result.index >= 0) resultIdsByIndex.set(result.index, id);
			else unindexedResultIds.push(id);
		}
	}
	return { jobId, resultIdsByIndex, unindexedResultIds };
}

export function createLunaFactoryExtension(host: FactoryHost, options: FactoryOptions = {}): LunaFactoryExtension {
	const env = options.env ?? process.env;
	const artifactRoots = options.artifactRoots ?? ["artifact://"];
	let ledger: Ledger | undefined;
	let loadProblem: string | undefined;
	const nativeTaskParameters = host.arktype?.("object");
	let nativeTaskWrapperRegistered = false;

	const enabled = (): boolean => env[ENABLE_FLAG] === "1";

	/**
	 * Keep the native task visible until a Factory ledger owns this session's
	 * execution. Once registered, the same-name wrapper remains the fail-closed
	 * boundary for the lifetime of that Factory-owned session.
	 */
	const registerNativeTaskWrapper = (): void => {
		if (nativeTaskWrapperRegistered || !enabled() || ledger === undefined || nativeTaskParameters === undefined) return;
		host.registerTool({
			name: "task",
			label: "Task",
			description: "Run an OMP task that is already bound to an admitted Luna Factory attempt.",
			parameters: nativeTaskParameters,
			async execute(_toolCallId, params, signal, onUpdate, rawContext) {
				const context = rawContext as NativeInvokeContext | undefined;
				if (loadProblem !== undefined) {
					return { content: text(`native task refused: Factory journal is unreadable: ${loadProblem}`), isError: true };
				}
				if (ledger === undefined || !enabled()) {
					if (context?.invokeTool === undefined) {
						return { content: text("native task delegation is unavailable on this OMP host"), isError: true };
					}
					return context.invokeTool(params, { signal, onUpdate });
				}
				const bindings = nativeTaskBindings(params, ledger);
				if (!bindings.ok) return { content: text(bindings.error), isError: true };
				if (context?.invokeTool === undefined) {
					return { content: text("native task is unsupported: OMP did not expose same-name ctx.invokeTool"), isError: true };
				}
				let result: ToolResult & { details?: unknown };
				try {
					result = await context.invokeTool(params, { signal, onUpdate });
				} catch (error) {
					return { content: text(`native task failed before a result could be correlated: ${error instanceof Error ? error.message : String(error)}`), isError: true };
				}

				const identities = nativeTaskIdentities(result.details);
				for (const binding of bindings.bindings) {
					const indexed = identities.resultIdsByIndex.get(binding.index);
					const resultIds = indexed === undefined
						? bindings.bindings.length === 1
							? [...identities.unindexedResultIds, ...identities.resultIdsByIndex.values()]
							: []
						: [indexed];
					const current = ledger;
					if (current === undefined) break;
					const event: LedgerEvent | undefined =
						identities.jobId === undefined
							? undefined
							: {
									kind: "record_native_job",
									expectedRevision: current.revision,
									taskId: binding.taskId,
									attemptId: binding.attemptId,
									jobId: identities.jobId,
									resultIds,
								  };
					const correlated = event === undefined
						? resultIds.reduce<ReduceResult>(
							(currentResult, resultId) =>
								currentResult.ok
									? reduce(
											currentResult.ledger,
											{
												kind: "record_native_result",
												expectedRevision: currentResult.ledger.revision,
												taskId: binding.taskId,
												attemptId: binding.attemptId,
												resultId,
											},
											{ artifactRoots },
										)
									: currentResult,
							{ ok: true, ledger: current },
						  )
						: reduce(current, event, { artifactRoots });
					if (correlated.ok) commit(correlated.ledger);
					else host.appendEntry("com.joshyorko.luna-factory.native-correlation", { taskId: binding.taskId, attemptId: binding.attemptId, error: correlated.error });
				}
				return result;
			},
		});
		nativeTaskWrapperRegistered = true;
	};

	/** Persist only through the journal, so every mutation survives a reload. */
	const commit = (next: Ledger): void => {
		saveRun(host, next);
		ledger = next;
		registerNativeTaskWrapper();
	};

	const z = host.zod;
	const jsonParameters = z.object({ input: z.string().describe("JSON payload for this command") });

	const registerTool = (definition: FactoryToolDefinition): void => {
		host.registerTool({
			...definition,
			parameters: jsonParameters,
			defaultInactive: !enabled(),
			loadMode: "essential",
		});
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

	const statusText = (): string => {
		if (ledger === undefined) {
			const lines = [loadProblem ?? "no Factory run is open"];
			lines.push(`execution: ${enabled() ? "enabled" : `idle (${ENABLE_FLAG}=1 to enable)`}`);
			lines.push(`enforced: ${enforcedPaths().join(", ")}`);
			lines.push(`unsupported: ${unsupportedPaths().join(", ")}`);
			return lines.join("\n");
		}
		return [
			...renderStatusDetail(ledger),
			"",
			`execution: ${enabled() ? "enabled" : `idle (${ENABLE_FLAG}=1 to enable)`}`,
			`enforced: ${enforcedPaths().join(", ")}`,
			`observed/unsupported: ${unsupportedPaths().join(", ")}`,
		].join("\n");
	};

	const notifyCommand = (ctx: FactoryCtx, message: string, level: string = "info"): void => {
		if (ctx.ui?.notify !== undefined) {
			ctx.ui.notify(message, level);
			return;
		}
		// Headless callers already have the namespaced tools. Do not start a model
		// turn merely to print a read-only command result.
		host.appendEntry("com.joshyorko.luna-factory.command", { command: "factory", message });
	};

	const controlSummary = (control: "active" | "paused" | "draining" | "interrupted", next: Ledger): string => {
		if (control !== "interrupted") return `run is ${next.control}`;
		const jobs = next.tasks
			.filter((task) => task.state === "RUNNING" || task.state === "VERIFY")
			.flatMap((task) => task.attempts.flatMap((attempt) => attempt.nativeJobIds));
		const lines = ["run is interrupted; no new admission will start."];
		lines.push(
			jobs.length === 0
				? "no recorded native job ids to cancel; reconcile with luna_factory_status before resuming. no external effect is rolled back."
				: `recorded native job ids to cancel through OMP: ${jobs.join(", ")}. Factory does not cancel them itself, and no external effect is rolled back.`,
		);
		return lines.join("\n");
	};

	let batchService: BatchService | undefined;
	const batches = (): BatchService => {
		if (!enabled()) throw new Error("Factory is disabled; explicitly enable LUNA_FACTORY_ENABLED=1");
		if (ledger) throw new Error("A single-subject journal is open; preserve it and use a fresh native session for selected batches");
		if (loadProblem !== undefined) throw new Error(`Factory journal is unreadable: ${loadProblem}; preserve it before starting a selected batch`);
		if (!batchService) {
			const capacity = Number(env.LUNA_FACTORY_CAPACITY ?? "2");
			if (!Number.isSafeInteger(capacity) || capacity < 1 || capacity > 100) throw new Error("LUNA_FACTORY_CAPACITY must be between 1 and 100");
			batchService = new BatchService(factoryStateRoot(env), new BatchGitHub(resolveToken(env)), host.pi, host.zod as unknown as SchemaBuilder, capacity, factoryClaimsRoot(env));
		}
		return batchService;
	};
	const batchCommand = async (raw: string, context: unknown): Promise<string> => {
		const ctx = context as FactoryCtx;
		const [verb = "status", id, ...rest] = raw.trim().split(/\s+/);
		if (verb === "claims") {
			const claims = new ResourceClaims(factoryStateRoot(env), factoryClaimsRoot(env));
			if (id === undefined || id === "status" || id === "inspect") {
				const current = claims.list();
				return current.length === 0 ? "No mutation claims." : current.map((claim) => `${claim.resource} is owned by ${claim.owner} [${claim.status}] (${claim.createdAt})`).join("\n");
			}
			if (id !== "reconcile") throw new Error("usage: /factory claims status | claims reconcile <owner> <resource>");
			const owner = rest[0];
			const resource = rest.slice(1).join(" ");
			if (!owner || !resource) throw new Error("usage: /factory claims reconcile <owner> <resource>");
			const verifier = (ctx as FactoryCtx & { reconcileMutationClaim?: (owner: string, resource: string) => Promise<"settled" | "unknown"> }).reconcileMutationClaim;
			if (!verifier) throw new Error(`${resource} remains UNKNOWN; Review must provide authoritative worker/external-effect reconciliation`);
			if (await verifier(owner, resource) !== "settled") return `Retained ${resource} for ${owner}; external effect remains UNKNOWN`;
			claims.reconcile(resource, owner);
			return `Reconciled ${resource} for ${owner}; claim released`;
		}
		const service = batches();
		if (verb === "start" || verb === "selected" || verb === "run") {
			let items: SelectedItem[];
			let settings: Partial<BatchOptions> = {};
			if (verb === "run") {
				const payload = JSON.parse(raw.trim().slice(4));
				if (!isRecord(payload) || !Array.isArray(payload.items)) throw new Error("run requires an explicit JSON items array");
				items = payload.items as SelectedItem[];
				settings = payload as Partial<BatchOptions>;
			} else {
				if (!["inspect", "patch", "pr-ready"].includes(id ?? "")) throw new Error("choose start inspect|patch|pr-ready; selection never grants merge/deploy authority");
				items = selectedFactoryItems(id as FactoryAction);
			}
			const batch = await service.submit(items, { capacity: settings.capacity ?? service.capacity, maxAttempts: settings.maxAttempts ?? 3, maxTotalAttempts: settings.maxTotalAttempts ?? items.length * 3, mode: settings.mode ?? "once", dependencies: settings.dependencies });
			const preflight = service.status(batch.id);
			notifyCommand(ctx, preflight);
			await service.resume(batch.id, ctx);
			if (!ctx.hasUI) await service.waitForIdle();
			return service.status(batch.id);
		}
		if (verb === "status" || verb === "inspect") return service.status(id);
		if (!id) throw new Error("an exact batch id is required; use /factory status");
		if (verb === "pause" || verb === "stop") await service.control(id, verb);
		else if (verb === "resume") { await service.resume(id, ctx); if (!ctx.hasUI) await service.waitForIdle(); }
		else if (verb === "retry") { if (!rest[0]) throw new Error("retry requires an exact item key"); await service.retry(id, rest[0], ctx); if (!ctx.hasUI) await service.waitForIdle(); }
		else if (verb === "exclude") service.exclude(id, rest[0] ?? "", rest.slice(1).join(" "));
		else if (verb === "export") { if (!rest.length) throw new Error("export requires an unused destination directory"); return service.store.export(id, rest.join(" ")); }
		else if (verb === "discard") { service.store.acquire(); service.store.discard(id); return `Archived ${id}; native logs and workspaces retained`; }
		else throw new Error("usage: /factory start inspect|patch|pr-ready | status | inspect/resume/pause/stop <batch> | retry <batch> <item> | exclude <batch> <item> <reason> | export <batch> <directory> | discard <batch>");
		return service.status(id);
	};
	const unregisterBatchController = registerFactoryController(batchCommand);
	host.on("session_shutdown", async () => { unregisterBatchController(); await batchService?.shutdown(); });
	if (env.LUNA_FACTORY_PACKAGED_BATCH_PROBE === "1") {
		registerTool({
			name: "luna_factory_packaged_batch_probe",
			label: "Factory Packaged Batch Probe",
			description: "Test-only deterministic BatchService vertical; requires the packaged probe flag and never uses external GitHub or provider credentials.",
			async execute(_toolCallId, _params) {
				const phase = env.LUNA_FACTORY_BATCH_PROBE_PHASE === "resume" ? "resume" : "seed";
				const result = await runPackagedBatchProbe({ root: factoryStateRoot(env), phase });
				return { content: text(`BATCH_PROBE ${JSON.stringify(result)}`), details: result };
			},
		});
	}

	if (host.registerCommand !== undefined) {
		host.registerCommand("factory", {
			description: "Open or inspect the opt-in Luna Factory run",
			handler: async (rawArgs, ctx) => {
				const args = rawArgs.trim();
				if (!ledger && (args.length === 0 || /^(start|selected|run|status|inspect|claims|pause|resume|stop|retry|exclude|export|discard)(\s|$)/.test(args))) {
					try { notifyCommand(ctx, await batchCommand(args || "status", ctx)); }
					catch (error) { notifyCommand(ctx, error instanceof Error ? error.message : String(error), "error"); }
					return;
				}
				if (args.length === 0 || args === "status") {
					notifyCommand(ctx, statusText());
					return;
				}
				if (args === "help") {
					notifyCommand(ctx, "usage: /factory <objective> | status | why <task-id> | pause | drain | resume | abort | -- <literal objective>");
					return;
				}
				if (args.startsWith("why ")) {
					const taskId = args.slice(4).trim();
					if (ledger === undefined) {
						notifyCommand(ctx, loadProblem ?? "no Factory run is open", "warning");
						return;
					}
					if (taskId.length === 0) {
						notifyCommand(ctx, "usage: /factory why <task-id>", "warning");
						return;
					}
					notifyCommand(ctx, renderWhy(ledger, taskId as TaskId).join("\n"));
					return;
				}
				const requestedControl = args === "pause" ? "paused" : args === "drain" ? "draining" : args === "resume" ? "active" : args === "abort" ? "interrupted" : undefined;
				if (requestedControl !== undefined) {
					const result = mutate(
						(current) => reduce(current, { kind: "set_control", expectedRevision: current.revision, control: requestedControl }, { artifactRoots }),
						(next) => controlSummary(requestedControl, next),
					);
					notifyCommand(ctx, result.content[0]!.text, result.isError === true ? "error" : "warning");
					return;
				}
				const objective = args.startsWith("--") ? args.slice(2).trim() : args;
				if (objective.length === 0) {
					notifyCommand(ctx, "a literal objective after /factory -- must be non-empty", "warning");
					return;
				}
				if (host.sendUserMessage === undefined) {
					notifyCommand(ctx, "this OMP host has no prompt handoff; use luna_factory_open with an explicit JSON contract", "error");
					return;
				}
				host.sendUserMessage(
					"The explicit operator objective for Luna Factory is:\n" +
						objective +
						"\nCapture the agreed generation, mandatory criteria, non-goals, permitted effects, finish authority, appetite, and exact repository subject before calling luna_factory_open. Do not infer write or merge authority; use the Factory tools and keep ordinary Review ownership unchanged.",
					{ deliverAs: "steer" },
				);
			},
		});
	}

	registerTool({
		name: "luna_factory_status",
		label: "Factory Status",
		description:
			"Report the current Luna Factory run: proven criteria, owned activity, blockers, dependencies, and routing. Reading status never starts work or changes a model.",
		async execute() {
			return { content: text(statusText()) };
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
			if (!isRecord(parsed.value)) return { content: text("Factory open input must be a JSON object"), isError: true };
			const payload = parsed.value;
			const objective = boundedOptionText(payload.objective, "objective");
			if (!objective.ok) return { content: text(objective.error), isError: true };
			const rawCriteria = payload.criteria;
			if (!Array.isArray(rawCriteria) || rawCriteria.length === 0) {
				return { content: text("criteria must be a non-empty array of {id, statement, mandatory}"), isError: true };
			}
			if (rawCriteria.length > 64) return { content: text("criteria exceeds 64 entries"), isError: true };
			if (typeof payload.repo !== "string" || typeof payload.base !== "string") {
				return { content: text("repo and base are required: evidence is bound to an exact subject"), isError: true };
			}
			if (loadProblem !== undefined) {
				return {
					content: text(`Factory journal is unreadable: ${loadProblem}; preserve the original evidence and repair or export it before opening a new run.`),
					isError: true,
				};
			}
			if (ledger !== undefined && payload.replace !== true) {
				return {
					content: text(
						`a Factory run is already open for '${ledger.goal.statement}'. A new objective must replace it explicitly with replace: true; a quoted objective is not authority to overwrite the current one.`,
					),
					isError: true,
				};
			}
			const contract = parseOpenContract(payload);
			if (!contract.ok) return { content: text(contract.error), isError: true };

			const criteria: Criterion[] = [];
			const criterionIds = new Set<string>();
			for (const entry of rawCriteria) {
				if (typeof entry !== "object" || entry === null) {
					return { content: text("each criterion must be an object"), isError: true };
				}
				const record = entry as Record<string, unknown>;
				if (typeof record.id !== "string" || !CRITERION_ID_RE.test(record.id)) {
					return { content: text("each criterion id must be a bounded identity"), isError: true };
				}
				if (criterionIds.has(record.id)) return { content: text(`criterion '${record.id}' is duplicated`), isError: true };
				const statement = boundedOptionText(record.statement, `criteria.${record.id}.statement`);
				if (!statement.ok) return { content: text(statement.error), isError: true };
				if (record.mandatory !== undefined && typeof record.mandatory !== "boolean") {
					return { content: text(`criteria.${record.id}.mandatory must be boolean when supplied`), isError: true };
				}
				criterionIds.add(record.id);
				criteria.push({
					id: record.id as Criterion["id"],
					statement: statement.value,
					mandatory: record.mandatory !== false,
				});
			}
			const parsedSubject = parseSubject(
				typeof payload.head === "string"
					? { repo: payload.repo, base: payload.base, head: payload.head }
					: { repo: payload.repo, base: payload.base },
			);
			if (!parsedSubject.ok) return { content: text(`subject rejected: ${parsedSubject.errors.join("; ")}`), isError: true };
			const subject: Subject = parsedSubject.value;
			const next = emptyLedger(`lf-${Date.now().toString(36)}` as RunId, {
				statement: objective.value,
				nonGoals: contract.value.nonGoals,
				permittedEffects: contract.value.permittedEffects,
				finishAuthority: contract.value.finishAuthority,
				appetite: contract.value.appetite,
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
		name: "luna_factory_reconcile",
		label: "Factory Reconcile",
		description:
			"Reconcile an interrupted native attempt as abandoned or liveness-unknown. This preserves native identities and retry lineage; it never invents a receipt or rolls back an external effect.",
		async execute(_toolCallId, params) {
			const parsed = parseArgument(params);
			if (!parsed.ok) return { content: text(parsed.error), isError: true };
			if (!isRecord(parsed.value)) return { content: text("reconcile input must be a JSON object"), isError: true };
			const payload = parsed.value;
			if (typeof payload.taskId !== "string" || typeof payload.attemptId !== "string") {
				return { content: text("taskId and attemptId are required"), isError: true };
			}
			if (payload.outcome !== "abandoned" && payload.outcome !== "unknown") {
				return { content: text("outcome must be abandoned or unknown"), isError: true };
			}
			if (typeof payload.reason !== "string" || payload.reason.trim().length === 0) {
				return { content: text("reason must explain the observed native outcome"), isError: true };
			}
			return mutate(
				(current) =>
					reduce(
						current,
						{
							kind: "reconcile_attempt",
							expectedRevision: current.revision,
							taskId: payload.taskId as TaskId,
							attemptId: payload.attemptId,
							outcome: payload.outcome,
							reason: payload.reason,
						},
						{ artifactRoots },
					),
				(next) => `attempt ${payload.attemptId} reconciled as ${payload.outcome}; run remains ${next.control} until explicitly resumed`,
			);
		},
	});

	registerTool({
		name: "luna_factory_integrate",
		label: "Factory Integrate",
		description:
			"Record the owner's explicit integration of a proven write attempt at a new repository subject. Factory never applies or rolls back the external change.",
		async execute(_toolCallId, params) {
			const parsed = parseArgument(params);
			if (!parsed.ok) return { content: text(parsed.error), isError: true };
			if (!isRecord(parsed.value)) return { content: text("integration input must be a JSON object"), isError: true };
			const payload = parsed.value;
			if (typeof payload.taskId !== "string" || typeof payload.attemptId !== "string") {
				return { content: text("taskId and attemptId are required"), isError: true };
			}
			const parsedSubject = parseSubject(payload.subject);
			if (!parsedSubject.ok) return { content: text(`integration subject rejected: ${parsedSubject.errors.join("; ")}`), isError: true };
			return mutate(
				(current) =>
					reduce(
						current,
						{
							kind: "integrate_attempt",
							expectedRevision: current.revision,
							taskId: payload.taskId as TaskId,
							attemptId: payload.attemptId,
							subject: parsedSubject.value,
						},
						{ artifactRoots },
					),
				(next) => `attempt ${payload.attemptId} integrated explicitly at ${next.subject.repo}@${next.subject.head ?? next.subject.base}; Factory applied no external change`,
			);
		},
	});

	registerTool({
		name: "luna_factory_replan",
		label: "Factory Replan",
		description:
			"Use the one bounded materially different same-goal replan, but only after two consecutive no-progress attempts have been recorded.",
		async execute(_toolCallId, params) {
			const parsed = parseArgument(params);
			if (!parsed.ok) return { content: text(parsed.error), isError: true };
			if (!isRecord(parsed.value)) return { content: text("replan input must be a JSON object"), isError: true };
			const payload = parsed.value;
			if (typeof payload.taskId !== "string") return { content: text("taskId is required"), isError: true };
			return mutate(
				(current) =>
					reduce(
						current,
						{ kind: "use_replan", expectedRevision: current.revision, taskId: payload.taskId as TaskId },
						{ artifactRoots },
					),
				(next) => `task ${payload.taskId} is READY for the one bounded replan; no-progress diagnosis remains recorded at ${next.noProgressAttempts}`,
			);
		},
	});

	registerTool({
		name: "luna_factory_reopen",
		label: "Factory Reopen",
		description:
			"Reopen a completed task only when the owner supplies new evidence of a legitimate defect; this invalidates its prior proof without authorizing successor work by itself.",
		async execute(_toolCallId, params) {
			const parsed = parseArgument(params);
			if (!parsed.ok) return { content: text(parsed.error), isError: true };
			if (!isRecord(parsed.value)) return { content: text("reopen input must be a JSON object"), isError: true };
			const payload = parsed.value;
			if (typeof payload.taskId !== "string") return { content: text("taskId is required"), isError: true };
			if (typeof payload.reason !== "string" || payload.reason.trim().length === 0) {
				return { content: text("reason must name the new evidence that justifies reopening the task"), isError: true };
			}
			return mutate(
				(current) =>
					reduce(
						current,
						{ kind: "reopen_task", expectedRevision: current.revision, taskId: payload.taskId as TaskId, reason: payload.reason },
						{ artifactRoots },
					),
				(next) => `task ${payload.taskId} reopened for explicit owner evidence; prior proof is no longer current`,
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
			"Pause or drain admission, resume after reconciliation, or abort. Pause drains admitted work without claiming rollback; abort requests cancellation of owned work and never retracts external effects.",
		async execute(_toolCallId, params) {
			const parsed = parseArgument(params);
			if (!parsed.ok) return { content: text(parsed.error), isError: true };
			const payload = parsed.value as { action?: unknown };
			const control = payload.action === "pause" ? "paused" : payload.action === "drain" ? "draining" : payload.action === "resume" ? "active" : payload.action === "abort" ? "interrupted" : undefined;
			if (control === undefined) return { content: text("action must be pause, drain, resume, or abort"), isError: true };
			const result = mutate(
				(current) => reduce(current, { kind: "set_control", expectedRevision: current.revision, control }, { artifactRoots }),
				(next) => controlSummary(control, next),
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

	// Discoverable extension tools are not guaranteed to be in OMP's initial
	// active set. Activate them from session_start, after OMP has initialized the
	// runtime action methods. The host's setter waits for OMP's registration
	// barrier, so the first model turn sees the complete Factory surface.
	const activateFactoryTools = async (): Promise<void> => {
		if (!enabled() || host.getActiveTools === undefined || host.setActiveTools === undefined) return;
		const activeTools = host.getActiveTools();
		const nativeNames = nativeTaskWrapperRegistered ? ["task"] : [];
		const nextActiveTools = [...new Set([...activeTools, ...FACTORY_TOOL_NAMES, ...nativeNames])];
		try {
			await host.setActiveTools(nextActiveTools);
		} catch (error) {
			host.appendEntry("com.joshyorko.luna-factory.activation", {
				error: error instanceof Error ? error.message : String(error),
			});
		}
	};

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
	host.on("session_start", async (_event, ctx) => {
		const loaded = loadRun(ctx);
		ledger = loaded.ledger;
		loadProblem = loaded.problem;
		if (loaded.problem !== undefined && ctx.hasUI) {
			ctx.ui?.notify?.(`Factory journal is unreadable: ${loaded.problem}`, "error");
		}
		registerNativeTaskWrapper();
		await activateFactoryTools();
	});
	host.on("session_stop", (_event, ctx) => settle(ctx));

	return {
		async whenStarted() {
			return;
		},
	};
}

/** Native OMP package entrypoint. The pure/core adapter remains directly testable. */
export default function lunaFactoryExtension(pi: FactoryHost): void {
	try {
		createLunaFactoryExtension(pi);
	} catch (error) {
		// Review reaches this module for its handoff, so a package that loads but
		// throws must leave a bounded reason behind instead of a bare "not loaded".
		reportFactoryLoadFailure(error instanceof Error ? error.message : String(error));
		throw error;
	}
}
