#!/usr/bin/env python3
"""Conservative path-to-profile selection for the local pre-push gate."""

from __future__ import annotations

import argparse
import json
import subprocess
from pathlib import Path


PIPELINE_PATHS = {
    ".dagger",
    ".github/workflows",
    "bin/ci",
    "ci",
    "dagger.json",
    "requirements-ci.lock",
    ".gitignore",
    "scripts/ci",
    "scripts/check-skill-frontmatter.sh",
    "scripts/generate-skills.py",
    "scripts/install-git-cliff.sh",
    "scripts/review-formula.py",
    "scripts/update-omp-pins.mjs",
    "scripts/update-derived-pins.mjs",
    "scripts/update-gh-pins.mjs",
    "scripts/update-rtk-pins.mjs",
    "scripts/update-typesafe-pins.mjs",
    "scripts/update-requirements-ci-hashes.mjs",
    "scripts/validate-release-source.sh",
    "tests/test-registry.sh",
    "tests/ci-",
    "tests/ci_",
    "tests/release-publication-source.sh",
    "tests/package_oci_contract.py",
    "tests/package_review_contract.py",
    "tests/luna_factory_dogfood_contract.test.ts",
    "tests/update-",
    "justfile",
    ".pre-commit-config.yaml",
}
NATIVE_PATHS = {
    "image",
    "patches",
    "scripts/package-review",
    "scripts/install-apptainer-ci.sh",
    "scripts/build-derived-omp.sh",
    "tests/appliance-runtime-probe.sh",
    "tests/appliance-runtime-report.ts",
    "tests/luna-factory-dogfood.sh",
    "tests/review-factory-coload-smoke.sh",
    "tests/fixtures/review-factory-coload-rpc.py",
}
NATIVE_TEST_MARKERS = ("native", "krun", "apptainer", "sif", "coload", "runtime")
PORTABLE_TEST_PATHS = {"tests/ci_native_adapter_contract.py"}
APPLIANCE_ARTIFACT_PATHS = {
    "image",
    "patches",
    "scripts/package-review",
    "tests/appliance-runtime-probe.sh",
    "tests/appliance-runtime-report.ts",
    "tests/luna-factory-dogfood.sh",
    "tests/review-factory-coload-smoke.sh",
    "tests/fixtures/review-factory-coload-rpc.py",
}
DOC_PATHS = ("docs/", "README", "AGENTS.md", "CHANGELOG.md", "LICENSE", "CONTRIBUTING")


def _git(root: Path, *args: str) -> bytes:
    return subprocess.run(
        ["git", *args], cwd=root, check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE
    ).stdout


def _parse_name_status(payload: bytes) -> set[str]:
    fields = payload.decode("utf-8", errors="surrogateescape").split("\0")
    paths: set[str] = set()
    index = 0
    while index < len(fields) and fields[index]:
        status = fields[index]
        index += 1
        count = 2 if status.startswith(("R", "C")) else 1
        paths.update(fields[index : index + count])
        index += count
    return paths


def _matches(path: str, patterns: set[str]) -> bool:
    return any(path == pattern or path.startswith(f"{pattern}/") for pattern in patterns if not pattern.endswith(("_", "-"))) or any(
        path.startswith(pattern) for pattern in patterns if pattern.endswith(("_", "-"))
    )


def _changed_paths(root: Path, base: str, ref: str) -> tuple[set[str], str | None]:
    paths: set[str] = set()
    try:
        paths |= _parse_name_status(_git(root, "diff", "--name-status", "-z", "--find-renames", f"{base}...{ref}"))
    except subprocess.CalledProcessError as error:
        detail = error.stderr.decode("utf-8", errors="replace").strip()
        return paths, f"comparison base/ref unavailable: {detail or base + '...' + ref}"

    try:
        head = _git(root, "rev-parse", "HEAD").decode().strip()
        selected = _git(root, "rev-parse", ref).decode().strip()
    except subprocess.CalledProcessError as error:
        detail = error.stderr.decode("utf-8", errors="replace").strip()
        return paths, f"selected source ref unavailable: {detail or ref}"
    if head != selected:
        return paths, f"working checkout HEAD {head} does not match requested ref {ref} ({selected})"

    try:
        paths |= _parse_name_status(_git(root, "diff", "--name-status", "-z", "--find-renames", "HEAD"))
        paths |= _parse_name_status(_git(root, "diff", "--cached", "--name-status", "-z", "--find-renames", "HEAD"))
        untracked = _git(root, "ls-files", "--others", "--exclude-standard", "-z")
        paths.update(item.decode("utf-8", errors="surrogateescape") for item in untracked.split(b"\0") if item)
    except subprocess.CalledProcessError as error:
        detail = error.stderr.decode("utf-8", errors="replace").strip()
        return paths, f"working tree paths unavailable: {detail}"

    project_skill = root / ".agents/skills/review-ci"
    if project_skill.is_dir():
        paths.update(item.relative_to(root).as_posix() for item in project_skill.rglob("*") if item.is_file() or item.is_symlink())
    return paths, None


def plan(root: Path, base: str | None, ref: str = "HEAD", require_native: bool = False, require_os: str | None = None) -> dict:
    root = root.resolve()
    if not base:
        return {
            "profile": "portable",
            "native": "unknown",
            "blocked": True,
            "reason": "pre-push requires an explicit comparison base",
            "changedPaths": [],
        }
    paths, error = _changed_paths(root, base, ref)
    if error:
        return {
            "profile": "portable",
            "native": "unknown",
            "blocked": True,
            "reason": error,
            "changedPaths": sorted(paths),
        }

    native = "not-required"
    unknown: set[str] = set()
    native_paths: set[str] = set()
    portable = False
    docs_only = bool(paths)
    for path in paths:
        if path in PORTABLE_TEST_PATHS:
            portable = True
            docs_only = False
            continue
        if _matches(path, NATIVE_PATHS) or (path.startswith("tests/") and any(marker in path.lower() for marker in NATIVE_TEST_MARKERS)):
            native = "required"
            native_paths.add(path)
            portable = True
            docs_only = False
            continue
        if _matches(path, PIPELINE_PATHS):
            portable = True
            docs_only = False
            continue
        if any(path == prefix or path.startswith(prefix) for prefix in DOC_PATHS) or path.startswith(
            ".agents/skills/review-ci/"
        ):
            continue
        if path == "renovate.json":
            portable = True
            docs_only = False
            continue
        unknown.add(path)
        portable = True
        docs_only = False

    if unknown and native == "not-required":
        native = "unknown"

    if require_native or require_os:
        native = "required"
    profile = "contract" if docs_only and not portable else "portable"
    reason = "known paths selected" if not unknown else f"unknown paths require conservative review: {', '.join(sorted(unknown))}"
    native_adapter = None
    if (
        native == "required"
        and not require_os
        and not require_native
        and not unknown
        and native_paths
        and all(_matches(path, APPLIANCE_ARTIFACT_PATHS) for path in native_paths)
    ):
        native_adapter = "appliance-artifact"
    tracked_paths = {
        item.decode("utf-8", errors="surrogateescape")
        for item in _git(root, "ls-files", "--cached", "-z").split(b"\0")
        if item
    }
    project_skill = root / ".agents/skills/review-ci"
    project_skill_has_untracked = project_skill.is_dir() and any(
        item.relative_to(root).as_posix() not in tracked_paths
        for item in project_skill.rglob("*")
        if item.is_file() or item.is_symlink()
    )
    dirty = bool(_git(root, "status", "--porcelain=v1", "-z")) or project_skill_has_untracked
    if native_adapter and dirty:
        native_adapter = None
    blocked = native != "not-required" and native_adapter is None
    if require_os:
        reason += f"; required host OS {require_os} is not verified by this portable runner"
    elif require_native:
        reason += "; explicit native proof is not available in this runner"
    elif native == "required":
        if native_adapter:
            reason += "; appliance artifact native adapter selected"
        elif dirty:
            reason += "; native appliance proof requires a clean committed source"
        else:
            reason += "; this path set needs a native adapter not available in this runner"
    return {
        "profile": profile,
        "native": native,
        "nativeAdapter": native_adapter,
        "blocked": blocked,
        "reason": reason,
        "changedPaths": sorted(paths),
        "base": base,
        "ref": ref,
        "head": _git(root, "rev-parse", "HEAD").decode().strip(),
        "dirty": dirty,
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--repo", required=True)
    parser.add_argument("--base")
    parser.add_argument("--ref", default="HEAD")
    parser.add_argument("--require-native", action="store_true")
    parser.add_argument("--require-os")
    args = parser.parse_args()
    print(json.dumps(plan(Path(args.repo), args.base, args.ref, args.require_native, args.require_os)))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
