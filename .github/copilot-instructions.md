# Copilot instructions for Review

## Read the local contract first

Before changing this repository, read `AGENTS.md`, `docs/factory/agentic-model.md`, `docs/SKILL.md`, and the matching guide under `docs/skills/`. Verify repository-specific commands and runtime claims against the current launcher, image, tests, workflow, or local contract.

This repository ships one OMP Review appliance, the GitHub-generic Review extension, and Luna Factory co-loaded beside it. `image/extension/review/` contains the Review workbench.

## Route work to the right surface

| Goal | Entry point | Boundary |
| --- | --- | --- |
| Review GitHub PRs or issues | `bin/review-source owner/repo`, `just review-appliance owner/repo`, or `review owner/repo` | Review uses GitHub permissions and live evidence. |
| Review an organization | `bin/review-source org:acme` or the appliance with `org:acme` | No default organization is inferred. Headless callers supply a scope. |
| Develop the extension | `bin/review-source` | Source OMP entry point; the appliance remains the runtime boundary. |
| Build the appliance | `just review-appliance-build [tag]` | One Review appliance, used by the OCI and personal package paths. |
| Diagnose launch readiness | `just review-doctor` | Read-only preflight; starts no agent. |
| Run bounded Factory work | Select Luna Factory from Review | Factory execution is opt-in and keeps its own admission, claims, receipts, and state. |

Review uses GitHub for its queue and current repository state. It does not discover contributor-registration files or use external queue configuration.

## Authority and execution

GitHub remains authoritative for repository state and permissions. OMP owns agents, sessions, tools, tasks, and workflowz. Review agents return read-only evidence; only explicit human intent delegates a bounded mutating lifecycle. Preserve exact-head checks, live permission and ruleset checks, workflow-file safeguards, claims, and no-self-review/approval/merge boundaries.

Luna Factory is packaged with Review but starts no work on load. `LUNA_FACTORY_ENABLED=1` opts into execution. Do not infer Factory admission from a visible GitHub queue item. Keep current-subject evidence, durable attempt identity, claims, and blocked/unknown reasons truthful.

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
| Personal package | `python3 tests/package_review_contract.py`, `python3 tests/package_oci_contract.py` |
| Skill frontmatter/catalog | `bash scripts/check-skill-frontmatter.sh`; use `--write` only to regenerate the index |

Run focused checks for the changed contract, then report skipped runtime evidence explicitly. Never leave validation calling a deleted Contribute surface or documentation describing it as current.
