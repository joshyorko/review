# Qualify the #140 clipboard patch

This source check runs in repository validation for the Review appliance's pinned OMP source. It reads the exact version, commit, archive digest, and patch inputs from `image/appliance/Containerfile`; it does not pin a historical OMP release in the test. It verifies `/dump` and `/dump all` status messages. It does not prove clipboard delivery or packaged behavior.

## Pinned inputs

The test obtains its inputs from `image/appliance/Containerfile`. The source fixture verifies the exact OMP commit and archive digest, reads the current MemoryBackend and clipboard patch files, checks their pinned digests in strict mode, and applies them in build order. For an OMP upgrade candidate with stale patch provenance, validation runs the same behavior check in qualification mode before the strict appliance contract. `node scripts/qualify-omp-upgrade.mjs --if-stale --record` runs the full derived build, tests, and canary before recording the candidate patch hashes and source commits.

## Run the source check

```sh
node --test tests/fixtures/issue-140-clipboard-truth.test.mjs
```

The fixture verifies the pinned OMP source archive and extracts only the MemoryBackend patch targets, the clipboard command controller, and the archive report formatter. It applies the current registration patch first, then the clipboard patch. It exercises the actual `/dump` handler and the shared archive-report handler used by `/dump all`, preserving a normal and 4 MiB transcript, sidecar warning, persistent archive path, member list, and archive warning while requiring delivery to be described as unconfirmed.

To preserve the baseline failure, set `ISSUE140_APPLY_PATCH=0`. The original handlers report successful clipboard delivery despite the best-effort `copyToClipboard()` contract.

## Current behavior and limits

OMP's `copyToClipboard()` remains best-effort and provides no delivery acknowledgement. `/dump` now says delivery is unconfirmed and points to `/dump all`. `/dump all` still creates the persistent archive, prints its path and contents list, and warns that the archive may contain raw context. This patch changes status text only. It does not change copied text or archive generation.

The package builder checks that each patch was qualified against the exact pinned OMP commit, verifies the patch digests, applies the patches in order, and records their identities in the SPDX SBOM and image labels. OMP's `copyToClipboard()` remains best-effort and provides no delivery acknowledgement. The clipboard patch changes status text only; it does not change copied text or archive generation. This source test does not prove host clipboard delivery. Packaged small/large clipboard behavior and archive readability after container exit remain unverified; keep #140 open until those runtime checks pass.
