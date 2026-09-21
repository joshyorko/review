#!/usr/bin/env bash
# Exercise the packaged Review appliance with Review and Luna Factory loaded
# together. The local model catalog keeps this smoke credential-free; the
# status command itself does not invoke a model turn or provider request.
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
image="${BLUEFIN_REVIEW_IMAGE:-localhost/review:factory-handoff}"
run_root="${RUNNER_TEMP:-${TMPDIR:-/tmp}}/review-factory-coload-$$"
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
  local home="$run_root/$name/home" profile="$run_root/$name/home/.omp/profiles/bluefin-review-appliance/agent"
  mkdir -p "$profile"
  chmod 0777 "$home"
  sed 's#43127#43129#g' "$root/tests/fixtures/luna-factory-omp-probe-models.yml" >"$profile/models.yml"
  local -a env_args=(
    --env HOME=/home/bluefin
    --env XDG_CONFIG_HOME=/home/bluefin/.config
    --env XDG_STATE_HOME=/home/bluefin/.local/state
    --env XDG_CACHE_HOME=/home/bluefin/.cache
    --env BLUEFIN_REVIEW_MODE=review
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
      --volume "$home:/home/bluefin:rw" "$image" \
      --mode rpc-ui --no-skills --no-rules --no-pty --model local-probe/deterministic \
      >"$output" 2>&1
  local status=$?
  set -e
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
printf 'review-factory-coload-smoke: passed image=%s evidence=%s\n' "$image" "$run_root"
