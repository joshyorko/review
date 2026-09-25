import assert from "node:assert/strict";
import test from "node:test";
import { EvidenceViewer } from "../image/extension/luna-factory/ui/evidence-viewer.ts";
import { visibleWidth } from "../image/extension/bluefin-review/width.ts";

type Harness = {
	viewer: EvidenceViewer;
	frames: (width?: number) => string[];
	requestCount: () => number;
	closed: () => number;
	setRows: (rows: number) => void;
};

function harness(text: string, path = "/state/evidence.log", truncated = false, rows = 8): Harness {
	let requests = 0;
	let closed = 0;
	let currentRows = rows;
	const viewer = new EvidenceViewer({
		preview: { path, text, truncated },
		tui: { requestRender: () => { requests += 1; }, terminal: { get rows() { return currentRows; } } },
		done: () => { closed += 1; },
	});
	return {
		viewer,
		frames: (width = 24) => viewer.render(width),
		requestCount: () => requests,
		closed: () => closed,
		setRows: (value) => { currentRows = value; },
	};
}

test("wraps long lines and reaches their tail with end navigation", () => {
	const h = harness("prefix-0123456789012345678901234567890123456789-tail", "/state/long.log", false, 4);
	const initial = h.frames().join("\n");
	assert.match(initial, /prefix/);
	assert.doesNotMatch(initial, /tail/);
	h.viewer.handleInput("G");
	assert.match(h.frames().join("\n"), /tail/);
	assert.ok(h.requestCount() > 0);
});

test("keeps multiline indentation and blank lines while wrapping", () => {
	const h = harness("  first line\n\n    second line", "/state/multiline.log", false, 10);
	const output = h.frames().join("\n");
	assert.match(output, /  first/);
	assert.match(output, /    second/);
	assert.match(output, /EVIDENCE/);
});

test("keeps unicode readable and never emits terminal escapes", () => {
	const h = harness("  café 🙂\nnext", "/state/\u001b[31munsafe\u001b[0m.log", false, 10);
	const output = h.frames().join("\n");
	assert.match(output, /café/);
	assert.match(output, /🙂/);
	assert.doesNotMatch(output, /\u001b/);
});

test("wraps combining, CJK, and emoji text without overflowing the terminal", () => {
	const h = harness("e\u0301界👩‍💻終", "/state/unicode.log", false, 8);
	for (const line of h.frames(8)) assert.ok(visibleWidth(line) <= 8, `overflow: ${line}`);
	h.viewer.handleInput("G");
	for (const line of h.frames(1)) assert.ok(visibleWidth(line) <= 1, `overflow: ${line}`);
});

test("keeps the truncation marker visible with a long path", () => {
	const h = harness("bounded", "/state/" + "nested/".repeat(30) + "evidence.jsonl", true, 8);
	const header = h.frames()[0]!;
	assert.match(header, /truncated/);
	assert.ok(header.length <= 24);
});

test("scrolls at boundaries, pages, homes, ends, and adapts to resize", () => {
	const h = harness(Array.from({ length: 40 }, (_, i) => `line-${i}`).join("\n"), "/state/lines.log", false, 8);
	const start = h.frames().join("\n");
	assert.match(start, /line-0/);
	h.viewer.handleInput("j");
	h.viewer.handleInput("\u001b[6~");
	h.viewer.handleInput("G");
	assert.match(h.frames().join("\n"), /line-39/);
	h.viewer.handleInput("g");
	assert.match(h.frames().join("\n"), /line-0/);
	h.viewer.handleInput("\u001b[5~");
	assert.match(h.frames().join("\n"), /line-0/);
	h.setRows(4);
	const resized = h.frames();
	assert.ok(resized.length <= 4);
	h.viewer.handleInput("q");
	assert.equal(h.closed(), 1);
	h.viewer.dispose();
	h.viewer.handleInput("G");
	assert.equal(h.closed(), 1);
});
