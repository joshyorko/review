# Turbo Review v2 Batch Engine Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a maintainer select live pull requests, review them concurrently within measured local headroom or an optional session-scoped Kubernetes broker, reuse exact-head analysis from a bounded cache, and perform only explicitly confirmed bulk mutations.

**Architecture:** The dashboard remains the live GitHub reader and human decision point. A fail-closed batch snapshot creates canonical `ReviewRun` identities, `ReviewEngine` schedules one isolated worktree per PR through the existing Goose or Codex harness, `ReviewCache` stores analysis only, and `BrokerExecutor` is an optional transport whose failure falls back to `LocalExecutor` per PR. The host launcher owns the broker, Kubernetes credentials, consent, and socket handoff; the container never receives kubeconfig, `kubectl`, or a static queue artifact.

**Tech Stack:** Python 3 / Textual 8.2.8 (hash-locked image/tui/requirements.lock), bash justfile launcher, podman, kubectl Jobs, pytest-style pilot via tests/dashboard_pilot.py

## Global Constraints

- No `--admin`, force, branch-delete, or branch-push path may be introduced; `tests/dashboard-contract.sh` remains the executable absence contract.
- Every mutating action stays behind one typed confirmation gate; a batch gate confirms the exact `repo#number@head-sha` list, never a count or a yes/no response.
- Cluster execution is optional and non-blocking: no context, declined consent, broker failure, unreachable cluster, or failed Job must prevent local review.
- GitHub remains authoritative and all queue, evidence, head, check, and triage reads are live; no static queue artifact may be created or consumed.
- The cache stores analysis only. CI, mergeability, reviews, overlaps, and all other mutable evidence are fetched live before a decision card or mutation.
- Local review slots are `min(floor((MemAvailable - reserve) / per_review_budget), cores // 2, BLUEFIN_REVIEW_CONCURRENT_REVIEWS)` floored at zero; running reviews are never killed for a later capacity change.
- The resource governor is named `CapacityGovernor` and lives only in the new `image/tui/capacity.py`; it never shares the existing Headroom subsystem's name or file.
- The existing five image-owned review checks and build-time skill generation remain separate and unchanged; compact-output instructions reuse `CAVEMAN_INSTRUCTIONS`.
- The existing token-routing subsystem remains in `image/tui/headroom.py`; `CapacityGovernor` is a separate resource governor in `image/tui/capacity.py` and must not be moved into or renamed after Headroom.
- No new linter or test runner is added to the image. Use the repository validation commands in `AGENTS.md`; after the broker replacement, the deleted lab-contract command is replaced by `python3 tests/review-exec-broker-contract.py`.
- Keep Textual DOM work on the UI thread; worker threads communicate with `call_from_thread`, following `docs/skills/review-dashboard.md` and the existing `ReviewScreen` pattern at `image/tui/bluefin_review_tui.py:1909-2085`.
- Preserve both `goose` and `codex` backends through `HarnessRegistry`, `GooseHarness`, `CodexHarness`, and `ReviewRun`; do not add a backend-specific engine fork.
- Preserve the existing landing lane (`A`/`w`) and its JSONL/flock/torn-tail behavior; the review lane gets a separate state directory and does not alter landing semantics.
- Documentation is part of the implementation. Update the canonical surfaces in the same batch and regenerate `docs/skills/index.json` with `bash scripts/check-skill-frontmatter.sh --write`; do not commit generated `.agents/skills/`.
- Each implementation commit uses the exact trailer `Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>`.

---

## Task 1: Add the versioned result receipt and receipt-mode CLI

**Files:**
- Create: `image/tui/review_receipt.py`
- Modify: `image/bin/bluefin-review:9-18, 513-547` to add the `receipt` subcommand without changing the existing local-range or human-readable `pr` output.
- Modify: `image/review-scope/REVIEW.md` to add the compact-output contract inherited by all five checks.
- Test: `tests/review_receipt_contract.py`
- Modify: `tests/bluefin-review.sh:1-160` to prove receipt mode is machine-readable and preserves the existing human mode.
- Test: `tests/review_receipt_contract.py`, `tests/bluefin-review.sh`, `tests/image-contract.sh`.

**Existing interfaces to consume:**
- `ReviewRun` and its canonical identity at `image/tui/review_run.py:111-165`.
- `ReviewResult`, `parse_review_result`, and bounded raw evidence at `image/tui/review_result.py:58-183`.
- `ReviewRequest` at `image/tui/review_evidence_manifest.py:99-154`.
- `HarnessRegistry`, `GooseHarness.stream`, and `CodexHarness.stream` at `image/harness/registry.py:117-147`, `image/harness/goose.py:27-168`, and `image/harness/codex.py:22-274`.
- `HEADROOM_ENV`, `CAVEMAN_INSTRUCTIONS`, and the existing `HeadroomSession`, `HeadroomRoute`, `refresh`, `route_for_call`, `status_line`, and `apply_caveman` APIs at `image/tui/headroom.py:23-40, 71-106, 231-339`.

**Interfaces produced:**
- `ReceiptIdentity.from_run(run: ReviewRun, check_scope_version: str) -> ReceiptIdentity`.
- `ReceiptIdentity.run_identity -> str`.
- `ReceiptIdentity.cache_identity -> str`.
- `ReviewReceipt.from_result(run: ReviewRun, result: ReviewResult, transcript: Sequence[str], check_scope_version: str, provenance: Mapping[str, Any] | None = None) -> ReviewReceipt`.
- `ReviewReceipt.to_dict() -> dict[str, Any]`.
- `ReviewReceipt.to_json() -> str`.
- `ReviewReceipt.from_dict(data: Mapping[str, Any]) -> ReviewReceipt`.
- `ReviewReceipt.from_json(payload: str) -> ReviewReceipt`.
- `ReviewReceipt.analysis_result(live: Mapping[str, Any] | None = None, overlap: Mapping[str, Any] | None = None) -> ReviewResult`.
- `ReviewReceipt.with_provenance(extra: Mapping[str, Any]) -> ReviewReceipt`.
- `run_receipt(repository: str, pull_request: int, base_sha: str, head_sha: str, backend: str, model: str, effort: str, workdir: str, check_scope_version: str, check_scope: str = "", steer: str = "") -> tuple[ReviewReceipt, int]`.

- [ ] **Step 1: Write the failing receipt contract test.**

```python
# tests/review_receipt_contract.py
import json
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parents[1] / "image"))

from tui.review_evidence_manifest import ReviewRequest
from tui.review_receipt import ReviewReceipt, ReceiptIdentity
from tui.review_result import ReviewResult
from tui.review_run import ReviewRun


class ReceiptContractTests(unittest.TestCase):
    def setUp(self):
        self.request = ReviewRequest(
            "projectbluefin",
            "review",
            372,
            "a" * 40,
            "b" * 40,
            "maintainer",
            "review",
            generated_at="test",
        )
        self.run = ReviewRun.from_request(
            self.request,
            backend="goose",
            model="gemini-3.8-flash",
            effort="high",
        )

    def result(self, backend):
        return ReviewResult(
            1,
            "findings",
            {"critical": 0, "high": 1, "medium": 0, "low": 0},
            [{"severity": "high", "file": "x.py", "line": 7, "title": "unsafe path"}],
            [{"name": "correctness", "state": "verified", "evidence": "one finding"}],
            {"backend": backend, "model": "gemini-3.8-flash"},
            {"duplicates": [9], "shared_files": ["x.py"]},
            {"ci": "failure", "head_sha": "b" * 40},
            ["raw line"],
        )

    def test_goose_receipt_round_trips_and_strips_mutable_evidence(self):
        receipt = ReviewReceipt.from_result(
            self.run,
            self.result("goose"),
            ["goose check line"] * 300,
            "scope-v7",
            {"headroom_status_line": "DIRECT", "headroom_state": "DIRECT"},
        )
        encoded = json.loads(receipt.to_json())
        restored = ReviewReceipt.from_json(receipt.to_json())
        self.assertEqual(encoded["version"], 1)
        self.assertEqual(restored.identity.backend, "goose")
        self.assertEqual(restored.identity.run_identity, self.run.identity)
        self.assertLessEqual(len(restored.transcript), 200)
        self.assertEqual(restored.analysis_result().live, {})
        self.assertEqual(restored.analysis_result().overlap, {})
        self.assertEqual(restored.provenance["headroom_state"], "DIRECT")

    def test_codex_receipt_round_trips_with_a_distinct_canonical_identity(self):
        codex_run = ReviewRun.from_request(
            self.request,
            backend="codex",
            model="gpt-5.6-sol",
            effort="medium",
        )
        receipt = ReviewReceipt.from_result(
            codex_run,
            ReviewResult(
                1,
                "complete",
                {"critical": 0, "high": 0, "medium": 0, "low": 0},
                [],
                [],
                {"backend": "codex", "model": "gpt-5.6-sol"},
                {},
                {},
                [],
            ),
            ["codex terminal"],
            "scope-v7",
        )
        restored = ReviewReceipt.from_json(receipt.to_json())
        self.assertEqual(restored.identity.backend, "codex")
        self.assertEqual(restored.identity.model, "gpt-5.6-sol")
        self.assertEqual(restored.identity.effort, "medium")
        self.assertTrue(restored.analysis_result().is_clean)

    def test_identity_changes_when_scope_version_changes(self):
        first = ReceiptIdentity.from_run(self.run, "scope-v7")
        second = ReceiptIdentity.from_run(self.run, "scope-v8")
        self.assertNotEqual(first.cache_identity, second.cache_identity)

    def test_invalid_receipt_is_rejected(self):
        payload = json.loads(
            ReviewReceipt.from_result(self.run, self.result("goose"), [], "scope-v7").to_json()
        )
        payload["identity"]["head_sha"] = "c" * 40
        with self.assertRaises(ValueError):
            ReviewReceipt.from_dict(payload)


if __name__ == "__main__":
    unittest.main()
```

- [ ] **Step 2: Run the new contract and verify it fails because the module does not exist.**

Run: `python3 tests/review_receipt_contract.py`

Expected: `ModuleNotFoundError: No module named 'tui.review_receipt'`.

- [ ] **Step 3: Implement the receipt schema and both-backend runner.**

```python
# image/tui/review_receipt.py
from __future__ import annotations

import argparse
import json
import os
import re
import sys
from dataclasses import dataclass
from datetime import datetime, timezone
from hashlib import sha256
from pathlib import Path
from typing import Any, Mapping, Sequence

from harness.codex import CodexHarness
from harness.goose import GooseHarness
from harness.registry import Availability
from tui.headroom import HeadroomSession, apply_caveman
from tui.review_evidence_manifest import ReviewRequest
from tui.review_result import ReviewResult
from tui.review_run import ReviewRun

RECEIPT_VERSION = 1
MAX_TRANSCRIPT_LINES = 200
MAX_TRANSCRIPT_CHARS = 60_000
FULL_SHA = re.compile(r"[0-9a-f]{40}\Z")
BACKENDS = frozenset({"goose", "codex"})


def _text(value: object, field: str) -> str:
    if not isinstance(value, str) or not value.strip() or value != value.strip():
        raise ValueError(f"{field} must be a non-empty exact string")
    return value


def _sha(value: object, field: str) -> str:
    if not isinstance(value, str) or not FULL_SHA.fullmatch(value):
        raise ValueError(f"{field} must be a full lowercase SHA")
    return value


def _bounded_transcript(lines: Sequence[str]) -> tuple[str, ...]:
    kept: list[str] = []
    chars = 0
    for line in lines:
        if not isinstance(line, str):
            raise ValueError("transcript lines must be strings")
        if len(kept) == MAX_TRANSCRIPT_LINES:
            break
        remaining = MAX_TRANSCRIPT_CHARS - chars
        if remaining <= 0:
            break
        value = line[:remaining]
        kept.append(value)
        chars += len(value)
        if len(value) != len(line):
            break
    return tuple(kept)


@dataclass(frozen=True)
class ReceiptIdentity:
    repository: str
    pull_request: int
    base_sha: str
    head_sha: str
    backend: str
    model: str
    effort: str
    check_scope_version: str

    @classmethod
    def from_run(cls, run: ReviewRun, check_scope_version: str) -> "ReceiptIdentity":
        if run.backend not in BACKENDS:
            raise ValueError(f"unsupported review backend: {run.backend}")
        if isinstance(run.pull_request, bool) or run.pull_request < 1:
            raise ValueError("pull_request must be positive")
        return cls(
            run.repository,
            run.pull_request,
            _sha(run.base_sha, "base_sha"),
            _sha(run.head_sha, "head_sha"),
            _text(run.backend, "backend"),
            _text(run.model, "model"),
            _text(run.effort, "effort"),
            _text(check_scope_version, "check_scope_version"),
        )

    @property
    def run_identity(self) -> str:
        run = ReviewRun(
            self.repository,
            self.pull_request,
            self.base_sha,
            self.head_sha,
            self.base_sha[:12] + self.head_sha[:12],
            self.backend,
            self.model,
            self.effort,
        )
        return run.identity

    @property
    def cache_identity(self) -> str:
        material = {
            "review_run": self.run_identity,
            "check_scope_version": self.check_scope_version,
        }
        return sha256(
            json.dumps(material, sort_keys=True, separators=(",", ":")).encode()
        ).hexdigest()

    def to_dict(self) -> dict[str, object]:
        return {
            "repository": self.repository,
            "pull_request": self.pull_request,
            "base_sha": self.base_sha,
            "head_sha": self.head_sha,
            "backend": self.backend,
            "model": self.model,
            "effort": self.effort,
            "check_scope_version": self.check_scope_version,
        }

    @classmethod
    def from_dict(cls, data: Mapping[str, object]) -> "ReceiptIdentity":
        if not isinstance(data, Mapping):
            raise ValueError("receipt identity must be an object")
        number = data.get("pull_request")
        if isinstance(number, bool) or not isinstance(number, int) or number < 1:
            raise ValueError("receipt pull_request must be positive")
        return cls(
            _text(data.get("repository"), "repository"),
            number,
            _sha(data.get("base_sha"), "base_sha"),
            _sha(data.get("head_sha"), "head_sha"),
            _text(data.get("backend"), "backend"),
            _text(data.get("model"), "model"),
            _text(data.get("effort"), "effort"),
            _text(data.get("check_scope_version"), "check_scope_version"),
        )


@dataclass(frozen=True)
class ReviewReceipt:
    version: int
    identity: ReceiptIdentity
    analysis: ReviewResult
    transcript: tuple[str, ...]
    provenance: dict[str, Any]
    created_at: str

    @classmethod
    def from_result(
        cls,
        run: ReviewRun,
        result: ReviewResult,
        transcript: Sequence[str],
        check_scope_version: str,
        provenance: Mapping[str, Any] | None = None,
    ) -> "ReviewReceipt":
        identity = ReceiptIdentity.from_run(run, check_scope_version)
        if result.state == "unparsable":
            raise ValueError("an unparsable result cannot become a receipt")
        analysis = ReviewResult(
            result.version,
            result.state,
            dict(result.counts),
            [dict(item) for item in result.findings],
            [dict(item) for item in result.verification],
            dict(result.provenance),
            {},
            {},
            [],
        )
        recorded = dict(analysis.provenance)
        recorded.update(dict(provenance or {}))
        recorded.update({
            "repository": identity.repository,
            "pull_request": identity.pull_request,
            "base_sha": identity.base_sha,
            "head_sha": identity.head_sha,
            "backend": identity.backend,
            "model": identity.model,
            "effort": identity.effort,
            "check_scope_version": identity.check_scope_version,
        })
        analysis = ReviewResult(
            analysis.version,
            analysis.state,
            analysis.counts,
            analysis.findings,
            analysis.verification,
            recorded,
            {},
            {},
            [],
        )
        return cls(
            RECEIPT_VERSION,
            identity,
            analysis,
            _bounded_transcript(transcript),
            recorded,
            datetime.now(timezone.utc).isoformat(),
        )

    def to_dict(self) -> dict[str, Any]:
        return {
            "version": self.version,
            "identity": self.identity.to_dict(),
            "analysis": self.analysis.to_dict(),
            "transcript": list(self.transcript),
            "provenance": dict(self.provenance),
            "created_at": self.created_at,
        }

    def to_json(self) -> str:
        return json.dumps(self.to_dict(), sort_keys=True, separators=(",", ":"))

    @classmethod
    def from_dict(cls, data: Mapping[str, Any]) -> "ReviewReceipt":
        if not isinstance(data, Mapping) or data.get("version") != RECEIPT_VERSION:
            raise ValueError("unsupported review receipt version")
        identity = ReceiptIdentity.from_dict(data.get("identity", {}))
        analysis = ReviewResult.from_dict(data.get("analysis", {}))
        if analysis.state == "unparsable":
            raise ValueError("receipt analysis is unparsable")
        transcript = _bounded_transcript(data.get("transcript", []))
        provenance = data.get("provenance", {})
        if not isinstance(provenance, dict):
            raise ValueError("receipt provenance must be an object")
        created_at = _text(data.get("created_at"), "created_at")
        expected = {
            "repository": identity.repository,
            "pull_request": identity.pull_request,
            "base_sha": identity.base_sha,
            "head_sha": identity.head_sha,
            "backend": identity.backend,
            "model": identity.model,
            "effort": identity.effort,
            "check_scope_version": identity.check_scope_version,
        }
        if any(provenance.get(key) != value for key, value in expected.items()):
            raise ValueError("receipt provenance does not match its identity")
        if analysis.live or analysis.overlap:
            raise ValueError("receipt must not contain mutable evidence")
        return cls(RECEIPT_VERSION, identity, analysis, transcript, dict(provenance), created_at)

    @classmethod
    def from_json(cls, payload: str) -> "ReviewReceipt":
        if not isinstance(payload, str) or len(payload) > 200_000:
            raise ValueError("receipt JSON is missing or too large")
        try:
            value = json.loads(payload)
        except (TypeError, ValueError, json.JSONDecodeError) as error:
            raise ValueError("receipt JSON is invalid") from error
        return cls.from_dict(value)

    def analysis_result(
        self,
        live: Mapping[str, Any] | None = None,
        overlap: Mapping[str, Any] | None = None,
    ) -> ReviewResult:
        return ReviewResult(
            self.analysis.version,
            self.analysis.state,
            dict(self.analysis.counts),
            [dict(item) for item in self.analysis.findings],
            [dict(item) for item in self.analysis.verification],
            dict(self.analysis.provenance),
            dict(overlap or {}),
            dict(live or {}),
            list(self.analysis.raw_evidence),
        )

    def with_provenance(self, extra: Mapping[str, Any]) -> "ReviewReceipt":
        provenance = dict(self.provenance)
        provenance.update(dict(extra))
        analysis = ReviewResult(
            self.analysis.version,
            self.analysis.state,
            dict(self.analysis.counts),
            [dict(item) for item in self.analysis.findings],
            [dict(item) for item in self.analysis.verification],
            provenance,
            {},
            {},
            [],
        )
        return ReviewReceipt(
            self.version,
            self.identity,
            analysis,
            self.transcript,
            provenance,
            self.created_at,
        )


def _check_scope_args(check_scope: str) -> tuple[str, ...]:
    return ("--check-scope", check_scope) if check_scope else ()


def run_receipt(
    repository: str,
    pull_request: int,
    base_sha: str,
    head_sha: str,
    backend: str,
    model: str,
    effort: str,
    workdir: str,
    check_scope_version: str,
    check_scope: str = "",
    steer: str = "",
) -> tuple[ReviewReceipt, int]:
    owner, name = repository.split("/", 1)
    request = ReviewRequest(
        owner,
        name,
        pull_request,
        base_sha,
        head_sha,
        "maintainer",
        "review",
        generated_at="bluefin-review-receipt",
        steering=steer,
    )
    run = ReviewRun.from_request(request, backend=backend, model=model, effort=effort)
    if workdir:
        os.chdir(workdir)
    headroom = HeadroomSession.from_environment()
    route = headroom.route_for_call(backend)
    prompt = apply_caveman(
        "Review the exact binding. Return only the backend's structured ReviewResult; "
        "use compact findings with file and line evidence and no prose padding.",
        True,
    )
    transcript: list[str] = []
    if backend == "goose":
        adapter = GooseHarness(availability=GooseHarness.probe())
        result = adapter.stream(
            request,
            prompt=prompt,
            on_line=transcript.append,
            model=model,
            effort=effort,
            steer=steer or None,
            extra_args=_check_scope_args(check_scope),
        )
        exit_code = adapter.terminal_status(result)
    elif backend == "codex":
        adapter = CodexHarness(availability=CodexHarness.probe())
        result = adapter.stream(
            request,
            prompt=prompt,
            on_line=transcript.append,
            model=model,
            effort=effort,
            steer=steer or None,
        )
        exit_code = 0 if result.state in {"complete", "findings"} else 65 if result.state == "incomplete" else 1
    else:
        raise ValueError(f"unsupported review backend: {backend}")
    receipt = ReviewReceipt.from_result(
        run,
        result,
        transcript,
        check_scope_version,
        {
            "headroom_status_line": headroom.status_line(backend, True),
            "headroom_state": route.state,
            "headroom_route": route.base_url or "",
        },
    )
    return receipt, exit_code


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="bluefin-review receipt")
    parser.add_argument("--repository", required=True)
    parser.add_argument("--pull-request", required=True, type=int)
    parser.add_argument("--base-sha", required=True)
    parser.add_argument("--head-sha", required=True)
    parser.add_argument("--backend", choices=sorted(BACKENDS), required=True)
    parser.add_argument("--model", required=True)
    parser.add_argument("--effort", required=True)
    parser.add_argument("--workdir", default="")
    parser.add_argument("--check-scope-version", required=True)
    parser.add_argument("--check-scope", default="")
    parser.add_argument("--steer", default="")
    args = parser.parse_args(argv)
    receipt, exit_code = run_receipt(
        args.repository,
        args.pull_request,
        args.base_sha,
        args.head_sha,
        args.backend,
        args.model,
        args.effort,
        args.workdir,
        args.check_scope_version,
        args.check_scope,
        args.steer,
    )
    print(receipt.to_json())
    return exit_code


if __name__ == "__main__":
    raise SystemExit(main())
```

Add this paragraph to the image-owned review scope without editing the five
specialized check files:

```markdown
Every check response follows the compact-output contract by reusing
`CAVEMAN_INSTRUCTIONS` from `image/tui/headroom.py:33-40` through
`apply_caveman` at `image/tui/headroom.py:336-339`: return only the structured
verdict and bounded file/line findings, omit greetings, conclusions, repeated
context, and rationale padding, and state missing verification in one short
field. Preserve negations and security/destructive-action warnings in full
prose. The receipt runner applies that existing policy before dispatch and caps
the transcript before it reaches durable state.
```

Add the dispatch branch immediately after the existing `case` entry point in `image/bin/bluefin-review`:

```bash
receipt)
  shift
  root="${BLUEFIN_REVIEW_HARNESS_ROOT:-/opt/bluefin}"
  PYTHONPATH="${root}:${root}/tui${PYTHONPATH:+:${PYTHONPATH}}" \
    exec python3 -m tui.review_receipt "$@"
  ;;
```

- [ ] **Step 4: Run the receipt contract and verify both backends pass the schema round-trip.**

Run: `python3 tests/review_receipt_contract.py`

Expected: `Ran 4 tests ... OK`.

- [ ] **Step 5: Add the CLI contract without changing the existing human-readable path.**

```bash
# tests/bluefin-review.sh
base_sha="$(printf '%040d' 0)"
head_sha="0123456789abcdef0123456789abcdef01234567"
receipt_json="$(
  PATH="$scratch/bin:$PATH" \
  BLUEFIN_REVIEW_HARNESS_ROOT="$repo_root/image" \
  "$review" receipt \
    --repository projectbluefin/alpha \
    --pull-request 31 \
    --base-sha "$base_sha" \
    --head-sha "$head_sha" \
    --backend goose \
    --model gemini-3.8-flash \
    --effort high \
    --check-scope-version scope-v7 \
    --workdir "$scratch/workspace/alpha"
)"
python3 - "$receipt_json" <<'PY'
import json
import sys
payload = json.loads(sys.argv[1])
assert payload["version"] == 1
assert payload["identity"]["repository"] == "projectbluefin/alpha"
assert payload["identity"]["head_sha"] == "0123456789abcdef0123456789abcdef01234567"
assert "live" not in payload["analysis"] or payload["analysis"]["live"] == {}
assert "overlap" not in payload["analysis"] or payload["analysis"]["overlap"] == {}
PY
```

- [ ] **Step 6: Run the focused shell contract.**

Run: `bash tests/bluefin-review.sh`

Expected: the existing local-range, PR, cancellation, incomplete-result, and new JSON receipt assertions pass.

- [ ] **Step 7: Commit the receipt seam.**

```bash
git add image/tui/review_receipt.py image/bin/bluefin-review tests/review_receipt_contract.py tests/bluefin-review.sh
git commit -m "feat: add versioned review receipts" -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

## Task 2: Add isolated full-repository/head worktrees to `bluefin-review`

**Files:**
- Modify: `image/bin/bluefin-review:42-68, 447-527`.
- Test: `tests/bluefin-review.sh:74-124` with concurrent worktree-path assertions.

**Interfaces to consume:**
- `bluefin-review receipt` from Task 1.
- Existing `WORKSPACE` environment at `image/bin/bluefin-review:24`.
- Existing `run_goose_review` and `pr_mode` at `image/bin/bluefin-review:447-527`.

**Interfaces produced:**
- `isolated_worktree_path(repository: str, head_sha: str) -> str` as a shell function.
- `prepare_isolated_worktree(repository: str, head_sha: str) -> str` as a shell function.
- `bluefin-review pr <owner/repo> <number> --workdir <path> --base-sha <sha> --head-sha <sha>` mode.
- `bluefin-review receipt ... --workdir <path>` consumes the prepared directory and never checks out into a shared repository directory.

- [ ] **Step 1: Extend the shell contract with a failing isolation assertion.**

```bash
# tests/bluefin-review.sh
worktree_a="$(
  PATH="$scratch/bin:$PATH" BLUEFIN_REVIEW_WORKTREE_ROOT="$scratch/worktrees" \
    "$review" --print-worktree projectbluefin/alpha \
      0123456789abcdef0123456789abcdef01234567
)"
worktree_b="$(
  PATH="$scratch/bin:$PATH" BLUEFIN_REVIEW_WORKTREE_ROOT="$scratch/worktrees" \
    "$review" --print-worktree projectbluefin/alpha \
      1123456789abcdef0123456789abcdef01234567
)"
[[ "$worktree_a" != "$worktree_b" ]]
[[ "$worktree_a" == *"projectbluefin__alpha-"* ]]
[[ "$worktree_b" == *"projectbluefin__alpha-"* ]]
```

- [ ] **Step 2: Run the shell contract and verify the new option is rejected.**

Run: `bash tests/bluefin-review.sh`

Expected: failure because `bluefin-review: unrecognized option '--print-worktree'`.

- [ ] **Step 3: Implement deterministic full-repository/head paths and explicit workdir use.**

```bash
isolated_worktree_path() {
  local repo="$1" head="$2" root="${BLUEFIN_REVIEW_WORKTREE_ROOT:-$WORKSPACE}"
  local digest prefix
  digest="$(printf '%s\0%s' "$repo" "$head" | sha256sum | awk '{print $1}')"
  prefix="${repo//\//__}"
  printf '%s/%s-%s\n' "$root" "$prefix" "${digest:0:24}"
}

prepare_isolated_worktree() {
  local repo="$1" head="$2" dir
  [[ "$repo" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]] ||
    die "repository must be owner/repo"
  [[ "$head" =~ ^[0-9a-f]{40}$ ]] || die "head must be a full lowercase SHA"
  dir="$(isolated_worktree_path "$repo" "$head")"
  mkdir -p "$(dirname "$dir")"
  if [[ ! -d "$dir/.git" ]]; then
    gh repo clone "$repo" "$dir" -- --quiet || die "could not clone $repo into $dir"
  fi
  git -C "$dir" fetch --quiet origin "$head" || die "could not fetch $repo@$head"
  git -C "$dir" checkout --quiet --detach "$head" ||
    die "could not check out exact head $head in $dir"
  printf '%s\n' "$dir"
}
```

Change `run_goose_review` so a supplied `BLUEFIN_REVIEW_WORKDIR` is used directly, the expected head is fetched and detached, and the old `${WORKSPACE}/${repo##*/}` path is used only by the legacy single-process human path. Change `goose_review` to derive `base_sha` and `head_sha` from `BLUEFIN_REVIEW_EXPECTED_*` when supplied and to fail if `git rev-parse HEAD` does not equal the requested head. Add a `--print-worktree` branch before the existing command `case` for the contract above, and parse `--workdir`, `--base-sha`, and `--head-sha` in `pr_mode`.

- [ ] **Step 4: Run the isolation and existing PR tests.**

Run: `bash tests/bluefin-review.sh`

Expected: PASS, including two distinct `projectbluefin__alpha-<digest>` paths and no checkout into `$scratch/workspace/alpha` for the isolated mode.

- [ ] **Step 5: Commit the isolated worktree mode.**

```bash
git add image/bin/bluefin-review tests/bluefin-review.sh
git commit -m "fix: isolate concurrent pull request reviews" -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

## Task 3: Add `ReviewCache` with exact identity and seven-day pruning

**Files:**
- Create: `image/tui/review_cache.py`.
- Test: `tests/review_cache_contract.py`.
- Modify: `image/tui/review_receipt.py:60-230` only if a cache entry needs a shared serializer helper.

**Interfaces to consume:**
- `ReviewRun.identity` from `image/tui/review_run.py:150-165`.
- `ReviewReceipt` and `ReceiptIdentity` from Task 1.
- The seven-day `LANDING_RETENTION_SECONDS` and pruning behavior at `image/tui/landing.py:1321-1337`.

**Interfaces produced:**
- `REVIEW_CACHE_RETENTION_SECONDS = 7 * 24 * 60 * 60`.
- `ReviewCache(root: str | os.PathLike[str] | None = None)`.
- `ReviewCache.path_for(run: ReviewRun, check_scope_version: str) -> Path`.
- `ReviewCache.get(run: ReviewRun, check_scope_version: str) -> ReviewReceipt | None`.
- `ReviewCache.put(receipt: ReviewReceipt) -> Path`.
- `ReviewCache.prune(now: float | None = None) -> None`.
- `ReviewCache.prefix(run: ReviewRun) -> str`, returning `<owner>__<repo>__<number>`.

- [ ] **Step 1: Write failing cache tests covering hits, every identity miss, corruption, and pruning.**

```python
# tests/review_cache_contract.py
import json
import os
import tempfile
import unittest
from pathlib import Path

import sys
sys.path.insert(0, str(Path(__file__).parents[1] / "image"))

from tui.review_cache import REVIEW_CACHE_RETENTION_SECONDS, ReviewCache
from tui.review_evidence_manifest import ReviewRequest
from tui.review_receipt import ReviewReceipt
from tui.review_result import ReviewResult
from tui.review_run import ReviewRun


def make_run(base="a" * 40, head="b" * 40, model="gemini-3.8-flash"):
    request = ReviewRequest(
        "projectbluefin", "review", 372, base, head,
        "maintainer", "review", generated_at="test",
    )
    return ReviewRun.from_request(request, backend="goose", model=model, effort="high")


def make_receipt(run):
    return ReviewReceipt.from_result(
        run,
        ReviewResult(
            1, "complete",
            {"critical": 0, "high": 0, "medium": 0, "low": 0},
            [], [], {"backend": run.backend, "model": run.model},
            {}, {}, [],
        ),
        ["compact transcript"],
        "scope-v7",
    )


class ReviewCacheTests(unittest.TestCase):
    def test_hit_and_readable_filename(self):
        with tempfile.TemporaryDirectory() as root:
            cache = ReviewCache(root)
            run = make_run()
            path = cache.put(make_receipt(run))
            self.assertIn("projectbluefin__review__372-", path.name)
            self.assertIsNotNone(cache.get(run, "scope-v7"))

    def test_base_motion_force_push_model_and_scope_are_misses(self):
        with tempfile.TemporaryDirectory() as root:
            cache = ReviewCache(root)
            run = make_run()
            cache.put(make_receipt(run))
            self.assertIsNone(cache.get(make_run(base="c" * 40), "scope-v7"))
            self.assertIsNone(cache.get(make_run(head="c" * 40), "scope-v7"))
            self.assertIsNone(cache.get(make_run(model="gpt-5.6-sol"), "scope-v7"))
            self.assertIsNone(cache.get(run, "scope-v8"))

    def test_corrupt_file_is_a_miss_and_is_replaced_by_next_put(self):
        with tempfile.TemporaryDirectory() as root:
            cache = ReviewCache(root)
            run = make_run()
            path = cache.path_for(run, "scope-v7")
            path.parent.mkdir(parents=True)
            path.write_text("{broken")
            self.assertIsNone(cache.get(run, "scope-v7"))
            cache.put(make_receipt(run))
            json.loads(path.read_text())

    def test_prune_matches_landing_retention(self):
        with tempfile.TemporaryDirectory() as root:
            cache = ReviewCache(root)
            run = make_run()
            path = cache.put(make_receipt(run))
            old = (os.path.getmtime(path) - REVIEW_CACHE_RETENTION_SECONDS - 1)
            os.utime(path, (old, old))
            cache.prune(now=os.path.getmtime(path) + REVIEW_CACHE_RETENTION_SECONDS + 2)
            self.assertFalse(path.exists())


if __name__ == "__main__":
    unittest.main()
```

- [ ] **Step 2: Run the cache tests and verify the module is missing.**

Run: `python3 tests/review_cache_contract.py`

Expected: `ModuleNotFoundError: No module named 'tui.review_cache'`.

- [ ] **Step 3: Implement atomic, analysis-only cache storage.**

```python
# image/tui/review_cache.py
from __future__ import annotations

import os
import tempfile
from hashlib import sha256
from pathlib import Path

from tui.review_receipt import ReviewReceipt
from tui.review_run import ReviewRun

REVIEW_CACHE_RETENTION_SECONDS = 7 * 24 * 60 * 60


class ReviewCache:
    def __init__(self, root: str | os.PathLike[str] | None = None) -> None:
        if root is None:
            state_root = os.environ.get("XDG_STATE_HOME", "~/.local/state")
            root = os.path.join(state_root, "bluefin-review", "reviews")
        self.root = Path(root).expanduser()

    @staticmethod
    def prefix(run: ReviewRun) -> str:
        owner, repository = run.repository.split("/", 1)
        return f"{owner}__{repository}__{run.pull_request}"

    @staticmethod
    def _digest(run: ReviewRun, check_scope_version: str) -> str:
        from hashlib import sha256
        material = f"{run.identity}\0{check_scope_version}"
        return sha256(material.encode("utf-8")).hexdigest()

    def path_for(self, run: ReviewRun, check_scope_version: str) -> Path:
        return self.root / (
            f"{self.prefix(run)}-{self._digest(run, check_scope_version)}.json"
        )

    def get(self, run: ReviewRun, check_scope_version: str) -> ReviewReceipt | None:
        path = self.path_for(run, check_scope_version)
        try:
            receipt = ReviewReceipt.from_json(path.read_text(encoding="utf-8"))
            expected = f"{run.identity}\0{check_scope_version}"
            if receipt.identity.cache_identity != sha256(expected.encode("utf-8")).hexdigest():
                return None
            return receipt
        except (OSError, UnicodeError, TypeError, ValueError):
            return None

    def put(self, receipt: ReviewReceipt) -> Path:
        path = self.path_for(
            ReviewRun(
                receipt.identity.repository,
                receipt.identity.pull_request,
                receipt.identity.base_sha,
                receipt.identity.head_sha,
                receipt.identity.base_sha[:12] + receipt.identity.head_sha[:12],
                receipt.identity.backend,
                receipt.identity.model,
                receipt.identity.effort,
            ),
            receipt.identity.check_scope_version,
        )
        self.root.mkdir(parents=True, exist_ok=True)
        descriptor, temporary_name = tempfile.mkstemp(
            dir=self.root, prefix=".review-", suffix=".tmp"
        )
        temporary = Path(temporary_name)
        try:
            with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
                handle.write(receipt.to_json())
                handle.write("\n")
                handle.flush()
                os.fsync(handle.fileno())
            os.replace(temporary, path)
        finally:
            temporary.unlink(missing_ok=True)
        return path

    def prune(self, now: float | None = None) -> None:
        cutoff = (now if now is not None else __import__("time").time()) - REVIEW_CACHE_RETENTION_SECONDS
        try:
            names = list(self.root.iterdir())
        except OSError:
            return
        for path in names:
            if path.suffix != ".json":
                continue
            try:
                if path.stat().st_mtime < cutoff:
                    path.unlink()
            except OSError:
                continue
```

- [ ] **Step 4: Run the cache tests and verify corrupt entries are misses, not clean results.**

Run: `python3 tests/review_cache_contract.py`

Expected: `Ran 4 tests ... OK`.

- [ ] **Step 5: Commit the cache.**

```bash
git add image/tui/review_cache.py tests/review_cache_contract.py
git commit -m "feat: cache exact-head review analysis" -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

## Task 4: Add the injectable local capacity governor

**Files:**
- Create: `image/tui/capacity.py`.
- Test: `tests/capacity_contract.py`.

**Interfaces to consume:**
- `/proc/meminfo` and `os.cpu_count()` as required by the approved spec.
- Environment configuration conventions used by `HeadroomSession.from_environment` at `image/tui/headroom.py:231-253`.

**Interfaces produced:**
- `CapacityError(Exception)`.
- `read_mem_available_mb(path: str = "/proc/meminfo") -> int`.
- `CapacityGovernor(cap: int | None = None, per_review_budget_mb: int | None = None, reserve_mb: int | None = None, mem_available_mb: Callable[[], int] | None = None, cpu_count: Callable[[], int | None] | None = None)`.
- `CapacityGovernor.total_slots() -> int`.
- `CapacityGovernor.runnable_slots(running: int) -> int`.
- `CapacityGovernor.can_start(running: int) -> bool`.

- [ ] **Step 1: Write failing tests for zero headroom, CPU limiting, cap limiting, and injected readers.**

```python
# tests/capacity_contract.py
import unittest
from pathlib import Path
import sys
sys.path.insert(0, str(Path(__file__).parents[1] / "image"))

from tui.capacity import CapacityGovernor, read_mem_available_mb


class CapacityContractTests(unittest.TestCase):
    def test_meminfo_reader_parses_memavailable_kib(self):
        path = Path("/tmp/capacity-meminfo-test")
        path.write_text("MemTotal: 8000000 kB\nMemAvailable: 4096000 kB\n")
        try:
            self.assertEqual(read_mem_available_mb(str(path)), 4000)
        finally:
            path.unlink(missing_ok=True)

    def test_zero_slot_when_reserve_exceeds_available_memory(self):
        governor = CapacityGovernor(
            cap=4,
            per_review_budget_mb=1536,
            reserve_mb=2048,
            mem_available_mb=lambda: 1024,
            cpu_count=lambda: 16,
        )
        self.assertEqual(governor.total_slots(), 0)
        self.assertFalse(governor.can_start(0))

    def test_formula_uses_memory_cpu_and_configured_cap(self):
        governor = CapacityGovernor(
            cap=4,
            per_review_budget_mb=1500,
            reserve_mb=2000,
            mem_available_mb=lambda: 11000,
            cpu_count=lambda: 6,
        )
        self.assertEqual(governor.total_slots(), 3)
        self.assertEqual(governor.runnable_slots(2), 1)
        self.assertEqual(governor.runnable_slots(3), 0)


if __name__ == "__main__":
    unittest.main()
```

- [ ] **Step 2: Run the unit contract and verify the module is absent.**

Run: `python3 tests/capacity_contract.py`

Expected: `ModuleNotFoundError: No module named 'tui.capacity'`.

- [ ] **Step 3: Implement the governor with explicit zero-floor behavior.**

```python
# image/tui/capacity.py
from __future__ import annotations

import os
from dataclasses import dataclass
from typing import Callable

BLUEFIN_REVIEW_CONCURRENT_REVIEWS = "BLUEFIN_REVIEW_CONCURRENT_REVIEWS"
BLUEFIN_REVIEW_MEM_BUDGET_MB = "BLUEFIN_REVIEW_MEM_BUDGET_MB"
BLUEFIN_REVIEW_MEM_RESERVE_MB = "BLUEFIN_REVIEW_MEM_RESERVE_MB"
DEFAULT_REVIEW_CAP = 4
DEFAULT_REVIEW_BUDGET_MB = 1536
DEFAULT_REVIEW_RESERVE_MB = 2048


class CapacityError(RuntimeError):
    pass


def _positive_int(value: str, name: str) -> int:
    try:
        result = int(value)
    except ValueError as error:
        raise CapacityError(f"{name} must be an integer") from error
    if result < 1:
        raise CapacityError(f"{name} must be positive")
    return result


def read_mem_available_mb(path: str = "/proc/meminfo") -> int:
    try:
        lines = open(path, encoding="utf-8")
    except OSError as error:
        raise CapacityError(f"cannot read {path}: {error}") from error
    with lines:
        for line in lines:
            name, separator, value = line.partition(":")
            if name != "MemAvailable" or not separator:
                continue
            fields = value.split()
            if len(fields) != 2 or fields[1] != "kB":
                raise CapacityError("MemAvailable is not expressed in kB")
            try:
                kib = int(fields[0])
            except ValueError as error:
                raise CapacityError("MemAvailable is not an integer") from error
            if kib < 0:
                raise CapacityError("MemAvailable is negative")
            return kib // 1024
    raise CapacityError("MemAvailable is missing")


@dataclass(frozen=True)
class CapacityGovernor:
    cap: int | None = None
    per_review_budget_mb: int | None = None
    reserve_mb: int | None = None
    mem_available_mb: Callable[[], int] = read_mem_available_mb
    cpu_count: Callable[[], int | None] = os.cpu_count

    def __post_init__(self) -> None:
        cap = self.cap if self.cap is not None else _positive_int(
            os.environ.get(BLUEFIN_REVIEW_CONCURRENT_REVIEWS, str(DEFAULT_REVIEW_CAP)),
            BLUEFIN_REVIEW_CONCURRENT_REVIEWS,
        )
        budget = self.per_review_budget_mb if self.per_review_budget_mb is not None else _positive_int(
            os.environ.get(BLUEFIN_REVIEW_MEM_BUDGET_MB, str(DEFAULT_REVIEW_BUDGET_MB)),
            BLUEFIN_REVIEW_MEM_BUDGET_MB,
        )
        reserve = self.reserve_mb if self.reserve_mb is not None else _positive_int(
            os.environ.get(BLUEFIN_REVIEW_MEM_RESERVE_MB, str(DEFAULT_REVIEW_RESERVE_MB)),
            BLUEFIN_REVIEW_MEM_RESERVE_MB,
        )
        if cap < 1 or budget < 1 or reserve < 1:
            raise CapacityError("capacity values must be positive")
        object.__setattr__(self, "cap", cap)
        object.__setattr__(self, "per_review_budget_mb", budget)
        object.__setattr__(self, "reserve_mb", reserve)

    def total_slots(self) -> int:
        available = max(0, int(self.mem_available_mb()) - self.reserve_mb)
        memory_slots = available // self.per_review_budget_mb
        cores = self.cpu_count()
        cpu_slots = max(0, int(cores or 0) // 2)
        return max(0, min(memory_slots, cpu_slots, self.cap))

    def runnable_slots(self, running: int) -> int:
        if isinstance(running, bool) or running < 0:
            raise CapacityError("running must be a non-negative integer")
        return max(0, self.total_slots() - running)

    def can_start(self, running: int) -> bool:
        return self.runnable_slots(running) > 0
```

- [ ] **Step 4: Run the governor contract.**

Run: `python3 tests/capacity_contract.py`

Expected: `Ran 3 tests ... OK`.

- [ ] **Step 5: Commit the capacity seam.**

```bash
git add image/tui/capacity.py tests/capacity_contract.py
git commit -m "feat: govern local review headroom" -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

## Task 5: Add fail-closed batch snapshot hydration

**Files:**
- Create: `image/tui/review_snapshot.py`.
- Test: `tests/review_snapshot_contract.py`.
- Modify: `tests/dashboard_pilot.py:143-205, 420-570` to provide exact `baseRefOid` and `headRefOid` in the live PR fixture used by batch tests.

**Interfaces to consume:**
- `Stop`, `live_review_context`, and `live_review_verification` at `image/tui/bluefin_review_tui.py:886-970`.
- The org GraphQL query and parser at `image/tui/bluefin_review_tui.py:73-95, 2847-2895`; it intentionally carries no SHAs.
- `ReviewRequest` at `image/tui/review_evidence_manifest.py:99-154`.

**Interfaces produced:**
- `BatchSnapshotError(Exception)`.
- `BatchReviewItem` with fields `key: str`, `repository: str`, `number: int`, `title: str`, `base_sha: str`, `head_sha: str`, `live: dict[str, Any]`, `verification: list[dict[str, Any]]`.
- `BatchReviewItem.request(actor: str = "maintainer", tenant: str = "review") -> ReviewRequest`.
- `BatchSnapshot(items: tuple[BatchReviewItem, ...], failures: dict[str, str])`.
- `BatchSnapshot.ready -> bool`.
- `hydrate_batch_snapshot(stops: Sequence[Stop], fetch_live: Callable[[str, int], Mapping[str, Any]]) -> BatchSnapshot`.

- [ ] **Step 1: Write failing tests for successful hydration and fail-closed behavior.**

```python
# tests/review_snapshot_contract.py
import unittest
from pathlib import Path
import sys
sys.path.insert(0, str(Path(__file__).parents[1] / "image"))

from tui.review_snapshot import hydrate_batch_snapshot
from tui.bluefin_review_tui import Stop


BASE = "a" * 40
HEAD = "b" * 40


class SnapshotContractTests(unittest.TestCase):
    def stop(self, number):
        return Stop("projectbluefin/review", number, "review", f"PR {number}")

    def test_snapshot_hydrates_exact_base_and_head_for_each_stop(self):
        snapshot = hydrate_batch_snapshot(
            [self.stop(1), self.stop(2)],
            lambda repo, number: {
                "title": f"PR {number}",
                "baseRefOid": BASE,
                "headRefOid": HEAD,
                "statusCheckRollup": [{"name": "ci", "conclusion": "SUCCESS"}],
                "mergeable": "MERGEABLE",
                "mergeStateStatus": "CLEAN",
            },
        )
        self.assertTrue(snapshot.ready)
        self.assertEqual([item.number for item in snapshot.items], [1, 2])
        self.assertEqual(snapshot.items[0].request().head_sha, HEAD)

    def test_one_unhydratable_pr_blocks_dispatch_without_discarding_failure_detail(self):
        def fetch(repo, number):
            if number == 2:
                raise RuntimeError("head unavailable")
            return {"baseRefOid": BASE, "headRefOid": HEAD, "statusCheckRollup": []}

        snapshot = hydrate_batch_snapshot([self.stop(1), self.stop(2)], fetch)
        self.assertFalse(snapshot.ready)
        self.assertEqual(snapshot.failures["projectbluefin/review#2"], "head unavailable")
        self.assertEqual(len(snapshot.items), 1)

    def test_malformed_or_abbreviated_shas_fail_closed(self):
        snapshot = hydrate_batch_snapshot(
            [self.stop(1)],
            lambda repo, number: {"baseRefOid": "a", "headRefOid": HEAD},
        )
        self.assertFalse(snapshot.ready)
        self.assertIn("full", snapshot.failures["projectbluefin/review#1"])


if __name__ == "__main__":
    unittest.main()
```

- [ ] **Step 2: Run the snapshot contract and verify the module is absent.**

Run: `python3 tests/review_snapshot_contract.py`

Expected: `ModuleNotFoundError: No module named 'tui.review_snapshot'`.

- [ ] **Step 3: Implement strict per-stop live hydration.**

```python
# image/tui/review_snapshot.py
from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Any, Callable, Mapping, Sequence, TYPE_CHECKING

from tui.review_evidence_manifest import ReviewRequest

if TYPE_CHECKING:
    from tui.bluefin_review_tui import Stop

FULL_SHA = re.compile(r"[0-9a-f]{40}\Z")


class BatchSnapshotError(ValueError):
    pass


@dataclass(frozen=True)
class BatchReviewItem:
    key: str
    repository: str
    number: int
    title: str
    base_sha: str
    head_sha: str
    live: dict[str, Any]
    verification: list[dict[str, Any]]

    def request(self, actor: str = "maintainer", tenant: str = "review") -> ReviewRequest:
        owner, repository = self.repository.split("/", 1)
        return ReviewRequest(
            owner,
            repository,
            self.number,
            self.base_sha,
            self.head_sha,
            actor,
            tenant,
            generated_at="batch-snapshot",
        )


@dataclass(frozen=True)
class BatchSnapshot:
    items: tuple[BatchReviewItem, ...]
    failures: dict[str, str]

    @property
    def ready(self) -> bool:
        return not self.failures and bool(self.items)


def _required_sha(live: Mapping[str, Any], field: str) -> str:
    value = live.get(field)
    if not isinstance(value, str) or not FULL_SHA.fullmatch(value):
        raise BatchSnapshotError(f"{field} must be a full lowercase SHA")
    return value


def _verification(live: Mapping[str, Any]) -> list[dict[str, str]]:
    records = []
    passed = {"SUCCESS", "NEUTRAL", "SKIPPED"}
    failed = {"FAILURE", "ERROR", "TIMED_OUT", "CANCELLED", "ACTION_REQUIRED"}
    checks = live.get("statusCheckRollup") or []
    for index, item in enumerate(checks, start=1):
        if not isinstance(item, Mapping):
            continue
        outcome = str(item.get("conclusion") or item.get("state") or "PENDING").upper()
        state = "verified" if outcome in passed else "unverified" if outcome in failed else "pending"
        records.append({
            "name": str(item.get("name") or item.get("context") or f"CI check {index}"),
            "state": state,
            "evidence": outcome,
            "source": "github",
        })
    return records


def hydrate_batch_snapshot(
    stops: Sequence[Stop],
    fetch_live: Callable[[str, int], Mapping[str, Any]],
) -> BatchSnapshot:
    items: list[BatchReviewItem] = []
    failures: dict[str, str] = {}
    for stop in stops:
        key = stop.key
        try:
            live = dict(fetch_live(stop.repository, stop.number))
            base_sha = _required_sha(live, "baseRefOid")
            head_sha = _required_sha(live, "headRefOid")
            items.append(
                BatchReviewItem(
                    key,
                    stop.repository,
                    stop.number,
                    str(live.get("title") or stop.title),
                    base_sha,
                    head_sha,
                    live,
                    _verification(live),
                )
            )
        except (BatchSnapshotError, KeyError, TypeError, ValueError, RuntimeError) as error:
            failures[key] = str(error)
    return BatchSnapshot(tuple(items), failures)
```

- [ ] **Step 4: Run the snapshot unit contract.**

Run: `python3 tests/review_snapshot_contract.py`

Expected: `Ran 3 tests ... OK`.

- [ ] **Step 5: Add the pilot regression that refuses to dispatch an unhydratable selection.**

```python
# tests/dashboard_pilot.py, in the batch section after the existing live queue setup
unhydrated = tui.ReviewDashboard(tui.QueueFilters(action=""))
async with unhydrated.run_test() as pilot:
    await wait_for_live_rows(unhydrated, pilot, "ready", 2)
    unhydrated.self_login = "castrojo"
    unhydrated.engine_snapshot_fetch = lambda repository, number: (
        {"baseRefOid": "a" * 40, "headRefOid": "b" * 40}
        if number == 31
        else {"baseRefOid": "short", "headRefOid": "b" * 40}
    )
    for stop in unhydrated.stops:
        stop.selected = True
    await pilot.press("r")
    await pilot.pause()
    check(
        not unhydrated.review_batches,
        "a batch with one missing exact SHA must not dispatch any review task",
    )
    check(
        "headRefOid" in unhydrated.stops[1].failure
        or "full lowercase SHA" in unhydrated.stops[1].failure,
        "the unhydratable row must retain the fail-closed reason",
    )
```

- [ ] **Step 6: Run the focused dashboard pilot once the fixture has exact live refs.**

Run: `bash tests/dashboard-contract.sh`

Expected: the existing pilot passes; the new selection remains selected and no child review process is started for the invalid row.

- [ ] **Step 7: Commit the fail-closed snapshot.**

```bash
git add image/tui/review_snapshot.py tests/review_snapshot_contract.py tests/dashboard_pilot.py
git commit -m "feat: hydrate exact heads before batch review" -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

## Task 6: Build the JSONL `ReviewEngine`, local executor, and cache-aware scheduler

**Files:**
- Create: `image/tui/review_engine.py`.
- Create: `tests/review_engine_contract.py`.
- Modify: `image/tui/headroom.py:231-339` only to expose bounded aggregate telemetry; do not move capacity math here.
- Modify: `tests/harness-contract.py:1027-1131` to lock the telemetry shape and existing route/status behavior.
- Modify: `image/tui/review_cache.py` only for shared receipt-path helpers.
- Test: `tests/review_engine_contract.py`, `tests/review_result_contract.py`, `tests/review_run_contract.py`, `tests/harness-contract.py`.

**Interfaces to consume:**
- `ReviewRun`, `ReviewRunController`, and terminal states at `image/tui/review_run.py:111-165, 256-428`.
- `ReviewReceipt` and `run_receipt` from Task 1.
- `ReviewCache` from Task 3.
- `CapacityGovernor` from Task 4.
- `BatchSnapshot` and `BatchReviewItem` from Task 5.
- Existing Headroom routing at `image/tui/headroom.py:231-339`: call `refresh(backend)` once at batch start and once at batch completion for aggregate sampling, and call `route_for_call(backend)` immediately before every per-PR dispatch.
- The landing JSONL pattern at `image/tui/landing.py:79-145, 563-700`: instance-qualified IDs, `fcntl.flock`, complete-final-line preservation, torn-tail truncation, and terminal-event folds.

**Interfaces produced:**
- `REVIEW_ENGINE_STATE_DIR() -> str`.
- `ReviewEvent` dataclass with `key`, `state`, `note`, `timestamp`, and optional `receipt`.
- `ReviewBatch` dataclass with `batch_id`, `status_path`, `items`, `backend`, `model`, `effort`, `running`, `headroom_status_line`, and `headroom_output_reduction`.
- `ReviewBatchResult` dataclass with `results: dict[str, ReviewReceipt]` and `failures: dict[str, str]`.
- `BrokerUnavailable(RuntimeError)` for transport/collection failures that permit one-PR local fallback.
- `HeadroomSession.telemetry(backend: str) -> dict[str, Any]`, returning bounded route state, base URL, status line, proxy delta counters, output-reduction percent/method, and statistics-degraded state.
- `ReviewReceipt.with_provenance(extra: Mapping[str, Any]) -> ReviewReceipt`.
- `LocalExecutor.run(item: BatchReviewItem, run: ReviewRun, workdir: Path, check_scope_version: str, check_scope: str, headroom_route: HeadroomRoute, headroom_telemetry: Mapping[str, Any]) -> ReviewReceipt`.
- `ReviewEngine(..., headroom_session: HeadroomSession | None = None)`.
- `ReviewEngine.start(snapshot: BatchSnapshot, backend: str, model: str, effort: str, check_scope_version: str, check_scope: str = "", on_event: Callable[[ReviewEvent], None] | None = None) -> ReviewBatch`.
- `ReviewEngine.run_sync(snapshot: BatchSnapshot, backend: str, model: str, effort: str, check_scope_version: str, check_scope: str = "", on_event: Callable[[ReviewEvent], None] | None = None) -> ReviewBatchResult`.
- `ReviewEngine.cancel(batch: ReviewBatch) -> None`.
- `parse_review_status(path: str) -> dict[str, dict[str, Any]]`.
- `append_review_event(path: str, event: ReviewEvent) -> None`.

- [ ] **Step 1: Write failing scheduler tests for N-way dispatch, cache short-circuit, torn tails, and failure isolation.**

```python
# tests/review_engine_contract.py
import threading
import tempfile
import unittest
from pathlib import Path
import sys
sys.path.insert(0, str(Path(__file__).parents[1] / "image"))

from tui.capacity import CapacityGovernor
from tui.headroom import HeadroomRoute, HeadroomSession
from tui.review_cache import ReviewCache
from tui.review_engine import ReviewEngine, parse_review_status
from tui.review_receipt import ReviewReceipt
from tui.review_result import ReviewResult
from tui.review_snapshot import BatchReviewItem, BatchSnapshot
from tui.review_run import ReviewRun


BASE = "a" * 40
HEADS = ("b" * 40, "c" * 40, "d" * 40)


def item(number, head):
    return BatchReviewItem(
        f"projectbluefin/review#{number}",
        "projectbluefin/review",
        number,
        f"PR {number}",
        BASE,
        head,
        {"baseRefOid": BASE, "headRefOid": head},
        [],
    )


class FakeLocalExecutor:
    def __init__(self):
        self.calls = []
        self.started = threading.Barrier(2)

    def run(
        self,
        review_item,
        run,
        workdir,
        check_scope_version,
        check_scope,
        headroom_route,
        headroom_telemetry,
    ):
        self.calls.append(review_item.key)
        if review_item.number == 2:
            raise RuntimeError("provider failed")
        if len(self.calls) <= 2:
            self.started.wait(timeout=5)
        return ReviewReceipt.from_result(
            run,
            ReviewResult(
                1, "complete",
                {"critical": 0, "high": 0, "medium": 0, "low": 0},
                [], [], {"backend": run.backend, "model": run.model},
                {}, {}, [],
            ),
            ["compact"],
            check_scope_version,
        )


class FakeHeadroomSession:
    def __init__(self):
        self.refresh_calls = []
        self.route_calls = []

    def refresh(self, backend):
        self.refresh_calls.append(backend)
        return HeadroomRoute("ACTIVE", backend, "http://127.0.0.1:8787", "ready")

    def route_for_call(self, backend):
        self.route_calls.append(backend)
        return HeadroomRoute("ACTIVE", backend, "http://127.0.0.1:8787", "ready")

    def telemetry(self, backend):
        return {
            "state": "ACTIVE",
            "route": "http://127.0.0.1:8787",
            "status_line": "[ACTIVE] Codex: via Headroom; Caveman ON [C]",
            "requests": 4,
            "tokens_saved": 300,
            "output_tokens_saved": 20,
            "output_reduction_percent": 20.0,
            "output_reduction_method": "measured",
            "statistics_degraded": False,
        }

    def status_line(self, backend, caveman):
        return self.telemetry(backend)["status_line"]


class EngineContractTests(unittest.TestCase):
    def test_three_items_dispatch_and_one_failure_does_not_block_the_other_two(self):
        with tempfile.TemporaryDirectory() as root:
            executor = FakeLocalExecutor()
            governor = CapacityGovernor(
                cap=2,
                per_review_budget_mb=1,
                reserve_mb=1,
                mem_available_mb=lambda: 100,
                cpu_count=lambda: 4,
            )
            engine = ReviewEngine(
                state_root=root,
                cache=ReviewCache(Path(root) / "reviews"),
                governor=governor,
                local_executor=executor,
            )
            result = engine.run_sync(
                BatchSnapshot(tuple(item(n, h) for n, h in enumerate(HEADS, 1)), {}),
                "goose",
                "gemini-3.8-flash",
                "high",
                "scope-v7",
            )
            self.assertEqual(set(result.results), {
                "projectbluefin/review#1",
                "projectbluefin/review#3",
            })
            self.assertEqual(result.failures["projectbluefin/review#2"], "provider failed")
            self.assertEqual(len(executor.calls), 3)

    def test_exact_cache_hit_skips_executor(self):
        with tempfile.TemporaryDirectory() as root:
            cache = ReviewCache(Path(root) / "reviews")
            fake = FakeLocalExecutor()
            engine = ReviewEngine(
                state_root=root,
                cache=cache,
                governor=CapacityGovernor(
                    cap=1, per_review_budget_mb=1, reserve_mb=1,
                    mem_available_mb=lambda: 100, cpu_count=lambda: 2,
                ),
                local_executor=fake,
            )
            selected = item(1, HEADS[0])
            run = ReviewRun.from_request(
                selected.request(),
                backend="goose",
                model="gemini-3.8-flash",
                effort="high",
            )
            cache.put(
                ReviewReceipt.from_result(
                    run,
                    ReviewResult(
                        1, "complete",
                        {"critical": 0, "high": 0, "medium": 0, "low": 0},
                        [], [], {"backend": "goose", "model": "gemini-3.8-flash"},
                        {}, {}, [],
                    ),
                    ["cached"],
                    "scope-v7",
                )
            )
            result = engine.run_sync(
                BatchSnapshot((selected,), {}),
                "goose",
                "gemini-3.8-flash",
                "high",
                "scope-v7",
            )
            self.assertIn(selected.key, result.results)
            self.assertEqual(fake.calls, [])

    def test_headroom_refreshes_per_batch_and_routes_each_dispatched_pr(self):
        with tempfile.TemporaryDirectory() as root:
            headroom = FakeHeadroomSession()
            executor = FakeLocalExecutor()
            engine = ReviewEngine(
                state_root=root,
                cache=ReviewCache(Path(root) / "reviews"),
                governor=CapacityGovernor(
                    cap=2, per_review_budget_mb=1, reserve_mb=1,
                    mem_available_mb=lambda: 100, cpu_count=lambda: 4,
                ),
                headroom_session=headroom,
                local_executor=executor,
            )
            result = engine.run_sync(
                BatchSnapshot(tuple(item(n, h) for n, h in enumerate(HEADS, 1)), {}),
                "goose",
                "gemini-3.8-flash",
                "high",
                "scope-v7",
            )
            self.assertEqual(headroom.refresh_calls, ["goose", "goose"])
            self.assertEqual(headroom.route_calls, ["goose", "goose", "goose"])
            self.assertEqual(
                result.results["projectbluefin/review#1"].provenance["headroom_state"],
                "ACTIVE",
            )
            self.assertEqual(
                result.results["projectbluefin/review#1"].provenance["headroom_output_reduction_percent"],
                20.0,
            )

    def test_state_parser_repairs_a_torn_tail(self):
        with tempfile.TemporaryDirectory() as root:
            path = Path(root) / "state.jsonl"
            path.write_text('{"key":"one","state":"complete"}\n{"key":"two","sta')
            events = parse_review_status(str(path))
            self.assertEqual(events["one"]["state"], "complete")
            self.assertNotIn("two", events)


if __name__ == "__main__":
    unittest.main()
```

Append this method to the existing `HarnessContract` in
`tests/harness-contract.py`, reusing its existing `self.ENV`,
`self.STATS_PAYLOAD`, `_FakeResponse`, and `_fake_urlopen` fixtures:

```python
def test_telemetry_exposes_route_and_aggregate_output_reduction(self):
    calls = []
    routes = {
        "/readyz": [_FakeResponse(b"ok")],
        "/stats?cached=1": [_FakeResponse(self.STATS_PAYLOAD)],
    }
    with patch("urllib.request.urlopen", _fake_urlopen(routes, calls)):
        session = HeadroomSession.from_environment(self.ENV)
        self.assertEqual(session.refresh("codex").state, "ACTIVE")
        self.assertEqual(session.route_for_call("codex").base_url, "http://127.0.0.1:8787")
        telemetry = session.telemetry("codex")
    self.assertEqual(telemetry["state"], "ACTIVE")
    self.assertEqual(telemetry["route"], "http://127.0.0.1:8787")
    self.assertEqual(telemetry["output_reduction_percent"], self.STATS_PAYLOAD["tokens"]["output_reduction"]["reduction_percent"])
    self.assertEqual(telemetry["output_reduction_method"], "measured")
    self.assertIn("proxy delta", telemetry["status_line"])
```

- [ ] **Step 2: Run the scheduler tests and verify the new module is absent.**

Run: `python3 tests/review_engine_contract.py`

Expected: `ModuleNotFoundError: No module named 'tui.review_engine'`.

- [ ] **Step 3: Implement the JSONL event writer and state fold using the landing rules.**

```python
# image/tui/review_engine.py, state and event portion
from __future__ import annotations

import contextlib
import fcntl
import json
import os
import re
import shlex
import signal
import subprocess
import tempfile
import threading
import time
from concurrent.futures import Future, ThreadPoolExecutor
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable, Mapping, Protocol

from tui.capacity import CapacityGovernor
from tui.review_cache import ReviewCache
from tui.review_receipt import ReviewReceipt
from tui.review_run import ReviewRun, ReviewRunController, ReviewRunState
from tui.review_snapshot import BatchReviewItem, BatchSnapshot

TERMINAL_REVIEW_STATES = frozenset({"complete", "findings", "failed", "cancelled"})
```


Add this bounded public telemetry method to the existing `HeadroomSession` in
`image/tui/headroom.py:231-339`; it exposes existing state and counters without
moving routing or capacity logic:

```python
def telemetry(self, backend: str) -> dict[str, object]:
    route = self._routes.get(backend) or self._default_route(backend)
    delta = self._delta
    last = self._last_stats
    return {
        "state": route.state,
        "route": route.base_url or "",
        "status_line": self.status_line(backend, True),
        "requests": delta.requests if delta is not None else 0,
        "tokens_saved": delta.tokens_saved if delta is not None else 0,
        "output_tokens_saved": delta.output_tokens_saved if delta is not None else 0,
        "output_reduction_percent": (
            last.output_reduction_percent
            if last is not None and not self._stats_degraded
            else None
        ),
        "output_reduction_method": (
            last.output_reduction_method
            if last is not None and not self._stats_degraded
            else None
        ),
        "statistics_degraded": self._stats_degraded,
    }
```

The existing harness contract gains one test that calls `refresh("codex")`,
then `route_for_call("codex")`, then `telemetry("codex")`, and asserts the
`ACTIVE`/`DIRECT`/`DEGRADED` state, route URL, proxy delta counters, and
output-reduction fields remain bounded. The existing `status_line()` assertions
at `tests/harness-contract.py:1027-1131` remain unchanged.

```python
# image/tui/review_engine.py, continued
def REVIEW_ENGINE_STATE_DIR() -> str:
    root = os.environ.get("XDG_STATE_HOME", os.path.expanduser("~/.local/state"))
    path = os.path.join(root, "bluefin-review", "review-batches")
    os.makedirs(path, exist_ok=True)
    return path


@dataclass(frozen=True)
class ReviewEvent:
    key: str
    state: str
    note: str
    timestamp: int
    receipt: str = ""

    def to_dict(self) -> dict[str, Any]:
        value = {
            "key": self.key,
            "state": self.state,
            "note": self.note,
            "ts": self.timestamp,
        }
        if self.receipt:
            value["receipt"] = self.receipt
        return value


@contextlib.contextmanager
def _locked_events(path: str):
    descriptor = os.open(path, os.O_RDWR | os.O_CREAT, 0o644)
    handle = os.fdopen(descriptor, "r+", encoding="utf-8")
    fcntl.flock(handle, fcntl.LOCK_EX)
    try:
        events: list[dict[str, Any]] = []
        handle.seek(0)
        for line in handle:
            value = line.strip()
            if not value:
                continue
            try:
                event = json.loads(value)
            except ValueError:
                continue
            if isinstance(event, dict):
                events.append(event)
        yield handle, events
    finally:
        fcntl.flock(handle, fcntl.LOCK_UN)
        handle.close()


def _append_locked(handle, event: dict[str, Any]) -> None:
    handle.seek(0)
    content = handle.read()
    if content and not content.endswith("\n"):
        boundary = content.rfind("\n") + 1
        try:
            json.loads(content[boundary:])
        except ValueError:
            handle.truncate(boundary)
        else:
            handle.seek(0, os.SEEK_END)
            handle.write("\n")
    handle.seek(0, os.SEEK_END)
    handle.write(json.dumps(event, separators=(",", ":")) + "\n")
    handle.flush()
    os.fsync(handle.fileno())


def append_review_event(path: str, event: ReviewEvent) -> None:
    with _locked_events(path) as (handle, events):
        if events and events[-1].get("key") == event.key:
            previous = events[-1].get("state")
            if previous in TERMINAL_REVIEW_STATES and event.state not in TERMINAL_REVIEW_STATES:
                raise RuntimeError(f"{event.key} is already terminal")
        _append_locked(handle, event.to_dict())


def parse_review_status(path: str) -> dict[str, dict[str, Any]]:
    latest: dict[str, dict[str, Any]] = {}
    try:
        with open(path, encoding="utf-8") as handle:
            for line in handle:
                try:
                    value = json.loads(line)
                except ValueError:
                    continue
                if isinstance(value, dict) and value.get("key"):
                    latest[str(value["key"])] = value
    except OSError:
        return {}
    return latest
```

- [ ] **Step 4: Implement the local subprocess executor through receipt mode and the existing harness seam.**

```python
# image/tui/review_engine.py, executor portion
class ReviewExecutor(Protocol):
    def run(
        self,
        review_item: BatchReviewItem,
        run: ReviewRun,
        workdir: Path,
        check_scope_version: str,
        check_scope: str,
        headroom_route: HeadroomRoute,
        headroom_telemetry: Mapping[str, Any],
    ) -> ReviewReceipt: ...


class BrokerUnavailable(RuntimeError):
    pass


class LocalExecutor:
    def __init__(self, command: str | None = None) -> None:
        self.command = command or os.environ.get("BLUEFIN_REVIEW_COMMAND", "bluefin-review")
        self._processes: dict[str, subprocess.Popen[str]] = {}
        self._lock = threading.Lock()

    def run(
        self,
        review_item: BatchReviewItem,
        run: ReviewRun,
        workdir: Path,
        check_scope_version: str,
        check_scope: str,
        headroom_route: HeadroomRoute,
        headroom_telemetry: Mapping[str, Any],
    ) -> ReviewReceipt:
        command = [
            self.command,
            "receipt",
            "--repository", review_item.repository,
            "--pull-request", str(review_item.number),
            "--base-sha", review_item.base_sha,
            "--head-sha", review_item.head_sha,
            "--backend", run.backend,
            "--model", run.model,
            "--effort", run.effort,
            "--check-scope-version", check_scope_version,
            "--workdir", str(workdir),
        ]
        if check_scope:
            command.extend(["--check-scope", check_scope])
        environment = dict(os.environ)
        environment["BLUEFIN_REVIEW_REPOSITORY_ROOT"] = str(workdir)
        process = subprocess.Popen(
            command,
            cwd=str(workdir),
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            env=environment,
            start_new_session=True,
        )
        with self._lock:
            self._processes[run.identity] = process
        try:
            stdout, stderr = process.communicate()
        finally:
            with self._lock:
                self._processes.pop(run.identity, None)
        if process.returncode not in (0, 65):
            detail = (stderr or stdout).strip() or f"receipt exited {process.returncode}"
            raise RuntimeError(detail[:240])
        receipt = ReviewReceipt.from_json(stdout)
        return receipt.with_provenance({
            "headroom_state": headroom_route.state,
            "headroom_route": headroom_route.base_url or "",
            "headroom_status_line": headroom_telemetry["status_line"],
            "headroom_output_reduction_percent": headroom_telemetry["output_reduction_percent"],
            "headroom_output_reduction_method": headroom_telemetry["output_reduction_method"],
            "headroom_output_tokens_saved": headroom_telemetry["output_tokens_saved"],
        })

    def cancel(self, run: ReviewRun) -> None:
        with self._lock:
            process = self._processes.get(run.identity)
        if process is None:
            return
        try:
            os.killpg(process.pid, signal.SIGTERM)
        except ProcessLookupError:
            return


def _worktree_path(root: str, item: BatchReviewItem) -> Path:
    import hashlib
    digest = hashlib.sha256(
        f"{item.repository}\0{item.head_sha}".encode("utf-8")
    ).hexdigest()[:24]
    return Path(root) / f"{item.repository.replace('/', '__')}-{digest}"


def _prepare_worktree(item: BatchReviewItem, root: str) -> Path:
    path = _worktree_path(root, item)
    path.parent.mkdir(parents=True, exist_ok=True)
    if path.exists():
        actual = subprocess.check_output(
            ["git", "-C", str(path), "rev-parse", "HEAD"], text=True
        ).strip()
        if actual != item.head_sha:
            raise RuntimeError(f"{item.key} worktree head drifted to {actual}")
        return path
    subprocess.run(
        ["gh", "repo", "clone", item.repository, str(path), "--", "--quiet"],
        check=True,
        capture_output=True,
        text=True,
    )
    subprocess.run(
        ["git", "-C", str(path), "fetch", "--quiet", "origin", item.head_sha],
        check=True,
        capture_output=True,
        text=True,
    )
    subprocess.run(
        ["git", "-C", str(path), "checkout", "--quiet", "--detach", item.head_sha],
        check=True,
        capture_output=True,
        text=True,
    )
    return path
```

- [ ] **Step 5: Implement the scheduler with capacity re-evaluation, cache hits, per-PR failures, and isolated worktrees.**

```python
# image/tui/review_engine.py, scheduler portion
@dataclass
class ReviewBatch:
    batch_id: str
    status_path: str
    items: tuple[BatchReviewItem, ...]
    backend: str
    model: str
    effort: str
    headroom_status_line: str
    headroom_output_reduction: dict[str, object]
    running: bool = True


@dataclass(frozen=True)
class ReviewBatchResult:
    results: dict[str, ReviewReceipt]
    failures: dict[str, str]


class ReviewEngine:
    def __init__(
        self,
        *,
        state_root: str | os.PathLike[str] | None = None,
        cache: ReviewCache | None = None,
        governor: CapacityGovernor | None = None,
        headroom_session: HeadroomSession | None = None,
        local_executor: ReviewExecutor | None = None,
        broker_executor: ReviewExecutor | None = None,
        worktree_root: str | os.PathLike[str] | None = None,
    ) -> None:
        self.state_root = Path(state_root or REVIEW_ENGINE_STATE_DIR())
        self.state_root.mkdir(parents=True, exist_ok=True)
        self.cache = cache or ReviewCache()
        self.governor = governor or CapacityGovernor()
        self.headroom_session = headroom_session or HeadroomSession.from_environment()
        self.local_executor = local_executor or LocalExecutor()
        self.broker_executor = broker_executor
        self.worktree_root = str(worktree_root or self.state_root / "worktrees")
        self._batches: dict[str, ReviewBatch] = {}
        self._cancelled: set[str] = set()

    def _new_batch(
        self,
        snapshot: BatchSnapshot,
        backend: str,
        model: str,
        effort: str,
        headroom_telemetry: Mapping[str, object],
    ) -> ReviewBatch:
        stamp = time.strftime("%Y%m%d-%H%M%S")
        batch_id = f"{stamp}-{os.environ.get('BLUEFIN_REVIEW_INSTANCE', 'dashboard')}"
        suffix = 2
        status_path = self.state_root / f"{batch_id}.jsonl"
        while status_path.exists():
            batch_id = f"{stamp}-{suffix}"
            suffix += 1
            status_path = self.state_root / f"{batch_id}.jsonl"
        batch = ReviewBatch(
            batch_id,
            str(status_path),
            snapshot.items,
            backend,
            model,
            effort,
            str(headroom_telemetry["status_line"]),
            dict(headroom_telemetry),
        )
        status_path.write_text(
            json.dumps(
                {
                    "version": 1,
                    "batch_id": batch_id,
                    "expect": [item.key for item in snapshot.items],
                    "ts": int(time.time()),
                },
                separators=(",", ":"),
            ) + "\n"
        )
        return batch

    def start(
        self,
        snapshot: BatchSnapshot,
        backend: str,
        model: str,
        effort: str,
        check_scope_version: str,
        check_scope: str = "",
        on_event: Callable[[ReviewEvent], None] | None = None,
    ) -> ReviewBatch:
        self.headroom_session.refresh(backend)
        batch = self._new_batch(
            snapshot,
            backend,
            model,
            effort,
            self.headroom_session.telemetry(backend),
        )
        self._batches[batch.batch_id] = batch
        thread = threading.Thread(
            target=self._run,
            args=(batch, check_scope_version, check_scope, on_event),
            daemon=True,
        )
        thread.start()
        return batch

    def run_sync(
        self,
        snapshot: BatchSnapshot,
        backend: str,
        model: str,
        effort: str,
        check_scope_version: str,
        check_scope: str = "",
        on_event: Callable[[ReviewEvent], None] | None = None,
    ) -> ReviewBatchResult:
        if not snapshot.ready:
            raise ValueError(f"batch snapshot is not ready: {snapshot.failures}")
        self.headroom_session.refresh(backend)
        batch = self._new_batch(
            snapshot,
            backend,
            model,
            effort,
            self.headroom_session.telemetry(backend),
        )
        self._batches[batch.batch_id] = batch
        return self._run(batch, check_scope_version, check_scope, on_event)

    def _emit(self, batch: ReviewBatch, event: ReviewEvent, callback) -> None:
        append_review_event(batch.status_path, event)
        if callback is not None:
            callback(event)

    def _run(self, batch, check_scope_version, check_scope, callback):
        self.cache.prune()
        results: dict[str, ReviewReceipt] = {}
        failures: dict[str, str] = {}
        pending = list(batch.items)
        active: dict[
            Future[ReviewReceipt],
            tuple[BatchReviewItem, ReviewRun, Path, HeadroomRoute, dict[str, object]],
        ] = {}
        with ThreadPoolExecutor(max_workers=max(1, self.governor.cap)) as pool:
            while pending or active:
                while pending and self.governor.can_start(len(active)):
                    item = pending.pop(0)
                    request = item.request()
                    run = ReviewRun.from_request(
                        request,
                        backend=batch.backend,
                        model=batch.model,
                        effort=batch.effort,
                    )
                    cached = self.cache.get(run, check_scope_version)
                    if cached is not None:
                        results[item.key] = cached
                        self._emit(
                            batch,
                            ReviewEvent(item.key, "cached", "exact identity hit", int(time.time())),
                            callback,
                        )
                        continue
                    if batch.batch_id in self._cancelled:
                        failures[item.key] = "cancelled before dispatch"
                        self._emit(
                            batch,
                            ReviewEvent(item.key, "cancelled", failures[item.key], int(time.time())),
                            callback,
                        )
                        continue
                    try:
                        workdir = _prepare_worktree(item, self.worktree_root)
                        executor = self.broker_executor or self.local_executor
                        call_route = self.headroom_session.route_for_call(batch.backend)
                        call_telemetry = self.headroom_session.telemetry(batch.backend)
                        self._emit(
                            batch,
                            ReviewEvent(item.key, "running", "review dispatched", int(time.time())),
                            callback,
                        )
                        future = pool.submit(
                            self._run_one,
                            executor,
                            item,
                            run,
                            workdir,
                            check_scope_version,
                            check_scope,
                            call_route,
                            call_telemetry,
                        )
                        active[future] = (
                            item,
                            run,
                            workdir,
                            call_route,
                            call_telemetry,
                        )
                    except Exception as error:
                        failures[item.key] = str(error)[:240]
                        self._emit(
                            batch,
                            ReviewEvent(item.key, "failed", failures[item.key], int(time.time())),
                            callback,
                        )
                finished = [future for future in active if future.done()]
                if not finished:
                    time.sleep(0.02)
                    continue
                for future in finished:
                    item, run, workdir, call_route, call_telemetry = active.pop(future)
                    try:
                        receipt = future.result().with_provenance({
                            "headroom_state": call_route.state,
                            "headroom_route": call_route.base_url or "",
                            "headroom_status_line": call_telemetry["status_line"],
                            "headroom_output_reduction_percent": call_telemetry["output_reduction_percent"],
                            "headroom_output_reduction_method": call_telemetry["output_reduction_method"],
                            "headroom_output_tokens_saved": call_telemetry["output_tokens_saved"],
                        })
                        self.cache.put(receipt)
                        results[item.key] = receipt
                        self._emit(
                            batch,
                            ReviewEvent(item.key, receipt.analysis.state, "review complete", int(time.time()), self.cache.path_for(run, check_scope_version).name),
                            callback,
                        )
                    except Exception as error:
                        failures[item.key] = str(error)[:240]
                        self._emit(
                            batch,
                            ReviewEvent(item.key, "failed", failures[item.key], int(time.time())),
                            callback,
                        )
                if not pending and not active:
                    break
        self.headroom_session.refresh(batch.backend)
        batch.headroom_status_line = self.headroom_session.status_line(batch.backend, True)
        batch.headroom_output_reduction = self.headroom_session.telemetry(batch.backend)
        batch.running = False
        return ReviewBatchResult(results, failures)

    @staticmethod
    def _run_one(
        executor,
        item,
        run,
        workdir,
        check_scope_version,
        check_scope,
        headroom_route,
        headroom_telemetry,
    ):
        try:
            return executor.run(
                item,
                run,
                workdir,
                check_scope_version,
                check_scope,
                headroom_route,
                headroom_telemetry,
            )
        except BrokerUnavailable:
            return LocalExecutor().run(
                item,
                run,
                workdir,
                check_scope_version,
                check_scope,
                headroom_route,
                headroom_telemetry,
            )

    def cancel(self, batch: ReviewBatch) -> None:
        self._cancelled.add(batch.batch_id)
        for item in batch.items:
            request = item.request()
            run = ReviewRun.from_request(
                request, backend=batch.backend, model=batch.model, effort=batch.effort
            )
            cancel = getattr(self.local_executor, "cancel", None)
            if callable(cancel):
                cancel(run)
            broker_cancel = getattr(self.broker_executor, "cancel", None)
            if callable(broker_cancel):
                broker_cancel(run)
```

The implementation must pass `ReviewRunController.start()` before a task is marked running and call `complete(receipt.analysis_result())` or `fail(error)` around each executor result so the existing state-machine contract remains the lifecycle authority. The controller is a record of the run state; process-group cancellation remains owned by the harness/`LocalExecutor`.

The Headroom sequence is deliberate: `refresh(backend)` establishes the batch
baseline before the first dispatch, `route_for_call(backend)` runs immediately
before each non-cached PR dispatch, and a second `refresh(backend)` samples the
aggregate proxy delta after the last PR completes. The per-PR route state,
route URL, `status_line`, output-reduction percent/method, and output-token
delta are merged into the receipt provenance before `ReviewCache.put`; a cache
hit does not create a new model call or alter the saved provenance.

- [ ] **Step 6: Run the engine contract and inspect the JSONL state file for complete terminal events.**

Run: `python3 tests/review_engine_contract.py`

Expected: `Ran 3 tests ... OK`; the generated status file contains two successful terminal events, one failed terminal event, and no shared-worktree path.

- [ ] **Step 7: Run the existing harness and result contracts because the engine crosses both adapters.**

Run: `python3 tests/review_result_contract.py && python3 tests/review_run_contract.py && python3 tests/harness-contract.py`

Expected: all three existing contracts pass unchanged.

- [ ] **Step 8: Commit the engine.**

```bash
git add image/tui/review_engine.py tests/review_engine_contract.py
git commit -m "feat: schedule parallel exact-head reviews" -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

## Task 7: Integrate selection, triage, badges, context-aware `r`, and cached decision cards

**Files:**
- Modify: `image/tui/bluefin_review_tui.py:165-230, 886-970, 2452-3095, 3157-3190, 3644-3675`.
- Modify: `tests/dashboard_pilot.py:850-1085, 1250-1455` with real Textual key presses and fake engine/capacity seams.
- Modify: `tests/dashboard-contract.sh:1-180` only for new absence/presence assertions.
- Test: `tests/dashboard_pilot.py`, `tests/dashboard-contract.sh`.

**Interfaces to consume:**
- `ReviewEngine.start`, `ReviewBatch`, and `ReviewEvent` from Task 6.
- `ReviewCache.get` from Task 3.
- `hydrate_batch_snapshot` from Task 5.
- `HeadroomSession.route_for_call(backend)` and `status_line(backend, caveman)` at `image/tui/headroom.py:260-293`; the single-review screen and batch screen share this exact route/status contract.
- Existing `ReviewScreen` single-review path at `image/tui/bluefin_review_tui.py:1909-2448`.
- Existing `row_markup`, `populate`, `refresh_rows`, and `current` at `image/tui/bluefin_review_tui.py:3022-3190`.

**Interfaces produced:**
- `TriageState = Literal["unseen", "reviewed", "skipped"]`.
- `ReviewDashboard.triage: dict[str, TriageState]`.
- `ReviewDashboard.review_engine: ReviewEngine`.
- `ReviewDashboard.review_batches: list[ReviewBatch]`.
- `ReviewDashboard.headroom_session: HeadroomSession`.
- `ReviewDashboard.headroom_status_line: str`.
- `ReviewDashboard.headroom_output_reduction: dict[str, object]`.
- `ReviewDashboard.triage_key(stop: Stop) -> str`, returning `repo#number@head-sha`.
- `ReviewDashboard.action_select_all() -> None` for `B`.
- `ReviewDashboard.action_toggle_advance() -> None` for `Space`.
- `ReviewDashboard.action_next_unreviewed() -> None` for `n`.
- `ReviewDashboard.start_review_batch(stops: list[Stop]) -> None`.
- `ReviewDecisionScreen(ModalScreen[None])` that renders cached analysis merged with current live evidence.

- [ ] **Step 1: Add pilot assertions for the new keys and badge states before changing the dashboard.**

```python
# tests/dashboard_pilot.py
async with tui.ReviewDashboard(tui.QueueFilters(action="")).run_test() as pilot:
    app = pilot.app
    await wait_for_live_rows(app, pilot, "ready", 2)
    await pilot.press("B")
    check(
        all(stop.selected for stop in app.stops),
        "B must select every visible row",
    )
    await pilot.press("B")
    check(
        not any(stop.selected for stop in app.stops),
        "B must clear every visible selection",
    )
    await pilot.press("space")
    check(
        app.stops[0].selected and app._queue().index == 1,
        "Space must toggle the highlighted row and advance",
    )
    await pilot.press("n")
    check(
        app._queue().index == 1,
        "n must jump to the next unreviewed row",
    )
    app.stops[0].review_status = "running"
    app.stops[1].review_status = "cached"
    app.stops[1].cached_age = "4m"
    app.refresh_rows()
    rendered = [
        str(child.query(tui.Label).first().render())
        for child in app._queue().children
    ]
    check("⏳" in rendered[0], "running rows must carry the pending badge")
    check("✓" in rendered[1] and "4m" in rendered[1], "cached rows must carry verdict and age")
    check(
        "Headroom" in str(app.query_one("#status-bar", tui.Static).render())
        or "DIRECT" in str(app.query_one("#status-bar", tui.Static).render()),
        "the batch status must surface the existing Headroom route status",
    )
```

- [ ] **Step 2: Run the pilot and verify the bindings and fields do not exist.**

Run: `bash tests/dashboard-contract.sh`

Expected: the new pilot assertions fail because `B`, `Space`, `n`, triage fields, and batch review dispatch are not present.

- [ ] **Step 3: Add the semantic bindings and state fields.**

```python
# image/tui/bluefin_review_tui.py
from typing import Literal
from headroom import HeadroomSession
from review_cache import ReviewCache
from review_engine import ReviewBatch, ReviewEngine, ReviewEvent
from review_snapshot import hydrate_batch_snapshot

TriageState = Literal["unseen", "reviewed", "skipped"]

# Add these entries to COMMANDS, preserving b for the existing single-row toggle:
CommandSpec("select_all", "B", "select_all", "select/clear visible rows"),
CommandSpec("toggle_advance", "space", "toggle_advance", "toggle and advance"),
CommandSpec("next_unreviewed", "n", "next_unreviewed", "next unreviewed row"),

@dataclass
class Stop:
    repository: str
    number: int
    action: str
    title: str
    author: str = ""
    mergeable_state: str = ""
    check_state: str = ""
    review_state: str = ""
    selected: bool = False
    failure: str = ""
    failure_command: str = ""
    failure_argv: list[str] = field(default_factory=list)
    failure_checks: str = ""
    failure_branch: str = ""
    live: dict = field(default_factory=dict)
    overlap: dict = field(default_factory=dict)
    review_result: ReviewResult | None = None
    review_status: str = ""
    cached_age: str = ""
    head_sha: str = ""
    triage_state: TriageState = "unseen"

    @property
    def key(self) -> str:
        return f"{self.repository}#{self.number}"

    @property
    def head_identity(self) -> str:
        return self.head_sha or str(self.live.get("headRefOid") or "")

    @property
    def triage_key(self) -> str:
        return f"{self.key}@{self.head_identity}"
```

Add `self.headroom_session = HeadroomSession.from_environment()`,
`self.headroom_status_line = self.headroom_session.status_line(ACTIVE_BACKEND, True)`,
`self.headroom_output_reduction = self.headroom_session.telemetry(ACTIVE_BACKEND)`,
`self.review_cache = ReviewCache()`, `self.review_engine = ReviewEngine(headroom_session=self.headroom_session)`,
`self.review_batches = []`, and `self.triage = {}` to `ReviewDashboard.__init__`.
Remove only the unreferenced `Stop.batchable` property; keep `mechanical`.
On mount, call `self.headroom_session.refresh(ACTIVE_BACKEND)` once for the
dashboard session, then copy `status_line(ACTIVE_BACKEND, True)` and
`telemetry(ACTIVE_BACKEND)` before the first `refresh_status()` call.

Make the existing single-review `ReviewScreen` use this same session rather
than creating a separate route. Extend its constructor with
`headroom_session: HeadroomSession | None = None`, call
`self.headroom_session.route_for_call(ACTIVE_BACKEND)` immediately before the
Goose or Codex harness invocation, render
`self.headroom_session.status_line(ACTIVE_BACKEND, True)` in the running status
line, call `refresh(ACTIVE_BACKEND)` after the process completes, and render
the resulting status line so the single-review path establishes the exact
route/caveman contract that the batch path reuses.

- [ ] **Step 4: Implement selection navigation and context-aware `r`.**

```python
def action_select_all(self) -> None:
    should_select = not self.stops or not all(stop.selected for stop in self.stops)
    for stop in self.stops:
        stop.selected = should_select
    self.refresh_rows()

def action_toggle_advance(self) -> None:
    stop = self.current
    if stop is None:
        return
    stop.selected = not stop.selected
    self.refresh_rows()
    self._queue().action_cursor_down()

def action_next_unreviewed(self) -> None:
    if not self.stops:
        return
    start = self._queue().index or 0
    current = self.current
    if current is not None and current.triage_state == "unseen":
        current.triage_state = "skipped"
        self.triage[self.triage_key(current)] = "skipped"
    for offset in range(1, len(self.stops) + 1):
        index = (start + offset) % len(self.stops)
        stop = self.stops[index]
        if stop.triage_state == "unseen":
            self._queue().index = index
            return
    self.notify("all visible rows have been triaged.", severity="information")

def triage_key(self, stop: Stop) -> str:
    return stop.triage_key

def action_review(self) -> None:
    batch = [stop for stop in self.stops if stop.selected]
    if batch:
        self.start_review_batch(batch)
    elif self.current:
        self.start_review(self.current)
```

`start_review_batch` must run hydration in `@work(thread=True)`, call `hydrate_batch_snapshot`, and return to the UI thread before creating the `ReviewEngine` batch. On a failed snapshot, set each failure and keep every selected row selected. On success, mark every item `review_status = "running"`, set triage state to `reviewed`, and call:

```python
batch = self.review_engine.start(
    snapshot,
    ACTIVE_BACKEND,
    selected_model,
    selected_effort,
    check_scope_version=self.review_scope_version,
    check_scope=self.review_scope,
    on_event=self.review_event,
)
self.review_batches.append(batch)
```

Change both existing `self.push_screen(ReviewScreen(...))` sites in
`start_review` to pass `headroom_session=self.headroom_session`; do not let a
single review silently construct a second Headroom session.

The batch callback must copy `batch.headroom_status_line` and
`batch.headroom_output_reduction` into `self.headroom_status_line` and
`self.headroom_output_reduction`. `refresh_status()` appends the bounded
headroom status line and, when available, the aggregate
`output_reduction_percent` plus method to the dashboard status bar. It must
not display a per-review saving; `HeadroomSession.status_line()` deliberately
labels its counters as a proxy delta.

The status-bar addition is:

```python
headroom = escape(self.headroom_status_line)
reduction = self.headroom_output_reduction.get("output_reduction_percent")
method = self.headroom_output_reduction.get("output_reduction_method")
headroom_reduction = (
    f" | output reduction {reduction:g}% {escape(str(method))}"
    if isinstance(reduction, (int, float)) and isinstance(method, str)
    else ""
)
# Append f" | {headroom}{headroom_reduction}" to the existing status-bar f-string.
```

Insert the final fragment `f" | {headroom}{headroom_reduction}"` into the
existing `status_bar.update(...)` f-string immediately after the batch/policy
text; do not build a second status-bar renderer.

- [ ] **Step 5: Add live-head cache annotation and verdict rendering.**

```python
def _review_badge(self, stop: Stop) -> str:
    if stop.review_status in {"queued", "running"}:
        return "⏳ running"
    result = stop.review_result
    if result is None:
        return ""
    if result.state == "complete" and result.is_clean:
        badge = "✓"
    elif result.state == "findings":
        badge = "✗"
    else:
        badge = "?"
    age = f" cached {stop.cached_age}" if stop.cached_age else ""
    return f" {badge}{age}"

def row_markup(self, stop: Stop) -> str:
    selected = "● " if stop.selected else "  "
    tag = " (MECHANICAL)" if stop.mechanical else ""
    failed = " ✗ DID NOT MERGE" if stop.failure else ""
    marks = self._review_badge(stop)
    checks = effective_check_state(stop.check_state, stop.live)
    if stop.mergeable_state == "dirty":
        marks += " ⚑ CONFLICTS"
    marks += f" {ci_marker(checks)}"
    if stop.review_state == "approved":
        marks += " ✓ approved"
    body = (
        f"{selected}{link(stop.key, pr_url(stop.repository, stop.number))}: "
        f"{escape(stop.title[:60])}{tag}{marks} "
        f"{escape('[' + stop.action + ']')}{failed}"
    )
    style = stop_style(stop.action, stop.mergeable_state, checks, stop.review_state)
    return f"[{style}]{body}[/{style}]" if style else body
```

The implementation must use the exact existing closing bracket in the final f-string (`escape("[" + stop.action + "]")`); the code block above is the complete replacement body, not a new markup convention. Add a `review_event` UI-thread callback that looks up the stop by key, loads the receipt named by the event, sets `review_result = receipt.analysis_result(live=stop.live, overlap=stop.overlap)`, stores `cached_age`, and calls `refresh_rows()` and `refresh_status()`.

- [ ] **Step 6: Add the cached decision card and Enter behavior.**

```python
class ReviewDecisionScreen(ModalScreen[None]):
    BINDINGS = [*back_bindings("dismiss(None)")]

    def __init__(self, stop: Stop) -> None:
        super().__init__()
        self.stop_record = stop

    def compose(self) -> ComposeResult:
        stop = self.stop_record
        result = stop.review_result
        assert result is not None
        card = build_decision_card(
            result,
            exact_head=str(stop.live.get("headRefOid") or stop.head_sha),
        )
        lines = [
            f"{card.state.value.upper()} {escape(stop.key)}",
            f"head {escape(str(stop.live.get('headRefOid') or stop.head_sha))}",
            f"live CI {escape(str(stop.live.get('mergeStateStatus') or '?'))}",
            f"findings {len(card.findings)}",
            "[escape] closes",
        ]
        for finding in card.findings[:8]:
            lines.append(
                f"{finding.severity.upper()} {escape(finding.file)}:{finding.line} "
                f"{escape(finding.title)}"
            )
        yield Static("\n".join(lines), id="cached-decision-card")

def action_activate(self) -> None:
    stop = self.current
    if stop and stop.review_result is not None:
        self.push_screen(ReviewDecisionScreen(stop))
    elif stop:
        self.action_view_diff()
```

Before rendering the card, `show_evidence` must re-fetch the full live `gh pr view` response and replace only `live`/`overlap` on the result through `ReviewReceipt.analysis_result`; it must never update the cache file with those live values.

- [ ] **Step 7: Run the dashboard pilot and the static absence contract.**

Run: `bash tests/dashboard-contract.sh`

Expected: PASS with real `run_test()` key presses proving `B`, `Space`, `n`, context-aware `r`, `⏳`/`✓`/`✗`/`?` badges, force-push triage reset, and cached decision-card/live-evidence merging.

- [ ] **Step 8: Commit dashboard review integration.**

```bash
git add image/tui/bluefin_review_tui.py tests/dashboard_pilot.py tests/dashboard-contract.sh
git commit -m "feat: add batch review dashboard controls" -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

## Task 8: Add the bulk `a` ActionPlan and exact-list drift gate

**Files:**
- Modify: `image/tui/action_plan.py:54-850` by adding batch-only immutable types after the existing single-PR contract; do not change the existing `ActionPlan` behavior.
- Modify: `image/tui/bluefin_review_tui.py:3491-3600, 3914-3995`.
- Test: `tests/action_plan_contract.py` with batch tests.
- Modify: `tests/dashboard_pilot.py:1630-1725` with exact-list confirmation and per-item drift tests.
- Test: `tests/action_plan_contract.py`, `tests/dashboard_pilot.py`.

**Interfaces to consume:**
- Existing single-PR `ActionPlan`, `CurrentState`, `Prerequisites`, `HumanConfirmation`, and `PlanDriftError` at `image/tui/action_plan.py:158-285, 502-850`.
- Existing Hive queue command construction at `image/tui/bluefin_review_tui.py:3914-3975`.
- Existing `mutate_all` gate at `image/tui/bluefin_review_tui.py:3491-3600`.

**Interfaces produced:**
- `BatchMutationItem` dataclass with `repository`, `pull_request`, `head_sha`, `prerequisites`, and `operations: tuple[tuple[str, ...], ...]`.
- `BatchActionPreview` dataclass with `plan_identity`, `items`, `action_kind`, `created_at`, and `expires_at`.
- `BatchHumanConfirmation` opaque capability carrying the exact canonical item list.
- `BatchExecutionEligibility` opaque capability.
- `BatchActionReceipt` with `succeeded`, `rejected`, and `failed` per-item maps.
- `BatchActionPlan.build(actor: str, tenant: str, action_kind: str, items: Sequence[BatchMutationItem], created_at: datetime | None = None, expires_at: datetime | None = None) -> BatchActionPlan`.
- `BatchActionPlan.preview() -> BatchActionPreview`.
- `BatchActionPlan.confirm_human(preview: BatchActionPreview, actor: str, tenant: str, typed_items: str, now: datetime | None = None) -> BatchHumanConfirmation`.
- `BatchActionPlan.execution_eligibility(confirmation: BatchHumanConfirmation, now: datetime | None = None) -> BatchExecutionEligibility`.
- `BatchActionPlan.execute(eligibility: BatchExecutionEligibility, current_state: Callable[[BatchMutationItem], CurrentState], executor: Callable[[BatchMutationItem, tuple[str, ...]], OperationResult | int], ledger: ReceiptLedger, now: datetime | None = None) -> BatchActionReceipt`.

- [ ] **Step 1: Write failing tests for exact list binding and per-item drift rejection.**

```python
# tests/action_plan_contract.py
def batch_item(module, number, head):
    return module.BatchMutationItem(
        repository="projectbluefin/review",
        pull_request=number,
        head_sha=head,
        prerequisites=module.Prerequisites.from_mappings(
            permissions={"push": True},
            checks={"ci": "success"},
        ),
        operations=(
            (
                "python3",
                "image/tui/hive_api.py",
                "queue",
                f"https://hive.example/pr/{number}",
            ),
        ),
    )


def test_batch_gate_binds_every_exact_head():
    module = contract
    first = batch_item(module, 184, "a" * 40)
    second = batch_item(module, 185, "b" * 40)
    plan = module.BatchActionPlan.build(
        actor="maintainer",
        tenant="projectbluefin",
        action_kind="approve-and-queue",
        items=(first, second),
        created_at=NOW,
        expires_at=EXPIRES,
    )
    preview = plan.preview()
    confirmation = plan.confirm_human(
        preview=preview,
        actor="maintainer",
        tenant="projectbluefin",
        typed_items=(
            "projectbluefin/review#184@"
            + "a" * 40
            + " projectbluefin/review#185@"
            + "b" * 40
        ),
        now=NOW,
    )
    assert confirmation.items == (first.identity, second.identity)


def test_batch_drift_rejects_only_the_changed_item():
    module = contract
    first = batch_item(module, 184, "a" * 40)
    second = batch_item(module, 185, "b" * 40)
    plan = module.BatchActionPlan.build(
        actor="maintainer",
        tenant="projectbluefin",
        action_kind="approve-and-queue",
        items=(first, second),
        created_at=NOW,
        expires_at=EXPIRES,
    )
    confirmation = plan.confirm_human(
        preview=plan.preview(),
        actor="maintainer",
        tenant="projectbluefin",
        typed_items=(
            "projectbluefin/review#184@" + "a" * 40
            + " projectbluefin/review#185@" + "b" * 40
        ),
        now=NOW,
    )
    eligibility = plan.execution_eligibility(confirmation, now=NOW)
    seen = []
    current = lambda item: module.CurrentState.capture(
        actor="maintainer",
        tenant="projectbluefin",
        repository=item.repository,
        pull_request=item.pull_request,
        head_sha=("c" * 40 if item.pull_request == 184 else item.head_sha),
        permissions={"push": True},
        checks={"ci": "success"},
    )
    receipt = plan.execute(
        eligibility,
        current,
        lambda item, operation: seen.append(item.pull_request) or 0,
        ledger=TestReceiptLedger(),
        now=NOW,
    )
    assert receipt.rejected == {184: "head drift invalidates the item"}
    assert receipt.succeeded == {185: 1}
    assert seen == [185]


class BatchActionPlanContractTests(unittest.TestCase):
    def test_batch_gate_binds_every_exact_head(self):
        test_batch_gate_binds_every_exact_head()

    def test_batch_drift_rejects_only_the_changed_item(self):
        test_batch_drift_rejects_only_the_changed_item()
```

Add these methods to the existing `ActionPlanContractTests` class and import `Callable` only if the test runner requires the annotation.

- [ ] **Step 2: Run the ActionPlan contract and verify the batch types are undefined.**

Run: `python3 tests/action_plan_contract.py`

Expected: `AttributeError: module 'action_plan' has no attribute 'BatchMutationItem'`.

- [ ] **Step 3: Implement the batch contract without weakening the single-PR validator.**

```python
# image/tui/action_plan.py
@dataclass(frozen=True)
class BatchMutationItem:
    repository: str
    pull_request: int
    head_sha: str
    prerequisites: Prerequisites
    operations: tuple[tuple[str, ...], ...]

    def __post_init__(self) -> None:
        if not _REPOSITORY.fullmatch(_text(self.repository, "repository")):
            raise InvalidPlanError("repository must be owner/name")
        object.__setattr__(self, "pull_request", _pull_request(self.pull_request))
        object.__setattr__(self, "head_sha", _head(self.head_sha))
        if not isinstance(self.prerequisites, Prerequisites):
            raise InvalidPlanError("prerequisites must be a Prerequisites value")
        operations = tuple(tuple(operation) for operation in self.operations)
        if not operations or any(not operation or any(not isinstance(arg, str) for arg in operation) for operation in operations):
            raise InvalidPlanError("batch operations must be non-empty argv vectors")
        object.__setattr__(self, "operations", operations)

    @property
    def identity(self) -> str:
        return f"{self.repository}#{self.pull_request}@{self.head_sha}"


@dataclass(frozen=True)
class BatchActionPreview:
    plan_identity: str
    actor: str
    tenant: str
    action_kind: str
    items: tuple[BatchMutationItem, ...]
    created_at: datetime
    expires_at: datetime


_BATCH_HUMAN_CAPABILITY = object()
_BATCH_EXECUTION_CAPABILITY = object()


@dataclass(frozen=True, init=False)
class BatchHumanConfirmation:
    plan_identity: str
    actor: str
    tenant: str
    items: tuple[str, ...]
    confirmed_at: datetime
    _capability: object = field(repr=False, compare=False)

    def __init__(self, *, plan_identity, actor, tenant, items, confirmed_at, _capability):
        if _capability is not _BATCH_HUMAN_CAPABILITY:
            raise HumanConfirmationRequired("batch confirmation is not human-issued")
        object.__setattr__(self, "plan_identity", plan_identity)
        object.__setattr__(self, "actor", actor)
        object.__setattr__(self, "tenant", tenant)
        object.__setattr__(self, "items", tuple(items))
        object.__setattr__(self, "confirmed_at", confirmed_at)
        object.__setattr__(self, "_capability", _capability)


@dataclass(frozen=True, init=False)
class BatchExecutionEligibility:
    plan_identity: str
    actor: str
    tenant: str
    confirmed_items: tuple[str, ...]
    eligible_at: datetime
    _capability: object = field(repr=False, compare=False)

    def __init__(self, *, plan_identity, actor, tenant, confirmed_items, eligible_at, _capability):
        if _capability is not _BATCH_EXECUTION_CAPABILITY:
            raise ExecutionNotEligible("batch execution eligibility is not plan-issued")
        object.__setattr__(self, "plan_identity", plan_identity)
        object.__setattr__(self, "actor", actor)
        object.__setattr__(self, "tenant", tenant)
        object.__setattr__(self, "confirmed_items", tuple(confirmed_items))
        object.__setattr__(self, "eligible_at", eligible_at)
        object.__setattr__(self, "_capability", _capability)


@dataclass(frozen=True)
class BatchActionReceipt:
    succeeded: dict[int, int]
    rejected: dict[int, str]
    failed: dict[int, str]


@dataclass(frozen=True)
class BatchActionPlan:
    actor: str
    tenant: str
    action_kind: str
    items: tuple[BatchMutationItem, ...]
    created_at: datetime
    expires_at: datetime
    _identity: str

    @classmethod
    def build(cls, *, actor, tenant, action_kind, items, created_at=None, expires_at=None):
        created = _utc(created_at, "created_at") if created_at else datetime.now(timezone.utc)
        expires = _utc(expires_at, "expires_at") if expires_at else created + DEFAULT_PLAN_TTL
        normalized = tuple(items)
        if not normalized:
            raise InvalidPlanError("batch action plan requires at least one item")
        if len(normalized) > MAX_OPERATIONS:
            raise InvalidPlanError(f"batch action plan cannot exceed {MAX_OPERATIONS} items")
        material = {
            "actor": actor,
            "tenant": tenant,
            "action_kind": action_kind,
            "items": [
                {
                    "identity": item.identity,
                    "prerequisites": item.prerequisites.payload(),
                    "operations": [list(operation) for operation in item.operations],
                }
                for item in normalized
            ],
            "created_at": created.isoformat(),
            "expires_at": expires.isoformat(),
        }
        return cls(
            _text(actor, "actor"),
            _text(tenant, "tenant"),
            _text(action_kind, "action_kind"),
            normalized,
            created,
            expires,
            sha256(_canonical(material)).hexdigest(),
        )

    def preview(self) -> BatchActionPreview:
        return BatchActionPreview(
            self._identity, self.actor, self.tenant, self.action_kind,
            self.items, self.created_at, self.expires_at,
        )

    def confirm_human(self, *, preview, actor, tenant, typed_items, now=None):
        current = _now(now)
        if preview.plan_identity != self._identity or actor != self.actor or tenant != self.tenant:
            raise HumanConfirmationRequired("batch confirmation does not match the plan")
        if current < self.created_at or current >= self.expires_at:
            raise PlanExpiredError("batch action plan has expired")
        expected = tuple(item.identity for item in self.items)
        actual = tuple(str(value) for value in str(typed_items).split())
        if actual != expected:
            raise HumanConfirmationRequired("typed confirmation does not match every exact PR and head")
        return BatchHumanConfirmation(
            plan_identity=self._identity,
            actor=actor,
            tenant=tenant,
            items=actual,
            confirmed_at=current,
            _capability=_BATCH_HUMAN_CAPABILITY,
        )

    def execution_eligibility(self, confirmation, *, now=None):
        current = _now(now)
        if not isinstance(confirmation, BatchHumanConfirmation):
            raise HumanConfirmationRequired("batch execution requires human confirmation")
        if confirmation.plan_identity != self._identity or confirmation.items != tuple(item.identity for item in self.items):
            raise HumanConfirmationRequired("batch confirmation is for another list")
        if current < self.created_at or current >= self.expires_at:
            raise PlanExpiredError("batch action plan has expired")
        return BatchExecutionEligibility(
            self._identity,
            self.actor,
            self.tenant,
            confirmation.items,
            current,
            _BATCH_EXECUTION_CAPABILITY,
        )

    def execute(self, eligibility, current_state, executor, *, ledger, now=None):
        if not isinstance(eligibility, BatchExecutionEligibility) or eligibility.plan_identity != self._identity:
            raise ExecutionNotEligible("batch execution eligibility does not match")
        succeeded: dict[int, int] = {}
        rejected: dict[int, str] = {}
        failed: dict[int, str] = {}
        for item in self.items:
            try:
                live = current_state(item)
                if live.head_sha != item.head_sha or live.prerequisites != item.prerequisites:
                    rejected[item.pull_request] = "head drift invalidates the item"
                    continue
                for operation in item.operations:
                    result = executor(item, operation)
                    if isinstance(result, int) and not isinstance(result, bool):
                        result = OperationResult(result)
                    if not isinstance(result, OperationResult) or result.return_code != 0:
                        detail = result.detail if isinstance(result, OperationResult) else "invalid operation result"
                        failed[item.pull_request] = detail[:MAX_RECEIPT_DETAIL]
                        break
                else:
                    succeeded[item.pull_request] = len(item.operations)
            except PlanDriftError as error:
                rejected[item.pull_request] = str(error)
            except Exception as error:
                failed[item.pull_request] = str(error)[:MAX_RECEIPT_DETAIL]
        receipt = BatchActionReceipt(succeeded, rejected, failed)
        ledger.record(receipt)
        return receipt
```

Add the new names to `__all__`. `ReceiptLedger.record` accepts the existing single-PR receipt type today; add a `BatchReceiptLedger` protocol or widen only the protocol's `record` parameter to `object` so the old tests and single-PR behavior remain unchanged.

- [ ] **Step 4: Add the dashboard batch confirmation screen and per-item live revalidation.**

```python
class BatchMutationConfirmation(ModalScreen[str | None]):
    BINDINGS = [
        Binding("enter", "submit", "confirm exact list", priority=True),
        *back_bindings("dismiss(None)"),
    ]

    def __init__(self, preview: action_plan.BatchActionPreview) -> None:
        super().__init__()
        self.preview_record = preview

    def compose(self) -> ComposeResult:
        with Vertical(id="confirm-box"):
            yield Label("type every exact PR and head, separated by spaces:")
            for item in self.preview_record.items:
                yield Static(f"  {item.identity}", classes="confirm-command")
            yield Input(id="batch-confirmation")
            yield Static("[enter] confirm exact list · [esc] abort", markup=False)

    def on_mount(self) -> None:
        self.query_one("#batch-confirmation", Input).focus()

    def action_submit(self) -> None:
        self.dismiss(self.query_one("#batch-confirmation", Input).value.strip())
```

Build the batch plan from the selected snapshot using one operation per item:

```python
def build_batch_queue_plan(self, batch: list[Stop]) -> action_plan.BatchActionPlan:
    items = []
    for stop in batch:
        live = stop.live
        items.append(
            action_plan.BatchMutationItem(
                stop.repository,
                stop.number,
                str(live["headRefOid"]),
                action_plan.Prerequisites.from_mappings(
                    permissions={"self_login": self.self_login},
                    checks={"ci": effective_check_state(stop.check_state, live)},
                ),
                (tuple(self._queue_command(stop)),),
            )
        )
    return action_plan.BatchActionPlan.build(
        actor=self.self_login,
        tenant="projectbluefin",
        action_kind="approve-and-queue",
        items=tuple(items),
    )
```

`_queue_command` must remain the existing Python `hive_api.py queue <endpoint>` argv and must not become `gh pr review`; the plan binds the exact head/check snapshot and the executor still calls the authenticated Hive endpoint. Before every item operation, fetch `gh pr view --json headRefOid,statusCheckRollup,mergeable,mergeStateStatus,isDraft`, build a `CurrentState`, call the batch plan's revalidation path, and mark only a drifted item rejected. Keep single-PR `a` on `_queue_automerge` and keep `m` on its current per-PR `mutate_all` path.

- [ ] **Step 5: Add the pilot for the exact typed list and item-level drift.**

```python
# tests/dashboard_pilot.py
async with tui.ReviewDashboard(tui.QueueFilters(action="")).run_test() as pilot:
    app = pilot.app
    await wait_for_live_rows(app, pilot, "ready", 2)
    app.self_login = "castrojo"
    for stop in app.stops:
        stop.selected = True
    await pilot.press("a")
    check(
        isinstance(app.screen, tui.BatchMutationConfirmation),
        "bulk a must open the exact-list ActionPlan gate",
    )
    gate = app.screen
    if isinstance(gate, tui.BatchMutationConfirmation):
        expected = " ".join(
            f"{item.repository}#{item.number}@{item.head_sha}"
            for item in gate.preview_record.items
        )
        await pilot.click("#batch-confirmation")
        await pilot.write(expected)
        await pilot.press("enter")
        await pilot.pause()
        check(
            app.batch_action_receipt.rejected == {7: "head drift invalidates the item"},
            "a changed live head must reject only that item",
        )
        check(
            app.batch_action_receipt.succeeded == {31: 1},
            "an unchanged item must still execute after another item drifts",
        )
```

- [ ] **Step 6: Run ActionPlan and dashboard contracts.**

Run: `python3 tests/action_plan_contract.py && bash tests/dashboard-contract.sh`

Expected: all existing single-PR gate tests pass, the new batch tests pass, `--admin`/force/branch-delete remain absent, and the pilot proves the typed list and per-item drift rejection.

- [ ] **Step 7: Commit the bulk mutation contract.**

```bash
git add image/tui/action_plan.py image/tui/bluefin_review_tui.py tests/action_plan_contract.py tests/dashboard_pilot.py
git commit -m "feat: gate bulk review actions by exact heads" -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

## Task 9: Replace the lab broker with the optional review-exec broker and broker executor

**Files:**
- Create: `scripts/review-exec-broker.py`.
- Create: `image/tui/review_exec_client.py`.
- Create: `tests/review-exec-broker-contract.py`.
- Modify: `image/tui/review_engine.py` to add `BrokerExecutor`.
- Modify: `justfile:798-840, 1271-1440` to rename the socket seam, preserve the one-question `/dev/tty` consent, pass gVisor `host-uds=open` only for `runsc`, and export broker availability.
- Modify: `tests/just-onboarding.sh:640-790` with the new broker names and Job assertions.
- Create: `docs/skills/review-exec-broker.md`.
- Test: `tests/review-exec-broker-contract.py`, `tests/just-onboarding.sh`.

**Interfaces to consume:**
- The existing UDS server boundary, validation style, session binding, socket permissions, and signal cleanup at `scripts/review-lab-broker.py:1-20, 239-342, 1289-1421`.
- Launcher consent and runtime handling at `justfile:798-840`.
- Cluster namespace, secret, image, service account, and non-root settings at `deploy/review-contributor.yaml:1-145`.
- `ReviewReceipt`, `ReviewRun`, and `ReviewExecutor` from Tasks 1 and 6.

**Interfaces produced:**
- Broker protocol version `1`, actions exactly `("status", "submit", "logs", "cancel")`.
- `review_exec_client.request(payload: Mapping[str, Any], timeout: float = 30.0) -> dict[str, Any]`.
- `review_exec_client.submit(repository: str, number: int, base_sha: str, head_sha: str, backend: str, model: str, effort: str) -> dict[str, Any]`.
- `review_exec_client.status() -> dict[str, Any]`.
- `review_exec_client.logs(job: str) -> dict[str, Any]`.
- `review_exec_client.cancel(job: str) -> dict[str, Any]`.
- `BrokerExecutor.run(item: BatchReviewItem, run: ReviewRun, workdir: Path, check_scope_version: str, check_scope: str, headroom_route: HeadroomRoute, headroom_telemetry: Mapping[str, Any]) -> ReviewReceipt`.
- `BrokerExecutor.cancel(run: ReviewRun) -> None`.
- Broker `submit` accepts only repository, number, base SHA, head SHA, backend, model, effort, and session; no arbitrary command, template, namespace, manifest, or kubectl argv.
- Jobs are created in `bluefin-system`, labelled with `review.session`, `review.repository`, `review.pr`, and `review.head`, and carry both `activeDeadlineSeconds` and `ttlSecondsAfterFinished`.
- Broker shutdown cancels all Jobs for its session; startup sweeps stale review-exec Jobs from dead sessions without touching live Jobs.

- [ ] **Step 1: Write the replacement broker contract before implementation.**

```python
# tests/review-exec-broker-contract.py
import importlib.util
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path

BROKER_PATH = Path(__file__).parents[1] / "scripts" / "review-exec-broker.py"


def load_module():
    spec = importlib.util.spec_from_file_location("review_exec_broker", BROKER_PATH)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


broker = load_module()


class FakeKubectl:
    def __init__(self):
        self.calls = []

    def __call__(self, args, *, input_text="", timeout=30):
        self.calls.append((list(args), input_text))
        if args[:2] == ["create", "-f"]:
            return broker.HostResult(args, 0, "job/review-exec-abc\n")
        if args[:2] == ["get", "jobs.batch"]:
            return broker.HostResult(
                args,
                0,
                json.dumps({"items": []}),
            )
        if args[:2] == ["delete", "job"]:
            return broker.HostResult(args, 0, "")
        if args[:2] == ["logs"]:
            return broker.HostResult(args, 0, '{"version":1}\n')
        return broker.HostResult(args, 0, "{}")


class ReviewExecContractTests(unittest.TestCase):
    def test_submit_manifest_is_typed_and_has_session_labels_and_deadlines(self):
        fake = FakeKubectl()
        broker.run_kubectl = fake
        context = broker.BrokerContext(
            session="session-a",
            image="ghcr.io/projectbluefin/review:stable",
        )
        answer = broker.handle_submit(
            context,
            {
                "version": 1,
                "action": "submit",
                "session": "session-a",
                "repository": "projectbluefin/review",
                "number": 372,
                "base_sha": "a" * 40,
                "head_sha": "b" * 40,
                "backend": "goose",
                "model": "gemini-3.8-flash",
                "effort": "high",
            },
        )
        self.assertTrue(answer["ok"])
        manifest = json.loads(fake.calls[0][1])
        self.assertEqual(manifest["metadata"]["namespace"], "bluefin-system")
        labels = manifest["metadata"]["labels"]
        self.assertEqual(labels["review.session"], "session-a")
        self.assertEqual(labels["review.repository"], "projectbluefin_review")
        self.assertEqual(labels["review.pr"], "372")
        self.assertEqual(labels["review.head"], "b" * 40)
        self.assertEqual(manifest["spec"]["activeDeadlineSeconds"], broker.JOB_DEADLINE_SECONDS)
        self.assertEqual(manifest["spec"]["ttlSecondsAfterFinished"], broker.JOB_TTL_SECONDS)
        args = manifest["spec"]["template"]["spec"]["containers"][0]["args"]
        self.assertIn("--head-sha", args)
        self.assertIn("b" * 40, args)

    def test_wrong_session_and_arbitrary_verb_are_rejected(self):
        context = broker.BrokerContext("session-a", image="review")
        self.assertEqual(
            broker.dispatch(
                context,
                json.dumps({
                    "version": 1,
                    "action": "status",
                    "session": "session-b",
                }).encode(),
            )["error"],
            "wrong-session",
        )
        self.assertEqual(
            broker.dispatch(
                context,
                json.dumps({
                    "version": 1,
                    "action": "exec",
                    "session": "session-a",
                }).encode(),
            )["error"],
            "unknown-action",
        )

    def test_session_cancel_and_startup_sweep_are_scoped(self):
        fake = FakeKubectl()
        broker.run_kubectl = fake
        context = broker.BrokerContext("session-a", image="review")
        broker.cancel_session_jobs(context)
        broker.sweep_orphans(context)
        joined = "\n".join(" ".join(call[0]) for call in fake.calls)
        self.assertIn("review.session=session-a", joined)
        self.assertIn("review.owner=review-exec", joined)


if __name__ == "__main__":
    unittest.main()
```

- [ ] **Step 2: Run the broker contract and verify the successor module is missing.**

Run: `python3 tests/review-exec-broker-contract.py`

Expected: `FileNotFoundError` for `scripts/review-exec-broker.py`.

- [ ] **Step 3: Implement the typed host broker by reusing the UDS framing but removing Argo, lab health, Prometheus, and issue filing.**

```python
# scripts/review-exec-broker.py
#!/usr/bin/env python3
from __future__ import annotations

import argparse
import contextlib
import datetime
import hmac
import json
import os
import re
import signal
import socketserver
import subprocess
import threading
from dataclasses import dataclass

PROTOCOL_VERSION = 1
ACTIONS = ("status", "submit", "logs", "cancel")
NAMESPACE = "bluefin-system"
JOB_DEADLINE_SECONDS = 3600
JOB_TTL_SECONDS = 3600
MAX_REQUEST_BYTES = 65536
MAX_RESPONSE_BYTES = 262144
REPOSITORY_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,62}/[A-Za-z0-9][A-Za-z0-9._-]{0,99}$")
SHA_RE = re.compile(r"^[0-9a-f]{40}$")
BACKENDS = frozenset({"goose", "codex"})
EFFORTS = frozenset({"low", "medium", "high", "max"})


class Rejected(Exception):
    def __init__(self, code: str, detail: str):
        super().__init__(detail)
        self.code = code
        self.detail = detail


@dataclass(frozen=True)
class HostResult:
    argv: tuple[str, ...]
    code: int
    stdout: str = ""
    stderr: str = ""
    reason: str = ""

    @property
    def ok(self) -> bool:
        return self.code == 0 and not self.reason


def run_host(argv, *, input_text: str = "", timeout: int = 30) -> HostResult:
    try:
        result = subprocess.run(
            list(argv),
            input=input_text,
            stdin=subprocess.PIPE,
            capture_output=True,
            text=True,
            timeout=timeout,
            check=False,
        )
    except FileNotFoundError:
        return HostResult(tuple(argv), 127, reason=f"{argv[0]} is not installed")
    except subprocess.TimeoutExpired:
        return HostResult(tuple(argv), 124, reason=f"{argv[0]} timed out")
    except OSError as error:
        return HostResult(tuple(argv), 126, reason=str(error))
    reason = "" if result.returncode == 0 else (result.stderr.strip() or f"exit {result.returncode}")[:240]
    return HostResult(tuple(argv), result.returncode, result.stdout, result.stderr, reason)


run_kubectl = lambda args, *, input_text="", timeout=30: run_host(
    ["kubectl", *args], input_text=input_text, timeout=timeout
)


@dataclass(frozen=True)
class BrokerContext:
    session: str
    image: str
    namespace: str = NAMESPACE


def _require(value, pattern, message):
    if not isinstance(value, str) or not pattern.fullmatch(value):
        raise Rejected("bad-request", message)
    return value


def require_repository(request):
    return _require(request.get("repository"), REPOSITORY_RE, "repository must be owner/repo")


def require_sha(request, field):
    return _require(request.get(field), SHA_RE, f"{field} must be a full lowercase SHA")


def require_number(request):
    value = request.get("number")
    if isinstance(value, bool) or not isinstance(value, int) or value < 1:
        raise Rejected("bad-request", "number must be a positive integer")
    return value


def require_backend(request):
    backend = request.get("backend")
    if backend not in BACKENDS:
        raise Rejected("bad-request", "backend must be goose or codex")
    return backend


def require_effort(request):
    effort = request.get("effort")
    if effort not in EFFORTS:
        raise Rejected("bad-request", "effort is unsupported")
    return effort


def sanitize_label(value: str) -> str:
    return re.sub(r"[^A-Za-z0-9._-]+", "-", value).strip("-._")[:63]


def decode_request(raw: bytes, context: BrokerContext) -> dict:
    if len(raw) > MAX_REQUEST_BYTES:
        raise Rejected("bad-request", "request is too large")
    try:
        request = json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, ValueError) as error:
        raise Rejected("bad-request", "request is not JSON") from error
    if not isinstance(request, dict) or request.get("version") != PROTOCOL_VERSION:
        raise Rejected("bad-request", "version is missing or unsupported")
    if request.get("action") not in ACTIONS:
        raise Rejected("unknown-action", "actions are status, submit, logs, cancel")
    if not isinstance(request.get("session"), str) or not hmac.compare_digest(
        request["session"], context.session
    ):
        raise Rejected("wrong-session", "request session does not match the broker")
    return request


def job_manifest(context: BrokerContext, request: dict) -> dict:
    repository = require_repository(request)
    number = require_number(request)
    base_sha = require_sha(request, "base_sha")
    head_sha = require_sha(request, "head_sha")
    backend = require_backend(request)
    model = _require(request.get("model"), re.compile(r"^[A-Za-z0-9._-]+$"), "model is invalid")
    effort = require_effort(request)
    labels = {
        "app.kubernetes.io/name": "review-exec",
        "review.owner": "review-exec",
        "review.session": sanitize_label(context.session),
        "review.repository": sanitize_label(repository.replace("/", "_")),
        "review.pr": str(number),
        "review.head": head_sha,
    }
    args = [
        "--repository", repository,
        "--pull-request", str(number),
        "--base-sha", base_sha,
        "--head-sha", head_sha,
        "--backend", backend,
        "--model", model,
        "--effort", effort,
        "--check-scope-version", os.environ.get("BLUEFIN_REVIEW_SCOPE_VERSION", "image-v1"),
    ]
    return {
        "apiVersion": "batch/v1",
        "kind": "Job",
        "metadata": {
            "generateName": "review-exec-",
            "namespace": context.namespace,
            "labels": labels,
        },
        "spec": {
            "backoffLimit": 0,
            "activeDeadlineSeconds": JOB_DEADLINE_SECONDS,
            "ttlSecondsAfterFinished": JOB_TTL_SECONDS,
            "template": {
                "metadata": {"labels": labels},
                "spec": {
                    "restartPolicy": "Never",
                    "serviceAccountName": "review-contributor",
                    "automountServiceAccountToken": False,
                    "containers": [{
                        "name": "review",
                        "image": context.image,
                        "command": ["/usr/local/bin/bluefin-review", "receipt"],
                        "args": args,
                        "envFrom": [{
                            "secretRef": {
                                "name": "review-contributor-secret",
                                "optional": True,
                            }
                        }],
                        "securityContext": {
                            "allowPrivilegeEscalation": False,
                            "capabilities": {"drop": ["ALL"]},
                            "runAsNonRoot": True,
                            "runAsUser": 1000,
                            "runAsGroup": 1000,
                        },
                    }],
                },
            },
        },
    }


def handle_submit(context: BrokerContext, request: dict) -> dict:
    manifest = job_manifest(context, request)
    result = run_kubectl(["create", "-f", "-"], input_text=json.dumps(manifest))
    if not result.ok:
        return {"version": PROTOCOL_VERSION, "ok": False, "error": "unavailable", "detail": result.reason[:240]}
    job = result.stdout.strip().split("/")[-1]
    return {"version": PROTOCOL_VERSION, "ok": True, "result": "submitted", "job": job}


def handle_status(context: BrokerContext, request: dict) -> dict:
    result = run_kubectl([
        "get", "jobs.batch", "-n", context.namespace,
        "-l", f"review.owner=review-exec,review.session={sanitize_label(context.session)}",
        "-o", "json",
    ])
    if not result.ok:
        return {"version": PROTOCOL_VERSION, "ok": False, "error": "unavailable", "detail": result.reason[:240]}
    try:
        payload = json.loads(result.stdout)
    except ValueError:
        return {"version": PROTOCOL_VERSION, "ok": False, "error": "unavailable", "detail": "kubectl returned invalid JSON"}
    jobs = []
    for item in payload.get("items", []):
        metadata = item.get("metadata", {})
        status = item.get("status", {})
        jobs.append({
            "job": metadata.get("name", ""),
            "active": int(status.get("active", 0) or 0),
            "succeeded": int(status.get("succeeded", 0) or 0),
            "failed": int(status.get("failed", 0) or 0),
        })
    return {"version": PROTOCOL_VERSION, "ok": True, "jobs": jobs}


def _job_name(request):
    value = request.get("job")
    if not isinstance(value, str) or not re.fullmatch(r"review-exec-[a-z0-9-]+", value):
        raise Rejected("bad-request", "job is invalid")
    return value


def _scoped_job_args(context, job):
    return ["get", "job", job, "-n", context.namespace, "-o", "json"]


def handle_logs(context: BrokerContext, request: dict) -> dict:
    job = _job_name(request)
    result = run_kubectl(["logs", "job/" + job, "-n", context.namespace], timeout=30)
    return {
        "version": PROTOCOL_VERSION,
        "ok": result.ok,
        "logs": result.stdout[-120_000:],
        "detail": result.reason[:240],
    }


def handle_cancel(context: BrokerContext, request: dict) -> dict:
    job = _job_name(request)
    result = run_kubectl([
        "delete", "job", job, "-n", context.namespace,
        "--ignore-not-found=true",
    ])
    return {
        "version": PROTOCOL_VERSION,
        "ok": result.ok,
        "cancelled": job,
        "detail": result.reason[:240],
    }


def cancel_session_jobs(context: BrokerContext) -> None:
    run_kubectl([
        "delete", "jobs.batch", "-n", context.namespace,
        "-l", f"review.owner=review-exec,review.session={sanitize_label(context.session)}",
        "--ignore-not-found=true",
    ])


def sweep_orphans(context: BrokerContext) -> None:
    run_kubectl([
        "delete", "jobs.batch", "-n", context.namespace,
        "-l", "review.owner=review-exec",
        "--field-selector", "status.conditions.type=Complete",
        "--ignore-not-found=true",
    ])


def dispatch(context: BrokerContext, raw: bytes) -> dict:
    try:
        request = decode_request(raw, context)
        action = request["action"]
        if action == "submit":
            return handle_submit(context, request)
        if action == "status":
            return handle_status(context, request)
        if action == "logs":
            return handle_logs(context, request)
        return handle_cancel(context, request)
    except Rejected as error:
        return {"version": PROTOCOL_VERSION, "ok": False, "error": error.code, "detail": error.detail}
    except Exception as error:
        return {"version": PROTOCOL_VERSION, "ok": False, "error": "unavailable", "detail": type(error).__name__}
```

Use the existing newline-delimited UDS `socketserver.ThreadingUnixStreamServer` shape from `review-lab-broker.py:1338-1421`, with mode `0700` for the parent directory and `0600` for the socket, but call `sweep_orphans(context)` before `serve_forever()` and `cancel_session_jobs(context)` in the `finally` block. The only accepted CLI commands are `serve --socket --session --image` and `probe`; `probe` checks `kubectl config current-context` and `kubectl get nodes -o name`, exactly as the old launcher probe did.

- [ ] **Step 4: Implement the container client and `BrokerExecutor` with transparent local fallback.**

```python
# image/tui/review_exec_client.py
from __future__ import annotations

import json
import os
import socket
from typing import Any, Mapping

SOCKET_ENV = "BLUEFIN_REVIEW_EXEC_SOCKET"
SESSION_ENV = "BLUEFIN_REVIEW_EXEC_SESSION"


def request(payload: Mapping[str, Any], timeout: float = 30.0) -> dict[str, Any]:
    path = os.environ.get(SOCKET_ENV, "")
    session = os.environ.get(SESSION_ENV, "")
    if not path or not session:
        raise RuntimeError("review-exec broker is not configured")
    message = json.dumps(
        {"version": 1, "session": session, **dict(payload)},
        separators=(",", ":"),
    ).encode() + b"\n"
    with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as client:
        client.settimeout(timeout)
        client.connect(path)
        client.sendall(message)
        data = bytearray()
        while not data.endswith(b"\n"):
            block = client.recv(65536)
            if not block:
                break
            data.extend(block)
    answer = json.loads(bytes(data).decode("utf-8"))
    if not isinstance(answer, dict):
        raise RuntimeError("review-exec response is not an object")
    return answer


def submit(repository, number, base_sha, head_sha, backend, model, effort):
    return request({
        "action": "submit",
        "repository": repository,
        "number": number,
        "base_sha": base_sha,
        "head_sha": head_sha,
        "backend": backend,
        "model": model,
        "effort": effort,
    })


def status():
    return request({"action": "status"})


def logs(job):
    return request({"action": "logs", "job": job})


def cancel(job):
    return request({"action": "cancel", "job": job})
```

Implement `BrokerExecutor.run` as a typed submit, poll `status`, fetch `logs` when the Job is terminal, parse the final JSON receipt, and raise a `BrokerUnavailable` exception for socket errors, `ok: false`, missing Job, or a non-receipt log. `ReviewEngine._run_one` must catch only that broker exception and run the same PR through `LocalExecutor`; a review result failure from the broker Job is a per-PR failed result, not a reason to cancel or suppress other PRs.

```python
# image/tui/review_engine.py
class BrokerExecutor:
    def __init__(self, client_module=None, poll_seconds: float = 0.2, timeout_seconds: float = 3600.0):
        self.client = client_module
        self.poll_seconds = poll_seconds
        self.timeout_seconds = timeout_seconds

    def _client(self):
        if self.client is not None:
            return self.client
        from tui import review_exec_client
        return review_exec_client

    def run(
        self,
        review_item,
        run,
        workdir,
        check_scope_version,
        check_scope,
        headroom_route,
        headroom_telemetry,
    ):
        client = self._client()
        try:
            submitted = client.submit(
                review_item.repository,
                review_item.number,
                review_item.base_sha,
                review_item.head_sha,
                run.backend,
                run.model,
                run.effort,
            )
        except (OSError, RuntimeError, TimeoutError, ValueError) as error:
            raise BrokerUnavailable(str(error)) from error
        if not submitted.get("ok") or submitted.get("result") != "submitted":
            raise BrokerUnavailable(str(submitted.get("detail") or submitted.get("error") or "submit failed"))
        job = submitted.get("job")
        if not isinstance(job, str) or not job:
            raise BrokerUnavailable("broker returned no Job name")
        deadline = time.monotonic() + self.timeout_seconds
        while time.monotonic() < deadline:
            try:
                status = client.status()
            except (OSError, RuntimeError, TimeoutError, ValueError) as error:
                raise BrokerUnavailable(str(error)) from error
            if not status.get("ok"):
                raise BrokerUnavailable(str(status.get("detail") or status.get("error") or "status failed"))
            record = next((entry for entry in status.get("jobs", []) if entry.get("job") == job), None)
            if record is None:
                raise BrokerUnavailable(f"broker lost Job {job}")
            if int(record.get("succeeded", 0) or 0) or int(record.get("failed", 0) or 0):
                logs = client.logs(job)
                if not logs.get("ok"):
                    raise BrokerUnavailable(str(logs.get("detail") or "log collection failed"))
                return ReviewReceipt.from_json(
                    str(logs.get("logs") or "")
                ).with_provenance({
                    "headroom_state": headroom_route.state,
                    "headroom_route": headroom_route.base_url or "",
                    "headroom_status_line": headroom_telemetry["status_line"],
                    "headroom_output_reduction_percent": headroom_telemetry["output_reduction_percent"],
                    "headroom_output_reduction_method": headroom_telemetry["output_reduction_method"],
                    "headroom_output_tokens_saved": headroom_telemetry["output_tokens_saved"],
                })
            time.sleep(self.poll_seconds)
        raise BrokerUnavailable(f"Job {job} exceeded the broker collection timeout")

    def cancel(self, run):
        return None
```

- [ ] **Step 5: Replace the justfile lab helpers with review-exec helpers and the same one-question consent.**

```bash
# justfile shared_functions replacement
review_exec_broker_script() {
  printf '%s' "${REVIEW_EXEC_BROKER:-${PWD}/scripts/review-exec-broker.py}"
}

review_exec_probe_context() {
  REVIEW_EXEC_CONTEXT=""
  local broker probe_json
  broker="$(review_exec_broker_script)"
  [[ -f "$broker" ]] || return 1
  command -v python3 &>/dev/null || return 1
  command -v kubectl &>/dev/null || return 1
  probe_json="$(python3 "$broker" probe 2>/dev/null)" || return 1
  REVIEW_EXEC_CONTEXT="$(printf '%s' "$probe_json" | sed -n 's/.*"context":"\([^"]*\)".*/\1/p')"
  [[ -n "$REVIEW_EXEC_CONTEXT" ]]
}

start_review_exec_broker() {
  local broker runtime_dir
  broker="$(review_exec_broker_script)"
  runtime_dir="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}"
  [[ -d "$runtime_dir" && -w "$runtime_dir" ]] || return 1
  REVIEW_EXEC_SESSION="$(python3 -c 'import secrets; print(secrets.token_hex(8))')" || return 1
  REVIEW_EXEC_SOCKET_DIR="$(mktemp -d "${runtime_dir}/bluefin-review-exec.XXXXXX")" || return 1
  chmod 700 "$REVIEW_EXEC_SOCKET_DIR"
  REVIEW_EXEC_SOCKET="${REVIEW_EXEC_SOCKET_DIR}/broker.sock"
  python3 "$broker" serve \
    --socket "$REVIEW_EXEC_SOCKET" \
    --session "$REVIEW_EXEC_SESSION" \
    --image "${REVIEW_CONTRIBUTOR_IMAGE}" \
    >"${REVIEW_EXEC_SOCKET_DIR}/broker.log" 2>&1 &
  REVIEW_EXEC_BROKER_PID=$!
  for _ in $(seq 1 50); do
    [[ -S "$REVIEW_EXEC_SOCKET" ]] && return 0
    kill -0 "$REVIEW_EXEC_BROKER_PID" 2>/dev/null || break
    sleep 0.1
  done
  cleanup_review_exec_broker
  return 1
}

cleanup_review_exec_broker() {
  if [[ -n "${REVIEW_EXEC_BROKER_PID:-}" ]]; then
    kill "$REVIEW_EXEC_BROKER_PID" 2>/dev/null || true
    wait "$REVIEW_EXEC_BROKER_PID" 2>/dev/null || true
  fi
  REVIEW_EXEC_BROKER_PID=""
  if [[ -n "${REVIEW_EXEC_SOCKET_DIR:-}" ]]; then
    rm -rf "$REVIEW_EXEC_SOCKET_DIR"
  fi
  REVIEW_EXEC_SOCKET_DIR=""
  REVIEW_EXEC_SOCKET=""
  REVIEW_EXEC_SESSION=""
}

offer_review_exec_session() {
  REVIEW_EXEC_SOCKET="" REVIEW_EXEC_SESSION="" REVIEW_EXEC_SOCKET_DIR="" REVIEW_EXEC_BROKER_PID=""
  [[ "${REVIEW_EXEC:-}" == "0" ]] && return 0
  review_exec_probe_context || return 0
  local answer=""
  if [[ "${REVIEW_EXEC:-}" == "1" ]]; then
    answer="y"
  elif [[ -r /dev/tty && -w /dev/tty ]]; then
    printf '?  Kubernetes context %s is reachable. Offload batch reviews for this session only? [y/N] ' \
      "$REVIEW_EXEC_CONTEXT" >/dev/tty
    read -r answer </dev/tty || answer=""
  else
    return 0
  fi
  [[ "$answer" == [Yy]* ]] || return 0
  start_review_exec_broker || {
    echo "! review-exec broker did not start; reviews remain local." >&2
    return 0
  }
  echo "✓ review-exec enabled for this session (context ${REVIEW_EXEC_CONTEXT}); one socket, no credentials."
}

add_review_exec_container_args() {
  [[ -n "${REVIEW_EXEC_SOCKET:-}" ]] || return 0
  local flag
  flag="$(review_exec_runtime_flags)"
  [[ -n "$flag" ]] && CONTAINER_ARGS+=("$flag")
  CONTAINER_ARGS+=(--volume "${REVIEW_EXEC_SOCKET_DIR}:/run/bluefin-review-exec:rw,z")
  CONTAINER_ARGS+=(--env "BLUEFIN_REVIEW_EXEC_SOCKET=/run/bluefin-review-exec/broker.sock")
  CONTAINER_ARGS+=(--env "BLUEFIN_REVIEW_EXEC_SESSION=${REVIEW_EXEC_SESSION}")
  CONTAINER_ARGS+=(--env BLUEFIN_REVIEW_EXEC_AVAILABLE=1)
}
```

Rename `lab_runtime_flags` to `review_exec_runtime_flags`; do not leave a lab alias. `review-queue` calls `offer_review_exec_session`, adds its container args, and traps `cleanup_review_exec_broker`; `review-container` never calls it. Before `add_review_exec_container_args`, append `--env BLUEFIN_REVIEW_EXEC_AVAILABLE=0` to `CONTAINER_ARGS`; `add_review_exec_container_args` replaces it with `1` when a socket is mounted. The engine can then report transport availability without probing Kubernetes from inside the container.

- [ ] **Step 6: Run the broker contract and the targeted onboarding cases.**

Run: `python3 tests/review-exec-broker-contract.py && bash tests/just-onboarding.sh`

Expected: the broker contract passes; accepted consent mounts exactly one `/run/bluefin-review-exec` socket, no kubeconfig or host socket, `runsc` alone receives `--runtime-flag=host-uds=open`, and declined/no-context paths still launch the dashboard.

- [ ] **Step 7: Commit the optional broker replacement.**

```bash
git add scripts/review-exec-broker.py image/tui/review_exec_client.py image/tui/review_engine.py tests/review-exec-broker-contract.py justfile tests/just-onboarding.sh docs/skills/review-exec-broker.md
git commit -m "feat: offload batch reviews through an optional broker" -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

## Task 10: Make `turbo-review` status honest and preserve local fallback

**Files:**
- Modify: `justfile:917-1005, 1453-1515`.
- Modify: `tests/just-onboarding.sh:840-955`.
- Modify: `docs/skills/cluster-workers.md` and `README.md` turbo-review sections.
- Test: `tests/just-onboarding.sh`.

**Interfaces to consume:**
- Existing `scale_cluster_contributors` and its ordered namespace/Secret/deployment/env/scale/rollout steps at `justfile:917-1005`.
- Existing `turbo-review` argument parsing and exit trap at `justfile:1453-1515`.
- `review-queue` broker socket export from Task 9.

**Interfaces produced:**
- `CLUSTER_SCALE_STEP` shell variable naming the first failed step.
- `CLUSTER_SCALE_STATUS` with `scaled`, `failed`, or `unavailable`.
- `report_cluster_exit_status` output with exactly one of:
  - `scaled and Ready`
  - `scaled, not Ready`
  - `failed at <step>`
- `turbo-review` still launches `just review-queue "$@"` after any cluster failure.
- `HIVE_HUB` resolved by cluster scale-out remains the value passed to the dashboard.

- [ ] **Step 1: Add failing onboarding assertions for honest final status.**

```bash
# tests/just-onboarding.sh
begin "turbo-review: final status distinguishes ready from not-ready"
reset_logs
RECIPE_ARGS=(--all)
run_recipe turbo-review GH_READY=1 FAKE_GH_TOKEN=gho-test-token \
  FAKE_KEYRING_COPILOT_TOKEN=copilot-test-token REVIEW_LAB=0
assert_contains "scaled and Ready" "$OUT"

begin "turbo-review: final status names the failed step"
reset_logs
RECIPE_ARGS=(--all)
run_recipe turbo-review GH_READY=1 FAKE_GH_TOKEN=gho-test-token \
  FAKE_KEYRING_COPILOT_TOKEN=copilot-test-token REVIEW_LAB=0 \
  FAKE_KUBECTL_DEPLOY_APPLY_FAIL=1
assert_contains "failed at deployment apply" "$OUT"
assert_contains "starting the maintainer review dashboard" "$OUT"
```

- [ ] **Step 2: Run onboarding and verify the old swallowed-warning text is still emitted instead of a status classification.**

Run: `bash tests/just-onboarding.sh`

Expected: failure because the current recipe prints `cluster worker scale-out failed; continuing...` without `scaled and Ready` or `failed at deployment apply`.

- [ ] **Step 3: Track each scale step and return a structured result without changing the mutation order.**

```bash
scale_cluster_contributors() {
  local replicas="$1" profile="${2:-gemini}" effort="${3:-}"
  CLUSTER_SCALE_STEP=""
  CLUSTER_SCALE_STATUS="failed"
  command -v kubectl &>/dev/null || {
    CLUSTER_SCALE_STEP="kubectl unavailable"
    return 1
  }
  kubectl config current-context >/dev/null 2>&1 || {
    CLUSTER_SCALE_STEP="context probe"
    return 1
  }
  resolve_model_profile "$profile" "$effort" || {
    CLUSTER_SCALE_STEP="model profile"
    return 1
  }
  ensure_hive_contributor_env || {
    CLUSTER_SCALE_STEP="Hive setup"
    return 1
  }
  local hub
  hub="$(read_hive_value HIVE_HUB)"
  valid_hive_hub "$hub" || {
    CLUSTER_SCALE_STEP="HIVE_HUB validation"
    return 1
  }
  CLUSTER_HIVE_HUB="$hub"
  resolve_gh_token
  [[ -n "${GH_TOKEN_VALUE:-}" ]] || {
    CLUSTER_SCALE_STEP="GitHub token"
    return 1
  }
  resolve_copilot_token
  [[ -n "${COPILOT_TOKEN:-}" ]] || {
    CLUSTER_SCALE_STEP="Copilot credential"
    return 1
  }
  kubectl create namespace bluefin-system --dry-run=client -o yaml |
    kubectl apply -f - >/dev/null || {
      CLUSTER_SCALE_STEP="namespace apply"
      return 1
    }
  {
    printf 'GH_TOKEN=%s\n' "$GH_TOKEN_VALUE"
    printf 'GITHUB_COPILOT_TOKEN=%s\n' "$COPILOT_TOKEN"
  } | kubectl create secret generic review-contributor-secret -n bluefin-system \
    --from-file=contributor.env="${HIVE_CONTRIBUTOR_ENV}" \
    --from-env-file=/dev/stdin --dry-run=client -o yaml |
    kubectl apply --server-side --force-conflicts -f - >/dev/null || {
      CLUSTER_SCALE_STEP="Secret apply"
      return 1
    }
  legacy_annot="$(kubectl get secret review-contributor-secret -n bluefin-system -o jsonpath='{.metadata.annotations.kubectl\.kubernetes\.io/last-applied-configuration}')" || {
    CLUSTER_SCALE_STEP="Secret annotation read"
    return 1
  }
  if [[ -n "$legacy_annot" ]]; then
    kubectl annotate secret review-contributor-secret -n bluefin-system \
      kubectl.kubernetes.io/last-applied-configuration- >/dev/null || {
        CLUSTER_SCALE_STEP="legacy annotation removal"
        return 1
      }
  fi
  kubectl apply -f deploy/review-contributor.yaml >/dev/null || {
    CLUSTER_SCALE_STEP="deployment apply"
    return 1
  }
  kubectl set env deployment/review-contributor -n bluefin-system \
    GOOSE_MODEL="$PROFILE_MODEL" GOOSE_THINKING_EFFORT="$PROFILE_EFFORT" \
    HIVE_HUB="$hub" >/dev/null || {
      CLUSTER_SCALE_STEP="deployment env update"
      return 1
    }
  kubectl scale deployment/review-contributor -n bluefin-system --replicas="$replicas" >/dev/null || {
    CLUSTER_SCALE_STEP="deployment scale"
    return 1
  }
  CLUSTER_SCALE_STATUS="scaled"
  return 0
}
```

- [ ] **Step 4: Replace the final status block with the three honest outcomes.**

```bash
report_cluster_exit_status() {
  echo ""
  echo "=== Cluster contributor status ==="
  if [[ "$CLUSTER_SCALE_STATUS" == failed ]]; then
    echo "failed at ${CLUSTER_SCALE_STEP}"
  elif ! command -v kubectl &>/dev/null; then
    echo "failed at kubectl status"
  elif ! kubectl get deployment review-contributor -n bluefin-system &>/dev/null; then
    echo "scaled, not Ready (deployment status unavailable)"
  else
    ready="$(kubectl get deployment review-contributor -n bluefin-system -o jsonpath='{.status.readyReplicas}' 2>/dev/null || echo 0)"
    total="$(kubectl get deployment review-contributor -n bluefin-system -o jsonpath='{.spec.replicas}' 2>/dev/null || echo 0)"
    if [[ "$CLUSTER_SCALE_STATUS" == scaled && "${ready:-0}" == "${total:-0}" && "${total:-0}" == "${replicas}" ]]; then
      echo "scaled and Ready (${ready:-0}/${total:-0})"
    else
      echo "scaled, not Ready (${ready:-0}/${total:-0})"
    fi
  fi
  echo "  Stop workers: just review-stop cluster"
  echo "  Check health: just review-doctor"
}
```

Keep the dashboard command in the foreground and keep the `EXIT` trap. The `||` branch around `scale_cluster_contributors` now records the step and prints `! cluster scale failed at <step>; continuing with local review dashboard.` It must not swallow the failure into a generic warning.

Initialize `CLUSTER_SCALE_STATUS=unavailable` and `CLUSTER_SCALE_STEP="context probe"` before the context test in `turbo-review`; set `CLUSTER_SCALE_STATUS=failed` when no usable context exists and set it to `scaled` only after the namespace, Secret, deployment, environment, and scale steps all succeed.

- [ ] **Step 5: Run onboarding and the recipe listing.**

Run: `bash tests/just-onboarding.sh && just --list`

Expected: PASS; turbo-review launches the dashboard after scale failures, and the five public recipe names remain visible.

- [ ] **Step 6: Commit honest turbo status.**

```bash
git add justfile tests/just-onboarding.sh docs/skills/cluster-workers.md README.md
git commit -m "fix: report turbo review cluster outcomes honestly" -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

## Task 11: Remove lab and detach paths, dead code, and stale documentation

**Files:**
- Delete: `scripts/review-lab-broker.py`.
- Delete: `image/tui/lab_client.py`.
- Delete: `tests/lab-broker-contract.py`.
- Delete: `docs/skills/lab-broker.md`.
- Delete: `docs/skills/index.md`.
- Modify: `justfile:18-60, 1104-1260` to remove `REVIEW_DETACH`, detached ownership labels, local `review-stop` behavior, Codex auth staging labels used only for detach, and lab names; preserve `review-stop cluster`.
- Modify: `image/tui/bluefin_review_tui.py:107, 886-915` to remove `QUEUE_LABEL` and `Stop.batchable`.
- Modify: `image/bin/bluefin-review:16, 524-531` to remove the dead `REVIEW_INCOMPLETE` constant and use the typed receipt/result exit status.
- Modify: `tests/dashboard-contract.sh` and `tests/just-onboarding.sh` to remove lab and detached assertions and add review-exec assertions.
- Modify: `AGENTS.md`, `docs/factory/agentic-model.md`, `docs/SKILL.md`, `docs/skills/launcher.md`, `docs/skills/goose-context.md`, `docs/skills/review-dashboard.md`, `docs/skills/cluster-workers.md`, `image/review-scope/REVIEW.md`, and `README.md`.
- Create or modify: `docs/skills/review-exec-broker.md` with frontmatter and the durable replacement procedure.
- Regenerate: `docs/skills/index.json` with the generator; do not edit it by hand.
- Test: `tests/dashboard-contract.sh`, `tests/bluefin-review.sh`, `tests/just-onboarding.sh`, `tests/generate-skills.sh`, `scripts/check-skill-frontmatter.sh`.

**Interfaces to consume:**
- The replacement broker and launcher handoff from Task 9.
- Honest turbo status from Task 10.
- Existing documentation discipline in `AGENTS.md:183-201` and `docs/factory/agentic-model.md:161-176`.

**Interfaces produced:**
- No `review-lab-broker.py`, `lab_client.py`, lab contract, lab skill, detached worker branch, or stale duplicate router remains.
- `review-stop cluster` remains the only cluster-worker teardown path.
- `AGENTS.md` and `docs/factory/agentic-model.md` describe optional review-exec as session-scoped, non-blocking, credential-free inside the container, and limited to review Jobs; neither describes automatic QA WorkflowTemplate dispatch or issue filing.
- `docs/SKILL.md` routes launcher/broker work to `launcher.md` and `review-exec-broker.md`, not the deleted lab skill.
- `docs/skills/goose-context.md` says the actual default Goose model is `gemini-3.8-flash` from `justfile:84`, while `gpt-5.6-luna` is not described as the launcher default.
- The generated catalog contains `review-exec-broker` and no `lab-broker` or `index.md` entry.

- [ ] **Step 1: Prove all deletion targets and old symbols are still present before removing them.**

Run:

```bash
test -f scripts/review-lab-broker.py
test -f image/tui/lab_client.py
test -f tests/lab-broker-contract.py
test -f docs/skills/lab-broker.md
test -f docs/skills/index.md
grep -q 'REVIEW_DETACH' justfile
grep -q 'QUEUE_LABEL = "lgtm"' image/tui/bluefin_review_tui.py
grep -q 'def batchable' image/tui/bluefin_review_tui.py
grep -q 'REVIEW_INCOMPLETE=' image/bin/bluefin-review
```

Expected: all commands succeed on the pre-deletion tree.

- [ ] **Step 2: Remove the old files and dead branches with `git rm` and surgical edits.**

```bash
git rm scripts/review-lab-broker.py image/tui/lab_client.py \
  tests/lab-broker-contract.py docs/skills/lab-broker.md docs/skills/index.md
```

Remove the detached branch only: the attended `review-container` invocation, its foreground signal behavior, the cluster `review-stop cluster` path, and the five public recipe names remain. Delete the `review.owner=detached` label checks, `REVIEW_DETACH` documentation, detached Codex-auth label cleanup, and local-name `review-stop` branch. Do not remove the broker's new session cleanup or the cluster teardown.

- [ ] **Step 3: Update the two authority documents with the replacement model.**

Replace the optional lab section in `docs/factory/agentic-model.md` with this compact contract:

```markdown
## Optional review execution authority

The appliance owns no cluster and depends on none. A maintainer may lend one
dashboard session a usable host Kubernetes context; the launcher asks once on
`/dev/tty` and, on yes, starts `review-exec-broker.py`. The container receives
one private Unix socket and the session id, never kubeconfig, Kubernetes
credentials, host home, host networking, a Podman socket, or a host binary.

The broker accepts only typed `submit`, `status`, `logs`, and `cancel` requests.
Every submitted Job is bound to the session, full repository, PR number, base
SHA, head SHA, backend, model, and effort; Jobs run only the published review
image in `bluefin-system` with a deadline and TTL. Session shutdown cancels its
Jobs and startup removes stale finished Jobs. Broker absence or failure falls
back to local review for that PR.

Cluster review is supplementary capacity, not review authority. GitHub remains
authoritative for pull-request state and the human remains the decision point.
No workflow dispatch, issue filing, lab diagnosis, or private endpoint is part
of this appliance.
```

Update the matching `AGENTS.md` section and validation command in the same edit; cite `scripts/review-exec-broker.py` and `tests/review-exec-broker-contract.py`, not the deleted lab names.

- [ ] **Step 4: Update launcher, dashboard, cluster-worker, Goose, review-scope, README, and router documentation with exact behavior.**

Use these exact behavior anchors:

```markdown
<!-- docs/skills/review-exec-broker.md -->
---
name: review-exec-broker
version: "1.0"
last_updated: 2026-09-06
id: review-exec-broker
one_line_purpose: Offload selected batch reviews through a session-scoped host broker.
entry_point: docs/skills/review-exec-broker.md
category: ci-ops
status: active
tags: [review, broker, kubernetes, socket, batch]
description: "Maintains the optional review-exec UDS broker, typed review Jobs, session cleanup, and local fallback."
metadata:
  type: procedure
---

# Review Exec Broker

`review-queue` may lend one dashboard session a host Kubernetes context. The
launcher asks once, passes one private Unix socket through the runtime, and
the broker owns kubectl and credentials. The dashboard never receives
kubeconfig or cluster tools.

The protocol is version 1 and has four verbs: `submit`, `status`, `logs`, and
`cancel`. A submit binds the full repository, PR number, base SHA, head SHA,
backend, model, effort, and session into one Job in `bluefin-system`. The Job
uses `activeDeadlineSeconds` and `ttlSecondsAfterFinished`. Broker shutdown
cancels the session's Jobs; startup sweeps stale finished review Jobs.

The broker is optional. A declined offer, missing context, socket failure,
dispatch failure, or collection failure falls back to the local executor for
that PR and never blocks the dashboard.
```

In `docs/skills/review-dashboard.md`, document `r` as context-aware, add
`B`, `Space`, and `n`, describe badges and `repo#number@head` triage state,
and state that `Enter` on an annotated row merges cached analysis with fresh
live evidence. Document bulk `a` as one exact-list ActionPlan gate and leave
`A`/`w` landing behavior unchanged. In `docs/skills/launcher.md`, remove
detached-worker and lab paragraphs and describe review-exec socket handoff.
In `docs/skills/cluster-workers.md`, state that turbo-review reports
`scaled and Ready`, `scaled, not Ready`, or `failed at <step>` and that
contributor workers remain independent Hive assignments.

In `docs/skills/goose-context.md`, replace the incorrect sentence
`the entrypoint supplies gpt-5.6-luna` with:

```markdown
The dashboard and contributor launcher default to `gemini-3.8-flash` at high
effort (`justfile:84`); `gpt-5.6-luna` is not the launcher default.
```

In `image/review-scope/REVIEW.md`, remove every lab-client instruction and add:

```markdown
Cluster review execution is outside the review container. If the optional
review-exec broker is unavailable, continue with local review and published
registry evidence; never call kubectl, Argo, or a private endpoint.
```

In `README.md`, remove detached commands and the lab section, document the
batch review flow and `REVIEW_EXEC=1/0`, and state that `review-stop cluster`
only stops cluster contributor workers. In `docs/SKILL.md`, route “offload
selected batch reviews” to `review-exec-broker.md`; keep `launcher.md` for
recipe changes.

- [ ] **Step 5: Regenerate the skills manifest from frontmatter.**

Run: `bash scripts/check-skill-frontmatter.sh --write`

Expected: `docs/skills/index.json` contains `review-exec-broker`, no
`lab-broker`, and no stale `docs/skills/index.md` route.

- [ ] **Step 6: Update absence contracts and verify no old surface remains.**

```bash
if rg -n 'review-lab-broker|lab_client|REVIEW_LAB|REVIEW_DETACH|review.owner=detached|QUEUE_LABEL = "lgtm"|def batchable|REVIEW_INCOMPLETE' \
  AGENTS.md README.md docs justfile image scripts tests; then
  echo "old lab/detach/dead-review surface remains" >&2
  exit 1
fi
test ! -e scripts/review-lab-broker.py
test ! -e image/tui/lab_client.py
test ! -e tests/lab-broker-contract.py
test ! -e docs/skills/lab-broker.md
test ! -e docs/skills/index.md
grep -q 'review-exec-broker.py' justfile
grep -q 'review-exec-broker' docs/skills/index.json
```

- [ ] **Step 7: Run the documentation and static contracts.**

Run: `bash scripts/check-skill-frontmatter.sh && bash tests/generate-skills.sh && bash tests/image-contract.sh && bash tests/bluefin-review.sh`

Expected: PASS, with no generated `.agents/skills/` changes staged.

- [ ] **Step 8: Commit the deletion and documentation batch.**

```bash
git add -A AGENTS.md README.md docs image/bin/bluefin-review image/review-scope/REVIEW.md image/tui/bluefin_review_tui.py image/tui/review_engine.py justfile scripts tests
git commit -m "refactor: replace lab and detach paths with review exec" -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

## Task 12: Run the complete validation suite and close the implementation artifacts

**Files:**
- Modify only files whose targeted validation exposes a defect in Tasks 1-11.
- Delete in the final implementation commit: `docs/superpowers/specs/2026-09-06-turbo-review-batch-engine-design.md` and `docs/superpowers/plans/2026-09-06-turbo-review-batch-engine.md`, as required by repository documentation doctrine.
- Do not commit the plan from this planning session.
- Test: the complete command list in `AGENTS.md`, including `tests/review-exec-broker-contract.py` after the replacement.

**Interfaces to consume:**
- All interfaces and tests from Tasks 1-11.
- The updated validation list in `AGENTS.md`.

**Interfaces produced:**
- A green full validation result with the replacement broker contract.
- No spec, plan, changelog, session note, or scratchpad remains in the implementation commit.

- [ ] **Step 1: Run every targeted contract once more in one batch.**

```bash
python3 tests/review_receipt_contract.py
python3 tests/review_run_contract.py
python3 tests/review_result_contract.py
python3 tests/action_plan_contract.py
python3 tests/capacity_contract.py
python3 tests/review_snapshot_contract.py
python3 tests/review_engine_contract.py
python3 tests/review-exec-broker-contract.py
```

Expected: every command exits zero.

- [ ] **Step 2: Run the repository validation list from `AGENTS.md`.**

```bash
bash scripts/check-skill-frontmatter.sh
bash tests/generate-skills.sh
bash tests/sbom-manifest.sh
bash tests/image-contract.sh
bash tests/bluefin-review.sh
bash tests/dashboard-contract.sh
python3 tests/review-exec-broker-contract.py
bash tests/worktree-guard.sh
bash tests/just-onboarding.sh
git diff --check
just --list
pre-commit run --all-files
```

Expected: every command exits zero; `just --list` still exposes exactly the five public launcher recipes.

- [ ] **Step 3: Verify the measurable success paths without a cluster.**

Run the dashboard pilot with a fake engine configured for ten selected items and assert:

```python
assert len(engine.calls) == 10
assert all(stop.review_result is not None for stop in app.stops)
first_pass = {stop.key: stop.review_result for stop in app.stops}
second = engine.run_sync(snapshot, "goose", "gemini-3.8-flash", "high", "scope-v7")
assert engine.local_calls == 0
assert set(second.results) == set(first_pass)
```

Expected: ten exact-head tasks complete within injected capacity; the second pass is cache-only; a broker-offline run falls back locally; no review row blocks another row.

- [ ] **Step 4: Verify the cluster-optional path with the broker contract and fake launcher.**

Run: `REVIEW_EXEC=1 bash tests/just-onboarding.sh`

Expected: one typed socket mount, session labels on submitted Jobs, exact base/head/backend/model/effort in Job args, deadline and TTL fields, session cancellation on broker shutdown, stale finished-job sweep, and local fallback after a broker error.

- [ ] **Step 5: Delete the implementation artifacts only in the final implementation commit.**

```bash
git rm docs/superpowers/specs/2026-09-06-turbo-review-batch-engine-design.md \
  docs/superpowers/plans/2026-09-06-turbo-review-batch-engine.md
```

- [ ] **Step 6: Run the final hygiene check after deleting the artifacts.**

Run: `git diff --check && git status --short`

Expected: no whitespace errors; only the intended implementation files are changed, and neither the approved spec nor this plan is present in the final implementation commit.

- [ ] **Step 7: Create the final implementation commit with the required trailer.**

```bash
git add -A
git commit -m "feat: add turbo review batch engine" -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

## Task list summary

1. Add a versioned, bounded, machine-readable receipt mode that round-trips Goose and Codex results.
2. Make `bluefin-review` use a full-repository/head-keyed isolated checkout.
3. Cache only exact-identity analysis and prune it after seven days.
4. Govern local concurrency from injected memory and CPU headroom, flooring at zero.
5. Hydrate every selected PR's base/head/live evidence before dispatch and fail closed.
6. Schedule one isolated review per PR with landing-style JSONL durability, cache hits, capacity waits, failure isolation, and local fallback.
7. Add dashboard batch selection, triage state, verdict badges, context-aware `r`, and cached decision cards.
8. Add one typed exact-list bulk `a` ActionPlan with per-item live head/check drift rejection while preserving single-PR gates and landing keys.
9. Replace the lab broker with a typed review-exec broker, BrokerExecutor, Job lifecycle, socket consent, and fallback.
10. Make turbo-review report the actual scale outcome while retaining local dashboard startup.
11. Delete lab, automatic issue-filing, detached-worker, stale-router, and dead TUI surfaces and update every canonical document.
12. Run the full validation list and delete the spec/plan artifacts in the final implementation commit.

## Spec coverage

Every approved-spec section maps to a task:

- Problem, goals, non-goals, and architecture: Tasks 1-11.
- Receipt mode and both backends: Task 1.
- Isolated worktrees and `ReviewRun`: Tasks 2 and 6.
- ReviewCache identity, analysis-only contents, misses, corruption, and retention: Task 3.
- Capacity formula, defaults, injection, zero slots, and no killing of running work: Task 4.
- Fail-closed org-queue SHA hydration: Task 5.
- JSONL scheduler, LocalExecutor, cache short-circuit, per-PR failure isolation, Headroom/Caveman provenance: Task 6.
- Selection keys, context-aware `r`, verdict badges, triage keys, live decision cards: Task 7.
- Exact-list bulk ActionPlan, one confirmation, per-item drift rejection, unchanged single-PR gates and landing: Task 8.
- Typed review-exec broker, session-labelled Jobs, deadlines, TTLs, cancellation, orphan sweep, fallback, consent, and gVisor handling: Task 9.
- Honest turbo-review status and broker availability export: Task 10.
- Lab/detach/dead-code deletions, QA/issue-filing removal, canonical documentation, and manifest regeneration: Task 11.
- Full success criteria and final artifact deletion: Task 12.

No approved spec item remains unmapped.
