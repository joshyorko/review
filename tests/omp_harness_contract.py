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
        self.assertIn("[Ctrl+A] Approve+Merge", lines[2])

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

    def test_extension_source_exports_review_queue_and_graphql(self):
        """Verify extension source contains key exports and queries."""
        with open("image/extension/bluefin-review.ts", "r") as f:
            content = f.read()
        self.assertIn("ReviewQueueState", content)
        self.assertIn("ORG_QUEUE_QUERY", content)
        self.assertIn("ORG_ISSUES_QUERY", content)
        self.assertIn("fetchLiveQueue", content)
        self.assertIn("bluefin-review-lower-third", content)
        self.assertIn("bluefin-welcome-box", content)
        self.assertIn('pi.registerShortcut("ctrl+j"', content)
        self.assertIn('pi.registerShortcut("ctrl+k"', content)
        self.assertIn('pi.registerShortcut("tab"', content)
        self.assertIn('pi.registerShortcut("ctrl+r"', content)
        self.assertIn('pi.registerShortcut("ctrl+a"', content)
        self.assertIn('pi.registerShortcut("ctrl+f"', content)
        self.assertIn('pi.registerShortcut("ctrl+$"', content)
        self.assertIn('pi.registerShortcut("ctrl+d"', content)

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

    def test_composer_shape_spec(self):
        shape = self.harness.composer_shape_spec()
        self.assertEqual(shape["id"], "bluefin-dock")
        self.assertEqual(shape["bottomBar"], "full")
        self.assertTrue(shape["bottomBarGap"])
        self.assertEqual(shape["defaultPromptGutter"], "❯ ")

    def test_host_tools_and_uri_schemes(self):
        tools = self.harness.host_tools_spec()
        self.assertEqual(len(tools), 2)
        tool_names = [t["name"] for t in tools]
        self.assertIn("bluefin_query_queue", tool_names)
        self.assertIn("bluefin_submit_verdict", tool_names)

        schemes = self.harness.host_uri_schemes_spec()
        self.assertEqual(len(schemes), 1)
        self.assertEqual(schemes[0]["scheme"], "bluefin")
        self.assertTrue(schemes[0]["writable"])

    def test_extension_tool_structure(self):
        """Verify extension registers bluefin_review_status and bluefin_review_diff tools."""
        with open("image/extension/bluefin-review.ts", "r") as f:
            content = f.read()
        self.assertIn("pi.registerTool({", content)
        self.assertIn('name: "bluefin_review_status"', content)
        self.assertIn('name: "bluefin_review_diff"', content)
        self.assertIn("total_items: queue.items.length", content)
        self.assertIn("pull_request: params.pull_request", content)

    def test_extension_tool_diff_parameters(self):
        """Verify bluefin_review_diff parameters schema requires pull_request number."""
        with open("image/extension/bluefin-review.ts", "r") as f:
            content = f.read()
        self.assertIn("pull_request: z.number()", content)
        self.assertIn('label: "Review Diff"', content)


if __name__ == "__main__":
    unittest.main()
