"""Run the M1 shadow fixtures against the recorded Python ReviewResult contract."""

from __future__ import annotations

import hashlib
import json
import sys
from pathlib import Path
from typing import Any

ROOT = Path(__file__).parents[2]
BASELINE_COMMIT = "6748294e476cc7ba836771b92565f0b09082a33e"
BASELINE_SOURCES = {
    ROOT / "image" / "tui" / "review_result.py": "fe5574a3b6a6d14bedc37febc8d68a27cbc50b86",
}
BASELINE_TEST_SOURCES = {
    ROOT / "tests" / "review_result_contract.py": "c0b7247fab31c2ff8c6010976b64befce64c224b",
}


def verify_baseline_sources() -> None:
    for source_path, expected_blob in {
        **BASELINE_SOURCES,
        **BASELINE_TEST_SOURCES,
    }.items():
        source = source_path.read_bytes()
        blob = f"blob {len(source)}\0".encode() + source
        actual_blob = hashlib.sha1(blob, usedforsecurity=False).hexdigest()
        if actual_blob != expected_blob:
            raise RuntimeError(
                f"baseline source changed: {source_path} has {actual_blob}, "
                f"want {expected_blob} from {BASELINE_COMMIT}"
            )


verify_baseline_sources()
sys.path.insert(0, str(ROOT / "image" / "tui"))
from review_result import MAX_RAW_CHARS, parse_review_result  # noqa: E402

FIXTURES = Path(__file__).parent / "testdata" / "review-result-cases.json"
CANONICAL_FIELDS = {
    "counts",
    "findings",
    "verification",
    "provenance",
    "overlap",
    "live",
    "raw_evidence",
    "state",
    "version",
}


def fixture_payload(payload: Any) -> str:
    if isinstance(payload, str):
        return payload
    return json.dumps(payload, sort_keys=True, separators=(",", ":"), ensure_ascii=False)


def canonical_result(result: Any) -> dict[str, Any]:
    return json.loads(result.to_json())


def check_fixtures() -> tuple[int, int]:
    cases = json.loads(FIXTURES.read_text(encoding="utf-8"))
    round_trip_count = 0
    for case in cases:
        result = parse_review_result(fixture_payload(case["payload"]))
        expected = case["expected"]
        actual_shape = canonical_result(result)
        if set(actual_shape) != CANONICAL_FIELDS:
            raise AssertionError(
                f'{case["name"]}: serialized result fields differ: '
                f"{sorted(actual_shape)}"
            )
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
                f"actual={json.dumps(actual_shape, sort_keys=True, ensure_ascii=False)}\n"
                f'expected={json.dumps(expected["result"], sort_keys=True, ensure_ascii=False)}'
            )
        if result.state != "unparsable":
            round_trip = parse_review_result(result.to_json())
            if canonical_result(round_trip) != actual_shape:
                raise AssertionError(f'{case["name"]}: round-trip result differs')
            if round_trip.is_clean != result.is_clean:
                raise AssertionError(f'{case["name"]}: round-trip clean state differs')
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


def check_numeric_edges() -> int:
    cases = {
        "-0": "complete",
        "0.0": "unparsable",
        "1e0": "unparsable",
        "-0.0": "unparsable",
        "+1": "unparsable",
        "01": "unparsable",
    }
    for token, expected_state in cases.items():
        payload = (
            '{"counts":{"critical":'
            + token
            + ',"high":0,"low":0,"medium":0},"findings":[],"state":"complete","version":1}'
        )
        result = parse_review_result(payload)
        if result.state != expected_state or (
            expected_state == "unparsable" and result.is_clean
        ):
            raise AssertionError(
                f"numeric edge {token!r}: state={result.state!r}, clean={result.is_clean!r}"
            )
    return len(cases)


def check_unicode_line_splitting() -> int:
    separators = (
        "\r\n",
        "\n",
        "\r",
        "\v",
        "\f",
        "\x1c",
        "\x1d",
        "\x1e",
        "\x85",
        "\u2028",
        "\u2029",
    )
    raw = "".join(
        f"line{index}{separator}" for index, separator in enumerate(separators)
    ) + "tail"
    payload = json.dumps(
        {
            "counts": {"critical": 0, "high": 0, "low": 0, "medium": 0},
            "findings": [],
            "raw_evidence": raw,
            "state": "complete",
            "version": 1,
        },
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
    )
    result = parse_review_result(payload)
    expected = [f"line{index}" for index in range(len(separators))] + ["tail"]
    if result.raw_evidence != expected:
        raise AssertionError(
            f"Unicode line splitting = {result.raw_evidence!r}, want {expected!r}"
        )
    return len(separators)


def check_malformed_optional_fields() -> int:
    cases = json.loads(FIXTURES.read_text(encoding="utf-8"))
    malformed = [case for case in cases if case["name"].startswith("malformed-")]
    for case in malformed:
        result = parse_review_result(fixture_payload(case["payload"]))
        if result.state != "unparsable" or result.is_clean:
            raise AssertionError(f'{case["name"]} was accepted as clean')
    return len(malformed)


def main() -> None:
    fixture_count, round_trip_count = check_fixtures()
    boundary_count, truncated_count = check_boundary_payloads()
    numeric_count = check_numeric_edges()
    unicode_count = check_unicode_line_splitting()
    malformed_count = check_malformed_optional_fields()
    print(
        "Python ReviewResult parity: "
        f"baseline {BASELINE_COMMIT}, "
        f"{fixture_count} fixture cases, {round_trip_count} round-trip cases, "
        f"{boundary_count} boundary cases, {truncated_count} truncated prefixes, "
        f"{numeric_count} numeric edge cases, {unicode_count} Unicode line boundaries, "
        f"and {malformed_count} malformed optional cases passed"
    )


if __name__ == "__main__":
    main()
