/** Small, passive notice state shared by cache-busted Review module copies. */

import { visibleWidth } from "./width.ts";

export type NoticeLevel = "info" | "warning" | "error";

export interface ReviewNotice {
	readonly id: string;
	readonly sessionId: string;
	readonly level: NoticeLevel;
	readonly title: string;
	readonly outcome: string;
	readonly action: string;
	readonly steps: readonly string[];
	readonly details: string;
	readonly resolution?: string;
}

export interface NoticePainter {
	fg(role: NoticeLevel | "dim" | "accent" | "text" | "border", text: string): string;
	bold(text: string): string;
}

export interface NoticeContent {
	readonly title: string;
	readonly outcome: string;
	readonly action: string;
	readonly steps?: readonly string[];
	readonly details: string;
}

export interface NoticeHost {
	notify(message: string, level?: NoticeLevel): void;
}

interface NativeToastDescribeContext {
	supports(kind: "toast"): boolean;
}

interface SharedNoticeState {
	sessionId?: string;
	current?: ReviewNotice;
	latestDetails?: ReviewNotice;
	readonly delivered: Map<string, string>;
}

const STATE_KEY = Symbol.for("com.review.native-notice.v3");
const MAX_TEXT_LENGTH = 1_200;
const MAX_DELIVERED_IDS = 256;

function sharedState(): SharedNoticeState {
	const root = globalThis as typeof globalThis & { [STATE_KEY]?: SharedNoticeState };
	return root[STATE_KEY] ??= { delivered: new Map<string, string>() };
}

function safeText(value: string, max = MAX_TEXT_LENGTH): string {
	return value.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ").replace(/\s+/g, " ").trim().slice(0, max);
}

function safeDiagnostic(value: string): string {
	return value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g, "")
		.split(/\r?\n/).map((line) => line.replace(/[\t ]+/g, " ").trimEnd()).join("\n").trim().slice(0, MAX_TEXT_LENGTH);
}

function safeSteps(value: readonly string[] | undefined, fallback: string): string[] {
	const steps = (value?.length ? value : [fallback])
		.map((step) => safeText(step, 500))
		.filter(Boolean)
		.slice(0, 5);
	return steps.length ? steps : ["Run /review details to inspect the saved diagnostic."];
}

function wrap(text: string, width: number, indent = ""): string[] {
	const available = Math.max(8, width - visibleWidth(indent));
	const words = text.split(/\s+/).filter(Boolean).flatMap((word) => {
		if (visibleWidth(word) <= available) return [word];
		const chunks: string[] = [];
		let chunk = "";
		for (const character of word) {
			if (chunk && visibleWidth(`${chunk}${character}`) > available) {
				chunks.push(chunk);
				chunk = character;
			} else chunk += character;
		}
		if (chunk) chunks.push(chunk);
		return chunks;
	});
	const lines: string[] = [];
	let line = "";
	for (const word of words) {
		if (!line) line = word;
		else if (visibleWidth(`${line} ${word}`) <= available) line += ` ${word}`;
		else { lines.push(`${indent}${line}`); line = word; }
	}
	if (line) lines.push(`${indent}${line}`);
	return lines.length ? lines : [indent];
}

export function wrapNoticeText(text: string, width: number): string[] {
	return wrap(text, width);
}

/** Compact themed card: severity title, truthful outcome, then the next action. */
export function renderNoticeBanner(notice: ReviewNotice | undefined, painter: NoticePainter, width = 100): string[] {
	if (!notice) return [];
	const columns = Math.min(80, Math.max(14, width));
	const left = painter.fg("border", "│");
	const title = safeText(notice.title, 100);
	const outcome = safeText(notice.outcome, 240);
	const lines = [
		...wrap(title, columns - 2, "  ").map((line) => `${left} ${painter.bold(painter.fg(notice.level, line.trimStart()))}`),
		...wrap(outcome, columns - 2, "  ").map((line) => `${left} ${painter.fg("text", line.trimStart())}`),
	];
	for (const [index, step] of notice.steps.entries()) {
		const wrapped = wrap(step, columns - 2, "    ");
		for (let lineIndex = 0; lineIndex < wrapped.length; lineIndex++) {
			const content = wrapped[lineIndex]!.trimStart();
			const number = lineIndex === 0 ? painter.bold(painter.fg("accent", `${index + 1}.`)) : "  ";
			lines.push(`${left} ${number} ${paintControls(content, painter)}`);
		}
	}
	for (const line of wrap("Message box: /review details", columns - 2, "  ")) {
		lines.push(`${left} ${paintControls(line.trimStart(), painter)}`);
	}
	return lines;
}

function paintControls(text: string, painter: NoticePainter): string {
	const control = /(\/review(?:\s+(?:status|details|reconcile|revise|resume))?|\/settings|Alt\+[A-Za-z]|Structured Task Results|\b(?:Esc|press q|press s)\b)/gi;
	const parts: string[] = [];
	let cursor = 0;
	for (const match of text.matchAll(control)) {
		const index = match.index ?? 0;
		parts.push(text.slice(cursor, index), painter.fg("accent", match[0]));
		cursor = index + match[0].length;
	}
	parts.push(text.slice(cursor));
	return parts.join("");
}

/** Public TSP component contract; ANSI hosts render the persistent card instead. */
export function createNativeToastWidget(getCurrent: () => ReviewNotice | undefined) {
	let currentId: string | undefined;
	let toast: { k: "toast"; p: { text: string; sub: string; ttl: number } } | undefined;
	return {
		render: (_width: number): readonly string[] => [],
		describe: (context: NativeToastDescribeContext) => {
			const notice = getCurrent();
			if (!notice || !context.supports("toast")) return null;
			if (notice.id !== currentId) {
				currentId = notice.id;
				toast = { k: "toast", p: { text: notice.title, sub: `Next: ${safeText(notice.action, 96)}`, ttl: 2400 } };
			}
			return toast ?? null;
		},
	};
}

/** Lifecycle events are explicit. This helper never schedules work or changes focus. */
export function createReviewNoticeComponent(host?: NoticeHost) {
	const state = sharedState();
	return {
		get current(): ReviewNotice | undefined { return state.current; },
		get latestDetails(): ReviewNotice | undefined { return state.latestDetails; },
		sessionChanged(sessionId: string | undefined): boolean {
			if (state.sessionId === sessionId) return false;
			state.sessionId = sessionId;
			state.current = undefined;
			state.latestDetails = undefined;
			state.delivered.clear();
			return true;
		},
		publish(input: { id: string; sessionId: string; level: NoticeLevel; content: NoticeContent }): boolean {
			if (!input.id || !input.sessionId || input.sessionId !== state.sessionId) return false;
			const key = `${input.sessionId}\u0000${input.id}`;
			const content = {
				title: safeText(input.content.title, 100),
				outcome: safeText(input.content.outcome, 240),
				action: safeText(input.content.action, 120),
				steps: safeSteps(input.content.steps, input.content.action),
				details: safeDiagnostic(input.content.details),
			};
			if (!content.title || !content.outcome || !content.action) return false;
			const fingerprint = JSON.stringify([input.level, content]);
			if (state.delivered.get(key) === fingerprint) return false;
			state.delivered.delete(key);
			state.delivered.set(key, fingerprint);
			while (state.delivered.size > MAX_DELIVERED_IDS) {
			const oldest = state.delivered.keys().next().value;
				if (oldest === undefined) break;
				state.delivered.delete(oldest);
			}
			const next: ReviewNotice = { id: input.id, sessionId: input.sessionId, level: input.level, ...content };
			if (!state.current || input.level === "error" || state.current.level === "info" || (input.level === "warning" && state.current.level !== "error")) state.current = next;
			if (state.current?.id === next.id && state.current.level === next.level) state.latestDetails = next;
			host?.notify(`${content.title}. ${content.outcome} Next: ${content.action}`, input.level);
			return true;
		},
		acknowledge(): void {
			if (state.current) state.delivered.delete(`${state.current.sessionId}\u0000${state.current.id}`);
			state.current = undefined;
		},
		resolveCurrent(id: string, resolution: string, sessionId: string): ReviewNotice | undefined {
			if (sessionId !== state.sessionId) return undefined;
			const source = state.current?.id === id ? state.current : state.latestDetails?.id === id ? state.latestDetails : undefined;
			if (!source || source.sessionId !== sessionId || source.resolution) return undefined;
			const resolved = { ...source, resolution: safeText(resolution, 240) };
			if (state.current?.id === id) state.current = undefined;
			state.latestDetails = resolved;
			state.delivered.delete(`${resolved.sessionId}\u0000${resolved.id}`);
			return resolved;
		},
		clear(): void {
			state.current = undefined;
			state.latestDetails = undefined;
			state.delivered.clear();
		},
	};
}
