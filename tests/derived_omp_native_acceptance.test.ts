import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";

const image = process.env.REVIEW_DERIVED_OMP_CANARY_IMAGE;
const adapter = process.env.REVIEW_MEMORYD_TEST_SOURCE;

test("derived OMP build canary proves native status, search, and explicit save", {
  skip: !image || !adapter,
  timeout: 120_000,
}, async () => {
  assert.ok(image);
  assert.ok(adapter);
  const run = await mkdtemp(resolve(tmpdir(), "derived-omp-native-"));
  try {
    const result = spawnSync("podman", [
      "run", "--rm", "--network=none", "--userns=keep-id:uid=65532,gid=65532",
      "--volume", `${resolve("scripts")}:/canary-source:ro,Z`,
      "--volume", `${resolve(adapter)}:/adapter-source:ro,Z`,
      "--volume", `${run}:/canary-run:rw,Z`,
      "--entrypoint", "/usr/bin/bun", image,
      "/canary-source/derived-omp-canary.ts", "/usr/bin/omp",
      "/adapter-source/index.ts", "/canary-run",
    ], { encoding: "utf8", timeout: 100_000 });
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    const receiptPath = resolve(run, "native-operations.json");
    assert.ok(existsSync(receiptPath), "build canary did not exercise native status/search/save");
    const receipt: unknown = JSON.parse(await readFile(receiptPath, "utf8"));
    assert.partialDeepStrictEqual(receipt, {
      status: { backend: "codex-memoryd", active: true, writable: true, searchable: true },
      search: {
        backend: "codex-memoryd", query: "synthetic native search", count: 1,
        items: [{ content: "synthetic native search match" }],
      },
      save: { backend: "codex-memoryd", stored: 1, ids: ["synthetic-native-save"] },
    });
  } finally {
    await rm(run, { recursive: true, force: true });
  }
});
