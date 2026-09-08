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

## When NOT to Use

Do not use this for the initial landing agent, repository mutation gates, or
the dashboard queue scheduler; those belong to `review-dashboard`.

## Core Process

1. Start only after every selected pull request has a terminal landing state.
2. Run each review, fix, re-review, and cleanup phase as a fresh process.
3. Keep the batch scope, status record, explicit model, and five-round breaker
   intact across every transition.
4. End only with `final-review-clean` or `review-blocked`.

## The rounds

A landed batch is not a reviewed batch (#378). Once every selected pull
request holds a terminal outcome, the same lane runs a final review, a fix
round, then a fresh review, until the batch reads clean or blocked.

The policy is one session decision: `FinalPolicyScreen` is asked once before
the first dispatch, kept in memory only, and changed later with `[P]` —
**automatic** (Gemini Flash by default, K3 for dependency/chore-only batches
and all fixes), **always Gemini Flash**, **always Opus 5**, **always GPT Sol**,
or **always Kimi K3**. The gate states what a round may do — commit on the
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

Rounds are `LandingTask`s with a `phase`, drained by the existing
repository-aware dispatcher: same status file, log, process group, and `[x]`.
There is no second queue and no second selection authority. One dispatcher
owns scheduling (`landing_draining`), because a round is enqueued from a
finished task's callback and a second dispatcher started there would run it
twice.

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

## Common Rationalizations

- "The reviewer can also fix its own findings." Fresh processes prevent review
  from becoming a rubber stamp.
- "A missing round result can be retried forever." A missing result blocks the
  batch so a broken agent cannot create an unbounded loop.
- "The round can widen the selection." The maintainer's confirmed batch is the
  only authority scope.

## Red Flags

- A round runs in the same process that changed the branch.
- A model is inherited implicitly from the dashboard launch environment.
- A round writes after a terminal final phase or exceeds five rounds.
- A final-review task uses a second queue or bypasses the repository-aware
  landing dispatcher.

## Verification

- All selected pull requests have terminal landing states before dispatch.
- Each round has a fresh process, explicit model, bounded phase, and durable
  status record.
- The record rejects invalid heads, post-terminal writes, and round six.
- The pilot covers clean, fixing, re-review, cleanup, blocked, and no-result
  outcomes.
