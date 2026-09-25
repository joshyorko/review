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

The OMP extension at `image/extension/bluefin-review/` is the GitHub-generic Review surface. `bin/omp-review` is the neutral source entry point; `just review-appliance` launches the packaged extension. The retained source directory name is not a routing or policy signal.

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

The normal Review help and status bars omit Hive controls and status. Do not add controls that imply optional integrations are required.

## Bounded execution

Review specialists use neutral definitions in `image/extension/bluefin-review/agents/`: `reviewer`, `review-security`, `review-correctness`, `review-test-coverage`, `review-simplicity`, `review-ci-triage`, and `review-queue-triage`. They remain read-only; the coordinator may dispatch isolated fixers only after explicit user intent and current evidence.

A pull-request lifecycle verifies the exact head and live repository rules before mutation. Returned pull requests from the authenticated user stay in a repair-only lane: never self-review, self-approve, or self-merge. Preserve workflow-file permission checks, incomplete-file-list fail-closed behavior, mutation claims, and ambiguous-effect reconciliation.

Issue work reads the GitHub issue and bounded discussion. A multi-issue wave uses OMP workflowz tasks with repository-local isolated workspaces. Workers may submit changes through pull requests; they do not approve or merge their own work. A settled job or empty queue alone is not terminal proof.

## Interrupted wave recovery

Review persists the selected wave, worker identities, issue-submission baseline, and host-wide mutation resources before dispatch. On restart, a running wave becomes blocked and is reconciled against live GitHub state; an issue Slay settles only when exactly one new submitted pull request is identified for each issue. Missing, duplicate, unrelated, stale, or otherwise ambiguous effects remain `UNKNOWN` and keep their claims.

Normal Review commands provide recovery without claim-file or Factory archaeology:

- `/review status` shows the active/recoverable waves and Review-owned claims.
- `/review reconcile` re-checks authoritative worker and GitHub evidence.
- `/review drain` pauses admission and waits for the current wave to settle.
- `/review cancel` drains active work, then archives the wave while retaining UNKNOWN claims.
- `/review revise` cancels a blocked wave after the same safe reconciliation and leaves the session ready for a new selection.
- `/review slay` starts another issue Slay from the refreshed visible queue.

If OMP records a coordinator error or abort before any tool invocation, Review binds that terminal event to the unique dispatched prompt and saves the proof. Explicit reconciliation can release its claims after checking that GitHub effects are unchanged and no worker is running or awaiting delivery. The wave is cancelled, not completed. Missing terminal proof, tool activity, or uncertain effects keep ownership protected. Existing records without this proof remain fenced.

Reconciliation releases only claims with settled evidence. Changing instance keys or scopes does not bypass a host-wide claim.

Task invocation IDs, agent IDs, and async job IDs are distinct. Review maps
structured task progress to OMP job snapshots and persists terminal status at
result-delivery and tool-result boundaries. Consumed results need not remain in
OMP's recent-job list. Recovery records live under `review-waves/` in the shared
mutation-claims root, so losing the session projection does not lose the wave.
An orphan claim without a valid record is reported as UNKNOWN; it is never
released based on the claim file alone.

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
OMP 18.3.0 job manager. To reproduce locally with a clean checkout of that tag:

```bash
REVIEW_OMP_SOURCE=/path/to/oh-my-pi node --experimental-transform-types --test --test-name-pattern='packaged OMP 18.3.0' tests/omp-review-mode.test.ts
```

Use Node 24 for this upstream TypeScript test. The test verifies the upstream
commit before loading its manager; only the logger dependency is substituted.
