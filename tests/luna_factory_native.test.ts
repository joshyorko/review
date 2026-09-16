import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runNative, sandboxTest } from "../image/extension/luna-factory/omp/batch-native.ts";

const schema = { object: (x: unknown) => x, string: () => ({}), array: (x: unknown) => x, boolean: () => ({}) } as any;
function item(workspace: string, action = "patch") { return { workspace, selected: { key: "r/1", action, acceptance: "inspect" }, sessions: [] } as any; }
function fake(workspace: string, invoke: (tools: any[]) => Promise<void>) {
  let disposed = false;
  const session: any = { sessionFile: "native.log", subscribe: () => () => {}, abort: async () => {}, dispose: async () => { disposed = true; }, prompt: async () => {} };
  const sdk: any = { Settings: { isolated: (x: unknown) => x }, SessionManager: { create: () => ({}) }, AgentRegistry: class {}, createAgentSession: async (options: any) => { await invoke(options.customTools); return { session }; } };
  return { sdk, get disposed() { return disposed; } };
}

test("native file tools reject traversal, URI, symlink, and hardlink paths", async () => {
  const root = await mkdtemp(join(tmpdir(), "factory-native-"));
  await mkdir(join(root, "src")); await writeFile(join(root, "src", "x"), "x");
  await symlink("/tmp", join(root, "escape"));
  const outside = join(root, "outside"); await writeFile(outside, "outside"); await require("node:fs/promises").link(outside, join(root, "hard"));
  let tools: any[] = [];
  const sdk = fake(root, async (registered) => { tools = registered; });
  const controller = new AbortController();
  const promise = runNative(sdk.sdk, schema, { model: {}, modelRegistry: { authStorage: {} } }, item(root), root, "worker", controller.signal, () => {});
  await promise.catch(() => {});
  const read = tools.find((x) => x.name === "factory_read");
  for (const path of ["../outside", "/etc/passwd", "file:///etc/passwd", "escape/x", "hard"]) await assert.rejects(() => read.execute("id", { path }));
  assert.equal(sdk.disposed, true);
});

test("sandbox refuses symlinked verification workspace before invoking bwrap", async () => {
  const root = await mkdtemp(join(tmpdir(), "factory-native-"));
  await symlink("/tmp", join(root, "link"));
  await assert.rejects(() => sandboxTest(root, "true", new AbortController().signal), /unsafe verification workspace/);
});
