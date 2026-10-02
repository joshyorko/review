#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
exec node "$repo_root/tests/fixtures/luna-factory-graph-acceptance-driver.mjs" "${1:-native}"
