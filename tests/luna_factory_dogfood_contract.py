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
    assert "ubuntu-24.04" in workflow
    assert "tests/luna-factory-dogfood.sh" in workflow
    assert "tests/appliance-runtime-probe.sh" in workflow
    assert "scripts/brew-dev" in workflow
    assert "actions/upload-artifact" in workflow
    assert "podman build --format oci" in workflow
    assert "tests/appliance-contract.sh --image" in workflow
    assert "oven-sh/setup-bun@0c5077e51419868618aeaa5fe8019c62421857d6" in workflow
    assert "eWaterCycle/setup-apptainer@58d788a297b0acdec33b8979428afa78679aa711" in workflow
    assert "actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1" in workflow
    assert "actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a" in workflow
    assert "id: capabilities" in workflow
    for marker in ("steps.capabilities.outputs.oci", "steps.capabilities.outputs.sif", "REVIEW_REVISION"):
        assert marker in workflow, marker
    assert 'localhost/review:luna-factory-dogfood-${{ github.event.pull_request.head.sha }}' in workflow
    for forbidden in ("podman push", "ghcr.io", "secrets.", "gh auth", "release create", "BLUEFIN_REVIEW_OCI_PUSH"):
        assert forbidden not in workflow, forbidden
    assert "pull_request:" in workflow
    assert "github.event.pull_request.head.sha" in workflow
    assert "ubuntu-24.04" in workflow
    assert "tests/luna-factory-dogfood.sh" in workflow
    assert "tests/appliance-runtime-probe.sh" in workflow
    assert "scripts/brew-dev" in workflow
    assert "actions/upload-artifact" in workflow
    assert "podman build --format oci" in workflow
    assert "tests/appliance-contract.sh --image" in workflow


def test_oci_harness_is_clean_and_uses_the_local_provider():
    harness = HARNESS.read_text()
    assert "--network host" in harness
    assert "127.0.0.1" in harness
    assert "LUNA_FACTORY_ENABLED" in harness
    assert '"type":"prompt"' in harness
    assert "LUNA_FACTORY_PROBE_ROOT" in harness
    for marker in ("factoryRoot", "luna_factory_open", "luna_factory_candidate", "luna_factory_attempt", "luna_factory_dispatch", "nativeResultIds"):
        assert marker in harness, marker
    assert "HOME" in harness
    assert "XDG_STATE_HOME" in harness
    assert "luna-factory-omp-probe-config.yml" in harness
    assert "luna-factory-omp-probe-models.yml" in harness
    assert "--no-session" not in harness
    assert "provider.log" in harness
    assert "write_result blocked" in harness


def test_sif_harness_uses_apptainer_directly_and_does_not_claim_krun():
    harness = HARNESS.read_text()
    assert "BLUEFIN_REVIEW_FALLBACK_SIF" in harness
    assert "apptainer exec" in harness
    assert "--bind" in harness
    assert "krun" not in harness


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
    for marker in ("userNamespace", '"apptainer"', '"kvm"', '"krun"', '"sif"'):
        assert marker in probe, marker


if __name__ == "__main__":
    test_workflow_is_exact_head_no_publish_and_artifact_bounded()
    test_oci_harness_is_clean_and_uses_the_local_provider()
    test_sif_harness_uses_apptainer_directly_and_does_not_claim_krun()
    test_capability_probe_records_required_host_boundaries()
