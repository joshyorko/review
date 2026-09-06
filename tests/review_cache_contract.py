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


def make_run(base="a" * 40, head="b" * 40, model="gemini-3.8-flash", backend="goose", effort="high", pr=372):
    request = ReviewRequest(
        "projectbluefin", "review", pr, base, head,
        "maintainer", "review", generated_at="test",
    )
    return ReviewRun.from_request(request, backend=backend, model=model, effort=effort)


def make_receipt(run, scope="scope-v7"):
    return ReviewReceipt.from_result(
        run,
        ReviewResult(
            1, "complete",
            {"critical": 0, "high": 0, "medium": 0, "low": 0},
            [], [], {"backend": run.backend, "model": run.model},
            {}, {}, [],
        ),
        ["compact transcript"],
        scope,
    )


class ReviewCacheTests(unittest.TestCase):
    def test_hit_and_readable_filename(self):
        with tempfile.TemporaryDirectory() as root:
            cache = ReviewCache(root)
            run = make_run()
            path = cache.put(make_receipt(run))
            self.assertIn("projectbluefin__review__372-", path.name)
            self.assertEqual(cache.prefix(run), "projectbluefin__review__372")
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

    def test_backend_and_effort_and_pr_are_misses(self):
        with tempfile.TemporaryDirectory() as root:
            cache = ReviewCache(root)
            run = make_run()
            cache.put(make_receipt(run))
            self.assertIsNone(cache.get(make_run(backend="codex"), "scope-v7"))
            self.assertIsNone(cache.get(make_run(effort="medium"), "scope-v7"))
            self.assertIsNone(cache.get(make_run(pr=373), "scope-v7"))

    def test_corrupt_file_is_a_miss_and_is_replaced_by_next_put(self):
        with tempfile.TemporaryDirectory() as root:
            cache = ReviewCache(root)
            run = make_run()
            path = cache.path_for(run, "scope-v7")
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text("{broken")
            self.assertIsNone(cache.get(run, "scope-v7"))
            cache.put(make_receipt(run))
            json.loads(path.read_text())

    def test_tampered_identity_in_cached_json_is_a_miss(self):
        with tempfile.TemporaryDirectory() as root:
            cache = ReviewCache(root)
            run = make_run()
            path = cache.put(make_receipt(run))
            data = json.loads(path.read_text())
            data["identity"]["head_sha"] = "c" * 40
            path.write_text(json.dumps(data))
            self.assertIsNone(cache.get(run, "scope-v7"))

    def test_tampered_mutable_evidence_in_cached_json_is_a_miss(self):
        with tempfile.TemporaryDirectory() as root:
            cache = ReviewCache(root)
            run = make_run()
            path = cache.put(make_receipt(run))
            data = json.loads(path.read_text())
            data["provenance"]["ci"] = "failure"
            path.write_text(json.dumps(data))
            self.assertIsNone(cache.get(run, "scope-v7"))

    def test_prune_nonexistent_root_is_noop(self):
        cache = ReviewCache("/nonexistent/directory/for/cache/test")
        cache.prune()

    def test_default_root_uses_xdg_state_home(self):
        with tempfile.TemporaryDirectory() as temp_home:
            old = os.environ.get("XDG_STATE_HOME")
            os.environ["XDG_STATE_HOME"] = temp_home
            try:
                cache = ReviewCache()
                expected_root = Path(temp_home) / "bluefin-review" / "reviews"
                self.assertEqual(cache.root, expected_root)
            finally:
                if old is not None:
                    os.environ["XDG_STATE_HOME"] = old
                else:
                    os.environ.pop("XDG_STATE_HOME", None)

    def test_prune_matches_landing_retention(self):
        with tempfile.TemporaryDirectory() as root:
            cache = ReviewCache(root)
            run = make_run()
            path = cache.put(make_receipt(run))
            non_json = Path(root) / "notes.txt"
            non_json.write_text("ignore me")
            old = (os.path.getmtime(path) - REVIEW_CACHE_RETENTION_SECONDS - 1)
            os.utime(path, (old, old))
            os.utime(non_json, (old, old))
            cache.prune(now=os.path.getmtime(path) + REVIEW_CACHE_RETENTION_SECONDS + 2)
            self.assertFalse(path.exists())
            self.assertTrue(non_json.exists())


if __name__ == "__main__":
    unittest.main()
