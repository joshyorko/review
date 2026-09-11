# Image and development guide

The image derives from the digest-pinned Project Bluefin FSDK lab runner and
layers the pinned Hive runtime (the tracked revision is in the [README](../README.md)),
the pinned OMP release, the pinned official Codex CLI, GitHub CLI,
tmux, uv with the Textual dashboard runtime, hooks, and generated organization
skills.

The relay uses the root `package-lock.json` to install only the exact `ws`
dependency with `npm ci --omit=dev --ignore-scripts`. The official,
checksum-verified Node archive remains intact as a JavaScript runtime: `node`,
`npm`, and `corepack` stay available. Only its headers, documentation, and the
now-unused npm download cache are removed. Those fixed Node, CLI, tmux, and
relay inputs are built before the agent layers.

`ghcr.io/projectbluefin/review-contributor` remains the compatibility image for
the maintainer dashboard and legacy `review-container` path.
`ghcr.io/projectbluefin/contribute` is a separate distroless Hive worker: it
carries only OMP, Node with the locked `ws` module, GitHub CLI, tmux, the
upstream Hive runtime, and the FSDK shell/git closure. It contains no
Codex, Pi, Python, dashboard, review scope, or generated skills. Its embedded
SPDX manifest records exactly those artifacts, `ws`, and pinned Hive files; the
registration is mounted at `/home/bluefin/.config/hive/contributor.env` and
provider credentials are inherited environment names only.

`contribute` is OMP-only by contract. Its entrypoint rejects any external `AGENT_BACKEND` other than `omp`, so a stale registration cannot reactivate another Hive backend. This is a product boundary rather than a launcher default: the image defines the entire contributor experience, while Hive retains registration, assignment, tmux lifecycle, prompt injection, retries, and result capture.

That Hive SHA is load-bearing, not decorative. It is the third of three copies
of the same pin: `hive_commit` in the `justfile`, `ARG HIVE_COMMIT` in
`image/Containerfile`, and the one in the README. All three must move together, and CI
fails if they disagree. Renovate proposes them as a single change, so take its
pull request whole rather than editing any copy by hand.

OMP installs from official GitHub releases with architecture-specific SHA256
checksums (`OMP_VERSION`, `OMP_X86_64_SHA256`, `OMP_AARCH64_SHA256`).
Use an immutable contributor image digest or `sha-<commit>` image tag when a
fixed artifact is required.
Every published contributor digest carries review-specific OCI title,
description, project URL/source, revision, version, creation time, license,
and exact FSDK base name/digest metadata in both platform labels and manifest
annotations. Publishing attaches a signed SLSA provenance bundle and a signed
SPDX SBOM to the published index digest, verifiable with `gh attestation
verify`. The SBOM covers the archive-installed components — OMP, the GitHub
CLI, tmux, Codex, ripgrep, the pinned Hive runtime files, the skill bundles,
and the review git hooks — because the image carries a build-time SPDX
manifest of them (`/opt/bluefin/sbom/review-components.spdx.json`, generated
from the resolved Containerfile pins) that the publish scan ingests; the
post-publish audit fails when any of them is missing from either platform's
attested SBOM. CI verifies the FSDK input's GitHub attestation and its
linux/amd64+linux/arm64 manifest before a build; after publication it verifies
both review attestations, labels, annotations, subject digest, and exactly
those two platforms.

The image is built with podman and buildah, the same engines that run it, and
each architecture is built by a runner of that architecture: `ubuntu-26.04`
for amd64 and `ubuntu-26.04-arm` for arm64. Each build job proves its host,
podman engine, and container architecture, runs the shipped runtime, and audits
the image it just pushed. The published `:stable` is an OCI index assembled by
buildah from those two native digests, so no shipped layer is ever produced
under emulation. The generated per-architecture audit reports in the GitHub
Actions step summary are the acceptance artifact; local single-architecture
validation cannot supply that evidence.

The pinned Hive runtime provides the contributor environment. No static
image-owned agent configuration file is required for OMP.
Organization skills are generated at image build time from
`projectbluefin/common`'s `docs/skills/index.json`. Repositories may
route agents to their own skill catalog, but per-repository skills are not
automatically discovered at session startup, and no session-layer skill becomes
a review check unless it is authored separately in the image-owned
review scope.

The base image ships the full ncurses terminfo database, so the caller's
terminal type is the truth inside the container. tmux panes run
`tmux-direct`, so 24-bit color is a terminfo fact and tmux passes RGB
through to terminals that support it, downsampling only for weaker attach
clients. For a terminal newer than the base's ncurses (e.g.
`xterm-ghostty`), the entrypoint falls back to `xterm-direct` for a
truecolor caller (`COLORTERM`) and to `xterm-256color` otherwise.

The pinned FSDK base ships GNU findutils 4.10.0 and diffutils 3.12, so the
image uses those directly. It previously installed Python `find` and `cmp`
shims into `/usr/local/bin`, which precedes `/usr/sbin` on `PATH` and so
shadowed the real tools; the `find` shim also got `-o` precedence wrong and
deleted `*.out` of any age where GNU `find` deleted only old `*.html`,
destroying fresh agent output. Both shims are gone. Use the tools the image
ships; if one is missing, fix it at the FSDK seam rather than reimplementing
it here.

Context7 serves the agent: the Hive hub queries it
server-side and folds the result into its knowledge export.

`worktree-guard` (at `/usr/local/bin/worktree-guard`) runs an agent command
in an ephemeral git worktree and enforces hygiene: a run that leaves the
tree dirty is reported, purged, and failed, and the agent's own exit code is
never masked. When bubblewrap is available it adds a read-only-root sandbox
around the run (fsdk-containers#109 tracks shipping bwrap in the base).

Git hooks at `/opt/bluefin/git-hooks` are ergonomics only; GitHub rulesets and
required checks enforce repository policy.

## Development

### Iterating on the contributor image

Prototype image-owned behavior in this checkout, then build the commit you
have under the same immutable tag CI mints for it:

```bash
ref="ghcr.io/projectbluefin/review:sha-$(git rev-parse HEAD)"
podman build \
  -f image/Containerfile -t "$ref" .
```

Use that tag for a container-only trial without publishing it:

```bash
REVIEW_CONTRIBUTOR_IMAGE="$ref" just review-container
```

An `sha-<commit>` tag names exactly one build, so the launcher never re-pulls
over it and the local copy is the one that runs. It also says which commit is
in the image, which a made-up local name cannot.
After the change is ready, commit it and use the normal publish workflow; CI
publishes immutable `sha-<commit>` and version tags and advances `:stable`
from `main`.
The checked-in checksums make this local command use the known pinned OMP release;
to update it, update `OMP_VERSION`, `OMP_X86_64_SHA256`, and `OMP_AARCH64_SHA256`.
### Validation

CI enforces the complete contract suite in `.github/workflows/validate.yml`. To run the local portion of the suite (everything preceding container image builds and registry calls):

```bash
# Static hygiene and formatting
pre-commit run --all-files
git diff --check

# Commit, skill, and manifest contracts
bash tests/check-commit-message.sh
bash scripts/check-skill-frontmatter.sh
bash tests/generate-skills.sh
bash tests/sbom-manifest.sh
python3 tests/harness-contract.py
python3 tests/autopilot-contract.py

# Launcher and onboarding contracts
just --list
bash tests/just-onboarding.sh
bash tests/readme-quickstart.sh

# Runtime and image contracts
bash tests/image-contract.sh
bash tests/hive-compatibility.sh
bash tests/bluefin-review.sh
bash tests/worktree-guard.sh
bash tests/omp-review-mode.sh
bash tests/appliance-contract.sh
bash tests/dashboard-contract.sh
```

Additional focused contract tests (such as `python3 tests/lab-broker-contract.py` or `python3 tests/review_engine_contract.py`) cover individual subsystems as documented in their respective skill files.
`tests/image-audit.sh` inspects a real image, so it needs a container engine
and network access. It uses `podman`; `CONTAINER_ENGINE` names another one.
Use `--verify-base-evidence` to check the pinned
FSDK input alone, or `--derived <image>` to audit a build. The report records
each platform's runtime evidence as native or unavailable — never QEMU —
and `--report image-audit-report.md` writes it to a git-ignored file. Native
per-architecture acceptance comes from the matrix `build` job in
`.github/workflows/publish-compat-image.yml` and its generated step summary:

```bash
bash tests/image-audit.sh \
  --derived "ghcr.io/projectbluefin/review:sha-$(git rev-parse HEAD)"
```

`pre-commit run --all-files` runs socket-free hygiene checks locally.
ShellCheck remains required in CI, where the validate workflow invokes its
manual container-backed hook explicitly.

See [`AGENTS.md`](../AGENTS.md) for contributor boundaries and
[`docs/SKILL.md`](../docs/SKILL.md) for task-specific documentation.
