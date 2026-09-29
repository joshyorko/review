import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";

type Event = Record<string, unknown>;

type RunResult = {
  exitCode: number | null;
  stdout: string;
  stderr: string;
};

const [binary, adapterIndex, canaryRootArg] = Bun.argv.slice(2);
if (!binary || !adapterIndex || !canaryRootArg) {
  throw new Error("usage: bun derived-omp-canary.ts <omp-binary> <adapter-index.ts> <workdir>");
}

const canaryRoot = resolve(canaryRootArg);
const home = resolve(canaryRoot, "home");
const profile = "derived-omp-canary";
const cwd = resolve(canaryRoot, "cwd");
const agentDir = resolve(home, ".omp", "profiles", profile, "agent");
const configPath = resolve(canaryRoot, "config.yml");
const extensionPath = resolve(canaryRoot, "memoryd-extension.ts");
const memoryMarker = "MEMORYD_DERIVED_BUILD_CANARY_7f3a";
const prompt = "Use the synthetic recalled token to answer this first-turn canary.";
const workspace = "derived-omp-ci-canary";
const memoryProfile = "personal";

await mkdir(agentDir, { recursive: true });
await mkdir(cwd, { recursive: true });

const memoryEvents: Event[] = [];
const providerEvents: Event[] = [];
let memoryServer: ReturnType<typeof Bun.serve>;
let memoryServerRunning = true;

memoryServer = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(request) {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/healthz") return new Response("ok");
    if (request.method === "GET" && url.pathname === "/v1/status") {
      return Response.json({
        ok: true,
        data: {
          status: "local_only",
          storage: { writable: true },
          features: { recall: true, search: true },
        },
      });
    }
    if (request.method === "POST" && url.pathname === "/v1/recall") {
      const body = (await request.json()) as Record<string, unknown>;
      const metadata = body.metadata as Record<string, unknown> | undefined;
      memoryEvents.push({
        kind: "memory-recall",
        query: body.query,
        profile: body.profile,
        workspace: body.workspace,
        packMode: body.pack_mode,
        sourceKind: metadata?.source_kind,
      });
      return Response.json({
        ok: true,
        data: {
          authority: "recall_not_authority",
          facts: [{ id: "synthetic-canary", content: `Synthetic token: ${memoryMarker}`, stale: false }],
          checkpoints: [],
          withheld: [],
        },
      });
    }
    return new Response("not found", { status: 404 });
  },
});

const modelServer = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(request) {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname.endsWith("/models")) {
      return Response.json({
        object: "list",
        data: [{ id: "boundary", object: "model", created: 1, owned_by: "canary" }],
      });
    }
    if (request.method === "POST" && url.pathname.endsWith("/chat/completions")) {
      const body = (await request.json()) as Record<string, unknown>;
      const hasRecallMarker = JSON.stringify(body).includes(memoryMarker);
      const recallCountAtBoundary = memoryEvents.length;
      const response = hasRecallMarker ? "MEMORYD_RECALL_PRESENT_OK" : "MEMORYD_NO_RECALL_FAIL_OPEN_OK";
      providerEvents.push({ kind: "provider-boundary", hasRecallMarker, recallCountAtBoundary, response });
      if (body.stream === false) {
        return Response.json({
          id: "derived-omp-canary",
          object: "chat.completion",
          created: 1,
          model: body.model,
          choices: [{ index: 0, message: { role: "assistant", content: response }, finish_reason: "stop" }],
        });
      }
      const chunks = [
        { id: "derived-omp-canary", object: "chat.completion.chunk", created: 1, model: body.model, choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }] },
        { id: "derived-omp-canary", object: "chat.completion.chunk", created: 1, model: body.model, choices: [{ index: 0, delta: { content: response }, finish_reason: null }] },
        { id: "derived-omp-canary", object: "chat.completion.chunk", created: 1, model: body.model, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
      ];
      const sse = chunks.map(chunk => `data: ${JSON.stringify(chunk)}\n\n`).join("") + "data: [DONE]\n\n";
      return new Response(sse, { headers: { "content-type": "text/event-stream", "cache-control": "no-cache" } });
    }
    return new Response("not found", { status: 404 });
  },
});

const modelsPath = resolve(agentDir, "models.yml");
await Bun.write(
  modelsPath,
  `providers:\n  canary:\n    baseUrl: http://127.0.0.1:${modelServer.port}/v1\n    api: openai-completions\n    auth: none\n    models:\n      - id: boundary\n        name: Derived OMP Provider Boundary Canary\n        reasoning: false\n        input: [text]\n        cost:\n          input: 0\n          output: 0\n          cacheRead: 0\n          cacheWrite: 0\n        contextWindow: 8192\n        maxTokens: 256\n`,
);
await Bun.write(
  configPath,
  `memory:\n  backend: codex-memoryd\n  backendSettings:\n    codex-memoryd:\n      codexMemoryd.baseUrl: http://127.0.0.1:${memoryServer.port}\n      codexMemoryd.profile: ${memoryProfile}\n      codexMemoryd.workspace: ${workspace}\n      codexMemoryd.autoRecall: true\n      codexMemoryd.autoObserve: false\n`,
);
await Bun.write(
  extensionPath,
  `import { registerMemoryD } from ${JSON.stringify(adapterIndex)};\n\nexport default function (api: Parameters<typeof registerMemoryD>[0]) {\n  registerMemoryD(api);\n}\n`,
);

async function runCandidate(message: string): Promise<RunResult> {
  const child = Bun.spawn({
    cmd: [
      binary,
      "--profile",
      profile,
      "--model",
      "canary/boundary",
      "--config",
      configPath,
      "--extension",
      extensionPath,
      "--no-session",
      "--no-tools",
      "--no-skills",
      "--no-rules",
      "--no-lsp",
      "--print",
      message,
    ],
    cwd,
    env: {
      HOME: home,
      OMP_PROFILE: profile,
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      TMPDIR: canaryRoot,
    },
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
  return { exitCode, stdout, stderr };
}

try {
  const recallRun = await runCandidate(prompt);
  const recallEvent = memoryEvents[0];
  const recallBoundary = providerEvents[0];
  if (
    recallRun.exitCode !== 0 ||
    recallRun.stdout.trim() !== "MEMORYD_RECALL_PRESENT_OK" ||
    memoryEvents.length !== 1 ||
    recallEvent?.profile !== memoryProfile ||
    recallEvent?.workspace !== workspace ||
    recallEvent?.sourceKind !== "omp_native_recall" ||
    recallBoundary?.hasRecallMarker !== true ||
    recallBoundary?.recallCountAtBoundary !== 1
  ) {
    throw new Error(`first-turn MemoryD canary failed: ${JSON.stringify({ recallRun, memoryEvents, providerEvents })}`);
  }

  memoryServer.stop(true);
  memoryServerRunning = false;
  const outageRun = await runCandidate("MemoryD is stopped. Continue without recalled context.");
  const outageBoundary = providerEvents[1];
  if (
    outageRun.exitCode !== 0 ||
    outageRun.stdout.trim() !== "MEMORYD_NO_RECALL_FAIL_OPEN_OK" ||
    providerEvents.length !== 2 ||
    outageBoundary?.hasRecallMarker !== false
  ) {
    throw new Error(`daemon-down fail-open canary failed: ${JSON.stringify({ outageRun, memoryEvents, providerEvents })}`);
  }

  console.log("Derived OMP provider-boundary canary: recall and daemon-down fail-open passed");
} finally {
  if (memoryServerRunning) memoryServer.stop(true);
  modelServer.stop(true);
}
