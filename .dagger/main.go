// Review CI runs repository verification in a pinned Dagger engine.
package main

import (
	"context"
	"embed"
	"encoding/json"
	"fmt"
	"reflect"
	"regexp"
	"strings"

	"dagger/review-ci/internal/dagger"
)

//go:embed verify-source-identity.sh
var sourceIdentityVerifier embed.FS

//go:embed install-precommit-hooks.sh
var preCommitHookInstaller embed.FS

type ReviewCi struct{}

// Runs fast, host-independent contracts against the supplied source snapshot.
func (m *ReviewCi) Contract(ctx context.Context, source *dagger.Directory) (string, error) {
	return m.Check(ctx, source, "contract")
}

// Runs the portable profile. Native runtime checks and publication are kept
// outside this credential-free container execution.
func (m *ReviewCi) Portable(ctx context.Context, source *dagger.Directory) (string, error) {
	return m.Check(ctx, source, "portable")
}

func (m *ReviewCi) applianceImage(ctx context.Context, source *dagger.Directory, revision string) (*dagger.Container, string, dagger.ID, error) {
	if len(revision) != 40 {
		return nil, "", "", fmt.Errorf("appliance source revision must be a full commit SHA")
	}
	for _, char := range revision {
		if !(char >= '0' && char <= '9') && !(char >= 'a' && char <= 'f') {
			return nil, "", "", fmt.Errorf("appliance source revision must be lowercase hexadecimal")
		}
	}
	committedSource, err := m.verifySourceSubject(ctx, source, revision)
	if err != nil {
		return nil, "", "", err
	}
	version, err := committedSource.File("VERSION").Contents(ctx)
	if err != nil {
		return nil, "", "", fmt.Errorf("read Review VERSION: %w", err)
	}
	version = strings.TrimSpace(version)
	containerfile, err := committedSource.File("image/appliance/Containerfile").Contents(ctx)
	if err != nil {
		return nil, "", "", fmt.Errorf("read appliance Containerfile: %w", err)
	}
	ompCommit := regexp.MustCompile(`(?m)^ARG OMP_SOURCE_COMMIT=([0-9a-f]{40})$`).FindStringSubmatch(containerfile)
	if len(ompCommit) != 2 {
		return nil, "", "", fmt.Errorf("appliance Containerfile does not declare one full OMP source commit")
	}
	image := committedSource.DockerBuild(dagger.DirectoryDockerBuildOpts{
		Dockerfile: "image/appliance/Containerfile",
		BuildArgs: []dagger.BuildArg{
			{Name: "REVIEW_VERSION", Value: version},
			{Name: "REVIEW_REVISION", Value: revision},
		},
	})
	for name, expected := range map[string]string{
		"org.opencontainers.image.version":         version,
		"org.opencontainers.image.revision":        revision,
		"io.github.joshyorko.review.omp.source.commit": ompCommit[1],
		"io.github.joshyorko.review.omp.memoryd.shim": "0",
	} {
		actual, err := image.Label(ctx, name)
		if err != nil {
			return nil, "", "", fmt.Errorf("read built appliance label %s: %w", name, err)
		}
		if actual != expected {
			return nil, "", "", fmt.Errorf("built appliance label %s mismatch: expected %q, found %q", name, expected, actual)
		}
	}
	imageID, err := image.ID(ctx)
	if err != nil {
		return nil, "", "", fmt.Errorf("resolve built appliance identity: %w", err)
	}
	return image, version, imageID, nil
}

func (m *ReviewCi) verifySourceSubject(ctx context.Context, source *dagger.Directory, revision string) (*dagger.Directory, error) {
	verifier, err := sourceIdentityVerifier.ReadFile("verify-source-identity.sh")
	if err != nil {
		return nil, fmt.Errorf("read trusted source identity verifier: %w", err)
	}
	container := dag.Container().
		From("python:3.13.9-slim-bookworm@sha256:b685a4fa58bb19d1814d78a1ec0f0208f351452724f78b20212c984d6e124a34").
		WithExec([]string{"sh", "-c", "set -eu; apt-get update; apt-get install -y --no-install-recommends bash=5.2.15-2+b13 git=1:2.39.5-0+deb12u3 ca-certificates=20250419~deb12u2; rm -rf /var/lib/apt/lists/*"}).
		WithNewFile("/usr/local/bin/verify-source-identity.sh", string(verifier), dagger.ContainerWithNewFileOpts{Permissions: 0755}).
		WithDirectory("/src", source).
		WithWorkdir("/src").
		WithExec([]string{"/usr/local/bin/verify-source-identity.sh", revision, "/verified"})
	committedSource, err := container.Directory("/verified").Sync(ctx)
	if err != nil {
		return nil, fmt.Errorf("verify appliance source against its committed tree: %w", err)
	}
	return committedSource, nil
}

// Builds the exact-source appliance with Dagger Dockerfile compatibility and
// verifies its package labels and direct runtime commands. Native Podman/krun,
// Apptainer, and SIF behavior remain separate host profiles.
func (m *ReviewCi) Appliance(ctx context.Context, source *dagger.Directory, revision string) (string, error) {
	image, version, imageID, err := m.applianceImage(ctx, source, revision)
	if err != nil {
		return "", err
	}
	ompVersion, err := image.WithExec([]string{"/usr/bin/omp", "--version"}).Stdout(ctx)
	if err != nil {
		return "", fmt.Errorf("built appliance OMP version probe failed: %w", err)
	}
	launcherHelp, err := image.WithExec([]string{"/usr/bin/review-appliance", "--help"}).Stdout(ctx)
	if err != nil {
		return "", fmt.Errorf("built appliance launcher help probe failed: %w", err)
	}
	return fmt.Sprintf("appliance build passed: version=%s revision=%s omp=%s container-id=%s launcher-help-bytes=%d", version, revision, strings.TrimSpace(ompVersion), imageID, len(launcherHelp)), nil
}

// Exports the verified exact-source appliance as an OCI archive for native
// host adapters. The archive is an ephemeral verification artifact, not a
// published image or release asset.
func (m *ReviewCi) ApplianceArchive(ctx context.Context, source *dagger.Directory, revision string) (*dagger.File, error) {
	image, _, _, err := m.applianceImage(ctx, source, revision)
	if err != nil {
		return nil, err
	}
	return image.AsTarball(dagger.ContainerAsTarballOpts{MediaTypes: dagger.ImageMediaTypesOci}).WithName("review-appliance-" + revision + ".oci.tar"), nil
}

// Executes the checked-in suite selected by name. Unknown and empty profiles
// fail closed rather than producing a vacuous green result.
func (m *ReviewCi) Check(ctx context.Context, source *dagger.Directory, profile string) (string, error) {
	manifest, err := source.File("ci/suites.json").Contents(ctx)
	if err != nil {
		return "", fmt.Errorf("read ci/suites.json: %w", err)
	}
	var suites struct {
		Profiles map[string][]string `json:"profiles"`
	}
	if err := json.Unmarshal([]byte(manifest), &suites); err != nil {
		return "", fmt.Errorf("parse ci/suites.json: %w", err)
	}
	steps, ok := suites.Profiles[profile]
	if !ok || len(steps) == 0 {
		return "", fmt.Errorf("unknown or empty CI profile %q", profile)
	}
	if required, ok := requiredProfiles[profile]; !ok || !reflect.DeepEqual(steps, required) {
		return "", fmt.Errorf("profile %q does not match the verifier-owned required suite; update .dagger/main.go and ci/suites.json together", profile)
	}
	commands := make([]string, 0, len(steps))
	for _, step := range steps {
		command, ok := supportedSteps[step]
		if !ok {
			return "", fmt.Errorf("profile %q selects unsupported step %q", profile, step)
		}
		commands = append(commands, command)
	}
	return run(ctx, source, commands)
}

// Only these commands can be selected by a source-provided profile manifest.
// In particular, ci/suites.json is data and cannot inject shell text.
var supportedSteps = map[string]string{
	"ci-runner-contract":      "bash tests/ci-runner-contract.sh",
	"ci-path-plan-contract":   "python3 tests/ci_path_plan_test.py",
	"ci-registry-invocation-test": "python3 tests/ci_manifest_registry_test.py",
	"release-dispatch-guard":      "python3 tests/release-dispatch-guard.py",
	"release-request-plan":        "python3 tests/ci_release_request_plan_test.py",
	"release-request-adapter":     "python3 tests/ci_release_request_test.py",
	"agent-cli-contract":          "bash tests/ci_mcp_cli_fallback.sh",
	"precommit-acquisition-contract": "python3 tests/ci_precommit_acquire_test.py",
	"ci-shellcheck":           "shellcheck --exclude=SC1090 --exclude=SC2034 bin/ci scripts/ci/native-appliance.sh scripts/ci/check-oci-digest.sh scripts/validate-release-source.sh .dagger/install-precommit-hooks.sh tests/ci-runner-contract.sh tests/release-publication-source.sh",
	"static-hygiene":          "SKIP=check-skill-frontmatter,generate-skills,omp-review-mode,appliance-contract pre-commit run --all-files --show-diff-on-failure",
	"source-snapshot-contract": "python3 tests/ci_source_snapshot_test.py && python3 tests/ci_appliance_subject_test.py && python3 tests/ci_native_adapter_contract.py",
	"skill-frontmatter":        "bash scripts/check-skill-frontmatter.sh",
	"generate-skills":          "bash tests/generate-skills.sh",
	"test-registry":            "bash tests/test-registry.sh",
	"check-commit-message":     "bash tests/check-commit-message.sh",
	"omp-review-mode":          "bash tests/omp-review-mode.sh",
	"just-onboarding":          "bash tests/just-onboarding.sh",
	"appliance-contract":       "bash tests/appliance-contract.sh",
	"package-review-contract":  "python3 tests/package_review_contract.py",
	"release-version":           "python3 tests/release_version_test.py && bash tests/release-publication-source.sh",
	"review-changelog":           "PATH=/opt/review-ci-tools:$PATH python3 tests/review_changelog_test.py",
	"package-oci-contract":     "python3 tests/package_oci_contract.py",
	"appliance-sbom-contract":  "python3 tests/appliance_sbom_contract.py",
	"version-derivation":       "bash tests/version-derivation.sh",
	"update-omp-pins":          "node --test tests/update-omp-pins.test.mjs",
	"qualify-omp-upgrade-tests": "node --test tests/qualify-omp-upgrade.test.mjs",
	"update-derived-pins":      "node --test tests/update-derived-pins.test.mjs",
	"luna-factory":             "node --test tests/luna_factory.test.ts",
	"luna-dogfood-contract":    "node --test --disable-warning=MODULE_TYPELESS_PACKAGE_JSON tests/luna_factory_dogfood_contract.test.ts",
	"sdk-types":                "OMP_SDK_NODE_MODULES=/opt/review-sdk/node_modules bash scripts/ci/run-sdk-type-checks.sh",
	"omp-source-regressions":   "OMP_SDK_NODE_MODULES=/opt/review-sdk/node_modules REVIEW_OMP_SOURCE=/opt/review-omp-source bash scripts/ci/run-omp-source-regressions.sh",
	"renovate-config":          "@renovate-validator",
}

var requiredProfiles = map[string][]string{
	"contract": {"check-commit-message", "just-onboarding", "ci-runner-contract", "ci-path-plan-contract", "source-snapshot-contract", "ci-registry-invocation-test", "ci-shellcheck", "agent-cli-contract", "precommit-acquisition-contract", "static-hygiene"},
	"portable": {"static-hygiene", "skill-frontmatter", "generate-skills", "test-registry", "check-commit-message", "release-dispatch-guard", "release-request-plan", "release-request-adapter", "ci-path-plan-contract", "source-snapshot-contract", "omp-review-mode", "agent-cli-contract", "precommit-acquisition-contract", "just-onboarding", "appliance-contract", "package-review-contract", "release-version", "review-changelog", "package-oci-contract", "appliance-sbom-contract", "version-derivation", "update-omp-pins", "qualify-omp-upgrade-tests", "update-derived-pins", "luna-factory", "luna-dogfood-contract", "sdk-types", "omp-source-regressions", "renovate-config"},
}

func run(ctx context.Context, source *dagger.Directory, commands []string) (string, error) {
	preCommitInstaller, err := preCommitHookInstaller.ReadFile("install-precommit-hooks.sh")
	if err != nil {
		return "", fmt.Errorf("read trusted pre-commit hook installer: %w", err)
	}
	nodeImage := dag.Container().From("node:26.13.0-bookworm-slim@sha256:bc0a2afd3b74ce12222fc8bab99271e66257f021078f5f4a5d687a77d280c1d9")
	container := dag.Container().
		From("python:3.13.9-slim-bookworm@sha256:b685a4fa58bb19d1814d78a1ec0f0208f351452724f78b20212c984d6e124a34").
		WithFile("/usr/local/bin/node", nodeImage.File("/usr/local/bin/node")).
		WithDirectory("/usr/local/lib/node_modules/npm", nodeImage.Directory("/usr/local/lib/node_modules/npm")).
		WithExec([]string{"sh", "-c", "ln -sf /usr/local/lib/node_modules/npm/bin/npm-cli.js /usr/local/bin/npm && ln -sf /usr/local/lib/node_modules/npm/bin/npx-cli.js /usr/local/bin/npx"}).
		WithExec([]string{"sh", "-c", "set -eu; apt-get update; apt-get install -y --no-install-recommends bash=5.2.15-2+b13 git=1:2.39.5-0+deb12u3 ca-certificates=20250419~deb12u2 curl=7.88.1-10+deb12u15 jq=1.6-2.1+deb12u3 shellcheck=0.9.0-1 libatomic1=12.2.0-14+deb12u1; useradd -m -u 1000 -s /bin/bash node; rm -rf /var/lib/apt/lists/*; arch=\"$(dpkg --print-architecture)\"; case \"$arch\" in amd64) asset=just-1.52.0-x86_64-unknown-linux-musl.tar.gz; sha=e0a712614574d45625332529c864754e26782422b7c7db931466180a618f092d ;; arm64) asset=just-1.52.0-aarch64-unknown-linux-musl.tar.gz; sha=41af45372c49c404ca7b9a318ae9de5564636e39c6520cc4d42bf678f3bfb1bc ;; *) echo \"unsupported architecture: $arch\" >&2; exit 2 ;; esac; curl -fsSLo /tmp/just.tgz https://github.com/casey/just/releases/download/1.52.0/$asset; echo \"$sha  /tmp/just.tgz\" | sha256sum -c -; tar -xzf /tmp/just.tgz -C /usr/local/bin just; rm -f /tmp/just.tgz; test \"$(node --version)\" = v26.13.0; test \"$(python3 --version)\" = 'Python 3.13.9'; test \"$(git --version)\" = 'git version 2.39.5'; test \"$(jq --version)\" = jq-1.6; test \"$(shellcheck --version | sed -n 's/.*version: //p')\" = 0.9.0; just --version"}).
		WithEnvVariable("PRE_COMMIT_HOME", "/opt/review-pre-commit").
		WithFile("/tooling/requirements-ci.lock", source.File("requirements-ci.lock")).
		WithFile("/tooling/.pre-commit-config.yaml", source.File(".pre-commit-config.yaml")).
		WithWorkdir("/tooling").
		WithNewFile("/tooling/install-precommit-hooks.sh", string(preCommitInstaller), dagger.ContainerWithNewFileOpts{Permissions: 0755}).
		WithExec([]string{"bash", "-lc", "git init -q --initial-branch=main /tooling && python3 -m pip install --require-hashes --no-warn-script-location -r requirements-ci.lock && bash /tooling/install-precommit-hooks.sh /tooling/.pre-commit-config.yaml"}).
		WithExec([]string{"chown", "-R", "node:node", "/opt/review-pre-commit"}).
		WithExec([]string{"mkdir", "-p", "/opt/review-sdk"}).
		WithFile("/opt/review-sdk/package.json", source.File("ci/sdk-types/package.json")).
		WithFile("/opt/review-sdk/package-lock.json", source.File("ci/sdk-types/package-lock.json")).
		WithFile("/opt/review-sdk/toolchains.json", source.File("ci/toolchains.json")).
		WithWorkdir("/opt/review-sdk").
		WithExec([]string{"bash", "-lc", "expected_npm=\"$(node -p 'require(\"./toolchains.json\").verification.sdkLockGeneratorNpm')\"; test \"$(npm --version)\" = \"$expected_npm\"; npm ci --ignore-scripts --no-audit --no-fund"}).
		WithWorkdir("/tooling").
		WithFile("/tooling/install-git-cliff.sh", source.File("scripts/install-git-cliff.sh")).
		WithFile("/tooling/ci/toolchains.json", source.File("ci/toolchains.json")).
		WithExec([]string{"bash", "/tooling/install-git-cliff.sh", "/opt/review-ci-tools"}).
		WithFile("/tooling/Containerfile", source.File("image/appliance/Containerfile")).
		WithExec([]string{"bash", "-lc", "omp_version=\"$(sed -n 's/^ARG OMP_VERSION=//p' /tooling/Containerfile)\"; omp_commit=\"$(sed -n 's/^ARG OMP_SOURCE_COMMIT=//p' /tooling/Containerfile)\"; test -n \"$omp_version\" && test -n \"$omp_commit\"; git clone --quiet --depth 1 --branch \"v${omp_version}\" https://github.com/can1357/oh-my-pi.git /opt/review-omp-source; test \"$(git -C /opt/review-omp-source rev-parse HEAD)\" = \"$omp_commit\"; chown -R node:node /opt/review-omp-source"}).
		WithDirectory("/src", source).
		WithExec([]string{"chown", "-R", "node:node", "/src"}).
		WithUser("node").
		WithWorkdir("/src").
		WithExec([]string{"bash", "-lc", "if [ -f .ci-history.bundle ]; then git clone -q --bare .ci-history.bundle .git && git --git-dir=.git config core.bare false && git --git-dir=.git config core.worktree /src && git reset --mixed HEAD >/dev/null && rm .ci-history.bundle && git add -A && if [ -d .agents/skills/review-ci ]; then git add -f .agents/skills/review-ci; fi; fi"})
	var extraOutput strings.Builder
	for _, command := range commands {
		if command == "@renovate-validator" {
			output, err := runRenovate(ctx, source)
			if err != nil {
				return output, err
			}
			extraOutput.WriteString(output)
			continue
		}
		container = container.WithExec([]string{"bash", "-lc", "set -euo pipefail; " + command})
	}
	output, err := container.Stdout(ctx)
	if err != nil {
		return output, fmt.Errorf("verification failed: %w\n%s", err, strings.TrimSpace(output))
	}
	return extraOutput.String() + output, nil
}

func runRenovate(ctx context.Context, source *dagger.Directory) (string, error) {
	toolchainsJSON, err := source.File("ci/toolchains.json").Contents(ctx)
	if err != nil {
		return "", fmt.Errorf("read ci/toolchains.json: %w", err)
	}
	var toolchains struct {
		Verification struct {
			RenovateNodeImage string `json:"renovateNodeImage"`
			Renovate          string `json:"renovate"`
			RenovateRe2       string `json:"renovateRe2"`
		} `json:"verification"`
	}
	if err := json.Unmarshal([]byte(toolchainsJSON), &toolchains); err != nil {
		return "", fmt.Errorf("parse ci/toolchains.json: %w", err)
	}
	if toolchains.Verification.RenovateNodeImage != "node:24.15.0-bookworm-slim@sha256:4e6b70dd6cbfc88c8157ba19aa3d9f9cce6ba4703576d55459e45efcbc9c5f5d" || toolchains.Verification.Renovate != "44.181.2" || toolchains.Verification.RenovateRe2 != "1.27.0" {
		return "", fmt.Errorf("Renovate toolchain pins do not match the reviewed runner contract")
	}
	return dag.Container().
		From(toolchains.Verification.RenovateNodeImage).
		WithFile("/tooling/package.json", source.File("ci/renovate-validator/package.json")).
		WithFile("/tooling/package-lock.json", source.File("ci/renovate-validator/package-lock.json")).
		WithWorkdir("/tooling").
		WithExec([]string{"npm", "ci", "--no-audit", "--no-fund"}).
		WithEnvVariable("RENOVATE_NODE_MODULES", "/tooling/node_modules").
		WithDirectory("/src", source).
		WithWorkdir("/src").
		WithExec([]string{"bash", "scripts/ci/run-renovate-validator.sh"}).
		Stdout(ctx)
}
