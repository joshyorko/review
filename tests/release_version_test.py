import subprocess
import unittest
from pathlib import Path

SCRIPT = Path(__file__).resolve().parents[1] / 'scripts' / 'validate-release-version.py'


class ReleaseVersionTest(unittest.TestCase):
    def check_version(self, requested, current='0.1.3', existing='v0.1.3\n'):
        return subprocess.run(['python3', str(SCRIPT), current, requested], input=existing,
                              text=True, capture_output=True)

    def test_accepts_newer_unpublished_stable_version(self):
        self.assertEqual(self.check_version('0.2.0').returncode, 0)
        self.assertEqual(self.check_version('0.1.10').returncode, 0)

    def test_rejects_invalid_equal_older_or_published_version(self):
        for requested in ('v0.1.4', '0.01.4', '0.1.4-rc1', '0.1.3', '0.1.2', '1.0.0\nmalicious'):
            with self.subTest(requested=requested):
                self.assertNotEqual(self.check_version(requested).returncode, 0)
        self.assertNotEqual(self.check_version('0.1.4', existing='v0.1.4\n').returncode, 0)

    def test_explicit_bump_choices(self):
        for bump, expected in [('patch', '0.1.4'), ('minor', '0.2.0'), ('major', '1.0.0')]:
            result = self.check_version(bump)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(result.stdout.strip(), expected)
        self.assertNotEqual(self.check_version('patch', existing='v0.1.4\n').returncode, 0)

    def test_unpublished_current_release_can_request_the_next_patch(self):
        result = self.check_version('patch', current='0.1.6', existing='v0.1.5\n')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout.strip(), '0.1.7')

    def test_rejects_invalid_current_version(self):
        self.assertNotEqual(self.check_version('0.1.4', current='broken').returncode, 0)


if __name__ == '__main__':
    unittest.main()
