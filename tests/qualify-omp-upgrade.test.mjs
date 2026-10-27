import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { qualifyOmpUpgrade } from "../scripts/qualify-omp-upgrade.mjs";

const sourceCommit = "0838d2ab4407b74e870de07e1a6780a13c7d542c";
const oldCommit = "45c35e40c46166dc726ccc52f5d27f40f2449f99";
const fileContents = {
	"patches/omp/memory-backend-registration.patch": "memory patch candidate\n",
	"patches/omp/clipboard-truthful.patch": "clipboard patch candidate\n",
	"patches/omp/session-lifecycle.patch": "session patch candidate\n",
};
const digest = value => createHash("sha256").update(value).digest("hex");
const staleHash = "0".repeat(64);
const containerfile = `ARG OMP_VERSION=18.13.1
ARG OMP_SOURCE_COMMIT=${sourceCommit}
ARG OMP_SOURCE_SHA256=${"a".repeat(64)}
ARG OMP_PATCH_SHA256=${staleHash}
ARG OMP_CLIPBOARD_PATCH_SOURCE_COMMIT=${oldCommit}
ARG OMP_SESSION_LIFECYCLE_PATCH_SOURCE_COMMIT=${oldCommit}
ARG OMP_CLIPBOARD_PATCH_SHA256=${staleHash}
ARG OMP_SESSION_LIFECYCLE_PATCH_SHA256=${staleHash}
ARG OMP_CLIPBOARD_PATCH_PATH=/usr/local/share/review/omp/clipboard-truthful.patch
ARG OMP_SESSION_LIFECYCLE_PATCH_PATH=/usr/local/share/review/omp/session-lifecycle.patch
ARG OMP_BUN_VERSION=1.4.2
ARG OMP_BUN_X86_64_SHA256=${"b".repeat(64)}
ARG OMP_BUN_AARCH64_SHA256=${"c".repeat(64)}
ARG OMP_NATIVES_VERSION=18.13.1
ARG OMP_NATIVES_X86_64_SHA512=${"d".repeat(128)}
ARG OMP_NATIVES_AARCH64_SHA512=${"e".repeat(128)}
ARG MEMORYD_SOURCE_COMMIT=${"f".repeat(40)}
ARG MEMORYD_SOURCE_SHA256=${"1".repeat(64)}
`;

async function fixture(t) {
	const root = await mkdtemp(join(tmpdir(), "review-omp-qualify-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	await mkdir(join(root, "image/appliance"), { recursive: true });
	for (const [path, content] of Object.entries(fileContents)) {
		const destination = join(root, path);
		await mkdir(dirname(destination), { recursive: true });
		await writeFile(destination, content);
	}
	const containerfilePath = join(root, "image/appliance/Containerfile");
	await writeFile(containerfilePath, containerfile);
	return { root, containerfilePath };
}

test("qualification records exact source and patch pins only after the full candidate build succeeds", async (t) => {
	const { root, containerfilePath } = await fixture(t);
	let buildCall;
	const result = await qualifyOmpUpgrade({
		root,
		record: true,
		ifStale: true,
		runBuild: async call => {
			buildCall = call;
			return { status: 0 };
		},
	});

	assert.deepEqual(buildCall.args, ["--qualify-only"]);
	assert.equal(buildCall.env.OMP_SOURCE_COMMIT, sourceCommit);
	assert.equal(buildCall.env.OMP_CLIPBOARD_PATCH_SOURCE_COMMIT, oldCommit);
	assert.equal(buildCall.env.OMP_SESSION_LIFECYCLE_PATCH_SOURCE_COMMIT, oldCommit);
	assert.equal(buildCall.env.OMP_PATCH_SHA256, digest(fileContents["patches/omp/memory-backend-registration.patch"]));
	assert.equal(buildCall.env.OMP_CLIPBOARD_PATCH_SHA256, digest(fileContents["patches/omp/clipboard-truthful.patch"]));
	assert.equal(buildCall.env.OMP_SESSION_LIFECYCLE_PATCH_SHA256, digest(fileContents["patches/omp/session-lifecycle.patch"]));
	assert.equal(result.recorded, true);

	const updated = await readFile(containerfilePath, "utf8");
	assert.match(updated, new RegExp(`^ARG OMP_CLIPBOARD_PATCH_SOURCE_COMMIT=${sourceCommit}$`, "m"));
	assert.match(updated, new RegExp(`^ARG OMP_SESSION_LIFECYCLE_PATCH_SOURCE_COMMIT=${sourceCommit}$`, "m"));
	assert.match(updated, new RegExp(`^ARG OMP_PATCH_SHA256=${digest(fileContents["patches/omp/memory-backend-registration.patch"])}$`, "m"));
	assert.match(updated, new RegExp(`^ARG OMP_CLIPBOARD_PATCH_SHA256=${digest(fileContents["patches/omp/clipboard-truthful.patch"])}$`, "m"));
	assert.match(updated, new RegExp(`^ARG OMP_SESSION_LIFECYCLE_PATCH_SHA256=${digest(fileContents["patches/omp/session-lifecycle.patch"])}$`, "m"));
	const skipped = await qualifyOmpUpgrade({
		root,
		ifStale: true,
		runBuild: async () => assert.fail("current provenance must skip duplicate qualification"),
	});
	assert.equal(skipped.skipped, true);
});

test("failed source qualification leaves all provenance and patch digests untouched", async (t) => {
	const { root, containerfilePath } = await fixture(t);
	const original = await readFile(containerfilePath, "utf8");
	await assert.rejects(
		qualifyOmpUpgrade({ root, record: true, runBuild: async () => ({ status: 1 }) }),
		/exact-source OMP patch qualification failed/,
	);
	assert.equal(await readFile(containerfilePath, "utf8"), original);
});

test("qualification refuses to record when a patch changes during the build", async (t) => {
	const { root, containerfilePath } = await fixture(t);
	await assert.rejects(
		qualifyOmpUpgrade({
			root,
			record: true,
			runBuild: async () => {
				await writeFile(join(root, "patches/omp/clipboard-truthful.patch"), "changed during qualification\n");
				return { status: 0 };
			},
		}),
		/qualification inputs changed during the build/,
	);
	assert.equal(await readFile(containerfilePath, "utf8"), containerfile);
});

test("qualification preserves a concurrent Containerfile edit", async (t) => {
	const { root, containerfilePath } = await fixture(t);
	const edited = `${containerfile}# concurrent edit\n`;
	await assert.rejects(
		qualifyOmpUpgrade({
			root,
			record: true,
			runBuild: async () => {
				await writeFile(containerfilePath, edited);
				return { status: 0 };
			},
		}),
		/qualification inputs changed during the build/,
	);
	assert.equal(await readFile(containerfilePath, "utf8"), edited);
});

test("ordinary derived builds reject both stale source attestations before downloading source", async (t) => {
	const { root } = await fixture(t);
	const patchPath = name => join(root, "patches/omp", name);
	const env = {
		...process.env,
		OMP_VERSION: "18.13.1",
		OMP_SOURCE_COMMIT: sourceCommit,
		OMP_SOURCE_SHA256: "a".repeat(64),
		OMP_PATCH_SHA256: digest(fileContents["patches/omp/memory-backend-registration.patch"]),
		OMP_CLIPBOARD_PATCH_SOURCE_COMMIT: oldCommit,
		OMP_SESSION_LIFECYCLE_PATCH_SOURCE_COMMIT: oldCommit,
		OMP_CLIPBOARD_PATCH_SHA256: digest(fileContents["patches/omp/clipboard-truthful.patch"]),
		OMP_SESSION_LIFECYCLE_PATCH_SHA256: digest(fileContents["patches/omp/session-lifecycle.patch"]),
		OMP_CLIPBOARD_PATCH_PATH: patchPath("clipboard-truthful.patch"),
		OMP_SESSION_LIFECYCLE_PATCH_PATH: patchPath("session-lifecycle.patch"),
		OMP_BUN_VERSION: "1.4.2",
		OMP_BUN_X86_64_SHA256: "b".repeat(64),
		OMP_BUN_AARCH64_SHA256: "c".repeat(64),
		OMP_NATIVES_VERSION: "18.13.1",
		OMP_NATIVES_X86_64_SHA512: "d".repeat(128),
		OMP_NATIVES_AARCH64_SHA512: "e".repeat(128),
		MEMORYD_SOURCE_COMMIT: "f".repeat(40),
		MEMORYD_SOURCE_SHA256: "1".repeat(64),
		OMP_PATCH_PATH: patchPath("memory-backend-registration.patch"),
		OMP_OUTPUT_PATH: join(root, "out/omp"),
	};
	const repositoryRoot = dirname(dirname(fileURLToPath(import.meta.url)));
	const result = spawnSync("bash", [join(repositoryRoot, "scripts/build-derived-omp.sh")], {
		cwd: root,
		env,
		encoding: "utf8",
	});
	assert.equal(result.status, 1);
	assert.match(result.stderr, /clipboard patch was reviewed for OMP source/);
	assert.match(result.stderr, /session lifecycle patch was reviewed for OMP source/);
	assert.doesNotMatch(result.stderr, /git ls-remote|curl:/);
});
