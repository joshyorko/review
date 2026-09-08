---
name: pr-labels
version: "1.0"
last_updated: 2026-09-06
id: pr-labels
one_line_purpose: Enforce the canonical factory seven-label and automation label contract.
entry_point: docs/skills/pr-labels.md
category: meta
status: active
tags: [labels, factory, triage, automation, workflow]
description: "Defines projectbluefin's canonical seven-label workflow contract and repository automation labels (lgtm, override, security-advisory). Use when managing labels or triage."
metadata:
  type: policy
  context7-sources: [/pre-commit/pre-commit]
---

# Pull Request Labels

> Workflows own state; humans provide intent. Project Bluefin standardizes seven
> lifecycle labels and three repository automation labels.

## When to Use

Load this when triaging issues/PRs, assigning factory workflow labels, or
applying automation overrides.

## When Not to Use

Do not load this for git commit conventions or branch preparation (`pr-workflow.md`).

## The Seven Factory Labels

| Label | Meaning |
|---|---|
| `1-triage` | New work awaiting human triage. |
| `2-discussing` | Work requiring discussion or a clarified design. |
| `3-ready` | Triaged and ready for contributor/agent pickup. |
| `4-working` | Actively being worked on by an agent or contributor. |
| `5-review` | Code changes complete and under review. |
| `6-done` | Work finished, merged, or resolved. |
| `blocked` | Progress halted on external dependency or missing infra. |

## Automation Labels

This repository carries three automation labels:

| Label | Meaning |
|---|---|
| `lgtm` | Human approval flag permitting automated merge when CI passes. |
| `override` | Bypasses non-blocking lint/doc checks when authorized. |
| `security-advisory` | Routes high-priority security patches to rapid merge lanes. |

## Core Process

1. Agents never self-assign `3-ready` or manipulate labels to cherry-pick
   tasks. Hive is the sole assignment authority.
2. Label changes reflect verified state transitions, not speculative intentions.
3. Apply `lgtm` only when human review criteria are satisfied.

## Red Flags

- Inventing repository-local label variants that break org standardization.
- Relabelling issues to attract or shed Hive assignments.
- Removing `blocked` before the blocking condition is genuinely resolved.

## Verification

```bash
gh label list --repo projectbluefin/review
```
