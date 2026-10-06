# Qualify the #140 clipboard patch

This is a manual source check for the OMP 18.5.0 clipboard patch. It checks the `/dump` and `/dump all` status messages against the pinned handler code. It does not prove clipboard delivery or packaged behavior.

## Pinned inputs

The source archive is OMP 18.5.0 at commit `9348320cc4a30a7195d36a1f05a6c11bcb701a17`, with SHA-256 `60ead7acc6185f5c06942d3f56d82dd0f41081e749f03b73547c6ed537407b46`. The candidate is [`patches/omp/clipboard-truthful-18.5.0.patch`](../patches/omp/clipboard-truthful-18.5.0.patch), with SHA-256 `118612c41e9a3d8d68d15f4451d798a4fbe1e948bed60bc87e5eaf1eb7693214`.

The fixture checks both hashes and confirms that `image/appliance/Containerfile` still pins this OMP commit and archive. A pin change requires a new source review and patch check.

## Run the source check

Set `ISSUE140_OMP_ARCHIVE` to a local copy of the exact pinned archive. The fixture extracts it into a temporary directory, applies the patch, and runs the actual pinned handler bodies with stubbed session and clipboard calls.

```sh
ISSUE140_OMP_ARCHIVE=/path/to/omp-9348320.tar.gz \
  node --test tests/fixtures/issue-140-clipboard-truth.test.mjs
```

The two passing cases check the `/dump` status and unchanged small and 4 MiB transcript payloads. They also check that `/dump all` prints the pinned archive report, member names, and persistence warning while marking clipboard delivery unconfirmed.

To preserve the baseline failure, set `ISSUE140_APPLY_PATCH=0`. On 2026-10-06, that command failed both status assertions against the original handlers. The command above with the patch applied passed both cases.

## Current behavior and limits

OMP's `copyToClipboard()` remains best-effort and provides no delivery acknowledgement. `/dump` now says delivery is unconfirmed and points to `/dump all`. `/dump all` still creates the existing persistent ZIP, prints its path and contents list, and warns that the archive may contain raw context. The patch changes status text only. It does not change copied text or archive generation.

The patch is not wired into the appliance build or SBOM. The current `Containerfile` and `scripts/build-derived-omp.sh` still apply only the memory-backend registration patch. This source check does not prove that a packaged binary contains the clipboard patch.

The packaged krun/Podman and Apptainer/SIF paths remain untested for this change. Actual small and large host-clipboard delivery and archive readability after container exit also remain unproved. Keep #140 open until those runtime checks pass.
