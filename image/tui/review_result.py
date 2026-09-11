"""Backend-neutral, versioned result contract for the maintainer cockpit."""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from typing import Any

SEVERITIES = ("critical", "high", "medium", "low")
STATES = ("complete", "findings", "incomplete", "failed", "unparsable")
MAX_RAW_LINES = 400
MAX_RAW_CHARS = 120_000
VERIFICATION_STATES = ("verified", "unverified", "skipped")


def _raw_lines(value: str | list[str] | None) -> list[str]:
    if value is None:
        return []
    if isinstance(value, str):
        return value.splitlines()
    if not isinstance(value, list) or any(not isinstance(line, str) for line in value):
        raise ValueError("raw evidence must be text or a list of text lines")
    return value


def _raw(value: str | list[str] | None) -> list[str]:
    lines = _raw_lines(value)
    text = "\n".join(str(line) for line in lines)
    return text[:MAX_RAW_CHARS].splitlines()[:MAX_RAW_LINES]


def _raw_truncated(value: str | list[str] | None) -> bool:
    lines = _raw_lines(value)
    return len(lines) > MAX_RAW_LINES or len("\n".join(lines)) > MAX_RAW_CHARS


def _text(value: Any) -> bool:
    return isinstance(value, str) and bool(value.strip())


def _integer(value: Any) -> bool:
    return isinstance(value, int) and not isinstance(value, bool)


def _unparsable(raw_evidence: Any, payload: Any) -> "ReviewResult":
    try:
        evidence = _raw(raw_evidence if raw_evidence is not None else payload)
    except (TypeError, ValueError):
        try:
            evidence = _raw(payload)
        except (TypeError, ValueError):
            evidence = []
    return ReviewResult(1, "unparsable", raw_evidence=evidence)


@dataclass(frozen=True)
class ReviewResult:
    version: int
    state: str
    counts: dict[str, int] = field(default_factory=lambda: {s: 0 for s in SEVERITIES})
    findings: list[dict[str, Any]] = field(default_factory=list)
    verification: list[dict[str, Any]] = field(default_factory=list)
    provenance: dict[str, Any] = field(default_factory=dict)
    overlap: dict[str, Any] = field(default_factory=dict)
    live: dict[str, Any] = field(default_factory=dict)
    raw_evidence: list[str] = field(default_factory=list)

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "ReviewResult":
        if not isinstance(data, dict) or "counts" not in data or "findings" not in data:
            return cls(1, "unparsable")
        try:
            version = data["version"]
        except (KeyError, TypeError):
            return cls(1, "unparsable")
        state = data.get("state")
        if not _integer(version) or not isinstance(state, str):
            return cls(1, "unparsable")
        if version != 1 or state not in STATES:
            state = "unparsable"
        raw_counts = data["counts"]
        raw_findings = data["findings"]
        if not isinstance(raw_counts, dict) or not isinstance(raw_findings, list):
            return cls(1, "unparsable")
        if set(raw_counts) != set(SEVERITIES):
            return cls(1, "unparsable")
        try:
            counts = {severity: raw_counts.get(severity, 0) for severity in SEVERITIES}
        except (TypeError, ValueError):
            return cls(1, "unparsable")
        if any(not _integer(value) or value < 0 for value in counts.values()):
            return cls(1, "unparsable")
        findings = list(raw_findings)
        observed = {severity: 0 for severity in SEVERITIES}
        for finding in findings:
            if (
                not isinstance(finding, dict)
                or finding.get("severity") not in SEVERITIES
                or not _text(finding.get("file"))
                or not _integer(finding.get("line"))
                or finding["line"] < 1
                or not _text(finding.get("title"))
                or ("end_line" in finding and (
                    not _integer(finding["end_line"]) or finding["end_line"] < finding["line"]
                ))
            ):
                return cls(1, "unparsable")
            observed[finding["severity"]] += 1
        if counts != observed:
            state = "unparsable"
        if state == "complete" and findings:
            state = "findings"
        verification = data["verification"] if "verification" in data else []
        provenance = data["provenance"] if "provenance" in data else {}
        overlap = data["overlap"] if "overlap" in data else {}
        live = data["live"] if "live" in data else {}
        if (
            not isinstance(verification, list)
            or not isinstance(provenance, dict)
            or not isinstance(overlap, dict)
            or not isinstance(live, dict)
        ):
            return cls(1, "unparsable")
        if any(
            not isinstance(item, dict)
            or not _text(item.get("name"))
            or item.get("state") not in VERIFICATION_STATES
            or not _text(item.get("evidence"))
            for item in verification
        ):
            return cls(1, "unparsable")
        if state == "complete" and any(item["state"] == "unverified" for item in verification):
            state = "incomplete"
        if provenance and (
            not _text(provenance.get("backend")) or not _text(provenance.get("model"))
        ):
            return cls(1, "unparsable")
        if overlap and (
            not isinstance(overlap.get("duplicates"), list)
            or not isinstance(overlap.get("shared_files"), list)
            or any(not _integer(item) for item in overlap["duplicates"])
            or any(not _text(item) for item in overlap["shared_files"])
        ):
            return cls(1, "unparsable")
        try:
            raw_evidence = _raw(data.get("raw_evidence"))
        except (TypeError, ValueError):
            return cls(1, "unparsable")
        return cls(
            version,
            state,
            counts,
            findings,
            list(verification),
            dict(provenance),
            dict(overlap),
            dict(live),
            raw_evidence,
        )

    @property
    def is_clean(self) -> bool:
        return self.state == "complete" and not any(self.counts.values()) and not self.findings

    def to_dict(self) -> dict[str, Any]:
        return {
            "version": self.version,
            "state": self.state,
            "counts": self.counts,
            "findings": self.findings,
            "verification": self.verification,
            "provenance": self.provenance,
            "overlap": self.overlap,
            "live": self.live,
            "raw_evidence": self.raw_evidence,
        }

    def to_json(self) -> str:
        return json.dumps(self.to_dict(), sort_keys=True, separators=(",", ":"))


def parse_review_result(payload: str, raw_evidence: str | list[str] | None = None) -> ReviewResult:
    if not isinstance(payload, str) or len(payload) > MAX_RAW_CHARS:
        return _unparsable(raw_evidence, payload)
    try:
        value = json.loads(payload)
        if not isinstance(value, dict):
            raise ValueError("result is not an object")
        result = ReviewResult.from_dict(value)
        if result.state == "unparsable":
            return _unparsable(raw_evidence, payload)
        return result
    except (TypeError, ValueError, json.JSONDecodeError, RecursionError):
        return _unparsable(raw_evidence, payload)
