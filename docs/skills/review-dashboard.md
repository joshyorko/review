---
name: review-dashboard
version: "2.2"
last_updated: 2026-09-05
id: review-dashboard
one_line_purpose: Change the maintainer dashboard without weakening its gate or hiding the queue.
entry_point: docs/skills/review-dashboard.md
category: ci-ops
mcp_compliance_level: partial
optimization_status: draft
status: active
dependencies: []
tags: [textual, tui, dashboard, review, maintainer]
description: "Maintains image/tui/bluefin_review_tui.py: the mutation gate, the queue view, and its Textual patterns. Use when editing the dashboard or its pilot tests."
metadata:
  type: runbook
  context7-sources: [/websites/textual_textualize_io, /textualize/textual]
---

# Review Dashboard

`just review-queue` reads the organization's open pull requests live: one
paginated GraphQL search through the shipped GitHub CLI, carrying the review,
mergeability, and CI-rollup evidence each recommended action is classified
from. `just review-queue owner/repo` reads that repository's open pull
requests the same way and normalizes them into the same repository-qualified
queue rows. The authenticated maintainer's own pull requests remain hidden.
The dashboard distinguishes ready, empty, missing, inaccessible, malformed,
and failed sources; `R` rereads whichever source is active. The flag form
`--repo` narrows the org-wide queue to one repository.

## When to Use

Load this before editing `image/tui/bluefin_review_tui.py`,
`tests/dashboard_pilot.py`, or `tests/dashboard-contract.sh` — the maintainer
surface `just review-queue` opens.

## When Not to Use

Do not use this for the launcher that starts the container
([`launcher.md`](launcher.md)), the image it runs in
([`image-build.md`](image-build.md)), or Hive's contributor protocol
([`hive-runtime.md`](hive-runtime.md)).

## Semantic Foundation

`image/tui/semantic_view.py` is the pure semantic contract for the dashboard.
Its builders consume queue items and validated `ReviewResult` values; they
do not call Textual, GitHub, Hive, a harness, or a mutation gate.

`ActionID` is a stable shared registry, and every intent is explicit: verdict
selection and submission are separate (`CHOOSE_REVIEW_VERDICT`,
`APPROVE_REVIEW`, `REQUEST_CHANGES`, `COMMENT_REVIEW`, `SUBMIT_REVIEW`), as
are pull-request mutations (`APPROVE_AND_QUEUE`, `MERGE_NOW`, `UPDATE_BRANCH`,
`CLOSE_PULL_REQUEST`, `ADD_PULL_REQUEST_COMMENT`, `RESOLVE_DUPLICATES`),
read-only `COPY_REVIEW_CONTEXT`, navigation, harness preparation, and
review-body intents. The registry must not reintroduce ambiguous `REJECT`,
`LEAVE_REVIEW`, `COMMENT`, or `HANDOFF` identifiers.

`ActionSpec.suspended_in_editor` marks navigation and pane intents suppressed
while a text editor owns focus; `mutating` identifies a GitHub-side mutation,
and `confirmation_required` also covers local preparation needing consent.

The live TUI exposes one `command_registry()` from
`image/tui/bluefin_review_tui.py`, and bindings and help/palette entries are
projections of it (`j/k`, `g/G`, `Ctrl-d/Ctrl-u`, `h/l`, Enter, Escape, `q`,
`Ctrl-C`, `Ctrl-q`, `/`, `r`, `y`, `Ctrl-p`, `:`, `?`). On the root dashboard
`q` and Ctrl-C quit; on pushed screens `q` and Escape go back. Editor and
confirmation focus stays authoritative: suspended commands never consume typed
prose or PR numbers. `u` is the gated branch update, `U` selects
live-evidence mechanical Renovate rows, `a` is approve+queue only, `A` is the
only batch-landing key, `w` opens the read-only batch queue, and `P` sets the
session's final-review policy.

`QueueRow` and `DecisionCard` carry the pull-request identity, TL;DR, current
and reviewed heads, freshness, CI, mergeability, provenance, verification,
findings, and available human actions. A full current head is bound only when
Codex-style `provenance.head_sha` or the landed Goose `live.head` evidence is
the exact 40-character SHA; an abbreviated Goose head produces `STALE` and
withholds the current head, and repository-backed expansion belongs before
this pure builder, which performs no lookup. Missing evidence or any
disagreement also produces `STALE` and cannot produce a clean card. `effort`
is preferred while `reasoning_effort` remains accepted. `ReviewStateView`
owns `READY`, `RUNNING`, `STALE`, and `CANCELLED`.

Terminal-normalized Shift-L may arrive as lowercase key identity plus uppercase
character: the dashboard dispatches it to ordinary review and keeps lowercase
`l` pane movement on the active `Screen` focus API. The two right-hand
evidence panes are focusable `ScrollableContainer`s wrapping the
`#details`/`#context` Statics, so `h`/`l` reach them and tall evidence scrolls
instead of clipping. Editor shortcuts are priority bindings with literal hints
and buttons calling the same actions; review and comment submission both run
exact-body preview then the typed-number gate. Terminal dispatch failures
become bounded visible errors instead of ending the dashboard. `e` opens
bounded decision evidence, `r` the explicitly secondary raw transcript, and
`[u]` updates only clean branches — conflicts go to manual resolution.

## Core Process

1. **Every mutation goes through `mutate_all()`.** It shows the exact command
   or Hive request and runs nothing until the maintainer types the pull request
   number. The read-only `gh()` helper must never carry a mutating verb.
2. **One decision is one gate.** An action needing several `gh` calls passes
   them all to a single `mutate_all()` so the whole sequence is confirmed
   once and then runs to completion. Never chain gated calls through a
   completion callback: it asks the maintainer to confirm the same decision
   twice, which trains the number as a reflex.
3. **Order a sequence so its first failure is harmless.** `mutate_all()`
   stops at the first non-zero exit. Put the step that can fail without
   consequence first — creating a missing `lgtm` label before submitting the
   approval means a failure leaves no approval that nothing will act on.
4. **A failure must survive the notification.** Record it on the `Stop`, mark
   the row, count it in the status line, and keep the stop selected so a
   batch carries it forward. A toast is gone before a batch of eight
   finishes.
5. **Batch every action that a maintainer repeats.** Merging and updating
   branches take the batch selection when one exists. `A` on a selection is
   different: the reviewed batch
   becomes one landing agent's brief behind
   one proportionate gate (see "Batch landing" below), not one typed gate
   per pull request.
6. **Add the behaviour to `tests/dashboard_pilot.py`**, which drives the real
   app through `run_test()`. The static greps in
   `tests/dashboard-contract.sh` are for proving *absence* — a power the
   dashboard must not have. Presence is proven by pressing the key.
7. **Completed reviews cross the `ReviewResult` contract.** The Goose adapter
   accepts its JSONL findings and orchestrator progress records; an exit-zero
   transcript without that structure is `unparsable`, never clean. The Codex
   adapter accepts one complete official JSONL run: one thread and turn start,
   one final result-bearing `item.completed` agent message, and an immediately
   following successful `turn.completed`. Bare or ambiguous results and
   malformed, failed, cancelled, out-of-order, or trailing terminal events are
   `unparsable` with bounded raw evidence. It enables code-mode-only with the
   bundled official host, disables direct-tool fallback, and uses the review
   container as the shell isolation boundary rather than a nested bubblewrap
   sandbox. A re-entrant harness persists its opaque continuation before
   waiting on an external event; only that durable continuation makes a run
   resumable. Keep the decision card concise, keep bounded raw evidence on
   `e`, and keep backend prose out of Textual rendering code.
8. **Keep the acting surface explicit.** The shipped keys cover review,
   merge, branch updates, rejection, handoff, docs, and dupe
   cleanup; label and priority mutation are not part of the dashboard.

## Textual Patterns

Verified against `/websites/textual_textualize_io`.

**Escaping is not optional, and upstream's `escape` is not sufficient.** Both
`rich.markup.escape` and `textual.markup.escape` compile
`(\\*)(\[[a-z#/@][^[]*?])` — the tag pattern matches **lowercase only** — while
the renderer consumes `[H]` and `[WIP]` all the same. A pull request titled
`[WIP] fix the thing` silently lost its prefix. Use the module's own
`escape()`, which escapes every opening bracket:

```python
def escape(text: str) -> str:
    return str(text).replace("\\", "\\\\").replace("[", "\\[")
```

Upstream's recommendation for mixing variables into markup — template
substitution, `Content.from_markup("hello [bold]$name[/bold]!", name=name)` —
sidesteps the question entirely.

**Links need a quoted URL.** `[link=https://…]` fails the markup value parser
at the colon; `[link="https://…"]` is correct, and reaches the terminal as
OSC 8.

**Markup spans resolve `$`-theme variables.** `[$text-success on
$success-muted]…[/]` inside a `Static` parses through the active app's
stylesheet, so the theme's text-on-muted pairings work in markup, not only
in CSS. Padding spaces inside a span keep its background — that is how a
markup line becomes a full-width bar (`ljust` the label to the content
width, then wrap it in the styled span).

**Never touch the DOM from a thread worker — including the query.** Textual
is not thread-safe. `self.call_from_thread(self.query_one(...).update, text)`
looks safe and is not: the query runs on the worker thread and can race a
repaint. Hand the whole operation over:

```python
@work(thread=True)
def render_context(self, stop: Stop) -> None:
    ...
    self.call_from_thread(self.paint_context, "\n".join(lines))

def paint_context(self, text: str) -> None:
    self.query_one("#context", Static).update(text)
```

**Diffs get Pygments through Rich**: `Syntax(text, "diff", theme="ansi_dark")`.
`ansi_dark` resolves to the terminal's own palette instead of assuming a
background colour. `DiffScreen` keeps GitHub's complete response in bounded
pages; `[` and `]` navigate them, while loading, success, and fetch error are
distinct states. `[o]` is only an optional browser escape hatch.

## Design Rules

- **Show the whole queue by default.** Defaulting to one
  `recommended_action` rendered a 121-stop queue as five and hid every
  merge-ready pull request. When a view is filtered, the status line says how
  many stops are hidden.
- **Keep mutation failures inspectable.** The selected stop and recovery screen
  retain the exact command, GitHub error, checks, and branch state after the
  notification disappears. Update, retry, queue, and skip are explicit; a true
  conflict offers manual handoff without a bypass.
- **Colour is never the only carrier of a fact.** Rows colour by state *and*
  carry `⚑ CONFLICTS`, `✓ CI GREEN`, `✗ CI FAILED`, `… CI PENDING`, or
  `? CI UNKNOWN`, as applicable. The batch queue applies the same rule three
  layers deep — printed state word, a shape-distinct glyph from
  `LANDING_STATE_STYLES`, then colour — so a colourless or colour-blind read
  loses nothing (see "Batch landing"). Selection is not colour-only either:
  a selected row leads with a `●` marker and carries a full-row background.
- **Direct merge respects known CI state.** Ordinary `[m]` refuses a pull
  request whose queue evidence or fetched live evidence says CI failed or is
  pending; GitHub branch protection remains an additional gate.
- **Roll up checks at the exact current head.** Fetch `headRefOid` and
  `statusCheckRollup` in one `gh pr view`, group check runs by workflow and job
  name (commit statuses by context), and use only the newest run per stable
  context, so a superseded cancellation cannot fail a successful rerun.
  Authoritative failures, cancellations, pending and absent checks, and
  GitHub's merge state remain separate evidence.
- **Prefer the queue evidence already in memory.** `mergeable_state`, `check_state`,
  `review_state`, `labels` and every duplicate's title arrive with the queue
  and the cluster listing. Colour, the merge-queue meter and the duplicate
  summaries all cost zero extra requests.
- **Classify from evidence, never from a title.** `MECHANICAL` marks
  merging the base into a green, mergeable branch that is merely behind. It
  requires a Renovate author, update type (`digest`, `pin`, `patch`, `minor`),
  an open non-draft pull request, `MERGEABLE` + `BEHIND`, and all checks green.
  `[U]` selects those stops for gated `[u]`.
- **Distinguish the merge paths.** `a` requests Hive's App-authored approval
  and applies `lgtm`. On a selection, `A` dispatches one landing agent for the
  batch; without a selection `A` no-ops. `w` opens the batch queue. `m` squashes
  now (gated on `push` permission). `L` leaves a review and merges nothing.
- **Keyboard reference modal on `?`**: `?` opens `HelpScreen`, a modal
  grouping navigation, review, batching, and mutations with cyan/magenta
  badges; dismisses cleanly with `?`, `q`, or `Esc`.
- **Treat the Hive API as JSON, not a browser.** The read-only status probe
  reports missing hub configuration, missing credentials, network failure,
  authentication, authorization, edge/login redirects, malformed responses,
  and server failure as separate concise states. The queue POST never follows a
  redirect and succeeds only when a bounded JSON response explicitly says
  `queued`; the typed pull-request-number gate remains the authority boundary.
  A failed probe leaves the queue and review evidence visible and marks
  retained worker assignments as last-known. Probes run only at startup or
  after an explicit refresh; direct GitHub review and merge stay available.

## Batch landing

The selection is the review, so the batch gate is proportionate:
`BatchPlanScreen` shows every selected pull request and the exact agent
command, Enter dispatches, Esc aborts — no typed count. A typed-number gate
earns its ceremony on a single irreversible command; on a batch reviewed
row by row it teaches nothing.

Multi-repository selections partition into independent per-repository
`LandingTask`s, unlocking parallel execution across separate repository lanes.
Confirmed batches enter `app.landing_queue`; the repository-aware dispatcher
admits up to `BLUEFIN_REVIEW_CONCURRENT_LANDINGS` (defaults to 6) concurrent
agents whose repository sets are disjoint, while a batch touching a running
repository waits. This enables the maintainer to review the queue concurrently
in their client dashboard across up to 6 parallel review/landing lanes while
the 6 cluster worker pods process assigned work on Kubernetes simultaneously.
The agent is Goose's documented one-shot (`goose run --no-session -i
<prompt-file>`, overridable with `BLUEFIN_REVIEW_LANDING_COMMAND`), run in
its own process group so `[x]` stops it whole. On `ReviewScreen`, the decision
card renders diff footprint, per-check breakdown, and findings with severity
badges. Pressing `f` enqueues an automated background fix-and-land agent seeded
with the review findings, returning immediately to the queue so the maintainer
can pile up background fixes; `F` prompts for guidance before dispatching. Fix
agents repair defects, verify green CI, re-review, and land.

The agent reports, the screen polls — and the agent never writes the
status file directly: every state change goes via the module's report
CLI, one JSON line per call under flock, stamped `ts`. A terminal state is
written once: identical retries no-op, a wrong terminal verdict corrects
to a later terminal event (latest wins), a post-terminal non-terminal
write fails, and `done` is refused while any pull request in the seeded
selection lacks a terminal state (#377). `LandingScreen` ([w], auto-pushed
on dispatch) renders all batches, per-PR state, the agent log tail, and
Hive stats. Never scrape agent prose for status. When a task finishes,
`landing_finished` folds the report onto the rows and notifies the
maintainer: the toast carries the batch id and the per-state counts, at
error severity when anything failed or the agent exited without the
task-level `done` event, and persists on the status line (`last batch …`)
until the next dispatch or refresh. The rows keep what
the toast cannot outlive: merged leaves the batch; blocked, failed, and
awaiting-stable stays selected with the agent's reason — the same rule as
every other failure. A pull request the agent never carried to an outcome
is marked `no outcome reported` when the agent closed its report with
`done` and `agent died mid-batch` when it never did — each with the last
reported state, both distinguishable from every reportable state.

The brief teaches the agent to batch a repository-level blocker: a required
check that fails on the toolchain or the base branch blocks every pull
request in that repository identically, so the first such `blocked` verdict
is diagnosed once and applied to the remaining same-repository rows in one
pass — each note naming the one root cause. The fix never goes inside one
pull request's branch: a mechanical root cause (a toolchain pin bump, a
workflow repair) is fixed at the root as its own branch and pull request,
named in each covered note, and reported rather than merged because it was
not in the maintainer's confirmed selection. A root cause with no mechanical
fix is a written finding in the done note.

The screen is a cabinet of framed panels (`BATCHES`, `HIVE`, `AGENT LOG`,
round `$secondary` borders with titles) over a title bar. Each batch header
is a full-width state bar (`batch_bar_style`) that also names its heartbeat
— the age of the status file's last append (`last report 3m ago`) — so a
healthy long wait is distinguishable from a dead agent (#291). Each pull
request carries its state three ways at once: the printed word, a
shape-distinct glyph, and a colour from `LANDING_STATE_STYLES` — `◌`
waiting, `◐` diagnosing/fixing, `◔` waiting-ci, `▶` merging, `◆`
awaiting-stable, `✓` merged, `■` blocked, `✗` failed, `✔` task-level done,
`◇` a final review round. Colour is additive: terminal states also read bold
on a muted fill, so hue is never the only difference. Verified against the
pinned Textual: markup spans resolve `$`-theme variables via the active
app's stylesheet, and padding in a span keeps its background.

The record outlives the run: the launcher mounts the state directory from the
host, and `restore_landing_marks` folds the newest persisted outcome
(`landing.persisted_events`, oldest file first) back onto matching rows
whenever the queue (re)builds them, so a relaunch shows the failure marking
again instead of reverting to un-reviewed (#281). Only the marking is
restored; rebuilding a batch selection stays the maintainer's. A manual
success — a re-queue, a direct merge — clears the row in memory and also
writes a superseding event (`landing.record_event`, appended to
`manual.jsonl`, fresh mtime, wins the fold), or the next refresh folds the
stale failure back onto the row (#290). The record is durable, so it is
bounded: batch files older than seven days are pruned as the record is read.
Each task id carries the instance name (`BLUEFIN_REVIEW_INSTANCE`, set by the
launcher to the container name) because named dashboards share one state
directory, and a bare one-second stamp let two overwrite each other's files;
same-second batches from one dashboard get a numeric suffix.

**Done is the release tag, not the merge — where an image is published.**
A GitHub merge only starts the publish pipeline; the batch item is landed
when the repository's release tag carries the merged commit. The tag is
the repository's fact, never an assumption: the brief has the agent list
the package's tags through the anonymous ghcr flow and accept the publish
it can prove — the convention is `:stable`, a repository publishing only
`:latest` proves it there (common#1008 was reported blocked on a
successful `latest` publish), and a commit-tagged image with no moving
release tag is itself a proven publish. `failed`/`blocked` is only for a
merge commit no publication can evidence. The agent reports
`awaiting-stable` at merge and `merged` only once the tag has it. A
repository with no publish workflow and no image package — a
config/quadlets repository — can never publish, so the brief has the agent
detect that *before* merging and define done as the GitHub merge itself,
reported as `merged` with a note that no image pipeline exists. The
detection never uses the packages API (the shipped token lacks
`read:packages`, and the orgs endpoint 404s on user-owned repositories —
both read as a false "no package"): a repository counts as publishing
unless both signals are absent — no workflow has an `on.push` or
`on.workflow_run` path pushing the repository's own
`ghcr.io/<owner>/<repo>` package (reusable `workflow_call`, manual-only
`workflow_dispatch`, release-only, examples, and references to other
images never count — #376), and the package is not anonymously readable:
ghcr never 404s a missing package, so the signal is a denied anonymous
token mint (403 DENIED) or `/tags/list` answering 401/403 — probed through
the module's probe CLI so the denial survives in code, never a shell
pipeline (#375); a probe that cannot answer is not evidence of absence. A
403 alone is ambiguous with a private package; the workflow conjunction
covers that case. On a merge-queue repository, `gh pr merge` answering
"accepted by merge queue" means the merge completes later: poll `gh pr
view` until MERGED and verify the merge commit's publish run — never `gh
run watch` a merge_group gate run (#291). The wait watches the publish
workflow's own trigger (push runs, or `workflow_run` runs once upstream CI
completes; a release-only path owes nothing until a release) and ends
through the module's `publish-verdict` CLI: an empty run list is never
evidence, only all-terminal runs prove no publication is owed (#376).
Every wait-state note names its target and timeout. GitHub computes
mergeability asynchronously, so a `mergeable: UNKNOWN` answer is a
cache-warming placeholder: the brief has the agent re-query with backoff
for up to a minute and act only on the computed state — `blocked` on
UNKNOWN alone reports nothing a maintainer can act on (#294). Publish
detection also has a change-level edge: a publish workflow can be
path-filtered, scheduled, or manual, so a merge that touches none of its
triggers owes no publication — the brief has the agent prove the filter
from the workflow YAML and the merge commit's file list and report the
merge itself as the deliverable, never `failed` for a publication the
repository never promised. Above all of these stands one policy: this
appliance owns no lab and depends on none — no pull request may ever
report `blocked` because a maintainer-local service is missing; its
absence or failure only moves the verification to ghcr evidence. The same
holds for a required check that fails without testing the pull request:
when the external service the check drives — a lab endpoint, a runner pool
— is unreachable, that is infrastructure unavailability, not a defect, and
never `blocked` on its own. The brief has the agent prove the distinction
in the check's logs, verify the check's deliverable in ghcr instead (the
head's `sha-<head>` image is the substitute evidence), and continue the
normal path — approve and merge, or the `lgtm` label with the evidence
named when branch protection refuses with the check still red. Merging
around it stays forbidden. - **The completed card reuses those paths.**
`L`, `a`, `m`, and `u` return to the queue's existing handlers, so
permissions, live-head checks, exact commands, and typed-number
confirmation remain the authority boundary. - **Show evidence state, not a
verdict invented from prose.** The card carries exact severity counts,
cited file/line findings, engine and live-CI verification,
duplicate/overlap context, mergeability, head, and backend/model
provenance. Incomplete, failed, and unparsable results direct the reviewer
to raw evidence and never display a clean conclusion. The card is a
point-in-time record: `ReviewScreen` pins the live and overlap evidence at
review start, because the queue's background workers keep rewriting
`stop.live`/`stop.overlap` while the review runs (#339). - **Never bypass
branch protection.** No `--admin`, no `--delete-branch`, no push.

### Review bodies

`L` keeps the existing verdict picker, then opens a multiline `TextArea` for
approve, request-changes, or comment. `Ctrl-g` asks the active drafting
capability for bounded prose from the stored completed `ReviewResult` and live
PR facts; failed, incomplete, or untrusted evidence refuses generation while
manual text remains available. `Ctrl-e` returns focus to editing, `Ctrl-p`
previews the exact Markdown and command, `Ctrl-Shift-k` clears the body, and
`Ctrl-s` submits through the typed PR-number gate. The final Markdown is
written verbatim to a bounded temporary body file for `gh pr review
--body-file` only, removed after success, failure, or cancellation; no draft
action selects a verdict, discovers findings, or mutates GitHub.

## The optional lab in the UI

A landed batch is not a reviewed batch: the final review-and-fix rounds
(#378) run in this same lane once every selected pull request holds a
terminal outcome. Their policy gate, classification, per-round models,
five-round breaker, and cleanup gate are in [`final-review.md`](final-review.md).

The launcher owns the lab decision, the broker, and its lifetime; see
[`launcher.md`](launcher.md). The dashboard receives a socket
path, a session id, and read-only personal lab skills; never a credential.
`lab_client` is the whole container-side surface (`status`, `health`,
`submit`), returning `DEGRADED` envelopes on failure.

The status area carries `LAB OFF`, `LAB READY`, `LAB DEGRADED`, or
`LAB ⚡ ACTIVE`. `ACTIVE` requires a Review-bound workflow for this exact
session/repository/PR/head running **and** both `ghost` and `exo-0` reporting
`lab.projectbluefin.io/usb4-link=up` with valid `usb4-link-observed-at`
timestamps under 45 seconds old. Coarse 30-second off-thread polling ensures a
wedged broker never slows the UI. Lab evidence supplements a review and never
gates one.

## Common Rationalizations

| Rationalization | Reality |
|---|---|
| "Two confirmations is safer than one." | It is the same decision twice. The second prompt teaches the number as a reflex, and an abort at it leaves half the action applied. |
| "The notification reports the failure." | It is gone before a batch finishes. Mark the row. |
| "A grep proves the feature works." | It proves the source contains a string. The pilot presses the key. |
| "I know this Textual API." | `escape` misses uppercase tags and `[link=…]` needs quotes — both were found by running it, not by remembering it. |

## Red Flags

- `then=lambda: self.mutate(...)` — a chained gate; the contract fails on it.
- Interpolating any GitHub- or agent-sourced text into markup without
  `escape()`. An agent-reported JSONL state is attacker-shaped text too:
  unescaped, `waiting[/][blink]OWNED` raised `MarkupError` in
  `rows.update()` and took the whole batch-queue screen down.
- `self.query_one(...)` evaluated inside an `@work(thread=True)` body.
- A new mutating verb passed to the read-only `gh()` helper.
- A default view that filters the queue without saying so.
- A feature added with only a `tests/dashboard-contract.sh` grep behind it.

## Exact-head re-review

When a completed result is bound to an older full H0 while the point-in-time
live snapshot contains a different full H1, the decision card appends a
bounded, read-only delta: both identities, each prior finding disposition,
newly supported H1 evidence, and an explicit statement that H0 authority is
not carried forward. The review worker obtains changed H1 regions only through
the bounded read-only GitHub compare endpoint; a failed, malformed, oversized,
or partial response is concrete full-review evidence, never a guessed mapping.
Uncertain mappings, merge-base changes, sensitive workflow changes, incomplete
H0, and unavailable capability show their concrete fallback reasons and direct
the maintainer to a full review. Missing or malformed delta inputs fail closed
and do not alter ordinary same-head review cards or any action gate.

## Verification

```bash
bash tests/dashboard-contract.sh     # static contract + the Textual pilot
python3 tests/review_result_contract.py
bash tests/image-contract.sh
pre-commit run --all-files
```

- [ ] Every new mutation runs through `mutate_all()` and shows its commands.
- [ ] Multi-command actions are one gate, ordered so the first failure is
      harmless.
- [ ] Failures mark the row and keep the stop selected.
- [ ] All GitHub- and agent-sourced text passes through `escape()`.
- [ ] No DOM access inside a thread worker.
- [ ] The pilot presses the key and asserts the result.
