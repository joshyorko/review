#!/usr/bin/env python3
"""Copy tracked and non-ignored working-tree inputs without Git metadata."""

from __future__ import annotations

import os
import shutil
import subprocess
import sys
from pathlib import Path

EXCLUDED_TRANSIENT_PARTS = {".git", "node_modules", ".cache", "__pycache__", ".agents", ".superpowers"}


def create_snapshot(root: Path, destination: Path, include_history: bool = False) -> None:
    root = root.resolve()
    destination = destination.resolve()
    if destination == root or root in destination.parents:
        raise ValueError("destination must be outside the repository")

    tracked_output = subprocess.run(
        ["git", "ls-files", "--cached", "-z"], cwd=root, check=True, stdout=subprocess.PIPE
    ).stdout
    tracked = {os.fsdecode(item) for item in tracked_output.split(b"\0") if item}
    listed = subprocess.run(
        ["git", "ls-files", "--cached", "--others", "--exclude-standard", "-z"],
        cwd=root,
        check=True,
        stdout=subprocess.PIPE,
    ).stdout
    for raw_path in listed.split(b"\0"):
        if not raw_path:
            continue
        relative = os.fsdecode(raw_path)
        path = Path(relative)
        if path.is_absolute() or ".." in path.parts:
            raise ValueError(f"unsafe repository path: {relative!r}")
        secret_path = any(part == ".env" or part.startswith(".env.") for part in path.parts)
        transient_part = next((part for part in path.parts if part in EXCLUDED_TRANSIENT_PARTS), None)
        tracked_agent_skill = ".agents" in path.parts and relative in tracked
        if secret_path or (transient_part and not tracked_agent_skill):
            if relative in tracked:
                raise ValueError(f"tracked source matches excluded path policy: {relative}")
            continue
        source = root / path
        if not os.path.lexists(source):
            continue
        target = destination / path
        target.parent.mkdir(parents=True, exist_ok=True)
        if source.is_symlink():
            target.symlink_to(os.readlink(source))
        elif source.is_file():
            shutil.copy2(source, target)
    if include_history:
        subprocess.run(
            ["git", "bundle", "create", str(destination / ".ci-history.bundle"), "HEAD"],
            cwd=root,
            check=True,
        )


def main() -> int:
    if len(sys.argv) not in (2, 3) or (len(sys.argv) == 3 and sys.argv[2] != "--history"):
        print("usage: source-snapshot.py DESTINATION [--history]", file=sys.stderr)
        return 2
    destination = Path(sys.argv[1]).resolve()
    root = Path(__file__).resolve().parents[2]
    try:
        create_snapshot(root, destination, include_history=len(sys.argv) == 3)
    except (OSError, subprocess.CalledProcessError, ValueError) as error:
        print(f"source snapshot failed: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
