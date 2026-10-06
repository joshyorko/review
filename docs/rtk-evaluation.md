# RTK evaluation for Review (#167)

This is an optional, bounded efficiency experiment. The current OMP 18.5.0
baseline (upstream source commit
`9348320cc4a30a7195d36a1f05a6c11bcb701a17`) already exposes `tool_call` input
rewriting and `tool_result` content transforms. Its bash tool also caps inline
output while retaining the full raw stream artifact when truncation occurs.
RTK adds command-specific rewrite rules; it must not replace OMP's approval,
execution, or raw-artifact behavior.

## Current upstream identity

Checked read-only on 2026-10-06: the latest stable release at
[`rtk-ai/rtk v0.51.0`](https://github.com/rtk-ai/rtk/releases/tag/v0.51.0) is
the Rust Token Killer project and declares Apache-2.0 in its `LICENSE`. The
release's `checksums.txt` reports these Linux archives:

| Architecture | Release asset | SHA-256 |
| --- | --- | --- |
| x86_64 | `rtk-x86_64-unknown-linux-musl.tar.gz` | `5028d3b19a8f0990d30fec9fbb07e32782bc5698e618fb1861aad8a9ccba4eb5` |
| aarch64 | `rtk-aarch64-unknown-linux-gnu.tar.gz` | `8d6d1aad9e69b42481eda7039507d1f7ee93698f87713cecd873d287c1931632` |

Re-read the release, license, asset names, and checksums before any packaging
change. These are dated research evidence, not permanent pins.

RTK's [`hooks/pi/rtk.ts` at v0.51.0](https://github.com/rtk-ai/rtk/blob/v0.51.0/hooks/pi/rtk.ts)
documents that OMP loads this same extension through legacy-Pi compatibility.
It subscribes to `tool_call`, invokes `rtk rewrite <command>` using the host's
`exec` API, changes only bash input when a rewrite is returned, honors
`RTK_DISABLED=1`, and fails open on timeout, kill, or unexpected rewrite
status. OMP 18.5.0's public extension types expose mutable bash input, the
`tool_call` subscription, `ExtensionAPI.exec`, and an abort signal. This
establishes a compatible public API shape; loading and executing the packaged
extension in OMP remains a separate runtime acceptance gate.

The public API evidence is OMP's
[`shared-events.ts`](https://github.com/can1357/oh-my-pi/blob/9348320cc4a30a7195d36a1f05a6c11bcb701a17/packages/coding-agent/src/extensibility/shared-events.ts),
[`extensions/types.ts`](https://github.com/can1357/oh-my-pi/blob/9348320cc4a30a7195d36a1f05a6c11bcb701a17/packages/coding-agent/src/extensibility/extensions/types.ts),
[`extensions/loader.ts`](https://github.com/can1357/oh-my-pi/blob/9348320cc4a30a7195d36a1f05a6c11bcb701a17/packages/coding-agent/src/extensibility/extensions/loader.ts),
and [`bash.ts`](https://github.com/can1357/oh-my-pi/blob/9348320cc4a30a7195d36a1f05a6c11bcb701a17/packages/coding-agent/src/tools/bash.ts)
at that exact commit. They establish the event and raw-artifact seams only;
they do not prove that Review packages or loads RTK.

## Reproducible local comparison

`tests/fixtures/rtk-evaluation.sh` creates a bounded fixture repository and
private `HOME`/XDG directories. It is a manual opt-in fixture, outside the
root-level test registry; it does not install RTK, call `rtk init`, use the
operator's OMP profile, contact GitHub, or enable telemetry. Set `RTK_BIN` to
an explicitly downloaded private test artifact and `RTK_EVAL_OUTPUT_DIR` to a
fresh absolute private evidence path (the final directory must not exist):

```bash
RTK_BIN=/private/test-artifacts/rtk \
RTK_EVAL_OUTPUT_DIR=/var/tmp/review-rtk-evaluation/run-01 \
bash tests/fixtures/rtk-evaluation.sh
```

The runner puts a symlink to the selected binary first in its scoped `PATH`,
places a poisoned `rtk` command immediately after it, and records the resolved
path/version before executing any rewritten command. The raw, filtered, and
fallback rerun outputs, fixture repository, and complete runner log remain in
the evidence directory. A disabled/raw comparison executes the unchanged
command a second time with `RTK_DISABLED=1`; it records that command's actual
elapsed time instead of copying the first output. This validates the CLI-level
bypass fixture only; it does not execute the OMP hook.

The bounded corpus includes Git status/log, a parseable JSON passthrough, an
exact raw diff with rewriting disabled, a successful validator, and a noisy
failing test. For every case the runner records raw/filtered bytes, exit codes,
and command-level elapsed milliseconds. It fails on exit-code drift, checks
the JSON remains parseable and byte-identical, checks the raw diff is
byte-identical, and executes a raw rerun when a required diagnostic marker is
missing.

This harness characterizes command-level behavior only. It does not count
agent turns, certify that a real Review investigation retained enough context,
test the OMP extension lifecycle, or establish total-token savings. A
representative exact-head Review comparison must separately record RTK's
estimated `rtk gain`, raw reruns, diagnosis/retry turns, wall-clock impact,
parse/filter errors, and full-fidelity command exclusions. Never use the
upstream “up to 90%” output claim as Review acceptance evidence.

## Historical fixture sample (2026-10-06)

The x86_64 v0.51.0 release archive was checksum-verified and run from the
private artifact directory with the fixture's isolated home and telemetry
disabled. One cold local pass preserved all exit codes, the JSON bytes, the
explicit raw diff bytes, and every required diagnostic marker; no raw rerun
was triggered. `rtk gain` reported 1 estimated token saved (0.7%) over its
three tracked rewritten commands. The byte counts were 274→273 for Git status,
200→200 for Git log, 74→74 for JSON, 202→202 for the raw diff, 540→540 for the
successful validator, and 453→453 for the exit-7 failure. Filtered command
times ranged from 13–26 ms for rewritten commands versus 2–3 ms for the
corresponding raw commands; the raw diff bypass added no RTK process time.

This sample predates both the private-PATH guard and the disabled-command
re-execution. Its version probes also preceded the private HOME/XDG and
telemetry exports. Treat it as historical only; it does not establish which
executable handled rewritten command prefixes or prove a clean first RTK
invocation.

## Private-path fixture sample with environment-order defect (run-02)

The corrected v0.51.0 run resolved `rtk` to the selected private binary ahead
of a poisoned inherited `rtk` path entry. It retained the complete raw and
filtered outputs, fixture repository, and run log in the fresh
private `run-02` evidence directory. All
exit codes, required markers, JSON bytes, and explicit raw diff bytes matched;
there were zero fallback raw reruns. `rtk gain` again reported 1 estimated
token saved (0.7%) across three tracked rewritten commands. Bytes were 274→273
for Git status, 200→200 for Git log, 74→74 for JSON, 202→202 for the disabled
raw diff, 540→540 for the successful validator, and 453→453 for the exit-7
failure. Cold rewritten command measurements were 13–89 ms versus 2–3 ms raw;
the actual disabled/raw diff comparison was 3 ms after a 3 ms raw baseline.

The independent review found that the fixture made its first two RTK version
calls before exporting private HOME/XDG paths and disabling telemetry. Preserve
this run as historical evidence, but do not treat it as clean-environment
acceptance. Its evidence remains unchanged in `run-02/`.

## Clean-environment fixture sample (run-03)

The fresh v0.51.0 run logged private HOME, XDG, and telemetry values before its
first version invocation. It resolved the selected checksum-verified binary
ahead of the poisoned inherited PATH entry. All exit codes, required markers,
JSON bytes, and disabled raw diff bytes matched; no raw rerun was triggered.
`rtk gain` reported 1 estimated token saved (0.7%) across three tracked
rewritten commands. Bytes were 274→273 for Git status, 200→200 for Git log,
74→74 for JSON, 202→202 for the disabled raw diff, 540→540 for the successful
validator, and 453→453 for the exit-7 failure. Cold rewritten command times
were 12–89 ms versus 2–4 ms raw; disabled diff was 3 ms versus 3 ms raw.
The full raw/filtered outputs, fixture repository, and runner log are retained
in a fresh private `run-03` evidence directory. The old `run-02/`
directory remains unchanged.

This remains a synthetic fixture, with no authenticated GitHub reads, Review
test suites, OMP hook lifecycle, or agent-turn measurement. It does not settle
adoption.

No adoption default follows from the fixture alone. Decide default-on,
opt-in/binary-only, or reject only after the required packaged OMP dogfood and
the exact-head RTK-on/raw comparison complete.

## Source package checkpoint (2026-10-06)

The source pins RTK v0.51.0 with separate x86_64-musl and aarch64-GNU archive
digests, the matching upstream `hooks/pi/rtk.ts` digest, and the Apache-2.0
license digest `4044ade9c21d8b084d3d16a03375cf3b7e166b946a327bb37a3fbbdb53287cfd`
from `https://raw.githubusercontent.com/rtk-ai/rtk/v0.51.0/LICENSE`. It stages
the binary, hook, and exact upstream license text at
`/usr/bin/rtk`, `/usr/share/bluefin/review/rtk/rtk.ts`, and
`/usr/share/licenses/rtk/LICENSE`. Build-time version and `gain` probes run
after private HOME/XDG paths and telemetry-off are set. The SPDX generator
records binary, hook, and license version/source/checksums and Apache-2.0
declarations; OCI labels include each digest. The Renovate post-upgrade task
refreshes both architecture hashes, the matching hook, and the checked-in
version-matched license text and hash.

The entrypoint sets `RTK_DISABLED=1` and `RTK_TELEMETRY_DISABLED=1` by default.
It adds the immutable RTK extension only for explicit `RTK_DISABLED=0`; missing
files fall back to native OMP command execution. It does not initialize or
modify any `.omp` tree. Set `RTK_DISABLED=0` on either launcher to opt in:
`bluefin review` and `just review-appliance` pass the variable by name only.
When it is unset, both launchers add no override.

When the ready #151 launch-profile resolver is composed, it must keep
`RTK_DISABLED` as an explicit fixed-name host input and must not store or
synthesize a profile default. The reviewed combined #358 source demonstrates
that behavior, but its profile/collector code is not part of this #167 branch.

These are source/static contract changes only. No appliance image was built,
and no packaged OMP hook load, runtime output comparison, or Factory gate was
run. The separate clipboard package change at `77352dc` was not folded into
this branch; it overlaps the Containerfile, SPDX generator, and appliance
contracts and must be reconciled if it lands before this packet. No
`.dockerignore` change was needed because the pinned hook is fetched and
verified in the builder stage rather than copied from another source file.
