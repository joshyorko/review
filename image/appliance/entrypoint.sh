#!/usr/bin/bash
# The image is an immutable appliance: omp configuration that makes sense on a
# developer workstation must not silently become appliance startup policy.
set -eu

# krun may start the OCI entrypoint as guest root even though the image declares
# USER 65532:65532. Persistent bind mounts are owned by that mapped appliance
# user, so drop before touching OMP state or launching the interactive process.
# Apptainer and runtimes that honor OCI USER already enter as bluefin and pass
# through unchanged.
if ((EUID == 0)); then
  export HOME=/home/bluefin USER=bluefin LOGNAME=bluefin
  exec /usr/bin/python3 -c '
import os
import sys

try:
    os.setgroups([65532])
    os.setgid(65532)
    os.setuid(65532)
except OSError as error:
    print(f"Review appliance: could not drop to bluefin uid/gid 65532: {error}", file=sys.stderr)
    raise SystemExit(1)

os.execv("/usr/bin/bash", ["/usr/bin/bash", "/usr/bin/bluefin-review-appliance", *sys.argv[1:]])
' "$@"
fi

prepare_factory_state_dir() {
  local path="$1" expected_uid expected_gid owner group
  expected_uid="$(id -u)"
  expected_gid="$(id -g)"
  if [[ -L "$path" ]]; then
    echo "Review appliance: persistent Factory state path ${path} is a symlink; refusing to follow it." >&2
    return 1
  fi
  if [[ ! -e "$path" ]]; then
    mkdir -m 0700 -- "$path" || {
      echo "Review appliance: could not prepare persistent Factory state path ${path}." >&2
      return 1
    }
  fi
  [[ -d "$path" ]] || {
    echo "Review appliance: persistent Factory state path ${path} is not a directory." >&2
    return 1
  }
  IFS=: read -r owner group < <(stat -c '%u:%g' -- "$path") || {
    echo "Review appliance: could not inspect persistent Factory state path ${path}." >&2
    return 1
  }
  if [[ "$owner" != "$expected_uid" || "$group" != "$expected_gid" || ! -w "$path" ]]; then
    echo "Review appliance: persistent Factory state path ${path} is owned by ${owner}:${group}; expected ${expected_uid}:${expected_gid}. No ownership changes were made; use a fresh instance or inspect this exact path." >&2
    return 1
  fi
}

factory_home="${HOME:-/home/bluefin}"
for factory_path in \
  "$factory_home/.local" \
  "$factory_home/.local/state" \
  "$factory_home/.local/state/review" \
  "$factory_home/.local/state/review/factory"; do
  prepare_factory_state_dir "$factory_path" || exit 1
done

export COPILOT_INTEGRATION_ID="${COPILOT_INTEGRATION_ID:-copilot-developer-cli}"
export COPILOT_GITHUB_TOKEN="${COPILOT_GITHUB_TOKEN:-${GH_TOKEN:-${GITHUB_TOKEN:-}}}"
export GITHUB_COPILOT_TOKEN="${GITHUB_COPILOT_TOKEN:-${COPILOT_GITHUB_TOKEN:-}}"
profile="bluefin-review-appliance"
if [ "${REVIEW_INHERIT_OMP_CONFIG:-${BLUEFIN_REVIEW_INHERIT_OMP_CONFIG:-0}}" = 1 ]; then
  profile="review"
fi
if [ "$profile" = bluefin-review-appliance ]; then
  appliance_mcp_dir="$HOME/.omp/profiles/$profile/agent"
  appliance_mcp_config="$appliance_mcp_dir/mcp.json"
  if [ ! -e "$appliance_mcp_config" ] && [ -f /usr/share/bluefin/review/appliance-mcp.json ]; then
    mkdir -p "$appliance_mcp_dir"
    cp /usr/share/bluefin/review/appliance-mcp.json "$appliance_mcp_config"
  fi
fi

# Extension packages this image ships. Review is the mode; Luna Factory is loaded
# beside it and starts no work on load — its execution is opt-in through
# LUNA_FACTORY_ENABLED, so an inactive stock Review session is unchanged.
extension_args=(--extension /usr/share/bluefin/review/extension)
if [ -d /usr/share/bluefin/review/luna-factory ]; then
  extension_args+=(--extension /usr/share/bluefin/review/luna-factory)
else
  # The image is the only place the packaged layout is observable: say which
  # extension is missing instead of letting the handoff fail inside the session.
  echo "Review appliance: Luna Factory extension is not packaged at /usr/share/bluefin/review/luna-factory; the Factory handoff will be unavailable." >&2
fi
case "${1:-}" in
update)
  cat >&2 <<'EOF'
Review is an immutable appliance and cannot update itself.
Pull a newer container image and launch it to update.
EOF
  exit 2
  ;;
--help | -h | help)
  # OMP owns the rest of the help text. Remove its mutable-install update
  # command and replace it with the appliance contract below.
  omp --profile "$profile" --config /usr/share/bluefin/review/appliance-config.yml \
    "${extension_args[@]}" \
    --extension /usr/share/bluefin/review/typesafe-omp-loader.mjs "$@" |
    sed '/^[[:space:]]*update[[:space:]]/d'
  cat <<'EOF'

Appliance lifecycle:
  This image is immutable. Replace it to update; `omp update` is disabled.
  Host OMP profiles and their MCP servers are isolated by default. Set
  REVIEW_INHERIT_OMP_CONFIG=1 to explicitly use the host `review` profile.
EOF
  exit 0
  ;;
esac
args=("$@")
advisor=false
for arg in "${args[@]}"; do
  [ "$arg" = --advisor ] && advisor=true
done
if [ "$advisor" = false ]; then
  args+=(--advisor)
fi

exec omp --profile "$profile" \
  --config /usr/share/bluefin/review/appliance-config.yml \
  "${extension_args[@]}" \
  --extension /usr/share/bluefin/review/typesafe-omp-loader.mjs "${args[@]}"
