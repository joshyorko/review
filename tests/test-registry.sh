#!/usr/bin/env bash
# tests/test-registry.sh
#
# Every executable test under tests/ must be reachable from
# `.github/workflows/validate.yml`, either directly or through a test runner the
# workflow names. This prevents focused contracts from being committed without
# ever running in CI.

set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
workflow="$repo_root/.github/workflows/validate.yml"
tests_dir="$repo_root/tests"

failures=0
fail() {
  printf 'test registry: %s\n' "$1" >&2
  failures=$((failures + 1))
}

[[ -f "$workflow" ]] || {
  fail "missing workflow: $workflow"
  exit 1
}

# A test is "reachable" when the workflow names it, or when a named test runner
# invokes it. One hop covers this repository's shell-wrapper structure.
declare -a roots=()
while IFS= read -r name; do
  roots+=("$name")
done < <(
  grep -oE 'tests/[A-Za-z0-9_.-]+\.(sh|py|mjs|test\.ts)' "$workflow" | sed 's|^tests/||' | sort -u
)

# Dagger owns tests through verifier-approved step IDs in ci/suites.json. Resolve
# those IDs against its closed Go step map so the registry follows the actual
# invoked test files rather than YAML comments or descriptive labels.
dagger_roots="$(python3 - "$repo_root" <<'PY'
import json
import re
import sys
from pathlib import Path

root = Path(sys.argv[1])
suites = json.loads((root / "ci/suites.json").read_text())
module = (root / ".dagger/main.go").read_text()
step_pattern = re.compile(r'"([a-z0-9-]+)"\s*:\s*"([^"\n]+)"')
steps = dict(step_pattern.findall(module))
roots = set()
for profile, selected in suites["profiles"].items():
    for step in selected:
        command = steps.get(step)
        if command is None:
            raise SystemExit(f"suite profile {profile!r} names unmapped Dagger step {step!r}")
        match = re.search(r'(?:^|\s)(tests/[A-Za-z0-9_.-]+\.(?:sh|py|mjs|test\.ts))(?:\s|$)', command)
        if match:
            roots.add(Path(match.group(1)).name)
for name in sorted(roots):
    print(name)
PY
)" || {
  fail "Dagger suite manifest cannot be resolved through .dagger/main.go"
  exit 1
}
while IFS= read -r name; do
  [[ -n "$name" ]] && roots+=("$name")
done <<<"$dagger_roots"

((${#roots[@]} > 0)) || fail "validate.yml names no test files at all"

is_referenced_by_roots() {
  local target="$1" root
  for root in "${roots[@]}"; do
    [[ "$root" == "$target" ]] && return 0
    [[ -f "$tests_dir/$root" ]] || continue
    grep -qF "tests/$target" "$tests_dir/$root" && return 0
  done
  return 1
}

checked=0
while IFS= read -r path; do
  name="$(basename "$path")"
  # Fixtures and shared helpers are data, not suites.
  case "$name" in
  __init__.py | conftest.py) continue ;;
  esac
  checked=$((checked + 1))
  is_referenced_by_roots "$name" ||
    fail "tests/$name is never executed by .github/workflows/validate.yml"
done < <(find "$tests_dir" -maxdepth 1 -type f \( -name '*.py' -o -name '*.sh' -o -name '*.mjs' -o -name '*.test.ts' \) | sort)

# A root that names a file which does not exist is the same defect inverted:
# CI would fail late, or the reference silently rots.
for root in "${roots[@]}"; do
  [[ -f "$tests_dir/$root" ]] ||
    fail "validate.yml runs tests/$root, which does not exist"
done

if ((failures > 0)); then
  printf 'test registry: %d problem(s) across %d test file(s)\n' \
    "$failures" "$checked" >&2
  exit 1
fi

printf 'test registry OK: %d test files, all reachable from validate.yml\n' \
  "$checked"
