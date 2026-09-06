# Design Spec: `just turbo-review`

- Date: 2026-09-05
- Status: Approved (Reviewed by Claude Opus 5)
- Implementation Topic: One-command cluster worker scale-out paired with live review dashboard

## 1. Goal & User Need

Provide a single, fast command (`just turbo-review`) that:
1. Connects to the active Kubernetes cluster and scales 3 contributor workers in `bluefin-system`.
2. Synchronizes identical Hive contributor configuration, tokens, and model profiles so workers and dashboard communicate with the same Hive Hub.
3. Launches the interactive maintainer review dashboard (`review-queue`) in the foreground with argument forwarding.
4. Keeps cluster workers running in the background when the user exits the UI (`q` or `Ctrl-C`), printing an explicit reminder banner with status and stop commands.

## 2. Architecture & Components

### 2.1 Recipe Signature & Invocation
In `justfile`:
```just
[doc("Scale 3 cluster workers and open the maintainer review dashboard.")]
turbo-review *args:
```

- Accepts optional `*args` passed through to `review-queue` (e.g. `just turbo-review`, `just turbo-review sol`, `just turbo-review projectbluefin/review`).
- Default worker replica count is 3, configurable via `REVIEW_SCALE` environment variable.
- Default worker profile is `gemini` at `high` effort (maximizing factory throughput via flash models and fast cluster infra).
- Default dashboard profile matches the passed or default arguments.

### 2.2 Execution Flow

```text
[just turbo-review *args]
         │
         ├── 1. Preflight check: kubectl & active k8s context
         │      (If missing, warn and continue to local dashboard without cluster crash)
         │
         ├── 2. Resolve Hive registration & tokens (Copilot, GitHub, HIVE_HUB)
         │
         ├── 3. Sync Kubernetes Secret (review-contributor-secret in bluefin-system)
         │      Using server-side apply to avoid last-applied plaintext leakage
         │
         ├── 4. Deploy & Scale review-contributor to 3 replicas
         │      Set HIVE_HUB env to match dashboard's resolved hub (prevent split-brain)
         │
         ├── 5. Set EXIT trap for exit summary banner
         │
         └── 6. Subprocess execution: `just review-queue "$@"`
                (Subprocess prevents environment variable stickiness and trap clobbering)
```

### 2.3 Resolving Opus 5 Review Blockers

1. **Split-Brain Hive Prevention**:
   - `deploy/review-contributor.yaml` hardcoded hub is removed or overridden.
   - The launcher resolves `HIVE_HUB` from `HIVE_CONTRIBUTOR_ENV`.
   - Both `review-contributor-secret` and container environment pass the exact same `HIVE_HUB` to pods and dashboard.
   - The launcher prints the confirmed shared Hive hub.

2. **Single-Process Environment Stickiness**:
   - `turbo-review` runs `scale_cluster_contributors` in the host shell, then launches `just review-queue "$@"` as a child process.
   - This isolates environment mutations (e.g. `GOOSE_MODEL`, `GOOSE_THINKING_EFFORT`) and prevents profile leakage between cluster workers and local dashboard.

3. **Secret Security**:
   - Secret application uses `--server-side --force-conflicts` to prevent writing sensitive credentials into the `kubectl.kubernetes.io/last-applied-configuration` metadata annotation.

4. **Multi-Rollout Elimination**:
   - Apply deployment with targeted environment variables (`GOOSE_MODEL`, `GOOSE_THINKING_EFFORT`, `HIVE_HUB`) and replica count in a single synchronized operation rather than cascading apply -> set-env -> scale rollouts.

5. **Lifecycle & Exit Banner**:
   - When the user exits the UI (`q` or `Ctrl-C`), an `EXIT` trap executes reliably.
   - Queries `kubectl` for real-time `.status.readyReplicas` and prints:
     ```text
     ✓ N/3 cluster contributor workers active in bluefin-system.
       Stop workers: just review-stop cluster
       Check health: just review-doctor
     ```

## 3. Failure Handling

- **No Kubectl or No Active Context**:
  Prints warning:
  `! No active Kubernetes context found; continuing with local review dashboard only.`
  Proceeds to launch `review-queue` without aborting maintainer workflow.
- **Rollout Timeout / ImagePullBackOff**:
  Non-blocking 15s rollout wait. If pods are still pulling or pending, warns and continues to dashboard. The exit banner reports actual ready replicas.
- **Missing Tokens**:
  Handled by existing `resolve_gh_token` and `resolve_copilot_token` guards with actionable messages.

## 4. Contract & Testing Plan

1. **Launcher Contracts**:
   - Update `AGENTS.md` and `docs/skills/launcher.md` to document `turbo-review` alongside existing public recipes.
   - Update `README.md` with usage examples:
     `just turbo-review`
     `just turbo-review sol`
     `just turbo-review projectbluefin/review`
2. **Automated Testing in `tests/just-onboarding.sh`**:
   - Test `just turbo-review` happy path with mocked kubectl: verifies scale to 3, secret synchronization, and invocation of dashboard.
   - Test `just turbo-review` without kubectl: verifies fallback warning and successful continuation to `review-queue`.
   - Test exit trap and ready replica reporting.
