---
name: upstream-dependency-reporting
version: "1.0"
last_updated: "2026-10-30"
id: upstream-dependency-reporting
one_line_purpose: Report confirmed Review dependency defects with evidence and follow-through.
entry_point: docs/skills/upstream-dependency-reporting.md
category: ci-ops
status: active
tags: [upstream, dependency, reproducibility, reporting, follow-up]
description: "Use when a Review build, hosted action, packaged dependency, or runtime exposes a suspected third-party defect, or when an existing upstream report affecting Review needs follow-up."
metadata:
  type: procedure
  context7-sources: []
---

# Upstream Dependency Reporting

## When to use

Load this skill when a specific Review test, build, release qualification, or
runtime exposes a suspected dependency defect; before reporting or patching it
upstream; or when a relevant upstream report changes state. Investigate the
assigned finding only. This skill does not start a dependency audit, add an
automation service, or grant GitHub write access.

Do not use it for a Review-owned pin, patch, launcher, image, or integration
defect. Fix those here. Normal Review does not send reports to Hive Commons or
make Hive calls; consult [`hive-read-side.md`](hive-read-side.md) only for an
explicitly selected Hive integration issue.

## Identify the owner

Read the exact pin and the code that installs, invokes, or packages it. Route
the behavior to the project that owns the failing layer, not the first project
visible in the stack trace.

| Evidence points to | First owner to investigate |
| --- | --- |
| Review code, patch, pin, workflow wiring, or launcher integration | `joshyorko/review` |
| Software behavior that reproduces directly at the pinned source/release | That software's upstream repository, such as OMP, RTK, or GitHub CLI |
| An action's own install/setup behavior | The action repository; separate it from the tool or package it installs. Review's dogfood workflow currently pins `eWaterCycle/setup-apptainer`; its release workflow installs from `apptainer/ppa` instead. |
| A package build, repository, PPA, or distribution-specific patch | The package/distribution maintainer, not automatically the software project |
| Hosted runner image, kernel, AppArmor profile, or architecture capability | The owner of the runner/image configuration, after separating it from package behavior |
| Bluefin image-owned configuration or integration | The Bluefin repository/component whose source owns that behavior; do not route there just because investigation ran on Bluefin |

For Apptainer, inspect the current workflow and distinguish the CLI/source
project, selected package or PPA, installer action, and hosted runner's
kernel/security profile. A missing profile on one runner does not by itself
prove an Apptainer defect. Likewise, a machine running Bluefin does not make
Bluefin the owner unless the failed behavior is in a Bluefin-owned image or
integration.
For OMP, report sparingly: first establish a minimal failure against Review's
exact pinned OMP source without Review's compatibility patches or integration,
then compare the current OMP issue, PR, and release state. A Review patch or
SDK drift remains Review-owned. OMP is not categorically excluded when its own
contract is demonstrably broken.

## Establish and report the finding

1. Read the current source of the pin and its use, including the appliance
   `Containerfile`, relevant workflow, updater, and contract test as applicable.
   Reproduce the smallest failing case at the exact dependency pin. Run the
   dependency directly outside Review where possible; retain the command or
   fixture and say when an independent reproduction was not possible. For
   actions, package builds, hosted runners, or hardware/security capabilities,
   test the specific layer that failed. Mark attribution **unconfirmed** while
   the evidence cannot isolate an owner.
2. Record the Review commit, dependency version and source commit or immutable
   action ref, artifact digest when available, OS/distribution, architecture,
   and runtime boundary that materially affects the result. Capture expected
   and actual behavior, sanitized output, exit status, and probe time in UTC.
   Cite source with commit permalinks and line anchors. Never invent a probe,
   timestamp, digest, or result.
3. Use `ghx` for GitHub reads. Search the exact owner's current open and closed
   issues, pull requests, releases, docs, and contribution/security policy for
   the same symptom and affected version. Link a matching report and add only
   new evidence when useful; do not open a duplicate. Verify the current base
   branch, templates, disclosure route, and contribution requirements before
   preparing a patch.
4. Prepare the smallest maintainer-readable report. State observations and
   reproduction, not a required design. Mention Review only for concrete
   consumer impact, with a commit permalink to its test or integration. If a
   real upstream fix is clear and in scope, prepare a narrow upstream patch
   with an upstream-owned regression test; leave prioritization to maintainers.
5. Keep a downstream record when the defect affects Review. Distinguish the
   local workaround and its removal condition, a proposed upstream patch,
   merge, release, and **consumed-and-qualified** state. An upstream merge or
   release alone is not proof that Review consumes the fix. Follow up on new
   evidence, maintainer questions, release, downstream qualification, or a
   disproven attribution; do not post timer-driven nudges.

### Report shape

```markdown
## Observed and expected behavior
## Minimal reproduction
## Environment and pinned inputs
- Review commit:
- Dependency/action/package version, source ref, and digest:
- OS/distribution, architecture, and relevant runtime boundary:
- Probe time (UTC):
## Evidence
<Sanitized output, exit status, and immutable source links>
## Attribution
<What reproduced directly; what remains unverified; why this owner is responsible>
## Review impact
<Only when useful: affected behavior and commit permalink>
```

## Write and follow-through boundary

Preparing a diagnosis or draft does not authorize an external write. Before
creating or commenting on an upstream issue, PR, or local tracking issue,
confirm that the current task authorizes that specific repository and
operation, and follow any tool approval. Without it, leave a complete draft.
Read the target's security policy first; never publish credentials, private
data, or vulnerability details through a public issue. Do not assign, label,
milestone, merge, or approve on behalf of upstream maintainers.

Keep the status explicit: **unconfirmed**, **Review-owned**, **reported**,
**patch proposed**, **merged**, **released**, **consumed-and-qualified**, or
**not upstream**. When a temporary local workaround exists, name its owner,
tests, and removal condition. Do not silently make a permanent compatibility
fork or call a merged upstream change fixed downstream.

## Verification

For this skill and its router/catalog entry:

```bash
bash scripts/check-skill-frontmatter.sh
bash tests/generate-skills.sh
bash tests/test-registry.sh
git diff --check
```
