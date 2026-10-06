#!/usr/bin/env bash
set -Eeuo pipefail

fail() {
  printf 'graph krun host-provider: %s\n' "$*" >&2
  exit 78
}
readonly expected_uid='65532'
readonly expected_repo_suffix='/image/extension/luna-factory'
readonly expected_model='local-probe/deterministic'

[[ "${REVIEW_TEST_KRUN_ROOT_REVIEWED:-}" == 1 && "${REVIEW_TEST_KRUN_SLOT_GRANTED:-}" == 1 ]] || fail 'fresh root review and exclusive shared-slot grant are required'
[[ "${REVIEW_TEST_KRUN_SLOT_EXPIRES_EPOCH:-}" =~ ^[0-9]+$ ]] || fail 'shared-slot expiry is missing'
now="$(date +%s)"
((REVIEW_TEST_KRUN_SLOT_EXPIRES_EPOCH > now && REVIEW_TEST_KRUN_SLOT_EXPIRES_EPOCH <= now + 3600)) || fail 'shared-slot grant is expired or outside its one-hour window'

image_id="${REVIEW_TEST_KRUN_IMAGE_ID:-}"
image_sha="${REVIEW_TEST_KRUN_OMP_SHA256:-}"
grant="${REVIEW_TEST_KRUN_GRANT_FILE:-}"
source="${REVIEW_TEST_SOURCE:-}"
fixture_root="${REVIEW_TEST_FACTORY_ROOT:-}"
harness_input="${REVIEW_TEST_HARNESS_ROOT:-}"
root="${GRAPH130_ROOT:-}"
if [[ "$image_id" =~ ^([0-9a-f]{64})$ ]]; then
  image_id_bare="${BASH_REMATCH[1]}"
elif [[ "$image_id" =~ ^sha256:([0-9a-f]{64})$ ]]; then
  image_id_bare="${BASH_REMATCH[1]}"
else
  fail 'an immutable local OCI image ID is required; tags are not accepted'
fi
[[ "$image_sha" =~ ^[0-9a-f]{64}$ ]] || fail 'expected packaged OMP SHA-256 is missing'
[[ "$grant" == /* && -f "$grant" && ! -L "$grant" ]] || fail 'read-only root grant file is missing'
mode="$(stat -c '%a' "$grant")"
(((8#$mode & 0222) == 0)) || fail 'root grant file must be read-only'
source="$(realpath -e "$source" 2>/dev/null)" || fail 'production source checkout is missing'
[[ -d "$source/.git" && -z "$(git -C "$source" status --porcelain=v1)" ]] || fail 'production source checkout must be a clean standalone clone'
[[ ! -e "$source/.git/objects/info/alternates" ]] || fail 'production source checkout must not use external Git objects'
source_sha="$(git -C "$source" rev-parse HEAD)"
[[ "$fixture_root" == "$source$expected_repo_suffix" && -d "$fixture_root" ]] || fail 'Factory source root is outside the selected production checkout'
harness_root="$(realpath -e "$harness_input" 2>/dev/null)" || fail 'graph harness checkout is missing'
helper_root="$(realpath -e "$(dirname "${BASH_SOURCE[0]}")/../..")"
[[ "$harness_root" == "$helper_root" ]] || fail 'graph harness root must be the checkout containing this reviewed helper'
harness_head="$(git -C "$harness_root" rev-parse HEAD 2>/dev/null)" || fail 'graph harness checkout has no Git identity'
runtime_path="$harness_root/tests/fixtures/luna-factory-graph-acceptance-runtime.ts"
[[ -f "$runtime_path" ]] || fail 'graph harness runtime extension is absent from its checkout'
factory_tree_digest() {
  local checkout="$1"
  (cd "$checkout" && find image/extension/luna-factory -type f -print0 | sort -z | xargs -0 sha256sum | sha256sum | cut -d' ' -f1)
}
source_factory_digest="$(factory_tree_digest "$source")"
harness_factory_digest="$(factory_tree_digest "$harness_root")"
[[ "$source_factory_digest" == "$harness_factory_digest" ]] || fail 'harness Factory bytes differ from the immutable production source checkout'
[[ "$root" == /* && "$HOME" == "$root/home" ]] || fail 'private evidence and home roots are not bound'
[[ -f "$root/home/.config/omp/omp.yml" && -f "$HOME/.omp/agent/models.yml" ]] || fail 'fixture OMP config is absent'
profile="$HOME/.omp/profiles/bluefin-review-appliance/agent/models.yml"
[[ -f "$profile" ]] || fail 'private packaged profile model config is absent'
grep -Fxq "source=$image_id_bare" "$grant" || fail 'root grant names another immutable image ID'
grep -Fxq "image-digest=${REVIEW_TEST_KRUN_IMAGE_DIGEST:-}" "$grant" || fail 'root grant names another image manifest digest'
grep -Fxq 'root-review=1' "$grant" || fail 'root review marker is absent'
grep -Fxq 'shared-slot=1' "$grant" || fail 'exclusive shared-slot marker is absent'
granted_expiry="$(sed -nE 's/^expires-epoch=([0-9]+)$/\1/p' "$grant")"
[[ "$granted_expiry" == "$REVIEW_TEST_KRUN_SLOT_EXPIRES_EPOCH" ]] || fail 'slot expiry differs from the read-only root grant'
((granted_expiry > now && granted_expiry <= now + 3600)) || fail 'read-only root grant is expired or outside its one-hour window'

model_file="$HOME/.omp/agent/models.yml"
route_count="$(grep -Ec '^[[:space:]]*baseUrl:' "$model_file")"
[[ "$route_count" == 1 ]] || fail 'model config must contain one provider endpoint only'
provider_url="$(sed -nE 's/^[[:space:]]*baseUrl:[[:space:]]*([^[:space:]]+).*$/\1/p' "$model_file")"
[[ "$provider_url" =~ ^http://127\.0\.0\.1:([0-9]{1,5})/v1$ ]] || fail 'provider endpoint must use the unchanged dynamic loopback fixture route'
port="${BASH_REMATCH[1]}"
((10#$port >= 1 && 10#$port <= 65535)) || fail 'fixture provider port is out of range'
[[ "$(grep -Fc 'apiKey: luna-factory-probe' "$model_file")" == 1 ]] || fail 'fixture-only provider key is absent or duplicated'
[[ "$(grep -Fc 'id: deterministic' "$model_file")" == 1 ]] || fail 'fixture-only model ID is absent or duplicated'
[[ "$(grep -Fc "$expected_model" "$root/home/.config/omp/omp.yml")" == 6 ]] || fail 'five fixture roles and their task override must retain the fixture-only model'
cmp -s "$profile" "$model_file" || fail 'private packaged profile route differs from the fixture route'
[[ "$(grep -Fc 'baseUrl:' "$root/home/.config/omp/omp.yml")" == 0 ]] || fail 'OMP role config must not introduce a second provider endpoint'

# The version probe intentionally precedes fixture-token validation: it runs
# the immutable packaged OMP binary without passing any credential environment.
version_only=0
if (($# == 1)) && [[ "$1" == --version ]]; then
  version_only=1
fi
for credential_name in GITHUB_TOKEN COPILOT_GITHUB_TOKEN GITHUB_COPILOT_TOKEN GH_ENTERPRISE_TOKEN; do
  [[ -z "${!credential_name:-}" ]] || fail 'real GitHub/Copilot credential environment is forbidden'
done

expected_version="$(sed -nE 's/^ARG OMP_VERSION=([^[:space:]]+).*$/\1/p' "$source/image/appliance/Containerfile" | head -n 1)"
[[ "$expected_version" =~ ^[0-9]+\.[0-9]+\.[0-9]+([.-][A-Za-z0-9.-]+)?$ ]] || fail 'expected OMP version cannot be derived from the selected source'

args=("$@")
if ((!version_only)); then
  expected=(
    --mode rpc --no-ui --no-skills --no-rules --no-extensions --no-pty
    --config "$root/home/.config/omp/omp.yml"
    --model "$expected_model"
    --extension "$fixture_root"
  )
  ((${#args[@]} == ${#expected[@]} + 2)) || fail 'unrecognized OMP argv cardinality; refusing unknown commands/routes'
  for index in "${!expected[@]}"; do
    [[ "${args[$index]}" == "${expected[$index]}" ]] || fail "unrecognized OMP argv at position $((index + 1))"
  done
  [[ "${args[$((${#expected[@]}))]}" == --extension && "${args[$((${#expected[@]} + 1))]}" == "$runtime_path" ]] || fail 'graph runtime extension must come from the validated harness checkout'
  [[ "${GH_TOKEN:-}" == captured-fixture-token ]] || fail 'only the captured fixture token may enter the packaged test process'
fi

podman="$(command -v podman || true)"
[[ -n "$podman" && -x "$podman" ]] || fail 'Podman CLI is unavailable'
image_inspect="$root/krun-image-inspect.json"
"$podman" image inspect "$image_id" >"$image_inspect" || fail 'immutable OCI image inspect failed'
image_digest="$(jq -er '.[0].Digest' "$image_inspect")" || fail 'immutable OCI image has no manifest digest'
jq -e --arg id "$image_id_bare" --arg digest "$image_digest" --arg source "$source_sha" --arg version "$expected_version" '
  (.[0].Id | sub("^sha256:"; "")) == $id and .[0].Digest == $digest and .[0].Config.User == "65532:65532" and
  .[0].Config.Labels["org.opencontainers.image.revision"] == $source and
  .[0].Config.Labels["io.github.joshyorko.review.omp.version"] == $version
' "$image_inspect" >/dev/null || fail 'immutable image identity, source, user, or OMP label differs'
grep -Fxq "image-digest=$image_digest" "$grant" || fail 'image inspect digest differs from the root grant'

identity="$root/krun-host-transport-identity.txt"
printf 'image_id=%s\nimage_ref=%s\nimage_digest=%s\nsource_sha=%s\nharness_head=%s\nfactory_tree_digest=%s\nomp_version=%s\nexpected_omp_sha256=%s\nprovider_endpoint=%s\nnetwork_scope=host-loopback-fixture; not network isolated\n' \
  "$image_id_bare" "$image_id" "$image_digest" "$source_sha" "$harness_head" "$source_factory_digest" "$expected_version" "$image_sha" "$provider_url" >"$identity"

mounts=(--volume "$source:$source:ro,z")
if [[ "$harness_root" != "$source" ]]; then
  mounts+=(--volume "$harness_root:$harness_root:ro,z")
fi

common=(
  run --rm --pull=never --runtime=krun --network=host
  "--userns=keep-id:uid=$expected_uid,gid=$expected_uid" "--user=$expected_uid:$expected_uid"
  "${mounts[@]}" --volume "$root:$root:rw,z"
  --volume "$HOME:/home/bluefin:rw,z"
  --volume "$grant:/tmp/graph130-root-slot-grant.txt:ro,z"
  --env "HOME=$HOME" --env "XDG_CONFIG_HOME=$XDG_CONFIG_HOME"
  --env "XDG_CACHE_HOME=$XDG_CACHE_HOME" --env "XDG_STATE_HOME=$XDG_STATE_HOME"
  --env "GRAPH130_ROOT=$root" --env GRAPH130_GRANT_FILE=/tmp/graph130-root-slot-grant.txt
  --env "GRAPH130_EXPECTED_IMAGE_ID=$image_id_bare" --env "GRAPH130_EXPECTED_IMAGE_DIGEST=$image_digest"
  --env "GRAPH130_EXPECTED_OMP_SHA=$image_sha" --env "GRAPH130_EXPECTED_OMP_VERSION=omp/$expected_version"
  --env "REVIEW_TEST_SOURCE=$source" --env "REVIEW_TEST_FACTORY_ROOT=$fixture_root"
  --env "REVIEW_TEST_HARNESS_ROOT=$harness_root"
  --env "GRAPH130_PROVIDER_URL=$provider_url" --env "PATH=$root/shim:/usr/bin:/bin"
)
if ((version_only)); then
  exec "$podman" "${common[@]}" --entrypoint /usr/bin/omp "$image_id" --version
fi

filtered=()
for ((index = 0; index < ${#args[@]}; index++)); do
  case "${args[$index]}" in
  --no-extensions) ;;
  --extension)
    ((index + 1 < ${#args[@]})) || fail 'OMP extension path is missing'
    if [[ "${args[$((index + 1))]}" == "$fixture_root" ]]; then
      ((index += 1))
    else
      filtered+=(--extension "${args[$((index + 1))]}")
      ((index += 1))
    fi
    ;;
  *) filtered+=("${args[$index]}") ;;
  esac
done

# This guard validates the packaged runtime and byte-identical Factory source,
# then enters the image's actual production launcher with the original RPC argv.
# shellcheck disable=SC2016 # The string is interpreted by the guest Bash process.
guest='set -euo pipefail
[[ -r "$GRAPH130_GRANT_FILE" ]] || { echo "read-only root grant is missing" >&2; exit 12; }
expiry="$(sed -nE "s/^expires-epoch=([0-9]+)$/\\1/p" "$GRAPH130_GRANT_FILE")"
now="$(date +%s)"
[[ "$expiry" =~ ^[0-9]+$ ]] && (( expiry > now && expiry <= now + 3600 )) || { echo "root grant expired before guest entry" >&2; exit 12; }
grep -Fxq "source=$GRAPH130_EXPECTED_IMAGE_ID" "$GRAPH130_GRANT_FILE" || { echo "root grant image ID mismatch" >&2; exit 12; }
grep -Fxq "image-digest=$GRAPH130_EXPECTED_IMAGE_DIGEST" "$GRAPH130_GRANT_FILE" || { echo "root grant image digest mismatch" >&2; exit 12; }
uid="$(id -u)"
printf "%s\n" "$uid" > "$GRAPH130_ROOT/krun-effective-uid.txt"
[[ "$uid" == 65532 ]] || { echo "effective UID mismatch" >&2; exit 13; }
/usr/bin/omp --version > "$GRAPH130_ROOT/krun-omp-version.txt"
/usr/bin/sha256sum /usr/bin/omp > "$GRAPH130_ROOT/krun-omp-binary.sha256"
[[ "$(cat "$GRAPH130_ROOT/krun-omp-version.txt")" == "$GRAPH130_EXPECTED_OMP_VERSION" ]] || { echo "candidate OMP version mismatch" >&2; exit 14; }
[[ "$(cut -d" " -f1 "$GRAPH130_ROOT/krun-omp-binary.sha256")" == "$GRAPH130_EXPECTED_OMP_SHA" ]] || { echo "candidate OMP binary hash mismatch" >&2; exit 15; }
diff -qr "$REVIEW_TEST_FACTORY_ROOT" /usr/share/bluefin/review/luna-factory > "$GRAPH130_ROOT/krun-factory-source.diff"
/usr/bin/bwrap --version > "$GRAPH130_ROOT/krun-bwrap-version.txt"
exec /usr/bin/bluefin-review-appliance "$@"'
exec "$podman" "${common[@]}" \
  --env "LUNA_FACTORY_ENABLED=$LUNA_FACTORY_ENABLED" --env "LUNA_FACTORY_CAPACITY=$LUNA_FACTORY_CAPACITY" \
  --env "LUNA_FACTORY_STATE_ROOT=$LUNA_FACTORY_STATE_ROOT" --env "LUNA_FACTORY_CLAIMS_ROOT=$LUNA_FACTORY_CLAIMS_ROOT" \
  --env "REVIEW_DEFAULT_SCOPE=$REVIEW_DEFAULT_SCOPE" --env GH_TOKEN \
  --entrypoint /usr/bin/bash "$image_id" -c "$guest" graph-entrypoint "${filtered[@]}"
