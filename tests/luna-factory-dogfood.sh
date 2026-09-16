#!/usr/bin/env bash
# Exact-head, no-publish parent dogfood. Runtime capability failures are evidence.
set -euo pipefail
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
mode="${1:-native}"
case "$mode" in native|oci|sif) ;; --help|-h) printf 'usage: %s native|oci|sif\n' "$0"; exit 0 ;; *) printf 'usage: %s native|oci|sif\n' "$0" >&2; exit 2 ;; esac
run_root="${RUNNER_TEMP:-${TMPDIR:-/tmp}}/luna-factory-parent-$$"
mkdir -p -- "$run_root/state" "$run_root/home/config" "$run_root/home/cache"
chmod 700 "$run_root"
export HOME="$run_root/home" XDG_STATE_HOME="$run_root/state" XDG_CONFIG_HOME="$run_root/home/config" XDG_CACHE_HOME="$run_root/home/cache" LUNA_FACTORY_ENABLED=1 LUNA_PROBE_PORT=43129
cp "$root/tests/fixtures/luna-factory-omp-probe-config.yml" "$HOME/config/omp.yml"
sed 's#43127#43129#g' "$root/tests/fixtures/luna-factory-omp-probe-models.yml" > "$HOME/config/models.yml"
provider_pid=""
cleanup() { [[ -z "$provider_pid" ]] || kill "$provider_pid" 2>/dev/null || true; }
trap cleanup EXIT
node "$root/tests/fixtures/luna-factory-omp-probe-server.mjs" >"$run_root/provider.log" 2>&1 & provider_pid=$!
run_native() {
  local binary="${OMP_BINARY:-omp}"
  command -v "$binary" >/dev/null 2>&1 || { printf '{"status":"blocked","reason":"OMP binary unavailable"}\n' >&2; return 1; }
  export LUNA_PROBE_ROUTE="${LUNA_PROBE_ROUTE:-native-task}"
  printf '%s\n' '/factory status' | "$binary" --mode rpc-ui --config "$HOME/config/omp.yml" --extension "$root/image/extension/luna-factory" >"$run_root/terminal.txt" 2>&1 || { printf '{"status":"failed","reason":"native OMP exited"}\n' >&2; return 1; }
  [[ -s "$run_root/terminal.txt" ]] || { printf '{"status":"failed","reason":"terminal evidence missing"}\n' >&2; return 1; }
  compgen -G "$XDG_STATE_HOME/**/batch-*.json" >/dev/null 2>&1 || { printf '{"status":"failed","reason":"persisted batch evidence missing"}\n' >&2; return 1; }
}
case "$mode" in
  native) run_native ;;
  oci)
    image="${BLUEFIN_REVIEW_IMAGE:-review:parent-dogfood}"
    command -v podman >/dev/null 2>&1 || { printf '{"status":"blocked","reason":"podman unavailable"}\n' >&2; exit 1; }
    podman run --rm --network host -e HOME -e XDG_STATE_HOME -e XDG_CONFIG_HOME -e LUNA_FACTORY_ENABLED -v "$HOME/config:/home/bluefin/.config/omp:ro" -v "$XDG_STATE_HOME:/home/bluefin/.local/state" "$image" --mode rpc-ui --config /home/bluefin/.config/omp/omp.yml --extension /usr/share/bluefin/review/luna-factory >"$run_root/terminal.txt" 2>&1 || { printf '{"status":"failed","reason":"OCI launch failed"}\n' >&2; exit 1; }
    [[ -s "$run_root/terminal.txt" ]] || { printf '{"status":"failed","reason":"OCI terminal evidence missing"}\n' >&2; exit 1; }
    ;;
  sif)
    : "${BLUEFIN_REVIEW_FALLBACK_SIF:?set generated SIF path}"
    command -v apptainer >/dev/null 2>&1 || { printf '{"status":"blocked","reason":"Apptainer unavailable"}\n' >&2; exit 1; }
    apptainer exec --containall "$BLUEFIN_REVIEW_FALLBACK_SIF" /usr/bin/omp --mode rpc-ui --config /home/bluefin/.config/omp/omp.yml --extension /usr/share/bluefin/review/luna-factory >"$run_root/terminal.txt" 2>&1 || { printf '{"status":"failed","reason":"SIF launch failed"}\n' >&2; exit 1; }
    [[ -s "$run_root/terminal.txt" ]] || { printf '{"status":"failed","reason":"SIF terminal evidence missing"}\n' >&2; exit 1; }
    ;;
esac
printf '{"status":"observed","mode":"%s","evidence":"%s"}\n' "$mode" "$run_root"
