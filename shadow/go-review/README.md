# Go Review shadow

This subtree is the contract laboratory for the maintainer-side Review shadow.
The package is pure Go: it validates and serializes `ReviewResult` values
without terminal, network, filesystem, or process dependencies.

## Baseline

The contemporary upstream baseline used for this port is
`projectbluefin/review` `main` at
`6748294e476cc7ba836771b92565f0b09082a33e`.

The contract sources at that baseline are:

- `image/tui/review_result.py`
- `tests/review_result_contract.py`

Both implementations consume
`testdata/review-result-cases.json`. Each case records the complete canonical
serialized result, including counts, findings, verification, provenance,
overlap, live data, and bounded raw evidence. The cases cover every result
state, state transitions, malformed optional fields, numeric and Unicode
boundaries, deep and trailing JSON, and round-trip preservation.

The shadow-owned Python runner imports `image/tui/review_result.py` only after
verifying its recorded Git blob against the baseline. The official
upstream-oriented contract test is not part of this experiment. Run the parity
checks with:

```bash
go test ./...
go test -fuzz=FuzzParseReviewResultBounded -fuzztime=1s
python3 parity.py
```

The fork-local required workflow is
`.github/workflows/shadow-go-review.yml`. Its third step runs `git diff --check`
after the Go and Python contract checks.

See `PARITY_REPORT.md` for the baseline, branch, command, fixture, fuzz, and
semantic-deviation evidence for this M1 checkpoint.
