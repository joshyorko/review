# turbo-review Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `just turbo-review` to scale 3 cluster contributor workers in Kubernetes (`bluefin-system`) and launch the interactive maintainer review dashboard in the foreground, with shared Hive Hub wiring, non-blocking cluster fallback, and an EXIT status banner.

**Architecture:** Compose cluster scale-out with the existing `review-queue` recipe as a child process. The launcher synchronizes Hive credentials into `bluefin-system/review-contributor-secret` via server-side apply, sets deployment environment variables (including the resolved `HIVE_HUB`) in one pass, scales to 3 replicas, and executes `just review-queue "$@"` in foreground. An EXIT trap queries ready replicas on exit and prints status and stop instructions.

**Tech Stack:** Bash, just, Podman, Kubernetes (kubectl), Hive protocol, Textual (Python TUI).

## Global Constraints

- Recipe name: `turbo-review *args:` in `justfile`.
- Default replicas: 3 in namespace `bluefin-system`.
- Default profile: `gemini-3.8-flash` at `high` thinking effort.
- Subprocess isolation: `just review-queue` runs as child process to prevent profile environment variable stickiness.
- Security: Secrets created with `--server-side --force-conflicts` to prevent secret leakage in `kubectl.kubernetes.io/last-applied-configuration`.
- Non-blocking: Missing kubectl or cluster context warns and continues to local review dashboard; never crashes maintainer workflow.

---

### Task 1: Clean Manifest & Harden `scale_cluster_contributors` in `justfile`

**Files:**
- Modify: `deploy/review-contributor.yaml:35-45`
- Modify: `justfile:908-965`

**Interfaces:**
- Consumes: `HIVE_CONTRIBUTOR_ENV`, `COPILOT_TOKEN`, `GH_TOKEN_VALUE`
- Produces: `scale_cluster_contributors(replicas, profile, effort, hive_hub)`

- [ ] **Step 1: Update `deploy/review-contributor.yaml`**
Remove hardcoded `HIVE_HUB` default from manifest container env so it is populated cleanly from secret or `kubectl set env` without precedence conflicts.

- [ ] **Step 2: Update `scale_cluster_contributors` in `justfile`**
Update `scale_cluster_contributors` to:
- Use `kubectl apply --server-side --force-conflicts -f -` when creating `review-contributor-secret`.
- Pass resolved `HIVE_HUB` into `kubectl set env deployment/review-contributor`.
- Return non-zero cleanly with a clear warning if kubectl/context is missing.

- [ ] **Step 3: Run existing onboarding tests to verify no regressions**
Run: `bash tests/just-onboarding.sh`
Expected: PASS

- [ ] **Step 4: Commit Task 1**
```bash
git add deploy/review-contributor.yaml justfile
git commit -m "fix(cluster): remove hardcoded hub and harden secret apply in cluster scaling

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

### Task 2: Implement `turbo-review` Recipe in `justfile`

**Files:**
- Modify: `justfile` (add `turbo-review` recipe)

**Interfaces:**
- Consumes: `scale_cluster_contributors`, `review-queue`
- Produces: `just turbo-review *args`

- [ ] **Step 1: Add `turbo-review` recipe to `justfile`**
```just
# Scale 3 cluster workers and open the maintainer review dashboard in the foreground.
# Workers continue running in the cluster after the dashboard exits.
#
#   just turbo-review                      # default gemini profile, 3 cluster workers
#   just turbo-review sol                  # sol profile, 3 cluster workers
#   just turbo-review projectbluefin/review # live review of one repository
[doc("Scale 3 cluster workers and open the maintainer review dashboard.")]
turbo-review *args:
    #!/usr/bin/env bash
    set -euo pipefail
    {{shared_functions}}

    replicas="${REVIEW_SCALE:-3}"
    profile="gemini"
    effort="high"

    echo "=== Launching review turbo ==="
    if command -v kubectl &>/dev/null && [[ -n "$(kubectl config current-context 2>/dev/null || true)" ]]; then
      echo "✓ scaling ${replicas} cluster contributor workers in bluefin-system..."
      scale_cluster_contributors "$replicas" "$profile" "$effort" || {
        echo "! cluster worker scale-out failed; continuing with local review dashboard." >&2
      }
    else
      echo "! no active Kubernetes context found; continuing with local review dashboard only." >&2
    fi

    report_cluster_exit_status() {
      echo ""
      echo "=== Cluster contributor status ==="
      if command -v kubectl &>/dev/null && kubectl get deployment review-contributor -n bluefin-system &>/dev/null; then
        ready="$(kubectl get deployment review-contributor -n bluefin-system -o jsonpath='{.status.readyReplicas}' 2>/dev/null || echo 0)"
        total="$(kubectl get deployment review-contributor -n bluefin-system -o jsonpath='{.spec.replicas}' 2>/dev/null || echo 0)"
        echo "✓ ${ready:-0}/${total:-0} cluster contributor workers active in bluefin-system."
        echo "  Stop workers: just review-stop cluster"
        echo "  Check health: just review-doctor"
      fi
    }
    trap report_cluster_exit_status EXIT

    echo "✓ starting maintainer review dashboard in foreground..."
    # Execute review-queue as a child process to isolate environment variables and traps.
    # shellcheck disable=SC2086
    just review-queue {{args}}
```

- [ ] **Step 2: Validate syntax and recipe listing**
Run: `just --list`
Expected: `turbo-review` listed with description.

- [ ] **Step 3: Commit Task 2**
```bash
git add justfile
git commit -m "feat(launcher): add turbo-review recipe for cluster scale-out + dashboard

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

### Task 3: Contract Tests in `tests/just-onboarding.sh`

**Files:**
- Modify: `tests/just-onboarding.sh`

**Interfaces:**
- Consumes: fake kubectl harness in `tests/just-onboarding.sh`
- Produces: automated assertions for `turbo-review`

- [ ] **Step 1: Write tests for `turbo-review`**
Test cases:
1. `turbo-review` with active fake kubectl scales 3 workers and launches dashboard.
2. `turbo-review` without kubectl warns and still launches dashboard.
3. `turbo-review` exit banner reports active cluster status.

- [ ] **Step 2: Run test suite**
Run: `bash tests/just-onboarding.sh`
Expected: PASS

- [ ] **Step 3: Commit Task 3**
```bash
git add tests/just-onboarding.sh
git commit -m "test(launcher): add contract tests for turbo-review recipe

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

### Task 4: Documentation & Final Factory Checks

**Files:**
- Modify: `README.md`
- Modify: `docs/skills/launcher.md`
- Modify: `AGENTS.md`
- Run: `bash scripts/check-skill-frontmatter.sh --write`

**Interfaces:**
- Updates user documentation and skill catalog for `turbo-review`.

- [ ] **Step 1: Update `README.md`, `docs/skills/launcher.md`, and `AGENTS.md`**
Document `just turbo-review` in recipe tables and examples.

- [ ] **Step 2: Run frontmatter check and update manifest**
Run: `bash scripts/check-skill-frontmatter.sh --write`

- [ ] **Step 3: Run full validation suite**
```bash
bash scripts/check-skill-frontmatter.sh
bash tests/image-contract.sh
bash tests/bluefin-review.sh
bash tests/just-onboarding.sh
git diff --check
pre-commit run --all-files
```

- [ ] **Step 4: Commit Task 4**
```bash
git add README.md docs/skills/launcher.md AGENTS.md docs/skills/index.json
git commit -m "docs(launcher): document turbo-review recipe in README and skills

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```
