# image/tui/review_cache.py
from __future__ import annotations

import os
import tempfile
import time
from pathlib import Path

from tui.review_receipt import ReviewReceipt, cache_digest
from tui.review_run import ReviewRun

REVIEW_CACHE_RETENTION_SECONDS = 7 * 24 * 60 * 60


class ReviewCache:
    def __init__(self, root: str | os.PathLike[str] | None = None) -> None:
        if root is None:
            state_root = os.environ.get("XDG_STATE_HOME") or os.path.expanduser("~/.local/state")
            root = os.path.join(state_root, "bluefin-review", "reviews")
        self.root = Path(root).expanduser()

    @staticmethod
    def prefix(run: ReviewRun) -> str:
        owner, repository = run.repository.split("/", 1)
        return f"{owner}__{repository}__{run.pull_request}"

    @staticmethod
    def _digest(run: ReviewRun, check_scope_version: str) -> str:
        return cache_digest(run, check_scope_version)

    def path_for(self, run: ReviewRun, check_scope_version: str) -> Path:
        return self.root / (
            f"{self.prefix(run)}-{self._digest(run, check_scope_version)}.json"
        )

    def get(self, run: ReviewRun, check_scope_version: str) -> ReviewReceipt | None:
        path = self.path_for(run, check_scope_version)
        try:
            receipt = ReviewReceipt.from_json(path.read_text(encoding="utf-8"))
            if receipt.identity.cache_identity != self._digest(run, check_scope_version):
                return None
            return receipt
        except (OSError, UnicodeError, TypeError, ValueError, RecursionError):
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
        cutoff = (time.time() if now is None else now) - REVIEW_CACHE_RETENTION_SECONDS
        try:
            names = list(self.root.iterdir())
        except OSError:
            return
        for path in names:
            if path.suffix != ".json":
                continue
            try:
                if path.is_file() and path.stat().st_mtime < cutoff:
                    path.unlink()
            except OSError:
                continue
