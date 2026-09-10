/**
 * Dagger's progress vocabulary, ported.
 *
 * Every glyph, duration rule, and color role below mirrors the Dagger CLI TUI
 * (`dagql/idtui/symbols.go`, `frontend.go`, `dagql/dagui/spans.go`) so a Bluefin
 * review reads like a Dagger trace: rails for structure, one icon per status,
 * duration inline after the title, chrome restrained to the point of invisibility.
 *
 * The one addition is `findings`: a review that completed and reported problems is
 * neither a success nor an engine failure, and Dagger's own diamond carries it.
 */

/** Status of one pipeline step. */
export type SpanStatus = "pending" | "running" | "success" | "findings" | "failure" | "cached" | "skipped";

export const GLYPH = {
	/** dagql/idtui: braille spinner, 80ms per frame. */
	spinner: ["⣾", "⣽", "⣻", "⢿", "⡿", "⣟", "⣯", "⣷"],
	running: "◐",
	success: "✔",
	failure: "✘",
	findings: "◆",
	cached: "$",
	pending: "○",
	skipped: "∅",
	leaf: "●",
	/** Tree chrome. */
	branchMid: "├╴",
	branchEnd: "╰╴",
	railBar: "│ ",
	railGap: "  ",
	/** Log gutters: solid while streaming, dashed where output was dropped. */
	logBar: "┃ ",
	logDashed: "┇ ",
	caretOpen: "▼",
	caretClosed: "▶",
	breadcrumb: " › ",
	dot: "·",
	diamond: "◆",
	hex: "⬢",
} as const;

export const SPINNER_TICK_MS = 80;

/** Theme roles, named so the renderer never reaches for a raw ANSI code. */
export type PaintRole =
	| "accent"
	| "success"
	| "error"
	| "warning"
	| "dim"
	| "muted"
	| "text"
	| "border"
	| "toolTitle";

/**
 * The renderer paints through this seam rather than an omp `Theme`, so tree
 * rendering stays pure and testable without a TUI attached.
 */
export interface Painter {
	fg(role: PaintRole, text: string): string;
	bold(text: string): string;
	inverse(text: string): string;
}

/** Identity painter: rendering with no styling, for tests and non-TTY output. */
export const PLAIN_PAINTER: Painter = {
	fg: (_role, text) => text,
	bold: (text) => text,
	inverse: (text) => text,
};

/** Icon for a status; `frame` animates the running spinner. */
export function statusIcon(status: SpanStatus, frame = 0): string {
	switch (status) {
		case "running":
			return GLYPH.spinner[((frame % GLYPH.spinner.length) + GLYPH.spinner.length) % GLYPH.spinner.length]!;
		case "success":
			return GLYPH.success;
		case "failure":
			return GLYPH.failure;
		case "findings":
			return GLYPH.findings;
		case "cached":
			return GLYPH.cached;
		case "skipped":
			return GLYPH.skipped;
		default:
			return GLYPH.pending;
	}
}

/** Dagger `statusColor`: the loud palette, used for icons and titles. */
export function statusRole(status: SpanStatus): PaintRole {
	switch (status) {
		case "running":
			return "warning";
		case "success":
			return "success";
		case "failure":
			return "error";
		case "findings":
			return "warning";
		case "cached":
			return "accent";
		default:
			return "dim";
	}
}

/** Dagger `restrainedStatusColor`: chrome only shouts while running or failed. */
export function restrainedRole(status: SpanStatus): PaintRole {
	switch (status) {
		case "running":
			return "warning";
		case "failure":
			return "error";
		default:
			return "dim";
	}
}

/**
 * Dagger `FormatDuration`: tenths under a minute, then whole units, no padding.
 * A step that has not started renders nothing rather than a fake `0.0s`.
 */
export function formatDuration(ms: number): string {
	if (!Number.isFinite(ms) || ms < 0) return "";
	const seconds = ms / 1000;
	if (seconds < 60) return `${seconds.toFixed(1)}s`;

	const totalSeconds = Math.round(seconds);
	const minutes = Math.floor(totalSeconds / 60) % 60;
	const hours = Math.floor(totalSeconds / 3600) % 24;
	const days = Math.floor(totalSeconds / 86400);
	const secs = totalSeconds % 60;

	if (totalSeconds < 3600) return `${minutes}m${secs}s`;
	if (totalSeconds < 86400) return `${hours}h${minutes}m${secs}s`;
	return `${days}d${hours}h${minutes}m${secs}s`;
}
