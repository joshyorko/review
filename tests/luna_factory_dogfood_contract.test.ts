/** Behavioral contracts for the finite, no-publish Factory dogfood path. */
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";
import { join } from "node:path";
import { boundaryOutputLines, reportCapabilities } from "./appliance-runtime-report.ts";

const root = join(import.meta.dirname, "..");
const read = (name: string) => readFileSync(join(root, name), "utf8");
const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const assertIncludes = (source: string, markers: readonly string[]) => {
  for (const marker of markers) assert.ok(source.includes(marker), marker);
};

test("workflow preserves the bounded exact-head no-publish contract", () => {
  const workflow = read(".github/workflows/luna-factory-dogfood.yml");
  assertIncludes(workflow, [
    "pull_request:",
    "github.event.pull_request.head.sha",
    "ubuntu-24.04",
    "bun test tests/luna_factory_dogfood_contract.test.ts",
    "tests/luna-factory-dogfood.sh",
    "tests/appliance-runtime-probe.sh",
    "tests/appliance-runtime-report.ts",
    "scripts/brew-dev",
    "tar -xzf",
    "bluefin-review.sif",
    "podman image rm --ignore",
    "podman image prune --force",
    "podman system prune --all --force",
    'rm -f "$bundle"',
    "actions/upload-artifact",
    "podman build --format oci",
    "tests/appliance-contract.sh --image",
    "oven-sh/setup-bun@0c5077e51419868618aeaa5fe8019c62421857d6",
    "eWaterCycle/setup-apptainer@58d788a297b0acdec33b8979428afa78679aa711",
    "actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1",
    "actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a",
    "id: capabilities",
    "steps.capabilities.outputs.oci",
    "steps.capabilities.outputs.sif",
    "REVIEW_REVISION",
    'localhost/review:luna-factory-dogfood-${{ github.event.pull_request.head.sha }}',
    'LUNA_FACTORY_HEAD_SHA: ${{ github.event.pull_request.head.sha }}',
    '"$LUNA_FACTORY_HEAD_SHA"',
    "$GITHUB_OUTPUT",
  ]);
  for (const forbidden of [
    "python3",
    "<<'PY'",
    "podman push",
    "ghcr.io",
    "secrets.",
    "gh auth",
    "release create",
    "BLUEFIN_REVIEW_OCI_PUSH",
  ]) assert.doesNotMatch(workflow, new RegExp(escapeRegExp(forbidden)), forbidden);
  assert.equal(existsSync(join(root, "tests/luna_factory_dogfood_contract.py")), false);
});

test("harness preserves the local-provider and runtime-boundary contract", () => {
  const harness = read("tests/luna-factory-dogfood.sh");
  assertIncludes(harness, [
    "--network host",
    "--interactive",
    "--userns keep-id:uid=65532,gid=65532",
    "127.0.0.1",
    "LUNA_FACTORY_ENABLED",
    '"type":"prompt"',
    "LUNA_FACTORY_PROBE_ROOT",
    "luna_factory_open",
    "luna_factory_candidate",
    "luna_factory_attempt",
    "luna_factory_dispatch",
    "nativeAgentIds",
    "HOME",
    "XDG_STATE_HOME",
    'chmod 0711 "$run_root"',
    'chmod 0777 "$home" "$state" "$config" "$cache" "$models"',
    '"$models/models.yml"',
    "coproc factory_rpc",
    "shellcheck disable=SC2154",
    "ready",
    "available_commands_update",
    "agent_end",
    "luna-factory-omp-probe-config.yml",
    "luna-factory-omp-probe-models.yml",
    "provider.log",
    "write_result blocked",
    "native|oci|sif",
    "OMP_BINARY",
    "--mode rpc-ui",
    "--extension",
    "native-terminal.jsonl",
    'status\":\"passed\"',
    "BLUEFIN_REVIEW_FALLBACK_SIF",
  ]);
  assert.doesNotMatch(harness, /rm -rf/);
  assert.doesNotMatch(harness, /grep -Eq/);
  assert.doesNotMatch(harness, /exit 0/);
  assert.doesNotMatch(harness, /--no-session/);
});

test("SIF harness uses Apptainer directly and does not claim krun", () => {
  const harness = read("tests/luna-factory-dogfood.sh");
  assertIncludes(harness, ["BLUEFIN_REVIEW_FALLBACK_SIF", "apptainer exec", '--home "$home:/home/bluefin"', "--bind"]);
  assert.doesNotMatch(harness, /krun/);
});

test("capability probe records the independently classified host boundaries", () => {
  const probe = read("tests/appliance-runtime-probe.sh");
  assertIncludes(probe, [
    "/dev/fuse",
    "/dev/kvm",
    "/proc/filesystems",
    "unshare",
    "apparmor",
    "podman",
    "krun",
    "apptainer",
    "squashfuse",
    "mksquashfs",
    "unsquashfs",
    "fuse2fs",
    "userNamespace",
    '"apptainer"',
    '"kvm"',
    '"krun"',
    '"sif"',
  ]);
  assert.doesNotMatch(probe, /python3 .*<<['"]PY/);
});

test("runtime report exposes pure capability computation and GitHub outputs", () => {
  const probes = [
    { name: "podman.version", exitCode: 0, ok: true, command: "podman --version", stdout: "", stderr: "" },
    { name: "podman.info", exitCode: 1, ok: false, command: "podman info", stdout: "", stderr: "blocked" },
  ];
  const result = reportCapabilities(probes, "head", {}, "2026-01-01T00:00:00.000Z");
  assert.equal(result.commitSha, "head");
  assert.equal(result.boundaries.oci.status, "blocked");
  assert.equal(result.boundaries.oci.reason, "podman-unavailable");
  assert.match(boundaryOutputLines(result), /oci=blocked/);
  assert.match(boundaryOutputLines(result), /sif=blocked/);
  assert.match(boundaryOutputLines(result), /appArmor=blocked/);
});

test("the TypeScript contract is the only Factory dogfood contract", () => {
  const validate = read(".github/workflows/validate.yml");
  assert.match(validate, /node --test --disable-warning=MODULE_TYPELESS_PACKAGE_JSON tests\/luna_factory_dogfood_contract\.test\.ts/);
  assert.doesNotMatch(validate, /luna_factory_dogfood_contract\.py/);
  assert.doesNotMatch(read("tests/omp-review-mode.sh"), /luna_factory_dogfood_contract\.py/);
});

test("runtime probe invokes the TypeScript report without an embedded Python serializer", () => {
  const probe = read("tests/appliance-runtime-probe.sh");
  assert.match(probe, /appliance-runtime-report\.ts/);
  assert.doesNotMatch(probe, /python3 .*<<['"]PY/);
});
