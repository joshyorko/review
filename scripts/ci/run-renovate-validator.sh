#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
node_modules="${RENOVATE_NODE_MODULES:-}"
if [[ -z "$node_modules" ]]; then
  tool_dir="$(mktemp -d "${TMPDIR:-/tmp}/review-ci-renovate.XXXXXX")"
  trap 'rm -rf -- "$tool_dir"' EXIT
  node - "$repo_root/ci/toolchains.json" "$tool_dir/package.json" <<'JS'
const fs = require("node:fs");
const [lockPath, packagePath] = process.argv.slice(2);
const verification = JSON.parse(fs.readFileSync(lockPath, "utf8")).verification;
if (verification.renovate !== "44.181.2" || verification.renovateRe2 !== "1.27.0") {
	throw new Error("Renovate package pins do not match the checked-in verifier contract");
}
fs.writeFileSync(packagePath, JSON.stringify({
	private: true,
	allowScripts: { re2: true },
	dependencies: {
		renovate: verification.renovate,
		re2: verification.renovateRe2,
	},
}));
JS

  npm install --prefix "$tool_dir" --no-save --no-package-lock --no-audit --no-fund
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
