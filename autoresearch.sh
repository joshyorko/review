#!/usr/bin/env bash
set -euo pipefail

# Benchmark harness for porting review to omp with lower-third UI / review / issues modes.
# Runs hermetic contract tests verifying:
# 1. OMP harness adapter conformance (DraftRequest, streaming, exact binding)
# 2. OMP RPC client protocol integration (prompt, review, issues API dispatch)
# 3. Lower-third TUI layout & keyboard shortcut handling (j/k, activate, review, slay)

PYTHONPATH="${PWD}/image:${PYTHONPATH:-}" python3 -m unittest -v tests/omp_harness_contract.py > /tmp/omp_test_out.log 2>&1 || {
  cat /tmp/omp_test_out.log
  exit 1
}

# Calculate conformance metrics based on test passes
TESTS_RUN=$(grep -o "Ran [0-9]* tests" /tmp/omp_test_out.log | awk '{print $2}')
if grep -q "OK" /tmp/omp_test_out.log; then
  FAILED=0
else
  FAILED=1
fi

SCORE=$(awk -v run="$TESTS_RUN" -v fail="$FAILED" 'BEGIN { if (fail > 0) print 0; else print (run * 10) }')

echo "METRIC conformance_score=$SCORE"
echo "METRIC tests_run=$TESTS_RUN"
exit 0
