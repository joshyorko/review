#!/usr/bin/env bash
# Contract for the packaged official pi-typesafe extension.
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_root"

containerfile="image/appliance/Containerfile"
entrypoint="image/appliance/entrypoint.sh"
typesafe_version="$(sed -nE 's/^ARG TYPESAFE_VERSION=([^[:space:]]+)$/\1/p' "$containerfile")"

fail() {
  echo "typesafe-appliance-contract: $*" >&2
  exit 1
}

omp_version="$(sed -nE 's/^ARG OMP_VERSION=([^[:space:]]+)$/\1/p' "$containerfile")"
[[ "$omp_version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] ||
  fail "$containerfile must contain exactly one valid OMP_VERSION pin"
omp_source_commit="$(sed -nE 's/^ARG OMP_SOURCE_COMMIT=([^[:space:]]+)$/\1/p' "$containerfile")"
[[ "$omp_source_commit" =~ ^[0-9a-f]{40}$ ]] ||
  fail "$containerfile must pin the exact OMP source commit"
omp_natives_version="$(sed -nE 's/^ARG OMP_NATIVES_VERSION=([^[:space:]]+)$/\1/p' "$containerfile")"
[[ "$omp_natives_version" == "$omp_version" ]] ||
  fail "OMP native addon version must match OMP_VERSION"
[[ "$typesafe_version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] ||
  fail "$containerfile must contain exactly one valid TYPESAFE_VERSION pin"

require() {
  local path="$1"
  shift
  local needle
  for needle in "$@"; do
    grep -qF -- "$needle" "$path" || fail "$path must contain: $needle"
  done
}

require_arg() {
  local path="$1" name="$2"
  grep -qE "^ARG ${name}=[^[:space:]]+$" "$path" ||
    fail "$path must pin ${name}"
}

forbid_secret() {
  if grep -RIn --exclude='*lock*' --exclude='*.md' --exclude-dir=.git \
    -e 'TYPESAFE_API_KEY[[:space:]]*=' \
    -e 'typesafe[_-]api[_-]key[[:space:]]*:[[:space:]]*[^$]' \
    -e 'ts_[A-Za-z0-9]{20,}' .; then
    fail "a TypeSafe secret-like value is present in the repository"
  fi
}

require "$containerfile" \
  "ARG OMP_VERSION=${omp_version}" \
  "ARG OMP_SOURCE_COMMIT=${omp_source_commit}" \
  'ARG OMP_SOURCE_SHA256=' \
  'ARG OMP_PATCH_SHA256=' \
  "ARG OMP_NATIVES_VERSION=${omp_natives_version}" \
  'ARG OMP_NATIVES_X86_64_SHA512=' \
  'ARG OMP_NATIVES_AARCH64_SHA512=' \
  'COPY --chmod=0755 scripts/build-derived-omp.sh /usr/local/libexec/build-derived-omp' \
  'COPY patches/omp/memory-backend-registration.patch /usr/local/share/bluefin/omp/memory-backend-registration.patch'

require "$containerfile" \
  "ARG TYPESAFE_VERSION=${typesafe_version}" \
  'ARG TYPESAFE_SHA256=' \
  'ARG TYPESAFE_SDK_VERSION=' \
  'ARG TYPESAFE_SDK_SHA256=' \
  'ARG TYPESAFE_TYPEBOX_VERSION=' \
  'ARG TYPESAFE_TYPEBOX_SHA256=' \
  'https://registry.npmjs.org/pi-typesafe/-/pi-typesafe-' \
  'https://registry.npmjs.org/@typesafe-ai/sdk/-/sdk-' \
  'https://registry.npmjs.org/typebox/-/typebox-' \
  'sha256sum --check --status' \
  '/out/usr/share/bluefin/review/pi-typesafe/package.json' \
  'COPY image/extension/typesafe-omp-loader.mjs /out/usr/share/bluefin/review/typesafe-omp-loader.mjs'

require "$entrypoint" \
  '/usr/share/bluefin/review/typesafe-omp-loader.mjs'

require image/extension/typesafe-omp-loader.mjs \
  'pi-typesafe/extensions/index.js' \
  'registerEntryRenderer' \
  'typeof pi.registerEntryRenderer'

require "$containerfile" \
  "io.github.joshyorko.review.omp.version=\"\${OMP_VERSION}\"" \
  "io.github.joshyorko.review.omp.source.commit=\"\${OMP_SOURCE_COMMIT}\"" \
  "io.github.joshyorko.review.omp.patch.sha256=\"\${OMP_PATCH_SHA256}\""

forbid_secret

if [[ -n "${TYPESAFE_RUNTIME_IMAGE:-}" ]]; then
  engine="${CONTAINER_ENGINE:-podman}"
  command -v "$engine" >/dev/null 2>&1 || fail "$engine is required for runtime checks"

  image="${TYPESAFE_RUNTIME_IMAGE}"
  run() {
    "$engine" run --rm --entrypoint /usr/bin/bash "$image" -c "$1"
  }

  version="$(run '/usr/bin/omp --version')"
  grep -Fxq "omp/${omp_version}" <<<"$version" ||
    fail "runtime OMP version was not ${omp_version}: ${version}"
  run 'test -f /usr/share/bluefin/review/pi-typesafe/package.json'
  run "grep -Fq '\"version\": \"${typesafe_version}\"' /usr/share/bluefin/review/pi-typesafe/package.json"
  run 'test ! -e /usr/bin/node && test ! -e /usr/bin/npm'
  run "test -z \"\${TYPESAFE_API_KEY:-}\""

  rpc_request='{"id":"cmds","type":"get_available_commands"}'
  rpc_command="set -o pipefail; printf '%s\\n' '${rpc_request}' | env HOME=/tmp/typesafe-home XDG_CONFIG_HOME=/tmp/typesafe-home/.config XDG_DATA_HOME=/tmp/typesafe-home/.local/share XDG_STATE_HOME=/tmp/typesafe-home/.local/state /usr/bin/omp --profile typesafe-contract --no-session --no-tools --model gpt-5.2 --extension /usr/share/bluefin/review/typesafe-omp-loader.mjs --mode rpc"
  commands="$(run "$rpc_command")"
  grep -Fq '"name":"typesafe"' <<<"$commands" ||
    fail "packaged OMP did not register the /typesafe command"
  grep -Fq '"source":"extension"' <<<"$commands" ||
    fail "packaged OMP command list did not identify the TypeSafe extension"
  if grep -Fq 'Failed to load extension' <<<"$commands"; then
    fail "packaged OMP reported a TypeSafe extension load failure"
  fi
fi

echo "typesafe-appliance-contract: static contract holds (OMP ${omp_version}, pi-typesafe ${typesafe_version})"
