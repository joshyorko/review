import { stripVTControlCharacters } from "node:util";
import { canonicalKey, rawKeyMatcher, type KeyMatcher } from "../../bluefin-review/keys.ts";
import { truncateToWidth, visibleWidth } from "../../bluefin-review/width.ts";

export interface EvidenceViewerPreview {
	readonly path: string;
	readonly text: string;
	readonly truncated: boolean;
}

export interface EvidenceViewerOptions {
	readonly preview: EvidenceViewerPreview;
	readonly title?: string;
	readonly tui: { requestRender(): void; terminal?: { readonly rows?: number } };
	readonly done: () => void;
	readonly matchKey?: KeyMatcher;
}

function safeText(value: string): string {
	return stripVTControlCharacters(value)
		.replace(/\t/g, "    ")
		.replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, "");
}

function wrap(text: string, columns: number): string[] {
	const lines: string[] = [];
	for (const original of text.split("\n")) {
		let remaining = original.replace(/\r/g, "");
		if (remaining.length === 0) { lines.push(""); continue; }
		while (visibleWidth(remaining) > columns) {
			const part = truncateToWidth(remaining, columns, "");
			if (!part) break;
			lines.push(part);
			remaining = remaining.slice(part.length);
		}
		lines.push(remaining);
	}
	return lines;
}

/** Read-only, byte-bounded evidence view for the native TUI overlay. */
export class EvidenceViewer {
	private readonly options: EvidenceViewerOptions;
	private readonly path: string;
	private readonly text: string;
	private readonly truncated: boolean;
	private offset = 0;
	private disposed = false;
	private rows: string[] = [];

	constructor(options: EvidenceViewerOptions) {
		this.options = options;
		this.path = safeText(options.preview.path);
		this.text = safeText(options.preview.text);
		this.truncated = options.preview.truncated;
	}

	private key(data: string): string {
		const raw: Record<string, string> = { "\u001b[5~": "pageup", "\u001b[6~": "pagedown", "\u001b[H": "home", "\u001b[F": "end" };
		if (raw[data]) return raw[data];
		const matcher = this.options.matchKey ?? rawKeyMatcher;
		if (matcher(data, "pageup")) return "pageup";
		if (matcher(data, "pagedown")) return "pagedown";
		if (matcher(data, "home")) return "home";
		if (matcher(data, "end")) return "end";
		return canonicalKey(data, matcher);
	}

	handleInput(data: string): void {
		if (this.disposed) return;
		const key = this.key(data);
		const viewport = this.viewport();
		const max = Math.max(0, this.rows.length - viewport);
		if (key === "q" || key === "escape") this.options.done();
		else if (key === "j" || key === "down") this.offset = Math.min(max, this.offset + 1);
		else if (key === "k" || key === "up") this.offset = Math.max(0, this.offset - 1);
		else if (key === "pagedown" || data === "\u0004") this.offset = Math.min(max, this.offset + viewport);
		else if (key === "pageup" || data === "\u0015") this.offset = Math.max(0, this.offset - viewport);
		else if (key === "g" || key === "home") this.offset = 0;
		else if (key === "G" || key === "end") this.offset = max;
		else return;
		this.options.tui.requestRender();
	}

	private viewport(): number {
		return Math.max(1, (this.options.tui.terminal?.rows ?? 30) - 2);
	}

	render(width: number): string[] {
		const safeWidth = Math.max(1, width);
		this.lastWidth = safeWidth;
		this.rows = wrap(this.text, safeWidth);
		const viewport = this.viewport();
		this.offset = Math.min(this.offset, Math.max(0, this.rows.length - viewport));
		const marker = this.truncated ? " (truncated)" : "";
		const label = this.options.title ? safeText(this.options.title) : `EVIDENCE ${this.path}`;
		const header = visibleWidth(label) + visibleWidth(marker) <= safeWidth
			? `${label}${marker}`
			: `${truncateToWidth(label, Math.max(0, safeWidth - visibleWidth(marker)), "")}${marker}`;
		const body = this.rows.slice(this.offset, this.offset + viewport);
		while (body.length < viewport) body.push("");
		return [header, ...body, "j/k scroll · ctrl-d/u page · g/G home/end · q close"].map((line) => truncateToWidth(line, safeWidth, ""));
	}

	invalidate(): void {}

	dispose(): void {
		this.disposed = true;
		this.rows = [];
	}
}
