#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
tool_dir="${REVIEW_CI_TOOLS_DIR:-}"
if [[ -z "$tool_dir" ]]; then
  tool_dir="$(mktemp -d "${TMPDIR:-/tmp}/review-ci-cliff.XXXXXX")"
  trap 'rm -rf -- "$tool_dir"' EXIT
  bash "$repo_root/scripts/install-git-cliff.sh" "$tool_dir"
fi
PATH="$tool_dir:$PATH" python3 "$repo_root/tests/review_changelog_test.py"
