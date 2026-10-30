#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
sdk_version="$(sed -n 's/^ARG OMP_VERSION=//p' "$repo_root/image/appliance/Containerfile")"
typescript_version="$(jq -r '.verification.typescript' "$repo_root/ci/toolchains.json")"
node_types_version="$(jq -r '.verification.nodeTypes' "$repo_root/ci/toolchains.json")"
sdk_root="$(mktemp -d "${TMPDIR:-/tmp}/review-ci-sdk.XXXXXX")"
trap 'rm -rf -- "$sdk_root"' EXIT

npm install --prefix "$sdk_root" --ignore-scripts --no-audit --no-fund \
  "typescript@$typescript_version" "@types/node@$node_types_version" \
  "@oh-my-pi/pi-coding-agent@$sdk_version"
OMP_SDK_NODE_MODULES="$sdk_root/node_modules" bash "$repo_root/tests/luna-factory-sdk-types.sh"
