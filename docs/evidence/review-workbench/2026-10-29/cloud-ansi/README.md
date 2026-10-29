# Cloud ANSI visual evidence — 2026-10-29

**Limited ANSI inspection accepted for the recovery and browser flows below. Full Product Design sign-off remains BLOCKED/PENDING, including native TSP.** These are fresh, unedited screenshots of real GTK4/VTE windows running the actual OMP source CLI and Review implementation, not generated terminal illustrations or protocol snapshots.

## Source and runtime

Review source: `181b8472b48b34e8bdd9433e66e871c21ad14464`. The read-only archive and implementation hashes are recorded in [source-manifest.json](source-manifest.json). Every flow starts with a newly created HOME, work directory, state/claim roots and deterministic local model profile. Source files were made read only before launch. No historical audit HOME was reused.

OMP runtime: pinned upstream `413d278a87a69b453efabf8d1fedb9940385e8c6` (18.13.3), with the exact shipped `session-lifecycle.patch`, run by checksum-verified Bun 1.4.4 using the existing matching SDK dependencies. The matching SDK's generated HTML asset is copied into this isolated source runtime. This is **source-runtime UI evidence, not compiled appliance/SIF qualification**. Stock SDK execution correctly refused admission because it lacks Review's lifecycle API; that attempt is not recovery acceptance. [Runtime manifest](runtime-manifest.json) records the distinction and hashes.

Josh approved Bun, GTK4/VTE and Xvfb installation only in the disposable cloud environment. Official Debian signed package metadata supplied GTK 4.18.6, VTE 0.80.1 and Xvfb 21.1.16; packages and dependencies were extracted under `/workspace/.review-dev/visual-install` without global dpkg changes. [Package versions and SHA-256](installed-packages.json). No Apptainer, Tern, user-computer or appliance installation occurred.

## Capture method and acceptance boundaries

[capture.py](capture.py) creates a real foreground VTE PTY, measures VTE columns/rows and child `TIOCGWINSZ` before every capture, and rejects a mismatch. ImageMagick `import` captures the actual undecorated GTK window by XID. No compositing, resizing, reconstruction or image editing is used. Font: DejaVu Sans Mono 12; 10×19 pixel cells; 100×32 window 1002×610, 80×24 window 802×458. Xvfb runs with MIT-SHM disabled and GTK Cairo rendering because shared-memory rendering was unavailable. Black/shared-memory attempts were rejected, not accepted as evidence.

Each flow retains `geometry.jsonl`, timestamped input/capture events, actual terminal text, argv, config and the bounded fixture source. The launcher deliberately waits until the real queue is visible before driving actions; rejected early-start attempts are excluded. Proxy values, credentials, private session contents and child environment files are not published.

GitHub is an injected deterministic fixture (`fixture/review#42`). Browser failures and refresh errors are deterministic injected boundaries. Native navigation, reader, notices, Settings, lifecycle capability and public editor APIs are real. Model handoffs are intercepted before provider/worker calls; no live work or GitHub mutation occurs. A dispatching frame proves admission only, never worker completion.

## Accepted recovery flow, both sizes

[100×32 captures](recovery-100x32/screenshots/) · [80×24 captures](recovery-80x24/screenshots/)

- `02`: refusal says what happened, that no work started for the selected PR, and four numbered recovery steps.
- `03` plus `04`: read-only Status and its lower scroll position; the lower fragment is not a standalone full view.
- `05` and `13`: queue navigation returns to the same selected PR.
- `06`–`10`: real Settings → Tasks → Subagents changes Structured Task Results from false to true; `probe/task-schema-events.jsonl` independently records effective capability false→true and lifecycle API 1.
- `11`–`12`: persistent read-only Details before retry.
- `14`: obsolete notice clears after the same PR is admitted. Exactly one intercepted handoff targets `fixture/review#42`.
- `15`: resolved Details leads with the resolution and labels the saved earlier diagnostic. The old refusal outcome and numbered retry instructions are no longer presented as active instructions. This visual finding produced the regression fix in `181b847`; stored historical outcome/steps remain intact.
- `16`: active claims/status, not completed work. `17`: native `/review` argument suggestions, not completion of the Review wave.

Independent read-only Luna inspection found the critical refusal/recovery steps, Settings toggle, resolved diagnostic and command suggestions readable at both sizes. Queue help/status metadata uses existing ellipsis at narrow widths; no full accessibility or measured contrast claim is made.

## Accepted browser flow, both sizes

[100×32 captures](browser-100x32/screenshots/) · [80×24 captures](browser-80x24/screenshots/)

`02` records the unsent editor draft. PR reader/browser failure appears in `04`/`05`; the issue reader/browser failure appears in `08`/`09`. Both notices retain the full fixture URL, explain the browser failure, state the item remains available and give retry guidance. `06` and `10` return to the editor. The real public editor getters before and after both notice insertions equal the exact draft:

`DRAFT KEEP EXACTLY - review notes awaiting human approval.`

These values are preserved in each `probe/notice-events.jsonl`; actual before/after editor frames are included. Getter access cannot inspect focus directly, so focus equality is not claimed; keyboard return/navigation is demonstrated.

## Tests and pending gates

- Current-tree `bash tests/omp-review-mode.sh`: **855 passed, 4 skipped, 0 failed**, plus **43 Python tests** and launcher parity. [Compressed receipt](current-tree-tests.log.gz).
- Focused resolved-Details regression and notice/pagination tests: **370 passed, 2 skipped**. Baseline red and fixed green receipts are retained.
- Actual patched upstream lifecycle tests: **17 passed** in an isolated HOME. The earlier run using the read-only default HOME failed and is explicitly retained as a failed attempt, not acceptance.
- Exact-head hosted checks for source `181b847` are still being monitored; no reruns requested. Later evidence-only commits need their own final-head CI record.
- Refresh, unavailable Factory and uncertain-dashboard fresh captures are in progress in this checkpoint.
- **Native TSP visual inspection remains BLOCKED:** VTE is an ANSI renderer, and no compatible Tern renderer is available. Advertising a protocol or setting `TERM_PROGRAM` does not prove rendering. No Tern installation was authorized or performed. Full Product Design PASS is not claimed.
- Compiled appliance enabled-Factory/generic OCI/krun/KVM/SIF qualification remains separate from these source UI captures; historical green CI workflows recorded blocked runtime boundaries.

Older G2, narrow WIP and source-`1e13fdc` pilot captures are historical or rejected, not current approval. No merge, Ready transition, release, deployment, user desktop access or live Fix was performed.
