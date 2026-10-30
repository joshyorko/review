# Review notice UX refresh: normal-width checkpoint

This is a historical report for `516b289`, not a current Product Design PASS.
The actual current-source 100×32, 80×24, and native TSP reviews remain pending
or blocked. See [the cloud continuation report](../cloud-continuation/README.md).

## Source and capture

- Source commit: `516b28987a492fffba6040bc3a4bbcc83817ef4c`
- UI manifest SHA-256: `3d5cf1fab729763176bfca09e2b1bcff6f896bade18fa165e1f17b4563c596fc`
- Capture used an immutable Review source archive and canonical `/usr/share/review/extension` layout.
- Every normal screenshot records target size, actual VTE size, and child PTY `TIOCGWINSZ` as 100×32; measured cells are 10×19 px in a 1002×610 allocation.
- Source hashes and screenshot checksums are in `source-manifest.json` and `screenshot-manifest.json`.

## Normal-width review

Product Design accepted the 100×32 flows captured here for continued qualification. The set shows the bounded human-language card, Status and Details read-only viewers, the native Settings path and live toggle, the same-PR retry, removal of the setup card after the intercepted admission, and native `/review` completion. The fixture intercepts the outgoing prompt before any model request.

Selected frames:

- `screenshots/02-a1-error-dashboard.png` — structured-task refusal, outcome, and recovery steps.
- `screenshots/03-status-viewer-top.png` — acknowledgement and repeated recovery steps.
- `screenshots/12-details-top.png` — explicit read-only diagnostic viewer.
- `screenshots/15-after-admitted-retry.png` — the same PR admitted and the old setup card cleared.

`16-resolved-details.png` still repeats the original no-work outcome and steps below its resolution line. Product Design is reviewing this minor clarity point with the narrow-width pass.

## Remaining visual gates

- Narrow 80×24 review is pending.
- Browser-open, refresh, Factory-unavailable, and ambiguous-dashboard failure captures are not included in this checkpoint.
- Native TSP toast visual review remains blocked because no TSP-capable renderer was available.
- Earlier `final-b770/` screens are historical only; the operator rejected that copy/layout and later review found card clipping.
- These captures do not claim appliance rebuild, live model review, install, deployment, merge, or release.
