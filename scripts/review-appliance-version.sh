#!/usr/bin/env bash
# Print the standalone Review semantic version.
set -euo pipefail
repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
version_file="${repo_root}/VERSION"
[[ -r "$version_file" ]] || {
  echo "review-version: missing VERSION" >&2
  exit 1
}
version="$(<"$version_file")"
[[ "$version" =~ ^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$ ]] || {
  echo "review-version: VERSION must contain one semantic version" >&2
  exit 1
}
printf '%s\n' "$version"
