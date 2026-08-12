package review

import (
	"strings"
	"testing"

	tea "charm.land/bubbletea/v2"
)

func TestCockpitNavigationAndActionControls(t *testing.T) {
	reviews := []CockpitReview{
		{
			ID:          "review-1",
			Repository:  "octo/sample",
			PullRequest: 17,
			HeadSHA:     strings.Repeat("a", 40),
			Title:       "first",
			State:       StateComplete,
			IsClean:     true,
		},
		{
			ID:          "review-2",
			Repository:  "octo/sample",
			PullRequest: 18,
			HeadSHA:     strings.Repeat("b", 40),
			Title:       "second",
			State:       StateFindings,
		},
	}
	model := NewCockpitModel(reviews)
	updated, _ := model.Update(tea.KeyPressMsg{Text: "j"})
	model = updated.(CockpitModel)
	if model.Cursor() != 1 {
		t.Fatalf("cursor = %d, want 1", model.Cursor())
	}
	updated, _ = model.Update(tea.KeyPressMsg{Text: "a"})
	model = updated.(CockpitModel)
	plan, ok := model.PendingPlan()
	if !ok || model.Decision() != CockpitDecisionApprove {
		t.Fatalf("approve plan missing: decision=%q plan=%v", model.Decision(), ok)
	}
	if plan.ActionKind != "approve-and-queue" {
		t.Fatalf("action kind = %q", plan.ActionKind)
	}
	if !strings.Contains(model.View().Content, "typed confirmation required") {
		t.Fatal("view omitted confirmation status")
	}

	updated, _ = model.Update(tea.KeyPressMsg{Code: tea.KeyEscape})
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
