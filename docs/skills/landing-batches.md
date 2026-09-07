---
name: landing-batches
version: "1.0"
last_updated: 2026-09-06
id: landing-batches
one_line_purpose: Manage multi-PR landing batches and automated fix-and-land agents.
entry_point: docs/skills/landing-batches.md
category: ci-ops
status: active
tags: [batches, landing, tui, agent, automerge]
description: "Manages batch landings, multi-repo lane partitioning, fix-and-land agents, and landing status persistence. Use when modifying batch execution or landing.py."
metadata:
  type: procedure
  context7-sources: [/websites/textual_textualize_io, /textualize/textual]
---

# Landing Batches

> The review dashboard coordinates parallel batch landings and automated
> fix-and-land subagents without blocking interactive maintainer triage.

## When to Use

Load this when editing `image/tui/landing.py`, modifying batch dispatching,
adjusting landing lane concurrency, or working with `${XDG_STATE_HOME}/bluefin-review/landings/`.

## When Not to Use

Do not load this for primary cockpit layout and key navigation (`review-dashboard.md`)
or cluster scale-out (`cluster-workers.md`).

## Core Architecture

1. **Selection & Confirmation:** `[b]` marks stops for batching; `[A]` opens
   `BatchPlanScreen` showing every selected PR and the exact agent command.
   Enter dispatches; Escape aborts.
2. **Multi-Repository Partitioning:** Multi-repo selections partition into
   independent per-repository `LandingTask` lanes.
3. **Concurrent Execution:** Up to `BLUEFIN_REVIEW_CONCURRENT_LANDINGS`
   (default 6) run concurrently across disjoint repository sets.
4. **Fix & Land:** From `ReviewScreen`, `[f]` dispatches a background
   fix-and-land agent (`new_fix_task`) seeded with evidenced review findings.
   `[F]` prompts for steering guidance before dispatching.
   `[$]` ("slay") executes the pipeline end-to-end: reviews if unreviewed,
   dispatches `new_fix_task` if findings exist, or enqueues batch landing if clean.
5. **State Directory:** State persists at `${XDG_STATE_HOME}/bluefin-review/landings/`.
   Each batch receives `.jsonl` events, `.log` output, and `.prompt.md`.
   Filenames qualify with `BLUEFIN_REVIEW_INSTANCE` to avoid cross-session collisions.
6. **Reporting Seam:** The landing agent never writes status directly; it calls:
   `/opt/bluefin/tui/.venv/bin/python /opt/bluefin/tui/landing.py report ...`
7. **Process Termination:** The agent runs in its own process group; `[x]` on
   the batch screen stops it cleanly via `SIGTERM`.

## Common Rationalizations

| Rationalization | Reality |
|---|---|
| "Let agents write JSONL directly." | Direct writes risk file corruption and concurrent races. Use `landing.py report`. |
| "Serialize all batches." | Repositories with disjoint dependencies can land safely in parallel. |

## Red Flags

- Shared state directory writes without instance-qualified batch IDs.
- Leaving agent process groups running after `[x]` stop requests.
- Mutating PRs without prior maintainer batch confirmation.

## Verification

```bash
python3 -m unittest discover -s tests -p "*test*landing*"
bash tests/dashboard-contract.sh
```
