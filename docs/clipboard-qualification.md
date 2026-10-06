# Qualify the #140 clipboard patch

This source check runs in repository validation and can also run locally for the OMP 18.5.0 clipboard patch. It checks the `/dump` and `/dump all` status messages against the pinned handler code. It does not prove clipboard delivery or packaged behavior.

## Pinned inputs

The source archive is OMP 18.5.0 at commit `9348320cc4a30a7195d36a1f05a6c11bcb701a17`, with SHA-256 `60ead7acc6185f5c06942d3f56d82dd0f41081e749f03b73547c6ed537407b46`. The candidate is [`patches/omp/clipboard-truthful-18.5.0.patch`](../patches/omp/clipboard-truthful-18.5.0.patch), with SHA-256 `118612c41e9a3d8d68d15f4451d798a4fbe1e948bed60bc87e5eaf1eb7693214`. The build also pins the patch to that OMP commit and the path `/usr/local/share/bluefin/omp/clipboard-truthful-18.5.0.patch`.

The fixture checks both hashes and confirms that `image/appliance/Containerfile` still pins this OMP commit and archive. A pin change requires a new source review and patch check.

## Run the source check

The fixture checks its pinned source, archive checksum, patch checksum, and patch path against `image/appliance/Containerfile`. Repository validation reuses the OMP checkout from the adjacent async regression and verifies its full commit SHA. When no checkout is supplied, the fixture downloads the pinned archive and verifies its SHA-256. For a local cached archive, set `ISSUE140_OMP_ARCHIVE` to its path. The fixture checks at least 128 MiB free in the temporary directory, then copies or extracts only both patches' target files and the archive report formatter.

```sh
node --test tests/fixtures/issue-140-clipboard-truth.test.mjs
```

The two cases verify the existing MemoryBackend patch checksum and apply it first. They then apply the clipboard patch to the same pinned source and run the actual handler bodies with stubbed session and clipboard calls. They check the `/dump` status and unchanged small and 4 MiB transcript payloads. They also check that `/dump all` prints the pinned archive report, member names, and persistence warning while marking clipboard delivery unconfirmed.

To preserve the baseline failure, set `ISSUE140_APPLY_PATCH=0`. On 2026-10-06, that command failed both status assertions against the original handlers. The command above with the patch applied passed both cases.

## Current behavior and limits

OMP's `copyToClipboard()` remains best-effort and provides no delivery acknowledgement. `/dump` now says delivery is unconfirmed and points to `/dump all`. `/dump all` still creates the existing persistent ZIP, prints its path and contents list, and warns that the archive may contain raw context. The patch changes status text only. It does not change copied text or archive generation.

The `Containerfile` copies the clipboard patch as a separate input. `scripts/build-derived-omp.sh` checks its SHA-256 and source commit, then applies it after the memory-backend registration patch. The SBOM records both patches separately. A future OMP pin change leaves the clipboard patch source binding unchanged, so the builder refuses a mismatch until the patch is requalified. No package build has proved that the derived binary contains the candidate.

The packaged krun/Podman and Apptainer/SIF paths remain untested for this change. Actual small and large host-clipboard delivery and archive readability after container exit also remain unproved. Keep #140 open until those runtime checks pass.
