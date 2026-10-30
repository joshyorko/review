# ClawPatch discovery and evidence handling

Read this reference only when the operator explicitly requests repository
discovery with ClawPatch or continuation of an existing ClawPatch run. A
supplied finding or failure uses the direct path in
[`../upstream-dependency-reporting.md`](../upstream-dependency-reporting.md);
do not start a full scan for it. ClawPatch remains external tooling: do not add
it to the Review image, CI, or runtime, and do not install or configure it
without task-specific authorization. Findings are leads, not proof of an
upstream defect.

For appliance pins and package selection, load the `image-build` skill; for
runtime boundaries, load `launcher`. Use the reporting skill for attribution,
authorization, and upstream follow-through.

## Establish the run boundary

1. Read `AGENTS.md`, the applicable Review skill, and the exact pinned
   dependency/workflow/image source. Record the requested source revision and
   working-tree state. Locate existing ClawPatch state, reports, finding IDs,
   patch attempts, and submissions before initializing anything. Preserve
   existing state; initialize only when state is absent and required.
2. Discover the selected executable with `clawpatch --version` and
   `clawpatch --help`; inspect the relevant subcommand help and current provider
   documentation. Use `doctor` only if the installed CLI supports it. Do not
   copy a command, flag, version-specific limit, or feature claim from another
   repository without checking the installed executable. If ClawPatch or its
   configured provider is unavailable, report discovery as **NOT RUN**. An
   authorized alternative inspection is supplemental, not a ClawPatch run or
   evidence that the repository has no defects.
3. Keep the same selected repository root, native state, and configuration
   across operations. Use ClawPatch's native records as canonical; preserve
   source SHA, resolved executable path/version and package/source identity
   (binary digest when available), run/finding/patch-attempt IDs, provider
   configuration identity, and linked evidence. Keep raw/private evidence and
   bulky run artifacts outside the product checkout when practical. Do not
   build a second findings database or rewrite old results as if they covered
   a newer source revision.

## Run only the requested scope

Use installed help to find the current native operations. The following are
operation names to check, not a guaranteed CLI contract:

| Purpose | Possible native operation |
| --- | --- |
| Initialize absent state or inspect scope | `init`, `map`, `status --json` |
| Review requested slices/modes | `review` |
| Export and inspect all findings | unfiltered `report --json`, `show --finding <id>` |
| Continue one lead | `next`, `show --finding <id>` |
| Record a decision or verify a patch | `triage`, `fix --finding <id>`, `revalidate --finding <id>` |
| Open an authorized patch PR | `open-pr --patch <id>` |

The selected executable during authoring reports ClawPatch 0.7.2; its help has
no native `repro` command. Reproduce a finding directly from its native detail
and the exact pinned artifact/source. Recheck installed help on every run; do
not invent or assume a command. Never use `init --force` to replace existing
native state.

Complete the requested review modes and slices or report each unfinished,
failed, or omitted portion. Do not rerun batches until a desired finding count
appears. A mapping is not a review; a clean completed scope with zero newly
verified defects is a valid result.

For every review, inspect the prompt/context manifest and file/character
budgets. A reviewed prefix does not cover an omitted file tail: inspect
relevant omitted ranges separately, label that inspection **supplemental**,
and do not attribute it to ClawPatch's reviewed slice. Avoid dumping large
files or confidential data into logs or handoffs.

## Verify the worker boundary and patch evidence

Loading this skill in the coordinator does not prove a ClawPatch worker
received it. When that matters, inspect the installed provider's actual
arguments, working directory, prompt construction, and supported context
transport. Inspect a prompt file, manifest, or request capture only when the
selected version supports it; record what was and was not observed. A captured
guidance file proves text was supplied, not automatic inheritance of a skill
catalog. Check the effective test commands at feature and global levels;
repo-specific test setup or overrides may differ from a generic detected
command.

Treat native `fixed`, `revalidated`, or patch-applied state as tool state, not
as a test result. Inspect the patch and validate it independently using the
target repository's authorized execution path. A read-only worker lock error,
missing runtime, or unsupported test command is a tool/execution boundary
unless separate evidence proves a product defect. Preserve the check as
failed, unknown, or not run; do not weaken provider security to obtain a green
status.

## Triage, report, and continue

Inspect the complete unfiltered finding and patch inventory, not only one
`next` result or a severity-filtered summary. Preserve original IDs when
multiple findings are grouped, and group only when reproduction proves a
shared root cause. Keep raw report count, confirmed unique causes, false
positives, unresolved leads, optional improvements, and patch attempts
separate. Record requested/completed modes, failed slices, dropped findings,
omitted ranges, and missing worker context. Never convert an unknown count or
coverage gap to zero.

For each actionable finding, apply
[`../upstream-dependency-reporting.md`](../upstream-dependency-reporting.md):
prove the owning layer against the exact pinned artifact, search current
upstream issues/PRs/releases, and prepare or submit only the scoped report or
patch that the task authorizes. A ClawPatch finding does not authorize an
upstream write. Do not report a runner, package-selection, AppArmor, installer,
or OMP issue to the visible software project's repository until direct
evidence isolates that layer and owner. Keep one downstream tracking record
and distinguish proposed, patched, merged, released, and consumed-and-qualified
states.

When continuing, compare the requested source revision with the run's source
revision and validate the requested revision, not stale source. Reuse existing
issues and reports; add only meaningful new evidence. Upstream merge/release,
ClawPatch `fixed` state, and Review resolution are separate facts. A Review
dependency fix is consumed only when the corrected pinned artifact passes
Review's relevant qualification. Never post timer-driven reminders.

## Handoff

State the requested source and ClawPatch tool/run identities; requested and
completed scope, failures, and coverage gaps; counts for raw findings, unique
confirmed causes, false positives, unresolved leads, and patches; original
IDs and owner attribution; issue/PR or draft state; independent validation
results; and the next downstream gate. Say **NOT RUN** when ClawPatch did not
run. Do not claim comprehensive absence of defects from one successful pass.

For command behavior, consult the installed CLI help first, then the current
ClawPatch [review](https://github.com/openclaw/clawpatch/blob/main/docs/code-review.md),
[configuration](https://github.com/openclaw/clawpatch/blob/main/docs/configuration.md),
and [provider](https://github.com/openclaw/clawpatch/blob/main/docs/providers.md)
documentation. Verify docs against the executable selected for this run.

## Offline behavior checks

Use [`upstream-clawpatch-discovery-scenarios.json`](upstream-clawpatch-discovery-scenarios.json)
as synthetic input for a fresh evaluator that reads this reference and the
linked reporting skill. Present each request and snapshot without its expected
checks; do not run ClawPatch, tests, network calls, or GitHub writes during the
scenario evaluation. Inspect actual owner, scope, state, and next-gate choices.
The fixture checks reasoning only; it does not prove native tooling or provider
behavior.
