---
name: final-review
version: "1.0"
last_updated: 2026-09-05
id: final-review
one_line_purpose: Run bounded fresh-context review and fix rounds after a batch lands.
entry_point: docs/skills/final-review.md
category: ci-ops
mcp_compliance_level: partial
optimization_status: draft
status: active
dependencies: [review-dashboard]
tags: [review, batch, rounds, models, breaker, cleanup]
description: "Defines the dashboard's final review-and-fix phase: one session policy, batch classification, fresh-context rounds with explicit models, a five-round breaker, and the cleanup gate."
metadata:
  type: policy
---

# Final Review

## When to Use

Use when changing what happens to a landing batch after every selected pull
request reaches a terminal outcome: the review policy gate, batch
classification, the review/fix rounds, the breaker, or the cleanup gate.

## The rounds

A landed batch is not a reviewed batch (#378). Once every selected pull
request holds a terminal outcome, the same lane runs a final review, a fix
round, then a fresh review, until the batch reads clean or blocked.

The policy is one session decision: `FinalPolicyScreen` is asked once before
the first dispatch, kept in memory only, and changed later with `[P]` —
**automatic** (Opus 5 for normal and mixed batches, Kimi K3 for
dependency/chore-only ones), **always Opus 5** (Opus reviews, K3 fixes), or
**always Kimi K3**. The gate states what a round may do — commit on the
batch's own already-selected branches — and may not: widen the selection,
remove a hold, use `--admin`, force-push, or bypass a required check.

`classify_batch` calls a batch `dependency` only when every pull request is a
Conventional Commit `chore`/`build` (`deps`, `deps-dev`) or carries the
`dependencies` label. Anything unrecognized is `mixed`, so an unreadable title
picks the thorough reviewer rather than the cheap one. Classification selects
a model and grants no authority.

Every round is a fresh process: asking one long-lived agent to review the work
it just wrote is how a review becomes a rubber stamp. The model rides in
explicitly — `final_environment` sets `GOOSE_MODEL`/`GOOSE_THINKING_EFFORT`
for Goose and, for Codex, whose model is a command-line flag rather than an
environment variable, `final_command` carries it instead. The launch-time
model is the maintainer's dashboard choice and is never a round's choice.

Rounds are `LandingTask`s with a `phase`, drained by the one existing lane:
same status file, log, process group, and `[x]`. There is no second queue and
no second selection authority. One drainer runs the lane (`landing_draining`),
because a round is enqueued from a finished task's callback and a second
drainer started there would run it twice.

`report --status … final --round N --phase … --model … --input-head …
--output-head …` writes each round into the batch record under the reserved
`final` key, and the record holds the breaker: a round past
`FINAL_ROUND_LIMIT` (five) is refused, a head that is not 40 hex characters is
refused before any write, and nothing may be written after
`final-review-clean` or `review-blocked` — a blocked batch is a maintainer's
to act on, not an agent's to walk back. A round that reports nothing blocks
the batch rather than being dispatched forever. `cleanup` is a gate: the batch
is incomplete until the transient material it owns is gone, and a cleanup that
cannot finish closes as `review-blocked`.
