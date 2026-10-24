---
name: factory-operations
version: "1.3"
last_updated: 2026-08-14
id: factory-operations
one_line_purpose: Keep bounded factory work moving until it lands or is externally blocked.
entry_point: docs/skills/factory-operations.md
category: meta
mcp_compliance_level: partial
optimization_status: draft
status: active
dependencies: [contribution-culture, skill-improvement, pr-workflow]
tags: [factory, operations, continuation, scheduling, verification]
description: "Defines repository-neutral continuation, capacity, ownership, and evidence rules for bounded factory work."
metadata:
  type: policy
---

# Factory Operations

## When to Use

Use this when coordinating multiple bounded changes or deciding whether work
should continue after a worker, check, review, or remote operation changes
state.

## Operating Rules

- The default state is continue. Worker completion is an event, not supervisor
  completion.
- An initial issue list is a minimum path unless explicitly exhaustive. After
  a core-path or milestone merge, refresh the full repository issue, pull
  request, ownership, and dependency graph; admit the highest-priority ready
  work that does not conflict, and park only for a concrete dependency, human
  design decision, unavailable acceptance environment, or active overlapping
  owner.
- Assign one sole writer to each branch or worktree and state its explicit
  write set. Waiting, CI, review, and remote work do not consume writable
  capacity.
- An exact candidate SHA binds focused verification, hosted CI, and independent
  review. Evidence from a superseded SHA is stale.
- Blockers are lane-local: park only that lane and record discovered
  dependencies. Refill writable capacity immediately with the highest-priority
  ready work that does not conflict.
- Three writers is a ceiling, not a utilization target. Never invent filler
  work.
- Put important transition receipts in the repository's durable issue or pull
  request system.
- Before merge, classify the candidate against its owning issue as a full
  outcome or partial slice: a full outcome uses a closing keyword in the pull
  request and, after merge, verifies that the owning issue is actually
  closed/completed in the durable repository tracker; a partial slice uses
  non-closing `Progresses` or an equivalent and leaves unresolved intent open;
  an external or human blocker remains open with concrete blocker evidence.
  After every merge, blocker, or ownership transition, reconcile the current factory or
  ledger projection against live issue and pull-request state before selecting
  the next READY work; durable ledger/status must never contradict the
  repository tracker.
- When an authorized repository owner explicitly clears a lane and current
  remote PR, branch, and assignee evidence is clean, an unpushed planning
  reference is advisory rather than ACTIVE ownership; record the clearance and
  dispatch. Actual overlapping maintainer branches or PRs take precedence.
- Repair concrete, validated failures without speculative re-architecture.
- Knowing the next steps is not a stop condition. Continue until the outcome
  is merged or concretely externally blocked.

## Delivery Cadence

Review is fast-moving, and cadence is part of correctness here.

- Batch every compatible, ready fix into one integrated branch and one pull
  request. A staged sequence of micro-batches buys nothing a single reviewable
  diff does not, and each stage costs a full review round trip.
- Parallelize read-only work — research, exploration, and review passes. It
  shares no state and cannot conflict, so it never needs a lane.
- Do not add process overhead that produces no evidence: no staged approval
  gates between compatible changes, no intermediate PRs opened to be closed.
- Cadence never buys out a correctness gate. Batched work still passes the
  repository's full validation, every change still carries its evidence, and
  the sole-writer boundaries hold: one writer per branch or worktree, one
  agent per landing batch, and Hive as the only assignment authority.
  Parallelism belongs to reading; writing stays single-writer.

## Human Continuation

When a human must intervene to restart continuation or correct scheduling,
classify the control failure. Record the durable transition in the relevant
issue or pull request. If the lesson is reusable, add the smallest preventive
rule to the closest skill and verify it where practical; never create a
session diary.
