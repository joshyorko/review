/**
 * Terminal cell measurement.
 *
 * pi-tui refuses to render a line wider than the viewport, and every glyph in the
 * Dagger vocabulary (rails, carets, braille spinner) is styled, so `String.length`
 * is never the answer: it counts ANSI bytes as cells and wide CJK/emoji as one.
 * These two functions are the only measurement seam the renderer uses.
 */

/** CSI/OSC sequences, including the OSC 8 hyperlinks used for GitHub URLs. */
const ANSI_PATTERN =
	// biome-ignore lint/suspicious/noControlCharactersInRegex: matching terminal escapes is the point
	/[\u001B\u009B][[\]()#;?]*(?:(?:(?:[a-zA-Z\d]*(?:;[-a-zA-Z\d/#&.:=?%@~_]*)*)?\u0007)|(?:(?:\d{1,4}(?:;\d{0,4})*)?[\dA-PR-TZcf-ntqry=><~]))/g;

/** Strip styling so the remainder is exactly what the terminal paints. */
export function stripAnsi(text: string): string {
	return text.replace(ANSI_PATTERN, "");
}

function isZeroWidth(code: number): boolean {
	return (
		code === 0x200b || // zero width space
		code === 0x200d || // zero width joiner (emoji sequences)
		code === 0xfeff || // BOM
		(code >= 0x0300 && code <= 0x036f) || // combining diacriticals
		(code >= 0xfe00 && code <= 0xfe0f) // variation selectors
	);
}

function isWide(code: number): boolean {
	if (code < 0x1100) return false;
	return (
		code <= 0x115f ||
		code === 0x2329 ||
		code === 0x232a ||
		(code >= 0x2e80 && code <= 0xa4cf && code !== 0x303f) ||
		(code >= 0xac00 && code <= 0xd7a3) ||
		(code >= 0xf900 && code <= 0xfaff) ||
		(code >= 0xfe10 && code <= 0xfe19) ||
		(code >= 0xfe30 && code <= 0xfe6f) ||
		(code >= 0xff00 && code <= 0xff60) ||
		(code >= 0xffe0 && code <= 0xffe6) ||
		(code >= 0x1f300 && code <= 0x1f9ff) ||
		(code >= 0x20000 && code <= 0x3fffd)
	);
}

/** Visible terminal columns occupied by `text`. */
export function visibleWidth(text: string): number {
	let width = 0;
	for (const char of stripAnsi(text)) {
		const code = char.codePointAt(0) ?? 0;
		if (isZeroWidth(code)) continue;
		width += isWide(code) ? 2 : 1;
	}
	return width;
}

/**
 * Truncate to `limit` columns, preserving styling and re-emitting a reset so a
 * cut inside a styled run cannot bleed color into the rest of the frame.
 */
export function truncateToWidth(text: string, limit: number, ellipsis = "…"): string {
	if (limit <= 0) return "";
	if (visibleWidth(text) <= limit) return text;

	const tail = visibleWidth(ellipsis);
	const budget = Math.max(0, limit - tail);
	let width = 0;
	let out = "";
	let styled = false;
	let index = 0;

	while (index < text.length) {
		ANSI_PATTERN.lastIndex = index;
		const match = ANSI_PATTERN.exec(text);
		if (match && match.index === index) {
			out += match[0];
			styled = true;
			index += match[0].length;
			continue;
		}
		const char = String.fromCodePoint(text.codePointAt(index) ?? 0);
		const code = char.codePointAt(0) ?? 0;
		const cells = isZeroWidth(code) ? 0 : isWide(code) ? 2 : 1;
		if (width + cells > budget) break;
		out += char;
		width += cells;
		index += char.length;
	}

	return `${out}${styled ? "\u001b[0m" : ""}${ellipsis}`;
}

/** Pad to exactly `columns` visible cells, truncating when too long. */
export function fitToWidth(text: string, columns: number): string {
	const width = visibleWidth(text);
	if (width === columns) return text;
	if (width > columns) return truncateToWidth(text, columns);
	return text + " ".repeat(columns - width);
}
