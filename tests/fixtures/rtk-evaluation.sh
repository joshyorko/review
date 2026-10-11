#!/usr/bin/env bash
# Bounded, offline RTK value/fidelity fixture for Review issue #167.
# Run only with an explicitly selected private RTK binary; this never installs
# RTK, runs `rtk init`, or reads/writes the operator's home directory.
set -euo pipefail

fail() {
  echo "rtk-evaluation: $*" >&2
  exit 1
}

[[ -n "${RTK_BIN:-}" ]] || fail 'set RTK_BIN to the private test artifact path'
[[ -x "$RTK_BIN" ]] || fail "RTK_BIN is not executable: $RTK_BIN"
rtk_bin="$(realpath "$RTK_BIN")"
[[ -n "${RTK_EVAL_OUTPUT_DIR:-}" ]] || fail 'set RTK_EVAL_OUTPUT_DIR to a fresh private evidence directory'
[[ "$RTK_EVAL_OUTPUT_DIR" == /* && "$RTK_EVAL_OUTPUT_DIR" != / ]] ||
  fail 'RTK_EVAL_OUTPUT_DIR must be an absolute non-root path'
[[ ! -e "$RTK_EVAL_OUTPUT_DIR" && ! -L "$RTK_EVAL_OUTPUT_DIR" ]] ||
  fail "refusing to overwrite existing evidence directory: $RTK_EVAL_OUTPUT_DIR"
[[ -d "$(dirname "$RTK_EVAL_OUTPUT_DIR")" ]] ||
  fail 'RTK_EVAL_OUTPUT_DIR parent directory must already exist'
mkdir -m 0700 -- "$RTK_EVAL_OUTPUT_DIR"
tmp="$(realpath "$RTK_EVAL_OUTPUT_DIR")"
exec >"$tmp/runner.log" 2>&1

mkdir -p "$tmp/home" "$tmp/config" "$tmp/data" "$tmp/state" "$tmp/cases" "$tmp/bin" "$tmp/poison"
export HOME="$tmp/home" XDG_CONFIG_HOME="$tmp/config" XDG_DATA_HOME="$tmp/data" XDG_STATE_HOME="$tmp/state"
export RTK_TELEMETRY_DISABLED=1
cat >"$tmp/poison/rtk" <<'POISONED_RTK'
#!/usr/bin/env bash
echo 'ERROR: poisoned inherited rtk was invoked' >&2
exit 99
POISONED_RTK
chmod 0700 "$tmp/poison/rtk"
ln -s -- "$rtk_bin" "$tmp/bin/rtk"
export PATH="$tmp/poison:$PATH"
export PATH="$tmp/bin:$PATH"
resolved_rtk="$(command -v rtk)"
[[ "$resolved_rtk" == "$tmp/bin/rtk" ]] || fail "private RTK was not first in PATH: $resolved_rtk"
[[ "$(rtk --version)" == "$("$rtk_bin" --version)" ]] ||
  fail 'PATH-resolved RTK version did not match RTK_BIN'
echo "rtk-evaluation: private RTK resolved before poisoned PATH entry: $resolved_rtk"
echo "rtk-evaluation: HOME=$HOME XDG_CONFIG_HOME=$XDG_CONFIG_HOME XDG_DATA_HOME=$XDG_DATA_HOME XDG_STATE_HOME=$XDG_STATE_HOME RTK_TELEMETRY_DISABLED=$RTK_TELEMETRY_DISABLED"

mkdir -p "$tmp/repo"

repo="$tmp/repo"
cd "$repo"
git init -q
git config user.name 'RTK evaluation fixture'
git config user.email 'rtk-fixture@example.invalid'
for n in {1..8}; do
  printf 'fixture commit %02d\n' "$n" >"history-$n.txt"
  git add "history-$n.txt"
  fixture_date="$(printf '2026-01-01T00:00:%02dZ' "$((n + 10))")"
  GIT_AUTHOR_DATE="$fixture_date" GIT_COMMITTER_DATE="$fixture_date" \
    git commit -q -m "FIXTURE_COMMIT_$n"
done
printf 'modified fixture\n' >>history-8.txt
for n in {1..12}; do printf 'untracked fixture %02d\n' "$n" >"untracked-$n.txt"; done
printf '{"items":[{"id":1,"title":"fixture one"},{"id":2,"title":"fixture two"}]}\n' >fixture.json
printf '%s\n' 'diff fixture line one' 'diff fixture line two' >evidence.txt
git add fixture.json evidence.txt
git commit -q -m FIXTURE_EVIDENCE
printf '%s\n' 'diff fixture line two changed' >>evidence.txt

run_case() {
  local name="$1" command="$2" expected="$3" mode="$4"
  local raw="$tmp/cases/$name.raw" filtered="$tmp/cases/$name.filtered"
  local raw_rc filtered_rc rewrite_rc rewritten start end raw_ms filtered_ms rerun_ms=0 rerun=0
  start="$(date +%s%N)"
  set +e
  bash -c "$command" >"$raw" 2>&1
  raw_rc=$?
  set -e
  end="$(date +%s%N)"
  raw_ms=$(((end - start) / 1000000))

  if [[ "$mode" == raw || ("$mode" == disabled && "${RTK_DISABLED:-0}" == 1) ]]; then
    start="$(date +%s%N)"
    set +e
    if [[ "$mode" == disabled ]]; then
      RTK_DISABLED=1 bash -c "$command" >"$filtered" 2>&1
    else
      bash -c "$command" >"$filtered" 2>&1
    fi
    filtered_rc=$?
    set -e
    end="$(date +%s%N)"
    filtered_ms=$(((end - start) / 1000000))
  else
    start="$(date +%s%N)"
    set +e
    if [[ "$mode" == disabled ]]; then
      rewrite_rc=1
      rewritten="$command"
    else
      rewritten="$("$rtk_bin" rewrite "$command" 2>/dev/null)"
      rewrite_rc=$?
    fi
    set -e
    if [[ "$rewrite_rc" == 0 || "$rewrite_rc" == 3 ]] && [[ -n "$rewritten" ]]; then
      command="$rewritten"
    fi
    set +e
    bash -c "$command" >"$filtered" 2>&1
    filtered_rc=$?
    set -e
    end="$(date +%s%N)"
    filtered_ms=$(((end - start) / 1000000))
  fi

  local missing=0
  if [[ -n "$expected" ]] && ! grep -Fq -- "$expected" "$filtered"; then
    missing=1
    rerun=1
    # Match the practical fallback cost: the operator requests full raw output.
    start="$(date +%s%N)"
    set +e
    RTK_DISABLED=1 bash -c "$2" >"$tmp/cases/$name.rerun" 2>&1
    local rerun_rc=$?
    set -e
    end="$(date +%s%N)"
    rerun_ms=$(((end - start) / 1000000))
    ((rerun_rc == raw_rc)) || fail "$name raw rerun changed exit status"
  fi
  [[ "$raw_rc" == "$filtered_rc" ]] || fail "$name changed exit code raw=$raw_rc filtered=$filtered_rc"
  if [[ "$name" == json || "$name" == full-diff ]]; then
    cmp -s -- "$raw" "$filtered" || fail "$name was not byte-identical to raw output"
  fi
  local raw_bytes filtered_bytes
  raw_bytes="$(wc -c <"$raw")"
  filtered_bytes="$(wc -c <"$filtered")"
  printf '%s\traw_bytes=%s\tfiltered_bytes=%s\traw_exit=%s\tfiltered_exit=%s\traw_ms=%s\tfiltered_ms=%s\tmissing_signal=%s\traw_rerun=%s\traw_rerun_ms=%s\n' \
    "$name" "$raw_bytes" "$filtered_bytes" "$raw_rc" "$filtered_rc" "$raw_ms" "$filtered_ms" "$missing" "$rerun" "$rerun_ms"
}

echo "rtk-evaluation: binary=$rtk_bin version=$(rtk --version)"
run_case git-status 'git status --short --branch' 'history-8.txt' rewrite
run_case git-log 'git log --oneline -8' 'FIXTURE_COMMIT_8' rewrite
run_case json 'cat fixture.json' '"items"' rewrite
python3 -m json.tool "$tmp/cases/json.raw" >/dev/null
RTK_DISABLED=1 run_case full-diff 'git diff -- evidence.txt' 'diff fixture line two changed' disabled
run_case successful-validator "for n in {1..20}; do printf 'validator check %02d: passed\\n' \"\$n\"; done; exit 0" 'validator check 20: passed' rewrite
run_case noisy-failure "for n in {1..20}; do printf 'test case %02d: passed\\n' \"\$n\"; done; printf '%s\\n' 'FIXTURE_FAILURE: expected marker'; exit 7" 'FIXTURE_FAILURE: expected marker' rewrite

echo 'rtk-evaluation: RTK local savings estimate (not a billing measure)'
"$rtk_bin" gain

echo "rtk-evaluation: raw/filtered outputs, fixture repository, and command log retained in $tmp"
