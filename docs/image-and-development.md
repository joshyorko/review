# Image and development guide

The repository ships one OCI appliance from `image/appliance/Containerfile`. It carries OMP, GitHub CLI, the GitHub-generic Review extension, Luna Factory, and the minimal runtime/tool closure required by OMP.

The image does not select a provider, model, or thinking effort. OMP resolves them from the user's active configuration. The launcher prefers Podman's `krun` runtime with KVM and falls back to isolated Apptainer when necessary. Review and Factory remain in the same appliance but keep separate authority and state.

The Containerfile pins OMP's source tag/commit, source archive, clipboard and lifecycle patches, Bun toolchain, and per-architecture native packages. It builds the derived OMP binary on each native image architecture; it does not fetch a prebuilt OMP binary. `OMP_MEMORYD_SHIM=0` is the default and excludes MemoryD adapter fetches and tests. The manual **Qualify optional MemoryD shim** workflow builds a job-local `review-memoryd-candidate` with `OMP_MEMORYD_SHIM=1`; it does not publish, activate, or distribute the candidate. GitHub CLI artifacts remain per-architecture SHA-256 verified. `scripts/update-omp-pins.mjs` refreshes the OMP source/native pins and `scripts/update-gh-pins.mjs` refreshes GitHub CLI pins; CI requirement hashes are refreshed by `scripts/update-requirements-ci-hashes.mjs`.

## Development

```bash
# Build the Review appliance and verify its static contract
just review-appliance-build

# Exercise the source Review workbench
bin/review-source acme/widgets

# Build the Homebrew bundle from a committed ref
scripts/package-review build main
```

The source launcher keeps an existing Git checkout as OMP's isolation baseline.
When launched outside Git, it prepares a committed coordinator at
`$HOME/.local/state/review/coordinator`; it leaves the caller's directory and
files unchanged.

## Publishing an update

Run the **Request Review release** workflow on `main` and enter the next stable
version (for example, `0.1.4`). It creates a version-bump pull request and
explicitly dispatches `validate` against that PR's exact head; review and merge
that PR to request the release. Repository Actions settings must allow GitHub
Actions to create pull requests. If PR creation fails after the branch is pushed,
open a PR from `release/v<VERSION>` or remove that branch before retrying.

Alternatively, bump the root `VERSION` in a PR and merge it to `main`.
After `validate` succeeds, `Review release` automatically builds and tests both
native architectures at that exact commit, then publishes the versioned OCI/SIF
release. An already published version is skipped on automatic runs; a manual publish
request for one fails with an actionable error. Ordinary pushes still run CI.

`joshyorko/homebrew-tools` checks for new Review releases hourly. Its Dagger
pipeline verifies the release bundles, tests Homebrew installation, and commits
the updated formula automatically. The formula downloads the original Review
release assets; there is only one package release.
No formula copying or cross-repository credentials are required. To request an
immediate tap refresh, run its `Tap Auto Update` workflow with slot ID
`review-hourly`.

Once the tap update finishes, run `brew update` followed by
`brew upgrade joshyorko/tools/review`.

The `Review release` manual workflow remains available for candidate builds;
leave `publish` disabled to test an unpublished committed ref.

## Validation

Run `bin/ci --profile pre-push --base <base>` before each push, workflow
dispatch/rerun, or release action. The complete profile is still being
migrated; until it is available, this command fails blocked. `just ci` runs
only the bootstrap contract smoke and is not a substitute for the pre-push
gate. Native proof remains profile-specific; an unavailable required host
capability is blocked rather than counted as pass.

```bash
pre-commit run --all-files
bash tests/check-commit-message.sh
bash scripts/check-skill-frontmatter.sh
bash tests/generate-skills.sh
bash tests/test-registry.sh
bash tests/omp-review-mode.sh
bash tests/luna-factory-graph-acceptance.sh --transport-check
node --test tests/update-omp-pins.test.mjs
node --test tests/update-derived-pins.test.mjs
node --test tests/luna_factory.test.ts
bash tests/appliance-contract.sh
python3 tests/appliance_sbom_contract.py
bash tests/version-derivation.sh
bash tests/just-onboarding.sh
python3 tests/launcher_diagnostic_collector.py
bash tests/readme-quickstart.sh
python3 tests/package_review_contract.py
python3 tests/package_oci_contract.py
git diff --check
```

Hosted validation builds the appliance and exercises Review/Factory co-load. Native image and package evidence is reported by the corresponding workflow; do not claim runtime coverage that did not execute.

`bash tests/luna-factory-graph-acceptance.sh --transport-check` tests the krun host-provider boundary with a fake Podman CLI and does not start a container. The opt-in `krun-host-provider` profile requires root-owned exclusive runtime admission and an immutable packaged image.
