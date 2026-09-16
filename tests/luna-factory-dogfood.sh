#!/usr/bin/env bash
# Finite, no-publish packaged Factory dogfood. OCI and SIF are explicit modes.
set -euo pipefail
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
if [[ "${1:-}" == "--help" || "${1:-}" == "-h" ]]; then
  echo "usage: $0 [oci|sif]"
  exit 0
fi
mode="${1:-oci}"
work="${RUNNER_TEMP:-$root/.tmp}/luna-factory-dogfood"
mkdir -p "$work"; chmod 700 "$work"
case "$mode" in
oci)
  image="${BLUEFIN_REVIEW_IMAGE:-review:test}"
  state="$work/state"; home="$work/home"; mkdir -p "$state" "$home"
  export HOME="$home" XDG_STATE_HOME="$state" XDG_CONFIG_HOME="$home/config" XDG_CACHE_HOME="$home/cache"
  export LUNA_FACTORY_ENABLED=1 LUNA_FACTORY_PROVIDER_URL="http://127.0.0.1:43129"
  node "$root/tests/fixtures/luna-factory-omp-probe-server.mjs" --port 43129 >"$work/provider.log" 2>&1 & provider=$!
  trap 'kill "$provider" 2>/dev/null || true' EXIT
  podman run --rm --network host -e HOME -e XDG_STATE_HOME -e XDG_CONFIG_HOME -e XDG_CACHE_HOME -e LUNA_FACTORY_ENABLED -e LUNA_FACTORY_PROVIDER_URL -v "$state:/home/bluefin/.local/state" "$image" --help >"$work/oci-terminal.txt"
  grep -Fq "Appliance lifecycle" "$work/oci-terminal.txt" || { echo "OCI terminal evidence missing" >&2; exit 1; }
  ;;
sif)
  : "${BLUEFIN_REVIEW_FALLBACK_SIF:?set BLUEFIN_REVIEW_FALLBACK_SIF to the brew-dev SIF}"
  if [[ ! -e /dev/fuse ]]; then echo "blocked-by-runner-capability: /dev/fuse"; exit 0; fi
  export HOME="$work/home" XDG_STATE_HOME="$work/state" LUNA_FACTORY_ENABLED=1
  mkdir -p "$HOME" "$XDG_STATE_HOME"
  apptainer exec --containall "$BLUEFIN_REVIEW_FALLBACK_SIF" /usr/bin/omp --version >"$work/sif-terminal.txt" || { echo "blocked-by-runner-capability: SIF execution"; exit 0; }
  ;;
*) echo "usage: $0 [oci|sif]" >&2; exit 2;;
esac
