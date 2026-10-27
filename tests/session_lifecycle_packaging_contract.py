#!/usr/bin/env python3
"""Exercise derived-build qualification and integrity gates without network or a build."""
import hashlib
import os
from pathlib import Path
import re
import subprocess
import tarfile
import tempfile
import unittest

ROOT = Path(__file__).resolve().parent.parent


class LifecycleBuildGates(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.work = Path(self.tmp.name)
        self.env = dict(os.environ)
        for name, value in re.findall(r"^ARG (\w+)=(\S+)$", (ROOT / "image/appliance/Containerfile").read_text(), re.M):
            self.env[name] = value
        self.env.update(TMPDIR=str(self.work), OMP_OUTPUT_PATH=str(self.work / "never-installed"))
        for name in ("OMP_PATCH", "OMP_CLIPBOARD_PATCH", "OMP_SESSION_LIFECYCLE_PATCH"):
            path = self.work / (name + ".patch")
            path.write_text(name + " fixture\n")
            self.env[name + "_PATH"] = str(path)
            self.env[name + "_SHA256"] = hashlib.sha256(path.read_bytes()).hexdigest()
        archive = self.work / "source.tar.gz"
        with tarfile.open(archive, "w:gz"):
            pass
        self.env.update(OMP_SOURCE_SHA256=hashlib.sha256(archive.read_bytes()).hexdigest(), FIXTURE_ARCHIVE=str(archive), FIXTURE_TRACE=str(self.work / "trace"))
        commands = self.work / "bin"
        commands.mkdir()
        self.env["PATH"] = str(commands) + ":" + self.env["PATH"]
        for name, body in {
            "git": 'if [ "$1" = ls-remote ]; then printf "%s\\trefs/tags/v%s\\n" "$OMP_SOURCE_COMMIT" "$OMP_VERSION"; else printf "%s\\n" "$*" >> "$FIXTURE_TRACE"; fi',
            "curl": 'case "$*" in *oh-my-pi*) for arg do destination="$arg"; done; cp "$FIXTURE_ARCHIVE" "$destination";; *) echo "fixture reached post-patch boundary" >&2; exit 19;; esac',
        }.items():
            path = commands / name
            path.write_text("#!/bin/sh\nset -eu\n" + body + "\n")
            path.chmod(0o755)

    def run_build(self):
        return subprocess.run(["bash", str(ROOT / "scripts/build-derived-omp.sh")], env=self.env, capture_output=True, text=True)

    def test_source_update_requires_manual_lifecycle_qualification(self):
        self.env["OMP_SESSION_LIFECYCLE_PATCH_SOURCE_COMMIT"] = "0" * 40
        result = self.run_build()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("session lifecycle patch was reviewed for OMP source", result.stderr)
        self.assertFalse((self.work / "trace").exists())

    def test_changed_patch_bytes_are_rejected_before_application(self):
        Path(self.env["OMP_SESSION_LIFECYCLE_PATCH_PATH"]).write_text("tampered\n")
        result = self.run_build()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("OMP session lifecycle patch digest mismatch", result.stderr)
        self.assertNotIn(self.env["OMP_SESSION_LIFECYCLE_PATCH_PATH"], (self.work / "trace").read_text())

    def test_verified_patch_is_checked_then_applied_after_clipboard(self):
        result = self.run_build()
        self.assertEqual(result.returncode, 19, result.stderr)
        self.assertIn("fixture reached post-patch boundary", result.stderr)
        trace = (self.work / "trace").read_text()
        clipboard = 'apply ' + self.env["OMP_CLIPBOARD_PATCH_PATH"]
        check = 'apply --check ' + self.env["OMP_SESSION_LIFECYCLE_PATCH_PATH"]
        apply = 'apply ' + self.env["OMP_SESSION_LIFECYCLE_PATCH_PATH"]
        self.assertLess(trace.index(clipboard), trace.index(check))
        self.assertLess(trace.index(check), trace.index(apply))
        self.assertFalse(Path(self.env["OMP_OUTPUT_PATH"]).exists())


if __name__ == "__main__":
    unittest.main()
