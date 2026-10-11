# Qualify the #140 clipboard patch

This source check runs in repository validation for the Review appliance's pinned OMP source. It verifies `/dump` and `/dump all` status messages against the exact OMP 18.9.1 handlers. It does not prove clipboard delivery or packaged behavior.

## Pinned inputs

The source archive is OMP 18.9.1 at commit `a4d6f0adc63dda4ccdf4d25c26422219820f865b`, with SHA-256 `06a569467c1793e2c7f9f3d20807b5ddca60d59633b9be0748ad05851ccf4c00`. The MemoryBackend registration patch remains a separate input with SHA-256 `d558fb25cb4a664595f6ca34ae70d8efe46858c75a667db7028fd01ec1ee368f`. The clipboard candidate is [`patches/omp/clipboard-truthful-18.9.1.patch`](../patches/omp/clipboard-truthful-18.9.1.patch), with SHA-256 `9e2f74c989f7d2f86d8dff73eb99a1888188f72c00b7ba7147758669021328b7`.

The source fixture verifies the OMP source and archive, both patch hashes, their order, and the patch path against `image/appliance/Containerfile`. The clipboard patch is bound to the current OMP commit; an OMP pin change must be requalified before the build accepts it.

## Run the source check

```sh
node --test tests/fixtures/issue-140-clipboard-truth.test.mjs
```

The fixture verifies the pinned OMP source archive and extracts only the MemoryBackend patch targets, the clipboard command controller, and the archive report formatter. It applies the current registration patch first, then the clipboard patch. It exercises the actual `/dump` handler and the shared archive-report handler used by `/dump all`, preserving a normal and 4 MiB transcript, sidecar warning, persistent archive path, member list, and archive warning while requiring delivery to be described as unconfirmed.

To preserve the baseline failure, set `ISSUE140_APPLY_PATCH=0`. The original handlers report successful clipboard delivery despite the best-effort `copyToClipboard()` contract.

## Current behavior and limits

OMP's `copyToClipboard()` remains best-effort and provides no delivery acknowledgement. `/dump` now says delivery is unconfirmed and points to `/dump all`. `/dump all` still creates the persistent archive, prints its path and contents list, and warns that the archive may contain raw context. This patch changes status text only. It does not change copied text or archive generation.

The package builder checks that the patch was reviewed against the exact pinned OMP commit, verifies its SHA-256, applies it after the separate MemoryBackend patch, and records both patch identities in the SPDX SBOM and image labels. No package build has proved that the derived binary contains this candidate. The current environment has no Podman/krun/KVM or Apptainer runtime and no host desktop clipboard surface, so packaged small/large clipboard behavior and archive readability after container exit remain unverified. Keep #140 open until those runtime checks pass.
