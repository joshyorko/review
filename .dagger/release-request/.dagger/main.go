// Credential-free release request planning on an exact source and Git history snapshot.
package main

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"

	"dagger/release-request/internal/dagger"
)

type ReviewReleaseRequest struct{}

type toolchains struct {
	Verification struct {
		PythonImage string `json:"pythonImage"`
	} `json:"verification"`
}

// Plans VERSION and CHANGELOG.md from the exact source snapshot, bundled Git
// history, and a read-only GitHub release/tag observation. The returned JSON
// is data; this function has no credentials and performs no repository writes.
func (m *ReviewReleaseRequest) ReleasePlan(
	ctx context.Context,
	source *dagger.Directory,
	requestedVersion string,
	knownTagsJSON string,
	publishedReleasesJSON string,
	sourceSha string,
) (string, error) {
	var pins toolchains
	toolchainsJSON, err := source.File("ci/toolchains.json").Contents(ctx)
	if err != nil {
		return "", fmt.Errorf("read CI toolchain pins: %w", err)
	}
	if err := json.Unmarshal([]byte(toolchainsJSON), &pins); err != nil {
		return "", fmt.Errorf("parse CI toolchain pins: %w", err)
	}
	if pins.Verification.PythonImage == "" || !strings.Contains(pins.Verification.PythonImage, "@sha256:") {
		return "", fmt.Errorf("ci/toolchains.json must pin the Python verification image by digest")
	}
	inputs := dag.Directory().
		WithNewFile("known-tags.json", knownTagsJSON).
		WithNewFile("published-releases.json", publishedReleasesJSON)
	container := dag.Container().
		From(pins.Verification.PythonImage).
		WithExec([]string{"apt-get", "update"}).
		WithExec([]string{"apt-get", "install", "-y", "--no-install-recommends", "git", "ca-certificates", "bash", "curl", "tar"}).
		WithMountedDirectory("/source", source).
		WithMountedDirectory("/inputs", inputs).
		WithWorkdir("/source").
		WithExec([]string{"bash", "scripts/install-git-cliff.sh", "/tmp/review-git-cliff"}).
		WithEnvVariable("PATH", "/tmp/review-git-cliff:/usr/local/bin:/usr/local/sbin:/usr/bin:/usr/sbin:/bin:/sbin").
		WithExec([]string{
			"python3", "scripts/ci/release-request-plan.py",
			"--source", "/source",
			"--bundle", "/source/.ci-history.bundle",
			"--requested-version", requestedVersion,
			"--published-releases-file", "/inputs/published-releases.json",
			"--known-tags-file", "/inputs/known-tags.json",
			"--source-sha", sourceSha,
		})
	return container.Stdout(ctx)
}
