"""Exercise the workflow's explicit release-PR identity guard."""
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
GUARD = ROOT / 'scripts' / 'validate-release-dispatch.sh'
REPOSITORY = 'joshyorko/review'
OWNER = 'joshyorko'
BRANCH = 'release/v0.1.7'
SHA = 'ec4bf76dbd7c620c957b5005708800cddb9d3c43'


class ReleaseDispatchGuardTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        root = Path(self.tmp.name)
        self.bin = root / 'bin'
        self.bin.mkdir()
        self.gh_calls = root / 'gh-calls.json'
        self.pr_data = root / 'pulls.json'
        self.write_command('git', '''#!/usr/bin/env python3
import os
import sys
if sys.argv[1:] == ["rev-parse", "HEAD"]:
    print(os.environ["FAKE_GIT_HEAD_SHA"])
else:
    sys.exit(90)
''')
        self.write_command('gh', '''#!/usr/bin/env python3
import json
import os
import subprocess
import sys
args = sys.argv[1:]
with open(os.environ["FAKE_GH_CALLS"], "w") as stream:
    json.dump(args, stream)
if len(args) < 4 or args[:3] != ["api", "--method", "GET"]:
    sys.exit(91)
endpoint = args[3]
fields = {}
expression = None
i = 4
while i < len(args):
    if args[i] in ("--field", "-f"):
        key, value = args[i + 1].split("=", 1)
        fields[key] = value
        i += 2
    elif args[i] == "--jq":
        expression = args[i + 1]
        i += 2
    else:
        sys.exit(92)
if endpoint != "repos/joshyorko/review/pulls" or expression is None:
    sys.exit(93)
if fields != {"head": os.environ["FAKE_EXPECTED_HEAD"], "state": "open"}:
    payload = []
else:
    with open(os.environ["FAKE_PULL_REQUESTS"]) as stream:
        payload = json.load(stream)
result = subprocess.run(["jq", "-r", expression], input=json.dumps(payload),
                        text=True, capture_output=True, check=True)
print(result.stdout, end="")
''')
        self.env = os.environ.copy()
        self.env.update({
            'PATH': f'{self.bin}{os.pathsep}{os.environ["PATH"]}',
            'GITHUB_REPOSITORY': REPOSITORY,
            'EXPECTED_SHA': SHA,
            'EVENT_REF': BRANCH,
            'FAKE_GIT_HEAD_SHA': SHA,
            'FAKE_EXPECTED_HEAD': f'{OWNER}:{BRANCH}',
            'FAKE_GH_CALLS': str(self.gh_calls),
            'FAKE_PULL_REQUESTS': str(self.pr_data),
        })

    def write_command(self, name, contents):
        path = self.bin / name
        path.write_text(contents)
        path.chmod(0o755)

    @staticmethod
    def pull(**overrides):
        result = {
            'head': {'sha': SHA, 'ref': BRANCH, 'repo': {'full_name': REPOSITORY}},
            'base': {'ref': 'main'},
        }
        for key, value in overrides.items():
            if key == 'head_sha':
                result['head']['sha'] = value
            elif key == 'head_ref':
                result['head']['ref'] = value
            elif key == 'head_repo_full_name':
                result['head']['repo']['full_name'] = value
            elif key == 'base_ref':
                result['base']['ref'] = value
            else:
                raise ValueError(f'unknown pull request field: {key}')
        return result

    def run_guard(self, pulls, **env_overrides):
        self.pr_data.write_text(json.dumps(pulls))
        env = self.env | env_overrides
        return subprocess.run(['bash', str(GUARD)], capture_output=True, text=True, env=env)

    def test_accepts_exact_same_repository_main_pr_and_owner_branch_query(self):
        result = self.run_guard([self.pull()])
        self.assertEqual(result.returncode, 0, result.stderr)
        args = json.loads(self.gh_calls.read_text())
        self.assertIn('--method', args)
        self.assertEqual(args[args.index('--method') + 1], 'GET')
        self.assertIn(f'head={OWNER}:{BRANCH}', args)
        self.assertNotIn(f'head={REPOSITORY}:{BRANCH}', args)

    def test_rejects_wrong_repository_or_worktree_head_before_github_query(self):
        wrong_repository = self.run_guard([self.pull()], GITHUB_REPOSITORY='joshyorko/other')
        self.assertNotEqual(wrong_repository.returncode, 0)
        self.assertFalse(self.gh_calls.exists())

        wrong_head = self.run_guard([self.pull()], FAKE_GIT_HEAD_SHA='0' * 40)
        self.assertNotEqual(wrong_head.returncode, 0)
        self.assertFalse(self.gh_calls.exists())

    def test_rejects_missing_duplicate_wrong_head_repo_ref_or_base_pr(self):
        bad_pulls = [
            [],
            [self.pull(), self.pull()],
            [self.pull(head_sha='0' * 40)],
            [self.pull(head_ref='release/v0.1.8')],
            [self.pull(head_repo_full_name='attacker/review')],
            [self.pull(base_ref='release/v0.1.6')],
        ]
        for pulls in bad_pulls:
            with self.subTest(pulls=pulls):
                self.gh_calls.unlink(missing_ok=True)
                result = self.run_guard(pulls)
                self.assertNotEqual(result.returncode, 0)

    def test_validation_workflow_invokes_the_tested_guard(self):
        workflow = (ROOT / '.github' / 'workflows' / 'validate.yml').read_text()
        self.assertIn('run: bash scripts/validate-release-dispatch.sh', workflow)
        self.assertIn('python3 tests/release-dispatch-guard.py', workflow)


if __name__ == '__main__':
    unittest.main()
