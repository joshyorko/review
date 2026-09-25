import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, symlinkSync, linkSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { readBoundedEvidence, sessionEvidence } from "../image/extension/luna-factory/ui/evidence.ts";

function fixture(t: test.TestContext): string {
	const root = mkdtempSync(join(tmpdir(), "factory-evidence-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	return root;
}

test("evidence preview bounds bytes and preserves source", (t) => {
	const root = fixture(t);
	const file = join(root, "test.log");
	writeFileSync(file, "pass\n".repeat(100));
	const preview = readBoundedEvidence(root, file, 32);
	assert.equal(preview.truncated, true);
	assert.ok(Buffer.byteLength(preview.text) <= 32);
	assert.equal(preview.path, file);
	assert.equal(readFileSync(file, "utf8"), "pass\n".repeat(100));
});

test("evidence removes terminal commands and unsafe controls without removing lines", (t) => {
	const root = fixture(t);
	const file = join(root, "worker.log");
	writeFileSync(file, "\x1b[2Jok\x1b]52;c;Y2xpcGJvYXJk\x07\nnext\rspoof\u202efile");
	const preview = readBoundedEvidence(root, file);
	assert.equal(preview.text, "ok\nnextspooffile");
	assert.equal(preview.truncated, false);
});

test("evidence rejects escapes, symlinks, hardlinks and non-files", (t) => {
	const root = fixture(t);
	const owned = join(root, "owned");
	mkdirSync(owned);
	const outside = join(root, "outside.txt");
	writeFileSync(outside, "must not display");
	assert.throws(() => readBoundedEvidence(owned, outside), /outside|escapes/);
	symlinkSync(outside, join(owned, "link"));
	assert.throws(() => readBoundedEvidence(owned, join(owned, "link")), /symlink|escapes/);
	linkSync(outside, join(owned, "hardlink"));
	assert.throws(() => readBoundedEvidence(owned, join(owned, "hardlink")), /regular|link/);
	assert.throws(() => readBoundedEvidence(root, owned), /regular/);
});

test("evidence limits cannot disable the byte bound and UTF-8 truncation is clean", (t) => {
	const root = fixture(t);
	const file = join(root, "unicode.log");
	writeFileSync(file, "🙂".repeat(100));
	assert.equal(readBoundedEvidence(root, file, 5).text, "🙂");
	for (const limit of [0, -1, Infinity, NaN, 1.5, 1_000_000]) {
		assert.throws(() => readBoundedEvidence(root, file, limit), /limit/);
	}
});

test("session previews show conversation without native storage metadata", () => {
 const preview = sessionEvidence({ path: "/state/session.jsonl", truncated: true, text: [
  JSON.stringify({ type: "title", pad: " ".repeat(2000), title: "internal" }),
  JSON.stringify({ type: "message", message: { role: "user", content: "Inspect the repository" } }),
  JSON.stringify({ type: "message", message: { role: "assistant", content: [{ type: "text", text: "The check passed" }, { type: "toolCall", name: "factory_report" }] } }),
  '{"type":',
 ].join("\n") });
 assert.match(preview.text, /Instruction\nInspect the repository/);
 assert.match(preview.text, /Worker\nThe check passed\nCalled factory_report/);
 assert.match(preview.text, /incomplete session entry/);
 assert.doesNotMatch(preview.text, /internal|pad/);
 assert.equal(preview.truncated, true);
});
