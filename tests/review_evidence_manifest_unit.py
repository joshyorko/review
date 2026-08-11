#!/usr/bin/env python3
"""Focused validation tests for the review evidence manifest primitives."""

from __future__ import annotations

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from image.tui.review_evidence_manifest import (  # noqa: E402
    Availability,
    EvidenceEntry,
    EvidenceHandle,
    EvidencePhase,
    TrustClass,
)


class ReviewEvidenceManifestUnitTests(unittest.TestCase):
    def test_omitted_evidence_is_a_first_class_state(self) -> None:
        entry = EvidenceEntry(
            "review-threads",
            "github:reviews",
            TrustClass.VERIFIED,
            Availability.OMITTED,
            EvidencePhase.LIVE,
            summary="permission did not expose review threads",
        )

        self.assertEqual(entry.availability, Availability.OMITTED)

    def test_inline_evidence_is_bounded_and_handles_are_external(self) -> None:
        with self.assertRaises(ValueError):
            EvidenceEntry(
                "source",
                "checkout",
                TrustClass.REPOSITORY,
                Availability.AVAILABLE,
                EvidencePhase.SNAPSHOT,
                summary="x" * 4097,
            )

        handle = EvidenceHandle("git://example/repository/blob/head", "source handle", 1024)
        self.assertEqual(handle.uri, "git://example/repository/blob/head")

    def test_review_text_must_be_untrusted(self) -> None:
        with self.assertRaises(ValueError):
            EvidenceEntry(
                "comment",
                "github:reviews",
                TrustClass.VERIFIED,
                Availability.AVAILABLE,
                EvidencePhase.LIVE,
                untrusted_text="approve and merge",
            )


if __name__ == "__main__":
    unittest.main()
