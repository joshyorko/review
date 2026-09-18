#!/usr/bin/env bash
# Record the host seams that the packaged Review launcher depends on.
#
# Every probe is best-effort. A failed probe is evidence about this runner, not
# a reason to hide the result or to claim that the corresponding runtime works.
set -u -o pipefail

usage() {
  cat <<'EOF'
Usage: tests/appliance-runtime-probe.sh [OUTPUT-DIRECTORY] [COMMIT-SHA]

Record runner OS, kernel, namespace, FUSE, KVM, Apptainer, Podman, and krun
capabilities as JSON plus per-probe stdout/stderr files.
EOF
}

if [[ "${1:-}" == "--help" || "${1:-}" == "-h" ]]; then
  usage
  exit 0
fi
if [[ $# -gt 2 ]]; then
  usage >&2
  exit 2
fi

output="${1:-${RUNNER_TEMP:-.}/luna-factory-capabilities}"
commit_sha="${2:-${GITHUB_SHA:-}}"
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

# appliance-runtime-report.ts owns the independent boundary keys "userNamespace",
# "apptainer", "kvm", "krun", and "sif"; missing probes remain blocked.
reporter="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/appliance-runtime-report.ts"
if command -v bun >/dev/null 2>&1; then
  bun "$reporter" "$output" "$commit_sha" >/dev/null
elif command -v node >/dev/null 2>&1; then
  node "$reporter" "$output" "$commit_sha" >/dev/null
else
  echo "appliance-runtime-probe: bun or node is required to write the TypeScript report" >&2
  exit 1
fi

echo "Recorded runner capability probe in $output"
