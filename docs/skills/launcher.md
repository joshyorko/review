---
name: launcher
version: "5.3"
last_updated: 2026-09-15
id: launcher
one_line_purpose: Change review just recipes without breaking the launch contract.
entry_point: docs/skills/launcher.md
category: ci-ops
mcp_compliance_level: partial
optimization_status: draft
status: active
dependencies: []
tags: [just, launcher, podman, kubernetes, omp, hive]
description: "Maintains the OMP appliance and Hive contributor launcher recipes without crossing their credential or authority boundaries."
metadata:
  type: runbook
  context7-sources: [/websites/podman_io_en, /websites/kubernetes_io]
---

# Launcher

## Public commands

| Recipe | Purpose |
| --- | --- |
| `review-queue [flags...]` | Convenience alias for `review-appliance`; opens one isolated OMP review appliance. |
| `review-appliance [flags...]` | Runs `ghcr.io/projectbluefin/review`, preferring Podman `krun` and falling back to Apptainer. |
| `review-appliance-build [tag]` | Builds and verifies the review image locally. |
| `review-container [instance]` / `contribute [instance]` | Same Hive-authorized OMP worker; an optional instance selects its named Hive registration. |
| `contribute cluster [N]` | Scales independent Hive + OMP workers. |
| `review-stop [cluster]` | Stops cluster workers; local appliances stop with their terminal. |
| `review-doctor` | Read-only preflight; starts no agent. |

`review-queue` must remain delegation, not a second implementation. It and
`review-appliance` use the same image, entrypoint, OMP configuration, extension,
state volume, credentials, and argument parser.

## Authority boundary

The maintainer workbench reads live GitHub state and optional Hive ordering. It
does not register as a Hive contributor and does not select or complete Hive
assignments.

The contributor image contains Hive's worker runtime only. Hive chooses the
task, injects the prompt, owns the `contributor` tmux session, and captures the
result. The entrypoint may validate credentials and attach the terminal; it
must not filter, reorder, retry, or interpret assignments.

## Isolation and lifecycle

Every packaged appliance command prefers `podman run --runtime=krun` when
Podman, `krun`, and `/dev/kvm` are available. Otherwise it reports the missing
prerequisite and falls back to isolated Apptainer execution. Container names
include the target and a per-process suffix, so simultaneous KVM invocations
cannot replace one another. Persistent OMP homes are target-specific;
`BLUEFIN_INSTANCE` explicitly separates two sessions for the same target.

Every interactive microVM stays attached to its launching terminal. Do not add
`--detach`, `-d`, `nohup`, `setsid`, systemd units, or resurrection commands.
Ctrl-C stops only that invocation. `review-stop cluster` is reserved for the
Kubernetes worker deployment.
Apptainer omits its default `/etc/localtime` or `/etc/hosts` mount only when
that host source is absent or a dangling symlink; present sources retain the
runtime default.
Fallback also requires `squashfuse_ll` or `squashfuse` and a readable,
writable character device at `/dev/fuse`; `review-doctor` reports each missing
prerequisite separately before launch.
The doctor checks both published images through reachable Podman or `skopeo`.
If Apptainer is the only runtime and no read-only registry probe exists, it
reports image resolution as deferred to launch instead of misclassifying the
remote reference as a missing local SIF.
On the Podman path, every mutable image tag is refreshed before launch. A
registry outage may use an existing local copy only with an explicit stale-image
warning; a missing local copy fails before `podman run`. Digest and `sha-*`
references remain immutable and are not refreshed.
After Podman resolves an image, the launcher reports its OCI version, source
revision, and digest before execution; missing labels are shown as `unknown`
rather than inferred.

## Credentials

- Pass secrets only through inherited environment names or documented private
  mounts. Never put values in arguments, logs, image layers, socket paths, SSH
  targets, or committed files.
- Preserve `--userns keep-id` for the `0600` contributor registration.
- The OMP appliance receives GitHub/provider credentials by inherited name and,
  when `HIVE_HUB` is unset, resolves the hub from the host's default
  `~/.config/hive/contributor.env` without mounting its registration token.
- The explicit provider environment contract is:
  - GitHub: `GH_TOKEN`, `GITHUB_TOKEN`.
  - Copilot: `COPILOT_GITHUB_TOKEN`, `GITHUB_COPILOT_TOKEN`,
    `COPILOT_INTEGRATION_ID`.
  - Anthropic: `ANTHROPIC_API_KEY`, `ANTHROPIC_OAUTH_TOKEN`.
  - OpenAI and Gemini: `OPENAI_API_KEY`, `GEMINI_API_KEY`.
  - Amazon Bedrock: `AWS_BEARER_TOKEN_BEDROCK`, `AWS_REGION`,
    `AWS_DEFAULT_REGION`.
  This same allowlist is used by Podman's `--env` forwarding and Apptainer's
  `APPTAINERENV_` forwarding. The launcher does not pass the broader AWS
  credential or configuration environment.
- Apptainer's contained environment receives only the explicit credential and
  runtime allowlist through `APPTAINERENV_` variables. Keep `--no-eval` so
  credential and argument values remain literal inside the container.
- The contributor worker receives exactly one selected Hive registration.
- The checkout contributor recipe stages remote Podman registrations privately
  and deletes only its validated staging directory. The packaged `bluefin`
  launcher uses local Apptainer when Podman selects a remote engine; it never
  sends client-side credential bind paths to that engine.

## Personal SIF and audio

The personal Brew bundle carries a full-commit personal OCI reference and a
native immutable SIF built from the same source. The generated `bluefin`
wrapper selects the OCI image through Podman/krun when KVM is ready and sets
the bundled SIF as the Apptainer fallback. An explicit `BLUEFIN_REVIEW_SIF`
still forces a SIF. The target-specific `/home/bluefin` state boundary remains
the same on both paths. The SIF contains Headroom's MCP runtime and the OMP
Linux voice closure.

For Review voice, the packaged launcher binds only a detected
`$XDG_RUNTIME_DIR/pulse/native` socket and sets the contained `PULSE_SERVER`.
It binds the host Pulse cookie read-only when present. Without that socket it
binds `/dev/snd` only when the device exists; it never binds the entire runtime
directory, host home, or `.codex`. Missing audio never prevents Review startup.

## Arguments

`scripts/parse-review-args.sh` is the single parser for OMP review scope.
Repository, `--pr`, and `--issues` arguments must reach the appliance unchanged.
Every review launch passes OMP's built-in `--advisor` flag exactly once. The
source launcher also normalizes its parser-fallback path, and the packaged
entrypoint repeats the normalization for direct image launches. The appliance
configuration maps `modelRoles.advisor` to `@default` rather than selecting a
provider.
The optional contributor argument names an isolated instance and its
`contributor.<org-repo>.env`; Hive still selects work. OMP owns model choice.

## Verification

```bash
just --list
just --dry-run review-queue --issues
bash tests/just-onboarding.sh
bash tests/appliance-contract.sh
git diff --check
```
