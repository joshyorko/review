import json
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parents[1] / "image"))

from tui.review_result import MAX_RAW_CHARS, ReviewResult, parse_review_result


class ReviewResultContractTests(unittest.TestCase):
    def test_round_trip_preserves_versioned_evidence_contract(self):
        result = ReviewResult.from_dict({
            "version": 1,
            "state": "findings",
            "counts": {"critical": 0, "high": 1, "medium": 2, "low": 0},
            "findings": [
                {"severity": "high", "title": "unsafe path", "file": "x.py", "line": 7},
                {"severity": "medium", "title": "missing test", "file": "test_x.py", "line": 9},
                {"severity": "medium", "title": "weak assertion", "file": "test_x.py", "line": 12},
            ],
            "verification": [{"name": "unit", "state": "verified", "evidence": "pytest"}],
            "provenance": {"backend": "omp", "model": "gpt-5.6-luna"},
            "overlap": {"duplicates": [12], "shared_files": ["x.py"]},
            "live": {"ci": "failure", "mergeable": "MERGEABLE"},
            "raw_evidence": ["check output"],
        })
        encoded = json.loads(result.to_json())
        self.assertEqual(encoded["version"], 1)
        self.assertEqual(encoded["counts"]["high"], 1)
        self.assertEqual(encoded["findings"][0]["file"], "x.py")
        self.assertEqual(encoded["live"]["ci"], "failure")
        self.assertEqual(parse_review_result(result.to_json()).state, "findings")

    def test_malformed_or_inconsistent_contract_is_unparsable(self):
        malformed = ReviewResult.from_dict({"version": "not-a-version", "state": "complete"})
        self.assertEqual(malformed.state, "unparsable")
        inconsistent = ReviewResult.from_dict({
            "version": 1,
            "state": "findings",
            "counts": {"critical": 0, "high": 0, "medium": 0, "low": 0},
            "findings": [{"severity": "high", "file": "x.py", "line": 7, "title": "x"}],
        })
        self.assertEqual(inconsistent.state, "unparsable")

    def test_malformed_nested_evidence_is_unparsable(self):
        base = {
            "version": 1,
            "state": "findings",
            "counts": {"critical": 0, "high": 1, "medium": 0, "low": 0},
            "findings": [{"severity": "high", "title": "x", "file": "x.py", "line": 7}],
            "verification": [{"name": "unit", "state": "verified", "evidence": "pytest"}],
            "provenance": {"backend": "omp", "model": "m"},
            "overlap": {"duplicates": [], "shared_files": []},
        }
        for finding in (
            {"severity": "high", "title": "x", "line": 7},
            {"severity": "high", "title": "x", "file": "x.py", "line": "7"},
        ):
            payload = {**base, "findings": [finding]}
            self.assertEqual(ReviewResult.from_dict(payload).state, "unparsable")
        invalid_verification = {**base, "verification": [{"name": "unit", "state": "maybe", "evidence": "x"}]}
        self.assertEqual(ReviewResult.from_dict(invalid_verification).state, "unparsable")
        incomplete_provenance = {**base, "provenance": {"backend": "omp"}}
        self.assertEqual(ReviewResult.from_dict(incomplete_provenance).state, "unparsable")
        incomplete_overlap = {**base, "overlap": {"duplicates": []}}
        self.assertEqual(ReviewResult.from_dict(incomplete_overlap).state, "unparsable")

    def test_counts_and_findings_are_required_typed_fields(self):
        for field in ("counts", "findings"):
            for value in (None, False):
                payload = {"version": 1, "state": "complete", "counts": {}, "findings": []}
                payload[field] = value
                self.assertEqual(ReviewResult.from_dict(payload).state, "unparsable")
            payload = {"version": 1, "state": "complete", "counts": {}, "findings": []}
            payload.pop(field)
            self.assertEqual(ReviewResult.from_dict(payload).state, "unparsable")

    def test_malformed_raw_evidence_is_unparsable(self):
        payload = {
            "version": 1,
            "state": "complete",
            "counts": {"critical": 0, "high": 0, "medium": 0, "low": 0},
            "findings": [],
        }
        for value in ({"line": 1}, 7, ["ok", {"line": 1}]):
            self.assertEqual(ReviewResult.from_dict({**payload, "raw_evidence": value}).state, "unparsable")
            self.assertEqual(parse_review_result(json.dumps({**payload, "raw_evidence": value})).state, "unparsable")
        self.assertEqual(parse_review_result("not json", raw_evidence={"line": 1}).state, "unparsable")

    def test_present_falsey_optional_fields_are_not_defaults(self):
        payload = {
            "version": 1,
            "state": "complete",
            "counts": {"critical": 0, "high": 0, "medium": 0, "low": 0},
            "findings": [],
        }
        for field, value in (("verification", {}), ("provenance", []), ("overlap", [])):
            self.assertEqual(ReviewResult.from_dict({**payload, field: value}).state, "unparsable")

    def test_complete_with_unverified_check_is_not_clean(self):
        result = ReviewResult.from_dict({
            "version": 1,
            "state": "complete",
            "counts": {"critical": 0, "high": 0, "medium": 0, "low": 0},
            "findings": [],
            "verification": [{"name": "unit", "state": "unverified", "evidence": "failed"}],
        })
        self.assertEqual(result.state, "incomplete")
        self.assertFalse(result.is_clean)

    def test_oversized_and_deep_structured_payloads_are_unparsable(self):
        oversized = json.dumps({"version": 1, "state": "complete", "counts": {"critical": 0, "high": 0, "medium": 0, "low": 0}, "findings": [], "raw_evidence": ["x" * MAX_RAW_CHARS]})
        self.assertEqual(parse_review_result(oversized).state, "unparsable")
        deep = "[" * 2000 + "]" * 2000
        self.assertEqual(parse_review_result(deep).state, "unparsable")

    def test_incomplete_and_unparsable_never_become_clean(self):
        for state in ("incomplete", "unparsable", "failed"):
            result = ReviewResult.from_dict({"version": 1, "state": state})
            self.assertNotEqual(result.state, "complete")
            self.assertFalse(result.is_clean)

    def test_malformed_input_is_explicit_unparsable_with_raw_evidence(self):
        result = parse_review_result("not json", raw_evidence="not json")
        self.assertEqual(result.state, "unparsable")
        self.assertEqual(result.raw_evidence, ["not json"])


if __name__ == "__main__":
    unittest.main()
