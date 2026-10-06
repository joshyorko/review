import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

const expectedArchiveSha256 = "60ead7acc6185f5c06942d3f56d82dd0f41081e749f03b73547c6ed537407b46";
const expectedSourceCommit = "9348320cc4a30a7195d36a1f05a6c11bcb701a17";
const expectedPatchSha256 = "118612c41e9a3d8d68d15f4451d798a4fbe1e948bed60bc87e5eaf1eb7693214";
const archivePath = process.env.ISSUE140_OMP_ARCHIVE;
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const patchPath = path.join(repoRoot, "patches/omp/clipboard-truthful-18.5.0.patch");
const containerfile = await readFile(path.join(repoRoot, "image/appliance/Containerfile"), "utf8");
assert.match(containerfile, new RegExp(`ARG OMP_SOURCE_COMMIT=${expectedSourceCommit}\\n`));
assert.match(containerfile, new RegExp(`ARG OMP_SOURCE_SHA256=${expectedArchiveSha256}\\n`));

assert.ok(archivePath, "set ISSUE140_OMP_ARCHIVE to the pinned OMP 18.5.0 source archive");
const archive = await readFile(archivePath);
assert.equal(createHash("sha256").update(archive).digest("hex"), expectedArchiveSha256, "OMP archive pin");
const patch = await readFile(patchPath);
assert.equal(createHash("sha256").update(patch).digest("hex"), expectedPatchSha256, "OMP patch pin");

const sourceRoot = await mkdtemp(path.join(tmpdir(), "review-issue-140-omp-"));
test.after(async () => rm(sourceRoot, { recursive: true, force: true }));
const extract = spawnSync("tar", ["--no-same-owner", "-xzf", archivePath, "-C", sourceRoot, "--strip-components=1"], {
	encoding: "utf8",
});
assert.equal(extract.status, 0, `extract pinned OMP source: ${extract.stderr}`);

if (process.env.ISSUE140_APPLY_PATCH !== "0") {
	const apply = spawnSync("git", ["-C", sourceRoot, "apply", patchPath], { encoding: "utf8" });
	assert.equal(apply.status, 0, `apply OMP clipboard patch: ${apply.stderr}`);
}

const controllerPath = path.join(sourceRoot, "packages/coding-agent/src/modes/controllers/command-controller.ts");
const controllerSource = await readFile(controllerPath, "utf8");
const dumpFormatPath = path.join(sourceRoot, "packages/coding-agent/src/session/session-dump-format.ts");
const dumpFormatSource = await readFile(dumpFormatPath, "utf8");

const reportMatch = dumpFormatSource.match(
	/export function formatDumpArchiveReport\(archive: SessionDumpArchive\): string\[\] \{\n([\s\S]*?)\n\}/u,
);
assert.ok(reportMatch, "formatDumpArchiveReport exists in pinned source");
const formatDumpArchiveReport = new Function("archive", reportMatch[1]);

function actualHandler(name, followingMethod, dependencies) {
	const start = controllerSource.indexOf(`\tasync ${name}(): Promise<void> {`);
	assert.notEqual(start, -1, `${name} exists in pinned command controller`);
	const following = controllerSource.indexOf(followingMethod, start);
	const end = following === -1 ? -1 : controllerSource.lastIndexOf("\n\t}", following);
	assert.notEqual(end, -1, `${name} body has the expected class boundary`);
	let body = controllerSource.slice(start, end).replace(/^\tasync [^{]+\{\n/, "");
	body = body.replace(/\n\t\}$/u, "");
	body = body.replace(/^\s*let (\w+): string \| undefined;$/gm, "\t\tlet $1;");
	body = body.replace(/catch \((\w+): unknown\)/gu, "catch ($1)");
	const handler = new Function(...Object.keys(dependencies), `return async function () {\n${body}\n};`)(
		...Object.values(dependencies),
	);
	return handler;
}

function assertPayloadPreserved(actual, expected, label) {
	assert.equal(typeof actual, "string", `${label} remains text`);
	if (expected.length <= 1024) {
		assert.equal(actual, expected);
		return;
	}
	const digest = value => createHash("sha256").update(value).digest("hex");
	assert.equal(actual.length, expected.length, `${label} length`);
	assert.equal(digest(actual), digest(expected), `${label} SHA-256`);
	assert.equal(digest(actual.slice(0, 64)), digest(expected.slice(0, 64)), `${label} prefix`);
	assert.equal(digest(actual.slice(-64)), digest(expected.slice(-64)), `${label} suffix`);
}

test("pinned /dump reports an unconfirmed request and preserves complete small and large payloads", async () => {
	for (const payload of ["small transcript\n", `large transcript\n${"x".repeat(4 * 1024 * 1024)}\n`]) {
		let copied;
		let status;
		const ctx = {
			session: {
				formatSessionAsText: () => payload,
				dumpLlmRequestToTmpDir: async () => "/tmp/omp-llm-request-fixture.json",
			},
			showStatus: message => (status = message),
			showError: message => assert.fail(message),
		};
		const handler = actualHandler("handleDumpCommand", "handleDumpAllCommand", {
			copyToClipboard: async value => (copied = value),
		});
		await handler.call({ ctx });
		const expected = `${payload}\n\n---\nLLM request JSON: /tmp/omp-llm-request-fixture.json\nThis file persists on disk and may contain raw context/secrets — treat accordingly.`;
		assertPayloadPreserved(copied, expected, `transcript of ${payload.length} characters`);
		assert.match(status, /clipboard copy requested/i);
		assert.match(status, /delivery is unconfirmed/i);
		assert.match(status, /\/dump all/);
		assert.match(status, /LLM request JSON: \/tmp\/omp-llm-request-fixture\.json/);
		assert.doesNotMatch(status, /Session copied to clipboard/i);
	}
});

test("pinned /dump all keeps its persistent archive report and does not confirm clipboard delivery", async () => {
	let copied;
	let status;
	const archiveResult = {
		path: "/tmp/omp-dump-fixture.zip",
		files: ["session.md", "llm-request.json", "subagents/reviewer.md"],
		subagentCount: 1,
	};
	const ctx = {
		session: { dumpSessionArchiveToTmpDir: async () => archiveResult },
		showStatus: message => (status = message),
		showError: message => assert.fail(message),
	};
	const handler = actualHandler("handleDumpAllCommand", "handleAdvisorDumpCommand", {
		copyToClipboard: async value => (copied = value),
		formatDumpArchiveReport,
	});
	await handler.call({ ctx });
	assert.equal(copied, archiveResult.path);
	assert.match(status, /clipboard copy requested/i);
	assert.match(status, /delivery is unconfirmed/i);
	assert.match(status, /Session dump archive: \/tmp\/omp-dump-fixture\.zip/);
	assert.match(status, /session\.md/);
	assert.match(status, /llm-request\.json/);
	assert.match(status, /subagents\/reviewer\.md/);
	assert.match(status, /This archive persists on disk/);
	assert.doesNotMatch(status, /Archive path copied to clipboard/i);
});
