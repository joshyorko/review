# PR94 cloud continuation

Source under review: `c5d0f1f4af662f5a922ddbb6653c41d32b20f624`.
Started from `df1e45edf44ef33ec65f3f54fdd5435e02c11b38` on
`fix/review-workbench-recovery` in `joshyorko/review`.
The remote branch and PR94 head matched before work and after the source push.
PR94 was confirmed open and draft through the connected GitHub app.

## Changes and integrated validation

The selected-PR paginator now requires a safe nonnegative changed-file count,
including on a terminal first page. Malformed path nodes cannot discard other
readable PRs or leak unvalidated file evidence. Tests cover partial GraphQL data,
identity/state/count/head/base changes, missing/repeated cursors, the thirty-page
bound, and a later-page workflow hitting the live workflow-permission guard.
The existing permission, ownership, incomplete-file, and exact-head tests remain
in the integrated suite.

The baseline suite failed two personal-policy diagnostic assertions because
pagination reports absent metadata earlier. Those assertions now check the exact
earlier refusal and still assert zero dispatched work. Happy-path GitHub fixtures
now include the count requested by the production query.

`bash tests/omp-review-mode.sh` passed on the integrated working tree, then again
in a clean detached Git checkout of the exact source commit: **855 passed,
4 skipped**, plus **43 Python contracts passed** and launcher parity passed.
This is cloud-local evidence for the integrated source. It does not certify the
installed appliance or the UI.

Supplemental cloud checks passed:

- Launcher diagnostic collector: 22 tests.
- Review package contract: 16 tests; release-version contract: 4 tests.
- Pinned OMP 18.13.3 SDK adapter/schema check: 5 tests plus TypeScript checking.
- Pin-updater, upgrade-qualification, and derived-pin tests.
- Commit-message, generated-skill, appliance/static pin, version, registry,
  onboarding, quickstart, Just parsing, and pre-commit configuration checks.
- Pinned OMP source clipboard regressions: 2 tests. The clean upstream checkout
  is tag `v18.13.3`, commit `413d278a87a69b453efabf8d1fedb9940385e8c6`.
- The two job-delivery cases skipped in the ordinary suite passed separately
  against that source, using the already-installed TypeScript 5.9.3 compiler.
  Node 26 strips types but cannot strip upstream parameter properties, so
  `transpile-omp.mjs` supplies compilation without changing upstream files.
  These are source-level tests, not native OMP execution.

Two derived native/provider canaries remain unrun. The ordinary suite still
reports four skips; supplemental passes do not rewrite that result.
Full pre-commit hook execution was not attempted because the hook environments
are absent and installing them is not authorized. Configuration validation and
the patch exclusion were checked locally; hosted hygiene remains a separate gate.

## Archived patch and failed CI

Historical validate run [40917473071](https://github.com/joshyorko/review/actions/runs/40917473071)
checked merge subject `a889b6294c2c1ef8455a9bb74ed91fbab07d3412` for starting
head `df1e45e`. Its log proves `trailing-whitespace` modified two unified-diff
context lines in the archived pagination patch. No later validation steps ran.
This was an observed source hygiene failure, not a zero-step billing failure.

The hook exclusion now covers patch artifacts under `docs/evidence/` as well as
`patches/omp/`. Source files remain checked. The archived patch was not reapplied
or normalized. `git apply --numstat` parses it, and its SHA-256 remains
`e60fc2bae91eaa1b1092e66e24a946103f5e6f32a1537e7dae26eebc6e2ffc33`.

## Source and test provenance

`source-manifest.json` records the commit, Git tree, source archive checksum,
and hashes of the implementation and tests. An immutable `git archive` was
extracted read-only at `/tmp/pr94-qualification-u84t03g1/source`. Separate fresh
HOMEs were prepared for 100×32 and 80×24; neither capture was started.

The archive-only full suite stopped at the repository-dependent Factory test
`converge command accepts only inspect and patch even though start also accepts
pr-ready`. A source archive lacks `.git`. That focused test and the complete
suite passed in the detached Git checkout at the same SHA. The failed archive
run is retained as failed evidence and is not an acceptance result.

`validation.json` lists commands, outcomes and log hashes. The `logs/` directory
contains gzip-compressed receipts, including the baseline/red runs and failed
archive-only run. No old isolated worker result was promoted to integrated proof.

## Product Design gates

**Overall Product Design sign-off remains BLOCKED/PENDING. There are no fresh
accepted screenshots in this continuation.** Removing the historical previews
from the PR body remains pending. Automatic approval review rejected the prepared
description update because it requires explicit approval of that description.
No PR-body update was applied. No protocol or source test substitutes for visual
inspection.

| Step | Required evidence | Current health |
| --- | --- | --- |
| 1 | Current foreground workbench at 100×32; actual VTE and child PTY measured before screenshots | BLOCKED: native OMP and capture prerequisites missing |
| 2 | Separate fresh-HOME 80×24 walkthrough with actual VTE and PTY measurements | BLOCKED: same prerequisites; WIP narrow captures rejected as acceptance |
| 3 | Human-language notices, numbered effective recovery, Details/Status, settings and same-PR retry | PENDING: fresh screenshot inspection required |
| 4 | Browser-open, refresh, Factory-unavailable and ambiguous-dashboard failures; unchanged drafts and working navigation | PENDING: current-source screenshots and interaction evidence required |
| 5 | Native TSP toast rendered and inspected | BLOCKED: no TSP-capable renderer |

The installed SDK CLI cannot start: `/usr/bin/env: bun: No such file or directory`.
Its package requires Bun `>=1.4.4`. Python GI reports GTK4 unavailable and no Vte
3.91 namespace. Apptainer and a TSP renderer are also absent. The preserved
capture scripts depend on these runtime/capture facilities. Nothing was installed
and no substitute terminal rendering was presented as genuine VTE evidence.
`visual-preflight.json` records the attempted commands and fresh HOME paths.

The resolved Details wording still needs visual review because historical frames
repeat the original outcome and recovery steps below a resolution line. Human
readability, clipping, accessibility, draft preservation and navigation are not
visually qualified by this report.

## Hosted checks and authority

Hosted runs are recorded in `hosted-checks.json` with their exact source subject
and last observed state. Billing restrictions were reported in the handoff;
source run `40923282332` did obtain a runner. Static hygiene, integrated source
checks, SDK compatibility and pinned-source regressions passed; the last
observed step was the running appliance build. Do not
classify unfinished or zero-step jobs as source failures, and do not promote
older title/dogfood successes to a newer head. No reruns were requested.

One integration writer made the changes. Two bounded read-only Luna helpers
reviewed pagination and evidence through the available agent interface because
native OMP could not start. No replacement implementation owner was created.
Their findings are recorded in `luna-review-notes.md`; these are static review
notes and do not grant Product Design or native-runtime acceptance.

The PR remains draft. No live Fix against Job Hunt, installed appliance change,
user desktop access, install, Ready transition, merge, release or deployment ran.
The remaining action is actual current-source visual qualification in a runtime
that already has the missing prerequisites, followed by the required Product
Design PASS and current-head hosted checks.
