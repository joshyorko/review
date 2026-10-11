import { Buffer } from "node:buffer";
import { sanitizeMarkdown } from "./reader.ts";

const CREDENTIAL_PREFIX = /\b(?:bearer|basic)\b/gi;
const MAX_SAFE_PREVIEW_BYTES = 16 * 1_024;

export interface BoundedText {
	readonly text: string;
	readonly totalBytes: number;
	readonly omittedBytes: number;
}

/** Keep a UTF-8-safe suffix without splitting or copying the unbounded prefix. */
export function boundedUtf8Tail(value: string, maxBytes: number): BoundedText {
	const totalBytes = Buffer.byteLength(value, "utf8");
	if (maxBytes <= 0 || value.length === 0) return { text: "", totalBytes, omittedBytes: totalBytes };
	let start = value.length;
	let retainedBytes = 0;
	while (start > 0) {
		let next = start - 1;
		let code = value.charCodeAt(next);
		if (code >= 0xdc00 && code <= 0xdfff && next > 0) {
			const high = value.charCodeAt(next - 1);
			if (high >= 0xd800 && high <= 0xdbff) {
				next--;
				code = 0x10000 + ((high - 0xd800) << 10) + (code - 0xdc00);
			}
		}
		const bytes = code <= 0x7f ? 1 : code <= 0x7ff ? 2 : code <= 0xffff ? 3 : 4;
		if (retainedBytes + bytes > maxBytes) break;
		retainedBytes += bytes;
		start = next;
	}
	const text = value.slice(start);
	return { text, totalBytes, omittedBytes: totalBytes - retainedBytes };
}

/** Keep a UTF-8-safe prefix for labels whose leading operation name matters. */
export function boundedUtf8Head(value: string, maxBytes: number): BoundedText {
	const totalBytes = Buffer.byteLength(value, "utf8");
	if (maxBytes <= 0 || value.length === 0) return { text: "", totalBytes, omittedBytes: totalBytes };
	let end = 0;
	let retainedBytes = 0;
	for (const character of value) {
		const code = character.codePointAt(0)!;
		const bytes = code <= 0x7f ? 1 : code <= 0x7ff ? 2 : code <= 0xffff ? 3 : 4;
		if (retainedBytes + bytes > maxBytes) break;
		retainedBytes += bytes;
		end += character.length;
	}
	return { text: value.slice(0, end), totalBytes, omittedBytes: totalBytes - retainedBytes };
}

export function redactCredentials(value: string): string {
	return value
		.replace(/(\b(?:authorization|proxy-authorization)\s*:\s*(?:bearer|basic)\s+)[^\s,;]+/gi, "$1[REDACTED]")
		.replace(/(\b[\w.-]*(?:token|secret|password|passwd|api[_-]?key|credential)[\w.-]*\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;&]+)/gi, "$1[REDACTED]")
		.replace(/\b(?:gh[pousr]_[A-Za-z0-9_]{16,}|github_pat_[A-Za-z0-9_]{16,}|xox[baprs]-[A-Za-z0-9-]{16,}|sk-[A-Za-z0-9_-]{16,}|AIza[A-Za-z0-9_-]{16,})\b/g, "[REDACTED]")
		.replace(/(\bhttps?:\/\/[^:/\s@]+:)[^@/\s]+(@)/gi, "$1[REDACTED]$2");
}

/** Mask credential value ranges that overlap a bounded source window. */
function redactWindow(value: string, windowStart: number, windowText: string): string {
	const windowEnd = windowStart + windowText.length;
	const masked = new Uint8Array(windowText.length);
	const mask = (start: number, end: number): void => {
		masked.fill(1, Math.max(0, start - windowStart), Math.max(0, Math.min(end, windowEnd) - windowStart));
	};
	const maskValue = (prefixEnd: number): number => {
		let valueStart = prefixEnd;
		let quote = "";
		if (value[valueStart] === "\"" || value[valueStart] === "'") quote = value[valueStart++]!;
		let valueEnd = valueStart;
		while (valueEnd < value.length) {
			const character = value[valueEnd]!;
			if (quote ? character === quote : /[\s,;&]/.test(character)) break;
			if (quote && character === "\\" && valueEnd + 1 < value.length) valueEnd++;
			valueEnd++;
		}
		mask(valueStart, valueEnd);
		return valueEnd + (quote && value[valueEnd] === quote ? 1 : 0);
	};
	CREDENTIAL_PREFIX.lastIndex = 0;
	let match: RegExpExecArray | null;
	while ((match = CREDENTIAL_PREFIX.exec(value)) !== null) {
		let end = CREDENTIAL_PREFIX.lastIndex;
		while (end < value.length && /\s/.test(value[end]!)) end++;
		if (end > CREDENTIAL_PREFIX.lastIndex) CREDENTIAL_PREFIX.lastIndex = maskValue(end);
	}
	const keyTerm = /token|secret|password|passwd|api[_-]?key|credential/gi;
	while ((match = keyTerm.exec(value)) !== null) {
		let end = keyTerm.lastIndex;
		while (end < value.length && /[\w.-]/.test(value[end]!)) end++;
		while (end < value.length && /\s/.test(value[end]!)) end++;
		keyTerm.lastIndex = end;
		if (value[end] !== ":" && value[end] !== "=") continue;
		end++;
		while (end < value.length && /\s/.test(value[end]!)) end++;
		keyTerm.lastIndex = maskValue(end);
	}
	// Recognize prefixes in the original source, not a clipped credential suffix.
	const tokenPrefix = /\b(?:gh[pousr]_|github_pat_|xox[baprs]-|sk-|AIza)/g;
	while ((match = tokenPrefix.exec(value)) !== null) {
		const start = match.index;
		let end = tokenPrefix.lastIndex;
		const alphabet = match[0].startsWith("xox") ? /[A-Za-z0-9-]/ : match[0].startsWith("gh") ? /[A-Za-z0-9_]/ : /[A-Za-z0-9_-]/;
		while (end < value.length && alphabet.test(value[end]!)) end++;
		if (end - tokenPrefix.lastIndex >= 16 && !/\w/.test(value[end] ?? "")) mask(start, end);
		tokenPrefix.lastIndex = end;
	}
	const urlPrefix = /\bhttps?:\/\//gi;
	while ((match = urlPrefix.exec(value)) !== null) {
		let colon = urlPrefix.lastIndex;
		while (colon < value.length && !/[:/\s@]/.test(value[colon]!)) colon++;
		if (colon === urlPrefix.lastIndex || value[colon] !== ":") continue;
		let end = colon + 1;
		while (end < value.length && !/[@/\s]/.test(value[end]!)) end++;
		if (end > colon + 1 && value[end] === "@") mask(colon + 1, end);
	}
	const pieces: string[] = [];
	let cursor = 0;
	while (cursor < windowText.length) {
		const start = cursor;
		const secret = masked[cursor] === 1;
		while (cursor < windowText.length && (masked[cursor] === 1) === secret) cursor++;
		pieces.push(secret ? "[REDACTED]" : windowText.slice(start, cursor));
	}
	return pieces.join("");
}

/** Sanitize a bounded preview before it reaches a terminal or a handoff. */
export function safePreview(value: string, maxBytes: number, direction: "head" | "tail" = "tail"): BoundedText {
	const limit = Number.isFinite(maxBytes) ? Math.max(0, Math.min(MAX_SAFE_PREVIEW_BYTES, Math.trunc(maxBytes))) : 0;
	const clipped = direction === "head" ? boundedUtf8Head(value, limit) : boundedUtf8Tail(value, limit);
	const windowStart = direction === "head" ? 0 : value.length - clipped.text.length;
	const redactedWindow = redactWindow(value, windowStart, clipped.text);
	const sanitized = sanitizeMarkdown(redactedWindow).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g, "");
	const redacted = redactCredentials(sanitized);
	const final = direction === "head" ? boundedUtf8Head(redacted, limit) : boundedUtf8Tail(redacted, limit);
	const sanitizedBytes = Buffer.byteLength(sanitized, "utf8");
	return {
		text: final.text,
		totalBytes: clipped.totalBytes,
		omittedBytes: Math.max(0, clipped.omittedBytes + Buffer.byteLength(clipped.text, "utf8") - sanitizedBytes + final.omittedBytes),
	};
}
