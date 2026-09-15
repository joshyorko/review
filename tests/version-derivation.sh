#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
scratch="$(mktemp -d)"
trap 'rm -rf "$scratch"' EXIT

fail() {
  printf 'version-derivation: %s\n' "$1" >&2
  exit 1
}

make_fixture() {
  local script="$1" image="$2" base_lines="$3" revision="$4"
  fixture="$scratch/${script%.sh}-${case_name}"
  mkdir -p "$fixture/scripts" "$fixture/image/$image"
  cp "$repo_root/scripts/$script" "$fixture/scripts/$script"
  chmod +x "$fixture/scripts/$script"
  printf '%s\n' "$base_lines" >"$fixture/image/$image/Containerfile"
  if [[ "$revision" != __missing__ ]]; then
    printf '%s' "$revision" >"$fixture/image/$image/REVISION"
  fi
}

assert_success() {
  local script="$1" image="$2" base_lines="$3" revision="$4" expected="$5"
  case_name=$((case_name + 1))
  make_fixture "$script" "$image" "$base_lines" "$revision"
  local output
  output="$("$fixture/scripts/$script" 2>&1)" || fail "$script rejected valid fixture: $output"
  [[ "$output" == "$expected" ]] || fail "$script expected '$expected', got '$output'"
}

assert_failure() {
  local script="$1" image="$2" base_lines="$3" revision="$4" expected="$5"
  case_name=$((case_name + 1))
  make_fixture "$script" "$image" "$base_lines" "$revision"
  local output status
  set +e
  output="$("$fixture/scripts/$script" 2>&1)"
  status=$?
  set -e
  [[ "$status" -ne 0 ]] || fail "$script accepted invalid fixture producing '$output'"
  [[ "$output" == *"$expected"* ]] || fail "$script error did not contain '$expected': $output"
}

case_name=0
for spec in "review-appliance-version.sh appliance review-version" "contribute-version.sh contribute contribute-version"; do
  read -r script image prefix <<<"$spec"
  assert_success "$script" "$image" 'ARG FSDK_BASE_IMAGE=ghcr.io/projectbluefin/base:26.08.0@sha256:deadbeef' '7' '26.08.07'
  assert_success "$script" "$image" 'ARG FSDK_BASE_IMAGE=ghcr.io/projectbluefin/base:26.08.0@sha256:deadbeef' '08' '26.08.08'
  assert_success "$script" "$image" 'ARG FSDK_BASE_IMAGE=ghcr.io/projectbluefin/base:26.08.0@sha256:deadbeef' '09' '26.08.09'
  assert_success "$script" "$image" 'ARG FSDK_BASE_IMAGE=ghcr.io/projectbluefin/base:26.08@sha256:deadbeef' '12' '26.08.12'
  assert_success "$script" "$image" $'ARG FSDK_BASE_IMAGE=ghcr.io/projectbluefin/base:26.08.0@sha256:first\nARG FSDK_BASE_IMAGE=ghcr.io/projectbluefin/base:99.99.0@sha256:second' '3' '26.08.03'
  assert_failure "$script" "$image" 'ARG FSDK_BASE_IMAGE=ghcr.io/projectbluefin/base:latest@sha256:deadbeef' '7' 'FSDK series'
  assert_failure "$script" "$image" 'ARG OTHER=value' '7' 'ARG FSDK_BASE_IMAGE'
  assert_failure "$script" "$image" 'ARG FSDK_BASE_IMAGE=ghcr.io/projectbluefin/base:26.08.0@sha256:deadbeef' '__missing__' 'REVISION'
  assert_failure "$script" "$image" 'ARG FSDK_BASE_IMAGE=ghcr.io/projectbluefin/base:26.08.0@sha256:deadbeef' '3 4' 'single integer'
done

review_version="$(bash "$repo_root/scripts/review-appliance-version.sh")"
contribute_version="$(bash "$repo_root/scripts/contribute-version.sh")"
[[ "$review_version" =~ ^[0-9]{2}\.[0-9]{2}\.[0-9]{2}$ ]] || fail "committed review version is malformed: $review_version"
[[ "$contribute_version" =~ ^[0-9]{2}\.[0-9]{2}\.[0-9]{2}$ ]] || fail "committed contributor version is malformed: $contribute_version"
[[ "${review_version%.*}" == "${contribute_version%.*}" ]] ||
  fail "image series diverge: review=$review_version contribute=$contribute_version"

printf 'version-derivation: %d synthetic cases and committed image versions passed\n' "$case_name"
