"""Backend-neutral, versioned result contract for the maintainer cockpit."""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from typing import Any

SEVERITIES = ("critical", "high", "medium", "low")
STATES = ("complete", "findings", "incomplete", "failed", "unparsable")
MAX_RAW_LINES = 400
MAX_RAW_CHARS = 120_000


def _raw(value: str | list[str] | None) -> list[str]:
    if value is None:
        return []
    lines = value if isinstance(value, list) else value.splitlines()
    text = "\n".join(str(line) for line in lines)
    return text[:MAX_RAW_CHARS].splitlines()[:MAX_RAW_LINES]


@dataclass(frozen=True)
class ReviewResult:
    version: int
    state: str
    counts: dict[str, int] = field(default_factory=lambda: {s: 0 for s in SEVERITIES})
    findings: list[dict[str, Any]] = field(default_factory=list)
    verification: list[dict[str, Any]] = field(default_factory=list)
    provenance: dict[str, Any] = field(default_factory=dict)
    overlap: dict[str, Any] = field(default_factory=dict)
    raw_evidence: list[str] = field(default_factory=list)

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "ReviewResult":
        version = int(data.get("version", 0))
        state = str(data.get("state", "unparsable"))
        if version != 1 or state not in STATES:
            state = "unparsable"
        counts = {s: max(0, int((data.get("counts") or {}).get(s, 0))) for s in SEVERITIES}
        findings = list(data.get("findings") or [])
        if state == "complete" and findings:
            state = "findings"
        return cls(version, state, counts, findings, list(data.get("verification") or []),
                   dict(data.get("provenance") or {}), dict(data.get("overlap") or {}),
                   _raw(data.get("raw_evidence")))

    @property
    def is_clean(self) -> bool:
        return self.state == "complete" and not any(self.counts.values()) and not self.findings

    def to_dict(self) -> dict[str, Any]:
        return {"version": self.version, "state": self.state, "counts": self.counts,
                "findings": self.findings, "verification": self.verification,
                "provenance": self.provenance, "overlap": self.overlap,
                "raw_evidence": self.raw_evidence}

    def to_json(self) -> str:
        return json.dumps(self.to_dict(), sort_keys=True, separators=(",", ":"))


def parse_review_result(payload: str, raw_evidence: str | list[str] | None = None) -> ReviewResult:
    try:
        value = json.loads(payload)
        if not isinstance(value, dict):
            raise ValueError("result is not an object")
        result = ReviewResult.from_dict(value)
        if result.state == "unparsable":
            return ReviewResult(1, "unparsable", raw_evidence=_raw(raw_evidence or payload))
        return result
    except (TypeError, ValueError, json.JSONDecodeError):
        return ReviewResult(1, "unparsable", raw_evidence=_raw(raw_evidence or payload))
