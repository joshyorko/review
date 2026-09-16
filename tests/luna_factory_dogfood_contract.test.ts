/** Behavioral contracts for the finite, no-publish Factory dogfood path. */
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import test from "node:test";
import { join } from "node:path";
import { reportCapabilities } from "./appliance-runtime-report.ts";
const root = join(import.meta.dirname, "..");
const read = (name: string) => readFileSync(join(root, name), "utf8");

test("workflow uses exact head, pinned setup and no publishing", () => {
  const workflow = read(".github/workflows/luna-factory-dogfood.yml");
  assert.match(workflow, /github\.event\.pull_request\.head\.sha/);
  assert.match(workflow, /oven-sh\/setup-bun@[0-9a-f]{40}/);
  assert.match(workflow, /eWaterCycle\/setup-apptainer@[0-9a-f]{40}/);
  assert.match(workflow, /scripts\/brew-dev build/);
  assert.match(workflow, /actions\/upload-artifact@[0-9a-f]{40}/);
  for (const forbidden of ["podman push", "ghcr.io", "secrets.", "BLUEFIN_REVIEW_OCI_PUSH"]) assert.doesNotMatch(workflow, new RegExp(forbidden.replace(/[.*+?^${}()|[\\]\\]/g, "\\$&")), forbidden);
});

test("harness runs pinned native protocol probe and fails closed", () => {
  const harness = read("tests/luna-factory-dogfood.sh");
  for (const marker of ["native|oci|sif", "OMP_BINARY", "--mode rpc-ui", "--extension", "LUNA_FACTORY_ENABLED", "XDG_STATE_HOME", "native-terminal.jsonl", "status\\\":\\\"passed\\\"", "BLUEFIN_REVIEW_FALLBACK_SIF"]) assert.match(harness, new RegExp(marker.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\\\$&")), marker);
  assert.doesNotMatch(harness, /rm -rf/);
  assert.doesNotMatch(harness, /grep -Eq/);
  assert.doesNotMatch(harness, /exit 0/);
});

test("runtime report exposes pure TSV-free capability computation", () => {
  const probes = [
    { name: "podman.version", exitCode: 0, ok: true, command: "podman --version", stdout: "", stderr: "" },
    { name: "podman.info", exitCode: 1, ok: false, command: "podman info", stdout: "", stderr: "blocked" },
  ];
  const result = reportCapabilities(probes, "head", {}, "2026-01-01T00:00:00.000Z");
  assert.equal(result.commitSha, "head");
  assert.equal(result.boundaries.oci.status, "blocked");
  assert.equal(result.boundaries.oci.reason, "podman-unavailable");
});

test("runtime probe invokes TypeScript report", () => {
  const probe = read("tests/appliance-runtime-probe.sh");
  assert.match(probe, /appliance-runtime-report\.ts/);
  assert.doesNotMatch(probe, /python3 .*<<['"]PY/);
});
