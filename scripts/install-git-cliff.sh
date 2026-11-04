#!/usr/bin/env bash
# Authoring-only tool, pinned to upstream release bytes. No host installation.
set -euo pipefail
[[ $(uname -s) == Linux ]] || {
  echo 'git-cliff authoring installer requires Linux' >&2
  exit 1
}

case "$(uname -m)" in
x86_64)
  asset='git-cliff-2.14.2-x86_64-unknown-linux-gnu.tar.gz'
  algorithm=sha256sum
  digest=24f397c733add5390fdceee3a2088588ab0d5f944ce00d34cb7029b888cf2db4
  ;;
aarch64)
  asset='git-cliff-2.14.2-aarch64-unknown-linux-gnu.tar.gz'
  algorithm=sha512sum
  digest=fd27768ea76fea8c3ba3f3247fef2f6604988b629f15e48bf40be5eaa08b8fef2e4087cc9c8af16bc522bc19cc369611fa7692101b513f63469ad58522708600
  ;;
*)
  echo "git-cliff authoring installer does not support $(uname -m)" >&2
  exit 1
  ;;
esac
destination="${1:?usage: install-git-cliff.sh destination-directory}"
mkdir -p "$destination"
work="$(mktemp -d)"
trap 'rm -rf -- "$work"' EXIT
curl --fail --location --silent --show-error "https://github.com/orhun/git-cliff/releases/download/v2.14.2/$asset" -o "$work/cliff.tar.gz"
printf '%s  %s\n' "$digest" "$work/cliff.tar.gz" | "$algorithm" --check --status
tar -xzf "$work/cliff.tar.gz" -C "$work"
binary="$(find "$work" -type f -name git-cliff -print -quit)"
[[ -n "$binary" ]] || {
  echo 'git-cliff archive did not contain its executable' >&2
  exit 1
}
install -m 0755 "$binary" "$destination/git-cliff"
