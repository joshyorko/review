# Review Release Consolidation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Consolidate in-progress reliability fixes (#375–#377), final review/fix rounds (#378), optional Kubernetes lab broker (#379), Headroom telemetry fixes, vestigial queue documentation, and the `gemini-3.8-flash` default model update into `main`, then validate and publish the release.

**Architecture:** Finish uncommitted Headroom Task 1 review fixes and vestigial queue doc additions on `main`. Update default review model to `gemini-3.8-flash` at `high` reasoning effort across all harnesses and documentation. Merge `feat/review-lab` from the validated worktree. Run the full validation suite, push to `origin/main` to trigger automated container publishing, and tag `v0.2.0`.

**Tech Stack:** Python 3, Textual TUI, Bash, Just, Podman/Buildah, GitHub Actions.

## Global Constraints

- Interactive runs are foreground-only; detached background requires explicit `REVIEW_DETACH=1`.
- Never inspect `queue.json` or query static queue files; use live Hive or active review container state.
- Maintainer changes commit and push directly to `main` per repository policy.
- All tests must pass before pushing (`dashboard-contract.sh`, `harness-contract.py`, `lab-broker-contract.py`, `just-onboarding.sh`, `pre-commit`).
- Maintain Conventional Commit format with Co-authored-by trailer.

---

### Task 1: Complete Headroom Task 1 Fixes and Vestigial Queue Documentation

**Files:**
- Modify: `image/tui/headroom.py`
- Modify: `tests/harness-contract.py`
- Modify: `AGENTS.md`
- Modify: `docs/skills/static-pr-queue.md`

**Interfaces:**
- Produces: `HeadroomClient` with loopback opener that ignores HTTP proxies and rejects redirects.
- Produces: `HeadroomSession.from_environment` that returns a `DEGRADED` route when URL is invalid rather than raising.
- Produces: `HeadroomSession.status_line` emitting literal `ACTIVE`, `DIRECT`, or `DEGRADED`, proxy delta tokens/requests, reduction percent/method when present, and literal `Caveman ON/OFF [C]`.

- [ ] **Step 1: Verify current failing tests in `tests/harness-contract.py`**

Run: `python3 tests/harness-contract.py`
Expected: FAIL (2 failures, 1 error)

- [ ] **Step 2: Implement loopback opener, graceful degraded config, and status formatting in `image/tui/headroom.py`**

In `image/tui/headroom.py`:
1. Add `_NoRedirectHandler` subclassing `urllib.request.HTTPRedirectHandler` that raises `urllib.error.HTTPError(req.full_url, code, msg, headers, fp)` on 301, 302, 303, 307, 308.
2. Build opener with `urllib.request.build_opener(urllib.request.ProxyHandler({}), _NoRedirectHandler)`.
3. Use opener in `HeadroomClient._fetch`.
4. In `HeadroomSession.__init__`, catch `HeadroomError` on `HeadroomClient(base_url)` and record degraded state.
5. In `HeadroomSession.status_line`, emit:
   - State indicator: `[ACTIVE]`, `[DIRECT]`, or `[DEGRADED]`.
   - Delta tokens, requests, and reduction qualifier: `(proxy delta: ... req, ... tok saved, ...% <method>)`.
   - Affordance: `Caveman ON [C]` or `Caveman OFF [C]`.

- [ ] **Step 3: Run tests to verify all 60 pass**

Run: `python3 tests/harness-contract.py`
Expected: Ran 60 tests ... OK

- [ ] **Step 4: Commit Headroom Task 1 and vestigial queue doc updates**

```bash
git add image/tui/headroom.py tests/harness-contract.py AGENTS.md docs/skills/static-pr-queue.md
git commit -m "feat(dashboard): complete bounded Headroom telemetry model and vestigial queue docs" \
  -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

### Task 2: Update Default Review Model to `gemini-3.8-flash` (High Effort)

**Files:**
- Modify: `image/harness/goose.py`
- Modify: `image/harness/codex.py`
- Modify: `image/harness/autopilot.py`
- Modify: `image/tui/bluefin_review_tui.py`
- Modify: `image/tui/review_run.py`
- Modify: `justfile`
- Modify: `image/entrypoint.sh`
- Modify: `README.md`
- Modify: `docs/skills/launcher.md`
- Modify: `docs/skills/goose-context.md`
- Modify: `tests/harness-contract.py`
- Modify: `tests/review_run_contract.py`
- Modify: `tests/autopilot-contract.py`
- Modify: `tests/just-onboarding.sh`

**Interfaces:**
- Updates default model constants from `gpt-5.6-luna` to `gemini-3.8-flash` and effort from `low`/`max` to `high`.

- [ ] **Step 1: Update model and effort definitions in harness and launcher files**

Update:
- `image/harness/goose.py`: `model: str = "gemini-3.8-flash"`, `effort: str = "high"`
- `image/harness/codex.py`: `model: str = "gemini-3.8-flash"`, `effort: str = "high"`
- `image/harness/autopilot.py`: `model = "gemini-3.8-flash"`, default preference `gemini-3.8-flash`
- `image/tui/bluefin_review_tui.py`: default preference `gemini-3.8-flash`, `high`
- `image/tui/review_run.py`: `model: str = "gemini-3.8-flash"`, `effort: str = "high"`
- `justfile`: `copilot_default_model := "gemini-3.8-flash"`
- `image/entrypoint.sh`: default `GOOSE_MODEL="gemini-3.8-flash"`
- Documentation in `README.md`, `docs/skills/launcher.md`, `docs/skills/goose-context.md`.

- [ ] **Step 2: Update contract test assertions**

Update test assertions in:
- `tests/harness-contract.py`
- `tests/review_run_contract.py`
- `tests/autopilot-contract.py`
- `tests/just-onboarding.sh`

- [ ] **Step 3: Run targeted test suite to verify model changes**

Run:
```bash
python3 tests/harness-contract.py
python3 tests/review_run_contract.py
python3 tests/autopilot-contract.py
bash tests/just-onboarding.sh
```
Expected: All pass.

- [ ] **Step 4: Commit default model updates**

```bash
git add image/ tests/ justfile README.md docs/
git commit -m "feat(harness): update default review model to gemini-3.8-flash high" \
  -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

### Task 3: Integrate `feat/review-lab` (#375–#379)

**Files:**
- Merge: branch `feat/review-lab` from `.worktrees/review-final`

**Interfaces:**
- Consumes: `feat/review-lab` commits `d673078`, `307ed25`, plus uncommitted lab prompt doc in `image/tui/landing.py`.
- Produces: Integrated lab broker (`scripts/review-lab-broker.py`, `image/tui/lab_client.py`), hardened landing reporter, publication detector, and final review/fix loop on `main`.

- [ ] **Step 1: Commit uncommitted landing prompt update in `review-final` worktree**

```bash
cd /var/home/jorge/src/review/.worktrees/review-final
git add image/tui/landing.py
git commit -m "docs(landing): add lab socket guidance to review agent prompt" \
  -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

- [ ] **Step 2: Merge `feat/review-lab` into `main`**

```bash
cd /var/home/jorge/src/review
git merge feat/review-lab -m "feat(lab): integrate optional Kubernetes lab broker and landing reliability (#375-#379)"
```

- [ ] **Step 3: Verify contracts after merge**

Run:
```bash
python3 tests/lab-broker-contract.py
bash tests/dashboard-contract.sh
```
Expected: PASS (172/172 lab checks, 916/916 pilot checks).

---

### Task 4: Run Full Repository Validation

**Files:**
- All repository files

- [ ] **Step 1: Run complete repository test suite**

```bash
bash scripts/check-skill-frontmatter.sh
bash tests/generate-skills.sh
bash tests/sbom-manifest.sh
bash tests/image-contract.sh
bash tests/bluefin-review.sh
bash tests/dashboard-contract.sh
bash tests/worktree-guard.sh
bash tests/just-onboarding.sh
python3 tests/lab-broker-contract.py
python3 tests/harness-contract.py
git diff --check
just --list
pre-commit run --all-files
pre-commit run shellcheck --hook-stage manual --all-files
```
Expected: 100% clean across all checks.

---

### Task 5: Publish Release

**Files:**
- Git refs: `main`, `v0.2.0`

- [ ] **Step 1: Push `main` to `origin/main`**

```bash
git push origin main
```
Expected: Push succeeds; CI starts `publish review image` to build and publish `ghcr.io/projectbluefin/review:stable`.

- [ ] **Step 2: Create and push tag `v0.2.0`**

```bash
git tag -a v0.2.0 -m "Release v0.2.0: optional Kubernetes lab broker, landing reliability, final review loop, and Gemini 3.8 Flash default"
git push origin v0.2.0
```
Expected: Tag pushed; CI publishes versioned release image and artifacts.
