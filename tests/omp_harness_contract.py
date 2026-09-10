"""Hermetic contract tests for OMP (Oh My Pi) review adapter, extension, and UI modes."""

import json
import unittest

from harness.omp import OmpHarness
from harness.registry import (
    Availability,
    DraftRequest,
    DraftResult,
    DraftState,
    HarnessRegistry,
)
from tui.review_evidence_manifest import ReviewRequest
from tui.review_result import ReviewResult


class OmpHarnessContract(unittest.TestCase):
    def setUp(self):
        self.harness = OmpHarness()
        self.binding = ReviewRequest(
            "projectbluefin",
            "review",
            42,
            "0123456789abcdef0123456789abcdef01234567",
            "fedcba9876543210fedcba9876543210fedcba98",
            "maintainer",
            "review",
            generated_at="2026-09-09T00:00:00Z",
        )
        self.evidence = ReviewResult(
            version=1,
            state="complete",
            counts={"critical": 0, "major": 0, "minor": 0},
            provenance={
                "repository": "projectbluefin/review",
                "pull_request": 42,
                "base_sha": "0123456789abcdef0123456789abcdef01234567",
                "head_sha": "fedcba9876543210fedcba9876543210fedcba98",
            }
        )

    def test_harness_capabilities(self):
        caps = self.harness.capabilities
        self.assertTrue(caps.binary_readiness)
        self.assertTrue(caps.invocation)
        self.assertTrue(caps.exact_binding)
        self.assertTrue(caps.body_drafting)

    def test_branding(self):
        branding = self.harness.branding
        self.assertEqual(branding.harness_id, "omp")
        self.assertEqual(len(branding.terminal_badge), 2)

    def test_command_generation(self):
        cmd = self.harness.command(self.binding, prompt="Check correctness")
        self.assertEqual(cmd[0], "omp")
        self.assertIn("--mode", cmd)
        self.assertIn("rpc", cmd)

    def test_draft_command_generation(self):
        draft_req = DraftRequest(
            binding=self.binding,
            verdict="approve",
            evidence=self.evidence,
            live_facts={"ci": "success"}
        )
        cmd = self.harness.draft_command(draft_req)
        self.assertEqual(cmd[0], "omp")
        self.assertIn("rpc", cmd)

    def test_convert_draft_success(self):
        draft_req = DraftRequest(
            binding=self.binding,
            verdict="approve",
            evidence=self.evidence,
            live_facts={"ci": "success"}
        )
        res = self.harness.convert_draft("LGTM! Verified clean.", draft_req, 0)
        self.assertEqual(res.state, DraftState.COMPLETE)
        self.assertEqual(res.markdown, "LGTM! Verified clean.")
        self.assertEqual(res.provenance["repository"], "projectbluefin/review")

    def test_convert_draft_failure(self):
        draft_req = DraftRequest(
            binding=self.binding,
            verdict="approve",
            evidence=self.evidence,
            live_facts={"ci": "success"}
        )
        res = self.harness.convert_draft("", draft_req, 1)
        self.assertEqual(res.state, DraftState.FAILED)

    def test_registry_registration(self):
        reg = HarnessRegistry()
        reg.register(self.harness)
        self.assertIn("omp", reg.names())
        self.assertEqual(reg.get("omp").name, "omp")


if __name__ == "__main__":
    unittest.main()
