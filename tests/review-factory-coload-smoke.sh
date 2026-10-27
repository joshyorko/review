#!/usr/bin/env bash
# Exercise the packaged Review appliance with Review and Luna Factory loaded
# together. The local model catalog keeps this smoke credential-free; command
# RPCs do not invoke model turns or provider requests.
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
image="${REVIEW_APPLIANCE_IMAGE:-${REVIEW_APPLIANCE_IMAGE:-localhost/review:factory-handoff}}"
run_root="${RUNNER_TEMP:-${TMPDIR:-/tmp}}/review-factory-coload-$$"
enabled_result=passed
mkdir -p "$run_root"
chmod 0777 "$run_root"

command -v podman >/dev/null 2>&1 || {
  echo "review-factory-coload-smoke: podman unavailable" >&2
  exit 78
}
podman image exists "$image" || {
  echo "review-factory-coload-smoke: image unavailable: $image" >&2
  exit 78
}

omp_version="$(sed -nE 's/^ARG OMP_VERSION=([^[:space:]]+)$/\1/p' "$root/image/appliance/Containerfile")"
version="$(podman run --rm --entrypoint /usr/bin/omp "$image" --version)"
grep -Fxq "omp/$omp_version" <<<"$version" || {
  echo "review-factory-coload-smoke: expected omp/$omp_version, got: $version" >&2
  exit 1
}

run_case() {
  local name="$1" expected="$2" flag="$3" output="$run_root/$1.jsonl"
  local home="$run_root/$name/home" profile="$run_root/$name/home/.omp/profiles/review-appliance/agent"
  mkdir -p "$profile"
  chmod 0777 "$home"
  sed 's#43127#43129#g' "$root/tests/fixtures/luna-factory-omp-probe-models.yml" >"$profile/models.yml"
  local -a env_args=(
    --env HOME=/home/review
    --env XDG_CONFIG_HOME=/host-xdg
    --env XDG_STATE_HOME=/home/review/.local/state
    --env XDG_CACHE_HOME=/home/review/.cache
    --env REVIEW_DEFAULT_SCOPE=example/repo
    --env REVIEW_MODE=review
    --env GH_TOKEN=
    --env GITHUB_TOKEN=
  )
  if [[ "$flag" == enabled ]]; then
    env_args+=(--env LUNA_FACTORY_ENABLED=1)
  fi

  set +e
  printf '%s\n' \
    '{"id":"commands","type":"get_available_commands"}' \
    '{"id":"factory-status","type":"prompt","message":"/factory status"}' |
    timeout --signal=TERM --kill-after=5s 30s podman run --rm --interactive --network host \
      --userns keep-id:uid=65532,gid=65532 "${env_args[@]}" \
      --volume "$home:/home/review:rw" "$image" \
      --mode rpc-ui --no-skills --no-rules --no-pty --model local-probe/deterministic \
      >"$output" 2>&1
  local status=$?
  set -e
  if [[ "$flag" == enabled && "$status" -eq 1 ]] &&
    grep -Fq '"kind":"review-factory-verifier","status":"blocked"' "$output" &&
    grep -Fq 'refusing opt-in startup before work selection.' "$output"; then
    if grep -Fq '"statusKey":"review_workbench"' "$output" || [[ -e "$home/.local/state/review" ]]; then
      echo "review-factory-coload-smoke: blocked verifier reached OMP or persistent state; evidence=$output" >&2
      return 1
    fi
    enabled_result=blocked
    cat "$output"
    echo "review-factory-coload-smoke: enabled BLOCKED by packaged generic OCI verifier; startup refusal verified; evidence=$output"
    return 0
  fi
  [[ "$status" -eq 0 ]] || {
    echo "review-factory-coload-smoke: $name exited $status; evidence=$output" >&2
    return 1
  }
  grep -Fq '"statusKey":"review_workbench"' "$output" || {
    echo "review-factory-coload-smoke: Review workbench did not start in $name; evidence=$output" >&2
    return 1
  }
  grep -Fq '"name":"factory"' "$output" || {
    echo "review-factory-coload-smoke: packaged Factory command was not discovered in $name; evidence=$output" >&2
    return 1
  }
  if grep -Fq 'Factory handoff unavailable:' "$output"; then
    echo "review-factory-coload-smoke: Review lost the packaged Factory controller in $name; evidence=$output" >&2
    return 1
  fi
  grep -Fq "$expected" "$output" || {
    echo "review-factory-coload-smoke: expected '$expected' in $name; evidence=$output" >&2
    return 1
  }
}

run_case enabled 'Factory has no batches.' enabled
run_case disabled 'Factory is disabled; explicitly enable LUNA_FACTORY_ENABLED=1' absent

policy_home="$run_root/policy/home"
policy_profile="$policy_home/.omp/profiles/review-appliance/agent"
mkdir -p "$policy_profile"
chmod 0777 "$policy_home"
sed 's#43127#43129#g' "$root/tests/fixtures/luna-factory-omp-probe-models.yml" >"$policy_profile/models.yml"

policy_rpc() {
  local name="$1" request="$2" output status
  output="$run_root/policy-$name.jsonl"
  set +e
  printf '%s\n' \
    '{"id":"commands","type":"get_available_commands"}' \
    "$request" |
    timeout --signal=TERM --kill-after=5s 30s podman run --rm --interactive --network host \
      --userns keep-id:uid=65532,gid=65532 \
      --env HOME=/home/review \
      --env XDG_CONFIG_HOME=/host-xdg \
      --env XDG_STATE_HOME=/home/review/.local/state \
      --env XDG_CACHE_HOME=/home/review/.cache \
      --env REVIEW_DEFAULT_SCOPE=example/repo \
      --env REVIEW_MODE=review \
      --env GH_TOKEN= \
      --env GITHUB_TOKEN= \
      --volume "$policy_home:/home/review:rw" "$image" \
      --mode rpc-ui --no-skills --no-rules --no-pty --model local-probe/deterministic \
      >"$output" 2>&1
  status=$?
  set -e
  [[ "$status" -eq 0 ]] || {
    echo "review-factory-coload-smoke: policy $name exited $status; evidence=$output" >&2
    return 1
  }
  grep -Fq '"statusKey":"review_workbench"' "$output" || {
    echo "review-factory-coload-smoke: Review did not start for policy $name; evidence=$output" >&2
    return 1
  }
  grep -Fq '"name":"factory"' "$output" || {
    echo "review-factory-coload-smoke: Factory command was not discovered for policy $name; evidence=$output" >&2
    return 1
  }
}

# Set in a Factory-disabled instance, then restart that same mounted HOME and
# read through both command surfaces. The host XDG path is deliberately distinct.
policy_rpc set '{"id":"set-policy","type":"prompt","message":"/review policy example/repo solo"}'
grep -Fq 'example/repo: solo (explicit)' "$run_root/policy-set.jsonl" || {
  echo "review-factory-coload-smoke: Review did not confirm explicit solo policy; evidence=$run_root/policy-set.jsonl" >&2
  exit 1
}
grep -Fq '/home/review/.config/review/operator-policy.json' "$run_root/policy-set.jsonl" || {
  echo "review-factory-coload-smoke: policy store is not in mounted instance HOME; evidence=$run_root/policy-set.jsonl" >&2
  exit 1
}
policy_rpc restart $'{"id":"review-policy","type":"prompt","message":"/review policy example/repo"}\n{"id":"factory-policy","type":"prompt","message":"/factory policy example/repo"}'
grep -Fq 'example/repo: solo (explicit)' "$run_root/policy-restart.jsonl" || {
  echo "review-factory-coload-smoke: Review policy did not persist across restart; evidence=$run_root/policy-restart.jsonl" >&2
  exit 1
}
[[ "$(grep -o 'example/repo' "$run_root/policy-restart.jsonl" | wc -l)" -ge 2 &&
  "$(grep -o 'solo' "$run_root/policy-restart.jsonl" | wc -l)" -ge 2 ]] || {
    echo "review-factory-coload-smoke: Factory did not read matching solo policy; evidence=$run_root/policy-restart.jsonl" >&2
    exit 1
  }
grep -Fq '"id":"factory-policy"' "$run_root/policy-restart.jsonl" || {
  echo "review-factory-coload-smoke: Factory policy read did not return; evidence=$run_root/policy-restart.jsonl" >&2
  exit 1
}
[[ -s "$policy_home/.config/review/operator-policy.json" ]] || {
  echo "review-factory-coload-smoke: instance policy file missing under mounted HOME" >&2
  exit 1
}
printf 'review-factory-coload-smoke: enabled=%s disabled=passed image=%s evidence=%s\n' "$enabled_result" "$image" "$run_root"
