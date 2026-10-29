/** Small, passive notice state shared by cache-busted Review module copies. */

export type NoticeLevel = "info" | "warning" | "error";

export interface ReviewNotice {
	readonly id: string;
	readonly sessionId: string;
	readonly level: NoticeLevel;
	readonly message: string;
	readonly summary: string;
	readonly action: string;
}

export interface NoticePainter {
	fg(role: NoticeLevel | "dim", text: string): string;
	bold(text: string): string;
}

export interface NoticeHost {
	notify(message: string, level?: NoticeLevel): void;
}

interface SharedNoticeState {
	sessionId?: string;
	current?: ReviewNotice;
	readonly delivered: Set<string>;
}

const STATE_KEY = Symbol.for("com.review.native-notice.v1");
const MAX_MESSAGE_LENGTH = 240;
const MAX_DELIVERED_IDS = 256;

function sharedState(): SharedNoticeState {
	const root = globalThis as typeof globalThis & { [STATE_KEY]?: SharedNoticeState };
	return root[STATE_KEY] ??= { delivered: new Set<string>() };
}

function safeMessage(value: string): string {
	return value.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ").replace(/\s+/g, " ").trim().slice(0, MAX_MESSAGE_LENGTH);
}

/** ANSI-capable themed one-line banner suitable for a native status/widget area. */
export function renderNoticeBanner(notice: ReviewNotice | undefined, painter: NoticePainter): string[] {
	if (!notice) return [];
	const label = painter.bold(painter.fg(notice.level, "Review"));
	return [
		`${label} ${painter.fg("dim", "·")} ${painter.fg(notice.level, safeMessage(notice.summary))}`,
		painter.bold(painter.fg(notice.level, `Next: ${safeMessage(notice.action)}`)),
	];
}

/**
 * Lifecycle events are explicitly supplied by the host integration. This helper
 * never subscribes, schedules work, changes focus, or performs retries.
 */
export function createReviewNoticeComponent(host?: NoticeHost) {
	const state = sharedState();
	return {
		get current(): ReviewNotice | undefined { return state.current; },
		sessionChanged(sessionId: string | undefined): boolean {
			if (state.sessionId === sessionId) return false;
			state.sessionId = sessionId;
			state.current = undefined;
			state.delivered.clear();
			return true;
		},
		publish(input: { id: string; sessionId: string; level: NoticeLevel; message: string; summary?: string; action?: string }): boolean {
			if (!input.id || !input.sessionId || input.sessionId !== state.sessionId) return false;
			const key = `${input.sessionId}\u0000${input.id}`;
			if (state.delivered.has(key)) return false;
			const message = safeMessage(input.message);
			if (!message) return false;
			state.delivered.add(key);
			while (state.delivered.size > MAX_DELIVERED_IDS) {
				const oldest = state.delivered.values().next().value;
				if (oldest === undefined) break;
				state.delivered.delete(oldest);
			}
			const next = {
				id: input.id,
				sessionId: input.sessionId,
				level: input.level,
				message,
				summary: safeMessage(input.summary ?? message.slice(0, 100)),
				action: safeMessage(input.action ?? "/review status"),
			};
			if (!state.current || input.level === "error" || state.current.level === "info" || (input.level === "warning" && state.current.level !== "error")) state.current = next;
			host?.notify(message, input.level);
			return true;
		},
		clear(): void {
			state.current = undefined;
			state.delivered.clear();
		},
	};
}
