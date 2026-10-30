"""Resolve test files reached by Dagger profiles invoked in validate.yml."""

from __future__ import annotations

import json
import re
import sys
from pathlib import Path


class RegistryError(ValueError):
    pass


def dagger_test_roots(root: Path) -> list[str]:
    root = root.resolve()
    workflow = (root / ".github/workflows/validate.yml").read_text()
    manifest = json.loads((root / "ci/suites.json").read_text())
    module = (root / ".dagger/main.go").read_text()

    invoked_profiles = re.findall(r"(?m)^\s+args:\s*([a-z0-9-]+)\b", workflow)
    profiles = manifest.get("profiles", {})
    steps = dict(re.findall(r'"([a-z0-9-]+)"\s*:\s*"([^"\n]+)"', module))
    test_path = re.compile(r"(?:^|\s)(tests/[A-Za-z0-9_.-]+\.(?:sh|py|mjs|test\.ts))(?:\s|$)")
    roots: set[str] = set()

    for profile in invoked_profiles:
        selected = profiles.get(profile)
        if not selected:
            raise RegistryError(f"validate.yml invokes missing or empty Dagger profile {profile!r}")
        for step in selected:
            command = steps.get(step)
            if command is None:
                raise RegistryError(f"suite profile {profile!r} names unmapped Dagger step {step!r}")
            match = test_path.search(command)
            if match:
                roots.add(Path(match.group(1)).name)
    return sorted(roots)


def main() -> int:
    if len(sys.argv) != 2:
        print("usage: dagger-registry.py REPOSITORY_ROOT", file=sys.stderr)
        return 2
    try:
        for name in dagger_test_roots(Path(sys.argv[1])):
            print(name)
    except (OSError, json.JSONDecodeError, RegistryError) as error:
        print(f"Dagger registry: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
