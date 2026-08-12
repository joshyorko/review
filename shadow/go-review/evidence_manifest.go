package review

import (
	"encoding/json"
	"fmt"
	"unicode/utf8"
)

const (
	maxManifestSummary    = 4096
	maxManifestText       = 4096
	maxManifestHandle     = 2048
	maxManifestIdentity   = 256
	maxGeneratedAt        = 128
	maxManifestKind       = 256
	maxManifestProvenance = 256
	maxManifestEntries    = 128
	maxEntryHandles       = 32
)

type TrustClass string

const (
	TrustVerified   TrustClass = "verified"
	TrustRepository TrustClass = "repository"
	TrustUntrusted  TrustClass = "untrusted"
)

type Availability string

const (
	AvailabilityAvailable Availability = "available"
	AvailabilityInvalid   Availability = "invalid"
	AvailabilityTruncated Availability = "truncated"
	AvailabilityStale     Availability = "stale"
	AvailabilityOmitted   Availability = "omitted"
)

type EvidencePhase string

const (
	EvidenceSnapshot EvidencePhase = "exact-head-snapshot"
	EvidenceLive     EvidencePhase = "live-revalidate"
)

type ReviewScope struct {
	Actor        string
	Tenant       string
	Installation string
}

func (scope ReviewScope) Validate() error {
	if err := requireManifestText(scope.Actor, maxManifestIdentity, "actor"); err != nil {
		return err
	}
	if err := requireManifestText(scope.Tenant, maxManifestIdentity, "tenant"); err != nil {
		return err
	}
	if scope.Installation != "" {
		if err := requireManifestText(scope.Installation, maxManifestIdentity, "installation"); err != nil {
			return err
		}
	}
	return nil
}

type EvidenceHandle struct {
	URI      string `json:"uri"`
	Label    string `json:"label"`
	MaxBytes int    `json:"max_bytes"`
}

func NewEvidenceHandle(uri, label string, maxBytes int) EvidenceHandle {
	if maxBytes == 0 {
		maxBytes = 4096
	}
	return EvidenceHandle{URI: uri, Label: label, MaxBytes: maxBytes}
}

func (handle EvidenceHandle) Validate() error {
	if err := requireManifestText(handle.URI, maxManifestHandle, "evidence handle URI"); err != nil {
		return err
	}
	if err := requireManifestText(handle.Label, 256, "evidence handle label"); err != nil {
		return err
	}
	if handle.MaxBytes < 1 || handle.MaxBytes > 1024*1024 {
		return fmt.Errorf("evidence handle bound is invalid")
	}
	return nil
}

type EvidenceEntry struct {
	Kind          string
	Provenance    string
	Trust         TrustClass
	Availability  Availability
	Phase         EvidencePhase
	Summary       string
	Handles       []EvidenceHandle
	UntrustedText *string
}

func (entry EvidenceEntry) Validate() error {
	switch entry.Trust {
	case TrustVerified, TrustRepository, TrustUntrusted:
	default:
		return fmt.Errorf("evidence enum value is unsupported")
	}
	switch entry.Availability {
	case AvailabilityAvailable, AvailabilityInvalid, AvailabilityTruncated, AvailabilityStale, AvailabilityOmitted:
	default:
		return fmt.Errorf("evidence enum value is unsupported")
	}
	switch entry.Phase {
	case EvidenceSnapshot, EvidenceLive:
	default:
		return fmt.Errorf("evidence enum value is unsupported")
	}
	if err := requireManifestText(entry.Kind, maxManifestKind, "evidence kind"); err != nil {
		return err
	}
	if err := requireManifestText(entry.Provenance, maxManifestProvenance, "evidence provenance"); err != nil {
		return err
	}
	if !utf8.ValidString(entry.Summary) || utf8.RuneCountInString(entry.Summary) > maxManifestSummary {
		return fmt.Errorf("evidence summary exceeds the bounded limit")
	}
	if len(entry.Handles) > maxEntryHandles {
		return fmt.Errorf("evidence handle count exceeds the bounded limit")
	}
	for _, handle := range entry.Handles {
		if err := handle.Validate(); err != nil {
			return err
		}
	}
	if entry.UntrustedText != nil {
		if !utf8.ValidString(*entry.UntrustedText) || utf8.RuneCountInString(*entry.UntrustedText) > maxManifestText {
			return fmt.Errorf("untrusted text exceeds the bounded limit")
		}
		if entry.Trust != TrustUntrusted {
			return fmt.Errorf("text supplied by a review object must be untrusted")
		}
	}
	return nil
}

type ReviewRequest struct {
	Owner             string
	Repository        string
	PullRequestNumber int
	BaseSHA           string
	HeadSHA           string
	Actor             string
	Tenant            string
	Installation      string
	GeneratedAt       string
	Focus             string
	Steering          string
	Version           int
}

func NewReviewRequest(owner, repository string, pullRequestNumber int, baseSHA, headSHA, actor, tenant, generatedAt string) ReviewRequest {
	return ReviewRequest{
		Owner: owner, Repository: repository, PullRequestNumber: pullRequestNumber,
		BaseSHA: baseSHA, HeadSHA: headSHA, Actor: actor, Tenant: tenant,
		GeneratedAt: generatedAt, Version: 1,
	}
}

func (request ReviewRequest) Validate() error {
	if err := requireManifestText(request.Owner, maxManifestIdentity, "owner"); err != nil {
		return err
	}
	if err := requireManifestText(request.Repository, maxManifestIdentity, "repository"); err != nil {
		return err
	}
	if request.PullRequestNumber < 1 {
		return fmt.Errorf("pull request number must be positive")
	}
	if !isLowerSHA(request.BaseSHA) || !isLowerSHA(request.HeadSHA) {
		return fmt.Errorf("base_sha and head_sha must be full lowercase SHA-1 values")
	}
	if err := requireManifestText(request.Actor, maxManifestIdentity, "actor"); err != nil {
		return err
	}
	if err := requireManifestText(request.Tenant, maxManifestIdentity, "tenant"); err != nil {
		return err
	}
	if err := requireManifestText(request.GeneratedAt, maxGeneratedAt, "generated_at"); err != nil {
		return err
	}
	if request.Installation != "" {
		if err := requireManifestText(request.Installation, maxManifestIdentity, "installation"); err != nil {
			return err
		}
	}
	if request.Version != 1 {
		return fmt.Errorf("unsupported review request version")
	}
	if utf8.RuneCountInString(request.Focus) > maxManifestText || utf8.RuneCountInString(request.Steering) > maxManifestText {
		return fmt.Errorf("maintainer steering exceeds the bounded limit")
	}
	return nil
}

func (request ReviewRequest) Scope() ReviewScope {
	return ReviewScope{Actor: request.Actor, Tenant: request.Tenant, Installation: request.Installation}
}

type ManifestHarness interface {
	Receive(ReviewEvidenceManifest) error
}

type ReviewEvidenceManifest struct {
	Request            ReviewRequest
	Entries            []EvidenceEntry
	OrganizationPolicy *EvidenceEntry
	Version            int
}

func NewReviewEvidenceManifest(request ReviewRequest, entries []EvidenceEntry) ReviewEvidenceManifest {
	return ReviewEvidenceManifest{Request: request, Entries: entries, Version: 1}
}

func (manifest ReviewEvidenceManifest) Validate() error {
	if manifest.Version != 1 {
		return fmt.Errorf("unsupported evidence manifest version")
	}
	if err := manifest.Request.Validate(); err != nil {
		return err
	}
	if len(manifest.Entries)+boolInt(manifest.OrganizationPolicy != nil) > maxManifestEntries {
		return fmt.Errorf("manifest entry count exceeds the bounded limit")
	}
	for _, entry := range manifest.Entries {
		if err := entry.Validate(); err != nil {
			return err
		}
	}
	if manifest.OrganizationPolicy != nil {
		if manifest.OrganizationPolicy.Kind != "organization-policy" {
			return fmt.Errorf("organization policy must use its declared evidence kind")
		}
		if err := manifest.OrganizationPolicy.Validate(); err != nil {
			return err
		}
	}
	return nil
}

func (manifest ReviewEvidenceManifest) RequireScope(scope ReviewScope) error {
	if err := scope.Validate(); err != nil {
		return err
	}
	if manifest.Request.Scope() != scope {
		return fmt.Errorf("manifest scope does not match the requesting harness")
	}
	return nil
}

func (manifest ReviewEvidenceManifest) DeliverTo(harness ManifestHarness, scope ReviewScope) error {
	if harness == nil {
		return fmt.Errorf("manifest harness is required")
	}
	if err := manifest.RequireScope(scope); err != nil {
		return err
	}
	return harness.Receive(manifest)
}

func (manifest ReviewEvidenceManifest) SemanticMap() (map[string]any, error) {
	if err := manifest.Validate(); err != nil {
		return nil, err
	}
	entries := make([]any, len(manifest.Entries))
	for index, entry := range manifest.Entries {
		encoded, err := entry.semanticMap()
		if err != nil {
			return nil, err
		}
		entries[index] = encoded
	}
	var policy any
	if manifest.OrganizationPolicy != nil {
		encoded, err := manifest.OrganizationPolicy.semanticMap()
		if err != nil {
			return nil, err
		}
		policy = encoded
	}
	return map[string]any{
		"entries":             entries,
		"organization_policy": policy,
		"request":             requestMap(manifest.Request),
		"version":             manifest.Version,
	}, nil
}

func (manifest ReviewEvidenceManifest) SemanticJSON() (string, error) {
	value, err := manifest.SemanticMap()
	if err != nil {
		return "", err
	}
	encoded, err := json.Marshal(value)
	if err != nil {
		return "", err
	}
	return string(encoded), nil
}

func requestMap(request ReviewRequest) map[string]any {
	var installation any
	if request.Installation != "" {
		installation = request.Installation
	}
	return map[string]any{
		"actor":               request.Actor,
		"base_sha":            request.BaseSHA,
		"focus":               request.Focus,
		"generated_at":        request.GeneratedAt,
		"head_sha":            request.HeadSHA,
		"installation":        installation,
		"owner":               request.Owner,
		"pull_request_number": request.PullRequestNumber,
		"repository":          request.Repository,
		"steering":            request.Steering,
		"tenant":              request.Tenant,
		"version":             request.Version,
	}
}

func (entry EvidenceEntry) semanticMap() (map[string]any, error) {
	if err := entry.Validate(); err != nil {
		return nil, err
	}
	handles := make([]any, len(entry.Handles))
	for index, handle := range entry.Handles {
		handles[index] = map[string]any{
			"label":     handle.Label,
			"max_bytes": handle.MaxBytes,
			"uri":       handle.URI,
		}
	}
	value := map[string]any{
		"availability": entry.Availability,
		"handles":      handles,
		"kind":         entry.Kind,
		"phase":        entry.Phase,
		"provenance":   entry.Provenance,
		"trust":        entry.Trust,
	}
	if entry.Trust != TrustUntrusted {
		value["summary"] = entry.Summary
	}
	return value, nil
}

func requireManifestText(value string, limit int, label string) error {
	if value == "" || !utf8.ValidString(value) || utf8.RuneCountInString(value) > limit {
		return fmt.Errorf("%s is empty or too long", label)
	}
	return nil
}

func isLowerSHA(value string) bool {
	if len(value) != 40 {
		return false
	}
	for _, character := range value {
		if character < '0' || character > '9' && character < 'a' || character > 'f' {
			return false
		}
	}
	return true
}

func boolInt(value bool) int {
	if value {
		return 1
	}
	return 0
}
