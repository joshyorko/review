#!/usr/bin/env bash
set -euo pipefail

repo="${GITHUB_REPOSITORY:?GITHUB_REPOSITORY is required}"
expected_sha="${EXPECTED_SHA:?EXPECTED_SHA is required}"
event_ref="${EVENT_REF:?EVENT_REF is required}"

test "$repo" = joshyorko/review
test "$expected_sha" = "$(git rev-parse HEAD)"

owner="${repo%%/*}"
pull_count="$(gh api --method GET "repos/$repo/pulls" \
  --field "head=$owner:$event_ref" \
  --field state=open \
  --jq '[.[] | select(.head.sha == env.EXPECTED_SHA and
    .head.ref == env.EVENT_REF and
    .head.repo.full_name == env.GITHUB_REPOSITORY and
    .base.ref == "main")] | length')"
test "$pull_count" = 1
