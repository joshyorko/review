#!/usr/bin/env bash
set -euo pipefail

fail() { echo "verify-source-identity: $*" >&2; exit 3; }
[[ $# -eq 2 ]] || { echo "usage: $0 <commit-sha> <verified-source-directory>" >&2; exit 2; }
revision="$1"
verified_source="$2"
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
GIT_DIR="$work/repository.git" GIT_WORK_TREE="$PWD" git add -f -A -- .
if ! GIT_DIR="$work/repository.git" GIT_WORK_TREE="$PWD" git diff --cached --quiet "$revision" --; then
  fail 'source snapshot differs from its committed tree'
fi
mkdir -p "$verified_source"
GIT_DIR="$work/repository.git" GIT_WORK_TREE="$PWD" git archive "$revision" |
  tar -xf - -C "$verified_source"
[[ ! -e "$verified_source/.ci-history.bundle" ]] || fail 'verified source retained Git transport data'
printf 'verify-source-identity: revision=%s committed-tree=clean archive=git-archive\n' "$revision"
