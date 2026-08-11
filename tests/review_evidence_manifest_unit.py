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


def _entry(*, kind: str = "source", provenance: str = "checkout", handles: tuple[EvidenceHandle, ...] = ()) -> EvidenceEntry:
    return EvidenceEntry(
        kind,
        provenance,
        TrustClass.REPOSITORY,
        Availability.AVAILABLE,
        EvidencePhase.SNAPSHOT,
        handles=handles,
    )


def _request(**overrides: str | None) -> object:
    from image.tui.review_evidence_manifest import ReviewRequest

    values: dict[str, object] = {
        "owner": "octo",
        "repository": "sample",
        "pull_request_number": 17,
        "base_sha": "0" * 40,
        "head_sha": "1" * 40,
        "actor": "actor",
        "tenant": "tenant",
        "installation": "installation",
        "generated_at": "2026-08-11T00:00:00Z",
    }
    values.update(overrides)
    return ReviewRequest(**values)


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

    def test_manifest_and_entry_handle_count_boundaries(self) -> None:
        from image.tui.review_evidence_manifest import ReviewEvidenceManifest

        handle = EvidenceHandle("git://example/source", "source", 1024)
        entries = tuple(_entry(handles=(handle,) * 32) for _ in range(128))

        ReviewEvidenceManifest(_request(), entries)
        with self.assertRaises(ValueError):
            ReviewEvidenceManifest(_request(), entries + (_entry(),))
        with self.assertRaises(ValueError):
            _entry(handles=(handle,) * 33)

    def test_identity_and_provenance_strings_have_finite_boundaries(self) -> None:
        from image.tui.review_evidence_manifest import ReviewEvidenceManifest

        ReviewEvidenceManifest(
            _request(
                owner="o" * 256,
                repository="r" * 256,
                actor="a" * 256,
                tenant="t" * 256,
                installation="i" * 256,
                generated_at="g" * 128,
            ),
            (_entry(kind="k" * 256, provenance="p" * 256),),
        )

        for field, value in (
            ("owner", "o" * 257),
            ("repository", "r" * 257),
            ("actor", "a" * 257),
            ("tenant", "t" * 257),
            ("installation", "i" * 257),
            ("generated_at", "g" * 129),
        ):
            with self.subTest(field=field):
                with self.assertRaises(ValueError):
                    _request(**{field: value})

        for field, value in (("kind", "k" * 257), ("provenance", "p" * 257)):
            with self.subTest(field=field):
                with self.assertRaises(ValueError):
                    _entry(**{field: value})


if __name__ == "__main__":
    unittest.main()
