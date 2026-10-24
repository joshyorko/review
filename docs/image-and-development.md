# Image and development guide

The repository ships one OCI appliance from `image/appliance/Containerfile`. It carries OMP, GitHub CLI, the GitHub-generic Review extension, Luna Factory, and the minimal runtime/tool closure required by OMP.

The image does not select a provider, model, or thinking effort. OMP resolves them from the user's active configuration. The launcher prefers Podman's `krun` runtime with KVM and falls back to isolated Apptainer when necessary. Review and Factory remain in the same appliance but keep separate authority and state.

The Containerfile pins OMP's source tag/commit, source archive, generic registration patch, Bun toolchain, and per-architecture native packages. It builds the derived OMP binary on each native image architecture; it does not fetch a prebuilt OMP binary. GitHub CLI artifacts remain per-architecture SHA-256 verified. `scripts/update-omp-pins.mjs` refreshes the OMP source/native pins and `scripts/update-gh-pins.mjs` refreshes GitHub CLI pins; CI requirement hashes are refreshed by `scripts/update-requirements-ci-hashes.mjs`.

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

The release workflow builds immutable OCI images and native SIF bundles from the same committed source. The `review` formula lives in `joshyorko/homebrew-tools`, whose Dagger install checks verify candidate artifacts before publication.

## Validation

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
bash tests/readme-quickstart.sh
python3 tests/package_review_contract.py
python3 tests/package_oci_contract.py
git diff --check
```

Hosted validation builds the appliance and exercises Review/Factory co-load. Native image and package evidence is reported by the corresponding workflow; do not claim runtime coverage that did not execute.

`bash tests/luna-factory-graph-acceptance.sh --transport-check` tests the krun host-provider boundary with a fake Podman CLI and does not start a container. The opt-in `krun-host-provider` profile requires root-owned exclusive runtime admission and an immutable packaged image.
