/**
 * The live omp turn, as a Dagger trace.
 *
 * OMP already emits turn and tool-execution events; this projects them into a
 * Dagger-style span tree for the workbench. No parallel execution history is
 * reconstructed from another runtime.
 *
 * Bounded by construction: only the last `MAX_TURNS` turns are kept, each turn
 * keeps its tool spans, and each tool span keeps a short log tail.
 */

import type { Span, TraceClass } from "./trace.ts";
import type { NativeOutputReference, OutputRetention } from "./trace.ts";
import { createHash } from "node:crypto";
import { Buffer } from "node:buffer";
import { boundedUtf8Tail, safePreview } from "./safe-output.ts";

export const TRACE_LIMITS = Object.freeze({
	maxTurns: 6,
	maxSpansPerTurn: 64,
	maxRetainedSpans: 256,
	maxLogLines: 12,
	maxFieldBytes: 4_096,
	maxToolPreviewBytes: 8_192,
	maxTraceOutputBytes: 128 * 1_024,
	maxTraceBytes: 512 * 1_024,
	maxContentNodes: 64,
	maxJobsPerTool: 32,
	maxNativeJobsPerSync: 256,
	maxIdentifierBytes: 128,
	maxLabelBytes: 256,
} as const);

const MAX_ORPHAN_TERMINAL_CALL_IDS = TRACE_LIMITS.maxTurns * 8;
const MAX_TURNS = TRACE_LIMITS.maxTurns;
const MAX_LOG_LINES = TRACE_LIMITS.maxLogLines;

export interface SessionTraceStats {
	readonly turnCount: number;
	readonly spanCount: number;
	readonly retainedBytes: number;
	readonly outputBytes: number;
	readonly omittedSpans: number;
}

/**
 * OMP marks interrupted tool executions in structured result details. Result
 * prose is deliberately ignored: it is output, not lifecycle authority.
 */
function nativeCancellation(result: unknown): boolean {
	if (!result || typeof result !== "object" || !("details" in result)) return false;
	const details = result.details;
	if (!details || typeof details !== "object") return false;
	if ("__interrupted" in details && details.__interrupted === true) return true;
	if (!("__synthetic" in details) || details.__synthetic !== true || !("source" in details)) return false;
	return details.source === "interrupt_skipped" || details.source === "assistant_stop_aborted" || details.source === "assistant_stop_skipped";
}

type NativeTaskStatus = "pending" | "running" | "completed" | "failed" | "aborted";

interface NativeTaskProgress {
	id?: unknown;
	status?: unknown;
}

interface NativeTaskDetails {
	async?: { jobId?: unknown; state?: unknown };
	progress?: unknown[];
}

function nativeTaskDetails(value: unknown): NativeTaskDetails | undefined {
	if (!value || typeof value !== "object" || !("details" in value)) return undefined;
	const details = value.details;
	if (!details || typeof details !== "object") return undefined;
	const asyncValue = "async" in details ? details.async : undefined;
	const asyncDetails =
		asyncValue && typeof asyncValue === "object"
			? {
				jobId: "jobId" in asyncValue ? asyncValue.jobId : undefined,
				state: "state" in asyncValue ? asyncValue.state : undefined,
			}
			: undefined;
	const progress = "progress" in details && Array.isArray(details.progress) ? details.progress : undefined;
	return asyncDetails || progress ? { async: asyncDetails, progress } : undefined;
}

function nativeTaskStatus(value: unknown): NativeTaskStatus | undefined {
	return value === "pending" || value === "running" || value === "completed" || value === "failed" || value === "aborted"
		? value
		: undefined;
}

function spanStatus(status: NativeTaskStatus): Span["status"] {
	if (status === "completed") return "success";
	if (status === "failed") return "failure";
	if (status === "aborted") return "skipped";
	return status === "pending" ? "pending" : "running";
}

interface AsyncJobSnapshot {
	running?: Array<{ id: string; agentId?: string; status?: string }>;
	recent?: Array<{ id: string; agentId?: string; status?: string }>;
}

interface ToolArgs {
	command?: unknown;
	path?: unknown;
	pattern?: unknown;
	pull_request?: unknown;
}

/** One-line summary of a tool call, in the style of Dagger's call titles. */
export function describeToolCall(toolName: string, args: unknown): string {
	const record = (args ?? {}) as ToolArgs;
	const first =
		typeof record.command === "string"
			? record.command
			: typeof record.path === "string"
				? record.path
				: typeof record.pattern === "string"
					? record.pattern
					: typeof record.pull_request === "number"
						? `#${record.pull_request}`
							: undefined;
	const safeName = safePreview(toolName, 64, "head").text || "tool";
	const candidate = first === undefined ? undefined : safePreview(first, TRACE_LIMITS.maxLabelBytes * 2, "head").text;
	const lineEnd = candidate?.indexOf("\n") ?? -1;
	const firstLine = candidate === undefined ? undefined : candidate.slice(0, lineEnd < 0 ? candidate.length : lineEnd);
	const safeArgument = firstLine === undefined ? undefined : safePreview(firstLine, TRACE_LIMITS.maxLabelBytes, "head").text;
	return safeArgument ? `${safeName}(${safeArgument})` : `${safeName}()`;
}

interface ExtractedText {
	readonly text: string;
	readonly hasText: boolean;
	readonly omittedBytes: number;
	readonly omittedUnknown: boolean;
}

/** Traverse only a fixed number of native content nodes and retain their tail. */
function extractText(value: unknown): ExtractedText {
	const stack: unknown[] = [value];
	const visited = new Set<object>();
	const pieces: string[] = [];
	let nodes = 0;
	let originalBytes = 0;
	let hasText = false;
	let omittedUnknown = false;
	while (stack.length > 0 && nodes < TRACE_LIMITS.maxContentNodes) {
		const current = stack.pop();
		nodes += 1;
		if (typeof current === "string") {
			hasText = true;
			originalBytes += Buffer.byteLength(current, "utf8");
			pieces.push(safePreview(current, TRACE_LIMITS.maxFieldBytes).text);
			continue;
		}
		if (!current || typeof current !== "object") continue;
		if (visited.has(current)) {
			omittedUnknown = true;
			continue;
		}
		visited.add(current);
		if (Array.isArray(current)) {
			const available = Math.max(0, TRACE_LIMITS.maxContentNodes - stack.length);
			const first = Math.max(0, current.length - available);
			if (first > 0) omittedUnknown = true;
			for (let index = first; index < current.length && stack.length < TRACE_LIMITS.maxContentNodes; index++) {
				stack.push(current[index]);
			}
			continue;
		}
		try {
			if ("text" in current) stack.push(current.text);
			else if ("content" in current) stack.push(current.content);
			else if ("output" in current) stack.push(current.output);
		} catch {
			omittedUnknown = true;
		}
	}
	if (stack.length > 0) omittedUnknown = true;
	let joined = "";
	for (let index = pieces.length - 1; index >= 0; index--) {
		if (joined) joined = `${joined}\n`;
		joined += pieces[index]!;
	}
	const bounded = safePreview(joined, TRACE_LIMITS.maxToolPreviewBytes);
	const retainedBytes = Buffer.byteLength(bounded.text, "utf8");
	return {
		text: bounded.text,
		hasText,
		omittedBytes: Math.max(0, originalBytes - retainedBytes),
		omittedUnknown,
	};
}

function compactIdentifier(value: string): string {
	if (Buffer.byteLength(value, "utf8") <= TRACE_LIMITS.maxIdentifierBytes) return value;
	return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function walkSpans(root: Span, visit: (span: Span) => void): void {
	visit(root);
	for (const child of root.children ?? []) walkSpans(child, visit);
}

function countSpans(root: Span): number {
	let count = 0;
	walkSpans(root, () => { count += 1; });
	return count;
}

function spanOutputBytes(span: Span): number {
	return (span.logs ?? []).reduce((total, line) => total + Buffer.byteLength(line, "utf8"), Math.max(0, (span.logs?.length ?? 0) - 1));
}

function spanRetainedBytes(span: Span): number {
	let bytes = Buffer.byteLength(span.id, "utf8") + Buffer.byteLength(span.label, "utf8");
	if (span.detail) bytes += Buffer.byteLength(span.detail, "utf8");
	bytes += spanOutputBytes(span);
	const reference = span.output?.reference;
	if (reference) {
		if (reference.uri) bytes += Buffer.byteLength(reference.uri, "utf8");
		bytes += Buffer.byteLength(reference.sourceSessionId, "utf8");
		if (reference.kind === "available") bytes += Buffer.byteLength(reference.path, "utf8");
		else bytes += Buffer.byteLength(reference.reason, "utf8");
	}
	return bytes;
}

function addOmittedBytes(span: Span, bytes: number, unknown = false): void {
	if (bytes <= 0 && !unknown) return;
	const previous = span.output;
	span.output = {
		omittedBytes: (previous?.omittedBytes ?? 0) + Math.max(0, bytes),
		omittedSpans: previous?.omittedSpans ?? 0,
		omittedUnknown: (previous?.omittedUnknown ?? false) || unknown,
		...(previous?.omittedJobs === undefined ? {} : { omittedJobs: previous.omittedJobs }),
		...(previous?.nativeTotalBytes === undefined ? {} : { nativeTotalBytes: previous.nativeTotalBytes }),
		...(previous?.nativeArtifactElidedBytes === undefined ? {} : { nativeArtifactElidedBytes: previous.nativeArtifactElidedBytes }),
		...(previous?.reference === undefined ? {} : { reference: previous.reference }),
	};
}

function addOmittedSpans(span: Span, count: number): void {
	if (count <= 0) return;
	const previous = span.output;
	span.output = {
		omittedBytes: previous?.omittedBytes ?? 0,
		omittedSpans: (previous?.omittedSpans ?? 0) + count,
		omittedUnknown: previous?.omittedUnknown ?? false,
		...(previous?.omittedJobs === undefined ? {} : { omittedJobs: previous.omittedJobs }),
		...(previous?.nativeTotalBytes === undefined ? {} : { nativeTotalBytes: previous.nativeTotalBytes }),
		...(previous?.nativeArtifactElidedBytes === undefined ? {} : { nativeArtifactElidedBytes: previous.nativeArtifactElidedBytes }),
		...(previous?.reference === undefined ? {} : { reference: previous.reference }),
	};
}

function addOmittedJobs(span: Span, count: number): void {
	if (count <= 0) return;
	const previous = span.output;
	span.output = {
		omittedBytes: previous?.omittedBytes ?? 0,
		omittedSpans: previous?.omittedSpans ?? 0,
		omittedUnknown: previous?.omittedUnknown ?? false,
		omittedJobs: Math.max(previous?.omittedJobs ?? 0, count),
		...(previous?.nativeTotalBytes === undefined ? {} : { nativeTotalBytes: previous.nativeTotalBytes }),
		...(previous?.nativeArtifactElidedBytes === undefined ? {} : { nativeArtifactElidedBytes: previous.nativeArtifactElidedBytes }),
		...(previous?.reference === undefined ? {} : { reference: previous.reference }),
	};
}

/**
 * Accumulates turn and tool spans for the current session.
 *
 * Every mutator returns void and mutates in place: the dashboard repaints from a
 * timer, so allocating a new tree per streamed token would be pure waste.
 */
export class SessionTrace {
	private turns: Span[] = [];
	private toolsByCallId = new Map<string, Span>();
	private toolNamesByCallId = new Map<string, string>();
	private taskSpansByCallId = new Map<string, Span>();
	private terminalToolCallIds = new Map<string, Span>();
	private orphanTerminalToolCallIds = new Set<string>();
	private omittedCalls = new Map<string, Span>();
	private omittedWork = new Map<Span, { pending: number; failed: boolean; cancelled: boolean; unknown: boolean }>();
	private jobsByAgentId = new Map<string, Span>();
	private jobsByNativeId = new Map<string, Span>();
	private endedTurns = new Set<Span>();
	private turnStopReasons = new Map<Span, "aborted" | "error" | undefined>();
	private turnCounter = 0;

	/** Roots for the trace pane; newest turn last, matching a log's reading order. */
	roots(): Span[] {
		return this.turns;
	}

	current(): Span | undefined {
		return this.turns[this.turns.length - 1];
	}

	stats(): SessionTraceStats {
		let spanCount = 0, retainedBytes = 0, outputBytes = 0, omittedSpans = 0;
		for (const turn of this.turns) walkSpans(turn, (span) => {
			spanCount++;
			retainedBytes += spanRetainedBytes(span);
			outputBytes += spanOutputBytes(span);
			omittedSpans += span.output?.omittedSpans ?? 0;
		});
		return { turnCount: this.turns.length, spanCount, retainedBytes, outputBytes, omittedSpans };
	}

	private boundTrace(): void {
		const spans: Span[] = [];
		for (const turn of this.turns) walkSpans(turn, (span) => spans.push(span));
		let outputBytes = 0, retainedBytes = 0;
		for (const span of spans) { outputBytes += spanOutputBytes(span); retainedBytes += spanRetainedBytes(span); }
		for (const span of spans) {
			while ((span.logs?.length ?? 0) > 0 && (outputBytes > TRACE_LIMITS.maxTraceOutputBytes || retainedBytes > TRACE_LIMITS.maxTraceBytes)) {
				const before = spanOutputBytes(span);
				span.logs!.shift();
				const bytes = before - spanOutputBytes(span);
				outputBytes -= bytes; retainedBytes -= bytes;
				addOmittedBytes(span, bytes);
			}
		}
	}

	startTurn(now: number): void {
		this.turnCounter += 1;
		const turn: Span = {
			id: `turn/${this.turnCounter}`,
			label: `turn ${this.turnCounter}`,
			status: "running",
			startedAt: now,
			children: [],
		};
		this.turns.push(turn);
		if (this.turns.length > MAX_TURNS) {
			const dropped = this.turns.shift();
			this.endedTurns.delete(dropped!);
			this.turnStopReasons.delete(dropped!);
			this.omittedWork.delete(dropped!);
			for (const [id, owner] of this.omittedCalls) if (owner === dropped) this.omittedCalls.delete(id);
			const contains = (root: Span | undefined, target: Span): boolean =>
				root === target || (root?.children ?? []).some((child) => contains(child, target));
			for (const [id, span] of this.toolsByCallId) if (contains(dropped, span)) {
				this.toolsByCallId.delete(id);
				this.toolNamesByCallId.delete(id);
			}
			for (const [id, span] of this.taskSpansByCallId) if (contains(dropped, span)) this.taskSpansByCallId.delete(id);
			for (const [id, span] of this.terminalToolCallIds) if (contains(dropped, span)) this.terminalToolCallIds.delete(id);
			for (const [id, span] of this.jobsByAgentId) if (contains(dropped, span)) this.jobsByAgentId.delete(id);
			for (const [id, span] of this.jobsByNativeId) if (contains(dropped, span)) this.jobsByNativeId.delete(id);
			for (const owner of this.omittedWork.keys()) if (contains(dropped, owner)) this.omittedWork.delete(owner);
		}
	}

	private rememberOrphan(id: string): void {
		this.orphanTerminalToolCallIds.add(id);
		if (this.orphanTerminalToolCallIds.size > MAX_ORPHAN_TERMINAL_CALL_IDS) {
			this.orphanTerminalToolCallIds.delete(this.orphanTerminalToolCallIds.values().next().value!);
		}
	}

	private workFor(owner: Span) {
		let work = this.omittedWork.get(owner);
		if (!work) {
			work = { pending: 0, failed: false, cancelled: false, unknown: false };
			this.omittedWork.set(owner, work);
		}
		return work;
	}

	private hasUnsettled(span: Span): boolean {
		if (span.status === "running" || span.status === "pending") return true;
		const omitted = this.omittedWork.get(span);
		if (omitted && (omitted.pending > 0 || omitted.unknown)) return true;
		return (span.children ?? []).some((child) => this.hasUnsettled(child));
	}

	private reconcileTurn(turn: Span, now: number): void {
		if (!this.endedTurns.has(turn)) return;
		const omitted = this.omittedWork.get(turn);
		if ((omitted && (omitted.pending > 0 || omitted.unknown)) || (turn.children ?? []).some((child) => this.hasUnsettled(child))) {
			turn.status = "running";
			turn.cls = "unknown";
			turn.endedAt = undefined;
			return;
		}
		const failed = omitted?.failed || (turn.children ?? []).some((child) => this.hasFailure(child));
		const cancelled = !failed && (omitted?.cancelled || (turn.children ?? []).some((child) => this.hasCancellation(child)));
		const stopReason = this.turnStopReasons.get(turn);
		turn.status = failed || stopReason === "error" ? "failure" : cancelled || stopReason === "aborted" ? "skipped" : "success";
		turn.cls = turn.status === "failure" ? (failed ? "tool" : undefined) : turn.status === "skipped" ? "cancelled" : undefined;
		turn.endedAt ??= now;
	}

	private hasFailure(span: Span): boolean {
		return span.status === "failure" || this.omittedWork.get(span)?.failed === true || (span.children ?? []).some((child) => this.hasFailure(child));
	}

	private hasCancellation(span: Span): boolean {
		return span.status === "skipped" || this.omittedWork.get(span)?.cancelled === true || (span.children ?? []).some((child) => this.hasCancellation(child));
	}

	private reconcileEndedTurns(now: number): void {
		for (const span of this.taskSpansByCallId.values()) {
			if ((span.children?.length ?? 0) === 0) continue;
			const omitted = this.omittedWork.get(span);
			if ((omitted && (omitted.pending > 0 || omitted.unknown)) || span.children!.some((child) => this.hasUnsettled(child))) {
				span.status = "running";
				span.cls = "unknown";
				span.endedAt = undefined;
			} else if (span.children!.some((child) => this.hasFailure(child))) {
				span.status = "failure";
				span.cls = "tool";
				span.endedAt ??= now;
			} else if (span.children!.some((child) => this.hasCancellation(child))) {
				span.status = "skipped";
				span.cls = "cancelled";
				span.endedAt ??= now;
			} else {
				span.status = "success";
				span.cls = undefined;
				span.endedAt ??= now;
			}
		}
		for (const turn of this.endedTurns) this.reconcileTurn(turn, now);
	}

	endTurn(now: number, message?: unknown): void {
		const turn = this.current();
		if (!turn || this.endedTurns.has(turn)) return;
		this.endedTurns.add(turn);
		const stopReason =
			message && typeof message === "object" && "stopReason" in message && (message.stopReason === "aborted" || message.stopReason === "error")
				? message.stopReason
				: undefined;
		this.turnStopReasons.set(turn, stopReason);
		this.reconcileTurn(turn, now);
	}

	startTool(toolCallId: string, toolName: string, args: unknown, now: number): void {
		toolCallId = compactIdentifier(toolCallId);
		toolName = safePreview(toolName, 64, "head").text || "tool";
		if (this.toolsByCallId.has(toolCallId) || this.terminalToolCallIds.has(toolCallId) || this.orphanTerminalToolCallIds.has(toolCallId) || this.omittedCalls.has(toolCallId)) return;
		let turn = this.current();
		if (!turn || turn.status !== "running") {
			this.startTurn(now);
			turn = this.current();
		}
		if (!turn) return;
		const span: Span = {
			id: `tool/${compactIdentifier(toolCallId)}`,
			label: describeToolCall(toolName, args),
			status: "running",
			startedAt: now,
			logs: [],
		};
		if (countSpans(turn) >= TRACE_LIMITS.maxSpansPerTurn || this.stats().spanCount >= TRACE_LIMITS.maxRetainedSpans) {
			addOmittedSpans(turn, 1);
			this.workFor(turn).pending++;
			this.omittedCalls.set(toolCallId, turn);
			if (this.omittedCalls.size > MAX_ORPHAN_TERMINAL_CALL_IDS) {
				const oldest = this.omittedCalls.entries().next().value!;
				this.workFor(oldest[1]).unknown = true;
				this.omittedCalls.delete(oldest[0]);
			}
			return;
		}
		turn.children?.push(span);
		this.toolsByCallId.set(toolCallId, span);
		this.toolNamesByCallId.set(toolCallId, toolName);
	}

	private updateTaskDetails(span: Span, details: NativeTaskDetails, now: number): void {
		const progress: NativeTaskProgress[] = [];
		if ((details.progress?.length ?? 0) > TRACE_LIMITS.maxJobsPerTool) {
			addOmittedSpans(span, details.progress!.length - TRACE_LIMITS.maxJobsPerTool);
			this.workFor(span).unknown = true;
		}
		for (const value of (details.progress ?? []).slice(0, TRACE_LIMITS.maxJobsPerTool)) {
			if (!value || typeof value !== "object") continue;
			progress.push({
				id: "id" in value ? value.id : undefined,
				status: "status" in value ? value.status : undefined,
			});
		}
		const primaryJobId = typeof details.async?.jobId === "string" ? details.async.jobId : undefined;
		for (let index = 0; index < progress.length; index++) {
			const row = progress[index]!;
			if (typeof row.id !== "string" || !row.id) continue;
			const nativeAgentId = compactIdentifier(row.id);
			let job = this.jobsByAgentId.get(nativeAgentId);
			if (!job) {
				if ((span.children?.length ?? 0) >= TRACE_LIMITS.maxJobsPerTool || this.stats().spanCount >= TRACE_LIMITS.maxRetainedSpans || countSpans(this.current()!) >= TRACE_LIMITS.maxSpansPerTurn) { addOmittedSpans(span, 1); this.workFor(span).unknown = true; continue; }
				const safeId = compactIdentifier(row.id);
				job = { id: `${span.id}/job/${safeId}`, label: safePreview(`task ${row.id}`, TRACE_LIMITS.maxLabelBytes, "head").text, status: "running", startedAt: now };
				span.children ??= [];
				span.children.push(job);
				this.jobsByAgentId.set(nativeAgentId, job);
			}
			const nativeId = index === 0 ? primaryJobId : undefined;
			if (nativeId) {
				const safeNativeId = compactIdentifier(nativeId);
				for (const [id, owner] of this.jobsByNativeId) if (owner === job && id !== safeNativeId) this.jobsByNativeId.delete(id);
				this.jobsByNativeId.set(safeNativeId, job);
			}
			const status = nativeTaskStatus(row.status);
			if (status) this.applyJobStatus(job, status, now);
		}
		if (progress.length === 0 && primaryJobId && details.async?.state !== undefined) {
			let job = this.jobsByNativeId.get(compactIdentifier(primaryJobId));
			if (!job) {
				if ((span.children?.length ?? 0) >= TRACE_LIMITS.maxJobsPerTool || this.stats().spanCount >= TRACE_LIMITS.maxRetainedSpans || countSpans(this.current()!) >= TRACE_LIMITS.maxSpansPerTurn) { addOmittedSpans(span, 1); this.workFor(span).unknown = true; return; }
				job = { id: `${span.id}/job/${compactIdentifier(primaryJobId)}`, label: safePreview(`task ${primaryJobId}`, TRACE_LIMITS.maxLabelBytes, "head").text, status: "running", startedAt: now };
				span.children ??= [];
				span.children.push(job);
				this.jobsByNativeId.set(compactIdentifier(primaryJobId), job);
			}
			const status = nativeTaskStatus(details.async.state);
			if (status) this.applyJobStatus(job, status, now);
		}
	}

	private applyJobStatus(span: Span, status: NativeTaskStatus, now: number): void {
		if (span.status === "success" || span.status === "failure" || span.status === "skipped") return;
		span.status = spanStatus(status);
		if (span.status === "failure") span.cls = "tool";
		else if (span.status === "skipped") span.cls = "cancelled";
		else span.cls = undefined;
		if (span.status !== "running" && span.status !== "pending") span.endedAt ??= now;
	}

	updateTool(toolCallId: string, partial: unknown, now = Date.now()): void {
		toolCallId = compactIdentifier(toolCallId);
		if (this.terminalToolCallIds.has(toolCallId) || this.orphanTerminalToolCallIds.has(toolCallId)) return;
		const span = this.toolsByCallId.get(toolCallId) ?? this.taskSpansByCallId.get(toolCallId);
		if (!span) return;
		const details = nativeTaskDetails(partial);
		if (details) {
			this.updateTaskDetails(span, details, now);
			this.taskSpansByCallId.set(toolCallId, span);
		}
		const extracted = extractText(partial);
		const cumulativeBash = this.toolNamesByCallId.get(toolCallId) === "bash";
		if (extracted.hasText) this.applyOutput(span, extracted, cumulativeBash, false, partial);
		this.reconcileEndedTurns(now);
	}

	endTool(toolCallId: string, result: unknown, isError: boolean, now: number): void {
		toolCallId = compactIdentifier(toolCallId);
		const owner = this.omittedCalls.get(toolCallId);
		if (owner) {
			const work = this.workFor(owner);
			work.pending--;
			work.cancelled ||= nativeCancellation(result);
			work.failed ||= isError && !nativeCancellation(result);
			const details = nativeTaskDetails(result);
			if (details && (details.async || details.progress?.length)) work.unknown = true;
			this.omittedCalls.delete(toolCallId);
			this.rememberOrphan(toolCallId);
			this.reconcileEndedTurns(now);
			return;
		}
		if (this.terminalToolCallIds.has(toolCallId) || this.orphanTerminalToolCallIds.has(toolCallId)) return;
		const span = this.toolsByCallId.get(toolCallId);
		if (!span) {
			this.rememberOrphan(toolCallId);
			return;
		}
		const details = nativeTaskDetails(result);
		if (details) {
			this.updateTaskDetails(span, details, now);
			this.taskSpansByCallId.set(toolCallId, span);
		}
		span.endedAt = now;
		if (nativeCancellation(result)) {
			span.status = "skipped";
			span.cls = "cancelled";
		} else if (isError) {
			span.status = "failure";
			span.cls = "tool";
		} else {
			span.status = "success";
			span.cls = undefined;
		}
		const extracted = extractText(result);
		const cumulativeBash = this.toolNamesByCallId.get(toolCallId) === "bash";
		if (extracted.hasText || nativeTruncation(result)) this.applyOutput(span, extracted, cumulativeBash, true, result);
		this.terminalToolCallIds.set(toolCallId, span);
		this.toolsByCallId.delete(toolCallId);
		this.toolNamesByCallId.delete(toolCallId);
		this.boundTrace();
		this.reconcileEndedTurns(now);
	}

	private applyOutput(span: Span, extracted: ExtractedText, replace: boolean, terminal: boolean, source: unknown): void {
		const accumulated = replace ? extracted.text : [...(span.logs ?? []), ...(extracted.text ? [extracted.text] : [])].join("\n");
		const lines = accumulated ? accumulated.split("\n").slice(-MAX_LOG_LINES).join("\n") : "";
		const bounded = boundedUtf8Tail(lines, TRACE_LIMITS.maxToolPreviewBytes);
		span.logs = bounded.text ? bounded.text.split("\n") : [];
		const locallyOmitted = Buffer.byteLength(accumulated, "utf8") - Buffer.byteLength(bounded.text, "utf8");
		if (replace) {
			const previous = span.output;
			span.output = { omittedBytes: extracted.omittedBytes + locallyOmitted, omittedSpans: previous?.omittedSpans ?? 0, omittedUnknown: extracted.omittedUnknown || (previous?.omittedUnknown ?? false), ...(previous?.omittedJobs === undefined ? {} : { omittedJobs: previous.omittedJobs }), ...(previous?.nativeTotalBytes === undefined ? {} : { nativeTotalBytes: previous.nativeTotalBytes }), ...(previous?.nativeArtifactElidedBytes === undefined ? {} : { nativeArtifactElidedBytes: previous.nativeArtifactElidedBytes }), ...(previous?.reference ? { reference: previous.reference } : {}) };
		} else addOmittedBytes(span, extracted.omittedBytes + locallyOmitted, extracted.omittedUnknown);
		const truncation = terminal ? nativeTruncation(source) : undefined;
		if (truncation) {
			const previous = span.output;
			const nativeTotalBytes = typeof truncation.totalBytes === "number" && Number.isFinite(truncation.totalBytes) ? truncation.totalBytes : undefined;
			const artifactId = typeof truncation.artifactId === "string" && /^\d{1,128}$/.test(truncation.artifactId) ? truncation.artifactId : undefined;
			span.output = {
				omittedBytes: (previous?.omittedBytes ?? 0) + Math.max(0, typeof truncation.elidedBytes === "number" ? truncation.elidedBytes : (nativeTotalBytes === undefined ? 0 : nativeTotalBytes - (typeof truncation.outputBytes === "number" ? truncation.outputBytes : Buffer.byteLength(extracted.text, "utf8")))),
				omittedSpans: previous?.omittedSpans ?? 0,
				omittedUnknown: previous?.omittedUnknown ?? false,
				...(previous?.omittedJobs === undefined ? {} : { omittedJobs: previous.omittedJobs }),
				...(nativeTotalBytes === undefined ? {} : { nativeTotalBytes }),
				...(typeof truncation.artifactElidedBytes === "number" ? { nativeArtifactElidedBytes: truncation.artifactElidedBytes } : {}),
				...(artifactId && !nativeArtifactError(source) ? { reference: { kind: "unavailable", uri: `artifact://${artifactId}`, sourceSessionId: "pending", reason: "artifact not yet resolved" } as NativeOutputReference } : {}),
			};
		}
		this.boundTrace();
	}

	setArtifactReference(toolCallId: string, sourceSessionId: string, path: string | null): void {
		toolCallId = compactIdentifier(toolCallId);
		const span = this.terminalToolCallIds.get(toolCallId);
		const reference = span?.output?.reference;
		if (!span || !reference || reference.kind !== "unavailable") return;
		span.output = {
			...span.output!,
			reference: path
			? { kind: "available", uri: reference.uri!, path: safePreview(path, 512, "head").text, sourceSessionId: safePreview(sourceSessionId, 80, "head").text, complete: (span.output?.nativeArtifactElidedBytes ?? 0) === 0 }
			: { kind: "unavailable", uri: reference.uri, sourceSessionId: safePreview(sourceSessionId, 80, "head").text, reason: "artifact expired or could not be resolved" },
		};
	}

	syncAsyncJobs(snapshot: AsyncJobSnapshot | null | undefined, now = Date.now()): void {
		if (!snapshot) return;
		const lists = [snapshot.running ?? [], snapshot.recent ?? []];
		let visited = 0;
		let omitted = 0;
		for (let listIndex = 0; listIndex < lists.length; listIndex++) {
			const list = lists[listIndex]!;
			const count = Math.min(list.length, TRACE_LIMITS.maxNativeJobsPerSync - visited);
			for (let index = 0; index < count; index++) {
				const job = list[index]!;
				const span = this.jobsByNativeId.get(compactIdentifier(job.id)) ?? (job.agentId ? this.jobsByAgentId.get(compactIdentifier(job.agentId)) : undefined);
				if (!span) continue;
				const status = job.status === "cancelled" || job.status === "canceled" ? "aborted" : nativeTaskStatus(job.status);
				if (status) this.applyJobStatus(span, status, now);
			}
			visited += count;
			if (count < list.length) {
				omitted += list.length - count;
				for (let later = listIndex + 1; later < lists.length; later++) omitted += lists[later]!.length;
				break;
			}
		}
		if (omitted > 0) {
			const turn = this.current();
			if (turn) addOmittedJobs(turn, omitted);
		}
		this.reconcileEndedTurns(now);
	}

	/** Deepest running span, for the one-line rail under the editor. */
	active(): Span | undefined {
		const turn = this.current();
		if (!turn || turn.status !== "running") return undefined;
		const deepest = (span: Span): Span | undefined => {
			for (let i = (span.children?.length ?? 0) - 1; i >= 0; i--) {
				const child = span.children![i]!;
				if (child.status === "running" || child.status === "pending") return deepest(child) ?? child;
			}
			return undefined;
		};
		return deepest(turn) ?? turn;
	}

	clear(): void {
		this.turns = [];
		this.toolsByCallId.clear();
		this.toolNamesByCallId.clear();
		this.taskSpansByCallId.clear();
		this.terminalToolCallIds.clear();
		this.orphanTerminalToolCallIds.clear();
		this.omittedCalls.clear();
		this.omittedWork.clear();
		this.jobsByAgentId.clear();
		this.jobsByNativeId.clear();
		this.endedTurns.clear();
		this.turnStopReasons.clear();
		this.turnCounter = 0;
	}
}

function nativeTruncation(value: unknown): Record<string, unknown> | undefined {
	if (!value || typeof value !== "object" || !("details" in value)) return undefined;
	const details = value.details;
	if (!details || typeof details !== "object" || !("meta" in details)) return undefined;
	const meta = details.meta;
	if (!meta || typeof meta !== "object" || !("truncation" in meta)) return undefined;
	const truncation = meta.truncation;
	return truncation && typeof truncation === "object" ? truncation as Record<string, unknown> : undefined;
}

function nativeArtifactError(value: unknown): boolean {
	if (!value || typeof value !== "object" || !("details" in value)) return false;
	const details = value.details;
	if (!details || typeof details !== "object" || !("meta" in details)) return false;
	const meta = details.meta;
	return Boolean(meta && typeof meta === "object" && "artifactError" in meta && meta.artifactError);
}
