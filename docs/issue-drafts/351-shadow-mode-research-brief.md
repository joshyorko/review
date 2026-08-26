Conduct a thorough, adversarial, primary-source-backed product and architecture investigation for:

https://github.com/projectbluefin/review/issues/351

Working product name: **Shadow Mode**

Do not treat this as “add an AI agent to the application.” Determine how Shadow Mode can become a first-class Review capability that remains useful even when no model is called.

This turn is research and issue-design only:

* Do not implement code.
* Do not create branches, pull requests, issues, subissues, comments, or repository files.
* Do not update #351 yet.
* First present the research, ownership reconciliation, recommended design, and complete proposed replacement issue body.
* Wait for my explicit approval before changing GitHub.
* Do not ask preliminary questions unless access is genuinely blocked; make reasonable assumptions and label them.

## Product thesis

Shadow Mode should watch how Review itself is used, detect errors, regressions, repeated friction, and suspicious workflow patterns, reproduce them inside an isolated shadow instance, prepare and verify a repair, and return a trustworthy improvement for explicit human approval.

It has two cooperating subsystems:

* **Shadow Observer:** structured instrumentation, deterministic detectors, scheduled analysis, push/release correlation, deduplication, budgets, and the Improvement Inbox.
* **Shadow Repair Loop:** exact-revision reproduction, isolated gVisor execution, patch generation, deterministic verification, preview, cleanup, and human-gated promotion.

Manual “fix this” capture is one trigger. Automatic observation is equally central and must remain within issue #351. Do not split this into another issue.

The intended product journey is:

1. A developer clones one repository.
2. They run Review locally without deploying Hive.
3. Review presents work and safely executes agents through Jorge’s Dagger-style gRPC engine.
4. Shadow Mode makes Review rapidly improve while it is being dogfooded.
5. As the user accumulates repositories, concurrency, remote-compute needs, or unattended work, they connect the same Review experience to Hive.
6. Hive adds authoritative fleet coordination and scale without forcing the user to adopt a different maintainer interface.

Shadow Mode must strengthen that progression. It must not become a second scheduler or “mini-Hive” that competes with Hive’s authority.

## Required live GitHub investigation

Inspect the current repository state rather than relying on this prompt’s summaries.

Read and reconcile:

* issue #351 as it exists when you begin;
* the complete Review V2 issue and PR graph;
* open and recently closed issues and pull requests that intersect execution, lifecycle, evidence, TUI, screenshots, GitHub mutation, harnesses, Hive, MCP, containers, gVisor, replay, resumability, or developer experience;
* current branches and newly visible work from Jorge involving Dagger, gRPC, containers, engines, or remote execution;
* PR #349 and its exact-head security handoff;
* at minimum #119, #167, #173, #183, #184, #188, #196, #255, #346, #348, #349, and #351;
* any issue that supersedes, narrows, or materially changes those boundaries.

Read the current canonical repository contracts, including at least:

* `README.md`
* `AGENTS.md`
* `docs/factory/agentic-model.md`
* `docs/skills/review-dashboard.md`
* `docs/skills/hive-runtime.md`
* `docs/skills/launcher.md`
* relevant evidence, ReviewRun, adapter, image, queue, security, and testing documentation
* the actual TUI, launcher, ReviewRun, engine, event, and Pilot code where necessary to validate what already exists

Produce an ownership map showing:

* existing owner;
* behavior it owns;
* what Shadow Mode may reuse;
* what Shadow Mode must not duplicate;
* whether the relationship is dependency, extension, conflict, or historical precedent;
* what canonical documentation would eventually need to change.

Do not invent Jorge’s engine API. If his work is not public yet, state that clearly and keep #351 blocked on the public contract.

## External research

Use current primary sources wherever possible. Research the relevant patterns, not merely products with similar marketing.

At minimum examine:

### Dagger

Study official Dagger documentation, architecture, engine/client separation, local-to-remote execution symmetry, caching, structured operations, services, observability, secrets, interactive debugging, and agent-oriented workflows.

Review relevant first-party talks or writing from Solomon Hykes and the Dagger team when available.

Determine which Dagger principles fit Review and which would be cargo culting.

Important distinction: Jorge may be borrowing Dagger’s product and engine shape while independently choosing gRPC. Do not claim Dagger itself uses gRPC unless primary evidence proves that.

### Sentry-like observation

Study official Sentry documentation for error capture, tracing, session replay, issue grouping, regression detection, releases, suspect changes, privacy controls, sampling, retention, and any current AI-assisted diagnosis or remediation features.

Extract useful patterns without turning Review into application-performance-monitoring infrastructure or requiring a hosted telemetry service.

### OpenTelemetry and structured evidence

Study current official OpenTelemetry specifications and semantic conventions relevant to:

* traces, spans, events, logs, baggage, resource identity, and correlation;
* local-first collection;
* sampling;
* redaction;
* bounded retention;
* exact build/revision identity.

Determine whether Review should emit standard OTel data, a compact Review-native event envelope, or both. Favor the smallest interoperable choice.

### Record/replay and shadow environments

Study authoritative material for:

* deterministic record/replay;
* ephemeral preview environments;
* shadow testing or shadow traffic;
* canary validation;
* visual regression testing;
* exact-revision reproduction;
* failure-capsule or reproduction-bundle patterns.

Distinguish replaying structured Review behavior from copying production state or credentials.

### Agent repair systems

Examine credible first-party systems or research that automatically diagnose, patch, test, and prepare software changes.

Look specifically for lessons concerning:

* false positives;
* benchmark overfitting;
* unverifiable “fixes”;
* unsafe permissions;
* cost growth;
* repeated duplicate attempts;
* human review burden;
* trust receipts;
* rollback and recurrence detection.

Do not overstate Shadow Mode’s novelty. Identify adjacent prior art and then explain precisely what combination or product boundary may be distinctive.

### Relevant Review dependencies

Use authoritative documentation and repositories for:

* gVisor/`runsc`;
* Podman runtime selection and inspection;
* Textual and Pilot;
* Goose lifecycle/resumability;
* GitHub exact-head mutation and draft-PR workflows;
* Hive’s current assignment, queue, contributor, governor, and remote-execution boundaries.

## Central research question

Determine whether Shadow Mode can become a coherent product primitive with this contract:

> The application captures enough structured context to reproduce its own failure or friction safely, repairs only an isolated exact-revision shadow, proves the candidate, and asks a human whether to promote it.

Challenge this contract. Identify where it could become:

* surveillance;
* expensive noise;
* a self-modifying security hazard;
* an untrustworthy AI demo;
* a second workflow engine;
* a duplicate scheduler;
* an endless source of low-value PRs;
* a feature that requires more maintainer attention than it saves.

Then design those failure modes out of the product.

## First-class product requirements

The recommendation must optimize all six properties together:

### 1. Innovative

Shadow Mode should create a capability users cannot get merely by opening a chat window beside Review.

It should exploit application-native context:

* typed state transitions;
* exact revision and image identity;
* engine lifecycle events;
* reproducible fixtures;
* verification commands;
* visual evidence;
* candidate replay;
* post-push recurrence detection.

Identify the true product innovation without relying on vague “self-healing” language.

### 2. Intuitive

A new user should understand Shadow Mode without learning agent orchestration.

Research and recommend:

* the best user-facing name;
* whether **Shadow Mode** is sufficiently clear;
* alternative names only if materially better;
* the smallest onboarding;
* the `off`, `observe`, and `repair` mental model;
* manual “fix this” capture;
* how automatic findings appear;
* the Improvement Inbox;
* preview, accept, snooze, mute, discard, open-issue, and prepare-draft-PR actions;
* how the product explains what it observed and why it acted;
* how it avoids notification fatigue.

Do not design a sprawling settings panel.

### 3. Easy to run

Prefer local-first operation using the engine and capabilities Review already needs.

Avoid requiring:

* Kubernetes;
* Hive;
* a hosted telemetry backend;
* a permanently privileged sidecar;
* a second daemon or scheduler when the engine already owns lifecycle;
* a new database unless evidence proves it necessary;
* additional credentials for ordinary observation.

Determine the smallest durable local state needed and how it migrates safely.

### 4. Cheap to produce

Reuse existing Review primitives wherever appropriate:

* Jorge’s Dagger-style gRPC engine;
* ReviewRun lifecycle and continuation evidence;
* TUI action/state registry;
* exact-head evidence;
* GitHub confirmation gate;
* Textual Pilot;
* screenshots and decision cards;
* gVisor launch policy;
* existing local state and receipts.

The design should be independently landable through small PRs while one issue owns the complete outcome.

Identify the hot files, expected new boundaries, and likely implementation sequence, but do not write an implementation plan or code.

### 5. Cheap to consume

Design an explicit cost-control system:

* deterministic detectors before model calls;
* event-driven analysis for definite failures;
* compact analysis at session end or after bounded idle;
* scheduled aggregation rather than constant inference;
* confidence thresholds;
* sampling;
* deduplication;
* cooldowns;
* concurrency limits;
* token and runtime budgets;
* cheap-model routing where sufficient;
* caching by exact evidence identity;
* escalation only when uncertainty or impact warrants it;
* automatic candidate generation only under the `repair` policy.

Propose understandable defaults.

Estimate cost drivers and define what should be measurable. Do not invent pricing without current authoritative sources and explicit assumptions.

### 6. Trustworthy

Trust is the primary acceptance criterion.

Require:

* local-first, bounded, schema-versioned evidence;
* explicit data inventory;
* redaction before persistence or model access;
* no raw keylogging;
* no indiscriminate prompt, terminal, source, credential, or production-data capture;
* exact commit and image provenance;
* no writable sharing with the live session;
* no live Hive assignment token or production credential in the shadow;
* fail-closed gVisor/`runsc`;
* reproduction before editing;
* deterministic verification;
* before/after evidence for visual changes;
* complete candidate receipt;
* visible cost;
* safe cancellation and cleanup;
* no hot-patching the running session;
* no autonomous GitHub write, approval, merge, deployment, or release;
* explicit human promotion;
* post-push replay and recurrence status;
* a kill switch and `off` policy;
* explainable detector and confidence;
* snooze and mute controls;
* auditable reasons for every automatic investigation.

Create a concise threat model covering:

* assets;
* trust boundaries;
* attacker or failure cases;
* credential exposure;
* malicious repository content;
* prompt injection through logs or screenshots;
* poisoned reproduction bundles;
* sandbox escape;
* event tampering;
* candidate substitution;
* stale-head promotion;
* denial-of-wallet/token exhaustion;
* privacy leakage;
* repair loops that repeatedly repair their own previous repair.

Tie mitigations to existing Review boundaries where possible.

## AI must be optional infrastructure, not the product foundation

Design Shadow Mode so several valuable behaviors work without any model:

* exact event capture;
* deterministic error detection;
* release regression correlation;
* finding grouping and recurrence counting;
* reproduction capsule creation;
* test replay;
* cleanup validation;
* improvement-card creation for proven failures.

Use models only where semantic judgment is genuinely valuable:

* interpreting ambiguous friction;
* deriving a reproduction strategy;
* proposing a patch;
* explaining evidence;
* deciding whether two non-identical findings are related when deterministic grouping is insufficient.

A model-generated suspicion is not proof. Clearly separate:

* observed;
* inferred;
* reproduced;
* patched;
* verified;
* promoted;
* resolved after push.

## Local-to-Hive gateway

Treat standalone Review as the first rung of adoption and Hive as the scale transition.

Research and specify:

* what Shadow Mode can do entirely within one local repository;
* how the same client and evidence model can target remote execution later;
* which responsibilities always remain with Review;
* which become Hive responsibilities at fleet scale;
* how Hive remains authoritative for task selection and assignment;
* how Review avoids becoming a second scheduler;
* what user pain naturally signals readiness for Hive;
* how connecting Hive should make the existing experience more powerful rather than replace it;
* how remote execution preserves the same trust receipt and human authority.

Do not turn the issue into a Hive deployment feature or marketing funnel. Define a technically honest progression.

## Observation and scheduling model

Recommend a concrete trigger model covering:

1. Manual “fix this” with note and optional screenshot.
2. Immediate deterministic detection for crashes, timeouts, invalid transitions, cleanup failures, leaked resources, repeated command failures, and security invariant failures.
3. Session-completion or bounded-idle analysis.
4. Scheduled aggregation across sessions.
5. New commit, push, image, or release comparison.
6. Candidate replay against the originating evidence.
7. Post-merge or post-release recurrence monitoring.

Define the minimum structured events each trigger requires.

Recommend safe defaults for:

* local retention;
* idle delay;
* aggregate schedule;
* repair concurrency;
* token budget;
* finding cooldown;
* deduplication key;
* confidence threshold;
* automatic investigation;
* post-push observation window.

Label every proposed number as a recommendation or hypothesis unless supported by repository evidence.

## Improvement Inbox and trust receipt

Design the Improvement Inbox as a maintainer decision surface, not another noisy agent feed.

Each card should make clear:

* what happened;
* how often;
* on which exact revisions;
* what is observed versus inferred;
* why Shadow Mode considered it important;
* what data it used;
* whether it reproduced;
* whether it produced a candidate;
* what changed;
* what verification passed or failed;
* before/after evidence;
* cost;
* whether it recurred after a push;
* what human actions are available.

Recommend a concise default card with expandable evidence. Preserve Review’s existing explicit human-confirmation philosophy.

## Evaluation and success criteria

Propose measurable product and safety metrics, including:

* time from first occurrence to useful finding;
* reproduction success rate;
* candidate verification rate;
* candidate acceptance rate;
* false-positive and duplicate-finding rates;
* maintainer time saved versus attention consumed;
* cost per observed session;
* cost per investigated finding;
* cost per accepted repair;
* percentage handled deterministically;
* cleanup success;
* credential/redaction failures;
* recurrence after accepted repairs;
* Shadow Mode disable/mute rates;
* standalone-to-Hive compatibility.

Define dogfood scenarios using real Review failure classes without requiring a fabricated production incident.

Include explicit kill or redesign criteria. For example, the feature should not advance to automatic repair if it cannot keep false positives, cleanup failures, evidence leakage, or attention cost within an acceptable documented boundary.

## Naming research

Treat **Shadow Mode** as the preferred working name, not an immutable conclusion.

Evaluate it against:

* immediate comprehension;
* relationship to the isolated shadow instance;
* ability to include observation and automatic repair;
* risk of implying hidden surveillance;
* existing industry meanings or major product collisions;
* fit with Project Bluefin and Review’s maintainer culture;
* CLI/TUI readability;
* component naming.

If retained, use:

* **Shadow Mode** — complete feature;
* **Shadow Observer** — observation, detection, schedules, correlation, and budgets;
* **Shadow Repair Loop** — isolated reproduction, patching, testing, preview, and cleanup;
* **Improvement Inbox** — human decision surface.

Recommend a replacement only if it is clearly stronger.

## Required deliverables

Return the following in this order:

### 1. Direct executive answer

Explain whether this is a coherent first-class product feature, what makes it valuable, what makes it different from generic AI assistance, and the biggest reason it could fail.

### 2. Live ownership and dependency map

Use a compact table covering the relevant Review issues, PRs, files, and upstream boundaries. Link directly to sources.

### 3. Prior-art and differentiation matrix

Compare Shadow Mode with the most relevant external patterns. Identify what to borrow, what to avoid, and what remains distinctive.

### 4. Recommended product contract

State the user promise, authority boundary, operating modes, trigger model, data model, lifecycle, cost controls, and trust contract.

### 5. Architecture

Provide one compact Mermaid diagram showing:

* live Review;
* structured event stream;
* Shadow Observer;
* policy/budget decision;
* Shadow Repair Loop;
* Improvement Inbox;
* human confirmation;
* local engine and optional Hive-backed execution.

Do not invent unverified engine methods.

### 6. UX journey

Walk through:

* first run;
* manual capture;
* automatic finding;
* automatic investigation;
* candidate preview;
* accept/snooze/mute/discard;
* post-push verification;
* eventual Hive connection.

### 7. Security and privacy analysis

Provide the concise threat model and required mitigations.

### 8. Cost model

Identify production and consumption cost drivers, safe defaults, budget controls, and metrics.

### 9. Delivery shape

Keep #351 as the sole owning issue. Recommend independently reviewable PR slices inside it, dependency order, verification checkpoints, and which work can proceed in parallel after Jorge’s public engine contract exists.

### 10. Complete proposed replacement body for #351

Produce a polished, agent-ready GitHub issue body that:

* uses the final recommended name;
* is concise enough to function as a durable issue rather than a research paper;
* incorporates the whole Shadow Mode feature;
* includes one useful Mermaid diagram;
* defines first-class product principles;
* explains standalone Review and the Hive graduation path;
* includes operating modes;
* defines triggers, schedules, pushes, evidence, budgets, the Improvement Inbox, the Shadow Repair Loop, trust boundaries, non-goals, implementation slices, and full acceptance criteria;
* preserves correct existing issue relationships;
* links Jorge’s public Dagger/gRPC work only if it actually exists;
* retains the `blocked` dependency while appropriate;
* does not split automatic observation into another issue;
* does not describe AI as the product foundation;
* does not authorize implementation before unresolved engine ownership is reconciled.

### 11. Recommended GitHub metadata

Recommend the final title, existing labels, classification, and any dependency note. Do not invent labels.

### 12. Critical self-review

Before presenting the result, challenge your own proposed issue:

* Is this secretly two execution architectures?
* Does it duplicate Hive?
* Is it too large to be agent-ready even with PR slices?
* Does it require constant model usage?
* Could it surveil users?
* Can it prove a fix rather than merely claim one?
* Can a malicious repo manipulate its observer or repair agent?
* Does it preserve exact-head human authority?
* Is the standalone-to-Hive progression technically real?
* Is every major requirement testable?

Resolve contradictions in the final proposed issue rather than merely listing them.

## Evidence and citation requirements

* Use current primary and authoritative sources whenever available.
* Link claims directly to the relevant repository file, issue, PR, specification, documentation page, or first-party talk.
* Distinguish sourced fact, repository evidence, design recommendation, inference, and unresolved uncertainty.
* Verify dates, current issue state, merged/open status, exact heads, and product behavior at research time.
* Do not cite search-result pages.
* Do not overquote sources.
* Do not present inaccessible private work as fact.
* Clearly state when Jorge’s unpublished implementation prevents an exact conclusion.
* Stop when the key ownership, product, architecture, cost, trust, and differentiation questions are sufficiently evidenced; do not pad the report with redundant sources.

At the end, ask me to approve or revise the proposed #351 replacement. Do not update GitHub until I explicitly tell you to proceed.
