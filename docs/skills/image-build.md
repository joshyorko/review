---
name: image-build
version: "2.24"
last_updated: 2026-08-25
id: image-build
one_line_purpose: Build and publish the direct review image fork safely.
entry_point: docs/skills/image-build.md
category: ci-ops
mcp_compliance_level: partial
optimization_status: draft
status: active
dependencies: []
tags: [containerfile, image, digest, pinning, build, audit]
description: "Use when maintaining the digest-pinned lab-runner fork, direct-copy audit, or review-image publication path."
metadata:
  type: procedure
---
# Image Build

## When to Use

Load this before changing `image/Containerfile`, the pinned image source, or
published review-image behavior.

## Ownership Boundary

The image content comes from `projectbluefin/fsdk-containers`. This repository
owns the image reference, publication workflow, and tests; it does not rebuild
FSDK components or install packages into a downstream layer.

The first image slice is a direct fork of the published lab-runner image:

```Dockerfile
ARG FSDK_RUNNER_IMAGE=ghcr.io/projectbluefin/lab-runner:25.08@sha256:7c4b1e518bd1bffe2e506474e6196e9c18fb727bbd48a3c5f7ddbd3446ea5846
FROM ${FSDK_RUNNER_IMAGE}
```

The `FROM` is tag-plus-digest. The tag gives Renovate an update series; the
digest is the immutable build input. Do not replace it with a bare digest,
mutable `:latest`, a package overlay, a copied third-party binary, or a local
shim.

## Direct-Copy Contract

`image/Containerfile` must contain one `FSDK_RUNNER_IMAGE` argument and one
`FROM ${FSDK_RUNNER_IMAGE}` instruction. It must not add `RUN`, `COPY`, `ADD`,
`USER`, `WORKDIR`, `ENTRYPOINT`, `CMD`, `ENV`, or `LABEL` instructions. Build-time
publication labels are allowed in the workflow because they change metadata,
not the rootfs.

The direct fork preserves the lab-runner command and config contract. The
published lab-runner runtime currently provides `bash`, `curl`, `git`, `jq`,
`python3`, `kubectl`, `argo`, `just`, `which`, `xargs`, `awk`, `ps`, `tar`,
`diff`, `patch`, `less`, and `file`. Inventory the exact digest before changing
that list. If a common utility is missing, fix it at the FSDK seam and do not
reimplement it in this repository.

The full lab-runner catalog is informative, not a gate for this fork. The
first slice records catalog/runtime mismatches and does not add ShellCheck,
Hadolint, Actionlint, gzip, bubblewrap, Skopeo, or any other package locally.
The current mismatch is tracked in
[`fsdk-containers#205`](https://github.com/projectbluefin/fsdk-containers/issues/205).

## Publication

The publish workflow builds amd64 on `ubuntu-24.04` and arm64 on
`ubuntu-24.04-arm`, verifies the host and container architectures, and pushes
per-platform manifests before assembling an OCI index. The index must contain
exactly `linux/amd64` and `linux/arm64`; a missing platform fails publication.

Each build receives OCI source, revision, version, creation, license, and
exact base name/digest labels. It attaches signed SPDX SBOM and SLSA
provenance evidence plus a GitHub artifact attestation. The post-publish audit
uses `--direct-copy` to require exact base-layer equality and verifies that
`stable` and `sha-$GITHUB_SHA` resolve to the same index digest on main.

`projectbluefin/lab` consumes lab-runner for its GitOps test suite; its
workflows and skills are not copied into the review image. The review runtime
and launcher restoration is tracked in
[#346](https://github.com/projectbluefin/review/issues/346).

## Verification

```bash
bash tests/image-contract.sh
bash tests/image-audit.sh --verify-base-evidence
podman build --format oci -f image/Containerfile -t review:local .
bash tests/image-audit.sh --derived review:local --direct-copy
bash tests/just-onboarding.sh
git diff --check
```

Use the native matrix in `.github/workflows/publish-compat-image.yml` for
multi-architecture acceptance. Verify the published pointer with:

```bash
token="$(curl -fsSL 'https://ghcr.io/token?scope=repository:projectbluefin/review:pull' | jq -r .token)"
manifest_digest() {
  curl -fsSI \
    -H "Authorization: Bearer ${token}" \
    -H 'Accept: application/vnd.oci.image.index.v1+json,application/vnd.oci.image.manifest.v1+json' \
    "https://ghcr.io/v2/projectbluefin/review/manifests/$1" |
    awk -F': ' 'tolower($1) == "docker-content-digest" {print $2}' |
    tr -d '\r'
}
test "$(manifest_digest stable)" = "$(manifest_digest "sha-$(git rev-parse HEAD)")"
```

Generated audit reports stay out of git.
