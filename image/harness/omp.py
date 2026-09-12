"""OMP (Oh My Pi) review adapter for the shared harness contract."""

import json
import re
import os
import signal
import shutil
import subprocess
from dataclasses import dataclass, field
from typing import Callable

from tui.review_evidence_manifest import ReviewRequest
from tui.review_result import ReviewResult, parse_review_result

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
    model: str = "gemini-3.8-flash"
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
        self._process = process
        def _forward_signal(sig, _frame):
            try:
                os.killpg(process.pid, sig)
            except ProcessLookupError:
                pass
        old_term = signal.signal(signal.SIGTERM, _forward_signal)
        old_int = signal.signal(signal.SIGINT, _forward_signal)
        lines: list[str] = []
        assert process.stdout is not None
        try:
            for line in process.stdout:
                lines.append(line.rstrip("\n"))
                on_line(lines[-1])
            process.wait()
        finally:
            signal.signal(signal.SIGTERM, old_term)
            signal.signal(signal.SIGINT, old_int)
            self._process = None
        result = self.convert("\n".join(lines), binding, process.returncode,
                              model=model, effort=effort)
        live = dict(result.live)
        live["process_exit_code"] = process.returncode
        return ReviewResult(result.version, result.state, result.counts,
                            result.findings, result.verification, result.provenance,
                            result.overlap, live, result.raw_evidence)

    def convert(self, payload: str, binding: ReviewRequest, exit_code: int = 0,
                *, model: str | None = None, effort: str | None = None) -> ReviewResult:
        lines = payload.splitlines()
        if exit_code != 0:
            result = ReviewResult(1, "failed", raw_evidence=self._unparsable(lines).raw_evidence)
        else:
            result = self._convert_json_mode(lines)
        provenance = dict(result.provenance)
        provenance.update({
            "backend": self.name,
            "model": model or self.model,
            "repository": f"{binding.owner}/{binding.repository}",
            "pull_request": binding.pull_request_number,
            "base_sha": binding.base_sha,
            "head_sha": binding.head_sha,
            "reasoning_effort": effort or self.effort,
        })
        return ReviewResult(result.version, result.state, result.counts,
                            result.findings, result.verification, provenance,
                            result.overlap, result.live, result.raw_evidence)

    @staticmethod
    def _unparsable(lines: list[str]) -> ReviewResult:
        return parse_review_result("", raw_evidence=lines)

    @staticmethod
    def _unfenced(text: str) -> str:
        """Strip a single whole-message ```json ... ``` (or bare ```) wrapper.

        The result contract tells the model to return raw JSON, but models
        routinely fence it anyway; only an entire fenced message is unwrapped,
        never a fence nested inside surrounding prose.
        """
        stripped = text.strip()
        match = re.fullmatch(r"```(?:json)?\n(.*)\n```", stripped, re.DOTALL)
        return match.group(1) if match else stripped

    @staticmethod
    def _convert_json_mode(lines: list[str]) -> ReviewResult:
        """Accept one complete `omp --mode json` turn and nothing else.

        omp's JSON mode wraps the model's answer in a stream of protocol
        events; only the final `agent_end` frame's last assistant message is
        the review verdict, and a `stopReason` of "error" means the model
        never produced one even though the process itself exits 0.
        """
        invalid = OmpHarness._unparsable(lines)
        events: list[dict] = []
        for line in lines:
            if not line.strip():
                continue
            try:
                event = json.loads(line)
            except (TypeError, ValueError, json.JSONDecodeError):
                return invalid
            if not isinstance(event, dict) or not isinstance(event.get("type"), str):
                return invalid
            events.append(event)
        terminal = next((event for event in reversed(events) if event.get("type") == "agent_end"), None)
        if terminal is None:
            return invalid
        messages = terminal.get("messages")
        if not isinstance(messages, list):
            return invalid
        final_message = next(
            (message for message in reversed(messages)
             if isinstance(message, dict) and message.get("role") == "assistant"),
            None,
        )
        if not isinstance(final_message, dict) or final_message.get("stopReason") == "error":
            return invalid
        content = final_message.get("content")
        if not isinstance(content, list):
            return invalid
        texts = [
            item.get("text") for item in content
            if isinstance(item, dict) and item.get("type") == "text" and isinstance(item.get("text"), str)
        ]
        if not texts:
            return invalid
        result = parse_review_result(OmpHarness._unfenced(texts[-1]))
        if result.state == "unparsable":
            return invalid
        return result

    @staticmethod
    def terminal_status(result: ReviewResult) -> int:
        if result.state == "incomplete":
            return 65
        if result.state in ("complete", "findings"):
            return 0
        return int(result.live.get("process_exit_code", 1)) or 1

    def invoke(self, binding: ReviewRequest, *, prompt: str, model: str | None = None,
               effort: str | None = None, steer: str | None = None) -> ReviewResult:
        if self.availability is not Availability.READY:
            raise RuntimeError(f"omp unavailable: {self.availability.value}")
        return self.stream(binding, prompt=prompt, on_line=lambda _line: None,
                           effort=effort, model=model, steer=steer)

    RESULT_CONTRACT = (
        ' Return only one JSON object shaped as {"version":1,"state":"complete",'
        '"counts":{"critical":0,"high":0,"medium":0,"low":0},"findings":[]}.'
        ' Use state "findings" when findings exist; each finding requires severity, file,'
        ' line, and title, and counts must exactly match the findings. No Markdown.'
    )
    READ_ONLY_CONTRACT = (
        " This is a read-only review. Do not mutate GitHub, push commits,"
        " submit reviews, add comments, edit or merge pull requests, or change"
        " repository state."
    )

    def command(self, binding: ReviewRequest, *, prompt: str, model: str | None = None,
                effort: str | None = None, steer: str | None = None,
                extra_args: tuple[str, ...] = ()) -> list[str]:
        selected_model = model or self.model
        selected_effort = effort or self.effort
        context = (
            f"{binding.owner}/{binding.repository}#{binding.pull_request_number} "
            f"base={binding.base_sha} head={binding.head_sha}"
        )
        instruction = f"Review exact binding {context}. {prompt}"
        if steer:
            instruction += f" Maintainer steering: {steer}"
        instruction += self.READ_ONLY_CONTRACT + self.RESULT_CONTRACT
        cmd = [self.executable, "-p", "--mode", "json", "--model", selected_model,
               "--thinking", selected_effort]
        if extra_args:
            cmd.extend(extra_args)
        cmd.append(instruction)
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
        return [self.executable, "-p", "--mode", "text", "--model", self.model, prompt]

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

    # The review UI is owned by the omp extension package in
    # image/extension/bluefin-review: the rail under the editor, the dashboard
    # overlay, the status segment, and the LLM tools all live there, rendered by
    # omp itself. The Python shapes that used to describe that chrome from this
    # side (lower third, composer shape, host tool declarations, bluefin: URI
    # scheme) described a UI nothing built, so they are gone rather than kept as
    # a second, silently diverging description of the same surface. The
    # BuildStream element that used to live here went the same way: the
    # appliance is built by image/appliance/Containerfile.
