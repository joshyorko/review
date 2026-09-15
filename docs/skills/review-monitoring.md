---
name: review-monitoring
version: "2.1"
last_updated: 2026-09-14
id: review-monitoring
one_line_purpose: Monitor OMP workbenches and Hive contributor workers.
entry_point: docs/skills/review-monitoring.md
category: ci-ops
status: active
tags: [monitoring, review, omp, hive, container]
description: "Use when observing or diagnosing a running OMP review appliance or Hive contributor worker."
metadata:
  type: procedure
  context7-sources: [/websites/podman_io_en]
---

# Review Runtime Monitoring

## Surfaces

- `review-queue` and `review-appliance` are the same foreground OMP appliance.
- `review-container` is a separate foreground Hive contributor worker.
- Cluster contributors are independent workers managed by
  `review-container cluster` and `review-stop cluster`.

There is no second maintainer UI, dashboard sidecar, landing broker,
review-exec broker, or Kubernetes maintainer Pod.

## Observe without disturbing

1. Identify the exact container or Pod owned by the reported session.
2. Inspect its state, process tree, mounts, and recent logs.
3. For the OMP appliance, verify the `omp` process and workbench output.
4. For a contributor, verify `contributor-agent.sh`, Hive's relay, the
   `contributor` tmux session, and the selected backend process.
5. Treat an attended process as user-owned. Never stop, restart, or replace it
   merely to gather evidence.
6. Inspect the active session transcript as well as the process log. A forbidden
   tool call can succeed cleanly and leave no error-level log entry.

Queue truth comes from live GitHub and Hive reads. Do not create or consult a
static queue snapshot. OMP's state volume may be inspected for session and
batch recovery, but it is not a substitute for current GitHub state.

## Read the complete run

- Read the process log, every top-level session, child-session transcript, and
  persisted tool-output log for the run. Process warnings alone miss command
  failures; transcript errors alone miss lifecycle and provider failures.
- Classify by observed effect, not severity label. `Async job completion
  delivery failed` with `Yield queue entry became stale: async-result` can mean
  a `hub jobs`/`hub wait` snapshot already consumed the result; confirm the job
  remains retrievable before calling it lost (upstream OMP issue
  [#10378](https://github.com/can1357/oh-my-pi/issues/10378)).
- `Python kernel shutdown not confirmed` is an upstream OMP teardown defect
  tracked in [#7714](https://github.com/can1357/oh-my-pi/issues/7714). Record
  frequency and check for a surviving kernel; do not restart an attended
  appliance merely to clear it.
- Loopback discovery warnings for Ollama, LM Studio, and llama.cpp describe
  providers unreachable across the container boundary, not a failure of the
  selected remote model. Do not disable or filter models downstream; model
  availability remains OMP and user policy.

## Failure boundaries

- No queue data: inspect GitHub authentication and the optional `HIVE_HUB`.
- No contributor assignment: follow `hive-triage.md`; do not add client-side
  selection or retry logic.
- Missing OMP workbench: inspect extension loading and run
  `tests/omp-review-mode.sh`.
- Container startup failure: run `just review-doctor` without starting another
  agent.

## Verification

```bash
just --list
just review-doctor
bash tests/just-onboarding.sh
bash tests/omp-review-mode.sh
```
