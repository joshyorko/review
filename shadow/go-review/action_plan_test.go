package review

import (
	"bytes"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

type actionPlanFixture struct {
	Name     string            `json:"name"`
	Plan     actionPlanInput   `json:"plan"`
	Current  currentStateInput `json:"current"`
	Expected struct {
		Identity string `json:"identity"`
	} `json:"expected"`
}

type actionPlanInput struct {
	Actor          string             `json:"actor"`
	Tenant         string             `json:"tenant"`
	Repository     string             `json:"repository"`
	PullRequest    int                `json:"pull_request"`
	HeadSHA        string             `json:"head_sha"`
	ActionKind     string             `json:"action_kind"`
	Body           *string            `json:"body"`
	Operations     []operationInput   `json:"operations"`
	Prerequisites  prerequisitesInput `json:"prerequisites"`
	CreatedAt      string             `json:"created_at"`
	ExpiresAt      string             `json:"expires_at"`
	IdempotencyKey string             `json:"idempotency_key"`
}

type currentStateInput struct {
	Actor         string             `json:"actor"`
	Tenant        string             `json:"tenant"`
	Repository    string             `json:"repository"`
	PullRequest   int                `json:"pull_request"`
	HeadSHA       string             `json:"head_sha"`
	Body          *string            `json:"body"`
	Prerequisites prerequisitesInput `json:"prerequisites"`
}

type operationInput struct {
	Args []string `json:"argv"`
	Body *string  `json:"body"`
}

type prerequisitesInput struct {
	Permissions map[string]any `json:"permissions"`
	Checks      map[string]any `json:"checks"`
}

func TestActionPlanFixturesMatchCanonicalIdentity(t *testing.T) {
	raw, err := os.ReadFile(filepath.Join("testdata", "action-plan-cases.json"))
	if err != nil {
		t.Fatal(err)
	}
	var fixtures []actionPlanFixture
	if err := json.Unmarshal(raw, &fixtures); err != nil {
		t.Fatal(err)
	}
	for _, fixture := range fixtures {
		t.Run(fixture.Name, func(t *testing.T) {
			plan, err := fixturePlan(t, fixture.Plan)
			if err != nil {
				t.Fatal(err)
			}
			if got := plan.Identity(); got != fixture.Expected.Identity {
				t.Fatalf("identity = %q, want %q", got, fixture.Expected.Identity)
			}
			current := fixtureCurrentState(t, fixture.Current)
			if err := plan.Revalidate(current, plan.CreatedAt.Add(time.Minute)); err != nil {
				t.Fatal(err)
			}
			preview := plan.Preview()
			if preview.PlanIdentity != plan.Identity() || len(preview.Operations) != len(plan.Operations) {
				t.Fatalf("preview does not preserve exact plan intent: %#v", preview)
			}
		})
	}
}

func TestActionPlanRequiresTypedHumanConfirmationAndExactRevalidation(t *testing.T) {
	plan := testPlan(t)
	current := testCurrentState(t)
	preview := plan.Preview()
	var forged HumanConfirmation
	if _, err := plan.ExecutionEligibility(forged, current, plan.CreatedAt.Add(time.Minute)); err == nil {
		t.Fatal("model-only confirmation was accepted")
	} else {
		var required *HumanConfirmationRequired
		if !errors.As(err, &required) {
			t.Fatalf("error = %T, want HumanConfirmationRequired", err)
		}
	}
	confirmation, err := plan.ConfirmHuman(preview, "maintainer", "octo-tenant", 17, plan.CreatedAt.Add(time.Minute))
	if err != nil {
		t.Fatal(err)
	}
	eligibility, err := plan.ExecutionEligibility(confirmation, current, plan.CreatedAt.Add(2*time.Minute))
	if err != nil {
		t.Fatal(err)
	}
	if eligibility.PlanIdentity != plan.Identity() {
		t.Fatal("eligibility was not bound to the plan identity")
	}
	drifted := current
	drifted.HeadSHA = strings.Repeat("b", 40)
	if err := plan.Revalidate(drifted, plan.CreatedAt.Add(time.Minute)); err == nil || !strings.Contains(err.Error(), "head") {
		t.Fatalf("head drift error = %v", err)
	}
	drifted = current
	drifted.Prerequisites.Checks = map[string]any{"ci": "failure"}
	if err := plan.Revalidate(drifted, plan.CreatedAt.Add(time.Minute)); err == nil || !strings.Contains(err.Error(), "checks") {
		t.Fatalf("check drift error = %v", err)
	}
}

func TestActionPlanExecutionIsDryRunBoundedAndIdempotent(t *testing.T) {
	plan := testPlan(t)
	current := testCurrentState(t)
	confirmation, err := plan.ConfirmHuman(plan.Preview(), "maintainer", "octo-tenant", 17, plan.CreatedAt.Add(time.Minute))
	if err != nil {
		t.Fatal(err)
	}
	eligibility, err := plan.ExecutionEligibility(confirmation, current, plan.CreatedAt.Add(2*time.Minute))
	if err != nil {
		t.Fatal(err)
	}
	ledger := &actionTestLedger{}
	var calls []GitHubOperation
	receipt, err := plan.Execute(
		eligibility,
		current,
		func(operation GitHubOperation) OperationResult {
			calls = append(calls, operation.Copy())
			return OperationResult{}
		},
		ledger,
		plan.CreatedAt.Add(3*time.Minute),
	)
	if err != nil {
		t.Fatal(err)
	}
	if receipt.Status != "succeeded" || receipt.AttemptedOperations != len(plan.Operations) {
		t.Fatalf("receipt = %#v", receipt)
	}
	if len(calls) != len(plan.Operations) || len(ledger.Receipts) != 1 {
		t.Fatalf("calls = %d, receipts = %d", len(calls), len(ledger.Receipts))
	}
	if _, err := plan.Execute(eligibility, current, func(GitHubOperation) int { return 0 }, ledger, plan.CreatedAt.Add(4*time.Minute)); err == nil {
		t.Fatal("idempotency replay was accepted")
	}
}

func TestActionPlanFailureStopsBeforeLaterOperationAndBoundsReceipt(t *testing.T) {
	body := "Reviewed exactly.\n"
	operationOne, err := NewGitHubOperation([]string{"gh", "pr", "review", "17", "--repo", "octo/sample", "--approve", "--body", body}, nil)
	if err != nil {
		t.Fatal(err)
	}
	operationTwo, err := NewGitHubOperation([]string{"gh", "pr", "edit", "17", "--repo", "octo/sample", "--add-label", "lgtm"}, nil)
	if err != nil {
		t.Fatal(err)
	}
	plan := buildTestPlan(t, body, []GitHubOperation{operationOne, operationTwo})
	current := testCurrentState(t)
	confirmation, err := plan.ConfirmHuman(plan.Preview(), "maintainer", "octo-tenant", 17, plan.CreatedAt.Add(time.Minute))
	if err != nil {
		t.Fatal(err)
	}
	eligibility, err := plan.ExecutionEligibility(confirmation, current, plan.CreatedAt.Add(2*time.Minute))
	if err != nil {
		t.Fatal(err)
	}
	ledger := &actionTestLedger{}
	calls := 0
	receipt, err := plan.Execute(
		eligibility,
		current,
		func(GitHubOperation) OperationResult {
			calls++
			return OperationResult{ReturnCode: 1, Detail: strings.Repeat("x", MaxReceiptDetail+100)}
		},
		ledger,
		plan.CreatedAt.Add(3*time.Minute),
	)
	if err != nil {
		t.Fatal(err)
	}
	if receipt.Status != "failed" || calls != 1 || receipt.AttemptedOperations != 1 || receipt.CompletedOperations != 0 {
		t.Fatalf("receipt = %#v, calls = %d", receipt, calls)
	}
	if len([]rune(receipt.Detail)) != MaxReceiptDetail {
		t.Fatalf("receipt detail length = %d, want %d", len([]rune(receipt.Detail)), MaxReceiptDetail)
	}
}

func TestActionPlanRejectsUnsafeOrMismatchedOperations(t *testing.T) {
	base := testPlanInput()
	cases := []struct {
		name string
		args []string
	}{
		{"wrong executable", []string{"git", "push", "--repo", "octo/sample"}},
		{"wrong repository", []string{"gh", "pr", "review", "17", "--repo", "other/sample", "--approve"}},
		{"wrong pull request", []string{"gh", "pr", "merge", "18", "--repo", "octo/sample"}},
		{"admin", []string{"gh", "pr", "merge", "17", "--repo", "octo/sample", "--admin"}},
		{"auto", []string{"gh", "pr", "merge", "17", "--repo", "octo/sample", "--auto"}},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			input := base
			input.Operations = []operationInput{{Args: testCase.args}}
			if _, err := fixturePlan(t, input); err == nil {
				t.Fatal("unsafe operation was accepted")
			}
		})
	}
}

func FuzzActionPlanValidationDoesNotPanic(f *testing.F) {
	for _, seed := range []string{"", "actor", strings.Repeat("x", 257), "é"} {
		f.Add(seed)
	}
	f.Fuzz(func(t *testing.T, value string) {
		input := testPlanInput()
		input.Actor = value
		input.Tenant = value
		input.Repository = value
		input.HeadSHA = value
		input.ActionKind = value
		_, _ = fixturePlan(t, input)
	})
}

type actionTestLedger struct {
	Claimed  map[string]bool
	Receipts []ActionReceipt
}

func (ledger *actionTestLedger) Claim(key string) bool {
	if ledger.Claimed == nil {
		ledger.Claimed = map[string]bool{}
	}
	if ledger.Claimed[key] {
		return false
	}
	ledger.Claimed[key] = true
	return true
}

func (ledger *actionTestLedger) Record(receipt ActionReceipt) {
	ledger.Receipts = append(ledger.Receipts, receipt)
}

func testPlan(t *testing.T) ActionPlan {
	t.Helper()
	return buildTestPlan(t, "Reviewed exactly.\n", nil)
}

func buildTestPlan(t *testing.T, body string, operations []GitHubOperation) ActionPlan {
	t.Helper()
	if operations == nil {
		operation, err := NewGitHubOperation([]string{"gh", "pr", "review", "17", "--repo", "octo/sample", "--approve", "--body", body}, nil)
		if err != nil {
			t.Fatal(err)
		}
		operations = []GitHubOperation{operation}
	}
	prerequisites, err := NewPrerequisites(map[string]any{"push": true}, map[string]any{"ci": "success"})
	if err != nil {
		t.Fatal(err)
	}
	plan, err := BuildActionPlan(
		"maintainer", "octo-tenant", "octo/sample", 17, strings.Repeat("a", 40),
		"review", &body, operations, prerequisites,
		time.Date(2026, 8, 11, 12, 0, 0, 0, time.UTC),
		time.Date(2026, 8, 11, 12, 10, 0, 0, time.UTC),
		"test-plan",
	)
	if err != nil {
		t.Fatal(err)
	}
	return plan
}

func testCurrentState(t *testing.T) CurrentState {
	t.Helper()
	prerequisites, err := NewPrerequisites(map[string]any{"push": true}, map[string]any{"ci": "success"})
	if err != nil {
		t.Fatal(err)
	}
	body := "Reviewed exactly.\n"
	current, err := NewCurrentState(
		"maintainer", "octo-tenant", "octo/sample", 17, strings.Repeat("a", 40), &body, prerequisites,
	)
	if err != nil {
		t.Fatal(err)
	}
	return current
}

func testPlanInput() actionPlanInput {
	body := "Reviewed exactly.\n"
	return actionPlanInput{
		Actor: "maintainer", Tenant: "octo-tenant", Repository: "octo/sample",
		PullRequest: 17, HeadSHA: strings.Repeat("a", 40), ActionKind: "review", Body: &body,
		Operations: []operationInput{{
			Args: []string{"gh", "pr", "review", "17", "--repo", "octo/sample", "--approve", "--body", body},
		}},
		Prerequisites: prerequisitesInput{
			Permissions: map[string]any{"push": true}, Checks: map[string]any{"ci": "success"},
		},
		CreatedAt: "2026-08-11T12:00:00+00:00", ExpiresAt: "2026-08-11T12:10:00+00:00",
		IdempotencyKey: "test-plan",
	}
}

func fixturePlan(t *testing.T, input actionPlanInput) (ActionPlan, error) {
	t.Helper()
	operations := make([]GitHubOperation, len(input.Operations))
	for index, value := range input.Operations {
		operation, err := NewGitHubOperation(value.Args, value.Body)
		if err != nil {
			return ActionPlan{}, err
		}
		operations[index] = operation
	}
	prerequisites, err := NewPrerequisites(input.Prerequisites.Permissions, input.Prerequisites.Checks)
	if err != nil {
		return ActionPlan{}, err
	}
	createdAt, err := time.Parse(time.RFC3339Nano, input.CreatedAt)
	if err != nil {
		return ActionPlan{}, err
	}
	expiresAt, err := time.Parse(time.RFC3339Nano, input.ExpiresAt)
	if err != nil {
		return ActionPlan{}, err
	}
	return BuildActionPlan(
		input.Actor, input.Tenant, input.Repository, input.PullRequest, input.HeadSHA,
		input.ActionKind, input.Body, operations, prerequisites, createdAt, expiresAt,
		input.IdempotencyKey,
	)
}

func fixtureCurrentState(t *testing.T, input currentStateInput) CurrentState {
	t.Helper()
	prerequisites, err := NewPrerequisites(input.Prerequisites.Permissions, input.Prerequisites.Checks)
	if err != nil {
		t.Fatal(err)
	}
	current, err := NewCurrentState(input.Actor, input.Tenant, input.Repository, input.PullRequest, input.HeadSHA, input.Body, prerequisites)
	if err != nil {
		t.Fatal(err)
	}
	return current
}

func TestActionPlanIdentityIsStableAcrossMapOrder(t *testing.T) {
	first, err := NewPrerequisites(map[string]any{"push": true, "read": "yes"}, map[string]any{"ci": "success"})
	if err != nil {
		t.Fatal(err)
	}
	second, err := NewPrerequisites(map[string]any{"read": "yes", "push": true}, map[string]any{"ci": "success"})
	if err != nil {
		t.Fatal(err)
	}
	body := "body"
	operation, err := NewGitHubOperation([]string{"gh", "pr", "comment", "17", "--repo", "octo/sample", "--body", body}, nil)
	if err != nil {
		t.Fatal(err)
	}
	created := time.Date(2026, 8, 11, 12, 0, 0, 0, time.UTC)
	expires := created.Add(10 * time.Minute)
	one, err := BuildActionPlan("a", "t", "octo/sample", 17, strings.Repeat("a", 40), "comment", &body, []GitHubOperation{operation}, first, created, expires, "key")
	if err != nil {
		t.Fatal(err)
	}
	two, err := BuildActionPlan("a", "t", "octo/sample", 17, strings.Repeat("a", 40), "comment", &body, []GitHubOperation{operation}, second, created, expires, "key")
	if err != nil {
		t.Fatal(err)
	}
	if one.Identity() != two.Identity() {
		t.Fatal("map order changed the plan identity")
	}
	if bytes.Equal([]byte(one.Identity()), []byte("")) {
		t.Fatal("plan identity is empty")
	}
}
