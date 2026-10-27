#!/usr/bin/env python3
"""Draft release notes from explicit Git history; read committed release prose."""
from pathlib import Path
import re
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[1]


def section(text, version):
    headings = list(re.finditer(r'^## \[([^\]]+)\].*$', text, re.MULTILINE))
    matches = [(i, h) for i, h in enumerate(headings) if h[1] == version]
    if len(matches) != 1:
        raise ValueError(f'changelog must contain exactly one section for {version}')
    i, heading = matches[0]
    end = headings[i + 1].start() if i + 1 < len(headings) else len(text)
    result = text[heading.start():end].strip()
    if not result.split('\n', 1)[-1].strip() or '\n' not in result:
        raise ValueError(f'changelog section for {version} is empty')
    return result


def main():
    action, *args = sys.argv[1:]
    path = ROOT / 'CHANGELOG.md'
    if action == 'section':
        print(section(path.read_text(), args[0]))
    elif action == 'draft':
        current, requested = args
        if not re.fullmatch(r'\d+\.\d+\.\d+', requested):
            raise ValueError('requested version must be MAJOR.MINOR.PATCH')
        if subprocess.check_output(['git-cliff', '--version'], text=True).strip() != 'git-cliff 2.14.2':
            raise ValueError('release authoring requires git-cliff 2.14.2; use scripts/install-git-cliff.sh')
        baseline = f'v{current}'
        head = subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=ROOT, text=True).strip()
        subprocess.run(['git', 'merge-base', '--is-ancestor', baseline, head], cwd=ROOT, check=True)
        result = subprocess.check_output(['git-cliff', f'{baseline}..{head}', '--config', str(ROOT / 'cliff.toml'),
                                          '--tag', f'v{requested}', '--strip', 'all'], cwd=ROOT, text=True)
        print(section(result, requested))
    elif action == 'prepend':
        version, = args
        new = section(sys.stdin.read(), version)
        old = path.read_text()
        if re.search(r'^## \[' + re.escape(version) + r'\]', old, re.MULTILINE):
            raise ValueError(f'changelog already contains {version}')
        first = re.search(r'^## \[', old, re.MULTILINE)
        offset = first.start() if first else len(old)
        path.write_text(old[:offset].rstrip() + '\n\n' + new + '\n\n' + old[offset:])
    else:
        raise ValueError('usage: review-changelog.py section VERSION | draft CURRENT NEXT | prepend VERSION')


if __name__ == '__main__':
    try:
        main()
    except (ValueError, subprocess.CalledProcessError) as error:
        sys.exit(str(error))
