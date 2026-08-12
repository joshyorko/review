# Go Review shadow

This subtree is the private M1 contract laboratory for the maintainer-side
Review shadow. The current PR checkpoint is **M1-A / ReviewResult parity**.
The package is pure Go: it validates, bounds, and serializes contract values
without terminal, network, filesystem, subprocess, mutation, launcher, image,
or live-adapter paths.

## Recorded baseline

The recorded upstream baseline is
`projectbluefin/review` `main` at
`6748294e476cc7ba836771b92565f0b09082a33e`.

The implementation sources are:

- `image/tui/review_result.py`
- `image/tui/review_evidence_manifest.py`
- `image/tui/action_plan.py`

The corresponding upstream contract tests are:

- `tests/review_result_contract.py`
- `tests/review_evidence_manifest_contract.py`
- `tests/action_plan_contract.py`

`parity.py` verifies the recorded Git blobs before importing only the
implementation modules. It does not modify or import the official
upstream-oriented test suites. Shared fixtures compare the complete validated
ReviewResult serialization, and the M1 extension fixtures cover
EvidenceManifest, exact-head revalidation, and ActionPlan identity.

## Commands

From this directory:

```bash
go test ./...
python3 parity.py
for target in \
  FuzzParseReviewResultBounded \
  FuzzTruncatedCleanPayloadNeverBecomesClean \
  FuzzEvidenceManifestValidationDoesNotPanic \
  FuzzActionPlanValidationDoesNotPanic
do
  go test -fuzz="$target" -fuzztime=1s
done
```

The fork-local required workflow is
`.github/workflows/shadow-go-review.yml`; it also runs `git diff --check`.
`PARITY_REPORT.md` records the exact tested fork head, fixture and fuzz
counts, command results, baseline source hashes, and semantic deviations.

The contemporary upstream rebaseline required before the M2 cockpit gate is
blocked until upstream PR #192 lands. No UI, hosted/local Hive, Codex access,
GitHub access, or mutation path is part of this checkpoint.
