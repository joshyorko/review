import assert from "node:assert/strict";
import test from "node:test";
import { createNativeToastWidget, createReviewNoticeComponent, renderNoticeBanner } from "../image/extension/review/notice.ts";

test("notice state is shared and repeated lifecycle notices are delivered once", () => {
	const delivered: string[] = [];
	const first = createReviewNoticeComponent({ notify: (message) => delivered.push(message) });
	const second = createReviewNoticeComponent();
	first.sessionChanged("session-a");
	assert.equal(first.publish({ id: "worker-completed", sessionId: "session-a", level: "info", message: "Worker completed" }), true);
	assert.equal(second.current?.message, "Worker completed");
	assert.equal(second.publish({ id: "worker-completed", sessionId: "session-a", level: "info", message: "Worker completed" }), false);
	assert.deepEqual(delivered, ["Worker completed"]);
});

test("session changes clear session-owned notices and reject stale events", () => {
	const notice = createReviewNoticeComponent();
	notice.sessionChanged("session-b");
	assert.equal(notice.publish({ id: "old", sessionId: "session-a", level: "warning", message: "stale" }), false);
	assert.equal(notice.publish({ id: "current", sessionId: "session-b", level: "warning", message: "current" }), true);
	notice.sessionChanged("session-c");
	assert.equal(notice.current, undefined);
	assert.equal(notice.publish({ id: "current", sessionId: "session-c", level: "warning", message: "new session" }), true);
});

test("informational notices do not hide the latest unresolved warning or error", () => {
	const notice = createReviewNoticeComponent();
	notice.sessionChanged("session-priority");
	notice.publish({ id: "blocked", sessionId: "session-priority", level: "warning", message: "Needs review" });
	notice.publish({ id: "progress", sessionId: "session-priority", level: "info", message: "Worker started" });
	assert.equal(notice.current?.message, "Needs review");
	notice.publish({ id: "failed", sessionId: "session-priority", level: "error", message: "Worker failed" });
	notice.publish({ id: "warning", sessionId: "session-priority", level: "warning", message: "Another item needs attention" });
	notice.publish({ id: "complete", sessionId: "session-priority", level: "info", message: "Other item completed" });
	assert.equal(notice.current?.message, "Worker failed");
	notice.clear();
	assert.equal(notice.current, undefined);
});

test("dedupe retains only a fixed recent window of lifecycle IDs", () => {
	const notice = createReviewNoticeComponent();
	notice.sessionChanged("session-dedupe-bound");
	for (let index = 0; index < 257; index++) {
		assert.equal(notice.publish({ id: `event-${index}`, sessionId: "session-dedupe-bound", level: "info", message: `event ${index}` }), true);
	}
	assert.equal(notice.publish({ id: "event-256", sessionId: "session-dedupe-bound", level: "info", message: "latest duplicate" }), false);
	assert.equal(notice.publish({ id: "event-0", sessionId: "session-dedupe-bound", level: "info", message: "outside recent window" }), true);
});

test("banner is compact and uses native theme ANSI styling", () => {
	const notice = createReviewNoticeComponent();
	notice.sessionChanged("session-banner");
	notice.publish({ id: "blocked", sessionId: "session-banner", level: "warning", message: "Needs review", action: "/review reconcile" });
	const banner = renderNoticeBanner(notice.current, {
		fg: (role, text) => `<${role}>${text}</${role}>`,
		bold: (text) => `**${text}**`,
	});
	assert.deepEqual(banner, [
		"**<warning>Review</warning>** <dim>·</dim> <warning>Needs review</warning>",
		"**<warning>Next: /review reconcile</warning>**",
	]);
	assert.deepEqual(renderNoticeBanner(undefined, { fg: (_role, text) => text, bold: (text) => text }), []);
});

test("native notice widget uses the public TSP toast node and stays quiet in ANSI", () => {
	const notice = createReviewNoticeComponent();
	notice.sessionChanged("session-toast-node");
	notice.publish({ id: "blocked", sessionId: "session-toast-node", level: "error", message: "Full diagnostic", summary: "Review action failed", action: "/review status" });
	const current = notice.current;
	if (!current) throw new Error("notice was not retained");
	const widget = createNativeToastWidget(() => notice.current);
	const toastNode = widget.describe({ supports: (kind) => kind === "toast" });
	assert.deepEqual(toastNode, {
		k: "toast",
		p: { text: "Review action failed", sub: "Next: /review status", ttl: 2400 },
	});
	assert.equal(widget.describe({ supports: (kind) => kind === "toast" }), toastNode, "unchanged notices reuse the same native node identity");
	assert.equal(widget.describe({ supports: () => false }), null);
	assert.deepEqual(widget.render(80), []);
	notice.publish({ id: "next", sessionId: "session-toast-node", level: "warning", message: "Other blocker", summary: "Review action needs attention", action: "/review status" });
	assert.equal(widget.describe({ supports: (kind) => kind === "toast" }), toastNode, "a lower-severity warning does not replace the unresolved error toast");
	notice.clear();
	assert.equal(widget.describe({ supports: (kind) => kind === "toast" }), null, "acknowledgement removes a pending toast description");
});

test("long failures keep their recovery command on a separate visible banner row", () => {
	const notice = createReviewNoticeComponent();
	notice.sessionChanged("session-long-error");
	notice.publish({ id: "error", sessionId: "session-long-error", level: "error", message: "x".repeat(240), summary: "Review action failed for fixture/repo#42", action: "/review reconcile" });
	const rows = renderNoticeBanner(notice.current, { fg: (_role, text) => text, bold: (text) => text });
	assert.equal(rows.length, 2);
	assert.equal(rows[0], "Review · Review action failed for fixture/repo#42");
	assert.equal(rows[1], "Next: /review reconcile");
});

test("explicit acknowledgement clears the persistent notice and dedupe entry", () => {
	const notice = createReviewNoticeComponent();
	notice.sessionChanged("session-ack");
	const level: "error" = "error";
	const input = { id: "blocked", sessionId: "session-ack", level, message: "Needs reconciliation", action: "/review reconcile" };
	assert.equal(notice.publish(input), true);
	notice.clear();
	assert.equal(notice.current, undefined);
	assert.equal(notice.publish(input), true, "the same unresolved event can reappear after acknowledgement");
});

test("acknowledgement and session changes clear shared notices across module copies", () => {
	const firstCopy = createReviewNoticeComponent();
	const secondCopy = createReviewNoticeComponent();
	firstCopy.sessionChanged("session-widget-fence");
	firstCopy.publish({ id: "blocked", sessionId: "session-widget-fence", level: "error", message: "Review failed" });
	assert.equal(secondCopy.current?.message, "Review failed");
	secondCopy.clear();
	assert.equal(firstCopy.current, undefined);
	firstCopy.publish({ id: "again", sessionId: "session-widget-fence", level: "error", message: "Review failed again" });
	firstCopy.sessionChanged("session-widget-next");
	assert.equal(secondCopy.current, undefined);
});
