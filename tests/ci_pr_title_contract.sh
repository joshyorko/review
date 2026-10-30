#!/usr/bin/env bash
set -euo pipefail

command -v dagger >/dev/null || {
	echo "ci-pr-title-contract: Dagger CLI is required" >&2
	exit 127
}

accepts() {
	local title="$1"
	local output
	if ! output="$(DAGGER_NO_NAG=1 dagger call pr-title --title "$title" 2>&1)"; then
		printf '%s\n' "$output" >&2
		return 1
	fi
}

rejects() {
	local title="$1"
	if accepts "$title" >/dev/null 2>&1; then
		echo "ci-pr-title-contract: accepted invalid title: $(printf '%q' "$title")" >&2
		return 1
	fi
}

for type in feat fix chore docs style refactor perf test ci build revert; do
	accepts "$type: add title validation coverage"
done
accepts 'fix(parser): handle scoped changes'
accepts 'feat(api)!: handle breaking changes'

rejects 'wip: not in the allowed type list'
rejects 'fix: '
rejects $'fix: reject multiline\nsubject'
rejects $'fix: reject carriage return\rsubject'

tmpdir="$(mktemp -d "${TMPDIR:-/tmp}/ci-pr-title.XXXXXX")"
trap 'rm -rf "$tmpdir"' EXIT
sentinel="$tmpdir/command-ran"
hostile_title="feat: keep quotes ' \" and ticks \` plus \$(touch $sentinel) as data"
accepts "$hostile_title"
[[ ! -e "$sentinel" ]] || {
	echo "ci-pr-title-contract: title input executed a shell command" >&2
	exit 1
}

echo "ci-pr-title-contract: allowed types, rejection cases, and inert shell metacharacters passed"
