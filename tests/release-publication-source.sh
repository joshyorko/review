#!/usr/bin/env bash
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
guard="$root/scripts/validate-release-source.sh"
temporary="$(mktemp -d "${TMPDIR:-/tmp}/review-release-source.XXXXXX")"
trap 'rm -rf -- "$temporary"' EXIT
repo="$temporary/repo"
mkdir "$repo"
git -C "$repo" init -q --initial-branch=main
git -C "$repo" config user.name 'Release source contract'
git -C "$repo" config user.email 'release-source@example.invalid'
printf '0.1.7\n' >"$repo/VERSION"
git -C "$repo" add VERSION
git -C "$repo" commit -qm 'published base'
main_sha="$(git -C "$repo" rev-parse HEAD)"
git -C "$repo" update-ref refs/remotes/origin/main "$main_sha"

(
  cd "$repo"
  "$guard" "$main_sha" "$main_sha" true
)

git -C "$repo" switch -q -c candidate
printf 'candidate\n' >"$repo/README.md"
git -C "$repo" add README.md
git -C "$repo" commit -qm 'unpublished committed candidate'
candidate_sha="$(git -C "$repo" rev-parse HEAD)"
(
  cd "$repo"
  "$guard" "$candidate_sha" "$main_sha" false
)

assert_blocked() {
  local label="$1" output status
  shift
  set +e
  output="$(cd "$repo" && "$guard" "$@" 2>&1)"
  status=$?
  set -e
  [[ "$status" -eq 3 && "$output" == *BLOCKED* ]] || {
    printf 'FAIL: %s did not block (status=%s): %s\n' "$label" "$status" "$output" >&2
    exit 1
  }
}

assert_blocked 'valid version on a non-main commit' "$candidate_sha" "$main_sha" true
synthetic_sha="$(git -C "$repo" commit-tree "$(git -C "$repo" rev-parse 'HEAD^{tree}')" -p "$main_sha" -m 'unreferenced synthetic candidate')"
assert_blocked 'unreferenced synthetic commit SHA' "$synthetic_sha" "$main_sha" true

git -C "$repo" switch -q main
printf 'dirty\n' >"$repo/README.md"
assert_blocked 'dirty version with a valid published source SHA' "$main_sha" "$main_sha" true

echo 'Release source guard accepts exact committed candidates and blocks synthetic, stale-publication, and dirty sources.'
