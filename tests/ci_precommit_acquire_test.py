from __future__ import annotations

import os
import subprocess
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
HELPER = ROOT / ".dagger/install-precommit-hooks.sh"


class PreCommitAcquisitionTest(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory(prefix="precommit-acquire-")
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.bin = self.root / "bin"
        self.bin.mkdir()
        self.calls = self.root / "calls"
        self.stub = self.bin / "pre-commit"
        self.stub.write_text(
            "#!/usr/bin/env python3\n"
            "import os, pathlib, sys\n"
            "calls = pathlib.Path(os.environ['STUB_CALLS'])\n"
            "count = int(calls.read_text()) + 1 if calls.exists() else 1\n"
            "calls.write_text(str(count))\n"
            "pathlib.Path(os.environ['STUB_ARGS']).write_text(repr(sys.argv[1:]))\n"
            "mode = os.environ['STUB_MODE']\n"
            "if mode == 'transient-then-pass' and count == 1:\n"
            " print('first-download-failure')\n"
            " print('stream error: stream ID 15; INTERNAL_ERROR; received from peer', file=sys.stderr)\n"
            " sys.exit(17)\n"
            "if mode == 'always-transient':\n"
            " print(f'network-attempt-{count}')\n"
            " print('connection reset by peer', file=sys.stderr)\n"
            " sys.exit(19)\n"
            "if mode == 'deterministic':\n"
            " print('invalid hook manifest; checksum mismatch')\n"
            " sys.exit(7)\n"
            "print('hook environments ready')\n"
        )
        self.stub.chmod(0o755)
        self.config = self.root / "config with ; metacharacters.yaml"
        self.config.write_text("repos: []\n")
        self.args_log = self.root / "args"
        self.log_tmp = self.root / "temporary-files"
        self.log_tmp.mkdir()

    def run_helper(self, mode: str) -> tuple[subprocess.CompletedProcess[str], int]:
        count_before = int(self.calls.read_text()) if self.calls.exists() else 0
        env = os.environ.copy()
        env.update(
            {
                "PATH": f"{self.bin}{os.pathsep}{env['PATH']}",
                "STUB_MODE": mode,
                "STUB_CALLS": str(self.calls),
                "STUB_ARGS": str(self.args_log),
                "PRE_COMMIT_HOME": "do-not-print-this-value",
                "TMPDIR": str(self.log_tmp),
            }
        )
        result = subprocess.run(
            ["bash", str(HELPER), str(self.config)],
            text=True,
            capture_output=True,
            env=env,
            check=False,
        )
        count_after = int(self.calls.read_text()) if self.calls.exists() else 0
        count = count_after - count_before
        self.assertEqual(list(self.log_tmp.iterdir()), [])
        return result, count

    def test_retries_classified_download_failure_then_succeeds(self) -> None:
        result, calls = self.run_helper("transient-then-pass")

        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(calls, 2)
        self.assertIn("first-download-failure", result.stdout)
        self.assertIn("INTERNAL_ERROR", result.stderr)
        self.assertIn("hook environments ready", result.stdout)
        self.assertEqual(
            self.args_log.read_text(),
            repr(["install-hooks", "--config", str(self.config)]),
        )
        self.assertNotIn("do-not-print-this-value", result.stdout + result.stderr)

    def test_caps_retries_and_preserves_last_exit_status(self) -> None:
        result, calls = self.run_helper("always-transient")

        self.assertEqual(result.returncode, 19)
        self.assertEqual(calls, 3)
        self.assertIn("network-attempt-1", result.stdout)
        self.assertIn("network-attempt-3", result.stdout)
        self.assertIn("3/3", result.stderr)

    def test_deterministic_error_is_not_retried(self) -> None:
        result, calls = self.run_helper("deterministic")

        self.assertEqual(result.returncode, 7)
        self.assertEqual(calls, 1)
        self.assertIn("invalid hook manifest", result.stdout)
        self.assertIn("checksum mismatch", result.stdout)
        self.assertNotIn("retrying", result.stderr.lower())


if __name__ == "__main__":
    unittest.main()
