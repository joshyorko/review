---
name: luna-factory
version: "0.1"
last_updated: 2026-09-20
id: luna-factory
one_line_purpose: Keep the Luna Factory protocol's mechanical decisions in tested extension code.
entry_point: docs/skills/luna-factory.md
category: ci-ops
mcp_compliance_level: partial
optimization_status: draft
status: active
dependencies: [review-dashboard, contribution-culture]
tags: [omp, extension, factory, evidence, admission]
description: "Maintains the opt-in Luna Factory extension in image/extension/luna-factory/. Use when editing admission, evidence reconciliation, convergence, or repair lineage."
metadata:
  type: runbook
  context7-sources: []
---

# Luna Factory Extension

`image/extension/luna-factory/` is an opt-in OMP extension that ships beside the
Review workbench. It keeps the Luna Factory protocol and moves the mechanically
checkable parts of it — admission, task state, evidence binding, repair lineage,
completion — out of conversational memory and into tested code.

It is not a second runtime. It adds no database, daemon, scheduler, or worker
store, and it does not own execution: OMP does.

## When to Use

Use this skill for the reducer, admission rule, evidence reconciliation,
convergence verdict, journal, capability table, or the extension's tool surface.

## When NOT to Use

Use `review-dashboard.md` for the Review workbench, `launcher.md` for container
launch mechanics, and `contribution-culture.md` for scoping the change itself.

## Core Process

1. Decide which layer the change belongs to. `core/` is pure and must stay
   host-free: no terminal, no clock, no model. `omp/` is the host and capability
   boundary. `ui/` only projects the ledger.
2. Change the rule, then drive it from `tests/luna_factory.test.ts`. The suite
   drives the pure core directly, so a new rule needs no TUI to be exercised.
3. Keep the capability table honest. A path that cannot be probed against the
   packaged OMP is `unsupported`, and the adapter must refuse it rather than
   route through it.

## Invariants

- A returned worker moves to VERIFY. Only `finish_task` against a receipt that
  reconciles as proven at the current subject reaches DONE.
- Integration moves the certified subject, which demotes proof taken against the
  old head. Proof freshness is not optional.
- Identity is stamped by the adapter from the ledger. A receipt naming another
  task, attempt, generation, or subject is contradicted, not merely weak.
- Artifact references outside the run's roots are rejected, never followed.
- CONVERGED means mandatory acceptance has current valid proof. QUIESCENT means
  no authorized autonomous progress remains and may be unconverged. An empty
  queue, an exhausted budget, and a returned worker imply neither.
- Completion creates no merge, publish, or deploy authority.
- Loading the extension starts nothing. Execution requires
  `LUNA_FACTORY_ENABLED=1`, and Factory never infers an admission from a Hive
  rank or a visible queue row.
- `LUNA_FACTORY_ENABLED` and `LUNA_FACTORY_CAPACITY` are the only Factory
  runtime knobs that are user configuration; both cross the personal appliance
  boundary by name, and neither value is ever rendered into argv. Loading
  Factory with the opt-in absent leaves it registered and discoverable, with
  execution disabled.
- Review advertises its Factory handoff only while a Factory controller is
  registered. When the handoff is unreachable, startup and the first
  invocation report the bounded cause — package absent or not passed as an
  `--extension` versus a packaged extension that failed to load — instead of
  blaming the execution opt-in.
- The Review/Factory command bridge stores selection, controller, and bounded
  load failure state in one versioned global slot, so cache-busted extension
  module copies retain the same handoff and identity-safe cleanup.

## Verification

```bash
bash tests/omp-review-mode.sh
bash tests/appliance-contract.sh
bash tests/test-registry.sh
BLUEFIN_REVIEW_IMAGE=review:test bash tests/review-factory-coload-smoke.sh
git diff --check
```

`tests/luna_factory.test.ts` runs under `tests/omp-review-mode.sh` with the rest
of the extension contracts, so a new suite is registered by naming it there.
## Selected batches and runtime boundaries

Factory batches use the existing OMP command bridge (`factoryCommand`) and one
same-host state root. A run once command exits when work is complete or blocked;
retain keeps the journal, patches, logs, and native artifacts for `inspect`,
`resume`, `pause`, `stop`, `export`, or explicit `discard`. Stop cancellation
does not claim rollback or release a conflicting writer until cancellation is
confirmed. There is no detached service or nested tool runtime.

The shared bound includes native Factory workers, retries, verification, and
reviewer tasks; unrelated Review work remains usable. Resource ownership is
keyed by the lower-case repository and item identity in the state root.
Remote, gateway, and distributed workers are deferred, as are parent #111 gates;
this skill does not claim dogfood or packaged-runtime success without evidence.
