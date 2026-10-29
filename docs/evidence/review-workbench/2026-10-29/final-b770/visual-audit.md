# Review workbench visual audit receipt

**Verdict: BLOCKED — native TSP visual rendering is unavailable in the capture environment.** The captured ANSI banner, recovery path, navigation, completion, focus, and narrow layout pass the observed scope. No TSP screenshot or visual PASS is claimed.

## Source and environment

- Commit: `b7703314eafca250e95233d822bdaf253e1986d6`.
- UI manifest SHA256: `2fc4db22002e84218055b1080448c8c257599e8242c9ad409d2fc05625e967d2`.
- Full source manifest SHA256: `a2b03d9fec3c9de8f0e5e0e4bba4310630b461ced46f783fc511d0880d65b9d2`.
- Runtime: Homebrew Review SIF, OMP 18.13.3, hybrid source mount, isolated HOME, deterministic in-memory fixture, no live credentials, GitHub requests, model turns, or work dispatches.
- Normal ANSI capture: 100×32 PTY, 1280×720 pixels. Narrow ANSI capture: 80×24 PTY, 680×460 pixels. Screenshots were opened and inspected.
- The fixture did not co-load Luna Factory; its unrelated `Factory handoff unavailable` startup notice appears in the screenshots.

## Round-one finding

**D1 — resolved in the captured ANSI scope.** The earlier UI repeated a long error in several regions. The current screenshots show one full transcript diagnostic plus a short persistent Review summary and a separate bold red `Next:` action. A later browser warning and an info notice do not replace the unresolved Slay error. `/review status` clears the persistent banner. Typing continues after an asynchronous refresh error.

## Normal and narrow evidence

All screenshots are in `screenshots/`.

| Step | Normal | Narrow | Health |
|---|---|---|---|
| Queue baseline | `01-baseline-100x32.png` | `narrow-01-baseline-80x24.png` | Pass; real fixture queue is visible. |
| Alt+B selection | `02-selected-100x32.png` | `narrow-02-selected-80x24.png` | Pass; selected state is visible. |
| Blocked `/review slay` error | `03-error-100x32.png` | `narrow-03-error-80x24.png` | Pass; the error says admission failed before dispatch and gives the next step. |
| Dashboard with persistent banner | `04-error-dashboard-100x32.png` | `narrow-04-error-dashboard-80x24.png` | Pass; the recovery row remains visible. |
| Lower-severity warning does not replace error | `05-error-after-warning-100x32.png` | `narrow-05-error-after-warning-80x24.png` | Pass; error summary/action remain. |
| `/review status` acknowledgement | `06-ack-100x32.png` | `narrow-06-ack-80x24.png` | Pass; the persistent banner clears. |

Exact screenshot paths:

- `screenshots/01-baseline-100x32.png`
- `screenshots/02-selected-100x32.png`
- `screenshots/03-error-100x32.png`
- `screenshots/04-error-dashboard-100x32.png`
- `screenshots/05-error-after-warning-100x32.png`
- `screenshots/06-ack-100x32.png`
- `screenshots/narrow-01-baseline-80x24.png`
- `screenshots/narrow-02-selected-80x24.png`
- `screenshots/narrow-03-error-80x24.png`
- `screenshots/narrow-04-error-dashboard-80x24.png`
- `screenshots/narrow-05-error-after-warning-80x24.png`
- `screenshots/narrow-06-ack-80x24.png`

The dashboard reader and warning state are also shown in the normal screenshots. At 80×24, the full warning wraps, but the dashboard row and recovery action remain visible. The green `RUNNING` footer label is a nonblocking clarity ambiguity: it is paired with `no active slay`, while the red banner says `Cannot admit slay`. `rail.ts:154-162` defines the former as admission being unpaused and the latter as batch progress being absent.

## Public TSP node evidence

The actual `review-native-notice` setWidget factory was observed through the fixture wrapper at `statusnotice-widget-events.jsonl`:

- Set: `nativeNode={k:"toast",p:{text:"Cannot admit slay for fixture/review#42: …",sub:"Next: /review status",ttl:2400}}`.
- Unsupported capability: `describe({supports:()=>false})` returned `null`.
- ANSI: `render(80)` returned `[]`.
- Acknowledgement: the subsequent event was `cleared:true`.

The supported `describe()` result was queried with a fixture context whose `supports("toast")` returned true. This verifies the public node contract; it is not a rendered TSP screenshot.

## Remaining gate: TSP visual

This environment exposes VTE ANSI only and has no TSP-capable renderer, so the native toast could not be seen. The current docs state that TSP-capable terminals receive the toast node and ANSI terminals use the persistent banner and transcript at [review-dashboard.md:188](../../../../skills/review-dashboard.md:188). A TSP-capable screenshot is still required before full visual sign-off.

The audit does not claim full accessibility conformance or installed-appliance qualification.
