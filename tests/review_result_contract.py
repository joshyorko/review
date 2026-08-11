import json
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parents[1] / "image" / "tui"))

from review_result import ReviewResult, adapt_current_engine, parse_review_result

FIXTURES = Path(__file__).parent / "fixtures"


def fixture(name):
    return (FIXTURES / name).read_text()


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
            "provenance": {"backend": "goose", "model": "gpt-5.6-luna"},
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

    def test_incomplete_and_unparsable_never_become_clean(self):
        for state in ("incomplete", "unparsable", "failed"):
            result = ReviewResult.from_dict({"version": 1, "state": state})
            self.assertNotEqual(result.state, "complete")
            self.assertFalse(result.is_clean)

    def test_malformed_input_is_explicit_unparsable_with_raw_evidence(self):
        result = parse_review_result("not json", raw_evidence="not json")
        self.assertEqual(result.state, "unparsable")
        self.assertEqual(result.raw_evidence, ["not json"])

    def test_current_engine_adapter_parses_real_jsonl_findings_and_checks(self):
        output = fixture("goose-review-findings.txt")
        result = adapt_current_engine(output, 0, {"backend": "goose", "model": "m"})
        self.assertEqual(result.state, "findings")
        self.assertEqual(result.counts["high"], 1)
        self.assertEqual(result.counts["medium"], 1)
        self.assertEqual(result.findings[0]["file"], "image/entrypoint.sh")
        self.assertEqual(result.findings[0]["line"], 87)
        self.assertEqual(result.verification[0]["name"], "bluefin-doctrine")
        self.assertEqual(result.verification[0]["state"], "verified")
        self.assertEqual(result.provenance["model"], "m")
        self.assertEqual(result.raw_evidence, output.splitlines())

    def test_current_engine_adapter_requires_structured_clean_summary(self):
        self.assertTrue(adapt_current_engine(fixture("goose-review-clean.txt"), 0).is_clean)
        result = adapt_current_engine("0 findings", 0)
        self.assertEqual(result.state, "unparsable")
        self.assertFalse(result.is_clean)

    def test_current_engine_adapter_keeps_failed_check_incomplete(self):
        result = adapt_current_engine(fixture("goose-review-incomplete.txt"), 65)
        self.assertEqual(result.state, "incomplete")
        self.assertIn("unverified", {item["state"] for item in result.verification})

    def test_nonzero_engine_exit_is_failed_even_when_output_mentions_zero(self):
        result = adapt_current_engine("0 finding(s)", 2)
        self.assertEqual(result.state, "failed")
        self.assertFalse(result.is_clean)


if __name__ == "__main__":
    unittest.main()
