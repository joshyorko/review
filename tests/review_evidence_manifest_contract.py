#!/usr/bin/env python3
"""Contract tests for the versioned review evidence manifest."""

from __future__ import annotations

import unittest
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from image.tui.review_evidence_manifest import ReviewRequest


class ReviewRequestContractTests(unittest.TestCase):
    def test_request_preserves_full_base_and_head_identity(self) -> None:
        request = ReviewRequest(
            owner="example",
            repository="project",
            pull_request_number=17,
            base_sha="0123456789abcdef0123456789abcdef01234567",
            head_sha="89abcdef0123456789abcdef0123456789abcdef",
            actor="maintainer",
            tenant="example-tenant",
        )

        self.assertEqual(request.base_sha, "0123456789abcdef0123456789abcdef01234567")
        self.assertEqual(request.head_sha, "89abcdef0123456789abcdef0123456789abcdef")


if __name__ == "__main__":
    unittest.main()
