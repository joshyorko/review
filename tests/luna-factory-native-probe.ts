#!/usr/bin/env bun
import { mkdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";

const [binary, extension, config, state] = Bun.argv.slice(2);
if (!binary || !extension || !config || !state) {
  console.error(JSON.stringify({ status: "failed", reason: "usage: probe <omp> <extension> <config> <state>" }));
  process.exit(2);
}
await mkdir(state, { recursive: true });
const child = Bun.spawn([binary, "--mode", "rpc-ui", "--no-skills", "--no-rules", "--no-pty", "--config", config, "--extension", extension], {
  stdin: "pipe", stdout: "pipe", stderr: "pipe",
  env: { HOME: process.env.HOME!, XDG_STATE_HOME: process.env.XDG_STATE_HOME!, XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME!, LUNA_FACTORY_ENABLED: "1" },
});
const request = { type: "prompt", message: "/factory status" };
child.stdin.write(JSON.stringify(request) + "\n");
child.stdin.end();
const output = await new Response(child.stdout).text();
const errors = await new Response(child.stderr).text();
const status = await child.exited;
await Bun.write(join(state, "native-terminal.jsonl"), output + errors);
const journal = await (async () => {
  try { return await readFile(state, "utf8"); } catch { return ""; }
})();
const evidence = /factory|status|BLOCKED|unavailable|no run/i.test(output + errors) && (output + errors).trim().length > 0;
const persisted = journal.length > 0;
const result = { status: status === 0 && evidence ? "passed" : "failed", exit: status, terminalEvidence: evidence, stateEvidence: persisted, bytes: (output + errors).length };
console.log(JSON.stringify(result));
if (result.status !== "passed") process.exit(1);
