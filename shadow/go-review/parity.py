"""Run the shadow fixture suite against the recorded Python contract."""

from __future__ import annotations

import json
import sys
from pathlib import Path
from typing import Any

ROOT = Path(__file__).parents[2]
sys.path.insert(0, str(ROOT / "image" / "tui"))

from review_result import MAX_RAW_CHARS, parse_review_result  # noqa: E402


FIXTURES = Path(__file__).parent / "testdata" / "review-result-cases.json"


def fixture_payload(payload: Any) -> str:
    if isinstance(payload, str):
        return payload
    return json.dumps(payload, sort_keys=True, separators=(",", ":"), ensure_ascii=False)


def canonical_result(result: Any) -> dict[str, Any]:
    return json.loads(result.to_json())


def check_fixtures() -> int:
    cases = json.loads(FIXTURES.read_text())
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
    return len(cases)


def check_oversized_payload() -> None:
    result = parse_review_result("x" * (MAX_RAW_CHARS + 1))
    if result.state != "unparsable" or result.is_clean:
        raise AssertionError("oversized input was accepted as clean")
    if len(result.raw_evidence) != 1 or len(result.raw_evidence[0]) != MAX_RAW_CHARS:
        raise AssertionError("oversized input did not retain bounded raw evidence")


def main() -> None:
    count = check_fixtures()
    check_oversized_payload()
    print(f"Python ReviewResult parity: {count} fixture cases and 1 boundary case passed")


if __name__ == "__main__":
    main()
