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
`testdata/review-result-cases.json`. The shared cases cover every result state,
the clean decision predicate, state transitions, malformed nested evidence,
inconsistent counts, provenance validation, and malformed JSON. Run the
fixture parity checks with:

```bash
go test ./...
python3 ../../tests/review_result_contract.py
```
