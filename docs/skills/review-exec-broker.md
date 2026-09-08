---
name: review-exec-broker
version: "1.0"
last_updated: "2026-09-06"
id: review-exec-broker
one_line_purpose: Offload selected batch reviews through a session-scoped host broker.
entry_point: docs/skills/review-exec-broker.md
category: ci-ops
status: active
tags:
  - review
  - broker
  - kubernetes
  - socket
  - batch
description: "Maintains the optional review-exec UDS broker, typed review Jobs, session cleanup, and local fallback."
metadata:
  type: procedure
---

# Review Execution Broker

The review execution broker (`scripts/review-exec-broker.py`) provides an optional,
session-scoped mechanism to offload concurrent batch reviews to a Kubernetes cluster
without exposing cluster credentials or host networking to the review container.

## Architecture

- **Host Broker (`scripts/review-exec-broker.py`)**: Runs on the host, bound to a private
  Unix domain socket in a 0700 runtime directory (`mode 0600` socket). Listens for typed
  JSON-over-newline requests.
- **Container Boundary**: The container mounts only the private socket at
  `/run/bluefin-review-exec/broker.sock`. The container receives no `kubeconfig`, no
  Kubernetes tokens, and no cluster binaries.
- **Job Execution**: Submits Kubernetes batch Jobs to the `bluefin-system` namespace. Each
  Job runs `/usr/local/bin/bluefin-review receipt` inside the published container image.
- **Labels & Deadlines**: Every Job is stamped with `review.session`, `review.repository`,
  `review.pr`, `review.head`, `activeDeadlineSeconds: 3600`, and `ttlSecondsAfterFinished: 3600`.
- **Local Fallback**: If the broker is unreachable, returns an error, or times out,
  `ReviewEngine` immediately falls back to `LocalExecutor` for that pull request.

## Protocol Actions

The broker speaks protocol version `1` and accepts exactly four actions:
1. `submit`: Submits a review Job for a repository, PR number, base SHA, head SHA, backend, model, and effort.
2. `status`: Returns active/succeeded/failed counts for Jobs belonging to this session.
3. `logs`: Returns stdout/stderr log output containing the completed `ReviewReceipt` JSON.
4. `cancel`: Deletes an individual review Job.

## Lifecycle

- `review-queue` detects an active Kubernetes context and offers session offloading once on `/dev/tty`.
- When accepted, the launcher starts `review-exec-broker.py serve` in the background and mounts the socket into the container.
- An EXIT trap kills the broker process and sweeps all Jobs created for that session.
