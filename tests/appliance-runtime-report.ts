#!/usr/bin/env bun
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const selfTest = process.argv.includes("--self-test");
if (selfTest) {
  console.log(JSON.stringify({ schema: 2, boundaries: {
    oci: { status: "blocked", reason: "not-executed" },
    sifFuse: { status: "blocked", reason: "not-executed" },
    krunKvm: { status: "blocked", reason: "runner-capability-not-tested" },
  }}));
  process.exit(0);
}
const root = process.argv[2];
if (!root) throw new Error("usage: appliance-runtime-report.ts OUTPUT-DIRECTORY [COMMIT]");
const commitSha = process.argv[3] ?? "";
const probes = readFileSync(join(root, "probes.tsv"), "utf8").trim().split("\n").filter(Boolean).map((line) => {
  const [name, status, command, stdoutName, stderrName] = line.split("\t", 5);
  const exitCode = Number(status);
  return { name, exitCode, ok: exitCode === 0, command, stdout: readFileSync(join(root, stdoutName), "utf8"), stderr: readFileSync(join(root, stderrName), "utf8") };
});
const safeRunnerEnvironment: Record<string, string> = {};
for (const key of ["RUNNER_OS", "RUNNER_ARCH", "ImageOS", "ImageVersion", "GITHUB_RUNNER_OS", "GITHUB_RUNNER_ARCH", "GITHUB_ACTIONS", "CI"]) {
  if (process.env[key]) safeRunnerEnvironment[key] = process.env[key];
}
const has = (name: string) => probes.find((probe) => probe.name === name)?.ok === true;
const boundaries = {
  oci: { status: has("podman.version") && has("podman.info") ? "available" : "blocked", reason: has("podman.version") && has("podman.info") ? undefined : "podman-unavailable" },
  sifFuse: { status: has("apptainer.version") && has("fuse.device") ? "available" : "blocked", reason: has("apptainer.version") && has("fuse.device") ? undefined : "apptainer-or-fuse-unavailable" },
  krunKvm: { status: has("krun.version") && has("kvm.device") ? "available" : "blocked", reason: has("krun.version") && has("kvm.device") ? undefined : "krun-or-kvm-unavailable" },
};
const manifest = { schema: 2, generatedAtUtc: new Date().toISOString(), commitSha, safeRunnerEnvironment, boundaries, probes };
writeFileSync(join(root, "capabilities.json"), `${JSON.stringify(manifest, null, 2)}\n`);
writeFileSync(join(root, "capabilities.txt"), ["Luna Factory packaged-runtime runner capability probe", `commit: ${commitSha || "unknown"}`, ...probes.map((probe) => `${probe.ok ? "ok" : `failed(${probe.exitCode})`}: ${probe.name}: ${probe.command}`), "", `OCI: ${boundaries.oci.status}`, `SIF/FUSE: ${boundaries.sifFuse.status}`, `krun/KVM: ${boundaries.krunKvm.status}`].join("\n"));
console.log(JSON.stringify(manifest));
