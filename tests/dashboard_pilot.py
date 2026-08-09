"""Pilot tests: drive the real dashboard and assert what it does.

These run the Textual app through ``run_test()``, so a binding that points at
nothing, a screen that never reaches a terminal state, and a review whose
outcome is misreported are all failures here. The previous contract was a set
of greps over this file's source text, which passed while the dashboard had no
way to review anything at all.

No network and no GitHub: the queue is served from a temp file and the review
engine is replaced by a stub script whose exit status the test chooses.
"""

from __future__ import annotations

import asyncio
import json
import os
import stat
import sys
import time
import tempfile
from pathlib import Path

TUI_DIR = Path(
    os.environ.get(
        "BLUEFIN_REVIEW_TUI_DIR",
        Path(__file__).resolve().parent.parent / "image" / "tui",
    )
)
sys.path.insert(0, str(TUI_DIR))

SNAPSHOT = {
    "generated_at": "2026-08-08T00:00:00Z",
    "items": [
        {
            "repository": "projectbluefin/bluefinctl",
            "number": 31,
            "recommended_action": "review",
            "title": "fix: ci.yml add permissions block",
            "author": "someone-else",
        },
        {
            "repository": "projectbluefin/common",
            "number": 7,
            "recommended_action": "merge",
            "title": "chore: bump digest",
            "author": "someone-else",
        },
        {
            "repository": "projectbluefin/review",
            "number": 9,
            "recommended_action": "review",
            "title": "my own work",
            "author": "castrojo",
        },
    ],
}

failures: list[str] = []
checks = 0


def check(condition: bool, description: str) -> None:
    global checks
    checks += 1
    if not condition:
        failures.append(description)


def write_stub(path: Path, body: str) -> str:
    path.write_text("#!/usr/bin/env bash\n" + body)
    path.chmod(path.stat().st_mode | stat.S_IEXEC)
    return str(path)


async def main() -> int:
    workdir = Path(tempfile.mkdtemp(prefix="dashboard-pilot."))

    queue_file = workdir / "queue.json"
    queue_file.write_text(json.dumps(SNAPSHOT))

    # gh is read-only here: the pilot never lets a mutation reach a real
    # network, and any attempt to run one is recorded for the assertions.
    gh_log = workdir / "gh.log"
    gh_stub = write_stub(
        workdir / "gh",
        f'printf "%s\\n" "$*" >>"{gh_log}"\n'
        'if [ "$1 $2" = "api user" ]; then echo castrojo; exit 0; fi\n'
        'if [ "$1 $2" = "pr view" ]; then echo "{}"; exit 0; fi\n'
        'if [ "$1 $2" = "pr list" ]; then echo "[]"; exit 0; fi\n'
        "exit 0\n",
    )
    os.environ["PATH"] = f"{workdir}:{os.environ['PATH']}"
    os.environ["XDG_STATE_HOME"] = str(workdir / "state")
    os.environ["BLUEFIN_REVIEW_QUEUE_URL"] = queue_file.as_uri()

    review_log = workdir / "review.log"

    def review_stub(exit_code: int, output: str) -> str:
        return write_stub(
            workdir / "bluefin-review",
            f'printf "%s\\n" "$*" >>"{review_log}"\n'
            f'printf "%s\\n" "{output}"\n'
            f"exit {exit_code}\n",
        )

    os.environ["BLUEFIN_REVIEW_COMMAND"] = str(workdir / "bluefin-review")
    review_stub(0, "a finding")

    import bluefin_review_tui as tui

    # ── the queue loads, filters own work, and honours the action filter ──
    app = tui.ReviewDashboard(tui.QueueFilters(url=queue_file.as_uri()))
    async with app.run_test() as pilot:
        await pilot.pause()
        for _ in range(200):
            if app.stops:
                break
            await pilot.pause(0.05)
        keys = [stop.key for stop in app.stops]
        check(
            keys == ["projectbluefin/bluefinctl#31"],
            f"action filter + own-work filter should leave one stop, got {keys}",
        )

    # --all keeps every action; own work stays filtered out regardless.
    app = tui.ReviewDashboard(tui.QueueFilters(action="", url=queue_file.as_uri()))
    async with app.run_test() as pilot:
        await pilot.pause()
        for _ in range(200):
            if app.stops:
                break
            await pilot.pause(0.05)
        check(len(app.stops) == 2, f"--all should keep both other-authored stops, got {len(app.stops)}")
        check(
            all(stop.author != "castrojo" for stop in app.stops),
            "own work must never appear in the queue",
        )

    # --repo narrows to one repository.
    app = tui.ReviewDashboard(
        tui.QueueFilters(action="", repository="common", url=queue_file.as_uri())
    )
    async with app.run_test() as pilot:
        await pilot.pause()
        for _ in range(200):
            if app.stops:
                break
            await pilot.pause(0.05)
        check(
            [s.key for s in app.stops] == ["projectbluefin/common#7"],
            "--repo should accept a short repository name",
        )

    # ── every binding resolves to a real action ──────────────────────────
    app = tui.ReviewDashboard(tui.QueueFilters(url=queue_file.as_uri()))
    async with app.run_test() as pilot:
        await pilot.pause()
        for binding in tui.ReviewDashboard.BINDINGS:
            name = f"action_{binding.action.split('(')[0]}"
            check(
                hasattr(app, name) or hasattr(tui.App, name),
                f"binding {binding.key!r} points at missing {name}",
            )
        review = [b for b in tui.ReviewDashboard.BINDINGS if b.action == "review"]
        check(len(review) == 1, f"exactly one binding must run a review, got {len(review)}")
        check(
            bool(review) and review[0].key == "r",
            f"review must be on 'r', got {[b.key for b in review]}",
        )

    async def run_review(exit_code: int, output: str):
        review_stub(exit_code, output)
        app = tui.ReviewDashboard(tui.QueueFilters(url=queue_file.as_uri()))
        async with app.run_test() as pilot:
            await pilot.pause()
            for _ in range(200):
                if app.stops:
                    break
                await pilot.pause(0.05)
            await pilot.press("r")
            await pilot.pause()
            screen = app.screen
            if not isinstance(screen, tui.ReviewScreen):
                check(False, f"'r' must open the review screen, got {type(screen).__name__}")
                return "", set()
            for _ in range(400):
                if screen.finished:
                    break
                await pilot.pause(0.05)
            check(screen.finished, f"review screen never finished (exit {exit_code})")
            status = screen.query_one("#review-status", tui.Static)
            return str(status.render()), set(status.classes)

    # ── a completed review reports complete ──────────────────────────────
    text, classes = await run_review(0, "0 findings")
    check("COMPLETE" in text, f"exit 0 must report COMPLETE, got {text!r}")
    check("complete" in classes, f"exit 0 must carry the complete style, got {classes}")
    check(
        "projectbluefin/bluefinctl#31" in text,
        "the review status must name the pull request under review",
    )
    invocations = review_log.read_text().strip().splitlines() if review_log.exists() else []
    check(
        invocations[-1:] == ["pr projectbluefin/bluefinctl 31"],
        f"the review must call 'pr <repo> <number>', got {invocations[-1:]}",
    )

    # ── the regression that started this: a review whose checks returned no
    # verdict must never read as clean ───────────────────────────────────
    text, classes = await run_review(65, "goose review: orchestrator emitted 0 finding(s)")
    check("INCOMPLETE" in text, f"exit 65 must report INCOMPLETE, got {text!r}")
    check("incomplete" in classes, f"exit 65 must carry the incomplete style, got {classes}")
    check(
        "COMPLETE" not in text.replace("INCOMPLETE", ""),
        "an incomplete review must not also claim to be complete",
    )
    check(
        "not a clean bill of health" in text.lower() or "NOT a clean" in text,
        f"an incomplete review must say the finding count is not clean, got {text!r}",
    )

    # ── a failed review is a failure, not an empty result ────────────────
    text, classes = await run_review(3, "boom")
    check("FAILED" in text, f"a nonzero exit must report FAILED, got {text!r}")
    check("failed" in classes, f"a failed review must carry the failed style, got {classes}")

    # ── [x] actually stops a review ──────────────────────────────────────
    # The engine is a shell that runs Goose, which runs a subprocess per check.
    # Signalling only the shell leaves those children alive holding the pipe
    # open, and the screen would wait on them forever. This stub reproduces
    # that shape: a grandchild that survives its parent and ignores SIGTERM.
    marker = workdir / "grandchild-alive"
    write_stub(
        workdir / "bluefin-review",
        f'printf "%s\\n" "$*" >>"{review_log}"\n'
        "echo starting\n"
        f'( trap "" TERM; touch "{marker}"; sleep 60; rm -f "{marker}" ) &\n'
        'trap "" TERM\n'
        "wait\n",
    )
    app = tui.ReviewDashboard(tui.QueueFilters(url=queue_file.as_uri()))
    async with app.run_test() as pilot:
        await pilot.pause()
        for _ in range(200):
            if app.stops:
                break
            await pilot.pause(0.05)
        await pilot.press("r")
        await pilot.pause()
        screen = app.screen
        if not isinstance(screen, tui.ReviewScreen):
            check(False, "'r' must open the review screen for the stop test")
        else:
            for _ in range(200):
                if marker.exists():
                    break
                await pilot.pause(0.05)
            check(marker.exists(), "the stop-test stub never started its grandchild")
            tui.STOP_GRACE_SECONDS = 0.2
            await pilot.press("x")
            deadline = time.monotonic() + 30
            while not screen.finished and time.monotonic() < deadline:
                await pilot.pause(0.05)
            check(screen.finished, "[x] must end a review that ignores SIGTERM")
            status = screen.query_one("#review-status", tui.Static)
            check(
                "STOPPED" in str(status.render()),
                f"a stopped review must report STOPPED, got {str(status.render())!r}",
            )
            check(
                "COMPLETE" not in str(status.render()),
                "a stopped review must never report COMPLETE",
            )

    # ── the review path never mutates GitHub ─────────────────────────────
    calls = gh_log.read_text().splitlines() if gh_log.exists() else []
    mutations = [
        call
        for call in calls
        if any(
            call.startswith(verb)
            for verb in ("pr merge", "pr close", "pr comment", "pr edit", "pr review")
        )
    ]
    check(not mutations, f"reviewing must not mutate GitHub, saw: {mutations}")

    # ── the review is traced for the feedback loop ───────────────────────
    trace_file = Path(tui.TRACE_PATH)
    records = (
        [json.loads(line) for line in trace_file.read_text().splitlines() if line.strip()]
        if trace_file.exists()
        else []
    )
    outcomes = [r["outcome"] for r in records if r.get("action") == "review"]
    check(
        outcomes == ["complete", "incomplete", "failed", "stopped"],
        f"every review must be traced with its outcome, got {outcomes}",
    )

    for failure in failures:
        print(f"FAIL: {failure}", file=sys.stderr)
    print(f"dashboard pilot: {checks - len(failures)}/{checks} checks passed")
    return 1 if failures else 0


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
