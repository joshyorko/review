#!/usr/bin/env bash
# Contract for launcher argument parsing and Brew/SIF and source launcher parity.
#
# Verifies that:
#   1. scripts/parse-review-args.sh parses all shorthand forms and mixed combinations.
#   2. bin/bluefin review forwards parsed flags to the SIF container rather than prompt text.
#   3. bin/omp-review forwards identical parsed flags to omp.
#   4. Brew/SIF and source launchers have complete argument parity.
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_root"

# shellcheck source=scripts/parse-review-args.sh
source "${repo_root}/scripts/parse-review-args.sh"

fail() {
  echo "launcher-contract: $*" >&2
  exit 1
}

assert_eq() {
  local actual="$1"
  local expected="$2"
  local label="${3:-}"
  if [[ "$actual" != "$expected" ]]; then
    fail "${label}: expected '${expected}', got '${actual}'"
  fi
}

# --- 1. Parser unit tests across all forms and mixed combinations -------------

test_cases=(
  "projectbluefin/review|--repo projectbluefin/review"
  "projectbluefin/review #463|--repo projectbluefin/review --pr 463"
  "projectbluefin/review 463|--repo projectbluefin/review --pr 463"
  "projectbluefin/review#463|--repo projectbluefin/review --pr 463"
  "https://github.com/projectbluefin/review|--repo projectbluefin/review"
  "https://github.com/projectbluefin/review#463|--repo projectbluefin/review --pr 463"
  "https://github.com/projectbluefin/review/pull/463|--repo projectbluefin/review --pr 463"
  "https://github.com/projectbluefin/review/issues/463|--repo projectbluefin/review --pr 463"
  "org:projectbluefin|--repo org:projectbluefin"
  "#463|--pr 463"
  "463|--pr 463"
  "--repo projectbluefin/review|--repo projectbluefin/review"
  "--repo projectbluefin/review #463|--repo projectbluefin/review --pr 463"
  "--repo projectbluefin/review 463|--repo projectbluefin/review --pr 463"
  "--repo projectbluefin/review#463|--repo projectbluefin/review --pr 463"
  "--repo=projectbluefin/review#463|--repo projectbluefin/review --pr 463"
  "--pr 463|--pr 463"
  "--pr #463|--pr 463"
  "--pr=463|--pr 463"
  "--pr=#463|--pr 463"
  "issues|--issues"
  "--issues|--issues"
  "all|--all"
  "--all|--all"
  "autoslay|--autoslay"
  "slay|--autoslay"
  "--autoslay|--autoslay"
  "bluefin|--repo bluefin"
  "bluefin #123|--repo bluefin --pr 123"
  "bluefin#123|--repo bluefin --pr 123"
  "projectbluefin/review issues|--repo projectbluefin/review --issues"
  "projectbluefin/review --issues|--repo projectbluefin/review --issues"
  "issues projectbluefin/review|--issues --repo projectbluefin/review"
  "--issues projectbluefin/review|--issues --repo projectbluefin/review"
  "projectbluefin/review #463 --issues|--repo projectbluefin/review --pr 463 --issues"
  "projectbluefin/review#463 --issues|--repo projectbluefin/review --pr 463 --issues"
  "--issues projectbluefin/review#463|--issues --repo projectbluefin/review --pr 463"
  "--issues projectbluefin/review #463|--issues --repo projectbluefin/review --pr 463"
  "projectbluefin/review issues #463|--repo projectbluefin/review --issues --pr 463"
  "--repo projectbluefin/review --issues|--repo projectbluefin/review --issues"
  "--issues --repo projectbluefin/review|--issues --repo projectbluefin/review"
  "projectbluefin/review --skip-repo lab|--repo projectbluefin/review --skip-repo lab"
  "--skip-repo lab projectbluefin/review|--skip-repo lab --repo projectbluefin/review"
)

for case in "${test_cases[@]}"; do
  input="${case%%|*}"
  expected="${case#*|}"
  # shellcheck disable=SC2086
  parse_review_args $input
  actual="${PARSED_REVIEW_ARGS[*]:-}"
  assert_eq "$actual" "$expected" "parse_review_args '$input'"
done

# Verify standalone execution of parse-review-args.sh
standalone_out="$("${repo_root}/scripts/parse-review-args.sh" projectbluefin/review#463 --issues | tr '\n' ' ' | sed 's/ $//')"
assert_eq "$standalone_out" "--repo projectbluefin/review --pr 463 --issues" "standalone parse-review-args.sh"

# --- 2. Hermetic test of bin/bluefin review (Brew / SIF launcher) --------------

scratch="$(mktemp -d)"
trap 'rm -rf "$scratch"' EXIT

mkdir -p "$scratch/bin"
mock_apptainer_log="$scratch/apptainer.log"
cat >"$scratch/bin/apptainer" <<EOF
#!/usr/bin/env bash
printf '%s\n' "\$*" >>"$mock_apptainer_log"
exit 0
EOF
chmod +x "$scratch/bin/apptainer"

cat >"$scratch/bin/gh" <<'EOF'
#!/usr/bin/env bash
if [[ "$*" == "auth token"* ]]; then
  echo "mock-token"
  exit 0
fi
exit 1
EOF
chmod +x "$scratch/bin/gh"

mock_sif="$scratch/bluefin-review.sif"
touch "$mock_sif" && chmod +x "$mock_sif"

export BLUEFIN_REVIEW_SIF="$mock_sif"
export PATH="$scratch/bin:$PATH"

assert_bluefin_review() {
  local input="$1"
  local expected_flags="$2"
  rm -f "$mock_apptainer_log"

  # shellcheck disable=SC2086
  "${repo_root}/bin/bluefin" review $input >/dev/null 2>&1 || fail "bin/bluefin review failed for: $input"

  [[ -f "$mock_apptainer_log" ]] || fail "bin/bluefin review did not invoke apptainer for: $input"
  local apptainer_call
  apptainer_call="$(cat "$mock_apptainer_log")"

  # apptainer run --home ... "$sif" [FLAGS...]
  # Verify that the expected flags were passed after "$mock_sif"
  local passed_flags="${apptainer_call#*"$mock_sif"}"
  passed_flags="$(echo "$passed_flags" | xargs)"

  assert_eq "$passed_flags" "$expected_flags" "bin/bluefin review $input flags"
  # Invariant: no shorthand reaches the container as bare positional prompt text
  if [[ "$passed_flags" == *"projectbluefin/review"* && "$passed_flags" != *"--repo projectbluefin/review"* ]]; then
    fail "shorthand reached apptainer as prompt text: $passed_flags"
  fi
}

assert_bluefin_review "projectbluefin/review" "--repo projectbluefin/review"
assert_bluefin_review "projectbluefin/review #463" "--repo projectbluefin/review --pr 463"
assert_bluefin_review "projectbluefin/review#463" "--repo projectbluefin/review --pr 463"
assert_bluefin_review "--issues projectbluefin/review" "--issues --repo projectbluefin/review"
assert_bluefin_review "projectbluefin/review#463 --issues" "--repo projectbluefin/review --pr 463 --issues"

# --- 3. Hermetic test of bin/omp-review (Source launcher) ----------------------

mock_omp_log="$scratch/omp.log"
cat >"$scratch/bin/omp" <<EOF
#!/usr/bin/env bash
printf '%s\n' "\$*" >>"$mock_omp_log"
exit 0
EOF
chmod +x "$scratch/bin/omp"

assert_omp_review() {
  local input="$1"
  local expected_flags="$2"
  rm -f "$mock_omp_log"

  # shellcheck disable=SC2086
  "${repo_root}/bin/omp-review" $input >/dev/null 2>&1 || fail "bin/omp-review failed for: $input"

  [[ -f "$mock_omp_log" ]] || fail "bin/omp-review did not invoke omp for: $input"
  local omp_call
  omp_call="$(cat "$mock_omp_log")"

  # omp --profile review --extension <path> [FLAGS...]
  local passed_flags
  passed_flags="$(echo "$omp_call" | sed -E 's/^--profile review --extension [^ ]+ ?//' | xargs)"

  assert_eq "$passed_flags" "$expected_flags" "bin/omp-review $input flags"
  if [[ "$passed_flags" == *"projectbluefin/review"* && "$passed_flags" != *"--repo projectbluefin/review"* ]]; then
    fail "shorthand reached omp as prompt text: $passed_flags"
  fi
}

assert_omp_review "projectbluefin/review" "--repo projectbluefin/review"
assert_omp_review "projectbluefin/review #463" "--repo projectbluefin/review --pr 463"
assert_omp_review "projectbluefin/review#463" "--repo projectbluefin/review --pr 463"
assert_omp_review "--issues projectbluefin/review" "--issues --repo projectbluefin/review"
assert_omp_review "projectbluefin/review#463 --issues" "--repo projectbluefin/review --pr 463 --issues"

# --- 4. Parity test: Brew/SIF and source launchers produce identical flags ----

for case in "${test_cases[@]}"; do
  input="${case%%|*}"
  expected="${case#*|}"
  assert_bluefin_review "$input" "$expected"
  assert_omp_review "$input" "$expected"
done

echo "launcher-contract: all shorthand forms and launcher parity assertions passed"
