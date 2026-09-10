"""Hermetic contract tests for OMP (Oh My Pi) review adapter & modes."""

import json
import unittest
from dataclasses import dataclass

from harness.registry import (
    Availability,
    DraftRequest,
    DraftResult,
    DraftState,
    HarnessCapabilities,
    HarnessRegistry,
)
from tui.review_evidence_manifest import ReviewRequest
from tui.review_result import ReviewResult


@dataclass
class OmpHarness:
    """OMP review harness adapter running Oh My Pi in RPC or review execution mode."""
    name: str = "omp"
    model: str = "github-copilot/gemini-3.8-flash"
    effort: str = "max"
    availability: Availability = Availability.READY
    executable: str = "omp"
    capabilities: HarnessCapabilities = HarnessCapabilities(
        binary_readiness=True,
        auth_preflight=True,
        invocation=True,
        exact_binding=True,
        model_effort=True,
        steering=True,
        streaming=True,
        cancellation=True,
        result_conversion=True,
        provenance=True,
        body_drafting=True,
    )

    def command(self, binding: ReviewRequest, *, prompt: str, model: str | None = None,
                effort: str | None = None, steer: str | None = None,
                extra_args: tuple[str, ...] = ()) -> list[str]:
        selected_model = model or self.model
        context = (
            f"{binding.owner}/{binding.repository}#{binding.pull_request_number} "
            f"base={binding.base_sha} head={binding.head_sha}"
        )
        instruction = f"Review exact binding {context}. {prompt}"
        if steer:
            instruction += f" Maintainer steering: {steer}"
        return [self.executable, "--mode", "rpc", "--model", selected_model, *extra_args]

    def draft_request_to_rpc_prompt(self, request: DraftRequest) -> dict:
        """Format DraftRequest as an OMP RPC prompt command."""
        return {
            "type": "prompt",
            "message": (
                f"Perform review for {request.binding.owner}/{request.binding.repository}#{request.binding.pull_request_number}. "
                f"Verdict: {request.verdict}"
            )
        }


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

    def test_harness_capabilities(self):
        caps = self.harness.capabilities
        self.assertTrue(caps.binary_readiness)
        self.assertTrue(caps.invocation)
        self.assertTrue(caps.exact_binding)
        self.assertTrue(caps.body_drafting)

    def test_command_generation(self):
        cmd = self.harness.command(self.binding, prompt="Check correctness")
        self.assertEqual(cmd[0], "omp")
        self.assertIn("--mode", cmd)
        self.assertIn("rpc", cmd)

    def test_rpc_prompt_structure(self):
        evidence = ReviewResult(
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
        draft_req = DraftRequest(
            binding=self.binding,
            verdict="approve",
            evidence=evidence,
            live_facts={"ci": "success"}
        )
        prompt_cmd = self.harness.draft_request_to_rpc_prompt(draft_req)
        self.assertEqual(prompt_cmd["type"], "prompt")
        self.assertIn("projectbluefin/review#42", prompt_cmd["message"])
        self.assertIn("approve", prompt_cmd["message"])


if __name__ == "__main__":
    unittest.main()
