from __future__ import annotations

import subprocess
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
VERIFY = ROOT / "scripts/ci/verify-source-identity.sh"


def git(root: Path, *args: str) -> str:
    return subprocess.run(
        ["git", *args], cwd=root, check=True, text=True, stdout=subprocess.PIPE
    ).stdout.strip()


class ApplianceSubjectTest(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.repo = self.root / "repo"
        self.repo.mkdir()
        git(self.repo, "init", "-q", "--initial-branch=main")
        git(self.repo, "config", "user.name", "Subject fixture")
        git(self.repo, "config", "user.email", "subject@example.invalid")
        (self.repo / ".gitignore").write_text(".agents/\n")
        (self.repo / "VERSION").write_text("0.1.7\n")
        (self.repo / "image/appliance").mkdir(parents=True)
        (self.repo / "image/appliance/Containerfile").write_text("FROM scratch\n")
        git(self.repo, "add", ".")
        git(self.repo, "commit", "-qm", "committed appliance source")
        self.revision = git(self.repo, "rev-parse", "HEAD")

    def make_snapshot(self, name: str) -> Path:
        snapshot = self.root / name
        snapshot.mkdir()
        archive = subprocess.run(
            ["git", "archive", self.revision],
            cwd=self.repo,
            check=True,
            stdout=subprocess.PIPE,
        ).stdout
        subprocess.run(["tar", "-x", "-C", str(snapshot)], input=archive, check=True)
        git(self.repo, "bundle", "create", str(snapshot / ".ci-history.bundle"), "HEAD", "--tags")
        return snapshot

    def verify(self, snapshot: Path, revision: str | None = None) -> subprocess.CompletedProcess[str]:
        return subprocess.run(
            ["bash", str(VERIFY), revision or self.revision],
            cwd=snapshot,
            check=False,
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
        )

    def test_matching_history_bundle_and_tree_are_required(self) -> None:
        clean = self.make_snapshot("clean")
        result = self.verify(clean)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn(self.revision, result.stdout)

        wrong_revision = self.make_snapshot("wrong-revision")
        wrong = self.verify(wrong_revision, "f" * 40)
        self.assertEqual(wrong.returncode, 3)
        self.assertIn("bundle HEAD", wrong.stderr)

        dirty_tree = self.make_snapshot("dirty-tree")
        (dirty_tree / "image/appliance/Containerfile").write_text("FROM scratch\nchanged\n")
        dirty = self.verify(dirty_tree)
        self.assertEqual(dirty.returncode, 3)
        self.assertIn("differs from its committed tree", dirty.stderr)

        ignored_project_skill = self.make_snapshot("ignored-project-skill")
        skill = ignored_project_skill / ".agents/skills/review-ci/SKILL.md"
        skill.parent.mkdir(parents=True)
        skill.write_text("uncommitted skill input\n")
        skill_result = self.verify(ignored_project_skill)
        self.assertEqual(skill_result.returncode, 3)
        self.assertIn("differs from its committed tree", skill_result.stderr)


if __name__ == "__main__":
    unittest.main()
