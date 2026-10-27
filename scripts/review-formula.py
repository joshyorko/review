#!/usr/bin/env python3
"""Validate native bundles and generate the stable Review formula."""
import importlib.util
import hashlib
import json
from pathlib import Path
import re
import sys


def prepare(bundles: Path, output: Path, changelog=None):
    records = [json.loads(p.read_text()) for p in sorted(bundles.glob('manifest-*.json'))]
    if not records:
        raise ValueError('no bundle manifests')
    if len({(r['sha'], r['ref']) for r in records}) != 1:
        raise ValueError('bundles must share one source ref and commit')
    sha, ref = records[0]['sha'], records[0]['ref']
    if not re.fullmatch('[0-9a-f]{40}', sha):
        raise ValueError('source SHA must be a full commit')
    default_oci = f'ghcr.io/joshyorko/review:sha-{sha}'
    oci_images = {r.get('oci_image', default_oci) for r in records}
    if len(oci_images) != 1:
        raise ValueError('bundles must share one OCI image reference')
    oci_image = oci_images.pop()
    if not re.fullmatch(r'ghcr\.io/joshyorko/review:sha-[0-9a-f]{40}', oci_image):
        raise ValueError('OCI image must use the full-commit reference')
    arches = [r['arch'] for r in records]
    if len(set(arches)) != len(arches) or any(a not in ('x86_64', 'aarch64') for a in arches):
        raise ValueError('invalid or repeated architecture')
    expected = {f'review-{a}.tar.gz' for a in arches}
    if {p.name for p in bundles.glob('review-*.tar.gz')} != expected:
        raise ValueError('archives and manifests must match exactly')
    versions = {r.get('version') for r in records}
    if len(versions) != 1:
        raise ValueError('bundles must share one version')
    version = versions.pop()
    if not isinstance(version, str) or not re.fullmatch(r'0|[1-9][0-9]*', version.split('.')[0]) or not re.fullmatch(r'[0-9]+\.[0-9]+\.[0-9]+', version):
        raise ValueError('bundle version must be semantic MAJOR.MINOR.PATCH')
    tag = f'v{version}'
    lines = ['class Review < Formula',
             '  desc "GitHub review workbench and Luna Factory"',
             '  homepage "https://github.com/joshyorko/review"',
             f'  version "{version}"', '  license "Apache-2.0"',
             '  depends_on :linux', '  depends_on "apptainer"', '  depends_on "squashfuse"', '  depends_on "gh"',
             ]
    if len(arches) == 1:
        lines.append('  depends_on arch: :' + ('x86_64' if arches[0] == 'x86_64' else 'arm64'))
    for r in records:
        name = f"review-{r['arch']}.tar.gz"
        expected_oci_arch = f'{oci_image}-{r["arch"]}'
        if r.get('oci_arch_image', expected_oci_arch) != expected_oci_arch:
            raise ValueError('OCI architecture reference does not match source image')
        actual = hashlib.sha256((bundles/name).read_bytes()).hexdigest()
        if actual != r['archive_sha256']:
            raise ValueError('archive checksum differs from manifest')
        scope = 'on_intel' if r['arch'] == 'x86_64' else 'on_arm'
        lines += [f'  {scope} do', f'    url "https://github.com/joshyorko/review/releases/download/{tag}/{name}"',
                  f'    sha256 "{actual}"', '  end']
    lines += ['  livecheck do', '    url :stable', '    strategy :github_latest', '  end', '  def install', '    libexec.install "launcher", "build.json", "build.txt", "LICENSE", "NOTICE"',
              '    bin.install "review"',
              '  end', '  test do', '    assert_match "Usage: review", shell_output("#{bin}/review --help 2>&1")',
              '    assert_predicate libexec/"launcher/review.sif", :executable?', '  end', 'end', '']
    spec = importlib.util.spec_from_file_location('review_changelog', Path(__file__).with_name('review-changelog.py'))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    notes = module.section(Path(changelog or Path(__file__).resolve().parents[1] / 'CHANGELOG.md').read_text(), version)
    output.mkdir(parents=True, exist_ok=True)
    (output/'review.rb').write_text('\n'.join(lines))
    (output/'sha').write_text(sha+'\n')
    (output/'tag').write_text(tag+'\n')
    (output/'notes').write_text(notes + f'\n\n### Build provenance\n\nSource: {ref}\nCommit: {sha}\nOCI: {oci_image}\nNative Linux launcher and SIF from the same commit.\n')


if __name__ == '__main__':
    prepare(Path(sys.argv[1]), Path(sys.argv[2]))
