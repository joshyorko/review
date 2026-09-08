#!/usr/bin/env bash
# Review-owned host gVisor runtime bundle manager.
set -euo pipefail

readonly GVISOR_RELEASE="release-20260831.0"
readonly GVISOR_BASE_URL="https://github.com/google/gvisor/releases/download/${GVISOR_RELEASE}"
readonly GVISOR_X86_64_SHA256="014b3871a5c698c802fd7a03758e0dbf4c1683f9e3f8c743979ea66bbf6553a4"
readonly GVISOR_AARCH64_SHA256="24e91d9b2e02079d18837380a7c9d32cb04c58ccbb1f95901f09d10057f1261d"

runtime_root="${BLUEFIN_REVIEW_RUNTIME_ROOT:-/var/lib/bluefin-review/runtime/gvisor}"
runtime_dir="${runtime_root%/}/${GVISOR_RELEASE}"

die() {
  printf 'ERROR: review runtime: %s\n' "$1" >&2
  exit 1
}

require_absolute_root() {
  [[ "$runtime_root" == /* && "$runtime_root" != "/" ]] ||
    die "runtime root must be an absolute, non-root path"
  [[ ! -L "$runtime_root" ]] || die "runtime root must not be a symlink"
}

architecture_asset() {
  case "$(uname -m)" in
    x86_64) printf 'gvisor-x86_64.tar.bz2 %s\n' "$GVISOR_X86_64_SHA256" ;;
    aarch64|arm64) printf 'gvisor-aarch64.tar.bz2 %s\n' "$GVISOR_AARCH64_SHA256" ;;
    *) die "unsupported architecture: $(uname -m)" ;;
  esac
}

validate_bundle() {
  local dir="$1" member
  [[ -d "$dir" && ! -L "$dir" ]] || die "bundle directory is missing or symlinked"
  [[ -x "$dir/runsc" && ! -L "$dir/runsc" ]] || die "bundle runsc is not a regular executable"
  [[ -x "$dir/containerd-shim-runsc-v1" && ! -L "$dir/containerd-shim-runsc-v1" ]] ||
    die "bundle containerd-shim-runsc-v1 is not a regular executable"
  [[ -d "$dir/gvisor-bin" && ! -L "$dir/gvisor-bin" ]] || die "bundle gvisor-bin is missing or symlinked"
  find "$dir" -type l -print -quit | grep -q . && die "bundle contains a symlink"
  while IFS= read -r member; do
    [[ "$member" != /* && "$member" != *../* && "$member" != */../* ]] ||
      die "bundle contains an unsafe member: $member"
  done < <(find "$dir" -mindepth 1 -printf '%P\n')
}

validate_archive_members() {
  local archive="$1" member
  while IFS= read -r member; do
    case "$member" in
      runsc|containerd-shim-runsc-v1|gvisor-bin/|gvisor-bin/*) ;;
      *) die "archive contains an unexpected member: $member" ;;
    esac
    [[ "$member" != /* && "$member" != *../* && "$member" != */../* ]] ||
      die "archive contains an unsafe member: $member"
  done < <(tar -tjf "$archive")
}

publish_bundle() {
  local stage="$1" backup=""
  if [[ -e "$runtime_dir" || -L "$runtime_dir" ]]; then
    validate_bundle "$runtime_dir" || die "existing pinned bundle is invalid; refusing replacement"
    backup="${runtime_root}/.${GVISOR_RELEASE}.previous.$$"
    mv -- "$runtime_dir" "$backup"
  fi
  if mv -- "$stage" "$runtime_dir"; then
    [[ -z "$backup" ]] || rm -rf -- "$backup"
    return 0
  fi
  [[ -z "$backup" ]] || mv -- "$backup" "$runtime_dir"
  die "atomic bundle publication failed"
}

install_bundle() {
  local asset sha archive stage extract
  read -r asset sha < <(architecture_asset)
  require_absolute_root
  mkdir -p -- "$runtime_root"
  [[ -d "$runtime_root" && ! -L "$runtime_root" ]] || die "runtime root is not a directory"
  stage="$(mktemp -d "${runtime_root%/}/.staging-${GVISOR_RELEASE}.XXXXXX")"
  trap 'rm -rf -- "$stage"' RETURN
  archive="$stage/$asset"
  extract="$stage/extract"
  mkdir -- "$extract"
  curl --fail --location --show-error --silent \
    "$GVISOR_BASE_URL/$asset" -o "$archive"
  printf '%s  %s\n' "$sha" "$archive" | sha256sum -c -
  validate_archive_members "$archive"
  tar -xjf "$archive" -C "$extract"
  chmod 0755 "$extract/runsc" "$extract/containerd-shim-runsc-v1" "$extract/gvisor-bin"/*
  chmod 0755 "$extract" "$extract/gvisor-bin"
  validate_bundle "$extract"
  publish_bundle "$extract"
  trap - RETURN
  rm -rf -- "$stage"
  printf 'installed Review gVisor bundle %s at %s\n' "$GVISOR_RELEASE" "$runtime_dir"
}

remove_bundle() {
  require_absolute_root
  [[ -e "$runtime_dir" || -L "$runtime_dir" ]] || {
    printf 'Review gVisor bundle %s is not installed\n' "$GVISOR_RELEASE"
    return 0
  }
  [[ -d "$runtime_dir" && ! -L "$runtime_dir" ]] || die "refusing to remove a symlinked bundle"
  validate_bundle "$runtime_dir"
  rm -rf -- "$runtime_dir"
  printf 'removed Review gVisor bundle %s\n' "$GVISOR_RELEASE"
}

status_bundle() {
  if validate_bundle "$runtime_dir" >/dev/null 2>&1; then
    printf 'installed %s\n' "$runtime_dir"
    return 0
  fi
  printf 'missing %s\n' "$runtime_dir"
  return 1
}

path_bundle() {
  validate_bundle "$runtime_dir" >/dev/null 2>&1 || return 1
  printf '%s\n' "$runtime_dir/runsc"
}

usage() {
  printf 'usage: %s {path|status|install|update|remove}\n' "${0##*/}" >&2
}

require_absolute_root
case "${1:-}" in
  path) path_bundle ;;
  status) status_bundle ;;
  install|update) install_bundle ;;
  remove) remove_bundle ;;
  *) usage; exit 2 ;;
esac
