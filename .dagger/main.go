// Review CI runs repository verification in a pinned Dagger engine.
package main

import (
	"context"
	"encoding/json"
	"fmt"
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

func run(ctx context.Context, source *dagger.Directory, commands []string) (string, error) {
	container := dag.Container().
		From("node:26.13.0-bookworm-slim").
		WithExec([]string{"bash", "-lc", "set -euo pipefail; apt-get update; apt-get install -y --no-install-recommends bash python3 git ca-certificates curl; rm -rf /var/lib/apt/lists/*; arch=\"$(dpkg --print-architecture)\"; case \"$arch\" in amd64) asset=just-1.52.0-x86_64-unknown-linux-musl.tar.gz; sha=e0a712614574d45625332529c864754e26782422b7c7db931466180a618f092d ;; arm64) asset=just-1.52.0-aarch64-unknown-linux-musl.tar.gz; sha=41af45372c49c404ca7b9a318ae9de5564636e39c6520cc4d42bf678f3bfb1bc ;; *) echo \"unsupported architecture: $arch\" >&2; exit 2 ;; esac; curl -fsSLo /tmp/just.tgz https://github.com/casey/just/releases/download/1.52.0/$asset; echo \"$sha  /tmp/just.tgz\" | sha256sum -c -; tar -xzf /tmp/just.tgz -C /usr/local/bin just; rm -f /tmp/just.tgz"}).
		WithDirectory("/src", source).
		WithExec([]string{"chown", "-R", "node:node", "/src"}).
		WithUser("node").
		WithWorkdir("/src")
	for _, command := range commands {
		container = container.WithExec([]string{"bash", "-lc", "set -euo pipefail; " + command})
	}
	output, err := container.Stdout(ctx)
	if err != nil {
		return output, fmt.Errorf("verification failed: %w\n%s", err, strings.TrimSpace(output))
	}
	return output, nil
}
