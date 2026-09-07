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

## Common Rationalizations

| Rationalization | Reality |
|---|---|
| "Read static queue.json to monitor state." | Static JSON is an antipattern. Inspect live container, GitHub, and landing JSONL. |
| "Kill the container when agent is quiet." | Agents may be waiting on legitimate image builds or CI checks; verify processes first. |

## Red Flags

- Scraping agent console output instead of reading structured JSONL status.
- Polling static files or mocking state when the live container is accessible.
- Ignoring permission errors in agent logs as harmless noise.
