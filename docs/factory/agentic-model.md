# Review + Luna Factory Agentic Model

This document defines the local product and authority boundaries for Review and Luna Factory. Read it after `AGENTS.md` and before the task-specific guide.

## Product and roles

| Component | Responsibility | Authority |
|---|---|---|
| **GitHub** | Repository, issue, pull-request, check, permission, and merge state. | The authenticated credential and live repository rules decide what can be read or changed. |
| **Review** | Generic GitHub queue, bounded evidence, review/repair coordination, and durable human intent. | Projects `owner/repo` or `org:<name>` explicitly; it never guesses an organization from this fork. |
| **OMP** | Sessions, model resolution, agents, tasks, tools, workflowz execution, and cancellation. | Runs only through the user's active OMP configuration and the packaged capability boundary. |
| **Luna Factory** | Optional bounded native workers, evidence reconciliation, claims, and task state. | Execution is opt-in; visibility in Review is not admission. Completion grants no merge, publish, or deploy authority. |
| **Human operator** | Scope, policy, and mutating intent. | Reviewers remain read-only; a confirmed action delegates only its bounded lifecycle. |
| **Optional Hive read-side** | Explicitly configured ordering/status context for users who select Hive mode. | Read-side facts do not assign work, grant GitHub permissions, or create Factory admission. |

The normal workbench is GitHub-only Review. It does not require Hive, contributor registration, Bluefin labels, organization policy, or an organization-specific MCP server. `REVIEW_MODE=hive` opts into the optional read-side integration; `HIVE_HUB` must be supplied explicitly. The default path performs no Hive fetch or contributor-registration discovery.

## Scope and evidence

Review scope follows explicit operator intent: an explicit repository/organization, a restored explicit Review scope, `REVIEW_DEFAULT_SCOPE`, then an interactive choice. Headless callers must provide `owner/repo` or `org:<name>`. Never infer an organization from repository ancestry, login identity, or historical defaults.

GitHub owns current state. A queue row is an observation, not a task assignment. Before any mutation, preserve the relevant item identity and exact head, refresh live evidence and permissions, and refuse stale or mismatched subjects. An absent permission or required check remains a real gate; optional Hive context cannot bypass it.

## Review and Factory separation

Review is the source and observation front-end. Review specialist agents return evidence and recommendations; they have no comment, approval, push, or merge capability. Human-confirmed Slay intent may authorize a bounded coordinator lifecycle, subject to the existing live permission, exact-head, ruleset, mutation-claim, and no-self-review safeguards.

Luna Factory is a separate execution controller co-loaded with Review. Loading it starts nothing. `LUNA_FACTORY_ENABLED=1` is required for work. Its admission, task state, evidence, worker receipts, retry lineage, and claims are Factory-owned. A queue row or Hive rank is never an admission signal. Factory completion never creates GitHub landing or deployment authority.

## Factory proof and task state

- Attempts retain durable identity and history. A returned worker is not success; the owner enters verification and checks the receipt against the current task, attempt, generation, and subject.
- Proof is subject-bound. Integration changes the subject and makes affected old proof stale; explicitly unaffected evidence may remain valid.
- Contradictory identity or an artifact reference outside the run's allowed roots is rejected. Missing, stale, or ambiguous evidence is reported as blocked/unknown, never promoted to success.
- `CONVERGED` means every mandatory acceptance criterion has current valid proof. `QUIESCENT` means no authorized autonomous progress remains; it may still be unconverged. An empty queue, exhausted budget, or returned worker implies neither.
- A failed check reopens the same admitted task for bounded repair. Preserve attempt lineage; a new worker or commit does not reset it. New observations are candidates and require independent admission.
- Claims enforce single-writer/resource exclusion across Review and Factory work. Stop and cancellation do not imply rollback or release until the external effect is known.

## Selected batches and runtime

A selected batch is a finite OMP operation, not a daemon. Run-once exits when work completes or an honest blocker is reached. Retained runs keep their journal, patches, logs, and native artifacts available for inspect, resume, pause, stop, export, or explicit discard. The same-host state root is authoritative for ownership and recovery.

The capacity bound includes native workers, retries, verification, and reviewer work without globally disabling unrelated Review work. OCI, Apptainer SIF/FUSE, and krun/KVM are distinct containment boundaries. Remote, gateway, and distributed workers remain unsupported unless their capability is demonstrated by the packaged runtime; never claim absent runtime evidence.

The launcher remains foreground and signal-responsive. It prefers Podman with `krun`/KVM and reports a missing prerequisite before isolated Apptainer fallback. Host OMP configuration is isolated unless explicitly requested. Credentials remain environment inputs and never enter argv, logs, or image layers.

## Documentation and verification

Code and tests define implementation behavior; this model and the matching skill define the local agent-facing contract. Keep the contract aligned with the actual launcher, appliance, tests, and OMP capability probes. Run the focused Review/Factory and appliance checks for the changed surface, and distinguish local evidence from hosted/runtime evidence.

Historical paths and package aliases may remain for the current personal install path. They do not define product identity. No fork-network detachment, repository recreation, or history rewrite is part of this product boundary.
