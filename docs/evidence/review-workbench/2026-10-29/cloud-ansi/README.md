# Cloud ANSI visual evidence — 2026-10-29

> Historical source-`369957e` checkpoint. The [refresh recovery follow-up](../cloud-refresh-recovery/README.md) fixes the persistent notice and provides new exact-source captures. The remaining native TSP and packaged-restart gates are recorded there.

**Limited ANSI inspection accepted for the recovery and browser flows below. Full Product Design sign-off remains BLOCKED/PENDING, including native TSP.** These are fresh, unedited screenshots of real GTK4/VTE windows running the actual OMP source CLI and Review implementation, not generated terminal illustrations or protocol snapshots.

## Source and runtime

Current Review source: `369957ec05c9647685256627f4df37a2d647d364`. The read-only archive and implementation hashes are recorded in [source-manifest.json](source-manifest.json). Every flow starts with a newly created HOME, work directory, state/claim roots and deterministic local model profile. Source files were made read only before launch. No historical audit HOME was reused.

OMP runtime: pinned upstream `413d278a87a69b453efabf8d1fedb9940385e8c6` (18.13.3), with the exact shipped `session-lifecycle.patch`, run by checksum-verified Bun 1.4.4 using the existing matching SDK dependencies. The matching SDK's generated HTML asset is copied into this isolated source runtime. This is **source-runtime UI evidence, not compiled appliance/SIF qualification**. Stock SDK execution correctly refused admission because it lacks Review's lifecycle API; that attempt is not recovery acceptance. [Runtime manifest](runtime-manifest.json) records the distinction and hashes.

Josh approved Bun, GTK4/VTE and Xvfb installation only in the disposable cloud environment. Official Debian signed package metadata supplied GTK 4.18.6, VTE 0.80.1 and Xvfb 21.1.16; packages and dependencies were extracted under `/workspace/.review-dev/visual-install` without global dpkg changes. [Package versions and SHA-256](installed-packages.json). No Apptainer, Tern, user-computer or appliance installation occurred.

## Capture method and acceptance boundaries

[capture.py](capture.py) creates a real foreground VTE PTY, measures VTE columns/rows and child `TIOCGWINSZ` before every capture, and rejects a mismatch. ImageMagick `import` captures the actual undecorated GTK window by XID. No compositing, resizing, reconstruction or image editing is used. Font: DejaVu Sans Mono 12; 10×19 pixel cells; 100×32 window 1002×610, 80×24 window 802×458. Xvfb runs with MIT-SHM disabled and GTK Cairo rendering because shared-memory rendering was unavailable. Black/shared-memory attempts were rejected, not accepted as evidence.

Each flow retains `geometry.jsonl`, timestamped input/capture events, gzip-compressed raw terminal text, argv, config and the bounded fixture source. The audit orchestrator waits until the real queue is visible before driving actions; rejected early-start attempts are excluded. Proxy values, credentials, private session contents and child environment files are not published.

GitHub is an injected deterministic fixture (`fixture/review#42`). Browser failures and refresh errors are deterministic injected boundaries. Native navigation, reader, notices, Settings, lifecycle capability and public editor APIs are real. Model handoffs are intercepted before provider/worker calls; no live work or GitHub mutation occurs. A dispatching frame proves admission only, never worker completion.

## Accepted recovery flow, both sizes

[100×32 captures](recovery-100x32/screenshots/) · [80×24 captures](recovery-80x24/screenshots/)

- `02`: refusal says what happened, that no work started for the selected PR, and four numbered recovery steps.
- `03` plus `04`: read-only Status and its lower scroll position; the lower fragment is not a standalone full view.
- `05` and `13`: queue navigation returns to the same selected PR.
- `06`–`10`: real Settings → Tasks → Subagents changes Structured Task Results from false to true; `probe/task-schema-events.jsonl` independently records effective capability false→true and lifecycle API 1.
- `11`–`12`: persistent read-only Details before retry.
- `14`: obsolete notice clears after the same PR is admitted. Exactly one intercepted handoff targets `fixture/review#42`.
- `15`: resolved Details leads with the resolution and labels the saved earlier diagnostic. The old refusal outcome and numbered retry instructions are no longer presented as active instructions. This visual finding produced the regression fix in `181b847`; stored historical outcome/steps remain intact. Source `369957e` also keeps technical queue errors out of the dashboard header and empty-queue rail. All current captures were retaken from the latter source.
- `16`: active claims/status, not completed work. `17`: native `/review` argument suggestions, not completion of the Review wave.

Independent read-only Luna inspection found the critical refusal/recovery steps, Settings toggle, resolved diagnostic and command suggestions readable at both sizes. Queue help/status metadata uses existing ellipsis at narrow widths; no full accessibility or measured contrast claim is made.

## Accepted browser flow, both sizes

[100×32 captures](browser-100x32/screenshots/) · [80×24 captures](browser-80x24/screenshots/)

`02` records the unsent editor draft. PR reader/browser failure appears in `04`/`05`; the issue reader/browser failure appears in `08`/`09`. Both notices retain the full fixture URL, explain the browser failure, state the item remains available and give retry guidance. `06` and `10` return to the editor. The real public editor getters before and after both notice insertions equal the exact draft:

`DRAFT KEEP EXACTLY - review notes awaiting human approval.`

These values are preserved in each `probe/notice-events.jsonl`; actual before/after editor frames are included. Getter access cannot inspect focus directly, so focus equality is not claimed; keyboard return/navigation is demonstrated.

## Tests and pending gates

- Current source `369957e`, current-tree `bash tests/omp-review-mode.sh`: **855 passed, 4 skipped, 0 failed**, plus **43 Python tests** and launcher parity. [Compressed receipt](final-current-tree-tests.log.gz).
- Focused resolved-Details regression and notice/pagination tests: **370 passed, 2 skipped**. Baseline red and fixed green receipts are retained.
- Actual patched upstream lifecycle tests: **17 passed** in an isolated HOME. The earlier run using the read-only default HOME failed and is explicitly retained as a failed attempt, not acceptance.
- Exact final-head hosted checks remain a separate gate; their terminal result will be recorded in the PR body after this evidence-only push. No reruns are requested. Historical source `369957e` inherited the initial evidence-format hygiene failure below; its cloud-local full source suite passed.
- Refresh, unavailable Factory and uncertain-dashboard flows have now been captured at both measured sizes; see the scope and remaining limitations below.
- **Native TSP visual inspection remains BLOCKED:** VTE is an ANSI renderer, and no compatible Tern renderer is available. Advertising a protocol or setting `TERM_PROGRAM` does not prove rendering. No Tern installation was authorized or performed. Full Product Design PASS is not claimed.
- Compiled appliance enabled-Factory/generic OCI/krun/KVM/SIF qualification remains separate from these source UI captures; historical green CI workflows recorded blocked runtime boundaries.

Older G2, narrow WIP and source-`1e13fdc` pilot captures are historical or rejected, not current approval. No merge, Ready transition, release, deployment, user desktop access or live Fix was performed.

## Additional failure flows and limits

[100×32 refresh/dashboard captures](failures-100x32/screenshots/) · [80×24 refresh/dashboard captures](failures-80x24/screenshots/)

- `02` shows a human refresh failure and two recovery steps while retaining the old queue row. The dashboard header now says `refresh failed`, rather than leaking truncated GraphQL/schema details. `03` retains the original technical diagnostic in read-only Details.
- `04` follows the actual `r` retry. The header returns to a fresh timestamp, but the previous persistent error card remains. **Automatic refresh-notice resolution is not demonstrated and remains a UI limitation**; these images must not be presented as proof that the old card cleared. Details/Status acknowledgement is available. The fixture repeats long diagnostic cause text deliberately; it is not primary notice copy.
- `05`/`06` show an actual rejected native custom-UI opening. The notice explicitly says the result is uncertain and not to retry yet, with Details/Status guidance. `07`/`08` are those read-only views. No worker handoff occurs, and the fixture does not pretend to simulate an actual partially completed GitHub mutation.

[100×32 missing-Factory captures](factory-100x32/screenshots/) · [80×24 missing-Factory captures](factory-80x24/screenshots/)

The actual Factory extension is omitted in these fresh sessions. `01` states Factory actions are unavailable, the GitHub queue can still be browsed, and gives two recovery steps. `02` retains the registration diagnostic in Details; `03` shows navigation back to the queue; `04` shows Status. This qualifies the unavailable-state presentation only. **A packaged-launcher restart was not executed**, so recovery into a packaged, enabled Factory is not established here.

## Evidence-format correction and review

The first 58-frame checkpoint was published at `785366a`, with source `181b847`. Hosted validate [40932182088](https://github.com/joshyorko/review/actions/runs/40932182088) actually ran and failed static hygiene: padding spaces/end-of-file content in raw VTE text and non-executable capture scripts. This was an evidence-format defect, not a zero-step/billing result. The local originals and screenshots were unchanged. Current raw terminal receipts are stored byte-for-byte in gzip files so hygiene tools cannot rewrite screen padding; authored JSON gets a final newline, and scripts with shebangs are executable. No broad hygiene exclusion was added. Initial and final source receipts are named separately; the old checkpoint is not relabeled as new-source evidence.

All **86 current PNGs** are source `369957e`. [validation.json](validation.json) checks each flow's fresh HOME, every VTE/PTY measurement (recorded as `pty_ioctl`), PNG/window allocation, effective schema transition, bounded single-PR handoff and unchanged browser draft. [artifact-hashes.json](artifact-hashes.json) records current artifact SHA-256 hashes. Raw logs and text remain compressed without whitespace normalization.

Independent read-only Luna review inspected the actual final critical frames at both sizes, including refusal, native Settings, resolved Details, browser fallback, refresh/uncertain dashboard and Factory unavailable. It found the critical text/actions readable at both sizes. The 80-column reader metadata URL is truncated, while each browser warning preserves the full actionable link. Focus equality is unverified; screenshot navigation and draft equality are evidenced. Native TSP, full design acceptance, actual worker completion and packaged Factory restart remain outside this limited ANSI conclusion.
