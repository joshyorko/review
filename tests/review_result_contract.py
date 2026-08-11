import json
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parents[1] / "image" / "tui"))

from review_result import ReviewResult, parse_review_result


class ReviewResultContractTests(unittest.TestCase):
    def test_round_trip_preserves_versioned_evidence_contract(self):
        result = ReviewResult.from_dict({
            "version": 1,
            "state": "findings",
            "counts": {"critical": 0, "high": 1, "medium": 2, "low": 0},
            "findings": [{"severity": "high", "title": "unsafe path", "file": "x.py", "line": 7}],
            "verification": [{"name": "unit", "state": "verified", "evidence": "pytest"}],
            "provenance": {"backend": "goose", "model": "gpt-5.6-luna"},
            "overlap": {"duplicates": [12], "shared_files": ["x.py"]},
            "raw_evidence": ["check output"],
        })
        encoded = json.loads(result.to_json())
        self.assertEqual(encoded["version"], 1)
        self.assertEqual(encoded["counts"]["high"], 1)
        self.assertEqual(encoded["findings"][0]["file"], "x.py")
        self.assertEqual(parse_review_result(result.to_json()).state, "findings")

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
