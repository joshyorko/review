"""Bluefin Review Dashboard — the maintainer surface for the PR queue.

The static queue snapshot orders the work, GitHub supplies the live evidence,
Goose supplies the review, and every state-changing command runs through
exactly one confirmation gate that makes the maintainer type the pull request
number. GitHub stays authoritative for pull-request state; Hive is never asked
for work here.

This is the only maintainer surface. Runs inside the review image:
``just review-queue``.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import signal
import subprocess
import time
import urllib.request
from collections import Counter
from dataclasses import dataclass, field
from datetime import datetime, timezone

from textual import work
from textual.app import App, ComposeResult
from textual.binding import Binding
from textual.containers import Horizontal, Vertical
from textual.screen import ModalScreen, Screen
from textual.widgets import (
    Footer,
    Header,
    Input,
    Label,
    ListItem,
    ListView,
    RichLog,
    Static,
)

QUEUE_URL = os.environ.get(
    "BLUEFIN_REVIEW_QUEUE_URL",
    "https://projectbluefin.github.io/review/queue.json",
)
TRACE_PATH = os.path.join(
    os.environ.get("XDG_STATE_HOME", os.path.expanduser("~/.local/state")),
    "bluefin-review",
    "trace.jsonl",
)
PULL_FETCH_LIMIT = os.environ.get("BLUEFIN_REVIEW_PULL_LIMIT", "200")
MUTATION_TIMEOUT = 60
PRIORITIES = ["P0-critical", "P1-high", "P2-medium", "P3-low"]
LABEL_CHOICES = ["kind/bug", "kind/improvement", "area/bootc", "status/approved"]

# The order a maintainer wants, which is not the order the snapshot is written
# in. The generator ranks by how stuck a pull request is; a reviewer opening
# this dashboard wants the ones they can act on now — the merge-ready and the
# reviewable — above the ones waiting on their author or on better evidence.
# A queue that buries what you can land under sixty things you cannot is a
# queue you stop reading.
MAINTAINER_ORDER = [
    "ready-for-human-merge",
    "review",
    "resolve-conflicts",
    "fix-ci",
    "investigate",
]


def action_rank(action: str) -> int:
    try:
        return MAINTAINER_ORDER.index(action)
    except ValueError:
        return len(MAINTAINER_ORDER)


# The review engine. It produces a Review Draft and has no approve, merge,
# comment, or close path of its own, so running it can never mutate GitHub.
REVIEW_COMMAND = os.environ.get("BLUEFIN_REVIEW_COMMAND", "bluefin-review")

# bluefin-review's exit status for a review whose checks did not all return a
# verdict. 'goose review' exits 0 in that case and still prints a finding
# count, so the count would otherwise read as a clean review.
REVIEW_INCOMPLETE = 65

# How long a stopped review has to die politely before it is killed.
STOP_GRACE_SECONDS = 5.0

# Ghost Cluster build dispatch and the docs-update agent task are tracked
# work, not silent stubs; the handlers below name the issue.
GHOST_BUILD_ISSUE = "projectbluefin/review#133"
DOCS_UPDATE_ISSUE = "projectbluefin/review#134"


def gh(*args: str, timeout: int = 60) -> subprocess.CompletedProcess:
    return subprocess.run(
        ["gh", *args], capture_output=True, text=True, timeout=timeout
    )


def trace(record: dict) -> None:
    """Append a JSON trace of a maintainer action for the feedback loop."""
    os.makedirs(os.path.dirname(TRACE_PATH), exist_ok=True)
    record = {"ts": datetime.now(timezone.utc).isoformat(), **record}
    with open(TRACE_PATH, "a", encoding="utf-8") as sink:
        sink.write(json.dumps(record, separators=(",", ":")) + "\n")


def dependency_subject(title: str) -> str | None:
    """Normalise a title down to the dependency it updates (walker parity)."""
    s = title.lower()
    s = re.sub(r"^\w+(\([^)]*\))?:\s*", "", s)
    for pattern in (
        r"update module\s+(\S+)",
        r"update dependency\s+(\S+)",
        r"update\s+(\S+)\s+docker\s+(?:tag|digest)",
        r"update\s+(\S+)\s+action",
        r"update\s+(\S+)\s+digest",
        r"update\s+(\S+)\s+to\s+v?[\d.]",
    ):
        found = re.search(pattern, s)
        if found:
            return re.sub(r":[^:/]*$", "", found.group(1).strip())
    return None


@dataclass
class QueueFilters:
    """Which of the snapshot's items reach the dashboard.

    The launcher passes these straight through, so 'just review-queue --repo
    bluefin' narrows the queue without a second surface to learn.
    """

    action: str = ""
    repository: str = ""
    url: str = QUEUE_URL

    def wants(self, item: dict) -> bool:
        if self.action and item.get("recommended_action", "") != self.action:
            return False
        if self.repository:
            full = item.get("repository", "")
            if full != self.repository and full.split("/")[-1] != self.repository:
                return False
        return True


@dataclass
class Stop:
    repository: str
    number: int
    action: str
    title: str
    author: str = ""
    selected: bool = False
    live: dict = field(default_factory=dict)

    @property
    def key(self) -> str:
        return f"{self.repository}#{self.number}"

    @property
    def batchable(self) -> bool:
        return dependency_subject(self.title) is not None


class ConfirmMutation(ModalScreen[bool]):
    """The single mutation gate: show the exact commands, require the typed
    pull request number. Empty, wrong, or Esc aborts; there is no y/yes and
    no timeout.

    One decision gates one sequence. Queueing a pull request is an approval
    plus the lgtm label the sweep scans for, and reject is a comment plus a
    close: splitting either into two gates asks a maintainer to confirm the
    same decision twice, which trains them to type the number without reading
    it. Every command that will run is shown here, before the one gate.
    """

    BINDINGS = [Binding("escape", "dismiss(False)", "abort")]

    def __init__(self, commands: list[list[str]], expected: str) -> None:
        super().__init__()
        self.commands = [list(command) for command in commands]
        self.expected = expected

    @property
    def command(self) -> list[str]:
        return self.commands[0]

    def compose(self) -> ComposeResult:
        with Vertical(id="confirm-box"):
            yield Label("will run:", id="confirm-heading")
            for index, command in enumerate(self.commands):
                yield Static(" ".join(command), classes="confirm-command",
                             id=f"confirm-command-{index}")
            yield Label(
                f"type the pull request number ({self.expected}) to run it; "
                "empty or Esc aborts"
            )
            yield Input(placeholder=self.expected, id="confirm-input")

    def on_mount(self) -> None:
        self.query_one(Input).focus()

    def on_input_submitted(self, event: Input.Submitted) -> None:
        self.dismiss(event.value.strip() == self.expected)


class LabelOverlay(ModalScreen[str | None]):
    """Fast label picker: one keystroke per label, Esc closes."""

    BINDINGS = [Binding("escape", "dismiss(None)", "close")]

    def compose(self) -> ComposeResult:
        with Vertical(id="label-box"):
            yield Label("toggle label:")
            for index, label in enumerate(LABEL_CHOICES, start=1):
                yield Label(f"  [{index}] {label}")

    def on_key(self, event) -> None:
        if event.key.isdigit():
            index = int(event.key) - 1
            if 0 <= index < len(LABEL_CHOICES):
                self.dismiss(LABEL_CHOICES[index])


class ReviewScreen(Screen):
    """One Goose review, streamed live.

    The review is the reason this tool exists, so it gets the whole screen and
    reports its own outcome. ``bluefin-review`` distinguishes a review that
    completed from one whose checks never returned a verdict, and that
    distinction is carried all the way to the status line here: a review that
    did not finish must never be mistaken for a clean one.
    """

    BINDINGS = [
        Binding("escape", "close", "close"),
        Binding("q", "close", "close"),
        Binding("x", "stop", "stop review"),
    ]

    def __init__(self, stop: Stop, steer: str = "") -> None:
        super().__init__()
        self.stop_record = stop
        self.steer = steer
        self.process: subprocess.Popen | None = None
        self.finished = False
        self.stop_requested = False
        self.started = time.monotonic()

    def compose(self) -> ComposeResult:
        stop = self.stop_record
        yield Header(show_clock=True)
        yield Static(
            f" reviewing {stop.repository}#{stop.number} — starting…"
            + (f"  steer: {self.steer}" if self.steer else ""),
            id="review-status",
        )
        yield RichLog(highlight=False, markup=False, wrap=True, id="review-log")
        yield Footer()

    def on_mount(self) -> None:
        self.query_one("#review-status", Static).add_class("running")
        self.run_review()

    @work(thread=True)
    def run_review(self) -> None:
        stop = self.stop_record
        command = [REVIEW_COMMAND, "pr", stop.repository, str(stop.number)]
        # Maintainer steering rides the documented additive seam: it is added
        # to the review's instructions, never a replacement for the doctrine.
        environment = dict(os.environ)
        if self.steer:
            environment["BLUEFIN_REVIEW_STEER"] = self.steer
        else:
            environment.pop("BLUEFIN_REVIEW_STEER", None)
        try:
            process = subprocess.Popen(
                command,
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,
                text=True,
                bufsize=1,
                env=environment,
                # Its own process group. A review is a shell that runs Goose,
                # which runs a subprocess per check: signalling only the shell
                # leaves those children alive holding the pipe open, and the
                # read loop below would never end.
                start_new_session=True,
            )
        except OSError as error:
            self.app.call_from_thread(self.finish, None, str(error))
            return
        self.process = process
        self.app.call_from_thread(self.mark_running)
        assert process.stdout is not None
        for line in process.stdout:
            self.app.call_from_thread(self.append, line.rstrip("\n"))
        self.app.call_from_thread(self.finish, process.wait(), "")

    def mark_running(self) -> None:
        stop = self.stop_record
        self.query_one("#review-status", Static).update(
            f" reviewing {stop.repository}#{stop.number} — running; [x] stops it"
        )

    def append(self, line: str) -> None:
        self.query_one("#review-log", RichLog).write(line)

    def finish(self, code: int | None, error: str) -> None:
        self.finished = True
        stop = self.stop_record
        elapsed = int(time.monotonic() - self.started)
        if error:
            outcome, state = "error", f"FAILED to start: {error}"
        elif self.stop_requested:
            outcome, state = "stopped", "STOPPED — you cancelled it. Nothing was submitted."
        elif code == 0:
            outcome = "complete"
            state = "COMPLETE — a Review Draft for you to judge. Nothing was submitted."
        elif code == REVIEW_INCOMPLETE:
            outcome = "incomplete"
            state = (
                "INCOMPLETE — part of this review returned no verdict. "
                "Its finding count is NOT a clean bill of health."
            )
        elif code is not None and code < 0:
            outcome, state = "stopped", "STOPPED — the review was killed. Nothing was submitted."
        else:
            outcome = "failed"
            state = f"FAILED (exit {code}) — the review did not run. Nothing was submitted."

        status = self.query_one("#review-status", Static)
        status.remove_class("running")
        status.add_class(outcome)
        status.update(
            f" {stop.repository}#{stop.number} — {state} ({elapsed}s) — [escape] closes"
        )
        trace(
            {
                "action": "review",
                "repository": stop.repository,
                "number": stop.number,
                "steer": self.steer,
                "outcome": outcome,
                "exit_code": code,
                "seconds": elapsed,
            }
        )

    def action_stop(self) -> None:
        # Signal the whole process group, and mean it. A review that ignores
        # SIGTERM — or a check subprocess that outlives its parent — gets
        # SIGKILL after a grace period, because a stop key that leaves the
        # review running is worse than no stop key.
        if self.finished or self.stop_requested:
            return
        self.stop_requested = True
        self.query_one("#review-status", Static).update(
            f" {self.stop_record.repository}#{self.stop_record.number} — stopping…"
        )
        if self.signal_group(signal.SIGTERM):
            self.set_timer(STOP_GRACE_SECONDS, self.escalate_stop)

    def escalate_stop(self) -> None:
        if not self.finished:
            self.signal_group(signal.SIGKILL)

    def signal_group(self, number: int) -> bool:
        process = self.process
        if process is None or process.poll() is not None:
            return False
        try:
            os.killpg(os.getpgid(process.pid), number)
        except (ProcessLookupError, PermissionError):
            return False
        return True

    def action_close(self) -> None:
        # A review takes minutes. Closing mid-run would throw that away with a
        # keystroke, so an unfinished review has to be stopped deliberately.
        if not self.finished:
            self.notify("review still running — [x] stops it")
            return
        self.dismiss()


class ReviewDashboard(App):
    """PROJECT BLUEFIN REVIEW DASHBOARD."""

    TITLE = "BLUEFIN REVIEW DASHBOARD"
    CSS = """
    #status-bar { height: 1; background: $panel; color: cyan; }
    #queue-pane { width: 45%; border: solid $secondary; }
    #right-pane { width: 55%; }
    #details { height: 60%; border: solid $secondary; padding: 0 1; }
    #context { height: 40%; border: solid $secondary; padding: 0 1; }
    #confirm-box, #label-box {
        border: heavy magenta; background: $surface;
        width: 80%; height: auto; padding: 1 2; margin: 4 4;
    }
    #confirm-command, .confirm-command { color: magenta; text-style: bold; }
    #steer { border: solid $secondary; height: 3; }
    ListItem.selected Label { color: magenta; text-style: bold; }
    #review-status { height: auto; padding: 0 1; background: $panel; }
    #review-status.running { background: $panel; color: cyan; }
    #review-status.complete { background: $success; color: $text; text-style: bold; }
    #review-status.incomplete { background: $warning; color: $text; text-style: bold; }
    #review-status.failed, #review-status.error, #review-status.stopped {
        background: $error; color: $text; text-style: bold;
    }
    #review-log { border: solid $secondary; }
    """

    BINDINGS = [
        Binding("r", "review", "review"),
        Binding("b", "batch", "batch select"),
        Binding("l", "labels", "labels"),
        Binding("p", "priority", "priority"),
        Binding("d", "docs", "update docs"),
        Binding("g", "ghost_build", "ghost build"),
        Binding("o", "open_browser", "open"),
        Binding("v", "view_diff", "diff"),
        Binding("c", "comment", "comment"),
        Binding("a", "merge", "approve and queue"),
        Binding("m", "merge_now", "merge now"),
        Binding("x", "reject", "reject"),
        Binding("h", "handoff", "handoff"),
        Binding("slash", "steer", "steer review"),
        Binding("f", "filter", "filter"),
        Binding("M", "resolve_cluster", "resolve dupes", show=False),
        Binding("q", "quit", "quit"),
    ]

    def __init__(self, filters: QueueFilters | None = None) -> None:
        super().__init__()
        self.filters = filters or QueueFilters()
        self.stops: list[Stop] = []
        self.self_login = ""
        self.generated_at = ""
        self.pulls_cache: dict[str, list[dict]] = {}
        # Repository -> whether this login may merge there. Merging without
        # the lgtm opt-in is a maintainer power, so it is asked of GitHub per
        # repository rather than assumed from the fact that a dashboard is
        # open. Unknown until asked, and never cached as True by default.
        self.merge_rights: dict[str, bool] = {}
        self.snapshot_items: list[dict] = []

    # ── layout ────────────────────────────────────────────────────────────

    def compose(self) -> ComposeResult:
        yield Header(show_clock=True)
        yield Static("loading queue…", id="status-bar")
        with Horizontal():
            with Vertical(id="queue-pane"):
                yield ListView(id="queue")
            with Vertical(id="right-pane"):
                yield Static("", id="details")
                yield Static("", id="context")
        yield Input(
            placeholder="[/] steer the review of the highlighted PR — "
            "enter runs it, esc returns to the queue",
            id="steer",
        )
        yield Footer()

    def on_mount(self) -> None:
        # The queue keeps the keystrokes. The steer box is entered on purpose
        # with [/], because a focused Input swallows every single-key binding.
        self.query_one("#queue", ListView).focus()
        self.load_queue()

    def action_steer(self) -> None:
        """Focus the steering box: free text that rides along with the next
        review of the highlighted stop as maintainer instructions."""
        if not self.current:
            self.notify("nothing highlighted to steer.", severity="warning")
            return
        self.query_one("#steer", Input).focus()

    def on_input_submitted(self, event: Input.Submitted) -> None:
        if event.input.id != "steer":
            return
        event.stop()
        steer = event.value.strip()
        field = self.query_one("#steer", Input)
        field.value = ""
        self.query_one("#queue", ListView).focus()
        stop = self.current
        if not stop or not steer:
            return
        self.push_screen(ReviewScreen(stop, steer=steer))

    def on_key(self, event) -> None:
        if event.key == "escape" and self.focused is self.query_one("#steer", Input):
            event.stop()
            self.query_one("#queue", ListView).focus()

    # ── data layer (walker parity) ────────────────────────────────────────

    @work(thread=True, exclusive=True)
    def load_queue(self) -> None:
        who = gh("api", "user", "--jq", ".login")
        self.self_login = who.stdout.strip() if who.returncode == 0 else ""
        with urllib.request.urlopen(self.filters.url, timeout=60) as response:
            snapshot = json.load(response)
        self.generated_at = snapshot.get("generated_at", "")
        # Keep the whole snapshot: the action filter is a view over it, so
        # narrowing and widening never needs another fetch.
        self.snapshot_items = [
            item
            for item in snapshot.get("items", [])
            # Own-work filtering: a maintainer reviews other people's work.
            if not (self.self_login and item.get("author") == self.self_login)
        ]
        self.call_from_thread(self.apply_filters)

    def apply_filters(self) -> None:
        stops = [
            Stop(
                repository=item["repository"],
                number=item["number"],
                action=item.get("recommended_action", ""),
                title=item.get("title", ""),
                author=item.get("author", "") or "",
            )
            for item in self.snapshot_items
            if self.filters.wants(item)
        ]
        stops.sort(key=lambda stop: (action_rank(stop.action), stop.repository, stop.number))
        self.populate(stops)

    def populate(self, stops: list[Stop]) -> None:
        self.stops = stops
        queue = self.query_one("#queue", ListView)
        queue.clear()
        for stop in stops:
            tag = " (BATCHABLE)" if stop.batchable else ""
            queue.append(
                ListItem(Label(f"{stop.key}: {stop.title[:60]}{tag} [{stop.action}]"))
            )
        self.refresh_status()
        if stops:
            queue.index = 0

    def refresh_status(self) -> None:
        selected = sum(1 for s in self.stops if s.selected)
        freshness = self.generated_at or "unknown"
        shown = len(self.stops)
        total = len(self.snapshot_items)
        scope = self.filters.action or "all"
        # Say how much of the queue is hidden. A filtered view that looks like
        # the whole queue is how a maintainer concludes there are five open
        # pull requests when there are a hundred and twenty-one.
        held_back = f" (of {total}; [f] widens)" if shown != total else ""
        breakdown = ", ".join(
            f"{count} {action}"
            for action, count in sorted(
                Counter(
                    item.get("recommended_action", "") for item in self.snapshot_items
                ).items(),
                key=lambda pair: action_rank(pair[0]),
            )
        )
        self.query_one("#status-bar", Static).update(
            f" Queue: {shown} PRs{held_back} | filter {scope} | {breakdown} "
            f"| snapshot {freshness} | as {self.self_login or 'unknown'} "
            f"| batch: {selected} | Ghost Cluster: {GHOST_BUILD_ISSUE}"
        )

    def action_filter(self) -> None:
        """Cycle the action filter: every action, then one at a time."""
        present = [a for a in MAINTAINER_ORDER if any(
            item.get("recommended_action") == a for item in self.snapshot_items
        )]
        scopes = [""] + present
        try:
            nxt = scopes[(scopes.index(self.filters.action) + 1) % len(scopes)]
        except ValueError:
            nxt = ""
        self.filters.action = nxt
        self.apply_filters()
        self.notify(f"filter: {nxt or 'all actions'} — {len(self.stops)} PRs")

    @property
    def current(self) -> Stop | None:
        index = self.query_one("#queue", ListView).index
        if index is None or not (0 <= index < len(self.stops)):
            return None
        return self.stops[index]

    def on_list_view_highlighted(self, _event) -> None:
        stop = self.current
        if stop:
            self.show_evidence(stop)

    @work(thread=True)
    def show_evidence(self, stop: Stop) -> None:
        live = gh(
            "pr", "view", str(stop.number), "--repo", stop.repository,
            "--json",
            "author,state,headRefOid,isDraft,mergeable,mergeStateStatus,"
            "reviewDecision,additions,deletions,changedFiles,updatedAt,"
            "closingIssuesReferences,statusCheckRollup,labels",
        )
        stop.live = json.loads(live.stdout) if live.returncode == 0 else {}
        if stop.repository not in self.merge_rights:
            # 'push' is exactly the power to merge on GitHub: a contributor
            # agent works from a fork and has none, which is why the direct
            # merge key can never be its path.
            rights = gh(
                "api", f"repos/{stop.repository}", "--jq", ".permissions.push"
            )
            self.merge_rights[stop.repository] = (
                rights.returncode == 0 and rights.stdout.strip() == "true"
            )
        self.call_from_thread(self.render_evidence, stop)

    def repo_pulls(self, repo: str) -> list[dict]:
        if repo not in self.pulls_cache:
            listing = gh(
                "pr", "list", "--repo", repo, "--state", "open",
                "--limit", PULL_FETCH_LIMIT,
                "--json", "number,title,files,closingIssuesReferences",
            )
            if listing.returncode != 0:
                return []
            self.pulls_cache[repo] = json.loads(listing.stdout)
        return self.pulls_cache[repo]

    def cluster(self, stop: Stop) -> tuple[list[int], list[int]]:
        """Duplicates and overlaps, exactly as the walker computes them."""
        pulls = self.repo_pulls(stop.repository)
        mine = next((p for p in pulls if p["number"] == stop.number), None)
        if mine is None:
            return [], []

        def issues(pr: dict) -> set:
            return {r["number"] for r in (pr.get("closingIssuesReferences") or [])}

        def paths(pr: dict) -> set:
            return {f["path"] for f in (pr.get("files") or [])}

        subject = dependency_subject(mine["title"])
        dupes, overlaps = [], []
        for other in pulls:
            if other["number"] == stop.number:
                continue
            if subject and dependency_subject(other["title"]) == subject:
                dupes.append(other["number"])
            elif issues(mine) & issues(other):
                dupes.append(other["number"])
            elif paths(mine) & paths(other):
                overlaps.append(other["number"])
        return dupes, overlaps

    def render_evidence(self, stop: Stop) -> None:
        if self.current is not stop:
            return
        live = stop.live
        checks = live.get("statusCheckRollup") or []
        outcomes = [c.get("conclusion") or c.get("state") or "PENDING" for c in checks]
        ok = sum(1 for o in outcomes if o in ("SUCCESS", "NEUTRAL", "SKIPPED"))
        bad = sum(1 for o in outcomes if o in ("FAILURE", "ERROR", "TIMED_OUT", "CANCELLED"))
        pending = len(outcomes) - ok - bad
        issues = ", ".join(
            f"#{r['number']}" for r in (live.get("closingIssuesReferences") or [])
        ) or "-"
        labels = ", ".join(l["name"] for l in (live.get("labels") or [])) or "-"
        author = (live.get("author") or {}).get("login", stop.author or "-")
        self.query_one("#details", Static).update(
            f"[b]{stop.key}[/b]  {stop.title}\n"
            f"queue says: {stop.action}\n"
            f"author   {author}\n"
            f"state    {live.get('state', '?')}    "
            f"head {str(live.get('headRefOid', ''))[:12] or '?'}\n"
            f"draft    {live.get('isDraft', '?')}    "
            f"review {live.get('reviewDecision') or '-'}\n"
            f"merge    {live.get('mergeable', '?')} / {live.get('mergeStateStatus', '?')}\n"
            f"size     +{live.get('additions', '?')} -{live.get('deletions', '?')} "
            f"across {live.get('changedFiles', '?')} files\n"
            f"checks   {ok} ok, {bad} failed, {pending} pending\n"
            f"linked   {issues}\n"
            f"labels   {labels}"
        )
        self.render_context(stop)

    @work(thread=True)
    def render_context(self, stop: Stop) -> None:
        dupes, overlaps = self.cluster(stop)
        lines = ["[b]CONTEXT & VERIFICATION[/b]"]
        if dupes:
            lines.append(
                f"dupe-of  {', '.join(f'#{n}' for n in dupes)} — resolve with M"
            )
        if overlaps:
            shown = ", ".join(f"#{n}" for n in overlaps[:6])
            lines.append(f"overlaps {shown} (ordering hazard, not duplication)")
        if not dupes and not overlaps:
            lines.append("no duplicates or overlaps in the open set")
        lines.append(f"skills   ~/.agents/skills (org inventory)")
        lines.append(f"trace    {TRACE_PATH}")
        self.call_from_thread(
            self.query_one("#context", Static).update, "\n".join(lines)
        )

    # ── the mutation gate ─────────────────────────────────────────────────

    def mutate(self, stop: Stop, *args: str, then=None) -> None:
        """Run one gh mutation behind the typed-number confirmation."""
        self.mutate_all(stop, [["gh", *args]], then=then)

    def mutate_all(self, stop: Stop, commands: list[list[str]], then=None) -> None:
        """Run a sequence of gh mutations behind one typed-number gate.

        The sequence is the unit a maintainer decides on, so it is confirmed
        once and then runs to completion off the UI thread. A failed step
        stops the rest: half a queueing is reported, never re-confirmed.
        """
        if not commands:
            return

        def finish(confirmed: bool | None) -> None:
            if not confirmed:
                self.notify("aborted; nothing was run.", severity="warning")
                return
            self.notify(f"running: {' '.join(commands[0][:4])}…")
            self.run_mutations(stop, commands, then)

        self.push_screen(ConfirmMutation(commands, str(stop.number)), finish)

    @work(thread=True)
    def run_mutations(self, stop: Stop, commands: list[list[str]], then) -> None:
        """Execute a confirmed sequence off the UI thread. A slow or hung gh
        call must never freeze the dashboard, so each step is bounded by
        MUTATION_TIMEOUT and reports back through call_from_thread."""
        for command in commands:
            try:
                result = subprocess.run(
                    command, capture_output=True, text=True, timeout=MUTATION_TIMEOUT
                )
            except (subprocess.TimeoutExpired, OSError) as error:
                trace(
                    {
                        "repo": stop.repository,
                        "number": stop.number,
                        "argv": command,
                        "error": str(error),
                    }
                )
                self.call_from_thread(
                    self.notify,
                    f"{' '.join(command[:4])}… did not finish: {error}",
                    severity="error",
                )
                return
            trace(
                {
                    "repo": stop.repository,
                    "number": stop.number,
                    "argv": command,
                    "exit": result.returncode,
                }
            )
            if result.returncode != 0:
                message = result.stderr.strip()[:200] or f"exit {result.returncode}"
                self.call_from_thread(
                    self.mutation_failed, stop, command, message
                )
                return
        self.call_from_thread(self.mutations_finished, stop, commands, then)

    def mutation_failed(self, stop: Stop, command: list[str], message: str) -> None:
        self.pulls_cache.pop(stop.repository, None)
        self.notify(f"{' '.join(command[:4])}…: {message}", severity="error")
        self.show_evidence(stop)

    def mutations_finished(
        self, stop: Stop, commands: list[list[str]], then
    ) -> None:
        """Apply one finished sequence on the UI thread."""
        self.pulls_cache.pop(stop.repository, None)
        self.notify(f"done: {' '.join(commands[-1][:4])}…")
        if then:
            then()
        self.show_evidence(stop)

    # ── actions ───────────────────────────────────────────────────────────

    def action_batch(self) -> None:
        stop = self.current
        if not stop:
            return
        stop.selected = not stop.selected
        item = self.query_one("#queue", ListView).highlighted_child
        if item:
            item.set_class(stop.selected, "selected")
        self.refresh_status()

    def action_labels(self) -> None:
        stop = self.current
        if not stop:
            return

        def apply(label: str | None) -> None:
            if label:
                self.mutate(
                    stop, "pr", "edit", str(stop.number),
                    "--repo", stop.repository, "--add-label", label,
                )

        self.push_screen(LabelOverlay(), apply)

    def action_priority(self) -> None:
        stop = self.current
        if not stop:
            return
        current = {l["name"] for l in (stop.live.get("labels") or [])}
        have = [p for p in PRIORITIES if p in current]
        nxt = PRIORITIES[(PRIORITIES.index(have[0]) + 1) % len(PRIORITIES)] if have else PRIORITIES[0]
        args = ["pr", "edit", str(stop.number), "--repo", stop.repository, "--add-label", nxt]
        for old in have:
            args += ["--remove-label", old]
        self.mutate(stop, *args)

    def action_review(self) -> None:
        stop = self.current
        if stop:
            self.push_screen(ReviewScreen(stop))

    def action_docs(self) -> None:
        self.notify(f"docs-update agent task is tracked as {DOCS_UPDATE_ISSUE}")

    def action_ghost_build(self) -> None:
        self.notify(f"Ghost Cluster build dispatch is tracked as {GHOST_BUILD_ISSUE}")

    def action_open_browser(self) -> None:
        stop = self.current
        if stop:
            gh("pr", "view", str(stop.number), "--repo", stop.repository, "--web")

    def action_view_diff(self) -> None:
        stop = self.current
        if not stop:
            return
        diff = gh("pr", "diff", str(stop.number), "--repo", stop.repository)
        body = diff.stdout if diff.returncode == 0 else diff.stderr
        self.query_one("#details", Static).update(body[:20000] or "(empty diff)")

    def action_comment(self) -> None:
        stop = self.current
        if not stop:
            return

        def submitted(confirmed) -> None:
            pass

        # Reuse the confirm modal's input for the body first.
        class CommentBody(ModalScreen[str | None]):
            BINDINGS = [Binding("escape", "dismiss(None)", "close")]

            def compose(self) -> ComposeResult:
                with Vertical(id="confirm-box"):
                    yield Label("comment (empty aborts):")
                    yield Input(id="comment-input")

            def on_mount(self) -> None:
                self.query_one(Input).focus()

            def on_input_submitted(self, event: Input.Submitted) -> None:
                self.dismiss(event.value or None)

        def with_body(body: str | None) -> None:
            if not body:
                return
            os.makedirs(os.path.dirname(TRACE_PATH), exist_ok=True)
            body_file = os.path.join(os.path.dirname(TRACE_PATH), "comment.md")
            with open(body_file, "w", encoding="utf-8") as sink:
                sink.write(body + "\n")
            self.mutate(
                stop, "pr", "comment", str(stop.number),
                "--repo", stop.repository, "--body-file", body_file,
            )

        self.push_screen(CommentBody(), with_body)

    def _queueable(self, stop: Stop) -> bool:
        if stop.live.get("isDraft") is True:
            self.notify(
                f"{stop.key} is a draft; the sweep ignores drafts.",
                severity="warning",
            )
            return False
        if not self.self_login:
            self.notify(
                "your GitHub login is unknown; the queue approval needs it.",
                severity="warning",
            )
            return False
        return True

    def _queue_automerge(self, stop: Stop, then=None) -> None:
        """Queue for Hive auto-merge: post the exact approval the governor
        sweep re-verifies, then add the lgtm label it scans for. The sweep
        enforces the self-merge ban, requires green CI, and squash-merges.

        Both commands are one decision, so they sit behind one gate and then
        run to completion in the background."""
        body = f"Approved by @{self.self_login} for Hive auto-merge on green CI."
        self.mutate_all(
            stop,
            [
                [
                    "gh", "pr", "review", str(stop.number),
                    "--repo", stop.repository, "--approve", "--body", body,
                ],
                [
                    "gh", "pr", "edit", str(stop.number),
                    "--repo", stop.repository, "--add-label", "lgtm",
                ],
            ],
            then=then,
        )

    def action_merge(self) -> None:
        batch = [s for s in self.stops if s.selected]
        if not batch and self.current:
            batch = [self.current]

        queue: list[Stop] = []
        for stop in batch:
            if not stop.live:
                self.notify(f"{stop.key}: no live evidence yet; select it first.")
                continue
            if self._queueable(stop):
                queue.append(stop)

        def queue_next(index: int = 0) -> None:
            if index >= len(queue):
                if len(queue) > 1:
                    self.notify(f"batch queued: {len(queue)} PRs.")
                return
            self._queue_automerge(
                queue[index],
                then=lambda next_index=index + 1: queue_next(next_index),
            )

        queue_next()

    def action_merge_now(self) -> None:
        """Merge this pull request now, as a maintainer, without `lgtm`.

        `lgtm` is an explicit opt-in to automation: it hands the pull request
        to Hive's governor sweep, which re-verifies and merges on green CI.
        Not every merge wants that, and a maintainer who has read the diff
        should not have to label a pull request to arm a robot in order to
        land it. This is the direct path — same typed-number gate, the same
        squash the sweep performs, and no label.

        It is a maintainer power. GitHub's `push` permission on the repository
        is exactly that power, so it is asked of GitHub rather than assumed.
        Branch protections are never bypassed: nothing here passes the flag
        that would override them, so a repository requiring review or green
        checks still refuses, and that refusal is reported rather than worked
        around.
        """
        stop = self.current
        if not stop:
            return
        if not stop.live:
            self.notify(f"{stop.key}: no live evidence yet; select it first.")
            return
        if stop.live.get("isDraft") is True:
            self.notify(f"{stop.key} is a draft; ready it first.", severity="warning")
            return
        if stop.repository not in self.merge_rights:
            self.notify(
                f"still checking your permission on {stop.repository}; try again.",
                severity="warning",
            )
            return
        if not self.merge_rights[stop.repository]:
            self.notify(
                f"merging {stop.repository} directly is a maintainer power and "
                "you do not have it there; queue it with [a] instead.",
                severity="error",
            )
            return
        self.mutate_all(
            stop,
            [[
                "gh", "pr", "merge", str(stop.number),
                "--repo", stop.repository, "--squash",
            ]],
        )

    def action_reject(self) -> None:
        stop = self.current
        if not stop:
            return
        body_file = os.path.join(os.path.dirname(TRACE_PATH), "reject.md")
        os.makedirs(os.path.dirname(TRACE_PATH), exist_ok=True)
        with open(body_file, "w", encoding="utf-8") as sink:
            sink.write(
                "Closing after maintainer review; see the review notes above.\n"
            )
        self.mutate_all(
            stop,
            [
                [
                    "gh", "pr", "comment", str(stop.number),
                    "--repo", stop.repository, "--body-file", body_file,
                ],
                ["gh", "pr", "close", str(stop.number), "--repo", stop.repository],
            ],
        )

    def action_handoff(self) -> None:
        """Copy the stop's identity, live evidence, and cluster verdicts to
        the reviewer's clipboard (OSC 52 through the attached terminal), so
        the review context can be handed to an issue, a chat, or another
        agent. Read-only."""
        stop = self.current
        if not stop:
            return
        live = stop.live
        lines = [
            f"{stop.key} — {stop.title}",
            f"https://github.com/{stop.repository}/pull/{stop.number}",
            f"queue says: {stop.action}",
        ]
        if live:
            lines.append(
                f"state: {live.get('state', '?')}  "
                f"head: {str(live.get('headRefOid', ''))[:12]}  "
                f"draft: {live.get('isDraft', '?')}  "
                f"review: {live.get('reviewDecision') or '-'}  "
                f"merge: {live.get('mergeable', '?')}/{live.get('mergeStateStatus', '?')}"
            )
            issues = ", ".join(
                f"#{r['number']}" for r in (live.get("closingIssuesReferences") or [])
            )
            if issues:
                lines.append(f"linked issues: {issues}")
        dupes, overlaps = self.cluster(stop)
        if dupes:
            lines.append(f"duplicates: {', '.join(f'#{n}' for n in dupes)}")
        if overlaps:
            lines.append(
                f"overlaps (ordering hazard): {', '.join(f'#{n}' for n in overlaps[:6])}"
            )
        self.copy_to_clipboard("\n".join(lines))
        self.notify(
            f"handoff for {stop.key} copied (OSC 52; the terminal must support it)."
        )

    def action_resolve_cluster(self) -> None:
        stop = self.current
        if not stop:
            return
        if not self._queueable(stop):
            return
        dupes, _ = self.cluster(stop)
        if not dupes:
            self.notify("no duplicates in the open set; nothing to resolve.")
            return

        def close_next(remaining: list[int]) -> None:
            if not remaining:
                self.notify("cluster resolved; recheck linked issues by hand.")
                return
            dup, rest = remaining[0], remaining[1:]
            body_file = os.path.join(os.path.dirname(TRACE_PATH), f"superseded-{dup}.md")
            with open(body_file, "w", encoding="utf-8") as sink:
                sink.write(
                    f"Superseded by #{stop.number}, which is queued for Hive "
                    "auto-merge. Closing as a duplicate; the surviving change "
                    "lands there.\n"
                )
            dup_stop = Stop(stop.repository, dup, "close", "duplicate")
            self.mutate_all(
                dup_stop,
                [
                    [
                        "gh", "pr", "comment", str(dup),
                        "--repo", stop.repository, "--body-file", body_file,
                    ],
                    ["gh", "pr", "close", str(dup), "--repo", stop.repository],
                ],
                then=lambda: close_next(rest),
            )

        os.makedirs(os.path.dirname(TRACE_PATH), exist_ok=True)
        self._queue_automerge(stop, then=lambda: close_next(dupes))


def main() -> None:
    parser = argparse.ArgumentParser(
        prog="review-queue",
        description="The Bluefin maintainer review dashboard.",
    )
    parser.add_argument(
        "--action",
        default="",
        help="only this recommended_action (default: every action)",
    )
    parser.add_argument(
        "--all",
        action="store_true",
        help="every action (the default; kept so existing commands still work)",
    )
    parser.add_argument(
        "--repo",
        default="",
        help="only this repository (short name or owner/repo)",
    )
    parser.add_argument("--url", default=QUEUE_URL, help="read the queue from elsewhere")
    args = parser.parse_args()
    filters = QueueFilters(
        action="" if args.all else args.action,
        repository=args.repo,
        url=args.url,
    )
    ReviewDashboard(filters).run()


if __name__ == "__main__":
    main()
