# Issue #293 — derived native OMP seam proof; distribution blocked

This receipt records the live capability audit and follow-up for
[joshyorko/review#293](https://github.com/joshyorko/review/issues/293).
The generic OMP patch, x86_64 derived build, first-turn native selection/recall,
and daemon-down fail-open path are verified locally. The appliance now builds
derived OMP per native architecture, but no image or aarch64 build was run here.
The MemoryD adapter is not packaged: its pinned source commit has no license, so
packaged MemoryD behavior is not claimed.

## Exact heads

| Component | Identity |
| --- | --- |
| Review live `self-hosted` head at audit | `35dec9f80eed65dd307e3fdf1626ce2fd7749f64` |
| Review handoff baseline | `ca9496e1a65912344cf68fa08c2a7425f1da627d` |
| Last published Review dev appliance | `dev-0.20260929125440-ca9496e659`; still contains upstream OMP 18.4.3 |
| OMP source tag and exact commit | `v18.4.3` = `fc671eba383f2a7208500836673b485c0dc7073d` |
| OMP live `main` audited | `60d3a5a4520b2937b4a0fc727abadabbed17cf2e` |
| Latest local derived x86_64 OMP SHA-256 | `9ac68b5d682c42bc6e12f3da59241655db470616c396aa8faf524953502b15c3` |
| MemoryD adapter source | `e7f8d431797973afbdf4d0530aa14a25f43acf35`; no license file at that commit |

The OMP source, patch, Bun, native-package, and MemoryD test-source pins are in
`image/appliance/Containerfile:32-44`; the resolved derived binary hash is
recorded in the image SBOM. The last published Review dev appliance observed
during the audit is not this derived candidate. The issue's original 18.4.2
publication baseline is stale.

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

**Native seam conclusion:** unmodified OMP `v18.4.3` does **not** expose a
third-party `registerMemoryBackend` API. `memory.backend` has a closed enum and
resolver. A generic registration/resolution patch is therefore required in a
derived source build; it leaves the upstream tag and release artifact unchanged.

### Follow-up: exact-source derived build and provider-boundary canary

`scripts/build-derived-omp.sh` fetches and verifies the exact OMP source archive,
applies `patches/omp/memory-backend-registration.patch`, verifies the toolchain
and native addon, runs the pinned MemoryD adapter tests and focused OMP tests,
then compiles the native binary. The x86_64 run passed:

- OMP source `fc671eba383f2a7208500836673b485c0dc7073d`, archive SHA-256
  `d7e19ecdf0e75312098b94b3a4997c8c7f0d36ef0b350a93d7cfa486c1cb9ef2`;
- generic patch SHA-256
  `08985708402dc8657f8e34eeff10fdede62343d276fab6ec4b77f82c2b3d9e41`;
- Bun 1.4.2 x86_64 archive SHA-256
  `c678040f14fe0440eb839d37cbd0ce4c051a32da72806ac97de6a6aab6bf728f`;
- `@oh-my-pi/pi-natives-linux-x64@18.4.3` archive SHA-512
  `9186665bbcf69f557bac60b8311840b3e45b367a78d1d1cf841b07ee2102d1655ef524d7abd99996efcc66774891e7d2bd78c1c1d541dd9303f21a9dfd1567be`;
- MemoryD source `e7f8d431797973afbdf4d0530aa14a25f43acf35`, archive SHA-256
  `155ec09537e941e4c71a65b738650b0419ae86f12cc86e28761d10553627d692`;
- OMP typecheck passed; resolver tests passed (7 tests, 20 expectations);
  selector regression tests passed (7 tests, 39 expectations); adapter tests
  passed (27 tests, 68 expectations);
- derived executable reported `omp/18.4.3`, SHA-256
  `9ac68b5d682c42bc6e12f3da59241655db470616c396aa8faf524953502b15c3`.

The live x86_64 canary used that derived executable and the exact adapter source
fetched ephemerally from the pinned commit. A loopback synthetic MemoryD server
returned a recall marker on the first prompt. OMP sent one `/v1/recall` request
with `profile=personal`, `workspace=issue-293-canary-current`,
`pack_mode=active_task`, and `source_kind=omp_native_recall`; the provider
boundary observed the marker after one recall and returned
`MEMORYD_RECALL_PRESENT_OK` (process exit 0). After stopping the synthetic
MemoryD server, a second OMP process exited 0 with
`MEMORYD_NO_RECALL_FAIL_OPEN_OK`; the provider saw no recall marker. This proves
the native selector and fail-open path against deterministic loopback fixtures,
not against a production MemoryD daemon or packaged appliance.

The unmodified official x86_64 OMP artifact was separately executed as a
baseline: SHA-256
`afcecdff1f421f3c88fb1714c407b3700899b4de3ed003cd8369f52ae6ca87de`
and output `omp/18.4.3`. It is an upstream artifact, not the derived candidate,
and the Containerfile no longer downloads it.

`scripts/update-omp-pins.mjs 18.4.3` resolved the source commit/archive and
both npm native-package integrities from their live endpoints. Its focused test
passed (6 tests). `bash tests/appliance-contract.sh` passed the static image,
SBOM, architecture-lane, and promotion-gate contracts; it did not build or
publish an OCI image. The existing publish workflow builds x86_64 and aarch64
on native runners and assembles the index only after both builds succeed. The
aarch64 builder and hosted promotion have not been exercised in this worktree.

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

The immutable MemoryD source commit contains the landed
`adapters/omp-memory-provider` package (`@codex-memoryd/omp-memory-provider`,
version `0.1.0`). Its `src/index.ts` calls only the generic
`api.registerMemoryBackend(registration)` API; `src/backend.ts` owns adapter
policy, bounded recall, `recall_not_authority` framing, staged-commit
protection, fail-open behavior, cancellation, status/search/explicit-save, and
bounded pre-compaction recall. Automatic observation/writeback remains
disabled pending MemoryD #233. No fake `memory://` resource is introduced.

The pinned MemoryD repository commit has no `LICENSE` file; no license or
distribution grant is inferred from repository ownership. The adapter is
fetched only into temporary build/canary directories and is not copied into the
Review repository or image. MemoryD #245 remains open; no published release,
tag, npm artifact, or Homebrew formula was verified. Packaging the adapter is
blocked until distribution rights are established.

## Generic native registration patch implemented

The Review patch adds duplicate-safe generic `MemoryBackend` factory
registration, reserved-ID protection, registration resolution, and native
session lifecycle integration. It preserves the built-in OMP selector and keeps
MemoryD policy in the adapter; there is no MemoryD-specific OMP branch,
competing memory loop, or automatic writeback. No upstream OMP fork or PR was
created.

`image/appliance/Containerfile` builds the patched OMP source on each native
image architecture. The existing publish workflow retains its native arm64
runner, and the OCI index job depends on both architecture builds and checks for
both digests. Static contract tests guard these gates. Actual arm64 compilation,
hosted CI, and image publication remain unverified.

## Acceptance status

| Criterion | Status |
| --- | --- |
| Official OMP source tag matches exact commit | TESTED — `v18.4.3` = `fc671eba383f2a7208500836673b485c0dc7073d` |
| Generic registration patch, x86_64 derived build, focused OMP tests, provenance | TESTED — executable SHA-256 recorded above |
| Derived x86_64 binary selects the adapter and recalls a synthetic fact on the first provider request | TESTED — provider-boundary trace above |
| Daemon-down recall is fail-open | TESTED — second loopback canary process exited 0 without recalled context |
| Adapter cancellation, stale/root invalidation, status/search/save, and write policy | TESTED — pinned adapter unit tests only; no live daemon lifecycle integration |
| Native status/search/explicit save against MemoryD | REMAINING — no runtime exercise; automatic writeback remains disabled |
| Derived image build and native aarch64 lane | IMPLEMENTED, NOT RUN — local builder was x86_64; hosted native arm64 build remains pending |
| Promotion waits for both native builds and both digests | TESTED — static workflow contract only; no hosted promotion |
| MemoryD adapter distribution authorization | BLOCKED — pinned commit contains no license; adapter is not packaged |
| Exact-head independent review and hosted checks | REMAINING |

Terminal marker: `DISTRIBUTION_AUTHORIZATION_REQUIRED`.
