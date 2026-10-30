import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";

const REPOSITORY = "can1357/oh-my-pi";
const API = `https://api.github.com/repos/${REPOSITORY}`;
const CONTAINERFILES = ["image/appliance/Containerfile"];
const SDK_PACKAGE = "ci/sdk-types/package.json";
const SDK_LOCK = "ci/sdk-types/package-lock.json";
const VERSION_PATTERN = /^\d+\.\d+\.\d+$/;
const COMMIT_PATTERN = /^[0-9a-f]{40}$/;
const NATIVE_PACKAGES = ["pi-natives-linux-x64", "pi-natives-linux-arm64"];

export function releasePins(release, requestedVersion) {
	if (!release || release.draft === true || release.prerelease === true) {
		throw new Error("OMP release must be a published stable release");
	}
	const version = String(release.tag_name ?? "").replace(/^v/, "");
	if (!VERSION_PATTERN.test(version)) throw new Error(`invalid OMP release tag: ${release.tag_name ?? "missing"}`);
	if (requestedVersion && version !== requestedVersion) {
		throw new Error(`requested OMP ${requestedVersion}, received ${version}`);
	}
	return { version };
}

function replaceSingle(source, pattern, replacement, label, path) {
	const matches = source.match(pattern);
	if (matches?.length !== 1) throw new Error(`${path}: expected one ${label} pin`);
	return source.replace(pattern, replacement);
}

function replaceArg(source, name, value, path) {
	return replaceSingle(source, new RegExp(`^ARG ${name}=.*$`, "gm"), `ARG ${name}=${value}`, `ARG ${name}`, path);
}

function readPinnedVersion(source, path) {
	const matches = [...source.matchAll(/^ARG OMP_VERSION=(.*)$/gm)];
	if (matches.length !== 1) throw new Error(`${path}: expected one ARG OMP_VERSION pin`);
	const version = matches[0][1];
	if (!VERSION_PATTERN.test(version)) throw new Error(`${path}: invalid OMP version ${version}`);
	return version;
}

export function updateContainerfile(source, pins, path = "Containerfile") {
	let updated = replaceArg(source, "OMP_VERSION", pins.version, path);
	updated = replaceArg(updated, "OMP_SOURCE_COMMIT", pins.sourceCommit, path);
	updated = replaceArg(updated, "OMP_SOURCE_SHA256", pins.sourceSha256, path);
	updated = replaceArg(updated, "OMP_NATIVES_VERSION", pins.nativesVersion, path);
	updated = replaceArg(updated, "OMP_NATIVES_X86_64_SHA512", pins.nativesX86_64Sha512, path);
	return replaceArg(updated, "OMP_NATIVES_AARCH64_SHA512", pins.nativesAarch64Sha512, path);
}

export async function updateSdkLock({ packageJson, lockfile, version, npmVersion, runNpm = (tempRoot, environment) => {
	execFileSync("npm", ["install", "--package-lock-only", "--ignore-scripts", "--no-audit", "--no-fund"], {
		cwd: tempRoot,
		env: environment,
		stdio: "pipe",
	});
} }) {
	const tempRoot = await mkdtemp(join(tmpdir(), "review-omp-sdk-lock-"));
	try {
		await writeFile(join(tempRoot, "package.json"), packageJson);
		await writeFile(join(tempRoot, "package-lock.json"), lockfile);
		const npmEnvironment = {
			PATH: process.env.PATH ?? "/usr/bin:/bin",
			HOME: tempRoot,
			NPM_CONFIG_USERCONFIG: join(tempRoot, "empty.npmrc"),
			NPM_CONFIG_GLOBALCONFIG: join(tempRoot, "empty-global.npmrc"),
			NPM_CONFIG_CACHE: join(tempRoot, "npm-cache"),
			...Object.fromEntries(["HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY"].filter(name => process.env[name]).map(name => [name, process.env[name]])),
		};
		if (npmVersion) {
			const actualNpmVersion = execFileSync("npm", ["--version"], { env: npmEnvironment, encoding: "utf8" }).trim();
			if (actualNpmVersion !== npmVersion) {
				throw new Error(`SDK lock generator requires npm ${npmVersion}, found ${actualNpmVersion}`);
			}
		}
		await runNpm(tempRoot, npmEnvironment);
		const updated = await readFile(join(tempRoot, "package-lock.json"), "utf8");
		const parsed = JSON.parse(updated);
		if (parsed.packages?.[""]?.dependencies?.["@oh-my-pi/pi-coding-agent"] !== version ||
			parsed.packages?.["node_modules/@oh-my-pi/pi-coding-agent"]?.version !== version) {
			throw new Error(`SDK lock update did not resolve @oh-my-pi/pi-coding-agent@${version}`);
		}
		return updated;
	} finally {
		await rm(tempRoot, { recursive: true, force: true });
	}
}

function githubHeaders() {
	const token = process.env.RENOVATE_TOKEN || process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
	const headers = {
		Accept: "application/vnd.github+json",
		"User-Agent": "joshyorko-review-omp-sync",
		"X-GitHub-Api-Version": "2022-11-28",
	};
	if (token) headers.Authorization = `Bearer ${token}`;
	return headers;
}

async function requireOk(response, url) {
	if (!response.ok) throw new Error(`OMP pin lookup failed for ${url}: ${response.status} ${response.statusText}`);
	return response;
}

async function fetchJson(url, fetchImpl, headers = {}) {
	const response = await requireOk(await fetchImpl(url, { headers, redirect: "error" }), url);
	return response.json();
}

async function fetchRelease(requestedVersion, fetchImpl) {
	const release = await fetchJson(`${API}/releases/tags/v${requestedVersion}`, fetchImpl, githubHeaders());
	return releasePins(release, requestedVersion);
}

async function fetchSourcePins(version, fetchImpl) {
	const commitUrl = `${API}/commits/v${version}`;
	const commitData = await fetchJson(commitUrl, fetchImpl, githubHeaders());
	const sourceCommit = String(commitData.sha ?? "");
	if (!COMMIT_PATTERN.test(sourceCommit)) throw new Error(`OMP ${version} tag has no valid commit SHA`);

	const archiveUrl = `https://github.com/${REPOSITORY}/archive/${sourceCommit}.tar.gz`;
	const archiveResponse = await requireOk(await fetchImpl(archiveUrl, { redirect: "follow" }), archiveUrl);
	const sourceSha256 = createHash("sha256").update(new Uint8Array(await archiveResponse.arrayBuffer())).digest("hex");
	return { sourceCommit, sourceSha256 };
}

async function fetchNativeSha512(packageName, version, fetchImpl) {
	const url = `https://registry.npmjs.org/${encodeURIComponent(`@oh-my-pi/${packageName}`)}/${version}`;
	const metadata = await fetchJson(url, fetchImpl);
	const integrity = /^sha512-([A-Za-z0-9+/]+={0,2})$/.exec(metadata.dist?.integrity ?? "");
	if (!integrity) throw new Error(`${packageName}@${version} has no valid SHA-512 registry integrity`);
	const digest = Buffer.from(integrity[1], "base64");
	if (digest.byteLength !== 64 || digest.toString("base64") !== integrity[1]) {
		throw new Error(`${packageName}@${version} has an invalid SHA-512 registry integrity`);
	}
	return digest.toString("hex");
}

export async function syncOmpPins({ root = process.cwd(), requestedVersion, fetchImpl = fetch, sdkLockUpdater = updateSdkLock } = {}) {
	const files = await Promise.all(CONTAINERFILES.map(async (relativePath) => {
		const path = join(root, relativePath);
		return { relativePath, path, source: await readFile(path, "utf8") };
	}));
	const pinnedVersion = readPinnedVersion(files[0].source, files[0].relativePath);
	const normalized = requestedVersion?.replace(/^v/, "") ?? pinnedVersion;
	if (!normalized || !VERSION_PATTERN.test(normalized)) throw new Error(`invalid requested OMP version: ${requestedVersion}`);

	const release = await fetchRelease(normalized, fetchImpl);
	const [sourcePins, nativesX86_64Sha512, nativesAarch64Sha512] = await Promise.all([
		fetchSourcePins(release.version, fetchImpl),
		fetchNativeSha512(NATIVE_PACKAGES[0], release.version, fetchImpl),
		fetchNativeSha512(NATIVE_PACKAGES[1], release.version, fetchImpl),
	]);
	const pins = {
		version: release.version,
		...sourcePins,
		nativesVersion: release.version,
		nativesX86_64Sha512,
		nativesAarch64Sha512,
	};
	const toolchains = JSON.parse(await readFile(join(root, "ci/toolchains.json"), "utf8"));
	const sdkLockNpmVersion = String(toolchains.verification?.sdkLockGeneratorNpm ?? "");
	if (!/^\d+\.\d+\.\d+$/.test(sdkLockNpmVersion)) throw new Error("ci/toolchains.json has no pinned SDK lock npm version");
	const sdkPackagePath = join(root, SDK_PACKAGE);
	const sdkLockPath = join(root, SDK_LOCK);
	const sdkPackage = JSON.parse(await readFile(sdkPackagePath, "utf8"));
	const originalSdkLock = await readFile(sdkLockPath, "utf8");
	const sdkVersion = sdkPackage.dependencies?.["@oh-my-pi/pi-coding-agent"];
	if (!VERSION_PATTERN.test(sdkVersion ?? "")) throw new Error(`${SDK_PACKAGE}: invalid OMP SDK version ${sdkVersion ?? "missing"}`);
	JSON.parse(originalSdkLock);
	const updatedSdkPackage = { ...sdkPackage, dependencies: { ...sdkPackage.dependencies, "@oh-my-pi/pi-coding-agent": pins.version } };
	const updatedSdkPackageText = `${JSON.stringify(updatedSdkPackage, null, 2)}\n`;
	// Regenerate even when the package manifest already has this pin: a previous
	// partial update may have left a stale lock that would otherwise be kept.
	const updatedSdkLock = await sdkLockUpdater({
		packageJson: updatedSdkPackageText,
		lockfile: originalSdkLock,
		version: pins.version,
		npmVersion: sdkLockNpmVersion,
	});
	const validatedSdkLock = JSON.parse(updatedSdkLock);
	if (validatedSdkLock.packages?.[""]?.dependencies?.["@oh-my-pi/pi-coding-agent"] !== pins.version ||
		validatedSdkLock.packages?.["node_modules/@oh-my-pi/pi-coding-agent"]?.version !== pins.version) {
		throw new Error(`${SDK_LOCK}: expected a lock for @oh-my-pi/pi-coding-agent@${pins.version}`);
	}

	// Write only after the source, native integrity, and refreshed SDK lock have
	// all validated, so a network/registry failure leaves the original pins intact.
	for (const { relativePath, path, source } of files) {
		const updated = updateContainerfile(source, pins, relativePath);
		if (updated !== source) await writeFile(path, updated);
	}
	if (updatedSdkPackageText !== `${JSON.stringify(sdkPackage, null, 2)}\n`) {
		await writeFile(sdkPackagePath, updatedSdkPackageText);
	}
	if (updatedSdkLock !== originalSdkLock) await writeFile(sdkLockPath, updatedSdkLock);
	return pins;
}

async function main() {
	const pins = await syncOmpPins({ requestedVersion: process.argv[2] });
	process.stdout.write(
		`OMP ${pins.version}: source ${pins.sourceCommit} sha256 ${pins.sourceSha256}; native SHA-512 x64 ${pins.nativesX86_64Sha512}, arm64 ${pins.nativesAarch64Sha512}\n`,
	);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	main().catch((error) => {
		process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
		process.exitCode = 1;
	});
}
