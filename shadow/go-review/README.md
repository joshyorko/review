# Go ReviewResult shadow

This subtree is the fork-local M1 contract lab for the maintainer-side
`ReviewResult` value. It contains pure Go parsing, fail-closed validation,
bounded evidence handling, state transitions, canonical serialization, shared
fixtures, and parity checks against the recorded Python baseline.

The package has no terminal program, UI, network listener, filesystem adapter,
subprocess, GitHub or Codex client, Hive integration, launcher, image, MCP
surface, or mutation path.

## Recorded baseline

The recorded upstream baseline is
`projectbluefin/review` `main` at
`6748294e476cc7ba836771b92565f0b09082a33e`.

The contract implementation source is:

- `image/tui/review_result.py`

The corresponding upstream contract test is:

- `tests/review_result_contract.py`

`parity.py` verifies the recorded Git blobs before importing only the baseline
implementation. It does not modify or import the official upstream-oriented
test suite. The shared fixtures compare the complete validated `ReviewResult`
serialization, including counts, findings, verification, provenance, overlap,
live data, raw evidence, state, and version.

## Commands

From this directory:

```bash
go test ./...
python3 parity.py
go test -fuzz=FuzzParseReviewResultBounded -fuzztime=1s
go test -fuzz=FuzzTruncatedCleanPayloadNeverBecomesClean -fuzztime=1s
```

The fork-local required workflow is
`.github/workflows/shadow-go-review.yml`; it runs the Go suite, Python
baseline parity, bounded fuzz targets, and `git diff --check`.
`PARITY_REPORT.md` records the exact baseline and fork evidence.
