#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
runner="$repo_root/bin/ci"

assert_blocked() {
  local label="$1"
  shift
  local output status
  set +e
  output="$("$runner" "$@" 2>&1)"
  status=$?
  set -e
  if [[ "$status" -ne 3 ]]; then
    echo "FAIL: $label returned $status, expected blocked status 3" >&2
    echo "$output" >&2
    exit 1
  fi
  grep -qi 'blocked' <<<"$output" || {
    echo "FAIL: $label did not explain the block" >&2
    exit 1
  }
}

assert_blocked "pre-push profile" --profile pre-push
assert_blocked "base selection on an explicit single profile" --profile contract --base origin/main
assert_blocked "ref selection" --profile contract --ref HEAD
assert_blocked "native requirement" --profile contract --require-native
assert_blocked "OS requirement" --profile contract --require-os ubuntu:26.04
assert_blocked "unavailable comparison base" --profile pre-push --base missing-base --plan-only
assert_blocked "release-plan does not accept a pre-push base" --profile release-plan --base origin/main

echo "CI runner reports missing subject and unsupported native gates as blocked."
