#!/usr/bin/env bash
set -uo pipefail

readonly max_attempts=3

if (($# != 1)); then
  echo "usage: install-precommit-hooks.sh <pre-commit-config>" >&2
  exit 2
fi

config="$1"
if [[ ! -f "$config" ]]; then
  echo "pre-commit hook acquisition: config file is unavailable" >&2
  exit 2
fi
if ! command -v pre-commit >/dev/null 2>&1; then
  echo "pre-commit hook acquisition: pre-commit executable is unavailable" >&2
  exit 127
fi

temporary="$(mktemp -d "${TMPDIR:-/tmp}/review-precommit-hooks.XXXXXXXX")" || {
  echo "pre-commit hook acquisition: could not create a private log directory" >&2
  exit 1
}

# shellcheck disable=SC2329 # Called indirectly by the EXIT trap.
cleanup() {
  local file
  for file in current.stdout current.stderr current.combined first.stdout first.stderr last.stdout last.stderr; do
    [[ ! -e "$temporary/$file" ]] || rm -- "$temporary/$file"
  done
  rmdir -- "$temporary" 2>/dev/null || true
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

emit_logs() {
  local stdout_file="$1"
  local stderr_file="$2"
  [[ ! -s "$stdout_file" ]] || cat -- "$stdout_file"
  [[ ! -s "$stderr_file" ]] || cat -- "$stderr_file" >&2
}

is_transient_acquisition_error() {
  grep -Eiq \
    'stream error: stream ID [0-9]+; INTERNAL_ERROR; received from peer|connection reset by peer|ConnectionResetError|TLS handshake timeout|ReadTimeoutError|ConnectTimeoutError|i/o timeout|context deadline exceeded|Temporary failure in name resolution|Temporary failure resolving|Could not resolve host|no such host|Name or service not known|remote end hung up unexpectedly|HTTP/(1\.[01]|2)[[:space:]]+(429|5[0-9][0-9])|returned error: (429|5[0-9][0-9])' \
    "$temporary/current.combined"
}

first_status=""
for ((attempt = 1; attempt <= max_attempts; attempt++)); do
  printf 'pre-commit hook acquisition attempt %d/%d\n' "$attempt" "$max_attempts" >&2
  if pre-commit install-hooks --config "$config" >"$temporary/current.stdout" 2>"$temporary/current.stderr"; then
    if ((attempt > 1)); then
      printf 'pre-commit hook acquisition recovered on attempt %d/%d after transient failure (first exit %s).\n' \
        "$attempt" "$max_attempts" "$first_status" >&2
      emit_logs "$temporary/first.stdout" "$temporary/first.stderr"
    fi
    emit_logs "$temporary/current.stdout" "$temporary/current.stderr"
    exit 0
  else
    status=$?
  fi

  cat -- "$temporary/current.stdout" "$temporary/current.stderr" >"$temporary/current.combined"
  if ! is_transient_acquisition_error; then
    printf 'pre-commit hook acquisition stopped after non-retryable failure (exit %s).\n' "$status" >&2
    if [[ -n "$first_status" ]]; then
      emit_logs "$temporary/first.stdout" "$temporary/first.stderr"
    fi
    emit_logs "$temporary/current.stdout" "$temporary/current.stderr"
    exit "$status"
  fi

  if ((attempt == 1)); then
    first_status="$status"
    cp -- "$temporary/current.stdout" "$temporary/first.stdout"
    cp -- "$temporary/current.stderr" "$temporary/first.stderr"
  fi
  cp -- "$temporary/current.stdout" "$temporary/last.stdout"
  cp -- "$temporary/current.stderr" "$temporary/last.stderr"

  if ((attempt == max_attempts)); then
    printf 'pre-commit hook acquisition exhausted %d attempts (first exit %s, last exit %s).\n' \
      "$max_attempts" "$first_status" "$status" >&2
    emit_logs "$temporary/first.stdout" "$temporary/first.stderr"
    emit_logs "$temporary/last.stdout" "$temporary/last.stderr"
    exit "$status"
  fi

  delay="$attempt"
  printf 'pre-commit hook acquisition saw a classified transient download failure; retrying in %ss.\n' "$delay" >&2
  sleep "$delay"
done

exit 1
