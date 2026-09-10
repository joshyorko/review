# Copilot instructions for `review`

## Read the local contract first

Before changing this repository, read `AGENTS.md`, then
`docs/factory/agentic-model.md`, `docs/SKILL.md`, and the one task-specific
file under `docs/skills/`. Read `docs/skills/contribution-culture.md` alongside
every task-specific skill. The local launcher, image, tests, and documentation
must describe the same authority model.

Use session history, issue reports, and prior agent output only to find a
relevant source. Before asserting a repository-specific command, workflow, or
runtime behavior, verify it in the current launcher, image, test, workflow, or
local contract.

`review` ships two OCI images and the root `justfile` launcher: the distroless
appliance (`image/appliance/Containerfile` -> `ghcr.io/projectbluefin/review`)
and the contributor runtime (`image/Containerfile` ->
`ghcr.io/projectbluefin/review-contributor`), which carries the Textual
dashboard and the Hive worker.
`image/` contains the FSDK-derived runtime and maintainer dashboard;
`image/extension/bluefin-review/` is the omp review mode, the one piece of
TypeScript here, loaded from source by omp and gated by
`tests/omp-review-mode.sh`; `tests/` contains shell, Python, and Node contract
tests. The root `package.json` is only for the image's pinned `ws` dependency;
this is not a Node application.

## Route an operational request to the right command

| User goal | Command | Authority and lifecycle |
| --- | --- | --- |
| Contribute one local Hive worker | `just review-container` | Hive selects and assigns tasks. |
| Scale cluster contributors | `just review-container cluster [N]` | Workers are separate from the maintainer dashboard. |
| Review live pull requests | `just review-queue [profile] [effort] [flags...]` | Foreground maintainer dashboard; it does not register with Hive. |
| Review live pull requests from an omp session | `bin/omp-review [number\|issues]` | Foreground maintainer mode; keyboard only, no slash commands. |
| Review from the shipped container | `just review-appliance [flags...]` | Distroless appliance `ghcr.io/projectbluefin/review`; no host toolchain. |
| Stop deliberately detached local workers or cluster workers | `just review-stop [name\|cluster]` | Use the explicit lifecycle command. |
| Diagnose launch readiness | `just review-doctor` | Read-only preflight; starts no agent. |

Never make task selection, assignment, completion, or priority decisions for
Hive. The maintainer owns review, approval, queueing, and merge decisions.

The review mode consumes Hive rather than competing with it: when a hub is
configured it orders the queue by Hive's own positions and never recomputes
them, and when no hub is configured it classifies the queue locally using the
dashboard's action vocabulary (`ready-for-human-merge`, `review`,
`resolve-conflicts`, `fix-ci`, `investigate`, `triage`). Any change that adds a
priority signal belongs on the local side of that seam, never on Hive's.

## Spawn agents on the project's model

Subagent work in this repository runs on Gemini 3.8 Flash, pinned in
`.omp/config.yml` under `task.agentModelOverrides`. Judgement work — `reviewer`,
`security-reviewer`, `bluefin-doctrine` — runs the same model at high effort
rather than a different model, so a wide fan-out stays affordable and its output
stays consistent with what the appliance itself produces. That file deliberately
sets no `modelRoles.default`: the model a human drives is theirs to pick.

The agents shipped inside the appliance
(`image/extension/bluefin-review/agents/`) pin `provider/model` directly. They
travel to machines with no project config, and a dangling `@role` alias does not
fail there — it silently falls back to whatever the parent session is running.

## Inspect live state; preserve active work

The PR queue is live GitHub/Hive evidence. Inspect it through the active
container, GitHub, Hive, or
`${XDG_STATE_HOME:-~/.local/state}/bluefin-review/landings/`; never create or
consume a static queue snapshot.

Before diagnosing or remediating a running appliance, inspect its live
container/Pod state, process tree, mounts, and recent logs. Treat attended
containers and dashboard sessions as user-owned: a pull or rebuild affects
only future launches. Keep interactive runs foreground and signal-responsive;
never stop, restart, kill, or reclaim an active attended instance to clear a
stale state.

## Keep launcher mutations explicit and credential-safe

For cluster scale-out changes, validate the resolved `HIVE_HUB` and selected
credentials before the first Kubernetes mutation. Preserve the launcher's
non-blocking fallback when Kubernetes is unavailable, but propagate failures
from secret synchronization, legacy-annotation removal, and scale operations
with actionable errors rather than masking them.

Pass secrets only through inherited environment variables or the documented
restricted mounts. Do not put credential values in arguments, logs, committed
files, Podman endpoints, socket paths, SSH targets, kubeconfigs, host-home
mounts, or static state. Preserve `--userns keep-id` for rootless Podman
access to the `0600` Hive contributor credential; never loosen that file's
permissions as a workaround.

## Validate by changed surface

Run the smallest existing contract test that covers the change:

| Changed surface | Focused validation |
| --- | --- |
| Root launcher or cluster handoff | `just --list`, `just review-doctor`, `bash tests/just-onboarding.sh` |
| Dashboard/TUI behavior | `bash tests/dashboard-contract.sh` |
| omp review mode (`image/extension/bluefin-review/`) | `bash tests/omp-review-mode.sh` |
| Review appliance image or its version scheme | `bash tests/appliance-contract.sh`; with an engine, `just review-appliance-build` |
| Image/runtime contract | `bash tests/image-contract.sh` |
| One Python contract | `python3 tests/<contract>_contract.py` (for example, `python3 tests/review_engine_contract.py`) |
| Skill frontmatter or skill catalog | `bash scripts/check-skill-frontmatter.sh`; use `--write` only to regenerate `docs/skills/index.json` |

Launcher tests are hermetic: fake external tools and assert exact commands or
observable behavior. Do not allow a missing-tool scenario to fall through to a
host `kubectl`, Podman service, cluster, or credential. For broad hygiene, run
`pre-commit run --all-files`, which includes ShellCheck via the
shellcheck-py wheel (no container pull). Finish changes
with `git diff --check`.
