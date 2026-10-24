#!/usr/bin/env bash
# tests/check-commit-message.sh
#
# Contract tests for scripts/check-commit-message.sh (commit-msg CI-skip guard).
# GitHub skips every push-triggered workflow when the head commit message
# contains one of its skip directives anywhere in the message.
#
# Asserts:
# - Rejects each real CI-skip directive GitHub honors:
#   [skip ci], [ci skip], [no ci], [skip actions], [actions skip]
# - Rejects directives appearing anywhere in the message, including body lines
# - Rejects directives with internal whitespace/padding (e.g. [ skip ci ])
# - Rejects directives matched case-insensitively ([SKIP CI], [Ci Skip], etc.)
# - Accepts ordinary Conventional Commit messages
# - Accepts prose that mentions directive keywords without bracket form (e.g. skip-ci)
# - Honors ALLOW_SKIP_CI=1 escape hatch (and only exact "1")
# - Fails with usage when message file argument is missing
# - Validates pre-commit config hook stage wiring

set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
script="$repo_root/scripts/check-commit-message.sh"
precommit_config="$repo_root/.pre-commit-config.yaml"

tmpdir="$(mktemp -d)"
trap 'rm -rf "$tmpdir"' EXIT

fail=0
assert_fails() {
  local desc="$1" file="$2"
  shift 2
  if "$script" "$file" "$@" >/dev/null 2>&1; then
    echo "FAIL: expected failure: $desc" >&2
    fail=1
  fi
}

assert_passes() {
  local desc="$1" file="$2"
  shift 2
  if ! "$script" "$file" "$@" >/dev/null 2>&1; then
    echo "FAIL: expected success: $desc" >&2
    fail=1
  fi
}

# 1. Missing argument usage failure
if "$script" >/dev/null 2>&1; then
  echo "FAIL: expected failure on missing argument" >&2
  fail=1
fi

# 2. Reject each real CI-skip directive in subject
directives=(
  "skip ci"
  "ci skip"
  "no ci"
  "skip actions"
  "actions skip"
)

for directive in "${directives[@]}"; do
  msg_file="$tmpdir/msg_${directive// /_}.txt"
  printf 'feat: do something [%s]\n' "$directive" >"$msg_file"
  assert_fails "rejects subject with [$directive]" "$msg_file"

  # Case-insensitive
  msg_file_upper="$tmpdir/msg_upper_${directive// /_}.txt"
  printf 'feat: do something [%s]\n' "${directive^^}" >"$msg_file_upper"
  assert_fails "rejects uppercase [${directive^^}]" "$msg_file_upper"

  # Whitespace padding inside brackets
  msg_file_pad="$tmpdir/msg_pad_${directive// /_}.txt"
  printf 'feat: do something [  %s  ]\n' "$directive" >"$msg_file_pad"
  assert_fails "rejects padded [  $directive  ]" "$msg_file_pad"
done

# 3. Reject directive on body lines (not just subject)
body_msg="$tmpdir/msg_body.txt"
cat >"$body_msg" <<'EOF'
feat: add cool feature

This commit includes extra details in body.
[skip ci]
EOF
assert_fails "rejects directive in commit body" "$body_msg"

body_msg_no_ci="$tmpdir/msg_body_no_ci.txt"
cat >"$body_msg_no_ci" <<'EOF'
fix: resolve timing bug

Signed-off-by: Maintainer <maintainer@example.com>
[no ci]
EOF
assert_fails "rejects [no ci] in commit body footer" "$body_msg_no_ci"

# 4. Accept ordinary Conventional Commit messages
good_msg="$tmpdir/msg_good.txt"
cat >"$good_msg" <<'EOF'
feat(dashboard): add review queue filter

Explain the feature clearly in paragraphs without triggers.
EOF
assert_passes "accepts conventional commit message" "$good_msg"

# 5. Accept messages mentioning words without bracket form
prose_msg="$tmpdir/msg_prose.txt"
cat >"$prose_msg" <<'EOF'
docs: explain skip-ci and GitHub CI-skip directives

We mention skip ci and actions skip without brackets in prose.
Also reference [WIP] in brackets which is not a skip directive.
EOF
assert_passes "accepts prose mentioning keywords without bracket form" "$prose_msg"

# 6. Escape hatch: ALLOW_SKIP_CI=1 allows skip directive
skip_msg="$tmpdir/msg_skip.txt"
printf 'chore: release bump [skip ci]\n' >"$skip_msg"

ALLOW_SKIP_CI=1 assert_passes "allows skip directive when ALLOW_SKIP_CI=1" "$skip_msg"

# Non-1 values must NOT bypass the check
ALLOW_SKIP_CI=0 assert_fails "rejects skip directive when ALLOW_SKIP_CI=0" "$skip_msg"
ALLOW_SKIP_CI=true assert_fails "rejects skip directive when ALLOW_SKIP_CI=true" "$skip_msg"
ALLOW_SKIP_CI=yes assert_fails "rejects skip directive when ALLOW_SKIP_CI=yes" "$skip_msg"

# 7. Pre-commit hook stage wiring: must be staged at commit-msg
if ! grep -q 'id: check-commit-message' "$precommit_config"; then
  echo "FAIL: check-commit-message hook missing from .pre-commit-config.yaml" >&2
  fail=1
fi

if ! grep -A 5 'id: check-commit-message' "$precommit_config" | grep -q 'stages: \[commit-msg\]'; then
  echo "FAIL: check-commit-message hook not configured with stages: [commit-msg]" >&2
  fail=1
fi

if [[ $fail -ne 0 ]]; then
  echo "check-commit-message contract tests failed!" >&2
  exit 1
fi

echo "check-commit-message contract tests passed."
