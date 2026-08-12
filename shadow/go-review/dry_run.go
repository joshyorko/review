package review

import (
	"encoding/json"
	"errors"
	"time"
)

// DryRunPreview is an immutable description of a validated plan. It records
// whether current state still matches, but it never invokes an executor.
type DryRunPreview struct {
	Preview                   ActionPreview
	Eligible                  bool
	RequiresTypedConfirmation bool
	Warnings                  []string
	plan                      ActionPlan
}

func PreviewActionPlan(plan ActionPlan, current CurrentState, now time.Time) (DryRunPreview, error) {
	if err := plan.Validate(); err != nil {
		return DryRunPreview{}, err
	}
	if err := current.Validate(); err != nil {
		return DryRunPreview{}, err
	}
	preview := DryRunPreview{
		Preview:                   plan.Preview(),
		RequiresTypedConfirmation: true,
		plan:                      plan,
	}
	if err := plan.Revalidate(current, now); err != nil {
		preview.Warnings = []string{boundedDetail(err.Error())}
		return preview, nil
	}
	preview.Eligible = true
	return preview, nil
}

func (preview DryRunPreview) Confirm(actor, tenant string, typedPullRequest int, now time.Time) (HumanConfirmation, error) {
	if !preview.Eligible {
		return HumanConfirmation{}, errors.New("dry-run preview is not eligible")
	}
	if !preview.RequiresTypedConfirmation {
		return HumanConfirmation{}, errors.New("typed confirmation is required")
	}
	return preview.plan.ConfirmHuman(preview.Preview, actor, tenant, typedPullRequest, now)
}

func (preview DryRunPreview) ExecutionEligibility(
	confirmation HumanConfirmation,
	current CurrentState,
	now time.Time,
) (ExecutionEligibility, error) {
	if !preview.Eligible {
		return ExecutionEligibility{}, errors.New("dry-run preview is not eligible")
	}
	return preview.plan.ExecutionEligibility(confirmation, current, now)
}

func (preview DryRunPreview) ToJSON() string {
	payload := map[string]any{
		"eligible":                    preview.Eligible,
		"requires_typed_confirmation": preview.RequiresTypedConfirmation,
		"warnings":                    append([]string(nil), preview.Warnings...),
		"plan":                        planPayload(preview.plan),
	}
	encoded, err := json.Marshal(payload)
	if err != nil {
		return ""
	}
	return string(encoded)
}

type DryRunService struct{}

func (DryRunService) Preview(plan ActionPlan, current CurrentState, now time.Time) (DryRunPreview, error) {
	return PreviewActionPlan(plan, current, now)
}
