---
name: lab-broker
version: "1.0"
last_updated: 2026-09-06
id: lab-broker
one_line_purpose: Lend host Kubernetes cluster access to the review dashboard safely.
entry_point: docs/skills/lab-broker.md
category: ci-ops
status: active
tags: [kubernetes, broker, lab, gvisor, socket]
description: "Controls the host-side lab broker, private Unix domain socket handoff, and gVisor host-uds safety for review-queue sessions. Use when debugging lab workflows or broker socket connectivity."
metadata:
  type: procedure
  context7-sources: [/websites/kubernetes_io, /websites/podman_io_en]
---

# Lab Broker

> A maintainer may lend one `review-queue` session their own Kubernetes
> cluster. A host-side broker provides a private Unix socket boundary.

## When to Use

Load this when configuring `REVIEW_LAB=1`, debugging `scripts/review-lab-broker.py`,
or troubleshooting gVisor socket forwarding to the container.

## When Not to Use

Do not load this for cluster contributor scale-out (`cluster-workers.md`) or
standard container launches without cluster lab workflows.

## Security Boundary

What crosses into the container is exactly one Unix domain socket.
- No kubeconfig or credentials enter the container.
- No host filesystem access is permitted beyond the isolated socket directory.
- The broker answers exactly three typed verbs: `status`, `health`, `submit`.
- The broker dies with the foreground session (managed via `EXIT` trap).

## Core Process

1. `offer_lab_session` probes the current Kubernetes context name and node
   reachability without printing credentials or cluster endpoints.
2. If accepted (or `REVIEW_LAB=1`), `start_lab_broker` creates a private `0700`
   directory in `XDG_RUNTIME_DIR` and starts `scripts/review-lab-broker.py serve`.
3. Podman runtime check: under gVisor (`runsc`), `--runtime-flag=host-uds=open`
   is passed because gVisor blocks host domain sockets by default. Under `crun`
   or `runc`, the flag is omitted (as they reject it).
4. Personal lab skills (`lab-test`, `k3s-cluster-ops`, `kubernetes-specialist`,
   `live-dev-common`) are bind-mounted read-only if present on host.
5. On dashboard exit, the EXIT trap kills the broker process and deletes the
   temporary socket directory.

## Common Rationalizations

| Rationalization | Reality |
|---|---|
| "Mount kubeconfig directly." | Kubeconfig contains full cluster credentials. The broker enforces an RPC boundary. |
| "Always pass host-uds=open." | crun and runc fail immediately if passed runsc-specific flags. Probe runtime first. |

## Red Flags

- Mounting Docker or Podman sockets into the review container.
- Leaving broker processes alive after the dashboard exits.
- Requiring a live lab for normal pull request review.

## Verification

```bash
python3 tests/lab-broker-contract.py
REVIEW_LAB=1 just review-queue --dry-run
```
