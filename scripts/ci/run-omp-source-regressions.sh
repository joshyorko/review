#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
omp_version="$(sed -n 's/^ARG OMP_VERSION=//p' "$repo_root/image/appliance/Containerfile")"
omp_commit="$(sed -n 's/^ARG OMP_SOURCE_COMMIT=//p' "$repo_root/image/appliance/Containerfile")"
test -n "$omp_version" && test -n "$omp_commit"
omp_source="${REVIEW_OMP_SOURCE:-}"
if [[ -z "$omp_source" ]]; then
  omp_temp="$(mktemp -d "${TMPDIR:-/tmp}/review-ci-omp.XXXXXX")"
  trap 'rm -rf -- "$omp_temp"' EXIT
  git clone --depth 1 --branch "v${omp_version}" \
    https://github.com/can1357/oh-my-pi.git "$omp_temp/source"
  omp_source="$omp_temp/source"
fi
test "$(git -C "$omp_source" rev-parse HEAD)" = "$omp_commit"
REVIEW_OMP_SOURCE="$omp_source" node --test \
  "$repo_root/tests/fixtures/issue-140-clipboard-truth.test.mjs"
if [[ -n "${OMP_SDK_NODE_MODULES:-}" && -x "$OMP_SDK_NODE_MODULES/.bin/tsx" ]]; then
  REVIEW_OMP_SOURCE="$omp_source" "$OMP_SDK_NODE_MODULES/.bin/tsx" --test \
    --test-name-pattern='packaged OMP current pin delivers and evicts' \
    "$repo_root/tests/omp-review-mode.test.ts"
else
  REVIEW_OMP_SOURCE="$omp_source" npx --yes tsx@4.21.0 --test \
    --test-name-pattern='packaged OMP current pin delivers and evicts' \
    "$repo_root/tests/omp-review-mode.test.ts"
fi
