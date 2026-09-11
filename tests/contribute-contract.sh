#!/usr/bin/env bash
set -euo pipefail
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$root"
image=""
smaller_than=""
while (($#)); do
  case "$1" in
    --image) image="$2"; shift 2 ;;
    --smaller-than) smaller_than="$2"; shift 2 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done
containerfile=image/contribute/Containerfile
fail() { echo "contribute-contract: $*" >&2; exit 1; }
grep -qE '^ARG FSDK_BASE_IMAGE=ghcr\.io/projectbluefin/base:[^@]+@sha256:[0-9a-f]{64}$' "$containerfile" || fail "base must be tag@digest pinned"
grep -qE '^ARG FSDK_BUILDER_IMAGE=ghcr\.io/projectbluefin/lab-runner:[^@]+@sha256:[0-9a-f]{64}$' "$containerfile" || fail "builder must be tag@digest pinned"
for pin in OMP_X86_64_SHA256 OMP_AARCH64_SHA256 NODE_X86_64_SHA256 NODE_AARCH64_SHA256 GH_X86_64_SHA256 GH_AARCH64_SHA256 TMUX_X86_64_SHA256 TMUX_AARCH64_SHA256; do grep -qE "^ARG ${pin}=[0-9a-f]{64}$" "$containerfile" || fail "missing ${pin}"; done
for path in contributor-agent.sh contributor-relay.js pi-backend.js lib/pane-classifier.js; do grep -q "${path}" "$containerfile" || fail "missing Hive runtime ${path}"; done
grep -qF 'ENTRYPOINT ["/usr/local/bin/contribute-entrypoint"]' "$containerfile" || fail "wrong entrypoint"
grep -qF 'WORKDIR /home/bluefin/workspace' "$containerfile" || fail "wrong workdir"
grep -qF 'USER 65532:65532' "$containerfile" || fail "wrong user"
grep -qF 'NODE_PATH=/usr/lib/bluefin/hive/node_modules' "$containerfile" || fail "missing NODE_PATH"
grep -qF 'io.projectbluefin.contribute="true"' "$containerfile" || fail "missing contribute label"
grep -qF 'contribute_image := env("CONTRIBUTE_IMAGE", "ghcr.io/projectbluefin/contribute:stable")' justfile || fail "missing launcher image"
grep -qF '/home/bluefin/.config/hive/contributor.env:ro,z' justfile || fail "missing single registration mount"
grep -qF 'keep-id:uid=65532,gid=65532' justfile || fail "wrong user namespace"
grep -qF 'HIVE_SETUP_BACKEND=omp' justfile || fail "OMP setup not selected"
grep -qF 'AGENT_BACKEND=omp' "$containerfile" || fail "OMP must be the image default backend"
grep -qF 'supports only AGENT_BACKEND=omp' image/contribute/entrypoint.sh || fail "entrypoint must reject alternate backends"
if [[ -z "$image" ]]; then echo "contribute-contract: static contract holds"; exit 0; fi
engine="${CONTAINER_ENGINE:-podman}"
inspect() { "$engine" image inspect "$image" --format "$1"; }
test "$(inspect '{{.Config.User}}')" = 65532:65532 || fail "image user"
test "$(inspect '{{.Config.WorkingDir}}')" = /home/bluefin/workspace || fail "image workdir"
test "$(inspect '{{json .Config.Entrypoint}}')" = '["/usr/local/bin/contribute-entrypoint"]' || fail "image entrypoint"
"$engine" run --rm --entrypoint /usr/bin/bash "$image" -c 'set -eu; omp --version; node -e "require.resolve(\"ws\")"; gh --version >/dev/null; tmux -V; git --version >/dev/null; curl --version >/dev/null; find --version >/dev/null; grep --version >/dev/null; sed --version >/dev/null; cmp --version >/dev/null; test -w "$HOME"; test -w "$HOME/workspace"; test -f /usr/local/bin/contributor-relay.js; test -f /usr/local/bin/pi-backend.js; test -f /usr/local/bin/lib/pane-classifier.js; test ! -e /usr/bin/npm; test ! -e /usr/bin/corepack' >/dev/null || fail "runtime closure"
if "$engine" run --rm --env AGENT_BACKEND=goose "$image" >/dev/null 2>&1; then
  fail "alternate agent backends must be rejected"
fi
if [[ -n "$smaller_than" ]]; then
  size() { "$engine" history --format json "$1" | python3 -c 'import json,sys; print(sum(int(x.get("size") or 0) for x in json.load(sys.stdin)))'; }
  test "$(size "$image")" -lt "$(size "$smaller_than")" || fail "contribute image is not smaller than ${smaller_than}"
fi
echo "contribute-contract: runtime contract holds"
