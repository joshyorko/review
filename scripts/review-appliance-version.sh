#!/usr/bin/env bash
# Print the review appliance version.
#
# FSDK versioning, extended by one component: <fsdk-series>.<tool-revision>.
# The series is not written down twice — it is read from the pinned FSDK base in
# the Containerfile, so rebasing onto a new freedesktop-sdk release moves the
# appliance's version with it and cannot drift from what actually shipped. The
# only hand-maintained number is the tool revision in image/appliance/REVISION,
# bumped when the appliance changes on an unchanged base.
#
#   ghcr.io/projectbluefin/base:26.08.0@sha256:…  +  REVISION=3  ->  26.08.03
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
containerfile="${repo_root}/image/appliance/Containerfile"
revision_file="${repo_root}/image/appliance/REVISION"

base_ref="$(sed -nE 's/^ARG FSDK_BASE_IMAGE=(.*)$/\1/p' "$containerfile" | head -1)"
if [[ -z "$base_ref" ]]; then
  echo "review-version: no ARG FSDK_BASE_IMAGE in ${containerfile}" >&2
  exit 1
fi

# ghcr.io/projectbluefin/base:26.08.0@sha256:… -> 26.08.0
base_tag="${base_ref#*base:}"
base_tag="${base_tag%%@*}"

if [[ ! "$base_tag" =~ ^([0-9]{2}\.[0-9]{2}) ]]; then
  echo "review-version: cannot read an FSDK series from base tag '${base_tag}'" >&2
  exit 1
fi
series="${BASH_REMATCH[1]}"

revision="$(tr -d '[:space:]' <"$revision_file")"
if [[ ! "$revision" =~ ^[0-9]+$ ]]; then
  echo "review-version: ${revision_file} must contain a single integer, got '${revision}'" >&2
  exit 1
fi
# Format revision with leading zero if single digit, so version is always 26.08.MM
formatted_revision=$(printf '%02d' "$((10#$revision))")
printf '%s.%s\n' "$series" "$formatted_revision"
