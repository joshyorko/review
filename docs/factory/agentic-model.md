# Agentic Factory Feedback Loop

This document is the canonical local model for `contribute`. It defines how this
repository operates as an OMP contributor runtime for Hive. Read it after
`AGENTS.md` and before task-specific skills.

The repository ships one purpose-specific runtime:
1. The contributor runtime (`image/contribute/Containerfile` ->
   `ghcr.io/projectbluefin/contribute`, used as a registry location) packages Hive's worker and OMP. Both
   `hive-contribute` and `just contribute` launch it; OMP owns model and effort.

Local launchers run the OCI image through Podman's `krun` runtime. Each
invocation is a separate foreground KVM microVM with a unique container name;
the hub endpoint hash selects separate persistent OMP state.

Hive assignment authority remains separate:
Hive assigns contributor tasks, while OMP owns agent execution, model choice,
and tool boundaries.
The model is documentation: the launcher, image, tests, skills, and
user-facing instructions must describe the same roles and authority
boundaries. When source evidence changes the model, update this document and
the affected local contract together. Do not preserve superseded plans,
session logs, or design scratchpads as competing explanations.

## Roles and authority

| Term | Meaning | Authority |
|---|---|---|
| **Agentic Factory Feedback Loop** | The lifecycle that turns agent work and test feedback into reviewed open-source contributions. | The model for this repository. |
| **Toil** | Repetitive, low-novelty maintenance work an under-maintained project needs: broken CI, stale pins, drifted documentation, unreproduced reports, untriaged issues, stalled branches. | Toil is the work this factory exists to absorb. |
| **Contributor** | A contributor using the worker configuration to receive and complete Hive-assigned work. Specializes in the `clanker-queue`. Same team, different specialization. | Hive assigns work; the worker implements only its assigned scope. |
| **Maintainer/Reviewer** | A maintainer assessing an incoming pull request or issue. Active review process requiring human judgment and decision. | The human decides review, approval, and merge. |

Avoid classifying contributors by role; it is the loadout a contributor chooses to use that day.

## Two layers

The factory has a human layer and an agent layer, governed by different rules.
Conflating them is the most likely misreading of this model.

The **agent** does the unglamorous work: the toil defined above, in small,
evidenced, reviewable changes. They are humorously referred to as clankers as a joke on the absurdity of the world we live in.

The **human** does the "unglamorous work" of directing agents — scoping a task,
judging the output, and carrying the result to a maintainer. Their standing is
earned under ordinary open-source contribution culture, which AI did not
change; projects determine it, and Hive may use it when distributing work.
Nothing in this repository sets, scores, or automates it, and the
`human-queue` is out of scope here.

The important distinction in the culture is that the humans take pride in maintaining systems at the highest levels. If they are doing their jobs, they are invisible. We are designing this tool because the mental toll of that maintenance is hurting people. Amongst their peers there is a culture of respect and craftsmanship. The leaderboards/contribution graphs are supposed to be a friendly way to remind maintainers that their work is recognized by their peers. This is one of the highest honors a maintainer can receive. Silent professionals.

Do not reconcile the two layers by applying agent scope rules to the human, or
by reading the human ladder as a statement about agent output.

## Scope of work

This is a toil-reduction factory for under-maintained open-source projects,
not a feature factory. Factory Workers repair what is already broken and
finish what a project already decided to do; they do not add features,
dependencies, configuration surfaces, or architecture.

Well-staffed projects restrict large agent-authored pull requests because
those consume more maintainer attention than they return. That reasoning is
the model here too: the reviewer's attention is the scarce resource, so a
change is sized to be reviewable rather than to be complete in one pass. When
an assigned task can only be finished by out-of-scope work, the deliverable is
an evidenced written finding. That is completed work, not a declined
assignment; Hive's authority over what gets worked on is unchanged.

[`docs/skills/contribution-culture.md`](../skills/contribution-culture.md)
carries the operational form of this section.

## Repository boundary

`contribute` ships the contributor image, credential handoff, and contributor runtime.

OMP owns agent execution, sessions, tasks, and tool boundaries.

Hive owns the contributor WebSocket protocol, task selection, assignment prompt
injection, the `contributor` tmux session, and output capture. The launcher
must not decline, retry, or otherwise manage assignments mid-protocol. Hive also
owns contributor completion.

The `contribute` image defines one narrow contributor experience: it always
launches OMP and rejects every other `AGENT_BACKEND` value before Hive starts.
Its closure contains only the tools required by OMP and Hive's interactive
relay. The generic upstream helper files needed by that relay are implementation
dependencies, not alternate agent surfaces. No dashboard, scheduler, Codex,
Pi, or provider state belongs in the image.

The base image owns the contributor toolchain. `contribute` consumes the
tools the image ships and does not reimplement them: a missing utility is
fixed at the base image seam, and a shim is removed the moment that fix lands. A
local reimplementation is not a neutral stopgap — it shadows the real tool on
`PATH` and silently substitutes its own semantics for the ones every caller
assumes.

## Documentation discipline

Keep the model executable and compact:

1. Treat local code and tests as evidence for implementation behavior.
2. Treat `AGENTS.md`, this document, and the matching skill as the
   agent-facing contract.
3. Record durable operational knowledge in `docs/skills/` and generate
   `docs/skills/index.json` from skill frontmatter.
4. Delete stale changelogs, session notes, plans, design scratchpads, and
   append-only status documents. They are historical noise, not the model.

## Verification

For factory model, skills, and image contract changes, run the core contract checks:

```bash
pre-commit run --all-files
git diff --check
just --list
bash scripts/check-skill-frontmatter.sh
bash tests/launcher-contract.sh
bash tests/contribute-contract.sh
```
