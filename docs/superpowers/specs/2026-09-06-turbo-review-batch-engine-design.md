# Turbo Review v2 — Parallel Batch Review Engine

**Date:** 2026-09-06
**Status:** Approved design, pending implementation plan
**Lifecycle:** This spec is a working artifact. Per repository documentation
doctrine, it is deleted in the final change of the batch that implements it;
durable knowledge moves to `docs/skills/`.

## Problem

`turbo-review` does not perform mass review. It best-effort scales generic
Hive contributor workers (which process their own Hive-assigned authoring
tasks, not the maintainer's queue), swallows every cluster failure, then opens
a dashboard that reviews one PR at a time. There is no review fan-out, no
result collection, no cache, no triage state, and no bulk verdict. Batch
support exists only for *landing* (`A`). Issues #372 and #362 already name
the throughput gap.

## Goals

- One maintainer sitting clears multiple batches of 5–10 PRs; total
  throughput is the success metric.
- Hybrid workflow: pre-annotated rapid triage plus bulk actions on a
  selection.
- One review subagent per PR, N PRs reviewed in parallel.
- Review evidence cached by PR + head SHA; unchanged heads annotate
  instantly.
- Concurrency sized to real machine headroom; offload to Kubernetes when a
  context is present so the local machine never crushes itself.
- Moderate simplification: internals get leaner; model profiles, skill
  generation, and `review-container` are untouched.

## Non-goals

- Cluster-required review. The engine is fully functional with zero cluster.
- Changing Hive contributor scale-out semantics (workers remain independent
  Hive contributors).
- Weakening mutation gates. Merge keeps its per-PR typed confirmation.
- Auto-merge or auto-approve. Verdicts are evidence; the human decides.

## Architecture

```
ReviewDashboard
  ├── selection (b/B/Space)         queue rows, verdict badges, triage state
  ├── ReviewEngine (new)            image/tui/review_engine.py
  │     ├── scheduler               cloned from landing scheduler pattern
  │     │                           (JSONL state, concurrency cap; no repo
  │     │                           lanes — reviews are read-only)
  │     ├── LocalExecutor           subprocess `bluefin-review` per PR,
  │     │                           slots granted by HeadroomGovernor
  │     ├── K8sExecutor             same review command in a pod on the
  │     │                           review image in bluefin-system; results
  │     │                           collected from pod logs; any failure
  │     │                           falls back to LocalExecutor
  │     └── ReviewCache             ~/.local/state/bluefin-review/reviews/
  └── existing landing lane (A/w)   unchanged
```

### ReviewEngine

- Input: a set of queue stops (`owner/repo#number@head_sha`), from the
  current selection or all visible rows.
- Per PR it runs the same engine `ReviewScreen` uses today —
  `bluefin-review` with the image-owned check scope (five check subagents) —
  producing a `ReviewResult`.
- Scheduler state is JSONL in the state directory, mirroring the landing
  lane's proven torn-tail/flock/idempotent-terminal handling.
- A subagent failure marks that row failed and retryable; it never blocks
  other PRs in the batch.

### Executor seam

- `LocalExecutor` (default): spawns subprocesses; asks the
  `HeadroomGovernor` for a slot before each spawn.
- `K8sExecutor` (optional): selected automatically when a usable Kubernetes
  context is present (e.g. after `turbo-review` verified one). Runs the
  identical review command in a pod using the published review image in the
  `bluefin-system` namespace, reads the compact result JSON from pod logs,
  and writes it into the same local cache. Dispatch or collection failure
  falls back to `LocalExecutor` for that PR and is reported as a note, never
  a block. Concurrency cap is `REVIEW_SCALE` (default 3).
- Doctrine holds: the appliance depends on no cluster; declining, absence,
  or failure of the k8s path leaves everything working locally.

### HeadroomGovernor

- Local concurrency = `clamp(min(floor(MemAvailable / per_review_budget),
  cores // 2), 1, BLUEFIN_REVIEW_CONCURRENT_REVIEWS)` with a default cap of
  4 and a per-review memory budget default of 1.5 GiB
  (`BLUEFIN_REVIEW_MEM_BUDGET_MB` overrides).
- Re-evaluated before every dispatch slot: if headroom drops below the
  floor, new spawns pause; running reviews are never killed.
- Reads `/proc/meminfo` (`MemAvailable`) and `os.cpu_count()`; injectable
  for tests.

### ReviewCache

- Path: `${XDG_STATE_HOME:-~/.local/state}/bluefin-review/reviews/`
  `<owner>__<repo>__<number>__<head-sha>.json`.
- Content: the compact `ReviewResult` (verdict, bounded findings, engine
  provenance, timestamp). Transcript stored capped (caveman contract).
- Hit (exact head SHA) short-circuits dispatch and annotates instantly; a
  new head is a natural miss. Corrupt cache file = miss.
- Pruned after seven days, same policy as landings.

## Dashboard UX

- `r` is context-aware: empty selection → today's single-PR `ReviewScreen`;
  non-empty selection → swarm the batch through `ReviewEngine`.
- `B` selects/clears all visible rows; `Space` toggles the highlighted row
  and advances; `n` jumps to the next unreviewed row. `b` unchanged.
- Queue rows show a verdict badge: ✓ approve, ✗ changes requested,
  ? investigate, ⏳ running, plus cached-age hint. Session triage state
  (unseen / reviewed / skipped) is in-memory, keyed `repo#number`.
- `Enter` on a row with a cached/collected result shows the decision card
  instantly without re-running; the full diff remains one keystroke away.
- Bulk queue: `a` with a non-empty selection presents **one** confirmation
  listing every exact PR, gated by a typed count; per-PR failures are
  reported individually. Single-PR `a` unchanged. Direct merge `m` keeps
  its per-PR typed-number gate.
- Batch landing (`A`, `w`) is untouched and remains a separate flow.

## turbo-review recipe

- Kept, made honest: each cluster step reports its real outcome instead of
  one swallowed warning; the final status block distinguishes "scaled and
  Ready", "scaled, not Ready", and "failed at <step>".
- Exports k8s-executor availability to the dashboard (environment flag) so
  the review engine can offload without re-probing.
- Hive contributor scale-out semantics unchanged; contributors remain
  independent Hive-assigned capacity, not queue reviewers.

## Caveman + skills integration

- Check prompts gain a compact-output contract: structured verdict, bounded
  finding list, no prose padding; cached transcripts are size-capped.
- The five review-scope check subagents and build-time skill generation are
  untouched (protected). Skills continue to serve interactive contributor
  sessions only; they do not become review checks automatically.

## Deletions (moderate simplification)

| Target | Approx. LOC | Notes |
|---|---:|---|
| Lab broker (`scripts/review-lab-broker.py`), lab client, `tests/lab-broker-contract.py`, `docs/skills/lab-broker.md`, launcher socket/probe/prompt plumbing | ~3,000 | Optional capability, unprotected; its gVisor `host-uds` flag goes with it |
| Detached worker mode (`REVIEW_DETACH`, `review-stop` local path, Codex auth staging for detach, ownership tests specific to detach) | ~600 | `review-stop cluster` survives for turbo teardown |
| Stale duplicate router `docs/skills/index.md` | 23 | `docs/SKILL.md` is the router |
| Dead TUI code: `Stop.batchable`, `REVIEW_INCOMPLETE`, `QUEUE_LABEL` | small | Verified unreferenced |

Documentation drift fixed in the same change: wrong default Goose model in
`goose-context.md`; lab references removed with the broker; `AGENTS.md`,
README, `docs/skills/review-dashboard.md`, `docs/skills/cluster-workers.md`
updated to describe the review engine; `docs/skills/index.json` regenerated.

## Error handling

- Subagent failure → row marked failed + retryable; batch continues.
- K8s dispatch/collection failure → transparent local fallback + note.
- Headroom exhaustion → dispatch pauses, UI shows waiting state.
- Cache corruption → treated as miss, file replaced on next result.
- Dashboard exit mid-swarm → local subprocesses terminated with the
  process-group handling the landing lane already uses; k8s work runs as
  Jobs with `ttlSecondsAfterFinished` so nothing leaks.

## Testing

- `tests/dashboard_pilot.py`: swarm dispatch (N selected → N engine tasks),
  cache hit short-circuit, verdict badges and triage filter, context-aware
  `r`, bulk-queue single confirmation listing every PR, per-PR failure
  isolation.
- Headroom governor unit tests with injected meminfo/cpu values.
- K8s executor fallback tests with a fake `kubectl` (dispatch fails → local
  fallback; logs collected → cache written).
- `tests/just-onboarding.sh`: honest turbo status reporting; removal of
  lab/detach cases.
- Deleted with their features: `tests/lab-broker-contract.py`, detach
  lifecycle tests.

## Success criteria

- `just turbo-review` with no cluster: select 10 PRs, `r`, all 10 reviewed
  in parallel within local headroom, badges appear, second pass on
  unchanged heads is instant from cache.
- Same flow with a cluster context: reviews run in pods, local machine
  stays responsive, fallback works when the cluster is unplugged mid-batch.
- Bulk `a` queues an annotated selection with one confirmation.
- Full validation suite passes; ~3,600 LOC net removed.
