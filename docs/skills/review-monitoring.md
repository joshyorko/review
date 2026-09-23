---
name: review-monitoring
version: "2.2"
last_updated: 2026-09-23
id: review-monitoring
one_line_purpose: Observe Review and Factory without disturbing active work.
entry_point: docs/skills/review-monitoring.md
category: ci-ops
status: active
tags: [monitoring, review, omp, factory, container]
description: "Use when observing or diagnosing an attended Review appliance or Luna Factory run."
metadata:
  type: procedure
  context7-sources: [/websites/podman_io_en]
---

# Review and Factory Monitoring

## Surfaces

- `just review-appliance` and its `review-queue` alias launch the same foreground OMP appliance.
- `bin/omp-review` runs the source extension for development.
- Luna Factory runs inside the same OMP session when explicitly enabled; it is not a daemon or a second runtime.

## Observe without disturbing

1. Identify the exact OMP process, session, container, or Factory run reported by the operator.
2. Inspect its state, process tree, mounts, recent logs, and relevant session transcript.
3. Treat attended sessions as user-owned. Never stop, restart, replace, or reclaim one just to gather evidence.
4. Queue truth comes from live GitHub. Hive reads are relevant only if the user explicitly selected Hive mode; no static queue snapshot is authoritative.
5. OMP state may support session and Factory recovery, but it does not replace current GitHub state or prove a worker is still live.
6. Distinguish provider, tool, and runtime errors from benign warning labels by the observed effect. A clean log alone does not prove the intended lifecycle completed.

## Failure boundaries

- Missing queue: inspect explicit scope, GitHub authentication, and GitHub API evidence.
- Missing Factory handoff: inspect extension packaging/loading and the Review-to-Factory bridge before changing execution opt-in.
- Explicit Hive mode unavailable: verify that `HIVE_HUB` was supplied and the read-side request result is current; do not make normal Review depend on it.
- Appliance startup failure: run `just review-doctor` without starting another agent.

## Verification

```bash
just review-doctor
bash tests/just-onboarding.sh
bash tests/omp-review-mode.sh
bash tests/test-registry.sh
```
