import { createHash } from "node:crypto";

export interface ModelRoute {
	readonly provider: string;
	readonly model: string;
	readonly api: string;
	/** Digest only; custom endpoint URLs can contain operator-controlled secrets. */
	readonly endpointFingerprint: string;
}

export interface ExecutionPolicy {
	readonly version: 1;
	readonly route: ModelRoute;
	readonly openedAt: number;
	readonly deadlineAt: number;
	readonly maxRequests: number;
	readonly maxInputBytes: number;
	readonly maxOutputTokens: number;
	readonly maxReservedOutputTokens: number;
}

export interface RequestUsage {
	readonly inputTokens: number;
	readonly outputTokens: number;
	/** OMP's provider/catalog estimate, not a hard monetary charge. */
	readonly estimatedCost: number | null;
}

export interface RequestReservation {
	readonly id: number;
	readonly route: ModelRoute;
	readonly reservedPayloadBytes: number;
	readonly reservedOutputTokens: number;
	readonly status: "reserved" | "response" | "settled";
	readonly createdAt: number;
	readonly usage?: RequestUsage;
}

export interface RequestAccounting {
	readonly sequence: number;
	readonly reservations: readonly RequestReservation[];
}

export interface RequestUsageObservation {
	readonly input: unknown;
	readonly output: unknown;
	readonly cost: unknown;
}

/** Normalize OMP AssistantMessage.usage, whose cost is an object with a `total` estimate. */
export function usageObservationFromOmp(value: unknown): RequestUsageObservation {
	if (!value || typeof value !== "object" || Array.isArray(value)) return { input: undefined, output: undefined, cost: undefined };
	const usage = value as Record<string, unknown>;
	const reportedCost = usage.cost;
	const cost = reportedCost && typeof reportedCost === "object" && !Array.isArray(reportedCost)
		? (reportedCost as Record<string, unknown>).total
		: reportedCost;
	return { input: usage.input, output: usage.output, cost };
}

export type RequestGateResult =
	| { readonly ok: true; readonly accounting: RequestAccounting; readonly reservation: RequestReservation; readonly payload: Record<string, unknown> }
	| { readonly ok: false; readonly reason: string };

const DEFAULT_LIMITS = { maxRequests: 128, maxInputBytes: 512 * 1024, maxOutputTokens: 1024, maxReservedOutputTokens: 1_000_000 } as const;
const SUPPORTED_OUTPUT_FIELDS: Readonly<Record<string, "max_tokens" | "max_completion_tokens" | "max_output_tokens" | "config.maxOutputTokens">> = {
	"anthropic-messages": "max_tokens",
	"openai-completions": "max_completion_tokens",
	"openai-responses": "max_output_tokens",
	"google-generative-ai": "config.maxOutputTokens",
};

function safeId(value: unknown): value is string { return typeof value === "string" && /^[A-Za-z0-9._:-]{1,128}$/.test(value); }
function safeCount(value: unknown): value is number { return typeof value === "number" && Number.isSafeInteger(value) && value >= 0; }
function sameRoute(a: ModelRoute, b: ModelRoute): boolean {
	return a.provider === b.provider && a.model === b.model && a.api === b.api && a.endpointFingerprint === b.endpointFingerprint;
}
function payloadBytes(payload: unknown): number | undefined {
	try {
		const serialized = JSON.stringify(payload);
		return serialized === undefined ? undefined : Buffer.byteLength(serialized, "utf8");
	} catch { return undefined; }
}
function outputCap(payload: Record<string, unknown>, api: string, maximum: number): Record<string, unknown> | undefined {
	const field = SUPPORTED_OUTPUT_FIELDS[api];
	if (!field) return;
	const copy = structuredClone(payload);
	if (field === "config.maxOutputTokens") {
		const prior = copy.config;
		if (prior !== undefined && (!prior || typeof prior !== "object" || Array.isArray(prior))) return;
		const config = { ...(prior as Record<string, unknown> | undefined) };
		if (config.maxOutputTokens !== undefined && !safeCount(config.maxOutputTokens)) return;
		config.maxOutputTokens = Math.min((config.maxOutputTokens as number | undefined) ?? maximum, maximum);
		copy.config = config;
		return copy;
	}
	if (api === "openai-completions") {
		const fields = ["max_tokens", "max_completion_tokens"].filter((name) => Object.hasOwn(copy, name));
		if (!fields.length) fields.push("max_completion_tokens");
		for (const name of fields) {
			const prior = copy[name];
			if (prior !== undefined && !safeCount(prior)) return;
			copy[name] = Math.min((prior as number | undefined) ?? maximum, maximum);
		}
		return copy;
	}
	const prior = copy[field];
	if (prior !== undefined && !safeCount(prior)) return;
	copy[field] = Math.min((prior as number | undefined) ?? maximum, maximum);
	return copy;
}

export function routeForModel(model: unknown): ModelRoute {
	if (!model || typeof model !== "object" || Array.isArray(model)) throw new Error("OMP model route unavailable; Factory execution refused");
	const value = model as Record<string, unknown>;
	if (!safeId(value.provider) || !safeId(value.id) || !safeId(value.api) || (value.baseUrl !== undefined && typeof value.baseUrl !== "string")) {
		throw new Error("OMP model provider/model/API/endpoint identity unavailable; Factory execution refused");
	}
	if (!SUPPORTED_OUTPUT_FIELDS[value.api]) throw new Error(`OMP API ${value.api} has no qualified bounded-output field; Factory execution refused`);
	return {
		provider: value.provider,
		model: value.id,
		api: value.api,
		endpointFingerprint: createHash("sha256").update((value.baseUrl as string | undefined) ?? "").digest("hex"),
	};
}

export function createExecutionPolicy(
	route: ModelRoute,
	openedAt: number,
	options: Partial<Pick<ExecutionPolicy, "maxRequests" | "deadlineAt" | "maxInputBytes" | "maxOutputTokens" | "maxReservedOutputTokens">> = {},
): ExecutionPolicy {
	if (!route || !safeId(route.provider) || !safeId(route.model) || !safeId(route.api) || !/^[a-f0-9]{64}$/.test(route.endpointFingerprint)) throw new Error("invalid execution route policy");
	if (!safeCount(openedAt) || !safeCount(options.deadlineAt ?? openedAt + 60 * 60_000) || (options.deadlineAt ?? openedAt + 60 * 60_000) <= openedAt) throw new Error("invalid execution deadline");
	const limits = { ...DEFAULT_LIMITS, ...options };
	for (const [name, value] of Object.entries(limits)) if (!safeCount(value) || value < 1) throw new Error(`${name} must be a positive safe integer`);
	if (limits.maxOutputTokens > 8192 || limits.maxInputBytes > 4 * 1024 * 1024 || limits.maxRequests > 10_000) throw new Error("execution limit exceeds supported bound");
	return { version: 1, route: { ...route }, openedAt, deadlineAt: options.deadlineAt ?? openedAt + 60 * 60_000, ...limits };
}

/** Reserves request and worst-case token capacity synchronously before OMP can call its provider. */
export function reserveProviderRequest(
	policy: ExecutionPolicy,
	accounting: RequestAccounting,
	route: ModelRoute,
	payload: unknown,
	now = Date.now(),
): RequestGateResult {
	if (!sameRoute(policy.route, route)) return { ok: false, reason: "effective provider/model/API/endpoint differs from the admitted Factory policy" };
	if (now >= policy.deadlineAt) return { ok: false, reason: "Factory execution deadline expired; resume cannot renew it" };
	if (accounting.reservations.length >= policy.maxRequests) return { ok: false, reason: "Factory provider request limit exhausted; original reservations remain charged" };
	const bytes = payloadBytes(payload);
	if (bytes === undefined || bytes > policy.maxInputBytes || !payload || typeof payload !== "object" || Array.isArray(payload)) {
		return { ok: false, reason: "provider payload is unreadable or exceeds the admitted input byte limit" };
	}
	const limited = outputCap(payload as Record<string, unknown>, route.api, policy.maxOutputTokens);
	if (!limited) return { ok: false, reason: `provider output cap is unsupported for ${route.api}; request refused before send` };
	const currentlyReservedOutputTokens = accounting.reservations.reduce((sum, row) => sum + (row.usage ? row.usage.outputTokens : row.reservedOutputTokens), 0);
	if (currentlyReservedOutputTokens + policy.maxOutputTokens > policy.maxReservedOutputTokens) return { ok: false, reason: "Factory aggregate reserved-output-token limit exhausted; unresolved output reservations are not treated as zero" };
	const reservation: RequestReservation = {
		id: accounting.sequence + 1,
		route: { ...route },
		reservedPayloadBytes: bytes,
		reservedOutputTokens: policy.maxOutputTokens,
		status: "reserved",
		createdAt: now,
	};
	return {
		ok: true,
		accounting: { sequence: reservation.id, reservations: [...accounting.reservations, reservation] },
		reservation,
		payload: limited,
	};
}

export function observeProviderResponse(accounting: RequestAccounting, route: ModelRoute): RequestAccounting {
	const index = accounting.reservations.findIndex((row) => row.status === "reserved" && sameRoute(row.route, route));
	if (index < 0) return accounting;
	return { ...accounting, reservations: accounting.reservations.map((row, i) => i === index ? { ...row, status: "response" } : row) };
}

/** Missing or malformed OMP usage remains unresolved and retains the maximum reservation. */
export function settleProviderUsage(accounting: RequestAccounting, route: ModelRoute, observation: RequestUsageObservation): RequestAccounting {
	const index = accounting.reservations.findIndex((row) => row.status === "response" && sameRoute(row.route, route));
	if (index < 0) return accounting;
	const inputTokens = observation.input;
	const outputTokens = observation.output;
	const cost = observation.cost;
	if (!safeCount(inputTokens) || !safeCount(outputTokens) || (cost !== null && (typeof cost !== "number" || !Number.isFinite(cost) || cost < 0))) return accounting;
	return {
		...accounting,
		reservations: accounting.reservations.map((row, i) => i === index
			? { ...row, status: "settled", usage: { inputTokens, outputTokens, estimatedCost: cost as number | null } }
			: row),
	};
}

export function validateExecutionPolicy(value: unknown): asserts value is ExecutionPolicy {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid durable Factory execution policy");
	const policy = value as Partial<ExecutionPolicy>;
	if (policy.version !== 1 || Object.hasOwn(policy, "effort") || !policy.route || !safeId(policy.route.provider) || !safeId(policy.route.model) || !safeId(policy.route.api) || !/^[a-f0-9]{64}$/.test(policy.route.endpointFingerprint)) throw new Error("invalid durable Factory execution policy route");
	if (!safeCount(policy.openedAt) || !safeCount(policy.deadlineAt) || policy.deadlineAt <= policy.openedAt) throw new Error("invalid durable Factory execution deadline");
	for (const [name, value] of Object.entries({ maxRequests: policy.maxRequests, maxInputBytes: policy.maxInputBytes, maxOutputTokens: policy.maxOutputTokens, maxReservedOutputTokens: policy.maxReservedOutputTokens })) {
		if (!safeCount(value) || value < 1) throw new Error(`invalid durable Factory ${name}`);
	}
	if (policy.maxRequests! > 10_000 || policy.maxInputBytes! > 4 * 1024 * 1024 || policy.maxOutputTokens! > 8192) throw new Error("durable Factory execution policy exceeds supported bounds");
}

export function validateRequestAccounting(value: unknown): asserts value is RequestAccounting {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid durable Factory request accounting");
	const accounting = value as Partial<RequestAccounting>;
	if (!safeCount(accounting.sequence) || !Array.isArray(accounting.reservations) || accounting.reservations.length > 10_000) throw new Error("invalid durable Factory request accounting sequence");
	let priorId = 0;
	for (const entry of accounting.reservations) {
		if (!entry || !safeCount(entry.id) || entry.id <= priorId || !entry.route || !safeId(entry.route.provider) || !safeId(entry.route.model) || !safeId(entry.route.api) || !/^[a-f0-9]{64}$/.test(entry.route.endpointFingerprint) || !safeCount(entry.reservedPayloadBytes) || !safeCount(entry.reservedOutputTokens) || !safeCount(entry.createdAt) || !["reserved", "response", "settled"].includes(entry.status)) throw new Error("invalid durable Factory request reservation");
		if (entry.usage && (!safeCount(entry.usage.inputTokens) || !safeCount(entry.usage.outputTokens) || (entry.usage.estimatedCost !== null && (typeof entry.usage.estimatedCost !== "number" || !Number.isFinite(entry.usage.estimatedCost) || entry.usage.estimatedCost < 0)))) throw new Error("invalid durable Factory request usage");
		if ((entry.status === "settled") !== Boolean(entry.usage)) throw new Error("Factory request settlement and usage disagree");
		priorId = entry.id;
	}
	if (accounting.sequence !== priorId) throw new Error("Factory request accounting sequence does not match its reservation history");
}
