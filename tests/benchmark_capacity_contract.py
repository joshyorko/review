# tests/benchmark_capacity_contract.py
"""Contract tests for scripts/benchmark-capacity.py (#490).

Pins calculation logic, CLI argument parsing, CPU model detection,
workload generation, and end-to-end benchmark execution at minimal units.
"""

from __future__ import annotations

import importlib.util
import io
import os
from pathlib import Path
import sys
import unittest
from unittest.mock import patch

REPO_ROOT = Path(__file__).resolve().parents[1]
BENCHMARK_PATH = REPO_ROOT / "scripts" / "benchmark-capacity.py"


def load_benchmark_module():
    spec = importlib.util.spec_from_file_location("benchmark_capacity", BENCHMARK_PATH)
    if spec is None or spec.loader is None:
        raise ImportError(f"Cannot load {BENCHMARK_PATH}")
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


benchmark = load_benchmark_module()


class BenchmarkCapacityContractTests(unittest.TestCase):
    def test_get_cpu_model_extracts_model_name_from_cpuinfo(self):
        fake_cpuinfo = "processor\t: 0\nmodel name\t: AMD Ryzen 5 7600X\nstepping\t: 2\n"
        with patch("builtins.open", unittest.mock.mock_open(read_data=fake_cpuinfo)):
            self.assertEqual(benchmark._get_cpu_model(), "AMD Ryzen 5 7600X")

    def test_get_cpu_model_falls_back_to_unknown_on_oserror(self):
        with patch("builtins.open", side_effect=OSError("no /proc/cpuinfo")):
            self.assertEqual(benchmark._get_cpu_model(), "unknown")

    def test_get_cpu_model_falls_back_to_unknown_when_model_missing(self):
        fake_cpuinfo = "processor\t: 0\nstepping\t: 2\n"
        with patch("builtins.open", unittest.mock.mock_open(read_data=fake_cpuinfo)):
            self.assertEqual(benchmark._get_cpu_model(), "unknown")

    def test_make_subagent_code_generates_runnable_python_code(self):
        code = benchmark.make_subagent_code(buffer_mb=1, rounds=1)
        self.assertIn("hashlib.sha256", code)
        self.assertIn("bytearray(1 * 1024 * 1024)", code)
        self.assertIn("range(1)", code)

        # Confirm syntax is valid python
        compiled = compile(code, "<test-workload>", "exec")
        self.assertIsNotNone(compiled)

    def test_run_benchmark_single_slot_executes_real_workload(self):
        # Run a minimal real execution: 1 worker level, 1 unit, 1 run, 1 subagent
        results = benchmark.run_benchmark(
            workers_list=[1],
            units=1,
            runs=1,
            subagents_per_slot=1,
            buffer_mb=1,
            rounds=1,
        )
        self.assertIn(1, results)
        data = results[1]
        self.assertEqual(len(data["times"]), 1)
        self.assertEqual(len(data["peaks"]), 1)
        self.assertGreater(data["med_time"], 0.0)
        self.assertGreater(data["throughput"], 0.0)
        self.assertAlmostEqual(data["throughput"], 1.0 / data["med_time"])
        self.assertEqual(data["min_time"], data["med_time"])
        self.assertEqual(data["max_time"], data["med_time"])
        self.assertGreaterEqual(data["med_peak"], 0.0)
        self.assertEqual(data["max_peak"], data["med_peak"])

    def test_main_speedup_and_marginal_calculation(self):
        # Verify speedup is relative to first worker level, marginal relative to previous
        fake_results = {
            1: {
                "times": [2.0],
                "peaks": [100.0],
                "med_time": 2.0,
                "min_time": 2.0,
                "max_time": 2.0,
                "throughput": 10.0,
                "med_peak": 100.0,
                "max_peak": 100.0,
            },
            2: {
                "times": [1.0],
                "peaks": [150.0],
                "med_time": 1.0,
                "min_time": 1.0,
                "max_time": 1.0,
                "throughput": 20.0,
                "med_peak": 150.0,
                "max_peak": 150.0,
            },
            4: {
                "times": [0.8],
                "peaks": [200.0],
                "med_time": 0.8,
                "min_time": 0.8,
                "max_time": 0.8,
                "throughput": 25.0,
                "med_peak": 200.0,
                "max_peak": 200.0,
            },
        }

        with patch.object(benchmark, "run_benchmark", return_value=fake_results):
            with patch.object(sys, "argv", ["benchmark-capacity.py", "--workers", "1", "2", "4"]):
                out = io.StringIO()
                with patch("sys.stdout", out):
                    benchmark.main()
                output = out.getvalue()

        # Check speedup:
        # For 1: 10/10 = 1.00x, marginal 0.0%
        # For 2: 20/10 = 2.00x, marginal +100.0%
        # For 4: 25/10 = 2.50x, marginal +25.0%
        self.assertIn("1.00x |     +0.0%", output)
        self.assertIn("2.00x |   +100.0%", output)
        self.assertIn("2.50x |    +25.0%", output)


if __name__ == "__main__":
    unittest.main()
