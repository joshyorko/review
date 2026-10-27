"""Exercise release ranges with real Git history and the pinned git-cliff binary."""
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]


class ChangelogContract(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.repo = Path(self.tmp.name)
        (self.repo / 'scripts').mkdir()
        shutil.copy2(ROOT / 'scripts/review-changelog.py', self.repo / 'scripts')
        shutil.copy2(ROOT / 'cliff.toml', self.repo)
        (self.repo / 'CHANGELOG.md').write_text('# Changelog\n\n## [0.1.0]\n\nOriginal.\n')
        self.git('init', '-q')
        self.git('config', 'user.name', 'Fixture')
        self.git('config', 'user.email', 'fixture@example.invalid')
        self.git('add', '.')
        self.git('commit', '-qm', 'feat: baseline')
        self.git('tag', 'v0.1.0')
        self.git('commit', '--allow-empty', '-qm', 'fix: squash-style repair (#42)')
        self.git('commit', '--allow-empty', '-qm', 'chore: release 0.1.0')

    def git(self, *args):
        return subprocess.check_output(['git', '-C', str(self.repo), *args], text=True)

    def run_helper(self, *args, input=None):
        return subprocess.run(['python3', str(self.repo / 'scripts/review-changelog.py'), *args],
                              input=input, capture_output=True, text=True)

    def test_prepend_preserves_history_and_rejects_duplicates(self):
        new = '## [0.1.1]\n\n### Bug fixes\n\n- Repair.\n'
        result = self.run_helper('prepend', '0.1.1', input=new)
        self.assertEqual(result.returncode, 0, result.stderr)
        text = (self.repo / 'CHANGELOG.md').read_text()
        self.assertIn('## [0.1.0]\n\nOriginal.', text)
        extracted = self.run_helper('section', '0.1.1')
        self.assertEqual(extracted.stdout.strip(), new.strip())
        self.assertNotEqual(self.run_helper('prepend', '0.1.1', input=new).returncode, 0)

    def test_missing_or_nonancestor_baseline_fails(self):
        self.assertNotEqual(self.run_helper('draft', '9.0.0', '9.0.1').returncode, 0)
        self.git('checkout', '--orphan', 'unrelated')
        self.git('commit', '--allow-empty', '-qm', 'feat: unrelated')
        self.assertNotEqual(self.run_helper('draft', '0.1.0', '0.1.1').returncode, 0)

    @unittest.skipUnless(shutil.which('git-cliff'), 'git-cliff authoring tool not installed')
    def test_real_generator_uses_only_requested_range_and_is_repeatable(self):
        first = self.run_helper('draft', '0.1.0', '0.1.1')
        self.assertEqual(first.returncode, 0, first.stderr)
        self.assertIn('squash-style repair (#42)', first.stdout)
        self.assertIn('https://github.com/joshyorko/review/commit/', first.stdout)
        self.assertNotIn('baseline', first.stdout)
        self.assertNotIn('release 0.1.0', first.stdout)
        self.assertEqual(first.stdout, self.run_helper('draft', '0.1.0', '0.1.1').stdout)


if __name__ == '__main__':
    unittest.main()
