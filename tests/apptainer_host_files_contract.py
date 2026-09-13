"""Drive the real launchers against minimal-host filesystem and runtime boundaries."""
import itertools
import json
from pathlib import Path
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
HOST_FILES = ("/etc/localtime", "/etc/hosts")


class HostFilesContract(unittest.TestCase):
    def run_launcher(self, launcher, present, dangling=False, kvm=True):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            host = root / "host"
            (host / "etc").mkdir(parents=True)
            for path in present:
                (host / path.lstrip("/")).touch()
            if dangling:
                (host / "etc/localtime").symlink_to("missing-zoneinfo")
            home = root / "home"
            (home / ".config/hive").mkdir(parents=True)
            (home / ".config/gh").mkdir()
            (home / ".omp").mkdir()
            (home / ".gitconfig").touch()
            registration = home / ".config/hive/contributor.env"
            registration.touch()
            registration.chmod(0o600)
            sif = root / "review.sif"
            sif.touch()
            sif.chmod(0o700)
            device = root / "kvm"
            if kvm:
                device.touch()
            tools = root / "bin"
            tools.mkdir()
            runtime = tools / "apptainer"
            runtime.write_text("""#!/usr/bin/env python3
import json, os, sys
with open(os.environ['CALL_RECORD'], 'w') as out:
    json.dump({'argv': sys.argv[1:], 'token': os.environ.get('GH_TOKEN'),
               'github_token': os.environ.get('GITHUB_TOKEN')}, out)
""")
            runtime.chmod(0o700)
            # Only the filesystem probe is replaced. Every launcher branch and
            # emitted runtime argument executes from the checked-in artifact.
            hook = root / "filesystem.sh"
            hook.write_text("""test() {
  if [[ "$#" == 2 && "$1" == -e && ( "$2" == /etc/localtime || "$2" == /etc/hosts ) ]]; then
    builtin test -e "$HOST_FIXTURE$2"
  else
    builtin test "$@"
  fi
}
""")
            record = root / "call.json"
            env = {"PATH": f"{tools}:/usr/bin:/bin", "HOME": str(home),
                   "XDG_STATE_HOME": str(root / "state"), "BASH_ENV": str(hook),
                   "HOST_FIXTURE": str(host), "CALL_RECORD": str(record),
                   "GH_TOKEN": "fixture-token", "BLUEFIN_KVM_DEVICE": str(device),
                   "BLUEFIN_REVIEW_SIF": str(sif), "BLUEFIN_CONTRIBUTE_SIF": str(sif)}
            args = [str(ROOT / "bin" / launcher)]
            if launcher == "bluefin":
                args += ["review", "owner/repo", "1284"]
            else:
                args += ["--fixture-argument"]
            result = subprocess.run(args, env=env, capture_output=True, text=True)
            if not kvm:
                self.assertNotEqual(result.returncode, 0)
                self.assertIn("KVM is required", result.stderr)
                self.assertFalse(record.exists())
                return
            self.assertEqual(result.returncode, 0, result.stderr)
            call = json.loads(record.read_text())
            argv = call["argv"]
            disabled = [argv[i+1] for i, arg in enumerate(argv) if arg == "--no-mount"]
            self.assertEqual(disabled, [p for p in HOST_FILES if p not in present])
            self.assertEqual(argv[0], "run")
            self.assertIn(str(sif), argv)
            self.assertEqual(call["token"], "fixture-token")
            self.assertEqual(call["github_token"], "fixture-token")
            self.assertIn(f"{home}/.config/gh:/home/bluefin/.config/gh:ro", argv)
            if launcher == "bluefin":
                self.assertEqual(argv[-4:], ["--repo", "owner/repo", "--pr", "1284"])
                self.assertIn(f"{home}/.gitconfig:/home/bluefin/.gitconfig:ro", argv)
            else:
                self.assertEqual(argv[-1], "--fixture-argument")
                self.assertIn(f"{registration}:/home/bluefin/.config/hive/contributor.env:ro", argv)
                self.assertIn(f"{home}/.omp:/home/bluefin/.omp:rw", argv)

    def test_only_missing_host_files_are_suppressed(self):
        for launcher, mask in itertools.product(("bluefin", "bluefin-contribute"), range(4)):
            present = [path for i, path in enumerate(HOST_FILES) if mask & (1 << i)]
            with self.subTest(launcher=launcher, present=present):
                self.run_launcher(launcher, present)

    def test_dangling_localtime_symlink_is_also_absent(self):
        self.run_launcher("bluefin", ["/etc/hosts"], dangling=True)

    def test_missing_host_files_do_not_bypass_kvm_gate(self):
        for launcher in ("bluefin", "bluefin-contribute"):
            with self.subTest(launcher=launcher):
                self.run_launcher(launcher, [], kvm=False)


if __name__ == "__main__":
    unittest.main()
