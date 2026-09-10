"""Hermetic contract tests for OMP (Oh My Pi) review adapter, extension, and UI modes."""

import json
import tempfile
import unittest
from pathlib import Path

from harness.autopilot import discover_all, choose_option, Preference
from harness.omp import OmpHarness
from harness.registry import (
    Availability,
    DraftRequest,
    DraftResult,
    DraftState,
    HarnessRegistry,
)
from tui.action_plan import BatchActionPlan, BatchMutationItem, Prerequisites
from tui.re_review import (
    ClassifiedFinding,
    DeltaInput,
    FallbackReason,
    FindingDisposition,
    FindingEvidence,
    H1Evidence,
    PriorFinding,
    Region,
    classify_head_delta,
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

    def test_extension_package_is_loadable_by_omp(self):
        """The mode must be a real omp extension package: manifest, entry, agents.

        omp resolves a --extension directory through package.json#omp.extensions and
        discovers companion task agents under <extension-root>/agents. An agent file
        missing name or description is skipped in silence, so assert the frontmatter
        omp actually requires.
        """
        root = Path("image/extension/bluefin-review")
        manifest = json.loads((root / "package.json").read_text())
        self.assertEqual(manifest["omp"]["extensions"], ["./index.ts"])
        self.assertTrue((root / "index.ts").is_file())

        agents = sorted((root / "agents").glob("*.md"))
        self.assertTrue(agents, "the mode ships companion review agents")
        for agent in agents:
            frontmatter = agent.read_text().split("---")[1]
            fields = {}
            for line in frontmatter.splitlines():
                if ":" in line and not line[:1].isspace():
                    key, value = line.split(":", 1)
                    fields[key.strip()] = value.strip()
            self.assertEqual(fields.get("name"), agent.stem)
            self.assertTrue(fields.get("description"), f"{agent.name} needs a description omp can index")
            # These agents travel inside the appliance, where no project config
            # exists to resolve a role alias. A dangling "@role" does not fail:
            # it silently falls back to whatever the parent session is running,
            # which is how a review ends up on an unintended model.
            model = fields.get("model", "")
            self.assertNotIn("@", model, f"{agent.name} must name a model, not a role alias")
            self.assertRegex(
                model,
                r"^[a-z0-9-]+/[A-Za-z0-9._-]+(:[a-z]+)?$",
                f"{agent.name} must pin provider/model",
            )

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
        with tempfile.TemporaryDirectory() as directory:
            executable = Path(directory) / "omp"
            executable.touch(mode=0o755)
            availability = OmpHarness.probe(str(executable))
        self.assertEqual(availability, Availability.READY)

    def test_omp_terminal_status(self):
        clean_res = ReviewResult(1, "complete")
        findings_res = ReviewResult(1, "findings")
        failed_res = ReviewResult(1, "failed", live={"process_exit_code": 23})
        self.assertEqual(self.harness.terminal_status(clean_res), 0)
        self.assertEqual(self.harness.terminal_status(findings_res), 0)
        self.assertEqual(self.harness.terminal_status(failed_res), 23)

    def test_omp_rpc_prompt_synthesis(self):
        draft_req = DraftRequest(
            binding=self.binding,
            verdict="approve",
            evidence=self.evidence,
            live_facts={"ci": "success"}
        )
        prompt_frame = self.harness.draft_request_to_rpc_prompt(draft_req)
        self.assertEqual(prompt_frame["type"], "prompt")
        self.assertIn("projectbluefin/review#42", prompt_frame["message"])
        self.assertIn("approve", prompt_frame["message"])

    def test_re_review_prompt_synthesis(self):
        delta = DeltaInput(
            reviewed_head_sha=self.binding.head_sha,
            current_head_sha=self.binding.head_sha,
            reviewed_merge_base_sha=self.binding.base_sha,
            current_merge_base_sha=self.binding.base_sha,
            current_h1_request=self.binding,
            prior_findings=(PriorFinding("f1", FindingEvidence("src/main.py", 10, 20)),),
            evidence=(FindingEvidence("src/main.py", 10, 20),),
            changed_regions=(Region("src/main.py", 15, 18),),
        )
        result = classify_head_delta(delta)
        prompt_frame = self.harness.re_review_prompt(result)
        self.assertEqual(prompt_frame["type"], "prompt")
        self.assertEqual(prompt_frame["streamingBehavior"], "steer")
        self.assertIn(self.binding.head_sha, prompt_frame["message"])
        self.assertIn("changed-region", prompt_frame["message"])

    def test_queue_pagination(self):
        items = [{"id": i} for i in range(25)]
        page0 = self.harness.format_queue_page(items, page=0, per_page=10)
        self.assertEqual(page0["page"], 0)
        self.assertEqual(len(page0["items"]), 10)
        self.assertTrue(page0["has_next"])

        page2 = self.harness.format_queue_page(items, page=2, per_page=10)
        self.assertEqual(page2["page"], 2)
        self.assertEqual(len(page2["items"]), 5)
        self.assertFalse(page2["has_next"])

    def test_format_batch_plan_prompt(self):
        item = BatchMutationItem(
            repository="projectbluefin/review",
            pull_request=42,
            head_sha="0123456789abcdef0123456789abcdef01234567",
            prerequisites=Prerequisites.from_mappings(permissions={"push": True}, checks={"ci": "success"}),
            operations=(("gh", "pr", "merge", "42", "--squash"),),
        )
        plan = BatchActionPlan.build(
            actor="maintainer",
            tenant="projectbluefin",
            action_kind="squash-merge",
            items=(item,),
        )
        prompt_frame = self.harness.format_batch_plan_prompt(plan)
        self.assertEqual(prompt_frame["type"], "prompt")
        self.assertEqual(prompt_frame["metadata"]["action_kind"], "squash-merge")
        self.assertEqual(prompt_frame["metadata"]["target_count"], 1)
        self.assertIn(plan.identity, prompt_frame["message"])
        self.assertIn("projectbluefin/review#42", prompt_frame["message"])

    def test_process_rpc_event_frames(self):
        delta_frame = {
            "type": "message_update",
            "assistantMessageEvent": {"type": "text_delta", "delta": "Looks good."},
        }
        processed_delta = self.harness.process_rpc_event(delta_frame)
        self.assertEqual(processed_delta["kind"], "delta")
        self.assertEqual(processed_delta["delta"], "Looks good.")
        self.assertFalse(processed_delta["is_tool"])

        terminal_frame = {"type": "agent_end", "isTerminal": True}
        processed_term = self.harness.process_rpc_event(terminal_frame)
        self.assertEqual(processed_term["kind"], "terminal")
        self.assertTrue(processed_term["is_terminal"])

        tool_frame = {"type": "tool_execution_start", "toolName": "read"}
        processed_tool = self.harness.process_rpc_event(tool_frame)
        self.assertEqual(processed_tool["kind"], "tool_start")
        self.assertEqual(processed_tool["tool"], "read")


if __name__ == "__main__":
    unittest.main()
