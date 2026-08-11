"""Focused contracts for the dashboard's pure semantic view models."""

from __future__ import annotations

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parents[1] / "image" / "tui"))

try:
    from semantic_view import (
        ACTIONS,
        ActionID,
        DecisionState,
        build_decision_card,
        build_queue_row,
    )
except ModuleNotFoundError:
    ACTIONS = None
    ActionID = None
    DecisionState = None
    build_decision_card = None
    build_queue_row = None

from review_result import ReviewResult


@unittest.skipIf(ActionID is None, "semantic view module has not been implemented")
class SemanticViewContractTests(unittest.TestCase):
    def test_registry_has_one_stable_entry_per_action_id(self):
        self.assertEqual(tuple(ACTIONS), tuple(ActionID))
        self.assertEqual(len(ACTIONS), len(set(ActionID)))
        self.assertEqual(ActionID.APPROVE_AND_QUEUE.value, "approve-and-queue")
        self.assertTrue(ACTIONS[ActionID.APPROVE_AND_QUEUE].mutating)
        self.assertTrue(ACTIONS[ActionID.APPROVE_AND_QUEUE].confirmation_required)
        self.assertFalse(ACTIONS[ActionID.VIEW_DIFF].mutating)
        self.assertFalse(ACTIONS[ActionID.OPEN_BROWSER].ordinary_journey)

    def test_queue_row_preserves_current_snapshot_meaning(self):
        row = build_queue_row({
            "repository": "projectbluefin/review",
            "number": 196,
            "title": "semantic foundation",
            "author": "raptor",
            "head_sha": "a" * 40,
            "mergeable_state": "dirty",
            "check_state": "failure",
            "review_state": "approved",
            "recommended_action": "review",
        })
        self.assertEqual(row.identity, "projectbluefin/review#196")
        self.assertEqual(row.exact_head, "a" * 40)
        self.assertEqual(row.mergeability.label, "CONFLICTS")
        self.assertEqual(row.ci.label, "CI FAILED")
        self.assertEqual(row.review.label, "APPROVED")
        self.assertEqual(row.primary_action, ActionID.RUN_REVIEW)

    def test_queue_row_fails_closed_for_unknown_or_invalid_state(self):
        row = build_queue_row({
            "repository": "projectbluefin/review",
            "number": 196,
            "title": "semantic foundation",
            "author": "raptor",
            "head_sha": "not-an-exact-head",
            "mergeable_state": "mystery",
            "check_state": "mystery",
            "review_state": "mystery",
            "recommended_action": "mystery",
        })
        self.assertIsNone(row.exact_head)
        self.assertEqual(row.mergeability.label, "MERGEABILITY UNKNOWN")
        self.assertEqual(row.ci.label, "CI UNKNOWN")
        self.assertEqual(row.review.label, "REVIEW UNKNOWN")
        self.assertIsNone(row.primary_action)

    def test_decision_card_preserves_exact_head_and_result_evidence(self):
        result = ReviewResult.from_dict({
            "version": 1,
            "state": "findings",
            "counts": {"critical": 0, "high": 1, "medium": 0, "low": 0},
            "findings": [{
                "severity": "high",
                "title": "unsafe mutation",
                "file": "image/tui/example.py",
                "line": 7,
            }],
            "verification": [{
                "name": "unit",
                "state": "verified",
                "evidence": "python3 tests/example.py",
            }],
            "provenance": {"backend": "codex", "model": "gpt-5.6-luna"},
        })
        card = build_decision_card(result, exact_head="b" * 40)
        self.assertEqual(card.state, DecisionState.FINDINGS)
        self.assertEqual(card.exact_head, "b" * 40)
        self.assertEqual(card.provenance.backend, "codex")
        self.assertEqual(card.provenance.model, "gpt-5.6-luna")
        self.assertEqual(card.findings[0].title, "unsafe mutation")
        self.assertEqual(card.verification[0].state, "verified")
        self.assertFalse(card.clean)

    def test_decision_card_never_promotes_nonterminal_or_invalid_results(self):
        expected = {
            "incomplete": DecisionState.INCOMPLETE,
            "failed": DecisionState.FAILED,
            "unparsable": DecisionState.UNPARSABLE,
        }
        for raw_state, semantic_state in expected.items():
            with self.subTest(raw_state=raw_state):
                result = ReviewResult(1, raw_state)
                card = build_decision_card(result, exact_head="invalid")
                self.assertEqual(card.state, semantic_state)
                self.assertIsNone(card.exact_head)
                self.assertFalse(card.clean)


class SemanticViewRedTest(unittest.TestCase):
    def test_semantic_view_module_exists(self):
        self.assertIsNotNone(ActionID, "semantic view module must exist")


if __name__ == "__main__":
    unittest.main()
