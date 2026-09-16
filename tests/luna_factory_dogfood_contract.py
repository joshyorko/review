"""Static contract for the no-publish Luna Factory GitHub dogfood path."""

from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
WORKFLOW = ROOT / ".github/workflows/luna-factory-dogfood.yml"
HARNESS = ROOT / "tests/luna-factory-dogfood.sh"
CAPABILITIES = ROOT / "tests/appliance-runtime-probe.sh"


def test_workflow_is_exact_head_no_publish_and_artifact_bounded():
    workflow = WORKFLOW.read_text()
    assert "pull_request:" in workflow
    assert "github.event.pull_request.head.sha" in workflow
    assert "ubuntu-latest" in workflow
    assert "ubuntu-24.04" in workflow
    assert "tests/luna-factory-dogfood.sh" in workflow
    assert "tests/appliance-runtime-probe.sh" in workflow
    assert "scripts/brew-dev" in workflow
    assert "actions/upload-artifact" in workflow
    assert "podman build --format oci" in workflow
    assert "tests/appliance-contract.sh --image" in workflow
    for forbidden in (
        "podman push",
        "ghcr.io",
        "secrets.",
        "gh auth",
        "release create",
        "BLUEFIN_REVIEW_OCI_PUSH",
    ):
        assert forbidden not in workflow, forbidden


def test_oci_harness_is_clean_and_uses_the_local_provider():
    harness = HARNESS.read_text()
    assert "--network host" in harness
    assert "127.0.0.1" in harness
    assert "LUNA_FACTORY_ENABLED" in harness
    assert "HOME" in harness
    assert "XDG_STATE_HOME" in harness
    assert "luna-factory-omp-probe-server.mjs" in harness
    assert "luna-factory-omp-probe-config.yml" in harness
    assert "luna-factory-omp-probe-models.yml" in harness
    assert "--no-session" not in harness


def test_sif_harness_uses_the_personal_launcher_and_does_not_claim_krun():
    harness = HARNESS.read_text()
    assert "scripts/brew-dev" not in harness
    assert "BLUEFIN_REVIEW_FALLBACK_SIF" in harness
    assert "bin/bluefin" in harness
    assert "krun" in harness
    assert "blocked-by-runner-capability" in harness


def test_capability_probe_records_required_host_boundaries():
    probe = CAPABILITIES.read_text()
    for marker in (
        "/dev/fuse",
        "/dev/kvm",
        "/proc/filesystems",
        "unshare",
        "apparmor",
        "podman",
        "krun",
        "apptainer",
        "squashfuse",
        "mksquashfs",
        "unsquashfs",
        "fuse2fs",
    ):
        assert marker in probe, marker


if __name__ == "__main__":
    test_workflow_is_exact_head_no_publish_and_artifact_bounded()
    test_oci_harness_is_clean_and_uses_the_local_provider()
    test_sif_harness_uses_the_personal_launcher_and_does_not_claim_krun()
    test_capability_probe_records_required_host_boundaries()
