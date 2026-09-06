---
name: launcher
version: "3.5"
last_updated: 2026-09-06
id: launcher
one_line_purpose: Change review just recipes without breaking the launch contract.
entry_point: docs/skills/launcher.md
category: ci-ops
mcp_compliance_level: partial
optimization_status: draft
status: active
dependencies: []
tags: [just, launcher, podman, container]
description: "Maintains the five review recipes and their credential boundaries. Use when editing justfile."
metadata:
  type: runbook
  context7-sources: [/websites/podman_io_en, /websites/kubernetes_io]
---

# Launcher

> The published image derives from the pinned lab-runner base and includes the
> contributor worker and maintainer dashboard. These procedures describe the
> launcher handoff and lifecycle for both modes.

## When to Use

Load this before editing `justfile` or changing container launch,
lifecycle, or credential-passthrough behavior.

## When Not to Use

Do not use this for Hive task selection, contributor-session triage, Goose
configuration internals, or image-layer pinning. Those belong to the Hive,
Goose, or image build skill documents.

## Core Process

1. Keep exactly five public recipes:

   | Recipe | Purpose |
   |---|---|
   | `review-container` | Run the Hive queue worker: the contributor container that receives assigned tasks. `REVIEW_DETACH=1` runs it detached. |
   | `review-stop` | Stop a detached worker; refuses attended runs and unlabeled containers. |
   | `review-doctor` | Perform read-only preflight checks. |
   | `review-queue` | Walk the live PR queue in the container; no Hive registration is mounted, but the selected hub URL is passed when configured. |
   | `turbo-review` | Scale three cluster contributor workers by default, then forward its arguments to the foreground `review-queue` dashboard. |

   `just` reads only the current directory's justfile, so these recipes fail
   with `justfile does not contain recipe` from any other checkout. That is
   `just`'s behavior, not a launcher bug: fix it outside the repository with a
   `~/.local/bin` shim that forwards these five names to this justfile, and
   do not add a wrapper recipe here to compensate.

2. Keep the interactive launch paths foreground, and the detached worker
   explicit. `REVIEW_DETACH=1` is the one permitted background launch: it
   stamps `review.owner=detached`, a later launch refuses to reclaim it, and
   `review-stop` is its only lifecycle verb — polite `podman stop`, never a
   force flag, and it refuses attended runs and containers it did not label.
   Nothing else may background a run. Persistent state is two directories:
   the launcher owns only the pinned Hive checkout under
   `~/.local/state/review/`, and `review-queue` mounts the dashboard's
   `bluefin-review` state directory from the host (below).
   Ctrl-C stops an interactive run; `--replace` only reclaims a container
   name when a new launch starts.
3. Keep the container path narrow. It mounts only the read-only Hive
   contributor configuration and runs the image entrypoint, which attaches to
   Hive's `contributor` session.
   `review-queue` runs the dashboard. If a registration exists, pass its
   `HIVE_HUB` URL (only `wss://` or `https://`). The dashboard binds
   `${XDG_STATE_HOME:-~/.local/state}/bluefin-review` with `rw,z` for landing
   records, passing `BLUEFIN_REVIEW_INSTANCE` so batch ids never collide.
   `REVIEW_HIVE` picks a named registration (`contributor.<name>.env`) before
   defaulting. Use shared `:z` relabelling (never `:Z`, which revokes access
   for concurrent workers).
4. Keep Goose as the default backend (`TOOL=goose`); Codex (`TOOL=codex`) and
   Pi (`TOOL=pi`) are explicit backends. Profiles set defaults:
   `gemini` (`gemini-3.8-flash`, high effort), `sol` (`gpt-5.6-sol`, medium),
   `opus5` (`claude-opus-5`, high, 264k context), `k3` (`kimi-k3`, max, 264k).
   Environment `GOOSE_*` always wins.
5. Pass credentials via inherited environment (`--env NAME`), never CLI args.
   Stage disposable Codex auth (`0600`) at `/home/dev/.codex/auth.json`.
6. When renaming launcher identifiers, do a full sweep and leave no aliases.

## Container Ownership

`podman run --rm -it` does **not** bind a container's lifetime to its client.
`conmon` supervises the container, survives the client, and reparents to
`systemd --user`, so a hard-killed terminal leaves a fully running, ownerless,
unreachable container — not merely an exited name. Inferring ownership from a
`pgrep` for the `podman run` command line cannot tell that apart from a live
session.

Ownership must be proven: stamp `--label review.owner=<boot-id>:<client-pid>`
at launch. A container is owned only when the PID is alive, the boot matches,
and the process still names the container. Unlabelled or dead-owner containers
are orphans reclaimed silently at next launch. There is no `pgrep` fallback.

## Concurrent Instances

Every ownership check is keyed on the container name, so the name is what
scopes an instance. `REVIEW_CONTAINER_NAME` overrides the default
`review-container` and is the only supported way to run a second contributor
agent at the same time:

```bash
REVIEW_CONTAINER_NAME=review-container-2 just review-container opus5 high
```

Keep it to that one variable. Do not add a `--name` recipe parameter, instance
numbering, a multi-instance manager, or any registry of running instances;
that would be launcher state and task-selection surface this repository does
not have.

Validate user-supplied names against `[a-zA-Z0-9][a-zA-Z0-9_.-]*` before
launch. Hive selects tasks; the launcher never filters or skips assignments.

## Cluster Contributor Scale-Out

For unattended cluster workers, `just review-container cluster [N]` and
`just turbo-review *args` scale out contributor workers across Kubernetes.
See [`cluster-workers.md`](cluster-workers.md) for full scale-out details,
secret synchronization, and `turbo-review` orchestration.

## Rootless Podman And Mounted Host Files

Rootless Podman maps the host user to container **root**, not to the container
user of the same uid. A mounted host file keeps its mode, so Hive's
`contributor.env` at `0600` arrives root-owned and the image's `dev` user
cannot read it — the agent dies at startup with `Permission denied` before any
work begins. Launch with `--userns keep-id:uid=1000,gid=1000` so the host user
maps onto `dev`. Never answer this by loosening the host file's mode; it holds
Hive credentials.

A locally built image has no registry behind it and is not a moving tag.
Build local images under the `sha-<commit>` tag CI mints for that commit.
Absent from local storage is the final answer for a `localhost/` ref:
fail immediately rather than attempting remote registry dials.

`just --list` in another repository shows only that repository's recipes, so
run `just review-container` from this checkout, or pass `--justfile`, when you
want to be certain which launcher you are invoking.

## The Optional Lab

A maintainer may lend one `review-queue` session their own Kubernetes cluster
(#379). A host broker on `scripts/review-lab-broker.py` provides a private
Unix socket (`--runtime-flag=host-uds=open` under gVisor `runsc`). No
kubeconfig or credentials enter the container. See [`lab-broker.md`](lab-broker.md)
for full broker details.

## Common Rationalizations

- "It's only a comment or test fixture." Workflow assertions, onboarding
  fixtures, and operator comments are part of the public launcher surface and
  must be rebranded with the code.
- "We can leave an alias for safety." This launcher's contract is a clean
  break; aliases preserve stale instructions and weaken test coverage.
- "Passing `--env NAME=value` is equivalent." For secrets it is not: inherited
  `--env NAME` avoids printing values into the Podman command line.
- "Mounting `~/.codex` is simpler." It also passes provider configuration and
  lets a container mutate the host login. Stage only `auth.json`; never mount
  the directory or the original file.

## Red Flags

- An undocumented public recipe, or an implicit background launch with no
  matching lifecycle verb.
- An interactive launch path whose final process is neither `exec`'d nor the
  last foreground command whose status propagates (`nohup`, `setsid`).
  Background jobs the shell `wait`s on and reaps by trap are allowed for signal handling.
- A host directory mount beyond the read-only Hive configuration for the
  contributor container, or a host Codex config/login mount instead of the
  one-run staged auth file.
- A token in output, files, Podman arguments, or any persisted launcher file.
- Ownership inferred from `pgrep` rather than a label plus a live, same-boot,
  still-naming PID.
- A user-supplied container name reaching `podman run` or an ownership probe
  unvalidated, or a hint that names the default container instead of the one
  the caller asked for.
- A model-catalog or model-ID validity check in the launcher; only the profile
  name is a closed set.
- Contributor task-selection policy outside Hive (own-work exclusion on the
  maintainer queue view is the one permitted filter).

## Verification

```bash
just --list
just review-doctor
bash tests/just-onboarding.sh
git diff --check
```

The recipe list must contain only the five public commands. Doctor must not start a container.

## Sources

- Podman environment inheritance: Context7 `/websites/podman_io_en`
