package review

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"
	"unicode/utf8"
)

const (
	DefaultRuntimeTimeout     = 5 * time.Second
	DefaultRuntimeOutputBytes = 120_000
	DefaultRuntimeItems       = 100
)

// RuntimeLimits bound every read-only adapter call.
type RuntimeLimits struct {
	Timeout        time.Duration
	MaxOutputBytes int
	MaxItems       int
}

func (limits RuntimeLimits) normalized() RuntimeLimits {
	if limits.Timeout <= 0 {
		limits.Timeout = DefaultRuntimeTimeout
	}
	if limits.MaxOutputBytes <= 0 || limits.MaxOutputBytes > MaxRawChars {
		limits.MaxOutputBytes = DefaultRuntimeOutputBytes
	}
	if limits.MaxItems <= 0 || limits.MaxItems > DefaultRuntimeItems {
		limits.MaxItems = DefaultRuntimeItems
	}
	return limits
}

func runtimeContext(ctx context.Context, limits RuntimeLimits) (context.Context, context.CancelFunc) {
	if ctx == nil {
		ctx = context.Background()
	}
	return context.WithTimeout(ctx, limits.normalized().Timeout)
}

func boundedRuntimeBytes(value []byte, limit int) ([]byte, bool) {
	if limit <= 0 || len(value) <= limit {
		return append([]byte(nil), value...), false
	}
	clipped := append([]byte(nil), value[:limit]...)
	for len(clipped) > 0 && !utf8.Valid(clipped) {
		clipped = clipped[:len(clipped)-1]
	}
	return clipped, true
}

func boundedRuntimeText(value string, limit int) (string, bool) {
	clipped, truncated := boundedRuntimeBytes([]byte(value), limit)
	return string(clipped), truncated
}

type CapabilityRecord struct {
	Name        string
	ReadOnly    bool
	Network     bool
	Process     bool
	Mutation    bool
	Description string
}

type AdapterProvenance struct {
	Adapter      string
	Source       string
	Baseline     string
	ReadOnly     bool
	Capabilities []string
}

func githubCapability() CapabilityRecord {
	return CapabilityRecord{
		Name: "github-read-only", ReadOnly: true, Network: true,
		Description: "pull-request metadata only; no GitHub mutation methods",
	}
}

func codexCapability() CapabilityRecord {
	return CapabilityRecord{
		Name: "codex-read-only", ReadOnly: true, Process: false,
		Description: "bounded review output supplied by an injected read-only client",
	}
}

type GitHubPullRequest struct {
	ID         string
	Repository string
	Number     int
	HeadSHA    string
	Title      string
	Author     string
}

type GitHubReadRequest struct {
	Repository string
	Limit      int
}

type GitHubReadOnlyClient interface {
	ListPullRequests(context.Context, GitHubReadRequest) ([]GitHubPullRequest, error)
}

type GitHubReadSnapshot struct {
	PullRequests []GitHubPullRequest
	Truncated    bool
	Provenance   AdapterProvenance
	Capability   CapabilityRecord
}

// GitHubReadOnlyAdapter constrains an injected client to bounded list reads.
type GitHubReadOnlyAdapter struct {
	Client   GitHubReadOnlyClient
	Limits   RuntimeLimits
	Source   string
	Baseline string
}

func (adapter GitHubReadOnlyAdapter) List(ctx context.Context, request GitHubReadRequest) (GitHubReadSnapshot, error) {
	if adapter.Client == nil {
		return GitHubReadSnapshot{}, errors.New("github read-only client is required")
	}
	limits := adapter.Limits.normalized()
	if request.Limit <= 0 || request.Limit > limits.MaxItems {
		request.Limit = limits.MaxItems
	}
	callContext, cancel := runtimeContext(ctx, limits)
	defer cancel()
	items, err := adapter.Client.ListPullRequests(callContext, request)
	if err != nil {
		return GitHubReadSnapshot{}, err
	}
	if err := callContext.Err(); err != nil {
		return GitHubReadSnapshot{}, err
	}
	truncated := len(items) > request.Limit
	if truncated {
		items = items[:request.Limit]
	}
	bounded := make([]GitHubPullRequest, len(items))
	for index, item := range items {
		bounded[index] = item
		bounded[index].ID, _ = boundedRuntimeText(item.ID, limits.MaxOutputBytes)
		bounded[index].Repository, _ = boundedRuntimeText(item.Repository, limits.MaxOutputBytes)
		bounded[index].HeadSHA, _ = boundedRuntimeText(item.HeadSHA, limits.MaxOutputBytes)
		bounded[index].Title, _ = boundedRuntimeText(item.Title, limits.MaxOutputBytes)
		bounded[index].Author, _ = boundedRuntimeText(item.Author, limits.MaxOutputBytes)
	}
	return GitHubReadSnapshot{
		PullRequests: bounded,
		Truncated:    truncated,
		Capability:   githubCapability(),
		Provenance: AdapterProvenance{
			Adapter: "github-read-only", Source: adapter.Source,
			Baseline: adapter.Baseline, ReadOnly: true,
			Capabilities: []string{"pull-request-list", "pull-request-metadata"},
		},
	}, nil
}

type CodexReviewRequest struct {
	ReviewID    string
	Repository  string
	PullRequest int
	Prompt      string
}

type CodexReviewOutput struct {
	Payload     string
	RawEvidence []string
}

type CodexReadOnlyClient interface {
	Review(context.Context, CodexReviewRequest) (CodexReviewOutput, error)
}

type CodexReadResult struct {
	Result     ReviewResult
	Truncated  bool
	Provenance AdapterProvenance
	Capability CapabilityRecord
}

// CodexReadOnlyAdapter parses only bounded output from an injected client.
type CodexReadOnlyAdapter struct {
	Client   CodexReadOnlyClient
	Limits   RuntimeLimits
	Source   string
	Baseline string
}

func (adapter CodexReadOnlyAdapter) Review(ctx context.Context, request CodexReviewRequest) (CodexReadResult, error) {
	if adapter.Client == nil {
		return CodexReadResult{}, errors.New("codex read-only client is required")
	}
	limits := adapter.Limits.normalized()
	callContext, cancel := runtimeContext(ctx, limits)
	defer cancel()
	output, err := adapter.Client.Review(callContext, request)
	if err != nil {
		return CodexReadResult{}, err
	}
	if err := callContext.Err(); err != nil {
		return CodexReadResult{}, err
	}
	payload, payloadTruncated := boundedRuntimeText(output.Payload, limits.MaxOutputBytes)
	rawEvidence := make([]string, 0, len(output.RawEvidence))
	rawTruncated := false
	for _, line := range output.RawEvidence {
		bounded, truncated := boundedRuntimeText(line, limits.MaxOutputBytes)
		rawEvidence = append(rawEvidence, bounded)
		rawTruncated = rawTruncated || truncated
	}
	result := ParseReviewResult(payload, rawEvidence)
	return CodexReadResult{
		Result: result, Truncated: payloadTruncated || rawTruncated,
		Capability: codexCapability(),
		Provenance: AdapterProvenance{
			Adapter: "codex-read-only", Source: adapter.Source,
			Baseline: adapter.Baseline, ReadOnly: true,
			Capabilities: []string{"review-result"},
		},
	}, nil
}

type RuntimeReview struct {
	ID          string
	Repository  string
	PullRequest int
	HeadSHA     string
	Title       string
	Author      string
	Result      ReviewResult
	Provenance  []AdapterProvenance
}

type RuntimeSnapshot struct {
	Reviews      []RuntimeReview
	Truncated    bool
	Capabilities []CapabilityRecord
	Provenance   []AdapterProvenance
}

type RuntimeSource interface {
	Snapshot(context.Context) (RuntimeSnapshot, error)
}

type StaticRuntimeSource struct {
	Value RuntimeSnapshot
}

func (source StaticRuntimeSource) Snapshot(ctx context.Context) (RuntimeSnapshot, error) {
	if ctx != nil {
		select {
		case <-ctx.Done():
			return RuntimeSnapshot{}, ctx.Err()
		default:
		}
	}
	return cloneRuntimeSnapshot(source.Value), nil
}

// AdapterRuntimeSource joins read-only pull-request metadata to read-only
// review output without creating a network, process, or mutation path.
type AdapterRuntimeSource struct {
	GitHub  GitHubReadOnlyAdapter
	Codex   CodexReadOnlyAdapter
	Request GitHubReadRequest
}

func (source AdapterRuntimeSource) Snapshot(ctx context.Context) (RuntimeSnapshot, error) {
	github, err := source.GitHub.List(ctx, source.Request)
	if err != nil {
		return RuntimeSnapshot{}, err
	}
	snapshot := RuntimeSnapshot{
		Truncated:    github.Truncated,
		Capabilities: []CapabilityRecord{github.Capability},
		Provenance:   []AdapterProvenance{github.Provenance},
	}
	for _, pullRequest := range github.PullRequests {
		id := pullRequest.ID
		if id == "" {
			id = fmt.Sprintf("%s#%d", pullRequest.Repository, pullRequest.Number)
		}
		codex, err := source.Codex.Review(ctx, CodexReviewRequest{
			ReviewID: id, Repository: pullRequest.Repository,
			PullRequest: pullRequest.Number,
		})
		if err != nil {
			return RuntimeSnapshot{}, err
		}
		snapshot.Truncated = snapshot.Truncated || codex.Truncated
		snapshot.Capabilities = appendUniqueCapability(snapshot.Capabilities, codex.Capability)
		snapshot.Provenance = append(snapshot.Provenance, codex.Provenance)
		snapshot.Reviews = append(snapshot.Reviews, RuntimeReview{
			ID: id, Repository: pullRequest.Repository, PullRequest: pullRequest.Number,
			HeadSHA: pullRequest.HeadSHA, Title: pullRequest.Title, Author: pullRequest.Author,
			Result: codex.Result, Provenance: []AdapterProvenance{github.Provenance, codex.Provenance},
		})
	}
	return snapshot, nil
}

type ReviewRuntime struct {
	source RuntimeSource
	limits RuntimeLimits
}

func NewReviewRuntime(source RuntimeSource, limits RuntimeLimits) (*ReviewRuntime, error) {
	if source == nil {
		return nil, errors.New("runtime source is required")
	}
	return &ReviewRuntime{source: source, limits: limits.normalized()}, nil
}

func (runtime *ReviewRuntime) Snapshot(ctx context.Context) (RuntimeSnapshot, error) {
	if runtime == nil || runtime.source == nil {
		return RuntimeSnapshot{}, errors.New("runtime source is required")
	}
	callContext, cancel := runtimeContext(ctx, runtime.limits)
	defer cancel()
	snapshot, err := runtime.source.Snapshot(callContext)
	if err != nil {
		return RuntimeSnapshot{}, err
	}
	if err := callContext.Err(); err != nil {
		return RuntimeSnapshot{}, err
	}
	if len(snapshot.Reviews) > runtime.limits.MaxItems {
		snapshot.Reviews = snapshot.Reviews[:runtime.limits.MaxItems]
		snapshot.Truncated = true
	}
	return cloneRuntimeSnapshot(snapshot), nil
}

func (runtime *ReviewRuntime) List(ctx context.Context, limit int) (RuntimeSnapshot, error) {
	snapshot, err := runtime.Snapshot(ctx)
	if err != nil {
		return RuntimeSnapshot{}, err
	}
	if limit > 0 && len(snapshot.Reviews) > limit {
		snapshot.Reviews = snapshot.Reviews[:limit]
		snapshot.Truncated = true
	}
	return snapshot, nil
}

func (runtime *ReviewRuntime) Get(ctx context.Context, id string) (RuntimeReview, error) {
	if strings.TrimSpace(id) == "" {
		return RuntimeReview{}, errors.New("review ID is required")
	}
	snapshot, err := runtime.Snapshot(ctx)
	if err != nil {
		return RuntimeReview{}, err
	}
	for _, item := range snapshot.Reviews {
		if item.ID == id {
			return item, nil
		}
	}
	return RuntimeReview{}, fmt.Errorf("review %q was not found", id)
}

func (runtime *ReviewRuntime) Preview(ctx context.Context, id string, decision CockpitDecision) (DryRunPreview, error) {
	item, err := runtime.Get(ctx, id)
	if err != nil {
		return DryRunPreview{}, err
	}
	cockpitReview := CockpitReview{
		ID: item.ID, Repository: item.Repository, PullRequest: item.PullRequest,
		HeadSHA: item.HeadSHA, Title: item.Title,
		State: item.Result.State, IsClean: item.Result.IsClean(),
		Actor: "maintainer", Tenant: "local",
	}
	plan, err := BuildCockpitActionPlan(cockpitReview, decision, time.Unix(0, 0).UTC())
	if err != nil {
		return DryRunPreview{}, err
	}
	prerequisites, err := NewPrerequisites(
		map[string]any{"review": "human-confirmation"},
		map[string]any{"head_sha": item.HeadSHA},
	)
	if err != nil {
		return DryRunPreview{}, err
	}
	current, err := NewCurrentState(
		"maintainer", "local", item.Repository, item.PullRequest, item.HeadSHA,
		nil, prerequisites,
	)
	if err != nil {
		return DryRunPreview{}, err
	}
	return PreviewActionPlan(plan, current, time.Unix(60, 0).UTC())
}

type FakeGitHubReadClient struct {
	PullRequests []GitHubPullRequest
}

func (client FakeGitHubReadClient) ListPullRequests(ctx context.Context, _ GitHubReadRequest) ([]GitHubPullRequest, error) {
	if ctx != nil {
		select {
		case <-ctx.Done():
			return nil, ctx.Err()
		default:
		}
	}
	return append([]GitHubPullRequest(nil), client.PullRequests...), nil
}

type FakeCodexReadClient struct {
	Output CodexReviewOutput
}

func (client FakeCodexReadClient) Review(ctx context.Context, _ CodexReviewRequest) (CodexReviewOutput, error) {
	if ctx != nil {
		select {
		case <-ctx.Done():
			return CodexReviewOutput{}, ctx.Err()
		default:
		}
	}
	return CodexReviewOutput{
		Payload:     client.Output.Payload,
		RawEvidence: append([]string(nil), client.Output.RawEvidence...),
	}, nil
}

func appendUniqueCapability(records []CapabilityRecord, value CapabilityRecord) []CapabilityRecord {
	for _, record := range records {
		if record.Name == value.Name {
			return records
		}
	}
	return append(records, value)
}

func cloneRuntimeSnapshot(snapshot RuntimeSnapshot) RuntimeSnapshot {
	cloned := RuntimeSnapshot{
		Truncated:    snapshot.Truncated,
		Capabilities: append([]CapabilityRecord(nil), snapshot.Capabilities...),
		Provenance:   append([]AdapterProvenance(nil), snapshot.Provenance...),
	}
	for _, item := range snapshot.Reviews {
		result := cloneReviewResult(item.Result)
		cloned.Reviews = append(cloned.Reviews, RuntimeReview{
			ID: item.ID, Repository: item.Repository, PullRequest: item.PullRequest,
			HeadSHA: item.HeadSHA, Title: item.Title, Author: item.Author,
			Result: result, Provenance: append([]AdapterProvenance(nil), item.Provenance...),
		})
	}
	return cloned
}

func cloneReviewResult(result ReviewResult) ReviewResult {
	encoded, err := json.Marshal(result)
	if err != nil {
		return result
	}
	var decoded map[string]any
	decoder := json.NewDecoder(strings.NewReader(string(encoded)))
	decoder.UseNumber()
	if err := decoder.Decode(&decoded); err != nil {
		return result
	}
	return FromMap(decoded)
}
