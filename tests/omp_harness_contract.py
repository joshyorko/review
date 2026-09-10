"""Hermetic contract tests for OMP (Oh My Pi) review adapter, extension, and UI modes."""

import json
import unittest

from harness.autopilot import discover_all, choose_option, Preference
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

    def test_lower_third_widget_rendering(self):
        """Test lower third dashboard UI representation."""
        lines = self.harness.render_lower_third(
            items=[{"id": 42, "title": "feat: add omp review mode", "author": "jorge", "ci": "SUCCESS"}],
            active_index=0,
            mode="prs",
            width=80,
        )
        self.assertEqual(len(lines), 3)
        self.assertIn("BLUEFIN PRS QUEUE", lines[0])
        self.assertIn("#42", lines[1])
        self.assertIn("[j/k] Navigate", lines[2])

    def test_issues_mode_toggle_and_rendering(self):
        """Test issues mode in lower third widget."""
        lines = self.harness.render_lower_third(
            items=[{"id": 101, "title": "bug: fix crash in rpc mode", "author": "alice"}],
            active_index=0,
            mode="issues",
            width=80,
        )
        self.assertIn("BLUEFIN ISSUES QUEUE", lines[0])
        self.assertIn("#101", lines[1])

    def test_bst_container_recipe_spec(self):
        """Test BuildStream element configuration schema for omp-review container."""
        spec = self.harness.bst_element_spec()
        self.assertEqual(spec["kind"], "oci")
        self.assertIn("sources", spec)
        self.assertIn("config", spec)
        self.assertEqual(spec["config"]["entrypoint"], ["/usr/local/bin/omp-review"])

    def test_autopilot_discovery_includes_omp(self):
        options = discover_all()
        backends = [opt.discovery.backend for opt in options]
        self.assertIn("omp", backends)

    def test_autopilot_prefers_omp_when_configured(self):
        options = discover_all()
        pref = Preference("omp", "github-copilot/gemini-3.8-flash", "max")
        chosen = choose_option("projectbluefin/review", {"*": pref}, options)
        self.assertIsNotNone(chosen)
        self.assertEqual(chosen.discovery.backend, "omp")

    def test_omp_probe_ready(self):
        availability = OmpHarness.probe()
        self.assertEqual(availability, Availability.READY)


if __name__ == "__main__":
    unittest.main()
