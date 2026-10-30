import { createHash } from "node:crypto";
import { access, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, posix } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const OMP_PATCH_DIRECTORY = "/usr/local/share/review/omp/";

function readArg(source, name, path) {
	const matches = [...source.matchAll(new RegExp(`^ARG ${name}=([^\\n]+)$`, "gm"))];
	if (matches.length !== 1) throw new Error(`${path}: expected one ARG ${name} pin`);
	return matches[0][1];
}

function replaceArg(source, name, value, path) {
	const pattern = new RegExp(`^ARG ${name}=.*$`, "gm");
	const matches = source.match(pattern);
	if (matches?.length !== 1) throw new Error(`${path}: expected one ARG ${name} pin`);
	return source.replace(pattern, `ARG ${name}=${value}`);
}

async function sha256(path) {
	return createHash("sha256").update(await readFile(path)).digest("hex");
}

async function pathExists(path) {
	try {
		await access(path);
		return true;
	} catch (error) {
		if (error?.code === "ENOENT") return false;
		throw error;
	}
}

function localPatchPath(root, source, name) {
	const containerPath = readArg(source, name, "image/appliance/Containerfile");
	if (!containerPath.startsWith(OMP_PATCH_DIRECTORY)) {
		throw new Error(`${name} must be staged from ${OMP_PATCH_DIRECTORY}`);
	}
	const filename = posix.basename(containerPath);
	if (!filename.endsWith(".patch") || filename === ".patch") throw new Error(`${name} must name a patch file`);
	return join(root, "patches/omp", filename);
}

function runDerivedBuild({ root, args, env }) {
	return spawnSync("bash", [join(root, "scripts/build-derived-omp.sh"), ...args], {
		cwd: root,
		env,
		stdio: "inherit",
	});
}

export async function qualifyOmpUpgrade({ root = process.cwd(), record = false, ifStale = false, memorydShim: requestedShim, runBuild = runDerivedBuild } = {}) {
	const containerfilePath = join(root, "image/appliance/Containerfile");
	const containerfile = await readFile(containerfilePath, "utf8");
	const value = name => readArg(containerfile, name, "image/appliance/Containerfile");
	const sourceCommit = value("OMP_SOURCE_COMMIT");
	const version = value("OMP_VERSION");
	const memorydShim = requestedShim ?? process.env.OMP_MEMORYD_SHIM ?? value("OMP_MEMORYD_SHIM");
	if (memorydShim !== "0" && memorydShim !== "1") throw new Error(`invalid OMP_MEMORYD_SHIM value: ${memorydShim} (expected 0 or 1)`);
	if (!/^\d+\.\d+\.\d+$/.test(version) || !/^[0-9a-f]{40}$/.test(sourceCommit)) {
		throw new Error("OMP source version or commit pin is invalid");
	}

	const memoryPath = join(root, "patches/omp/memory-backend-registration.patch");
	const paths = [
		...(memorydShim === "1" ? [memoryPath] : []),
		localPatchPath(root, containerfile, "OMP_CLIPBOARD_PATCH_PATH"),
		localPatchPath(root, containerfile, "OMP_SESSION_LIFECYCLE_PATCH_PATH"),
	];
	const hashes = await Promise.all(paths.map(sha256));
	const pins = {
		version,
		sourceCommit,
		memorydShim,
		...(memorydShim === "1" ? { memorySha256: hashes[0] } : {}),
		clipboardSha256: hashes[memorydShim === "1" ? 1 : 0],
		sessionLifecycleSha256: hashes[memorydShim === "1" ? 2 : 1],
	};
	// Patch pins alone do not prove that OMP_VERSION still resolves to OMP_SOURCE_COMMIT.
	// Until a source-tag-bound receipt exists, --if-stale always reruns qualification.

	const outputRoot = await mkdtemp(join(tmpdir(), "review-omp-qualification-"));
	const outputPath = join(outputRoot, "must-not-install-omp");
	const env = {
		...process.env,
		OMP_VERSION: version,
		OMP_SOURCE_COMMIT: sourceCommit,
		OMP_SOURCE_SHA256: value("OMP_SOURCE_SHA256"),
		...(memorydShim === "1" ? { OMP_PATCH_SHA256: pins.memorySha256 } : {}),
		OMP_CLIPBOARD_PATCH_SOURCE_COMMIT: value("OMP_CLIPBOARD_PATCH_SOURCE_COMMIT"),
		OMP_SESSION_LIFECYCLE_PATCH_SOURCE_COMMIT: value("OMP_SESSION_LIFECYCLE_PATCH_SOURCE_COMMIT"),
		OMP_CLIPBOARD_PATCH_SHA256: pins.clipboardSha256,
		OMP_SESSION_LIFECYCLE_PATCH_SHA256: pins.sessionLifecycleSha256,
		OMP_CLIPBOARD_PATCH_PATH: paths[memorydShim === "1" ? 1 : 0],
		OMP_SESSION_LIFECYCLE_PATCH_PATH: paths[memorydShim === "1" ? 2 : 1],
		OMP_BUN_VERSION: value("OMP_BUN_VERSION"),
		OMP_BUN_X86_64_SHA256: value("OMP_BUN_X86_64_SHA256"),
		OMP_BUN_AARCH64_SHA256: value("OMP_BUN_AARCH64_SHA256"),
		OMP_NATIVES_VERSION: value("OMP_NATIVES_VERSION"),
		OMP_NATIVES_X86_64_SHA512: value("OMP_NATIVES_X86_64_SHA512"),
		OMP_NATIVES_AARCH64_SHA512: value("OMP_NATIVES_AARCH64_SHA512"),
		OMP_MEMORYD_SHIM: memorydShim,
		...(memorydShim === "1" ? {
			MEMORYD_SOURCE_COMMIT: value("MEMORYD_SOURCE_COMMIT"),
			MEMORYD_SOURCE_SHA256: value("MEMORYD_SOURCE_SHA256"),
			OMP_PATCH_PATH: memoryPath,
		} : {}),
		OMP_OUTPUT_PATH: outputPath,
	};

	try {
		const result = await runBuild({ root, args: ["--qualify-only"], env });
		if (result?.error || result?.status !== 0) {
			throw new Error(`exact-source OMP patch qualification failed${result?.status == null ? "" : ` (exit ${result.status})`}`);
		}
		if (await pathExists(outputPath)) throw new Error("qualification-only build installed an OMP binary");
		const [currentContainerfile, currentHashes] = await Promise.all([
			readFile(containerfilePath, "utf8"),
			Promise.all(paths.map(sha256)),
		]);
		if (currentContainerfile !== containerfile || currentHashes.some((hash, index) => hash !== hashes[index])) {
			throw new Error("OMP qualification inputs changed during the build; rerun qualification");
		}
		if (record) {
			let updated = replaceArg(containerfile, "OMP_CLIPBOARD_PATCH_SHA256", pins.clipboardSha256, containerfilePath);
			updated = replaceArg(updated, "OMP_SESSION_LIFECYCLE_PATCH_SHA256", pins.sessionLifecycleSha256, containerfilePath);
			updated = replaceArg(updated, "OMP_CLIPBOARD_PATCH_SOURCE_COMMIT", pins.sourceCommit, containerfilePath);
			updated = replaceArg(updated, "OMP_SESSION_LIFECYCLE_PATCH_SOURCE_COMMIT", pins.sourceCommit, containerfilePath);
			if (memorydShim === "1") updated = replaceArg(updated, "OMP_PATCH_SHA256", pins.memorySha256, containerfilePath);
			const temporaryRoot = await mkdtemp(join(dirname(containerfilePath), ".omp-qualification-"));
			try {
				const temporaryPath = join(temporaryRoot, "Containerfile");
				await writeFile(temporaryPath, updated);
				await rename(temporaryPath, containerfilePath);
			} finally {
				await rm(temporaryRoot, { recursive: true, force: true });
			}
		}
		return { ...pins, recorded: record, skipped: false };
	} finally {
		await rm(outputRoot, { recursive: true, force: true });
	}
}

async function main() {
	const args = process.argv.slice(2);
	if (args.some(arg => arg !== "--record" && arg !== "--if-stale") || new Set(args).size !== args.length) {
		throw new Error("usage: node scripts/qualify-omp-upgrade.mjs [--if-stale] [--record]");
	}
	const result = await qualifyOmpUpgrade({
		root: dirname(dirname(fileURLToPath(import.meta.url))),
		record: args.includes("--record"),
		ifStale: args.includes("--if-stale"),
	});
	process.stdout.write(
		`OMP ${result.version} patch qualification passed for ${result.sourceCommit}: memoryd-shim=${result.memorydShim}, ${result.memorydShim === "1" ? `memory=${result.memorySha256}, ` : ""}clipboard=${result.clipboardSha256}, session-lifecycle=${result.sessionLifecycleSha256}${result.recorded ? "; provenance recorded" : ""}\n`,
	);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	main().catch(error => {
		process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
		process.exitCode = 1;
	});
}
