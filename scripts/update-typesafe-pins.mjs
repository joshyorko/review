import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const CONTAINERFILE = "image/appliance/Containerfile";
const VERSION_PATTERN = /^\d+\.\d+\.\d+$/;

export const TYPESAFE_PACKAGES = [
	{
		depName: "pi-typesafe",
		versionArg: "TYPESAFE_VERSION",
		shaArg: "TYPESAFE_SHA256",
		tarball: (version) => `https://registry.npmjs.org/pi-typesafe/-/pi-typesafe-${version}.tgz`,
	},
	{
		depName: "@typesafe-ai/sdk",
		versionArg: "TYPESAFE_SDK_VERSION",
		shaArg: "TYPESAFE_SDK_SHA256",
		tarball: (version) => `https://registry.npmjs.org/@typesafe-ai/sdk/-/sdk-${version}.tgz`,
	},
	{
		depName: "typebox",
		versionArg: "TYPESAFE_TYPEBOX_VERSION",
		shaArg: "TYPESAFE_TYPEBOX_SHA256",
		tarball: (version) => `https://registry.npmjs.org/typebox/-/typebox-${version}.tgz`,
	},
];

function readArg(source, name, path) {
	const matches = [...source.matchAll(new RegExp(`^ARG ${name}=([^\\s]+)$`, "gm"))];
	if (matches.length !== 1) throw new Error(`${path}: expected one ARG ${name} pin`);
	return matches[0][1];
}

function replaceArg(source, name, value, path) {
	const pattern = new RegExp(`^ARG ${name}=.*$`, "gm");
	const matches = source.match(pattern);
	if (matches?.length !== 1) throw new Error(`${path}: expected one ARG ${name} pin`);
	return source.replace(pattern, `ARG ${name}=${value}`);
}

export async function fetchTarballSha256(spec, version, fetchImpl = fetch) {
	if (!VERSION_PATTERN.test(version)) throw new Error(`invalid ${spec.depName} version: ${version}`);
	const url = spec.tarball(version);
	const response = await fetchImpl(url, { redirect: "error" });
	if (!response.ok) {
		throw new Error(`npm tarball lookup failed for ${spec.depName}@${version}: ${response.status} ${response.statusText}`);
	}
	const bytes = Buffer.from(await response.arrayBuffer());
	if (bytes.length === 0) throw new Error(`npm tarball for ${spec.depName}@${version} was empty`);
	return { url, sha256: createHash("sha256").update(bytes).digest("hex") };
}

export async function syncTypesafePins({ root = process.cwd(), fetchImpl = fetch } = {}) {
	const path = join(root, CONTAINERFILE);
	const source = await readFile(path, "utf8");
	let updated = source;
	const pins = {};

	for (const spec of TYPESAFE_PACKAGES) {
		const version = readArg(source, spec.versionArg, CONTAINERFILE);
		if (!VERSION_PATTERN.test(version)) throw new Error(`invalid ${spec.depName} version: ${version}`);
		const { url, sha256 } = await fetchTarballSha256(spec, version, fetchImpl);
		updated = replaceArg(updated, spec.shaArg, sha256, CONTAINERFILE);
		pins[spec.depName] = { version, url, sha256 };
	}

	if (updated !== source) await writeFile(path, updated);
	return pins;
}

async function main() {
	const pins = await syncTypesafePins();
	for (const [depName, pin] of Object.entries(pins)) {
		process.stdout.write(`${depName}@${pin.version}: ${pin.sha256}\n`);
	}
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	main().catch((error) => {
		process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
		process.exitCode = 1;
	});
}
