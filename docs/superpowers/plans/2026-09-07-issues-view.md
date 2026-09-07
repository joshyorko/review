# Issues View & Triage Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task.

**Goal:** Implement an issues view and triage capability in the maintainer review dashboard (`image/tui/bluefin_review_tui.py`), allowing maintainers to toggle between open pull requests and open issues via `Tab`, inspect issue details/body, and triage issues directly (comment, close, browser view, copy handoff).

**Architecture:** The dashboard remains the live GitHub reader and human decision point. When toggled to issues view (`view_mode == "issues"`), the dashboard queries live open issues via GitHub GraphQL (or repo-scoped live queries), renders issue rows in the existing queue pane, displays issue metadata and markdown body in the details pane, and maps triage keystrokes (`c` for comment, `x` for close with comment, `o` for web view, `y` for handoff) through the established `mutate_all()` typed-number confirmation gate.

**Tech Stack:** Python 3 / Textual (pinned in `image/tui/requirements.lock`), `gh` CLI, `tests/dashboard_pilot.py`, `tests/dashboard-contract.sh`.

## Global Constraints

- Every mutation must go through `self.mutate_all()` and confirm with the typed issue number; `gh()` remains strictly read-only.
- No `--admin`, `--delete-branch`, or force actions may be added; `tests/dashboard-contract.sh` must remain green.
- Exactly two `subprocess.run` and two `subprocess.Popen` sites in `image/tui/bluefin_review_tui.py`.
- No DOM access inside `@work(thread=True)` workers; all UI mutations dispatch through `self.call_from_thread()`.
- Textual markup must be escaped using `escape()` on all GitHub-sourced text (titles, bodies, labels).
- Preserve existing PR review workflows, landing batch orchestration, and key bindings without regressions.
- Each commit uses trailer: `Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>`.

---

## Task 1: Add semantic action and command specs for view toggle

**Files:**
- Modify: `image/tui/semantic_view.py`
- Modify: `tests/semantic_view_contract.py`
- Modify: `image/tui/bluefin_review_tui.py`
- Test: `python3 tests/semantic_view_contract.py`

---

## Task 2: Implement issues queue fetching, rendering, view toggling, and triage mutations

**Files:**
- Modify: `image/tui/bluefin_review_tui.py`
- Test: `python3 -m py_compile image/tui/bluefin_review_tui.py`

---

## Task 3: Pilot tests, documentation, and contract validation

**Files:**
- Modify: `tests/dashboard_pilot.py`
- Modify: `docs/skills/review-dashboard.md`
- Run: `bash scripts/check-skill-frontmatter.sh --write`
- Test: `bash tests/dashboard-contract.sh`
