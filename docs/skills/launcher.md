---
name: launcher
version: "5.4"
last_updated: 2026-09-23
id: launcher
one_line_purpose: Maintain the generic Review appliance launch contract.
entry_point: docs/skills/launcher.md
category: ci-ops
status: active
tags: [review, launcher, podman, apptainer, omp, credentials]
description: "Maintains the Review appliance launcher, scope handoff, and credential boundary."
metadata:
  type: runbook
  context7-sources: [/websites/podman_io_en]
---

# Review Launcher

## Public commands

| Command | Purpose |
| --- | --- |
| `bin/omp-review [owner/repo|org:<name>|flags...]` | Neutral source entry point. |
| `just review-appliance [owner/repo|org:<name>|flags...]` | Runs the packaged Review appliance. |
| `just review-queue [owner/repo|org:<name>|flags...]` | Compatibility alias for `review-appliance`. |
| `just review-appliance-build [tag]` | Builds the appliance and verifies its contract. |
| `just review-doctor` | Read-only runtime preflight; starts no agent. |

The `bluefin review` Homebrew command and `bluefin-review-dev` formula are retained install aliases. They are not the recommended source or product names.

## Scope and mode

`scripts/parse-review-args.sh` is the shared argument parser. Repository and organization scopes use `owner/repo` and `org:<name>`. A fresh interactive session asks for scope if none is explicit, restored, or configured; a headless caller must pass one. `REVIEW_DEFAULT_SCOPE` is the generic environment setting. The launcher must not infer scope from the fork parent, GitHub login, or image metadata.

GitHub-only Review is the default and makes no Hive request. Hive read-side data is available only when the operator sets `REVIEW_MODE=hive` and explicitly supplies `HIVE_HUB`. Never read `~/.config/hive/contributor.env` or mount a contributor registration.

## Isolation and lifecycle

The appliance prefers `podman run --runtime=krun` when Podman, krun, and `/dev/kvm` are available. Report missing prerequisites before isolated Apptainer fallback. Every run stays in the foreground with a unique container name and target-specific home, workspace, and scratch directories. `Ctrl-C` stops only the active invocation; never add detached or resurrected worker behavior.

The appliance owns its OMP profile and MCP configuration. Host OMP configuration is opt-in through `REVIEW_INHERIT_OMP_CONFIG=1`. Keep the explicit credential allowlist and Apptainer `--no-eval` boundary; do not put secrets in argv, logs, image layers, or unapproved host mounts. GitHub permission remains authoritative.

## Personal package compatibility

The current personal package workflow builds an immutable OCI image and matching SIF from a committed ref on `self-hosted`. Its historical Homebrew names remain for existing installations. New launcher controls use `REVIEW_*`; old `BLUEFIN_REVIEW_*` inputs are accepted only where the launcher still has a compatibility mapping. Do not add new Bluefin-prefixed settings.

## Verification

```bash
just --list
bash tests/just-onboarding.sh
bash tests/launcher-contract.sh
bash tests/appliance-contract.sh
python3 tests/brew_dev_contract.py
```
