"""Pure semantic view models for the maintainer review dashboard."""

from __future__ import annotations

from dataclasses import dataclass
from enum import Enum
import re
from types import MappingProxyType
from typing import Any, Mapping

from review_result import ReviewResult


_SHA = re.compile(r"^[0-9a-f]{40}$")


class ActionID(str, Enum):
    RUN_REVIEW = "run-review"
    STEER_REVIEW = "steer-review"
    STOP_REVIEW = "stop-review"
    LEAVE_REVIEW = "leave-review"
    APPROVE_AND_QUEUE = "approve-and-queue"
    MERGE_NOW = "merge-now"
    UPDATE_BRANCH = "update-branch"
    REJECT = "reject"
    COMMENT = "comment"
    VIEW_DIFF = "view-diff"
    TOGGLE_EVIDENCE = "toggle-evidence"
    BATCH_SELECT = "batch-select"
    FILTER_QUEUE = "filter-queue"
    REFRESH = "refresh"
    HANDOFF = "handoff"
    OPEN_BROWSER = "open-browser"
    ASK_HIVE = "ask-hive"
    UPDATE_DOCS = "update-docs"
    GHOST_BUILD = "ghost-build"
    RESOLVE_DUPLICATES = "resolve-duplicates"
    CLOSE_LAYER = "close-layer"
    QUIT = "quit"


@dataclass(frozen=True)
class ActionSpec:
    label: str
    mutating: bool = False
    confirmation_required: bool = False
    ordinary_journey: bool = True


_ACTION_SPECS = (
    (ActionID.RUN_REVIEW, ActionSpec("Run review")),
    (ActionID.STEER_REVIEW, ActionSpec("Steer review")),
    (ActionID.STOP_REVIEW, ActionSpec("Stop review")),
    (ActionID.LEAVE_REVIEW, ActionSpec("Leave a review", True, True)),
    (ActionID.APPROVE_AND_QUEUE, ActionSpec("Approve and queue", True, True)),
    (ActionID.MERGE_NOW, ActionSpec("Merge now", True, True)),
    (ActionID.UPDATE_BRANCH, ActionSpec("Update branch", True, True)),
    (ActionID.REJECT, ActionSpec("Reject", True, True)),
    (ActionID.COMMENT, ActionSpec("Comment", True, True)),
    (ActionID.VIEW_DIFF, ActionSpec("View diff")),
    (ActionID.TOGGLE_EVIDENCE, ActionSpec("Toggle evidence")),
    (ActionID.BATCH_SELECT, ActionSpec("Batch select")),
    (ActionID.FILTER_QUEUE, ActionSpec("Filter queue")),
    (ActionID.REFRESH, ActionSpec("Refresh")),
    (ActionID.HANDOFF, ActionSpec("Copy handoff")),
    (ActionID.OPEN_BROWSER, ActionSpec("Open in browser", ordinary_journey=False)),
    (ActionID.ASK_HIVE, ActionSpec("Ask Hive")),
    (ActionID.UPDATE_DOCS, ActionSpec("Update docs")),
    (ActionID.GHOST_BUILD, ActionSpec("Ghost build")),
    (ActionID.RESOLVE_DUPLICATES, ActionSpec("Resolve duplicates", True, True)),
    (ActionID.CLOSE_LAYER, ActionSpec("Close")),
    (ActionID.QUIT, ActionSpec("Quit")),
)

ACTIONS: Mapping[ActionID, ActionSpec] = MappingProxyType(dict(_ACTION_SPECS))


class DecisionState(str, Enum):
    READY = "ready"
    RUNNING = "running"
    CLEAN = "clean"
    FINDINGS = "findings"
    STALE = "stale"
    INCOMPLETE = "incomplete"
    FAILED = "failed"
    UNPARSABLE = "unparsable"
    CANCELLED = "cancelled"


@dataclass(frozen=True)
class SemanticStatus:
    value: str
    label: str


@dataclass(frozen=True)
class QueueRow:
    repository: str
    number: int
    title: str
    author: str
    exact_head: str | None
    mergeability: SemanticStatus
    ci: SemanticStatus
    review: SemanticStatus
    primary_action: ActionID | None

    @property
    def identity(self) -> str:
        return f"{self.repository}#{self.number}"


@dataclass(frozen=True)
class FindingView:
    severity: str
    title: str
    file: str
    line: int
    end_line: int | None = None


@dataclass(frozen=True)
class VerificationView:
    name: str
    state: str
    evidence: str


@dataclass(frozen=True)
class ProvenanceView:
    backend: str
    model: str
    provider: str = ""
    effort: str = ""


@dataclass(frozen=True)
class DecisionCard:
    state: DecisionState
    exact_head: str | None
    counts: Mapping[str, int]
    findings: tuple[FindingView, ...]
    verification: tuple[VerificationView, ...]
    provenance: ProvenanceView
    raw_evidence: tuple[str, ...]

    @property
    def clean(self) -> bool:
        return self.state is DecisionState.CLEAN


_MERGEABILITY = {
    "clean": SemanticStatus("clean", "MERGEABLE"),
    "dirty": SemanticStatus("dirty", "CONFLICTS"),
    "blocked": SemanticStatus("blocked", "BLOCKED"),
    "unstable": SemanticStatus("unstable", "UNSTABLE"),
}
_CI = {
    "success": SemanticStatus("success", "CI GREEN"),
    "failure": SemanticStatus("failure", "CI FAILED"),
    "pending": SemanticStatus("pending", "CI PENDING"),
}
_REVIEW = {
    "approved": SemanticStatus("approved", "APPROVED"),
    "changes_requested": SemanticStatus("changes_requested", "CHANGES REQUESTED"),
    "review_required": SemanticStatus("review_required", "REVIEW REQUIRED"),
}
_PRIMARY_ACTION = {
    "review": ActionID.RUN_REVIEW,
    "approve": ActionID.LEAVE_REVIEW,
    "queue": ActionID.APPROVE_AND_QUEUE,
    "merge": ActionID.MERGE_NOW,
    "update": ActionID.UPDATE_BRANCH,
}
_DECISION_STATES = {
    "complete": DecisionState.CLEAN,
    "findings": DecisionState.FINDINGS,
    "incomplete": DecisionState.INCOMPLETE,
    "failed": DecisionState.FAILED,
    "unparsable": DecisionState.UNPARSABLE,
}


def _exact_head(value: Any) -> str | None:
    return value if isinstance(value, str) and _SHA.fullmatch(value) else None


def build_queue_row(snapshot: Mapping[str, Any]) -> QueueRow:
    """Build immutable queue meaning from an existing queue snapshot."""

    repository = snapshot.get("repository")
    number = snapshot.get("number")
    title = snapshot.get("title")
    author = snapshot.get("author")
    if (
        not isinstance(repository, str)
        or not repository
        or not isinstance(number, int)
        or isinstance(number, bool)
        or number < 1
        or not isinstance(title, str)
        or not isinstance(author, str)
    ):
        raise ValueError("queue identity fields are invalid")
    mergeability = _MERGEABILITY.get(
        snapshot.get("mergeable_state"), SemanticStatus("unknown", "MERGEABILITY UNKNOWN")
    )
    ci = _CI.get(snapshot.get("check_state"), SemanticStatus("unknown", "CI UNKNOWN"))
    review = _REVIEW.get(
        snapshot.get("review_state"), SemanticStatus("unknown", "REVIEW UNKNOWN")
    )
    return QueueRow(
        repository,
        number,
        title,
        author,
        _exact_head(snapshot.get("head_sha")),
        mergeability,
        ci,
        review,
        _PRIMARY_ACTION.get(snapshot.get("recommended_action")),
    )


def build_decision_card(result: ReviewResult, *, exact_head: str) -> DecisionCard:
    """Build terminal decision meaning without adding mutation authority."""

    state = _DECISION_STATES.get(result.state, DecisionState.UNPARSABLE)
    findings = tuple(
        FindingView(
            item["severity"],
            item["title"],
            item["file"],
            item["line"],
            item.get("end_line"),
        )
        for item in result.findings
    )
    verification = tuple(
        VerificationView(item["name"], item["state"], item["evidence"])
        for item in result.verification
    )
    provenance = ProvenanceView(
        str(result.provenance.get("backend", "")),
        str(result.provenance.get("model", "")),
        str(result.provenance.get("provider", "")),
        str(result.provenance.get("effort", "")),
    )
    return DecisionCard(
        state,
        _exact_head(exact_head),
        MappingProxyType(dict(result.counts)),
        findings,
        verification,
        provenance,
        tuple(result.raw_evidence),
    )


__all__ = [
    "ACTIONS",
    "ActionID",
    "ActionSpec",
    "DecisionCard",
    "DecisionState",
    "FindingView",
    "ProvenanceView",
    "QueueRow",
    "SemanticStatus",
    "VerificationView",
    "build_decision_card",
    "build_queue_row",
]
