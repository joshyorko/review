#!/usr/bin/env bash
# Finite Factory dogfood. Runs the real OMP binary with a deterministic local
# protocol fixture; packaged modes add only the existing OCI/SIF boundary.
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
usage() { printf 'usage: %s native|oci|sif\n' "$0"; }
mode="${1:-}"
case "$mode" in
native | oci | sif) ;;
--help | -h)
  usage
  exit
  ;;
*)
  usage >&2
  exit 2
  ;;
esac

run_root="${RUNNER_TEMP:-${TMPDIR:-/tmp}}/luna-factory-dogfood-$$"
state="$run_root/state"
home="$run_root/home"
config="$home/.config/omp"
cache="$home/.cache"
provider_log="$run_root/provider.log"
result_file="$run_root/result.json"
terminal_file="$run_root/${mode}-terminal.jsonl"
mkdir -p -- "$state" "$config" "$cache"
chmod 700 "$run_root" "$home" "$state"
export HOME="$home" XDG_STATE_HOME="$state" XDG_CONFIG_HOME="$home/.config" XDG_CACHE_HOME="$cache"
export LUNA_FACTORY_ENABLED=1 LUNA_FACTORY_PROVIDER_URL="http://127.0.0.1:43129" LUNA_PROBE_PORT=43129
export LUNA_PROBE_ROUTE="${LUNA_PROBE_ROUTE:-native-task}"
head_sha="${LUNA_FACTORY_HEAD_SHA:-${GITHUB_SHA:-unknown}}"
cp "$root/tests/fixtures/luna-factory-omp-probe-config.yml" "$config/omp.yml"
sed 's#43127#43129#g' "$root/tests/fixtures/luna-factory-omp-probe-models.yml" >"$config/models.yml"

write_result() {
  local status="$1" reason="${2:-}" evidence="${3:-$run_root}"
  printf '{"status":"%s","mode":"%s","headSha":"%s","reason":"%s","evidence":"%s"}\n' \
    "$status" "$mode" "$head_sha" "$reason" "$evidence" >"$result_file"
}
blocked() {
  write_result blocked "$1"
  cat "$result_file" >&2
  exit 78
}
failed() {
  write_result failed "$1"
  cat "$result_file" >&2
  exit 1
}

provider_pid=""
cleanup() {
  [[ -z "$provider_pid" ]] || kill "$provider_pid" 2>/dev/null || true
}
trap cleanup EXIT

command -v node >/dev/null 2>&1 || blocked "node unavailable for local fixture"
node "$root/tests/fixtures/luna-factory-omp-probe-server.mjs" >"$provider_log" 2>&1 &
provider_pid=$!

for attempt in {1..100}; do
  grep -Fq '{"ready":true' "$provider_log" && break
  kill -0 "$provider_pid" 2>/dev/null || failed "local fixture exited before readiness"
  sleep 0.1
done
grep -Fq '{"ready":true' "$provider_log" || failed "local fixture did not become ready"

probe_request='{"type":"prompt","message":"/factory -- LUNA_FACTORY_PROBE_ROOT: exercise one bounded Factory native task and stop after its returned result"}'
run_command() {
  local output="$1"
  shift
  command -v timeout >/dev/null 2>&1 || blocked "timeout unavailable for bounded OMP probe"
  if ! timeout --signal=TERM --kill-after=10s 180s "$@" <<<"$probe_request" >"$output" 2>&1; then
    failed "packaged OMP probe exited before completing; inspect $output"
  fi
}

case "$mode" in
native)
  binary="${OMP_BINARY:-omp}"
  command -v "$binary" >/dev/null 2>&1 || blocked "OMP binary unavailable"
  extension="${LUNA_FACTORY_EXTENSION_PATH:-$root/image/extension/luna-factory}"
  [[ -d "$extension" ]] || failed "Factory extension unavailable"
  run_command "$terminal_file" "$binary" --mode rpc-ui --no-skills --no-rules --no-pty \
    --config "$config/omp.yml" --extension "$extension"
  ;;
oci)
  image="${BLUEFIN_REVIEW_IMAGE:-localhost/review:luna-factory-dogfood}"
  command -v podman >/dev/null 2>&1 || blocked "podman unavailable"
  podman info >/dev/null 2>&1 || blocked "podman info unavailable"
  run_command "$terminal_file" podman run --rm --network host --entrypoint /usr/bin/omp \
    --env HOME=/home/bluefin \
    --env XDG_CONFIG_HOME=/home/bluefin/.config \
    --env XDG_STATE_HOME=/home/bluefin/.local/state \
    --env XDG_CACHE_HOME=/home/bluefin/.cache \
    --env LUNA_FACTORY_ENABLED=1 \
    --env LUNA_FACTORY_PROVIDER_URL=http://127.0.0.1:43129 \
    --env LUNA_PROBE_PORT=43129 \
    --env LUNA_PROBE_ROUTE="$LUNA_PROBE_ROUTE" \
    --env LUNA_FACTORY_HEAD_SHA="$head_sha" \
    --volume "$home:/home/bluefin:rw" \
    --volume "$state:/home/bluefin/.local/state:rw" \
    "$image" --mode rpc-ui --no-skills --no-rules --no-pty \
    --config /home/bluefin/.config/omp/omp.yml \
    --extension /usr/share/bluefin/review/luna-factory
  ;;
sif)
  sif="${BLUEFIN_REVIEW_FALLBACK_SIF:-}"
  [[ -n "$sif" ]] || blocked "generated SIF path unavailable"
  command -v apptainer >/dev/null 2>&1 || blocked "Apptainer unavailable"
  [[ -e "$sif" ]] || blocked "generated SIF missing"
  run_command "$terminal_file" apptainer exec --containall \
    --env HOME=/home/bluefin \
    --env XDG_CONFIG_HOME=/home/bluefin/.config \
    --env XDG_STATE_HOME=/home/bluefin/.local/state \
    --env XDG_CACHE_HOME=/home/bluefin/.cache \
    --env LUNA_FACTORY_ENABLED=1 \
    --env LUNA_FACTORY_PROVIDER_URL=http://127.0.0.1:43129 \
    --env LUNA_PROBE_PORT=43129 \
    --env LUNA_PROBE_ROUTE="$LUNA_PROBE_ROUTE" \
    --env LUNA_FACTORY_HEAD_SHA="$head_sha" \
    --bind "$home:/home/bluefin:rw" \
    --bind "$state:/home/bluefin/.local/state:rw" \
    "$sif" /usr/bin/omp --mode rpc-ui --no-skills --no-rules --no-pty \
    --config /home/bluefin/.config/omp/omp.yml \
    --extension /usr/share/bluefin/review/luna-factory
  ;;
esac

[[ -s "$terminal_file" ]] || failed "OMP terminal evidence missing"
grep -Fq '"factoryRoot":true' "$provider_log" || failed "OMP never entered the Factory tool surface"
for tool in luna_factory_open luna_factory_candidate luna_factory_attempt luna_factory_dispatch task; do
  grep -Fq "\"name\":\"$tool\"" "$provider_log" || failed "Factory tool call was not observed: $tool"
done
journal_file="$(find "$home" "$state" -type f -print0 2>/dev/null | xargs -0 grep -Il 'com.joshyorko.luna-factory.run' 2>/dev/null | head -n 1 || true)"
[[ -n "$journal_file" ]] || failed "Factory journal was not persisted by the packaged OMP run"
grep -Fq 'nativeResultIds' "$journal_file" || failed "native task returned without a persisted result identity"

write_result passed "" "$run_root"
cat "$result_file"
