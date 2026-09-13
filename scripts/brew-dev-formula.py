#!/usr/bin/env python3
"""Validate native bundles and generate the single moving personal formula."""
import hashlib
import json
from pathlib import Path
import re
import sys
from datetime import datetime, timezone


def prepare(bundles: Path, output: Path):
    records = [json.loads(p.read_text()) for p in sorted(bundles.glob('manifest-*.json'))]
    if not records:
        raise ValueError('no bundle manifests')
    if len({(r['sha'], r['ref']) for r in records}) != 1:
        raise ValueError('bundles must share one source ref and commit')
    sha, ref = records[0]['sha'], records[0]['ref']
    if not re.fullmatch('[0-9a-f]{40}', sha):
        raise ValueError('source SHA must be a full commit')
    arches = [r['arch'] for r in records]
    if len(set(arches)) != len(arches) or any(a not in ('x86_64', 'aarch64') for a in arches):
        raise ValueError('invalid or repeated architecture')
    expected = {f'bluefin-review-dev-{a}.tar.gz' for a in arches}
    if {p.name for p in bundles.glob('bluefin-review-dev-*.tar.gz')} != expected:
        raise ValueError('archives and manifests must match exactly')
    version = '0.' + datetime.now(timezone.utc).strftime('%Y%m%d%H%M%S')
    tag = f'dev-{version}-{sha[:12]}'
    lines = ['class BluefinReviewDev < Formula',
             '  desc "Personal development builds of Bluefin Review"',
             '  homepage "https://github.com/joshyorko/review"',
             f'  version "{version}"', '  license "Apache-2.0"',
             '  depends_on :linux', '  depends_on "apptainer"', '  depends_on "squashfuse"', '  depends_on "gh"',
             '  conflicts_with "bluefin-contributor-tools", because: "both provide bluefin"']
    if len(arches) == 1:
        lines.append('  depends_on arch: :' + ('x86_64' if arches[0] == 'x86_64' else 'arm64'))
    for r in records:
        name = f"bluefin-review-dev-{r['arch']}.tar.gz"
        actual = hashlib.sha256((bundles/name).read_bytes()).hexdigest()
        if actual != r['archive_sha256']:
            raise ValueError('archive checksum differs from manifest')
        scope = 'on_intel' if r['arch'] == 'x86_64' else 'on_arm'
        lines += [f'  {scope} do', f'    url "https://github.com/joshyorko/review/releases/download/{tag}/{name}"',
                  f'    sha256 "{actual}"', '  end']
    lines += ['  def install', '    libexec.install "launcher", "build.json", "build.txt"',
              '    bin.install "bluefin"', '    bin.install_symlink libexec/"launcher/bin/bluefin-contribute"',
              '  end', '  test do', '    assert_match "Usage: bluefin", shell_output("#{bin}/bluefin 2>&1", 2)',
              '    assert_predicate libexec/"launcher/bluefin-review.sif", :executable?', '  end', 'end', '']
    output.mkdir(parents=True, exist_ok=True)
    (output/'bluefin-review-dev.rb').write_text('\n'.join(lines))
    (output/'sha').write_text(sha+'\n')
    (output/'tag').write_text(tag+'\n')
    (output/'notes').write_text(f'Source: {ref}\nCommit: {sha}\nNative Linux launcher and SIF from the same commit.\n')


if __name__ == '__main__':
    prepare(Path(sys.argv[1]), Path(sys.argv[2]))
