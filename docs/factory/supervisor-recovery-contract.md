# Review Factory Supervisor Recovery Contract

This document is the durable recovery contract for a long-running Hermes-style
factory supervisor operating on Josh's `review` fork.

It exists so the supervisor can recover its control model after context
compaction, restart, or handoff without depending on conversation history.

**Do not copy the architecture of another repository into `review`.** The
lessons below are the factory control model only: state, gates, concurrency,
receipts, and continuation behavior. Repository architecture and product scope
remain governed by `AGENTS.md`, `docs/factory/agentic-model.md`, current code,
tests, issues, and maintainer decisions.

## Authority and recovery order

After any context compaction, restart, uncertainty, or supervisor handoff,
reconstruct reality from durable repository state instead of guessing from
memory.

Read, in order:

1. `AGENTS.md`.
2. `docs/factory/agentic-model.md`.
3. This document.
4. The current parent/factory issue or other active scheduler ledger.
5. Every active lane's issue, branch/worktree, draft PR, exact head SHA, CI,
   review comments, and merge state.
6. Relevant dependency issues or PRs discovered by those lanes.

Conversation state is advisory. GitHub and the checkout are authoritative.

If an important fact exists only in an agent conversation, matriculate it back
into durable state before relying on it.

## Core model: the repository is the state machine

Treat repository artifacts as durable factory state:

- **issue** = desired outcome and acceptance contract;
- **issue/PR comments** = discovered facts, failed hypotheses, exact evidence,
  blockers, repair receipts, and decisions;
- **branch/worktree** = one writable implementation attempt;
- **draft PR** = visible delivery and CI surface;
- **commit SHA** = immutable candidate identity;
- **hosted CI** = environmental acceptance for that candidate;
- **independent review** = adversarial acceptance for that candidate;
- **merge** = completed state transition;
- **parent/factory issue** = scheduler ledger and dependency view.

The supervisor should not need the whole implementation context in its own
prompt. Workers read the issue and repository. The supervisor primarily owns
lane selection, dependency reasoning, receipts, gates, capacity, and
continuation.

## Outcome-driven issues

A writable lane starts from a bounded, independently reviewable outcome with
acceptance criteria.

The supervisor operates the issue graph; it does not replace the graph with a
giant private implementation plan.

When implementation discovers a real missing prerequisite:

1. record the dependency explicitly;
2. record evidence for why it is a dependency;
3. park the blocked lane if necessary;
4. schedule the prerequisite when appropriate;
5. immediately reuse any otherwise idle writable capacity for another READY,
   non-conflicting issue.

A discovered dependency is durable scheduling information, not a reason to
freeze the entire factory.

## Exact-SHA acceptance

A candidate is always an **exact commit SHA**.

CI belongs to an exact SHA. Review belongs to an exact SHA. Evidence belongs
to an exact SHA. A repaired SHA does not inherit acceptance from the previous
SHA merely because the diff is small.

The default acceptance loop is:

```text
RED acceptance contract
-> implementation
-> focused/local verification
-> push exact candidate SHA
-> hosted CI on that SHA
-> independent bounded review on that SHA
-> repair only validated blockers
-> push new exact SHA
-> rerun affected gates on the new SHA
-> READY TO MERGE
-> merge
-> durable merge receipt
```

Do not call a lane ready because a worker says it is done. Verify the gates
against the current head SHA.

### Minimum ready-to-merge gate

Before declaring a lane ready to merge, confirm all acceptance requirements
that apply to that issue, including:

- exact current head SHA recorded;
- required focused/local tests pass;
- required hosted CI/checks pass on that SHA;
- independent review evaluated that SHA and has no unresolved validated
  blocker;
- required real execution/evidence exists;
- branch/PR state permits the intended merge path;
- no unresolved dependency or acceptance ambiguity remains;
- scheduler ledger reflects the current state.

If the SHA changes, explicitly determine which gates must be rerun. Never
silently reuse a review or CI result from an older candidate.

## Reality and evidence gate

When acceptance depends on behavior visible only in a real environment, prove
it in that environment.

For UI/TUI, MCP, Hive, authentication, provider integration, runtime behavior,
or other integration-sensitive work:

- use authentic execution evidence;
- use real screenshots when screenshots are part of acceptance;
- do not substitute placeholders, fabricated output, or mock screenshots for a
  required real proof;
- record enough information to tie the evidence to the candidate SHA and
  environment.

If real-model acceptance is required by the active issue, prefer the cheapest
supported real model first. For the current Review factory policy, use
`gpt-5.6-luna` first when supported and escalate only after a concrete Luna
failure. Record backend/provider/model and the reason for escalation rather
than silently substituting another backend.

## Concurrency: small fixed writable capacity

Default to a small fixed number of writable implementation lanes. The proven
starting point is **three writable lanes** unless the current parent issue or
maintainer direction sets another limit.

Each writable lane has:

- one issue/outcome;
- one isolated branch/worktree;
- one sole implementation writer;
- explicit path/contract ownership;
- one current exact candidate SHA when a candidate exists.

Read-only investigation and independent review may fan out more broadly when
useful because they do not create write conflicts.

Serialize only real dependencies or overlapping ownership. Do not serialize
independent work merely because another lane is waiting.

## Blockers are lane-local

A blocked lane does not block the factory.

If lane A depends on B, or is waiting on an external condition:

- mark A honestly;
- free any writer that is no longer actively writing;
- start B if it is the correct prerequisite and is READY;
- otherwise fill capacity with another non-conflicting READY issue.

The scheduler must reason about the graph, not promote one lane's blocker into
a global stop condition.

## Capacity recycling

Waiting does not consume a writer.

Examples of non-writing states:

- hosted CI running;
- independent review running;
- waiting for a remote job;
- waiting for a reviewer response;
- waiting for an external environment after a candidate is already pushed.

As soon as a lane enters a non-writing wait, reclaim writable capacity and
schedule another READY non-conflicting issue when one exists.

A lane under read-only review is still an active lane, but it is not occupying
a writable worker.

## Worker completion is an event, not supervisor completion

This is a critical control-loop rule.

When a worker returns a receipt, the supervisor must process the event. It
must not simply summarize:

```text
Next:
1. ...
2. ...
3. ...
```

and stop while runnable work still exists.

After every worker receipt, the supervisor should:

1. inspect and validate the receipt;
2. inspect the actual repository state when necessary;
3. push/integrate the candidate if that is the lane contract;
4. record the exact candidate SHA;
5. update the issue/PR/parent ledger with material evidence;
6. start or observe the next required gate;
7. release any now-idle writable capacity;
8. dispatch the next READY operation;
9. continue the control loop.

**DEFAULT = CONTINUE.**

Knowing the next actions is not equivalent to executing them.

## Supervisor versus workers

Prefer the supervisor as orchestrator, not as the primary implementation
writer.

The supervisor owns:

- issue/dependency graph interpretation;
- lane ownership and capacity;
- worker dispatch;
- receipt validation;
- exact-SHA gate tracking;
- CI/review scheduling and observation;
- durable issue/PR ledger updates;
- bounded recovery when a worker fails;
- deciding what can run next.

Implementation workers own bounded writable changes in their assigned lane.
Independent reviewers stay read-only with respect to the candidate they are
reviewing unless explicitly dispatched into a later repair phase as a writer.

The supervisor may perform repository-control actions needed to orchestrate
(branch/PR/issue state, comments, receipts, integration), but should not steal
implementation work from an available bounded worker without a reason.

## Open draft PRs early, but distinguish states

Once a lane has a coherent visible checkpoint, open or maintain a draft PR so
CI and review have a durable surface.

Do not confuse these states:

- **DISPATCHED**: a worker has been assigned;
- **IMPLEMENTING**: writable work is in progress;
- **IMPLEMENTATION CANDIDATE PUSHED**: an exact SHA containing the claimed
  implementation is on the remote;
- **GATING**: CI/review/evidence is evaluating that SHA;
- **REPAIR**: a validated blocker is being fixed;
- **READY TO MERGE**: all required gates for the current SHA are satisfied;
- **MERGED**: the state transition completed and receipt is recorded.

An empty kickoff PR or a dispatched worker is not implementation progress.

## Bounded repair, not re-architecture

When CI or review finds a concrete problem:

1. reproduce or validate the specific failure;
2. record the blocker and evidence;
3. repair the blocker;
4. add regression acceptance when appropriate;
5. produce a new exact SHA;
6. rerun the affected gates.

Do not use a bounded blocker as permission to redesign unrelated architecture,
add speculative features, or reopen settled scope.

For `review`, also respect the repository's own factory model: it is primarily
a toil-reduction and completion system, not permission for unconstrained
feature fan-out.

## Durable receipts

Important discoveries belong in GitHub or another repository-controlled
artifact that a future worker can inspect.

Record at least the material facts needed to reconstruct why the current state
exists, such as:

- exact candidate SHA;
- local verification result;
- hosted CI failure or success;
- concrete diagnosis;
- rejected hypothesis when it prevents repeated dead ends;
- validated review blocker;
- repair SHA;
- real execution/screenshot receipt;
- newly discovered dependency;
- merge receipt.

Avoid append-only narrative noise. Store facts that change scheduling,
acceptance, diagnosis, or future reconstruction.

## Recovery after worker failure or context loss

If a worker disappears, crashes, compacts, or returns an ambiguous receipt:

1. do not infer completion from the conversation;
2. inspect the branch/worktree and remote PR;
3. identify the actual head SHA and dirty/unpushed state;
4. inspect tests/CI/review attached to that SHA;
5. reconstruct the lane status from durable evidence;
6. record any missing material receipt;
7. either resume with a bounded worker or park the lane with an evidenced
   blocker;
8. refill capacity elsewhere if possible.

If the supervisor itself compacts, repeat the authority/recovery order at the
top of this document and reconstruct every active lane before dispatching new
writes.

## Stop conditions

The supervisor may return control to the human when one of these is true:

- the human explicitly asked it to stop or pause;
- no runnable operation remains and all active work is genuinely waiting;
- every useful lane is blocked by authentication/environment/access that the
  supervisor cannot resolve;
- a consequential decision is explicitly reserved for a human and no other
  independent READY work exists;
- the requested factory outcome has completed and merge/closure receipts are
  durable.

A worker finishing, CI starting, review starting, one lane blocking, or the
supervisor knowing the next steps are **not** stop conditions by themselves.

## Compact supervisor loop

Use this loop repeatedly:

```text
RECONSTRUCT durable state
-> CLASSIFY lanes and dependencies
-> VALIDATE receipts and exact SHAs
-> ADVANCE gates
-> RECYCLE idle writable capacity
-> DISPATCH READY non-conflicting work
-> RECORD material state changes
-> REPEAT
```

When in doubt after compaction: **read the repo, recover the ledger, then
continue.**
