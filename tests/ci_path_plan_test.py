from __future__ import annotations

import importlib.util
import subprocess
import tempfile
import unittest
from pathlib import Path


MODULE_PATH = Path(__file__).resolve().parents[1] / "scripts/ci/path-plan.py"
SPEC = importlib.util.spec_from_file_location("path_plan", MODULE_PATH)
assert SPEC and SPEC.loader
path_plan = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(path_plan)


def git(root: Path, *args: str) -> str:
    return subprocess.run(
        ["git", *args], cwd=root, check=True, text=True, stdout=subprocess.PIPE
    ).stdout.strip()


def repository(root: Path) -> str:
    root.mkdir()
    git(root, "init", "-q", "--initial-branch=main")
    git(root, "config", "user.name", "Path planner test")
    git(root, "config", "user.email", "path-plan@example.invalid")
    (root / "docs").mkdir()
    (root / ".gitignore").write_text(".agents/\n")
    (root / "docs/guide.md").write_text("guide\n")
    (root / "README.md").write_text("readme\n")
    git(root, "add", ".")
    git(root, "commit", "-qm", "path planner base")
    return git(root, "rev-parse", "HEAD")


class PathPlanTest(unittest.TestCase):
    def test_docs_and_ignored_project_skill_use_the_light_profile(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary) / "repo"
            repository(root)
            (root / "docs/new.md").write_text("new docs\n")
            (root / ".agents/skills/review-ci").mkdir(parents=True)
            (root / ".agents/skills/review-ci/SKILL.md").write_text("project skill\n")

            selected = path_plan.plan(root, "main")

            self.assertEqual(selected["profile"], "contract")
            self.assertEqual(selected["native"], "not-required")
            self.assertFalse(selected["blocked"])
            self.assertIn(".agents/skills/review-ci/SKILL.md", selected["changedPaths"])

    def test_pipeline_changes_include_untracked_and_renamed_paths(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary) / "repo"
            repository(root)
            (root / "docs/guide.md").rename(root / "docs/renamed.md")
            (root / ".dagger").mkdir()
            (root / ".dagger/main.go").write_text("pipeline\n")

            selected = path_plan.plan(root, "main")

            self.assertEqual(selected["profile"], "portable")
            self.assertEqual(selected["native"], "not-required")
            self.assertFalse(selected["blocked"])
            self.assertIn("docs/guide.md", selected["changedPaths"])
            self.assertIn("docs/renamed.md", selected["changedPaths"])
            self.assertIn(".dagger/main.go", selected["changedPaths"])

    def test_native_and_unknown_paths_are_blocked_after_portable_selection(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary) / "native"
            repository(root)
            (root / "image/appliance").mkdir(parents=True)
            (root / "image/appliance/Containerfile").write_text("runtime change\n")
            native = path_plan.plan(root, "main")
            self.assertEqual(native["profile"], "portable")
            self.assertEqual(native["native"], "required")
            self.assertTrue(native["blocked"])

        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary) / "unknown"
            repository(root)
            (root / "new-format.data").write_text("unknown\n")
            unknown = path_plan.plan(root, "main")
            self.assertEqual(unknown["profile"], "portable")
            self.assertEqual(unknown["native"], "unknown")
            self.assertTrue(unknown["blocked"])

    def test_missing_base_mismatched_ref_and_explicit_native_fail_closed(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary) / "repo"
            repository(root)
            self.assertTrue(path_plan.plan(root, None)["blocked"])
            self.assertTrue(path_plan.plan(root, "missing-base")["blocked"])
            other = git(root, "rev-parse", "HEAD")
            (root / "README.md").write_text("dirty source\n")
            self.assertTrue(path_plan.plan(root, "main", ref=other + "^", require_native=True)["blocked"])


if __name__ == "__main__":
    unittest.main()
