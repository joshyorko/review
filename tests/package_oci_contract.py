"""Personal Brew wrapper selects the matching Review OCI image and SIF fallback."""
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "scripts/package-review"
WORKFLOW = ROOT / ".github/workflows/release.yml"


def test_wrapper_uses_review_scoped_controls_and_keeps_sif_fallback():
    script = SCRIPT.read_text()
    wrapper = script.split('cat > "$work/payload/review" <<EOF\n', 1)[1].split("\nEOF\n", 1)[0]
    assert "REVIEW_APPLIANCE_IMAGE" in wrapper
    assert "ghcr.io/joshyorko/review:sha-" in script
    assert "REVIEW_APPLIANCE_FALLBACK_SIF" in wrapper
    assert "export REVIEW_MODE=review" in wrapper
    assert "BLUEFIN_REVIEW_IMAGE" not in wrapper
    assert "BLUEFIN_REVIEW_MODE" not in wrapper
    assert "BLUEFIN_REVIEW_PERSONAL_MODE" not in wrapper
    assert "BLUEFIN_REVIEW_ALLOW_WORKFLOW_SLAY" not in wrapper


def test_personal_workflow_publishes_matching_oci_before_tap_update():
    workflow = WORKFLOW.read_text()
    assert "packages: write" in workflow
    assert "ghcr.io/joshyorko/review" in workflow
    assert "podman push" in workflow
    assert "podman manifest" in workflow


def test_personal_workflow_adds_arch_images_by_immutable_repository_digest():
    workflow = WORKFLOW.read_text()
    assert 'arch_repository="${arch_image%%:*}"' in workflow
    assert 'podman manifest add "$image" "$arch_repository@$digest"' in workflow
    assert 'podman manifest add "$image" "docker://$arch_image@$digest"' not in workflow


if __name__ == "__main__":
    test_wrapper_uses_review_scoped_controls_and_keeps_sif_fallback()
    test_personal_workflow_publishes_matching_oci_before_tap_update()
    test_personal_workflow_adds_arch_images_by_immutable_repository_digest()
