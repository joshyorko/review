"""Committed snapshot and failure-boundary contracts for the local Brew helper."""
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest

SCRIPT = Path(__file__).resolve().parents[1] / "scripts/brew-dev"


class BrewDevContract(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.repo = self.root / "repo with spaces"
        self.repo.mkdir()
        self.git("init", "-q", "-b", "main")
        self.git("config", "user.name", "fixture")
        self.git("config", "user.email", "fixture@example.invalid")
        (self.repo / "scripts").mkdir()
        shutil.copy2(SCRIPT, self.repo / "scripts/brew-dev")
        (self.repo / "scripts/parse-review-args.sh").write_text("#!/bin/sh\n")
        (self.repo / "scripts/review-appliance-version.sh").write_text("#!/bin/sh\nprintf '26.08.07\\n'\n")
        (self.repo / "bin").mkdir()
        (self.repo / "bin/bluefin").write_text("#!/bin/sh\necho committed-launcher\n")
        (self.repo / "image/appliance").mkdir(parents=True)
        (self.repo / "image/appliance/Containerfile").write_text("FROM scratch\n")
        self.git("add", ".")
        self.git("commit", "-qm", "fixture")
        self.sha = self.git("rev-parse", "HEAD").strip()
        tools = self.root / "tools"
        tools.mkdir()
        self.calls = self.root / "calls"
        for name, body in {
            "brew": 'case "$1" in --prefix) echo "$FIXTURE_ROOT/prefix";; --repository) echo "$FIXTURE_ROOT/brew";; *) echo "$*" >> "$FIXTURE_CALLS"; exit 9;; esac',
            "apptainer": "exit 9",
            "podman": 'if [[ "$1" == build ]]; then printf "%s\\n" "$*" > "$FIXTURE_ROOT/build-args"; cat bin/bluefin > "$FIXTURE_ROOT/snapshot-launcher"; exit 42; fi',
        }.items():
            p = tools / name
            p.write_text("#!/usr/bin/env bash\nset -eu\n" + body + "\n")
            p.chmod(0o755)
        self.env = dict(os.environ, PATH=f"{tools}:{os.environ['PATH']}",
                        XDG_DATA_HOME=str(self.root / "data"),
                        FIXTURE_ROOT=str(self.root), FIXTURE_CALLS=str(self.calls))

    def git(self, *args):
        return subprocess.check_output(["git", "-C", str(self.repo), *args], text=True)

    def run_cli(self, *args):
        return subprocess.run([str(self.repo / "scripts/brew-dev"), *args],
                              cwd=self.repo, env=self.env, capture_output=True, text=True)

    def test_unknown_ref_has_no_package_or_build_side_effect(self):
        result = self.run_cli("build", "missing-ref")
        self.assertNotEqual(result.returncode, 0)
        self.assertFalse(self.calls.exists())
        self.assertFalse((self.root / "build-args").exists())

    def test_dirty_current_checkout_is_not_mislabeled_as_a_commit(self):
        (self.repo / "bin/bluefin").write_text("dirty-launcher")
        result = self.run_cli("build")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("commit", result.stderr.lower())
        self.assertFalse((self.root / "build-args").exists())

    def test_explicit_ref_builds_archived_bytes_and_preserves_dirty_checkout(self):
        launcher = self.repo / "bin/bluefin"
        launcher.write_text("dirty-launcher")
        result = self.run_cli("build", "main")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("committed-launcher", (self.root / "snapshot-launcher").read_text())
        self.assertIn(self.sha, (self.root / "build-args").read_text())
        self.assertEqual(launcher.read_text(), "dirty-launcher")
        self.assertFalse(self.calls.exists())
        self.assertFalse(list((self.root / "data").rglob(".build.*")))

    def test_remote_branch_resolves_without_creating_a_local_branch(self):
        self.git("update-ref", "refs/remotes/origin/feature", self.sha)
        result = self.run_cli("build", "feature")
        self.assertNotEqual(result.returncode, 0)  # build stub stops before packaging
        self.assertIn(self.sha, (self.root / "build-args").read_text())
        self.assertIn("committed-launcher", (self.root / "snapshot-launcher").read_text())
        self.assertEqual(self.git("branch", "--show-current").strip(), "main")

    def test_invalid_bundle_cannot_publish(self):
        result = self.run_cli("publish", str(self.root / "missing-bundle"))
        self.assertNotEqual(result.returncode, 0)
        self.assertFalse(self.calls.exists())

    def test_package_carries_parser_and_resolves_its_libexec_root(self):
        script = SCRIPT.read_text()
        self.assertIn("parse-review-args.sh", script)
        self.assertIn('")/../.."', script)
        self.assertIn("/usr/bin/headroom", script)

    def test_personal_workflow_builds_the_default_branch(self):
        workflow = (SCRIPT.parents[1] / ".github/workflows/review-dev.yml").read_text()
        self.assertIn("default: main", workflow)
        self.assertNotIn("feat/brew-dev-dogfood", workflow)


class FormulaContract(unittest.TestCase):
    def setUp(self):
        import importlib.util
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.output = self.root / "output"
        spec = importlib.util.spec_from_file_location("brew_formula", SCRIPT.with_name("brew-dev-formula.py"))
        self.module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(self.module)

    def bundle(self, arch, sha="a" * 40):
        import hashlib
        data = ("fixture " + arch).encode()
        (self.root / f"bluefin-review-dev-{arch}.tar.gz").write_bytes(data)
        record = {"ref": "feature/example", "sha": sha, "arch": arch,
                  "archive_sha256": hashlib.sha256(data).hexdigest()}
        (self.root / f"manifest-{arch}.json").write_text(json.dumps(record))

    def test_both_native_architectures_share_one_version_and_sha(self):
        for arch in ["x86_64", "aarch64"]:
            self.bundle(arch)
        self.module.prepare(self.root, self.output)
        formula = (self.output / "bluefin-review-dev.rb").read_text()
        self.assertIn("on_intel do", formula)
        self.assertIn("on_arm do", formula)
        self.assertIn('depends_on "gh"', formula)
        self.assertIn('depends_on "squashfuse"', formula)
        self.assertEqual((self.output / "sha").read_text().strip(), "a" * 40)
        self.assertEqual(formula.count("version "), 1)
        self.assertNotIn("projectbluefin/review/releases", formula)

    def test_mixed_source_commits_cannot_be_published_together(self):
        self.bundle("x86_64")
        self.bundle("aarch64", "b" * 40)
        with self.assertRaisesRegex(ValueError, "one source"):
            self.module.prepare(self.root, self.output)
        self.assertFalse(self.output.exists())

    def test_corrupt_archive_is_rejected_before_formula_is_written(self):
        self.bundle("x86_64")
        (self.root / "bluefin-review-dev-x86_64.tar.gz").write_bytes(b"changed")
        with self.assertRaisesRegex(ValueError, "checksum"):
            self.module.prepare(self.root, self.output)
        self.assertFalse(self.output.exists())

    def test_unidentified_archive_is_not_uploaded(self):
        self.bundle("x86_64")
        (self.root / "bluefin-review-dev-aarch64.tar.gz").write_bytes(b"unidentified")
        with self.assertRaisesRegex(ValueError, "match exactly"):
            self.module.prepare(self.root, self.output)


if __name__ == "__main__":
    unittest.main()
