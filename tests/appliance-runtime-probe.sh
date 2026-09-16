#!/usr/bin/env bash
# Record the host seams that the packaged Review launcher depends on.
#
# Every probe is best-effort. A failed probe is evidence about this runner, not
# a reason to hide the result or to claim that the corresponding runtime works.
set -u -o pipefail

usage() {
  cat <<'EOF'
Usage: tests/appliance-runtime-probe.sh [OUTPUT-DIRECTORY]

Record runner OS, kernel, namespace, FUSE, KVM, Apptainer, Podman, and krun
capabilities as JSON plus per-probe stdout/stderr files.
EOF
}

if [[ "${1:-}" == "--help" || "${1:-}" == "-h" ]]; then
  usage
  exit 0
fi
if [[ $# -gt 1 ]]; then
  usage >&2
  exit 2
fi

output="${1:-${RUNNER_TEMP:-.}/luna-factory-capabilities}"
mkdir -p "$output" || exit 1
index="$output/probes.tsv"
: >"$index" || exit 1

probe() {
  local name="$1" command_line="$2" stdout stderr status
  stdout="$output/$name.stdout"
  stderr="$output/$name.stderr"
  bash -c "$command_line" >"$stdout" 2>"$stderr"
  status=$?
  printf '%s\t%s\t%s\t%s\t%s\n' "$name" "$status" "$command_line" \
    "${stdout##*/}" "${stderr##*/}" >>"$index"
}

probe runner.uname 'uname -a'
probe runner.kernel 'uname -r'
probe runner.os-release 'cat /etc/os-release'
probe runner.arch 'uname -m'

probe fuse.device 'test -e /dev/fuse && test -c /dev/fuse && test -r /dev/fuse && test -w /dev/fuse'
probe fuse.kernel 'grep -E "(^|[[:space:]])fuse([[:space:]]|$)|fuseblk|fusectl" /proc/filesystems'
probe fuse.mount-helper 'grep -E "fuse" /proc/self/mountinfo'
probe kvm.device 'test -e /dev/kvm && test -c /dev/kvm && test -r /dev/kvm && test -w /dev/kvm'
probe userns.sysctl 'sysctl kernel.unprivileged_userns_clone user.max_user_namespaces'
probe userns.unshare 'unshare -Ur true'
probe apparmor.status '{ command -v aa-status >/dev/null 2>&1 && aa-status --enabled; }'
probe apparmor.module 'test -r /sys/module/apparmor/parameters/enabled && cat /sys/module/apparmor/parameters/enabled'
probe apparmor.profiles 'test -r /sys/kernel/security/apparmor/profiles && cat /sys/kernel/security/apparmor/profiles'

probe podman.version 'podman --version'
probe podman.info 'podman info --format json'
probe podman.oci-runtime "podman info --format '{{.Host.OCIRuntime}}'"
probe podman.runtimes "podman info --format '{{json .Host.OCIRuntimes}}'"
probe krun.version 'krun --version'

probe apptainer.version 'apptainer --version'
probe apptainer.buildcfg 'apptainer buildcfg'
probe squashfuse-ll.version 'squashfuse_ll --version'
probe squashfuse.version 'squashfuse --version'
probe squashfs-tools.mksquashfs 'mksquashfs -version'
probe squashfs-tools.unsquashfs 'unsquashfs -version'
probe fuse2fs.version 'fuse2fs -V'

python3 - "$output" "${GITHUB_SHA:-}" <<'PY'
import json
import os
import sys
from datetime import datetime, timezone
from pathlib import Path

root = Path(sys.argv[1])
probes = []
for line in (root / "probes.tsv").read_text().splitlines():
    name, status, command, stdout_name, stderr_name = line.split("\t", 4)
    probes.append(
        {
            "name": name,
            "exitCode": int(status),
            "ok": int(status) == 0,
            "command": command,
            "stdout": (root / stdout_name).read_text(errors="replace"),
            "stderr": (root / stderr_name).read_text(errors="replace"),
        }
    )

safe_environment = {}
for key in (
    "RUNNER_OS",
    "RUNNER_ARCH",
    "ImageOS",
    "ImageVersion",
    "GITHUB_RUNNER_OS",
    "GITHUB_RUNNER_ARCH",
    "GITHUB_ACTIONS",
    "CI",
):
    if key in os.environ:
        safe_environment[key] = os.environ[key]

manifest = {
    "schema": 1,
    "generatedAtUtc": datetime.now(timezone.utc).isoformat(),
    "commitSha": sys.argv[2],
    "safeRunnerEnvironment": safe_environment,
    "probes": probes,
}
(root / "capabilities.json").write_text(json.dumps(manifest, indent=2) + "\n")

with (root / "capabilities.txt").open("w") as stream:
    stream.write("Luna Factory packaged-runtime runner capability probe\n")
    stream.write(f"commit: {sys.argv[2] or 'unknown'}\n")
    for probe in probes:
        state = "ok" if probe["ok"] else f"failed({probe['exitCode']})"
        stream.write(f"{state:>12}  {probe['name']}: {probe['command']}\n")
PY

echo "Recorded runner capability probe in $output"
