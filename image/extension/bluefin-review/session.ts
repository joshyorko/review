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

const MAX_TURNS = 6;
const MAX_LOG_LINES = 12;
const MAX_ORPHAN_TERMINAL_CALL_IDS = MAX_TURNS * 8;

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
	return first ? `${toolName}(${first.split("\n")[0]})` : `${toolName}()`;
}

function textOf(value: unknown): string[] {
	if (typeof value === "string") return value.split("\n");
	if (Array.isArray(value)) {
		return value.flatMap((entry) => {
			if (entry && typeof entry === "object" && "text" in entry) return textOf((entry as { text?: unknown }).text);
			return [];
		});
	}
	if (value && typeof value === "object") {
		const record = value as { content?: unknown; output?: unknown };
		if (record.content !== undefined) return textOf(record.content);
		if (record.output !== undefined) return textOf(record.output);
	}
	return [];
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
	private taskSpansByCallId = new Map<string, Span>();
	private terminalToolCallIds = new Map<string, Span>();
	private orphanTerminalToolCallIds = new Set<string>();
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
			const contains = (root: Span | undefined, target: Span): boolean =>
				root === target || (root?.children ?? []).some((child) => contains(child, target));
			for (const [id, span] of this.toolsByCallId) if (contains(dropped, span)) this.toolsByCallId.delete(id);
			for (const [id, span] of this.taskSpansByCallId) if (contains(dropped, span)) this.taskSpansByCallId.delete(id);
			for (const [id, span] of this.terminalToolCallIds) if (contains(dropped, span)) this.terminalToolCallIds.delete(id);
			for (const [id, span] of this.jobsByAgentId) if (contains(dropped, span)) this.jobsByAgentId.delete(id);
			for (const [id, span] of this.jobsByNativeId) if (contains(dropped, span)) this.jobsByNativeId.delete(id);
		}
	}

	private hasUnsettled(span: Span): boolean {
		if (span.status === "running" || span.status === "pending") return true;
		return (span.children ?? []).some((child) => this.hasUnsettled(child));
	}

	private reconcileTurn(turn: Span, now: number): void {
		if (!this.endedTurns.has(turn)) return;
		if ((turn.children ?? []).some((child) => this.hasUnsettled(child))) {
			turn.status = "running";
			turn.cls = "unknown";
			turn.endedAt = undefined;
			return;
		}
		const failed = (turn.children ?? []).some((child) => this.hasFailure(child));
		const cancelled = !failed && (turn.children ?? []).some((child) => this.hasCancellation(child));
		const stopReason = this.turnStopReasons.get(turn);
		turn.status = failed || stopReason === "error" ? "failure" : cancelled || stopReason === "aborted" ? "skipped" : "success";
		turn.cls = turn.status === "failure" ? (failed ? "tool" : undefined) : turn.status === "skipped" ? "cancelled" : undefined;
		turn.endedAt ??= now;
	}

	private hasFailure(span: Span): boolean {
		return span.status === "failure" || (span.children ?? []).some((child) => this.hasFailure(child));
	}

	private hasCancellation(span: Span): boolean {
		return span.status === "skipped" || (span.children ?? []).some((child) => this.hasCancellation(child));
	}

	private reconcileEndedTurns(now: number): void {
		for (const span of this.taskSpansByCallId.values()) {
			if ((span.children?.length ?? 0) === 0) continue;
			if (span.children!.some((child) => this.hasUnsettled(child))) {
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
		if (this.toolsByCallId.has(toolCallId) || this.terminalToolCallIds.has(toolCallId) || this.orphanTerminalToolCallIds.has(toolCallId)) return;
		let turn = this.current();
		if (!turn || turn.status !== "running") {
			this.startTurn(now);
			turn = this.current();
		}
		if (!turn) return;
		const span: Span = {
			id: `tool/${toolCallId}`,
			label: describeToolCall(toolName, args),
			status: "running",
			startedAt: now,
			logs: [],
		};
		turn.children?.push(span);
		this.toolsByCallId.set(toolCallId, span);
	}

	private updateTaskDetails(span: Span, details: NativeTaskDetails, now: number): void {
		const progress = (details.progress ?? []).flatMap((value): NativeTaskProgress[] => {
			if (!value || typeof value !== "object") return [];
			return [{
				id: "id" in value ? value.id : undefined,
				status: "status" in value ? value.status : undefined,
			}];
		});
		const primaryJobId = typeof details.async?.jobId === "string" ? details.async.jobId : undefined;
		for (let index = 0; index < progress.length; index++) {
			const row = progress[index]!;
			if (typeof row.id !== "string" || !row.id) continue;
			let job = this.jobsByAgentId.get(row.id);
			if (!job) {
				job = { id: `${span.id}/job/${row.id}`, label: `task ${row.id}`, status: "running", startedAt: now };
				span.children ??= [];
				span.children.push(job);
				this.jobsByAgentId.set(row.id, job);
			}
			const nativeId = index === 0 ? primaryJobId : undefined;
			if (nativeId) this.jobsByNativeId.set(nativeId, job);
			const status = nativeTaskStatus(row.status);
			if (status) this.applyJobStatus(job, status, now);
		}
		if (progress.length === 0 && primaryJobId && details.async?.state !== undefined) {
			let job = this.jobsByNativeId.get(primaryJobId);
			if (!job) {
				job = { id: `${span.id}/job/${primaryJobId}`, label: `task ${primaryJobId}`, status: "running", startedAt: now };
				span.children ??= [];
				span.children.push(job);
				this.jobsByNativeId.set(primaryJobId, job);
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
		if (this.terminalToolCallIds.has(toolCallId) || this.orphanTerminalToolCallIds.has(toolCallId)) return;
		const span = this.toolsByCallId.get(toolCallId) ?? this.taskSpansByCallId.get(toolCallId);
		if (!span) return;
		const details = nativeTaskDetails(partial);
		if (details) {
			this.updateTaskDetails(span, details, now);
			this.taskSpansByCallId.set(toolCallId, span);
		}
		const lines = textOf(partial).filter((line) => line.trim().length > 0);
		if (lines.length > 0) span.logs = [...(span.logs ?? []), ...lines].slice(-MAX_LOG_LINES);
		this.reconcileEndedTurns(now);
	}

	endTool(toolCallId: string, result: unknown, isError: boolean, now: number): void {
		if (this.terminalToolCallIds.has(toolCallId) || this.orphanTerminalToolCallIds.has(toolCallId)) return;
		const span = this.toolsByCallId.get(toolCallId);
		if (!span) {
			this.orphanTerminalToolCallIds.add(toolCallId);
			if (this.orphanTerminalToolCallIds.size > MAX_ORPHAN_TERMINAL_CALL_IDS) {
				const oldest = this.orphanTerminalToolCallIds.values().next().value;
				if (typeof oldest === "string") this.orphanTerminalToolCallIds.delete(oldest);
			}
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
		const lines = textOf(result).filter((line) => line.trim().length > 0);
		if (lines.length > 0) span.logs = lines.slice(-MAX_LOG_LINES);
		this.terminalToolCallIds.set(toolCallId, span);
		this.toolsByCallId.delete(toolCallId);
		this.reconcileEndedTurns(now);
	}

	syncAsyncJobs(snapshot: AsyncJobSnapshot | null | undefined, now = Date.now()): void {
		if (!snapshot) return;
		for (const job of [...(snapshot.running ?? []), ...(snapshot.recent ?? [])]) {
			const span = this.jobsByNativeId.get(job.id) ?? (job.agentId ? this.jobsByAgentId.get(job.agentId) : undefined);
			if (!span) continue;
			const status = job.status === "cancelled" || job.status === "canceled" ? "aborted" : nativeTaskStatus(job.status);
			if (status) this.applyJobStatus(span, status, now);
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
		this.taskSpansByCallId.clear();
		this.terminalToolCallIds.clear();
		this.orphanTerminalToolCallIds.clear();
		this.jobsByAgentId.clear();
		this.jobsByNativeId.clear();
		this.endedTurns.clear();
		this.turnStopReasons.clear();
		this.turnCounter = 0;
	}
}
