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
import type { Appetite, Criterion, Effect, Ledger, NativeAgentId, NativeJobId, ReduceResult, RunId, Subject, TaskId } from "./core/model.ts";
import { findTask } from "./core/model.ts";
import { renderCompletionReceipt } from "./core/receipt.ts";
import { reduce } from "./core/reducer.ts";
import { parseCandidate, parseProofAssumptions, parseReceipt, parseSubject } from "./core/schema.ts";
import { buildDispatchPrompt, DISPATCH_MARKER, dispatchMarker } from "./omp/adapter.ts";
import { coverageFor, enforcedPaths, unsupportedPaths } from "./omp/capabilities.ts";
import { type SessionCtx, loadRun, saveRun, loadDashboardPresentation, saveDashboardPresentation } from "./omp/session.ts";
import { renderStatusDetail, renderWhy, truncatePlain } from "./ui/status.ts";
import { BatchService, type BatchOptions, type BatchSnapshot, type BatchHistoryCursor } from "./omp/batch-service.ts";
import { BatchGitHub } from "./omp/batch-github.ts";
import { factoryClaimsRoot, factoryStateRoot, ResourceClaims } from "./omp/batch-store.ts";
import { registerFactoryController, registerFactoryBatchSubmitter, registerFactoryDashboardOpener, registerFactoryDashboardReader, registeredFactoryReconciler, registeredFactoryClaimInspector, reportFactoryLoadFailure, selectedFactoryItems } from "./omp/batch-bridge.ts";
import type { NativeSDK, NativeContext, SchemaBuilder } from "./omp/batch-native.ts";
import type { FactoryAction, SelectedItem } from "./core/batch.ts";
import { resolveToken } from "../bluefin-review/github.ts";
import { runPackagedBatchProbe } from "./omp/batch-probe.ts";
import { FactoryDashboard, type FactoryDashboardAction, type FactoryDashboardPresentation, type FactoryDashboardSnapshot, type FactoryDashboardPrimitives, type FactoryDashboardTheme } from "./ui/dashboard.ts";
import { readBoundedEvidence } from "./ui/evidence.ts";
import { EvidenceViewer } from "./ui/evidence-viewer.ts";
import { dashboardActionAllowed } from "./ui/actions.ts";
import { rawKeyMatcher, type KeyMatcher } from "../bluefin-review/keys.ts";

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

interface NativeAgentSessionLike {
	subscribe(listener: (event: unknown) => void): () => void;
}

interface NativeAgentRefLike {
	readonly id: string;
	readonly kind: string;
	readonly session: NativeAgentSessionLike | null;
}

interface NativeAgentRegistryLike {
	get(id: string): NativeAgentRefLike | undefined;
	onChange(listener: (event: unknown) => void): () => void;
}

interface NativeInvokeContext extends FactoryCtx {
	invokeTool?<TDetails = unknown>(
		params: Record<string, unknown>,
		options?: { signal?: AbortSignal; onUpdate?: (update: ToolUpdate) => void },
	): Promise<ToolResult & { details?: TDetails }>;
	/** Test seam; production loads OMP's existing global registry lazily. */
	agentRegistry?: NativeAgentRegistryLike;
}

interface SchemaLike {
	optional(): SchemaLike;
	describe(text: string): SchemaLike;
}

interface ZodLike {
	object(shape: Record<string, unknown>): SchemaLike;
	string(): SchemaLike;
	number(): SchemaLike;
	boolean(): SchemaLike;
	array(item: unknown): SchemaLike;
	enum(values: readonly [string, ...string[]]): SchemaLike;
	literal(value: string | number | boolean): SchemaLike;
	union(values: readonly unknown[]): SchemaLike;
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
	exec?(command: string, args: string[], options?: { timeout?: number }): Promise<{ code: number; killed?: boolean }>;
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
	ui?: {
		notify(message: string, level?: string): void;
		theme?: { fg(color: string, text: string): string; bold(text: string): string; inverse(text: string): string };
		custom?<T>(factory: (tui: unknown, theme: unknown, keybindings: unknown, done: (result: T) => void) => unknown, options?: unknown): Promise<T>;
		confirm?(title: string, message: string): Promise<boolean>;
		input?(title: string, placeholder?: string): Promise<string | undefined>;
		editor?(title: string, prefill?: string, options?: unknown, editorOptions?: { promptStyle?: boolean }): Promise<string | undefined>;
		pasteToEditor?(text: string): void;
		setTitle?(title: string): void;
	};
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

interface FactoryToolSchemas {
	readonly empty: unknown;
	readonly open: unknown;
	readonly candidate: unknown;
	readonly attempt: unknown;
	readonly dispatch: unknown;
	readonly receipt: unknown;
	readonly reconcile: unknown;
	readonly integrate: unknown;
	readonly replan: unknown;
	readonly reopen: unknown;
	readonly finish: unknown;
	readonly why: unknown;
	readonly control: unknown;
}

function factoryToolSchemas(z: ZodLike): FactoryToolSchemas {
	const subject = z.object({
		repo: z.string().describe("canonical repository identity in owner/name form"),
		base: z.string().describe("exact git revision for the current subject"),
		head: z.string().describe("optional exact git revision").optional(),
	});
	const assumptions = z.array(z.object({
		kind: z.enum(["acceptance-revision", "dependency-outcome"]),
		value: z.string(),
		taskId: z.string().describe("required for dependency-outcome").optional(),
	}));
	const appetite = z.object({
		tasks: z.number().describe("integer from 1 through 64"),
		attemptsPerTask: z.number().describe("integer from 1 through 64"),
	});
	const openOptions = z.object({
		nonGoals: z.array(z.string()).optional(),
		permittedEffects: z.array(z.enum(["read", "write"])).optional(),
		finishAuthority: z.string().optional(),
		finishDeliverable: z.string().optional(),
		appetite: appetite.optional(),
	});
	const criterion = z.object({
		id: z.string(),
		statement: z.string(),
		mandatory: z.boolean().describe("defaults to true").optional(),
		assumptions: assumptions.optional(),
	});
	const testClaim = z.object({
		command: z.string(),
		outcome: z.enum(["pass", "fail", "not-run"]),
		artifact: z.string().optional(),
	});
	const routing = z.object({
		requested: z.string().optional(),
		effective: z.string().optional(),
		effort: z.string().optional(),
		verified: z.boolean(),
	});
	const semanticResult = z.object({
		kind: z.enum(["inspection", "finding"]),
		outcome: z.enum(["no-finding", "supported", "disproven", "uncertain"]),
		summary: z.string(),
		verified: z.boolean(),
		publicationAuthority: z.literal("none"),
		publicationBlocker: z.string().optional(),
	});
	const predicates = z.array(z.object({
		phase: z.enum(["worker", "verification", "acceptance"]),
		item: z.string(),
		ok: z.boolean(),
		note: z.string(),
	}));
	const receiptFields = {
		taskId: z.string(),
		attemptId: z.string(),
		generation: z.string(),
		subject,
		result: z.string(),
		changed: z.array(z.string()),
		evidence: z.array(z.string()),
		tests: z.array(testClaim),
		cleanEnvironment: z.union([z.boolean(), z.literal("unknown")]),
		unresolved: z.array(z.string()),
		next: z.string(),
		confidence: z.enum(["low", "medium", "high"]),
		routing,
		exitCode: z.number().describe("integer process exit code"),
		aborted: z.boolean(),
		truncated: z.boolean(),
	};
	const receipt = z.union([
		z.object({
			version: z.literal(1),
			...receiptFields,
		}),
		z.object({
			version: z.literal(2),
			...receiptFields,
			assumptions,
			semanticResult: semanticResult.optional(),
			predicates,
		}),
	]);
	return {
		empty: z.object({}),
		open: z.object({
			repo: z.string().describe("canonical repository identity in owner/name form"),
			base: z.string().describe("exact git revision for the current subject"),
			head: z.string().describe("optional exact git revision").optional(),
			objective: z.string(),
			criteria: z.array(criterion),
			nonGoals: z.array(z.string()).optional(),
			permittedEffects: z.array(z.enum(["read", "write"])).optional(),
			finishAuthority: z.string().optional(),
			finishDeliverable: z.string().optional(),
			appetite: appetite.optional(),
			replace: z.boolean().optional(),
			options: openOptions.describe("legacy nested form accepted by the current ledger adapter").optional(),
		}),
		candidate: z.object({
			taskId: z.string(),
			generation: z.string(),
			criterionId: z.string(),
			title: z.string(),
			deps: z.array(z.string()).optional(),
			effect: z.enum(["read", "write"]),
			owner: z.string(),
			necessity: z.string(),
		}),
		attempt: z.object({ taskId: z.string(), attemptId: z.string() }),
		dispatch: z.object({ taskId: z.string(), attemptId: z.string(), path: z.string().optional() }),
		receipt,
		reconcile: z.object({
			taskId: z.string(),
			attemptId: z.string(),
			outcome: z.enum(["abandoned", "unknown"]),
			reason: z.string(),
		}),
		integrate: z.object({ taskId: z.string(), attemptId: z.string(), subject }),
		replan: z.object({ taskId: z.string() }),
		reopen: z.object({ taskId: z.string(), reason: z.string() }),
		finish: z.object({ taskId: z.string() }),
		why: z.object({ taskId: z.string() }),
		control: z.object({ action: z.enum(["pause", "drain", "resume", "abort"]) }),
	};
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
		if (task.state !== "READY" || task.decision !== "ADMIT" || attempt.state !== "started" || attempt.nativeJobIds.length > 0 || attempt.nativeAgentIds.length > 0) {
			return { ok: false, error: `native task item ${index + 1} is not bound to an admitted attempt awaiting its first OMP execution` };
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
	readonly agentIdsByIndex: ReadonlyMap<number, NativeAgentId>;
	readonly unindexedAgentIds: readonly NativeAgentId[];
}

function nativeTaskIdentities(details: unknown): NativeTaskIdentities {
	if (!isRecord(details)) return { agentIdsByIndex: new Map(), unindexedAgentIds: [] };
	let jobId: NativeJobId | undefined;
	if (isRecord(details.async) && typeof details.async.jobId === "string" && NATIVE_IDENTITY_RE.test(details.async.jobId)) {
		jobId = details.async.jobId as NativeJobId;
	}
	const agentIdsByIndex = new Map<number, NativeAgentId>();
	const unindexedAgentIds: NativeAgentId[] = [];
	const addAgent = (value: unknown): void => {
		if (!isRecord(value) || typeof value.id !== "string" || !NATIVE_IDENTITY_RE.test(value.id)) return;
		const id = value.id as NativeAgentId;
		if (typeof value.index === "number" && Number.isInteger(value.index) && value.index >= 0) agentIdsByIndex.set(value.index, id);
		else unindexedAgentIds.push(id);
	};
	if (Array.isArray(details.progress)) {
		for (const progress of details.progress) {
			if (!isRecord(progress)) continue;
			if (typeof progress.requests === "number" && progress.requests > 0) addAgent(progress);
		}
	}
	if (Array.isArray(details.results)) {
		for (const result of details.results) {
			if (isRecord(result) && typeof result.requests === "number" && result.requests > 0) addAgent(result);
		}
	}
	return { jobId, agentIdsByIndex, unindexedAgentIds };
}

interface NativeAgentSteeringWatch {
	readonly id: string;
	session?: NativeAgentSessionLike;
	binding?: NativeTaskBinding;
	steered: boolean;
	unsubscribe?: () => void;
}

interface NativeAgentSteeringObserver {
	bind(agentId: NativeAgentId, binding: NativeTaskBinding): boolean;
	finishCall(): void;
	sync(current: Ledger): void;
	isClosed(): boolean;
	wasSteered(binding: NativeTaskBinding): boolean;
}

function nativeAgentSteeringKey(binding: NativeTaskBinding): string {
	return `${binding.taskId}\u0000${binding.attemptId}`;
}

function createNativeAgentSteeringObserver(
	registry: NativeAgentRegistryLike,
	onSteering: (binding: NativeTaskBinding, agentId: NativeAgentId) => void,
): NativeAgentSteeringObserver {
	const watches = new Map<string, NativeAgentSteeringWatch>();
	const invalidated = new Set<string>();
	let acceptingNew = true;
	let registryUnsubscribe: (() => void) | undefined;
	let closed = false;

	const closeRegistry = (): void => {
		if (closed) return;
		registryUnsubscribe?.();
		registryUnsubscribe = undefined;
		closed = true;
	};
	const remove = (id: string): void => {
		watches.get(id)?.unsubscribe?.();
		watches.delete(id);
		if (!acceptingNew && watches.size === 0) closeRegistry();
	};

	const observe = (value: unknown): NativeAgentSteeringWatch | undefined => {
		if (!isRecord(value) || typeof value.id !== "string" || value.kind !== "sub") return undefined;
		const id = value.id;
		const previous = watches.get(id);
		const session = value.session as NativeAgentSessionLike | null;
		if (session === null || typeof session?.subscribe !== "function") {
			if (previous) {
				previous.unsubscribe?.();
				previous.unsubscribe = undefined;
				previous.session = undefined;
			}
			return previous;
		}
		if (previous?.session === session) return previous;
		previous?.unsubscribe?.();
		const watch = previous ?? { id, steered: false };
		watch.session = session;
		watch.unsubscribe = session.subscribe((event) => {
			if (!isRecord(event) || event.type !== "message_start" || !isRecord(event.message)) return;
			if (event.message.role !== "user" || event.message.attribution !== "user") return;
			if (watch.steered) return;
			watch.steered = true;
			if (watch.binding) {
				invalidated.add(nativeAgentSteeringKey(watch.binding));
				onSteering(watch.binding, id as NativeAgentId);
			}
		});
		watches.set(id, watch);
		return watch;
	};

	registryUnsubscribe = registry.onChange((event) => {
		if (!isRecord(event) || !isRecord(event.ref) || typeof event.ref.id !== "string") return;
		if (event.type === "removed") {
			remove(event.ref.id);
			return;
		}
		if (event.type === "registered" || event.type === "status_changed") {
			if (acceptingNew || watches.has(event.ref.id)) observe(event.ref);
		}
	});

	return {
		bind(agentId, binding) {
			const bindingKey = nativeAgentSteeringKey(binding);
			if (invalidated.has(bindingKey)) return true;
			if (closed) return false;
			let watch = watches.get(agentId);
			if (!watch) {
				const ref = registry.get(agentId);
				if (ref) watch = observe(ref);
			}
			if (!watch) return false;
			watch.binding = binding;
			if (watch.steered) {
				invalidated.add(bindingKey);
				onSteering(binding, agentId);
			}
			return true;
		},
		finishCall() {
			acceptingNew = false;
			for (const [id, watch] of watches) if (!watch.binding) remove(id);
			if (watches.size === 0) closeRegistry();
		},
		sync(current) {
			for (const [id, watch] of watches) {
				if (!watch.binding) continue;
				const task = findTask(current, watch.binding.taskId);
				if (task === undefined || task.state === "DONE" || task.state === "ESCALATE" || task.state === "BLOCKED" || watch.steered) {
					remove(id);
				}
			}
			if (!acceptingNew && watches.size === 0) closeRegistry();
		},
		wasSteered(binding) {
			return invalidated.has(nativeAgentSteeringKey(binding));
		},
		isClosed() {
			return closed;
		},
	};
}

// Keep this a literal dynamic import so OMP's compiled-extension rewriter can
// map its bundled registry; tests inject a fake because they lack that package.
async function loadNativeAgentRegistry(context: NativeInvokeContext): Promise<NativeAgentRegistryLike> {
	if (context.agentRegistry) return context.agentRegistry;
	const imported = await import("@oh-my-pi/pi-coding-agent/registry/agent-registry") as unknown as { AgentRegistry?: { global?: () => unknown } };
	const registry = imported.AgentRegistry?.global?.();
	if (!isRecord(registry) || typeof registry.get !== "function" || typeof registry.onChange !== "function") {
		throw new Error("OMP Agent Hub registry does not expose child observation");
	}
	return registry as unknown as NativeAgentRegistryLike;
}

function reconcileRestartedAttempts(ledger: Ledger, artifactRoots: readonly string[]): Ledger {
	const unfinished = ledger.tasks.flatMap((task) =>
		task.attempts
			.filter((attempt) => attempt.state === "started")
			.map((attempt) => ({ taskId: task.id, attempt })),
	);
	if (unfinished.length === 0) return ledger;
	let current = ledger;
	if (current.control !== "interrupted") {
		const interrupted = reduce(current, {
			kind: "set_control",
			expectedRevision: current.revision,
			control: "interrupted",
		}, { artifactRoots });
		if (!interrupted.ok) throw new Error(interrupted.error);
		current = interrupted.ledger;
	}
	for (const { taskId, attempt } of unfinished) {
		const identityObserved = attempt.nativeAgentIds.length > 0 || attempt.privateSessions.some((session) => session.started);
		const reconciled = reduce(current, {
			kind: "reconcile_attempt",
			expectedRevision: current.revision,
			taskId,
			attemptId: attempt.id,
			outcome: "unknown",
			reason: identityObserved
				? "Factory session restarted; the persisted OMP identity does not prove its child is still live"
				: "Factory session restarted without an observed child start; execution liveness is unknown",
		}, { artifactRoots });
		if (!reconciled.ok) throw new Error(reconciled.error);
		current = reconciled.ledger;
	}
	return current;
}

export function createLunaFactoryExtension(host: FactoryHost, options: FactoryOptions = {}): LunaFactoryExtension {
	const env = options.env ?? process.env;
	const artifactRoots = options.artifactRoots ?? ["artifact://"];
	let ledger: Ledger | undefined;
	let loadProblem: string | undefined;
	const nativeTaskParameters = host.arktype?.("object");
	let nativeTaskWrapperRegistered = false;
	const nativeSteeringObservers = new Set<NativeAgentSteeringObserver>();

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
				const recordNativeEvent = (event: LedgerEvent): void => {
					const current = ledger;
					if (current === undefined) return;
					const applied = reduce(current, event, { artifactRoots });
					if (!applied.ok) {
						host.appendEntry("com.joshyorko.luna-factory.native-correlation", { error: applied.error });
					} else if (applied.ledger !== current) {
						commit(applied.ledger);
					}
				};
				let steeringObserver: NativeAgentSteeringObserver;
				try {
					const registry = await loadNativeAgentRegistry(context);
					steeringObserver = createNativeAgentSteeringObserver(registry, (binding, agentId) => {
						const current = ledger;
						if (current === undefined) return;
						recordNativeEvent({
							kind: "record_native_agent_steering",
							expectedRevision: current.revision,
							taskId: binding.taskId,
							attemptId: binding.attemptId,
							agentId,
							reason: "a user-attributed message arrived in the Hub-visible OMP child",
						});
					});
					nativeSteeringObservers.add(steeringObserver);
				} catch (error) {
					const reason = `native task refused before execution: OMP Hub steering observation unavailable (${error instanceof Error ? error.message : String(error)})`;
					for (const binding of bindings.bindings) {
						const current = ledger;
						const attempt = current && findTask(current, binding.taskId)?.attempts.find((candidate) => candidate.id === binding.attemptId);
						if (current !== undefined && attempt?.state === "started") {
							recordNativeEvent({
								kind: "reconcile_attempt",
								expectedRevision: current.revision,
								taskId: binding.taskId,
								attemptId: binding.attemptId,
								outcome: "abandoned",
								reason,
							});
						}
					}
					return { content: text(reason), isError: true };
				}
				const steeringUnobservableBindings = new Map<string, NativeTaskBinding>();
				const observeNativeDetails = (details: unknown): void => {
					const identities = nativeTaskIdentities(details);
					for (const binding of bindings.bindings) {
						const current = ledger;
						if (current === undefined) break;
						const attempt = findTask(current, binding.taskId)?.attempts.find((candidate) => candidate.id === binding.attemptId);
						if (!attempt) continue;
						if (identities.jobId !== undefined && !attempt.nativeJobIds.includes(identities.jobId)) {
							recordNativeEvent({
								kind: "record_native_job",
								expectedRevision: current.revision,
								taskId: binding.taskId,
								attemptId: binding.attemptId,
								jobId: identities.jobId,
							});
						}
						const refreshed = ledger;
						const refreshedAttempt = refreshed && findTask(refreshed, binding.taskId)?.attempts.find((candidate) => candidate.id === binding.attemptId);
						const agentId = identities.agentIdsByIndex.get(binding.index)
							?? (bindings.bindings.length === 1 ? identities.unindexedAgentIds[0] : undefined);
						if (agentId !== undefined && refreshedAttempt) {
							if (!refreshedAttempt.nativeAgentIds.includes(agentId)) {
								recordNativeEvent({
									kind: "record_native_agent_start",
									expectedRevision: refreshed!.revision,
									taskId: binding.taskId,
									attemptId: binding.attemptId,
									agentId,
								});
							}
							const latest = ledger;
							const latestAttempt = latest && findTask(latest, binding.taskId)?.attempts.find((candidate) => candidate.id === binding.attemptId);
							if (!latestAttempt?.nativeAgentIds.includes(agentId) || !steeringObserver.bind(agentId, binding)) {
								steeringUnobservableBindings.set(nativeAgentSteeringKey(binding), binding);
								const current = ledger;
								if (current !== undefined && latestAttempt?.state === "started") {
									recordNativeEvent({
										kind: "reconcile_attempt",
										expectedRevision: current.revision,
										taskId: binding.taskId,
										attemptId: binding.attemptId,
										outcome: "unknown",
										reason: "OMP exposed a child ID without a steer-observable Agent Hub session",
									});
								}
							}
						}
					}
				};
				const reconcileUnknown = (targets: readonly NativeTaskBinding[], reason: string): void => {
					for (const binding of targets) {
						const current = ledger;
						if (current === undefined) break;
						const attempt = findTask(current, binding.taskId)?.attempts.find((candidate) => candidate.id === binding.attemptId);
						if (attempt?.state !== "started") continue;
						recordNativeEvent({
							kind: "reconcile_attempt",
							expectedRevision: current.revision,
							taskId: binding.taskId,
							attemptId: binding.attemptId,
							outcome: "unknown",
							reason,
						});
					}
				};
				const observeNativeSettlement = (details: unknown): void => {
					observeNativeDetails(details);
					if (!isRecord(details)) return;
					const asyncDetails = isRecord(details.async) ? details.async : undefined;
					const asyncSettled = asyncDetails?.state === "completed" || asyncDetails?.state === "failed";
					const terminalProgress = new Set<number>();
					if (Array.isArray(details.progress)) {
						for (const progress of details.progress) {
							if (!isRecord(progress) || typeof progress.index !== "number" || !Number.isInteger(progress.index) || progress.index < 0) continue;
							const terminal = progress.status === "completed" || progress.status === "failed" || progress.status === "aborted";
							if (terminal && !(typeof progress.requests === "number" && progress.requests > 0)) terminalProgress.add(progress.index);
						}
					}
					const unknown = bindings.bindings.filter((binding) => {
						const current = ledger;
						const attempt = current && findTask(current, binding.taskId)?.attempts.find((candidate) => candidate.id === binding.attemptId);
						return attempt?.state === "started" && attempt.nativeAgentIds.length === 0 && (asyncSettled || terminalProgress.has(binding.index));
					});
					if (unknown.length > 0) reconcileUnknown(unknown, "OMP task settled without an observed child agent start identity");
					if (asyncSettled) steeringObserver.finishCall();
				};
				try {
					result = await context.invokeTool(params, {
						signal,
						onUpdate: (update) => {
							observeNativeSettlement(update.details);
							onUpdate?.(update);
						},
					});
				} catch (error) {
					steeringObserver.finishCall();
					const reason = `OMP task failed before a child identity could be reconciled: ${error instanceof Error ? error.message : String(error)}`;
					reconcileUnknown(bindings.bindings, reason);
					return { content: text(reason), isError: true };
				}
				observeNativeSettlement(result.details);
				const details = isRecord(result.details) ? result.details : undefined;
				const asyncDetails = details && isRecord(details.async) ? details.async : undefined;
				const stillDispatched = asyncDetails?.state === "running"
					&& typeof asyncDetails.jobId === "string"
					&& NATIVE_IDENTITY_RE.test(asyncDetails.jobId);
				const steeringBlocked = bindings.bindings.filter((binding) =>
					steeringObserver.wasSteered(binding) || steeringUnobservableBindings.has(nativeAgentSteeringKey(binding)),
				);
				if (stillDispatched) {
					return steeringBlocked.length > 0
						? {
								...result,
								isError: true,
								content: [...result.content, { type: "text", text: "Hub steering or an unobservable child invalidated this Factory attempt; no receipt can certify it." }],
							}
						: result;
				}
				steeringObserver.finishCall();
				if (steeringBlocked.length > 0) {
					return {
						...result,
						isError: true,
						content: [...result.content, { type: "text", text: "Hub steering or an unobservable child invalidated this Factory attempt; no receipt can certify it." }],
					};
				}
				const notStarted = bindings.bindings.filter((binding) => {
					const current = ledger;
					const task = current && findTask(current, binding.taskId);
					const attempt = task?.attempts.find((candidate) => candidate.id === binding.attemptId);
					return task !== undefined && attempt !== undefined && attempt.nativeAgentIds.length === 0 && (attempt.state === "started" || task.state === "ESCALATE");
				});
				if (!stillDispatched && notStarted.length > 0) {
					reconcileUnknown(notStarted, "OMP returned without an observed running/completed child agent identity");
					return {
						...result,
						isError: true,
						content: [...result.content, { type: "text", text: "OMP did not expose a started child identity for every Factory attempt; unresolved attempts were escalated as unknown." }],
					};
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
		for (const observer of nativeSteeringObservers) {
			observer.sync(next);
			if (observer.isClosed()) nativeSteeringObservers.delete(observer);
		}
		registerNativeTaskWrapper();
	};

	const z = host.zod;
	const schemas = factoryToolSchemas(z);

	const registerTool = (
		definition: Omit<FactoryToolDefinition, "parameters">,
		parameters: unknown,
	): void => {
		host.registerTool({
			...definition,
			parameters,
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
			...ledger.tasks.flatMap((task) => task.attempts.flatMap((attempt) => {
				const identities: string[] = [];
				if (attempt.nativeJobIds.length > 0) identities.push(`OMP task dispatch (not start proof): ${attempt.nativeJobIds.join(", ")}`);
				if (attempt.nativeAgentIds.length > 0) identities.push(`OMP agent identity (start observed; liveness not inferred): ${attempt.nativeAgentIds.join(", ")}`);
				if (attempt.steeredAgentId !== undefined) identities.push(`OMP agent Hub-steered; attempt invalidated: ${attempt.steeredAgentId}`);
				for (const session of attempt.privateSessions) {
					identities.push(`Factory-private ${session.phase} session (${session.started ? "turn start observed; liveness not inferred" : "identity recorded; turn start not observed"}): ${session.sessionFile}`);
				}
				return identities.length > 0 ? [`execution ${task.id}/${attempt.id}: ${identities.join("; ")}`] : [];
			})),
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
	let batchService: BatchService | undefined;
	let dashboardReaderUnsubscribe: (() => void) | undefined;
	let dashboardOpenerUnsubscribe: (() => void) | undefined;
	let dashboardPresentation: FactoryDashboardPresentation | undefined;
	const evidenceWarnings = new Map<string, string>();
	const openDashboard = async (ctx: FactoryCtx, focusBatchId?: string): Promise<void> => {
		if (!ctx.hasUI || !ctx.ui?.custom) {
			notifyCommand(ctx, "Factory dashboard requires an interactive OMP UI; use /factory status for headless inspection", "warning");
			return;
		}
		const custom = ctx.ui.custom.bind(ctx.ui);
		const overlay = { overlay: true, overlayOptions: { fullscreen: true, width: "100%", maxHeight: "100%", anchor: "top-left", mouseTracking: false } };
		let service: BatchService | undefined;
		try { service = batchServiceForView(); } catch { /* async reconstruction presents the original error */ }
		let dashboard: FactoryDashboard | undefined;
		let alive = true;
		let busy = false;
		let notice: string | undefined;
		let displayed: FactoryDashboardSnapshot | undefined;
		let historyCursor: BatchHistoryCursor | undefined;
		const pending = new Set<string | undefined>();
		let refreshing = false;
		const refresh = async (id?: string): Promise<void> => {
			pending.add(id);
			if (refreshing) return;
			refreshing = true;
			try {
				while (alive && pending.size) {
					const ids = [...pending]; pending.clear();
					if (!displayed) {
						try {
							const owner = batchServiceForView();
							const page = await owner.readHistoryPage(undefined, focusBatchId ?? dashboardPresentation?.batchId);
							historyCursor = page.next;
							displayed = assembleDashboardSnapshot(owner, page.snapshot);
						} catch (error) { displayed = failedSnapshot(error); }
					} else {
						const targets = [...new Set(ids.map((id) => id ?? dashboard?.selection.batchId).filter((id): id is string => id !== undefined))];
						for (const changedId of targets) displayed = await dashboardSnapshotAsync(changedId, displayed);
					}
					if (alive && displayed) { displayed = { ...displayed, hasMoreHistory: historyCursor !== undefined }; dashboard?.setSource({ ...displayed, notice, busy }); }
				}
			} finally { refreshing = false; }
		};
		const unsubscribe = service?.onChange((event) => { if (alive) void refresh(event.batchId); }) ?? (() => {});
		const report = (message: string, level = "info"): void => {
			notice = message;
			if (alive && displayed) dashboard?.setSource({ ...displayed, notice, busy });
			notifyCommand(ctx, message, level);
		};
		let matchKey: KeyMatcher = rawKeyMatcher;
		let primitives: FactoryDashboardPrimitives | undefined;
		try {
			const [{ PanelRows }, { SplitPane, matchesKey }] = await Promise.all([
				import("@oh-my-pi/pi-tui/chrome") as Promise<{ PanelRows: new () => { setLines(lines: readonly string[]): void; render(width: number): readonly string[] } }>,
				import("@oh-my-pi/pi-tui") as Promise<{ matchesKey: KeyMatcher; SplitPane: new (options: Record<string, unknown>) => { render(width: number): readonly string[] } }>,
			]);
			matchKey = matchesKey;
			primitives = {
				panelRows: (_title, rows, width) => { const panel = new PanelRows(); panel.setLines(rows); return panel.render(width); },
				splitPane: (left, right, width) => {
					const leftRows = new PanelRows(); const rightRows = new PanelRows(); leftRows.setLines(left); rightRows.setLines(right);
					return new SplitPane({ left: leftRows, right: rightRows, splitAt: 96, leftSize: { fixed: Math.floor((width - 3) / 2) }, rightMinWidth: 32, narrowPane: "left", divider: "   " }).render(width);
				},
			};
		} catch (error) { notice = `Native layout unavailable; bounded text layout: ${error instanceof Error ? error.message : String(error)}`; }
		const perform = async (action: FactoryDashboardAction): Promise<void> => {
			if (busy || !alive) return;
			busy = true;
			if (displayed) dashboard?.setSource({ ...displayed, notice, busy });
			try {
				if (["close", "inspect", "batch", "claims", "evidence", "help", "palette"].includes(action.kind)) return;
				if (action.kind === "older-runs") {
					if (historyCursor && displayed) {
						const owner = batchServiceForView(); const page = await owner.readHistoryPage(historyCursor); historyCursor = page.next;
						const loaded = assembleDashboardSnapshot(owner, page.snapshot);
						const existing = new Map(displayed.batches.map((batch) => [batch.id, batch]));
						for (const batch of loaded.batches) existing.set(batch.id, batch);
						displayed = { ...displayed, ...loaded, batches: [...existing.values()], hasMoreHistory: historyCursor !== undefined };
					}
					return;
				}
				const current = dashboardSnapshot("batchId" in action ? action.batchId : dashboard?.selection.batchId, displayed);
				if (!dashboardActionAllowed(action, current)) { report("Action is no longer available for this subject; inspect current Factory state", "warning"); return; }
				if (action.kind === "open") {
					const opened = await host.exec?.("gh", ["pr", "view", action.url, "--web"], { timeout: 15_000 });
					if (opened?.code === 0 && !opened.killed) report("Opened the pull request.");
					else { ctx.ui?.pasteToEditor?.(action.url); report(`${ctx.ui?.pasteToEditor ? "Browser unavailable; PR link copied to the prompt" : "PR link"}: ${action.url}`); }
					return;
				}
				if (action.kind === "evidence-preview") {
					const preview = readBoundedEvidence(current.root ?? factoryStateRoot(env), action.path);
					await custom<void>((tui, _theme, _keys, done) => new EvidenceViewer({ preview, tui: tui as { requestRender(): void }, done: () => done(), matchKey }), overlay);
					return;
				}
				if (action.kind === "workspace" || action.kind === "session") {
					const item = current.batches.find((b) => b.id === action.batchId)?.items.find((i) => i.selected.key === action.itemKey);
					const value = action.kind === "workspace" ? item?.workspace : item?.ledger.tasks.flatMap((task) => task.attempts.flatMap((attempt) => attempt.privateSessions.filter((session) => session.phase === "worker"))).at(-1)?.sessionFile ?? item?.sessions.at(-1);
					if (action.kind === "session" && value) {
						const preview = readBoundedEvidence(current.root ?? factoryStateRoot(env), value);
						await custom<void>((tui, _theme, _keys, done) => new EvidenceViewer({ preview, tui: tui as { requestRender(): void }, done: () => done(), matchKey }), overlay);
					} else { if (value) ctx.ui?.pasteToEditor?.(value); report(value ? `Workspace path copied to the prompt: ${value}` : `${action.kind} unavailable`); }
					return;
				}
				let command: string | undefined;
				if (action.kind === "pause" || action.kind === "resume") command = `${action.kind} ${action.batchId}`;
				else if (action.kind === "stop") {
					if (!ctx.ui?.confirm || !(await ctx.ui.confirm("Stop Factory batch?", "New dispatch will stop. Existing effects are not rolled back, and ownership remains until execution settles."))) return;
					command = `stop ${action.batchId}`;
				} else if (action.kind === "retry") {
					if (!ctx.ui?.confirm || !(await ctx.ui.confirm("Retry Factory item?", "Inspect retained work first. The original attempt budget remains in force; unknown external effects cannot be retried."))) return;
					command = `retry ${action.batchId} ${action.itemKey}`;
				} else if (action.kind === "exclude") {
					const reason = ctx.ui?.editor ? await ctx.ui.editor("Why exclude this item?", "", undefined, { promptStyle: true }) : await ctx.ui?.input?.("Why exclude this item?", "reason");
					if (!reason?.trim()) return;
					if (!ctx.ui?.confirm || !(await ctx.ui.confirm("Exclude Factory item?", `Exclude ${action.itemKey}: ${reason.trim()}. This records a scope revision and prevents original-scope convergence.`))) return;
					command = `exclude ${action.batchId} ${action.itemKey} ${reason.trim()}`;
				} else if (action.kind === "discard") {
					if (!ctx.ui?.confirm || !(await ctx.ui.confirm("Archive Factory batch?", "This removes the batch from retained history. Native evidence and workspaces remain retained."))) return;
					command = `discard ${action.batchId}`;
				} else if (action.kind === "export") {
					const directory = await ctx.ui?.input?.("Export Factory evidence to which directory?", "unused destination directory");
					if (!directory?.trim()) return;
					command = `export ${action.batchId} ${directory.trim()}`;
				} else if (action.kind === "reconcile") {
					if (!ctx.ui?.confirm || !(await ctx.ui.confirm("Reconcile mutation ownership?", `Verify ${action.resource} owned by ${action.owner}. Release is allowed only after authoritative worker/effect settlement.`))) return;
					command = `claims reconcile ${action.owner} ${action.resource}`;
				} else if (action.kind === "reconcile-effect") {
					if (!ctx.ui?.confirm || !(await ctx.ui.confirm("Reconcile effects and resume this batch?", "The existing resume controller checks recorded external effects, then may dispatch other eligible items. UNKNOWN effects are not repeated."))) return;
					command = `resume ${action.batchId}`;
				}
				if (!command) return;
				if (!dashboardActionAllowed(action, dashboardSnapshot("batchId" in action ? action.batchId : dashboard?.selection.batchId, displayed))) { report("Factory state changed while confirming; action refused", "warning"); return; }
				const result = await batchCommand(command, ctx);
				if (action.kind === "discard") { displayed = undefined; historyCursor = undefined; }
				const message = action.kind === "pause" ? "Paused. Work already running can finish."
					: action.kind === "resume" ? "Resumed. Eligible work can start."
					: action.kind === "stop" ? "Stop requested. Ownership stays protected until work settles."
					: action.kind === "retry" ? "Retry requested within the original budget."
					: action.kind === "exclude" ? "Removed from this run. The scope change is recorded."
					: action.kind === "discard" ? "Run archived. Evidence and workspaces are retained."
					: action.kind === "export" ? "Evidence exported."
					: action.kind === "reconcile" ? (result.startsWith("Reconciled") ? "Ownership reconciled." : "Ownership is still uncertain. Inspect the owner for the recovery path.")
					: "Reconciliation finished. Check the updated work status.";
				report(message);
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				if ((action.kind === "evidence-preview" || action.kind === "session") && action.itemKey) {
					evidenceWarnings.set(`${action.batchId}:${action.itemKey}`, message);
					report("Evidence couldn't be opened. The recorded proof needs revalidation; archiving is unavailable.", "warning");
				} else report(message, "error");
			}
			finally { busy = false; if (alive) await refresh(); }
		};
		try {
			let presentation = dashboardPresentation;
			let focus = focusBatchId;
			for (;;) {
				const action = await custom<FactoryDashboardAction>((tui, theme, _keys, done) => {
					dashboard = new FactoryDashboard({
						tui: tui as { requestRender(): void }, theme: theme as FactoryDashboardTheme, done, onAction: perform,
						source: displayed ? { ...displayed, notice, busy } : { batches: [], claims: [], readOnly: true, loading: true, notice, busy },
						matchKey, primitives, presentation, focusBatchId: focus,
					});
					void refresh();
					return dashboard;
				}, overlay);
				focus = undefined;
				presentation = dashboard?.presentation;
				dashboardPresentation = presentation;
				if (action.kind === "close") return;
				// Compatible hosts may resolve a custom component with an action.
				// Native callbacks keep this overlay mounted beneath nested viewers.
				await perform(action);
			}
		} finally {
			alive = false; unsubscribe();
			dashboardPresentation = dashboard?.presentation ?? dashboardPresentation;
			if (dashboardPresentation) {
				try { saveDashboardPresentation(host, dashboardPresentation); }
				catch { notifyCommand(ctx, "Factory view focus could not be saved; batch state is unchanged", "warning"); }
			}
			dashboard?.dispose();
		}
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

	const batchServiceForView = (): BatchService => {
		if (!batchService) {
			const capacity = Number(env.LUNA_FACTORY_CAPACITY ?? "2");
			if (!Number.isSafeInteger(capacity) || capacity < 1 || capacity > 100) throw new Error("LUNA_FACTORY_CAPACITY must be between 1 and 100");
			batchService = new BatchService(factoryStateRoot(env), new BatchGitHub(resolveToken(env)), host.pi, host.zod as unknown as SchemaBuilder, capacity, factoryClaimsRoot(env));
		}
		return batchService;
	};
	const batches = (): BatchService => {
		if (!enabled()) throw new Error("Factory is disabled; explicitly enable LUNA_FACTORY_ENABLED=1");
		if (ledger) throw new Error("A single-subject journal is open; preserve it and use a fresh native session for selected batches");
		if (loadProblem !== undefined) throw new Error(`Factory journal is unreadable: ${loadProblem}; preserve it before starting a selected batch`);
		return batchServiceForView();
	};
	const assembleDashboardSnapshot = (service: BatchService, snapshot: BatchSnapshot, batchId?: string, previous?: FactoryDashboardSnapshot): FactoryDashboardSnapshot => {
			const retained = batchId && previous ? [...previous.batches.filter((batch) => batch.id !== batchId), ...snapshot.batches] : [...snapshot.batches];
			let claims;
			try { claims = service.claims.list(); }
			catch (error) { return { batches: retained, claims: [], root: snapshot.root, readOnly: true, error: `claims unreadable: ${error instanceof Error ? error.message : String(error)}` }; }
			const errors = snapshot.errors.map((entry) => `${entry.id}: ${entry.error}`);
			if (previous?.error && !errors.includes(previous.error)) errors.push(previous.error);
			const inspector = registeredFactoryClaimInspector();
			const claimOwners = inspector ? claims.filter((claim) => claim.owner.startsWith("review:")).flatMap((claim) => {
				try { return [inspector(claim.owner, claim.resource)]; } catch { return []; }
			}) : [];
			if (loadProblem) errors.push(`Factory journal unreadable: ${loadProblem}; original state preserved`);
			if (ledger) errors.push("A single-subject journal is open; use /factory status and its textual controls. Selected batches are inspect-only in this session.");
			retained.sort((a, b) => b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id));
			return { batches: retained, hasMoreHistory: previous?.hasMoreHistory, claims, claimOwners, evidenceWarnings: Object.fromEntries(evidenceWarnings), canReconcileClaims: registeredFactoryReconciler() !== undefined, activeItemKeys: snapshot.activeItemKeys, root: snapshot.root, readOnly: !enabled() || Boolean(snapshot.fatal || errors.length), ...(snapshot.fatal || errors.length ? { error: [snapshot.fatal, ...errors].filter(Boolean).join("; ") } : {}) };
	};
	const failedSnapshot = (error: unknown): FactoryDashboardSnapshot => ({ batches: [], claims: [], root: factoryStateRoot(env), readOnly: true, error: error instanceof Error ? error.message : String(error) });
	const dashboardSnapshot = (batchId?: string, previous?: FactoryDashboardSnapshot): FactoryDashboardSnapshot => {
		try {
			const service = batchServiceForView();
			return assembleDashboardSnapshot(service, service.readSnapshot(batchId), batchId, previous);
		} catch (error) { return failedSnapshot(error); }
	};
	const dashboardSnapshotAsync = async (batchId?: string, previous?: FactoryDashboardSnapshot): Promise<FactoryDashboardSnapshot> => {
		try {
			const service = batchServiceForView();
			return assembleDashboardSnapshot(service, await service.readSnapshotAsync(batchId), batchId, previous);
		} catch (error) { return failedSnapshot(error); }
	};

	const registerDashboardReader = (): void => {
		dashboardReaderUnsubscribe?.();
		dashboardReaderUnsubscribe = registerFactoryDashboardReader(dashboardSnapshot);
	};
	const submitSelectedBatch = async (action: FactoryAction, context: unknown, settings: Partial<BatchOptions> = {}): Promise<{ batchId: string; text: string }> => {
		const ctx = context as FactoryCtx;
		const service = batches();
		const items = selectedFactoryItems(action);
		const batch = await service.submit(items, {
			capacity: settings.capacity ?? service.capacity,
			maxAttempts: settings.maxAttempts ?? 3,
			maxTotalAttempts: settings.maxTotalAttempts ?? items.length * 3,
			mode: settings.mode ?? "once",
			dependencies: settings.dependencies,
		});
		const preflight = service.status(batch.id);
		notifyCommand(ctx, preflight);
		await service.resume(batch.id, ctx);
		if (!ctx.hasUI) await service.waitForIdle();
		return { batchId: batch.id, text: service.status(batch.id) };
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
			const explicitVerifier = (ctx as FactoryCtx & { reconcileMutationClaim?: (owner: string, resource: string) => Promise<"settled" | "unknown"> }).reconcileMutationClaim;
			const verifier = explicitVerifier ?? registeredFactoryReconciler();
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
	const unregisterBatchSubmitter = registerFactoryBatchSubmitter((action, context) => submitSelectedBatch(action, context));
	registerDashboardReader();
	dashboardOpenerUnsubscribe = registerFactoryDashboardOpener((context, focusBatchId) => openDashboard(context as FactoryCtx, focusBatchId));
	host.on("session_shutdown", async () => {
		unregisterBatchController();
		unregisterBatchSubmitter();
		dashboardReaderUnsubscribe?.();
		dashboardOpenerUnsubscribe?.();
		if (batchService?.isWriterAcquired()) await batchService.shutdown();
	});
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
		}, schemas.empty);
	}

	if (host.registerCommand !== undefined) {
		host.registerCommand("factory", {
			description: "Open or inspect the opt-in Luna Factory run",
			handler: async (rawArgs, ctx) => {
				const args = rawArgs.trim();
				if (args.length === 0 && ctx.hasUI && ctx.ui?.custom) {
					try { await openDashboard(ctx); }
					catch (error) { notifyCommand(ctx, error instanceof Error ? error.message : String(error), "error"); }
					return;
				}
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
					notifyCommand(ctx, "this OMP host has no prompt handoff; use luna_factory_open with its typed contract", "error");
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
	}, schemas.empty);

	registerTool({
		name: "luna_factory_open",
		label: "Factory Open",
		description:
			"Establish a Factory run from an objective the user already agreed to. Pass objective, criteria, and the subject repository/base. Refuses to silently replace an open run.",
		async execute(_toolCallId, params) {
			const payload = params;
			if (!enabled()) {
				return { content: text(`${ENABLE_FLAG}=1 is required to open a Factory run.`), isError: true };
			}
			const objective = boundedOptionText(payload.objective, "objective");
			if (!objective.ok) return { content: text(objective.error), isError: true };
			const rawCriteria = payload.criteria;
			if (!Array.isArray(rawCriteria) || rawCriteria.length === 0) {
				return { content: text("criteria must be a non-empty array of {id, statement, mandatory, assumptions?}"), isError: true };
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
				let currentAssumptions: Criterion["assumptions"];
				if (record.assumptions !== undefined) {
					const parsedAssumptions = parseProofAssumptions(record.assumptions);
					if (!parsedAssumptions.ok) {
						return { content: text(`criteria.${record.id}.assumptions rejected: ${parsedAssumptions.errors.join("; ")}`), isError: true };
					}
					currentAssumptions = parsedAssumptions.value;
				}
				criterionIds.add(record.id);
				criteria.push({
					id: record.id as Criterion["id"],
					statement: statement.value,
					mandatory: record.mandatory !== false,
					...(currentAssumptions === undefined ? {} : { assumptions: currentAssumptions }),
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
	}, schemas.open);

	registerTool({
		name: "luna_factory_candidate",
		label: "Factory Candidate",
		description:
			"Submit a discovered candidate for admission. Discovery creates candidates, never authority: the ledger decides ADMIT, DEFER, DISMISS, or ESCALATE and records the reason.",
		async execute(_toolCallId, params) {
			const candidate = parseCandidate(params);
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
	}, schemas.candidate);

	registerTool({
		name: "luna_factory_attempt",
		label: "Factory Attempt",
		description:
			"Persist the intent to run an admitted task before any external effect, opening a new attempt on the task's lineage.",
		async execute(_toolCallId, params) {
			const payload = params as { taskId?: unknown; attemptId?: unknown };
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
	}, schemas.attempt);

	registerTool({
		name: "luna_factory_dispatch",
		label: "Factory Dispatch",
		description:
			"Build the bounded prompt for an admitted task. Factory's enforced boundary is the work it emits: it refuses an unadmitted task, a closed run, and any execution path whose admission gate is unproven.",
		async execute(_toolCallId, params) {
			if (ledger === undefined) return { content: text(loadProblem ?? "no Factory run is open"), isError: true };
			const payload = params as { taskId?: unknown; attemptId?: unknown; path?: unknown };
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
	}, schemas.dispatch);

	registerTool({
		name: "luna_factory_receipt",
		label: "Factory Receipt",
		description:
			"Record a worker's structured receipt and reconcile it against the exact task, attempt, generation, and subject it claims to certify.",
		async execute(_toolCallId, params) {
			const receipt = parseReceipt(params);
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
	}, schemas.receipt);

	registerTool({
		name: "luna_factory_reconcile",
		label: "Factory Reconcile",
		description:
			"Reconcile an interrupted native attempt as abandoned or liveness-unknown. This preserves native identities and retry lineage; it never invents a receipt or rolls back an external effect.",
		async execute(_toolCallId, params) {
			const payload = params;
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
	}, schemas.reconcile);

	registerTool({
		name: "luna_factory_integrate",
		label: "Factory Integrate",
		description:
			"Record the owner's explicit integration of a proven write attempt at a new repository subject. Factory never applies or rolls back the external change.",
		async execute(_toolCallId, params) {
			const payload = params;
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
	}, schemas.integrate);

	registerTool({
		name: "luna_factory_replan",
		label: "Factory Replan",
		description:
			"Use the one bounded materially different same-goal replan, but only after two consecutive no-progress attempts have been recorded.",
		async execute(_toolCallId, params) {
			const payload = params;
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
	}, schemas.replan);

	registerTool({
		name: "luna_factory_reopen",
		label: "Factory Reopen",
		description:
			"Reopen a completed task only when the owner supplies new evidence of a legitimate defect; this invalidates its prior proof without authorizing successor work by itself.",
		async execute(_toolCallId, params) {
			const payload = params;
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
	}, schemas.reopen);

	registerTool({
		name: "luna_factory_finish",
		label: "Factory Finish",
		description:
			"Certify an admitted task against a receipt that reconciles as proven at the current subject. Refuses unproven, stale, or unintegrated write work.",
		async execute(_toolCallId, params) {
			const payload = params as { taskId?: unknown };
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
	}, schemas.finish);

	registerTool({
		name: "luna_factory_why",
		label: "Factory Why",
		description: "Explain why one task was admitted, deferred, dismissed, or escalated, with the evidence recorded for it.",
		async execute(_toolCallId, params) {
			const payload = params as { taskId?: unknown };
			if (typeof payload.taskId !== "string") return { content: text("taskId is required"), isError: true };
			if (ledger === undefined) return { content: text(loadProblem ?? "no Factory run is open"), isError: true };
			return { content: text(renderWhy(ledger, payload.taskId as TaskId).join("\n")) };
		},
	}, schemas.why);

	registerTool({
		name: "luna_factory_control",
		label: "Factory Control",
		description:
			"Pause or drain admission, resume after reconciliation, or abort. Pause drains admitted work without claiming rollback; abort requests cancellation of owned work and never retracts external effects.",
		async execute(_toolCallId, params) {
			const payload = params as { action?: unknown };
			const control = payload.action === "pause" ? "paused" : payload.action === "drain" ? "draining" : payload.action === "resume" ? "active" : payload.action === "abort" ? "interrupted" : undefined;
			if (control === undefined) return { content: text("action must be pause, drain, resume, or abort"), isError: true };
			const result = mutate(
				(current) => reduce(current, { kind: "set_control", expectedRevision: current.revision, control }, { artifactRoots }),
				(next) => controlSummary(control, next),
			);
			return result;
		},
	}, schemas.control);

	registerTool({
		name: "luna_factory_completion",
		label: "Factory Completion",
		description:
			"Render the Factory-verified completion receipt. This is a distinct artifact derived only from ledger records, so a premature success sentence in prose has nothing to attach to.",
		async execute() {
			if (ledger === undefined) return { content: text(loadProblem ?? "no Factory run is open"), isError: true };
			return { content: text(renderCompletionReceipt(ledger, evaluateRun(ledger))) };
		},
	}, schemas.empty);

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
		dashboardPresentation = loadDashboardPresentation(ctx);
		const loaded = loadRun(ctx);
		ledger = loaded.ledger;
		loadProblem = loaded.problem;
		if (ledger !== undefined) {
			try {
				const before = ledger;
				const recovered = reconcileRestartedAttempts(before, artifactRoots);
				if (recovered !== before) {
					saveRun(host, recovered);
					ledger = recovered;
					if (ctx.hasUI) ctx.ui?.notify?.("Factory resumed with unfinished attempts marked UNKNOWN; inspect execution liveness before starting new work.", "warning");
				}
			} catch (error) {
				ledger = undefined;
				loadProblem = `unfinished Factory attempts could not be safely reconciled after restart: ${error instanceof Error ? error.message : String(error)}`;
			}
		}
		if (loadProblem !== undefined && ctx.hasUI) {
			ctx.ui?.notify?.(`Factory journal is unreadable or unreconciled: ${loadProblem}`, "error");
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
