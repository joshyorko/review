# Turbo Review v2 — Parallel Batch Review Engine

**Date:** 2026-09-06
**Status:** Approved design (revised after GPT-5.6 Sol design review), pending
implementation plan
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
- Review analysis cached by the canonical review identity (base SHA, head
  SHA, backend, model, effort, check-scope version); an unchanged identity
  annotates instantly.
- Concurrency sized to real machine headroom; offload to Kubernetes when a
  context is present so the local machine never crushes itself.
- Moderate simplification: internals get leaner; model profiles, skill
  generation, and the interactive `review-container` contributor path are
  untouched (its *detached* branch is removed — see Deletions).

## Non-goals

- Cluster-required review. The engine is fully functional with zero cluster.
- Changing Hive contributor scale-out semantics (workers remain independent
  Hive contributors).
- Weakening mutation gates. Merge keeps its per-PR typed confirmation.
- Auto-merge or auto-approve. Verdicts are evidence; the human decides.

## Architecture

```
ReviewDashboard (container)
  ├── selection (b/B/Space)         queue rows, verdict badges, triage state
  ├── batch snapshot (new)          fail-closed hydration of base/head SHAs
  │                                 and live evidence for every selected PR
  ├── ReviewEngine (new)            image/tui/review_engine.py
  │     ├── scheduler               cloned from landing scheduler pattern
  │     │                           (JSONL state, concurrency cap); each
  │     │                           review gets an isolated worktree keyed
  │     │                           full-repo + head SHA — no shared checkout
  │     ├── LocalExecutor           per-PR review subprocess through the
  │     │                           existing harness/ReviewRun abstractions,
  │     │                           slots granted by CapacityGovernor;
  │     │                           every run routed through the existing
  │     │                           Headroom session (token reduction)
  │     ├── BrokerExecutor          typed submit/status/logs requests over a
  │     │                           private UDS to the host-side review-exec
  │     │                           broker, which owns kubectl + credentials
  │     │                           and runs review Jobs in bluefin-system;
  │     │                           any failure falls back to LocalExecutor
  │     └── ReviewCache             ~/.local/state/bluefin-review/reviews/
  └── existing landing lane (A/w)   unchanged

Host (launcher)
  └── review-exec broker (new,      scripts/review-exec-broker.py — the lab
      replaces lab broker)          broker's UDS seam, purpose-built: creates
                                    session-labelled review Jobs, streams
                                    logs, cancels on session end
```

### ReviewEngine

- Input: a set of queue stops from the current selection or all visible
  rows. Before any dispatch, a **fail-closed batch snapshot** hydrates
  every selected PR (the org queue query carries no SHAs): base SHA, head
  SHA, and live evidence are fetched and frozen; a PR that cannot be
  hydrated is marked failed, never dispatched blind.
- Per PR it executes through the existing harness/`ReviewRun` abstractions
  — the same path `ReviewScreen` uses, preserving both Goose and Codex
  backends explicitly — with the image-owned check scope (five check
  subagents). The run emits a **versioned machine-readable result receipt**
  (JSON) as its terminal output; `bluefin-review` gains a receipt mode
  rather than being scraped for prose.
- Each review runs in an **isolated worktree** keyed by full repository and
  head SHA. `bluefin-review` currently mutates one shared checkout
  (`gh pr checkout` into `${WORKSPACE}/${repo##*/}`), which races under
  concurrency; isolation is a precondition for fan-out.
- Scheduler state is JSONL in the state directory, mirroring the landing
  lane's proven torn-tail/flock/idempotent-terminal handling.
- A subagent failure marks that row failed and retryable; it never blocks
  other PRs in the batch.

### Executor seam

- `LocalExecutor` (default): spawns review subprocesses; asks the
  `CapacityGovernor` for a slot before each spawn. Each run resolves its
  route through the existing `HeadroomSession` (`image/tui/headroom.py`)
  exactly as single reviews do, so Headroom token reduction applies to the
  swarm; headroom state and route are recorded in result provenance and the
  batch UI surfaces the session status line.
- `BrokerExecutor` (optional): the dashboard container holds no kubeconfig,
  Kubernetes credential, or `kubectl` — that boundary stays. Instead the
  launcher (which owns them) starts a host-side **review-exec broker**
  (`scripts/review-exec-broker.py`) when a usable context exists, passing
  the container only a private Unix socket, exactly the seam the lab broker
  used. The broker answers typed requests — `submit` (repository, number,
  base SHA, head SHA, backend, model, effort), `status`, `logs`, `cancel` —
  creates session-labelled review Jobs on the published review image in
  `bluefin-system`, injects the review credentials it already holds, and
  streams the result receipt back. Broker absence, dispatch failure, or
  collection failure falls back to `LocalExecutor` for that PR and is
  reported as a note, never a block. Concurrency cap is `REVIEW_SCALE`
  (default 3).
- Doctrine holds: the appliance depends on no cluster; declining, absence,
  or failure of the broker path leaves everything working locally.

### CapacityGovernor

- Lives in `image/tui/capacity.py`. (Named to avoid collision with the
  existing Headroom token-reduction subsystem in `image/tui/headroom.py`.)
- Runnable local slots = `min(floor((MemAvailable - reserve) /
  per_review_budget), cores // 2, BLUEFIN_REVIEW_CONCURRENT_REVIEWS)`,
  floored at **zero** — exhausted headroom yields no slot and queued work
  waits. Default cap 4; per-review memory budget default 1.5 GiB
  (`BLUEFIN_REVIEW_MEM_BUDGET_MB`); explicit host reserve default 2 GiB
  (`BLUEFIN_REVIEW_MEM_RESERVE_MB`).
- Re-evaluated before every dispatch slot; running reviews are never
  killed. Queued (selected, snapshotted) work is distinct from runnable
  capacity and drains as slots free.
- Reads `/proc/meminfo` (`MemAvailable`) and `os.cpu_count()`; injectable
  for tests.

### ReviewCache

- Key: the canonical review-run identity already defined by
  `image/tui/review_run.py` — repository, number, **base SHA, head SHA,
  backend, model, effort** — extended with the check-scope/prompt version.
  Filename is a digest of that identity plus a readable
  `<owner>__<repo>__<number>` prefix under
  `${XDG_STATE_HOME:-~/.local/state}/bluefin-review/reviews/`.
- Content: **analysis only** — verdict, bounded findings, capped transcript,
  engine provenance, timestamp, and the frozen identity. Mutable evidence
  (CI, mergeability, reviews, overlaps) is never cached; it is re-fetched
  live before rendering a decision card or permitting any action.
- Exact identity hit short-circuits dispatch and annotates instantly; base
  motion, force-push, model/effort change, or a bumped check-scope version
  are natural misses. Corrupt cache file = miss.
- Session triage state is keyed `repo#number@head-sha`, so a force-push
  resets a PR to unseen.
- Pruned after seven days, same policy as landings.

## Dashboard UX

- `r` is context-aware: empty selection → today's single-PR `ReviewScreen`;
  non-empty selection → swarm the batch through `ReviewEngine`.
- `B` selects/clears all visible rows; `Space` toggles the highlighted row
  and advances; `n` jumps to the next unreviewed row. `b` unchanged.
- Queue rows show a verdict badge: ✓ approve, ✗ changes requested,
  ? investigate, ⏳ running, plus cached-age hint. Session triage state
  (unseen / reviewed / skipped) is in-memory, keyed `repo#number@head-sha`.
- `Enter` on a row with a cached/collected result shows the decision card
  instantly without re-running — cached analysis merged with freshly
  fetched live evidence; the full diff remains one keystroke away.
- Bulk queue: `a` with a non-empty selection builds a **batch ActionPlan**
  that binds the complete repository/PR/head-SHA list. One confirmation
  screen lists every exact PR and head; the typed gate confirms that list
  (not a bare count). Immediately before each mutation the item's live head
  and checks are revalidated — drift rejects that item, exactly as the
  existing `ActionPlan` head/check contract does. Per-PR failures are
  reported individually. Single-PR `a` unchanged. Direct merge `m` keeps
  its per-PR typed-number gate.
- Batch landing (`A`, `w`) is untouched and remains a separate flow.

## turbo-review recipe

- Kept, made honest: each cluster step reports its real outcome instead of
  one swallowed warning; the final status block distinguishes "scaled and
  Ready", "scaled, not Ready", and "failed at <step>".
- Exports broker-socket availability to the dashboard so the review engine
  can offload without re-probing; `review-queue` starts the review-exec
  broker under the same one-question `/dev/tty` consent the lab broker
  used.
- Hive contributor scale-out semantics unchanged; contributors remain
  independent Hive-assigned capacity, not queue reviewers.

## Caveman + skills integration

- Check prompts gain a compact-output contract reusing the existing
  `CAVEMAN_INSTRUCTIONS` from `image/tui/headroom.py`: structured verdict,
  bounded finding list, no prose padding; cached transcripts are size-capped.
- The five review-scope check subagents and build-time skill generation are
  untouched (protected). Skills continue to serve interactive contributor
  sessions only; they do not become review checks automatically.

## Deletions and replacements (moderate simplification)

| Target | Approx. LOC | Notes |
|---|---:|---|
| Lab broker (`scripts/review-lab-broker.py`, ~1,500), lab client, `tests/lab-broker-contract.py` (~1,200), `docs/skills/lab-broker.md`, QA WorkflowTemplate dispatch, automatic issue filing | ~3,000 gross | **Replaced**, not merely deleted: the UDS seam, gVisor `host-uds` handling, consent prompt, and session scoping carry over into the much smaller review-exec broker (`submit`/`status`/`logs`/`cancel`, no Argo, no issue filing, no Prometheus) |
| Detached worker mode (`REVIEW_DETACH` branch inside `review-container`, `review-stop` local path, Codex auth staging for detach, detach ownership tests) | ~600 | The interactive `review-container` path is unchanged; only its detached branch goes. `review-stop cluster` survives for turbo teardown |
| Stale duplicate router `docs/skills/index.md` | 23 | `docs/SKILL.md` is the router |
| Dead TUI code: `Stop.batchable`, `REVIEW_INCOMPLETE`, `QUEUE_LABEL` | small | Verified unreferenced |

Every canonical surface that describes the deleted or replaced behavior
changes in the same batch: the lab-authority section of
`docs/factory/agentic-model.md`, the `docs/SKILL.md` route, the lab passages
in `AGENTS.md` and `docs/skills/launcher.md`, the lab reference embedded in
`image/review-scope/REVIEW.md`, the wrong default Goose model in
`docs/skills/goose-context.md`, README, `docs/skills/review-dashboard.md`,
and `docs/skills/cluster-workers.md`; `docs/skills/index.json` is
regenerated.

## Error handling

- Subagent failure → row marked failed + retryable; batch continues.
- Broker dispatch/collection failure → transparent local fallback + note.
- Headroom exhaustion → dispatch pauses at zero slots, UI shows waiting
  state; queued work drains as slots free.
- Cache corruption → treated as miss, file replaced on next result.
- Dashboard exit mid-swarm → local subprocesses terminated with the
  process-group handling the landing lane already uses; the broker cancels
  its session-labelled Jobs on session end, every Job carries
  `activeDeadlineSeconds` and `ttlSecondsAfterFinished`, and broker startup
  sweeps orphaned Jobs from dead sessions.

## Testing

- `tests/dashboard_pilot.py`: batch snapshot hydration (fail-closed on
  unhydratable PRs), swarm dispatch (N selected → N engine tasks), cache
  hit short-circuit and identity-miss cases (base motion, force-push,
  model change), verdict badges and triage filter, context-aware `r`,
  batch ActionPlan confirmation listing every PR + head with per-item
  drift rejection, per-PR failure isolation, worktree isolation.
- Headroom governor unit tests with injected meminfo/cpu values, including
  the zero-slot case.
- Review-exec broker contract test (successor to the lab-broker contract,
  much smaller): typed request validation, session labelling, cancel on
  session end, orphan sweep, fallback on broker absence.
- Result receipt schema test: versioned JSON receipt round-trips through
  both backends.
- `tests/just-onboarding.sh`: honest turbo status reporting; removal of
  lab/detach cases; broker consent and socket handoff.
- Deleted with their features: `tests/lab-broker-contract.py`, detach
  lifecycle tests.

## Success criteria

- `just turbo-review` with no cluster: select 10 PRs, `r`, all 10 reviewed
  in parallel within local headroom, badges appear, second pass on
  unchanged heads is instant from cache.
- Same flow with a cluster context and broker consent: reviews run as
  session-labelled Jobs, local machine stays responsive, fallback works
  when the cluster is unplugged mid-batch, and no Job outlives the session
  deadline.
- Bulk `a` queues an annotated selection through one batch ActionPlan
  confirmation with per-item head revalidation.
- Full validation suite passes; net LOC decreases (~3,600 gross deletion
  against the new engine + smaller broker).
