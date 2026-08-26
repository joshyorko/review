"""Executable contract for the ReviewRun state machine."""

from __future__ import annotations

import sys
from hashlib import sha256
from pathlib import Path

# The harness and tui modules expect `image/` on the path.
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "image"))
from tui.review_evidence_manifest import ReviewRequest  # noqa: E402
from tui.review_result import ReviewResult  # noqa: E402
from tui.review_run import (  # noqa: E402
    ReviewRun,
    ReviewRunController,
    ReviewRunError,
    ReviewRunState,
    RunCheckpoint,
    StepAction,
)
from harness.registry import HarnessCapabilities  # noqa: E402

FAILURES: list[str] = []


def check(condition: bool, message: str) -> None:
    if not condition:
        FAILURES.append(message)


def make_request(owner="projectbluefin", repository="bluefin", number=42,
                 base="0" * 40, head="a" * 40) -> ReviewRequest:
    return ReviewRequest(owner, repository, number, base, head,
                         actor="maintainer", tenant="review", generated_at="dashboard")


def make_run(request=None) -> ReviewRun:
    request = request or make_request()
    return ReviewRun.from_request(request, backend="goose", model="gpt-5.6-luna", effort="high")


class FakeHarness:
    name = "goose"
    availability = "READY"
    capabilities = HarnessCapabilities(
        invocation=True, streaming=True, cancellation=True,
        resumable=False, checkpoint=False, yieldable=False,
    )


class FakeRegistry:
    def get(self, name):
        return FakeHarness()
    def names(self):
        return ("goose",)


def identity() -> None:
    """ReviewRun identity is deterministic and unique per binding."""
    r1 = make_run()
    r2 = make_run(make_request(number=99))
    check(r1.identity != r2.identity, "different runs must have different identities")
    r1b = make_run()
    check(r1.identity == r1b.identity, "same binding must produce the same identity")
    check(len(r1.identity) == 64, "identity must be a 64-character SHA-256 hex digest")
    assert sha256(b"").hexdigest() and all(c in "0123456789abcdef" for c in r1.identity), (
        "identity must be lowercase hex"
    )
    print(f"  identity: {r1.identity}")


def states() -> None:
    """All required states exist and have the correct string values."""
    expected = {
        "pending", "running", "yielded", "waiting-external",
        "resumable", "stale", "complete", "failed", "cancelled",
    }
    observed = {s.value for s in ReviewRunState}
    check(observed == expected,
          f"state values mismatch: {observed ^ expected}")
    terminal = {s for s in ReviewRunState if s.terminal}
    check(terminal == {ReviewRunState.COMPLETE, ReviewRunState.FAILED,
                        ReviewRunState.CANCELLED, ReviewRunState.STALE},
          f"unexpected terminal states: {terminal}")
    print(f"  states: {', '.join(sorted(observed))}")
    print(f"  terminal: {', '.join(s.value for s in terminal)}")


def start_transition() -> None:
    """PENDING -> RUNNING is the only valid start."""
    controller = ReviewRunController(run=make_run(), harness=FakeHarness(), registry=FakeRegistry())
    result = controller.start()
    check(controller.state is ReviewRunState.RUNNING,
          f"start must produce RUNNING, got {controller.state.value}")
    check(result.state is ReviewRunState.RUNNING,
          f"step result must report RUNNING, got {result.state.value}")
    check(result.next_action == StepAction.WAIT.value,
          f"start must suggest WAIT, got {result.next_action}")
    print("  PENDING -> RUNNING: OK")


def complete_transition() -> None:
    """RUNNING -> COMPLETE is the normal terminal path."""
    controller = ReviewRunController(run=make_run(), harness=FakeHarness(), registry=FakeRegistry())
    controller.start()
    result = ReviewResult(1, "complete", {"critical": 0, "high": 0, "medium": 0, "low": 0})
    step = controller.complete(result)
    check(controller.state is ReviewRunState.COMPLETE,
          f"complete must transition to COMPLETE, got {controller.state.value}")
    check(step.terminal_result is result,
          "terminal result must be the same ReviewResult")
    check(step.next_action == StepAction.DONE.value,
          "complete must suggest DONE")
    check(controller.terminal_result() is result,
          "controller must retain the terminal result")
    print("  RUNNING -> COMPLETE: OK")


def fail_transition() -> None:
    """RUNNING -> FAILED is the error path."""
    controller = ReviewRunController(run=make_run(), harness=FakeHarness(), registry=FakeRegistry())
    controller.start()
    step = controller.fail("provider unavailable")
    check(controller.state is ReviewRunState.FAILED,
          f"fail must transition to FAILED, got {controller.state.value}")
    check(step.yield_reason == "provider unavailable",
          "fail must carry the error reason")
    print("  RUNNING -> FAILED: OK")


def cancel_transition() -> None:
    """RUNNING -> CANCELLED is the user-initiated stop."""
    controller = ReviewRunController(run=make_run(), harness=FakeHarness(), registry=FakeRegistry())
    controller.start()
    step = controller.cancel()
    check(controller.state is ReviewRunState.CANCELLED,
          f"cancel must transition to CANCELLED, got {controller.state.value}")
    check(step.next_action == StepAction.DONE.value,
          "cancel must suggest DONE")
    try:
        controller.cancel()
        check(False, "cancelling a terminal state must raise ReviewRunError")
    except ReviewRunError:
        pass
    print("  RUNNING -> CANCELLED: OK")


def stale_transition() -> None:
    """YIELDED/RESUMABLE -> STALE is the head-changed path."""
    controller = ReviewRunController(run=make_run(), harness=FakeHarness(), registry=FakeRegistry())
    controller.start()
    controller.mark_yielded()
    step = controller.stale()
    check(controller.state is ReviewRunState.STALE,
          f"stale must transition to STALE, got {controller.state.value}")
    check(step.next_action == StepAction.DONE.value,
          "stale must suggest DONE")
    try:
        controller.resume()
        check(False, "resuming a stale run must raise ReviewRunError")
    except ReviewRunError:
        pass
    print("  YIELDED -> STALE: OK")


def yield_then_checkpoint() -> None:
    """YIELDED -> RESUMABLE with checkpoint is the yield-then-resume path."""
    controller = ReviewRunController(run=make_run(), harness=FakeHarness(), registry=FakeRegistry())
    controller.start()
    step = controller.mark_yielded("rate limit hit")
    check(controller.state is ReviewRunState.YIELDED,
          f"yield must transition to YIELDED, got {controller.state.value}")
    check(step.yield_reason == "rate limit hit", "yield reason must be preserved")
    cp = RunCheckpoint('{"step": 3, "files": ["a.py"]}')
    step = controller.checkpoint_ready(cp)
    check(controller.state is ReviewRunState.RESUMABLE,
          f"checkpoint must transition to RESUMABLE, got {controller.state.value}")
    check(step.checkpoint is cp, "checkpoint must be preserved")
    step = controller.resume(cp)
    check(controller.state is ReviewRunState.RUNNING,
          f"resume must transition to RUNNING, got {controller.state.value}")
    print("  YIELDED -> RESUMABLE -> RUNNING: OK")


def waiting_external() -> None:
    """RUNNING -> WAITING_EXTERNAL -> RESUMABLE is the external-event path."""
    controller = ReviewRunController(run=make_run(), harness=FakeHarness(), registry=FakeRegistry())
    controller.start()
    step = controller.mark_waiting_external()
    check(controller.state is ReviewRunState.WAITING_EXTERNAL,
          f"must transition to WAITING_EXTERNAL, got {controller.state.value}")
    check(step.next_action == StepAction.WAIT_FOR_EVENT.value,
          "must suggest WAIT_FOR_EVENT")
    step = controller.external_event_received()
    check(controller.state is ReviewRunState.RESUMABLE,
          f"event received must transition to RESUMABLE, got {controller.state.value}")
    print("  WAITING_EXTERNAL -> RESUMABLE: OK")


def invalid_transitions() -> None:
    """Invalid transitions must raise ReviewRunError."""
    controller = ReviewRunController(run=make_run(), harness=FakeHarness(), registry=FakeRegistry())
    try:
        controller.complete(ReviewResult(1, "complete", {s: 0 for s in ("critical", "high", "medium", "low")}))
        check(False, "complete from PENDING must raise ReviewRunError")
    except ReviewRunError:
        pass
    try:
        controller.resume()
        check(False, "resume from PENDING must raise ReviewRunError")
    except ReviewRunError:
        pass
    try:
        controller.stale()
        check(False, "stale from PENDING must raise ReviewRunError")
    except ReviewRunError:
        pass
    print("  invalid transitions rejected: OK")


def checkpoint_encoding() -> None:
    """RunCheckpoint round-trips through encode/decode."""
    original = RunCheckpoint('{"step": 3, "check": "main"}')
    encoded = original.encode()
    decoded = RunCheckpoint.decode(encoded)
    check(decoded.data == original.data,
          "checkpoint must round-trip through encode/decode")
    print("  checkpoint encode/decode: OK")


def main() -> int:
    print("review_run contract: RUNNING")
    identity()
    states()
    start_transition()
    complete_transition()
    fail_transition()
    cancel_transition()
    stale_transition()
    yield_then_checkpoint()
    waiting_external()
    invalid_transitions()
    checkpoint_encoding()
    if FAILURES:
        print(f"\nFAILURES ({len(FAILURES)}):")
        for f in FAILURES:
            print(f"  ✗ {f}")
        return 1
    print("\nreview_run contract: PASS")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())