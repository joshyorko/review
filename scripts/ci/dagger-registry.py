"""Resolve test files reached by Dagger profiles invoked in validate.yml."""

from __future__ import annotations

import json
import re
import sys
from pathlib import Path


class RegistryError(ValueError):
    pass


def _step_blocks(workflow: str) -> list[str]:
    lines = workflow.splitlines()
    blocks: list[str] = []
    index = 0
    while index < len(lines):
        section = re.match(r"^( *)steps:\s*$", lines[index])
        if not section:
            index += 1
            continue
        section_indent = len(section.group(1))
        step_indent = section_indent + 2
        cursor = index + 1
        while cursor < len(lines):
            indent = len(lines[cursor]) - len(lines[cursor].lstrip(" "))
            if lines[cursor].strip() and indent <= section_indent:
                break
            if re.match(rf"^ {{{step_indent}}}-\s+", lines[cursor]):
                start = cursor
                cursor += 1
                while cursor < len(lines):
                    next_indent = len(lines[cursor]) - len(lines[cursor].lstrip(" "))
                    if lines[cursor].strip() and next_indent <= section_indent:
                        break
                    if re.match(rf"^ {{{step_indent}}}-\s+", lines[cursor]):
                        break
                    cursor += 1
                blocks.append("\n".join(lines[start:cursor]))
                continue
            cursor += 1
        index = cursor
    return blocks


def _invoked_profiles(workflow: str) -> list[str]:
    profiles: list[str] = []
    for block in _step_blocks(workflow):
        if not re.search(r"(?m)^\s*(?:-\s*)?uses:\s*dagger/dagger-for-github@[0-9a-f]{40}(?:\s|$)", block):
            continue
        conditions = re.findall(r"(?m)^\s+if:\s*(.+?)\s*$", block)
        if conditions and any(value.strip().strip("'\"") not in {"true", "${{ true }}"} for value in conditions):
            if any(value.strip().strip("'\"") in {"false", "${{ false }}"} for value in conditions):
                continue
            raise RegistryError("conditional Dagger workflow steps need an explicit registry policy")
        with_match = re.search(r"(?m)^( +)with:\s*$", block)
        if not with_match:
            raise RegistryError("active Dagger action is missing its with: block")
        with_indent = len(with_match.group(1))
        fields: dict[str, str] = {}
        for line in block[with_match.end() :].splitlines():
            indent = len(line) - len(line.lstrip(" "))
            if line.strip() and indent <= with_indent:
                break
            field = re.match(r"^\s{0," + str(with_indent + 2) + r"}(verb|args):\s*(.*?)\s*$", line)
            if field:
                fields[field.group(1)] = field.group(2).strip().strip("'\"")
        verb = fields.get("verb")
        args = fields.get("args", "")
        if verb == "call":
            profile_match = re.match(r"([a-z0-9-]+)(?:\s|$)", args)
            if not profile_match:
                raise RegistryError("Dagger call action has no literal profile argument")
            profiles.append(profile_match.group(1))
        elif verb == "run":
            profile_match = re.search(r"(?:--profile\s+|--profile=)([a-z0-9-]+)", args)
            if not profile_match:
                raise RegistryError("Dagger run action has no literal --profile")
            profiles.append(profile_match.group(1))
        else:
            raise RegistryError("active Dagger action has an unsupported or missing verb")
    return profiles


def dagger_test_roots(root: Path) -> list[str]:
    root = root.resolve()
    workflow = (root / ".github/workflows/validate.yml").read_text()
    manifest = json.loads((root / "ci/suites.json").read_text())
    module = (root / ".dagger/main.go").read_text()

    invoked_profiles = _invoked_profiles(workflow)
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
