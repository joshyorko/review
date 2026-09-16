#!/usr/bin/env bash
# Finite Factory dogfood. Runs the real OMP binary with a deterministic local
# protocol fixture; packaged modes only add the existing OCI/SIF boundary.
set -euo pipefail
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
usage() { echo "usage: $0 native|oci|sif"; }
mode="${1:-}"
case "$mode" in native|oci|sif) ;; --help|-h) usage; exit 0 ;; *) usage >&2; exit 2 ;; esac
run_root="${RUNNER_TEMP:-${TMPDIR:-/tmp}}/luna-factory-dogfood-$$"
mkdir -p -- "$run_root"
chmod 700 "$run_root"
state="$run_root/state"; home="$run_root/home"; config="$home/config"; cache="$home/cache"
mkdir -p -- "$state" "$config" "$cache"
export HOME="$home" XDG_STATE_HOME="$state" XDG_CONFIG_HOME="$config" XDG_CACHE_HOME="$cache"
export LUNA_FACTORY_ENABLED=1 LUNA_FACTORY_PROVIDER_URL="http://127.0.0.1:43129" LUNA_PROBE_PORT=43129
cp "$root/tests/fixtures/luna-factory-omp-probe-config.yml" "$config/omp.yml"
sed 's#43127#43129#g' "$root/tests/fixtures/luna-factory-omp-probe-models.yml" > "$config/models.yml"
binary="${OMP_BINARY:-/home/bluefin/worktrees/.review-113-tools/omp-18.1.22}"
extension="${LUNA_FACTORY_EXTENSION_PATH:-$root/image/extension/luna-factory}"
[[ -x "$binary" ]] || { printf '%s\n' '{"status":"blocked","reason":"missing pinned OMP binary"}' >&2; exit 1; }
[[ -d "$extension" ]] || { printf '%s\n' '{"status":"blocked","reason":"missing Factory extension"}' >&2; exit 1; }
run_native() {
  bun "$root/tests/luna-factory-native-probe.ts" "$binary" "$extension" "$config/omp.yml" "$state"
  [[ -s "$state/native-terminal.jsonl" ]] || { printf '%s\n' '{"status":"failed","reason":"native terminal artifact missing"}' >&2; return 1; }
}
case "$mode" in
  native) run_native ;;
  oci)
    image="${BLUEFIN_REVIEW_IMAGE:-review:luna-factory-dogfood}"
    command -v podman >/dev/null 2>&1 || { printf '%s\n' '{"status":"blocked","reason":"podman unavailable"}' >&2; exit 1; }
    podman run --rm --network host -e HOME -e XDG_STATE_HOME -e XDG_CONFIG_HOME -e XDG_CACHE_HOME -e LUNA_FACTORY_ENABLED -v "$config:/home/bluefin/.config/omp:ro" -v "$state:/home/bluefin/.local/state" "$image" /usr/local/bin/omp --mode rpc-ui --config /home/bluefin/.config/omp/omp.yml --extension /usr/share/bluefin/review/luna-factory < /dev/null >"$state/oci-terminal.jsonl" 2>&1 || { printf '%s\n' '{"status":"failed","reason":"OCI native launch failed"}' >&2; exit 1; }
    [[ -s "$state/oci-terminal.jsonl" ]] || { printf '%s\n' '{"status":"failed","reason":"OCI terminal artifact missing"}' >&2; exit 1; }
    ;;
  sif)
    : "${BLUEFIN_REVIEW_FALLBACK_SIF:?set BLUEFIN_REVIEW_FALLBACK_SIF to generated brew bundle SIF}"
    command -v apptainer >/dev/null 2>&1 || { printf '%s\n' '{"status":"blocked","reason":"apptainer unavailable"}' >&2; exit 1; }
    [[ -e "$BLUEFIN_REVIEW_FALLBACK_SIF" ]] || { printf '%s\n' '{"status":"blocked","reason":"generated SIF missing"}' >&2; exit 1; }
    apptainer exec --containall "$BLUEFIN_REVIEW_FALLBACK_SIF" /usr/local/bin/omp --mode rpc-ui --extension /usr/share/bluefin/review/luna-factory < /dev/null >"$state/sif-terminal.jsonl" 2>&1 || { printf '%s\n' '{"status":"failed","reason":"SIF native launch failed"}' >&2; exit 1; }
    [[ -s "$state/sif-terminal.jsonl" ]] || { printf '%s\n' '{"status":"failed","reason":"SIF terminal artifact missing"}' >&2; exit 1; }
    ;;
esac
printf '{"status":"passed","mode":"%s","evidence":"%s"}\n' "$mode" "$state"
