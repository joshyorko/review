"""Personal Brew wrapper must prefer the matching OCI image and retain the matching SIF as fallback."""
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "scripts/brew-dev"
WORKFLOW = ROOT / ".github/workflows/review-dev.yml"


def test_wrapper_enables_personal_workflow_actions_and_keeps_sif_fallback():
    script = SCRIPT.read_text()
    wrapper = script.split('cat > "$work/payload/bluefin" <<EOF\n', 1)[1].split("\nEOF\n", 1)[0]
    assert "BLUEFIN_REVIEW_IMAGE" in wrapper
    assert "ghcr.io/joshyorko/review-appliance:sha-" in script
    assert "BLUEFIN_REVIEW_FALLBACK_SIF" in wrapper
    assert "export BLUEFIN_REVIEW_MODE=review" in wrapper
    assert "export BLUEFIN_REVIEW_PERSONAL_MODE=1" in wrapper
    assert "export BLUEFIN_REVIEW_SHOW_WORKFLOW_PRS=1" in wrapper
    assert 'export BLUEFIN_REVIEW_ALLOW_WORKFLOW_SLAY="\\${BLUEFIN_REVIEW_ALLOW_WORKFLOW_SLAY:-1}"' in wrapper
    assert 'export BLUEFIN_REVIEW_SIF="$root/launcher/bluefin-review.sif"' not in wrapper


def test_personal_workflow_publishes_matching_oci_before_tap_update():
    workflow = WORKFLOW.read_text()
    assert "packages: write" in workflow
    assert "ghcr.io/joshyorko/review-appliance" in workflow
    assert "podman push" in workflow
    assert "podman manifest" in workflow


def test_personal_workflow_adds_arch_images_by_immutable_repository_digest():
    workflow = WORKFLOW.read_text()
    assert 'arch_repository="${arch_image%%:*}"' in workflow
    assert 'podman manifest add "$image" "$arch_repository@$digest"' in workflow
    assert 'podman manifest add "$image" "docker://$arch_image@$digest"' not in workflow


if __name__ == "__main__":
    test_wrapper_enables_personal_workflow_actions_and_keeps_sif_fallback()
    test_personal_workflow_publishes_matching_oci_before_tap_update()
    test_personal_workflow_adds_arch_images_by_immutable_repository_digest()
