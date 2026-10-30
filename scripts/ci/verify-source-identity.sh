#!/usr/bin/env bash
set -euo pipefail

fail() {
  echo "verify-source-identity: $*" >&2
  exit 3
}
[[ $# -eq 1 ]] || {
  echo "usage: $0 <commit-sha>" >&2
  exit 2
}
revision="$1"
[[ "$revision" =~ ^[0-9a-f]{40}$ ]] || fail 'revision must be a full lowercase commit SHA'
bundle="$PWD/.ci-history.bundle"
[[ -f "$bundle" && ! -L "$bundle" ]] || fail 'source snapshot must contain a regular Git history bundle'

bundle_head="$(git bundle list-heads "$bundle" | awk '$2 == "HEAD" { print $1 }')"
[[ "$bundle_head" == "$revision" ]] || fail 'bundle HEAD does not match the requested source revision'

work="$(mktemp -d "${TMPDIR:-/tmp}/review-source-identity.XXXXXX")"
trap 'rm -rf -- "$work"' EXIT
git clone --quiet --bare "$bundle" "$work/repository.git"
git --git-dir="$work/repository.git" cat-file -e "$revision^{commit}" || fail 'source revision is absent from the bundle'
git --git-dir="$work/repository.git" config core.bare false
git --git-dir="$work/repository.git" config core.worktree "$PWD"
GIT_DIR="$work/repository.git" GIT_WORK_TREE="$PWD" git read-tree "$revision"
rm -- "$bundle"
GIT_DIR="$work/repository.git" GIT_WORK_TREE="$PWD" git add -A -- .
if [[ -d .agents/skills/review-ci ]]; then
  GIT_DIR="$work/repository.git" GIT_WORK_TREE="$PWD" git add -f -- .agents/skills/review-ci
fi
if ! GIT_DIR="$work/repository.git" GIT_WORK_TREE="$PWD" git diff --cached --quiet "$revision" --; then
  fail 'source snapshot differs from its committed tree'
fi
printf 'verify-source-identity: revision=%s committed-tree=clean\n' "$revision"
