#!/usr/bin/env bash
set -euo pipefail

fixture_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
exec node "$fixture_root/tests/fixtures/luna-factory-owned-pr-acceptance-driver.mjs" "${1:-native}"
