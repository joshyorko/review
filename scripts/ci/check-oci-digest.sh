#!/usr/bin/env bash
set -euo pipefail

fail() {
  echo "check-oci-digest: $*" >&2
  exit 3
}
[[ $# -eq 2 ]] || {
  echo "usage: $0 <archive-manifest-digest> <registry-manifest-digest>" >&2
  exit 2
}
archive_digest="$1"
registry_digest="$2"
[[ "$archive_digest" =~ ^sha256:[0-9a-f]{64}$ ]] || fail 'archive manifest digest is malformed'
[[ "$registry_digest" =~ ^sha256:[0-9a-f]{64}$ ]] || fail 'registry manifest digest is malformed'
[[ "$archive_digest" == "$registry_digest" ]] || fail 'registry conversion changed the OCI manifest digest'
printf 'check-oci-digest: preserved %s\n' "$archive_digest"
