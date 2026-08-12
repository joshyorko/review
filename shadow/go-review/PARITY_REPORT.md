# M1-M5 Review shadow contract report

This report records the fork-local M1-M5 contract-lab checkpoint. M1 keeps
fail-closed parity with the recorded Python baseline. M2 adds a deterministic
Bubble Tea model, M3 adds bounded read-only runtime contracts, M4 adds a
non-executing dry-run gate, and M5 adds read-only MCP inspection and preview
tools. No terminal program, network listener, filesystem adapter, subprocess,
Hive, launcher, image, credential, or mutation path is included.

## Baseline and sources

- Upstream repository: `projectbluefin/review`
- Recorded upstream baseline:
  `6748294e476cc7ba836771b92565f0b09082a33e`
- Baseline implementation sources:
  - `image/tui/review_result.py`
    - blob `fe5574a3b6a6d14bedc37febc8d68a27cbc50b86`
  - `image/tui/review_evidence_manifest.py`
    - blob `e7c334309a4456ddca208c75d2d2289f58e66f58`
  - `image/tui/action_plan.py`
    - blob `13f8884c00af62233add5e4bcf1604919f9dd065`
- Baseline contract tests, verified but not imported:
  - `tests/review_result_contract.py`
    - blob `c0b7247fab31c2ff8c6010976b64befce64c224b`
  - `tests/review_evidence_manifest_contract.py`
    - blob `e064581649cc95dbae5be947c86f00f7a5d7b51d`
  - `tests/action_plan_contract.py`
    - blob `3b8033c96881e55cea285d311b55d873c5fa1208`
- Fork-owned parity runner: `shadow/go-review/parity.py`
- Shared ReviewResult fixtures:
  `shadow/go-review/testdata/review-result-cases.json`
- M2 fixture: `shadow/go-review/testdata/cockpit-cases.json`
- M1-M5 implementation sources:
  - `shadow/go-review/review_result.go`
  - `shadow/go-review/evidence_manifest.go`
  - `shadow/go-review/action_plan.go`
  - `shadow/go-review/cockpit.go`
  - `shadow/go-review/runtime.go`
  - `shadow/go-review/dry_run.go`
  - `shadow/go-review/mcp_server.go`

The runner verifies the recorded implementation and test blobs before
importing the three baseline modules. It compares complete serialized
ReviewResult objects: version, counts, findings, verification, provenance,
overlap, live data, raw evidence, and state. The official upstream-oriented
Python tests remain unchanged.

## Fork isolation and provenance

- Fork: `joshyorko/review`
- Tested fork SHA:
  `76f15e8e6815329989fa0016649cfae7921cfefa`
- Working branch: `copilot/experiment-build-go-bubble-tea-cockpit`
- Preferred issue experiment line: `experiment/go-review-shadow`
- Branch deviation: the Copilot-managed head branch differs from the
  preferred experiment line; no replacement branch was created.
- Work location: fork PR #14 only; no upstream PR was opened or prepared.
- Issue relation: `Progresses #13`; this checkpoint does not close the
  multi-milestone experiment.
- Requested implementation runtime: `gpt-5.6-luna`, reasoning `max`.
- Parent implementation runtime provenance: provider, backend, model, and
  reasoning fields were not exposed, so no Luna/max execution claim is made.
- Dedicated static review invocation: model `gpt-5.6-luna`; provider/backend
  and reasoning fields were not exposed; it ran no tests and made no edits.

The GitHub and Codex adapters are interfaces around injected clients. Their
capability records state read-only intent, and deterministic fakes are used by
the tests. The MCP surface uses the SDK in-memory transport; it does not start
a network server.

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
- M2 cockpit fixture cases: 1
- M2 keyboard/mouse interaction tests: 2
- M3 adapter, bound, timeout, and fake-client tests: 3
- M4 dry-run confirmation and drift tests: 2
- M5 MCP in-memory server/client tests: 1
- Go fuzz seeds:
  - `FuzzParseReviewResultBounded`: 8
  - `FuzzTruncatedCleanPayloadNeverBecomesClean`: 4
  - `FuzzEvidenceManifestValidationDoesNotPanic`: 4
  - `FuzzActionPlanValidationDoesNotPanic`: 4
- Bounds: 400 raw-evidence lines, 120,000 Unicode characters, 128 manifest
  entries, 32 action operations, 256 receipt-detail characters, bounded
  runtime output, and bounded runtime rows.

The fuzz properties include panic resistance, raw-evidence bounds,
serialization round trips for clean results, and the invariant that malformed
or truncated input never becomes clean.

## Commands and results at the tested fork SHA

```text
$ cd shadow/go-review && go test ./...
ok  	github.com/joshyorko/review/shadow/go-review	0.025s

$ cd shadow/go-review && python3 parity.py
Python ReviewResult parity: baseline 6748294e476cc7ba836771b92565f0b09082a33e, 31 fixture cases, 11 round-trip cases, 3 boundary cases, 98 truncated prefixes, 6 numeric edge cases, 11 Unicode line boundaries, and 7 malformed optional cases passed
Python M1 contract parity: 2 EvidenceManifest fixtures, 4 malformed EvidenceManifest cases, 2 ActionPlan fixtures, 2 exact-head revalidation cases, and 5 malformed ActionPlan cases passed

$ cd shadow/go-review && go test -fuzz=FuzzParseReviewResultBounded -fuzztime=1s
fuzz: elapsed: 2s, execs: 7942 (4154/sec), new interesting: 11 (total: 19)
PASS

$ cd shadow/go-review && go test -fuzz=FuzzTruncatedCleanPayloadNeverBecomesClean -fuzztime=1s
fuzz: elapsed: 1s, execs: 17349 (17004/sec), new interesting: 14 (total: 18)
PASS

$ cd shadow/go-review && go test -fuzz=FuzzEvidenceManifestValidationDoesNotPanic -fuzztime=1s
fuzz: elapsed: 2s, execs: 3684 (1839/sec), new interesting: 19 (total: 23)
PASS

$ cd shadow/go-review && go test -fuzz=FuzzActionPlanValidationDoesNotPanic -fuzztime=1s
fuzz: elapsed: 2s, execs: 8564 (4271/sec), new interesting: 39 (total: 43)
PASS

$ git diff --check
exit 0; no output
```

## Fork workflow evidence

Required workflow: `.github/workflows/shadow-go-review.yml`

The workflow runs:

```text
cd shadow/go-review && go test ./...
cd shadow/go-review && python3 parity.py
cd shadow/go-review && go test -fuzz=<each bounded target> -fuzztime=1s
git diff --check
```

Hosted run evidence is refreshed on the fork after this report commit and is
listed here with its run ID, head SHA, event, conclusion, and failed-job log
result.

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
5. M2-M5 are fork-local continuation contracts. They do not claim parity with
   an upstream implementation because no upstream M2-M5 implementation was
   imported.

## Result

M1-M5 fork-local contract coverage is complete for this checkpoint. The
experiment remains isolated in PR #14 for human review; no upstream
contribution branch or PR was opened or prepared.
