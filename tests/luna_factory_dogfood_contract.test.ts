/** Contract coverage for the finite, no-publish Factory dogfood path. */
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import test from "node:test";
import { join } from "node:path";

const root = join(import.meta.dirname, "..");
const read = (name: string) => readFileSync(join(root, name), "utf8");

test("dogfood workflow is exact-head and cannot publish", () => {
  const workflow = read(".github/workflows/luna-factory-dogfood.yml");
  assert.match(workflow, /pull_request:/);
  assert.match(workflow, /github\.event\.pull_request\.head\.sha/);
  assert.match(workflow, /ubuntu-24\.04/);
  assert.match(workflow, /tests\/luna-factory-dogfood\.sh/);
  assert.match(workflow, /tests\/appliance-runtime-probe\.sh/);
  assert.match(workflow, /scripts\/brew-dev/);
  assert.match(workflow, /actions\/upload-artifact/);
  assert.match(workflow, /podman build --format oci/);
  assert.match(workflow, /tests\/appliance-contract\.sh --image/);
  for (const forbidden of ["podman push", "ghcr.io", "secrets.", "gh auth", "release create", "BLUEFIN_REVIEW_OCI_PUSH"]) {
    assert.doesNotMatch(workflow, new RegExp(forbidden.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), forbidden);
  }
});

test("OCI harness uses clean state and deterministic local transport", () => {
  const harness = read("tests/luna-factory-dogfood.sh");
  for (const marker of ["--network host", "127.0.0.1", "LUNA_FACTORY_ENABLED", "HOME", "XDG_STATE_HOME", "luna-factory-omp-probe-server.mjs", "luna-factory-omp-probe-config.yml", "luna-factory-omp-probe-models.yml"]) assert.match(harness, new RegExp(marker.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), marker);
  assert.doesNotMatch(harness, /--no-session/);
});

test("SIF path reports capability blocks instead of claiming krun", () => {
  const harness = read("tests/luna-factory-dogfood.sh");
  for (const marker of ["BLUEFIN_REVIEW_FALLBACK_SIF", "bin/bluefin", "krun", "blocked-by-runner-capability"]) assert.match(harness, new RegExp(marker), marker);
  assert.doesNotMatch(harness, /scripts\/brew-dev/);
});

test("runtime report helper emits separate honest probe outcomes", () => {
  const helper = join(root, "tests/appliance-runtime-report.ts");
  assert.ok(existsSync(helper));
  const output = execFileSync(process.env.BUN ?? "bun", [helper, "--self-test"], { encoding: "utf8" });
  const report = JSON.parse(output);
  assert.equal(report.schema, 2);
  assert.ok(report.boundaries.oci && report.boundaries.sifFuse && report.boundaries.krunKvm);
  assert.equal(report.boundaries.krunKvm.status, "blocked");
});

test("runtime probe invokes the TypeScript report, not embedded Python", () => {
  const probe = read("tests/appliance-runtime-probe.sh");
  assert.match(probe, /appliance-runtime-report\.ts/);
  assert.doesNotMatch(probe, /python3 .*<<['"]PY/);
});
