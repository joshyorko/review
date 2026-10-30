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
| A package build, repository metadata, source registration, or distribution-specific patch | The component that creates the artifact or package selection; separate Review-owned setup from installer/repository tooling and package maintainers |
| Hosted runner image, kernel, AppArmor profile, or architecture capability | The owner of the runner/image configuration, after separating it from package behavior |
| Bluefin image-owned configuration or integration | The Bluefin repository/component whose source owns that behavior; do not route there just because investigation ran on Bluefin |

For Apptainer, inspect the current workflow and distinguish the CLI/source
project, package/PPA artifact, repository metadata and architecture filter,
installer action, and hosted runner's kernel/security profile. Compare the
selected package identity with the package files and runner capabilities: a
correct artifact may be skipped by repository metadata, and a missing profile
on one runner does not by itself prove an Apptainer defect. Likewise, a machine
running Bluefin does not make Bluefin the owner unless the failed behavior is
in a Bluefin-owned image or integration.
For OMP, report sparingly: first establish a minimal failure against Review's
exact pinned OMP source without Review's compatibility patches or integration,
then compare the current OMP issue, PR, and release state. A Review patch or
SDK drift remains Review-owned. OMP is not categorically excluded when its own
contract is demonstrably broken.

## Establish and report the finding

1. Read the current source of the pin and its use, including the appliance
   `Containerfile`, relevant workflow, updater, and contract test as applicable.
   Reproduce the smallest failure using the actual pinned artifact/source in a
   clean isolated environment at the failing layer. Retain the command or
   fixture. A second platform can strengthen the result but is not required.
   For actions, package builds, hosted runners, or hardware/security
   capabilities, isolate that exact layer. Mark attribution **unconfirmed** if
   the pinned artifact or owner cannot be established.
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
4. Report only after both the defect and owner are confirmed; otherwise return
   the unconfirmed finding and the next investigation. Prepare the smallest
   maintainer-readable report with observations and reproduction, not a
   required design. Mention Review only for concrete consumer impact, with a
   commit permalink to its test or integration. For a confirmed defect with a
   feasible in-scope fix, prepare a narrow upstream patch and regression test
   that fails before and passes after the fix. Run the target's required checks
   and record any omissions. Leave prioritization to maintainers.
5. If Review is affected, search for and update one deduplicated downstream
   tracking record. Keep its owner attribution, upstream issue/PR links, exact
   fix commit or release, Review pin change, and evidence from qualification of
   the newly consumed artifact together. Track local workaround owner and
   removal condition separately. Keep the record open until Review consumes
   and qualifies the fix, or a verified local fix/no-defect reclassification
   resolves the failure; upstream rejection alone does not resolve it. Follow
   up on new evidence, maintainer questions, release, qualification, or
   disproven attribution, not on a timer.

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

An explicit task or report-skill invocation that requests a report or focused
PR to a named repository authorizes that scoped write; do not ask again when
authorization already covers it. Loading this skill or asking only for
diagnosis does not authorize a write. Submit when the scoped authorization is
present; otherwise return the finished report or patch as a draft. Follow any
tool approval. Read the target's security policy first; never publish
credentials, private data, or vulnerability details through a public issue.
Do not assign, label, milestone, merge, or approve on behalf of upstream
maintainers.

Keep the status explicit: **unconfirmed**, **Review-owned**, **reported**,
**patch proposed**, **merged**, **released**, **consumed-and-qualified**, or
**not upstream**. When a temporary local workaround exists, name its owner,
tests, and removal condition. Do not silently make a permanent compatibility
fork or call a merged upstream change fixed downstream.

## Final handoff

State the owner and attribution; upstream issue/PR or why the finished draft
was not sent; the single downstream tracking record; tests and results; the
current report/fix/consumption state; and the next gate, usually a pin update
and qualification of the consumed artifact.

## Verification

For this skill and its router/catalog entry:

```bash
bash scripts/check-skill-frontmatter.sh
bash tests/generate-skills.sh
bash tests/test-registry.sh
git diff --check
```
