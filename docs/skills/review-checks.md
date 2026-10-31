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

OMP discovers the companion agent definitions in `image/extension/review/agents/`. The retained directory name is a packaging path; the shipped agent vocabulary is neutral:

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
5. Review tools and prompts consume live GitHub evidence.
6. Delete a specialist when its responsibility is fully duplicated by OMP or another agent; do not keep wrappers for compatibility.

`REVIEW_WRITABLE_ISOLATION=1` opts into the credentialless issue executor. It runs only when the root-owned image qualification artifact matches the selected runtime profile and packaged Bubblewrap/`prlimit` binaries; the current image has no such artifact, so writable Slay/Fix remains blocked before task dispatch. The executor gives the issue worker only bounded Review tools, derives mandatory checks from the captured base tree, and exposes no command-list argument for the worker. Check definitions must still match the captured base before checks and publication. Workspace writes enforce the aggregate byte and distinct-path limits before creating or truncating candidate files. Check output and an opaque private-workspace locator are retained with bounded durable evidence for post-restart inspection; interruption never resumes or replays a writable attempt. OS qualification does not qualify dependency readiness. Authenticated GitHub publication stays in the trusted controller. Draft creation is not PR-ready acceptance. Do not describe OMP's native isolated worktree as the security boundary or claim runtime qualification from unit tests or a blocked cloud smoke.

## Verification

```bash
bash tests/omp-review-mode.sh
bash tests/appliance-contract.sh
```
