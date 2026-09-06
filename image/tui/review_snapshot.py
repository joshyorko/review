from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Any, Callable, Mapping, Sequence, TYPE_CHECKING

from tui.review_evidence_manifest import ReviewRequest

if TYPE_CHECKING:
    from tui.bluefin_review_tui import Stop

FULL_SHA = re.compile(r"[0-9a-f]{40}\Z")


class BatchSnapshotError(ValueError):
    pass


@dataclass(frozen=True)
class BatchReviewItem:
    key: str
    repository: str
    number: int
    title: str
    base_sha: str
    head_sha: str
    live: dict[str, Any]
    verification: list[dict[str, Any]]

    def request(self, actor: str = "maintainer", tenant: str = "review") -> ReviewRequest:
        owner, repository = self.repository.split("/", 1)
        return ReviewRequest(
            owner,
            repository,
            self.number,
            self.base_sha,
            self.head_sha,
            actor,
            tenant,
            generated_at="batch-snapshot",
        )


@dataclass(frozen=True)
class BatchSnapshot:
    items: tuple[BatchReviewItem, ...]
    failures: dict[str, str]

    @property
    def ready(self) -> bool:
        return not self.failures and bool(self.items)


def _required_sha(live: Mapping[str, Any], field: str) -> str:
    value = live.get(field)
    if not isinstance(value, str) or not FULL_SHA.fullmatch(value):
        raise BatchSnapshotError(f"{field} must be a full lowercase SHA")
    return value


def _verification(live: Mapping[str, Any]) -> list[dict[str, str]]:
    records = []
    passed = {"SUCCESS", "NEUTRAL", "SKIPPED"}
    failed = {"FAILURE", "ERROR", "TIMED_OUT", "CANCELLED", "ACTION_REQUIRED"}
    checks = live.get("statusCheckRollup") or []
    for index, item in enumerate(checks, start=1):
        if not isinstance(item, Mapping):
            continue
        outcome = str(item.get("conclusion") or item.get("state") or "PENDING").upper()
        state = "verified" if outcome in passed else "unverified" if outcome in failed else "pending"
        records.append({
            "name": str(item.get("name") or item.get("context") or f"CI check {index}"),
            "state": state,
            "evidence": outcome,
            "source": "github",
        })
    return records


def hydrate_batch_snapshot(
    stops: Sequence[Stop],
    fetch_live: Callable[[str, int], Mapping[str, Any]],
) -> BatchSnapshot:
    items: list[BatchReviewItem] = []
    failures: dict[str, str] = {}
    for stop in stops:
        key = stop.key
        try:
            live = dict(fetch_live(stop.repository, stop.number))
            base_sha = _required_sha(live, "baseRefOid")
            head_sha = _required_sha(live, "headRefOid")
            items.append(
                BatchReviewItem(
                    key,
                    stop.repository,
                    stop.number,
                    str(live.get("title") or stop.title),
                    base_sha,
                    head_sha,
                    live,
                    _verification(live),
                )
            )
        except (BatchSnapshotError, KeyError, TypeError, ValueError, RuntimeError) as error:
            failures[key] = str(error)
    return BatchSnapshot(tuple(items), failures)
