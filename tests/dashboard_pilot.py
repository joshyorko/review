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
import subprocess
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
    perm_file = workdir / "permissions.push"
    perm_file.write_text("true\n")
    gh_stub = write_stub(
        workdir / "gh",
        f'printf "%s\\n" "$*" >>"{gh_log}"\n'
        'if [ "$1 $2" = "api user" ]; then echo castrojo; exit 0; fi\n'
        f'case "$1 $2" in "api repos/"*) cat "{perm_file}"; exit 0 ;; esac\n'
        'if [ "$1 $2" = "pr view" ]; then echo "{}"; exit 0; fi\n'
        'if [ "$1 $2" = "pr diff" ]; then\n'
        '  printf "%s\\n" "diff --git a/x b/x" "--- a/x" "+++ b/x" "@@ -1 +1 @@" "-old" "+new"\n'
        "  exit 0\n"
        "fi\n"
        'if [ "$1 $2" = "pr list" ]; then echo "[]"; exit 0; fi\n'
        "exit 0\n",
    )
    os.environ["PATH"] = f"{workdir}:{os.environ['PATH']}"
    os.environ["XDG_STATE_HOME"] = str(workdir / "state")
    os.environ["BLUEFIN_REVIEW_QUEUE_URL"] = queue_file.as_uri()

    review_log = workdir / "review.log"
    steer_log = workdir / "steer.log"

    def review_stub(exit_code: int, output: str) -> str:
        return write_stub(
            workdir / "bluefin-review",
            f'printf "%s\\n" "$*" >>"{review_log}"\n'
            f'printf "%s\\n" "${{BLUEFIN_REVIEW_STEER-}}" >>"{steer_log}"\n'
            f'printf "%s\\n" "{output}"\n'
            f"exit {exit_code}\n",
        )

    os.environ["BLUEFIN_REVIEW_COMMAND"] = str(workdir / "bluefin-review")
    review_stub(0, "a finding")

    import bluefin_review_tui as tui

    # ── the default view hides nothing ───────────────────────────────────
    # The regression this pins: the dashboard defaulted to the 'review'
    # action, so a 121-pull-request queue rendered as five stops and the
    # merge-ready work was invisible. Default is now the whole queue, ordered
    # so what a maintainer can act on comes first.
    app = tui.ReviewDashboard(tui.QueueFilters(url=queue_file.as_uri()))
    async with app.run_test() as pilot:
        await pilot.pause()
        for _ in range(200):
            if app.stops:
                break
            await pilot.pause(0.05)
        keys = [stop.key for stop in app.stops]
        check(
            keys == ["projectbluefin/bluefinctl#31", "projectbluefin/common#7"],
            f"the default view must show every action, got {keys}",
        )
        check(
            tui.QueueFilters().action == "",
            "the default action filter must be empty (every action)",
        )
        check(
            tui.action_rank("ready-for-human-merge") < tui.action_rank("review")
            < tui.action_rank("fix-ci")
            < tui.action_rank("investigate"),
            "merge-ready and reviewable work must sort above stuck work",
        )
        # [f] narrows to one action at a time and comes back to everything.
        await pilot.press("f")
        await pilot.pause()
        check(
            app.filters.action == "review"
            and [s.key for s in app.stops] == ["projectbluefin/bluefinctl#31"],
            f"[f] must narrow to one action, got {app.filters.action!r} "
            f"{[s.key for s in app.stops]}",
        )
        for _ in range(6):
            if app.filters.action == "":
                break
            await pilot.press("f")
            await pilot.pause()
        check(
            app.filters.action == "" and len(app.stops) == 2,
            "[f] must cycle back to every action",
        )

    # ── an explicit action filter still narrows ──────────────────────────
    app = tui.ReviewDashboard(
        tui.QueueFilters(action="review", url=queue_file.as_uri())
    )
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

    # ── batch queueing must gate each PR once, for the whole sequence ────
    app = tui.ReviewDashboard(tui.QueueFilters(action="", url=queue_file.as_uri()))
    async with app.run_test() as pilot:
        await pilot.pause()
        for _ in range(200):
            if len(app.stops) == 2:
                break
            await pilot.pause(0.05)
        app.self_login = "castrojo"
        for stop in app.stops:
            stop.selected = True
            stop.live = {"isDraft": False}
        app.action_merge()
        await pilot.pause()

        def confirmations():
            return [
                screen
                for screen in app.screen_stack
                if isinstance(screen, tui.ConfirmMutation)
            ]

        gates = confirmations()
        check(
            len(gates) == 1,
            f"batch queueing must show one confirmation at a time, got {len(gates)}",
        )
        if len(gates) == 1:
            seen = []
            for _ in range(4):
                for _ in range(200):
                    if isinstance(app.screen, tui.ConfirmMutation):
                        break
                    await pilot.pause(0.05)
                if not isinstance(app.screen, tui.ConfirmMutation):
                    break
                gate = app.screen
                expected = gate.expected
                seen.append(
                    (expected, tuple(tuple(c[:3]) for c in gate.commands))
                )
                # type the number as a maintainer does; setting .value
                # directly would hide an unfocused, unusable gate
                await pilot.press(*expected)
                check(
                    gate.query_one(tui.Input).value == expected,
                    "confirmation gate must accept typed keystrokes",
                )
                await pilot.press("enter")
                for _ in range(200):
                    if app.screen is not gate:
                        break
                    await pilot.pause(0.05)
            numbers = [number for number, _ in seen]
            commands = [command for _, command in seen]
            check(
                len(seen) == 2
                and numbers[0] != numbers[1]
                and commands
                == [(("gh", "pr", "review"), ("gh", "pr", "edit"))] * 2,
                "queueing must gate each PR exactly once, for the approval "
                f"and the lgtm label together, got {seen}",
            )
            check(
                not confirmations(),
                "batch queueing must return to the dashboard after all gates",
            )
            for _ in range(200):
                ran = [
                    tuple(line.split()[:2])
                    for line in gh_log.read_text().splitlines()
                    if tuple(line.split()[:2]) in {("pr", "review"), ("pr", "edit")}
                ]
                if len(ran) >= 4:
                    break
                await pilot.pause(0.05)
            check(
                ran == [("pr", "review"), ("pr", "edit")] * 2,
                f"both queueing commands must run after the one gate, got {ran}",
            )
    gh_log.write_text("")

    # ── merging without lgtm is a maintainer power ───────────────────────
    # lgtm is an opt-in to Hive's automation, not a toll on merging: a
    # maintainer can land a pull request directly. Someone without the push
    # permission cannot, and must be told so rather than shown a gate.
    for allowed in (False, True):
        perm_file.write_text("true\n" if allowed else "false\n")
        app = tui.ReviewDashboard(tui.QueueFilters(action="", url=queue_file.as_uri()))
        async with app.run_test() as pilot:
            await pilot.pause()
            for _ in range(200):
                if app.stops:
                    break
                await pilot.pause(0.05)
            stop = app.stops[0]
            for _ in range(200):
                if stop.repository in app.merge_rights:
                    break
                await pilot.pause(0.05)
            check(
                app.merge_rights.get(stop.repository) is allowed,
                "the merge permission must be read from GitHub, got "
                f"{app.merge_rights.get(stop.repository)!r} for push={allowed}",
            )
            stop.live = {"isDraft": False}
            gh_log.write_text("")
            await pilot.press("m")
            await pilot.pause()
            gated = isinstance(app.screen, tui.ConfirmMutation)
            check(
                gated is allowed,
                "merging directly must be gated for a maintainer and refused "
                f"otherwise; push={allowed} produced gate={gated}",
            )
            if not allowed:
                check(
                    "pr merge" not in gh_log.read_text(),
                    "a non-maintainer must not reach 'gh pr merge'",
                )
                continue
            gate = app.screen
            check(
                [c[:3] for c in gate.commands] == [["gh", "pr", "merge"]],
                f"[m] must merge directly, got {gate.commands}",
            )
            check(
                "--squash" in gate.commands[0],
                f"the direct merge must squash, got {gate.commands[0]}",
            )
            check(
                "--admin" not in gate.commands[0]
                and "--delete-branch" not in gate.commands[0],
                f"the direct merge must not bypass or delete, got {gate.commands[0]}",
            )
            await pilot.press(*gate.expected)
            await pilot.press("enter")
            for _ in range(200):
                if "pr merge" in gh_log.read_text():
                    break
                await pilot.pause(0.05)
            merged = [
                line for line in gh_log.read_text().splitlines()
                if line.startswith("pr merge")
            ]
            check(
                len(merged) == 1 and "--squash" in merged[0],
                f"the confirmed merge must run exactly once, got {merged}",
            )
            check(
                "--add-label lgtm" not in gh_log.read_text(),
                "merging directly must not apply the lgtm automation opt-in",
            )
    perm_file.write_text("true\n")
    gh_log.write_text("")

    # ── asking Hive is easy, read-only, and never fatal ──────────────────
    # The status line used to say "Hive: not consulted" permanently, which is
    # a dashboard that never asked. It asks now, and a stop Hive is actively
    # working on says so — the diff on screen is about to be stale.
    hive_calls = workdir / "hive.log"

    class FakeHive:
        def __init__(self, status, contributors):
            self.status = status
            self.contributors = contributors

        def __call__(self, path):
            with open(hive_calls, "a") as sink:
                sink.write(path + "\n")
            return self.status if path.endswith("status") else self.contributors

    real_hive_get = tui.hive_get
    real_base = tui.hive_api_base
    tui.hive_api_base = lambda: "https://hub.example"
    tui.hive_get = FakeHive(
        {"hub": "online", "actionable_items": 185},
        {
            "contributors": [
                {
                    "github_username": "someone-else",
                    "current_task": {
                        "task_id": "ct-1",
                        "repo": "projectbluefin/bluefinctl",
                        "number": 31,
                    },
                },
                {"github_username": "idle", "current_task": None},
            ]
        },
    )
    try:
        app = tui.ReviewDashboard(tui.QueueFilters(url=queue_file.as_uri()))
        async with app.run_test() as pilot:
            await pilot.pause()
            for _ in range(200):
                if app.hive_state and app.stops:
                    break
                await pilot.pause(0.05)
            check(
                "online" in app.hive_state and "185 actionable" in app.hive_state,
                f"the status line must report what Hive said, got {app.hive_state!r}",
            )
            check(
                "not consulted" not in str(
                    app.query_one("#status-bar", tui.Static).render()
                ),
                "the dashboard must not claim Hive is unconsulted after asking",
            )
            check(
                len(app.hive_workers) == 1,
                f"only in-flight tasks count as working, got {app.hive_workers}",
            )
            stop = app.stops[0]
            worker = app.hive_worker_for(stop)
            check(
                worker is not None and worker["login"] == "someone-else",
                f"a stop Hive is working on must be identified, got {worker}",
            )
            check(
                app.hive_worker_for(app.stops[1]) is None,
                "a stop nobody is working on must not claim a worker",
            )
            for _ in range(200):
                if "is working on THIS" in str(
                    app.query_one("#context", tui.Static).render()
                ):
                    break
                await pilot.pause(0.05)
            check(
                "is working on THIS" in str(
                    app.query_one("#context", tui.Static).render()
                ),
                "the context pane must warn that Hive is changing this PR now",
            )
            check(
                {"/api/v1/status", "/api/v1/contributors"}
                <= set(hive_calls.read_text().split()),
                f"asking Hive must read status and contributors, got "
                f"{hive_calls.read_text().split()}",
            )
            # Read-only: consulting Hive must never mutate GitHub or Hive.
            check(
                "pr merge" not in gh_log.read_text()
                and "pr review" not in gh_log.read_text(),
                "consulting Hive must not mutate anything",
            )

        # An unreachable hub degrades to a plain statement, never a crash.
        tui.hive_get = lambda path: {}
        app = tui.ReviewDashboard(tui.QueueFilters(url=queue_file.as_uri()))
        async with app.run_test() as pilot:
            await pilot.pause()
            for _ in range(200):
                if app.hive_state:
                    break
                await pilot.pause(0.05)
            check(
                app.hive_state == "unreachable",
                f"an unreachable hub must say so, got {app.hive_state!r}",
            )
            check(app.stops, "an unreachable hub must not empty the queue")

        # No hub configured at all is its own honest answer.
        tui.hive_api_base = lambda: ""
        app = tui.ReviewDashboard(tui.QueueFilters(url=queue_file.as_uri()))
        async with app.run_test() as pilot:
            await pilot.pause()
            for _ in range(200):
                if app.hive_state:
                    break
                await pilot.pause(0.05)
            check(
                app.hive_state == "not configured",
                f"no hub must read as not configured, got {app.hive_state!r}",
            )
    finally:
        tui.hive_get = real_hive_get
        tui.hive_api_base = real_base
    gh_log.write_text("")

    # ── the diff is coloured, scrollable, and whole ──────────────────────
    # It used to be plain text pasted into the evidence pane and cut at 20 000
    # characters with no sign it had been cut.
    app = tui.ReviewDashboard(tui.QueueFilters(url=queue_file.as_uri()))
    async with app.run_test() as pilot:
        await pilot.pause()
        for _ in range(200):
            if app.stops:
                break
            await pilot.pause(0.05)
        await pilot.press("v")
        await pilot.pause()
        screen = app.screen
        check(
            isinstance(screen, tui.DiffScreen),
            f"'v' must open the diff screen, got {type(screen).__name__}",
        )
        if isinstance(screen, tui.DiffScreen):
            for _ in range(200):
                if screen.rendered is not None:
                    break
                await pilot.pause(0.05)
            check(
                isinstance(screen.rendered, tui.Syntax),
                f"the diff must be syntax-highlighted, got {type(screen.rendered)}",
            )
            check(
                getattr(getattr(screen.rendered, "lexer", None), "name", "") == "Diff",
                "the diff must use Pygments' diff lexer, so +/- are coloured",
            )
            check(
                "+new" in getattr(screen.rendered, "code", ""),
                "the diff screen must show the diff it fetched",
            )
            check(
                screen.query("#diff-scroll"),
                "the diff must live in a scrollable container",
            )
            # Truncation, when it happens, must say so.
            screen.render_diff("x" * (tui.DiffScreen.MAX_CHARS + 10))
            await pilot.pause()
            check(
                "truncated at" in getattr(screen.rendered, "code", ""),
                "a cut diff must say it was cut, and how big it really is",
            )
            await pilot.press("escape")
            await pilot.pause()
            check(
                not isinstance(app.screen, tui.DiffScreen),
                "escape must close the diff screen",
            )
        check(
            "pr diff" in gh_log.read_text(),
            "the diff screen must actually fetch the diff",
        )
    gh_log.write_text("")

    # ── the gate is always escapable ─────────────────────────────────────
    app = tui.ReviewDashboard(tui.QueueFilters(action="", url=queue_file.as_uri()))
    async with app.run_test() as pilot:
        await pilot.pause()
        for _ in range(200):
            if app.stops:
                break
            await pilot.pause(0.05)
        app.self_login = "castrojo"
        app.stops[0].live = {"isDraft": False}
        app.action_merge()
        await pilot.pause()
        check(
            isinstance(app.screen, tui.ConfirmMutation),
            "queueing a PR must open the confirmation gate",
        )
        await pilot.press("escape")
        for _ in range(200):
            if not isinstance(app.screen, tui.ConfirmMutation):
                break
            await pilot.pause(0.05)
        check(
            not isinstance(app.screen, tui.ConfirmMutation),
            "escape must abort the confirmation gate",
        )
    gh_log.write_text("")

    # ── a slow mutation must not freeze the dashboard ────────────────────
    app = tui.ReviewDashboard(tui.QueueFilters(action="", url=queue_file.as_uri()))
    real_run = subprocess.run

    def slow_run(*args, **kwargs):
        command = args[0] if args else kwargs.get("args")
        if (
            isinstance(command, (list, tuple))
            and len(command) > 2
            and command[1] == "pr"
            and command[2] in {"review", "edit"}
        ):
            time.sleep(2)
            return subprocess.CompletedProcess(command, 0, "", "")
        return real_run(*args, **kwargs)

    subprocess.run = slow_run
    try:
        async with app.run_test() as pilot:
            await pilot.pause()
            for _ in range(200):
                if app.stops:
                    break
                await pilot.pause(0.05)
            app.self_login = "castrojo"
            app.stops[0].live = {"isDraft": False}
            app.action_merge()
            await pilot.pause()
            expected = app.screen.expected
            await pilot.press(*expected)
            loop = asyncio.get_running_loop()
            start = loop.time()
            ticks = []

            async def heartbeat():
                while loop.time() - start < 3:
                    ticks.append(loop.time() - start)
                    await asyncio.sleep(0.1)

            beat = asyncio.create_task(heartbeat())
            await pilot.press("enter")
            await asyncio.sleep(3)
            beat.cancel()
            gaps = [b - a for a, b in zip(ticks, ticks[1:])]
            check(
                bool(gaps) and max(gaps) < 1,
                "a slow gh mutation must run off the UI thread, "
                f"but the event loop stalled {max(gaps) if gaps else 0:.2f}s",
            )
    finally:
        subprocess.run = real_run
    gh_log.write_text("")

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

    # ── the steer box: typed text reaches the review as instructions ─────
    review_stub(0, "0 findings")
    steer_log.write_text("")
    app = tui.ReviewDashboard(tui.QueueFilters(url=queue_file.as_uri()))
    async with app.run_test() as pilot:
        await pilot.pause()
        for _ in range(200):
            if app.stops:
                break
            await pilot.pause(0.05)
        await pilot.press("slash")
        await pilot.pause()
        box = app.query_one("#steer", tui.Input)
        check(app.focused is box, "'/' must focus the steer box")
        await pilot.press("c", "i")
        check(box.value == "ci", f"the steer box must take keystrokes, got {box.value!r}")
        await pilot.press("enter")
        await pilot.pause()
        screen = app.screen
        if not isinstance(screen, tui.ReviewScreen):
            check(False, f"steering must open a review, got {type(screen).__name__}")
        else:
            check(screen.steer == "ci", f"the review must carry the steer, got {screen.steer!r}")
            for _ in range(400):
                if screen.finished:
                    break
                await pilot.pause(0.05)
            check(screen.finished, "the steered review never finished")
            check(
                steer_log.read_text().splitlines()[-1:] == ["ci"],
                "the steer must reach the review engine as "
                f"BLUEFIN_REVIEW_STEER, got {steer_log.read_text()!r}",
            )
        check(
            app.query_one("#steer", tui.Input).value == "",
            "the steer box must clear after it is submitted",
        )

    # ── an unsteered review must not inherit a stale steer ───────────────
    steer_log.write_text("")
    await run_review(0, "0 findings")
    check(
        steer_log.read_text().splitlines()[-1:] == [""],
        f"an unsteered review must carry no steer, got {steer_log.read_text()!r}",
    )

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
        outcomes == [
            "complete", "incomplete", "failed", "complete", "complete", "stopped"
        ],
        f"every review must be traced with its outcome, got {outcomes}",
    )

    for failure in failures:
        print(f"FAIL: {failure}", file=sys.stderr)
    print(f"dashboard pilot: {checks - len(failures)}/{checks} checks passed")
    return 1 if failures else 0


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
