import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const REPOSITORY = "can1357/oh-my-pi";
const API = `https://api.github.com/repos/${REPOSITORY}`;
const CONTAINERFILES = ["image/appliance/Containerfile"];
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

export async function syncOmpPins({ root = process.cwd(), requestedVersion, fetchImpl = fetch } = {}) {
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
	for (const { relativePath, path, source } of files) {
		const updated = updateContainerfile(source, pins, relativePath);
		if (updated !== source) await writeFile(path, updated);
	}
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
