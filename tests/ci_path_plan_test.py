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
            (root / "tests").mkdir()
            (root / "tests/luna_factory_dogfood_contract.test.ts").write_text("contract\n")

            selected = path_plan.plan(root, "main")

            self.assertEqual(selected["profile"], "portable")
            self.assertEqual(selected["native"], "not-required")
            self.assertFalse(selected["blocked"])
            self.assertIn("docs/guide.md", selected["changedPaths"])
            self.assertIn("docs/renamed.md", selected["changedPaths"])
            self.assertIn(".dagger/main.go", selected["changedPaths"])
            self.assertEqual(selected["native"], "not-required")

    def test_native_runtime_probe_files_use_the_artifact_adapter(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary) / "native"
            base = repository(root)
            (root / "tests").mkdir()
            (root / "tests/appliance-runtime-probe.sh").write_text("probe\n")
            git(root, "add", "tests/appliance-runtime-probe.sh")
            git(root, "commit", "-qm", "change runtime probe")
            selected = path_plan.plan(root, base)
            self.assertEqual(selected["native"], "required")
            self.assertEqual(selected["nativeAdapter"], "appliance-artifact")
            self.assertFalse(selected["blocked"])

    def test_appliance_paths_select_the_native_artifact_adapter(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary) / "dirty"
            base = repository(root)
            (root / "image/appliance").mkdir(parents=True)
            (root / "image/appliance/Containerfile").write_text("uncommitted runtime change\n")
            dirty = path_plan.plan(root, base)
            self.assertTrue(dirty["dirty"])
            self.assertIsNone(dirty["nativeAdapter"])
            self.assertTrue(dirty["blocked"])
            self.assertIn("clean committed source", dirty["reason"])

        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary) / "ignored-skill"
            base = repository(root)
            (root / "image/appliance").mkdir(parents=True)
            (root / "image/appliance/Containerfile").write_text("committed appliance\n")
            git(root, "add", "image/appliance/Containerfile")
            git(root, "commit", "-qm", "change appliance")
            (root / ".agents/skills/review-ci").mkdir(parents=True)
            (root / ".agents/skills/review-ci/SKILL.md").write_text("ignored project skill\n")
            selected = path_plan.plan(root, base)
            self.assertIn(".agents/skills/review-ci/SKILL.md", selected["changedPaths"])
            self.assertTrue(selected["dirty"])
            self.assertIsNone(selected["nativeAdapter"])
            self.assertTrue(selected["blocked"])

        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary) / "native"
            base = repository(root)
            (root / "image/appliance").mkdir(parents=True)
            (root / "image/appliance/Containerfile").write_text("runtime change\n")
            git(root, "add", "image/appliance/Containerfile")
            git(root, "commit", "-qm", "change appliance")
            native = path_plan.plan(root, base)
            self.assertEqual(native["profile"], "portable")
            self.assertEqual(native["native"], "required")
            self.assertEqual(native["nativeAdapter"], "appliance-artifact")
            self.assertFalse(native["blocked"])

        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary) / "unsupported"
            base = repository(root)
            (root / "scripts").mkdir()
            (root / "scripts/install-apptainer-ci.sh").write_text("host package profile change\n")
            git(root, "add", "scripts/install-apptainer-ci.sh")
            git(root, "commit", "-qm", "change apptainer installer")
            unsupported = path_plan.plan(root, base)
            self.assertEqual(unsupported["native"], "required")
            self.assertIsNone(unsupported["nativeAdapter"])
            self.assertTrue(unsupported["blocked"])

        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary) / "unknown"
            repository(root)
            (root / "new-format.data").write_text("unknown\n")
            unknown = path_plan.plan(root, "main")
            self.assertEqual(unknown["profile"], "portable")
            self.assertEqual(unknown["native"], "unknown")
            self.assertIsNone(unknown["nativeAdapter"])
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
