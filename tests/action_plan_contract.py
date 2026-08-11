"""Focused contract tests for the shared exact-head ActionPlan."""

from __future__ import annotations

import importlib.util
import sys
import unittest
from pathlib import Path


TUI_ROOT = Path(__file__).resolve().parents[1] / "image" / "tui"
if str(TUI_ROOT) not in sys.path:
    sys.path.insert(0, str(TUI_ROOT))


class ActionPlanContractTests(unittest.TestCase):
    def test_shared_action_plan_module_exists(self) -> None:
        self.assertIsNotNone(
            importlib.util.find_spec("action_plan"),
            "the shared ActionPlan contract module must exist",
        )


if __name__ == "__main__":
    unittest.main()
