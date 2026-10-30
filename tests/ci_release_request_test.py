"""Exercise release-plan authority and the explicit host mutation boundary."""

import base64
import contextlib
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch
from importlib.machinery import SourceFileLoader


ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_loader("github_release_request", SourceFileLoader("github_release_request", str(ROOT / "scripts/ci/github-release-request")))
REQUEST = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(REQUEST)


def sha(data):
    return hashlib.sha256(data).hexdigest()


class ReleaseRequestBoundaryTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix="review-release-request-test-")
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        (self.root / "VERSION").write_text("0.1.7\n")
        (self.root / "CHANGELOG.md").write_text("# Changelog\n\n## [0.1.7]\n\nCurrent.\n")
        (self.root / "unrelated.txt").write_text("preserve\n")
        self.git("init", "-q")
        self.git("config", "user.name", "Fixture")
        self.git("config", "user.email", "fixture@example.invalid")
        self.git("add", "VERSION", "CHANGELOG.md", "unrelated.txt")
        self.git("commit", "-qm", "feat: stable baseline")
        self.git("tag", "v0.1.5")
        self.git("commit", "--allow-empty", "-qm", "fix: current source")
        self.source_sha = self.git("rev-parse", "HEAD").strip()
        self.baseline_sha = self.git("rev-parse", "v0.1.5^{commit}").strip()
        self.releases = [{"tag_name": "v0.1.5", "draft": False, "prerelease": False}]
        self.tags = [{"name": "v0.1.5", "objectSha": self.baseline_sha, "commitSha": self.baseline_sha}]
        self.plan = self.valid_plan()

    def git(self, *args):
        return subprocess.check_output(["git", "-C", str(self.root), *args], text=True)

    def valid_plan(self):
        old_changelog = (self.root / "CHANGELOG.md").read_bytes()
        new_changelog = b"# Changelog\n\n## [0.1.8]\n\nGenerated.\n\n## [0.1.7]\n\nCurrent.\n"
        old_version = (self.root / "VERSION").read_bytes()
        new_version = b"0.1.8\n"
        files = []
        for name, old, new in (("CHANGELOG.md", old_changelog, new_changelog), ("VERSION", old_version, new_version)):
            files.append({
                "path": name,
                "mode": "0644",
                "expectedSha256": sha(old),
                "newSha256": sha(new),
                "newContentBase64": base64.b64encode(new).decode(),
            })
        releases = REQUEST.normalize_releases(self.releases)
        return {
            "schemaVersion": 1,
            "sourceSha": self.source_sha,
            "currentVersion": "0.1.7",
            "requestedVersion": "0.1.8",
            "plannedTag": "v0.1.8",
            "publishedStableBaseline": {"tag": "v0.1.5", "commit": self.baseline_sha, "objectSha": self.baseline_sha},
            "supersedesUnpublishedVersion": True,
            "observed": {
                "releaseMetadataSha256": sha(REQUEST.canonical_json(releases)),
                "knownTagsSha256": sha(REQUEST.canonical_json(sorted(self.tags, key=lambda item: item["name"]))),
            },
            "files": files,
            "patchDigest": sha(REQUEST.canonical_json(files)),
            "publish": False,
        }

    def validate(self, plan=None, *, tags=None, source_sha=None):
        tags = self.tags if tags is None else tags
        return REQUEST.validate_plan(plan or self.plan, source_sha=source_sha or self.source_sha,
                                     releases=self.releases, known_tags=tags, root=self.root)

    def test_valid_plan_changes_only_the_two_expected_files(self):
        payloads = self.validate()
        before = (self.root / "unrelated.txt").read_bytes()
        REQUEST.apply_files(payloads, root=self.root)
        self.assertEqual((self.root / "VERSION").read_text(), "0.1.8\n")
        self.assertIn("## [0.1.8]", (self.root / "CHANGELOG.md").read_text())
        self.assertEqual((self.root / "unrelated.txt").read_bytes(), before)
        self.assertEqual({path.name for path in self.root.iterdir() if path.is_file()}, {"VERSION", "CHANGELOG.md", "unrelated.txt"})

    def test_rejects_tampered_plan_and_disallowed_paths(self):
        tampered = json.loads(json.dumps(self.plan))
        tampered["files"][0]["newContentBase64"] = base64.b64encode(b"modified").decode()
        with self.assertRaisesRegex(ValueError, "content hash mismatch"):
            self.validate(tampered)
        tampered = json.loads(json.dumps(self.plan))
        tampered["files"][0]["path"] = "scripts/evil.sh"
        with self.assertRaisesRegex(ValueError, "disallowed path"):
            self.validate(tampered)

    def test_rejects_old_head_dirty_target_bad_baseline_and_tag_reuse(self):
        with self.assertRaisesRegex(ValueError, "source identity"):
            self.validate(source_sha="0" * 40)
        with self.assertRaisesRegex(ValueError, "baseline tag identity"):
            plan = json.loads(json.dumps(self.plan))
            plan["publishedStableBaseline"]["commit"] = "0" * 40
            self.validate(plan)
        with self.assertRaisesRegex(ValueError, "already exists"):
            tags = self.tags + [{"name": "v0.1.8", "objectSha": "1" * 40, "commitSha": "1" * 40}]
            plan = self.valid_plan()
            plan["observed"]["knownTagsSha256"] = sha(REQUEST.canonical_json(sorted(tags, key=lambda item: item["name"])))
            self.validate(plan, tags=tags)
        (self.root / "VERSION").write_text("0.1.9\n")
        with self.assertRaisesRegex(ValueError, "changed since planning"):
            self.validate()

    def test_source_identity_rejects_dirty_tree_and_remote_observation_errors_fail(self):
        with patch.object(REQUEST, "ROOT", self.root):
            self.git("config", "remote.origin.url", "https://github.com/joshyorko/review")
            # repository_identity requires a main branch and a clean source checkout.
            self.git("branch", "-M", "main")
            (self.root / "VERSION").write_text("dirty\n")
            with self.assertRaisesRegex(ValueError, "must be clean"):
                REQUEST.repository_identity(self.root)
        with patch.object(REQUEST, "command", side_effect=RuntimeError("API unavailable")):
            with self.assertRaisesRegex(RuntimeError, "API unavailable"):
                REQUEST.observe("gh", self.root)

    def test_default_mode_emits_plan_without_applying_or_writing_files(self):
        before = {name: (self.root / name).read_bytes() for name in ("VERSION", "CHANGELOG.md", "unrelated.txt")}
        output = io.StringIO()
        error = io.StringIO()
        with patch.object(REQUEST, "ROOT", self.root), \
             patch.object(REQUEST, "repository_identity", return_value=self.source_sha), \
             patch.object(REQUEST, "observe", return_value=(self.releases, self.tags, self.source_sha)), \
             patch.object(REQUEST, "load_plan", return_value=self.plan), \
             patch.object(REQUEST, "validate_plan", return_value=self.validate()), \
             patch.object(REQUEST, "remote_release_conflict"), \
             patch.object(REQUEST, "apply_request") as apply_request, \
             patch.object(REQUEST.shutil, "which", return_value="/fake/gh"), \
             patch.object(REQUEST.sys, "argv", ["github-release-request", "--requested-version", "0.1.8"]), \
             patch.dict(os.environ, {"GITHUB_REPOSITORY": "joshyorko/review"}, clear=False), \
             contextlib.redirect_stdout(output), contextlib.redirect_stderr(error):
            self.assertEqual(REQUEST.main(), 0)
        apply_request.assert_not_called()
        self.assertEqual(json.loads(output.getvalue())["publish"], False)
        self.assertIn("Dry run only", error.getvalue())
        self.assertEqual(before, {name: (self.root / name).read_bytes() for name in before})

    def test_existing_branch_or_pr_is_an_honest_conflict(self):
        result = subprocess.CompletedProcess([], 1, "", "")
        exists = subprocess.CompletedProcess([], 0, "deadbeef\trefs/heads/release/v0.1.8\n", "")
        with patch.object(REQUEST, "command", side_effect=[result, exists]):
            with self.assertRaisesRegex(ValueError, "already exists"):
                REQUEST.remote_release_conflict("gh", "release/v0.1.8", root=self.root)
        absent = subprocess.CompletedProcess([], 1, "", "")
        no_remote_branch = subprocess.CompletedProcess([], 0, "", "")
        has_pr = subprocess.CompletedProcess([], 0, '[{"number": 12}]', "")
        with patch.object(REQUEST, "command", side_effect=[absent, no_remote_branch, has_pr]):
            with self.assertRaisesRegex(ValueError, "PR.*already exists"):
                REQUEST.remote_release_conflict("gh", "release/v0.1.8", root=self.root)

    def test_tag_observation_preserves_tag_object_and_peeled_commit_identities(self):
        rows = "\n".join([
            f"{'a' * 40}\trefs/tags/v0.1.5",
            f"{'b' * 40}\trefs/tags/v0.1.5^{{}}",
            f"{'c' * 40}\trefs/tags/v0.1.6",
        ])
        outputs = [
            subprocess.CompletedProcess([], 0, '{"tag_name":"v0.1.5","draft":false,"prerelease":false}\n', ""),
            subprocess.CompletedProcess([], 0, rows, ""),
            subprocess.CompletedProcess([], 0, f"{self.source_sha}\trefs/heads/main\n", ""),
        ]
        with patch.object(REQUEST, "command", side_effect=outputs):
            releases, tags, main_sha = REQUEST.observe("gh", self.root)
        self.assertEqual(main_sha, self.source_sha)
        self.assertEqual([tag["name"] for tag in tags], ["v0.1.5", "v0.1.6"])
        self.assertEqual(tags[0], {"name": "v0.1.5", "objectSha": "a" * 40, "commitSha": "b" * 40})
        self.assertEqual(tags[1]["commitSha"], "c" * 40)

    def test_workflow_keeps_request_logic_in_the_host_adapter(self):
        workflow = (ROOT / ".github/workflows/request-release.yml").read_text()
        self.assertIn("dagger/dagger-for-github@27b130bf0f79a7f6fbbbe0fbca6760dc9bb40a77", workflow)
        self.assertIn("module: .dagger/release-request", workflow)
        self.assertIn("run: python3 scripts/ci/github-release-request --apply", workflow)
        self.assertNotIn("gh pr create", workflow)
        self.assertNotIn("gh workflow run", workflow)


if __name__ == "__main__":
    unittest.main()
