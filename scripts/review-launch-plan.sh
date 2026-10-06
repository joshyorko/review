# shellcheck shell=bash
# Host launch intent only. Profiles are data, never shell input.
set -euo pipefail

declare -A REVIEW_LAUNCH_GROUP_NAMES=(
  ["aws-sdk"]="AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY AWS_SESSION_TOKEN AWS_REGION AWS_DEFAULT_REGION"
  ["bedrock-bearer"]="AWS_BEARER_TOKEN_BEDROCK AWS_REGION AWS_DEFAULT_REGION"
  [openai]="OPENAI_API_KEY"
  [anthropic]="ANTHROPIC_API_KEY ANTHROPIC_OAUTH_TOKEN"
  [gemini]="GEMINI_API_KEY"
  [typesafe]="TYPESAFE_API_KEY"
  [copilot]="COPILOT_GITHUB_TOKEN GITHUB_COPILOT_TOKEN COPILOT_INTEGRATION_ID"
)
REVIEW_LAUNCH_GROUPS=(aws-sdk bedrock-bearer openai anthropic gemini typesafe copilot)
REVIEW_LAUNCH_FIXED_NAMES=(GH_TOKEN GITHUB_TOKEN HIVE_HUB REVIEW_DEFAULT_SCOPE REVIEW_MODE REVIEW_INHERIT_OMP_CONFIG REVIEW_SKIP_REPOS LUNA_FACTORY_ENABLED LUNA_FACTORY_CAPACITY RTK_DISABLED)

review_launch_fail() {
  printf 'ERROR: %s\n' "$1" >&2
  return 1
}

review_launch_profile_name() {
  [[ "$1" =~ ^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$ && "$1" != none ]] ||
    review_launch_fail "profile names must be 1-64 letters, digits, dots, underscores or hyphens, starting with a letter or digit; 'none' is reserved"
}

review_launch_boolean() {
  case "$1" in
  true | 1) printf 'true' ;;
  false | 0) printf 'false' ;;
  *) review_launch_fail "boolean launch settings must be true, false, 1 or 0" ;;
  esac
}

review_launch_text_file() {
  # Bash read/mapfile discard NUL bytes, so compare raw bytes before parsing.
  local bytes text_bytes
  bytes="$(wc -c <"$1")" || {
    review_launch_fail "unreadable launch intent file"
    return 1
  }
  ((bytes <= $2)) || {
    review_launch_fail "launch intent file exceeds the supported size"
    return 1
  }
  text_bytes="$(LC_ALL=C tr -d '\000' <"$1" | wc -c)" || {
    review_launch_fail "unreadable launch intent file"
    return 1
  }
  if ((bytes != text_bytes)); then
    review_launch_fail "binary-corrupt launch intent file"
    return 1
  fi
}

review_launch_validate() {
  [[ "${REVIEW_LAUNCH_PLAN[version]}" == 1 ]] || review_launch_fail "unsupported launch profile version" || return
  case "${REVIEW_LAUNCH_PLAN[runtime]}" in auto | krun | apptainer) ;; *)
    review_launch_fail "runtime must be auto, krun or apptainer"
    return 1
    ;;
  esac
  case "${REVIEW_LAUNCH_PLAN[github_auth]}" in auto | gh-cli | environment) ;; *)
    review_launch_fail "GitHub auth source must be auto, gh-cli or environment"
    return 1
    ;;
  esac
  REVIEW_LAUNCH_PLAN[inherit_omp]="$(review_launch_boolean "${REVIEW_LAUNCH_PLAN[inherit_omp]}")" || return
  REVIEW_LAUNCH_PLAN[factory_enabled]="$(review_launch_boolean "${REVIEW_LAUNCH_PLAN[factory_enabled]}")" || return
  local capacity="${REVIEW_LAUNCH_PLAN[factory_capacity]}" group name approved
  if [[ ! "$capacity" =~ ^[1-9][0-9]{0,2}$ ]] || ((capacity > 100)); then
    review_launch_fail "Factory capacity must be between 1 and 100"
    return 1
  fi
  REVIEW_LAUNCH_SELECTED_NAMES=()
  REVIEW_LAUNCH_SELECTED_GROUPS=()
  REVIEW_LAUNCH_INDIVIDUAL_NAMES=()
  declare -A selected=()
  local -a entries=() names=()
  if [[ -n "${REVIEW_LAUNCH_PLAN[env_groups]}" ]]; then
    [[ "${REVIEW_LAUNCH_PLAN[env_groups]}" =~ ^[a-z][a-z0-9-]*(,[a-z][a-z0-9-]*)*$ ]] ||
      {
        review_launch_fail "environment groups must be a comma-separated list of supported groups"
        return 1
      }
    IFS=, read -r -a entries <<<"${REVIEW_LAUNCH_PLAN[env_groups]}"
    for group in "${entries[@]}"; do
      [[ "$group" =~ ^[a-z][a-z0-9-]*$ ]] || {
        review_launch_fail "unknown environment capability group"
        return 1
      }
      [[ -v "REVIEW_LAUNCH_GROUP_NAMES[$group]" ]] || {
        review_launch_fail "unknown environment capability group"
        return 1
      }
      REVIEW_LAUNCH_SELECTED_GROUPS+=("$group")
      read -r -a names <<<"${REVIEW_LAUNCH_GROUP_NAMES[$group]}"
      for name in "${names[@]}"; do selected["$name"]=1; done
    done
  fi
  if [[ -n "${REVIEW_LAUNCH_PLAN[env_names]}" ]]; then
    [[ "${REVIEW_LAUNCH_PLAN[env_names]}" =~ ^[A-Z][A-Z0-9_]*(,[A-Z][A-Z0-9_]*)*$ ]] ||
      {
        review_launch_fail "environment names must be a comma-separated list of approved names"
        return 1
      }
    IFS=, read -r -a entries <<<"${REVIEW_LAUNCH_PLAN[env_names]}"
    for name in "${entries[@]}"; do
      [[ "$name" =~ ^[A-Z][A-Z0-9_]*$ ]] || {
        review_launch_fail "unapproved environment capability name"
        return 1
      }
      approved=0
      for group in "${REVIEW_LAUNCH_GROUPS[@]}"; do
        [[ " ${REVIEW_LAUNCH_GROUP_NAMES[$group]} " != *" $name "* ]] || approved=1
      done
      for group in "${REVIEW_LAUNCH_FIXED_NAMES[@]}" TERM COLORTERM; do
        [[ "$group" != "$name" ]] || approved=1
      done
      ((approved)) || {
        review_launch_fail "unapproved environment capability name"
        return 1
      }
      selected["$name"]=1
      REVIEW_LAUNCH_INDIVIDUAL_NAMES+=("$name")
    done
  fi
  for name in "${!selected[@]}"; do REVIEW_LAUNCH_SELECTED_NAMES+=("$name"); done
}

review_launch_read_profile() {
  local name="$1" line key value path
  review_launch_profile_name "$name" || return
  path="$REVIEW_LAUNCH_CONFIG/profiles/$name.profile"
  [[ -f "$path" && ! -L "$path" && -r "$path" ]] || {
    review_launch_fail "selected launch profile is missing or unreadable"
    return 1
  }
  review_launch_text_file "$path" 16384 || return
  declare -A seen=()
  while IFS= read -r line || [[ -n "$line" ]]; do
    [[ -n "$line" && "$line" != \#* ]] || continue
    [[ "$line" == *=* ]] || {
      review_launch_fail "malformed launch profile record"
      return 1
    }
    key="${line%%=*}"
    value="${line#*=}"
    case "$key" in
    version | runtime | github_auth | inherit_omp | factory_enabled | factory_capacity | env_groups | env_names) ;;
    *)
      review_launch_fail "unknown launch profile field"
      return 1
      ;;
    esac
    [[ ! -v "seen[$key]" ]] || {
      review_launch_fail "duplicate launch profile field"
      return 1
    }
    seen["$key"]=1
    REVIEW_LAUNCH_PLAN["$key"]="$value"
  done <"$path"
  ((${#seen[@]} == 8)) || {
    review_launch_fail "launch profile is incomplete"
    return 1
  }
  review_launch_validate
}

review_launch_resolve() {
  local profile_env="${REVIEW_LAUNCH_PROFILE-}"
  REVIEW_LAUNCH_CONFIG="${XDG_CONFIG_HOME:-$HOME/.config}/review/launcher"
  REVIEW_LAUNCH_COMMAND=launch
  REVIEW_LAUNCH_PROFILE=""
  REVIEW_LAUNCH_QUIET=0
  REVIEW_LAUNCH_FILTERED=0
  REVIEW_LAUNCH_CUSTOM=0
  # Shared with bin/bluefin credential resolution after this sourced helper returns.
  # shellcheck disable=SC2034
  REVIEW_LAUNCH_AUTH_EXPLICIT=0
  REVIEW_LAUNCH_ARGS=()
  declare -gA REVIEW_LAUNCH_PLAN=([version]=1 [runtime]=auto [github_auth]=auto [inherit_omp]=false [factory_enabled]=false [factory_capacity]=2 [env_groups]="" [env_names]="")
  declare -A cli=()
  local arg flag field value name
  if [[ "${1:-}" == configure || "${1:-}" == profiles ]]; then
    REVIEW_LAUNCH_COMMAND="$1"
    shift
    if [[ "$REVIEW_LAUNCH_COMMAND" == configure ]]; then
      REVIEW_LAUNCH_PROFILE="${1:-personal}"
      (($# <= 1)) || {
        review_launch_fail "usage: bluefin review configure [name]"
        return 1
      }
      review_launch_profile_name "$REVIEW_LAUNCH_PROFILE" || return
      if [[ -e "$REVIEW_LAUNCH_CONFIG/profiles/$REVIEW_LAUNCH_PROFILE.profile" ]]; then
        review_launch_read_profile "$REVIEW_LAUNCH_PROFILE" || return
      fi
    else
      (($# == 0)) || {
        review_launch_fail "usage: bluefin review profiles"
        return 1
      }
    fi
    return 0
  fi
  while (($#)); do
    arg="$1"
    shift
    flag="${arg%%=*}"
    case "$flag" in
    --launcher-quiet)
      [[ "$arg" == "$flag" ]] || {
        review_launch_fail "--launcher-quiet takes no value"
        return 1
      }
      REVIEW_LAUNCH_QUIET=1
      continue
      ;;
    --launcher-profile) field=profile ;;
    --runtime) field=runtime ;;
    --github-auth) field=github_auth ;;
    --inherit-omp) field=inherit_omp ;;
    --factory) field=factory_enabled ;;
    --factory-capacity) field=factory_capacity ;;
    --env-groups) field=env_groups ;;
    --env-names) field=env_names ;;
    *)
      REVIEW_LAUNCH_ARGS+=("$arg")
      continue
      ;;
    esac
    if [[ "$arg" == *=* ]]; then
      value="${arg#*=}"
    else
      (($#)) && [[ "$1" != --* ]] || {
        review_launch_fail "launcher option requires a value"
        return 1
      }
      value="$1"
      shift
    fi
    [[ ! -v "cli[$field]" ]] || {
      review_launch_fail "duplicate launcher option"
      return 1
    }
    cli["$field"]="$value"
  done
  REVIEW_LAUNCH_PROFILE="${cli[profile]-$profile_env}"
  ((${#cli[@]} == 0)) || REVIEW_LAUNCH_CUSTOM=1
  if [[ -z "$REVIEW_LAUNCH_PROFILE" && (-e "$REVIEW_LAUNCH_CONFIG/default" || -L "$REVIEW_LAUNCH_CONFIG/default") ]]; then
    local -a defaults=()
    [[ -f "$REVIEW_LAUNCH_CONFIG/default" && ! -L "$REVIEW_LAUNCH_CONFIG/default" ]] || {
      review_launch_fail "invalid default launch profile selector"
      return 1
    }
    review_launch_text_file "$REVIEW_LAUNCH_CONFIG/default" 65 || return
    mapfile -t defaults <"$REVIEW_LAUNCH_CONFIG/default"
    ((${#defaults[@]} == 1)) || {
      review_launch_fail "invalid default launch profile selector"
      return 1
    }
    REVIEW_LAUNCH_PROFILE="${defaults[0]}"
  fi
  if [[ -n "$REVIEW_LAUNCH_PROFILE" && "$REVIEW_LAUNCH_PROFILE" != none ]]; then
    review_launch_read_profile "$REVIEW_LAUNCH_PROFILE" || return
    REVIEW_LAUNCH_FILTERED=1
    REVIEW_LAUNCH_CUSTOM=1
    REVIEW_LAUNCH_AUTH_EXPLICIT=1
  elif [[ "$REVIEW_LAUNCH_PROFILE" == none ]]; then REVIEW_LAUNCH_PROFILE=""; fi
  local -a overrides=(runtime:REVIEW_RUNTIME github_auth:REVIEW_GITHUB_AUTH inherit_omp:REVIEW_INHERIT_OMP_CONFIG factory_enabled:LUNA_FACTORY_ENABLED factory_capacity:LUNA_FACTORY_CAPACITY env_groups:REVIEW_ENV_GROUPS env_names:REVIEW_ENV_NAMES)
  for arg in "${overrides[@]}"; do
    field="${arg%%:*}"
    name="${arg#*:}"
    if [[ -v "cli[$field]" ]]; then
      REVIEW_LAUNCH_PLAN["$field"]="${cli[$field]}"
    elif [[ -v "$name" ]]; then REVIEW_LAUNCH_PLAN["$field"]="${!name}"; fi
    if [[ "$field" == github_auth ]] && { [[ -v "cli[$field]" ]] || [[ -v "$name" ]]; }; then
      # Shared with bin/bluefin credential resolution after this sourced helper returns.
      # shellcheck disable=SC2034
      REVIEW_LAUNCH_AUTH_EXPLICIT=1
      REVIEW_LAUNCH_CUSTOM=1
    fi
    if [[ "$field" == env_groups || "$field" == env_names ]] && { [[ -v "cli[$field]" ]] || [[ -v "$name" ]]; }; then REVIEW_LAUNCH_FILTERED=1; fi
  done
  review_launch_validate || return
  for arg in inherit_omp:REVIEW_INHERIT_OMP_CONFIG factory_enabled:LUNA_FACTORY_ENABLED factory_capacity:LUNA_FACTORY_CAPACITY; do
    field="${arg%%:*}"
    name="${arg#*:}"
    if [[ -n "$REVIEW_LAUNCH_PROFILE" || -v "cli[$field]" || -v "$name" ]]; then
      value="${REVIEW_LAUNCH_PLAN[$field]}"
      case "$value" in true) value=1 ;; false) value=0 ;; esac
      export "$name=$value"
    fi
  done
}

review_launch_environment() {
  REVIEW_LAUNCH_ENV_NAMES=()
  declare -A seen=()
  local name group
  local -a names=("${REVIEW_LAUNCH_FIXED_NAMES[@]}") group_names=()
  if ((REVIEW_LAUNCH_FILTERED)); then
    names+=("${REVIEW_LAUNCH_SELECTED_NAMES[@]}")
  else
    for group in "${REVIEW_LAUNCH_GROUPS[@]}"; do
      read -r -a group_names <<<"${REVIEW_LAUNCH_GROUP_NAMES[$group]}"
      names+=("${group_names[@]}")
    done
  fi
  for name in "${names[@]}"; do
    [[ "$name" != TERM && "$name" != COLORTERM && ! -v "seen[$name]" ]] || continue
    seen["$name"]=1
    [[ "$name" != RTK_DISABLED || -v RTK_DISABLED ]] || continue
    if ((REVIEW_LAUNCH_FILTERED)); then [[ -v "$name" ]] || continue; fi
    REVIEW_LAUNCH_ENV_NAMES+=("$name")
  done
}

review_launch_summary() {
  ((REVIEW_LAUNCH_QUIET == 0)) || return 0
  # Legacy launches keep their existing output unless a host option is selected.
  [[ "$REVIEW_LAUNCH_CUSTOM" == 1 || "${REVIEW_LAUNCH_PLAN[runtime]}" != auto || "$REVIEW_LAUNCH_FILTERED" == 1 ]] || return 0
  printf 'Review launch: scope=%s profile=%s runtime=%s\n' "$2" "${REVIEW_LAUNCH_PROFILE:-none}" "$1" >&2
  printf '  OMP config: %s; Factory: %s (capacity %s)\n' "${REVIEW_LAUNCH_PLAN[inherit_omp]}" "${REVIEW_LAUNCH_PLAN[factory_enabled]}" "${REVIEW_LAUNCH_PLAN[factory_capacity]}" >&2
  printf '  GitHub source: %s; credential: %s\n' "${REVIEW_GITHUB_AUTH_SOURCE:-auto}" "$([[ -n "${GH_TOKEN:-}${GITHUB_TOKEN:-}" ]] && printf present || printf missing)" >&2
  printf '  Factory Git author/committer: Luna Factory / factory@localhost (independent of GitHub authentication)\n' >&2
  local group name selected present
  local -a names=() missing=()
  for group in "${REVIEW_LAUNCH_GROUPS[@]}"; do
    read -r -a names <<<"${REVIEW_LAUNCH_GROUP_NAMES[$group]}"
    selected=0
    present=0
    missing=()
    if ((REVIEW_LAUNCH_FILTERED == 0)) || [[ " ${REVIEW_LAUNCH_SELECTED_GROUPS[*]} " == *" $group "* ]]; then selected=1; fi
    for name in "${names[@]}"; do
      if ((selected)); then
        if [[ -v "$name" ]]; then present=1; else missing+=("$name"); fi
      fi
    done
    if ((selected == 0)); then
      printf '  %s: not selected\n' "$group" >&2
    elif ((present == 0)); then
      printf '  %s: selected / missing\n' "$group" >&2
    else
      printf '  %s: selected / present' "$group" >&2
      ((${#missing[@]} == 0)) || printf ' (missing: %s)' "${missing[*]}" >&2
      printf '\n' >&2
    fi
  done
  for name in "${REVIEW_LAUNCH_INDIVIDUAL_NAMES[@]}"; do
    printf '  %s: selected / %s (individual name)\n' "$name" "$([[ -v "$name" ]] && printf present || printf missing)" >&2
  done
}

review_launch_profiles() {
  local path name default=""
  [[ ! -f "$REVIEW_LAUNCH_CONFIG/default" ]] || IFS= read -r default <"$REVIEW_LAUNCH_CONFIG/default" || true
  for path in "$REVIEW_LAUNCH_CONFIG"/profiles/*.profile; do
    [[ -f "$path" && ! -L "$path" ]] || continue
    name="${path##*/}"
    name="${name%.profile}"
    review_launch_profile_name "$name" || return
    printf '%s%s\n' "$name" "$([[ "$name" == "$default" ]] && printf ' (default)' || true)"
  done
}

review_launch_destination() {
  if [[ -e "$1" || -L "$1" ]]; then
    [[ -f "$1" && ! -L "$1" ]] || {
      review_launch_fail "launch intent destination must be a regular file or absent"
      return 1
    }
  fi
}

review_launch_configure() {
  [[ -t 0 && -t 1 ]] || {
    review_launch_fail "configure requires an interactive terminal; scripted callers may write the documented profile format"
    exit 1
  }
  command -v flock >/dev/null 2>&1 || {
    review_launch_fail "flock is required to safely save launch profiles"
    exit 1
  }
  local field answer value save make_default
  # Wait for the foreground save transaction to settle before exiting on a
  # signal. Its own traps restore previous files before the parent returns.
  trap 'exit 130' INT
  trap 'exit 143' TERM
  printf 'Review launcher profile: %s\n' "$REVIEW_LAUNCH_PROFILE"
  for field in runtime github_auth inherit_omp factory_enabled factory_capacity env_groups env_names; do
    read -r -p "$field [${REVIEW_LAUNCH_PLAN[$field]}]: " answer || {
      review_launch_fail "configuration cancelled; previous profile is unchanged"
      exit 1
    }
    value="${answer:-${REVIEW_LAUNCH_PLAN[$field]}}"
    if [[ "$field" == env_groups || "$field" == env_names ]] && [[ "$answer" == - ]]; then value=""; fi
    REVIEW_LAUNCH_PLAN["$field"]="$value"
  done
  review_launch_validate || exit 1
  read -r -p 'Save profile? [y/N]: ' save || {
    review_launch_fail "configuration cancelled; previous profile is unchanged"
    exit 1
  }
  case "$save" in y | Y | yes) ;; *)
    printf 'Profile unchanged.\n'
    exit 0
    ;;
  esac
  read -r -p 'Make it the default? [y/N]: ' make_default || {
    review_launch_fail "configuration cancelled; previous profile is unchanged"
    exit 1
  }
  (
    # Keep save state in this subshell: errexit cannot unwind it before EXIT.
    temp_profile=""
    temp_default=""
    profile_backup=""
    default_backup=""
    transaction_started=0
    committed=0
    save_default=0
    profile_destination="$REVIEW_LAUNCH_CONFIG/profiles/$REVIEW_LAUNCH_PROFILE.profile"
    default_destination="$REVIEW_LAUNCH_CONFIG/default"
    case "$make_default" in y | Y | yes) save_default=1 ;; esac
    # Invoked only by this transaction's EXIT trap below.
    # shellcheck disable=SC2329
    finish_launch_save() {
      save_status=$?
      trap - EXIT
      trap '' INT TERM
      rollback_failed=0
      if ((transaction_started && !committed)); then
        if [[ -n "$profile_backup" ]]; then
          mv -fT -- "$profile_backup" "$profile_destination" || rollback_failed=1
        else rm -f -- "$profile_destination" || rollback_failed=1; fi
        if ((save_default)); then
          if [[ -n "$default_backup" ]]; then
            mv -fT -- "$default_backup" "$default_destination" || rollback_failed=1
          else rm -f -- "$default_destination" || rollback_failed=1; fi
        fi
      fi
      for pending in "$temp_profile" "$temp_default"; do [[ -z "$pending" ]] || rm -f -- "$pending"; done
      if ((rollback_failed)); then
        printf 'ERROR: launch intent rollback failed; private recovery files were retained\n' >&2
        exit 1
      fi
      for pending in "$profile_backup" "$default_backup"; do [[ -z "$pending" ]] || rm -f -- "$pending"; done
      exit "$save_status"
    }
    trap 'finish_launch_save' EXIT
    trap 'exit 130' INT
    trap 'exit 143' TERM
    review_launch_destination "$profile_destination"
    ((save_default == 0)) || review_launch_destination "$default_destination"
    umask 077
    mkdir -p "$REVIEW_LAUNCH_CONFIG/profiles"
    chmod 0700 "$REVIEW_LAUNCH_CONFIG" "$REVIEW_LAUNCH_CONFIG/profiles"
    # Retain one inode: unlinking a lock file would let later saves bypass
    # owners still using its old descriptor. The kernel releases it on exit.
    review_launch_destination "$REVIEW_LAUNCH_CONFIG/configure.lock"
    exec {save_lock_fd}>>"$REVIEW_LAUNCH_CONFIG/configure.lock"
    if flock --exclusive --nonblock --conflict-exit-code 75 "$save_lock_fd" 2>/dev/null; then
      :
    else
      save_lock_status=$?
      if ((save_lock_status == 75)); then
        review_launch_fail "a launch profile save is in progress; retry after it exits"
      else review_launch_fail "could not acquire the launch profile save lock"; fi
      exit 1
    fi
    # A prior transaction may have changed these paths before lock acquisition.
    review_launch_destination "$profile_destination"
    ((save_default == 0)) || review_launch_destination "$default_destination"
    temp_profile="$(mktemp "$REVIEW_LAUNCH_CONFIG/profiles/.profile.XXXXXXXX")"
    for field in version runtime github_auth inherit_omp factory_enabled factory_capacity env_groups env_names; do
      printf '%s=%s\n' "$field" "${REVIEW_LAUNCH_PLAN[$field]}"
    done >"$temp_profile"
    if ((save_default)); then
      temp_default="$(mktemp "$REVIEW_LAUNCH_CONFIG/.default.XXXXXXXX")"
      printf '%s\n' "$REVIEW_LAUNCH_PROFILE" >"$temp_default"
    fi
    if [[ -f "$profile_destination" ]]; then
      profile_backup="$(mktemp "$REVIEW_LAUNCH_CONFIG/profiles/.profile-backup.XXXXXXXX")"
      cp -p -- "$profile_destination" "$profile_backup"
    fi
    if ((save_default)) && [[ -f "$default_destination" ]]; then
      default_backup="$(mktemp "$REVIEW_LAUNCH_CONFIG/.default-backup.XXXXXXXX")"
      cp -p -- "$default_destination" "$default_backup"
    fi
    # Arm rollback before mv: a queued trap can run before its next command.
    transaction_started=1
    mv -fT -- "$temp_profile" "$profile_destination"
    ((save_default == 0)) || mv -fT -- "$temp_default" "$default_destination"
    committed=1
  )
  printf 'Saved launch intent for %s. No runtime was started.\n' "$REVIEW_LAUNCH_PROFILE"
  exit 0
}
