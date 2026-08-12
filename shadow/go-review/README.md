# Go Review shadow

This subtree is the M1 contract laboratory for the maintainer-side Review
shadow. The current checkpoint is **M1 complete**: ReviewResult,
EvidenceManifest, exact-head revalidation, and ActionPlan parity.
The package is pure Go: it validates and serializes domain values without
terminal, network, filesystem, or process dependencies.

## M1 baseline

The recorded upstream baseline used for this port is
`projectbluefin/review` `main` at
`6748294e476cc7ba836771b92565f0b09082a33e`.

The contract sources at that baseline are:

- `image/tui/review_result.py`
- `tests/review_result_contract.py`
- `image/tui/review_evidence_manifest.py`
- `tests/review_evidence_manifest_contract.py`
- `image/tui/action_plan.py`
- `tests/action_plan_contract.py`

The implementations consume shared fixtures under `testdata/`. ReviewResult
cases record the complete canonical serialized result, including counts,
findings, verification, provenance, overlap, live data, and bounded raw
evidence. EvidenceManifest cases cover trust redaction and scope-bound
handles. ActionPlan cases cover canonical intent, exact-head revalidation, and
identity preservation. The parity runner adds malformed optional-field,
numeric, Unicode, deep, trailing-JSON, and round-trip checks.

The shadow-owned Python runner imports `image/tui/review_result.py` only after
verifying its recorded Git blob against the baseline. The official
upstream-oriented contract test is not part of this experiment. Run the parity
checks with:

```bash
go test ./...
for target in \
  FuzzParseReviewResultBounded \
  FuzzTruncatedCleanPayloadNeverBecomesClean \
  FuzzEvidenceManifestValidationDoesNotPanic \
  FuzzActionPlanValidationDoesNotPanic
do
  go test -fuzz="$target" -fuzztime=1s
done
python3 parity.py
```

The fork-local required workflow is
`.github/workflows/shadow-go-review.yml`. Its third step runs `git diff --check`
after the Go and Python contract checks.

See `PARITY_REPORT.md` for the exact-head M1 baseline, branch, command,
fixture, fuzz, and semantic-deviation evidence. The contemporary rebaseline
required before M2 is gated on upstream PR #192; no cockpit or live adapter
path belongs in this checkpoint.
