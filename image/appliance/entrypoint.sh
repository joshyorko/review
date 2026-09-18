#!/usr/bin/bash
# The image is an immutable appliance: omp configuration that makes sense on a
# developer workstation must not silently become appliance startup policy.
set -eu

export COPILOT_INTEGRATION_ID="${COPILOT_INTEGRATION_ID:-copilot-developer-cli}"
export COPILOT_GITHUB_TOKEN="${COPILOT_GITHUB_TOKEN:-${GH_TOKEN:-${GITHUB_TOKEN:-}}}"
export GITHUB_COPILOT_TOKEN="${GITHUB_COPILOT_TOKEN:-${COPILOT_GITHUB_TOKEN:-}}"
profile="bluefin-review-appliance"
if [ "${BLUEFIN_REVIEW_INHERIT_OMP_CONFIG:-0}" = 1 ]; then
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
fi
case "${1:-}" in
update)
  cat >&2 <<'EOF'
Bluefin Review is an immutable appliance and cannot update itself.
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
  BLUEFIN_REVIEW_INHERIT_OMP_CONFIG=1 to explicitly use the host `review` profile.
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
