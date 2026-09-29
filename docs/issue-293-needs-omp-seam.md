# Issue #293 — derived native OMP proof in progress

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

**Native seam conclusion:** at the audited release, current OMP does **not**
expose a third-party `registerMemoryBackend` API. `memory.backend` has a closed
enum and resolver; native MemoryD selection therefore requires a small generic
registration/resolution patch in a locally derived OMP build. Do not substitute
an extension hook or change the upstream release artifact.

### Follow-up: exact-source derived native build

The official OMP `v18.4.3` source tag resolves to
`fc671eba383f2a7208500836673b485c0dc7073d`; the checkout tag and commit agree.
The immutable MemoryD adapter source is
`joshyorko/codex-memoryd@e7f8d431797973afbdf4d0530aa14a25f43acf35`. Review has
not yet applied a generic OMP registration patch, built a derived executable,
or proved native adapter selection at the provider boundary.

The unmodified official x86_64 artifact was also downloaded and executed as a
baseline: SHA-256
`afcecdff1f421f3c88fb1714c407b3700899b4de3ed003cd8369f52ae6ca87de`
(matches `image/appliance/Containerfile:34`), output `omp/18.4.3`. This is the
upstream artifact hash, not a derived-output hash and not candidate proof.

Local source build prerequisite observed missing: shell `bun --version` and
`node --version` returned `command not found`; shell PATH also has no `npm`,
`rustc`, `cargo`, or `gcc`. No upstream build script, compile, native canary,
or CI-derived artifact run was completed. CI setup/build work and all derived
artifact provenance remain unproven.

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

## Generic native registration patch required

The derived source build needs a generic, duplicate-safe registration API for
external `MemoryBackend` factories, with metadata/settings ownership and
reserved-ID protection. Resolve a registered backend through OMP's existing
native per-session startup, prompt, compaction, status/search/save, live-setting,
cwd-rebind, resume, cancellation, disposal, and child-session paths. Preserve
the existing built-in resolver behavior and fail-open semantics. Keep all
MemoryD-specific policy in the adapter; no MemoryD branch in OMP, competing
memory loop, or automatic writeback.

No upstream OMP PR, fork repository, or generic source patch has yet been made.
Do not promote or package a derived candidate until a clean source build passes
the native MemoryD x86_64 canary. Then connect only those tested bytes to the
existing Review CI/package flow and add the existing aarch64 lane.

## Acceptance status

| Criterion | Status |
| --- | --- |
| Official OMP source tag matches exact commit | TESTED — `v18.4.3` = `fc671eba383f2a7208500836673b485c0dc7073d` |
| Official upstream x86_64 binary version and digest verified | TESTED — upstream artifact only; not derived candidate |
| MemoryD adapter source identity pinned | TESTED — `joshyorko/codex-memoryd@e7f8d431797973afbdf4d0530aa14a25f43acf35` |
| Generic native registration patch, clean derived OMP build, provenance | REMAINING — not attempted |
| Derived x86_64 binary selects existing adapter and recalls synthetic fact on first provider request | REMAINING — no derived binary/provider-boundary run |
| Daemon-down fail-open/degraded and cancellation/stale/rebind controls | REMAINING — not exercised |
| Native status/search/explicit save; automatic writeback remains disabled | REMAINING — not exercised |
| Derived artifact integrated with existing CI/package flow; aarch64 lane | REMAINING — do not expand before x86_64 canary |
| Promotion gate preserves last verified release on patch/build/test failure | REMAINING |
| Exact-head independent review | REMAINING |

Terminal marker: `NATIVE_BUILD_PROOF_REMAINING`.
