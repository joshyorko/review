#!/usr/bin/env bash
# Authoring-only tool, pinned to upstream release bytes. No host installation.
set -euo pipefail
[[ $(uname -s) == Linux && $(uname -m) == x86_64 ]] || { echo 'git-cliff authoring installer requires Linux x86_64' >&2; exit 1; }
destination="${1:?usage: install-git-cliff.sh destination-directory}"
mkdir -p "$destination"
work="$(mktemp -d)"
trap 'rm -rf -- "$work"' EXIT
curl --fail --location --silent --show-error https://github.com/orhun/git-cliff/releases/download/v2.14.2/git-cliff-2.14.2-x86_64-unknown-linux-gnu.tar.gz -o "$work/cliff.tar.gz"
printf '%s  %s\n' 24f397c733add5390fdceee3a2088588ab0d5f944ce00d34cb7029b888cf2db4 "$work/cliff.tar.gz" | sha256sum --check --status
tar -xzf "$work/cliff.tar.gz" -C "$work"
install -m 0755 "$work/git-cliff-2.14.2/git-cliff" "$destination/git-cliff"
