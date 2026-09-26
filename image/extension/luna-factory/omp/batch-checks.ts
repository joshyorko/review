import { existsSync, lstatSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { SelectedItem } from "../core/batch.ts";

/** Capture required checks from the selected contract or a small known repository convention.
 * No repository executable is loaded here, and workers cannot replace this list. */
export function requiredChecks(item: SelectedItem, workspace: string): string[] {
 if (item.action === "inspect") return [];
 if (item.requiredChecks) return [...item.requiredChecks];
 const regular = (name: string): boolean => { const path=join(workspace,name);if(!existsSync(path))return false;const s=lstatSync(path);if(!s.isFile()||s.nlink!==1||s.size>131072)throw new Error(`task readiness: unsafe or oversized ${name}; explicit checks required`);return true; };
 if (regular("go.mod")) {
  if (!existsSync(join(workspace,"vendor")) && /\brequire\b/.test(readFileSync(join(workspace,"go.mod"),"utf8"))) throw new Error("task readiness: Go dependencies are not prepared in vendor; the verifier has no network or host module cache");
  return ["go test ./..."];
 }
 if (regular("package.json")) {
  const manifest: unknown=JSON.parse(readFileSync(join(workspace,"package.json"),"utf8"));
  if (!manifest || typeof manifest!=="object") throw new Error("task readiness: invalid package.json");
  const p=manifest as {scripts?:{test?:unknown}; dependencies?:object; devDependencies?:object};
  if (Object.keys(p.dependencies??{}).length || Object.keys(p.devDependencies??{}).length) {
   if(!existsSync(join(workspace,"node_modules")))throw new Error("task readiness: JavaScript dependencies are not prepared; the verifier has no network or host packages");
  }
  if(typeof p.scripts?.test==="string" && p.scripts.test.trim())return ["npm test"];
 }
 const tests=join(workspace,"tests");
 if(existsSync(tests)&&lstatSync(tests).isDirectory()&&!lstatSync(tests).isSymbolicLink()&&readdirSync(tests).some(name=>/^test.*\.py$/.test(name)))return ["python3 -m unittest discover -s tests"];
 throw new Error("task readiness: no mandatory verification command is captured; submit an explicit requiredChecks list or prepare a supported repository test command");
}

/** Bind npm's indirection to the scripts captured before implementation. */
export function packageCheckScripts(workspace: string): string {
 const path = join(workspace, "package.json");
 const stat = lstatSync(path);
 if (!stat.isFile() || stat.nlink !== 1 || stat.size > 131072) throw new Error("task readiness: package.json is not a bounded regular file");
 const value: unknown = JSON.parse(readFileSync(path, "utf8"));
 if (!value || typeof value !== "object" || !("scripts" in value) || !value.scripts || typeof value.scripts !== "object" || Array.isArray(value.scripts)) throw new Error("task readiness: package test scripts unavailable");
 return JSON.stringify(Object.fromEntries(Object.entries(value.scripts).sort(([a], [b]) => a.localeCompare(b))));
}
