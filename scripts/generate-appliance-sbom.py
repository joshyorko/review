#!/usr/bin/env python3
"""Write the SPDX manifest for the review appliance's derived OMP and fetched components.

This runs inside the build, where each source archive, patch, add-on, and runtime
artifact has already passed its pinned integrity check. It writes SPDX 2.3 JSON
to ``/usr/share/bluefin/review/sbom.spdx.json`` for the publication workflow.
"""

from __future__ import annotations

import argparse
import json
import pathlib
import re
import sys
from datetime import datetime, timezone

SHA256_PATTERN = re.compile(r"[0-9a-f]{64}\Z")
SHA512_PATTERN = re.compile(r"[0-9a-f]{128}\Z")
COMMIT_PATTERN = re.compile(r"[0-9a-f]{40}\Z")
GH_ARCH = {"x86_64": "amd64", "aarch64": "arm64"}
NODE_ARCH = {"x86_64": "x64", "aarch64": "arm64"}
BUN_ARCHIVE = {"x86_64": "bun-linux-x64-baseline.zip", "aarch64": "bun-linux-aarch64.zip"}
NATIVE_PACKAGE = {
    "x86_64": "pi-natives-linux-x64",
    "aarch64": "pi-natives-linux-arm64",
}


def require_sha256(value: str, label: str) -> str:
    if not SHA256_PATTERN.fullmatch(value):
        raise SystemExit(f"{label} must be a lowercase SHA-256 hex digest, got: {value!r}")
    return value


def require_sha512(value: str, label: str) -> str:
    if not SHA512_PATTERN.fullmatch(value):
        raise SystemExit(f"{label} must be a lowercase SHA-512 hex digest, got: {value!r}")
    return value


def require_commit(value: str, label: str) -> str:
    if not COMMIT_PATTERN.fullmatch(value):
        raise SystemExit(f"{label} must be a lowercase 40-character commit SHA, got: {value!r}")
    return value


def require_non_empty(value: str, label: str) -> str:
    if not value:
        raise SystemExit(f"{label} must not be empty")
    return value


def with_checksum_qualifier(purl: str, algorithm: str, digest: str) -> str:
    return f"{purl}?checksum={algorithm.lower()}:{digest}" if digest else purl


def package(
    name: str,
    version: str,
    download_url: str,
    purl: str,
    comment: str,
    checksum_algorithm: str = "",
    checksum_value: str = "",
) -> dict:
    entry = {
        "name": name,
        "SPDXID": f"SPDXRef-Package-{name.replace('/', '-').replace('@', '')}",
        "versionInfo": version,
        "downloadLocation": download_url,
        "filesAnalyzed": False,
        "externalRefs": [
            {
                "referenceCategory": "PACKAGE-MANAGER",
                "referenceType": "purl",
                "referenceLocator": with_checksum_qualifier(purl, checksum_algorithm, checksum_value),
            }
        ],
        "comment": comment,
    }
    if checksum_value:
        entry["checksums"] = [{"algorithm": checksum_algorithm.upper(), "checksumValue": checksum_value}]
    return entry


def build_packages(args: argparse.Namespace, arch: str) -> list[dict]:
    omp_version = require_non_empty(args.omp_version, "omp version")
    omp_bun_version = require_non_empty(args.omp_bun_version, "omp Bun version")
    natives_version = require_non_empty(args.omp_natives_version, "omp native addon version")
    node_version = require_non_empty(args.node_version, "Node.js version")
    gh_version = require_non_empty(args.gh_version, "gh version")
    source_commit = require_commit(args.omp_source_commit, "omp source commit")
    clipboard_patch_source_commit = require_commit(
        args.omp_clipboard_patch_source_commit, "omp clipboard patch source commit"
    )
    if clipboard_patch_source_commit != source_commit:
        raise SystemExit(
            "omp clipboard patch source commit must match the pinned OMP source commit"
        )
    omp_sha = require_sha256(args.omp_sha256, "omp_sha256")
    source_sha = require_sha256(args.omp_source_sha256, "omp_source_sha256")
    patch_sha = require_sha256(args.omp_patch_sha256, "omp_patch_sha256")
    clipboard_patch_sha = require_sha256(
        args.omp_clipboard_patch_sha256, "omp_clipboard_patch_sha256"
    )
    clipboard_patch_path = require_non_empty(
        args.omp_clipboard_patch_path, "omp clipboard patch path"
    )
    clipboard_patch_name = pathlib.PurePosixPath(clipboard_patch_path).name
    if not re.fullmatch(r"[A-Za-z0-9._-]+\.patch", clipboard_patch_name):
        raise SystemExit("omp clipboard patch path must end in a patch filename")
    native_sha = require_sha512(args.omp_native_sha512, "omp_native_sha512")
    gh_sha = require_sha256(args.gh_sha256, "gh_sha256")
    node_sha = require_sha256(args.node_sha256, "node_sha256")
    bun_sha = require_sha256(args.bun_sha256, "bun_sha256")

    native_package = NATIVE_PACKAGE[arch]
    if args.omp_native_package != native_package:
        raise SystemExit(
            f"omp native package for {arch} must be {native_package}, got: {args.omp_native_package!r}"
        )
    native_url = (
        "https://registry.npmjs.org/%40oh-my-pi%2F"
        f"{native_package}/-/{native_package}-{natives_version}.tgz"
    )
    gh_arch = GH_ARCH[arch]
    node_arch = NODE_ARCH[arch]
    node_url = f"https://nodejs.org/dist/v{node_version}/node-v{node_version}-linux-{node_arch}.tar.gz"
    bun_asset = BUN_ARCHIVE[arch]
    bun_url = f"https://github.com/oven-sh/bun/releases/download/bun-v{omp_bun_version}/{bun_asset}"
    source_url = f"https://github.com/can1357/oh-my-pi/archive/{source_commit}.tar.gz"
    patch_url = (
        f"https://github.com/joshyorko/review/blob/{args.revision}/"
        "patches/omp/memory-backend-registration.patch"
    )
    clipboard_patch_url = (
        f"https://github.com/joshyorko/review/blob/{args.revision}/"
        f"patches/omp/{clipboard_patch_name}"
    )

    return [
        package(
            "omp",
            omp_version,
            "NOASSERTION",
            f"pkg:generic/omp-derived@{omp_version}",
            "Review-derived OMP executable built locally from the pinned source archive "
            f"at {source_commit} (SHA-256 {source_sha}) with the generic memory registration "
            f"patch (SHA-256 {patch_sha}) and clipboard truthfulness patch "
            f"(SHA-256 {clipboard_patch_sha}), Bun {omp_bun_version}, and verified native "
            f"addon {native_package}@{natives_version}. Installed to /usr/bin/omp.",
            "SHA256",
            omp_sha,
        ),
        package(
            "omp-source",
            source_commit,
            source_url,
            f"pkg:github/can1357/oh-my-pi@{source_commit}",
            "Exact OMP source archive used to produce the Review-derived executable; its "
            "SHA-256 is verified before extraction.",
            "SHA256",
            source_sha,
        ),
        package(
            "omp-memory-backend-patch",
            args.revision,
            patch_url,
            f"pkg:generic/omp-memory-backend-registration-patch@{args.revision}",
            "Generic native MemoryBackend registration patch applied to the pinned OMP source; "
            "its SHA-256 is verified before application.",
            "SHA256",
            patch_sha,
        ),
        package(
            "omp-clipboard-truthfulness-patch",
            clipboard_patch_source_commit,
            clipboard_patch_url,
            f"pkg:generic/omp-clipboard-truthfulness-patch@{clipboard_patch_source_commit}",
            "Review patch for the pinned OMP source that changes /dump and /dump all status "
            "messages to report unconfirmed clipboard delivery; its SHA-256 is verified "
            "before application.",
            "SHA256",
            clipboard_patch_sha,
        ),
        package(
            "omp-native-addon",
            natives_version,
            native_url,
            f"pkg:npm/%40oh-my-pi/{native_package}@{natives_version}",
            "Pinned architecture-specific npm native addon build input, verified using the "
            "registry's SHA-512 integrity value.",
            "SHA512",
            native_sha,
        ),
        package(
            "node",
            node_version,
            node_url,
            f"pkg:generic/node@{node_version}",
            "Node.js runtime and bundled npm/npx distribution; the architecture-specific release archive is verified by SHA-256.",
            "SHA256",
            node_sha,
        ),
        package(
            "bun",
            omp_bun_version,
            bun_url,
            f"pkg:github/oven-sh/bun@bun-v{omp_bun_version}",
            "Pinned Bun runtime archive used to build OMP and installed in the appliance; its architecture-specific ZIP is verified by SHA-256.",
            "SHA256",
            bun_sha,
        ),
        package(
            "gh",
            gh_version,
            f"https://github.com/cli/cli/releases/download/v{gh_version}/gh_{gh_version}_linux_{gh_arch}.tar.gz",
            f"pkg:github/cli/cli@v{gh_version}",
            "GitHub CLI. The appliance reviews, approves, and merges through it, so it is a "
            "runtime dependency rather than a convenience. Installed to /usr/bin/gh.",
            "SHA256",
            gh_sha,
        ),
        package(
            "review-workbench",
            args.version,
            f"https://github.com/joshyorko/review/tree/{args.revision}/image/extension/bluefin-review",
            f"pkg:github/joshyorko/review@{args.revision}",
            "The GitHub Review workbench for OMP: its extension package and companion review "
            "agents, copied from this repository at the recorded revision. Installed to "
            "/usr/share/bluefin/review/extension.",
        ),
    ]


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--arch", required=True, help="uname -m of the build host")
    parser.add_argument("--version", required=True, help="appliance version, e.g. 26.08.03")
    parser.add_argument("--revision", required=True, help="review source revision")
    parser.add_argument("--out", required=True, type=pathlib.Path, help="output SPDX JSON path")
    parser.add_argument("--omp-version", required=True)
    parser.add_argument("--omp-sha256", required=True)
    parser.add_argument("--omp-source-commit", required=True)
    parser.add_argument("--omp-source-sha256", required=True)
    parser.add_argument("--omp-patch-sha256", required=True)
    parser.add_argument("--omp-clipboard-patch-source-commit", required=True)
    parser.add_argument("--omp-clipboard-patch-sha256", required=True)
    parser.add_argument("--omp-clipboard-patch-path", required=True)
    parser.add_argument("--omp-bun-version", required=True)
    parser.add_argument("--node-version", required=True)
    parser.add_argument("--node-sha256", required=True)
    parser.add_argument("--bun-sha256", required=True)
    parser.add_argument("--omp-natives-version", required=True)
    parser.add_argument("--omp-native-package", required=True)
    parser.add_argument("--omp-native-sha512", required=True)
    parser.add_argument("--gh-version", required=True)
    parser.add_argument("--gh-sha256", required=True)
    args = parser.parse_args()

    arch = {"x86_64": "x86_64", "aarch64": "aarch64", "arm64": "aarch64"}.get(args.arch)
    if arch is None:
        raise SystemExit(f"unsupported architecture: {args.arch}")

    document = {
        "spdxVersion": "SPDX-2.3",
        "dataLicense": "CC0-1.0",
        "SPDXID": "SPDXRef-DOCUMENT",
        "name": "joshyorko-review-appliance",
        "documentNamespace": "https://github.com/joshyorko/review/sbom/"
        f"review-appliance-{args.version}-{args.revision}-{arch}",
        "creationInfo": {
            "created": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
            "creators": ["Tool: review-generate-appliance-sbom"],
        },
        "packages": build_packages(args, arch),
    }
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(document, indent=2) + "\n", encoding="utf-8")
    return 0


if __name__ == "__main__":
    sys.exit(main())
