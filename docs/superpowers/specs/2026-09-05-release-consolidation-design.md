# Specification: Review Release Consolidation

**Date:** 2026-09-05
**Topic:** Consolidating in-flight work and releasing projectbluefin/review
**Status:** Approved

## 1. Context and Motivation

The `review` appliance has multiple independent threads of high-value work in progress across branches, worktrees, and local modifications:

1. **Lab & Landing Reliability (`feat/review-lab` in `.worktrees/review-final`)**:
   - Resolves issues #375 (anonymous GHCR token probe without piping curl to jq), #376 (publication detection requiring on.push and terminal status), and #377 (single-writer report CLI under fcntl.flock, idempotent terminal writes).
   - Resolves issue #378 (final review-and-fix rounds with Opus 5 and Kimi K3, 5-round circuit breaker).
   - Resolves issue #379 (optional host-side lab broker over private Unix domain socket, gVisor host-uds=open, USB4 status detection, 'LAB ⚡ ACTIVE' indicator, typed safe profiles).
   - Verified with 916/916 Textual pilot checks and 172/172 lab broker contract checks.
2. **Headroom Telemetry & Caveman Model (`main` uncommitted)**:
   - Task 1 of the Headroom model is in progress: tests added in `tests/harness-contract.py` require 5 specific review fixes in `image/tui/headroom.py` to ensure loopback-only redirect refusal, proxy environment isolation, exact status formatting (`ACTIVE`, `DIRECT`, `DEGRADED`, `Caveman ON/OFF [C]`), and graceful degradation on invalid configuration.
3. **Vestigial Queue Documentation (`main` uncommitted)**:
   - Clear contract additions in `AGENTS.md` and `docs/skills/static-pr-queue.md` stating static `queue.json` is vestigial, instructing agents to inspect the active review container or query live state.
4. **Default Review Model Configuration**:
   - Maintainer preference to update default review model to `gemini-3.8-flash` with `high` reasoning effort across Goose, Codex, and launcher profiles.

Consolidating these strands into `main` and releasing the next milestone is required to unblock continuous contributor use and factory deployment.

## 2. Boundaries and Operating Invariants

- **Foreground Only**: Interactive runs remain foreground-only; background execution is permitted only via explicit `REVIEW_DETACH=1`.
- **No Static Queue Files**: Never inspect `queue.json`; pull-request state is obtained live from Hive or from the container runtime.
- **Repository Workflows**: Changes by the repository maintainer go straight to `main` per repository policy.
- **Independent Lab**: The lab is strictly optional; missing or degraded lab never blocks reviews or merges.
- **Strict TDD & Validation**: All changes must pass the full test suite (`dashboard-contract.sh`, `harness-contract.py`, `lab-broker-contract.py`, `just-onboarding.sh`, `pre-commit`, and manual `shellcheck`).

## 3. Work Units

### Unit 1: Complete Headroom Task 1 & Vestigial Queue Documentation
- Update `image/tui/headroom.py`:
  - Build dedicated urllib opener with `ProxyHandler({})` and `_NoRedirectHandler` that raises on 3xx redirects to guarantee loopback confinement.
  - Render status line with literal `ACTIVE`, `DIRECT`, or `DEGRADED`, proxy delta request/token stats, output reduction percentage and method qualifier, and literal `Caveman ON/OFF [C]`.
  - Handle malformed `BLUEFIN_REVIEW_HEADROOM_URL` in `HeadroomSession.from_environment` gracefully as `DEGRADED` rather than raising an unhandled exception.
- Validate `python3 tests/harness-contract.py` achieves 100% green (60/60 passing).
- Commit Headroom Task 1 and vestigial queue doc updates to `main`.

### Unit 2: Update Default Review Model to `gemini-3.8-flash` (High Effort)
- Update default model from `gpt-5.6-luna` to `gemini-3.8-flash` and effort to `high` across:
  - `image/harness/goose.py`
  - `image/harness/codex.py`
  - `image/harness/autopilot.py`
  - `image/tui/bluefin_review_tui.py`
  - `image/tui/review_run.py`
  - `justfile` (default profile values)
  - `image/entrypoint.sh`
  - Documentation (`README.md`, `docs/skills/launcher.md`, `docs/skills/goose-context.md`)
- Update corresponding contract test expectations in `tests/harness-contract.py`, `tests/review_run_contract.py`, `tests/autopilot-contract.py`, and `tests/just-onboarding.sh`.
- Validate that all unit and contract tests pass.

### Unit 3: Integrate `feat/review-lab` (#375–#379)
- Commit uncommitted review prompt instruction update in `.worktrees/review-final/image/tui/landing.py`.
- Merge `feat/review-lab` into `main`.
- Resolve any minor conflicts cleanly.

### Unit 4: Comprehensive Validation
- Execute all test suites locally:
  - `bash scripts/check-skill-frontmatter.sh`
  - `bash tests/generate-skills.sh`
  - `bash tests/sbom-manifest.sh`
  - `bash tests/image-contract.sh`
  - `bash tests/bluefin-review.sh`
  - `bash tests/dashboard-contract.sh`
  - `bash tests/just-onboarding.sh`
  - `python3 tests/lab-broker-contract.py`
  - `python3 tests/harness-contract.py`
  - `git diff --check`
  - `just --list`
  - `pre-commit run --all-files`
  - `pre-commit run shellcheck --hook-stage manual --all-files`

### Unit 5: Release and Publication
- Push consolidated `main` to `origin/main` to trigger `.github/workflows/publish-compat-image.yml` (publishing `ghcr.io/projectbluefin/review:stable`).
- Tag release `v0.2.0` on `main` and push the tag to publish the versioned release image and GitHub Release.
