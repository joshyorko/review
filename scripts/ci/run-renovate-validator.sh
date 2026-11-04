#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
node_modules="${RENOVATE_NODE_MODULES:-}"
if [[ -z "$node_modules" ]]; then
  tool_dir="$(mktemp -d "${TMPDIR:-/tmp}/review-ci-renovate.XXXXXX")"
  trap 'rm -rf -- "$tool_dir"' EXIT
  cp "$repo_root/ci/renovate-validator/package.json" "$repo_root/ci/renovate-validator/package-lock.json" "$tool_dir/"
  npm ci --prefix "$tool_dir" --no-audit --no-fund
  node_modules="$tool_dir/node_modules"
fi

node - "$repo_root/ci/toolchains.json" "$node_modules" <<'JS'
const fs = require("node:fs");
const [lockPath, nodeModules] = process.argv.slice(2);
const verification = JSON.parse(fs.readFileSync(lockPath, "utf8")).verification;
for (const [name, expected] of [["renovate", verification.renovate], ["re2", verification.renovateRe2]]) {
	const actual = JSON.parse(fs.readFileSync(`${nodeModules}/${name}/package.json`, "utf8")).version;
	if (actual !== expected) throw new Error(`${name} mismatch: expected ${expected}, found ${actual}`);
}
JS

"$node_modules/.bin/renovate-config-validator" --strict "$repo_root/renovate.json"
