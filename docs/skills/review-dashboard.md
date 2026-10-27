---
name: review-dashboard
version: "5.6"
last_updated: 2026-09-24
id: review-dashboard
one_line_purpose: Maintain the GitHub Review workbench and mutation guards.
entry_point: docs/skills/review-dashboard.md
category: ci-ops
status: active
tags: [omp, extension, dashboard, review, workflowz, github]
description: "Maintains Review queue behavior, evidence, bounded actions, and mutation safeguards."
metadata:
  type: runbook
  context7-sources: []
---

# Review Workbench

The OMP extension at `image/extension/review/` is the GitHub-generic Review surface. `bin/review-source` is the neutral source entry point; `just review-appliance` launches the packaged extension.

## Mode and authority

Review defaults to GitHub-only mode. `REVIEW_MODE=hive` explicitly enables optional Hive read-side context and `HIVE_HUB` must be configured directly. Normal Review does not fetch Hive, discover contributor registration, show Hive controls, or inject Hive knowledge. Hive mode remains read-only and never assigns or completes worker tasks.

- GitHub owns repository, issue, pull-request, check, and permission state.
- OMP owns sessions, agents, tasks, tools, workflowz workpools, and cancellation.
- Review owns queue projection, bounded evidence, durable human intent, mutation guards, and presentation.
- Luna Factory owns its admitted worker operations, claims, and receipts; a Review row is not Factory admission.
- Humans own scope and mutating intent. A reviewer recommendation is not authorization.

## Core interaction

| Key | Action |
| --- | --- |
| `Tab` | Toggle pull-request and issue queues |
| `j` / `k` | Move through the visible queue |
| `Space` | Toggle the focused item |
| `A` / `x` | Select the filtered slice / clear selection |
| `Alt-B` | Select or clear the focused repository group |
| `s` | Start the confirmed bounded review/repair lifecycle |
| `Alt-S` | Repair returned work before the visible issue backlog |
| `f` | Fix selected work in isolated workspaces |
| `F` | Open the Luna Factory action picker for selected work when Factory is loaded |
| `d` | Inspect bounded PR diff or issue discussion |
| `p` | Pause or resume later wave admission |
| `r` | Refresh GitHub evidence and explicitly enabled read-side projections |
| `o` | Change repository or organization scope |
| `/` | Filter the queue |
| `H` / `L` | Hive-only filter/stages; available only in explicit Hive mode |
| `t`, `g` / `G`, `h` / `l` | Focus trace, jump to ends, or collapse/expand a trace span |
| `c` | Comment only after confirmation and live revalidation |
| `v` | Open the focused GitHub item |
| `?`, `q` / `Esc` | Show help / close the workbench |

`/review recap` opens a deterministic, bounded summary of the current Review
selection, persisted Review operations, native OMP outcomes, and resolved
artifact references. It does not call a model or add the recap to model
context. `/review handoff` writes the same safety-bounded handoff through OMP's
session artifact API, opens a fresh child session, and sends one visible custom
message with `triggerTurn: false`. The new context must revalidate the current
repository, head, selection, claims, budget, and external effects and obtain
explicit human authorization. A handoff grants no approval, merge, comment,
publish, or deploy authority. OMP's `sendMessage` has no delivery receipt, so
Review reports submission without claiming acknowledgement and blocks blind
duplicate sends. If new-session creation is positively cancelled, the export
remains, no message is sent, and a later retry is allowed, including after
restoring the source branch. Uncertain transitions and submissions remain fenced.
Source identity, revalidation/no-authority instructions, and unresolved effects
are reserved before optional history; each history section has its own UTF-8
budget. Native trace facts prioritize recent failed, cancelled, and unknown
outcomes and disclose omitted descendants, not just omitted turns.

The ordinary Review trace bounds UTF-8 previews, total retained trace bytes,
accumulated per-tool output bytes, turns, tools, and task spans at ingestion.
Credentials are masked using their original source ranges before head/tail
clipping. Omitted work retains bounded aggregate lifecycle evidence; lost or
unsettled outcomes keep the enclosing turn UNKNOWN rather than successful.
Truncation metadata includes bytes lost to line and byte budgets plus known
native clipping, and is shown in both the tree and text projection. Native
artifact links are resolved against the source session; a session/branch reset
rejects pending lookups from the old trace. Expired or unresolved artifacts stay
unavailable. Native totals are shown only when OMP supplied
`details.meta.truncation` totals, and `details.meta.artifactError` suppresses the
full-output link.

The normal Review help and status bars omit Hive controls and status. Do not add controls that imply optional integrations are required.

## Bounded execution

Review specialists use neutral definitions in `image/extension/review/agents/`: `reviewer`, `review-security`, `review-correctness`, `review-test-coverage`, `review-simplicity`, `review-ci-triage`, and `review-queue-triage`. They remain read-only; the coordinator may dispatch fresh fixers only after explicit user intent and current evidence.

A pull-request lifecycle verifies the exact head and live repository rules before mutation. Returned pull requests from the authenticated user stay in a repair-only lane: never self-review, self-approve, or self-merge. Preserve workflow-file permission checks, incomplete-file-list fail-closed behavior, mutation claims, and ambiguous-effect reconciliation.

Issue work reads the GitHub issue and bounded discussion. A multi-issue wave uses OMP workflowz tasks with one fresh worker per item and unique target checkouts under `$HOME/worktrees`. Workers may submit changes through pull requests; they do not approve or merge their own work. A settled job or empty queue alone is not terminal proof.

## Interrupted wave recovery

Review persists the selected wave, worker identities, issue-submission baseline, and host-wide mutation resources before dispatch. On restart, a running wave becomes blocked and is reconciled against live GitHub state; an issue Slay settles only when exactly one new submitted pull request is identified for each issue. Missing, duplicate, unrelated, stale, or otherwise ambiguous effects remain `UNKNOWN` and keep their claims.

Normal interactive OMP exit offers **Pause and exit**, **Cancel run and exit**, and
**Stay**. Dismissal means Stay. Signals freeze admission and default to pause
without opening a dialog. Review saves the owning session and choice before
OMP cancels owned execution. Only the matching native post-shutdown settlement
receipt proves execution stopped; timeout, cancelled status, and an empty job
snapshot do not. Mutating admission requires packaged OMP shutdown lifecycle v1.
Worker progress while the exit picker is open does not cancel the selected exit;
a changed native session or dispatched wave still invalidates that choice.

A stopped wave still needs current GitHub effect reconciliation. Unchanged
subjects, a uniquely linked issue PR, or the existing exact PR terminal-effect
contract can release claims without marking cancelled workers or paused work
complete. Missing or ambiguous effects remain fenced. Startup reconciles positive stopped
receipts before offering saved paused work, so leaving verified work paused
retains no execution claim. Cancelled intent is reconciled without a resume
picker. `/review resume` rechecks repositories, heads, submissions,
and admission before dispatching a fresh run with fresh ownership. Existing
issue submissions are excluded, so resume cannot recreate their PRs. Restoring
work never replays the old prompt or worker delivery. Legacy records without
session proof still require their existing authoritative worker/effect evidence.

A complete, fresh non-author approval at the captured head can reconcile a
positively stopped OPEN PR with auto-merge still disabled. The wave remains
paused with no completed-item credit; resuming requires fresh admission.
Reopen the same conversation through the packaged launcher with `--resume`,
then choose **Resume saved work** or run `/review resume` after leaving it paused.
Those are alternative ways to resume the saved work, not two required steps.

For a positively stopped PR **Fix** wave, recovery also accepts forward pushes
when GitHub's immutable commit comparison proves the current head descends from
the captured head. The PR must remain open with the same author, URL, review
state, and auto-merge state. Recovery rechecks the observed heads before
releasing ownership, records them in the paused receipt, and preserves the
original captured subjects without crediting completed work. Explicit resume
admits fresh workers against those verified current heads. Diverged or rewound
heads, changed review or auto-merge state, unreadable evidence, and missing
shutdown proof retain claims. A separate Fix attempt rejected by an existing
owner creates no replacement wave; reopen the owning saved session.

Normal Review commands provide recovery without claim-file or Factory archaeology:

- `/review status` shows the active/recoverable waves and Review-owned claims.
- `/review reconcile` re-checks authoritative worker and GitHub evidence.
- `/review resume` explicitly resumes saved paused work after revalidation.
- `/review drain` pauses admission and waits for the current wave to settle.
- `/review cancel` drains active work, then archives the wave while retaining UNKNOWN claims.
- `/review revise` cancels a blocked wave after the same safe reconciliation and leaves the session ready for a new selection.
- `/review slay` starts another issue Slay from the refreshed visible queue.

If OMP records a coordinator error or abort before any tool invocation, Review binds that terminal event to the unique dispatched prompt and saves the proof. Explicit reconciliation can release its claims after checking that GitHub effects are unchanged and no worker is running or awaiting delivery. The wave is cancelled, not completed. Missing terminal proof, tool activity, or uncertain effects keep ownership protected. Existing records without this proof remain fenced.

After a provider/model error, select a working model and run `/review reconcile` before starting the selection again. A blocked wave with retained claims rejects retries without changing its original dispatch or worker evidence. A claim conflict before dispatch records no dispatched prompt or owning-session identity.

Reconciliation releases only claims with settled evidence. Changing instance keys or scopes does not bypass a host-wide claim.

### PR landing blocked while CI runs

The Review Slay guard runs locally before Bash or packaged GitHub MCP landing
calls reach GitHub. A pending check is neither failed nor evidence of a GitHub
rejection. Observed checks are not necessarily required by branch rules.
Approval can establish review readiness without requiring an existing approval;
the other landing blockers still apply.

Every new dispatch, including resumed saved work, requires a fresh OMP workflowz
`task` invocation. Historical `agent://` resources, worker conversations, results,
and job IDs provide context only. Before any approval or merge, the local guard
requires complete current-dispatch task-to-job coverage, successfully completed
workers, and delivered results. Missing, historical, ambiguous, running, failed,
or cancelled worker evidence blocks the tool call before GitHub. Consumed OMP
jobs retain their structured terminal receipts; do not invent or adopt old job
mappings to satisfy the guard.

Landing checks apply to the PR addressed by each Bash or GitHub MCP call, rather
than unrelated wave items. When GitHub has no aggregate review decision, Review
verifies complete, fresh, non-author approval evidence at the exact head.

If Slay stops with the PR still open and no accepted auto-merge request:

1. Open the PR URL shown in the guard or blocked-wave message. Wait for pending
   CI in GitHub, or fix failing checks.
2. Revalidate the current head, reviews, holds, and mergeability. Once eligible,
   merge or enable auto-merge through GitHub's ordinary controls.
3. Run `/review reconcile` in the existing Review session. It observes the
   GitHub effect and releases claims only when the existing worker and exact-head
   evidence requirements are met.

`/review reconcile` does not merge or restart work. Green CI alone does not complete
landing. `/review resume` applies to saved paused work, not this blocked landing.
Keep claims intact. If GitHub already shows merged or accepted auto-merge and reconciliation still retains UNKNOWN claims, inspect
`/review status` and report the warning; do not delete claims or bypass guards.

For a PR Slay wave, reconciliation observes the exact PR effect independently of the open queue. A MERGED PR at the captured head settles when authoritative effect evidence and terminal worker coverage are valid; it does not require a fresh approval, and a null aggregate review decision is valid. For a positively stopped wave, a changed-head MERGED PR also settles when GitHub verifies that its head is strictly forward of the captured head and a fresh terminal-effect read confirms the same PR identity, author, head, merge, and complete review evidence. The stopped wave receives no completion credit. Other changed-head MERGED PRs and OPEN PRs accepted for auto-merge still require a fresh non-author APPROVED review bound to the current head and submitted during the wave. An explicit CHANGES_REQUESTED decision rejects success. A CLOSED unmerged PR settles its claims but archives Slay as cancelled without increasing completed-item counts. An unexplained OPEN head, missing or stale required review, incomplete review history, unreadable effect, or contradictory state remains UNKNOWN and keeps its claims.

OMP native `isolated:true` is not required: it isolates the coordinator repository, not the target checkout. Worker communication and async delivery are independent of that option.

Task invocation IDs, agent IDs, and async job IDs are distinct. Review maps
structured task progress to OMP job snapshots and persists terminal status at
result-delivery and tool-result boundaries. Consumed results need not remain in
OMP's recent-job list. Recovery records live under `review-waves/` in the shared
mutation-claims root, so losing the session projection does not lose the wave.
An orphan claim without a valid record is reported as UNKNOWN; it is never
released based on the claim file alone.

The Review trace treats OMP lifecycle fields as authority: structured
`__interrupted`/synthetic interruption details and `isError` settle tool spans;
result prose never does. `turn_end` is only a foreground turn boundary, so a
running task or background job remains visible as `UNKNOWN` until its native
terminal status is observed. The rail, plain-text trace, and
`review_workbench_trace` tool read the same projection.

## Policy and tools

Use the generic workbench policy for every owner/repository. Do not route based on `projectbluefin/`, `joshyorko/`, or another organization prefix, and do not restore Blueberry or product-specific label gates.

Review mode registers `review_workbench_*` tools for GitHub status, queue, diff, trace, and issue inspection. Explicit Hive mode uses the corresponding `hive_workbench_*` read-side tools. Keep missing-scope, permission, stale-head, and unavailable-integration reasons truthful.

## Verification

```bash
bash tests/omp-review-mode.sh
bash tests/test-registry.sh
bash tests/review-factory-coload-smoke.sh
```

For UI changes, exercise the real foreground OMP workbench and verify the visible surface as well as the focused headless contract.

The validation workflow also runs the async-consumption regression against the
packaged OMP 18.3.2 job manager. To reproduce locally with a clean checkout of
that tag:

```bash
REVIEW_OMP_SOURCE=/path/to/oh-my-pi node --experimental-transform-types --test --test-name-pattern='packaged OMP 18.3.2' tests/omp-review-mode.test.ts
```

Use Node 24 for this upstream TypeScript test. The test verifies the upstream
commit before loading its manager; only the logger dependency is substituted.
