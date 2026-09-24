# Image and development guide

The repository ships one OCI appliance from `image/appliance/Containerfile`. It carries OMP, GitHub CLI, the GitHub-generic Review extension, Luna Factory, and the minimal runtime/tool closure required by OMP. Historical image and filesystem names remain only for the existing install path.

The image does not select a provider, model, or thinking effort. OMP resolves them from the user's active configuration. The launcher prefers Podman's `krun` runtime with KVM and falls back to isolated Apptainer when necessary. Review and Factory remain in the same appliance but keep separate authority and state.

The Containerfile pins its FSDK base by tag and digest and verifies downloaded OMP and GitHub CLI artifacts with per-architecture SHA-256 values. Renovate updates those releases through `scripts/update-omp-pins.mjs` and `scripts/update-gh-pins.mjs`; CI requirement hashes are refreshed by `scripts/update-requirements-ci-hashes.mjs`.

## Development

```bash
# Build the Review appliance and verify its static contract
just review-appliance-build

# Exercise the source Review workbench
bin/omp-review acme/widgets

# Build the personal Homebrew bundle from a committed ref
scripts/brew-dev build self-hosted
```

The personal package workflow publishes an immutable OCI image and native SIF from the same committed source ref, then updates the existing `bluefin-review-dev` formula in `joshyorko/homebrew-review-dev`. Those formula and `bluefin review` names remain compatibility aliases; `bin/omp-review` is the neutral source entry point.

## Validation

```bash
pre-commit run --all-files
bash tests/check-commit-message.sh
bash scripts/check-skill-frontmatter.sh
bash tests/generate-skills.sh
bash tests/test-registry.sh
bash tests/omp-review-mode.sh
node --test tests/update-omp-pins.test.mjs
node --test tests/update-derived-pins.test.mjs
node --test tests/luna_factory.test.ts
bash tests/appliance-contract.sh
python3 tests/appliance_sbom_contract.py
bash tests/version-derivation.sh
bash tests/just-onboarding.sh
bash tests/readme-quickstart.sh
python3 tests/brew_dev_contract.py
python3 tests/personal_brew_oci_contract.py
git diff --check
```

Hosted validation builds the appliance and exercises Review/Factory co-load. Native image and package evidence is reported by the corresponding workflow; do not claim runtime coverage that did not execute.
