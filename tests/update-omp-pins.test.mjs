import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { copyFile, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import { releasePins, syncOmpPins, updateContainerfile } from "../scripts/update-omp-pins.mjs";

const SOURCE_COMMIT = "c".repeat(40);
const SOURCE_ARCHIVE = Buffer.from("pinned OMP source archive fixture");
const SOURCE_SHA256 = createHash("sha256").update(SOURCE_ARCHIVE).digest("hex");
const NATIVE_X64 = Buffer.from("x64 native package fixture");
const NATIVE_ARM64 = Buffer.from("arm64 native package fixture");
const NATIVE_X64_SHA512 = createHash("sha512").update(NATIVE_X64).digest("hex");
const NATIVE_ARM64_SHA512 = createHash("sha512").update(NATIVE_ARM64).digest("hex");
const RELEASE = { tag_name: "v18.2.1", draft: false, prerelease: false };
const FUTURE_RELEASE = { tag_name: "v18.3.0", draft: false, prerelease: false };
const runFile = promisify(execFile);
const OLD_CONTAINERFILE = `# renovate: datasource=github-releases depName=can1357/oh-my-pi
ARG OMP_VERSION=18.1.22
ARG OMP_SOURCE_COMMIT=${"0".repeat(40)}
ARG OMP_SOURCE_SHA256=${"1".repeat(64)}
ARG OMP_NATIVES_VERSION=18.1.22
ARG OMP_NATIVES_X86_64_SHA512=${"a".repeat(128)}
ARG OMP_NATIVES_AARCH64_SHA512=${"b".repeat(128)}
`;
const RENOVATED_CONTAINERFILE = OLD_CONTAINERFILE.replace("18.1.22", "18.2.1");

function jsonResponse(payload) {
	return new Response(JSON.stringify(payload), { status: 200, headers: { "content-type": "application/json" } });
}

function createFetcher({ release = RELEASE, commit = SOURCE_COMMIT, sourceArchive = SOURCE_ARCHIVE, badNative = false } = {}) {
	const urls = [];
	const fetchImpl = async (input) => {
		const url = String(input);
		urls.push(url);
		if (url.endsWith(`/releases/tags/v${release.tag_name.slice(1)}`)) return jsonResponse(release);
		if (url.endsWith(`/commits/v${release.tag_name.slice(1)}`)) return jsonResponse({ sha: commit });
		if (url.endsWith(`/${commit}.tar.gz`)) return new Response(sourceArchive);
		if (url.includes("pi-natives-linux-x64/")) {
			return jsonResponse({ dist: { integrity: `sha512-${Buffer.from(NATIVE_X64_SHA512, "hex").toString("base64")}` } });
		}
		if (url.includes("pi-natives-linux-arm64/")) {
			const integrity = badNative ? "sha512-invalid" : `sha512-${Buffer.from(NATIVE_ARM64_SHA512, "hex").toString("base64")}`;
			return jsonResponse({ dist: { integrity } });
		}
		throw new Error(`unexpected OMP pin lookup: ${url}`);
	};
	return { fetchImpl, urls };
}

const EXPECTED_PINS = {
	version: "18.2.1",
	sourceCommit: SOURCE_COMMIT,
	sourceSha256: SOURCE_SHA256,
	nativesVersion: "18.2.1",
	nativesX86_64Sha512: NATIVE_X64_SHA512,
	nativesAarch64Sha512: NATIVE_ARM64_SHA512,
};

test("releasePins accepts stable semver tags and rejects prereleases or mismatched versions", () => {
	assert.deepEqual(releasePins(RELEASE), { version: "18.2.1" });
	assert.throws(() => releasePins({ ...RELEASE, prerelease: true }), /published stable release/);
	assert.throws(() => releasePins({ ...RELEASE, draft: true }), /published stable release/);
	assert.throws(() => releasePins({ ...RELEASE, tag_name: "latest" }), /invalid OMP release tag/);
	assert.throws(() => releasePins(RELEASE, "18.2.0"), /requested OMP 18\.2\.0, received 18\.2\.1/);
});

test("updateContainerfile replaces the exact version, source, and native-addon pin set", () => {
	const updated = updateContainerfile(OLD_CONTAINERFILE, EXPECTED_PINS);
	assert.match(updated, /^ARG OMP_VERSION=18\.2\.1$/m);
	assert.match(updated, new RegExp(`^ARG OMP_SOURCE_COMMIT=${SOURCE_COMMIT}$`, "m"));
	assert.match(updated, new RegExp(`^ARG OMP_SOURCE_SHA256=${SOURCE_SHA256}$`, "m"));
	assert.match(updated, /^ARG OMP_NATIVES_VERSION=18\.2\.1$/m);
	assert.match(updated, new RegExp(`^ARG OMP_NATIVES_X86_64_SHA512=${NATIVE_X64_SHA512}$`, "m"));
	assert.match(updated, new RegExp(`^ARG OMP_NATIVES_AARCH64_SHA512=${NATIVE_ARM64_SHA512}$`, "m"));
	assert.throws(() => updateContainerfile(`${OLD_CONTAINERFILE}ARG OMP_VERSION=1.0.0\n`, EXPECTED_PINS), /expected one ARG OMP_VERSION pin/);
});

test("syncOmpPins resolves stable tag source and both scoped npm integrity pins", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "omp-pins-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	await mkdir(join(root, "image/appliance"), { recursive: true });
	await writeFile(join(root, "image/appliance/Containerfile"), RENOVATED_CONTAINERFILE);
	const { fetchImpl, urls } = createFetcher();

	const pins = await syncOmpPins({ root, fetchImpl });

	assert.deepEqual(pins, EXPECTED_PINS);
	assert.deepEqual(new Set(urls), new Set([
		"https://api.github.com/repos/can1357/oh-my-pi/releases/tags/v18.2.1",
		"https://api.github.com/repos/can1357/oh-my-pi/commits/v18.2.1",
		`https://github.com/can1357/oh-my-pi/archive/${SOURCE_COMMIT}.tar.gz`,
		"https://registry.npmjs.org/%40oh-my-pi%2Fpi-natives-linux-x64/18.2.1",
		"https://registry.npmjs.org/%40oh-my-pi%2Fpi-natives-linux-arm64/18.2.1",
	]));
	const appliance = await readFile(join(root, "image/appliance/Containerfile"), "utf8");
	assert.match(appliance, /^ARG OMP_VERSION=18\.2\.1$/m);
	assert.match(appliance, new RegExp(`^ARG OMP_SOURCE_COMMIT=${SOURCE_COMMIT}$`, "m"));
	assert.match(appliance, new RegExp(`^ARG OMP_SOURCE_SHA256=${SOURCE_SHA256}$`, "m"));
	assert.match(appliance, new RegExp(`^ARG OMP_NATIVES_X86_64_SHA512=${NATIVE_X64_SHA512}$`, "m"));
	assert.match(appliance, new RegExp(`^ARG OMP_NATIVES_AARCH64_SHA512=${NATIVE_ARM64_SHA512}$`, "m"));
});

test("syncOmpPins fails closed on malformed npm integrity without rewriting pins", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "omp-pins-invalid-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	await mkdir(join(root, "image/appliance"), { recursive: true });
	const path = join(root, "image/appliance/Containerfile");
	await writeFile(path, RENOVATED_CONTAINERFILE);
	const { fetchImpl } = createFetcher({ badNative: true });

	await assert.rejects(syncOmpPins({ root, fetchImpl }), /invalid SHA-512 registry integrity/);
	assert.equal(await readFile(path, "utf8"), RENOVATED_CONTAINERFILE);
});

test("OMP upgrades keep version-owned appliance contracts current", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "omp-contract-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	for (const relativePath of [
		"image/appliance/Containerfile",
		"image/appliance/entrypoint.sh",
		"image/extension/typesafe-omp-loader.mjs",
		"tests/typesafe-appliance-contract.sh",
	]) {
		const destination = join(root, relativePath);
		await mkdir(dirname(destination), { recursive: true });
		await copyFile(relativePath, destination);
	}

	const { fetchImpl } = createFetcher({ release: FUTURE_RELEASE });
	await syncOmpPins({ root, requestedVersion: "18.3.0", fetchImpl });
	const result = await runFile("bash", [join(root, "tests/typesafe-appliance-contract.sh")], {
		cwd: root,
		env: { ...process.env, TYPESAFE_RUNTIME_IMAGE: "" },
	});
	assert.match(result.stdout, /static contract holds \(OMP 18\.3\.0/);
});

test("Renovate follows stable OMP releases and the appliance publisher validates pin sync", async () => {
	const config = JSON.parse(await readFile("renovate.json", "utf8"));
	assert.equal(config.extends, undefined, "Review must inherit centrally from Patchraptor");
	assert.equal(config.forkProcessing, "enabled", "central autodiscovery must process this fork");
	const manager = config.customManagers.find((candidate) => candidate.depNameTemplate === "can1357/oh-my-pi");
	assert.ok(manager, "OMP needs a regex manager for ARG OMP_VERSION");
	assert.equal(manager.datasourceTemplate, "github-releases");
	assert.equal(manager.versioningTemplate, "semver-coerced");
	assert.match(manager.matchStrings[0], /ARG OMP_VERSION/);
	const rule = config.packageRules.find((candidate) => candidate.matchPackageNames?.includes("can1357/oh-my-pi"));
	assert.ok(rule, "OMP needs a dedicated Renovate package rule");
	assert.deepEqual(rule.matchDatasources, ["github-releases"]);
	assert.equal(rule.matchManagers, undefined);
	assert.equal(rule.automerge, true);
	assert.equal(rule.automergeType, "pr");
	assert.equal(rule.automergeStrategy, "squash");
	assert.deepEqual(rule.postUpgradeTasks.commands, ["node scripts/update-omp-pins.mjs"]);
	assert.deepEqual(rule.postUpgradeTasks.fileFilters, ["image/appliance/Containerfile"]);

	await assert.rejects(readFile(".github/workflows/renovate.yml"), { code: "ENOENT" });
	const workflow = await readFile(".github/workflows/publish-appliance.yml", "utf8");
	assert.match(workflow, /push:\n    branches:\n      - main/);
	assert.match(workflow, /node --test tests\/update-omp-pins\.test\.mjs/);
});
