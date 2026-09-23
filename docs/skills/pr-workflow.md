---
name: pr-workflow
version: "1.13"
last_updated: 2026-09-23
id: pr-workflow
one_line_purpose: Prepare reviewable branches and pull requests for this repository.
entry_point: docs/skills/pr-workflow.md
category: meta
status: active
tags: [git, pullrequest, branches, validation]
description: "Defines branch, commit, push, and pull-request practice for Review + Luna Factory changes."
metadata:
  type: policy
  context7-sources: []
---

# Pull Request Workflow

## When to Use

Load this before preparing a branch, commit, or pull request for this repository. A target repository's own instructions take precedence when working elsewhere.

## Core Process

1. Read the issue and current `self-hosted` state. Preserve active work and use a dedicated feature branch/worktree; pull requests target `self-hosted`.
2. Make one coherent change per pull request. Use the issue's acceptance criteria to decide whether the change is complete or a partial checkpoint.
3. Run focused checks for each meaningful checkpoint. Commit and push validated progress to the active branch regularly; do not leave the only copy of valuable work in a local worktree. A push is not acceptance proof.
4. Use a Conventional Commit pull-request title and link the owning issue. Use a closing keyword only when the issue is complete; incomplete checkpoints use a non-closing reference and leave the issue open.
5. Update the affected tests, launcher, packaging, and user-facing documentation together. Report runtime checks that could not execute.
6. Do not merge or approve your own pull request. Reconcile exact-head checks and independent review before requesting an authorized owner decision.
7. Stage explicit paths and preserve unrelated working-tree changes. Never use `git add .` or `git add -A` when unrelated changes may be present.
8. Follow the repository's actual merge strategy; resolve conflicts hunk by hunk and rerun checks for the affected contract.

## CI and verification

Never include GitHub CI-skip directives in commit messages. Verify the artifact or runtime behavior when a workflow's green result alone does not prove it. Do not claim hosted checks, runtime execution, or publication from local static validation.

## Red Flags

- A pull request whose title or body overstates completion.
- A stale exact-head check presented as current evidence.
- Important changes committed but not pushed while work continues elsewhere.
- Self-merge or self-approval.
- `git add .` / `git add -A` with unrelated work in the tree.
- A test or documentation change that retains a deleted Contribute or Blueberry contract.

## Verification

```bash
bash tests/check-commit-message.sh
bash tests/just-onboarding.sh
bash tests/omp-review-mode.sh
bash tests/appliance-contract.sh
```
