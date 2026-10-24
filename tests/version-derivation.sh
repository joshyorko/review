#!/usr/bin/env bash
# The appliance release version is independent of its distribution builder.
set -euo pipefail
repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
fixture="$(mktemp -d)"
trap 'rm -rf "$fixture"' EXIT
mkdir -p "$fixture/scripts"
cp "$repo_root/scripts/review-appliance-version.sh" "$fixture/scripts/"
for version in 0.1.0 1.2.3 20.0.100; do
  printf '%s\n' "$version" >"$fixture/VERSION"
  [[ "$(bash "$fixture/scripts/review-appliance-version.sh")" == "$version" ]]
done
for version in 01.2.3 1.2 1.2.3.4 '1.2.3 extra' ''; do
  printf '%s\n' "$version" >"$fixture/VERSION"
  if bash "$fixture/scripts/review-appliance-version.sh" >/dev/null 2>&1; then
    echo "accepted invalid version: $version" >&2
    exit 1
  fi
done
rm "$fixture/VERSION"
if bash "$fixture/scripts/review-appliance-version.sh" >/dev/null 2>&1; then
  echo 'accepted missing VERSION' >&2
  exit 1
fi
echo 'version-derivation: standalone version contract holds'
