package review

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	tea "charm.land/bubbletea/v2"
)

type cockpitFixture struct {
	Name     string                 `json:"name"`
	Reviews  []cockpitReviewFixture `json:"reviews"`
	Expected cockpitExpectedFixture `json:"expected"`
}

type cockpitReviewFixture struct {
	ID          string `json:"id"`
	Repository  string `json:"repository"`
	PullRequest int    `json:"pull_request"`
	HeadSHA     string `json:"head_sha"`
	Title       string `json:"title"`
	State       State  `json:"state"`
	IsClean     bool   `json:"is_clean"`
}

type cockpitExpectedFixture struct {
	CursorAfterDown int             `json:"cursor_after_down"`
	Decision        CockpitDecision `json:"decision"`
	ActionKind      string          `json:"action_kind"`
}

func TestCockpitNavigationAndActionControls(t *testing.T) {
	raw, err := os.ReadFile(filepath.Join("testdata", "cockpit-cases.json"))
	if err != nil {
		t.Fatal(err)
	}
	var fixtures []cockpitFixture
	if err := json.Unmarshal(raw, &fixtures); err != nil {
		t.Fatal(err)
	}
	for _, fixture := range fixtures {
		t.Run(fixture.Name, func(t *testing.T) {
			reviews := make([]CockpitReview, len(fixture.Reviews))
			for index, item := range fixture.Reviews {
				reviews[index] = CockpitReview{
					ID: item.ID, Repository: item.Repository, PullRequest: item.PullRequest,
					HeadSHA: item.HeadSHA, Title: item.Title, State: item.State, IsClean: item.IsClean,
				}
			}
			model := NewCockpitModel(reviews)
			updated, _ := model.Update(tea.KeyPressMsg{Text: "j"})
			model = updated.(CockpitModel)
			if model.Cursor() != fixture.Expected.CursorAfterDown {
				t.Fatalf("cursor = %d, want %d", model.Cursor(), fixture.Expected.CursorAfterDown)
			}
			updated, _ = model.Update(tea.KeyPressMsg{Text: "a"})
			model = updated.(CockpitModel)
			plan, ok := model.PendingPlan()
			if !ok || model.Decision() != fixture.Expected.Decision {
				t.Fatalf("approve plan missing: decision=%q plan=%v", model.Decision(), ok)
			}
			if plan.ActionKind != fixture.Expected.ActionKind {
				t.Fatalf("action kind = %q, want %q", plan.ActionKind, fixture.Expected.ActionKind)
			}
			if !strings.Contains(model.View().Content, "typed confirmation required") {
				t.Fatal("view omitted confirmation status")
			}
		})
	}
	model := NewCockpitModel(nil)
	updated, _ := model.Update(tea.KeyPressMsg{Code: tea.KeyEscape})
	model = updated.(CockpitModel)
	if _, ok := model.PendingPlan(); ok {
		t.Fatal("escape left an action plan pending")
	}
}

func TestCockpitMouseSelectsRowAndBuildsRejectPlan(t *testing.T) {
	model := NewCockpitModel([]CockpitReview{{
		ID:          "review-1",
		Repository:  "octo/sample",
		PullRequest: 17,
		HeadSHA:     strings.Repeat("a", 40),
		State:       StateComplete,
	}})
	updated, _ := model.Update(tea.MouseClickMsg{X: 2, Y: 2})
	model = updated.(CockpitModel)
	if model.SelectedID() != "review-1" {
		t.Fatalf("selected ID = %q", model.SelectedID())
	}
	updated, _ = model.Update(tea.KeyPressMsg{Text: "r"})
	model = updated.(CockpitModel)
	plan, ok := model.PendingPlan()
	if !ok || model.Decision() != CockpitDecisionReject {
		t.Fatalf("reject plan missing: decision=%q plan=%v", model.Decision(), ok)
	}
	if plan.Operations[0].Args[len(plan.Operations[0].Args)-1] != "--request-changes" {
		t.Fatalf("operation = %#v", plan.Operations[0].Args)
	}
}
