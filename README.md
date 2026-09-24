# Review

Review is a GitHub workbench for pull requests and issues. It reads live GitHub state, presents bounded evidence, and offers review, inspection, repair, and implementation actions subject to the authenticated user's permissions and safety checks.

Luna Factory adds bounded native workers, durable claims, reconciliation, and a handoff from Review. It is packaged alongside Review; Review actions and Factory execution remain separate so each retains its own authority and state.

## Scope and authentication

Review accepts a repository (`owner/repo`) or an organization (`org:acme`). Pass a scope explicitly:

```sh
just review-queue acme/widgets
just review-queue org:acme
bin/omp-review acme/widgets
```

A fresh interactive session without a configured or restored scope asks for one. Headless use without a scope reports that `owner/repo` or `org:<name>` is required. `REVIEW_DEFAULT_SCOPE` sets an explicit generic default; `REVIEW_MODE=hive` opts into the optional Hive read-side integration. Normal Review mode is GitHub-only and does not discover Hive contributor configuration. The historical `BLUEFIN_REVIEW_ORG` and `BLUEFIN_REVIEW_MODE` names remain compatibility aliases only.

Authentication comes from the GitHub CLI credential or `GH_TOKEN`, `GITHUB_TOKEN`, or `COPILOT_GITHUB_TOKEN`. Review does not grant permissions: GitHub remains the authority for repository access, reviews, workflow changes, and landing.

## Quick start

The appliance requires Linux and GitHub CLI (`gh`). Sign in, then start against a repository or organization:

```sh
gh auth login --web --hostname github.com --scopes repo,read:org,workflow
just review-queue acme/widgets
```

The launcher prefers rootless Podman with `krun` and KVM; when unavailable it uses isolated Apptainer. Review keeps OMP sessions, provider auth, and MCP configuration under its appliance-owned state home; host `~/.omp` is not inherited by default. See [appliance setup](docs/appliance.md) and [launcher details](docs/skills/launcher.md).

The personal package path currently publishes from [joshyorko/review](https://github.com/joshyorko/review)'s `self-hosted` branch. Existing installations retain the `bluefin-review-dev` formula and `bluefin review` command as compatibility names:

```sh
brew tap joshyorko/review-dev
brew install joshyorko/review-dev/bluefin-review-dev
bluefin review acme/widgets
```

The source checkout also provides `bin/omp-review`; historical package, image, and filesystem names are compatibility details, not product defaults.

## Review and Factory

The Review workbench presents a GitHub queue and execution trace. It supports repository/organization scope, PR and issue views, bounded diff/issue inspection, review, fix, and Slay. Slay coordinates a review/repair lifecycle for pull requests or isolated implementation workers for issues. It never grants the operator permissions GitHub denies, and the coordinator does not approve or merge its own pull requests.

Standalone Review uses **local attention order**: returned author repairs, personal review requests, failing CI, conflicts, ready-for-human-merge, review, issue triage, incomplete/waiting evidence, then blocked work. Within each category, dependency bumps receive one demotion point and work untouched for more than 21 days receives two; fewer points come first, then the most recently updated item, then the lowercase `owner/repo#number` key. Missing update times sort after known times at the same demotion. Demotion never moves work outside its category.

Personal review requests are direct GitHub user requests, matched case-insensitively to your authenticated login. Team requests and missing reviewer evidence do not create personal priority.

The dashboard and ordinary Slay/Autoslay use the same ordered queue. Explicit selections define the Slay scope and retain selection order. Optional Hive ranks take precedence within the existing author-repair and remaining-work lanes; local categories and safety gates remain visible. With Hive absent, disabled, or offline, local attention ordering remains active. Ranking only reads the captured GitHub snapshot, current user, policy, and staleness time. It does not dispatch work or change Factory admission, convergence, or mutation authority.


Luna Factory is selected from Review when available, and owns its worker execution, claims, and durable state. Use Review to inspect and select GitHub work; use Factory for bounded worker operations. See the [Factory operating model](docs/factory/agentic-model.md).

Hive remains an optional, explicitly selected read-side integration for existing users. It is not required for Review, and the default mode makes no Hive requests or contributor-registration discovery.

## Guides

- [Review workbench](docs/skills/review-dashboard.md)
- [Launcher and credentials](docs/skills/launcher.md)
- [Factory operating model](docs/factory/agentic-model.md)
- [Image and development](docs/image-and-development.md)
- [Documentation index](docs/SKILL.md)

Licensed under [Apache 2.0](LICENSE). [Visual credits](docs/images/README.md).
