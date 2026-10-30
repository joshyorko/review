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

The product ships one OMP appliance from `image/appliance/Containerfile`. It carries OMP, GitHub CLI, Review, Luna Factory, and the required runtime/tool closure. The release workflow also builds a native SIF from the same committed source.

## Rules

1. Pin the distribution base and builder by tag and digest. Pin fetched runtime assets by version and architecture-specific SHA-256.
2. Build natively per architecture; do not present QEMU output as native evidence.
3. Never put credentials, user configuration, workspaces, or provider choices in image layers.
4. Do not add a package manager or duplicate tools already present in the pinned distribution closure.
5. Keep the appliance's executable closure and final image contract aligned. Every staged command must run in the built image.
6. Preserve `--runtime=krun` as the KVM VM boundary; a `/dev/kvm` mount alone is not isolation. Report missing KVM prerequisites before isolated Apptainer fallback.
7. Generate SPDX from resolved build arguments and keep build-only generators out of the final filesystem. Current source and SBOM provenance identify `joshyorko/review`.
8. Keep OMP source/commit/archive, selected patch, Bun, per-architecture native-package, and GitHub CLI pins synchronized with updater tests. `scripts/update-omp-pins.mjs` refreshes OMP source identity/archive hash and both native-package integrities. The ordinary appliance uses `OMP_MEMORYD_SHIM=0`: it applies and records the clipboard and lifecycle patches, and does not fetch MemoryD adapter source or run MemoryD tests/canaries. `OMP_MEMORYD_SHIM=1` is an opt-in qualification candidate; its selected MemoryD patch is recorded only when included. Run the manual **Qualify optional MemoryD shim** workflow to requalify the selected source and build a job-local `review-memoryd-candidate` image. That workflow does not publish, activate, or distribute it. The MemoryD source fetch remains ephemeral and qualification-only. Packaging stays blocked until #245 provides explicit distribution terms and a release-shaped artifact; consume only a pinned licensed release, never an ad-hoc source commit.
9. Node.js 24, npm/npx, and pinned Bun are part of the appliance runtime; the remaining Node and tmux uses are test/CI tooling. Keep CI requirement hashes current through `scripts/update-requirements-ci-hashes.mjs`.
10. Keep Review's bundled MCP configuration limited to its required GitHub and Context7 endpoints. Do not restore an organization-specific service to normal Review.
11. Give Apptainer instance-scoped disk-backed scratch storage; its default contained `/tmp` is too small for repository clones and archive inspection.

## Publication

Before a push, workflow dispatch/rerun, or release action, run the declared
`bin/ci` profile for the exact proposed subject. Native profile requirements
must be reported as blocked when the required host boundary is unavailable;
portable/container evidence does not stand in for native KVM, AppArmor, or
architecture-specific package proof.
`just ci` runs only the bootstrap contract smoke and is not a release or
publication gate; use the changed-path pre-push profile before release work.

`release.yml` automatically builds matching native OCI/SIF candidates at the exact successful `validate` commit on `main` when its `VERSION` is unpublished. Bump `VERSION` with a change to request a release; already published versions are skipped. The tools tap polls new stable releases hourly and updates its Dagger-verified formula automatically to use the original Review release assets. Review owns the only package release. Validate the candidate with the tools tap's Dagger and Homebrew checks before publishing a stable release. The tools tap owns the formula; no development tap is updated by this repository.

## Verification

```bash
node --test tests/update-omp-pins.test.mjs
node --test tests/update-derived-pins.test.mjs
bash tests/appliance-contract.sh
python3 tests/appliance_sbom_contract.py
bash tests/version-derivation.sh
python3 tests/package_review_contract.py
python3 tests/package_oci_contract.py
```

With a container engine, run `just review-appliance-build` and the relevant native publication/package workflow. Report unavailable runtime evidence instead of inferring it from static checks.
