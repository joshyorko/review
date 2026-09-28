import { registerHooks } from "node:module";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { join } from "node:path";

/** Run upstream's unmodified manager. Only its logging dependency is replaced. */
export async function loadPackagedJobManager(root: string) {
	const appliance = readFileSync(new URL("../image/appliance/Containerfile", import.meta.url), "utf8");
	const expectedVersion = appliance.match(/^ARG OMP_VERSION=(\S+)$/m)?.[1];
	if (!expectedVersion) throw new Error("Could not read the packaged OMP version from the appliance Containerfile");
	const packageJson = JSON.parse(readFileSync(join(root, "packages/coding-agent/package.json"), "utf8"));
	if (packageJson.version !== expectedVersion) throw new Error(`Expected packaged OMP ${expectedVersion}, found ${packageJson.version}`);
	const tag = execFileSync("git", ["-C", root, "describe", "--tags", "--exact-match", "HEAD"], { encoding: "utf8" }).trim();
	if (tag !== `v${expectedVersion}`) throw new Error(`Expected packaged OMP tag v${expectedVersion}, found ${tag}`);
	execFileSync("git", ["-C", root, "diff", "--exit-code", "HEAD", "--", "packages/coding-agent/src/async/job-manager.ts"]);
	const hooks = registerHooks({
		resolve(specifier, context, next) {
			if (specifier === "@oh-my-pi/pi-utils" && context.parentURL?.endsWith("/async/job-manager.ts")) {
				return { url: "data:text/javascript,export const logger = { warn: console.warn, error: console.error };", shortCircuit: true };
			}
			return next(specifier, context);
		},
	});
	try { return (await import(pathToFileURL(join(root, "packages/coding-agent/src/async/job-manager.ts")).href)).AsyncJobManager; }
	finally { hooks.deregister(); }
}
