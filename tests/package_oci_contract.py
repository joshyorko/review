"""Personal Brew wrapper selects the matching Review OCI image and SIF fallback."""
from pathlib import Path
import subprocess
import tempfile

ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "scripts/package-review"
WORKFLOW = ROOT / ".github/workflows/release.yml"


def test_wrapper_uses_review_scoped_controls_and_keeps_sif_fallback():
    script = SCRIPT.read_text()
    wrapper = script.split('cat > "$work/payload/review" <<EOF\n', 1)[1].split("\nEOF\n", 1)[0]
    assert "REVIEW_APPLIANCE_IMAGE" in wrapper
    assert "ghcr.io/joshyorko/review:sha-" in script
    assert "REVIEW_APPLIANCE_FALLBACK_SIF" in wrapper
    assert "REVIEW_MODE" not in wrapper
    assert "BLUEFIN_REVIEW_IMAGE" not in wrapper
    assert "BLUEFIN_REVIEW_MODE" not in wrapper
    assert "BLUEFIN_REVIEW_PERSONAL_MODE" not in wrapper
    assert "BLUEFIN_REVIEW_ALLOW_WORKFLOW_SLAY" not in wrapper


def test_personal_workflow_publishes_matching_oci_before_tap_update():
    workflow = WORKFLOW.read_text()
    assert "packages: write" in workflow
    assert "ghcr.io/joshyorko/review" in workflow
    assert "skopeo copy --all --preserve-digests" in workflow
    assert "podman manifest" in workflow


def test_personal_workflow_adds_arch_images_by_immutable_repository_digest():
    workflow = WORKFLOW.read_text()
    assert 'arch_repository="${arch_image%%:*}"' in workflow
    assert 'podman manifest add "$image" "$arch_repository@$digest"' in workflow
    assert 'podman manifest add "$image" "docker://$arch_image@$digest"' not in workflow


def test_publication_accepts_only_the_clean_current_main_source():
    workflow = WORKFLOW.read_text()
    guard = (ROOT / "scripts/validate-release-source.sh").read_text()
    assert 'main_sha="$(git rev-parse origin/main)"' in workflow
    assert 'if [ "$AUTOMATIC" = false ] && [ "$PUBLISH" = true ]; then' in workflow
    assert '[[ "$GITHUB_REF" == refs/heads/main ]]' in workflow
    assert '[[ "$sha" == "$main_sha" ]]' in workflow
    assert 'bash scripts/validate-release-source.sh "$sha" "$main_sha" "$PUBLISH"' in workflow
    assert '[[ "$head_sha" == "$source_sha" ]]' in guard
    assert '[[ -z "$(git status --porcelain=v1)" ]]' in guard
    assert '[[ "$publish" == true && "$source_sha" != "$main_sha" ]]' in guard
    assert 'scripts/ci/native-appliance.sh' not in workflow
    assert 'appliance-archive' not in workflow
    assert "if: needs.prepare.outputs.publish == 'true' && github.ref == 'refs/heads/main'" in workflow


def test_candidate_build_has_no_registry_write_or_credential_boundary():
    workflow = WORKFLOW.read_text()
    build = workflow.split("  build:\n", 1)[1].split("\n  publish:\n", 1)[0]
    publish = workflow.split("\n  publish:\n", 1)[1]
    assert "contents: read" in build
    assert "packages: write" not in build
    assert "GITHUB_TOKEN" not in build
    assert "REVIEW_OCI_PUSH" not in build
    assert "podman push" not in build
    assert "REVIEW_OCI_ARCHIVE:" in build
    assert "oci-archive:$REVIEW_OCI_ARCHIVE" in SCRIPT.read_text()
    assert "if: needs.prepare.outputs.publish == 'true'" in workflow
    assert "packages: write" in publish
    assert 'skopeo copy --all --preserve-digests --dest-authfile "$authfile"' in publish
    assert "archive_identity=\"$(skopeo inspect --format '{{.Digest}} {{index .Labels \"org.opencontainers.image.revision\"}}' \"oci-archive:$archive\")\"" in publish
    assert 'bash scripts/ci/check-oci-digest.sh "$archive_digest" "$registry_digest"' in publish
    assert "record['oci_archive_digest']=sys.argv[2]" in publish
    assert "record['oci_arch_digest']=sys.argv[3]" in publish
    assert "review-candidate-check" in build
    assert "review-candidate-check" not in publish
    assert "if: needs.prepare.outputs.publish == 'true' && github.ref == 'refs/heads/main'" in workflow


def test_archive_to_registry_manifest_digest_gate_rejects_rewritten_manifests():
    gate = ROOT / "scripts/ci/check-oci-digest.sh"
    source = "sha256:" + "a" * 64
    same = subprocess.run(["bash", str(gate), source, source], capture_output=True, text=True)
    assert same.returncode == 0, same.stderr
    rewritten = subprocess.run(
        ["bash", str(gate), source, "sha256:" + "b" * 64], capture_output=True, text=True
    )
    assert rewritten.returncode == 3
    assert "changed the OCI manifest digest" in rewritten.stderr


def test_hostile_candidate_guard_replacement_cannot_reach_publish_job():
    with tempfile.TemporaryDirectory() as temporary:
        repo = Path(temporary) / "repo"
        repo.mkdir()
        subprocess.run(["git", "init", "-q", "--initial-branch=main", str(repo)], check=True)
        subprocess.run(["git", "-C", str(repo), "config", "user.name", "Release fixture"], check=True)
        subprocess.run(["git", "-C", str(repo), "config", "user.email", "release@example.invalid"], check=True)
        (repo / "VERSION").write_text("0.1.7\n")
        (repo / "scripts").mkdir()
        (repo / "scripts/validate-release-source.sh").write_text("#!/usr/bin/env bash\nexit 3\n")
        subprocess.run(["git", "-C", str(repo), "add", "."], check=True)
        subprocess.run(["git", "-C", str(repo), "commit", "-qm", "trusted main"], check=True)
        main_sha = subprocess.check_output(["git", "-C", str(repo), "rev-parse", "HEAD"], text=True).strip()
        (repo / "scripts/validate-release-source.sh").write_text("#!/usr/bin/env bash\nexit 0\n")
        subprocess.run(["git", "-C", str(repo), "add", "scripts/validate-release-source.sh"], check=True)
        subprocess.run(["git", "-C", str(repo), "commit", "-qm", "hostile candidate guard"], check=True)
        candidate_sha = subprocess.check_output(["git", "-C", str(repo), "rev-parse", "HEAD"], text=True).strip()
        assert candidate_sha != main_sha
        assert len(candidate_sha) == 40

    workflow = WORKFLOW.read_text()
    manual_publish_guard = workflow.split('if [ "$AUTOMATIC" = false ] && [ "$PUBLISH" = true ]; then', 1)[1].split("fi", 1)[0]
    assert '[[ "$GITHUB_REF" == refs/heads/main ]]' in manual_publish_guard
    assert '[[ "$sha" == "$main_sha" ]]' in manual_publish_guard
    assert 'bash scripts/validate-release-source.sh "$sha" "$main_sha" "$PUBLISH"' in manual_publish_guard
    assert "if: needs.prepare.outputs.publish == 'true' && github.ref == 'refs/heads/main'" in workflow


if __name__ == "__main__":
    test_wrapper_uses_review_scoped_controls_and_keeps_sif_fallback()
    test_personal_workflow_publishes_matching_oci_before_tap_update()
    test_personal_workflow_adds_arch_images_by_immutable_repository_digest()
    test_publication_accepts_only_the_clean_current_main_source()
    test_candidate_build_has_no_registry_write_or_credential_boundary()
    test_archive_to_registry_manifest_digest_gate_rejects_rewritten_manifests()
    test_hostile_candidate_guard_replacement_cannot_reach_publish_job()
