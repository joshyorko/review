# justfile — the review appliance launcher entrypoint.
#
# The system image install path is still out of scope here; this root justfile
# is the launcher a checkout exposes directly.
#
# This is the ONLY file that ships/installs. Everything review needs
# (host preflight, backend selection, container lifecycle) is
# embedded below as private ('_'-prefixed variables and shared shell
# functions) on purpose: a user browsing the image or this repo should find
# one just-recipe file and the commands it exposes, not a scattered bin/ of
# standalone scripts they might stumble into and run directly out of context.
#
# Public commands:
#   review-queue      Run the GitHub Review workbench for an explicit scope.
#   review-appliance  Run the same workbench in its isolated appliance.
#   review-doctor     Check local runtime and GitHub authentication.
#
# ─────────────────────────────────────────────────────────────────────────
# LIFECYCLE
#
# Interactive Review launches stay in the foreground. Each invocation has
# isolated state; Ctrl-C stops only the calling terminal's appliance.
#
# Every interactive launch path ends in an 'exec' or a final foreground
# command whose exit status propagates verbatim; tests/just-onboarding.sh
# pins all of it.
# ─────────────────────────────────────────────────────────────────────────
#
# This checkout exposes Review and Luna Factory; optional integrations are
# selected explicitly by the operator.

# Shared bash, 'eval''d at the top of recipes that need it:
# GitHub authentication, host preflight, and runtime selection. Keeping
# this in one place avoids duplicate launch policy without creating a
# separate helper layer.
shared_functions := '''
GITHUB_LOGIN_COMMAND="gh auth login --web --hostname github.com --scopes repo,read:org,workflow"

github_auth_ready() {
  command -v gh &>/dev/null && gh auth status --hostname github.com &>/dev/null
}
kvm_device_ready() {
  local device="${REVIEW_TEST_KVM_DEVICE:-/dev/kvm}"
  [[ -r "$device" && -w "$device" ]]
}
kvm_runtime_ready() {
  local device="${REVIEW_TEST_KVM_DEVICE:-/dev/kvm}"
  command -v podman &>/dev/null || { KVM_FAILURE="Podman is unavailable"; return 1; }
  podman info &>/dev/null || { KVM_FAILURE="Podman is not reachable"; return 1; }
  local selected uri
  selected="$(podman_selected_connection)" || { KVM_FAILURE="Podman connections could not be resolved"; return 1; }
  IFS=$'\t' read -r uri _ <<<"$selected"
  if [[ -z "$uri" || "$uri" == unix://* ]]; then
    command -v krun &>/dev/null || { KVM_FAILURE="the krun OCI runtime is unavailable"; return 1; }
    kvm_device_ready || { KVM_FAILURE="${device} is not readable and writable"; return 1; }
  fi
  return 0
}
apptainer_fallback_ready() {
  local fuse_device="${REVIEW_TEST_FUSE_DEVICE:-/dev/fuse}"
  command -v apptainer &>/dev/null || { APPTAINER_FAILURE="Apptainer fallback is unavailable; install Apptainer"; return 1; }
  { command -v squashfuse_ll &>/dev/null || command -v squashfuse &>/dev/null; } || {
    APPTAINER_FAILURE="squashfuse userland is unavailable; install squashfuse"
    return 1
  }
  test -e "$fuse_device" || { APPTAINER_FAILURE="FUSE device ${fuse_device} is missing"; return 1; }
  test -c "$fuse_device" || { APPTAINER_FAILURE="FUSE device ${fuse_device} is not a character device"; return 1; }
  if ! test -r "$fuse_device" || ! test -w "$fuse_device"; then
    APPTAINER_FAILURE="FUSE device ${fuse_device} is not readable and writable"
    return 1
  fi
  return 0
}
require_apptainer_fallback() {
  apptainer_fallback_ready || { echo "ERROR: ${KVM_FAILURE}; ${APPTAINER_FAILURE}." >&2; return 1; }
  echo "WARNING: ${KVM_FAILURE}; using the isolated Apptainer fallback without a KVM boundary." >&2
}
prepare_apptainer_environment() {
  local name host_file
  for name in GH_TOKEN GITHUB_TOKEN COPILOT_GITHUB_TOKEN GITHUB_COPILOT_TOKEN COPILOT_INTEGRATION_ID ANTHROPIC_API_KEY ANTHROPIC_OAUTH_TOKEN OPENAI_API_KEY GEMINI_API_KEY TYPESAFE_API_KEY CONTEXT7_API_KEY AWS_BEARER_TOKEN_BEDROCK AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY AWS_SESSION_TOKEN AWS_REGION AWS_DEFAULT_REGION HIVE_HUB REVIEW_DEFAULT_SCOPE REVIEW_MODE REVIEW_INHERIT_OMP_CONFIG REVIEW_SKIP_REPOS BLUEFIN_REVIEW_ORG BLUEFIN_REVIEW_MODE BLUEFIN_REVIEW_INHERIT_OMP_CONFIG BLUEFIN_REVIEW_SKIP_REPOS TERM COLORTERM; do
    [[ -v "$name" ]] && export "APPTAINERENV_${name}=${!name}"
  done
  APPTAINER_HOST_ARGS=()
  for host_file in /etc/localtime /etc/hosts; do
    test -e "$host_file" || APPTAINER_HOST_ARGS+=(--no-mount "$host_file")
  done
  return 0
}
instance_key() {
  local value="$1" slug digest
  slug="$(printf '%s' "$value" | tr '[:upper:]/:' '[:lower:]--' | tr -cd 'a-z0-9_.-')"
  slug="${slug:0:28}"
  [[ -n "$slug" ]] || slug=default
  digest="$(printf '%s' "$value" | sha256sum | cut -c1-8)"
  printf '%s-%s\n' "$slug" "$digest"
}
preflight_github() {
  github_auth_ready || {
    echo "ERROR: GitHub CLI is not authenticated against github.com." >&2
    echo "  Run: ${GITHUB_LOGIN_COMMAND}" >&2
    return 1
  }
}
image_available() {
  local ref="$1"
  if command -v podman &>/dev/null && podman info &>/dev/null; then
    podman image exists "$ref" &>/dev/null && return 0
    case "$ref" in localhost/*) return 1 ;; esac
    podman manifest inspect "$ref" &>/dev/null
    return
  fi
  case "$ref" in localhost/*) return 1 ;; esac
  if command -v skopeo &>/dev/null; then
    [[ "$ref" == *://* ]] || ref="docker://${ref}"
    skopeo inspect "$ref" &>/dev/null
    return
  fi
  command -v apptainer &>/dev/null && return 2
  return 1
}
image_ref_is_moving() {
  # A digest is immutable and an 'sha-<commit>' tag is minted once per build,
  # so both always name exactly one image. That makes the tag CI mints the
  # right name for a local build too: it is honest about which commit is in
  # the image, and it is never re-pulled over. A locally built image has no
  # registry behind it either, so refreshing it only produces a failed pull
  # and a misleading "may be out of date" warning; podman stores a bare
  # 'podman build -t <name>:<tag>' under 'localhost/', so accept the bare
  # name a user is likely to type as well as the stored form. Anything else
  # can be repointed at a newer build under the same name.
  case "$1" in
    *@sha256:*|*:sha-*|localhost/*) return 1 ;;
    */*)                            return 0 ;;
  esac
  ! podman image exists "localhost/$1"
}
ensure_image() {
  # Moving tags are refreshed on every launch. If the registry is unavailable,
  # an existing local copy remains usable but the launcher says it may be stale.
  local ref="$1" product="$2" containerfile="$3" override="$4"
  if image_ref_is_moving "$ref"; then
    podman pull "$ref" && return 0
    if podman image exists "$ref"; then
      echo "! could not refresh ${ref}; using the local copy, which may be out of date." >&2
      return 0
    fi
  fi
  podman image exists "$ref" && return 0
  case "$ref" in
    localhost/*)
      echo "ERROR: ${ref} is a locally built image and it is not in local storage." >&2
      echo "  Build it: podman build -f ${containerfile} -t ${ref#localhost/} ." >&2
      echo "  Or drop the override to use the published default: unset ${override}" >&2
      return 1
      ;;
  esac
  podman pull "$ref" && return 0
  echo "ERROR: cannot obtain ${product} image ${ref}." >&2
  echo "  Set ${override} to a published tag or digest, or build ${containerfile}." >&2
  return 1
}
MIN_REVIEW_APPLIANCE_VERSION="26.08.06"
EXPECTED_IMAGE_SERIES="26.08"

launcher_revision() {
  local rev=""
  if command -v git >/dev/null 2>&1 && [[ -d ".git" ]]; then
    rev="$(git rev-parse --short HEAD 2>/dev/null || true)"
  fi
  if [[ -z "$rev" && -f "image/appliance/REVISION" ]]; then
    local tool_rev
    tool_rev="$(tr -d '[:space:]' <"image/appliance/REVISION" 2>/dev/null || true)"
    if [[ "$tool_rev" =~ ^[0-9]+$ ]]; then
      rev=$(printf '%s.%02d' "$EXPECTED_IMAGE_SERIES" "$((10#$tool_rev))")
    fi
  fi
  printf '%s\n' "${rev:-${BLUEFIN_LAUNCHER_VERSION:-26.08.08}}"
}

report_launcher_identity() {
  local rev
  rev="$(launcher_revision)"
  echo "✓ Review launcher revision: ${rev}" >&2
}

check_image_compatibility() {
  local ref="$1" product="$2" version="$3" min_version="$4" is_override="${5:-0}"
  [[ -n "$version" && "$version" != "unknown" ]] || {
    if [[ "$is_override" -eq 1 ]]; then
      echo "! ${product} image ${ref} has unknown version; proceeding with explicit override." >&2
    fi
    return 0
  }
  if [[ ! "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
    echo "ERROR: ${product} image ${ref} has malformed version label '${version}'; expected numeric MAJOR.MINOR.PATCH." >&2
    return 1
  fi
  local ver_series="${version%.*}"
  if [[ "$ver_series" != "$EXPECTED_IMAGE_SERIES" ]]; then
    if [[ "$is_override" -eq 1 ]]; then
      echo "WARNING: ${product} image ${ref} series (${ver_series}) differs from expected (${EXPECTED_IMAGE_SERIES}); proceeding with explicit override." >&2
      return 0
    fi
    echo "ERROR: ${product} image ${ref} (version ${version}) is incompatible with this launcher (expected series ${EXPECTED_IMAGE_SERIES})." >&2
    return 1
  fi
  local ver_num="${version##*.}" min_num="${min_version##*.}"
  if [[ "$ver_num" =~ ^[0-9]+$ && "$min_num" =~ ^[0-9]+$ ]]; then
    if (( 10#$ver_num < 10#$min_num )); then
      if [[ "$is_override" -eq 1 ]]; then
        echo "WARNING: ${product} image ${ref} (version ${version}) is older than recommended minimum (${min_version}); proceeding with explicit override." >&2
        return 0
      fi
      echo "ERROR: ${product} image ${ref} (version ${version}) is incompatible with this launcher (requires >= ${min_version})." >&2
      return 1
    fi
  fi
  return 0
}
migrate_legacy_state() {
  local legacy_dir="$1" target_home="$2" sif_name="$3"
  [[ -d "$legacy_dir" ]] || return 0
  [[ -d "$target_home" ]] || return 0
  local item base migrated=0
  for item in "$legacy_dir"/* "$legacy_dir"/.*; do
    [[ -e "$item" ]] || continue
    base="${item##*/}"
    [[ "$base" == "." || "$base" == ".." || "$base" == "$sif_name" ]] && continue
    if [[ ! -e "$target_home/$base" ]]; then
      if ! cp -a "$item" "$target_home/" 2>/dev/null; then
        echo "ERROR: failed to migrate legacy state item ${item} to ${target_home}; check permissions and available space." >&2
        return 1
      fi
      migrated=1
    fi
  done
  if [[ "$migrated" -eq 1 ]]; then
    echo "✓ migrated user configuration from ${legacy_dir} to ${target_home}" >&2
  fi
}
prepare_factory_state_dirs() {
  local home="$1" uid gid path owner group mode
  uid="$(id -u)"; gid="$(id -g)"
  for path in "$home" "$home/.local" "$home/.local/state" "$home/.local/state/review" "$home/.local/state/review/factory"; do
    [[ ! -L "$path" ]] || { echo "ERROR: persistent Factory state path ${path} is a symlink; refusing to follow it." >&2; return 1; }
    if [[ ! -e "$path" ]]; then
      mkdir -m 0700 -- "$path" || { echo "ERROR: could not prepare persistent Factory state path ${path}." >&2; return 1; }
    fi
    [[ -d "$path" ]] || { echo "ERROR: persistent Factory state path ${path} is not a directory." >&2; return 1; }
    IFS=: read -r owner group mode < <(stat -c '%u:%g:%a' -- "$path") || { echo "ERROR: could not inspect persistent Factory state path ${path}." >&2; return 1; }
    if [[ "$owner" != "$uid" || "$group" != "$gid" || ! -w "$path" ]]; then
      echo "ERROR: persistent Factory state path ${path} is owned by ${owner}:${group} (mode ${mode}); expected ${uid}:${gid}. No ownership changes were made; select a fresh BLUEFIN_INSTANCE or inspect this exact path." >&2
      return 1
    fi
  done
}

report_podman_image_identity() {
  local ref="$1" product="$2" is_override="${3:-0}" min_version="${4:-$MIN_REVIEW_APPLIANCE_VERSION}"
  local identity version revision digest
  identity="$(podman image inspect --format '{{ index .Config.Labels "org.opencontainers.image.version" }}|{{ index .Config.Labels "org.opencontainers.image.revision" }}|{{ .Digest }}' "$ref" 2>/dev/null)" || {
    echo "! ${product} image identity unavailable for ${ref}." >&2
    return 0
  }
  IFS='|' read -r version revision digest <<<"$identity"
  [[ -n "$version" && "$version" != "<no value>" ]] || version=unknown
  [[ -n "$revision" && "$revision" != "<no value>" ]] || revision=unknown
  [[ -n "$digest" && "$digest" != "<no value>" ]] || digest=unknown
  echo "✓ ${product} image ${ref}: version=${version} revision=${revision} digest=${digest}" >&2
  check_image_compatibility "$ref" "$product" "$version" "$min_version" "$is_override"
}

inspect_apptainer_image() {
  local ref="$1"
  local identity=""
  if [[ -f "$ref" ]] && command -v apptainer >/dev/null 2>&1; then
    local json
    json="$(apptainer inspect --json "$ref" 2>/dev/null || true)"
    if [[ -n "$json" ]] && command -v python3 >/dev/null 2>&1; then
      identity="$(python3 -c '
import json, sys
def parse():
    try:
        d = json.loads(sys.argv[1])
        labels = d.get("data", {}).get("attributes", {}).get("labels", {})
        v = labels.get("org.opencontainers.image.version", "")
        r = labels.get("org.opencontainers.image.revision", "")
        return f"{v}|{r}|unknown"
    except Exception:
        return ""
res = parse()
if res:
    print(res)
' "$json" 2>/dev/null || true)"
    fi
  elif command -v skopeo >/dev/null 2>&1; then
    local skopeo_ref="$ref"
    [[ "$skopeo_ref" == *://* ]] || skopeo_ref="docker://${skopeo_ref}"
    identity="$(skopeo inspect --format '{{ index .Labels "org.opencontainers.image.version" }}|{{ index .Labels "org.opencontainers.image.revision" }}|{{ .Digest }}' "$skopeo_ref" 2>/dev/null || true)"
  fi
  printf '%s\n' "$identity"
}

report_apptainer_image_identity() {
  local ref="$1" product="$2" is_override="${3:-0}" min_version="${4:-$MIN_REVIEW_APPLIANCE_VERSION}"
  local identity version revision digest
  identity="$(inspect_apptainer_image "$ref")"
  if [[ -z "$identity" ]]; then
    echo "! ${product} image identity unavailable for ${ref}." >&2
    return 0
  fi
  IFS='|' read -r version revision digest <<<"$identity"
  [[ -n "$version" && "$version" != "<no value>" ]] || version=unknown
  [[ -n "$revision" && "$revision" != "<no value>" ]] || revision=unknown
  [[ -n "$digest" && "$digest" != "<no value>" ]] || digest=unknown
  echo "✓ ${product} image ${ref}: version=${version} revision=${revision} digest=${digest}" >&2
  check_image_compatibility "$ref" "$product" "$version" "$min_version" "$is_override"
}



resolve_gh_token() {
  # Pass one GitHub credential by value rather than bind-mounting ~/.config/gh.
  # Review sees only the selected account/token, not other hosts or accounts.
  # REVIEW_GH_TOKEN lets the user choose a narrower token than the CLI default.
  GH_TOKEN_VALUE="${REVIEW_GH_TOKEN:-${GH_TOKEN:-}}"
  GH_TOKEN_SOURCE="environment"
  if [[ -z "$GH_TOKEN_VALUE" ]]; then
    GH_TOKEN_SOURCE="gh auth token"
    command -v gh &>/dev/null || { GH_TOKEN_SOURCE=""; return 0; }
    GH_TOKEN_VALUE="$(gh auth token --hostname github.com 2>/dev/null || true)"
  fi
  [[ -n "$GH_TOKEN_VALUE" ]] || GH_TOKEN_SOURCE=""
  return 0
}
gh_token_scopes() {
  # Scopes, never the token. Report the authority Review will receive.
  command -v gh &>/dev/null || return 0
  gh auth status --hostname github.com 2>&1 | sed -nE "s/.*[Tt]oken scopes:[[:space:]]*(.+)/\1/p" | head -1 || true
  return 0
}
podman_selected_connection() {
  # Podman resolves its target engine in this order: CONTAINER_HOST wins
  # outright, CONTAINER_CONNECTION names a saved connection, and otherwise
  # whichever connection is marked default applies. Mirror that order so the
  # queue guard and remote credential staging see the engine 'podman run' uses.
  if [[ -n "${CONTAINER_HOST:-}" ]]; then
    printf '%s\t\n' "$CONTAINER_HOST"
    return 0
  fi
  local list
  if ! list="$(podman system connection list --format '{{.Name}}\t{{.URI}}\t{{.Identity}}\t{{.Default}}' 2>/dev/null)"; then
    echo "ERROR: could not resolve Podman connections." >&2
    return 1
  fi
  if [[ -n "${CONTAINER_CONNECTION:-}" ]]; then
    local selected
    selected="$(awk -F'\t' -v n="$CONTAINER_CONNECTION" '$1==n{printf "%s\t%s\n", $2, $3; exit}' <<<"$list")"
    if [[ -z "$selected" ]]; then
      echo "ERROR: could not resolve selected Podman connection '${CONTAINER_CONNECTION}'." >&2
      return 1
    fi
    printf '%s\n' "$selected"
    return 0
  fi
  awk -F'\t' '$4=="true"{printf "%s\t%s\n", $2, $3; exit}' <<<"$list"
}
'''




# Maintainer convenience name for the OMP appliance. Keep this as delegation,
# not a second launch path: review-queue and review-appliance must execute the
# same image, entrypoint, configuration, and workbench.
alias review-queue := review-appliance

# The review appliance prefers one foreground libkrun microVM per invocation.
# Target-specific state and workspace directories also keep the Apptainer
# fallback independent when KVM is unavailable.
[doc("Run the distroless Review appliance container.")]
[positional-arguments]
review-appliance *appliance_args:
    #!/usr/bin/env bash
    set -euo pipefail
    {{shared_functions}}
    IS_OVERRIDE=0
    if [[ -n "${REVIEW_APPLIANCE_IMAGE:-}" ]]; then
      IMAGE="$REVIEW_APPLIANCE_IMAGE"
      IS_OVERRIDE=1
    elif [[ -n "${BLUEFIN_REVIEW_IMAGE:-}" ]]; then
      IMAGE="$BLUEFIN_REVIEW_IMAGE"
      IS_OVERRIDE=1
    elif [[ -n "${BLUEFIN_REVIEW_SIF:-}" ]]; then
      IMAGE="$BLUEFIN_REVIEW_SIF"
      IS_OVERRIDE=1
    else
      IMAGE="ghcr.io/projectbluefin/review:stable"
    fi

    # The token is resolved on the host and inherited by name. It is never an
    # argument, mount payload, image layer, or log value.
    if [[ -z "${GH_TOKEN:-}" && -z "${GITHUB_TOKEN:-}" ]] && command -v gh >/dev/null 2>&1; then
      GH_TOKEN="$(gh auth token 2>/dev/null || true)"
      export GH_TOKEN
    fi
    if [[ -z "${GH_TOKEN:-}${GITHUB_TOKEN:-}" ]]; then
      echo "WARNING: no GitHub credential found; the queue will load empty." >&2
      echo "  Run 'gh auth login' or export GH_TOKEN." >&2
    fi

    source scripts/parse-review-args.sh
    parse_review_args "$@"
    APPLIANCE_ARGS=("${PARSED_REVIEW_ARGS[@]}")
    SCOPE="${REVIEW_DEFAULT_SCOPE:-${BLUEFIN_REVIEW_ORG:-review}}"
    PREVIOUS=""
    for ARG in "${APPLIANCE_ARGS[@]}"; do
      if [[ "$PREVIOUS" == --repo ]]; then SCOPE="$ARG"; break; fi
      PREVIOUS="$ARG"
    done
    INSTANCE_KEY="$(instance_key "${BLUEFIN_INSTANCE:-review-${SCOPE}}")"
    INSTANCE_ROOT="${XDG_STATE_HOME:-${HOME}/.local/state}/bluefin/instances/${INSTANCE_KEY}"
    INSTANCE_HOME="${INSTANCE_ROOT}/home"
    INSTANCE_WORKSPACE="${INSTANCE_ROOT}/workspace"
    INSTANCE_TMP="${INSTANCE_ROOT}/tmp"
    CLAIMS_ROOT="${BLUEFIN_MUTATION_CLAIMS_ROOT:-${XDG_STATE_HOME:-${HOME}/.local/state}/review/mutation-claims}"
    mkdir -p "$CLAIMS_ROOT"
    report_launcher_identity
    CONTAINER_NAME="bluefin-review-${INSTANCE_KEY}-$(date +%s)-$$"
    KVM_FAILURE=""
    if kvm_runtime_ready && [[ "$IMAGE" != *.sif && ! -f "$IMAGE" ]]; then
      ensure_image "$IMAGE" "review appliance" "image/appliance/Containerfile" "REVIEW_APPLIANCE_IMAGE"
      CLAIMS_MOUNT="${CLAIMS_ROOT}:/claims:rw"
      if [[ "${CONTAINER_HOST:-}" == ssh://* || "${FAKE_REMOTE_DEFAULT:-}" == 1 ]]; then CLAIMS_MOUNT="bluefin-review-mutation-claims:/claims:rw"; fi
      report_podman_image_identity "$IMAGE" "review appliance" "$IS_OVERRIDE" "$MIN_REVIEW_APPLIANCE_VERSION"
      ARGS=(
        run --runtime=krun --rm --interactive --tty --name "$CONTAINER_NAME"
        --userns "keep-id:uid=65532,gid=65532"
        --volume "bluefin-review-${INSTANCE_KEY}-home:/home/bluefin:rw"
        --volume "bluefin-review-${INSTANCE_KEY}-workspace:/workspace:rw"
        --volume "bluefin-review-${INSTANCE_KEY}-tmp:/tmp:rw"
        --volume "${CLAIMS_MOUNT}"
        --env "LUNA_FACTORY_CLAIMS_ROOT=/claims"
        --env GH_TOKEN --env GITHUB_TOKEN --env COPILOT_GITHUB_TOKEN --env GITHUB_COPILOT_TOKEN
        --env COPILOT_INTEGRATION_ID
        --env ANTHROPIC_API_KEY --env ANTHROPIC_OAUTH_TOKEN --env OPENAI_API_KEY --env GEMINI_API_KEY --env CONTEXT7_API_KEY
        --env TYPESAFE_API_KEY
        --env AWS_BEARER_TOKEN_BEDROCK --env AWS_ACCESS_KEY_ID --env AWS_SECRET_ACCESS_KEY --env AWS_SESSION_TOKEN --env AWS_REGION --env AWS_DEFAULT_REGION
        --env HIVE_HUB --env REVIEW_MODE --env REVIEW_DEFAULT_SCOPE --env REVIEW_INHERIT_OMP_CONFIG --env REVIEW_SKIP_REPOS
        --env BLUEFIN_REVIEW_ORG --env BLUEFIN_REVIEW_MODE --env BLUEFIN_REVIEW_INHERIT_OMP_CONFIG --env BLUEFIN_REVIEW_SKIP_REPOS
        --env "TERM=${TERM:-xterm-256color}" --env "COLORTERM=${COLORTERM:-truecolor}"
      )
      exec podman "${ARGS[@]}" "$IMAGE" ${APPLIANCE_ARGS[@]+"${APPLIANCE_ARGS[@]}"}
    fi

    require_apptainer_fallback
    [[ "$IMAGE" != localhost/* ]] || { echo "ERROR: Apptainer cannot resolve local Podman image ${IMAGE}." >&2; exit 1; }
    mkdir -p "$INSTANCE_HOME" "$INSTANCE_WORKSPACE" "$INSTANCE_TMP"
    migrate_legacy_state "${XDG_STATE_HOME:-${HOME}/.local/state}/bluefin-review" "$INSTANCE_HOME" "bluefin-review.sif"
    prepare_factory_state_dirs "$INSTANCE_HOME"
    APPTAINER_IMAGE="$IMAGE"; [[ "$APPTAINER_IMAGE" == *://* || "$APPTAINER_IMAGE" == *.sif || -f "$APPTAINER_IMAGE" ]] || APPTAINER_IMAGE="docker://${APPTAINER_IMAGE}"
    report_apptainer_image_identity "$IMAGE" "review appliance" "$IS_OVERRIDE" "$MIN_REVIEW_APPLIANCE_VERSION"
    prepare_apptainer_environment
    export APPTAINERENV_LUNA_FACTORY_CLAIMS_ROOT=/claims
    exec apptainer run --containall --no-eval "${APPTAINER_HOST_ARGS[@]}" --home "${INSTANCE_HOME}:/home/bluefin" --pwd /workspace \
      --bind "${INSTANCE_WORKSPACE}:/workspace,${INSTANCE_TMP}:/tmp,${CLAIMS_ROOT}:/claims:rw" "$APPTAINER_IMAGE" ${APPLIANCE_ARGS[@]+"${APPLIANCE_ARGS[@]}"}

# Build the appliance from this checkout and hold it to its contract. The
# version is derived, never typed: FSDK series from the pinned base, revision
# from image/appliance/REVISION.
[doc("Build the review appliance image locally and verify its contract.")]
review-appliance-build tag="localhost/review:dev":
    #!/usr/bin/env bash
    set -euo pipefail
    ENGINE="${CONTAINER_ENGINE:-podman}"
    VERSION="$(bash scripts/review-appliance-version.sh)"
    echo "→ building {{tag}} as version ${VERSION}"
    "$ENGINE" build \
      --format oci \
      --build-arg REVIEW_VERSION="$VERSION" \
      --build-arg REVIEW_REVISION="$(git rev-parse HEAD 2>/dev/null || echo unknown)" \
      --file image/appliance/Containerfile \
      --tag "{{tag}}" \
      .
    bash tests/appliance-contract.sh --image "{{tag}}" --expect-arch "$(uname -m)"

# Preflight check for the Review appliance; starts no agent and mounts no credential.
[doc("Preflight diagnostics for this machine. Starts no agent.")]
review-doctor:
    #!/usr/bin/env bash
    set -uo pipefail
    {{shared_functions}}

    pass=0; fail=0
    check() {
      local label="$1"; shift
      if "$@" &>/dev/null; then echo "  ✓ ${label}"; pass=$((pass+1));
      else echo "  ✗ ${label}"; fail=$((fail+1)); fi
    }
    echo "=== Isolation runtime ==="
    KVM_FAILURE=""
    if kvm_runtime_ready; then
      echo "  ✓ Podman krun KVM runtime ready"
      pass=$((pass+1))
    elif apptainer_fallback_ready; then
      echo "  ! ${KVM_FAILURE}; isolated Apptainer fallback ready"
      pass=$((pass+1))
    else
      echo "  ✗ ${KVM_FAILURE}; ${APPTAINER_FAILURE}"
      fail=$((fail+1))
    fi
    echo ""

    echo "=== GitHub ==="
    if github_auth_ready; then
      echo "  ✓ gh is authenticated against github.com"
      pass=$((pass+1))
    else
      echo "  ✗ gh is not authenticated against github.com"
      echo "    Run: ${GITHUB_LOGIN_COMMAND}"
      fail=$((fail+1))
    fi
    resolve_gh_token
    if [[ -n "${GH_TOKEN_VALUE:-}" ]]; then
      echo "  ✓ a GitHub token is available to Review (from ${GH_TOKEN_SOURCE}; not shown)"
      DOCTOR_GH_SCOPES="$(gh_token_scopes)"
      if [[ -n "$DOCTOR_GH_SCOPES" ]]; then
        echo "    Review actions are limited to permissions this token grants: ${DOCTOR_GH_SCOPES}"
        if [[ ",${DOCTOR_GH_SCOPES//[[:space:]]/}," != *",workflow,"* && ",${DOCTOR_GH_SCOPES//[[:space:]]/}," != *"'workflow'"* ]]; then
          echo "    ! Token lacks 'workflow' scope: tasks modifying .github/workflows/* cannot be pushed or merged."
        fi
      fi
      echo "    Narrow that with REVIEW_GH_TOKEN=<scoped PAT> if that is wider than you want."
      pass=$((pass+1))
    else
      echo "  ✗ no GitHub token is available to Review"
      echo "    Run: ${GITHUB_LOGIN_COMMAND}, or export REVIEW_GH_TOKEN."
      fail=$((fail+1))
    fi
    unset GH_TOKEN_VALUE
    echo ""

    doctor_image() {
      local label="$1" ref="$2" status
      echo "=== ${label} image ==="
      if image_available "$ref"; then
        echo "  ✓ ${ref} is resolvable"
        pass=$((pass+1))
      else
        status=$?
        if [[ "$status" -eq 2 ]]; then
          echo "  - ${ref} resolution deferred to Apptainer launch"
          pass=$((pass+1))
        else
          echo "  ✗ ${ref} cannot be resolved"
          fail=$((fail+1))
        fi
      fi
      echo ""
    }
    doctor_image "Review" "${REVIEW_APPLIANCE_IMAGE:-ghcr.io/projectbluefin/review:stable}"




    echo "=== Workspace model ==="
    echo "  ✓ assigned repositories are cloned inside the disposable container"
    echo ""
    echo "${pass} checks passed, ${fail} failed."
    [[ "$fail" -eq 0 ]] || exit 1
