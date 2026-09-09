#!/usr/bin/env bash
# Deterministic contract for the Review-owned host runtime bundle manager.
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
manager="$repo_root/scripts/review-runtime.sh"
scratch="$(mktemp -d)"
trap 'rm -rf "$scratch"' EXIT

root="$scratch/runtime/gvisor"
release="release-20260831.0"
bundle="$root/$release"
mkdir -p "$bundle/gvisor-bin"
printf '#!/usr/bin/env bash\nexit 0\n' >"$bundle/runsc"
printf '#!/usr/bin/env bash\nexit 0\n' >"$bundle/containerd-shim-runsc-v1"
printf 'bundle\n' >"$bundle/gvisor-bin/sentry"
chmod 0755 "$bundle/runsc" "$bundle/containerd-shim-runsc-v1" "$bundle/gvisor-bin/sentry" "$bundle/gvisor-bin"

path="$(BLUEFIN_REVIEW_RUNTIME_ROOT="$root" "$manager" path)"
[[ "$path" == "$bundle/runsc" ]] || {
  echo "wrong runtime path: $path" >&2
  exit 1
}
BLUEFIN_REVIEW_RUNTIME_ROOT="$root" "$manager" status >/dev/null
for action in status install update; do
  BLUEFIN_REVIEW_RUNTIME_ROOT="$root" just --justfile "$repo_root/justfile" review-runtime "$action" >/dev/null
done
[[ "$(BLUEFIN_REVIEW_RUNTIME_ROOT="$root" just --justfile "$repo_root/justfile" review-runtime path)" == "$bundle/runsc" ]] || {
  echo 'runtime recipe did not forward the path action' >&2
  exit 1
}
BLUEFIN_REVIEW_RUNTIME_ROOT="$root" "$manager" update >/dev/null
[[ "$(BLUEFIN_REVIEW_RUNTIME_ROOT="$root" "$manager" path)" == "$bundle/runsc" ]] || {
  echo 'runtime update changed the pinned path unexpectedly' >&2
  exit 1
}

mv "$bundle" "$root/real-release"
ln -s "$root/real-release" "$bundle"
if BLUEFIN_REVIEW_RUNTIME_ROOT="$root" "$manager" path >/dev/null 2>&1; then
  echo 'runtime path unexpectedly accepted a symlinked pinned release' >&2
  exit 1
fi
rm -f "$bundle"
mv "$root/real-release" "$bundle"

BLUEFIN_REVIEW_RUNTIME_ROOT="$root" just --justfile "$repo_root/justfile" review-runtime remove >/dev/null
[[ ! -e "$bundle" ]] || {
  echo 'runtime remove left the pinned bundle behind' >&2
  exit 1
}
if BLUEFIN_REVIEW_RUNTIME_ROOT="$root" "$manager" path >/dev/null 2>&1; then
  echo 'runtime path unexpectedly resolved after removal' >&2
  exit 1
fi

printf 'Review runtime contract OK\n'
