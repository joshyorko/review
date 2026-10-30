import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { copyFile, mkdir, mkdtemp, readFile, rm, statfs } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

const sourceCheckout = process.env.REVIEW_OMP_SOURCE;
const cachedArchive = process.env.ISSUE140_OMP_ARCHIVE;
const qualificationMode = process.env.REVIEW_OMP_PATCH_QUALIFICATION === "1";
const memorydShim = process.env.OMP_MEMORYD_SHIM ?? "0";
assert.ok(memorydShim === "0" || memorydShim === "1", "OMP_MEMORYD_SHIM must be 0 or 1");
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const containerfile = await readFile(path.join(repoRoot, "image/appliance/Containerfile"), "utf8");
function pinnedArg(name) {
	const matches = [...containerfile.matchAll(new RegExp(`^ARG ${name}=([^\\n]+)$`, "gm"))];
	assert.equal(matches.length, 1, `Containerfile has one ${name} pin`);
	return matches[0][1];
}

const expectedArchiveSha256 = pinnedArg("OMP_SOURCE_SHA256");
const expectedSourceCommit = pinnedArg("OMP_SOURCE_COMMIT");
const expectedPatchSha256 = pinnedArg("OMP_CLIPBOARD_PATCH_SHA256");
const expectedOmpVersion = pinnedArg("OMP_VERSION");
const memoryPatchPath = path.join(repoRoot, "patches/omp/memory-backend-registration.patch");
const containerPatchPrefix = "/usr/local/share/review/omp/";
const pinnedPatchPath = pinnedArg("OMP_CLIPBOARD_PATCH_PATH");
assert.ok(pinnedPatchPath.startsWith(containerPatchPrefix), "clipboard patch is staged from the OMP patch directory");
const patchPath = path.join(repoRoot, "patches/omp", path.posix.basename(pinnedPatchPath));

if (!qualificationMode) {
	assert.equal(pinnedArg("OMP_CLIPBOARD_PATCH_SOURCE_COMMIT"), expectedSourceCommit);
}

assert.ok(!(sourceCheckout && cachedArchive), "set REVIEW_OMP_SOURCE or ISSUE140_OMP_ARCHIVE, not both");
const patch = await readFile(patchPath);
const actualPatchSha256 = createHash("sha256").update(patch).digest("hex");
const memoryPatchBytes = memorydShim === "1" ? await readFile(memoryPatchPath) : undefined;
const actualMemoryPatchSha256 = memoryPatchBytes && createHash("sha256").update(memoryPatchBytes).digest("hex");
const memoryPatch = memoryPatchBytes?.toString("utf8") ?? "";
if (!qualificationMode) {
	assert.equal(actualPatchSha256, expectedPatchSha256, "OMP clipboard patch pin");
	if (memorydShim === "1") assert.equal(actualMemoryPatchSha256, pinnedArg("OMP_PATCH_SHA256"), "OMP MemoryBackend patch pin");
}

const tempRoot = await mkdtemp(path.join(tmpdir(), "review-issue-140-omp-"));
const sourceRoot = path.join(tempRoot, "source");
await mkdir(sourceRoot);
test.after(async () => rm(tempRoot, { recursive: true, force: true }));
const tempFs = await statfs(tempRoot);
const freeBytes = tempFs.bavail * tempFs.bsize;
assert.ok(freeBytes >= 128 * 1024 * 1024, `need at least 128 MiB free in the temporary directory; found ${freeBytes}`);

const patchFiles = source => [...source.matchAll(/^--- a\/(\S+)$/gm)].map((match) => match[1]);
const sourceMembers = [...new Set([
	...(memorydShim === "1" ? patchFiles(memoryPatch) : []),
	...patchFiles(patch.toString("utf8")),
	"packages/coding-agent/package.json",
	"packages/coding-agent/src/session/session-dump-format.ts",
])].map(file => `oh-my-pi-${expectedSourceCommit}/${file}`);

if (sourceCheckout) {
	const checkoutCommit = spawnSync("git", ["-C", sourceCheckout, "rev-parse", "HEAD"], { encoding: "utf8" });
	assert.equal(checkoutCommit.status, 0, `read OMP checkout commit: ${checkoutCommit.stderr}`);
	assert.equal(checkoutCommit.stdout.trim(), expectedSourceCommit, "OMP checkout commit pin");
	const checkoutStatus = spawnSync("git", ["-C", sourceCheckout, "status", "--porcelain"], { encoding: "utf8" });
	assert.equal(checkoutStatus.status, 0, `read OMP checkout status: ${checkoutStatus.stderr}`);
	assert.equal(checkoutStatus.stdout, "", "OMP checkout is clean before source extraction");
	for (const member of sourceMembers) {
		const relativePath = member.slice(`oh-my-pi-${expectedSourceCommit}/`.length);
		const destination = path.join(sourceRoot, relativePath);
		await mkdir(path.dirname(destination), { recursive: true });
		await copyFile(path.join(sourceCheckout, relativePath), destination);
	}
} else {
	const archivePath = cachedArchive || path.join(tempRoot, "omp-source.tar.gz");
	if (!cachedArchive) {
		const download = spawnSync(
			"curl",
			[
				"--fail",
				"--location",
				"--show-error",
				"--silent",
				`https://github.com/can1357/oh-my-pi/archive/${expectedSourceCommit}.tar.gz`,
				"-o",
				archivePath,
			],
			{ encoding: "utf8" },
		);
		assert.equal(download.status, 0, `download pinned OMP source archive: ${download.stderr}`);
	}
	const archive = await readFile(archivePath);
	assert.equal(createHash("sha256").update(archive).digest("hex"), expectedArchiveSha256, "OMP archive checksum");
	const extract = spawnSync(
		"tar",
		["--no-same-owner", "-xzf", archivePath, "-C", sourceRoot, "--strip-components=1", "--wildcards", ...sourceMembers],
		{ encoding: "utf8" },
	);
	assert.equal(extract.status, 0, `extract pinned OMP source: ${extract.stderr}`);
}
const sourcePackage = JSON.parse(await readFile(path.join(sourceRoot, "packages/coding-agent/package.json"), "utf8"));
assert.equal(sourcePackage.version, expectedOmpVersion, "OMP source package version pin");
const initialize = spawnSync("git", ["-C", sourceRoot, "init", "-q"], { encoding: "utf8" });
assert.equal(initialize.status, 0, `initialize temporary patch target: ${initialize.stderr}`);

if (memorydShim === "1") {
	const applyMemory = spawnSync("git", ["-C", sourceRoot, "apply", "--check", memoryPatchPath], { encoding: "utf8" });
	assert.equal(applyMemory.status, 0, `check OMP MemoryBackend patch: ${applyMemory.stderr}`);
	const installMemory = spawnSync("git", ["-C", sourceRoot, "apply", memoryPatchPath], { encoding: "utf8" });
	assert.equal(installMemory.status, 0, `apply OMP MemoryBackend patch: ${installMemory.stderr}`);
}
if (process.env.ISSUE140_APPLY_PATCH !== "0") {
	const applyClipboard = spawnSync("git", ["-C", sourceRoot, "apply", "--check", patchPath], { encoding: "utf8" });
	assert.equal(applyClipboard.status, 0, `check OMP clipboard patch after MemoryBackend: ${applyClipboard.stderr}`);
	const installClipboard = spawnSync("git", ["-C", sourceRoot, "apply", patchPath], { encoding: "utf8" });
	assert.equal(installClipboard.status, 0, `apply OMP clipboard patch: ${installClipboard.stderr}`);
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
	const start = controllerSource.indexOf(`\tasync ${name}(`);
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
	assert.match(
		controllerSource,
		/handleDumpAllCommand\(\): Promise<void> \{\s+return this\.#writeDumpArchive\(\(\) => this\.ctx\.session\.dumpSessionArchiveToTmpDir\(\)\);/,
		"/dump all routes the persistent session archive through the shared report helper",
	);
	const ctx = {
		showStatus: message => (status = message),
		showError: message => assert.fail(message),
	};
	const handler = actualHandler("#writeDumpArchive", "handleAdvisorDumpCommand", {
		copyToClipboard: async value => (copied = value),
		formatDumpArchiveReport,
		write: async () => archiveResult,
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
