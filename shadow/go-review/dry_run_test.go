package review

import (
	"strings"
	"testing"
	"time"
)

func TestDryRunRequiresTypedConfirmationBeforeEligibility(t *testing.T) {
	plan := testPlan(t)
	current := testCurrentState(t)
	preview, err := PreviewActionPlan(plan, current, plan.CreatedAt.Add(time.Minute))
	if err != nil {
		t.Fatal(err)
	}
	if !preview.Eligible || !preview.RequiresTypedConfirmation {
		t.Fatalf("preview = %#v", preview)
	}
	if _, err := preview.ExecutionEligibility(HumanConfirmation{}, current, plan.CreatedAt.Add(2*time.Minute)); err == nil {
		t.Fatal("forged confirmation was accepted by dry run")
	}
	confirmation, err := preview.Confirm("maintainer", "octo-tenant", 17, plan.CreatedAt.Add(time.Minute))
	if err != nil {
		t.Fatal(err)
	}
	eligibility, err := preview.ExecutionEligibility(confirmation, current, plan.CreatedAt.Add(2*time.Minute))
	if err != nil {
		t.Fatal(err)
	}
	if eligibility.PlanIdentity != plan.Identity() {
		t.Fatal("eligibility was not bound to the previewed plan")
	}
	if !strings.Contains(preview.ToJSON(), `"requires_typed_confirmation":true`) {
		t.Fatal("dry-run JSON omitted confirmation requirement")
	}
}

func TestDryRunReportsDriftWithoutMakingItExecutable(t *testing.T) {
	plan := testPlan(t)
	current := testCurrentState(t)
	current.HeadSHA = strings.Repeat("b", 40)
	preview, err := PreviewActionPlan(plan, current, plan.CreatedAt.Add(time.Minute))
	if err != nil {
		t.Fatal(err)
	}
	if preview.Eligible || len(preview.Warnings) != 1 {
		t.Fatalf("drift preview = %#v", preview)
	}
	if _, err := preview.Confirm("maintainer", "octo-tenant", 17, plan.CreatedAt.Add(time.Minute)); err == nil {
		t.Fatal("drifted dry-run became confirmable")
	}
}
