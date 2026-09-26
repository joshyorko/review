#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
omp_binary="${OMP_BINARY:-omp}"
expected_version="omp/18.3.2"
probe_root="$(mktemp -d "${TMPDIR:-/tmp}/luna-factory-sdk-init.XXXXXX")"
output="$probe_root/omp-output.log"

if ! command -v "$omp_binary" >/dev/null 2>&1; then
	printf 'BLOCKED: OMP binary unavailable: %s\n' "$omp_binary" >&2
	exit 78
fi
actual_version="$("$omp_binary" --version 2>/dev/null || true)"
if [[ "$actual_version" != "$expected_version" ]]; then
	printf 'BLOCKED: expected %s, found %s\n' "$expected_version" "${actual_version:-unknown}" >&2
	exit 78
fi
if ! command -v timeout >/dev/null 2>&1; then
	printf 'BLOCKED: timeout unavailable\n' >&2
	exit 78
fi

mkdir -p "$probe_root/workspace" "$probe_root/factory-state" "$probe_root/factory-claims" "$probe_root/sessions"
export LUNA_SDK_INIT_PROBE_ROOT="$probe_root"
export LUNA_SDK_INIT_PACKAGED="${LUNA_SDK_INIT_PACKAGED:-1}"

coproc omp_sdk_probe {
	timeout --signal=TERM --kill-after=5s 75s \
		"$omp_binary" --mode rpc-ui --no-extensions --no-skills --no-rules --no-pty --profile "${OMP_PROFILE:-review}" \
		--session-dir "$probe_root/sessions" \
		--extension "$repo_root/tests/fixtures/luna-factory-omp-sdk-init-probe.ts" \
		>"$output" 2>&1
}
probe_pid="$omp_sdk_probe_PID"
probe_input="${omp_sdk_probe[1]}"

for _ in {1..800}; do
	if [[ -s "$probe_root/result.json" ]]; then break; fi
	if ! kill -0 "$probe_pid" 2>/dev/null; then break; fi
	sleep 0.1
done

exec {probe_input}>&- 2>/dev/null || true
set +e
wait "$probe_pid"
status=$?
set -e

if [[ -s "$probe_root/result.json" ]] && grep -q '"status": "passed"' "$probe_root/result.json" && [[ "$status" -eq 0 ]]; then
	cat "$probe_root/result.json"
	printf 'OMP output retained at %s\n' "$output"
	exit 0
fi

if [[ -s "$probe_root/result.json" ]]; then
	cat "$probe_root/result.json" >&2
else
	printf 'FAILED: no probe result; OMP exit=%s. Output retained at %s\n' "$status" "$output" >&2
fi
exit 1
