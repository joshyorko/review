# Refresh recovery follow-up

Current implementation source: `48fbaa8a0fa6929b261c1556e03dc0ffbdd7df6e`.
This supersedes the refresh-notice limitation recorded at source `369957e` in the [earlier ANSI report](../cloud-ansi/README.md). Full Product Design acceptance remains pending; native TSP is still blocked.

## Bugs fixed

A successful queue read updated the queue/error state but never resolved the existing failure notice. The card therefore kept telling the user to retry after recovery. Commit `0a6fca9` resolves only the matching scope/queue notice after a complete successful read, removes the active card/widget, and saves the earlier diagnostic with a clear resolution. Failed, partial, truncated and cancelled reads do not resolve it. A later identical failure remains visible. An unrelated notice is not dismissed.

Read-only review identified a second boundary defect: a late recovery from one session could resolve a same-ID notice in another session through the shared notice component. Commit `f9e44bd` requires the source session identity at the resolution boundary, including structured-setup recovery. The regression first failed against the previous implementation, then passed with the guard. Commit `48fbaa8` also makes resolution idempotent: later healthy refreshes cannot append the same resolution repeatedly, while a genuinely new identical failure can still appear and recover.

## Actual foreground captures

[100×32 screenshots](100x32/screenshots/) · [80×24 screenshots](80x24/screenshots/)

These **24 unedited PNGs** come from a new read-only source archive at `48fbaa8`, with separate fresh audit HOMEs, state/claim roots and work directories. Every frame measures both VTE rows/columns and the child PTY's `TIOCGWINSZ`; PNG dimensions match the real GTK window allocation: 1002×610 and 802×458 pixels, with 10×19 pixel cells. The source archive and implementation/test hashes are in [source-manifest.json](source-manifest.json).

- `00`/`01`: real queue ready, before the audit begins.
- `02`: typed, unsent refresh draft.
- `03`: deterministic 503 produces the human error card and numbered retry instructions.
- `04`: actual `r` retry succeeds, the card clears and the queue visibly changes to `fresh queue read after retry`.
- `04b`: an additional healthy refresh leaves the card cleared and appends no duplicate resolution history.
- `05`: returning to the editor retains the exact original draft.
- `06`: Details says the refresh resolved and labels the original 503 diagnostic as saved, read-only history; it no longer gives stale active retry instructions.
- `07`: readable Status after recovery.
- `08`: the same injected 503 can produce a new notice after the earlier one resolved.
- `09`/`10`: a second successful retry clears that card and retains its resolved diagnostic.

`probe/fetch-events.jsonl` independently records the successful initial read, 503, successful retry, an extra healthy read, repeated 503 and successful retry. `probe/notice-events.jsonl` records identical editor text before/after both the first insertion and removal. The exact draft is `DRAFT KEEP EXACTLY - refresh notes awaiting human approval.` The audit intentionally clears its saved synthetic draft only after frame `05` so it can enter the read-only Details command; that explicit audit action is in the command journal. Focus equality is not inspectable by the public API and is not claimed.

The deterministic GitHub fixture is injected at the network boundary; the native keyboard handling, UI, queue update, notice lifecycle, editor API and runtime are actual implementation code. No provider inference, worker handoff or live GitHub mutation occurs. The runtime remains pinned OMP 18.13.3 source plus the exact shipped session-lifecycle patch using existing SDK dependencies, not a compiled appliance. [Unchanged runtime/tool manifest](../cloud-ansi/runtime-manifest.json). No image editing or terminal reconstruction is used. Raw text/driver receipts are gzip-preserved without whitespace normalization.

## Verification

- Current source full `bash tests/omp-review-mode.sh`: **859 passed, 4 skipped, 0 failed**, plus **43 Python tests** and launcher parity.
- Focused notice, refresh and pagination tests: **374 passed, 2 skipped**.
- New regressions cover successful and empty queue recovery, partial/truncated/cancelled reads, idempotent healthy refreshes, repeated identical failures, unrelated notices, diagnostic retention and stale-session resolution. Red/green and full receipts are retained in `logs/`.
- Pagination, permissions, ownership and exact-head guards are unchanged. The archived pagination patch remains unchanged and was not reapplied.
- Final evidence-head CI is monitored separately and recorded in the PR description; old-head CI is not promoted to acceptance of the final head.

## Packaged Factory restart: concrete cloud blocker

The replacement environment has since pulled the pinned Fedora base and built the appliance. The [new packaged restart checkpoint](../cloud-packaged-restart/README.md) supersedes the network blocker below: disabled policy restart passed, while enabled verification remains blocked by actual namespace/runtime capability failures. The following records the earlier restricted-environment attempt.

A genuine packaged restart was assessed using the existing Docker 28.4.0 engine and Buildx 0.31.0. There was no local appliance image. The repository's Containerfile and pins were used unchanged from the immutable `0a6fca9` snapshot; the later notice-lifecycle changes do not alter the base pin. [Build subject](packaged-build-source-manifest.json) and [actual failed build log](logs/docker-build.log.gz).

The build exited **1 before compilation**: Docker's HEAD request for `registry.fedoraproject.org/fedora-minimal:46@sha256:47063fcb44549b53ef716744f90dc735dabe4febac4a0bc8fc12085651a6f0b9` returned **Forbidden**. The enforced cloud network policy is restricted to the package-manager preset, and `registry.fedoraproject.org` is absent from its effective allowlist. No image was created, and no packaged process/restart was started. This is an observed network/build blocker, not proof that Factory cannot run and not a source failure.

The concrete first prerequisite is approved environment access to that pinned official registry, or an already-built image with verified exact-source provenance. The build may expose further pinned download requirements once that first request is allowed. No mirror, alternate base, credentials, privileged flag, verifier bypass or retry of the denied request was used. The credential-free co-load smoke can then test actual extension registration/status and persisted operator policy across restart; it does not establish active batch recovery. Podman, krun, Apptainer, `/dev/kvm` and `/dev/fuse` are also absent, so the VM/SIF alternatives are not currently available. Default Docker's nested sandbox capability remains untested; only the packaged verifier may establish it.

## Native TSP: official renderer unavailable

Official sources were checked on 2026-10-29. [Tern's product page](https://stencil.so/tern) advertises closed-beta access through a waitlist; no public pinned Linux renderer download was found. The public [`tern-sdk`](https://github.com/stencil-hq/tern-sdk) provides protocol libraries and example plugins, while Tern itself performs layout/drawing. [`surface-play`](https://docs.stencil.so/tern/scripts/terminal.html) runs inside Tern; it is not a standalone renderer. The [handshake documentation](https://docs.stencil.so/tern/protocol/handshake.html) describes TSP v1 and `toast`; its example `0.4.3` is not an available installation pin.

**Remaining gate:** obtain a legitimate official Tern renderer compatible with TSP v1/toast and inspect the actual Review notice visually. Public SDK/protocol output, ANSI screenshots and a fabricated terminal identifier cannot close this gate. No waitlist signup, credentials, paid service, unknown-source installation, user-computer access or deployment occurred. Full design PASS, Ready and merge remain blocked by actual acceptance, despite broad permission to continue authorized work.
