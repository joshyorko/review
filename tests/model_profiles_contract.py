# tests/model_profiles_contract.py
import unittest
from pathlib import Path
from types import SimpleNamespace
import sys

sys.path.insert(0, str(Path(__file__).parents[1] / "image"))

from tui.model_profiles import (
    DEPENDENCY_TITLE,
    GEMINI_TRIPLE,
    KIMI_TRIPLE,
    OPUS_TRIPLE,
    SOL_TRIPLE,
    classify_batch,
    final_environment,
    final_triple,
)


class ModelProfilesContractTests(unittest.TestCase):
    def test_triple_constants(self):
        self.assertEqual(GEMINI_TRIPLE, ("goose", "gemini-3.8-flash", "high"))
        self.assertEqual(SOL_TRIPLE, ("goose", "gpt-5.6-sol", "medium"))
        self.assertEqual(OPUS_TRIPLE, ("goose", "claude-opus-5", "high"))
        self.assertEqual(KIMI_TRIPLE, ("goose", "kimi-k3", "high"))

    def test_explicit_policies_choose_expected_review_triple(self):
        cases = {
            "gemini": GEMINI_TRIPLE,
            "opus": OPUS_TRIPLE,
            "sol": SOL_TRIPLE,
            "gpt-sol": SOL_TRIPLE,
            "k3": KIMI_TRIPLE,
            "kimi": KIMI_TRIPLE,
            "unknown": GEMINI_TRIPLE,
        }
        for policy, triple in cases.items():
            with self.subTest(policy=policy):
                self.assertEqual(final_triple(policy, "mixed", "final-review"), triple)

    def test_automatic_uses_dependency_classification_for_cheaper_reviewer(self):
        self.assertEqual(final_triple("automatic", "dependency", "final-review"), KIMI_TRIPLE)
        self.assertEqual(final_triple("automatic", "mixed", "final-review"), GEMINI_TRIPLE)

    def test_fixing_and_cleanup_always_use_kimi(self):
        for policy in ("gemini", "opus", "sol", "gpt-sol", "k3", "kimi", "automatic", "unknown"):
            with self.subTest(policy=policy, phase="fixing"):
                self.assertEqual(final_triple(policy, "mixed", "fixing"), KIMI_TRIPLE)
            with self.subTest(policy=policy, phase="cleanup"):
                self.assertEqual(final_triple(policy, "dependency", "cleanup"), KIMI_TRIPLE)

    def test_classify_batch_accepts_all_dependency_conventional_commit_titles(self):
        stops = [
            SimpleNamespace(title="chore(deps): bump foo", labels=[]),
            SimpleNamespace(title="build(deps-dev)!: bump bar", labels=[]),
            SimpleNamespace(title="  chore: update generated pins", labels=[]),
        ]
        self.assertEqual(classify_batch(stops), "dependency")
        self.assertTrue(DEPENDENCY_TITLE.match("build(deps): bump baz"))

    def test_classify_batch_accepts_all_dependency_labels(self):
        stops = [
            SimpleNamespace(title="anything", labels=["dependencies"]),
            SimpleNamespace(title="feat: not dependency by title", labels=["Dependencies"]),
        ]
        self.assertEqual(classify_batch(stops), "dependency")

    def test_classify_batch_falls_back_to_mixed_for_unknown_or_empty_batches(self):
        self.assertEqual(
            classify_batch([SimpleNamespace(title="update pin", labels=[])]),
            "mixed",
        )
        self.assertEqual(classify_batch([]), "mixed")

    def test_final_environment_sets_goose_variables_only_for_goose_rounds(self):
        default_env = final_environment(OPUS_TRIPLE)
        self.assertEqual(default_env["BLUEFIN_REVIEW_BACKEND"], "goose")
        self.assertEqual(default_env["GOOSE_MODEL"], "claude-opus-5")
        self.assertEqual(default_env["GOOSE_THINKING_EFFORT"], "high")

        goose_env = final_environment(OPUS_TRIPLE, "goose")
        self.assertEqual(goose_env["BLUEFIN_REVIEW_BACKEND"], "goose")
        self.assertEqual(goose_env["GOOSE_MODEL"], "claude-opus-5")
        self.assertEqual(goose_env["GOOSE_THINKING_EFFORT"], "high")

        codex_env = final_environment(OPUS_TRIPLE, "codex")
        self.assertEqual(codex_env["BLUEFIN_REVIEW_BACKEND"], "codex")
        self.assertEqual(codex_env["BLUEFIN_REVIEW_FINAL_MODEL"], "claude-opus-5")
        self.assertEqual(codex_env["BLUEFIN_REVIEW_FINAL_EFFORT"], "high")
        self.assertNotIn("GOOSE_MODEL", codex_env)
        self.assertNotIn("GOOSE_THINKING_EFFORT", codex_env)


if __name__ == "__main__":
    unittest.main()
