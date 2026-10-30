# Dagger tooling for repository agents

Use `bin/ci` from the repository root for local verification:

```sh
bin/ci --profile contract
bin/ci --profile portable
bin/ci --profile pre-push --base origin/main
```

The contract and portable profiles snapshot the current working tree on every
invocation, remove known credential variables before starting Dagger, and
propagate the selected suite's exit status. A later invocation therefore sees
edits made after an earlier run. The pre-push profile requires an explicit
`--base`; its planner can report a native gate as blocked, which is not a green
native result.

The official Dagger MCP command in v0.21.11 is experimental and presents a
generic method dispatcher. This repository does not currently ship a tested
MCP policy layer that restricts method selection and source inputs to the
repo-only verification contract. Do not enable it in Codex or OMP for this
checkout. The repository agent skill is at
[`../.agents/skills/review-ci/SKILL.md`](../.agents/skills/review-ci/SKILL.md).

Do not add this development integration to
`image/extension/review/.mcp.json`; that file configures the shipped Review
product. Do not configure MCP in user-global Codex settings. Use `bin/ci` until
the repository can prove a bounded method surface, fresh source per call,
failure propagation, and denial of native execution and publication paths.
