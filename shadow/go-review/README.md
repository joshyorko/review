# Go Review shadow

This subtree is the fork-local M1–M5 contract laboratory for the
maintainer-side Review shadow. It contains the ReviewResult parity lab, a
fixture-driven Bubble Tea cockpit model, bounded read-only runtime adapter
contracts, dry-run safeguards, and read-only MCP tools.

The package has no terminal program, network listener, filesystem adapter,
subprocess, Hive, launcher, image, or mutation path. GitHub and Codex are
injected read-only interfaces with deterministic fakes; the MCP contract is
tested over the SDK's in-memory transport.

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
EvidenceManifest, exact-head revalidation, and ActionPlan identity. Go tests
cover the M2 cockpit controls, M3 bounds/provenance/fakes, M4 dry-run
confirmation gate, and M5 MCP tool surface.

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

The fork experiment remains isolated on its Copilot-managed branch and does
not open or prepare an upstream PR. Runtime adapters expose only injected
read-only contracts; no credential, network, process, Hive, or mutation
implementation is claimed by this lab.
