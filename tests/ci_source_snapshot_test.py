from __future__ import annotations

import importlib.util
import subprocess
import tempfile
import unittest
from pathlib import Path


MODULE_PATH = Path(__file__).resolve().parents[1] / "scripts/ci/source-snapshot.py"
SPEC = importlib.util.spec_from_file_location("source_snapshot", MODULE_PATH)
assert SPEC and SPEC.loader
source_snapshot = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(source_snapshot)


def git(root: Path, *args: str) -> str:
    return subprocess.run(
        ["git", *args], cwd=root, check=True, text=True, stdout=subprocess.PIPE
    ).stdout.strip()


class SourceSnapshotTest(unittest.TestCase):
    def test_preserves_tracked_agent_skill_and_current_worktree_paths(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary) / "repo"
            destination = Path(temporary) / "snapshot"
            root.mkdir()
            destination.mkdir()
            git(root, "init", "-q", "--initial-branch=main")
            git(root, "config", "user.name", "Snapshot test")
            git(root, "config", "user.email", "snapshot@example.invalid")
            (root / ".gitignore").write_text(".agents/\n")
            (root / ".agents/skills/review-ci").mkdir(parents=True)
            (root / ".agents/skills/review-ci/SKILL.md").write_text("tracked skill\n")
            (root / "old.txt").write_text("old\n")
            (root / "deleted.txt").write_text("delete me\n")
            git(root, "add", ".")
            git(root, "add", "-f", ".agents/skills/review-ci/SKILL.md")
            git(root, "commit", "-qm", "snapshot baseline")
            head = git(root, "rev-parse", "HEAD")
            git(root, "tag", "-a", "v1.0.0", "-m", "annotated release")
            git(root, "tag", "v1.0.1")

            git(root, "switch", "--orphan", "unrelated")
            (root / "unrelated.txt").write_text("separate history\n")
            git(root, "add", "unrelated.txt")
            git(root, "commit", "-qm", "unrelated tag target")
            git(root, "tag", "v9.9.9")
            git(root, "switch", "main")

            (root / "old.txt").write_text("edited\n")
            (root / "deleted.txt").unlink()
            (root / "renamed.txt").write_text("renamed content\n")
            (root / "added.txt").write_text("new file\n")
            (root / ".agents/skills/review-ci/new-helper.py").write_text("untracked but project-owned\n")
            (root / ".agents/session/private.md").parent.mkdir(parents=True)
            (root / ".agents/session/private.md").write_text("private agent data\n")
            (root / ".env.local").write_text("must not enter Dagger\n")
            (root / "__pycache__").mkdir()
            (root / "__pycache__/ignored.pyc").write_bytes(b"cache")

            source_snapshot.create_snapshot(root, destination, include_history=True)

            self.assertEqual(
                (destination / ".agents/skills/review-ci/SKILL.md").read_text(),
                "tracked skill\n",
            )
            self.assertEqual(
                (destination / ".agents/skills/review-ci/new-helper.py").read_text(),
                "untracked but project-owned\n",
            )
            self.assertFalse((destination / ".agents/session/private.md").exists())
            self.assertEqual((destination / "old.txt").read_text(), "edited\n")
            self.assertEqual((destination / "renamed.txt").read_text(), "renamed content\n")
            self.assertEqual((destination / "added.txt").read_text(), "new file\n")
            self.assertFalse((destination / "deleted.txt").exists())
            self.assertFalse((destination / ".env.local").exists())
            self.assertFalse((destination / "__pycache__").exists())
            self.assertFalse((destination / ".git").exists())
            self.assertTrue((destination / ".ci-history.bundle").is_file())
            bundle_repo = Path(temporary) / "bundle-check.git"
            subprocess.run(
                ["git", "clone", "-q", "--bare", str(destination / ".ci-history.bundle"), str(bundle_repo)],
                check=True,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
            )
            self.assertEqual(git(bundle_repo, "rev-parse", "HEAD"), head)
            self.assertEqual(git(bundle_repo, "tag", "--list"), "v1.0.0\nv1.0.1")

    def test_rejects_tracked_secret_paths(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary) / "repo"
            destination = Path(temporary) / "snapshot"
            root.mkdir()
            destination.mkdir()
            git(root, "init", "-q", "--initial-branch=main")
            (root / ".env.production").write_text("secret\n")
            git(root, "add", ".env.production")
            with self.assertRaisesRegex(ValueError, "tracked source matches excluded path policy"):
                source_snapshot.create_snapshot(root, destination)


if __name__ == "__main__":
    unittest.main()
