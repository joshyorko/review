# M1-A ReviewResult parity report

This report records the fork-local M1-A contract checkpoint. The lab remains
pure parsing, validation, bounded evidence, state transitions, and
serialization. It has no UI, network, filesystem, subprocess, mutation,
launcher, image, live-adapter, Codex, MCP, or Hive path.

## Baseline and sources

- Upstream repository: `projectbluefin/review`
- Recorded upstream baseline: `6748294e476cc7ba836771b92565f0b09082a33e`
- Implementation sources:
  - `image/tui/review_result.py`
    - blob `fe5574a3b6a6d14bedc37febc8d68a27cbc50b86`
  - `image/tui/review_evidence_manifest.py`
    - blob `e7c334309a4456ddca208c75d2d2289f58e66f58`
  - `image/tui/action_plan.py`
    - blob `13f8884c00af62233add5e4bcf1604919f9dd065`
- Contract test sources, verified but not imported:
  - `tests/review_result_contract.py`
    - blob `c0b7247fab31c2ff8c6010976b64befce64c224b`
  - `tests/review_evidence_manifest_contract.py`
    - blob `e064581649cc95dbae5be947c86f00f7a5d7b51d`
  - `tests/action_plan_contract.py`
    - blob `3b8033c96881e55cea285d311b55d873c5fa1208`
- Fork-owned runner: `shadow/go-review/parity.py`
- Shared ReviewResult fixtures:
  `shadow/go-review/testdata/review-result-cases.json`

The runner verifies every implementation and test blob before importing the
three implementation modules. It compares complete serialized ReviewResult
objects rather than only state and cleanliness: version, counts, findings,
verification, provenance, overlap, live data, raw evidence, and state are all
checked. The official upstream-oriented Python tests remain unchanged.

## Fork isolation and provenance

- Fork: `joshyorko/review`
- Tested fork SHA: `f4db6c7950b72c5bba060ca4bedbf6d1b2835985`
- Working branch: `copilot/experiment-build-go-bubble-tea-cockpit`
- Preferred issue experiment line: `experiment/go-review-shadow`
- Branch deviation: the Copilot-managed head branch differs from the preferred
  experiment line; no replacement branch was created.
- Work location: fork PR #14 only; no upstream PR was opened or prepared.
- Issue relation: `Progresses #13`; this checkpoint does not close the
  multi-milestone experiment.
- Requested implementation runtime: `gpt-5.6-luna`, reasoning `max`.
- Parent implementation runtime provenance: provider, backend, model, and
  reasoning fields were not exposed, so no Luna/max execution claim is made.
- Dedicated static review invocation: model `gpt-5.6-luna`; provider/backend
  and reasoning fields were not exposed; it ran no tests and made no edits.

## Coverage

- ReviewResult shared fixtures: 31
- ReviewResult round trips: 11
- Deep, oversized, and trailing-JSON boundary cases: 3
- Truncated clean-payload prefixes: 98
- Numeric edge cases: 6
- Unicode line-boundary cases: 11
- Malformed optional-field cases: 7
- EvidenceManifest fixtures: 2
- Malformed EvidenceManifest cases: 4
- ActionPlan fixtures: 2
- Exact-head revalidation cases: 2
- Malformed ActionPlan cases: 5
- Go fuzz seeds:
  - `FuzzParseReviewResultBounded`: 8
  - `FuzzTruncatedCleanPayloadNeverBecomesClean`: 4
  - `FuzzEvidenceManifestValidationDoesNotPanic`: 4
  - `FuzzActionPlanValidationDoesNotPanic`: 4
- Go fuzz campaigns: all four passed for one second; the exact execution
  counts are recorded below.
- Bounds: 400 raw-evidence lines, 120,000 Unicode characters, 128 manifest
  entries, 32 action operations, and 256 receipt-detail characters.

The fuzz properties include panic resistance, raw-evidence bounds,
serialization round trips for clean results, and the invariant that malformed
or truncated input never becomes clean.

## Commands and results at the tested fork SHA

```text
$ cd shadow/go-review && go test ./...
ok  	github.com/joshyorko/review/shadow/go-review	0.013s

$ cd shadow/go-review && python3 parity.py
Python ReviewResult parity: baseline 6748294e476cc7ba836771b92565f0b09082a33e, 31 fixture cases, 11 round-trip cases, 3 boundary cases, 98 truncated prefixes, 6 numeric edge cases, 11 Unicode line boundaries, and 7 malformed optional cases passed
Python M1 contract parity: 2 EvidenceManifest fixtures, 4 malformed EvidenceManifest cases, 2 ActionPlan fixtures, 2 exact-head revalidation cases, and 5 malformed ActionPlan cases passed

$ cd shadow/go-review && go test -fuzz=FuzzParseReviewResultBounded -fuzztime=1s
fuzz: elapsed: 1s, execs: 11376 (10267/sec), new interesting: 0 (total: 17)
PASS

$ cd shadow/go-review && go test -fuzz=FuzzTruncatedCleanPayloadNeverBecomesClean -fuzztime=1s
fuzz: elapsed: 2s, execs: 6251 (3094/sec), new interesting: 35 (total: 57)
PASS

$ cd shadow/go-review && go test -fuzz=FuzzEvidenceManifestValidationDoesNotPanic -fuzztime=1s
fuzz: elapsed: 2s, execs: 4866 (2426/sec), new interesting: 14 (total: 33)
PASS

$ cd shadow/go-review && go test -fuzz=FuzzActionPlanValidationDoesNotPanic -fuzztime=1s
fuzz: elapsed: 2s, execs: 10854 (5421/sec), new interesting: 19 (total: 51)
PASS

$ git diff --check
exit 0; no output
```

## Fork workflow evidence

Required workflow: `.github/workflows/shadow-go-review.yml`

- Repository: `joshyorko/review`
- Latest run for the tested head: run `31557534358`
- Head SHA reported by the run: `f4db6c7950b72c5bba060ca4bedbf6d1b2835985`
- Event: `pull_request`
- Conclusion: `action_required`
- Jobs: `0`
- Failed-job log query: no failed jobs; approval is required before a job is
  provisioned.

The workflow definition executes the Go suite, Python baseline parity, all
four bounded fuzz targets, and `git diff --check`. Local execution above is
the complete evidence for this tested head; hosted fork approval remains an
external gate and is not represented as green.

## Semantic deviations

No validated-field deviation was observed across the canonical fixtures,
malformed cases, round trips, or bounded property campaigns.

The following language/runtime boundaries are explicit:

1. Python's standard `json.loads` accepts non-standard `NaN` and infinity
   tokens by default. Go's `encoding/json` rejects them. Those tokens are not
   standard JSON contract inputs.
2. Go validates that manually constructed manifest strings are valid UTF-8;
   Python strings are Unicode by construction. JSON payloads cannot carry an
   invalid UTF-8 string through either contract.
3. Go exposes ordinary maps and slices, while the Python dataclasses freeze
   their outer value shape. Contract serialization and validation are
   equivalent; callers must not mutate a Go value after validation.
4. Go supports typed executor functions returning `(OperationResult, error)`,
   `OperationResult`, or `int`; Python accepts a callable returning
   `OperationResult` or `int`. This is an adapter convenience and does not
   widen the validated plan or bypass confirmation, revalidation, or the
   receipt ledger.

## Next gate

The deliberate contemporary rebaseline against upstream `main` must happen
once upstream PR #192 lands. M2 remains gated on that single rebaseline and a
fresh run of every differential test. No M2 cockpit, M3 live vertical, M4
executor, or M5 MCP surface is claimed by this report.
