# Review workbench visual audit receipt

**Verdict: BLOCKED — required native TSP toast rendering was not available to inspect.** The ANSI Review banner, recovery path, dashboard, completion menu, and narrow layout passed the captured scope below.

## Source and capture identity

- Commit: `b350c596b47e4cbb5492a9a6658bbf5fc223e41d`.
- Review UI manifest SHA256: `abf557fcd2164045549f53e4368ff66f009791d03303f24da65889347cd8ff98`.
- Full source manifest SHA256 reported by the owner: `7627f23140309371e66d33c8724f65593b50f968af4d377d931e7cfd06753df9`.
- Runtime: Homebrew Review SIF with OMP 18.13.3; Review source mounted from the workspace into a private Apptainer HOME. This is hybrid source evidence, not installed-appliance qualification.
- Rendering: actual interactive OMP TUI in VTE/Xvfb; normal PTY 100×32 at 1280×720, narrow PTY 80×24 at 680×460. Screenshots were opened and inspected.
- Fixture requests and `gh ... --web` were deterministic and local; no credentials, GitHub requests, model turns, or work dispatches were used.
- The fixture did not co-load Luna Factory; the startup `Factory handoff unavailable` notice is fixture-specific and outside this Review surface sign-off.

## Round-one finding

**D1 — resolved for captured ANSI screens.** Round 1 showed the same long error three times and a dim recovery action. The final screenshots show one full diagnostic transcript plus a short persistent summary and a bold red `Next:` action row. A lower-severity browser warning and an info notice do not replace the unresolved error. `/review status` clears the banner. The editor draft remains present and can be continued after a refresh error.

## Evidence

All screenshots are under `screenshots/`.

| Step | Normal (100×32) | Narrow (80×24) | Health |
|---|---|---|---|
| Review queue baseline | [01-dashboard-baseline.png](screenshots/01-dashboard-baseline.png) | [narrow-01-dashboard-baseline.png](screenshots/narrow-01-dashboard-baseline.png) | Pass; real fixture row and status are visible. |
| Alt+B repository selection | [02-dashboard-group-selected.png](screenshots/02-dashboard-group-selected.png) | [narrow-02-dashboard-group-selected.png](screenshots/narrow-02-dashboard-group-selected.png) | Pass; selected state is visible. |
| `/review slay` preflight error | [03-slay-error-editor.png](screenshots/03-slay-error-editor.png) | [narrow-03-slay-error-editor.png](screenshots/narrow-03-slay-error-editor.png) | Pass; real blocked error is legible and says no work was admitted. |
| Persistent banner in dashboard | [04-slay-error-dashboard.png](screenshots/04-slay-error-dashboard.png) | [narrow-04-slay-error-dashboard.png](screenshots/narrow-04-slay-error-dashboard.png) | Pass; `Next: /review status` is separate, bold, and visible. |
| Reader navigation before warning | [05-reader-before-warning.png](screenshots/05-reader-before-warning.png) | [narrow-05-reader-before-warning.png](screenshots/narrow-05-reader-before-warning.png) | Pass; selected PR reader is visible. |
| Lower-severity warning after error | [06-warning-early.png](screenshots/06-warning-early.png), [07-error-retained-after-warning.png](screenshots/07-error-retained-after-warning.png) | [narrow-06-warning-early.png](screenshots/narrow-06-warning-early.png), [narrow-07-error-retained-after-warning.png](screenshots/narrow-07-error-retained-after-warning.png) | Pass; warning details appear once; the red error summary/action remain. |
| Return from reader and dashboard | [08-error-dashboard-after-reader.png](screenshots/08-error-dashboard-after-reader.png) | [narrow-08-error-dashboard-after-reader.png](screenshots/narrow-08-error-dashboard-after-reader.png) | Pass; reader closes, dashboard remains navigable. |
| Ordinary info after error | [09-error-persists-after-info.png](screenshots/09-error-persists-after-info.png) | [narrow-09-error-persists-after-info.png](screenshots/narrow-09-error-persists-after-info.png) | Pass; info does not replace the persistent error. |
| `/review status` acknowledgement | [10-status-ack.png](screenshots/10-status-ack.png) | [narrow-10-status-ack.png](screenshots/narrow-10-status-ack.png) | Pass; persistent banner clears. |
| `/review` native completion | [11-review-completion.png](screenshots/11-review-completion.png) | [narrow-11-review-completion.png](screenshots/narrow-11-review-completion.png) | Pass; subcommands and descriptions are readable. |
| Draft before refresh failure | [12-draft-before-refresh-error.png](screenshots/12-draft-before-refresh-error.png) | [narrow-12-draft-before-refresh-error.png](screenshots/narrow-12-draft-before-refresh-error.png) | Pass; `/review sta` remains in the editor. |
| Refresh error while draft is active | [13-refresh-error-early.png](screenshots/13-refresh-error-early.png), [14-refresh-error-during-draft.png](screenshots/14-refresh-error-during-draft.png) | [narrow-13-refresh-error-early.png](screenshots/narrow-13-refresh-error-early.png), [narrow-14-refresh-error-during-draft.png](screenshots/narrow-14-refresh-error-during-draft.png) | Pass; error does not clear the draft or move focus. |
| Continue typing after error | [15-draft-continued.png](screenshots/15-draft-continued.png) | [narrow-15-draft-continued.png](screenshots/narrow-15-draft-continued.png) | Pass; typing `tus` completes the draft to `/review status`. |

## Remaining gate

The native TSP toast was not visually captured. The current terminal exposes ordinary ANSI through VTE/Xvfb only. The final source documents that the current OMP extension API does not expose its internal `StatusNotice` component at [review-dashboard.md:188](../../../skills/review-dashboard.md:188); the implementation now shows the transcript diagnostic and persistent Review banner. A diagnostic run before removal of the unsupported import recorded `ResolveMessage: Cannot find package '@oh-my-pi/pi-tui' imported from /usr/share/review/extension/extension.ts` in `statusnotice-diagnostic.jsonl`. This does not establish how a TSP-capable host would render a toast. No TSP capture surface was available, so full visual sign-off remains blocked.

Accessibility checks are limited to visible contrast, clipping, reading order, and keyboard behavior in the captured terminal. No full accessibility conformance claim is made.

## Nonblocking status-label note

In [narrow-04-slay-error-dashboard.png](screenshots/narrow-04-slay-error-dashboard.png), the green `RUNNING` label appears beside a blocked Slay error. It could briefly suggest that the rejected run is still executing, but the same footer says `no active slay`, and the banner says admission failed. The auditor rated this a nonblocking clarity ambiguity, not a release blocker. `rail.ts:154-162` defines `RUNNING` as admission being unpaused; `no active slay` is a separate batch-progress state.

## Nonblocking status label note

In [narrow-04-slay-error-dashboard.png](screenshots/narrow-04-slay-error-dashboard.png), the green `RUNNING` label sits beside the blocked Slay error. It could briefly read as the attempted run still executing, but the same footer says `no active slay`, and the banner explicitly says admission failed. I rate this a nonblocking clarity ambiguity, not a release blocker. `rail.ts:154-162` shows that `RUNNING` means admission is unpaused while `no active slay` is a separate batch-progress state.
