#!/usr/bin/env bash
set -euo pipefail
script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"

: "${OMP_VERSION:?OMP_VERSION is required}"
: "${OMP_SOURCE_COMMIT:?OMP_SOURCE_COMMIT is required}"
: "${OMP_SOURCE_SHA256:?OMP_SOURCE_SHA256 is required}"
: "${OMP_PATCH_SHA256:?OMP_PATCH_SHA256 is required}"
: "${OMP_BUN_VERSION:?OMP_BUN_VERSION is required}"
: "${OMP_BUN_X86_64_SHA256:?OMP_BUN_X86_64_SHA256 is required}"
: "${OMP_BUN_AARCH64_SHA256:?OMP_BUN_AARCH64_SHA256 is required}"
: "${OMP_NATIVES_VERSION:?OMP_NATIVES_VERSION is required}"
: "${OMP_NATIVES_X86_64_SHA512:?OMP_NATIVES_X86_64_SHA512 is required}"
: "${OMP_NATIVES_AARCH64_SHA512:?OMP_NATIVES_AARCH64_SHA512 is required}"
: "${MEMORYD_SOURCE_COMMIT:?MEMORYD_SOURCE_COMMIT is required}"
: "${MEMORYD_SOURCE_SHA256:?MEMORYD_SOURCE_SHA256 is required}"
: "${OMP_PATCH_PATH:?OMP_PATCH_PATH is required}"
: "${OMP_OUTPUT_PATH:?OMP_OUTPUT_PATH is required}"

if [[ ! "$OMP_VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ || ! "$OMP_SOURCE_COMMIT" =~ ^[0-9a-f]{40}$ || ! "$MEMORYD_SOURCE_COMMIT" =~ ^[0-9a-f]{40}$ ]]; then
  echo "invalid OMP or MemoryD version/commit pin" >&2
  exit 1
fi
for tool in curl git python3 tar sha256sum sha512sum install; do
  command -v "$tool" >/dev/null || {
    echo "missing build prerequisite: $tool" >&2
    exit 1
  }
done
[[ -f "$OMP_PATCH_PATH" ]] || {
  echo "OMP patch not found: $OMP_PATCH_PATH" >&2
  exit 1
}
if [[ "$OMP_PATCH_PATH" != /* ]]; then
  OMP_PATCH_PATH="$PWD/$OMP_PATCH_PATH"
fi

case "$(uname -m)" in
x86_64)
  omp_target=linux-x64
  bun_asset=bun-linux-x64-baseline.zip
  bun_member=bun-linux-x64-baseline/bun
  bun_sha="$OMP_BUN_X86_64_SHA256"
  native_package=pi-natives-linux-x64
  native_sha="$OMP_NATIVES_X86_64_SHA512"
  native_file=pi_natives.linux-x64-baseline.node
  ;;
aarch64 | arm64)
  omp_target=linux-arm64
  bun_asset=bun-linux-aarch64.zip
  bun_member=bun-linux-aarch64/bun
  bun_sha="$OMP_BUN_AARCH64_SHA256"
  native_package=pi-natives-linux-arm64
  native_sha="$OMP_NATIVES_AARCH64_SHA512"
  native_file=pi_natives.linux-arm64.node
  ;;
*)
  echo "unsupported derived OMP build architecture: $(uname -m)" >&2
  exit 1
  ;;
esac

workdir="$(mktemp -d)"
trap 'rm -rf "$workdir"' EXIT
source_dir="$workdir/omp"
mkdir -p "$source_dir" "$workdir/memoryd" "$workdir/bin" "$workdir/native"

omp_tag="refs/tags/v${OMP_VERSION}"
tag_refs="$(git ls-remote --exit-code https://github.com/can1357/oh-my-pi.git "$omp_tag" "${omp_tag}^{}")"
tag_commit=""
while IFS=$'\t' read -r object ref; do
  case "$ref" in
  "${omp_tag}^{}") tag_commit="$object" ;;
  "$omp_tag") tag_commit="${tag_commit:-$object}" ;;
  esac
done <<<"$tag_refs"
[[ "$tag_commit" == "$OMP_SOURCE_COMMIT" ]] || {
  echo "OMP v${OMP_VERSION} tag resolves to ${tag_commit:-missing}, expected ${OMP_SOURCE_COMMIT}" >&2
  exit 1
}

omp_archive="$workdir/omp-source.tar.gz"
curl --fail --location --show-error --silent \
  "https://github.com/can1357/oh-my-pi/archive/${OMP_SOURCE_COMMIT}.tar.gz" -o "$omp_archive"
printf '%s  %s\n' "$OMP_SOURCE_SHA256" "$omp_archive" | sha256sum --check --status || {
  echo "OMP source archive digest mismatch for ${OMP_SOURCE_COMMIT}" >&2
  exit 1
}
tar --no-same-owner --extract --gzip --file "$omp_archive" --directory "$source_dir" --strip-components=1
sha256sum "$OMP_PATCH_PATH" | {
  read -r actual _
  [[ "$actual" == "$OMP_PATCH_SHA256" ]]
} || {
  echo "OMP registration patch digest mismatch" >&2
  exit 1
}
git -C "$source_dir" apply --check "$OMP_PATCH_PATH"
git -C "$source_dir" apply "$OMP_PATCH_PATH"

memoryd_archive="$workdir/memoryd-source.tar.gz"
curl --fail --location --show-error --silent \
  "https://github.com/joshyorko/codex-memoryd/archive/${MEMORYD_SOURCE_COMMIT}.tar.gz" -o "$memoryd_archive"
printf '%s  %s\n' "$MEMORYD_SOURCE_SHA256" "$memoryd_archive" | sha256sum --check --status || {
  echo "MemoryD adapter source archive digest mismatch for ${MEMORYD_SOURCE_COMMIT}" >&2
  exit 1
}
tar --no-same-owner --extract --gzip --file "$memoryd_archive" --directory "$workdir/memoryd" --strip-components=1
adapter_source="$workdir/memoryd/adapters/omp-memory-provider/src"
[[ -f "$adapter_source/index.ts" ]] || {
  echo "pinned MemoryD source archive is missing the adapter" >&2
  exit 1
}

bun_archive="$workdir/$bun_asset"
curl --fail --location --show-error --silent \
  "https://github.com/oven-sh/bun/releases/download/bun-v${OMP_BUN_VERSION}/${bun_asset}" -o "$bun_archive"
printf '%s  %s\n' "$bun_sha" "$bun_archive" | sha256sum --check --status || {
  echo "Bun ${OMP_BUN_VERSION} ${bun_asset} digest mismatch" >&2
  exit 1
}
python3 -m zipfile -e "$bun_archive" "$workdir"
install -m 0755 "$workdir/$bun_member" "$workdir/bin/bun"
export PATH="$workdir/bin:$PATH"
[[ "$(bun --version)" == "$OMP_BUN_VERSION" ]] || {
  echo "downloaded Bun version does not match ${OMP_BUN_VERSION}" >&2
  exit 1
}

native_archive="$workdir/${native_package}-${OMP_NATIVES_VERSION}.tgz"
curl --fail --location --show-error --silent \
  "https://registry.npmjs.org/%40oh-my-pi%2F${native_package}/-/${native_package}-${OMP_NATIVES_VERSION}.tgz" -o "$native_archive"
printf '%s  %s\n' "$native_sha" "$native_archive" | sha512sum --check --status || {
  echo "@oh-my-pi/${native_package}@${OMP_NATIVES_VERSION} integrity mismatch" >&2
  exit 1
}
tar --no-same-owner --extract --gzip --file "$native_archive" --directory "$workdir/native" --strip-components=1
[[ -s "$workdir/native/$native_file" ]] || {
  echo "@oh-my-pi/${native_package}@${OMP_NATIVES_VERSION} has no expected native addon: ${native_file}" >&2
  exit 1
}
mkdir -p "$source_dir/packages/natives/native"
for addon in "$workdir/native/"*.node; do
  [[ -s "$addon" ]] || continue
  install -m 0644 "$addon" "$source_dir/packages/natives/native/${addon##*/}"
done
cd "$source_dir"
bun install --frozen-lockfile --no-progress
bun --cwd="$workdir/memoryd/adapters/omp-memory-provider" test tests
bun --cwd=packages/coding-agent run check:types
bun --cwd=packages/coding-agent test test/memory-backend-resolve.test.ts
bun --cwd=packages/coding-agent test test/modes/components/settings-selector-memory-refresh.test.ts
bun scripts/ci-release-build-binaries.ts "--targets=${omp_target}"

candidate="$source_dir/packages/coding-agent/binaries/omp-${omp_target}"
[[ -x "$candidate" ]] || {
  echo "OMP build did not produce ${candidate}" >&2
  exit 1
}
version_output="$("$candidate" --version)"
[[ "$version_output" == "omp/${OMP_VERSION}" ]] || {
  echo "derived OMP version mismatch: ${version_output}" >&2
  exit 1
}
bun "$script_dir/derived-omp-canary.ts" "$candidate" "$adapter_source/index.ts" "$workdir/canary"
install -D -m 0755 "$candidate" "$OMP_OUTPUT_PATH"

printf 'OMP derived build: version=%s commit=%s arch=%s\n' "$OMP_VERSION" "$OMP_SOURCE_COMMIT" "$omp_target"
printf 'OMP patch SHA-256: %s\n' "$OMP_PATCH_SHA256"
printf 'MemoryD source: %s (archive SHA-256 %s)\n' "$MEMORYD_SOURCE_COMMIT" "$MEMORYD_SOURCE_SHA256"
printf 'Bun version: %s (archive SHA-256 %s)\n' "$OMP_BUN_VERSION" "$bun_sha"
printf 'Native package: @oh-my-pi/%s@%s (archive SHA-512 %s)\n' "$native_package" "$OMP_NATIVES_VERSION" "$native_sha"
printf 'Derived OMP SHA-256: '
sha256sum "$OMP_OUTPUT_PATH"
