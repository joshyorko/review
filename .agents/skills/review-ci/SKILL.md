# Review CI agent workflow

Run repository verification through the checked-in Dagger entrypoint from the
repository root:

```sh
bin/ci --profile contract
bin/ci --profile portable
bin/ci --profile release-plan --bump patch
```

`contract` is the fast local contract set. `portable` includes the wider
credential-free checks. Each invocation creates a fresh sanitized snapshot of
the current tracked and non-ignored working tree, including the project CI
skill, and passes failures through unchanged. Re-run the same profile after a
repair; do not reuse a snapshot from an earlier call.

For the pre-push gate, provide an explicit comparison ref:

```sh
bin/ci --profile pre-push --base origin/main
```

The pre-push planner selects work from the diff. A blocked native requirement
is not portable proof. `contract` and `portable` do not prove host OCI/SIF
execution, two-architecture release readiness, GitHub Actions success, or
publication. State those gates separately in reviews and handoffs.

The `release-plan` profile is a read-only plan by default. Use `--apply` only
when an authorized main-branch release request should create the source change,
pull request, and exact-head validation dispatch.

Do not configure Dagger's experimental generic MCP server for this repository.
Its generic method dispatcher does not enforce the repo-only source and
verification boundary. Use `bin/ci` directly; it is the supported local and CI
entrypoint. Never run `codex mcp add` for this project or write user-global MCP
configuration.
