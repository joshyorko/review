#!/usr/bin/env bash
set -euo pipefail
repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
containerfile="${repo_root}/image/contribute/Containerfile"
revision_file="${repo_root}/image/contribute/REVISION"
base_ref="$(sed -nE 's/^ARG FSDK_BASE_IMAGE=(.*)$/\1/p' "$containerfile" | head -1)"
if [[ -z "$base_ref" ]]; then
  echo "contribute-version: no ARG FSDK_BASE_IMAGE in ${containerfile}" >&2
  exit 1
fi
base_tag="${base_ref#*base:}"
base_tag="${base_tag%%@*}"
if [[ ! "$base_tag" =~ ^([0-9]{2}\.[0-9]{2}) ]]; then
  echo "contribute-version: cannot read an FSDK series from base tag '${base_tag}'" >&2
  exit 1
fi
series="${BASH_REMATCH[1]}"
if [[ ! -r "$revision_file" ]]; then
  echo "contribute-version: missing or unreadable REVISION file ${revision_file}" >&2
  exit 1
fi
revision="$(<"$revision_file")"
if [[ ! "$revision" =~ ^[0-9]+$ ]]; then
  echo "contribute-version: ${revision_file} must contain a single integer, got '${revision}'" >&2
  exit 1
fi
printf '%s.%02d\n' "$series" "$((10#$revision))"
