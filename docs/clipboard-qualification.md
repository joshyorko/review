# Qualify the #140 clipboard patch

This source check runs in repository validation for the Review appliance's pinned OMP source. It verifies `/dump` and `/dump all` status messages against the exact OMP 18.10.3 handlers. It does not prove clipboard delivery or packaged behavior.

## Pinned inputs

The source archive is OMP 18.10.3 at commit `81e1d8927a3c16cfaff2e9456baa8c060e1e0e9b`, with SHA-256 `e4fa3c621fd6ef21b71e1b048f056bf7845dd9bada19199cbf698b84d3d70e15`. The MemoryBackend registration patch remains a separate input with SHA-256 `d558fb25cb4a664595f6ca34ae70d8efe46858c75a667db7028fd01ec1ee368f`. The clipboard candidate is [`patches/omp/clipboard-truthful-18.10.3.patch`](../patches/omp/clipboard-truthful-18.10.3.patch), with SHA-256 `608959e93b132d50aa9b6d015b1b6fecc6dbb644e7295628bee1f11640cf224e`.

The 18.10.3 refresh was checked against the verified source archive. Both unpatched handlers still report successful delivery; both regression cases fail without the clipboard patch and pass with it. The MemoryBackend patch is unchanged.

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
