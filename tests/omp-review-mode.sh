#!/usr/bin/env bash
# Contract gate for the omp review mode.
#
# The mode is the only TypeScript this repository ships, and it is loaded by omp
# from source. Nothing else validates it: there is no bundler, no tsc, and the
# extension only fails at runtime, inside a TUI, where a stack trace is a
# repainted frame. This runs the mode headlessly instead.
#
#   1. `node --test` drives the real modules against a fake omp host, a fake
#      GitHub, and a real on-disk state tree in a temp directory.
#   2. The Python harness contract covers the adapter and the package layout omp
#      needs in order to load the mode and its companion agents at all.
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_root"
test_files=(
  tests/omp-review-mode.test.ts
  tests/pr_reader.test.ts
  tests/personal_policy.test.ts
  tests/luna_factory.test.ts
  tests/luna_factory_dogfood_contract.test.ts
  tests/luna_factory_native.test.ts
  tests/luna_factory_batch.test.ts
  tests/luna_factory_projection.test.ts
  tests/luna_factory_dashboard.test.ts
  tests/luna_factory_dashboard_integration.test.ts
  tests/luna_factory_dashboard_actions.test.ts
  tests/luna_factory_evidence.test.ts
  tests/luna_factory_evidence_viewer.test.ts
  tests/luna_factory_claims.test.ts
  tests/luna_factory_claim_owner_bridge.test.ts
  tests/luna_factory_history.test.ts
  tests/luna_factory_operator.test.ts
)

if ! command -v node >/dev/null 2>&1; then
  echo "omp-review-mode: node is required to exercise the review mode" >&2
  exit 1
fi

# Type stripping (no transpile) is Node's default from 23.6; be explicit about
# the requirement so an older runtime fails with a sentence instead of a parse error.
node_major="$(node --version | sed -E 's/^v([0-9]+).*/\1/')"
if ((node_major < 24)); then
  if command -v bun >/dev/null 2>&1; then
    for test_file in "${test_files[@]}"; do
      printf 'omp-review-mode: running %s\n' "$test_file"
      bun test "$test_file"
    done
    bash tests/launcher-contract.sh
    exit 0
  fi
  echo "omp-review-mode: node >= 24 required for TypeScript type stripping (found $(node --version))" >&2
  exit 1
fi

for test_file in "${test_files[@]}"; do
  printf 'omp-review-mode: running %s\n' "$test_file"
  node --test --test-reporter=tap --disable-warning=MODULE_TYPELESS_PACKAGE_JSON "$test_file"
done
python3 tests/personal_brew_oci_contract.py
bash tests/launcher-contract.sh
