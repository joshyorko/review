"""Contract tests for the credential-free Dagger release request planner."""

import importlib.util
import json
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest


ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location("release_request_plan", ROOT / "scripts/ci/release-request-plan.py")
PLANNER = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(PLANNER)


class ReleaseRequestPlanTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix="review-release-plan-test-")
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.source = self.root / "source"
        self.source.mkdir()
        (self.source / "scripts").mkdir()
        shutil.copy2(ROOT / "scripts/review-changelog.py", self.source / "scripts")
        shutil.copy2(ROOT / "scripts/validate-release-version.py", self.source / "scripts")
        shutil.copy2(ROOT / "cliff.toml", self.source)
        (self.source / "VERSION").write_text("0.1.7\n")
        (self.source / "CHANGELOG.md").write_text("# Changelog\n\n## [0.1.7]\n\nExisting notes.\n")
        (self.source / "bin").mkdir()
        cliff = self.source / "bin/git-cliff"
        cliff.write_text("""#!/usr/bin/env python3
import sys
if sys.argv[1:] == ["--version"]:
    print("git-cliff 2.14.2")
else:
    version = sys.argv[sys.argv.index("--tag") + 1].removeprefix("v")
    print(f"## [{version}]\\n\\n### Bug fixes\\n\\n- Recovery note.")
""")
        cliff.chmod(0o755)
        self.env_path = f"{self.source / 'bin'}:{__import__('os').environ['PATH']}"
        self.repo = self.root / "history-source"
        self.repo.mkdir()
        self.git("init", "-q")
        self.git("config", "user.name", "Fixture")
        self.git("config", "user.email", "fixture@example.invalid")
        self.git("commit", "--allow-empty", "-qm", "feat: published 0.1.5")
        self.git("tag", "v0.1.5")
        self.git("commit", "--allow-empty", "-qm", "fix: failed release 0.1.7 recovery")
        self.git("tag", "v0.1.7")
        self.git("bundle", "create", str(self.root / "history.bundle"), "HEAD", "v0.1.5", "v0.1.7")
        self.source_sha = self.git("rev-parse", "HEAD").strip()
        self.tags = [{"name": tag, "objectSha": self.git("rev-parse", f"refs/tags/{tag}").strip(),
                      "commitSha": self.git("rev-parse", f"refs/tags/{tag}^{{commit}}").strip()}
                     for tag in ("v0.1.5", "v0.1.7")]

    def git(self, *args):
        return subprocess.check_output(["git", "-C", str(self.repo), *args], text=True)

    def build(self, requested="patch", releases=None, known_tags=None, source_sha=None):
        import os
        old = os.environ.get("PATH", "")
        os.environ["PATH"] = self.env_path
        try:
            return PLANNER.plan(
                self.source,
                self.root / "history.bundle",
                requested,
                json.dumps(releases if releases is not None else [
                    {"tag_name": "v0.1.7", "draft": False, "prerelease": False}
                ]),
                json.dumps(known_tags if known_tags is not None else self.tags),
                source_sha or self.source_sha,
            )
        finally:
            os.environ["PATH"] = old

    def test_unpublished_current_version_supersedes_failed_release_and_uses_published_head(self):
        plan = self.build(releases=[
            {"tag_name": "v0.1.7-rc.1", "draft": False, "prerelease": True},
            {"tag_name": "v0.1.5", "draft": False, "prerelease": False},
        ])
        self.assertEqual(plan["requestedVersion"], "0.1.8")
        self.assertEqual(plan["publishedStableBaseline"]["tag"], "v0.1.5")
        self.assertTrue(plan["supersedesUnpublishedVersion"])

    def test_current_published_version_requests_next_patch_and_limits_patch_paths(self):
        plan = self.build()
        self.assertEqual(plan["sourceSha"], self.source_sha)
        self.assertEqual(plan["requestedVersion"], "0.1.8")
        self.assertEqual(plan["plannedTag"], "v0.1.8")
        self.assertFalse(plan["publish"])
        self.assertEqual({item["path"] for item in plan["files"]}, {"VERSION", "CHANGELOG.md"})
        files = {item["path"]: item for item in plan["files"]}
        self.assertNotEqual(files["CHANGELOG.md"]["expectedSha256"], files["CHANGELOG.md"]["newSha256"])
        self.assertNotEqual(files["VERSION"]["expectedSha256"], files["VERSION"]["newSha256"])

    def test_rejects_unpublished_or_duplicate_known_tag_as_reuse(self):
        with self.assertRaisesRegex(ValueError, "already exists"):
            self.build(known_tags=self.tags + [{"name": "v0.1.8", "objectSha": "1" * 40, "commitSha": "1" * 40}])

    def test_rejects_missing_published_ancestor_and_invalid_api_data(self):
        with self.assertRaisesRegex(ValueError, "no published stable release tag is an ancestor"):
            self.build(releases=[])
        with self.assertRaisesRegex(ValueError, "boolean draft and prerelease"):
            self.build(releases=[{"tag_name": "v0.1.7", "draft": "false", "prerelease": False}])

    def test_rejects_stale_source_bundle_identity(self):
        with self.assertRaisesRegex(ValueError, "source identity mismatch"):
            self.build(source_sha="0" * 40)


if __name__ == "__main__":
    unittest.main()
