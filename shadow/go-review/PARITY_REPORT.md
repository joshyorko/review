# M1 ReviewResult shadow contract report

This report records the fork-local M1 `ReviewResult` contract-lab checkpoint.
The lab covers pure parsing, fail-closed validation, bounded raw evidence,
state transitions, and canonical serialization. It contains no UI, network,
process, filesystem, GitHub, Codex, MCP, Hive, launcher, image, credential, or
mutation path.

## Baseline and sources

- Upstream repository: `projectbluefin/review`
- Recorded upstream baseline:
  `6748294e476cc7ba836771b92565f0b09082a33e`
- Baseline implementation source:
  - `image/tui/review_result.py`
    - blob `fe5574a3b6a6d14bedc37febc8d68a27cbc50b86`
- Baseline contract test, verified but not imported:
  - `tests/review_result_contract.py`
    - blob `c0b7247fab31c2ff8c6010976b64befce64c224b`
- Fork-owned parity runner: `shadow/go-review/parity.py`
- Shared `ReviewResult` fixtures:
  `shadow/go-review/testdata/review-result-cases.json`
- Go implementation and tests:
  - `shadow/go-review/review_result.go`
  - `shadow/go-review/review_result_test.go`
  - `shadow/go-review/canonical_json.go`

The runner verifies the recorded implementation and test blobs before importing
only the baseline implementation. It compares complete serialized results:
version, counts, findings, verification, provenance, overlap, live data, raw
evidence, and state. The official upstream-oriented Python test remains
unchanged.

## Fork isolation and provenance

- Fork: `joshyorko/review`
- Tested fork SHA:
  `c0d7c99a69f522c6feb597edc8145d16d09df4c1`
- Working branch:
  `copilot/experiment-build-go-bubble-tea-cockpit`
- Preferred issue experiment line: `experiment/go-review-shadow`
- Branch deviation: the Copilot-managed head branch differs from the preferred
  experiment line; no replacement branch was created.
- Work location: fork PR #14 only; no upstream PR was opened or prepared.
- Issue relation: `Progresses #13`; this checkpoint does not close the
  multi-milestone experiment.
- The implementation remains limited to the fork-local M1 contract lab.

## Coverage

- Shared `ReviewResult` fixtures: 31
- Full serialization round trips: 11
- Deep, oversized, and trailing-JSON boundary cases: 3
- Truncated clean-payload prefixes: 98
- Numeric edge cases: 6
- Unicode line-boundary cases: 11
- Malformed optional-field cases: 7
- Go fuzz seeds:
  - `FuzzParseReviewResultBounded`: 8
  - `FuzzTruncatedCleanPayloadNeverBecomesClean`: 4
- Fuzz properties: parser panic resistance, bounded raw evidence, clean-result
  serialization round trips, and the invariant that malformed or truncated
  input never becomes clean.
- Bounds: 400 raw-evidence lines and 120,000 Unicode characters.

## Commands and results at the tested fork SHA

```text
$ cd shadow/go-review && go test ./...
ok  	github.com/joshyorko/review/shadow/go-review	0.012s

$ cd shadow/go-review && python3 parity.py
Python ReviewResult parity: baseline 6748294e476cc7ba836771b92565f0b09082a33e, 31 fixture cases, 11 round-trip cases, 3 boundary cases, 98 truncated prefixes, 6 numeric edge cases, 11 Unicode line boundaries, and 7 malformed optional cases passed

$ cd shadow/go-review && go test -fuzz=FuzzParseReviewResultBounded -fuzztime=1s
fuzz: elapsed: 2s, execs: 38242 (19097/sec), new interesting: 98 (total: 113)
PASS
ok  	github.com/joshyorko/review/shadow/go-review	2.023s

$ cd shadow/go-review && go test -fuzz=FuzzTruncatedCleanPayloadNeverBecomesClean -fuzztime=1s
fuzz: elapsed: 1s, execs: 46793 (44552/sec), new interesting: 0 (total: 18)
PASS
ok  	github.com/joshyorko/review/shadow/go-review	1.071s

$ git diff --check
exit 0; no output
```

The listed fuzz output includes the bounded one-second campaigns run at the
tested fork SHA; the hosted workflow repeats the same commands.

## Fork workflow evidence

Required workflow: `.github/workflows/shadow-go-review.yml`

The workflow runs these exact commands:

```text
cd shadow/go-review && go test ./...
cd shadow/go-review && python3 parity.py
cd shadow/go-review && go test -fuzz=<each bounded target> -fuzztime=1s
git diff --check
```

Hosted run evidence:

- Run ID: pending after the report commit
- Head SHA: pending after the report commit
- Event and conclusion: pending
- Failed-job log result: pending

## Semantic deviations

No validated-field deviation was observed across the shared fixtures,
malformed cases, boundary cases, numeric cases, Unicode cases, or round trips.
The following API/runtime boundaries are explicit:

1. Python's standard `json.loads` accepts non-standard `NaN` and infinity
   tokens by default. Go's `encoding/json` rejects them. These tokens are not
   standard JSON contract inputs.
2. Go accepts `[]byte` payloads and native integer types through its public Go
   API; the Python contract accepts a string payload and Python integers.
   JSON contract serialization is unchanged.
3. Go rejects invalid UTF-8 strings. Python strings are Unicode by
   construction, and JSON payloads cannot carry invalid UTF-8 through either
   contract.
4. Go exposes ordinary maps and slices, while Python freezes the dataclass's
   outer value shape. Contract serialization and validation are equivalent;
   callers must not mutate a Go value after validation.

## Result

M1 `ReviewResult` contract coverage is complete for this checkpoint. The
experiment remains isolated in the fork draft for human review; no upstream
contribution branch or PR was opened or prepared.
