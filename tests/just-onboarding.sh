#!/usr/bin/env bash
# Contract for the direct-copy transition: review recipes fail before launch.
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
justfile="$repo_root/justfile"
real_just="$(command -v just)"
scratch="$(mktemp -d)"
trap 'rm -rf "$scratch"' EXIT

fake_bin="$scratch/bin"
podman_log="$scratch/podman.log"
mkdir -p "$fake_bin"
cat >"$fake_bin/podman" <<'EOF'
#!/usr/bin/env bash
printf '%s\n' "$*" >>"${PODMAN_LOG:?}"
exit 99
EOF
chmod 0755 "$fake_bin/podman"

fail() {
  echo "FAIL: $1" >&2
  exit 1
}

run_recipe() {
  local recipe="$1"
  set +e
  output="$(
    PATH="$fake_bin:$PATH" PODMAN_LOG="$podman_log" \
      "$real_just" --justfile "$justfile" "$recipe" 2>&1
  )"
  status=$?
  set -e
}

for recipe in review-container review-queue review-doctor; do
  run_recipe "$recipe"
  [[ "$status" -ne 0 ]] || fail "${recipe} must refuse the direct-copy image"
  grep -q 'direct lab-runner fork' <<<"$output" ||
    fail "${recipe} must explain the direct-copy transition"
  grep -q '#173' <<<"$output" ||
    fail "${recipe} must name the runtime-restoration issue"
done

[[ ! -s "$podman_log" ]] ||
  fail "direct-copy launch guards must not invoke Podman"

list="$("$real_just" --justfile "$justfile" --list)"
for recipe in review-container review-stop review-doctor review-queue; do
  grep -qE "^[[:space:]]+${recipe}([[:space:]]|$)" <<<"$list" ||
    fail "public recipe missing from just --list: ${recipe}"
done
[[ "$(grep -cE '^[[:space:]]+review-(container|stop|doctor|queue)([[:space:]]|$)' <<<"$list")" -eq 4 ]] ||
  fail "just --list must expose exactly four review recipes"

code="$(cat "$justfile")"
grep -q 'require_review_runtime' <<<"$code" ||
  fail "the launcher must define the direct-copy guard"
stop_body="$(sed -n '/^review-stop/,/^[a-z]/p' "$justfile")"
grep -q 'review.owner' <<<"$stop_body" ||
  fail "review-stop must remain scoped to launcher-owned detached workers"
if grep -qE 'podman (rm|kill)|--force|stop -f' <<<"$stop_body"; then
  fail "review-stop must stop politely and never force-remove"
fi

printf 'direct-copy launcher contract OK\n'
