import json
import os
from pathlib import Path
import subprocess
import tarfile
import tempfile
from io import BytesIO


ROOT = Path(__file__).resolve().parents[1]


def test_cleanup_is_run_tag_scoped_and_load_failure_never_removes_an_image_id():
    script = (ROOT / "scripts/ci/native-appliance.sh").read_text()
    cleanup = script.split("cleanup() {", 1)[1].split("\n}", 1)[0]
    assert "run_nonce=\"$(python3 -c 'import secrets; print(secrets.token_hex(16))')\"" in script
    assert 'podman image exists "$image_ref"' in script
    assert 'podman image rm "$image_ref"' in cleanup
    assert "podman image rm --force \"$image_id\"" not in script
    assert 'podman image rm "$image_id"' not in script
    assert 'run_tag_owned=1' in script
    assert script.index('podman tag "$image_id" "$image_ref"') < script.index("run_tag_owned=1")


def test_appliance_archive_is_checked_against_the_snapshot_commit_before_build():
    module = (ROOT / ".dagger/main.go").read_text()
    verifier = (ROOT / "scripts/ci/verify-source-identity.sh").read_text()
    assert "m.verifySourceSubject(ctx, source, revision)" in module
    assert 'git bundle list-heads "$bundle"' in verifier
    assert '"$bundle_head" == "$revision"' in verifier
    assert 'git diff --cached --quiet "$revision" --' in verifier
    assert 'git add -f -- .agents/skills/review-ci' in verifier


def test_interrupted_podman_import_never_removes_an_image_or_tag():
    with tempfile.TemporaryDirectory() as temporary:
        root = Path(temporary)
        source = root / "source"
        source.mkdir()
        (source / "VERSION").write_text("0.1.7\n")
        archive_path = root / "candidate.oci.tar"
        manifest_digest = "sha256:" + "a" * 64
        config_digest = "sha256:" + "b" * 64
        manifest = json.dumps({"config": {"digest": config_digest}}).encode()
        index = json.dumps({"manifests": [{"digest": manifest_digest}]}).encode()
        with tarfile.open(archive_path, "w") as archive:
            for name, contents in (("index.json", index), ("blobs/sha256/" + "a" * 64, manifest)):
                member = tarfile.TarInfo(name)
                member.size = len(contents)
                archive.addfile(member, BytesIO(contents))

        binaries = root / "bin"
        binaries.mkdir()
        podman_log = root / "podman.log"
        podman = binaries / "podman"
        podman.write_text(
            "#!/bin/sh\n"
            "printf '%s\\n' \"$*\" >> \"$PODMAN_LOG\"\n"
            "case $1 in info) exit 0;; image) exit 1;; load) exit 77;; *) exit 99;; esac\n"
        )
        podman.chmod(0o755)
        scratch = root / "tmp"
        scratch.mkdir()
        env = {
            **os.environ,
            "PATH": f"{binaries}:{os.environ['PATH']}",
            "TMPDIR": str(scratch),
            "PODMAN_LOG": str(podman_log),
        }
        revision = "c" * 40
        result = subprocess.run(
            ["bash", str(ROOT / "scripts/ci/native-appliance.sh"), str(source), revision, str(archive_path)],
            env=env,
            capture_output=True,
            text=True,
        )
        calls = podman_log.read_text()
        assert result.returncode == 77
        assert "load --input" in calls
        assert "image rm" not in calls
        assert "rmi" not in calls
        assert not list(scratch.glob("review-ci-native.*"))


if __name__ == "__main__":
    test_cleanup_is_run_tag_scoped_and_load_failure_never_removes_an_image_id()
    test_appliance_archive_is_checked_against_the_snapshot_commit_before_build()
    test_interrupted_podman_import_never_removes_an_image_or_tag()
