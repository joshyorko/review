package review

import (
	"context"
	"strings"
	"testing"
	"time"
)

func TestAdapterRuntimeSourceUsesReadOnlyCapabilitiesAndBoundsRows(t *testing.T) {
	payload := emptyResult(StateComplete).ToJSON()
	source := AdapterRuntimeSource{
		GitHub: GitHubReadOnlyAdapter{
			Client: FakeGitHubReadClient{PullRequests: []GitHubPullRequest{
				{ID: "one", Repository: "octo/sample", Number: 17, HeadSHA: strings.Repeat("a", 40)},
				{ID: "two", Repository: "octo/sample", Number: 18, HeadSHA: strings.Repeat("b", 40)},
			}},
			Limits: RuntimeLimits{MaxItems: 1, MaxOutputBytes: 256, Timeout: time.Second},
			Source: "fake-github",
		},
		Codex: CodexReadOnlyAdapter{
			Client: FakeCodexReadClient{Output: CodexReviewOutput{Payload: payload}},
			Limits: RuntimeLimits{MaxOutputBytes: 256, Timeout: time.Second},
			Source: "fake-codex",
		},
		Request: GitHubReadRequest{Repository: "octo/sample", Limit: 10},
	}
	runtime, err := NewReviewRuntime(source, RuntimeLimits{MaxItems: 10, Timeout: time.Second})
	if err != nil {
		t.Fatal(err)
	}
	snapshot, err := runtime.Snapshot(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if !snapshot.Truncated || len(snapshot.Reviews) != 1 {
		t.Fatalf("snapshot = %#v", snapshot)
	}
	if len(snapshot.Capabilities) != 2 ||
		!snapshot.Capabilities[0].ReadOnly || !snapshot.Capabilities[1].ReadOnly {
		t.Fatalf("capabilities = %#v", snapshot.Capabilities)
	}
	if snapshot.Reviews[0].Result.IsClean() == false {
		t.Fatal("fake clean output was not preserved")
	}
	snapshot.Reviews[0].Result.Counts["high"] = 99
	again, err := runtime.Get(context.Background(), "one")
	if err != nil {
		t.Fatal(err)
	}
	high, ok := integerValue(again.Result.Counts["high"])
	if !ok || high.Sign() != 0 {
		t.Fatal("runtime returned mutable source state")
	}
}

func TestCodexReadOnlyAdapterFailsClosedAndBoundsOutput(t *testing.T) {
	adapter := CodexReadOnlyAdapter{
		Client: FakeCodexReadClient{Output: CodexReviewOutput{
			Payload:     strings.Repeat("{", 100),
			RawEvidence: []string{strings.Repeat("e", 100)},
		}},
		Limits: RuntimeLimits{Timeout: time.Second, MaxOutputBytes: 16},
	}
	result, err := adapter.Review(context.Background(), CodexReviewRequest{ReviewID: "review-1"})
	if err != nil {
		t.Fatal(err)
	}
	if !result.Truncated || result.Result.IsClean() || result.Result.State != StateUnparsable {
		t.Fatalf("result = %#v", result)
	}
	if len(result.Result.RawEvidence) == 0 || len([]rune(result.Result.RawEvidence[0])) > 16 {
		t.Fatalf("raw evidence was not bounded: %#v", result.Result.RawEvidence)
	}
}

type blockingGitHubReadClient struct{}

func (blockingGitHubReadClient) ListPullRequests(ctx context.Context, _ GitHubReadRequest) ([]GitHubPullRequest, error) {
	<-ctx.Done()
	return nil, ctx.Err()
}

func TestReadOnlyAdapterEnforcesTimeout(t *testing.T) {
	adapter := GitHubReadOnlyAdapter{
		Client: blockingGitHubReadClient{},
		Limits: RuntimeLimits{Timeout: 5 * time.Millisecond, MaxItems: 1},
		Source: "blocking-fake",
	}
	_, err := adapter.List(context.Background(), GitHubReadRequest{})
	if err == nil || err != context.DeadlineExceeded {
		t.Fatalf("timeout error = %v", err)
	}
}
