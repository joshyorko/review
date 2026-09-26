#!/usr/bin/env bash
# Compile the production adapter against declarations from the exact packaged SDK.
set -euo pipefail
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
modules="${OMP_SDK_NODE_MODULES:?Set OMP_SDK_NODE_MODULES to an isolated installation of the pinned SDK, TypeScript and @types/node}"
work="$(mktemp -d)"
trap 'rm -rf -- "$work"' EXIT
node - "$root" "$modules" "$work/tsconfig.json" <<'JS'
const fs = require('node:fs');
const path = require('node:path');
const [root, modulesInput, config] = process.argv.slice(2);
const modules = path.resolve(modulesInput);
const version = fs.readFileSync(path.join(root, 'image/appliance/Containerfile'), 'utf8').match(/^ARG OMP_VERSION=(\S+)$/m)?.[1];
const pkg = JSON.parse(fs.readFileSync(path.join(modules, '@oh-my-pi/pi-coding-agent/package.json'), 'utf8'));
if (!version || pkg.version !== version) throw new Error(`SDK mismatch: appliance ${version}, installed ${pkg.version}`);
fs.writeFileSync(config, JSON.stringify({compilerOptions: {
  target: 'ES2023', module: 'NodeNext', moduleResolution: 'NodeNext', strict: true,
  noEmit: true, allowImportingTsExtensions: true, skipLibCheck: true,
  types: ['node'], typeRoots: [path.join(modules, '@types')], paths: {
    '@oh-my-pi/pi-coding-agent': [path.join(modules, '@oh-my-pi/pi-coding-agent/dist/types/index.d.ts')],
    '@oh-my-pi/omptype/zod': [path.join(modules, '@oh-my-pi/omptype/dist/types/zod.d.ts')]
  }
}, files: ['batch-native.ts', 'batch-service.ts'].map(file => path.join(root, 'image/extension/luna-factory/omp', file))}));
console.log(`Checking production adapter against OMP ${version}`);
JS
"$modules/.bin/tsc" -p "$work/tsconfig.json"
