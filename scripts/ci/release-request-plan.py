#!/usr/bin/env python3
"""Build a credential-free, source-bound release request plan."""

from __future__ import annotations

import argparse
import base64
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import shutil
import stat
import subprocess
import sys
import tempfile


ROOT = Path(__file__).resolve().parents[2]
STABLE_VERSION = re.compile(r"(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\Z")
ALLOWED_FILES = ("CHANGELOG.md", "VERSION")


def sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def git(repo: Path, *args: str) -> str:
    return subprocess.check_output(["git", "-C", str(repo), *args], text=True).strip()


def mode(path: Path) -> str:
    info = path.lstat()
    if not stat.S_ISREG(info.st_mode):
        raise ValueError(f"release input must be a regular file: {path.name}")
    return format(stat.S_IMODE(info.st_mode), "04o")


def parse_json_array(value: str, label: str):
    try:
        result = json.loads(value)
    except json.JSONDecodeError as error:
        raise ValueError(f"{label} must be valid JSON: {error}") from error
    if not isinstance(result, list):
        raise ValueError(f"{label} must be a JSON array")
    return result


def changelog_drafter(source: Path):
    path = source / "scripts/review-changelog.py"
    spec = importlib.util.spec_from_file_location("review_changelog", path)
    if spec is None or spec.loader is None:
        raise ValueError("could not load scripts/review-changelog.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def plan(source: Path, bundle: Path, requested: str, release_json: str, tag_json: str, source_sha: str) -> dict:
    source = source.resolve()
    if not re.fullmatch(r"[0-9a-f]{40}", source_sha):
        raise ValueError("source SHA must be a lowercase full commit SHA")
    releases = parse_json_array(release_json, "published releases")
    known_tags = parse_json_array(tag_json, "known tags")
    for item in releases:
        if not isinstance(item, dict) or not isinstance(item.get("tag_name"), str):
            raise ValueError("published release entries must contain a string tag_name")
        if not isinstance(item.get("draft"), bool) or not isinstance(item.get("prerelease"), bool):
            raise ValueError("published release entries must contain boolean draft and prerelease fields")
    if any(
        not isinstance(tag, dict)
        or not isinstance(tag.get("name"), str)
        or not re.fullmatch(r"[0-9a-f]{40}", str(tag.get("objectSha", "")))
        or not re.fullmatch(r"[0-9a-f]{40}", str(tag.get("commitSha", "")))
        for tag in known_tags
    ):
        raise ValueError("known tags must include a name, tag object SHA, and peeled commit SHA")
    known_tag_names = [tag["name"] for tag in known_tags]
    if len(set(known_tag_names)) != len(known_tag_names):
        raise ValueError("known tags contain duplicate names")

    current_raw = (source / "VERSION").read_text(encoding="utf-8")
    current = current_raw.strip()
    if not STABLE_VERSION.fullmatch(current) or current_raw != current + "\n":
        raise ValueError("VERSION must contain one canonical MAJOR.MINOR.PATCH line")
    with tempfile.TemporaryDirectory(prefix="review-release-history-") as temp:
        repo = Path(temp) / "history"
        subprocess.run(["git", "-c", "advice.detachedHead=false", "clone", "--quiet", str(bundle), str(repo)], check=True,
                       env={"PATH": os.environ.get("PATH", "/usr/bin:/bin"), "HOME": str(Path(temp))})
        actual_sha = git(repo, "rev-parse", "HEAD")
        if actual_sha != source_sha:
            raise ValueError(f"source identity mismatch: expected {source_sha}, history bundle contains {actual_sha}")

        local_tags = git(repo, "tag", "--list").splitlines()
        all_tags = sorted(set(known_tag_names) | set(local_tags) | {item["tag_name"] for item in releases})
        version_result = subprocess.run(
            [sys.executable, str(source / "scripts/validate-release-version.py"), current, requested],
            input="\n".join(all_tags), text=True, capture_output=True, check=False,
        )
        if version_result.returncode:
            raise ValueError(version_result.stderr.strip() or "release version validation failed")
        requested = version_result.stdout.strip()

        published_tags = [item["tag_name"] for item in releases
                          if item["draft"] is False and item["prerelease"] is False]
        drafter = changelog_drafter(source)
        baseline = drafter.latest_published_ancestor(published_tags, root=repo)
        baseline_sha = git(repo, "rev-parse", f"refs/tags/{baseline}^{{commit}}")
        remote_baseline = next((tag for tag in known_tags if tag["name"] == baseline), None)
        if remote_baseline is None or remote_baseline["commitSha"] != baseline_sha:
            raise ValueError(f"published tag {baseline} does not match the bundled Git history")
        # Use the exact current config and helper, while resolving Git history only
        # from the supplied bundle. The helper checks the pinned git-cliff version.
        shutil.copy2(source / "cliff.toml", repo / "cliff.toml")
        section = drafter.draft(current, requested, published_tags, root=repo)

    changelog_path = source / "CHANGELOG.md"
    old_changelog = changelog_path.read_bytes()
    old_text = old_changelog.decode("utf-8")
    if re.search(r"^## \[" + re.escape(requested) + r"\]", old_text, re.MULTILINE):
        raise ValueError(f"changelog already contains {requested}")
    first = re.search(r"^## \[", old_text, re.MULTILINE)
    offset = first.start() if first else len(old_text)
    new_changelog = (old_text[:offset].rstrip() + "\n\n" + section.strip() + "\n\n" + old_text[offset:]).encode("utf-8")
    new_version = f"{requested}\n".encode("ascii")

    files = []
    for name, old, new in (("CHANGELOG.md", old_changelog, new_changelog), ("VERSION", current_raw.encode(), new_version)):
        path = source / name
        files.append({
            "path": name,
            "mode": mode(path),
            "expectedSha256": sha256(old),
            "newSha256": sha256(new),
            "newContentBase64": base64.b64encode(new).decode("ascii"),
        })
    canonical_files = json.dumps(files, sort_keys=True, separators=(",", ":")).encode()
    release_facts = [{"tag": item["tag_name"], "draft": item["draft"], "prerelease": item["prerelease"]}
                     for item in releases]
    release_facts.sort(key=lambda item: item["tag"])
    tags_facts = sorted(known_tags, key=lambda item: item["name"])
    return {
        "schemaVersion": 1,
        "sourceSha": source_sha,
        "currentVersion": current,
        "requestedVersion": requested,
        "plannedTag": f"v{requested}",
        "publishedStableBaseline": {"tag": baseline, "commit": baseline_sha, "objectSha": remote_baseline["objectSha"]},
        "supersedesUnpublishedVersion": f"v{current}" not in published_tags,
        "observed": {
            "releaseMetadataSha256": sha256(json.dumps(release_facts, sort_keys=True, separators=(",", ":")).encode()),
            "knownTagsSha256": sha256(json.dumps(tags_facts, separators=(",", ":")).encode()),
        },
        "files": files,
        "patchDigest": sha256(canonical_files),
        "publish": False,
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--source", type=Path, required=True)
    parser.add_argument("--bundle", type=Path, required=True)
    parser.add_argument("--requested-version", required=True)
    parser.add_argument("--published-releases-file", type=Path, required=True)
    parser.add_argument("--known-tags-file", type=Path, required=True)
    parser.add_argument("--source-sha", required=True)
    args = parser.parse_args()
    result = plan(args.source, args.bundle, args.requested_version,
                  args.published_releases_file.read_text(encoding="utf-8"),
                  args.known_tags_file.read_text(encoding="utf-8"), args.source_sha)
    print(json.dumps(result, sort_keys=True, separators=(",", ":")))
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (OSError, ValueError, subprocess.CalledProcessError) as error:
        print(f"release plan failed: {error}", file=sys.stderr)
        raise SystemExit(1)
