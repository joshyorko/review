#!/usr/bin/env python3
"""Validate a requested stable version against current and published versions."""
import re
import sys


def parse(value):
    if not re.fullmatch(r'(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)', value):
        raise ValueError(f'invalid stable version: {value!r}; use MAJOR.MINOR.PATCH')
    return tuple(map(int, value.split('.')))


def main():
    current, requested = sys.argv[1:]
    if requested in ('patch', 'minor', 'major'):
        major, minor, patch = parse(current)
        requested = {'patch': f'{major}.{minor}.{patch + 1}',
                     'minor': f'{major}.{minor + 1}.0',
                     'major': f'{major + 1}.0.0'}[requested]
    if parse(requested) <= parse(current):
        raise ValueError(f'{requested} must be newer than {current}')
    if f'v{requested}' in sys.stdin.read().splitlines():
        raise ValueError(f'v{requested} already exists as a release or tag')
    print(requested)


if __name__ == '__main__':
    try:
        main()
    except ValueError as error:
        sys.exit(str(error))
