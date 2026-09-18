#!/usr/bin/env bun
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export type Probe = {
  name: string;
  exitCode: number;
  ok: boolean;
  command: string;
  stdout: string;
  stderr: string;
};

export type Boundary = { status: "available" | "blocked"; reason?: string };
export type RuntimeReport = {
  schema: 2;
  generatedAtUtc: string;
  commitSha: string;
  safeRunnerEnvironment: Record<string, string>;
  boundaries: {
    fuse: Boundary;
    userNamespace: Boundary;
    appArmor: Boundary;
    apptainer: Boundary;
    kvm: Boundary;
    krun: Boundary;
    oci: Boundary;
    sif: Boundary;
  };
  probes: Probe[];
};

/** Compute the report from captured probes without consulting the host. */
export function reportCapabilities(
  probes: Probe[],
  commitSha = "",
  environment: Record<string, string | undefined> = process.env,
  generatedAtUtc = new Date().toISOString(),
): RuntimeReport {
  const safeRunnerEnvironment: Record<string, string> = {};
  for (const key of ["RUNNER_OS", "RUNNER_ARCH", "ImageOS", "ImageVersion", "GITHUB_RUNNER_OS", "GITHUB_RUNNER_ARCH", "GITHUB_ACTIONS", "CI"]) {
    const value = environment[key];
    if (value !== undefined) safeRunnerEnvironment[key] = value;
  }
  const has = (name: string) => probes.some((probe) => probe.name === name && probe.ok);
  const boundary = (names: readonly string[], reason: string): Boundary => names.every(has) ? { status: "available" } : { status: "blocked", reason };
  return {
    schema: 2,
    generatedAtUtc,
    commitSha,
    safeRunnerEnvironment,
    boundaries: {
      fuse: boundary(["fuse.device", "fuse.kernel", "fuse.mount-helper"], "fuse-device-or-mount-unavailable"),
      userNamespace: boundary(["userns.sysctl", "userns.unshare"], "user-namespace-unavailable"),
      appArmor: boundary(["apparmor.status"], "apparmor-unavailable"),
      apptainer: boundary(["apptainer.version", "apptainer.buildcfg"], "apptainer-unavailable"),
      kvm: boundary(["kvm.device"], "kvm-device-unavailable"),
      krun: boundary(["krun.version"], "krun-unavailable"),
      oci: boundary(["podman.version", "podman.info"], "podman-unavailable"),
      sif: boundary(["apptainer.version", "apptainer.buildcfg", "fuse.device", "podman.version", "podman.info", "squashfuse-ll.version", "squashfs-tools.mksquashfs", "fuse2fs.version", "userns.unshare"], "sif-build-or-runtime-unavailable"),
    },
    probes,
  };
}

function readProbes(root: string): Probe[] {
  const contents = readFileSync(join(root, "probes.tsv"), "utf8");
  return contents.split("\n").filter(Boolean).map((line) => {
    const [name, status, command, stdoutName, stderrName] = line.split("\t", 5);
    if (!name || !stdoutName || !stderrName || !/^[-]?\d+$/.test(status ?? "") || command === undefined) throw new Error(`invalid probe row: ${line}`);
    const exitCode = Number(status);
    return { name, exitCode, ok: exitCode === 0, command, stdout: readFileSync(join(root, stdoutName), "utf8"), stderr: readFileSync(join(root, stderrName), "utf8") };
  });
}

export function writeRuntimeReport(root: string, commitSha = ""): RuntimeReport {
  const manifest = reportCapabilities(readProbes(root), commitSha);
  writeFileSync(join(root, "capabilities.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  const boundaryLines = Object.entries(manifest.boundaries).map(([name, result]) => `${result.status}: ${name}${result.reason ? ` (${result.reason})` : ""}`);
  writeFileSync(join(root, "capabilities.txt"), ["Luna Factory packaged-runtime runner capability probe", `commit: ${commitSha || "unknown"}`, ...manifest.probes.map((probe) => `${probe.ok ? "ok" : `failed(${probe.exitCode})`}: ${probe.name}`), ...boundaryLines].join("\n") + "\n");
  return manifest;
}

if (import.meta.main) {
  const root = process.argv[2];
  if (!root) throw new Error("usage: appliance-runtime-report.ts OUTPUT-DIRECTORY [COMMIT]");
  console.log(JSON.stringify(writeRuntimeReport(root, process.argv[3] ?? "")));
}
