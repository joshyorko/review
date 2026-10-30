#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
tool_dir="$(mktemp -d "${TMPDIR:-/tmp}/review-ci-cliff.XXXXXX")"
trap 'rm -rf -- "$tool_dir"' EXIT
bash "$repo_root/scripts/install-git-cliff.sh" "$tool_dir"
PATH="$tool_dir:$PATH" python3 "$repo_root/tests/review_changelog_test.py"
