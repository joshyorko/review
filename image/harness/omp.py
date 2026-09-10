"""OMP (Oh My Pi) review adapter for the shared harness contract."""

import json
import os
import re
import signal
import shutil
import subprocess
from dataclasses import dataclass, field
from typing import Callable

from tui.review_evidence_manifest import ReviewRequest
from tui.review_result import ReviewResult, adapt_current_engine

from .registry import (
    Availability,
    DraftRequest,
    DraftResult,
    DraftState,
    HarnessBranding,
    HarnessCapabilities,
)


@dataclass
class OmpHarness:
    """OMP review harness adapter running Oh My Pi in RPC or review mode."""
    name: str = "omp"
    branding: HarnessBranding = HarnessBranding(
        "omp", "Oh My Pi", "PI", "Oh My Pi Coding Agent", "can1357/oh-my-pi", None
    )
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
    process_group_cancellation = True
    _process: subprocess.Popen | None = field(default=None, init=False, repr=False)

    def command(self, binding: ReviewRequest, *, prompt: str, model: str | None = None,
                effort: str | None = None, steer: str | None = None,
                extra_args: tuple[str, ...] = ()) -> list[str]:
        selected_model = model or self.model
        context = (
            f"{binding.owner}/{binding.repository}#{binding.pull_request_number} "
            f"base={binding.base_sha} head={binding.head_sha}"
        )
        instruction = (
            f"Review exact binding {context}. {prompt} "
            f"Model {selected_model} reasoning {effort or self.effort}."
        )
        if steer:
            instruction += f" Maintainer steering: {steer}"
        cmd = [self.executable, "--mode", "rpc", "--model", selected_model]
        if extra_args:
            cmd.extend(extra_args)
        return cmd

    def draft_command(self, request: DraftRequest) -> list[str]:
        """Command to generate review draft."""
        evidence = json.dumps(
            {"result": request.evidence.to_dict(), "live": dict(request.live_facts)},
            sort_keys=True,
            separators=(",", ":")
        )
        prompt = (
            f"Draft concise Markdown review body for verdict {request.verdict}. "
            f"Evidence: {evidence}. Return only Markdown."
        )
        return [self.executable, "--mode", "rpc", "--model", self.model]

    def draft_request_to_rpc_prompt(self, request: DraftRequest) -> dict:
        """Format DraftRequest as an OMP RPC prompt command."""
        evidence = json.dumps(
            {"result": request.evidence.to_dict(), "live": dict(request.live_facts)},
            sort_keys=True,
            separators=(",", ":")
        )
        return {
            "type": "prompt",
            "message": (
                f"Draft concise Markdown review body for verdict {request.verdict}. "
                f"For {request.binding.owner}/{request.binding.repository}#{request.binding.pull_request_number}. "
                f"Evidence: {evidence}"
            )
        }

    def convert_draft(self, payload: str, request: DraftRequest, exit_code: int = 0) -> DraftResult:
        if exit_code != 0 or not payload.strip():
            return DraftResult(
                DraftState.FAILED,
                provenance={"backend": self.name, "model": self.model, "effort": self.effort}
            )
        return DraftResult(
            DraftState.COMPLETE,
            provenance={
                "backend": self.name,
                "model": self.model,
                "effort": self.effort,
                "repository": f"{request.binding.owner}/{request.binding.repository}",
                "pull_request": request.binding.pull_request_number,
                "base_sha": request.binding.base_sha,
                "head_sha": request.binding.head_sha,
            },
            markdown=payload.strip(),
        )
