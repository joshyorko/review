---
name: review-dashboard
version: "4.9"
last_updated: 2026-09-14
id: review-dashboard
one_line_purpose: Maintain the single-screen OMP review workbench.
entry_point: docs/skills/review-dashboard.md
category: ci-ops
mcp_compliance_level: partial
optimization_status: draft
status: active
dependencies: []
tags: [omp, extension, dashboard, review, maintainer, workflowz]
description: "Maintains the OMP review workbench in image/extension/bluefin-review/. Use when editing review UI, queue projection, workflowz dispatch, or action seams."
metadata:
  type: runbook
  context7-sources: []
---

# Review Workbench

The only maintainer UI is the OMP extension in
`image/extension/bluefin-review/`. `bin/omp-review` loads it from source;
`just review-queue` and `just review-appliance` launch the same packaged
extension from `image/appliance/Containerfile`.

The Hive contributor runtime has no maintainer UI. It attaches the terminal
directly to the OMP session Hive created.

## When to Use

Use this skill for the OMP queue, dashboard controls, workflowz dispatch,
durable slay state, or review action prompts.

## When NOT to Use

Use `launcher.md` for container launch mechanics, `review-checks.md` for review
doctrine, and `hive-runtime.md` for contributor assignment behavior.

## Core Process

1. Trace the key or flag from `dashboard.ts` through `extension.ts` to its prompt.
2. Keep reviewer agents read-only; one explicit slay action authorizes the
   coordinator's bounded review, repair, re-review, and landing state machine.
3. Add a headless interaction test, then exercise the real foreground workbench.

## Authority

- GitHub owns repository state.
- Hive owns contributor selection, assignment, prompt injection, and output
  capture. The workbench may read Hive order but never claim contributor work.
- OMP owns sessions, agents, tasks, tools, workflowz workpools, and cancellation.
- The extension owns queue projection, durable user intent, mutation guards,
  and presentation.
- Humans own approval and merge decisions.

## Screen

The queue, focused item, Dagger-style execution trace, and prompt share one
screen. The top gauge reports mode, position, repository, outcomes, freshness,
Hive ordering, and actionable count. The bottom gauge reports Hive connectivity,
selection count, and the active workflowz slay.
Hive coverage is mode-aware: issue mode counts Hive issue identities, while PR
mode counts direct Hive pull requests and explicit open linked pull requests.
Pull requests discovered through GitHub closing references still inherit the
rank of their Hive issue. Never probe an issue identity as a pull request or
report issue-only backlog as missing PR evidence.


`Tab` switches PR/issue mode and every semantic accent between the cool PR
palette and warm issue palette.

| Key | Action |
| --- | --- |
| `Tab` | Toggle pull requests and issues |
| `j` / `k` | Move through the queue |
| `Space` | Toggle the focused item |
| `A` / `x` | Select the filtered slice / clear selection |
| `Alt-B` | Select or clear the focused repository group |
| `s` | Slay selected pull requests through review, repair, and landing |
| `Alt-S` | Autoslay the visible queue through the same lifecycle |
| `f` | Fix selected items in isolated workspaces |
| `d` | Inspect bounded diff evidence |
| `p` | Pause or resume later wave admission |
| `r` | Refetch GitHub and Hive projections |
| `o` | Change repository or organization scope |
| `/` | Filter the queue |
| `H` / `L` | Toggle Hive-only rows / step through Hive stages |
| `t` | Focus the execution trace |
| `g` / `G` | Jump to the first / last row |
| `h` / `l` | Collapse / expand the focused trace span |
| `c` | Comment after confirmation and live revalidation |
| `Enter` | Cite the focused item in the prompt |
| `?` | Show the key guide |
| `q` / `Esc` | Close the workbench |

## Slay execution

Slay is a maintainer-authorized review, repair, and landing lifecycle. Each
selected pull request first runs in a fresh `bluefin-reviewer` workpool item;
reviewers report findings and never mutate, approve, or merge. Findings dispatch
isolated fixers, and a fixed head receives a fresh reviewer before the
coordinator may approve and ask GitHub to squash-merge it. Live repository rules
remain authoritative; slay never removes holds, uses admin bypass, fabricates
reviewers, force-pushes, or lands a head different from the reviewed head.
`--autoslay` starts the visible bounded slice on launch and enables OMP's advisor
on the coordinator session. The advisor role maps to `@default`, so it follows
the maintainer's selected model without pinning a provider. `Alt-S` starts the
same lifecycle from the active workbench without changing advisor state.
The PR queue reads complete changed-file names with its GitHub projection and
omits pull requests that change `.github/workflows/` before reviewer selection.
Incomplete file lists are omitted rather than assumed safe. Slay rechecks the
selected candidates before constructing durable repository waves, removes any
workflow-changing item from the live queue, and continues with eligible items.
CI state combines status-rollup contexts with check-suite conclusions so a
workflow startup failure with zero jobs remains visible. Slay excludes known
failing or pending CI before reviewer dispatch, rechecks it before each wave,
and blocks approval or merge commands if the active queue state turns red or
pending.
Fresh reviewer sessions do not inherit the coordinator's selected repository or
a checkout. Their prompts must pass both `repo` and `pull_request` to
`hive_workbench_diff` and keep review reads repository-qualified. Repair agents
create checkouts with `gh repo clone` and `gh pr checkout` under
`$HOME/worktrees`, never the small container `/tmp`, and inspect effective
branch rules through `repos/<owner>/<repo>/rules/branches/<branch>` rather than
assuming the legacy branch-protection endpoint exists.
The appliance intentionally does not carry every repository's development
toolchain. Reviewers check a validator once, then use hosted check evidence and
report the local gap instead of installing packages or repeatedly invoking an
absent command.



Preserve Hive order by partitioning contiguous repository runs; an interleaved
repository returns in a later wave rather than jumping ahead. Ask workflowz to
execute every wave, including a singleton. Never implement an extension-local
worker pool, retry loop, task scheduler, or agent lifecycle. Advance on OMP's
`agent_end` only when `willContinue` is false and the wave's jobs have settled.
Pausing stops new waves; it does not pretend to suspend an agent already running.

Persist slay intent, item identity, wave position, and terminal outcomes.
Interrupted slays remain blocked after restart and require an explicit new
dispatch. Never replay a confirmed mutation.
A pull-request wave is terminal only when every target is closed or GitHub has
accepted it into auto-merge. Settled reviewer jobs alone never advance a slay;
open targets without auto-merge block the batch for explicit redispatch.

## Mutations

Capture repository, item number, entity type, and PR head SHA before preview.
Immediately before mutation, fetch live targets and repository rules again and
reject missing, changed, held, review-blocked, or type-mismatched targets.
Execute `gh` with an argument array, never a shell-composed command. Only a
maintainer-confirmed slay batch carries merge authority.
During an active slay, the extension's pre-execution `tool_call` guard rejects
admin merge bypasses, force pushes, and credential-bearing URL arguments even
when the coordinator ignores its prompt contract.

## Policy seam

Generic queue and execution code must not know Bluefin labels or review rules.
Bluefin action vocabulary lives in `policy.ts`; review doctrine lives in the
companion agents under `image/extension/bluefin-review/agents/`.
Every top-level TypeScript module in the extension must remain reachable from
`index.ts`; delete disconnected implementations and their tests instead of
keeping a second, unwired behavior model.

The registered inspection tools are `hive_workbench_status`,
`hive_workbench_queue`, `hive_workbench_diff`, `hive_workbench_trace`, and
`hive_workbench_lookup`.

## Common Rationalizations

- “Slay is just autoreview.” Review without repair and landing is an incomplete
  slay; reviewer agents stay read-only while the confirmed coordinator owns the
  complete lifecycle.
- “Review needs Hive admission.” Review is read-only and must still work from
  GitHub evidence when Hive is absent; write-capable fix keeps its gates.

## Red Flags

- A slay prompt uses the default task agent instead of `bluefin-reviewer` for
  the review stages.
- `s`, `Alt-S`, and `--autoslay` enter different execution paths.
- A reviewer agent approves, merges, or edits instead of returning evidence to
  the coordinator.
- Slay lands without revalidating the exact reviewed head and live GitHub rules.
- A repository wave advances before its OMP jobs settle.

## Verification

```bash
bash tests/omp-review-mode.sh
bash tests/appliance-contract.sh
git diff --check
```

For a visible change, launch `bin/omp-review --no-session` in a foreground
terminal, exercise the changed key path, inspect the real screen, and stop it.
