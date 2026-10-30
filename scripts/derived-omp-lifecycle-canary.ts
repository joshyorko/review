import { mkdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";

const [binary, canaryRootArg] = Bun.argv.slice(2);
if (!binary || !canaryRootArg) {
  throw new Error("usage: bun derived-omp-lifecycle-canary.ts <omp-binary> <workdir>");
}

const root = resolve(canaryRootArg);
const home = resolve(root, "home");
const profile = "derived-omp-lifecycle-canary";
const agentDir = resolve(home, ".omp", "profiles", profile, "agent");
const cwd = resolve(root, "cwd");
const configPath = resolve(root, "config.yml");
const extensionPath = resolve(root, "lifecycle-extension.ts");
const settledPath = resolve(root, "shutdown-settled.json");
await mkdir(agentDir, { recursive: true });
await mkdir(cwd, { recursive: true });

const modelServer = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(request) {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname.endsWith("/models")) return Response.json({ object: "list", data: [{ id: "boundary", object: "model", created: 1, owned_by: "canary" }] });
    if (request.method === "POST" && url.pathname.endsWith("/chat/completions")) {
      const body = await request.json() as Record<string, unknown>;
      const response = {
        id: "derived-omp-lifecycle-canary",
        object: "chat.completion",
        created: 1,
        model: body.model,
        choices: [{ index: 0, message: { role: "assistant", content: "LIFECYCLE_CANARY_OK" }, finish_reason: "stop" }],
      };
      if (body.stream === false) return Response.json(response);
      const chunks = [
        { id: response.id, object: "chat.completion.chunk", created: 1, model: response.model, choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }] },
        { id: response.id, object: "chat.completion.chunk", created: 1, model: response.model, choices: [{ index: 0, delta: { content: "LIFECYCLE_CANARY_OK" }, finish_reason: null }] },
        { id: response.id, object: "chat.completion.chunk", created: 1, model: response.model, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
      ];
      const sse = chunks.map(chunk => `data: ${JSON.stringify(chunk)}\n\n`).join("") + "data: [DONE]\n\n";
      return new Response(sse, { headers: { "content-type": "text/event-stream", "cache-control": "no-cache" } });
    }
    return new Response("not found", { status: 404 });
  },
});

try {
  await Bun.write(resolve(agentDir, "models.yml"),
    `providers:\n  canary:\n    baseUrl: http://127.0.0.1:${modelServer.port}/v1\n    api: openai-completions\n    auth: none\n    models:\n      - id: boundary\n        name: Lifecycle Canary\n        reasoning: false\n        input: [text]\n        cost:\n          input: 0\n          output: 0\n          cacheRead: 0\n          cacheWrite: 0\n        contextWindow: 8192\n        maxTokens: 128\n`);
  await Bun.write(configPath, "{}");
  await Bun.write(extensionPath,
    `import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";\n` +
    `export default function (api: ExtensionAPI) {\n` +
    `  if (api.sessionShutdownLifecycleVersion !== 1) throw new Error("native session shutdown lifecycle v1 is unavailable");\n` +
    `  api.on("session_shutdown_settled", async event => { await Bun.write(${JSON.stringify(settledPath)}, JSON.stringify(event)); });\n` +
    `}\n`);

  const child = Bun.spawn({
    cmd: [binary, "--profile", profile, "--model", "canary/boundary", "--config", configPath,
      "--extension", extensionPath, "--no-tools", "--no-skills", "--no-rules", "--no-lsp", "--print", "lifecycle canary"],
    cwd,
    env: { HOME: home, OMP_PROFILE: profile, PATH: process.env.PATH ?? "/usr/bin:/bin", TMPDIR: root },
    stdout: "pipe",
    stderr: "pipe",
  });
  const timeout = setTimeout(() => child.kill(), 60_000);
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  clearTimeout(timeout);
  if (exitCode !== 0 || stdout.trim() !== "LIFECYCLE_CANARY_OK") {
    throw new Error(`lifecycle candidate run failed: ${JSON.stringify({ exitCode, stdout, stderr })}`);
  }
  let settled: Record<string, unknown>;
  try {
    settled = JSON.parse(await readFile(settledPath, "utf8")) as Record<string, unknown>;
  } catch (error) {
    throw new Error(`compiled candidate did not emit session_shutdown_settled: ${String(error)}`);
  }
  if (settled.type !== "session_shutdown_settled" || typeof settled.sessionId !== "string" || settled.settled !== true) {
    throw new Error(`compiled candidate emitted invalid shutdown settlement evidence: ${JSON.stringify(settled)}`);
  }
  console.log("Derived OMP native session shutdown lifecycle capability v1: passed");
} finally {
  modelServer.stop(true);
}
