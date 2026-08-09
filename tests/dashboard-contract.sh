#!/usr/bin/env bash
# Contract checks for the maintainer dashboard (image/tui/bluefin_review_tui.py).
#
# The dashboard carries the same authority contract as bluefin-review's queue
# walk: GitHub is authoritative, every mutation runs behind the typed-number
# confirmation gate, and the powers stay narrow. These are static assertions
# over the source plus a compile check; the Textual runtime itself is
# exercised in the image build (py_compile in the uv layer).
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
tui="$repo_root/image/tui/bluefin_review_tui.py"

python3 -m py_compile "$tui"

fail() {
  echo "FAIL: $1" >&2
  exit 1
}

# No protection bypass, no branch deletion, no direct merge, no force.
grep -q -- '--admin' "$tui" && fail "the dashboard must never bypass branch protections with --admin"
grep -q -- '--delete-branch' "$tui" && fail "the dashboard must never delete branches"
grep -q '"pr", "merge"' "$tui" && fail "the dashboard must never merge directly — Hive's governor sweep merges"
grep -qE '"push"|git push' "$tui" && fail "the dashboard must never push"

# Exactly two direct process executions exist: the read-only gh() helper and
# the gated executor inside mutate(). Every mutating verb must be an argument
# of self.mutate(), never of gh().
[[ "$(grep -c 'subprocess.run' "$tui")" -eq 2 ]] ||
  fail "expected exactly two subprocess.run sites (gh() reader and mutate() executor)"
if grep -nE 'gh\("pr", "(merge|close|comment|edit|review)"' "$tui"; then
  fail "mutating gh verbs must go through self.mutate(), not the gh() reader"
fi

# The gate is the typed pull request number: no y/yes, no timeout.
grep -q 'class ConfirmMutation' "$tui" || fail "the ConfirmMutation gate must exist"
grep -q 'ConfirmMutation(command, str(stop.number))' "$tui" ||
  fail "mutate() must confirm with the pull request number"
grep -qiE '\(y/n\)|yes/no' "$tui" && fail "no y/yes confirmation shortcut"

# Queueing goes through Hive's governor sweep: the exact approval body it
# re-verifies plus the lgtm label, and the only review submission is that
# approval inside the gated _queue_automerge helper.
grep -q 'for Hive auto-merge on green CI.' "$tui" ||
  fail "queueing must post the exact approval the sweep re-verifies"
grep -q '"--add-label", "lgtm"' "$tui" ||
  fail "queueing must add the lgtm label the sweep scans for"
[[ "$(grep -c '"pr", "review"' "$tui")" -eq 1 ]] ||
  fail "exactly one review-submission site: the Hive queue approval"

# Drafts are refused from live evidence, own work is filtered, and every
# mutation leaves a trace for the feedback loop and invalidates the cache.
grep -q 'isDraft' "$tui" || fail "merge must refuse drafts from live evidence"
grep -q 'self_login' "$tui" || fail "own-work filtering must exist"
grep -q 'trace(' "$tui" || fail "mutations must write the JSON trace"
grep -q 'pulls_cache.pop' "$tui" || fail "mutations must invalidate the pull cache"

# Tracked gaps are named as issues, not silent stubs.
grep -q 'GHOST_BUILD_ISSUE = "projectbluefin/review#' "$tui" ||
  fail "the ghost-build stub must name its tracking issue"
grep -q 'DOCS_UPDATE_ISSUE = "projectbluefin/review#' "$tui" ||
  fail "the docs-update stub must name its tracking issue"

# The handoff key is read-only: it copies through Textual's clipboard API
# (OSC 52) and never mutates.
grep -q 'def action_handoff' "$tui" || fail "the handoff action must exist"
handoff_body="$(sed -n '/def action_handoff/,/def action_resolve_cluster/p' "$tui")"
grep -q 'copy_to_clipboard' <<<"$handoff_body" ||
  fail "handoff must copy through the app clipboard (OSC 52)"
if grep -qE 'self\.mutate|subprocess' <<<"$handoff_body"; then
  fail "handoff must stay read-only: no mutation gate, no process execution"
fi

printf 'dashboard contract OK\n'
