import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const REPOSITORY = "rtk-ai/rtk";
const CONTAINERFILE = "image/appliance/Containerfile";
const LICENSE_FILE = "image/extension/rtk/LICENSE";
const VERSION_PATTERN = /^\d+\.\d+\.\d+$/;
const DIGEST_PATTERN = /^sha256:([0-9a-f]{64})$/;
const HOOK_PATH = "hooks/pi/rtk.ts";
const LICENSE_PATH = "LICENSE";

function requireReleaseAsset(release, name) {
	const asset = release.assets?.find((candidate) => candidate.name === name);
	if (!asset) throw new Error(`RTK ${release.tag_name} has no ${name} asset`);
	const digest = DIGEST_PATTERN.exec(asset.digest ?? "");
	if (!digest) throw new Error(`RTK ${release.tag_name} ${name} has no valid SHA-256 digest`);
	return digest[1];
}

function validateHook(source) {
	if (!source.includes('pi.on("tool_call"')) throw new Error("RTK OMP hook has no tool_call subscription");
	if (!source.includes('pi.exec("rtk", ["rewrite", cmd]')) throw new Error("RTK OMP hook no longer delegates to rtk rewrite");
	if (!source.includes('process.env.RTK_DISABLED === "1"')) throw new Error("RTK OMP hook has no RTK_DISABLED bypass");
	return source;
}

function validateLicense(source) {
	if (!source.includes("Apache License") || !source.includes("Version 2.0, January 2004")) {
		throw new Error("RTK LICENSE must identify Apache License 2.0");
	}
	return source;
}

export function releasePins(release, hookSource, licenseSource, requestedVersion) {
	if (!release || release.draft === true || release.prerelease === true) {
		throw new Error("RTK release must be a published stable release");
	}
	const version = String(release.tag_name ?? "").replace(/^v/, "");
	if (!VERSION_PATTERN.test(version)) throw new Error(`invalid RTK release tag: ${release.tag_name ?? "missing"}`);
	if (requestedVersion && version !== requestedVersion) {
		throw new Error(`requested RTK ${requestedVersion}, received ${version}`);
	}
	validateHook(hookSource);
	validateLicense(licenseSource);
	return {
		version,
		x86_64: requireReleaseAsset(release, "rtk-x86_64-unknown-linux-musl.tar.gz"),
		aarch64: requireReleaseAsset(release, "rtk-aarch64-unknown-linux-gnu.tar.gz"),
		hook: createHash("sha256").update(hookSource).digest("hex"),
		license: createHash("sha256").update(licenseSource).digest("hex"),
	};
}

async function responseText(url, fetchImpl, headers) {
	const response = await fetchImpl(url, { headers, redirect: "error" });
	if (!response.ok) throw new Error(`RTK source lookup failed: ${response.status} ${response.statusText}`);
	return response.text();
}

async function fetchRelease(requestedVersion, fetchImpl) {
	const token = process.env.RENOVATE_TOKEN || process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
	const headers = {
		Accept: "application/vnd.github+json",
		"User-Agent": "joshyorko-review-rtk-sync",
		"X-GitHub-Api-Version": "2022-11-28",
	};
	if (token) headers.Authorization = `Bearer ${token}`;
	const response = await fetchImpl(`https://api.github.com/repos/${REPOSITORY}/releases/tags/v${requestedVersion}`, {
		headers,
		redirect: "error",
	});
	if (!response.ok) throw new Error(`GitHub RTK release lookup failed: ${response.status} ${response.statusText}`);
	return response.json();
}

export async function syncRtkPins({ root = process.cwd(), requestedVersion, fetchImpl = fetch } = {}) {
	const path = join(root, CONTAINERFILE);
	const licensePath = join(root, LICENSE_FILE);
	const source = await readFile(path, "utf8");
	const currentLicense = await readFile(licensePath, "utf8");
	const versionMatches = [...source.matchAll(/^ARG RTK_VERSION=(.*)$/gm)];
	if (versionMatches.length !== 1) throw new Error(`${CONTAINERFILE}: expected one ARG RTK_VERSION pin`);
	const currentVersion = versionMatches[0][1];
	if (!VERSION_PATTERN.test(currentVersion)) throw new Error(`${CONTAINERFILE}: invalid RTK version ${currentVersion}`);
	const version = requestedVersion?.replace(/^v/, "") ?? currentVersion;
	if (!VERSION_PATTERN.test(version)) throw new Error(`invalid requested RTK version: ${requestedVersion}`);
	const release = await fetchRelease(version, fetchImpl);
	const hookSource = await responseText(
		`https://raw.githubusercontent.com/${REPOSITORY}/v${version}/${HOOK_PATH}`,
		fetchImpl,
		{ "User-Agent": "joshyorko-review-rtk-sync" },
	);
	const licenseSource = await responseText(
		`https://raw.githubusercontent.com/${REPOSITORY}/v${version}/${LICENSE_PATH}`,
		fetchImpl,
		{ "User-Agent": "joshyorko-review-rtk-sync" },
	);
	const pins = releasePins(release, hookSource, licenseSource, version);
	const updated = updateContainerfile(source, pins, CONTAINERFILE);
	if (updated !== source) await writeFile(path, updated);
	if (currentLicense !== licenseSource) await writeFile(licensePath, licenseSource);
	return pins;
}

export function updateContainerfile(source, pins, path = "Containerfile") {
	let updated = replaceSingle(source, /^ARG RTK_VERSION=.*$/gm, `ARG RTK_VERSION=${pins.version}`, path);
	updated = replaceSingle(updated, /^ARG RTK_X86_64_SHA256=.*$/gm, `ARG RTK_X86_64_SHA256=${pins.x86_64}`, path);
	updated = replaceSingle(updated, /^ARG RTK_AARCH64_SHA256=.*$/gm, `ARG RTK_AARCH64_SHA256=${pins.aarch64}`, path);
	updated = replaceSingle(updated, /^ARG RTK_HOOK_SHA256=.*$/gm, `ARG RTK_HOOK_SHA256=${pins.hook}`, path);
	return replaceSingle(updated, /^ARG RTK_LICENSE_SHA256=.*$/gm, `ARG RTK_LICENSE_SHA256=${pins.license}`, path);
}

function replaceSingle(source, pattern, replacement, path) {
	const matches = source.match(pattern);
	if (matches?.length !== 1) throw new Error(`${path}: expected one ${replacement.split("=")[0]} pin`);
	return source.replace(pattern, replacement);
}

async function main() {
	const pins = await syncRtkPins({ requestedVersion: process.argv[2] });
	process.stdout.write(`RTK ${pins.version}: linux-x86_64 ${pins.x86_64}, linux-aarch64 ${pins.aarch64}, OMP hook ${pins.hook}, Apache-2.0 license ${pins.license}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	main().catch((error) => {
		process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
		process.exitCode = 1;
	});
}
