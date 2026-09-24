---
name: image-build
version: "3.6"
last_updated: 2026-09-23
id: image-build
one_line_purpose: Build and pin the single Review appliance.
entry_point: docs/skills/image-build.md
category: ci-ops
status: active
tags: [containerfile, image, digest, pinning, omp, review]
description: "Maintains the Review appliance, release pins, SBOM inputs, and publication workflows."
metadata:
  type: procedure
  context7-sources: [/websites/podman_io_en, /websites/github_en_actions]
---

# Review Appliance Build

The product ships one OMP appliance from `image/appliance/Containerfile`. It carries OMP, GitHub CLI, Review, Luna Factory, and the required runtime/tool closure. The personal Brew workflow also builds a native SIF from the same committed source. Historical artifact names remain compatibility details.

## Rules

1. Pin the FSDK base and builder by tag and digest. Pin fetched runtime assets by version and architecture-specific SHA-256.
2. Build natively per architecture; do not present QEMU output as native evidence.
3. Never put credentials, user configuration, workspaces, or provider choices in image layers.
4. Do not add a package manager or duplicate tools already present in the pinned FSDK closure.
5. Keep the appliance's executable closure and final image contract aligned. Every staged command must run in the built image.
6. Preserve `--runtime=krun` as the KVM VM boundary; a `/dev/kvm` mount alone is not isolation. Report missing KVM prerequisites before isolated Apptainer fallback.
7. Generate SPDX from resolved build arguments and keep build-only generators out of the final filesystem. Current source and SBOM provenance identify `joshyorko/review`.
8. Keep OMP and GitHub CLI version/digest pins synchronized with their updater tests. Renovate updates the single appliance Containerfile through `scripts/update-omp-pins.mjs` and `scripts/update-gh-pins.mjs`.
9. Keep `requirements-ci.lock` hashes current through `scripts/update-requirements-ci-hashes.mjs`; Node and tmux are test/CI tools, not appliance payload.
10. Keep Review's bundled MCP configuration limited to its required GitHub and Context7 endpoints. Do not restore an organization-specific service to normal Review.
11. Give Apptainer instance-scoped disk-backed scratch storage; its default contained `/tmp` is too small for repository clones and archive inspection.

## Publication

`publish-appliance.yml` maintains the existing OCI artifact path. `review-dev.yml` builds the personal immutable OCI image and matching SIF from the selected committed ref and updates the existing Homebrew tap. Do not claim an artifact was published merely because a build check passed. The current formula/image names are compatibility contracts until a separately authorized packaging migration.

## Verification

```bash
node --test tests/update-omp-pins.test.mjs
node --test tests/update-derived-pins.test.mjs
bash tests/appliance-contract.sh
python3 tests/appliance_sbom_contract.py
bash tests/version-derivation.sh
python3 tests/brew_dev_contract.py
python3 tests/personal_brew_oci_contract.py
```

With a container engine, run `just review-appliance-build` and the relevant native publication/package workflow. Report unavailable runtime evidence instead of inferring it from static checks.
