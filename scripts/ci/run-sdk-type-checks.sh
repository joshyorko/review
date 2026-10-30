#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
sdk_version="$(sed -n 's/^ARG OMP_VERSION=//p' "$repo_root/image/appliance/Containerfile")"
sdk_modules="${OMP_SDK_NODE_MODULES:-}"
sdk_temp=""
if [[ -z "$sdk_modules" ]]; then
  sdk_temp="$(mktemp -d "${TMPDIR:-/tmp}/review-ci-sdk.XXXXXX")"
  trap 'rm -rf -- "$sdk_temp"' EXIT
  cp "$repo_root/ci/sdk-types/package.json" "$repo_root/ci/sdk-types/package-lock.json" "$sdk_temp/"
  npm ci --prefix "$sdk_temp" --ignore-scripts --no-audit --no-fund
  sdk_modules="$sdk_temp/node_modules"
fi

SDK_VERSION="$sdk_version" SDK_NODE_MODULES="$sdk_modules" node <<'JS'
const fs = require("node:fs");
const path = require("node:path");
const modules = process.env.SDK_NODE_MODULES;
const expected = {
	"@oh-my-pi/pi-coding-agent": process.env.SDK_VERSION,
	"@types/node": "24.19.2",
	tsx: "4.21.0",
	typescript: "5.9.3",
};
for (const [name, version] of Object.entries(expected)) {
	const actual = JSON.parse(fs.readFileSync(path.join(modules, name, "package.json"), "utf8")).version;
	if (actual !== version) throw new Error(`${name} mismatch: expected ${version}, found ${actual}`);
}
JS
OMP_SDK_NODE_MODULES="$sdk_modules" bash "$repo_root/tests/luna-factory-sdk-types.sh"
