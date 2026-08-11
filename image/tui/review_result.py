"""Backend-neutral, versioned result contract for the maintainer cockpit."""

from __future__ import annotations

import json
import re
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
    live: dict[str, Any] = field(default_factory=dict)
    raw_evidence: list[str] = field(default_factory=list)

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "ReviewResult":
        try:
            version = int(data.get("version", 0))
        except (TypeError, ValueError):
            return cls(1, "unparsable")
        state = str(data.get("state", "unparsable"))
        if version != 1 or state not in STATES:
            state = "unparsable"
        raw_counts = data.get("counts") or {}
        raw_findings = data.get("findings") or []
        if not isinstance(raw_counts, dict) or not isinstance(raw_findings, list):
            return cls(1, "unparsable")
        try:
            counts = {
                severity: max(0, int(raw_counts.get(severity, 0)))
                for severity in SEVERITIES
            }
        except (TypeError, ValueError):
            return cls(1, "unparsable")
        findings = list(raw_findings)
        observed = {severity: 0 for severity in SEVERITIES}
        for finding in findings:
            if not isinstance(finding, dict) or finding.get("severity") not in SEVERITIES:
                return cls(1, "unparsable")
            observed[finding["severity"]] += 1
        if counts != observed:
            state = "unparsable"
        if state == "complete" and findings:
            state = "findings"
        verification = data.get("verification") or []
        provenance = data.get("provenance") or {}
        overlap = data.get("overlap") or {}
        live = data.get("live") or {}
        if (
            not isinstance(verification, list)
            or not isinstance(provenance, dict)
            or not isinstance(overlap, dict)
            or not isinstance(live, dict)
        ):
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
            _raw(data.get("raw_evidence")),
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


def adapt_current_engine(
    output: str,
    exit_code: int | None,
    provenance: dict[str, Any] | None = None,
    *,
    verification: list[dict[str, Any]] | None = None,
    overlap: dict[str, Any] | None = None,
    live: dict[str, Any] | None = None,
) -> ReviewResult:
    """Adapt Goose's JSONL findings and line-oriented progress records."""
    raw = _raw(output)
    base = dict(provenance or {})
    base.setdefault("engine", "bluefin-review")
    findings: list[dict[str, Any]] = []
    counts = {s: 0 for s in SEVERITIES}
    checks = list(verification or [])
    check_pattern = re.compile(
        r"^goose review: check '([^']+)' (completed|failed):\s*(.*)$"
    )
    summary_pattern = re.compile(
        r"^goose review: orchestrator emitted (\d+) finding\(s\) from (\d+) "
        r"check\(s\) \(main: (ran|skipped), (\d+) finding\(s\)(?:;[^)]*)?\)$"
    )
    summary: re.Match[str] | None = None
    for line in raw:
        check = check_pattern.match(line)
        if check:
            checks.append({
                "name": check.group(1),
                "state": "verified" if check.group(2) == "completed" else "unverified",
                "evidence": check.group(3),
                "source": "engine",
            })
            continue
        matched_summary = summary_pattern.match(line)
        if matched_summary:
            summary = matched_summary
            checks.append({
                "name": "main",
                "state": "verified" if matched_summary.group(3) == "ran" else "skipped",
                "evidence": f"{matched_summary.group(4)} finding(s)",
                "source": "engine",
            })
            continue
        try:
            item = json.loads(line)
        except (TypeError, ValueError, json.JSONDecodeError):
            continue
        if not isinstance(item, dict) or not {
            "severity", "path", "line_start", "summary", "check"
        }.issubset(item):
            continue
        severity = str(item["severity"]).lower()
        if severity not in SEVERITIES:
            severity = "medium"
        counts[severity] += 1
        findings.append({
            "severity": severity,
            "file": str(item["path"]),
            "line": int(item["line_start"]),
            "end_line": int(item.get("line_end", item["line_start"])),
            "title": str(item["summary"]),
            "check": str(item["check"]),
            "evidence": line,
        })

    context = {
        "verification": checks,
        "provenance": base,
        "overlap": dict(overlap or {}),
        "live": dict(live or {}),
        "raw_evidence": raw,
    }
    if exit_code not in (0, None, 65):
        return ReviewResult(1, "failed", **context)
    if exit_code == 65 or any("INCOMPLETE" in line.upper() for line in raw) or any(
        item.get("state") == "unverified" and item.get("source", "engine") == "engine"
        for item in checks
    ):
        return ReviewResult(1, "incomplete", counts=counts, findings=findings, **context)
    if summary is None or int(summary.group(1)) != len(findings):
        return ReviewResult(1, "unparsable", counts=counts, findings=findings, **context)
    return ReviewResult(1, "findings" if findings else "complete", counts=counts,
                        findings=findings, **context)
