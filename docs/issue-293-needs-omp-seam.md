# Issue #293 — extension proof in progress

This receipt records the live capability audit for
[joshyorko/review#293](https://github.com/joshyorko/review/issues/293).
The packaged native path is intentionally not claimed: the exact OMP releases
Review ships do not expose the generic external `MemoryBackend` registration
seam required by the existing MemoryD adapter.

## Exact heads

| Component | Identity |
| --- | --- |
| Review live `self-hosted` head at audit | `35dec9f80eed65dd307e3fdf1626ce2fd7749f64` |
| Review handoff baseline | `ca9496e1a65912344cf68fa08c2a7425f1da627d` |
| Packaged OMP | `18.4.3`, release source tag `fc671eba383f2a7208500836673b485c0dc7073d` |
| OMP live `main` audited | `60d3a5a4520b2937b4a0fc727abadabbed17cf2e` |
| MemoryD adapter source | `e7f8d431797973afbdf4d0530aa14a25f43acf35` |

The Review source pin is digest-verified in
`image/appliance/Containerfile:32-35`. The latest published Review dev
appliance observed during the audit is `dev-0.20260929125440-ca9496e659`; it
also contains OMP 18.4.3. The issue's original 18.4.2 publication baseline is
now stale.

## Phase 0 evidence

### OMP backend contract

At both OMP 18.4.3 and the audited live `main`:

- `packages/coding-agent/src/memory-backend/types.ts` defines the native
  `MemoryBackend` lifecycle, including `start`, developer instructions,
  `clear`, `enqueue`, optional status/search/save/statistics/diagnostics/queue
  hooks, `beforeAgentStartPrompt`, `preCompactionContext`, and live settings
  application. The `MemoryBackendId` union remains
  `off | local | hindsight | mnemopi | sharpshooter`.
- `packages/coding-agent/src/memory-backend/settings.ts` declares
  `memory.backend` as a static enum containing only those five IDs.
- `packages/coding-agent/src/memory-backend/resolve.ts` has explicit branches
  for those built-ins and resolves every other value to `offBackend`.
- `packages/coding-agent/src/memory-backend/runtime.ts` routes status, search,
  and save through the resolved backend.
- `packages/coding-agent/src/slash-commands/builtin-lifecycle.ts` routes
  `/memory` through that same resolver.
- `packages/coding-agent/src/session/session-memory.ts` owns serialized
  backend transitions, setting reloads, teardown, prompt refresh, and cwd
  rebind behavior. `packages/coding-agent/src/session/session-maintenance.ts`
  invokes `preCompactionContext`.
- `packages/coding-agent/src/tools/index.ts` still hard-codes memory tool
  activation to Hindsight/Mnemopi and the built-in local/autolearn cases.
- `packages/coding-agent/src/extensibility/extensions/types.ts` and
  `packages/coding-agent/src/extensibility/extensions/loader.ts` expose no
  `registerMemoryBackend` or equivalent registration API. The extension
  runtime has provider registration, but no memory-backend registry.
- `packages/coding-agent/test/memory-backend-resolve.test.ts`,
  `packages/coding-agent/test/agent-session-memory-backend.test.ts`,
  `packages/coding-agent/test/hindsight-backend.test.ts`, and
  `packages/coding-agent/test/memories-runtime.test.ts` cover the existing
  built-in resolver/lifecycle/subagent behavior, not third-party registration.

**Native seam conclusion:** current OMP does **not** expose a stable third-party
`registerMemoryBackend`-style API. An extension-only implementation cannot
make `memory.backend=codex-memoryd` work because settings validation and the
resolver reject/ignore the unknown ID before the extension can own the
lifecycle. This finding does not rule out automatic recall through the
documented extension lifecycle.

### Follow-up: stock-binary extension path

The official OMP 18.4.3 `omp-linux-x64` release artifact was downloaded and
executed on x86_64. Its SHA-256 is
`afcecdff1f421f3c88fb1714c407b3700899b4de3ed003cd8369f52ae6ca87de`, matching
the x86_64 pin at `image/appliance/Containerfile:34`. The binary reported
`omp/18.4.3`.

At the matching source tag `fc671eba383f2a7208500836673b485c0dc7073d`,
`packages/coding-agent/src/extensibility/extensions/types.ts` declares
`before_agent_start` with an awaited handler and a `message` result at
`BeforeAgentStartEventResult`; it can inject context before the agent runs.
This is a potential extension route, not a MemoryBackend registration API.
This continuation did **not** load an extension into that binary or observe a
provider-bound request. No recall, attribution, cancellation/retry/scope,
duplicate suppression, or daemon-outage behavior is proven.

### Upstream issue evidence

- OMP #2148 remains open and is the primary request for third-party memory
  registration. Its maintainer discussion identifies the unresolved
  namespacing, settings ownership, load ordering, lifecycle, and `/memory`
  parity decisions.
- OMP #7902 remains open as the duplicate request for a public extension API;
  its maintainer comment points back to #2148.
- OMP #10704 remains an open duplicate concerning backend-specific memory
  addressing/capabilities. It does not provide the registration seam needed by
  this issue.
- OMP #12668's cancellation work is already reflected in the optional abort
  signal on `beforeAgentStartPrompt`; it does not add registration.

### Review appliance and transport evidence

- `bin/bluefin` launches Podman/krun without `--network=host` and falls back
  to contained Apptainer. Persistent home, workspace, and scratch mounts are
  target-specific; no MemoryD endpoint, daemon, socket, or state mount exists.
- `image/appliance/entrypoint.sh` starts OMP directly and has no companion
  daemon supervisor.
- The adapter accepts only loopback HTTP(S) origins and requires explicit
  profile/workspace scope. It has no Unix-socket transport.
- A companion MemoryD process in the appliance's private network namespace is
  the least invasive candidate, but packaging, lifecycle supervision, durable
  shared state, and an Apptainer network contract are not implemented or
  proven here. Host networking, LAN exposure, and a Review-local database are
  excluded.

### MemoryD adapter and distribution evidence

MemoryD commit `e7f8d431797973afbdf4d0530aa14a25f43acf35` contains the landed
`adapters/omp-memory-provider` source package:

- package: `@codex-memoryd/omp-memory-provider`, version `0.1.0`;
- `src/index.ts` exports the generic registration packet and calls only
  `api.registerMemoryBackend(registration)`;
- `src/backend.ts` implements the native lifecycle, bounded recall,
  `recall_not_authority` framing, staged commit protection, fail-open behavior,
  cancellation, status/search/explicit-save, and bounded pre-compaction recall;
- automatic observation/writeback remains disabled pending MemoryD #233;
- no fake `memory://` resource is introduced.

This Git commit is an immutable source identity suitable for a future dogfood
fetch. MemoryD #245 is still open; no published GitHub release, tag, npm
artifact, or Homebrew formula was verified. The adapter must therefore not be
copied into Review or treated as a published package.

## Native registration seam (not required for extension mode)

The native integration previously considered would register a session-scoped
backend factory with generic metadata, accept registered IDs for
`memory.backend`, and route the resolved backend through existing native
startup, prompt, compaction, `/memory`, runtime status/search/save, live setting
changes, cwd rebind, resume, and child-session paths.

That describes native `/memory` integration, not an acceptance prerequisite for
the rewritten extension-based request. No MemoryD-specific OMP branch, custom
recall tool, competing hidden memory loop, or Hindsight/Mnemopi shadowing is
being proposed.

No generic OMP patch or upstream PR was created in this Review change. The
native registration audit remains valid, but it is not a blocker to the
rewritten extension-based request. The stock-binary extension lifecycle route
is identified, not yet proven; implementation and provider-boundary acceptance
remain in progress.

## Acceptance status

| Criterion | Status |
| --- | --- |
| Exact OMP version, architecture, and pinned artifact digest verified | TESTED — official 18.4.3 x86_64 artifact runs and matches pin |
| Native external MemoryBackend registration in packaged OMP | ABSENT — audit finding; not required for extension-mode recall |
| Documented extension pre-agent lifecycle contract identified | TESTED — source contract only; not exercised in binary |
| Extension loaded by exact official binary and awaited recall before provider request | REMAINING — not proven |
| First provider request contains one correctly attributed synthetic recall, no memory tool | REMAINING — provider boundary not exercised |
| Cancellation/re-entry/retry/scope invalidation, duplicate protection, daemon-down fail-open | REMAINING — not exercised |
| Existing MemoryD adapter reused by immutable identity | REMAINING — no integration attempted |
| Explicit writes only; automatic assistant-turn writeback disabled | REMAINING — no integration attempted |
| `/memory` parity, status/search/save, compaction, appliance transport/supervision | REMAINING — out of current proof; do not claim |
| Packaged appliance dogfood receipt | REMAINING — do not expand packaging before stock-binary proof |
| Exact-head independent review | REMAINING |

Terminal marker: `EXTENSION_PROOF_REMAINING`.
