#!/usr/bin/env bash
# Review-owned host gVisor runtime bundle manager.
set -euo pipefail

readonly GVISOR_RELEASE="release-20260831.0"
readonly GVISOR_BASE_URL="https://github.com/google/gvisor/releases/download/${GVISOR_RELEASE}"
readonly GVISOR_X86_64_SHA256="014b3871a5c698c802fd7a03758e0dbf4c1683f9e3f8c743979ea66bbf6553a4"
readonly GVISOR_AARCH64_SHA256="24e91d9b2e02079d18837380a7c9d32cb04c58ccbb1f95901f09d10057f1261d"

runtime_root="${BLUEFIN_REVIEW_RUNTIME_ROOT:-/var/lib/bluefin-review/runtime/gvisor}"
runtime_dir="${runtime_root%/}/${GVISOR_RELEASE}"
runtime_current="${runtime_root%/}/current"

die() {
  printf 'ERROR: review runtime: %s\n' "$1" >&2
  exit 1
}

require_absolute_root() {
  [[ "$runtime_root" == /* && "$runtime_root" != "/" ]] ||
    die "runtime root must be an absolute, non-root path"
  [[ ! -L "$runtime_root" ]] || die "runtime root must not be a symlink"
}

require_install_owner() {
  if [[ "$runtime_root" == /var/lib/bluefin-review/* && "$(id -u)" != 0 ]]; then
    die "install, update, and remove require root for ${runtime_root}; use sudo just review-runtime ..."
  fi
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
  [[ "$(stat -c %a "$dir")" == 755 ]] || die "bundle directory permissions must be 0755"
  [[ -x "$dir/runsc" && ! -L "$dir/runsc" ]] || die "bundle runsc is not a regular executable"
  [[ -x "$dir/containerd-shim-runsc-v1" && ! -L "$dir/containerd-shim-runsc-v1" ]] ||
    die "bundle containerd-shim-runsc-v1 is not a regular executable"
  [[ -d "$dir/gvisor-bin" && ! -L "$dir/gvisor-bin" ]] || die "bundle gvisor-bin is missing or symlinked"
  [[ "$(stat -c %a "$dir/gvisor-bin")" == 755 ]] || die "gvisor-bin permissions must be 0755"
  find "$dir" -type l -print -quit | grep -q . && die "bundle contains a symlink"
  while IFS= read -r member; do
    [[ "$member" != /* && "$member" != *../* && "$member" != */../* ]] ||
      die "bundle contains an unsafe member: $member"
  done < <(find "$dir" -mindepth 1 -printf '%P\n')
}

resolved_bundle_dir() {
  local target
  if [[ -L "$runtime_current" ]]; then
    target="$(readlink -f -- "$runtime_current")"
    case "$target" in
      "${runtime_root%/}"/*) ;;
      *) die "current runtime link escapes the Review runtime root" ;;
    esac
    printf '%s\n' "$target"
    return 0
  fi
  [[ ! -e "$runtime_current" ]] || die "current runtime selector is not a symlink"
  printf '%s\n' "$runtime_dir"
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
  local stage="$1" selector
  if [[ -e "$runtime_dir" || -L "$runtime_dir" ]]; then
    validate_bundle "$runtime_dir" || die "existing pinned bundle is invalid; refusing replacement"
    return 0
  fi
  mv -- "$stage" "$runtime_dir" || die "bundle publication failed"
  selector="${runtime_root%/}/.current.$$"
  ln -s -- "$GVISOR_RELEASE" "$selector"
  mv -T -- "$selector" "$runtime_current"
}

install_bundle() {
  local asset sha archive stage extract
  read -r asset sha < <(architecture_asset)
  require_absolute_root
  require_install_owner
  mkdir -p -- "$runtime_root"
  [[ -d "$runtime_root" && ! -L "$runtime_root" ]] || die "runtime root is not a directory"
  if [[ "$(id -u)" == 0 ]]; then
    chown 0:0 "$runtime_root"
    chmod 0755 "$runtime_root"
  fi
  if [[ -e "$runtime_dir" || -L "$runtime_dir" ]]; then
    validate_bundle "$runtime_dir"
    printf 'Review gVisor bundle %s is already installed; update the pinned release to advance it\n' "$GVISOR_RELEASE"
    return 0
  fi
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
  require_install_owner
  local resolved
  resolved="$(resolved_bundle_dir)"
  [[ -e "$runtime_dir" || -L "$runtime_dir" ]] || {
    printf 'Review gVisor bundle %s is not installed\n' "$GVISOR_RELEASE"
    return 0
  }
  [[ -d "$runtime_dir" && ! -L "$runtime_dir" ]] || die "refusing to remove a symlinked bundle"
  validate_bundle "$runtime_dir"
  if [[ -L "$runtime_current" ]]; then
    [[ "$(readlink -f -- "$runtime_current")" == "$runtime_dir" ]] ||
      die "current runtime selector points at a different bundle"
    rm -f -- "$runtime_current"
  fi
  rm -rf -- "$runtime_dir"
  printf 'removed Review gVisor bundle %s\n' "$GVISOR_RELEASE"
}

status_bundle() {
  local resolved
  resolved="$(resolved_bundle_dir 2>/dev/null || true)"
  if [[ -n "$resolved" ]] && validate_bundle "$resolved" >/dev/null 2>&1; then
    printf 'installed %s\n' "$resolved"
    return 0
  fi
  printf 'missing %s\n' "$runtime_dir"
  return 1
}

path_bundle() {
  local resolved
  resolved="$(resolved_bundle_dir 2>/dev/null || true)"
  [[ -n "$resolved" ]] || return 1
  validate_bundle "$resolved" >/dev/null 2>&1 || return 1
  printf '%s\n' "$resolved/runsc"
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
