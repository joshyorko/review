#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
omp_version="$(sed -n 's/^ARG OMP_VERSION=//p' "$repo_root/image/appliance/Containerfile")"
omp_commit="$(sed -n 's/^ARG OMP_SOURCE_COMMIT=//p' "$repo_root/image/appliance/Containerfile")"
test -n "$omp_version" && test -n "$omp_commit"
omp_source="$(mktemp -d "${TMPDIR:-/tmp}/review-ci-omp.XXXXXX")"
trap 'rm -rf -- "$omp_source"' EXIT

git clone --depth 1 --branch "v${omp_version}" \
  https://github.com/can1357/oh-my-pi.git "$omp_source/source"
test "$(git -C "$omp_source/source" rev-parse HEAD)" = "$omp_commit"
REVIEW_OMP_SOURCE="$omp_source/source" node --test \
  "$repo_root/tests/fixtures/issue-140-clipboard-truth.test.mjs"
REVIEW_OMP_SOURCE="$omp_source/source" npx --yes tsx@4.21.0 --test \
  --test-name-pattern='packaged OMP current pin delivers and evicts' \
  "$repo_root/tests/omp-review-mode.test.ts"
