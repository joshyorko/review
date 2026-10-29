# Packaged restart checkpoint

Execution subject: `bd143724883888d9c19695647c86b8b824a1d9b7` on `fix/review-workbench-recovery`.
This report supersedes the earlier Fedora-network blocker in the [refresh recovery report](../cloud-refresh-recovery/README.md). Product source is unchanged. Full acceptance remains blocked.

## Observed results

| Check | Actual result |
| --- | --- |
| Replacement cloud environment | Ready; unrestricted HTTP policy enforced |
| Exact pinned official Fedora pull | Passed |
| Native amd64 appliance build | Completed; build exit receipt 0 |
| Image revision label | Exact execution subject above |
| Packaged verifier under default `runc` | BLOCKED, exit 1: cannot create required namespace |
| Packaged verifier under existing `runsc` | BLOCKED, exit 1: `loopback: Failed RTM_NEWADDR: No such file or directory` |
| Docker-adapted repository co-load smoke | Exit 0 with **`enabled=blocked disabled=passed`** |
| Disabled Review/Factory policy restart | Passed: explicit fixture policy persisted and both command surfaces read it after a new process started |
| Enabled Factory restart / active batch recovery | **Not proven** |
| Native TSP rendering | **Not proven; separate renderer dependency** |

The enabled case actually refused startup before work selection. The smoke's exit 0 records its expected blocked branch; it is not an enabled-verifier PASS. Its disabled cases used fresh disposable HOMEs and a deterministic local model catalog. Command RPCs invoked no model turns or live inference. No personal HOME was adopted and no GitHub mutation was attempted by the appliance.

The image is `localhost/review:pr94-bd143724`, ID `sha256:96f6bcbf63d1508b4a085e3a9f7b42165f2674d506ffec5f0e8b656653486054`, size 726858432 bytes. [Image metadata](image-inspect.json), [checkpoint](checkpoint.json), [source hashes](source-manifest.json), [actual smoke output](logs/smoke-runc.log.gz), and the two probe receipts ([runc](verifier-runc.jsonl), [runsc](verifier-runsc.jsonl)) bind these claims to the executed artifact.

## Build and transport provenance

The same pinned Fedora digest, upstream artifacts, source, patches, build checks, final image instructions, entrypoint and verifier were retained. An ephemeral [cloud build recipe](Containerfile.cloud.txt) supplied a trusted combined CA bundle through a BuildKit secret and reduced layer duplication for the managed Docker daemon's `vfs` storage. It did not change the daemon storage driver or security policy. [Transformation description](build-adaptation.json), [shell failure-propagation check](build-failure-propagation-check.json), [archive modes](context-modes.json), and [final build log](logs/docker-build.log.gz) document the adaptation.

Initial attempts exhausted the 32 GB disk, exposed incorrect failure propagation in the temporary compaction recipe, and exposed private archive-extraction modes that prevented the Docker host UID from reading packaged files. These setup problems were corrected before this final build and smoke. Earlier images and failed setup attempts are not acceptance evidence. The final context preserved the Git archive's modes and matched every recorded source hash.

The [Docker smoke adaptation](smoke-docker.patch) replaces Podman commands directly and uses the host UID:GID instead of Podman's `keep-id`. Entrypoint, verifier, assertions, HOME mounts and baseline network mode remain intact. No Podman shim, privileged flag, unconfined profile, capability addition or verifier bypass was used.

## Required environment capability

The unprivileged appliance process must be able to run its existing Bubblewrap sandbox with user and nested mount/PID/IPC/UTS/network namespaces, UID/GID mappings, read-only bind mounts, proc/dev/tmpfs mounts and isolated workspace binding. Namespace creation through the applicable `clone`/`unshare` operations must work through every runtime boundary. Network namespace initialization must provide working route-netlink loopback configuration, including `RTM_NEWADDR`. Both shipped `sandboxPreflight` and `sandboxTest("true")` must succeed.

A normal Linux VM can provide these kernel facilities without changing application code, provided its kernel, distribution policy and selected runtime support this unprivileged sandbox. That is a capability requirement, not a claim that an untested VM passes. A VM running the same restrictive nested Docker boundary can still fail: Docker documents namespace-related restrictions in its [default seccomp profile](https://docs.docker.com/engine/security/seccomp/); Bubblewrap documents its [user-namespace sandbox model](https://github.com/containers/bubblewrap). The `runc` error alone does not identify which outer policy denied creation. The `runsc` receipt separately records its loopback failure. No policy relaxation was attempted.

## Verification and separate visual gate

Fresh source checks at the execution subject passed **859 tests with 4 skips**, **43 Python contracts**, and launcher parity. Static appliance, 16 package and 28 SBOM contracts also passed. [Source-suite receipt](logs/omp-review-mode.log.gz), [static appliance](logs/appliance-static.log.gz), [package](logs/package-review.log.gz), [SBOM](logs/appliance-sbom.log.gz). The build log records native compiled lifecycle and memory canaries. Skipped source tests remain skips.

The [existing real VTE/PTY screenshots](../cloud-refresh-recovery/README.md#actual-foreground-captures) remain source-runtime ANSI evidence; no new screenshot sweep occurred and no image is relabeled as a compiled appliance or TSP capture. [Tern](https://stencil.so/tern) still advertises closed-beta access, and the [public SDK releases page](https://github.com/stencil-hq/tern-sdk/releases) has no renderer release. A legitimate compatible TSP v1/toast renderer and actual visual inspection remain separate prerequisites.

Runtime-log sanitization replaced only the host evidence-root and temporary smoke-run paths. The Docker adaptation is presented as a zero-context diff. Environment identifiers, host names, credentials and configuration files are omitted. [Original and published hashes](sanitization.json) identify the sanitized artifacts. PR94 stays draft; enabled Factory and native TSP acceptance remain blocked.
