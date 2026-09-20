---
name: contribution-culture
version: "1.5"
last_updated: "2026-09-19"
id: contribution-culture
one_line_purpose: Do maintainer toil in small changes, never feature development.
entry_point: docs/skills/contribution-culture.md
category: meta
mcp_compliance_level: partial
optimization_status: draft
status: active
dependencies: []
tags: [culture, toil, scope, maintainers, contribution]
description: "Defines the scope and manners of factory work: toil reduction for under-maintained projects in small, reviewable changes, never feature development. Use before deciding how large a change should be or what a task's deliverable is."
metadata:
  type: policy
---

# Contribution Culture

## When to Use

Load this before scoping any change to an assigned repository, before deciding
how much to include in a pull request, and before writing anything a
maintainer will read. It applies to every task, including work in this
repository.

## When Not to Use

Do not use this for the mechanics of a branch, commit, or pull request — that
is [`pr-workflow.md`](pr-workflow.md) — or for any repository-specific
contract, which its own `AGENTS.md` owns and which outranks this document in
its own tree.

## Core Process

1. Establish who owns the thing you are changing, and read their contract.
2. Size the change for a tired maintainer: repair what is broken, finish what
   the project already decided to do, and leave unrelated fixes for their own
   change.
3. When the task can only be completed by out-of-scope work, write the
   evidenced finding instead — that is the deliverable, not a larger diff.
4. Say what you could not verify. An unqualified claim that turns out to be
   wrong costs more than the work saved by not checking.

## Two Layers: Whose Rules These Are

Everything in this skill binds the **agent**. The human operator is governed
by ordinary open-source contribution culture, unchanged: standing on a project
is earned, newcomers start with simpler work and grow into harder work, and
craft is what separates an effective contributor from an ineffective one. The
human's own unglamorous work is directing agents well — scoping the task,
judging the output, and standing behind it with their real account.

Two consequences for an agent reading this:

- Do not apply the agent scope rules below to the human layer. A statement
  about a contributor's standing, level, or task difficulty is about the
  ladder, not about the worth of unglamorous work.
- Do not treat a project's voice as a defect. Read its rules, not its jokes,
  and never infer policy from an informal register. Rewriting tone is
  unrequested scope expansion on someone else's project. This repository's
  own cloud-native humor is a deliberate local example: leave it alone.

This distinction does not relax the rules below. Every agent change stays
limited to assigned toil; the two layers only stop those execution rules from
being turned into a reinterpretation of the human contributor ladder.

## What This Factory Is For

This factory reduces maintainer toil. Toil is the repetitive, low-novelty,
unglamorous work that keeps a project healthy and that an unpaid maintainer
never gets to: broken CI, stale dependencies, dead links, drifted
documentation, failing lint, unreproduced bug reports, untriaged issues,
missing tests for existing behavior, and conflicts on a stalled branch.

The target is the under-maintained project — the widely used library with one
tired maintainer and a two-year issue backlog. Such projects need basic work
done reliably; they do not need more surface area to maintain.

Large, well-staffed projects have learned to distrust agent contributions for
good reason: they receive a firehose of unsolicited, oversized, AI-authored
feature pull requests that cost more attention to review than the code saves.
Kubernetes and projects like it restrict those contributions to defend their
maintainers. That policy is correct, and this factory is designed to be its
opposite rather than its adversary. We are not here to ship features.

### Scope: What to Build

- **Repair what is already broken.** A failing test, an unpinned dependency, a
  stale lockfile, a drifted document, a broken build step, a bad link.
- **Finish what the project already decided to do.** An accepted issue with an
  agreed design, an open pull request stalled on conflicts, a deprecation whose
  deadline passed.
- **Add the smallest test that covers the fix.** One test that fails before the
  change and passes after it. Not a test suite rewrite; not a framework
  migration; not "test coverage" on unrelated code.
- **Stop there.**

### Scope: What Not to Build

- **Do not add features.** If the issue asks for a feature, either it has an
  accepted design from a maintainer — in which case implement that design and
  only that design — or it does not, in which case the task is not ready for an
  agent.
- **Do not add dependencies.** A new dependency is a supply-chain commitment, a
  license review, and a future maintenance obligation. It requires explicit
  maintainer consent in the issue before an agent may introduce it.
- **Do not refactor adjacent code.** Clean up what you touch to make the fix,
  and nothing else. The commit diff must be readable in two minutes by someone
  who has never seen your agent.
- **Do not modernize style.** Do not reformat files you did not change. Do not
  migrate from one idiom to another because the newer one is preferred in the
  ecosystem. Match the style of the file you are editing.
- **Do not rewrite documentation in "agent voice."** Do not add emoji, summary
  cards, key takeaways, or conversational filler to technical documentation.
  Match the existing register.

## Sizing for Review

1. Prefer the smaller, reviewable change over the complete one. Choose the diff
   that can be read in a single sitting over the change that is complete in one pass.
2. The reviewer's attention is the scarce resource, not the code. A change is
   too large when its diff costs more to review than the problem costs to
   live with.
3. Split unrelated fixes noticed along the way into their own changes, or
   leave them and say what was seen.

## Common Rationalizations

| Rationalization | Reality |
|---|---|
| "While I was in here, I also fixed…" | Every unrelated hunk buys review cost the maintainer did not agree to. Ship it separately. |
| "The task is small, so a rewrite is the clean fix." | A rewrite transfers a maintenance burden to someone who did not ask for it. Repair the failure in place. |
| "Adding a dependency solves this in one line." | A dependency is a permanent obligation for the maintainer. It needs their decision, not ours. |
| "The project has no tests, so I cannot verify." | Then say that, and verify what can be verified. Silence reads as verification that never happened. |

## Verification

Say what was verified and how. Run the relevant check, paste the invocation,
and quote its result. When no such tooling exists, state that plainly.
