"""OMP (Oh My Pi) review adapter for the shared harness contract."""

import json
import os
import re
import signal
import shutil
import subprocess
from dataclasses import dataclass, field
from typing import Any, Callable

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

    @classmethod
    def probe(cls, executable: str = "omp") -> Availability:
        if shutil.which(executable) is None:
            return Availability.UNAVAILABLE_BINARY
        return Availability.READY

    def draft(self, request: DraftRequest) -> DraftResult:
        if self.availability is not Availability.READY:
            raise RuntimeError(f"omp unavailable: {self.availability.value}")
        process = subprocess.run(
            self.draft_command(request), capture_output=True, text=True, check=False
        )
        return self.convert_draft(process.stdout, request, process.returncode)

    def stream(self, binding: ReviewRequest, *, prompt: str,
               on_line: Callable[[str], None], effort: str | None = None,
               model: str | None = None, steer: str | None = None,
               extra_args: tuple[str, ...] = ()) -> ReviewResult:
        cmd = self.command(binding, prompt=prompt, effort=effort, model=model, steer=steer, extra_args=extra_args)
        process = subprocess.Popen(
            cmd, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True,
            bufsize=1, start_new_session=True,
        )
        lines: list[str] = []
        assert process.stdout is not None
        for line in process.stdout:
            lines.append(line.rstrip("\n"))
            on_line(lines[-1])
        process.wait()
        return adapt_current_engine(
            "\n".join(lines), process.returncode,
            {
                "backend": self.name,
                "model": model or self.model,
                "repository": f"{binding.owner}/{binding.repository}",
                "pull_request": binding.pull_request_number,
                "base_sha": binding.base_sha,
                "head_sha": binding.head_sha,
                "reasoning_effort": effort or self.effort,
            }
        )

    def invoke(self, binding: ReviewRequest, *, prompt: str, model: str | None = None,
               effort: str | None = None, steer: str | None = None) -> ReviewResult:
        if self.availability is not Availability.READY:
            raise RuntimeError(f"omp unavailable: {self.availability.value}")
        return self.stream(binding, prompt=prompt, on_line=lambda _line: None,
                           effort=effort, model=model, steer=steer)

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

    def render_lower_third(self, items: list[dict[str, Any]], active_index: int, mode: str, width: int) -> list[str]:
        """Render the lower-third dashboard widget mimicking omp status chrome."""
        mode_label = mode.upper()
        count = len(items)
        pos = f"{active_index + 1}/{count}" if count > 0 else "0/0"
        header = f"── [BLUEFIN {mode_label} QUEUE] ── ({pos}) ─────────────────────────────"[:width]
        if 0 <= active_index < len(items):
            current = items[active_index]
            ci_badge = f"[CI: {current['ci']}] " if "ci" in current else ""
            item_line = f"  #{current['id']} {ci_badge}{current['title']} (@{current.get('author', 'unknown')})"
        else:
            item_line = "  No items in queue"
        if len(item_line) > width:
            item_line = item_line[:width - 3] + "..."
        shortcuts = "  [j/k] Navigate  [r] Review  [a] Approve/Land  [I] Issues Mode  [$] Slay (Fix+Land)"[:width]
        return [header, item_line, shortcuts]

    def bst_element_spec(self) -> dict[str, Any]:
        """Return the BuildStream element definition for distributing omp-review."""
        return {
            "kind": "oci",
            "description": "Project Bluefin OMP Review Appliance Container",
            "sources": [
                {"kind": "local", "path": "image/extension"},
                {"kind": "local", "path": "image/harness"},
            ],
            "depends": [
                {"filename": "components/omp.bst"},
                {"filename": "components/gh-cli.bst"},
                {"filename": "components/git.bst"},
            ],
            "config": {
                "entrypoint": ["/usr/local/bin/omp-review"],
                "env": {
                    "PI_EXTENSIONS": "/opt/bluefin/extensions/bluefin-review.ts",
                    "BLUEFIN_REVIEW_MODE": "dashboard",
                },
            },
        }
