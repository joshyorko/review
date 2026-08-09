"""Bluefin Review Dashboard — the maintainer TUI for the PR queue.

A Textual port of the ``bluefin-review queue`` walk's data layer: the static
queue snapshot orders the walk, GitHub supplies the live evidence, and every
state-changing command runs through exactly one confirmation gate that makes
the maintainer type the pull request number. GitHub stays authoritative for
pull-request state; Hive is never asked for work here.

Runs inside the review image: ``just review-queue dashboard``.
"""

from __future__ import annotations

import json
import os
import re
import subprocess
import time
import urllib.request
from dataclasses import dataclass, field
from datetime import datetime, timezone

from textual import work
from textual.app import App, ComposeResult
from textual.binding import Binding
from textual.containers import Horizontal, Vertical
from textual.screen import ModalScreen
from textual.widgets import Footer, Header, Input, Label, ListItem, ListView, Static

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
PRIORITIES = ["P0-critical", "P1-high", "P2-medium", "P3-low"]
LABEL_CHOICES = ["kind/bug", "kind/improvement", "area/bootc", "status/approved"]

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
    """The single mutation gate: show the exact command, require the typed
    pull request number. Empty or wrong aborts; there is no y/yes and no
    timeout."""

    def __init__(self, command: list[str], expected: str) -> None:
        super().__init__()
        self.command = command
        self.expected = expected

    def compose(self) -> ComposeResult:
        with Vertical(id="confirm-box"):
            yield Label("will run:", id="confirm-heading")
            yield Static(" ".join(self.command), id="confirm-command")
            yield Label(
                f"type the pull request number ({self.expected}) to run it; empty aborts"
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
    #confirm-command { color: magenta; text-style: bold; }
    ListItem.selected Label { color: magenta; text-style: bold; }
    """

    BINDINGS = [
        Binding("b", "batch", "batch select"),
        Binding("l", "labels", "labels"),
        Binding("p", "priority", "priority"),
        Binding("d", "docs", "update docs"),
        Binding("r", "ghost_build", "ghost build"),
        Binding("o", "open_browser", "open"),
        Binding("v", "view_diff", "diff"),
        Binding("c", "comment", "comment"),
        Binding("a", "merge", "arm merge"),
        Binding("m", "merge", "arm merge", show=False),
        Binding("x", "reject", "reject"),
        Binding("h", "handoff", "handoff"),
        Binding("M", "resolve_cluster", "resolve dupes", show=False),
        Binding("q", "quit", "quit"),
    ]

    def __init__(self) -> None:
        super().__init__()
        self.stops: list[Stop] = []
        self.self_login = ""
        self.generated_at = ""
        self.pulls_cache: dict[str, list[dict]] = {}

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
        yield Footer()

    def on_mount(self) -> None:
        self.load_queue()

    # ── data layer (walker parity) ────────────────────────────────────────

    @work(thread=True, exclusive=True)
    def load_queue(self) -> None:
        who = gh("api", "user", "--jq", ".login")
        self.self_login = who.stdout.strip() if who.returncode == 0 else ""
        with urllib.request.urlopen(QUEUE_URL, timeout=60) as response:
            snapshot = json.load(response)
        self.generated_at = snapshot.get("generated_at", "")
        stops = [
            Stop(
                repository=item["repository"],
                number=item["number"],
                action=item.get("recommended_action", ""),
                title=item.get("title", ""),
                author=item.get("author", "") or "",
            )
            for item in snapshot.get("items", [])
            # Own-work filtering: a walk reviews other people's work.
            if not (self.self_login and item.get("author") == self.self_login)
        ]
        self.call_from_thread(self.populate, stops)

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
        self.query_one("#status-bar", Static).update(
            f" Queue: {len(self.stops)} PRs | snapshot {freshness} "
            f"| as {self.self_login or 'unknown'} | batch: {selected} "
            f"| Hive: walk mode (not consulted) | Ghost Cluster: {GHOST_BUILD_ISSUE}"
        )

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
        command = ["gh", *args]

        def finish(confirmed: bool | None) -> None:
            if not confirmed:
                self.notify("aborted; nothing was run.", severity="warning")
                return
            result = subprocess.run(command, capture_output=True, text=True)
            trace(
                {
                    "repo": stop.repository,
                    "number": stop.number,
                    "argv": command,
                    "exit": result.returncode,
                }
            )
            self.pulls_cache.pop(stop.repository, None)
            if result.returncode == 0:
                self.notify(f"done: {' '.join(command[:4])}…")
                if then:
                    then()
                self.show_evidence(stop)
            else:
                self.notify(result.stderr.strip()[:200], severity="error")

        self.push_screen(ConfirmMutation(command, str(stop.number)), finish)

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

    def _armable(self, stop: Stop) -> str | None:
        if stop.live.get("isDraft") is True:
            self.notify(f"{stop.key} is a draft; not merging.", severity="warning")
            return None
        head = stop.live.get("headRefOid") or ""
        if not head:
            self.notify(
                "live head commit unknown; not merging without --match-head-commit.",
                severity="warning",
            )
            return None
        return head

    def action_merge(self) -> None:
        batch = [s for s in self.stops if s.selected]
        for stop in batch or ([self.current] if self.current else []):
            if not stop.live:
                self.notify(f"{stop.key}: no live evidence yet; select it first.")
                continue
            head = self._armable(stop)
            if head:
                self.mutate(
                    stop, "pr", "merge", str(stop.number), "--repo", stop.repository,
                    "--squash", "--auto", "--match-head-commit", head,
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
        self.mutate(
            stop, "pr", "comment", str(stop.number),
            "--repo", stop.repository, "--body-file", body_file,
            then=lambda: self.mutate(
                stop, "pr", "close", str(stop.number), "--repo", stop.repository
            ),
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
        head = self._armable(stop)
        if not head:
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
                    f"Superseded by #{stop.number}, which is armed to merge. "
                    "Closing as a duplicate; the surviving change lands there.\n"
                )
            dup_stop = Stop(stop.repository, dup, "close", "duplicate")
            self.mutate(
                dup_stop, "pr", "comment", str(dup),
                "--repo", stop.repository, "--body-file", body_file,
                then=lambda: self.mutate(
                    dup_stop, "pr", "close", str(dup), "--repo", stop.repository,
                    then=lambda: close_next(rest),
                ),
            )

        os.makedirs(os.path.dirname(TRACE_PATH), exist_ok=True)
        self.mutate(
            stop, "pr", "merge", str(stop.number), "--repo", stop.repository,
            "--squash", "--auto", "--match-head-commit", head,
            then=lambda: close_next(dupes),
        )


def main() -> None:
    ReviewDashboard().run()


if __name__ == "__main__":
    main()
