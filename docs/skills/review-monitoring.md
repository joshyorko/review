---
name: review-monitoring
version: "1.0"
last_updated: 2026-09-07
id: review-monitoring
one_line_purpose: Monitor running review containers, landing batch execution, and container health.
entry_point: docs/skills/review-monitoring.md
category: ci-ops
status: active
tags: [monitoring, container, review, landings, queue]
description: "Use when observing, diagnosing, or monitoring running review-queue or review-container instances, landing batches, or agent process health."
metadata:
  type: procedure
  context7-sources: [/websites/podman_io_en]
---

# Review Container & Queue Monitoring

> Continuous, non-blocking observability into active review appliances,
> background landing batches, and agent health without static queue anti-patterns.

## When to Use

Use when:
- Inspecting active `review-queue` or `review-container` execution and process trees.
- Monitoring automated batch landing progress across `${XDG_STATE_HOME}/bluefin-review/landings/`.
- Diagnosing stuck landing agents, runaway CI watches, or subagent starvation.
- Auditing container state mounts, permissions, and log output.

## When Not to Use

Do not use for:
- Initial container launch or justfile recipe authoring (`launcher.md`).
- Primary TUI keybindings or review cockpit display (`review-dashboard.md`).
- Multi-worker cluster distribution (`cluster-workers.md`).

## Core Architecture & Observability

### 1. Active Container Discovery

Never inspect static queue artifacts. Probe live container state directly:

```bash
# Check running review container instances and owners
podman ps --filter "name=review-" --format "{{.ID}} {{.Names}} {{.Status}} {{.Image}}"

# Inspect runtime processes inside the appliance
podman top review-queue

# Read container mount bindings
podman inspect review-queue --format '{{json .Mounts}}' | jq .
```

### 2. Batch Landing Stream

Landing state persists under `${XDG_STATE_HOME:-~/.local/state}/bluefin-review/landings/`:
- `<id>.prompt.md`: The brief dispatched to the landing agent.
- `<id>.jsonl`: Ordered append-only event stream updated by `landing.py report`.
- `<id>.log`: Stdout and stderr from the agent process.

Monitor batch state live without modifying files:

```bash
# Stream latest batch status events
tail -f "${XDG_STATE_HOME:-$HOME/.local/state}/bluefin-review/landings/"*.jsonl

# Monitor agent log output
tail -n 50 -f "${XDG_STATE_HOME:-$HOME/.local/state}/bluefin-review/landings/"*.log
```

### 3. Agent Health & Diagnostics

Landing agents execute headless (`goose run --no-session -i <prompt>`).
Common health failure modes to detect:
1. **Synchronous CI Blockers:** Agent executing long-running `gh run watch` instead of polling `publish-verdict`.
2. **Permission Denied on Logs:** Missing user ownership on `/home/dev/.local/state` causing Goose logging failures.
3. **Partitioning Starvation:** Multiple repositories packed into a single task instead of concurrent per-repo lanes.

### 4. Continuous Monitoring Loop

For monitoring all night or across long batch runs:
1. Poll `podman ps` and `podman top review-queue` on a 30-60s interval.
2. Check for newly spawned landing tasks in the state directory.
3. Track active subagent commands for timeouts or hung external calls (`gh run watch`).
4. File actionable findings with reproducible evidence to the repository issue tracker.

## Showing Concurrency

Mass review runs unattended, so the interface has one job while nobody is
watching: say what is running, how much capacity exists, and how old the
answer is.

Local work and Hive work are **two separate displays and must never be
conflated**. Local review and landing lanes are the dashboard's own processes;
the Hive fleet is other machines running contributor tasks the dashboard does
not control. A maintainer who reads one as the other will size a batch against
capacity that is not theirs.

```text
Reviews:  4 active / 6 capacity · 11 queued · 2 retrying
Landings: 2 active / 6 capacity · 3 queued
Hive:     7 workers · 5 busy · queue 23            (as of 12s ago)
```

Show the **effective** capacity, not the configured one. Capacity resolves to
the minimum of every bound that applies, so a run throttled to two slots on a
small machine must say two — otherwise a correctly throttled scheduler and a
broken one look identical.

Every panel sourced from a remote carries its age. The dangerous failure for
an unattended display is not an outage; it is hours-old state rendered as
though it were current. Data that cannot be refreshed degrades visibly rather
than sitting there looking fine.

Local panels are always present. The Hive panel is absent when no hub is
configured — `just review-queue org/repo` against a repository with no Hive at
all is a first-class path, never a degraded one.

Hive's own observation endpoints are the source for the fleet panel:
`/api/contribute/fleet` and `/api/contribute/queue` are current truth, and
`/api/contribute/events` is a low-latency notification stream, not a
replacement for them. The stream drops events for a subscriber whose channel
is full **without disconnecting it**, so a client that trusts the stream alone
misses activity silently. Reconcile against a snapshot on a timer, and treat
prolonged byte-level silence as a reconnect trigger rather than as quiet.

## Common Rationalizations

| Rationalization | Reality |
|---|---|
| "Read static queue.json to monitor state." | Static JSON is an antipattern. Inspect live container, GitHub, and landing JSONL. |
| "Kill the container when agent is quiet." | Agents may be waiting on legitimate image builds or CI checks; verify processes first. |
| "One concurrency number is simpler." | Local lanes and the Hive fleet are different machines under different authority. One number invites sizing a batch against capacity you do not own. |
| "Show the configured cap." | Capacity is the minimum of every bound. A silently throttled run and a broken scheduler look the same unless the effective cap is shown. |
| "SSE is connected, so the view is current." | A full subscriber channel drops events without disconnecting. Reconcile against `/fleet` and `/queue`. |

## Red Flags

- Scraping agent console output instead of reading structured JSONL status.
- Polling static files or mocking state when the live container is accessible.
- Ignoring permission errors in agent logs as harmless noise.
- Remote-sourced state rendered without its age.
- Local lanes and Hive fleet counts shown as one number.
