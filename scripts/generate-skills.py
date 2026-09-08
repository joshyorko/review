#!/usr/bin/env python3
"""Project skill sources into Goose's native Agent Skills layout.

The org keeps skills as ``docs/skills/<id>.md`` plus a generated
``docs/skills/index.json`` manifest. Goose discovers skills only as directories
containing a ``SKILL.md``, under fixed roots such as ``~/.agents/skills``.

This script accepts factory manifests plus local or remote community
``SKILL.md`` sources and writes ``<out>/<id>/SKILL.md`` for each active skill.
It is a projection, not a migration: the original sources stay authoritative.
Local community directories retain their standard sibling ``scripts``,
``references`` and ``assets`` content.

Manifest-backed skills emit only ``name``, ``description`` and a nested
``metadata`` block. The factory frontmatter carries a further ten top-level
keys that Goose has no use for; regenerating rather than copying keeps them
away from Goose's parser entirely. Direct community sources retain their
standard frontmatter.

Goose loads only ``name`` and ``description`` into the system prompt at session
start, then fetches a body on demand via ``load_skill`` -- so the description is
what actually drives selection, and it is copied verbatim.
"""

from __future__ import annotations

import argparse
import json
import pathlib
import re
import shutil
import sys
import urllib.error
import urllib.parse
import urllib.request

DEFAULT_COMMON_COMMIT = "b6f5c370cca19398fbbbe43a0182dca6783a80cb"
DEFAULT_INDEX = (
    "https://raw.githubusercontent.com/projectbluefin/common/"
    f"{DEFAULT_COMMON_COMMIT}/docs/skills/index.json"
)
DEFAULT_RAW_BASE = (
    "https://raw.githubusercontent.com/projectbluefin/common/"
    f"{DEFAULT_COMMON_COMMIT}/"
)

# Goose's own guidance is that fewer tools and shorter always-on context perform
# better; every skill costs name+description tokens in every request.
MAX_DESCRIPTION = 256
SKILL_ID_PATTERN = re.compile(r"[a-z0-9]+(?:-[a-z0-9]+)*\Z")

# Skill bodies link to sibling material as 'references/<name>.md'. Those files
# are not listed in the manifest, so they are resolved from the body itself.
# Without them a projected skill ships dangling links: 'pr-review' alone points
# at four reference documents that never reached the image.
REFERENCE_LINK_PATTERN = re.compile(r"\(\s*(references/[A-Za-z0-9._-]+\.md)\s*\)")
REFERENCE_NAME_PATTERN = re.compile(r"[A-Za-z0-9][A-Za-z0-9._-]*\.md\Z")
FRONTMATTER_NAME_PATTERN = re.compile(r"^name:\s*(.+?)\s*$", re.MULTILINE)


def read_source(location: str) -> str:
    if is_url(location):
        with urllib.request.urlopen(location, timeout=30) as response:  # noqa: S310
            return response.read().decode("utf-8")
    return pathlib.Path(location).read_text(encoding="utf-8")


def is_url(location: str) -> bool:
    return location.startswith(("http://", "https://"))


def yaml_quote(value: str) -> str:
    escaped = (
        value.replace("\\", "\\\\")
        .replace('"', '\\"')
        .replace("\n", "\\n")
        .replace("\r", "\\r")
        .replace("\t", "\\t")
    )
    return f'"{escaped}"'


def render(skill: dict, body: str, skill_id: str) -> str:
    description = " ".join(str(skill.get("description", "")).split())
    if len(description) > MAX_DESCRIPTION:
        description = description[: MAX_DESCRIPTION - 1].rstrip() + "\u2026"

    tags = [str(tag) for tag in skill.get("tags", [])]
    lines = [
        "---",
        f"name: {skill_id}",
        f"description: {yaml_quote(description)}",
        "metadata:",
        f"  source: {yaml_quote(str(skill.get('entry_point', '')))}",
        f"  category: {yaml_quote(str(skill.get('category', '')))}",
        f"  version: {yaml_quote(str(skill.get('version', '')))}",
    ]
    if tags:
        lines.append("  tags: [" + ", ".join(yaml_quote(tag) for tag in tags) + "]")
    lines += ["---", "", body.rstrip(), ""]
    return "\n".join(lines)


def strip_frontmatter(text: str) -> str:
    """Remove the factory YAML frontmatter, keeping the prose body."""
    if not text.startswith("---"):
        return text
    end = text.find("\n---", 3)
    if end == -1:
        return text
    newline = text.find("\n", end + 1)
    return text[newline + 1 :] if newline != -1 else ""


def is_safe_entry_point(entry_point: object) -> bool:
    """Allow only relative source paths without traversal."""
    if not isinstance(entry_point, str):
        return False
    path = pathlib.PurePosixPath(entry_point)
    return (
        bool(path.parts)
        and not path.is_absolute()
        and "\\" not in entry_point
        and all(ord(character) >= 32 and ord(character) != 127 for character in entry_point)
        and all(part not in (".", "..") for part in path.parts)
    )


def is_safe_reference(name: object) -> bool:
    """Allow only a plain 'references/<file>.md' sibling of the skill document.

    The link text comes from a fetched body rather than the manifest, so it is
    untrusted input: reject anything with a path separator, a traversal
    segment, or a non-Markdown suffix before it is ever joined to a path.
    """
    if not isinstance(name, str):
        return False
    return bool(REFERENCE_NAME_PATTERN.fullmatch(name)) and ".." not in name


def reference_names(body: str) -> list[str]:
    """Return the unique, safe 'references/<file>.md' names a body links to."""
    seen: list[str] = []
    for match in REFERENCE_LINK_PATTERN.finditer(body):
        name = match.group(1).split("/", 1)[1]
        if is_safe_reference(name) and name not in seen:
            seen.append(name)
    return seen


def unquote_yaml_scalar(value: str) -> str:
    """Read the simple quoted scalars used by Agent Skills frontmatter."""
    value = value.strip()
    if len(value) >= 2 and value[0] == value[-1] == '"':
        try:
            decoded = json.loads(value)
        except json.JSONDecodeError:
            return value[1:-1]
        return decoded if isinstance(decoded, str) else value
    if len(value) >= 2 and value[0] == value[-1] == "'":
        return value[1:-1].replace("''", "'")
    return value


def direct_skill_id(location: str, text: str) -> str | None:
    """Derive a direct source's id from standard frontmatter or its path."""
    frontmatter = text.split("\n---", 1)[0] if text.startswith("---") else ""
    match = FRONTMATTER_NAME_PATTERN.search(frontmatter)
    if match:
        candidate = unquote_yaml_scalar(match.group(1))
        return candidate if SKILL_ID_PATTERN.fullmatch(candidate) else None

    if is_url(location):
        path = pathlib.PurePosixPath(urllib.parse.urlparse(location).path)
    else:
        path = pathlib.Path(location)
    candidate = path.parent.name if path.name == "SKILL.md" else path.stem
    return candidate if SKILL_ID_PATTERN.fullmatch(candidate) else None


def reset_target(target: pathlib.Path) -> None:
    """Replace one generated skill without following a stale target symlink."""
    if target.is_symlink() or target.is_file():
        target.unlink()
    elif target.exists():
        shutil.rmtree(target)
    target.mkdir(parents=True)


def paths_overlap(first: pathlib.Path, second: pathlib.Path) -> bool:
    first = first.resolve()
    second = second.resolve()
    return first == second or first in second.parents or second in first.parents


def copy_local_tree(
    source: pathlib.Path,
    target: pathlib.Path,
    *,
    skip_skill_file: bool = False,
) -> tuple[int, list[str]]:
    """Copy a standard local skill directory without following symlinks."""
    copied_references = 0
    skipped: list[str] = []
    for item in sorted(source.rglob("*")):
        relative = item.relative_to(source)
        if item.is_symlink():
            skipped.append(str(relative))
            continue
        if item.is_dir() or (skip_skill_file and relative == pathlib.Path("SKILL.md")):
            continue
        if not item.is_file():
            skipped.append(str(relative))
            continue
        destination = target / relative
        destination.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(item, destination)
        if relative.parts[:1] == ("references",):
            copied_references += 1
    return copied_references, skipped


def inferred_manifest_base(index: str, raw_base: str | None) -> str:
    if raw_base:
        return raw_base
    if index == DEFAULT_INDEX:
        return DEFAULT_RAW_BASE
    if is_url(index):
        return urllib.parse.urljoin(index, ".")
    return str(pathlib.Path(index).parent)


def resolve_manifest_entry(base: str, entry_point: str) -> str | None:
    """Resolve a safe manifest entry beneath its declared local base."""
    if is_url(entry_point):
        return entry_point
    if not is_safe_entry_point(entry_point):
        return None
    if is_url(base):
        return urllib.parse.urljoin(base.rstrip("/") + "/", entry_point)

    root = pathlib.Path(base).resolve()
    location = (root / pathlib.PurePosixPath(entry_point)).resolve()
    if location != root and root not in location.parents:
        return None
    return str(location)


def skill_document_location(location: str) -> str:
    if is_url(location):
        parsed = urllib.parse.urlparse(location)
        if parsed.path.endswith("/"):
            return urllib.parse.urljoin(location, "SKILL.md")
        return location
    path = pathlib.Path(location)
    return str(path / "SKILL.md") if path.is_dir() else str(path)


def project_direct_source(
    source: str,
    out_root: pathlib.Path,
    excluded: set[str],
    emitted_ids: set[str],
) -> tuple[int, int, list[tuple[str, str]]]:
    """Project one local/remote SKILL.md or local standard skill directory."""
    skipped: list[tuple[str, str]] = []
    local_dir: pathlib.Path | None = None
    local_path: pathlib.Path | None = None
    if not is_url(source):
        source_path = pathlib.Path(source)
        if source_path.is_symlink():
            return 0, 0, [(source, "source is a symlink")]
        if source_path.is_dir():
            local_dir = source_path.resolve()
            location = str(local_dir / "SKILL.md")
        else:
            local_path = source_path.resolve()
            location = str(local_path)
    else:
        location = skill_document_location(source)

    try:
        text = read_source(location)
    except (OSError, urllib.error.URLError) as err:
        return 0, 0, [(source, f"unreadable: {err}")]

    skill_id = direct_skill_id(location, text)
    if skill_id is None:
        return 0, 0, [(source, "invalid or missing skill name")]
    if skill_id in excluded:
        return 0, 0, [(skill_id, "excluded by build")]
    if skill_id in emitted_ids:
        return 0, 0, [(skill_id, "duplicate id")]

    target = out_root / skill_id
    source_location = local_dir or local_path
    if source_location is not None and paths_overlap(source_location, target):
        return 0, 0, [(skill_id, "source and target directories overlap")]

    reset_target(target)
    references = 0
    if local_dir is not None:
        references, unsafe = copy_local_tree(local_dir, target)
        skipped.extend(
            (f"{skill_id}/{name}", "symlink or unsupported file") for name in unsafe
        )
    else:
        (target / "SKILL.md").write_text(text, encoding="utf-8")
        for name in reference_names(text):
            reference_location = urllib.parse.urljoin(location, f"references/{name}")
            try:
                reference_body = read_source(reference_location)
            except (OSError, urllib.error.URLError) as err:
                skipped.append((f"{skill_id}/references/{name}", f"unreadable: {err}"))
                continue
            reference_dir = target / "references"
            reference_dir.mkdir(parents=True, exist_ok=True)
            (reference_dir / name).write_text(reference_body, encoding="utf-8")
            references += 1

    emitted_ids.add(skill_id)
    return 1, references, skipped


def project_manifest(
    index: str,
    raw_base: str | None,
    out_root: pathlib.Path,
    categories: set[str],
    excluded: set[str],
    emitted_ids: set[str],
) -> tuple[int, int, list[tuple[str, str]], str | None]:
    try:
        manifest = json.loads(read_source(index))
    except (OSError, urllib.error.URLError, json.JSONDecodeError) as err:
        return 0, 0, [], f"cannot read index {index}: {err}"
    if not isinstance(manifest, dict):
        return 0, 0, [], f"index {index} must contain an object"
    skills = manifest.get("skills")
    if not isinstance(skills, list):
        return 0, 0, [], f"index {index} must contain a skills array"

    base = inferred_manifest_base(index, raw_base)
    emitted = 0
    references = 0
    skipped: list[tuple[str, str]] = []
    for skill in skills:
        if not isinstance(skill, dict):
            skipped.append(("<unknown>", "not an object"))
            continue
        skill_id = skill.get("id") or skill.get("name")
        if not isinstance(skill_id, str) or not SKILL_ID_PATTERN.fullmatch(skill_id):
            skipped.append((str(skill_id), "invalid id"))
            continue
        if skill.get("status", "active") != "active":
            skipped.append((skill_id, "status is not active"))
            continue
        if categories and skill.get("category") not in categories:
            skipped.append((skill_id, "category filtered out"))
            continue
        if skill_id in excluded:
            skipped.append((skill_id, "excluded by build"))
            continue
        if skill_id in emitted_ids:
            skipped.append((skill_id, "duplicate id"))
            continue

        entry_point = skill.get("entry_point")
        if not isinstance(entry_point, str):
            skipped.append((skill_id, "invalid entry_point"))
            continue
        location = resolve_manifest_entry(base, entry_point)
        if location is None:
            skipped.append((skill_id, "invalid entry_point"))
            continue
        location = skill_document_location(location)
        try:
            body = strip_frontmatter(read_source(location))
        except (OSError, urllib.error.URLError) as err:
            skipped.append((skill_id, f"unreadable: {err}"))
            continue

        target = out_root / skill_id
        if not is_url(location):
            source_path = pathlib.Path(location)
            source_location = (
                source_path.parent if source_path.name == "SKILL.md" else source_path
            )
            if paths_overlap(source_location, target):
                skipped.append((skill_id, "source and target directories overlap"))
                continue
        reset_target(target)
        (target / "SKILL.md").write_text(
            render(skill, body, skill_id), encoding="utf-8"
        )
        emitted += 1
        emitted_ids.add(skill_id)

        if not is_url(location):
            if source_path.name == "SKILL.md":
                copied, unsafe = copy_local_tree(
                    source_path.parent, target, skip_skill_file=True
                )
                references += copied
                skipped.extend(
                    (f"{skill_id}/{name}", "symlink or unsupported file")
                    for name in unsafe
                )
                continue

        entry_path = pathlib.PurePosixPath(urllib.parse.urlparse(location).path)
        if entry_path.name != "SKILL.md":
            continue
        for name in reference_names(body):
            reference_location = urllib.parse.urljoin(location, f"references/{name}")
            try:
                reference_body = read_source(reference_location)
            except (OSError, urllib.error.URLError) as err:
                skipped.append((f"{skill_id}/references/{name}", f"unreadable: {err}"))
                continue
            reference_dir = target / "references"
            reference_dir.mkdir(parents=True, exist_ok=True)
            (reference_dir / name).write_text(reference_body, encoding="utf-8")
            references += 1

    return emitted, references, skipped, None


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--index",
        action="append",
        default=[],
        help="index.json path or URL (repeatable; defaults to Bluefin common)",
    )
    parser.add_argument(
        "--source",
        action="append",
        default=[],
        help="local SKILL.md, skill directory, manifest, or remote URL (repeatable)",
    )
    parser.add_argument(
        "--raw-base",
        help="base path or URL for --index entry_point values",
    )
    parser.add_argument("--out", required=True, help="output skills root")
    parser.add_argument(
        "--category",
        action="append",
        default=[],
        help="only emit skills in this category (repeatable; default all)",
    )
    parser.add_argument(
        "--exclude",
        action="append",
        default=[],
        help="never emit this skill id (repeatable)",
    )
    parser.add_argument(
        "--allow-empty",
        action="store_true",
        help="succeed even when no skills are emitted",
    )
    args = parser.parse_args()
    out_root = pathlib.Path(args.out)
    out_root = pathlib.Path(args.out)

    emitted = 0
    references = 0
    skipped: list[tuple[str, str]] = []
    emitted_ids: set[str] = set()
    indexes = args.index
    direct_sources: list[str] = []
    for source in args.source:
        source_path = (
            urllib.parse.urlparse(source).path if is_url(source) else source
        )
        if pathlib.PurePosixPath(source_path).suffix == ".json":
            indexes.append(source)
            continue
        direct_sources.append(source)

    if not indexes and not direct_sources:
        indexes = [DEFAULT_INDEX]

    for index in indexes:
        count, reference_count, index_skipped, error = project_manifest(
            index,
            args.raw_base,
            out_root,
            set(args.category),
            set(args.exclude),
            emitted_ids,
        )
        if error:
            print(f"generate-skills: {error}", file=sys.stderr)
            return 1
        emitted += count
        references += reference_count
        skipped.extend(index_skipped)

    for source in direct_sources:
        count, reference_count, source_skipped = project_direct_source(
            source, out_root, set(args.exclude), emitted_ids
        )
        emitted += count
        references += reference_count
        skipped.extend(source_skipped)

    for skill_id, reason in skipped:
        print(f"generate-skills: skipped {skill_id}: {reason}", file=sys.stderr)
    print(
        f"generate-skills: wrote {emitted} skills "
        f"and {references} reference document(s) to {out_root}",
        file=sys.stderr,
    )

    if emitted == 0 and not args.allow_empty:
        print("generate-skills: no skills emitted", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
