"""Exercise release ranges with real Git history and the pinned git-cliff binary."""
import os
import json
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
        self.initial_branch = self.git('branch', '--show-current').strip()
        self.git('config', 'user.name', 'Fixture')
        self.git('config', 'user.email', 'fixture@example.invalid')
        self.git('add', '.')
        self.git('commit', '-qm', 'feat: baseline')
        self.git('tag', 'v0.1.0')
        self.git('commit', '--allow-empty', '-qm', 'fix: squash-style repair (#42)')
        self.git('commit', '--allow-empty', '-qm', 'chore: release 0.1.0')
        self.bin = self.repo / 'bin'
        self.bin.mkdir()
        self.cliff_args = self.repo / 'cliff-args.json'
        cliff = self.bin / 'git-cliff'
        cliff.write_text('''#!/usr/bin/env python3
import json
import os
import sys
if sys.argv[1:] == ["--version"]:
    print("git-cliff 2.14.2")
else:
    with open(os.environ["CLIFF_ARGS"], "w") as stream:
        json.dump(sys.argv[1:], stream)
    tag = sys.argv[sys.argv.index("--tag") + 1].removeprefix("v")
    print(f"## [{tag}]\\n\\n### Bug fixes\\n\\n- Fixture changelog entry.")
''')
        cliff.chmod(0o755)

    def git(self, *args):
        return subprocess.check_output(['git', '-C', str(self.repo), *args], text=True)

    def run_helper(self, *args, input=None, real_cliff=False):
        env = os.environ.copy()
        if not real_cliff:
            env['PATH'] = f"{self.bin}{os.pathsep}{env['PATH']}"
        env['CLIFF_ARGS'] = str(self.cliff_args)
        return subprocess.run(['python3', str(self.repo / 'scripts/review-changelog.py'), *args],
                              input=input, capture_output=True, text=True, env=env)

    def published_tags(self, *tags):
        path = self.repo / 'published-tags.txt'
        path.write_text(''.join(f'{tag}\n' for tag in tags))
        return path

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
        empty = self.published_tags()
        result = self.run_helper('draft', '9.0.0', '9.0.1', str(empty))
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('no published stable release tag is an ancestor', result.stderr)
        self.git('checkout', '--quiet', '--orphan', 'unrelated')
        self.git('commit', '--allow-empty', '-qm', 'feat: unrelated')
        nonancestor = self.published_tags('v0.1.0')
        result = self.run_helper('draft', '0.1.0', '0.1.1', str(nonancestor))
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('no published stable release tag is an ancestor', result.stderr)

    def test_unpublished_current_version_uses_latest_published_ancestor(self):
        self.git('tag', 'v0.1.5', 'HEAD')
        self.git('commit', '--allow-empty', '-qm', 'chore: release 0.1.6')
        self.git('commit', '--allow-empty', '-qm', 'fix: recovery after failed 0.1.6 release')
        tags = self.published_tags('v0.1.5', 'v0.1.6-rc.1')

        result = self.run_helper('draft', '0.1.6', '0.1.7', str(tags))
        self.assertEqual(result.returncode, 0, result.stderr)
        args = json.loads(self.cliff_args.read_text())
        self.assertEqual(args[0], f"v0.1.5..{self.git('rev-parse', 'HEAD').strip()}")
        self.assertIn('recovery after failed 0.1.6 release',
                      self.git('log', '--format=%s', 'v0.1.5..HEAD'))
        self.assertIn('Fixture changelog entry', result.stdout)

    def test_published_current_version_remains_the_baseline(self):
        self.git('tag', 'v0.1.5', 'HEAD')
        self.git('commit', '--allow-empty', '-qm', 'fix: after published 0.1.5')
        tags = self.published_tags('v0.1.0', 'v0.1.5')

        result = self.run_helper('draft', '0.1.5', '0.1.6', str(tags))
        self.assertEqual(result.returncode, 0, result.stderr)
        args = json.loads(self.cliff_args.read_text())
        self.assertEqual(args[0], f"v0.1.5..{self.git('rev-parse', 'HEAD').strip()}")

    def test_picks_latest_stable_published_ancestor_and_ignores_bad_tags(self):
        self.git('tag', 'v0.1.5', 'HEAD')
        self.git('checkout', '--quiet', '--orphan', 'unrelated')
        self.git('commit', '--allow-empty', '-qm', 'feat: unrelated release line')
        self.git('tag', 'v9.0.0')
        self.git('checkout', '--quiet', self.initial_branch)
        self.git('commit', '--allow-empty', '-qm', 'fix: after published 0.1.5')
        tags = self.published_tags('bad-tag', 'v9.0.0', 'v0.1.0', 'v0.1.5', 'v0.9.9')

        result = self.run_helper('draft', '0.1.5', '0.1.6', str(tags))
        self.assertEqual(result.returncode, 0, result.stderr)
        args = json.loads(self.cliff_args.read_text())
        self.assertEqual(args[0], f"v0.1.5..{self.git('rev-parse', 'HEAD').strip()}")

    def test_request_workflow_delegates_planning_and_mutation_to_bounded_tools(self):
        workflow = (ROOT / '.github' / 'workflows' / 'request-release.yml').read_text()
        planner = (ROOT / 'scripts/ci/release-request-plan.py').read_text()
        adapter = (ROOT / 'scripts/ci/github-release-request').read_text()
        local_entrypoint = (ROOT / 'bin/ci').read_text()
        self.assertIn('module: .dagger/release-request', workflow)
        self.assertIn('run: bin/ci --profile release-plan --apply', workflow)
        self.assertIn('scripts/ci/github-release-request', local_entrypoint)
        self.assertIn('dagger', adapter)
        self.assertIn('latest_published_ancestor(published_tags', planner)
        self.assertIn('scripts/validate-release-version.py', planner)
        self.assertIn('known_tags = parse_json_array(tag_json', planner)
        self.assertIn('if not args.apply:', adapter)
        self.assertIn('remote_release_conflict(gh, f"release/v{plan[\'requestedVersion\']}", root=root)', adapter)

    @unittest.skipUnless(shutil.which('git-cliff'), 'git-cliff authoring tool not installed')
    def test_real_generator_uses_only_requested_range_and_is_repeatable(self):
        tags = self.published_tags('v0.1.0')
        first = self.run_helper('draft', '0.1.0', '0.1.1', str(tags), real_cliff=True)
        self.assertEqual(first.returncode, 0, first.stderr)
        self.assertIn('squash-style repair (#42)', first.stdout)
        self.assertIn('https://github.com/joshyorko/review/commit/', first.stdout)
        self.assertNotIn('baseline', first.stdout)
        self.assertNotIn('release 0.1.0', first.stdout)
        self.assertEqual(first.stdout, self.run_helper('draft', '0.1.0', '0.1.1', str(tags), real_cliff=True).stdout)

    @unittest.skipUnless(shutil.which('git-cliff'), 'git-cliff authoring tool not installed')
    def test_real_generator_includes_changes_since_published_tag_when_current_is_unpublished(self):
        self.git('tag', 'v0.1.5', 'HEAD')
        self.git('commit', '--allow-empty', '-qm', 'chore: release 0.1.6')
        self.git('commit', '--allow-empty', '-qm', 'fix: recovery after failed 0.1.6 release')
        tags = self.published_tags('v0.1.5', 'v0.1.6-rc.1')

        result = self.run_helper('draft', '0.1.6', '0.1.7', str(tags), real_cliff=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn('recovery after failed 0.1.6 release', result.stdout)
        self.assertNotIn('squash-style repair (#42)', result.stdout)
        self.assertNotIn('baseline', result.stdout)


if __name__ == '__main__':
    unittest.main()
