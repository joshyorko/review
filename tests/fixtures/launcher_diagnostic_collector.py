#!/usr/bin/env python3
"""Hermetic process and event fixtures for the private launcher collector."""

from __future__ import annotations

import os
from pathlib import Path
import pty
import select
import signal
import subprocess
import tempfile
import time
import unittest


ROOT = Path(__file__).resolve().parents[2]
COLLECTOR = ROOT / "bin/bluefin-diagnostic-collector"
LAUNCHER = ROOT / "bin/bluefin"
CONTAINER_ID = "a" * 64
FOREIGN_ID = "b" * 64
OWNER = "run-token-opaque"
SECRET = "fixture-secret-must-not-appear"
CREDENTIAL_NAMES = (
    "GH_TOKEN", "GITHUB_TOKEN", "COPILOT_GITHUB_TOKEN", "GITHUB_COPILOT_TOKEN",
    "ANTHROPIC_API_KEY", "ANTHROPIC_OAUTH_TOKEN", "OPENAI_API_KEY", "GEMINI_API_KEY",
    "TYPESAFE_API_KEY", "AWS_BEARER_TOKEN_BEDROCK", "AWS_ACCESS_KEY_ID",
    "AWS_SECRET_ACCESS_KEY", "AWS_SESSION_TOKEN",
)


def proc_stat(pid: int, starttime: int) -> str:
    # The comm field contains spaces and ')' so parsing must follow procfs rules.
    return f"{pid} (launcher fixture ) name) S 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 {starttime} 20\n"


class CollectorTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.collector_exists = COLLECTOR.is_file()

    def test_private_collector_entrypoint_exists(self) -> None:
        self.assertTrue(COLLECTOR.is_file(), "private post-exit event collector is missing")

    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory(prefix="review-launch-diagnostic-test-")
        self.root = Path(self.tmp.name)
        self.bin = self.root / "bin"
        self.bin.mkdir()
        self.proc_root = self.root / "proc"
        self.proc_root.mkdir()
        self.state = self.root / "state"
        self.state.mkdir(mode=0o700)
        self.home = self.root / "home"
        self.home.mkdir()
        self.fixture_dir = self.home / ".review-diagnostic-fixture"
        self.fixture_dir.mkdir(mode=0o700)
        (self.fixture_dir / "event-mode").write_text("clean\n")
        (self.fixture_dir / "owner").write_text(OWNER + "\n")
        self.fake_podman = self.bin / "podman"
        self.fake_podman.write_text(
            """#!/usr/bin/env bash
set -eu
if [[ ${1:-} != events ]]; then exit 0; fi
fixture_dir="${HOME}/.review-diagnostic-fixture"
printf '%s\\n' "$*" >>"$fixture_dir/events-args.log"
mode="$(<"$fixture_dir/event-mode")"
owner="$(<"$fixture_dir/owner")"
printf '%s\\n' "$$" >"$fixture_dir/events-pid"
credentials_present=0
for name in GH_TOKEN GITHUB_TOKEN COPILOT_GITHUB_TOKEN GITHUB_COPILOT_TOKEN ANTHROPIC_API_KEY ANTHROPIC_OAUTH_TOKEN OPENAI_API_KEY GEMINI_API_KEY TYPESAFE_API_KEY AWS_BEARER_TOKEN_BEDROCK AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY AWS_SESSION_TOKEN; do
  [[ ! -v "$name" ]] || credentials_present=1
done
if ((credentials_present)); then
  printf 'present\\n' >"$fixture_dir/event-credentials"
else
  printf 'absent\\n' >"$fixture_dir/event-credentials"
fi
case "$mode" in
  timeout|timeout-ignore) [[ "$mode" != timeout-ignore ]] || trap '' TERM; exec sleep 10 ;;
  long-line) printf '%10000s' x; exec sleep 10 ;;
  query137) exit 137 ;;
  no-events) exit 0 ;;
  flood)
    for ((index = 0; index < 80; index += 1)); do
      printf 'container|init|%s|<nil>|<nil>|%s\\n' '${CONTAINER_ID}' "$owner"
    done
    exec sleep 10 ;;
  foreign-only)
    printf 'container|create|%s|<nil>|<nil>|foreign-owner\\n' '${FOREIGN_ID}'
    printf 'container|died|%s|137|true|foreign-owner\\n' '${FOREIGN_ID}'
    ;;
  mixed)
    printf 'container|create|%s|<nil>|<nil>|foreign-owner\\n' '${FOREIGN_ID}'
    printf 'container|died|%s|137|true|foreign-owner\\n' '${FOREIGN_ID}'
    printf 'container|create|%s|<nil>|<nil>|%s\\n' '${CONTAINER_ID}' "$owner"
    printf 'container|died|%s|23|false|%s\\n' '${CONTAINER_ID}' "$owner"
    ;;
  oom)
    printf 'container|create|%s|<nil>|<nil>|%s\\n' '${CONTAINER_ID}' "$owner"
    printf 'container|died|%s|137|true|%s\\n' '${CONTAINER_ID}' "$owner"
    ;;
  clean)
    printf 'container|create|%s|<nil>|<nil>|%s\\n' '${CONTAINER_ID}' "$owner"
    printf 'container|died|%s|0|false|%s\\n' '${CONTAINER_ID}' "$owner"
    ;;
  exit137)
    printf 'container|create|%s|<nil>|<nil>|%s\\n' '${CONTAINER_ID}' "$owner"
    printf 'container|died|%s|137|false|%s\\n' '${CONTAINER_ID}' "$owner"
    ;;
  exit130)
    printf 'container|create|%s|<nil>|<nil>|%s\\n' '${CONTAINER_ID}' "$owner"
    printf 'container|died|%s|130|false|%s\\n' '${CONTAINER_ID}' "$owner"
    ;;
  kill-event)
    printf 'container|create|%s|<nil>|<nil>|%s\\n' '${CONTAINER_ID}' "$owner"
    printf 'container|kill|%s|<nil>|<nil>|%s\\n' '${CONTAINER_ID}' "$owner"
    printf 'container|died|%s|143|false|%s\\n' '${CONTAINER_ID}' "$owner"
    ;;
esac
""".replace("${FOREIGN_ID}", FOREIGN_ID).replace("${CONTAINER_ID}", CONTAINER_ID)
        )
        self.fake_podman.chmod(0o700)
        self.env = {
            "PATH": f"{self.bin}:/usr/bin:/bin",
            "GH_TOKEN": SECRET,
            "GITHUB_TOKEN": SECRET,
            "OPENAI_API_KEY": SECRET,
            "HOME": str(self.home),
            "TERM": "dumb",
            "LC_ALL": "C",
        }
        self.env.update({name: SECRET for name in CREDENTIAL_NAMES})

    def tearDown(self) -> None:
        self.tmp.cleanup()

    def launch_collector(self, pid: int, starttime: int, *, timeout: float = 4.0) -> tuple[subprocess.Popen[str], Path]:
        (self.fixture_dir / "events-pid").unlink(missing_ok=True)
        (self.fixture_dir / "events-args.log").unlink(missing_ok=True)
        report_root = self.root / f"report-root-{time.monotonic_ns()}"
        report_root.mkdir(mode=0o700)
        report_dir = report_root / f"review-launch-diagnostic.{OWNER}"
        report_dir.mkdir(mode=0o700)
        launcher_identity = report_dir / "launcher.identity"
        launcher_identity.write_text(f"launcher_pid={pid} launcher_start={starttime} owner={OWNER}\n")
        launcher_identity.chmod(0o600)
        pending_report = report_dir / "collector.report"
        pending_report.write_text("Review post-exit diagnostic: outcome=unknown evidence=collector_pending\n")
        pending_report.chmod(0o600)
        args = [
            str(COLLECTOR),
            str(pid),
            str(starttime),
            OWNER,
            str(report_root),
            str(report_dir),
            str(self.proc_root),
            "2026-10-06T00:00:00Z",
        ]
        proc = subprocess.Popen(args, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, text=True, env=self.env)
        self.addCleanup(self.cleanup_child, proc)
        deadline = time.monotonic() + timeout
        while not (report_dir / "collector.identity").exists() and time.monotonic() < deadline:
            time.sleep(0.01)
        self.assertTrue((report_dir / "collector.identity").exists(), "collector identity receipt was not written")
        return proc, report_dir

    @staticmethod
    def cleanup_child(proc: subprocess.Popen[str]) -> None:
        if proc.poll() is None:
            proc.kill()
            proc.communicate()

    def write_proc(self, pid: int, starttime: int) -> None:
        proc_dir = self.proc_root / str(pid)
        proc_dir.mkdir(exist_ok=True)
        (proc_dir / "stat").write_text(proc_stat(pid, starttime))

    def settle(self, pid: int) -> None:
        (self.proc_root / str(pid) / "stat").unlink(missing_ok=True)

    def finish(self, proc: subprocess.Popen[str], report_dir: Path) -> str:
        try:
            _, stderr = proc.communicate(timeout=5)
        except subprocess.TimeoutExpired:
            proc.kill()
            _, stderr = proc.communicate()
            self.fail("collector did not settle after the launcher identity changed")
        self.assertEqual(proc.returncode, 0, stderr)
        report = (report_dir / "collector.report").read_text().strip()
        if any(marker in report for marker in (
            "outcome=clean", "container_exit=130", "evidence=unavailable",
            "evidence=events_unavailable", "evidence=timeout", "evidence=event_limit",
            "evidence=query_terminated",
        )):
            self.assertEqual(stderr.strip(), "")
        else:
            self.assertEqual(stderr.strip(), report)
        self.assertLess(len(report), 240)
        self.assertNotIn(SECRET, stderr)
        return report

    def launch_fixture(self, *, run_mode: str = "status", event_mode: str = "clean", run_status: int = 0, remove_engine: bool = False) -> dict[str, str]:
        launch_bin = self.root / "launch-bin"
        launch_bin.mkdir(exist_ok=True)
        fixture_id = time.monotonic_ns()
        paths = {
            name: self.root / f"{name}-{fixture_id}"
            for name in ("run.log", "rm.log", "started", "signals", "tty")
        }
        script = r'''#!/usr/bin/env bash
set -eu
if [[ ${1:-} == events ]]; then
  fixture_dir="${HOME}/.review-diagnostic-fixture"
  printf '%s\n' "$*" >>"$fixture_dir/events-args.log"
  mode="$(<"$fixture_dir/event-mode")"
  owner="$(<"$fixture_dir/owner")"
  printf '%s\n' "$$" >"$fixture_dir/events-pid"
  if [[ -v GH_TOKEN || -v GITHUB_TOKEN || -v OPENAI_API_KEY || -v ANTHROPIC_API_KEY ]]; then
    printf 'present\n' >"$fixture_dir/event-credentials"
  else
    printf 'absent\n' >"$fixture_dir/event-credentials"
  fi
  case "$mode" in
    no-events) exit 0 ;;
    query137) exit 137 ;;
    foreign-only)
      printf 'container|create|@FOREIGN@|<nil>|<nil>|foreign-owner\n'
      printf 'container|died|@FOREIGN@|137|true|foreign-owner\n' ;;
    oom)
      printf 'container|create|@CONTAINER@|<nil>|<nil>|%s\n' "$owner"
      printf 'container|died|@CONTAINER@|137|true|%s\n' "$owner" ;;
    exit137)
      printf 'container|create|@CONTAINER@|<nil>|<nil>|%s\n' "$owner"
      printf 'container|died|@CONTAINER@|137|false|%s\n' "$owner" ;;
    exit130|exit143|exit129)
      exit_code="${mode#exit}"
      printf 'container|create|@CONTAINER@|<nil>|<nil>|%s\n' "$owner"
      printf 'container|died|@CONTAINER@|%s|false|%s\n' "$exit_code" "$owner" ;;
    kill-clean)
      printf 'container|create|@CONTAINER@|<nil>|<nil>|%s\n' "$owner"
      printf 'container|kill|@CONTAINER@|<nil>|<nil>|%s\n' "$owner"
      printf 'container|died|@CONTAINER@|0|false|%s\n' "$owner" ;;
    clean)
      printf 'container|create|@CONTAINER@|<nil>|<nil>|%s\n' "$owner"
      printf 'container|died|@CONTAINER@|0|false|%s\n' "$owner" ;;
  esac
  exit 0
fi
if [[ "${1:-}" == info && "$*" == *--runtime=krun* ]]; then
  printf 'krun\n'
  exit 0
fi
case "${1:-} ${2:-} ${3:-}" in
  "info  ") exit 0 ;;
  "system connection list") exit 0 ;;
  "pull "*|"image exists"*) exit 0 ;;
  "image inspect "*)
    if [[ "${REMOVE_ENGINE_ON_INSPECT:-0}" == 1 ]]; then rm -f -- "$0"; fi
    printf '26.08.07|0123456789abcdef|sha256:deadbeef\n'
    exit 0 ;;
  "run "*)
    printf 'pid=%s args=%s\n' "$$" "$*" >>"${RUN_LOG:?}"
    previous=""
    for arg in "$@"; do
      if [[ "$previous" == --label ]]; then printf '%s\n' "${arg#io.review.launch.owner=}" >"$HOME/.review-diagnostic-fixture/owner"; fi
      previous="$arg"
    done
    case "${FAKE_RUN_MODE:-status}" in
      collision) exit 125 ;;
      wait)
        on_signal() { printf '%s\n' "$1" >>"${SIGNAL_LOG:?}"; case "$1" in INT) exit 130 ;; TERM) exit 143 ;; HUP) exit 129 ;; esac; }
        trap 'on_signal INT' INT
        trap 'on_signal TERM' TERM
        trap 'on_signal HUP' HUP
        : >"${STARTED_FILE:?}"
        while :; do IFS= read -r -t 0.1 ignored || true; done ;;
      tty)
        : >"${STARTED_FILE:?}"
        if [[ -t 0 ]]; then tty_state=yes; else tty_state=no; fi
        IFS= read -r -n 1 tty_byte || true
        printf 'tty=%s stdin=%s\n' "$tty_state" "${tty_byte:-}" >"${TTY_REPORT:?}"
        exit 0 ;;
      status) exit "${FAKE_RUN_STATUS:-0}" ;;
    esac ;;
  "rm "*) printf '%s\n' "$*" >>"${RM_LOG:?}"; exit 0 ;;
esac
exit 0
'''
        script = script.replace("@FOREIGN@", FOREIGN_ID).replace("@CONTAINER@", CONTAINER_ID)
        fake_engine = launch_bin / "podman"
        fake_engine.write_text(script)
        fake_engine.chmod(0o700)
        (launch_bin / "krun").write_text("#!/usr/bin/env bash\nexit 0\n")
        (launch_bin / "krun").chmod(0o700)
        (launch_bin / "apptainer").write_text("#!/usr/bin/env bash\nexit 0\n")
        (launch_bin / "apptainer").chmod(0o700)
        kvm = self.root / "kvm"
        kvm.touch()
        kvm.chmod(0o666)
        home = self.root / f"home-{fixture_id}"
        home.mkdir()
        fixture_dir = home / ".review-diagnostic-fixture"
        fixture_dir.mkdir(mode=0o700)
        (fixture_dir / "event-mode").write_text(event_mode + "\n")
        (fixture_dir / "owner").write_text("missing-owner\n")
        state_home = home / ".local/state"
        state_home.mkdir(parents=True, exist_ok=True)
        tmpdir = self.root / f"launcher-tmp-{time.monotonic_ns()}"
        tmpdir.mkdir(exist_ok=True)
        path = f"{launch_bin}:/usr/bin:/bin"
        if remove_engine:
            system_bin = self.root / f"system-bin-{fixture_id}"
            system_bin.mkdir()
            excluded = {"podman", "krun", "apptainer", "gh", "skopeo"}
            for entry in Path("/usr/bin").iterdir():
                if entry.name in excluded or not entry.is_file() or not os.access(entry, os.X_OK):
                    continue
                try:
                    (system_bin / entry.name).symlink_to(entry.resolve())
                except FileExistsError:
                    pass
            path = f"{launch_bin}:{system_bin}"
        env = {
            "PATH": path,
            "HOME": str(home),
            "XDG_STATE_HOME": str(state_home),
            "TMPDIR": str(tmpdir),
            "REVIEW_TEST_KVM_DEVICE": str(kvm),
            "REVIEW_TEST_RUNTIME_DIR": str(self.root / "no-runtime"),
            "REVIEW_TEST_SND_DEVICE": str(self.root / "no-snd"),
            "GH_TOKEN": SECRET,
            "OPENAI_API_KEY": SECRET,
            "RUN_LOG": str(paths["run.log"]),
            "RM_LOG": str(paths["rm.log"]),
            "STARTED_FILE": str(paths["started"]),
            "SIGNAL_LOG": str(paths["signals"]),
            "TTY_REPORT": str(paths["tty"]),
            "FAKE_RUN_MODE": run_mode,
            "FAKE_RUN_STATUS": str(run_status),
            "REMOVE_ENGINE_ON_INSPECT": "1" if remove_engine else "0",
            "TERM": "xterm-256color",
            "COLORTERM": "truecolor",
        }
        env.update({name: SECRET for name in CREDENTIAL_NAMES})
        paths.update({"tmpdir": tmpdir, "home": home, "diagnostic_fixture": fixture_dir, "state_home": state_home, "launch_bin": launch_bin, "env": env})
        return paths

    def wait_for_file(self, path: Path, timeout: float = 5.0) -> None:
        deadline = time.monotonic() + timeout
        while not path.exists() and time.monotonic() < deadline:
            time.sleep(0.01)
        self.assertTrue(path.exists(), f"fixture did not reach expected state: {path.name}")

    def diagnostic_report_path(self, fixture: dict[str, str]) -> Path:
        report_roots = list(Path(fixture["state_home"]).glob("bluefin/instances/*/diagnostics"))
        report_dirs = [path for root in report_roots for path in root.glob("review-launch-diagnostic.*")]
        self.assertEqual(len(report_dirs), 1, "expected one private diagnostic report directory")
        report_dir = report_dirs[0]
        self.assertEqual(report_dir.stat().st_mode & 0o777, 0o700)
        report = report_dir / "collector.report"
        self.assertTrue(report.exists(), "collector did not leave its private report receipt")
        private_files = ("launcher.identity", "collector.identity", "collector.report")
        for name in private_files:
            self.assertEqual((report_dir / name).stat().st_mode & 0o777, 0o600)
        launcher_identity = (report_dir / "launcher.identity").read_text()
        collector_identity = (report_dir / "collector.identity").read_text()
        self.assertIn("launcher_pid=", launcher_identity)
        self.assertIn(launcher_identity.split("owner=", 1)[1].strip(), collector_identity)
        self.assertIn(launcher_identity.split("launcher_pid=", 1)[1].split()[0], collector_identity)
        collector_field = collector_identity.split("collector_pid=", 1)[1].split()[0]
        if collector_field.isdigit():
            collector_pid = int(collector_field)
            deadline = time.monotonic() + 2.0
            while Path(f"/proc/{collector_pid}").exists() and time.monotonic() < deadline:
                time.sleep(0.01)
            self.assertFalse(Path(f"/proc/{collector_pid}").exists(), "collector report existed before collector settlement")
        else:
            self.assertEqual(collector_field, "unavailable")
        return report

    def launcher_report(self, fixture: dict[str, str]) -> str:
        return self.diagnostic_report_path(fixture).read_text().strip()

    def launcher_diagnostic_dir(self, fixture: dict[str, str]) -> Path:
        report_roots = list(Path(fixture["state_home"]).glob("bluefin/instances/*/diagnostics"))
        report_dirs = [path for root in report_roots for path in root.glob("review-launch-diagnostic.*")]
        self.assertEqual(len(report_dirs), 1, "expected one diagnostic receipt directory")
        return report_dirs[0]

    @unittest.skipUnless(COLLECTOR.is_file(), "collector implementation follows this red test")
    def test_retained_events_are_owner_scoped_and_only_allowlisted_scalars_are_reported(self) -> None:
        pid, starttime = 41001, 771
        self.write_proc(pid, starttime)
        (self.fixture_dir / "event-mode").write_text("mixed\n")
        proc, report_dir = self.launch_collector(pid, starttime)
        time.sleep(0.05)
        # Reuse of the PID ends this invocation, but foreign events with exit 137/OOM
        # must not be attributed to the exact ownership label.
        self.write_proc(pid, starttime + 1)
        report = self.finish(proc, report_dir)
        self.assertIn("outcome=nonclean_unknown", report)
        self.assertIn("container_exit=23", report)
        self.assertIn("settlement=pid_reused", report)
        self.assertNotIn(FOREIGN_ID, report)
        self.assertNotIn("attributes", report.lower())
        event_call = (self.fixture_dir / "events-args.log").read_text()
        self.assertIn(f"label=io.review.launch.owner={OWNER}", event_call)
        self.assertIn("--stream=false", event_call)
        self.assertEqual((self.fixture_dir / "event-credentials").read_text(), "absent\n")

    @unittest.skipUnless(COLLECTOR.is_file(), "collector implementation follows this red test")
    def test_podman_oom_flag_is_reported_but_exit_137_alone_stays_unknown(self) -> None:
        for mode, expected in (("oom", "podman_oom_reported"), ("exit137", "nonclean_unknown")):
            with self.subTest(mode=mode):
                pid, starttime = 41002, 772
                self.write_proc(pid, starttime)
                (self.fixture_dir / "event-mode").write_text(mode + "\n")
                proc, report_dir = self.launch_collector(pid, starttime)
                time.sleep(0.05)
                self.settle(pid)
                report = self.finish(proc, report_dir)
                self.assertIn(f"outcome={expected}", report)

    @unittest.skipUnless(COLLECTOR.is_file(), "collector implementation follows this red test")
    def test_only_an_owned_podman_kill_event_is_classified_as_signal_observed(self) -> None:
        pid, starttime = 41007, 777
        self.write_proc(pid, starttime)
        (self.fixture_dir / "event-mode").write_text("kill-event\n")
        proc, report_dir = self.launch_collector(pid, starttime)
        time.sleep(0.05)
        self.settle(pid)
        self.assertIn("outcome=signal_observed", self.finish(proc, report_dir))

    @unittest.skipUnless(COLLECTOR.is_file(), "collector implementation follows this red test")
    def test_event_row_limit_returns_unknown_without_unbounded_capture(self) -> None:
        pid, starttime = 41008, 778
        self.write_proc(pid, starttime)
        (self.fixture_dir / "event-mode").write_text("flood\n")
        proc, report_dir = self.launch_collector(pid, starttime)
        time.sleep(0.05)
        self.settle(pid)
        began = time.monotonic()
        report = self.finish(proc, report_dir)
        self.assertLess(time.monotonic() - began, 4.0)
        self.assertIn("outcome=unknown", report)
        self.assertIn("evidence=event_limit", report)

    @unittest.skipUnless(COLLECTOR.is_file(), "collector implementation follows this red test")
    def test_missing_owned_create_event_is_unknown_and_name_collision_is_never_removed(self) -> None:
        pid, starttime = 41003, 773
        self.write_proc(pid, starttime)
        (self.fixture_dir / "event-mode").write_text("foreign-only\n")
        proc, report_dir = self.launch_collector(pid, starttime)
        time.sleep(0.05)
        self.settle(pid)
        report = self.finish(proc, report_dir)
        self.assertIn("outcome=unknown", report)
        self.assertIn("evidence=unavailable", report)
        self.assertFalse(any(" rm " in line for line in (self.fixture_dir / "events-args.log").read_text().splitlines()))

    @unittest.skipUnless(COLLECTOR.is_file(), "collector implementation follows this red test")
    def test_clean_exit_and_event_query_timeout_settle_without_changing_launch_status(self) -> None:
        pid, starttime = 41004, 774
        self.write_proc(pid, starttime)
        proc, report_dir = self.launch_collector(pid, starttime)
        time.sleep(0.05)
        self.settle(pid)
        self.assertIn("outcome=clean", self.finish(proc, report_dir))

        pid, starttime = 41005, 775
        self.write_proc(pid, starttime)
        (self.fixture_dir / "event-mode").write_text("timeout\n")
        proc, report_dir = self.launch_collector(pid, starttime, timeout=6.0)
        time.sleep(0.05)
        self.settle(pid)
        began = time.monotonic()
        report = self.finish(proc, report_dir)
        self.assertLess(time.monotonic() - began, 4.0)
        self.assertIn("outcome=unknown", report)
        self.assertIn("evidence=timeout", report)

    @unittest.skipUnless(COLLECTOR.is_file(), "collector implementation follows this red test")
    def test_query_exit_137_is_terminated_unknown_not_timeout_or_oom(self) -> None:
        pid, starttime = 41009, 779
        self.write_proc(pid, starttime)
        (self.fixture_dir / "event-mode").write_text("query137\n")
        proc, report_dir = self.launch_collector(pid, starttime)
        time.sleep(0.05)
        self.settle(pid)
        report = self.finish(proc, report_dir)
        self.assertIn("outcome=unknown", report)
        self.assertIn("evidence=query_terminated", report)
        self.assertNotIn("known_oom", report)

    @unittest.skipUnless(COLLECTOR.is_file(), "collector implementation follows this red test")
    def test_collector_ignores_parent_process_group_signals_until_owned_invocation_settles(self) -> None:
        pid, starttime = 41006, 776
        self.write_proc(pid, starttime)
        proc, report_dir = self.launch_collector(pid, starttime)
        time.sleep(0.05)
        for sig in ("INT", "TERM", "HUP"):
            os.kill(proc.pid, getattr(__import__("signal"), "SIG" + sig))
            time.sleep(0.03)
            self.assertIsNone(proc.poll(), f"collector exited on {sig}")
        self.settle(pid)
        report = self.finish(proc, report_dir)
        self.assertIn("outcome=clean", report)

    @unittest.skipUnless(COLLECTOR.is_file(), "collector implementation follows this red test")
    def test_report_path_symlinks_and_wrong_child_are_refused_without_touching_target(self) -> None:
        outside = self.root / "outside"
        outside.mkdir(mode=0o700)
        sentinel = outside / "sentinel"
        sentinel.write_text("outside stays intact\n")
        sentinel.chmod(0o600)
        report_root = self.root / "safe-root"
        report_root.mkdir(mode=0o700)
        proc_root = self.root / "fake-proc"
        proc_root.mkdir(mode=0o700)
        pid, starttime = 41101, 880
        self.write_proc(pid, starttime)

        symlink_child = report_root / f"review-launch-diagnostic.{OWNER}"
        symlink_child.symlink_to(outside, target_is_directory=True)
        result = subprocess.run(
            [str(COLLECTOR), str(pid), str(starttime), OWNER, str(report_root), str(symlink_child), str(proc_root), "2026-10-06T00:00:00Z"],
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            env=self.env,
        )
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(sentinel.read_text(), "outside stays intact\n")

        report_root2 = self.root / "safe-root-2"
        report_root2.mkdir(mode=0o700)
        report_dir = report_root2 / f"review-launch-diagnostic.{OWNER}"
        report_dir.mkdir(mode=0o700)
        (report_dir / "launcher.identity").symlink_to(sentinel)
        result = subprocess.run(
            [str(COLLECTOR), str(pid), str(starttime), OWNER, str(report_root2), str(report_dir), str(proc_root), "2026-10-06T00:00:00Z"],
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            env=self.env,
        )
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(sentinel.read_text(), "outside stays intact\n")
        self.assertFalse((report_dir / "collector.report").exists())

        report_root3 = self.root / "safe-root-3"
        report_root3.mkdir(mode=0o700)
        wrong_child = report_root3 / "unexpected-child"
        wrong_child.mkdir(mode=0o700)
        (wrong_child / "launcher.identity").write_text(f"launcher_pid={pid} launcher_start={starttime} owner={OWNER}\n")
        (wrong_child / "launcher.identity").chmod(0o600)
        (wrong_child / "collector.report").write_text("Review post-exit diagnostic: outcome=unknown evidence=collector_pending\n")
        (wrong_child / "collector.report").chmod(0o600)
        result = subprocess.run(
            [str(COLLECTOR), str(pid), str(starttime), OWNER, str(report_root3), str(wrong_child), str(proc_root), "2026-10-06T00:00:00Z"],
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            env=self.env,
        )
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual((wrong_child / "collector.report").read_text(), "Review post-exit diagnostic: outcome=unknown evidence=collector_pending\n")

        report_dir3 = report_root3 / f"review-launch-diagnostic.{OWNER}"
        report_dir3.mkdir(mode=0o700)
        (report_dir3 / "launcher.identity").write_text(f"launcher_pid={pid} launcher_start={starttime} owner={OWNER}\n")
        (report_dir3 / "launcher.identity").chmod(0o600)
        (report_dir3 / "collector.report").write_text("Review post-exit diagnostic: outcome=unknown evidence=collector_pending\n")
        (report_dir3 / "collector.report").chmod(0o600)
        hardlinked_report = report_dir3 / "collector.report"
        hardlinked_report.unlink()
        os.link(sentinel, hardlinked_report)
        result = subprocess.run(
            [str(COLLECTOR), str(pid), str(starttime), OWNER, str(report_root3), str(report_dir3), str(proc_root), "2026-10-06T00:00:00Z"],
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            env=self.env,
        )
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(sentinel.read_text(), "outside stays intact\n")

    @unittest.skipUnless(COLLECTOR.is_file(), "collector implementation follows this red test")
    def test_exit_130_receipt_is_retained_without_terminal_diagnostic(self) -> None:
        pid, starttime = 41102, 881
        self.write_proc(pid, starttime)
        (self.fixture_dir / "event-mode").write_text("exit130\n")
        proc, report_dir = self.launch_collector(pid, starttime)
        time.sleep(0.05)
        self.settle(pid)
        report = self.finish(proc, report_dir)
        self.assertIn("outcome=nonclean_unknown", report)
        self.assertIn("container_exit=130", report)

    @unittest.skipUnless(COLLECTOR.is_file(), "collector implementation follows this red test")
    def test_term_ignoring_and_unbroken_event_output_are_hard_bounded_and_reaped(self) -> None:
        for mode in ("timeout-ignore", "long-line"):
            with self.subTest(mode=mode):
                pid, starttime = 41103, 882
                self.write_proc(pid, starttime)
                (self.fixture_dir / "event-mode").write_text(mode + "\n")
                proc, report_dir = self.launch_collector(pid, starttime, timeout=6.0)
                self.settle(pid)
                event_pid_file = self.fixture_dir / "events-pid"
                deadline = time.monotonic() + 4.0
                while not event_pid_file.exists() and time.monotonic() < deadline:
                    time.sleep(0.01)
                self.assertTrue(event_pid_file.exists())
                owned_event_pid = int(event_pid_file.read_text().strip())
                began = time.monotonic()
                report = self.finish(proc, report_dir)
                self.assertLess(time.monotonic() - began, 4.0)
                self.assertIn("outcome=unknown", report)
                expected_evidence = "query_terminated" if mode == "timeout-ignore" else "event_limit"
                self.assertIn(f"evidence={expected_evidence}", report)
                self.assertFalse(Path(f"/proc/{owned_event_pid}").exists(), "owned query child was not reaped")

    @unittest.skipUnless(COLLECTOR.is_file(), "collector implementation follows this red test")
    def test_launcher_keeps_direct_exec_rm_and_original_status_with_private_diagnostic(self) -> None:
        fixture = self.launch_fixture(run_status=37, event_mode="exit137")
        proc = subprocess.Popen(
            [str(LAUNCHER), "review", "owner/repo"],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=False,
            env=fixture["env"],
        )
        stdout, stderr = proc.communicate(input=b"unused", timeout=10)
        self.assertEqual(proc.returncode, 37, stderr.decode(errors="replace"))
        run_log = Path(fixture["run.log"]).read_text()
        self.assertIn(f"pid={proc.pid} args=run --runtime=krun --rm --interactive --tty", run_log)
        self.assertIn("--name bluefin-review-", run_log)
        self.assertIn("--label io.review.launch.owner=", run_log)
        self.assertNotIn(SECRET, run_log + stdout.decode(errors="replace") + stderr.decode(errors="replace"))
        self.assertFalse(Path(fixture["rm.log"]).exists(), "launcher attempted post-exit cleanup")
        self.assertIn("outcome=nonclean_unknown", self.launcher_report(fixture))

    @unittest.skipUnless(COLLECTOR.is_file(), "collector implementation follows this red test")
    def test_owned_kill_event_prevents_clean_zero_exit_and_retains_bounded_identity(self) -> None:
        fixture = self.launch_fixture(run_status=0, event_mode="kill-clean")
        proc = subprocess.run(
            [str(LAUNCHER), "review", "owner/repo"],
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            timeout=10,
            env=fixture["env"],
        )
        self.assertEqual(proc.returncode, 0, proc.stderr)
        report = self.launcher_report(fixture)
        self.assertIn("outcome=signal_observed", report)
        self.assertIn("container_exit=0", report)
        self.assertIn(f"container_id={CONTAINER_ID}", report)
        self.assertIn("kill_seen=true", report)
        self.assertLess(len(report), 240)
        self.assertNotIn(SECRET, report + proc.stdout + proc.stderr)

    @unittest.skipUnless(COLLECTOR.is_file(), "collector implementation follows this red test")
    def test_launcher_name_collision_and_failed_runtime_start_remain_unknown(self) -> None:
        collision = self.launch_fixture(run_mode="collision", event_mode="foreign-only")
        collision_run = subprocess.run(
            [str(LAUNCHER), "review", "owner/repo"],
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            timeout=10,
            env=collision["env"],
        )
        self.assertEqual(collision_run.returncode, 125)
        self.assertIn("outcome=unknown", self.launcher_report(collision))
        self.assertFalse(Path(collision["rm.log"]).exists())

        failed = self.launch_fixture(event_mode="no-events", run_status=127)
        failed_run = subprocess.run(
            [str(LAUNCHER), "review", "owner/repo"],
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            timeout=10,
            env=failed["env"],
        )
        self.assertEqual(failed_run.returncode, 127)
        self.assertIn("outcome=unknown", self.launcher_report(failed))

    @unittest.skipUnless(COLLECTOR.is_file(), "collector implementation follows this red test")
    def test_exec_lookup_failure_after_preflight_is_unknown_and_keeps_exit_127(self) -> None:
        fixture = self.launch_fixture(remove_engine=True)
        proc = subprocess.run(
            [str(LAUNCHER), "review", "owner/repo"],
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            timeout=10,
            env=fixture["env"],
        )
        self.assertEqual(proc.returncode, 127)
        self.assertIn("outcome=unknown", self.launcher_report(fixture))

    @unittest.skipUnless(COLLECTOR.is_file(), "collector implementation follows this red test")
    def test_missing_proc_identity_is_quiet_for_clean_and_exit_130_with_unknown_receipt(self) -> None:
        for status in (0, 130):
            with self.subTest(status=status):
                fixture = self.launch_fixture(run_status=status)
                fixture["env"]["REVIEW_TEST_PROC_ROOT"] = str(self.root / "absent-proc")
                proc = subprocess.run(
                    [str(LAUNCHER), "review", "owner/repo"],
                    stdin=subprocess.DEVNULL,
                    stdout=subprocess.PIPE,
                    stderr=subprocess.PIPE,
                    text=True,
                    timeout=10,
                    env=fixture["env"],
                )
                self.assertEqual(proc.returncode, status)
                self.assertNotIn("Review post-exit diagnostic", proc.stderr)
                report = self.launcher_report(fixture)
                self.assertIn("outcome=unknown", report)
                self.assertIn("evidence=collector_unavailable", report)

    @unittest.skipUnless(COLLECTOR.is_file(), "collector implementation follows this red test")
    def test_unavailable_event_history_is_quiet_for_clean_and_exit_130(self) -> None:
        for status in (0, 130):
            with self.subTest(status=status):
                fixture = self.launch_fixture(run_status=status, event_mode="no-events")
                proc = subprocess.run(
                    [str(LAUNCHER), "review", "owner/repo"],
                    stdin=subprocess.DEVNULL,
                    stdout=subprocess.PIPE,
                    stderr=subprocess.PIPE,
                    text=True,
                    timeout=10,
                    env=fixture["env"],
                )
                self.assertEqual(proc.returncode, status)
                self.assertNotIn("Review post-exit diagnostic", proc.stderr)
                report = self.launcher_report(fixture)
                self.assertIn("outcome=unknown", report)
                self.assertIn("evidence=unavailable", report)

    @unittest.skipUnless(COLLECTOR.is_file(), "collector implementation follows this red test")
    def test_collector_and_event_child_do_not_inherit_provider_credentials(self) -> None:
        fixture = self.launch_fixture(run_mode="wait", event_mode="exit143")
        proc = subprocess.Popen(
            [str(LAUNCHER), "review", "owner/repo"],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            env=fixture["env"],
        )
        self.wait_for_file(Path(fixture["started"]))
        report_dir = self.launcher_diagnostic_dir(fixture)
        self.wait_for_file(report_dir / "collector.identity")
        identity = (report_dir / "collector.identity").read_text()
        collector_pid = int(identity.split("collector_pid=", 1)[1].split()[0])
        environment = Path(f"/proc/{collector_pid}/environ").read_bytes()
        for name in CREDENTIAL_NAMES:
            self.assertNotIn(f"{name}=".encode(), environment)
        os.kill(proc.pid, signal.SIGTERM)
        _, stderr = proc.communicate(timeout=10)
        self.assertEqual(proc.returncode, 143, stderr.decode(errors="replace"))
        self.assertEqual((Path(fixture["home"]) / ".review-diagnostic-fixture/event-credentials").read_text(), "absent\n")
        self.assertIn("outcome=nonclean_unknown", self.launcher_report(fixture))

    @unittest.skipUnless(COLLECTOR.is_file(), "collector implementation follows this red test")
    def test_launcher_preserves_tty_stdin_and_process_group_ctrl_c_once(self) -> None:
        fixture = self.launch_fixture(run_mode="tty", event_mode="clean")
        pid, fd = pty.fork()
        if pid == 0:
            os.execve(str(LAUNCHER), [str(LAUNCHER), "review", "owner/repo"], fixture["env"])
        self.wait_for_file(Path(fixture["started"]))
        os.write(fd, b"x\n")
        output = bytearray()
        deadline = time.monotonic() + 8.0
        wait_result = (0, 0)
        main_settled = False
        while time.monotonic() < deadline:
            ready, _, _ = select.select([fd], [], [], 0.05)
            if ready:
                try:
                    output.extend(os.read(fd, 4096))
                except OSError:
                    pass
            if not main_settled:
                wait_result = os.waitpid(pid, os.WNOHANG)
                main_settled = wait_result[0] == pid
            if main_settled and self.diagnostic_report_path(fixture).exists():
                break
        if not main_settled:
            os.kill(pid, signal.SIGKILL)
            os.waitpid(pid, 0)
            self.fail("direct foreground launcher did not settle")
        self.assertEqual(os.WEXITSTATUS(wait_result[1]), 0)
        self.assertEqual(Path(fixture["tty"]).read_text(), "tty=yes stdin=x\n")
        self.assertNotIn(b"post-exit diagnostic", output)
        self.assertIn("outcome=clean", self.launcher_report(fixture))

        ctrl_c = self.launch_fixture(run_mode="wait", event_mode="exit130")
        pid, fd = pty.fork()
        if pid == 0:
            os.execve(str(LAUNCHER), [str(LAUNCHER), "review", "owner/repo"], ctrl_c["env"])
        self.wait_for_file(Path(ctrl_c["started"]))
        os.write(fd, b"\x03")
        output = bytearray()
        deadline = time.monotonic() + 8.0
        wait_result = (0, 0)
        main_settled = False
        while time.monotonic() < deadline:
            ready, _, _ = select.select([fd], [], [], 0.05)
            if ready:
                try:
                    output.extend(os.read(fd, 4096))
                except OSError:
                    pass
            if not main_settled:
                wait_result = os.waitpid(pid, os.WNOHANG)
                main_settled = wait_result[0] == pid
            if main_settled and self.diagnostic_report_path(ctrl_c).exists():
                break
        if not main_settled:
            os.kill(pid, signal.SIGKILL)
            os.waitpid(pid, 0)
            self.fail("launcher did not settle after terminal Ctrl-C")
        self.assertEqual(os.WEXITSTATUS(wait_result[1]), 130)
        self.assertEqual(Path(ctrl_c["signals"]).read_text().splitlines(), ["INT"])
        self.assertNotIn(b"post-exit diagnostic", output)
        self.assertIn("outcome=nonclean_unknown", self.launcher_report(ctrl_c))

    @unittest.skipUnless(COLLECTOR.is_file(), "collector implementation follows this red test")
    def test_parent_only_signals_reach_direct_exec_once(self) -> None:
        for sig, expected_status, expected_name, event_mode in (
            (signal.SIGINT, 130, "INT", "exit130"),
            (signal.SIGTERM, 143, "TERM", "exit143"),
            (signal.SIGHUP, 129, "HUP", "exit129"),
        ):
            with self.subTest(signal=expected_name):
                fixture = self.launch_fixture(run_mode="wait", event_mode=event_mode)
                proc = subprocess.Popen(
                    [str(LAUNCHER), "review", "owner/repo"],
                    stdin=subprocess.PIPE,
                    stdout=subprocess.PIPE,
                    stderr=subprocess.PIPE,
                    env=fixture["env"],
                )
                self.wait_for_file(Path(fixture["started"]))
                os.kill(proc.pid, sig)
                _, stderr = proc.communicate(timeout=10)
                self.assertEqual(proc.returncode, expected_status, stderr.decode(errors="replace"))
                self.assertEqual(Path(fixture["signals"]).read_text().splitlines(), [expected_name])
                self.assertIn("outcome=nonclean_unknown", self.launcher_report(fixture))


if __name__ == "__main__":
    unittest.main(verbosity=2)
