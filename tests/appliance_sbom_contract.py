#!/usr/bin/env python3
"""Contract tests for the derived-OMP appliance SPDX generator.

The manifest records the built OMP executable, exact source archive and patch,
architecture-specific native addon input, fetched GitHub CLI, and Review
workbench. These checks validate artifact identity and provenance, not incidental
serialization.
"""

from __future__ import annotations

import json
import pathlib
import subprocess
import sys
import tempfile
import unittest

REPO_ROOT = pathlib.Path(__file__).resolve().parent.parent
SCRIPT = REPO_ROOT / "scripts" / "generate-appliance-sbom.py"

OMP_X86 = "a" * 64
OMP_ARM = "b" * 64
OMP_SOURCE = "c" * 64
OMP_PATCH = "d" * 64
NATIVE_X86 = "e" * 128
NATIVE_ARM = "f" * 128
GH_X86 = "1" * 64
GH_ARM = "2" * 64
RTK_X86 = "7" * 64
RTK_ARM = "8" * 64
RTK_HOOK = "9" * 64
RTK_LICENSE_SHA = "0" * 64
NODE_X86 = "3" * 64
NODE_ARM = "4" * 64
BUN_X86 = "5" * 64
BUN_ARM = "6" * 64
SOURCE_COMMIT = "abcdef0123456789abcdef0123456789abcdef01"
REVIEW_REVISION = "0123456789abcdef0123456789abcdef01234567"
BASE_ARGS = {
    "--version": "26.08.03",
    "--revision": REVIEW_REVISION,
    "--omp-version": "1.2.3",
    "--omp-sha256": OMP_X86,
    "--omp-source-commit": SOURCE_COMMIT,
    "--omp-source-sha256": OMP_SOURCE,
    "--omp-patch-sha256": OMP_PATCH,
    "--omp-bun-version": "1.4.2",
    "--bun-sha256": BUN_X86,
    "--node-version": "24.21.0",
    "--node-sha256": NODE_X86,
    "--omp-natives-version": "1.2.3",
    "--omp-native-package": "pi-natives-linux-x64",
    "--omp-native-sha512": NATIVE_X86,
    "--gh-version": "2.80.1",
    "--gh-sha256": GH_X86,
    "--rtk-version": "0.51.0",
    "--rtk-archive-sha256": RTK_X86,
    "--rtk-hook-sha256": RTK_HOOK,
    "--rtk-license-sha256": RTK_LICENSE_SHA,
}


def args_for_arch(arch: str, **overrides: str) -> dict[str, str]:
    resolved = "aarch64" if arch in ("aarch64", "arm64") else "x86_64"
    args = dict(BASE_ARGS)
    if resolved == "aarch64":
        args.update(
            {
                "--omp-sha256": OMP_ARM,
                "--omp-native-package": "pi-natives-linux-arm64",
                "--omp-native-sha512": NATIVE_ARM,
                "--node-sha256": NODE_ARM,
                "--bun-sha256": BUN_ARM,
                "--gh-sha256": GH_ARM,
                "--rtk-archive-sha256": RTK_ARM,
            }
        )
    args.update(overrides)
    return args


def run_generator(arch: str, out: pathlib.Path, **overrides: str):
    """Run the generator; return the CompletedProcess without raising."""
    args = args_for_arch(arch, **overrides)
    argv = [sys.executable, str(SCRIPT), "--arch", arch, "--out", str(out)]
    for flag, value in args.items():
        argv += [flag, value]
    return subprocess.run(argv, capture_output=True, text=True, check=False)


def generate(testcase: unittest.TestCase, arch: str, **overrides: str) -> dict:
    """Run the generator, assert success, and return the parsed document."""
    with tempfile.TemporaryDirectory() as tmp:
        out = pathlib.Path(tmp) / "nested" / "sbom.spdx.json"
        result = run_generator(arch, out, **overrides)
        testcase.assertEqual(
            result.returncode, 0, f"generator failed: {result.stderr or result.stdout}"
        )
        testcase.assertTrue(out.is_file(), "generator did not create its output path")
        raw = out.read_text(encoding="utf-8")
    testcase.assertTrue(raw.endswith("\n"), "SPDX JSON must end with a newline")
    return json.loads(raw)


def packages_by_name(document: dict) -> dict:
    return {package["name"]: package for package in document["packages"]}


class ArchitectureSelection(unittest.TestCase):
    def test_arm64_is_an_alias_for_aarch64(self):
        alias = generate(self, "arm64")
        native = generate(self, "aarch64")
        self.assertEqual(alias["packages"], native["packages"])
        self.assertTrue(alias["documentNamespace"].endswith("-aarch64"))

    def test_unsupported_architecture_is_refused(self):
        with tempfile.TemporaryDirectory() as tmp:
            out = pathlib.Path(tmp) / "sbom.spdx.json"
            result = run_generator("riscv64", out)
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("unsupported architecture: riscv64", result.stderr)
            self.assertFalse(out.exists(), "a refused build must not leave an SBOM")

    def test_native_addon_package_must_match_the_build_architecture(self):
        with tempfile.TemporaryDirectory() as tmp:
            out = pathlib.Path(tmp) / "sbom.spdx.json"
            result = run_generator("aarch64", out, **{"--omp-native-package": "pi-natives-linux-x64"})
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("omp native package for aarch64 must be pi-natives-linux-arm64", result.stderr)
            self.assertFalse(out.exists())


class PerArchitectureDigests(unittest.TestCase):
    """The SBOM must describe the bytes built for this architecture only."""

    def test_x86_64_records_its_derived_binary_native_addon_and_gh_hashes(self):
        found = packages_by_name(generate(self, "x86_64"))
        self.assertEqual(found["omp"]["checksums"][0]["checksumValue"], OMP_X86)
        self.assertEqual(found["omp-native-addon"]["checksums"][0]["checksumValue"], NATIVE_X86)
        self.assertEqual(found["gh"]["checksums"][0]["checksumValue"], GH_X86)
        self.assertEqual(found["rtk"]["checksums"][0]["checksumValue"], RTK_X86)
        self.assertEqual(found["rtk-omp-hook"]["checksums"][0]["checksumValue"], RTK_HOOK)
        self.assertEqual(found["rtk-license"]["checksums"][0]["checksumValue"], RTK_LICENSE_SHA)
        self.assertEqual(found["node"]["checksums"][0]["checksumValue"], NODE_X86)
        self.assertEqual(found["bun"]["checksums"][0]["checksumValue"], BUN_X86)
        serialized = json.dumps(found)
        for foreign in (OMP_ARM, NATIVE_ARM, GH_ARM, RTK_ARM, NODE_ARM, BUN_ARM):
            self.assertNotIn(foreign, serialized, "an aarch64 digest reached an x86_64 SBOM")

    def test_aarch64_records_its_derived_binary_native_addon_and_gh_hashes(self):
        found = packages_by_name(generate(self, "aarch64"))
        self.assertEqual(found["omp"]["checksums"][0]["checksumValue"], OMP_ARM)
        self.assertEqual(found["omp-native-addon"]["checksums"][0]["checksumValue"], NATIVE_ARM)
        self.assertEqual(found["gh"]["checksums"][0]["checksumValue"], GH_ARM)
        self.assertEqual(found["rtk"]["checksums"][0]["checksumValue"], RTK_ARM)
        self.assertEqual(found["rtk-omp-hook"]["checksums"][0]["checksumValue"], RTK_HOOK)
        self.assertEqual(found["rtk-license"]["checksums"][0]["checksumValue"], RTK_LICENSE_SHA)
        self.assertEqual(found["node"]["checksums"][0]["checksumValue"], NODE_ARM)
        self.assertEqual(found["bun"]["checksums"][0]["checksumValue"], BUN_ARM)
        serialized = json.dumps(found)
        for foreign in (OMP_X86, NATIVE_X86, GH_X86, RTK_X86, NODE_X86, BUN_X86):
            self.assertNotIn(foreign, serialized, "an x86_64 digest reached an aarch64 SBOM")

    def test_every_verified_component_has_its_actual_checksum_algorithm(self):
        found = packages_by_name(generate(self, "x86_64"))
        for name in ("omp", "omp-source", "omp-memory-backend-patch", "gh", "rtk", "rtk-omp-hook", "rtk-license"):
            self.assertEqual(found[name]["checksums"][0]["algorithm"], "SHA256")
        self.assertEqual(found["rtk"]["licenseDeclared"], "Apache-2.0")
        self.assertEqual(found["rtk-omp-hook"]["licenseDeclared"], "Apache-2.0")
        self.assertEqual(found["rtk-license"]["licenseDeclared"], "Apache-2.0")
        self.assertEqual(found["omp-native-addon"]["checksums"][0]["algorithm"], "SHA512")
        self.assertEqual(found["node"]["checksums"][0]["algorithm"], "SHA256")
        self.assertEqual(found["bun"]["checksums"][0]["algorithm"], "SHA256")
        self.assertNotIn("checksums", found["review-workbench"])

    def test_derived_binary_records_its_exact_source_patch_and_bun_inputs(self):
        found = packages_by_name(generate(self, "x86_64"))
        comment = found["omp"]["comment"]
        self.assertIn(SOURCE_COMMIT, comment)
        self.assertIn(OMP_SOURCE, comment)
        self.assertIn(OMP_PATCH, comment)
        self.assertIn("Bun 1.4.2", comment)


class DigestValidation(unittest.TestCase):
    def assert_rejected(self, fragment: str, **overrides: str):
        with tempfile.TemporaryDirectory() as tmp:
            out = pathlib.Path(tmp) / "sbom.spdx.json"
            result = run_generator("x86_64", out, **overrides)
            self.assertNotEqual(result.returncode, 0, f"accepted a bad value: {overrides}")
            self.assertIn(fragment, result.stderr)
            self.assertFalse(out.exists())

    def test_sha256_fields_reject_bad_case_length_and_alphabet(self):
        self.assert_rejected("omp_sha256", **{"--omp-sha256": "A" * 64})
        self.assert_rejected("omp_source_sha256", **{"--omp-source-sha256": "c" * 63})
        self.assert_rejected("omp_patch_sha256", **{"--omp-patch-sha256": "z" * 64})
        self.assert_rejected("gh_sha256", **{"--gh-sha256": "sha256:" + GH_X86})
        self.assert_rejected("rtk_archive_sha256", **{"--rtk-archive-sha256": "A" * 64})
        self.assert_rejected("rtk_hook_sha256", **{"--rtk-hook-sha256": "z" * 64})
        self.assert_rejected("rtk_license_sha256", **{"--rtk-license-sha256": "z" * 64})
        self.assert_rejected("node_sha256", **{"--node-sha256": "Z" * 64})
        self.assert_rejected("bun_sha256", **{"--bun-sha256": "Z" * 64})

    def test_native_sha512_must_be_exact_hex(self):
        self.assert_rejected("omp_native_sha512", **{"--omp-native-sha512": "e" * 127})
        self.assert_rejected("omp_native_sha512", **{"--omp-native-sha512": "Z" * 128})

    def test_source_commit_must_be_a_full_lowercase_sha(self):
        self.assert_rejected("omp source commit", **{"--omp-source-commit": "abc123"})

    def test_empty_versions_are_refused_by_name(self):
        for flag, label in (
            ("--omp-version", "omp version"),
            ("--omp-bun-version", "omp Bun version"),
            ("--omp-natives-version", "omp native addon version"),
            ("--gh-version", "gh version"),
            ("--node-version", "Node.js version"),
        ):
            with self.subTest(flag=flag):
                self.assert_rejected(f"{label} must not be empty", **{flag: ""})

    def test_missing_required_argument_is_refused(self):
        with tempfile.TemporaryDirectory() as tmp:
            argv = [sys.executable, str(SCRIPT), "--arch", "x86_64", "--out", str(pathlib.Path(tmp) / "sbom.json")]
            result = subprocess.run(argv, capture_output=True, text=True, check=False)
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("required", result.stderr)


class DownloadLocations(unittest.TestCase):
    def test_derived_binary_is_not_mislabeled_as_an_upstream_download(self):
        found = packages_by_name(generate(self, "x86_64"))
        self.assertEqual(found["omp"]["downloadLocation"], "NOASSERTION")

    def test_omp_source_and_patch_urls_are_exact_pinned_inputs(self):
        found = packages_by_name(generate(self, "x86_64"))
        self.assertEqual(
            found["omp-source"]["downloadLocation"],
            f"https://github.com/can1357/oh-my-pi/archive/{SOURCE_COMMIT}.tar.gz",
        )
        self.assertEqual(
            found["omp-memory-backend-patch"]["downloadLocation"],
            f"https://github.com/joshyorko/review/blob/{REVIEW_REVISION}/patches/omp/memory-backend-registration.patch",
        )

    def test_node_download_is_versioned_and_architecture_specific(self):
        x86 = packages_by_name(generate(self, "x86_64"))
        arm = packages_by_name(generate(self, "aarch64"))
        self.assertEqual(
            x86["node"]["downloadLocation"],
            "https://nodejs.org/dist/v24.21.0/node-v24.21.0-linux-x64.tar.gz",
        )
        self.assertEqual(
            arm["node"]["downloadLocation"],
            "https://nodejs.org/dist/v24.21.0/node-v24.21.0-linux-arm64.tar.gz",
        )

    def test_bun_runtime_archive_is_versioned_and_architecture_specific(self):
        x86 = packages_by_name(generate(self, "x86_64"))
        arm = packages_by_name(generate(self, "aarch64"))
        self.assertEqual(
            x86["bun"]["downloadLocation"],
            "https://github.com/oven-sh/bun/releases/download/bun-v1.4.2/bun-linux-x64-baseline.zip",
        )
        self.assertEqual(
            arm["bun"]["downloadLocation"],
            "https://github.com/oven-sh/bun/releases/download/bun-v1.4.2/bun-linux-aarch64.zip",
        )

    def test_native_archive_url_is_scoped_and_architecture_specific(self):
        found = packages_by_name(generate(self, "aarch64"))
        self.assertEqual(
            found["omp-native-addon"]["downloadLocation"],
            "https://registry.npmjs.org/%40oh-my-pi%2Fpi-natives-linux-arm64/-/pi-natives-linux-arm64-1.2.3.tgz",
        )

    def test_gh_download_url_is_architecture_specific(self):
        x86 = packages_by_name(generate(self, "x86_64"))
        arm = packages_by_name(generate(self, "aarch64"))
        self.assertEqual(
            x86["gh"]["downloadLocation"],
            "https://github.com/cli/cli/releases/download/v2.80.1/gh_2.80.1_linux_amd64.tar.gz",
        )
        self.assertEqual(
            arm["gh"]["downloadLocation"],
            "https://github.com/cli/cli/releases/download/v2.80.1/gh_2.80.1_linux_arm64.tar.gz",
        )

    def test_rtk_binary_and_hook_urls_are_versioned_and_architecture_specific(self):
        x86 = packages_by_name(generate(self, "x86_64"))
        arm = packages_by_name(generate(self, "aarch64"))
        self.assertEqual(
            x86["rtk"]["downloadLocation"],
            "https://github.com/rtk-ai/rtk/releases/download/v0.51.0/rtk-x86_64-unknown-linux-musl.tar.gz",
        )
        self.assertEqual(
            arm["rtk"]["downloadLocation"],
            "https://github.com/rtk-ai/rtk/releases/download/v0.51.0/rtk-aarch64-unknown-linux-gnu.tar.gz",
        )
        self.assertEqual(
            x86["rtk-omp-hook"]["downloadLocation"],
            "https://raw.githubusercontent.com/rtk-ai/rtk/v0.51.0/hooks/pi/rtk.ts",
        )
        self.assertEqual(x86["rtk-omp-hook"]["downloadLocation"], arm["rtk-omp-hook"]["downloadLocation"])
        self.assertEqual(
            x86["rtk-license"]["downloadLocation"],
            "https://raw.githubusercontent.com/rtk-ai/rtk/v0.51.0/LICENSE",
        )
        self.assertEqual(x86["rtk-license"]["downloadLocation"], arm["rtk-license"]["downloadLocation"])


class PackageIdentity(unittest.TestCase):
    def test_all_build_inputs_and_runtime_components_are_recorded(self):
        found = packages_by_name(generate(self, "x86_64"))
        self.assertEqual(
            sorted(found),
            ["bun", "gh", "node", "omp", "omp-memory-backend-patch", "omp-native-addon", "omp-source", "review-workbench", "rtk", "rtk-license", "rtk-omp-hook"],
        )
        self.assertEqual(found["omp"]["versionInfo"], "1.2.3")
        self.assertEqual(found["omp-source"]["versionInfo"], SOURCE_COMMIT)
        self.assertEqual(found["omp-memory-backend-patch"]["versionInfo"], REVIEW_REVISION)
        self.assertEqual(found["omp-native-addon"]["versionInfo"], "1.2.3")
        self.assertEqual(found["gh"]["versionInfo"], "2.80.1")
        self.assertEqual(found["rtk"]["versionInfo"], "0.51.0")
        self.assertEqual(found["rtk-omp-hook"]["versionInfo"], "0.51.0")
        self.assertEqual(found["rtk-license"]["versionInfo"], "0.51.0")
        self.assertEqual(found["node"]["versionInfo"], "24.21.0")
        self.assertEqual(found["bun"]["versionInfo"], "1.4.2")
        self.assertEqual(found["review-workbench"]["versionInfo"], "26.08.03")

    def test_spdxids_are_unique_and_sanitised(self):
        found = packages_by_name(generate(self, "x86_64"))
        identifiers = [item["SPDXID"] for item in found.values()]
        self.assertEqual(len(identifiers), len(set(identifiers)))
        for identifier in identifiers:
            self.assertRegex(identifier, r"^SPDXRef-[A-Za-z0-9.\-]+$")

    def test_purls_carry_verified_digests_with_the_correct_algorithm(self):
        found = packages_by_name(generate(self, "aarch64"))

        def locator(name: str) -> str:
            return found[name]["externalRefs"][0]["referenceLocator"]

        self.assertEqual(
            locator("omp"), f"pkg:generic/omp-derived@1.2.3?checksum=sha256:{OMP_ARM}"
        )
        self.assertEqual(
            locator("omp-source"),
            f"pkg:github/can1357/oh-my-pi@{SOURCE_COMMIT}?checksum=sha256:{OMP_SOURCE}",
        )
        self.assertEqual(
            locator("omp-memory-backend-patch"),
            f"pkg:generic/omp-memory-backend-registration-patch@{REVIEW_REVISION}?checksum=sha256:{OMP_PATCH}",
        )
        self.assertEqual(
            locator("omp-native-addon"),
            f"pkg:npm/%40oh-my-pi/pi-natives-linux-arm64@1.2.3?checksum=sha512:{NATIVE_ARM}",
        )
        self.assertEqual(locator("gh"), f"pkg:github/cli/cli@v2.80.1?checksum=sha256:{GH_ARM}")
        self.assertEqual(locator("rtk"), f"pkg:github/rtk-ai/rtk@v0.51.0?checksum=sha256:{RTK_ARM}")
        self.assertEqual(locator("rtk-omp-hook"), f"pkg:generic/rtk-omp-hook@0.51.0?checksum=sha256:{RTK_HOOK}")
        self.assertEqual(locator("rtk-license"), f"pkg:generic/rtk-license@0.51.0?checksum=sha256:{RTK_LICENSE_SHA}")
        self.assertEqual(locator("node"), f"pkg:generic/node@24.21.0?checksum=sha256:{NODE_ARM}")
        self.assertEqual(locator("bun"), f"pkg:github/oven-sh/bun@bun-v1.4.2?checksum=sha256:{BUN_ARM}")
        self.assertEqual(locator("review-workbench"), f"pkg:github/joshyorko/review@{REVIEW_REVISION}")

    def test_external_refs_are_package_manager_purls(self):
        for item in generate(self, "x86_64")["packages"]:
            reference = item["externalRefs"][0]
            self.assertEqual(reference["referenceCategory"], "PACKAGE-MANAGER")
            self.assertEqual(reference["referenceType"], "purl")
            self.assertFalse(item["filesAnalyzed"])
            self.assertTrue(item["comment"].strip())


class DocumentShape(unittest.TestCase):
    def test_spdx_envelope(self):
        document = generate(self, "x86_64")
        self.assertEqual(document["spdxVersion"], "SPDX-2.3")
        self.assertEqual(document["dataLicense"], "CC0-1.0")
        self.assertEqual(document["SPDXID"], "SPDXRef-DOCUMENT")
        self.assertEqual(document["name"], "joshyorko-review-appliance")

    def test_namespace_is_unique_per_version_revision_and_arch(self):
        document = generate(self, "x86_64")
        self.assertEqual(
            document["documentNamespace"],
            "https://github.com/joshyorko/review/sbom/review-appliance-"
            f"26.08.03-{REVIEW_REVISION}-x86_64",
        )

    def test_creation_info_is_utc_and_tool_attributed(self):
        creation = generate(self, "x86_64")["creationInfo"]
        self.assertRegex(creation["created"], r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$")
        self.assertEqual(creation["creators"], ["Tool: review-generate-appliance-sbom"])


if __name__ == "__main__":
    unittest.main()
