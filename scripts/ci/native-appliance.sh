#!/usr/bin/env bash
set -euo pipefail

usage() { printf 'usage: %s <source-snapshot> <revision-sha> <oci-archive>\n' "$0"; }
[[ $# -eq 3 ]] || {
  usage >&2
  exit 2
}
source_root="$1"
revision="$2"
archive="$3"
[[ "$revision" =~ ^[0-9a-f]{40}$ ]] || {
  echo 'native-appliance: revision must be a full lowercase commit SHA' >&2
  exit 2
}
[[ -s "$archive" ]] || {
  echo 'native-appliance: Dagger OCI archive is missing or empty' >&2
  exit 2
}

work="$(mktemp -d "${TMPDIR:-/tmp}/review-ci-native.XXXXXX")"
image_ref="localhost/review-ci:${revision:0:12}-$$"
image_id=""
image_preexisting=0
blocked=0
krun_runtime_path=""
unset_args=(-u GH_TOKEN -u GITHUB_TOKEN -u GITHUB_COPILOT_TOKEN -u COPILOT_GITHUB_TOKEN
  -u RENOVATE_TOKEN -u REVIEW_GH_TOKEN -u OPENAI_API_KEY -u ANTHROPIC_API_KEY
  -u GEMINI_API_KEY -u CONTEXT7_API_KEY -u AWS_ACCESS_KEY_ID -u AWS_SECRET_ACCESS_KEY
  -u AWS_SESSION_TOKEN)
for env_name in ${!APPTAINERENV_@} ${!SINGULARITYENV_@}; do
  unset_args+=(-u "$env_name")
done
cleanup() {
  if [[ -n "$image_id" && "$image_preexisting" -eq 0 ]]; then
    podman image rm --force "$image_id" >/dev/null 2>&1 || true
  elif [[ -n "$image_id" ]]; then
    podman image rm "$image_ref" >/dev/null 2>&1 || true
  fi
  rm -rf -- "$work"
}
trap cleanup EXIT

archive_sha="$(sha256sum "$archive" | cut -d ' ' -f 1)"
case "$(uname -m)" in
x86_64) expected_arch=amd64 ;;
aarch64) expected_arch=arm64 ;;
*)
  echo "native-appliance: unsupported host architecture: $(uname -m)" >&2
  exit 3
  ;;
esac
podman_available=1
if ! command -v podman >/dev/null 2>&1 || ! podman info >/dev/null 2>&1; then
  podman_available=0
  blocked=1
  echo 'native-appliance: BLOCKED podman engine unavailable' >&2
else
  expected_image_id="$(
    python3 - "$archive" <<'PY'
import json, re, sys, tarfile
with tarfile.open(sys.argv[1]) as archive:
    index = json.load(archive.extractfile("index.json"))
    manifests = index.get("manifests", [])
    if len(manifests) != 1:
        raise SystemExit("expected one platform-specific OCI manifest")
    descriptor = manifests[0]["digest"]
    manifest = json.load(archive.extractfile(f"blobs/{descriptor.replace(':', '/')}"))
    config_digest = manifest["config"]["digest"]
    if not re.fullmatch(r"sha256:[0-9a-f]{64}", config_digest):
        raise SystemExit("OCI image config digest is malformed")
    print(config_digest)
PY
  )"
  if podman image exists "$expected_image_id"; then image_preexisting=1; fi
  load_output="$(podman load --input "$archive")"
  printf '%s\n' "$load_output"
  image_id="$(sed -n 's/^Loaded image: \(sha256:[0-9a-f]\{64\}\)$/\1/p' <<<"$load_output" | tail -n 1)"
  [[ -n "$image_id" ]] || {
    echo 'native-appliance: podman did not report the imported image ID' >&2
    exit 1
  }
  [[ "$image_id" == "$expected_image_id" ]] || {
    printf 'native-appliance: imported config identity mismatch: expected %s, received %s\n' "$expected_image_id" "$image_id" >&2
    exit 1
  }
  podman tag "$image_id" "$image_ref"
  identity="$(podman image inspect --format '{{.Os}}/{{.Architecture}} {{index .Labels "org.opencontainers.image.revision"}} {{index .Labels "org.opencontainers.image.version"}}' "$image_ref")"
  [[ "$identity" == "linux/$expected_arch $revision $(<"$source_root/VERSION")" ]] || {
    printf 'native-appliance: loaded OCI identity mismatch: %s\n' "$identity" >&2
    exit 1
  }
  podman run --rm --entrypoint /usr/bin/omp "$image_ref" --version

  if env "${unset_args[@]}" REVIEW_APPLIANCE_IMAGE="$image_ref" LUNA_FACTORY_HEAD_SHA="$revision" \
    bash "$source_root/tests/luna-factory-dogfood.sh" oci; then
    echo 'native-appliance: Podman OCI dogfood passed'
  else
    status=$?
    if [[ "$status" -eq 78 ]]; then
      blocked=1
      echo 'native-appliance: BLOCKED Podman OCI dogfood prerequisite unavailable' >&2
    else
      echo "native-appliance: Podman OCI dogfood failed (exit $status)" >&2
      exit "$status"
    fi
  fi

  krun_runtime_path="$(podman info --runtime=krun --format '{{.Host.OCIRuntime.Path}}' 2>/dev/null || true)"
  if [[ -n "$krun_runtime_path" && -x "$krun_runtime_path" &&
    -e /dev/kvm && -r /dev/kvm && -w /dev/kvm ]]; then
    if env "${unset_args[@]}" REVIEW_APPLIANCE_IMAGE="$image_ref" REVIEW_SMOKE_RUNTIME=krun \
      bash "$source_root/tests/review-factory-coload-smoke.sh"; then
      echo 'native-appliance: Podman krun co-load smoke passed'
    else
      echo 'native-appliance: Podman krun co-load smoke failed' >&2
      exit 1
    fi
  else
    blocked=1
    echo 'native-appliance: BLOCKED Podman krun requires an available krun runtime and readable/writable /dev/kvm' >&2
  fi
fi

sif="$work/review.sif"
if command -v apptainer >/dev/null 2>&1; then
  if APPTAINER_CACHEDIR="$work/apptainer-cache" apptainer build "$sif" "oci-archive:$archive"; then
    sif_revision="$(apptainer inspect --json "$sif" | python3 -c 'import json,sys; print(json.load(sys.stdin)["data"]["attributes"]["labels"].get("org.opencontainers.image.revision", ""))')"
    [[ "$sif_revision" == "$revision" ]] || {
      echo "native-appliance: SIF revision mismatch: $sif_revision" >&2
      exit 1
    }
    apptainer exec --containall "$sif" /usr/bin/omp --version
    if env "${unset_args[@]}" APPTAINER_CACHEDIR="$work/apptainer-cache" APPTAINER_TMPDIR="$work/apptainer-tmp" \
      REVIEW_APPLIANCE_FALLBACK_SIF="$sif" LUNA_FACTORY_HEAD_SHA="$revision" \
      bash "$source_root/tests/luna-factory-dogfood.sh" sif; then
      echo 'native-appliance: Apptainer SIF dogfood passed'
    else
      status=$?
      if [[ "$status" -eq 78 ]]; then
        blocked=1
        echo 'native-appliance: BLOCKED Apptainer SIF dogfood prerequisite unavailable' >&2
      else
        echo "native-appliance: Apptainer SIF dogfood failed (exit $status)" >&2
        exit "$status"
      fi
    fi
  else
    echo 'native-appliance: Apptainer OCI-archive conversion failed' >&2
    exit 1
  fi
else
  blocked=1
  echo 'native-appliance: BLOCKED Apptainer unavailable' >&2
fi

if [[ -x "$source_root/tests/appliance-runtime-probe.sh" ]]; then
  "$source_root/tests/appliance-runtime-probe.sh" "$work/capabilities" "$revision"
  python3 - "$work/capabilities/capabilities.json" <<'PY'
import json, sys
report = json.load(open(sys.argv[1], encoding="utf-8"))
print("native-appliance: runtime boundaries " + ", ".join(
    f"{name}={value['status']}" for name, value in report["boundaries"].items()
))
PY
fi

printf 'native-appliance: artifact=sha256:%s revision=%s podman=%s apptainer=%s krun=%s\n' \
  "$archive_sha" "$revision" "$([[ "$podman_available" -eq 1 ]] && echo available || echo blocked)" \
  "$(command -v apptainer >/dev/null 2>&1 && echo available || echo blocked)" \
  "${krun_runtime_path:-blocked}"
((blocked == 0)) || exit 3
