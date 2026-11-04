package main

import (
	"fmt"
	"regexp"
)

var conventionalPRTitle = regexp.MustCompile(`^(?:feat|fix|chore|docs|style|refactor|perf|test|ci|build|revert)(?:\([^\r\n()]+\))?!?: [^\r\n]*\S[^\r\n]*\z`)

// Validates a Conventional Commit pull request title without executing it.
func (m *ReviewCi) PrTitle(title string) (string, error) {
	if !conventionalPRTitle.MatchString(title) {
		return "", fmt.Errorf("pull request title must use an allowed Conventional Commit type and a non-empty single-line subject")
	}
	return "Conventional Commit title accepted", nil
}
