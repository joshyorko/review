import assert from "node:assert/strict";
import test from "node:test";
import { createNativeToastWidget, createReviewNoticeComponent, renderNoticeBanner } from "../image/extension/review/notice.ts";

const content = {
	title: "Review couldn’t start this item",
	outcome: "No new work was started for fixture/review#42.",
	action: "Open /settings → Tasks → Subagents → Structured Task Results, turn it on, then retry from the Review queue.",
	details: "The reviewer could not use structured task results.",
};

test("notice state is shared and repeated lifecycle notices are delivered once", () => {
	const delivered: string[] = [];
	const first = createReviewNoticeComponent({ notify: (message) => delivered.push(message) });
	const second = createReviewNoticeComponent();
	first.sessionChanged("session-a");
	assert.equal(first.publish({ id: "worker-completed", sessionId: "session-a", level: "error", content }), true);
	assert.deepEqual(second.current, { id: "worker-completed", sessionId: "session-a", level: "error", ...content });
	assert.equal(second.publish({ id: "worker-completed", sessionId: "session-a", level: "error", content }), false);
	assert.deepEqual(delivered, [`${content.title}. ${content.outcome} Next: ${content.action}`]);
});

test("session changes clear session-owned notices and reject stale events", () => {
	const notice = createReviewNoticeComponent();
	notice.sessionChanged("session-b");
	assert.equal(notice.publish({ id: "old", sessionId: "session-a", level: "warning", content }), false);
	assert.equal(notice.publish({ id: "current", sessionId: "session-b", level: "warning", content }), true);
	notice.sessionChanged("session-c");
	assert.equal(notice.current, undefined);
	assert.equal(notice.latestDetails, undefined);
	assert.equal(notice.publish({ id: "current", sessionId: "session-c", level: "warning", content }), true);
});

test("informational notices do not hide the latest unresolved warning or error", () => {
	const notice = createReviewNoticeComponent();
	notice.sessionChanged("session-priority");
	notice.publish({ id: "blocked", sessionId: "session-priority", level: "warning", content });
	notice.publish({ id: "failed", sessionId: "session-priority", level: "error", content: { ...content, title: "A higher priority failure" } });
	notice.publish({ id: "warning", sessionId: "session-priority", level: "warning", content });
	assert.equal(notice.current?.title, "A higher priority failure");
	assert.equal(notice.latestDetails?.title, "A higher priority failure", "a lower-severity warning cannot replace the error details");
});

test("dedupe retains only a fixed recent window of lifecycle IDs", () => {
	const notice = createReviewNoticeComponent();
	notice.sessionChanged("session-dedupe-bound");
	for (let index = 0; index < 257; index++) {
		assert.equal(notice.publish({ id: `event-${index}`, sessionId: "session-dedupe-bound", level: "info", content: { ...content, title: `event ${index}` } }), true);
	}
	assert.equal(notice.publish({ id: "event-256", sessionId: "session-dedupe-bound", level: "info", content }), false);
	assert.equal(notice.publish({ id: "event-0", sessionId: "session-dedupe-bound", level: "info", content }), true);
});

test("banner presents a styled title, outcome, and wrapped action without diagnostics", () => {
	const notice = createReviewNoticeComponent();
	notice.sessionChanged("session-banner");
	notice.publish({ id: "blocked", sessionId: "session-banner", level: "error", content: { ...content, details: "PRIVATE TECHNICAL DETAIL" } });
	const banner = renderNoticeBanner(notice.current, {
		fg: (role, text) => `<${role}>${text}</${role}>`,
		bold: (text) => `**${text}**`,
	}, 80);
	assert.equal(banner[0], "**<error>Review couldn’t start this item</error>**");
	assert.match(banner[1]!, /No new work was started for fixture\/review#42/);
	assert.ok(banner.some((line) => line.includes("<accent>  Next:")));
	assert.ok(banner.every((line) => !line.includes("PRIVATE TECHNICAL DETAIL")));
	assert.deepEqual(renderNoticeBanner(undefined, { fg: (_role, text) => text, bold: (text) => text }), []);
});

test("native toast uses human copy while ANSI render adds no rows", () => {
	const notice = createReviewNoticeComponent();
	notice.sessionChanged("session-toast-node");
	notice.publish({ id: "blocked", sessionId: "session-toast-node", level: "error", content });
	const widget = createNativeToastWidget(() => notice.current);
	const toastNode = widget.describe({ supports: (kind) => kind === "toast" });
	assert.deepEqual(toastNode, {
		k: "toast",
		p: { text: content.title, sub: `Next: ${content.action}`, ttl: 2400 },
	});
	assert.equal(widget.describe({ supports: (kind) => kind === "toast" }), toastNode, "unchanged notices reuse the same node identity");
	assert.equal(widget.describe({ supports: () => false }), null);
	assert.deepEqual(widget.render(80), []);
	notice.acknowledge();
	assert.equal(widget.describe({ supports: (kind) => kind === "toast" }), null);
	assert.equal(notice.latestDetails?.details, content.details, "acknowledgement preserves read-only diagnostics");
	assert.equal(notice.publish({ id: "blocked", sessionId: "session-toast-node", level: "error", content }), true, "a repeated failure can reappear after acknowledgement");
});

test("diagnostics stay out of the compact card and acknowledgement preserves them", () => {
	const notice = createReviewNoticeComponent();
	notice.sessionChanged("session-long-error");
	const details = "task.structured schemaMode outputSchema " + "x".repeat(800);
	notice.publish({ id: "error", sessionId: "session-long-error", level: "error", content: { ...content, details: `line one\nline two\n${details}` } });
	const rows = renderNoticeBanner(notice.current, { fg: (_role, text) => text, bold: (text) => text }, 80);
	assert.ok(rows.length <= 7, "the card remains compact at 80 columns");
	assert.ok(rows.some((line) => /Next:/.test(line)), "the recovery step remains visible");
	assert.ok(rows.every((line) => !/schemaMode|outputSchema/.test(line)));
	notice.acknowledge();
	assert.equal(notice.current, undefined);
	assert.match(notice.latestDetails?.details ?? "", /line one\nline two/);
	assert.match(notice.latestDetails?.details ?? "", /outputSchema/);
	notice.sessionChanged("session-next");
	assert.equal(notice.latestDetails, undefined, "session changes discard prior-session diagnostics");
});

test("clear removes the current notice and saved details", () => {
	const notice = createReviewNoticeComponent();
	notice.sessionChanged("session-clear");
	notice.publish({ id: "blocked", sessionId: "session-clear", level: "error", content });
	notice.clear();
	assert.equal(notice.current, undefined);
	assert.equal(notice.latestDetails, undefined);
});
