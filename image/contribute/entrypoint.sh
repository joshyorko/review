#!/usr/bin/env bash
set -euo pipefail
if [[ -n "${AGENT_BACKEND:-}" && "${AGENT_BACKEND}" != omp ]]; then
  echo "ERROR: this contribute image supports only AGENT_BACKEND=omp." >&2
  exit 64
fi
export AGENT_BACKEND=omp
exec /usr/local/bin/contributor-agent.sh "$@"
