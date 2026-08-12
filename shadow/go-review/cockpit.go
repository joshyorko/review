package review

import (
	"fmt"
	"strconv"
	"strings"
	"time"

	tea "charm.land/bubbletea/v2"
)

// CockpitReview is the bounded, local view of one review queue row.
type CockpitReview struct {
	ID          string
	Repository  string
	PullRequest int
	HeadSHA     string
	Title       string
	State       State
	IsClean     bool
	Actor       string
	Tenant      string
}

type CockpitDecision string

const (
	CockpitDecisionNone    CockpitDecision = ""
	CockpitDecisionApprove CockpitDecision = "approve"
	CockpitDecisionReject  CockpitDecision = "reject"
)

// CockpitModel is a deterministic Bubble Tea model. It only selects rows and
// creates validated action plans; it never executes an operation.
type CockpitModel struct {
	reviews  []CockpitReview
	cursor   int
	width    int
	height   int
	status   string
	decision CockpitDecision
	plan     *ActionPlan
	selected string
}

func NewCockpitModel(reviews []CockpitReview) CockpitModel {
	copied := append([]CockpitReview(nil), reviews...)
	return CockpitModel{
		reviews: copied,
		status:  "select a review",
	}
}

func (model CockpitModel) Init() tea.Cmd { return nil }

func (model CockpitModel) Update(message tea.Msg) (tea.Model, tea.Cmd) {
	switch message := message.(type) {
	case tea.WindowSizeMsg:
		model.width, model.height = message.Width, message.Height
	case tea.KeyMsg:
		key := message.Key()
		switch key.Code {
		case tea.KeyUp:
			model.move(-1)
		case tea.KeyDown:
			model.move(1)
		case tea.KeyEnter:
			model.selectCurrent()
		case tea.KeyEscape:
			model.clearAction()
		default:
			switch key.Text {
			case "k":
				model.move(-1)
			case "j":
				model.move(1)
			case "a":
				model.buildAction(CockpitDecisionApprove)
			case "r":
				model.buildAction(CockpitDecisionReject)
			case "q":
				return model, tea.Quit
			}
		}
	case tea.MouseClickMsg:
		mouse := message.Mouse()
		row := mouse.Y - 2
		if row >= 0 && row < len(model.reviews) {
			model.cursor = row
			line := model.rowString(model.reviews[row], row == model.cursor)
			switch {
			case mouse.X >= strings.Index(line, "[approve]") && strings.Index(line, "[approve]") >= 0:
				model.buildAction(CockpitDecisionApprove)
			case mouse.X >= strings.Index(line, "[reject]") && strings.Index(line, "[reject]") >= 0:
				model.buildAction(CockpitDecisionReject)
			default:
				model.selectCurrent()
			}
		}
	}
	return model, nil
}

func (model *CockpitModel) move(delta int) {
	if len(model.reviews) == 0 {
		return
	}
	model.cursor += delta
	if model.cursor < 0 {
		model.cursor = len(model.reviews) - 1
	}
	if model.cursor >= len(model.reviews) {
		model.cursor = 0
	}
	model.status = fmt.Sprintf("highlighted %s", model.reviews[model.cursor].ID)
}

func (model *CockpitModel) selectCurrent() {
	if len(model.reviews) == 0 {
		model.status = "no reviews"
		return
	}
	model.selected = model.reviews[model.cursor].ID
	model.status = fmt.Sprintf("selected %s", model.selected)
}

func (model *CockpitModel) clearAction() {
	model.decision = CockpitDecisionNone
	model.plan = nil
	model.status = "action cleared"
}

func (model *CockpitModel) buildAction(decision CockpitDecision) {
	if len(model.reviews) == 0 {
		model.status = "no reviews"
		return
	}
	plan, err := BuildCockpitActionPlan(model.reviews[model.cursor], decision, time.Unix(0, 0).UTC())
	if err != nil {
		model.decision = CockpitDecisionNone
		model.plan = nil
		model.status = "action unavailable: " + err.Error()
		return
	}
	model.selected = model.reviews[model.cursor].ID
	model.decision = decision
	model.plan = &plan
	model.status = fmt.Sprintf("%s plan ready; typed confirmation required", decision)
}

func (model CockpitModel) rowString(review CockpitReview, selected bool) string {
	marker := " "
	if selected {
		marker = ">"
	}
	clean := string(review.State)
	if review.IsClean {
		clean = "clean"
	}
	return fmt.Sprintf("%s %-12s %-24s #%d %-12s [approve] [reject]",
		marker, review.ID, review.Repository, review.PullRequest, clean)
}

func (model CockpitModel) View() tea.View {
	var output strings.Builder
	output.WriteString("Review cockpit (M2, local and read-only)\n")
	output.WriteString("ID           repository               PR   state        controls\n")
	for index, review := range model.reviews {
		output.WriteString(model.rowString(review, index == model.cursor))
		output.WriteByte('\n')
	}
	output.WriteString("\n")
	output.WriteString("j/k or arrows: move  enter/click: select  a: approve  r: reject  esc: clear  q: quit\n")
	output.WriteString("status: ")
	output.WriteString(model.status)
	if model.plan != nil {
		output.WriteString("\nplan: ")
		output.WriteString(model.plan.Identity())
	}
	return tea.NewView(output.String())
}

func (model CockpitModel) Reviews() []CockpitReview {
	return append([]CockpitReview(nil), model.reviews...)
}

func (model CockpitModel) Cursor() int { return model.cursor }

func (model CockpitModel) SelectedID() string { return model.selected }

func (model CockpitModel) Decision() CockpitDecision { return model.decision }

func (model CockpitModel) PendingPlan() (ActionPlan, bool) {
	if model.plan == nil {
		return ActionPlan{}, false
	}
	return *model.plan, true
}

func BuildCockpitActionPlan(review CockpitReview, decision CockpitDecision, now time.Time) (ActionPlan, error) {
	if decision != CockpitDecisionApprove && decision != CockpitDecisionReject {
		return ActionPlan{}, invalidPlan("cockpit decision must be approve or reject")
	}
	actor := review.Actor
	if actor == "" {
		actor = "maintainer"
	}
	tenant := review.Tenant
	if tenant == "" {
		tenant = "local"
	}
	flag := "--approve"
	actionKind := "approve-and-queue"
	if decision == CockpitDecisionReject {
		flag = "--request-changes"
		actionKind = "reject"
	}
	operation, err := NewGitHubOperation([]string{
		"gh", "pr", "review", strconv.Itoa(review.PullRequest),
		"--repo", review.Repository, flag,
	}, nil)
	if err != nil {
		return ActionPlan{}, err
	}
	prerequisites, err := NewPrerequisites(
		map[string]any{"review": "human-confirmation"},
		map[string]any{"head_sha": review.HeadSHA},
	)
	if err != nil {
		return ActionPlan{}, err
	}
	return BuildActionPlan(
		actor, tenant, review.Repository, review.PullRequest, review.HeadSHA,
		actionKind, nil, []GitHubOperation{operation}, prerequisites,
		now, now.Add(DefaultPlanTTL), "",
	)
}
