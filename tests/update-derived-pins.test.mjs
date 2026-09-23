import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
	releasePins as ghReleasePins,
	syncGhPins,
	updateContainerfile as updateGhContainerfile,
} from "../scripts/update-gh-pins.mjs";
import {
	fetchPackageHashes,
	updateLockfileContent,
} from "../scripts/update-requirements-ci-hashes.mjs";

const X64 = "a".repeat(64);
const ARM64 = "b".repeat(64);
const GH_RELEASE = {
	tag_name: "v2.97.0",
	draft: false,
	prerelease: false,
	assets: [
		{ name: "gh_2.97.0_linux_amd64.tar.gz", digest: `sha256:${X64}` },
		{ name: "gh_2.97.0_linux_arm64.tar.gz", digest: `sha256:${ARM64}` },
	],
};
const OLD_GH_CONTAINERFILE = `# renovate: datasource=github-releases depName=cli/cli
ARG GH_VERSION=2.96.0
ARG GH_X86_64_SHA256=${"1".repeat(64)}
ARG GH_AARCH64_SHA256=${"2".repeat(64)}
`;
const RENOVATED_GH_CONTAINERFILE = OLD_GH_CONTAINERFILE.replace("2.96.0", "2.97.0");

function response(payload, { status = 200, statusText = "OK" } = {}) {
	return {
		ok: status >= 200 && status < 300,
		status,
		statusText,
		json: async () => payload,
		text: async () => (typeof payload === "string" ? payload : JSON.stringify(payload)),
	};
}

test("ghReleasePins accepts stable assets and rejects incomplete release evidence", () => {
	assert.deepEqual(ghReleasePins(GH_RELEASE), { version: "2.97.0", x86_64: X64, aarch64: ARM64 });
	assert.throws(() => ghReleasePins({ ...GH_RELEASE, prerelease: true }), /published stable release/);
	assert.throws(() => ghReleasePins({ ...GH_RELEASE, draft: true }), /published stable release/);
	assert.throws(
		() => ghReleasePins({ ...GH_RELEASE, assets: GH_RELEASE.assets.filter((asset) => !asset.name.includes("arm64")) }),
		/has no gh_2\.97\.0_linux_arm64\.tar\.gz asset/,
	);
	assert.throws(
		() => ghReleasePins({ ...GH_RELEASE, assets: [{ name: "gh_2.97.0_linux_amd64.tar.gz", digest: "" }] }),
		/no valid SHA-256 digest/,
	);
});

test("updateGhContainerfile replaces one complete GH pin set", () => {
	const updated = updateGhContainerfile(OLD_GH_CONTAINERFILE, { version: "2.97.0", x86_64: X64, aarch64: ARM64 });
	assert.match(updated, /^ARG GH_VERSION=2\.97\.0$/m);
	assert.match(updated, new RegExp(`^ARG GH_X86_64_SHA256=${X64}$`, "m"));
	assert.match(updated, new RegExp(`^ARG GH_AARCH64_SHA256=${ARM64}$`, "m"));
	assert.throws(
		() => updateGhContainerfile(`${OLD_GH_CONTAINERFILE}ARG GH_VERSION=2.0.0\n`, { version: "2.97.0", x86_64: X64, aarch64: ARM64 }),
		/expected one ARG GH_VERSION pin/,
	);
});

test("syncGhPins updates the Review appliance from the selected release", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "gh-pins-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	await mkdir(join(root, "image/appliance"), { recursive: true });
	await writeFile(join(root, "image/appliance/Containerfile"), RENOVATED_GH_CONTAINERFILE);

	const urls = [];
	const pins = await syncGhPins({
		root,
		fetchImpl: async (url) => {
			urls.push(String(url));
			return response(GH_RELEASE);
		},
	});

	assert.equal(pins.version, "2.97.0");
	assert.deepEqual(urls, ["https://api.github.com/repos/cli/cli/releases/tags/v2.97.0"]);
	const appliance = await readFile(join(root, "image/appliance/Containerfile"), "utf8");
	assert.match(appliance, /^ARG GH_VERSION=2\.97\.0$/m);
	assert.match(appliance, new RegExp(`^ARG GH_X86_64_SHA256=${X64}$`, "m"));
	assert.match(appliance, new RegExp(`^ARG GH_AARCH64_SHA256=${ARM64}$`, "m"));
});

test("fetchPackageHashes deduplicates hashes and rejects unavailable PyPI releases", async () => {
	const hashes = await fetchPackageHashes("sample-pkg", "1.0.0", async () => response({
		urls: [
			{ digests: { sha256: X64 } },
			{ digests: { sha256: ARM64 } },
			{ digests: { sha256: X64 } },
		],
	}));
	assert.deepEqual(hashes, [X64, ARM64].sort());
	await assert.rejects(
		() => fetchPackageHashes("sample-pkg", "1.0.0", async () => response({}, { status: 404, statusText: "Not Found" })),
		/PyPI metadata lookup failed/,
	);
	await assert.rejects(
		() => fetchPackageHashes("sample-pkg", "1.0.0", async () => response({ urls: [] })),
		/No release files found on PyPI/,
	);
});

test("updateLockfileContent replaces hashes without losing lock metadata", async () => {
	const initial = `# Header comment
# Compiled via: uv pip compile
foo==1.0.0 \\
    --hash=sha256:${"1".repeat(64)}
    # via bar
`;
	const updated = await updateLockfileContent(initial, async (url) => {
		assert.match(String(url), /pypi\.org\/pypi\/foo\/1\.0\.0\/json/);
		return response({ urls: [{ digests: { sha256: X64 } }, { digests: { sha256: ARM64 } }] });
	});

	assert.match(updated, /^# Header comment/m);
	assert.match(updated, /^# Compiled via: uv pip compile/m);
	assert.match(updated, /^foo==1\.0\.0 \\$/m);
	assert.match(updated, new RegExp(`^    --hash=sha256:${[X64, ARM64].sort()[0]} \\$`, "m"));
	assert.match(updated, new RegExp(`^    --hash=sha256:${[X64, ARM64].sort()[1]}$`, "m"));
	assert.match(updated, /^    # via bar$/m);
});

test("Renovate tracks only shipped Review and CI dependencies", async () => {
	const config = JSON.parse(await readFile("renovate.json", "utf8"));
	const ompManager = config.customManagers.find((manager) => manager.depNameTemplate === "can1357/oh-my-pi");
	const ghManager = config.customManagers.find((manager) => manager.depNameTemplate === "cli/cli");
	const pypiManager = config.customManagers.find((manager) => manager.datasourceTemplate === "pypi");
	assert.ok(ompManager);
	assert.ok(ghManager);
	assert.ok(pypiManager);
	assert.match(ompManager.managerFilePatterns[0], /image\/appliance\/Containerfile/);
	assert.match(ghManager.managerFilePatterns[0], /image\/appliance\/Containerfile/);

	const ompRule = config.packageRules.find((rule) => rule.matchPackageNames?.includes("can1357/oh-my-pi"));
	const ghRule = config.packageRules.find((rule) => rule.matchPackageNames?.includes("cli/cli"));
	const pypiRule = config.packageRules.find((rule) => rule.matchDatasources?.includes("pypi"));
	assert.deepEqual(ompRule.postUpgradeTasks.commands, ["node scripts/update-omp-pins.mjs"]);
	assert.deepEqual(ompRule.postUpgradeTasks.fileFilters, ["image/appliance/Containerfile"]);
	assert.deepEqual(ghRule.postUpgradeTasks.commands, ["node scripts/update-gh-pins.mjs"]);
	assert.deepEqual(ghRule.postUpgradeTasks.fileFilters, ["image/appliance/Containerfile"]);
	assert.deepEqual(pypiRule.postUpgradeTasks.commands, ["node scripts/update-requirements-ci-hashes.mjs"]);
	assert.deepEqual(pypiRule.postUpgradeTasks.fileFilters, ["requirements-ci.lock"]);

	const workflow = await readFile(".github/workflows/renovate.yml", "utf8");
	for (const updater of ["update-omp-pins", "update-gh-pins", "update-requirements-ci-hashes"]) {
		assert.match(workflow, new RegExp(updater));
	}
	assert.doesNotMatch(workflow, /update-(?:node|tmux)-pins/);
	const publisher = await readFile(".github/workflows/publish-appliance.yml", "utf8");
	assert.match(publisher, /node --test tests\\/update-derived-pins\\.test\\.mjs/);
});

test("Renovate extracts appliance pins and CI package versions", async () => {
	const config = JSON.parse(await readFile("renovate.json", "utf8"));
	const appliance = await readFile("image/appliance/Containerfile", "utf8");
	for (const [depName, expectedVersion] of [["can1357/oh-my-pi", "18.2.11"], ["cli/cli", "2.97.0"]]) {
		const manager = config.customManagers.find((candidate) => candidate.depNameTemplate === depName);
		const match = new RegExp(manager.matchStrings[0], "m").exec(appliance);
		assert.ok(match, `${depName} pin is extracted from the Review appliance`);
		assert.equal(match.groups.currentValue, expectedVersion);
	}

	const manager = config.customManagers.find((candidate) => candidate.datasourceTemplate === "pypi");
	const regex = new RegExp(manager.matchStrings[0], "gm");
	const lockfile = await readFile("requirements-ci.lock", "utf8");
	const matches = [...lockfile.matchAll(regex)];
	assert.ok(matches.length >= 10, "requirements-ci.lock packages are extracted");
	assert.ok(matches.some((match) => match.groups.depName === "pre-commit" && match.groups.currentValue === "4.6.2"));
});
