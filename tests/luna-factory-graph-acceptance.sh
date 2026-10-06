#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
profile="${1:-native}"
if [[ "$profile" == "--transport-check" ]]; then
  exec node --test "$repo_root/tests/fixtures/luna-factory-graph-krun-host-provider.test.mjs"
fi
exec node "$repo_root/tests/fixtures/luna-factory-graph-acceptance-driver.mjs" "$profile"
