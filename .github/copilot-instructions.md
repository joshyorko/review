# Copilot instructions for Review

## Read the local contract first

Before changing this repository, read `AGENTS.md`, `docs/factory/agentic-model.md`, `docs/SKILL.md`, and the matching guide under `docs/skills/`. Verify repository-specific commands and runtime claims against the current launcher, image, tests, workflow, or local contract.

This repository ships one OMP Review appliance, the GitHub-generic Review extension, and Luna Factory co-loaded beside it. `image/extension/bluefin-review/` is a historical source path, not a Project Bluefin product boundary. There is no Blueberry mode, local Contribute worker, contributor image, or organization policy adapter.

## Route work to the right surface

| Goal | Entry point | Boundary |
| --- | --- | --- |
| Review GitHub PRs or issues | `bin/omp-review owner/repo`, `just review-appliance owner/repo`, or `bluefin review owner/repo` | The installed `bluefin` command is a compatibility alias. Review uses GitHub permissions and live evidence. |
| Review an organization | `bin/omp-review org:acme` or the appliance with `org:acme` | No default organization is inferred. Headless callers supply a scope. |
| Develop the extension | `bin/omp-review` | Source OMP entry point; the appliance remains the runtime boundary. |
| Build the appliance | `just review-appliance-build [tag]` | One Review appliance, used by the OCI and personal package paths. |
| Diagnose launch readiness | `just review-doctor` | Read-only preflight; starts no agent. |
| Run bounded Factory work | Select Luna Factory from Review | Factory execution is opt-in and keeps its own admission, claims, receipts, and state. |

Review defaults to GitHub-only mode. `REVIEW_MODE=hive` explicitly enables the optional Hive read-side integration, and `HIVE_HUB` must be explicit. Normal Review never discovers `~/.config/hive/contributor.env`, requires a Hive account, or injects Hive data into issue work.

## Authority and execution

GitHub remains authoritative for repository state and permissions. OMP owns agents, sessions, tools, tasks, and workflowz. Review agents return read-only evidence; only explicit human intent delegates a bounded mutating lifecycle. Preserve exact-head checks, live permission and ruleset checks, workflow-file safeguards, claims, and no-self-review/approval/merge boundaries.

Luna Factory is packaged with Review but starts no work on load. `LUNA_FACTORY_ENABLED=1` opts into execution. Do not infer Factory admission from a visible queue item or optional Hive rank. Keep current-subject evidence, durable attempt identity, claims, and blocked/unknown reasons truthful.

The appliance prefers Podman `krun` with KVM and falls back to isolated Apptainer when prerequisites are unavailable. Runs remain foreground and signal-responsive. Secrets use approved environment names only; host OMP configuration is isolated unless explicitly opted in with `REVIEW_INHERIT_OMP_CONFIG=1`.

## Models and dependency pins

The appliance and companion agents do not select a provider, model, or effort; OMP resolves the user's active configuration. Renovate updates the OMP and GitHub CLI release pins for the appliance and regenerates the hashed CI requirements lock. Keep version and per-architecture digests synchronized with their updater tests. The image derives from the pinned FSDK base and does not install an alternate agent runtime.

## Validate by changed surface

| Changed surface | Focused validation |
| --- | --- |
| Review mode or scope | `bash tests/omp-review-mode.sh` |
| Appliance or SBOM | `bash tests/appliance-contract.sh`; with an engine, `just review-appliance-build` |
| Review/Factory bridge | `bash tests/test-registry.sh`, `bash tests/review-factory-coload-smoke.sh`, and relevant Luna Factory tests |
| Launcher | `bash tests/just-onboarding.sh`, `bash tests/launcher-contract.sh` |
| Personal package | `python3 tests/brew_dev_contract.py`, `python3 tests/personal_brew_oci_contract.py` |
| Skill frontmatter/catalog | `bash scripts/check-skill-frontmatter.sh`; use `--write` only to regenerate the index |

Run focused checks for the changed contract, then report skipped runtime evidence explicitly. Never leave validation calling a deleted Contribute surface or documentation describing it as current.
