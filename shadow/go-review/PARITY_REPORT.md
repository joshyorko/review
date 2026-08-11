# M1 ReviewResult parity report

This report records the completed M1 contract-lab evidence. The lab remains
pure parsing, validation, bounded evidence, state transitions, and
serialization; it does not include UI, network, process, mutation, launcher,
image, or live-adapter paths.

## Recorded baseline

- Upstream repository: `projectbluefin/review`
- Upstream baseline SHA: `6748294e476cc7ba836771b92565f0b09082a33e`
- Contract source: `image/tui/review_result.py`
- Contract test source: `tests/review_result_contract.py`
- Fork-owned parity runner: `shadow/go-review/parity.py`
- Shared canonical fixtures: `shadow/go-review/testdata/review-result-cases.json`

The Python runner imports the baseline implementation from the contract source
path. The official upstream-oriented contract test was not changed.

## Fork isolation

- Fork: `joshyorko/review`
- Tested fork SHA: `4a46284b738ec553bdba9bad5616a47ffe74835a`
- Working branch: `copilot/experiment-build-go-bubble-tea-cockpit`
- Preferred issue experiment line: `experiment/go-review-shadow`
- Branch deviation: the Copilot-managed branch name differs from the preferred
  experiment line; no replacement branch was created.
- The work is confined to fork PR [#14](https://github.com/joshyorko/review/pull/14).
  No upstream pull request was opened or prepared.
- Issue tracking uses `Progresses #13`; this M1 checkpoint does not close the
  multi-milestone experiment.

## Coverage counts

- Shared fixture cases: 31
- Valid fixture round-trip cases in the Python runner: 11
- Explicit boundary cases: 3 (deep, oversized, and trailing JSON)
- Clean-payload truncated prefixes: 98
- Go fuzz target: `FuzzParseReviewResultBounded`
- Go fuzz seed inputs: 8
- Bounded fuzz campaign: 52,467 executions, 120 new interesting inputs
- Raw evidence bounds: 400 lines and 120,000 Unicode characters

The Go parser copies maps before numeric normalization; the input immutability
test confirms that validation does not mutate caller-owned data. The shared
cases exercise counts, findings, verification, provenance, overlap, live data,
bounded raw evidence, malformed optional fields, numeric edges, Unicode line
splitting, deep and oversized JSON, trailing JSON, and preservation of
round-trip fields.

## Commands and results

The following commands were run at tested fork SHA
`4a46284b738ec553bdba9bad5616a47ffe74835a`.

```text
$ cd shadow/go-review && go test ./...
ok  github.com/joshyorko/review/shadow/go-review  (cached)

$ cd shadow/go-review && python3 parity.py
Python ReviewResult parity: 31 fixture cases, 11 round-trip cases, 3 boundary cases, and 98 truncated prefixes passed

$ cd shadow/go-review && go test -fuzz=FuzzParseReviewResultBounded -fuzztime=1s
PASS
ok  github.com/joshyorko/review/shadow/go-review  1.097s

$ python3 -m unittest tests/review_result_contract.py
Ran 20 tests
OK

$ git diff --check
exit 0; no output
```

## Fork workflow evidence

Required workflow: `.github/workflows/shadow-go-review.yml`

- Repository: `joshyorko/review`
- Run: [31547387907](https://github.com/joshyorko/review/actions/runs/31547387907)
- Head SHA: `4a46284b738ec553bdba9bad5616a47ffe74835a`
- Event: `workflow_dispatch`
- Conclusion: `success`
- Job: `contract` (`93962688047`)
- Required steps: Go contract, Python baseline parity, and `git diff --check`;
  each completed successfully.

## Semantic deviations

No validated-field deviations were observed across the standard JSON contract
cases and bounded property coverage.

The following boundary behaviors are recorded explicitly:

1. Python's standard-library decoder accepts non-standard `NaN` and infinity
   tokens by default; Go's `encoding/json` rejects them. These tokens are not
   standard JSON contract inputs.
2. Go and Python JSON encoders can choose different escaping or lexical
   spellings for equivalent JSON values. Parity compares the decoded canonical
   `ReviewResult` shape, and no field-value difference was observed.
3. The Go entry point also accepts `[]byte` payloads; the baseline entry point
   accepts text. String payloads produce the same validated shape.
