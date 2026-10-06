#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
fixture_root="$repo_root/tests/fixtures"
omp_binary="/usr/bin/omp"
expected_source_commit="9348320cc4a30a7195d36a1f05a6c11bcb701a17"
expected_version="omp/18.5.0"
cooperative_evidence_path="${LUNA_POLICY_PROBE_ROOT_ATTESTATION:-}"

if [[ -v OMP_BINARY ]]; then
  printf 'BLOCKED: OMP_BINARY overrides are not accepted for current-native qualification\n' >&2
  exit 78
fi
if [[ ! -x "$omp_binary" || -L "$omp_binary" ]]; then
  printf 'BLOCKED: fixed packaged OMP executable is unavailable or symlinked: %s\n' "$omp_binary" >&2
  exit 78
fi
if ! command -v node >/dev/null 2>&1 || ! command -v timeout >/dev/null 2>&1 || ! command -v sha256sum >/dev/null 2>&1; then
  printf 'BLOCKED: node, timeout, and sha256sum are required\n' >&2
  exit 78
fi
if [[ -z "$cooperative_evidence_path" || ! -f "$cooperative_evidence_path" || -L "$cooperative_evidence_path" ]]; then
  printf 'BLOCKED: cooperative root-provided identity evidence is required\n' >&2
  exit 78
fi
cooperative_evidence_sha256="$(sha256sum "$cooperative_evidence_path" | cut -d ' ' -f 1)"

actual_version="$("$omp_binary" --version 2>/dev/null)"
if [[ "$actual_version" != "$expected_version" ]]; then
  printf 'BLOCKED: expected %s, found %s\n' "$expected_version" "${actual_version:-unknown}" >&2
  exit 78
fi

sbom="/usr/share/bluefin/review/sbom.spdx.json"
if [[ ! -r "$sbom" ]]; then
  printf 'BLOCKED: packaged SBOM is unavailable: %s\n' "$sbom" >&2
  exit 78
fi
binary_path="$omp_binary"
binary_sha256="$(sha256sum "$binary_path" | cut -d ' ' -f 1)"
source_commit=""
sbom_binary_sha256=""
set +e
node - "$sbom" "$expected_source_commit" "$expected_version" "$binary_sha256" <<'NODE'
const fs = require("node:fs");
const [path, expectedSource, expectedVersion, actualBinarySha] = process.argv.slice(2);
const sbom = JSON.parse(fs.readFileSync(path, "utf8"));
const source = sbom.packages?.find((pkg) => pkg.name === "omp-source");
const binary = sbom.packages?.find((pkg) => pkg.name === "omp");
const sourceCommit = source?.versionInfo ?? "";
const binaryVersion = binary?.versionInfo ?? "";
const binarySha = binary?.checksums?.find((item) => item.algorithm === "SHA256")?.checksumValue ?? "";
if (sourceCommit !== expectedSource || binaryVersion !== expectedVersion.replace("omp/", "") || binarySha !== actualBinarySha) {
	console.error(JSON.stringify({ status:"blocked", sourceCommit, binaryVersion, sbomBinarySha256:binarySha, actualBinarySha256:actualBinarySha }));
	process.exit(78);
}
process.stdout.write(JSON.stringify({ sourceCommit, sbomBinarySha256:binarySha }));
NODE
sbom_status=$?
set -e
if [[ "$sbom_status" -ne 0 ]]; then
  printf 'BLOCKED: packaged SBOM source/version/binary digest does not match the selected executable\n' >&2
  exit 78
fi
sbom_identity="$(
  node - "$sbom" <<'NODE'
const fs = require("node:fs");
const sbom = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
const source = sbom.packages.find((pkg) => pkg.name === "omp-source");
const binary = sbom.packages.find((pkg) => pkg.name === "omp");
process.stdout.write(JSON.stringify({
	sourceCommit: source.versionInfo,
	binarySha256: binary.checksums.find((item) => item.algorithm === "SHA256").checksumValue,
}));
NODE
)"
source_commit="$(node -e 'process.stdout.write(JSON.parse(process.argv[1]).sourceCommit)' "$sbom_identity")"
sbom_binary_sha256="$(node -e 'process.stdout.write(JSON.parse(process.argv[1]).binarySha256)' "$sbom_identity")"
effective_uid="$(id -u)"

probe_root="$(mktemp -d "${TMPDIR:-/tmp}/luna-policy-request-probe.XXXXXX")"
chmod 700 "$probe_root"
mkdir -p "$probe_root/home" "$probe_root/config" "$probe_root/cache" "$probe_root/data" "$probe_root/state" "$probe_root/sessions"
identity_receipt="$probe_root/cooperative-identity-checked.json"
node --input-type=module - "$fixture_root/luna-factory-policy-request-probe-contracts.mjs" "$cooperative_evidence_path" "$probe_root" "$binary_path" "$actual_version" "$source_commit" "$binary_sha256" "$effective_uid" "$cooperative_evidence_sha256" <<'NODE' >"$probe_root/identity-validation.log" 2>&1
import fs from "node:fs";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";
const [contractsPath, path, outputRoot, binaryPath, version, sourceCommit, binarySha, uidText, cooperativeEvidenceFileSha256] = process.argv.slice(2);
const { validateAttestationFileStat, validateCooperativeIdentityInput } = await import(pathToFileURL(contractsPath).href);
try {
	const fd = fs.openSync(path, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
	try {
		const stat = fs.fstatSync(fd);
		validateAttestationFileStat({ isFile: stat.isFile(), nlink: stat.nlink, mode: stat.mode });
		const raw = fs.readFileSync(fd);
		const openedFileSha256 = execFileSync("sha256sum", ["-b"], { input: raw, encoding: "utf8" }).split(/\s+/)[0];
		if (openedFileSha256 !== attestationFileSha256) throw new Error("cooperative evidence file changed between identity read and receipt hash");
		const attestation = JSON.parse(raw.toString("utf8"));
		const validated = validateCooperativeIdentityInput(attestation, {
			ompBinaryPath: binaryPath,
			ompVersion: version,
			ompSourceCommit: sourceCommit,
			ompBinarySha256: binarySha,
			effectiveUid: Number(uidText),
			cooperativeEvidenceFileSha256,
		});
		fs.writeFileSync(outputRoot + "/cooperative-identity-checked.json", JSON.stringify(validated, null, 2), { mode: 0o600 });
	} finally {
		fs.closeSync(fd);
	}
} catch (error) {
	console.error("BLOCKED: " + (error instanceof Error ? error.message : String(error)));
	process.exit(78);
}
NODE
identity_status=$?
if [[ "$identity_status" -ne 0 || ! -s "$identity_receipt" ]]; then
  cat "$probe_root/identity-validation.log" >&2
  printf 'BLOCKED: cooperative identity input comparison failed\n' >&2
  exit 78
fi

ready_path="$probe_root/provider-ready.json"
audit_path="$probe_root/provider.jsonl"
result_path="$probe_root/result.json"
env -i PATH="$PATH" HOME="$probe_root/home" TMPDIR="$probe_root" \
  LUNA_POLICY_PROBE_READY="$ready_path" LUNA_POLICY_PROBE_AUDIT="$audit_path" \
  node "$fixture_root/luna-factory-policy-request-probe-server.mjs" >"$probe_root/provider.log" 2>&1 &
provider_pid=$!
cleanup() {
  if kill -0 "$provider_pid" 2>/dev/null; then kill -TERM "$provider_pid" 2>/dev/null || true; fi
  wait "$provider_pid" 2>/dev/null || true
}
trap cleanup EXIT

for _ in {1..100}; do
  [[ -s "$ready_path" ]] && break
  if ! kill -0 "$provider_pid" 2>/dev/null; then
    cat "$probe_root/provider.log" >&2
    printf 'FAILED: loopback provider exited before becoming ready\n' >&2
    exit 1
  fi
  sleep 0.1
done
if [[ ! -s "$ready_path" ]]; then
  printf 'FAILED: loopback provider did not become ready\n' >&2
  exit 1
fi
port="$(
  node - "$ready_path" <<'NODE'
const fs = require("node:fs");
process.stdout.write(String(JSON.parse(fs.readFileSync(process.argv[2], "utf8")).port));
NODE
)"
sed "s/__PORT__/$port/g" "$fixture_root/luna-factory-policy-request-probe-config.yml" >"$probe_root/omp.yml"
stats_url="http://127.0.0.1:$port/__probe/stats"
image_digest="$(node -e 'process.stdout.write(JSON.parse(require("node:fs").readFileSync(process.argv[1],"utf8")).imageDigest)' "$identity_receipt")"
container_config_digest="$(node -e 'process.stdout.write(JSON.parse(require("node:fs").readFileSync(process.argv[1],"utf8")).containerConfigDigest)' "$identity_receipt")"
runtime="$(node -e 'process.stdout.write(JSON.parse(require("node:fs").readFileSync(process.argv[1],"utf8")).runtime)' "$identity_receipt")"
attester="$(node -e 'process.stdout.write(JSON.parse(require("node:fs").readFileSync(process.argv[1],"utf8")).attester)' "$identity_receipt")"
printf '{"ompVersion":"%s","ompSourceCommit":"%s","ompBinaryPath":"%s","ompBinarySha256":"%s","sbomBinarySha256":"%s","imageDigest":"%s","containerConfigDigest":"%s","runtime":"%s","effectiveUid":%s,"cooperativeEvidenceFileSha256":"%s","attesterLabel":"%s"}\n' \
  "$actual_version" "$source_commit" "$binary_path" "$binary_sha256" "$sbom_binary_sha256" "$image_digest" "$container_config_digest" "$runtime" "$effective_uid" "$cooperative_evidence_sha256" "$attester" >"$probe_root/identity.json"

printf 'Probe artifacts: %s\n' "$probe_root"
cat "$probe_root/identity.json"
set +e
env -i PATH="$PATH" HOME="$probe_root/home" TMPDIR="$probe_root" \
  XDG_CONFIG_HOME="$probe_root/config" XDG_CACHE_HOME="$probe_root/cache" \
  XDG_DATA_HOME="$probe_root/data" XDG_STATE_HOME="$probe_root/state" \
  OMP_SOURCE_COMMIT="$source_commit" \
  LUNA_POLICY_PROBE_RESULT="$result_path" \
  LUNA_POLICY_PROBE_STATS_URL="$stats_url" \
  LUNA_POLICY_PROBE_OMP_BINARY_PATH="$binary_path" \
  LUNA_POLICY_PROBE_OMP_BINARY_SHA256="$binary_sha256" \
  LUNA_POLICY_PROBE_BINARY_VERSION="$actual_version" \
  LUNA_POLICY_PROBE_IMAGE_DIGEST="$image_digest" \
  LUNA_POLICY_PROBE_CONFIG_DIGEST="$container_config_digest" \
  LUNA_POLICY_PROBE_RUNTIME="$runtime" \
  LUNA_POLICY_PROBE_EFFECTIVE_UID="$effective_uid" \
  LUNA_POLICY_PROBE_EVIDENCE_SHA256="$cooperative_evidence_sha256" \
  LUNA_POLICY_PROBE_ATTESTER="$attester" \
  timeout --signal=TERM --kill-after=5s 100s \
  "$omp_binary" --mode rpc-ui --no-extensions --no-skills --no-rules --no-pty \
  --config "$probe_root/omp.yml" --session-dir "$probe_root/sessions" \
  --model local-probe/deterministic \
  --extension "$fixture_root/luna-factory-policy-request-probe.ts" \
  >"$probe_root/omp.log" 2>&1
omp_status=$?
set -e

summary_path="$audit_path.summary.json"
drain_path="$probe_root/provider-drain.json"
drain_log="$probe_root/provider-drain.log"
set +e
env -i PATH="$PATH" node --input-type=module - "$stats_url" "$drain_path" <<'NODE' >"$drain_log" 2>&1
import fs from "node:fs";
const [statsUrl, receiptPath] = process.argv.slice(2);
const url = new URL(statsUrl);
url.pathname = "/__probe/drain";
url.search = new URLSearchParams({ quietMs: "500", maxWaitMs: "5000" }).toString();
try {
	const response = await fetch(url, { signal: AbortSignal.timeout(7000) });
	const result = await response.json();
	fs.writeFileSync(receiptPath, JSON.stringify(result, null, 2));
	console.log(JSON.stringify({ status: result.status, settlement: result.settlement }));
	if (!response.ok || result.status !== "settled") process.exitCode = 1;
} catch (error) {
	console.error(error instanceof Error ? error.message : String(error));
	process.exitCode = 1;
}
NODE
drain_status=$?
set -e

provider_exited=0
for _ in {1..240}; do
  if [[ ! -r "/proc/$provider_pid/stat" ]]; then
    provider_exited=1
    break
  fi
  read -r _ _ process_state _ <"/proc/$provider_pid/stat" || {
    provider_exited=1
    break
  }
  if [[ "$process_state" == "Z" ]]; then
    provider_exited=1
    break
  fi
  sleep 0.05
done
if [[ "$provider_exited" -eq 1 ]]; then
  set +e
  wait "$provider_pid"
  provider_status=$?
  set -e
else
  cleanup
  provider_status=124
fi
trap - EXIT

printf '\nOMP exit: %s\n' "$omp_status"
if [[ -s "$result_path" ]]; then cat "$result_path"; else cat "$probe_root/omp.log" >&2; fi
if [[ -s "$summary_path" ]]; then cat "$summary_path"; else printf 'FAILED: provider accounting summary missing\n' >&2; fi
if [[ -s "$drain_path" ]]; then cat "$drain_path"; else printf 'FAILED: provider drain receipt missing\n' >&2; fi
printf 'OMP log: %s/omp.log\nProvider log: %s/provider.log\n' "$probe_root" "$probe_root"

if [[ "$omp_status" -ne 0 || "$drain_status" -ne 0 || "$provider_status" -ne 0 || ! -s "$result_path" || ! -s "$summary_path" || ! -s "$drain_path" ]] || ! node - "$result_path" "$summary_path" "$drain_path" <<'NODE'; then
const fs = require("node:fs");
const result = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
const summary = JSON.parse(fs.readFileSync(process.argv[3], "utf8"));
const drain = JSON.parse(fs.readFileSync(process.argv[4], "utf8"));
const expectedCases = ["allow", "abort", "throw", "timeout"];
if (result.status !== "observed" || result.accounting?.complete !== true) process.exit(1);
if (summary.activeCase !== null || summary.unassignedPostCount !== 0 || summary.totalPostCount !== summary.assignedPostCount) process.exit(1);
if (drain.status !== "settled" || drain.settlement?.quietMs !== 500 || drain.settlement?.maxWaitMs !== 5000 || drain.settlement?.waitedMs > 5100 || drain.settlement?.quietForMs < 500 || drain.settlement?.activeProviderRequestCount !== 0 || drain.settlement?.activeProviderConnectionCount !== 0 || drain.settlement?.lateProviderRequestCount !== 0) process.exit(1);
if (summary.drain?.settled !== true || summary.drain?.listenerClosed !== true || summary.drain?.forcedSocketClose === true || summary.drain?.lateProviderRequestCount !== 0) process.exit(1);
if (summary.activeProviderRequestCount !== 0 || summary.activeProviderConnectionCount !== 0) process.exit(1);
if (result.accounting.totalPostCount !== summary.totalPostCount || result.accounting.assignedPostCount !== summary.assignedPostCount || result.accounting.unassignedPostCount !== summary.unassignedPostCount) process.exit(1);
if (result.accounting.untaggedPostCount !== summary.untaggedPostCount || result.accounting.markerMismatchPostCount !== summary.markerMismatchPostCount) process.exit(1);
if (drain.snapshot?.totalPostCount !== summary.totalPostCount || drain.snapshot?.unassignedPostCount !== summary.unassignedPostCount) process.exit(1);
if (JSON.stringify(result.providerMethodPathCounts) !== JSON.stringify(summary.methodPathCounts) || JSON.stringify(drain.snapshot?.methodPathCounts) !== JSON.stringify(summary.methodPathCounts)) process.exit(1);
if (summary.caseWindows.length !== expectedCases.length) process.exit(1);
for (const name of expectedCases) {
	const window = summary.caseWindows.find((candidate) => candidate.case === name);
	if (!window?.finished || result.cases?.[name]?.providerSendCount !== window.postCount) process.exit(1);
}
const { allowedRequestObserved, throwFailOpenObserved, timeoutFailOpenObserved } = result.finding;
if (!allowedRequestObserved || !throwFailOpenObserved || !timeoutFailOpenObserved) process.exit(1);
const abort = result.cases?.abort;
if (result.finding.abortZeroSendObserved && (abort?.providerSendCount !== 0 || summary.untaggedPostCount !== 0 || summary.markerMismatchPostCount !== 0)) process.exit(1);
NODE
  printf 'FAILED/UNPROVED: exact-package observations, provider drain, or full accounting did not settle\n' >&2
  exit 1
fi
