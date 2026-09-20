---
name: skill-improvement
version: "1.3"
last_updated: "2026-09-19"
id: skill-improvement
one_line_purpose: Keep repository documentation source-backed, current, and compact.
entry_point: docs/skills/skill-improvement.md
category: meta
mcp_compliance_level: partial
optimization_status: active
status: active
dependencies: []
tags: [skills, documentation, maintenance, factory]
description: "Maintains repository documentation and skill contracts from current source evidence. Use for repo-wide documentation audits, stale guidance, skill routing, catalog changes, or durable agent learning."
metadata:
  type: reference
---

# Documentation and Skill Improvement

## When to Use

Load this before auditing or changing documentation, skill routing, the skill
catalog, or agent-facing repository contracts.

## When Not to Use

Do not use this as a backlog, session log, or replacement for the
task-specific launcher, image, Hive, or pull-request workflow skill.
Use it alongside the matching skill when documentation maintenance is part of
that work.

## Core Process

1. Read `AGENTS.md`, `docs/factory/agentic-model.md`, `docs/SKILL.md`, and
   every task-matching local skill first. The agentic model is the canonical
   vocabulary and authority boundary.
2. Inventory the documentation surface before editing. Classify every user doc,
   agent contract, skill, router entry, and generated catalog row as relevant or
   intentionally unchanged. “Update all docs” requires complete classification,
   not weightless edits to unrelated files.
3. Build an evidence chain for each behavior: current launcher/image/source,
   focused contract test, user-facing document, agent-facing contract, and
   matching skill. A link may be absent when that audience does not need the
   fact; contradictory links are defects.
4. Repair each contradiction at the nearest authoritative source. Keep one
   detailed home for a rule and use sharp context pointers elsewhere. Remove
   superseded wording instead of adding compatibility prose or a second model.
5. Prune duplication, stale caches, and no-op instructions. Preserve every
   source-backed safety invariant: a soft length or style warning is evidence to
   remove sediment, never permission to delete live contract behavior.
6. When skill frontmatter changes, regenerate `docs/skills/index.json` with
   `bash scripts/check-skill-frontmatter.sh --write`; never edit the catalog by
   hand. Keep changelogs, session notes, plans, and design scratchpads out of the
   repository.
7. Treat history, issue reports, and prior agent output as leads. Verify every
   project-specific claim in current source, tests, workflows, or contracts.
   Finish with a repository-wide search for superseded terminology and classify
   every surviving match before declaring the documentation aligned.

When a human must intervene to restart continuation or correct scheduling,
classify the control failure; record the durable transition in the relevant
issue or pull request; if reusable, add the smallest preventive rule to the
closest skill and verify it where practical; never create a session diary.

## Common Rationalizations

| Rationalization | Reality |
|---|---|
| "The implementation is the only source of truth." | The implementation proves behavior; the documented model makes roles and authority legible to agents and users. Keep both aligned. |
| "The plan is useful history." | Git history preserves completed work. A stale plan acts as a competing current contract. |
| "This detail is too small for a skill." | If it changes how a future agent should operate, encode the timeless rule in the nearest skill. |
| "The skill is over its soft line target, so a detailed rule must go." | Remove duplication or disclose a branch. A live safety invariant outranks a soft size warning. |

## Red Flags

- Copying a factory policy that conflicts with this repository's launcher
  boundaries.
- Treating a source file, test, and user document as independent policies
  instead of one documented model.
- Treating an old plan or design record as current behavior.
- Updating a skill without its matching catalog entry.
- Adding a permanent session log instead of repairing the relevant skill.
- Touching unrelated documents so a repo-wide audit appears comprehensive.
- Declaring alignment before every superseded-term search match is classified.
- Changing another repository before reading its `AGENTS.md`, `CONTRIBUTING.md`
  and `docs/skills/`. Those files name the seam and forbid the shortcut, so
  the two minutes spent reading them is repaid immediately; skipping them is
  what produces a rejected approach and a wasted build.
- Diagnosing a service by guessing at endpoint names when its skill documents
  the supported read-only ones.
- Claiming project-internal facts without checking the launcher, image, tests,
  or workflow.

## Verification

```bash
bash scripts/check-skill-frontmatter.sh
bash tests/generate-skills.sh
bash tests/test-registry.sh
pre-commit run --all-files
git diff --check
```
