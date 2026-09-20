---
name: pr-labels
version: "1.2"
last_updated: "2026-09-19"
id: pr-labels
one_line_purpose: Enforce the canonical factory lifecycle, admission, and automation label contract.
entry_point: docs/skills/pr-labels.md
category: meta
status: active
tags: [labels, factory, triage, automation, workflow]
description: "Defines the repository lifecycle labels, 3-clanker-queue admission, 3-human-queue routing, and the lgtm approval flag. Use when managing labels or triage."
metadata:
  type: policy
  context7-sources: [/pre-commit/pre-commit]
---

# Pull Request Labels

> Workflows own state; humans provide intent. The factory standardizes
> lifecycle labels, admission and routing queues, and repository automation labels.

## When to Use

Load this when triaging issues/PRs, assigning factory workflow labels, or
inspecting queue admissions.

## When Not to Use

Do not load this for git commit conventions or branch preparation (`pr-workflow.md`).

## Factory Lifecycle and Queue Labels

The repository defines seven core lifecycle and queue labels:

| Label | Meaning |
|---|---|
| `1-triage` | New work awaiting human triage. |
| `2-discussing` | Work requiring discussion or a clarified design. |
| `3-clanker-queue` | Explicit agent admission: reconciled OMP slice, clear dependencies, single writer. Sole positive marker for automated issue pickup. |
| `3-human-queue` | Work admitted to the human-maintained queue; human routing only, never agent admission. |
| `4-review` | A pull request is awaiting review. |
| `blocked` | Progress halted on external dependency or missing infra. |
| `hold` | Work is intentionally paused. |

### Queue Admission (Stage 3)

Stage 3 branches work into two separate queues depending on execution authority:
- `3-clanker-queue`: Autonomous agent queue. Scoped for unattended or agent-assisted execution with clear boundaries, single writer, and a reconciled slice.
- `3-human-queue`: Human maintainer queue. Complex, design-heavy, or non-automatable work reserved for human contributors. Human routing only, never agent admission.

Never use obsolete stage-3 or stage-4 labels like `3-ready` or `4-working`.

### Review and Blocked States

- `4-review`: Code changes are complete and awaiting maintainer or automated review (replaces obsolete `5-review`).
- `blocked`: Progress is halted on external dependency or missing infra.
- `hold`: Work is intentionally paused by a maintainer. Agents must never remove a hold.
- Terminal resolution (done) is tracked directly through issue/PR closure or merge, not a `6-done` label.

## Automation and Merge Labels

This repository carries two automation labels:

| Label | Meaning |
|---|---|
| `lgtm` | Human approval flag permitting automated merge when CI passes. |
| `automerge` | Signals eligibility for automated merge on green CI when authorized. |

The obsolete `override` and `security-advisory` labels do not exist in this repository.

## Agent and Domain Labels

The repository also maintains domain qualification and agent assignment labels:
- **Agent labels** (`agent/*`): `agent/ci-maintainer`, `agent/quality`, `agent/architect`, `agent/security`, `agent/scanner`.
- **Domain & subsystem labels**: `ci`, `quality`, `testing`, `architecture`, `tech-debt`, `security`, `bug`, `dependencies`, `chore/deps`, `hive-protocol-change`, `needs-human`, and hosted Hive identifiers.

## Core Process

1. **Positive admission only**: `3-clanker-queue` is the sole positive marker
   for automated issue pickup. Absence of this label means ineligible for
   automated implementation. An open issue state, `3-human-queue`, `hive/*`,
   `agent/*`, priority signals, or appearance in search results never grant
   automated admission.
2. **Review state discipline**: Use `4-review` for pull requests awaiting review.
3. **Approval ownership**: Humans own intent and approval. Labels reflect state
   transitions, not speculative intentions. Apply `lgtm` only when human
   review criteria are satisfied. Maintainers, not agents, own `lgtm`.
4. **Hold and blocked discipline**: Agents never remove `hold` or `blocked`
   before the blocking condition is genuinely resolved.

## Red Flags

- Inventing repository-local label variants or using obsolete labels (`3-ready`,
  `4-working`, `5-review`, `6-done`, `override`, `security-advisory`).
- Treating open issue state or `3-human-queue` as automated admission.
- Removing Hive provenance labels (`hive/*`, `agent/*`) as an admission substitute.
- Relabelling issues to attract or shed Hive assignments.

## Verification

```bash
gh label list
```
