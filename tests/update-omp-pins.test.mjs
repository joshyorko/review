import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { copyFile, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import { releasePins, syncOmpPins, updateContainerfile, updateSdkLock } from "../scripts/update-omp-pins.mjs";

const SOURCE_COMMIT = "c".repeat(40);
const SOURCE_ARCHIVE = Buffer.from("pinned OMP source archive fixture");
const SOURCE_SHA256 = createHash("sha256").update(SOURCE_ARCHIVE).digest("hex");
const NATIVE_X64 = Buffer.from("x64 native package fixture");
const NATIVE_ARM64 = Buffer.from("arm64 native package fixture");
const NATIVE_X64_SHA512 = createHash("sha512").update(NATIVE_X64).digest("hex");
const NATIVE_ARM64_SHA512 = createHash("sha512").update(NATIVE_ARM64).digest("hex");
const SDK_NAME = "review-ci-sdk-types";
const SDK_PACKAGE = "ci/sdk-types/package.json";
const SDK_LOCK = "ci/sdk-types/package-lock.json";
const RELEASE = { tag_name: "v18.2.1", draft: false, prerelease: false };
const FUTURE_RELEASE = { tag_name: "v18.3.0", draft: false, prerelease: false };
const runFile = promisify(execFile);
const OLD_CONTAINERFILE = `# renovate: datasource=github-releases depName=can1357/oh-my-pi
ARG OMP_VERSION=18.1.22
ARG OMP_SOURCE_COMMIT=${"0".repeat(40)}
ARG OMP_SOURCE_SHA256=${"1".repeat(64)}
ARG OMP_PATCH_SHA256=${"2".repeat(64)}
ARG OMP_CLIPBOARD_PATCH_SOURCE_COMMIT=${"3".repeat(40)}
ARG OMP_SESSION_LIFECYCLE_PATCH_SOURCE_COMMIT=${"3".repeat(40)}
ARG OMP_CLIPBOARD_PATCH_SHA256=${"4".repeat(64)}
ARG OMP_SESSION_LIFECYCLE_PATCH_SHA256=${"4".repeat(64)}
ARG OMP_CLIPBOARD_PATCH_PATH=/usr/local/share/review/omp/clipboard-truthful.patch
ARG OMP_SESSION_LIFECYCLE_PATCH_PATH=/usr/local/share/review/omp/session-lifecycle.patch
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

async function writeSdkFixtures(root, version) {
	const sdkRoot = join(root, "ci/sdk-types");
	await mkdir(sdkRoot, { recursive: true });
	const packageJson = {
		name: SDK_NAME,
		private: true,
		dependencies: {
			"@oh-my-pi/pi-coding-agent": version,
			"@types/node": "24.19.2",
			tsx: "4.21.0",
			typescript: "5.9.3",
		},
	};
	const packageLock = {
		name: SDK_NAME,
		lockfileVersion: 3,
		requires: true,
		packages: {
			"": { name: SDK_NAME, dependencies: { ...packageJson.dependencies } },
			"node_modules/@oh-my-pi/pi-coding-agent": { version },
		},
	};
	await writeFile(join(sdkRoot, "package.json"), `${JSON.stringify(packageJson, null, 2)}\n`);
	await writeFile(join(sdkRoot, "package-lock.json"), `${JSON.stringify(packageLock, null, 2)}\n`);
	await writeFile(join(root, "ci/toolchains.json"), `${JSON.stringify({ verification: { sdkLockGeneratorNpm: "11.20.0" } }, null, 2)}\n`);
}

async function fixtureSdkLockUpdate({ packageJson, lockfile, version }) {
	const pkg = JSON.parse(packageJson);
	const lock = JSON.parse(lockfile);
	pkg.dependencies["@oh-my-pi/pi-coding-agent"] = version;
	lock.packages[""].dependencies["@oh-my-pi/pi-coding-agent"] = version;
	lock.packages["node_modules/@oh-my-pi/pi-coding-agent"].version = version;
	return `${JSON.stringify(lock, null, 2)}\n`;
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

test("SDK lock refresh receives an isolated npm home and preserves the exact OMP package version", async () => {
	const packageJson = JSON.stringify({ dependencies: { "@oh-my-pi/pi-coding-agent": "18.3.0" } });
	const lockfile = JSON.stringify({ packages: { "": { dependencies: { "@oh-my-pi/pi-coding-agent": "18.2.1" } } } });
	let installRoot = "";
	const updated = await updateSdkLock({
		packageJson,
		lockfile,
		version: "18.3.0",
		runNpm: async (root, environment) => {
			installRoot = root;
			assert.equal(environment.HOME, root);
			assert.equal(environment.NPM_CONFIG_USERCONFIG, join(root, "empty.npmrc"));
			assert.equal(environment.NPM_CONFIG_GLOBALCONFIG, join(root, "empty-global.npmrc"));
			const lockPath = join(root, "package-lock.json");
			const next = JSON.parse(await readFile(lockPath, "utf8"));
			next.packages[""].dependencies["@oh-my-pi/pi-coding-agent"] = "18.3.0";
			next.packages["node_modules/@oh-my-pi/pi-coding-agent"] = { version: "18.3.0" };
			await writeFile(lockPath, JSON.stringify(next));
		},
	});
	assert.ok(installRoot);
	assert.equal(JSON.parse(updated).packages["node_modules/@oh-my-pi/pi-coding-agent"].version, "18.3.0");
});

test("updateContainerfile replaces the exact version, source, and native-addon pin set", () => {
	const updated = updateContainerfile(OLD_CONTAINERFILE, EXPECTED_PINS);
	assert.match(updated, /^ARG OMP_VERSION=18\.2\.1$/m);
	assert.match(updated, new RegExp(`^ARG OMP_SOURCE_COMMIT=${SOURCE_COMMIT}$`, "m"));
	assert.match(updated, new RegExp(`^ARG OMP_SOURCE_SHA256=${SOURCE_SHA256}$`, "m"));
	assert.match(updated, new RegExp(`^ARG OMP_PATCH_SHA256=${"2".repeat(64)}$`, "m"));
	assert.match(updated, new RegExp(`^ARG OMP_CLIPBOARD_PATCH_SOURCE_COMMIT=${"3".repeat(40)}$`, "m"));
	assert.match(updated, new RegExp(`^ARG OMP_SESSION_LIFECYCLE_PATCH_SOURCE_COMMIT=${"3".repeat(40)}$`, "m"));
	assert.match(updated, new RegExp(`^ARG OMP_CLIPBOARD_PATCH_SHA256=${"4".repeat(64)}$`, "m"));
	assert.match(updated, new RegExp(`^ARG OMP_SESSION_LIFECYCLE_PATCH_SHA256=${"4".repeat(64)}$`, "m"));
	assert.match(updated, /^ARG OMP_CLIPBOARD_PATCH_PATH=\/usr\/local\/share\/review\/omp\/clipboard-truthful\.patch$/m);
	assert.match(updated, /^ARG OMP_SESSION_LIFECYCLE_PATCH_PATH=\/usr\/local\/share\/review\/omp\/session-lifecycle\.patch$/m);
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
	await writeSdkFixtures(root, "18.2.1");
	const { fetchImpl, urls } = createFetcher();
	let sdkLockUpdateCalls = 0;
	const pins = await syncOmpPins({
		root,
		fetchImpl,
		sdkLockUpdater: async input => {
			sdkLockUpdateCalls += 1;
			return fixtureSdkLockUpdate(input);
		},
	});

	assert.deepEqual(pins, EXPECTED_PINS);
	assert.equal(sdkLockUpdateCalls, 1, "a same-version post-upgrade run refreshes a potentially stale SDK lock");
	assert.deepEqual(new Set(urls), new Set([
		"https://api.github.com/repos/can1357/oh-my-pi/releases/tags/v18.2.1",
		"https://api.github.com/repos/can1357/oh-my-pi/commits/v18.2.1",
		`https://github.com/can1357/oh-my-pi/archive/${SOURCE_COMMIT}.tar.gz`,
		"https://registry.npmjs.org/%40oh-my-pi%2Fpi-natives-linux-x64/18.2.1",
		"https://registry.npmjs.org/%40oh-my-pi%2Fpi-natives-linux-arm64/18.2.1",
	]));
	const appliance = await readFile(join(root, "image/appliance/Containerfile"), "utf8");
	const sdkPackage = JSON.parse(await readFile(join(root, SDK_PACKAGE), "utf8"));
	const sdkLock = JSON.parse(await readFile(join(root, SDK_LOCK), "utf8"));
	assert.equal(sdkPackage.dependencies["@oh-my-pi/pi-coding-agent"], "18.2.1");
	assert.equal(sdkLock.packages["node_modules/@oh-my-pi/pi-coding-agent"].version, "18.2.1");
	assert.match(appliance, /^ARG OMP_VERSION=18\.2\.1$/m);
	assert.match(appliance, new RegExp(`^ARG OMP_SOURCE_COMMIT=${SOURCE_COMMIT}$`, "m"));
	assert.match(appliance, new RegExp(`^ARG OMP_SOURCE_SHA256=${SOURCE_SHA256}$`, "m"));
	assert.match(appliance, new RegExp(`^ARG OMP_PATCH_SHA256=${"2".repeat(64)}$`, "m"));
	assert.match(appliance, new RegExp(`^ARG OMP_CLIPBOARD_PATCH_SOURCE_COMMIT=${"3".repeat(40)}$`, "m"));
	assert.match(appliance, new RegExp(`^ARG OMP_SESSION_LIFECYCLE_PATCH_SOURCE_COMMIT=${"3".repeat(40)}$`, "m"));
	assert.match(appliance, new RegExp(`^ARG OMP_CLIPBOARD_PATCH_SHA256=${"4".repeat(64)}$`, "m"));
	assert.match(appliance, new RegExp(`^ARG OMP_SESSION_LIFECYCLE_PATCH_SHA256=${"4".repeat(64)}$`, "m"));
	assert.match(appliance, /^ARG OMP_CLIPBOARD_PATCH_PATH=\/usr\/local\/share\/review\/omp\/clipboard-truthful\.patch$/m);
	assert.match(appliance, /^ARG OMP_SESSION_LIFECYCLE_PATCH_PATH=\/usr\/local\/share\/review\/omp\/session-lifecycle\.patch$/m);
	assert.match(appliance, new RegExp(`^ARG OMP_NATIVES_X86_64_SHA512=${NATIVE_X64_SHA512}$`, "m"));
	assert.match(appliance, new RegExp(`^ARG OMP_NATIVES_AARCH64_SHA512=${NATIVE_ARM64_SHA512}$`, "m"));
});

test("syncOmpPins fails closed on malformed npm integrity without rewriting pins", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "omp-pins-invalid-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	await mkdir(join(root, "image/appliance"), { recursive: true });
	const path = join(root, "image/appliance/Containerfile");
	await writeFile(path, RENOVATED_CONTAINERFILE);
	await writeSdkFixtures(root, "18.2.1");
	const { fetchImpl } = createFetcher({ badNative: true });

	await assert.rejects(syncOmpPins({ root, fetchImpl }), /invalid SHA-512 registry integrity/);
	assert.equal(await readFile(path, "utf8"), RENOVATED_CONTAINERFILE);
});

test("same-version Renovate replay repairs a stale SDK lock", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "omp-sdk-lock-stale-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	await mkdir(join(root, "image/appliance"), { recursive: true });
	await writeFile(join(root, "image/appliance/Containerfile"), RENOVATED_CONTAINERFILE);
	await writeSdkFixtures(root, "18.2.1");
	const lockPath = join(root, SDK_LOCK);
	const staleLock = JSON.parse(await readFile(lockPath, "utf8"));
	staleLock.packages[""].dependencies["@oh-my-pi/pi-coding-agent"] = "18.1.22";
	staleLock.packages["node_modules/@oh-my-pi/pi-coding-agent"].version = "18.1.22";
	await writeFile(lockPath, `${JSON.stringify(staleLock, null, 2)}\n`);
	let lockRefreshCalls = 0;

	await syncOmpPins({
		root,
		fetchImpl: createFetcher().fetchImpl,
		sdkLockUpdater: async input => {
			lockRefreshCalls += 1;
			return fixtureSdkLockUpdate(input);
		},
	});

	const refreshedLock = JSON.parse(await readFile(lockPath, "utf8"));
	assert.equal(lockRefreshCalls, 1);
	assert.equal(refreshedLock.packages["node_modules/@oh-my-pi/pi-coding-agent"].version, "18.2.1");
});

test("OMP source updates regenerate the SDK lock before atomically writing its pins", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "omp-sdk-lock-update-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	await mkdir(join(root, "image/appliance"), { recursive: true });
	await writeFile(join(root, "image/appliance/Containerfile"), RENOVATED_CONTAINERFILE);
	await writeSdkFixtures(root, "18.2.1");
	const { fetchImpl } = createFetcher({ release: FUTURE_RELEASE });

	const pins = await syncOmpPins({ root, requestedVersion: "18.3.0", fetchImpl, sdkLockUpdater: fixtureSdkLockUpdate });
	const appliance = await readFile(join(root, "image/appliance/Containerfile"), "utf8");
	const sdkPackage = JSON.parse(await readFile(join(root, SDK_PACKAGE), "utf8"));
	const sdkLock = JSON.parse(await readFile(join(root, SDK_LOCK), "utf8"));
	assert.equal(pins.version, "18.3.0");
	assert.match(appliance, /^ARG OMP_VERSION=18\.3\.0$/m);
	assert.equal(sdkPackage.dependencies["@oh-my-pi/pi-coding-agent"], "18.3.0");
	assert.equal(sdkLock.packages[""].dependencies["@oh-my-pi/pi-coding-agent"], "18.3.0");
	assert.equal(sdkLock.packages["node_modules/@oh-my-pi/pi-coding-agent"].version, "18.3.0");

	const before = [appliance, await readFile(join(root, SDK_PACKAGE), "utf8"), await readFile(join(root, SDK_LOCK), "utf8")];
	const failureFetcher = createFetcher({ release: { ...FUTURE_RELEASE, tag_name: "v18.4.0" } });
	await assert.rejects(
		syncOmpPins({ root, requestedVersion: "18.4.0", fetchImpl: failureFetcher.fetchImpl, sdkLockUpdater: async () => { throw new Error("lock refresh failed"); } }),
		/lock refresh failed/,
	);
	assert.deepEqual([
		await readFile(join(root, "image/appliance/Containerfile"), "utf8"),
		await readFile(join(root, SDK_PACKAGE), "utf8"),
		await readFile(join(root, SDK_LOCK), "utf8"),
	], before, "a failed lock refresh must not partially rewrite OMP pins");
});

test("OMP upgrades keep version-owned appliance contracts current", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "omp-contract-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	for (const relativePath of [
		"image/appliance/Containerfile",
		"image/appliance/entrypoint.sh",
		"image/extension/typesafe-omp-loader.mjs",
		"tests/typesafe-appliance-contract.sh",
		SDK_PACKAGE,
		SDK_LOCK,
		"ci/toolchains.json",
	]) {
		const destination = join(root, relativePath);
		await mkdir(dirname(destination), { recursive: true });
		await copyFile(relativePath, destination);
	}

	const { fetchImpl } = createFetcher({ release: FUTURE_RELEASE });
	await syncOmpPins({ root, requestedVersion: "18.3.0", fetchImpl, sdkLockUpdater: fixtureSdkLockUpdate });
	const result = await runFile("bash", [join(root, "tests/typesafe-appliance-contract.sh")], {
		cwd: root,
		env: { ...process.env, TYPESAFE_RUNTIME_IMAGE: "" },
	});
	assert.match(result.stdout, /static contract holds \(OMP 18\.3\.0/);
});

test("Renovate follows stable OMP releases and the appliance publisher validates pin sync", async () => {
	const config = JSON.parse(await readFile("renovate.json", "utf8"));
	assert.equal(config.extends, undefined, "Review must inherit centrally from Patchraptor");
	assert.equal(config.forkProcessing, undefined, "Review uses normal repository discovery");
	assert.equal(config.dependencyDashboard, true);
	assert.equal(config.dependencyDashboardTitle, "PatchRaptor Dependency Dashboard");
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
	assert.deepEqual(rule.postUpgradeTasks.fileFilters, [
		"image/appliance/Containerfile",
		"ci/sdk-types/package.json",
		"ci/sdk-types/package-lock.json",
	]);

	await assert.rejects(readFile(".github/workflows/renovate.yml"), { code: "ENOENT" });
	const workflow = await readFile(".github/workflows/validate.yml", "utf8");
	assert.match(workflow, /push:/);
	assert.match(workflow, /node --test tests\/update-omp-pins\.test\.mjs/);
});

test("pinned OMP source regression follows the current release and patch pins", async () => {
	const fixture = await readFile("tests/fixtures/issue-140-clipboard-truth.test.mjs", "utf8");
	for (const name of ["OMP_VERSION", "OMP_SOURCE_COMMIT", "OMP_SOURCE_SHA256", "OMP_PATCH_SHA256", "OMP_CLIPBOARD_PATCH_SHA256"]) {
		assert.match(fixture, new RegExp(`pinnedArg\\("${name}"\\)`), `${name} comes from Containerfile`);
	}
	assert.doesNotMatch(fixture, /18\.12\.6|45c35e40c46166dc726ccc52f5d27f40f2449f99|645df2d527de1b0ff62514ac14250230622439d5d5e84f781ffa06d38415b8d0|608959e93b132d50aa9b6d015b1b6fecc6dbb644e7295628bee1f11640cf224e/);
});

test("OMP Renovate candidates run exact-source qualification before the strict pin contract", async () => {
	const workflow = await readFile(".github/workflows/validate.yml", "utf8");
	const sourceRegression = workflow.indexOf("name: Pinned OMP source regressions");
	const qualification = workflow.indexOf("name: Requalify OMP compatibility patches");
	const applianceContract = workflow.indexOf("name: Appliance pin contract");
	assert.ok(sourceRegression >= 0 && sourceRegression < qualification && qualification < applianceContract);
	assert.match(workflow, /node scripts\/qualify-omp-upgrade\.mjs --if-stale/);
	assert.match(workflow, /REVIEW_OMP_PATCH_QUALIFICATION=1/);
});
