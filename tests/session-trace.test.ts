import assert from "node:assert/strict";
import test from "node:test";
import { SessionTrace, TRACE_LIMITS } from "../image/extension/bluefin-review/session.ts";
import { PLAIN_PAINTER } from "../image/extension/bluefin-review/glyphs.ts";
import { renderSpanTree, traceToText } from "../image/extension/bluefin-review/trace.ts";
import { safePreview } from "../image/extension/bluefin-review/safe-output.ts";

const NOW = 1_790_000_000_000;

test("a multi-megabyte single line is retained as a byte-bounded tail with omission metadata", () => {
	const trace = new SessionTrace();
	const output = "large-line-".repeat(2 * 1024 * 1024 / 11);
	trace.startTurn(NOW);
	trace.startTool("large", "bash", {}, NOW);
	trace.endTool("large", output, false, NOW + 1);
	trace.endTurn(NOW + 2);

	const span = trace.roots()[0]!.children![0]!;
	const retained = (span.logs ?? []).join("\n");
	assert.ok(Buffer.byteLength(retained, "utf8") <= TRACE_LIMITS.maxToolPreviewBytes);
	assert.ok((span.output?.omittedBytes ?? 0) >= Buffer.byteLength(output, "utf8") - TRACE_LIMITS.maxToolPreviewBytes);
	assert.match(traceToText(trace.roots(), NOW + 2), /omitted/i);
});

test("retained output stays on UTF-8 boundaries at the per-field byte limit", () => {
	const trace = new SessionTrace();
	const output = `${"a".repeat(TRACE_LIMITS.maxFieldBytes)}🙂`;
	trace.startTurn(NOW);
	trace.startTool("utf8", "read", {}, NOW);
	trace.endTool("utf8", output, false, NOW + 1);
	trace.endTurn(NOW + 2);

	const retained = (trace.roots()[0]!.children![0]!.logs ?? []).join("\n");
	assert.ok(Buffer.byteLength(retained, "utf8") <= TRACE_LIMITS.maxFieldBytes);
	assert.ok(retained.endsWith("🙂"));
	assert.ok(!retained.includes("\uFFFD"));
});

test("cumulative Bash snapshots and duplicate updates do not duplicate retained output", () => {
	const trace = new SessionTrace();
	trace.startTurn(NOW);
	trace.startTool("bash", "bash", {}, NOW);
	trace.updateTool("bash", { content: [{ type: "text", text: "first" }] }, NOW + 1);
	trace.updateTool("bash", { content: [{ type: "text", text: "first\nsecond" }] }, NOW + 2);
	trace.updateTool("bash", { content: [{ type: "text", text: "first\nsecond" }] }, NOW + 3);
	trace.endTool("bash", { content: [{ type: "text", text: "first\nsecond" }] }, false, NOW + 4);
	trace.endTurn(NOW + 5);

	assert.deepEqual(trace.roots()[0]!.children![0]!.logs, ["first", "second"]);
});

test("Bash progress without text metadata does not erase the latest cumulative snapshot", () => {
	const trace = new SessionTrace();
	trace.startTurn(NOW);
	trace.startTool("bash-metadata", "bash", {}, NOW);
	trace.updateTool("bash-metadata", { content: [{ type: "text", text: "latest output" }] }, NOW + 1);
	trace.updateTool("bash-metadata", { details: { async: { state: "running", jobId: "3" } } }, NOW + 2);
	trace.endTool("bash-metadata", { details: { async: { state: "completed", jobId: "3" } } }, false, NOW + 3);
	assert.deepEqual(trace.roots()[0]!.children![0]!.logs, ["latest output"]);
});

test("many retained tools have finite byte and span counts and report omitted spans", () => {
	const trace = new SessionTrace();
	trace.startTurn(NOW);
	for (let index = 0; index < 2_000; index++) {
		const id = `tool-${index}`;
		trace.startTool(id, "bash", { command: `${"x".repeat(2_048)}-${index}` }, NOW + index);
		trace.endTool(id, `${"y".repeat(2_048)}-${index}`, false, NOW + index + 1);
	}
	trace.endTurn(NOW + 2_001);

	const stats = trace.stats();
	assert.ok(stats.spanCount <= TRACE_LIMITS.maxRetainedSpans);
	assert.ok(stats.spanCount <= TRACE_LIMITS.maxSpansPerTurn);
	assert.ok(stats.outputBytes <= TRACE_LIMITS.maxTraceOutputBytes);
	assert.ok(stats.retainedBytes <= TRACE_LIMITS.maxTraceBytes);
	assert.ok(stats.omittedSpans > 0);
	assert.match(traceToText(trace.roots(), NOW + 2_001), /span.*omitted/i);
});

test("malformed cyclic and non-text tool payloads stay bounded and do not throw", () => {
	const trace = new SessionTrace();
	trace.startTurn(NOW);
	trace.startTool("cyclic", "tool", {}, NOW);
	const cyclic: { content?: unknown } = {};
	cyclic.content = cyclic;
	assert.doesNotThrow(() => trace.updateTool("cyclic", cyclic, NOW + 1));
	assert.doesNotThrow(() => trace.updateTool("cyclic", { content: Array.from({ length: 10_000 }, () => ({ type: "image", data: "ignored" })) }, NOW + 2));
	trace.endTool("cyclic", { content: [{ type: "image", data: "ignored" }] }, false, NOW + 3);
	trace.endTurn(NOW + 4);

	assert.deepEqual(trace.roots()[0]!.children![0]!.logs, []);
	assert.ok(trace.stats().retainedBytes <= TRACE_LIMITS.maxTraceBytes);
});

test("async job snapshots inspect only a bounded prefix and report omitted jobs", () => {
	const trace = new SessionTrace();
	trace.startTurn(NOW);
	trace.startTool("task-sync", "task", {}, NOW);
	trace.updateTool("task-sync", { details: { async: { jobId: "native-job" }, progress: [{ id: "worker-a", status: "running" }] } }, NOW + 1);
	const createLargeSnapshotList = (first) => {
		let numericReads = 0;
		const list = new Proxy([], {
			get(target, property, receiver) {
				if (property === "length") return 10_000;
				if (typeof property === "string" && /^\d+$/.test(property)) {
					numericReads++;
					return Number(property) === 0 ? first : { id: `unmatched-${property}`, status: "completed" };
				}
				return Reflect.get(target, property, receiver);
			},
		});
		return { list, reads: () => numericReads };
	};
	const firstJob = { id: "native-job", agentId: "worker-a", status: "completed" };
	const running = createLargeSnapshotList(firstJob);
	const recent = createLargeSnapshotList({ id: "recent-job", status: "completed" });
	trace.syncAsyncJobs({ running: running.list, recent: recent.list }, NOW + 2);
	assert.ok(running.reads() + recent.reads() <= TRACE_LIMITS.maxNativeJobsPerSync);
	assert.equal(running.reads(), TRACE_LIMITS.maxNativeJobsPerSync);
	assert.equal(recent.reads(), 0);
	assert.equal(trace.roots()[0]!.output?.omittedJobs, 20_000 - TRACE_LIMITS.maxNativeJobsPerSync);
	assert.match(traceToText(trace.roots(), NOW + 2), /async job snapshot bound: 19744 jobs omitted/);
});

test("trace output sanitizes terminal controls and masks credential-bearing values", () => {
	const trace = new SessionTrace();
	trace.startTurn(NOW);
	trace.startTool("secret", "bash", {}, NOW);
	trace.endTool("secret", "\u001b[31mGH_TOKEN=never-show-this\u001b[0m", false, NOW + 1);
	trace.endTurn(NOW + 2);

	const text = traceToText(trace.roots(), NOW + 2);
	assert.doesNotMatch(text, /\u001b\[31m|never-show-this/);
	assert.match(text, /REDACTED/);
});

test("tail clipping redacts a multi-megabyte credential when the preview begins inside its value", () => {
	const secret = "never-export-this";
	const value = `GH_TOKEN=${secret.repeat(150_000)}`;
	const preview = safePreview(value, 1_024, "tail");
	assert.ok(Buffer.byteLength(preview.text, "utf8") <= 1_024);
	assert.match(preview.text, /REDACTED/);
	assert.doesNotMatch(preview.text, /never-export-this/);
	assert.ok(preview.omittedBytes > 0);
	const bearer = safePreview(`Bearer ${secret.repeat(150_000)}`, 1_024, "tail");
	assert.match(bearer.text, /REDACTED/);
	assert.doesNotMatch(bearer.text, /never-export-this/);
});

test("trace tree and text inspection project the same truncation and native reference metadata", () => {
	const trace = new SessionTrace();
	trace.startTurn(NOW);
	trace.startTool("output", "bash", {}, NOW);
	trace.endTool("output", "0123456789", false, NOW + 1);
	trace.endTurn(NOW + 2);
	const span = trace.roots()[0]!.children![0]!;
	span.output = {
		...(span.output ?? { omittedBytes: 0, omittedSpans: 0, omittedUnknown: false }),
		omittedBytes: 99,
		reference: {
			kind: "available",
			uri: "artifact://42",
			path: "/state/omp/session/artifacts/42.bash.log",
			sourceSessionId: "session-1",
			complete: true,
		},
	};
	const rows = renderSpanTree(trace.roots(), { painter: PLAIN_PAINTER, width: 160, now: NOW + 2 }).map((row) => row.text).join("\n");
	const text = traceToText(trace.roots(), NOW + 2, 160);
	for (const projection of [rows, text]) {
		assert.match(projection, /99 bytes omitted/);
		assert.match(projection, /artifact:\/\/42/);
		assert.match(projection, /session-1/);
	}
});

test("pinned OMP truncation fields retain only supplied totals and resolve artifacts against the source session", () => {
	const trace = new SessionTrace();
	trace.startTurn(NOW);
	trace.startTool("native", "bash", {}, NOW);
	trace.endTool("native", { content: [{ type: "text", text: "tail sample" }], details: { meta: { truncation: { direction: "tail", truncatedBy: "bytes", totalLines: 100, totalBytes: 200, outputLines: 1, outputBytes: 11, artifactId: "42" } } } }, false, NOW + 1);
	const span = trace.roots()[0]!.children![0]!;
	assert.equal(span.output?.nativeTotalBytes, 200);
	assert.equal(span.output?.reference?.kind, "unavailable");
	trace.setArtifactReference("native", "source-session", "/state/source/artifacts/42.bash.log");
	assert.deepEqual(span.output?.reference, { kind: "available", uri: "artifact://42", path: "/state/source/artifacts/42.bash.log", sourceSessionId: "source-session", complete: true });

	trace.startTool("expired", "bash", {}, NOW + 2);
	trace.endTool("expired", { content: [{ type: "text", text: "sample" }], details: { meta: { truncation: { direction: "tail", truncatedBy: "bytes", totalLines: 1, outputLines: 1, outputBytes: 6, artifactId: "43", artifactElidedBytes: 2 } } } }, false, NOW + 3);
	trace.setArtifactReference("expired", "source-session", null);
	assert.equal(trace.roots()[0]!.children![1]!.output?.nativeTotalBytes, undefined, "OMP supplied no totalBytes");
	assert.deepEqual(trace.roots()[0]!.children![1]!.output?.reference, { kind: "unavailable", uri: "artifact://43", sourceSessionId: "source-session", reason: "artifact expired or could not be resolved" });
});

test("native artifactError suppresses the raw output link", () => {
	const trace = new SessionTrace();
	trace.startTurn(NOW);
	trace.startTool("error", "bash", {}, NOW);
	trace.endTool("error", { content: [{ type: "text", text: "capture failed" }], details: { meta: { artifactError: "disk full", truncation: { direction: "tail", truncatedBy: "bytes", totalLines: 1, totalBytes: 14, outputLines: 1, outputBytes: 14, artifactId: "44" } } } }, false, NOW + 1);
	assert.equal(trace.roots()[0]!.children![0]!.output?.reference, undefined);
});
