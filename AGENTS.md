# Review + Luna Factory — Agent Operating Contract

This repository ships a GitHub-generic Review workbench and Luna Factory for Oh My Pi (OMP). The current product source is [`joshyorko/review`](https://github.com/joshyorko/review); the repository remains in its existing fork network. Do not detach, recreate, transfer, or rewrite that network.

## Read order

1. This file.
2. [`docs/factory/agentic-model.md`](docs/factory/agentic-model.md).
3. [`docs/SKILL.md`](docs/SKILL.md).
4. The one task-specific guide in `docs/skills/`.

## Product boundary

- Review is GitHub-only by default. It accepts `owner/repo` and `org:<name>`; a fresh session never infers a scope from this fork, the GitHub login, or historical defaults. Use an explicit scope, `REVIEW_DEFAULT_SCOPE`, a restored Review scope, or the interactive selector. Headless callers must supply a scope.
- `REVIEW_MODE=hive` explicitly opts into the optional Hive read-side integration; set `HIVE_HUB` explicitly. Normal Review makes no Hive calls and does not inspect contributor registrations. Hive data never assigns work to this repository's agents.
- Blueberry, the local Contribute worker product, Project Bluefin repository policy, and organization-prefix routing are retired. Do not reintroduce them or add a replacement persona. Repository-specific policy must be explicit and generic.
- Luna Factory remains packaged beside Review. Loading it starts no work; execution is opt-in through `LUNA_FACTORY_ENABLED=1` and follows its tested admission, claims, evidence, and reconciliation rules.
- Historical filesystem, image, formula, and launcher names may remain where they are part of the existing personal install path. Treat them as compatibility details, not product defaults. Do not add new Project Bluefin coupling.

## Authority and safety

- GitHub owns repository state and permission checks. OMP owns sessions, agent execution, tasks, tools, workflowz dispatch, and cancellation. Review owns the GitHub queue projection, evidence presentation, durable human intent, and mutation guards.
- Review specialist agents are read-only. A confirmed human action may delegate a bounded coordinator lifecycle; an agent verdict alone never authorizes a GitHub mutation.
- Preserve exact-head and evidence-freshness checks, live permission/ruleset checks, workflow-file safety, mutation/resource claims, single-writer exclusion, truthful blocked/unknown reasons, and safe reconciliation of ambiguous effects.
- Never infer Factory admission from a visible GitHub or Hive queue row. Keep worker/reviewer authority, current subject, receipts, and claims aligned.
- Launcher runs stay foreground and signal-responsive. Prefer Podman with `krun`/KVM; report missing prerequisites and use isolated Apptainer fallback. Pass credentials by approved environment names, never values in arguments or logs. Host OMP configuration is isolated unless the operator explicitly sets `REVIEW_INHERIT_OMP_CONFIG=1`.

## Source layout and verification

- `image/extension/bluefin-review/` is the retained source path for Review; its public behavior is GitHub-generic.
- `image/extension/luna-factory/` is the co-loaded Factory extension.
- `image/appliance/Containerfile`, `image/appliance/entrypoint.sh`, and the root `justfile` define the packaged runtime. `bin/omp-review` is the neutral source entrypoint; the Homebrew `bluefin review` command is a compatibility alias.
- Match validation to changed behavior. Core contracts include `bash tests/omp-review-mode.sh`, `bash tests/appliance-contract.sh`, `bash tests/just-onboarding.sh`, `bash tests/test-registry.sh`, and `node --test tests/luna_factory.test.ts`. The appliance/package path also has `tests/review-factory-coload-smoke.sh` and `python3 tests/brew_dev_contract.py`.
- When skill frontmatter changes, regenerate `docs/skills/index.json` with `bash scripts/check-skill-frontmatter.sh --write`; never edit that generated index by hand.
- Update code, tests, launcher, and user-facing docs together. Do not leave a deleted product referenced from a workflow, generated manifest, or package contract.
