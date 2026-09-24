import { registerHooks } from "node:module";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { join } from "node:path";

/** Run upstream's unmodified manager. Only its logging dependency is replaced. */
export async function loadPackagedJobManager(root: string) {
	const revision = execFileSync("git", ["-C", root, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
	if (revision !== "62bc57be1b03ef0802a33cf7f5f530e534527531") throw new Error(`Expected packaged OMP 18.3.0, found ${revision}`);
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
