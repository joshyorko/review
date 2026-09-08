import sys
import unittest
from os import environ
from pathlib import Path
from unittest.mock import patch


sys.path.insert(0, str(Path(__file__).parents[1] / "image" / "tui"))

from observability import _OtlpMetricExporter, ReviewObservability


class FakeExporter:
    def __init__(self):
        self.records = []

    def record(self, name, value, attributes):
        self.records.append((name, value, attributes))


class FailingExporter:
    def __init__(self):
        self.calls = 0

    def record(self, name, value, attributes):
        self.calls += 1
        raise RuntimeError("collector unavailable")


class ObservabilityContractTest(unittest.TestCase):
    def test_sdk_uses_standard_endpoint_and_parses_headers(self):
        with patch.dict(
            environ,
            {
                "OTEL_EXPORTER_OTLP_ENDPOINT": "http://collector:4318",
                "OTEL_EXPORTER_OTLP_HEADERS": "x-countme-contract=enabled",
            },
        ):
            countme_exporter = _OtlpMetricExporter(lambda: None)
            reader = next(iter(countme_exporter._provider._metric_readers))
            exporter = reader._exporter._exporter
            self.assertEqual(exporter._endpoint, "http://collector:4318/v1/metrics")
            self.assertIsInstance(exporter._headers, dict)
            self.assertEqual(exporter._headers, {"x-countme-contract": "enabled"})
            countme_exporter._provider.shutdown()

    def test_unconfigured_observability_never_exports(self):
        exporter = FakeExporter()
        observability = ReviewObservability.from_environment({}, exporter=exporter)

        observability.operation("queue.refresh", 1.2, pages=3, items=224)
        observability.state("reviews.active", 4)

        self.assertEqual(exporter.records, [])

    def test_operation_rejects_pr_text_and_caps_count_attributes(self):
        observability = ReviewObservability.from_environment(
            {"OTEL_EXPORTER_OTLP_ENDPOINT": "http://collector"}
        )

        with self.assertRaises(ValueError):
            observability.operation("queue.refresh", 1.0, title=999)

    def test_configured_observability_exports_only_bounded_measurement(self):
        exporter = FakeExporter()
        observability = ReviewObservability.from_environment(
            {"OTEL_EXPORTER_OTLP_ENDPOINT": "http://collector"},
            exporter=exporter,
        )

        observability.operation("queue.refresh", 1.2, pages=3, items=224)

        self.assertEqual(
            exporter.records,
            [("queue.refresh", 1.2, {"pages": 3, "items": 224})],
        )

    def test_export_failure_marks_countme_unavailable_without_raising(self):
        exporter = FailingExporter()
        observability = ReviewObservability.from_environment(
            {"OTEL_EXPORTER_OTLP_ENDPOINT": "http://collector"},
            exporter=exporter,
        )

        observability.operation("queue.refresh", 1.2, pages=3, items=224)
        observability.state("reviews.active", 4)

        self.assertEqual(observability.status, "unavailable")
        self.assertEqual(exporter.calls, 1)


if __name__ == "__main__":
    unittest.main()
