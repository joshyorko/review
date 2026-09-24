# review Skill Router

After reading [`AGENTS.md`](../AGENTS.md) and the local
[agentic model](factory/agentic-model.md), choose the one task-specific
document below. Load only the matching skill.
[`contribution-culture.md`](skills/contribution-culture.md) is the exception:
it scopes every task, so read it alongside the matching skill.

| Task | Skill |
|---|---|
| Scope a change, size a pull request, or address a maintainer | [`contribution-culture.md`](skills/contribution-culture.md) |
| Change a launcher recipe, launch mode, or container execution | [`launcher.md`](skills/launcher.md) |
| Maintain the OMP workbench review agents and policy seam | [`review-checks.md`](skills/review-checks.md) |
| Maintain the opt-in Luna Factory extension | [`luna-factory.md`](skills/luna-factory.md) |
| Build the Review appliance, OMP pins, SBOMs, or publication workflows | [`image-build.md`](skills/image-build.md) |
| Configure explicitly selected optional Hive read-side context | [`hive-read-side.md`](skills/hive-read-side.md) |
| Change queue ordering, issue batches, or workbench controls | [`review-dashboard.md`](skills/review-dashboard.md) |
| Monitor running OMP workbenches | [`review-monitoring.md`](skills/review-monitoring.md) |
| Prepare a branch, commit, or pull request | [`pr-workflow.md`](skills/pr-workflow.md) |
| Audit docs or maintain factory compliance | [`skill-improvement.md`](skills/skill-improvement.md) |
| Coordinate bounded Factory continuation and writable capacity | [`factory-operations.md`](skills/factory-operations.md) |

`docs/skills/index.json` is the machine-readable catalog, generated from the
frontmatter in each skill file. When changing a skill, regenerate it with
`bash scripts/check-skill-frontmatter.sh --write` in the same change.
