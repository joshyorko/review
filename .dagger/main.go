// Review CI runs repository verification in a pinned Dagger engine.
package main

import (
	"context"
	"encoding/json"
	"fmt"
	"reflect"
	"strings"

	"dagger/review-ci/internal/dagger"
)

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
	"ci-registry-invocation-test": "python3 tests/ci_manifest_registry_test.py",
	"ci-shellcheck":           "shellcheck --exclude=SC1090 --exclude=SC2034 bin/ci tests/ci-runner-contract.sh",
	"static-hygiene":          "SKIP=check-skill-frontmatter,generate-skills,omp-review-mode,appliance-contract pre-commit run --all-files --show-diff-on-failure",
	"source-snapshot-contract": "python3 tests/ci_source_snapshot_test.py",
	"skill-frontmatter":        "bash scripts/check-skill-frontmatter.sh",
	"generate-skills":          "bash tests/generate-skills.sh",
	"test-registry":            "bash tests/test-registry.sh",
	"check-commit-message":     "bash tests/check-commit-message.sh",
	"omp-review-mode":          "bash tests/omp-review-mode.sh",
	"just-onboarding":          "bash tests/just-onboarding.sh",
	"appliance-contract":       "bash tests/appliance-contract.sh",
	"package-review-contract":  "python3 tests/package_review_contract.py",
	"package-oci-contract":     "python3 tests/package_oci_contract.py",
	"appliance-sbom-contract":  "python3 tests/appliance_sbom_contract.py",
	"version-derivation":       "bash tests/version-derivation.sh",
	"update-omp-pins":          "node --test tests/update-omp-pins.test.mjs",
	"update-derived-pins":      "node --test tests/update-derived-pins.test.mjs",
	"luna-factory":             "node --test tests/luna_factory.test.ts",
}

var requiredProfiles = map[string][]string{
	"contract": {"check-commit-message", "just-onboarding", "ci-runner-contract", "source-snapshot-contract", "ci-registry-invocation-test", "ci-shellcheck", "static-hygiene"},
	"portable": {"skill-frontmatter", "generate-skills", "test-registry", "check-commit-message", "omp-review-mode", "just-onboarding", "appliance-contract", "package-review-contract", "package-oci-contract", "appliance-sbom-contract", "version-derivation", "update-omp-pins", "update-derived-pins", "luna-factory", "static-hygiene"},
}

func run(ctx context.Context, source *dagger.Directory, commands []string) (string, error) {
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
		WithExec([]string{"bash", "-lc", "git init -q --initial-branch=main /tooling && python3 -m pip install --require-hashes --no-warn-script-location -r requirements-ci.lock && pre-commit install-hooks --config .pre-commit-config.yaml"}).
		WithExec([]string{"chown", "-R", "node:node", "/opt/review-pre-commit"}).
		WithDirectory("/src", source).
		WithExec([]string{"chown", "-R", "node:node", "/src"}).
		WithUser("node").
		WithWorkdir("/src").
		WithExec([]string{"bash", "-lc", "if [ -f .ci-history.bundle ]; then git clone -q --bare .ci-history.bundle .git && git --git-dir=.git config core.bare false && git --git-dir=.git config core.worktree /src && git reset --mixed HEAD >/dev/null && rm .ci-history.bundle && git add -A && if [ -d .agents/skills/review-ci ]; then git add -f .agents/skills/review-ci; fi; fi"})
	for _, command := range commands {
		container = container.WithExec([]string{"bash", "-lc", "set -euo pipefail; " + command})
	}
	output, err := container.Stdout(ctx)
	if err != nil {
		return output, fmt.Errorf("verification failed: %w\n%s", err, strings.TrimSpace(output))
	}
	return output, nil
}
