#!/usr/bin/env python3
"""Exercise host launch intent against the real launcher, without isolation runtimes."""

import json
import os
from pathlib import Path
import pty
import secrets
import select
import signal
import subprocess
import tempfile
import time
import unittest


REPO = Path(__file__).resolve().parents[1]
LAUNCHER = REPO / "bin/bluefin"
PROFILE = """version=1
runtime=auto
github_auth=auto
inherit_omp=false
factory_enabled=false
factory_capacity=2
env_groups=aws-sdk,typesafe
env_names=
"""

RUNTIME = r'''#!/usr/bin/python3
import json, os, sys
from pathlib import Path
tool = Path(sys.argv[0]).name
args = sys.argv[1:]
with open(os.environ["FIXTURE_CALLS"], "a") as f:
    f.write(json.dumps({"tool": tool, "args": args}) + "\n")
if tool == "podman":
    if args[0] in ("info", "system", "pull"): sys.exit(0)
    if args[:2] == ["image", "exists"]: sys.exit(0)
    if args[:2] == ["image", "inspect"]:
        print("unknown|fixture|sha256:fixture"); sys.exit(0)
else:
    if args[0] == "inspect":
        print('{"data":{"attributes":{"labels":{}}}}'); sys.exit(0)
if "--entrypoint" in args: sys.exit(0)
if "--factory-verifier-probe" in args:
    print('{"kind":"review-factory-verifier","status":"available"}'); sys.exit(0)
if tool == "podman":
    forwarded = {}
    for i, arg in enumerate(args[:-1]):
        if arg == "--env":
            name, sep, value = args[i + 1].partition("=")
            if sep or name in os.environ:
                forwarded[name] = value if sep else os.environ[name]
else:
    forwarded = {k.removeprefix("SINGULARITYENV_"): v for k,v in os.environ.items()
                 if k.startswith("SINGULARITYENV_")}
    forwarded.update({k.removeprefix("APPTAINERENV_"): v for k,v in os.environ.items()
                      if k.startswith("APPTAINERENV_")})
controls = {k: forwarded.get(k) for k in ("LUNA_FACTORY_ENABLED", "LUNA_FACTORY_CAPACITY", "REVIEW_INHERIT_OMP_CONFIG")}
print(json.dumps({"runtime": tool, "args": args, "names": sorted(forwarded), "controls": controls,
                  "stored_authority": forwarded.get("GH_TOKEN") == os.environ["FIXTURE_STORED_TOKEN"],
                  "environment_authority": forwarded.get("GH_TOKEN") == os.environ.get("FIXTURE_ENV_TOKEN"),
                  "same_authority": forwarded.get("GH_TOKEN") == forwarded.get("GITHUB_TOKEN")}))
'''

RENAME_INTERRUPTION = r'''#!/usr/bin/python3
import os, signal, subprocess, sys
from pathlib import Path
destination = sys.argv[-1]
mode = os.environ["FIXTURE_RENAME_MODE"]
marker = Path(os.environ["FIXTURE_RENAME_MARKER"])
matching = ((mode.startswith("profile") and destination.endswith("personal.profile")) or
            (mode.startswith("default") and destination.endswith("/default")))
inject = matching and not marker.exists()
if inject and mode.endswith("fail"):
    marker.touch()
    sys.exit(19)
if inject and mode.endswith("before"):
    marker.touch()
    signal.pause()
subprocess.run(["/usr/bin/mv", *sys.argv[1:]], check=True)
if inject and mode.endswith("after"):
    marker.touch()
    signal.pause()
'''


class LauncherProfilesContract(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix="review-launch-profiles-")
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        tools = self.root / "tools"
        tools.mkdir()
        self.calls_path = self.root / "calls"
        self.env_token = secrets.token_hex(24)
        self.stored_token = secrets.token_hex(24)
        self.provider_token = secrets.token_hex(24)
        self.env = dict(PATH=f"{tools}:/usr/bin:/bin", HOME=str(self.root / "home"),
                        XDG_CONFIG_HOME=str(self.root / "config"), XDG_STATE_HOME=str(self.root / "state"),
                        REVIEW_APPLIANCE_IMAGE="example.invalid/review:fixture", GH_TOKEN=self.env_token,
                        FIXTURE_ENV_TOKEN=self.env_token, FIXTURE_STORED_TOKEN=self.stored_token,
                        FIXTURE_CALLS=str(self.calls_path), REVIEW_TEST_KVM_DEVICE=str(self.root / "kvm"),
                        REVIEW_TEST_FUSE_DEVICE="/dev/null", OPENAI_API_KEY=self.provider_token,
                        AWS_ACCESS_KEY_ID=self.provider_token,
                        AWS_SECRET_ACCESS_KEY=self.provider_token, AWS_SESSION_TOKEN=self.provider_token,
                        AWS_REGION="us-east-1")
        self.env["TYPESAFE_API_KEY"] = self.provider_token
        Path(self.env["HOME"]).mkdir()
        Path(self.env["REVIEW_TEST_KVM_DEVICE"]).touch()
        for name in ("podman", "apptainer"):
            path = tools / name
            path.write_text(RUNTIME)
            path.chmod(0o755)
        for name in ("krun", "squashfuse"):
            path = tools / name
            path.write_text("#!/bin/sh\nexit 0\n")
            path.chmod(0o755)
        gh = tools / "gh"
        gh.write_text("""#!/usr/bin/python3
import os, json, sys
with open(os.environ['FIXTURE_CALLS'], 'a') as f:
    f.write(json.dumps({'tool': 'gh', 'args': sys.argv[1:],
                       'ambient_tokens': any(k in os.environ for k in ('GH_TOKEN', 'GITHUB_TOKEN'))}) + '\\n')
if os.environ.get('FIXTURE_NO_LOGIN') == '1': sys.exit(1)
print(os.environ['FIXTURE_STORED_TOKEN'])
""")
        gh.chmod(0o755)
        self.config = Path(self.env["XDG_CONFIG_HOME"]) / "review/launcher"

    def profile(self, **fields):
        lines = dict(line.split("=", 1) for line in PROFILE.splitlines())
        lines.update(fields)
        directory = self.config / "profiles"
        directory.mkdir(parents=True, exist_ok=True)
        path = directory / "personal.profile"
        path.write_text("".join(f"{k}={v}\n" for k, v in lines.items()))
        return path

    def run_launch(self, *args, env=None, ok=True):
        result = subprocess.run([str(LAUNCHER), "review", *args], env=self.env if env is None else env,
                                input="", text=True, capture_output=True, timeout=15)
        output = result.stdout + result.stderr
        for value in (self.env_token, self.stored_token, self.provider_token):
            self.assertNotIn(value, output, "launcher disclosed a credential")
        if ok:
            self.assertEqual(result.returncode, 0, output)
        else:
            self.assertNotEqual(result.returncode, 0, "launcher accepted invalid intent")
        return result

    def receipt(self, result):
        return json.loads(result.stdout.splitlines()[-1])

    def calls(self):
        if not self.calls_path.exists():
            return []
        return [json.loads(line) for line in self.calls_path.read_text().splitlines()]

    def test_explicit_apptainer_never_probes_krun(self):
        result = self.receipt(self.run_launch("--runtime", "apptainer", "owner/repo"))
        self.assertEqual(result["runtime"], "apptainer")
        self.assertFalse(any(c["tool"] == "podman" for c in self.calls()))
        self.assertNotIn("--runtime", result["args"])
        self.assertIn("--containall", result["args"])
        self.assertIn("--no-eval", result["args"])

    def test_explicit_krun_unavailable_never_downgrades(self):
        self.env["REVIEW_TEST_KVM_DEVICE"] = str(self.root / "missing-kvm")
        self.run_launch("--runtime", "krun", "owner/repo", ok=False)
        self.assertFalse(any(c["tool"] == "apptainer" for c in self.calls()))

    def test_profile_enables_factory_with_existing_capacity_contract(self):
        self.profile(factory_enabled="true", factory_capacity="100")
        result = self.receipt(self.run_launch("--launcher-profile", "personal", "owner/repo"))
        self.assertEqual(result["controls"]["LUNA_FACTORY_ENABLED"], "1")
        self.assertEqual(result["controls"]["LUNA_FACTORY_CAPACITY"], "100")
        self.assertEqual(sum("--factory-verifier-probe" in c["args"] for c in self.calls()), 1)

    def test_apptainer_factory_probe_keeps_the_verifier_device_mount(self):
        # The probe intentionally starts with a clean environment, so its
        # controlled executable uses a fixed fixture sink instead of env input.
        tool = self.root / "tools/apptainer"
        probe = """import json, sys
args = sys.argv[1:]
if '--factory-verifier-probe' in args or (args and args[0] == 'exec'):
    with open(%r, 'a') as f:
        f.write(json.dumps({'tool': 'apptainer', 'args': args}) + '\\n')
    if '/dev/full:/dev/full' not in args:
        print('verifier device missing', file=sys.stderr)
        sys.exit(78)
    if '--factory-verifier-probe' in args:
        print('{"kind":"review-factory-verifier","status":"available"}')
    sys.exit(0)
""" % str(self.calls_path)
        tool.write_text(RUNTIME.replace("import json, os, sys\n", probe + "\nimport json, os, sys\n", 1))
        self.profile(runtime="apptainer", factory_enabled="true")
        result = self.receipt(self.run_launch("--launcher-profile", "personal", "owner/repo"))
        self.assertEqual(result["runtime"], "apptainer")
        probes = [c for c in self.calls() if '--factory-verifier-probe' in c['args'] or c['args'][0] == 'exec']
        self.assertEqual(len(probes), 2)
        self.assertTrue(all('/dev/full:/dev/full' in c['args'] for c in probes))

    def test_explicit_environment_zero_disables_profile_factory_and_inheritance(self):
        self.profile(factory_enabled="true", inherit_omp="true")
        self.env.update(LUNA_FACTORY_ENABLED="0", BLUEFIN_REVIEW_INHERIT_OMP_CONFIG="0")
        result = self.receipt(self.run_launch("--launcher-profile", "personal", "owner/repo"))
        self.assertEqual(result["controls"]["LUNA_FACTORY_ENABLED"], "0")
        self.assertEqual(result["controls"]["REVIEW_INHERIT_OMP_CONFIG"], "0")
        self.assertFalse(any("--factory-verifier-probe" in c["args"] for c in self.calls()))

    def test_cli_overrides_environment_and_profile_without_omp_flag_leaks(self):
        self.profile(runtime="krun", factory_capacity="2")
        self.env.update(REVIEW_RUNTIME="krun", LUNA_FACTORY_CAPACITY="3")
        result = self.receipt(self.run_launch("--launcher-profile=personal", "owner/repo", "--runtime=apptainer",
                                             "--factory-capacity", "5", "--profile", "native-profile"))
        self.assertEqual(result["runtime"], "apptainer")
        self.assertEqual(result["controls"]["LUNA_FACTORY_CAPACITY"], "5")
        self.assertIn("native-profile", result["args"])
        self.assertNotIn("--launcher-profile=personal", result["args"])
        self.assertNotIn("--factory-capacity", result["args"])

    def test_default_profile_is_used_without_interactive_setup(self):
        self.profile(runtime="apptainer")
        (self.config / "default").write_text("personal\n")
        self.assertEqual(self.receipt(self.run_launch("owner/repo"))["runtime"], "apptainer")

    def test_environment_profile_selector_and_one_launch_none_override(self):
        self.profile(runtime="apptainer")
        self.env["REVIEW_LAUNCH_PROFILE"] = "personal"
        self.assertEqual(self.receipt(self.run_launch("owner/repo"))["runtime"], "apptainer")
        self.assertEqual(self.receipt(self.run_launch("--launcher-profile", "none", "owner/repo"))["runtime"], "podman")

    def test_explicit_krun_rejects_sif_before_any_runtime(self):
        sif = self.root / "review.sif"
        sif.write_bytes(b"fixture")
        sif.chmod(0o755)
        self.env.pop("REVIEW_APPLIANCE_IMAGE")
        self.env["REVIEW_APPLIANCE_SIF"] = str(sif)
        self.run_launch("--runtime", "krun", "owner/repo", ok=False)
        self.assertEqual(self.calls(), [])

    def test_no_profile_preserves_current_provider_forwarding(self):
        result = self.receipt(self.run_launch("owner/repo"))
        for name in ("OPENAI_API_KEY", "TYPESAFE_API_KEY", "AWS_ACCESS_KEY_ID", "AWS_SESSION_TOKEN"):
            self.assertIn(name, result["names"])

    def test_profile_forwards_only_selected_present_approved_names(self):
        self.profile()
        result = self.receipt(self.run_launch("--launcher-profile", "personal", "owner/repo"))
        self.assertNotIn("OPENAI_API_KEY", result["names"])
        for name in ("TYPESAFE_API_KEY", "AWS_ACCESS_KEY_ID", "AWS_SESSION_TOKEN", "AWS_REGION"):
            self.assertIn(name, result["names"])
        self.assertNotIn("AWS_DEFAULT_REGION", result["names"])

    def test_apptainer_provider_selection_matches_podman_and_clears_ambient_injection(self):
        self.profile()
        podman = self.receipt(self.run_launch("--launcher-profile", "personal", "owner/repo"))
        self.env.update(APPTAINERENV_OPENAI_API_KEY=self.provider_token,
                        APPTAINERENV_FOO_SECRET=self.provider_token,
                        SINGULARITYENV_OPENAI_API_KEY=self.provider_token)
        apptainer = self.receipt(self.run_launch("--launcher-profile", "personal", "--runtime", "apptainer", "owner/repo"))
        self.assertEqual(apptainer["names"], podman["names"])

    def test_advanced_names_are_bounded_to_existing_allowlist(self):
        self.profile(env_groups="", env_names="OPENAI_API_KEY")
        result = self.receipt(self.run_launch("--launcher-profile", "personal", "owner/repo"))
        self.assertIn("OPENAI_API_KEY", result["names"])
        self.assertNotIn("TYPESAFE_API_KEY", result["names"])
        self.profile(env_names="FOO_SECRET")
        self.calls_path.unlink()
        self.run_launch("--launcher-profile", "personal", "owner/repo", ok=False)
        self.assertEqual(self.calls(), [])

    def test_gh_cli_resolves_stored_authority_in_child_only(self):
        self.profile(github_auth="gh-cli")
        self.env["GITHUB_TOKEN"] = self.provider_token
        original = dict(self.env)
        result = self.receipt(self.run_launch("--launcher-profile", "personal", "owner/repo"))
        self.assertTrue(result["stored_authority"])
        self.assertTrue(result["same_authority"])
        self.assertEqual(self.env, original)
        queries = [c for c in self.calls() if c["tool"] == "gh"]
        self.assertEqual(len(queries), 1)
        self.assertFalse(queries[0]["ambient_tokens"])
        self.assertEqual(queries[0]["args"], ["auth", "token", "--hostname", "github.com"])

    def test_selected_environment_authority_does_not_mix_tokens_or_query_gh(self):
        self.profile(github_auth="environment")
        self.env["GITHUB_TOKEN"] = self.provider_token
        result = self.receipt(self.run_launch("--launcher-profile", "personal", "owner/repo"))
        self.assertTrue(result["environment_authority"])
        self.assertTrue(result["same_authority"])
        self.assertFalse(any(c["tool"] == "gh" for c in self.calls()))

    def test_explicit_auto_auth_uses_gh_token_precedence_without_mixing_aliases(self):
        self.env["GITHUB_TOKEN"] = self.provider_token
        result = self.receipt(self.run_launch("--github-auth", "auto", "owner/repo"))
        self.assertTrue(result["environment_authority"])
        self.assertTrue(result["same_authority"])

    def test_missing_selected_auth_sources_refuse_without_fallback(self):
        for source in ("environment", "gh-cli"):
            with self.subTest(source=source):
                self.profile(github_auth=source)
                self.env.pop("GH_TOKEN", None)
                self.env["FIXTURE_NO_LOGIN"] = "1"
                self.calls_path.unlink(missing_ok=True)
                self.run_launch("--launcher-profile", "personal", "owner/repo", ok=False)
                self.assertFalse(any(c["tool"] in ("podman", "apptainer") for c in self.calls()))

    def test_preflight_reports_presence_and_fixed_git_policy_without_authentication_claim(self):
        self.profile(env_groups="aws-sdk,typesafe,gemini")
        result = self.run_launch("--launcher-profile", "personal", "owner/repo")
        self.assertIn("selected / missing", result.stderr)
        self.assertIn("selected / present", result.stderr)
        self.assertIn("not selected", result.stderr)
        self.assertIn("bedrock-bearer: not selected", result.stderr)
        self.assertIn("Luna Factory / factory@localhost", result.stderr)
        self.assertNotIn("authentication succeeded", result.stderr)

    def test_inheritance_keeps_existing_mount_and_persistent_instance_identity(self):
        host_omp = Path(self.env["HOME"]) / ".omp"
        host_omp.mkdir()
        plain = self.receipt(self.run_launch("owner/repo"))
        self.profile(inherit_omp="true")
        configured = self.receipt(self.run_launch("--launcher-profile", "personal", "owner/repo"))
        self.assertIn(f"{host_omp}:/home/bluefin/.omp:rw", configured["args"])
        self.assertEqual([a for a in plain["args"] if ":/workspace:" in a],
                         [a for a in configured["args"] if ":/workspace:" in a])

    def test_bad_or_traversing_profiles_fail_before_runtime_without_echoing_values(self):
        malformed = [PROFILE.replace("version=1", "version=2"),
                     PROFILE.replace("inherit_omp=false", "inherit_omp=maybe"),
                     PROFILE.replace("factory_capacity=2", "factory_capacity=101"),
                     PROFILE.replace("runtime=auto", "runtime=" + self.provider_token),
                     PROFILE + "unknown=" + self.provider_token + "\n",
                     PROFILE + "runtime=auto\n", "version=1\nruntime=auto\n"]
        for contents in malformed:
            with self.subTest(contents=malformed.index(contents)):
                path = self.profile()
                path.write_text(contents)
                self.calls_path.unlink(missing_ok=True)
                self.run_launch("--launcher-profile", "personal", "owner/repo", ok=False)
                self.assertEqual(self.calls(), [])
        self.run_launch("--launcher-profile", "../../outside", "owner/repo", ok=False)

    def test_profile_content_is_never_executed_or_expanded(self):
        marker = self.root / "executed"
        path = self.profile(env_names=f"$(touch {marker})")
        self.run_launch("--launcher-profile", "personal", "owner/repo", ok=False)
        self.assertFalse(marker.exists())
        path.write_text(PROFILE + "`touch " + str(marker) + "`\n")
        self.run_launch("--launcher-profile", "personal", "owner/repo", ok=False)
        self.assertFalse(marker.exists())

    def test_binary_corruption_is_rejected_before_shell_parsing(self):
        path = self.profile()
        for contents in (PROFILE.encode().replace(b"runtime=auto", b"runtime=au\0to"),
                         PROFILE.encode().replace(b"version=1", b"ver\0sion=1"),
                         PROFILE.encode() + b"\0\n"):
            with self.subTest(contents=repr(contents[:30])):
                self.calls_path.unlink(missing_ok=True)
                path.write_bytes(contents)
                self.run_launch("--launcher-profile", "personal", "owner/repo", ok=False)
                self.assertEqual(self.calls(), [])
        path.write_text(PROFILE)
        for contents in (b"per\0sonal\n", b"personal\0unapproved\n"):
            with self.subTest(selector=repr(contents)):
                self.calls_path.unlink(missing_ok=True)
                (self.config / "default").write_bytes(contents)
                self.run_launch("owner/repo", ok=False)
                self.assertEqual(self.calls(), [])

    def test_multiline_capability_intent_is_rejected_without_truncation(self):
        cases = [("--env-groups", "openai\nFOO_SECRET"),
                 ("--env-names", "OPENAI_API_KEY\nFOO_SECRET")]
        for flag, value in cases:
            with self.subTest(flag=flag):
                self.calls_path.unlink(missing_ok=True)
                self.run_launch(flag, value, "owner/repo", ok=False)
                self.assertEqual(self.calls(), [])
        for name, value in (("REVIEW_ENV_GROUPS", "openai\nFOO_SECRET"),
                            ("REVIEW_ENV_NAMES", "OPENAI_API_KEY\nFOO_SECRET")):
            with self.subTest(variable=name):
                self.calls_path.unlink(missing_ok=True)
                env = dict(self.env, **{name: value})
                self.run_launch("owner/repo", env=env, ok=False)
                self.assertEqual(self.calls(), [])

    def test_dangling_default_selector_never_restores_compatibility_authority(self):
        self.profile(runtime="apptainer", github_auth="gh-cli", env_groups="")
        (self.config / "default").symlink_to(self.root / "missing-selector")
        self.run_launch("owner/repo", ok=False)
        self.assertEqual(self.calls(), [])

    def test_configure_refuses_invalid_destinations_before_changing_profile(self):
        path = self.profile()
        original = path.read_bytes()
        destination = self.config / "default"
        outside = self.root / "outside"
        outside.mkdir()
        for kind in ("directory", "directory-link", "dangling-link"):
            with self.subTest(kind=kind):
                path.write_bytes(original)
                if kind == "directory": destination.mkdir()
                elif kind == "directory-link": destination.symlink_to(outside, target_is_directory=True)
                else: destination.symlink_to(self.root / "missing-selector")
                try:
                    status, _ = self.configure_tty("apptainer\n\n\n\n\n\n\ny\ny\n")
                    self.assertNotEqual(status, 0)
                    self.assertEqual(path.read_bytes(), original)
                    self.assertEqual(list(outside.iterdir()), [])
                    if kind == "directory": self.assertEqual(list(destination.iterdir()), [])
                    self.assertEqual(self.calls(), [])
                finally:
                    if kind == "directory":
                        for nested in destination.iterdir(): nested.unlink()
                        destination.rmdir()
                    else: destination.unlink()
                    for nested in outside.iterdir(): nested.unlink()

    def test_profiles_lists_only_intent_without_resolving_credentials_or_starting_runtime(self):
        self.profile()
        result = self.run_launch("profiles")
        self.assertIn("personal", result.stdout)
        self.assertEqual(self.calls(), [])

    def configure_tty(self, answers, interrupt_at=None):
        master, slave = pty.openpty()
        process = subprocess.Popen([str(LAUNCHER), "review", "configure", "personal"], env=self.env,
                                   stdin=slave, stdout=slave, stderr=slave, start_new_session=True)
        os.close(slave)
        os.write(master, answers.encode())
        output = bytearray()
        deadline = time.monotonic() + 15
        interrupted = False
        while time.monotonic() < deadline:
            if select.select([master], [], [], 0.1)[0]:
                try:
                    output.extend(os.read(master, 65536))
                except OSError:
                    break
            if interrupt_at is not None and interrupt_at.exists() and not interrupted:
                os.killpg(process.pid, signal.SIGINT)
                interrupted = True
            if process.poll() is not None:
                break
        if process.poll() is None:
            process.kill()
        process.wait(timeout=5)
        os.close(master)
        if interrupt_at is not None:
            self.assertTrue(interrupted, "did not reach the controlled publication boundary")
        return process.returncode, output.decode(errors="replace")

    def test_save_rolls_back_both_files_on_commit_interruption_or_failure(self):
        path = self.profile()
        original_profile = path.read_bytes()
        (self.config / "profiles/older.profile").write_bytes(original_profile)
        destination = self.config / "default"
        original_default = b"older\n"
        destination.write_bytes(original_default)
        tool = self.root / "tools/mv"
        tool.write_text(RENAME_INTERRUPTION)
        tool.chmod(0o755)
        marker = self.root / "rename-marker"
        self.env["FIXTURE_RENAME_MARKER"] = str(marker)
        for mode in ("profile-after", "default-before", "default-after", "default-fail"):
            with self.subTest(mode=mode):
                path.write_bytes(original_profile)
                destination.write_bytes(original_default)
                marker.unlink(missing_ok=True)
                self.env["FIXTURE_RENAME_MODE"] = mode
                status, _ = self.configure_tty("apptainer\n\n\n\n3\n-\n-\ny\ny\n",
                                               None if mode.endswith("fail") else marker)
                self.assertNotEqual(status, 0)
                self.assertEqual(path.read_bytes(), original_profile)
                self.assertEqual(destination.read_bytes(), original_default)
                self.assertEqual(list(self.config.rglob(".*")), [])
                self.assertEqual(self.calls(), [])

    def test_configure_is_private_atomic_and_stores_no_credentials(self):
        status, output = self.configure_tty("apptainer\ngh-cli\ntrue\nfalse\n3\naws-sdk,typesafe\n\ny\ny\n")
        self.assertEqual(status, 0, output)
        path = self.config / "profiles/personal.profile"
        contents = path.read_text()
        self.assertIn("runtime=apptainer\n", contents)
        self.assertEqual(path.stat().st_mode & 0o777, 0o600)
        self.assertEqual((self.config / "default").read_text(), "personal\n")
        for value in (self.env_token, self.stored_token, self.provider_token):
            self.assertNotIn(value, contents + output)
        self.assertEqual(self.calls(), [])

    def test_interrupted_configure_retains_existing_profile_and_default(self):
        path = self.profile()
        original = path.read_bytes()
        (self.config / "default").write_text("personal\n")
        # EOF at the final default confirmation must not save the already
        # confirmed profile or erase its previous capabilities.
        status, _ = self.configure_tty("apptainer\n\n\n\n\n-\n-\ny\n\x04")
        self.assertNotEqual(status, 0)
        self.assertEqual(path.read_bytes(), original)
        self.assertEqual((self.config / "default").read_text(), "personal\n")
        self.assertEqual(self.calls(), [])

    def test_non_tty_configure_refuses_without_runtime_or_config_write(self):
        self.run_launch("configure", "personal", ok=False)
        self.assertFalse(self.config.exists())
        self.assertEqual(self.calls(), [])

    def test_quiet_launch_keeps_host_plan_flags_out_of_omp(self):
        self.profile(runtime="apptainer")
        result = self.run_launch("--launcher-profile", "personal", "--launcher-quiet", "owner/repo")
        self.assertNotIn("Review launch:", result.stderr)
        self.assertNotIn("--launcher-quiet", self.receipt(result)["args"])

    def test_missing_host_flag_value_refuses_before_runtime(self):
        self.run_launch("--runtime", ok=False)
        self.assertEqual(self.calls(), [])


if __name__ == "__main__":
    unittest.main()
