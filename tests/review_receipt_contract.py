# tests/review_receipt_contract.py
import json
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parents[1] / "image"))

from harness.registry import Availability, HarnessRegistry
from tui.review_evidence_manifest import ReviewRequest
from tui.review_receipt import (
    MUTABLE_PROVENANCE_KEYS,
    ReceiptIdentity,
    ReviewReceipt,
    cache_digest,
    default_harness_registry,
    run_receipt,
)
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

    def test_deeply_nested_json_is_rejected_as_invalid(self):
        deep_json = '{"a":' * 10000 + "1" + "}" * 10000
        with self.assertRaises(ValueError) as ctx:
            ReviewReceipt.from_json(deep_json)
        self.assertIn("receipt JSON is invalid", str(ctx.exception))

    def test_cache_digest_matches_receipt_identity(self):
        identity = ReceiptIdentity.from_run(self.run, "scope-v7")
        self.assertEqual(identity.cache_identity, cache_digest(self.run, "scope-v7"))
        self.assertEqual(identity.cache_identity, cache_digest(self.run.identity, "scope-v7"))

    def test_mutable_fields_cannot_appear_in_provenance(self):
        mutable_evidence = {
            "ci": "failure",
            "checks": [{"name": "build", "state": "failure"}],
            "mergeability": "conflicting",
            "reviews": [{"user": "octocat", "state": "approved"}],
            "live": {"status": "active"},
            "overlap": {"prs": [1, 2]},
        }
        tainted_result = ReviewResult(
            1,
            "findings",
            {"critical": 0, "high": 1, "medium": 0, "low": 0},
            [{"severity": "high", "file": "x.py", "line": 7, "title": "unsafe path"}],
            [{"name": "correctness", "state": "verified", "evidence": "one finding"}],
            {"backend": "goose", "model": "gemini-3.8-flash", **mutable_evidence},
            {"duplicates": [9]},
            {"ci": "failure"},
            ["raw line"],
        )
        receipt = ReviewReceipt.from_result(
            self.run,
            tainted_result,
            ["goose check line"],
            "scope-v7",
            provenance=mutable_evidence,
        )
        for key in mutable_evidence:
            self.assertNotIn(key, receipt.provenance)
            self.assertNotIn(key, receipt.analysis.provenance)

        updated = receipt.with_provenance(mutable_evidence)
        for key in mutable_evidence:
            self.assertNotIn(key, updated.provenance)
            self.assertNotIn(key, updated.analysis.provenance)

        for key in mutable_evidence:
            bad_top = json.loads(receipt.to_json())
            bad_top["provenance"][key] = "leak"
            with self.assertRaises(ValueError):
                ReviewReceipt.from_dict(bad_top)

            bad_analysis = json.loads(receipt.to_json())
            bad_analysis["analysis"]["provenance"][key] = "leak"
            with self.assertRaises(ValueError):
                ReviewReceipt.from_dict(bad_analysis)

    def test_receipt_identity_from_dict_validates_backend(self):
        valid = self.run
        identity = ReceiptIdentity.from_run(valid, "scope-v7")
        data = identity.to_dict()
        data["backend"] = "invalid_backend"
        with self.assertRaises(ValueError) as ctx:
            ReceiptIdentity.from_dict(data)
        self.assertIn("unsupported review backend", str(ctx.exception))

    def test_transcript_max_chars_bound(self):
        # 10 lines of 10,000 characters = 100,000 chars > MAX_TRANSCRIPT_CHARS (60,000)
        lines = ["x" * 10_000 for _ in range(10)]
        receipt = ReviewReceipt.from_result(
            self.run,
            self.result("goose"),
            lines,
            "scope-v7",
        )
        total_chars = sum(len(line) for line in receipt.transcript)
        self.assertEqual(total_chars, 60_000)
        self.assertEqual(len(receipt.transcript), 6)

    def test_harness_registry_preserves_both_backends_without_fork(self):
        registry = default_harness_registry()
        self.assertEqual(set(registry.names()), {"goose", "codex"})

        class MockHarness:
            def __init__(self, name: str, state: str = "complete"):
                self.name = name
                self.availability = Availability.READY
                self.state = state
                self.streamed_args = None

            def stream(self, binding, *, prompt, on_line, model=None, effort=None, steer=None, extra_args=()):
                self.streamed_args = {
                    "binding": binding,
                    "prompt": prompt,
                    "model": model,
                    "effort": effort,
                    "steer": steer,
                    "extra_args": extra_args,
                }
                on_line(f"{self.name} output")
                return ReviewResult(
                    1,
                    self.state,
                    {"critical": 0, "high": 0, "medium": 0, "low": 0},
                    [],
                    [],
                    {"backend": self.name, "model": model or "mock-model"},
                    {},
                    {},
                    [f"{self.name} raw"],
                )

            def terminal_status(self, result):
                return 0 if result.state == "complete" else 1

        mock_registry = HarnessRegistry()
        goose_mock = MockHarness("goose")
        codex_mock = MockHarness("codex")
        mock_registry.register(goose_mock)
        mock_registry.register(codex_mock)

        for backend in ("goose", "codex"):
            with self.subTest(backend=backend):
                receipt, exit_code = run_receipt(
                    "projectbluefin/review",
                    372,
                    "a" * 40,
                    "b" * 40,
                    backend,
                    "test-model",
                    "high",
                    "",
                    "scope-v7",
                    check_scope="/tmp/check-scope",
                    registry=mock_registry,
                )
                self.assertEqual(receipt.identity.backend, backend)
                self.assertEqual(exit_code, 0)
                self.assertEqual(receipt.transcript, (f"{backend} output",))


if __name__ == "__main__":
    unittest.main()
