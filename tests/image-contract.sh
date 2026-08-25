#!/usr/bin/env bash
# Static contract for the first image slice: review is an exact lab-runner fork.
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_root"

fail=0
error() {
  echo "::error::$1" >&2
  fail=1
}

base_ref="$(sed -n 's/^ARG FSDK_RUNNER_IMAGE=\(.*\)$/\1/p' image/Containerfile)"
expected_prefix='ghcr.io/projectbluefin/lab-runner:25.08@sha256:'
[[ "$base_ref" == "${expected_prefix}"???????????????????????????????????????????????????????????????? ]] ||
  error "FSDK_RUNNER_IMAGE must be the tag-plus-digest lab-runner source"

[[ "$(grep -c '^ARG FSDK_RUNNER_IMAGE=' image/Containerfile)" -eq 1 ]] ||
  error "Containerfile must declare exactly one FSDK_RUNNER_IMAGE argument"
[[ "$(grep -c '^FROM ' image/Containerfile)" -eq 1 ]] ||
  error "Containerfile must contain exactly one FROM instruction"
# shellcheck disable=SC2016
grep -qFx 'FROM ${FSDK_RUNNER_IMAGE}' image/Containerfile ||
  error "Containerfile must derive directly from FSDK_RUNNER_IMAGE"

if grep -qE '^(RUN|COPY|ADD|USER|WORKDIR|ENTRYPOINT|CMD|ENV|LABEL|VOLUME|EXPOSE|ONBUILD|STOPSIGNAL|HEALTHCHECK|SHELL) ' image/Containerfile; then
  error "direct-copy Containerfile must not add layers or runtime configuration"
fi

for forbidden in \
  'LAB_SKILLS_COMMIT' \
  'projectbluefin/lab/' \
  'review-entrypoint' \
  'GOOSE_CHANNEL' \
  'CODEX_VERSION' \
  'PI_VERSION' \
  'SKILLS_COMMIT'; do
  grep -qF -- "$forbidden" image/Containerfile &&
    error "direct-copy Containerfile must not contain ${forbidden}"
done

grep -qxF '*' .dockerignore ||
  error ".dockerignore must ignore the complete build context"
grep -qxF '!image/' .dockerignore ||
  error ".dockerignore must retain the image directory"
grep -qxF '!image/Containerfile' .dockerignore ||
  error ".dockerignore must retain image/Containerfile"
if grep -Eq '^!(package|scripts|docs|tests|README|justfile)' .dockerignore; then
  error ".dockerignore must not retain unused review build inputs"
fi

[[ "$fail" -eq 0 ]] && echo "✓ direct lab-runner copy contract holds."
exit "$fail"
