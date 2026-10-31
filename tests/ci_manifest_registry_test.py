from __future__ import annotations

import importlib.util
import json
import tempfile
import unittest
from pathlib import Path


MODULE_PATH = Path(__file__).resolve().parents[1] / "scripts/ci/dagger-registry.py"
SPEC = importlib.util.spec_from_file_location("dagger_registry", MODULE_PATH)
assert SPEC and SPEC.loader
dagger_registry = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(dagger_registry)
ACTION = f"dagger/dagger-for-github@{'a' * 40}"


class DaggerRegistryTest(unittest.TestCase):
    def test_shared_cli_is_not_wrapped_in_a_dagger_run_session(self) -> None:
        root = MODULE_PATH.parents[2]
        for workflow in (root / ".github/workflows").glob("*.yml"):
            for block in dagger_registry._step_blocks(workflow.read_text()):
                if "dagger/dagger-for-github@" not in block:
                    continue
                self.assertFalse(
                    "verb: run" in block and "bin/ci" in block,
                    f"{workflow.name}: bin/ci starts its own Dagger client",
                )

    def test_title_client_contract_runs_outside_the_engine(self) -> None:
        workflow = (MODULE_PATH.parents[2] / ".github/workflows/validate.yml").read_text()
        self.assertTrue(
            "run: bash tests/ci_pr_title_contract.sh" in workflow,
            "the title integration test needs the host Dagger client",
        )

    def test_only_workflow_invoked_profiles_contribute_test_roots(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            (root / ".github/workflows").mkdir(parents=True)
            (root / ".dagger").mkdir()
            (root / "ci").mkdir()
            (root / ".github/workflows/validate.yml").write_text(
                f"jobs:\n  validate:\n    steps:\n      - uses: {ACTION}\n"
                "        with:\n          verb: call\n          args: contract --source=.\n"
                "      - uses: unrelated/action@v1\n"
                "        with:\n          args: portable --source=.\n"
                f"      - uses: {ACTION}\n"
                "        if: false\n"
                "        with:\n          verb: call\n          args: portable --source=.\n"
            )
            (root / "ci/suites.json").write_text(
                json.dumps(
                    {
                        "profiles": {
                            "contract": ["contract-test"],
                            "portable": ["portable-only-test"],
                        }
                    }
                )
            )
            (root / ".dagger/main.go").write_text(
                '\t"contract-test": "python3 tests/contract_test.py && bash tests/secondary_contract.sh",\n'
                '\t"portable-only-test": "python3 tests/portable_only_test.py",\n'
            )

            self.assertEqual(
                dagger_registry.dagger_test_roots(root),
                ["contract_test.py", "secondary_contract.sh"],
            )
            self.assertNotIn("portable_only_test.py", dagger_registry.dagger_test_roots(root))

    def test_rejects_invoked_profile_missing_from_manifest(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            (root / ".github/workflows").mkdir(parents=True)
            (root / ".dagger").mkdir()
            (root / "ci").mkdir()
            (root / ".github/workflows/validate.yml").write_text(
                f"jobs:\n  validate:\n    steps:\n      - uses: {ACTION}\n"
                "        with:\n          verb: call\n          args: missing-profile --source=.\n"
            )
            (root / "ci/suites.json").write_text('{"profiles":{}}')
            (root / ".dagger/main.go").write_text("")

            with self.assertRaisesRegex(dagger_registry.RegistryError, "missing or empty"):
                dagger_registry.dagger_test_roots(root)

    def test_fails_closed_for_conditional_dagger_profile(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            (root / ".github/workflows").mkdir(parents=True)
            (root / ".dagger").mkdir()
            (root / "ci").mkdir()
            (root / ".github/workflows/validate.yml").write_text(
                f"jobs:\n  validate:\n    steps:\n      - uses: {ACTION}\n"
                "        if: github.event_name == 'pull_request'\n"
                "        with:\n          verb: call\n          args: contract --source=.\n"
            )
            (root / "ci/suites.json").write_text('{"profiles":{"contract":["contract-test"]}}')
            (root / ".dagger/main.go").write_text('\t"contract-test": "python3 tests/contract_test.py",\n')

            with self.assertRaisesRegex(dagger_registry.RegistryError, "conditional Dagger"):
                dagger_registry.dagger_test_roots(root)


if __name__ == "__main__":
    unittest.main()
