# tests/review_receipt_contract.py
import json
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parents[1] / "image"))

from tui.review_evidence_manifest import ReviewRequest
from tui.review_receipt import ReviewReceipt, ReceiptIdentity
from tui.review_result import ReviewResult
from tui.review_run import ReviewRun


class ReceiptContractTests(unittest.TestCase):
    def setUp(self):
        self.request = ReviewRequest(
            "projectbluefin",
            "review",
            372,
            "a" * 40,
            "b" * 40,
            "maintainer",
            "review",
            generated_at="test",
        )
        self.run = ReviewRun.from_request(
            self.request,
            backend="goose",
            model="gemini-3.8-flash",
            effort="high",
        )

    def result(self, backend):
        return ReviewResult(
            1,
            "findings",
            {"critical": 0, "high": 1, "medium": 0, "low": 0},
            [{"severity": "high", "file": "x.py", "line": 7, "title": "unsafe path"}],
            [{"name": "correctness", "state": "verified", "evidence": "one finding"}],
            {"backend": backend, "model": "gemini-3.8-flash"},
            {"duplicates": [9], "shared_files": ["x.py"]},
            {"ci": "failure", "head_sha": "b" * 40},
            ["raw line"],
        )

    def test_goose_receipt_round_trips_and_strips_mutable_evidence(self):
        receipt = ReviewReceipt.from_result(
            self.run,
            self.result("goose"),
            ["goose check line"] * 300,
            "scope-v7",
            {"headroom_status_line": "DIRECT", "headroom_state": "DIRECT"},
        )
        encoded = json.loads(receipt.to_json())
        restored = ReviewReceipt.from_json(receipt.to_json())
        self.assertEqual(encoded["version"], 1)
        self.assertEqual(restored.identity.backend, "goose")
        self.assertEqual(restored.identity.run_identity, self.run.identity)
        self.assertLessEqual(len(restored.transcript), 200)
        self.assertEqual(restored.analysis_result().live, {})
        self.assertEqual(restored.analysis_result().overlap, {})
        self.assertEqual(restored.provenance["headroom_state"], "DIRECT")

    def test_codex_receipt_round_trips_with_a_distinct_canonical_identity(self):
        codex_run = ReviewRun.from_request(
            self.request,
            backend="codex",
            model="gpt-5.6-sol",
            effort="medium",
        )
        receipt = ReviewReceipt.from_result(
            codex_run,
            ReviewResult(
                1,
                "complete",
                {"critical": 0, "high": 0, "medium": 0, "low": 0},
                [],
                [],
                {"backend": "codex", "model": "gpt-5.6-sol"},
                {},
                {},
                [],
            ),
            ["codex terminal"],
            "scope-v7",
        )
        restored = ReviewReceipt.from_json(receipt.to_json())
        self.assertEqual(restored.identity.backend, "codex")
        self.assertEqual(restored.identity.model, "gpt-5.6-sol")
        self.assertEqual(restored.identity.effort, "medium")
        self.assertTrue(restored.analysis_result().is_clean)

    def test_identity_changes_when_scope_version_changes(self):
        first = ReceiptIdentity.from_run(self.run, "scope-v7")
        second = ReceiptIdentity.from_run(self.run, "scope-v8")
        self.assertNotEqual(first.cache_identity, second.cache_identity)

    def test_invalid_receipt_is_rejected(self):
        payload = json.loads(
            ReviewReceipt.from_result(self.run, self.result("goose"), [], "scope-v7").to_json()
        )
        payload["identity"]["head_sha"] = "c" * 40
        with self.assertRaises(ValueError):
            ReviewReceipt.from_dict(payload)


if __name__ == "__main__":
    unittest.main()
