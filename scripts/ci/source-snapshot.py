#!/usr/bin/env python3
"""Copy tracked and non-ignored working-tree inputs without Git metadata."""

from __future__ import annotations

import os
import shutil
import subprocess
import sys
from pathlib import Path


def main() -> int:
    if len(sys.argv) != 2:
        print("usage: source-snapshot.py DESTINATION", file=sys.stderr)
        return 2
    root = Path(__file__).resolve().parents[2]
    destination = Path(sys.argv[1]).resolve()
    if destination == root or root in destination.parents:
        print("destination must be outside the repository", file=sys.stderr)
        return 2

    listed = subprocess.run(
        ["git", "ls-files", "--cached", "--others", "--exclude-standard", "-z"],
        cwd=root,
        check=True,
        stdout=subprocess.PIPE,
    ).stdout
    excluded_parts = {".git", "node_modules", ".cache", "__pycache__", ".agents", ".superpowers"}
    for raw_path in listed.split(b"\0"):
        if not raw_path:
            continue
        relative = os.fsdecode(raw_path)
        path = Path(relative)
        if path.is_absolute() or ".." in path.parts or any(part in excluded_parts for part in path.parts):
            continue
        if any(part == ".env" or part.startswith(".env.") for part in path.parts):
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
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
