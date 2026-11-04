#!/usr/bin/env bash
set -euo pipefail

fail() {
  echo "validate-release-source: BLOCKED $*" >&2
  exit 3
}
[[ $# -eq 3 ]] || {
  echo "usage: $0 <source-sha> <main-sha> <publish:true|false>" >&2
  exit 2
}
source_sha="$1"
main_sha="$2"
publish="$3"
[[ "$source_sha" =~ ^[0-9a-f]{40}$ && "$main_sha" =~ ^[0-9a-f]{40}$ ]] || fail 'source and main must be full lowercase commit SHAs'
[[ "$publish" == true || "$publish" == false ]] || fail 'publish must be true or false'
head_sha="$(git rev-parse --verify 'HEAD^{commit}' 2>/dev/null)" || fail 'checked-out source is not a commit'
remote_main_sha="$(git rev-parse --verify 'refs/remotes/origin/main^{commit}' 2>/dev/null)" || fail 'origin/main is unavailable'
[[ "$remote_main_sha" == "$main_sha" ]] || fail 'provided main SHA does not match origin/main'
[[ "$head_sha" == "$source_sha" ]] || fail 'source SHA does not match checked-out commit'
[[ -z "$(git status --porcelain=v1)" ]] || fail 'working tree is dirty'
if [[ "$publish" == true && "$source_sha" != "$main_sha" ]]; then
  fail 'publication requires the exact current main commit'
fi
printf 'validate-release-source: source=%s publish=%s\n' "$source_sha" "$publish"
