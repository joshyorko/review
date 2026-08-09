#!/usr/bin/env bash
# Behavioral contract for image/bin/worktree-guard: ephemeral worktree, strict
# hygiene, preserved exit codes, removal from outside the worktree.
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
guard="$repo_root/image/bin/worktree-guard"

scratch="$(mktemp -d)"
trap 'rm -rf "$scratch"' EXIT

fail() {
  echo "FAIL: $1" >&2
  exit 1
}

git init -q "$scratch/repo"
cd "$scratch/repo"
git -c user.email=t@t -c user.name=t -c core.hooksPath=/dev/null \
  commit -q --allow-empty -m "chore: seed"

# A clean run passes through with status 0 and leaves no worktree behind.
"$guard" -- bash -c 'test -f .git' 2>/dev/null || fail "clean run must exit 0 inside a worktree"
[[ "$(git worktree list | wc -l)" -eq 1 ]] || fail "the worktree must be removed after a clean run"

# The command runs in the ephemeral worktree, never the caller's checkout.
# shellcheck disable=SC2016 # $PWD is for the guarded shell, the path is spliced in
"$guard" -- bash -c 'test "$PWD" != "'"$scratch/repo"'"' 2>/dev/null ||
  fail "the command must run inside the ephemeral worktree"

# Litter fails the run, is reported, and never reaches the real checkout.
set +e
out="$("$guard" -- bash -c 'echo trash > trash.txt' 2>&1)"
status=$?
set -e
[[ "$status" -eq 1 ]] || fail "a littering run must fail with status 1 (got $status)"
[[ "$out" == *'left the worktree dirty'* ]] || fail "litter must be reported"
[[ "$out" == *'trash.txt'* ]] || fail "the report must name the litter"
[[ ! -e trash.txt ]] || fail "litter must never reach the caller's checkout"
[[ "$(git worktree list | wc -l)" -eq 1 ]] || fail "the worktree must be removed after a littering run"

# The agent's own failure code is preserved, clean or dirty.
set +e
"$guard" -- bash -c 'exit 7' 2>/dev/null
[[ $? -eq 7 ]] || fail "a failing agent's exit code must be preserved"
"$guard" -- bash -c 'echo x > f && exit 7' >/dev/null 2>&1
[[ $? -eq 7 ]] || fail "hygiene failure must never mask the agent's own failure code"
set -e

# Tracked-file modifications are litter too.
git -c user.email=t@t -c user.name=t -c core.hooksPath=/dev/null \
  commit -q --allow-empty -m "chore: more" >/dev/null 2>&1 || true
printf 'content\n' >tracked.txt
git add tracked.txt
git -c user.email=t@t -c user.name=t -c core.hooksPath=/dev/null \
  commit -q -m "chore: tracked"
set +e
"$guard" -- bash -c 'echo edited >> tracked.txt' >/dev/null 2>&1
status=$?
set -e
[[ "$status" -eq 1 ]] || fail "modifying a tracked file must fail hygiene (got $status)"
[[ "$(cat tracked.txt)" == "content" ]] || fail "the caller's tracked file must be untouched"

# Outside a repository the guard refuses with its own diagnostic.
set +e
out="$(cd "$scratch" && "$guard" -- true 2>&1)"
status=$?
set -e
[[ "$status" -eq 2 ]] || fail "a non-repository must be refused with status 2"
[[ "$out" == *'not a git repository'* ]] || fail "the refusal must say why"

printf 'worktree-guard contract OK\n'
