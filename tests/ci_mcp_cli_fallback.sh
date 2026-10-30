#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
skill="$repo_root/.agents/skills/review-ci/SKILL.md"
guide="$repo_root/docs/dagger-agent-tooling.md"
temporary="$(mktemp -d "${TMPDIR:-/tmp}/review-ci-mcp-fallback.XXXXXX")"
trap 'python3 -c '\''import shutil,sys; shutil.rmtree(sys.argv[1], ignore_errors=True)'\'' "$temporary"' EXIT

test -x "$repo_root/bin/ci"
test -f "$skill"
test -f "$guide"
grep -Fq 'bin/ci --profile contract' "$skill"
grep -Fq 'bin/ci --profile portable' "$skill"
grep -Fq 'bin/ci --profile pre-push --base' "$skill"
grep -Fq 'fresh sanitized snapshot' "$skill"
grep -Fq 'does not currently ship a tested' "$guide"

# A developer MCP registration must not autostart before a bounded adapter is
# implemented and verified. The shipped product MCP remains a separate owner.
test ! -e "$repo_root/.mcp.json"
test ! -e "$repo_root/.codex/config.toml"
if grep -En 'dagger.*mcp|mcp.*dagger' "$repo_root/image/extension/review/.mcp.json"; then
  echo 'Dagger development MCP leaked into the shipped Review MCP configuration' >&2
  exit 1
fi

# Exercise the real entrypoint across sequential edits without starting an
# engine. The fake CLI inspects the snapshot passed to each Dagger call and
# returns its exit status unchanged.
fixture="$temporary/repo"
fake_bin="$temporary/bin"
mkdir -p "$fixture/scripts/ci" "$fake_bin"
cp "$repo_root/bin/ci" "$fixture/bin-ci"
mkdir -p "$fixture/bin"
mv "$fixture/bin-ci" "$fixture/bin/ci"
cp "$repo_root/scripts/ci/source-snapshot.py" "$fixture/scripts/ci/source-snapshot.py"
printf 'first\n' >"$fixture/fixture.txt"
git -C "$fixture" init -q --initial-branch=main
git -C "$fixture" config user.name 'CI MCP fallback test'
git -C "$fixture" config user.email 'ci-mcp-fallback@example.invalid'
git -C "$fixture" add .
git -C "$fixture" commit -qm 'fixture baseline'

cat >"$fake_bin/dagger" <<'DAGGER'
#!/usr/bin/env bash
set -euo pipefail
if [[ "${1:-}" == version ]]; then
  echo 'dagger v0.21.11 (image://registry.dagger.io/engine:v0.21.11) linux/amd64'
  exit 0
fi
[[ "${1:-}" == call ]]
source_dir=''
for argument in "$@"; do
  case "$argument" in
    --source=*) source_dir="${argument#--source=}" ;;
  esac
done
[[ -n "$source_dir" ]]
cat "$source_dir/fixture.txt"
[[ "$(cat "$source_dir/fixture.txt")" != fail ]]
DAGGER
chmod +x "$fake_bin/dagger"

first_output="$(PATH="$fake_bin:$PATH" "$fixture/bin/ci" --profile contract)"
[[ "$first_output" == first ]]
printf 'second\n' >"$fixture/fixture.txt"
second_output="$(PATH="$fake_bin:$PATH" "$fixture/bin/ci" --profile contract)"
[[ "$second_output" == second ]]
printf 'fail\n' >"$fixture/fixture.txt"
if failure_output="$(PATH="$fake_bin:$PATH" "$fixture/bin/ci" --profile contract)"; then
  echo 'bin/ci reported success after the selected Dagger check failed' >&2
  exit 1
else
  status=$?
fi
[[ "$status" -eq 1 ]]
[[ "$failure_output" == fail ]]
