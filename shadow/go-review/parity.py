"""Run the shadow fixture suite against the recorded Python contract."""

from __future__ import annotations

import hashlib
import json
import sys
from pathlib import Path
from typing import Any

ROOT = Path(__file__).parents[2]
BASELINE_COMMIT = "6748294e476cc7ba836771b92565f0b09082a33e"
BASELINE_SOURCE = ROOT / "image" / "tui" / "review_result.py"
BASELINE_SOURCE_BLOB = "fe5574a3b6a6d14bedc37febc8d68a27cbc50b86"


def verify_baseline_source() -> None:
    source = BASELINE_SOURCE.read_bytes()
    blob = f"blob {len(source)}\0".encode() + source
    actual = hashlib.sha1(blob, usedforsecurity=False).hexdigest()
    if actual != BASELINE_SOURCE_BLOB:
        raise RuntimeError(
            f"baseline source changed: {BASELINE_SOURCE} has {actual}, "
            f"want {BASELINE_SOURCE_BLOB} from {BASELINE_COMMIT}"
        )


verify_baseline_source()
sys.path.insert(0, str(BASELINE_SOURCE.parent))
from review_result import MAX_RAW_CHARS, parse_review_result  # noqa: E402


FIXTURES = Path(__file__).parent / "testdata" / "review-result-cases.json"


def fixture_payload(payload: Any) -> str:
    if isinstance(payload, str):
        return payload
    return json.dumps(payload, sort_keys=True, separators=(",", ":"), ensure_ascii=False)


def canonical_result(result: Any) -> dict[str, Any]:
    return json.loads(result.to_json())


def check_fixtures() -> tuple[int, int]:
    cases = json.loads(FIXTURES.read_text())
    round_trip_count = 0
    for case in cases:
        result = parse_review_result(fixture_payload(case["payload"]))
        expected = case["expected"]
        actual_shape = canonical_result(result)
        if result.state != expected["state"]:
            raise AssertionError(
                f'{case["name"]}: state={result.state!r}, want {expected["state"]!r}'
            )
        if result.is_clean != expected["is_clean"]:
            raise AssertionError(
                f'{case["name"]}: is_clean={result.is_clean!r}, want {expected["is_clean"]!r}'
            )
        if actual_shape != expected["result"]:
            raise AssertionError(
                f'{case["name"]}: serialized result differs\n'
                f"actual={json.dumps(actual_shape, sort_keys=True)}\n"
                f'expected={json.dumps(expected["result"], sort_keys=True)}'
            )
        if result.state != "unparsable":
            round_trip = parse_review_result(result.to_json())
            if canonical_result(round_trip) != actual_shape:
                raise AssertionError(f'{case["name"]}: round-trip result differs')
            round_trip_count += 1
    return len(cases), round_trip_count


def check_boundary_payloads() -> tuple[int, int]:
    clean_payload = json.dumps(
        {
            "counts": {"critical": 0, "high": 0, "low": 0, "medium": 0},
            "findings": [],
            "state": "complete",
            "version": 1,
        },
        sort_keys=True,
        separators=(",", ":"),
    )
    cases = {
        "deep JSON": "[" * 2_000 + "]" * 2_000,
        "oversized JSON": "x" * (MAX_RAW_CHARS + 1),
        "trailing JSON": clean_payload + " {}",
    }
    for name, payload in cases.items():
        result = parse_review_result(payload)
        if result.state != "unparsable" or result.is_clean:
            raise AssertionError(f"{name} was accepted as clean")
    oversized = parse_review_result(cases["oversized JSON"])
    if len(oversized.raw_evidence) != 1 or len(oversized.raw_evidence[0]) != MAX_RAW_CHARS:
        raise AssertionError("oversized input did not retain bounded raw evidence")

    truncated_prefixes = 0
    for end in range(len(clean_payload)):
        if parse_review_result(clean_payload[:end]).is_clean:
            raise AssertionError(f"truncated clean payload became clean at byte {end}")
        truncated_prefixes += 1
    return len(cases), truncated_prefixes


def main() -> None:
    fixture_count, round_trip_count = check_fixtures()
    boundary_count, truncated_count = check_boundary_payloads()
    print(
        "Python ReviewResult parity: "
        f"baseline {BASELINE_COMMIT}, "
        f"{fixture_count} fixture cases, {round_trip_count} round-trip cases, "
        f"{boundary_count} boundary cases, and {truncated_count} truncated prefixes passed"
    )


if __name__ == "__main__":
    main()
