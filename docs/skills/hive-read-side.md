---
name: hive-read-side
version: "1.0"
last_updated: 2026-09-23
id: hive-read-side
one_line_purpose: Maintain Review's explicit optional Hive read-side integration.
entry_point: docs/skills/hive-read-side.md
category: ci-ops
status: active
tags: [hive, review, read-side, configuration]
description: "Documents the optional Hive projections available only when Review mode and HIVE_HUB are explicitly selected."
metadata:
  type: runbook
  context7-sources: []
---

# Optional Hive Read-Side Integration

Review is GitHub-only by default. Use this guide only when maintaining or deliberately using the optional Hive read-side integration. The implementation lives in `image/extension/bluefin-review/hive.ts`, `mode.ts`, and `tools.ts`.

## Opt in explicitly

Set both `REVIEW_MODE=hive` and `HIVE_HUB` for the session. The hub URL is configuration, not a default. Do not discover it from `~/.config/hive/contributor.env`, infer it from an organization, or restore an implicit endpoint. If configuration is absent or the read fails, report that condition without disabling GitHub Review.

```bash
REVIEW_MODE=hive HIVE_HUB=https://hive.example bin/omp-review acme/widgets
```

The explicit mode may show Hive ordering, status, triage, or curated read-side context supported by the current API. It does not assign, complete, retry, or mutate Hive work. It does not provide a contributor runtime, tmux session, or worker credential protocol.

## Preserve the boundary

- Normal Review mode performs no Hive fetch, discovery, or Hive-only queue filtering.
- Hive tools and Hive-specific controls are registered only in explicit Hive mode.
- Hive data never grants GitHub permissions or Factory admission.
- Do not restore a Project Bluefin endpoint, policy, label rule, or required MCP server.
- Keep API failures visible and distinguish unavailable Hive context from empty GitHub results.

## Verification

```bash
bash tests/omp-review-mode.sh
```

The focused contract includes explicit-Hive behavior and proves that normal Review ignores inherited `HIVE_HUB` and contributor-registration files.
