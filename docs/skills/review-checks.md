---
name: review-checks
version: "2.2"
last_updated: 2026-09-23
id: review-checks
one_line_purpose: Maintain neutral Review agents and generic policy.
entry_point: docs/skills/review-checks.md
category: ci-ops
status: active
tags: [checks, review, subagents, policy, omp]
description: "Maintains Review's generic policy seam and read-only specialist agents."
metadata:
  type: reference
  context7-sources: []
---

# Review Agents and Policy

OMP discovers the companion agent definitions in `image/extension/bluefin-review/agents/`. The retained directory name is a packaging path; the shipped agent vocabulary is neutral:

- `reviewer`: coordinates specialist evidence into a human-facing review draft.
- `review-security`: examines trust boundaries, credentials, and unsafe mutations.
- `review-correctness`: examines observable behavior and failure modes.
- `review-test-coverage`: assesses meaningful behavioral coverage and regressions.
- `review-simplicity`: identifies duplication, dead machinery, and avoidable complexity.
- `review-ci-triage`: diagnoses live CI failures.
- `review-queue-triage`: classifies GitHub queue evidence without organization-specific routing.

## Rules

1. Agent definitions omit provider, model, and effort; OMP resolves the user's active choice.
2. Review agents are read-only. Their tool allowlists must not include comment, submit-review, approval, push, or merge capabilities.
3. Verdicts and specialist findings inform the human/coordinator; they never authorize GitHub mutation or turn missing evidence into approval.
4. Use the target repository's own instructions. Do not route by owner prefix or add organization-specific labels, doctrine, or policy defaults.
5. Review tools and prompts consume live GitHub evidence. Optional Hive projections are available only in explicitly selected Hive mode and do not assign work.
6. Delete a specialist when its responsibility is fully duplicated by OMP or another agent; do not keep wrappers for compatibility.

## Verification

```bash
bash tests/omp-review-mode.sh
bash tests/appliance-contract.sh
```
