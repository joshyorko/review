# Luna Factory (OMP extension)

An opt-in OMP extension that keeps the Luna Factory protocol and moves the
mechanically checkable parts of it — admission, task state, evidence binding,
repair lineage, completion — out of conversational memory and into tested code.

> Luna owns the objective and the semantic judgment. This extension owns the
> validated ledger and its mechanical transitions. OMP owns execution, agents,
> jobs, isolation, transcripts, and model plumbing. GitHub and repository policy
> still own external authority.

It is not a replacement for Hive, not another agent runtime, and not a Review
rewrite. It adds no database, no daemon, no scheduler, and no second worker
store.

## Contract mapping

The protocol this implements lives in the existing skill
(`joshyorko/plugins` → `plugins/luna-factory/skills/luna-factory/SKILL.md`), with
the convergence work tracked in
[`joshyorko/plugins#52`](https://github.com/joshyorko/plugins/issues/52). This
package is a mapping, not a second copy: the skill remains the behavioural source,
and the semantics below are the ones the issue restates from it. It was written
against that restatement rather than a fetched skill revision hash, so the
revision link is the skill itself.

| Semantics | Where it lives |
|---|---|
| Reuse the agreed goal, invariants, non-goals, permitted effects, appetite | `core/model.ts` — `Goal`, `Appetite`, `emptyLedger`; captured by `luna_factory_open` |
| Discovery creates candidates, never authority | `core/admission.ts` — `admit` |
| ADMIT the smallest necessary action; else DEFER/DISMISS/ESCALATE | `core/admission.ts` — fixed-order rule with a named reason |
| READY needs satisfied dependencies, ownership, current generation, appetite | `core/admission.ts` |
| A returned worker moves to VERIFY, not DONE | `core/reducer.ts` — `record_receipt` |
| Execution proof, fresh acceptance review, and premise judgment stay distinct | `core/evidence.ts` — `reconcileReceipt`; `agents/lf-reviewer.md` |
| Two no-progress attempts diagnose a plateau; one bounded replan; lineage survives | `core/reducer.ts` — `use_replan`; `core/convergence.ts` |
| CONVERGED ≠ QUIESCENT; empty queues and returned workers prove nothing | `core/convergence.ts` — `evaluateRun` |
| Required safety defects are not scope creep; optional cleanup is not a successor mission | `core/convergence.ts` blockers + `core/receipt.ts` |
| Completion creates no merge or deploy authority | `core/receipt.ts` — the receipt says so explicitly |

## Command surface

The objective describes `/factory`, `/factory status`, `/factory why <task-id>`,
`/factory pause`, `/factory resume`, and `/factory abort`. **The pinned
appliance's OMP host slice registers flags, shortcuts, tools, and events — not
commands**, so those spellings are not a supported seam here. The supported
equivalents are namespaced LLM-callable tools:

| Objective | Supported surface |
|---|---|
| `/factory <objective>` | `luna_factory_open` (refuses to silently replace an open run) |
| `/factory status` | `luna_factory_status` |
| `/factory why <task-id>` | `luna_factory_why` |
| `/factory pause` / `resume` / `abort` | `luna_factory_control` |
| (ledger input) | `luna_factory_candidate`, `luna_factory_attempt`, `luna_factory_receipt`, `luna_factory_finish` |
| (verified finish) | `luna_factory_completion` |

`luna_factory_dispatch` builds the bounded prompt for an admitted task; the
coordinator then performs the native dispatch itself. See the gap list below.

## Execution boundary

`omp/capabilities.ts` is the authoritative table. Today it records exactly one
**enforced** path — the work Factory itself emits, driven by admission and
covered by this package's tests — and marks every path that would require
interception of OMP's own dispatch as **unsupported**, because no packaged OMP
binary was available to probe. `luna_factory_dispatch` refuses those paths rather
than routing through them silently.

Shell, eval file and network access, child environments, and other extensions can
have effects outside a narrowly intercepted tool, so nothing here is an OS
security boundary and nothing here guarantees termination.

## Run state, evidence, recovery

`CANDIDATE → READY | BLOCKED | DEFERRED | ESCALATE` then `READY → RUNNING →
VERIFY → DONE`, with run control (`active`, `paused`, `draining`, `interrupted`,
`quiescent`, `converged`) kept separate from task state.

The ledger is one versioned, namespaced custom entry (`com.joshyorko.luna-factory.run`)
written through native session storage. A missing, corrupt, or unknown-version
record fails safely and reports why; a record is never deleted to clear it. If
the session exposes no history, durability is reported as **unavailable** rather
than claimed.

Integration moves the certified subject, which demotes proof taken against the
old head back to VERIFY. Process-local eval handles and pools are never
serialized and never treated as live after a restart.

## Opt-in and non-interference

Loading the extension registers a surface and waits: it starts no work, changes
no model, takes over no Review queue, and enables no perpetual automation.
Execution requires `LUNA_FACTORY_ENABLED=1`. Factory never approves, merges,
publishes, or pushes to a protected branch, and it never infers an admission from
a Hive rank or a visible queue row.

Review and Factory are not meant to hold the same scope at once; V1 has no
automatic handoff, so an overlap is reported rather than resolved silently.

## Known gaps

- No slash-command registration in the pinned host slice (above).
- No enforced interception of native `task`, eval `tool.task`, eval `agent`,
  `workpool().push`, hub steering, or child tool policy.
  [`can1357/oh-my-pi#2574`](https://github.com/can1357/oh-my-pi/issues/2574),
  [#6947](https://github.com/can1357/oh-my-pi/issues/6947),
  [#5859](https://github.com/can1357/oh-my-pi/issues/5859) are design references,
  not shipped dependencies.
- `session_stop` is used only as a final settlement check. Its documented
  eight-continuation ceiling and background-job deferral mean it cannot schedule
  or rescue a hung job.