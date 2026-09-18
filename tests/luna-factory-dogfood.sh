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

run_root="${RUNNER_TEMP:-${TMPDIR:-/tmp}}/luna-factory-dogfood-$$-${mode}"
state="$run_root/state"
home="$run_root/home"
config="$home/.config/omp"
cache="$home/.cache"
models="$home/.omp/agent"
provider_log="$run_root/provider.log"
result_file="$run_root/result.json"
case "$mode" in
native) terminal_file="$run_root/native-terminal.jsonl" ;;
oci) terminal_file="$run_root/oci-terminal.jsonl" ;;
sif) terminal_file="$run_root/sif-terminal.jsonl" ;;
esac
mkdir -p -- "$state" "$config" "$cache" "$models"
chmod 0711 "$run_root"
# Rootless OCI maps the image's 65532 user to a different host uid. These are
# disposable, fixture-only directories; make the bind mounts writable without
# changing the image or the host container-engine storage.
chmod 0777 "$home" "$state" "$config" "$cache" "$models"
export LUNA_FACTORY_ENABLED=1 LUNA_FACTORY_PROVIDER_URL="http://127.0.0.1:43129" LUNA_PROBE_PORT=43129
export LUNA_PROBE_ROUTE="${LUNA_PROBE_ROUTE:-native-task}"
head_sha="${LUNA_FACTORY_HEAD_SHA:-${GITHUB_SHA:-}}"
cp "$root/tests/fixtures/luna-factory-omp-probe-config.yml" "$config/omp.yml"
sed 's#43127#43129#g' "$root/tests/fixtures/luna-factory-omp-probe-models.yml" >"$models/models.yml"

write_result() {
  local status="$1" reason="${2:-}" evidence="${3:-$run_root}"
  case "$status" in
  passed)
    printf '{"status":"passed","mode":"%s","headSha":"%s","reason":"%s","evidence":"%s"}\n' \
      "$mode" "$head_sha" "$reason" "$evidence" >"$result_file"
    ;;
  blocked | failed)
    printf '{"status":"%s","mode":"%s","headSha":"%s","reason":"%s","evidence":"%s"}\n' \
      "$status" "$mode" "$head_sha" "$reason" "$evidence" >"$result_file"
    ;;
  *)
    printf 'invalid dogfood result status: %s\n' "$status" >&2
    exit 2
    ;;
  esac
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

if [[ ! "$head_sha" =~ ^[0-9a-f]{40}$ ]]; then
  blocked "exact head identity unavailable"
fi

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

probe_request='{"id":"factory-probe","type":"prompt","message":"/factory -- LUNA_FACTORY_PROBE_ROOT: exercise one bounded Factory native task and stop after its returned result"}'
run_command() {
  local output="$1"
  shift
  command -v timeout >/dev/null 2>&1 || blocked "timeout unavailable for bounded OMP probe"
  local command_pid writer_fd
  # Use Bash's persistent coprocess pipe. The parent keeps the writable end
  # open for the full RPC session while the child receives a normal pipe on
  # stdin; this avoids FIFO/container stdin EOF behavior.
  coproc factory_rpc { timeout --signal=TERM --kill-after=10s 180s "$@" >"$output" 2>&1; }
  # Bash creates these coprocess variables dynamically; ShellCheck cannot see them.
  # shellcheck disable=SC2154
  command_pid=$factory_rpc_PID
  writer_fd=${factory_rpc[1]}

  cleanup_command() {
    exec {writer_fd}>&- 2>/dev/null || true
    kill "$command_pid" 2>/dev/null || true
    wait "$command_pid" 2>/dev/null || true
  }

  for _ in {1..1800}; do
    grep -Fq '"type":"ready"' "$output" && break
    if ! kill -0 "$command_pid" 2>/dev/null; then
      cleanup_command
      failed "packaged OMP probe exited before RPC ready; inspect $output"
    fi
    sleep 0.1
  done
  grep -Fq '"type":"ready"' "$output" || {
    cleanup_command
    failed "packaged OMP probe did not publish RPC ready; inspect $output"
  }

  for _ in {1..1800}; do
    grep -Fq '"type":"available_commands_update"' "$output" && break
    if ! kill -0 "$command_pid" 2>/dev/null; then
      cleanup_command
      failed "packaged OMP probe exited before RPC command discovery; inspect $output"
    fi
    sleep 0.1
  done
  grep -Fq '"type":"available_commands_update"' "$output" || {
    cleanup_command
    failed "packaged OMP probe did not publish RPC command discovery; inspect $output"
  }

  printf '%s\n' "$probe_request" >&"$writer_fd"
  for _ in {1..1800}; do
    # OMP 18.x marks terminal agent_end frames explicitly. The fallback for an
    # older packaged binary accepts the final agent_end when isTerminal is
    # omitted, but never treats an explicitly non-terminal frame as complete.
    if awk '/"type":"agent_end"/ { last=$0 } END { if (last == "") exit 1; if (last ~ /"isTerminal":false/) exit 1 }' "$output"; then
      break
    fi
    if ! kill -0 "$command_pid" 2>/dev/null; then
      cleanup_command
      failed "packaged OMP probe exited before the Factory prompt completed; inspect $output"
    fi
    sleep 0.1
  done
  awk '/"type":"agent_end"/ { last=$0 } END { if (last == "") exit 1; if (last ~ /"isTerminal":false/) exit 1 }' "$output" || {
    cleanup_command
    failed "packaged OMP probe did not reach a terminal agent_end; inspect $output"
  }

  exec {writer_fd}>&-
  if ! wait "$command_pid"; then
    failed "packaged OMP probe exited before completing; inspect $output"
  fi
}

case "$mode" in
native)
  export HOME="$home" XDG_STATE_HOME="$state" XDG_CONFIG_HOME="$home/.config" XDG_CACHE_HOME="$cache"
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
  run_command "$terminal_file" podman run --rm --interactive --network host \
    --userns keep-id:uid=65532,gid=65532 --entrypoint /usr/bin/omp \
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
    --home "$home:/home/bluefin" \
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
