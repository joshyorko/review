package review

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"math"
	"reflect"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"
)

const (
	DefaultPlanTTL    = 10 * time.Minute
	MaxPlanOperations = 32
	MaxReceiptDetail  = 256
)

var forbiddenOperationArgs = map[string]struct{}{
	"--admin":            {},
	"--auto":             {},
	"--delete-branch":    {},
	"--force":            {},
	"--force-with-lease": {},
}

var allowedActionKinds = map[string]struct{}{
	"approve-and-queue": {},
	"comment":           {},
	"merge":             {},
	"queue":             {},
	"reject":            {},
	"resolve-cluster":   {},
	"review":            {},
	"update-branch":     {},
}

var allowedPROperations = map[string]struct{}{
	"close":         {},
	"comment":       {},
	"edit":          {},
	"merge":         {},
	"review":        {},
	"update-branch": {},
}

type ActionPlanError struct {
	Message string
}

func (err *ActionPlanError) Error() string { return err.Message }

type InvalidPlanError struct{ ActionPlanError }
type PlanDriftError struct{ ActionPlanError }
type PlanExpiredError struct{ PlanDriftError }
type HumanConfirmationRequired struct{ ActionPlanError }
type ExecutionNotEligible struct{ ActionPlanError }

func invalidPlan(message string) error {
	return &InvalidPlanError{ActionPlanError{Message: message}}
}

func planDrift(message string) error {
	return &PlanDriftError{ActionPlanError{Message: message}}
}

func planExpired(message string) error {
	return &PlanExpiredError{PlanDriftError{ActionPlanError{Message: message}}}
}

func confirmationRequired(message string) error {
	return &HumanConfirmationRequired{ActionPlanError{Message: message}}
}

func executionNotEligible(message string) error {
	return &ExecutionNotEligible{ActionPlanError{Message: message}}
}

type Prerequisites struct {
	Permissions map[string]any
	Checks      map[string]any
}

func NewPrerequisites(permissions, checks map[string]any) (Prerequisites, error) {
	normalizedPermissions, err := cloneScalarMap(permissions, "permissions")
	if err != nil {
		return Prerequisites{}, err
	}
	normalizedChecks, err := cloneScalarMap(checks, "checks")
	if err != nil {
		return Prerequisites{}, err
	}
	return Prerequisites{
		Permissions: normalizedPermissions,
		Checks:      normalizedChecks,
	}, nil
}

func (prerequisites Prerequisites) Validate() error {
	_, err := NewPrerequisites(prerequisites.Permissions, prerequisites.Checks)
	return err
}

func (prerequisites Prerequisites) Payload() map[string]map[string]any {
	return map[string]map[string]any{
		"permissions": clonePlanMap(prerequisites.Permissions),
		"checks":      clonePlanMap(prerequisites.Checks),
	}
}

type GitHubOperation struct {
	Args []string
	Body *string
}

func NewGitHubOperation(args []string, body *string) (GitHubOperation, error) {
	operation := GitHubOperation{Args: append([]string(nil), args...), Body: cloneString(body)}
	if err := operation.Validate(); err != nil {
		return GitHubOperation{}, err
	}
	return operation, nil
}

func (operation GitHubOperation) Validate() error {
	if len(operation.Args) == 0 {
		return invalidPlan("operation argv must be a non-empty string sequence")
	}
	for _, argument := range operation.Args {
		if argument == "" {
			return invalidPlan("operation argv must be a non-empty string sequence")
		}
	}
	if operation.Body != nil && !utf8.ValidString(*operation.Body) {
		return invalidPlan("operation body must be an exact Markdown string or None")
	}
	return nil
}

func (operation GitHubOperation) Copy() GitHubOperation {
	return GitHubOperation{Args: append([]string(nil), operation.Args...), Body: cloneString(operation.Body)}
}

type CurrentState struct {
	Actor         string
	Tenant        string
	Repository    string
	PullRequest   int
	HeadSHA       string
	Body          *string
	Prerequisites Prerequisites
}

func NewCurrentState(actor, tenant, repository string, pullRequest int, headSHA string, body *string, prerequisites Prerequisites) (CurrentState, error) {
	state := CurrentState{
		Actor: actor, Tenant: tenant, Repository: repository, PullRequest: pullRequest,
		HeadSHA: strings.ToLower(headSHA), Body: cloneString(body), Prerequisites: prerequisites,
	}
	if err := state.Validate(); err != nil {
		return CurrentState{}, err
	}
	return state, nil
}

func (state CurrentState) Validate() error {
	if err := planText(state.Actor, "actor"); err != nil {
		return err
	}
	if err := planText(state.Tenant, "tenant"); err != nil {
		return err
	}
	if err := planText(state.Repository, "repository"); err != nil {
		return err
	}
	if strings.Count(state.Repository, "/") != 1 || strings.ContainsAny(state.Repository, " \t\r\n") {
		return invalidPlan("repository must be owner/name")
	}
	if err := positivePullRequest(state.PullRequest); err != nil {
		return err
	}
	if err := planHead(state.HeadSHA); err != nil {
		return err
	}
	if state.Body != nil && !utf8.ValidString(*state.Body) {
		return invalidPlan("body must be an exact Markdown string or None")
	}
	if err := state.Prerequisites.Validate(); err != nil {
		return err
	}
	return nil
}

type ActionPreview struct {
	PlanIdentity   string
	Actor          string
	Tenant         string
	Repository     string
	PullRequest    int
	HeadSHA        string
	ActionKind     string
	Body           *string
	Operations     []GitHubOperation
	Prerequisites  Prerequisites
	CreatedAt      time.Time
	ExpiresAt      time.Time
	IdempotencyKey string
}

func (preview ActionPreview) Copy() ActionPreview {
	operations := make([]GitHubOperation, len(preview.Operations))
	for index, operation := range preview.Operations {
		operations[index] = operation.Copy()
	}
	return ActionPreview{
		PlanIdentity: preview.PlanIdentity, Actor: preview.Actor, Tenant: preview.Tenant,
		Repository: preview.Repository, PullRequest: preview.PullRequest, HeadSHA: preview.HeadSHA,
		ActionKind: preview.ActionKind, Body: cloneString(preview.Body), Operations: operations,
		Prerequisites: Prerequisites{
			Permissions: clonePlanMap(preview.Prerequisites.Permissions),
			Checks:      clonePlanMap(preview.Prerequisites.Checks),
		},
		CreatedAt: preview.CreatedAt, ExpiresAt: preview.ExpiresAt,
		IdempotencyKey: preview.IdempotencyKey,
	}
}

type humanCapability struct{}

type HumanConfirmation struct {
	PlanIdentity string
	Actor        string
	Tenant       string
	PullRequest  int
	ConfirmedAt  time.Time
	capability   *humanCapability
}

type executionCapability struct{}

type ExecutionEligibility struct {
	PlanIdentity   string
	IdempotencyKey string
	Actor          string
	Tenant         string
	EligibleAt     time.Time
	capability     *executionCapability
}

type OperationResult struct {
	ReturnCode int
	Detail     string
}

func (result OperationResult) Validate() error {
	if !utf8.ValidString(result.Detail) {
		return fmt.Errorf("operation detail must be valid UTF-8")
	}
	return nil
}

type ActionReceipt struct {
	PlanIdentity        string
	IdempotencyKey      string
	Status              string
	TotalOperations     int
	AttemptedOperations int
	CompletedOperations int
	StartedAt           time.Time
	FinishedAt          time.Time
	Detail              string
}

type ReceiptLedger interface {
	Claim(string) bool
	Record(ActionReceipt)
}

type OperationExecutor func(GitHubOperation) (OperationResult, error)

type ActionPlan struct {
	Actor          string
	Tenant         string
	Repository     string
	PullRequest    int
	HeadSHA        string
	ActionKind     string
	Body           *string
	Operations     []GitHubOperation
	Prerequisites  Prerequisites
	CreatedAt      time.Time
	ExpiresAt      time.Time
	IdempotencyKey string
}

func BuildActionPlan(
	actor, tenant, repository string,
	pullRequest int,
	headSHA, actionKind string,
	body *string,
	operations []GitHubOperation,
	prerequisites Prerequisites,
	createdAt, expiresAt time.Time,
	idempotencyKey string,
) (ActionPlan, error) {
	if createdAt.IsZero() {
		createdAt = time.Now().UTC()
	}
	createdAt = createdAt.UTC().Truncate(time.Microsecond)
	if expiresAt.IsZero() {
		expiresAt = createdAt.Add(DefaultPlanTTL)
	}
	expiresAt = expiresAt.UTC().Truncate(time.Microsecond)
	if err := prerequisites.Validate(); err != nil {
		return ActionPlan{}, err
	}
	copiedOperations := make([]GitHubOperation, len(operations))
	for index, operation := range operations {
		copiedOperations[index] = operation.Copy()
	}
	if idempotencyKey == "" {
		payload := planPayload(ActionPlan{
			Actor: actor, Tenant: tenant, Repository: repository, PullRequest: pullRequest,
			HeadSHA: strings.ToLower(headSHA), ActionKind: actionKind, Body: body,
			Operations: copiedOperations, Prerequisites: prerequisites,
			CreatedAt: createdAt, ExpiresAt: expiresAt,
		})
		encoded, err := marshalCanonicalJSON(payload)
		if err != nil {
			return ActionPlan{}, err
		}
		sum := sha256.Sum256(encoded)
		idempotencyKey = hex.EncodeToString(sum[:])
	}
	plan := ActionPlan{
		Actor: actor, Tenant: tenant, Repository: repository, PullRequest: pullRequest,
		HeadSHA: strings.ToLower(headSHA), ActionKind: actionKind, Body: cloneString(body),
		Operations: copiedOperations, Prerequisites: Prerequisites{
			Permissions: clonePlanMap(prerequisites.Permissions),
			Checks:      clonePlanMap(prerequisites.Checks),
		},
		CreatedAt: createdAt, ExpiresAt: expiresAt, IdempotencyKey: idempotencyKey,
	}
	if err := plan.Validate(); err != nil {
		return ActionPlan{}, err
	}
	return plan, nil
}

func (plan ActionPlan) Validate() error {
	if err := planText(plan.Actor, "actor"); err != nil {
		return err
	}
	if err := planText(plan.Tenant, "tenant"); err != nil {
		return err
	}
	if err := planText(plan.Repository, "repository"); err != nil {
		return err
	}
	if strings.Count(plan.Repository, "/") != 1 || strings.ContainsAny(plan.Repository, " \t\r\n") {
		return invalidPlan("repository must be owner/name")
	}
	if err := positivePullRequest(plan.PullRequest); err != nil {
		return err
	}
	if err := planHead(plan.HeadSHA); err != nil {
		return err
	}
	if err := planText(plan.ActionKind, "action_kind"); err != nil {
		return err
	}
	if _, ok := allowedActionKinds[plan.ActionKind]; !ok {
		return invalidPlan("action_kind is not an existing review mutation")
	}
	if plan.Body != nil && !utf8.ValidString(*plan.Body) {
		return invalidPlan("body must be an exact Markdown string or None")
	}
	if len(plan.Operations) == 0 {
		return invalidPlan("a plan must contain at least one exact operation")
	}
	if len(plan.Operations) > MaxPlanOperations {
		return invalidPlan(fmt.Sprintf("a plan cannot contain more than %d operations", MaxPlanOperations))
	}
	if err := plan.Prerequisites.Validate(); err != nil {
		return err
	}
	planHasBody := false
	for _, operation := range plan.Operations {
		sawBody, err := validateOperation(operation, plan.Repository, plan.PullRequest, plan.Body)
		if err != nil {
			return err
		}
		planHasBody = planHasBody || sawBody
	}
	if plan.Body != nil && !planHasBody {
		return invalidPlan("exact plan body is not represented by its operations")
	}
	if plan.CreatedAt.IsZero() || plan.ExpiresAt.IsZero() || !plan.ExpiresAt.After(plan.CreatedAt) {
		return invalidPlan("expires_at must be after created_at")
	}
	if err := planText(plan.IdempotencyKey, "idempotency_key"); err != nil {
		return err
	}
	return nil
}

func (plan ActionPlan) Identity() string {
	payload := planPayload(plan)
	encoded, err := marshalCanonicalJSON(payload)
	if err != nil {
		return ""
	}
	sum := sha256.Sum256(encoded)
	return hex.EncodeToString(sum[:])
}

func (plan ActionPlan) PlanHash() string { return plan.Identity() }
func (plan ActionPlan) PlanID() string   { return plan.Identity() }

func (plan ActionPlan) IsExpired(now time.Time) bool {
	if now.IsZero() {
		now = time.Now().UTC()
	}
	return !now.Before(plan.ExpiresAt)
}

func (plan ActionPlan) Preview() ActionPreview {
	operations := make([]GitHubOperation, len(plan.Operations))
	for index, operation := range plan.Operations {
		operations[index] = operation.Copy()
	}
	return ActionPreview{
		PlanIdentity: plan.Identity(), Actor: plan.Actor, Tenant: plan.Tenant,
		Repository: plan.Repository, PullRequest: plan.PullRequest, HeadSHA: plan.HeadSHA,
		ActionKind: plan.ActionKind, Body: cloneString(plan.Body), Operations: operations,
		Prerequisites: Prerequisites{
			Permissions: clonePlanMap(plan.Prerequisites.Permissions),
			Checks:      clonePlanMap(plan.Prerequisites.Checks),
		},
		CreatedAt: plan.CreatedAt, ExpiresAt: plan.ExpiresAt, IdempotencyKey: plan.IdempotencyKey,
	}
}

func (plan ActionPlan) ConfirmHuman(preview ActionPreview, actor, tenant string, typedPullRequest int, now time.Time) (HumanConfirmation, error) {
	if preview.PlanIdentity != plan.Identity() {
		return HumanConfirmation{}, confirmationRequired("preview belongs to another plan")
	}
	if now.IsZero() {
		now = time.Now().UTC()
	}
	now = now.UTC().Truncate(time.Microsecond)
	if err := plan.ensureLive(now); err != nil {
		return HumanConfirmation{}, err
	}
	if actor != plan.Actor {
		return HumanConfirmation{}, confirmationRequired("confirmation actor does not match the plan")
	}
	if tenant != plan.Tenant {
		return HumanConfirmation{}, confirmationRequired("confirmation tenant does not match the plan")
	}
	if typedPullRequest != plan.PullRequest {
		return HumanConfirmation{}, confirmationRequired("typed pull request does not match the plan")
	}
	return HumanConfirmation{
		PlanIdentity: plan.Identity(), Actor: actor, Tenant: tenant,
		PullRequest: typedPullRequest, ConfirmedAt: now, capability: &humanCapability{},
	}, nil
}

func (plan ActionPlan) Revalidate(current CurrentState, now time.Time) error {
	if now.IsZero() {
		now = time.Now().UTC()
	}
	if err := plan.ensureLive(now.UTC()); err != nil {
		return err
	}
	if err := current.Validate(); err != nil {
		return planDrift("current state is required")
	}
	comparisons := []struct {
		name     string
		expected any
		actual   any
	}{
		{"actor", plan.Actor, current.Actor},
		{"tenant", plan.Tenant, current.Tenant},
		{"repository", plan.Repository, current.Repository},
		{"pull_request", plan.PullRequest, current.PullRequest},
		{"head", strings.ToLower(plan.HeadSHA), strings.ToLower(current.HeadSHA)},
		{"body", plan.Body, current.Body},
		{"permissions", plan.Prerequisites.Permissions, current.Prerequisites.Permissions},
		{"checks", plan.Prerequisites.Checks, current.Prerequisites.Checks},
	}
	for _, comparison := range comparisons {
		if !reflect.DeepEqual(comparison.expected, comparison.actual) {
			return planDrift(fmt.Sprintf("%s drift invalidates the ActionPlan", comparison.name))
		}
	}
	return nil
}

func (plan ActionPlan) ExecutionEligibility(confirmation HumanConfirmation, current CurrentState, now time.Time) (ExecutionEligibility, error) {
	if confirmation.capability == nil {
		return ExecutionEligibility{}, confirmationRequired("a preview or model-only confirmation cannot authorize execution")
	}
	if confirmation.PlanIdentity != plan.Identity() {
		return ExecutionEligibility{}, confirmationRequired("confirmation belongs to another plan")
	}
	if confirmation.Actor != plan.Actor || confirmation.Tenant != plan.Tenant {
		return ExecutionEligibility{}, confirmationRequired("confirmation authority drifted")
	}
	if confirmation.PullRequest != plan.PullRequest {
		return ExecutionEligibility{}, confirmationRequired("confirmation pull request drifted")
	}
	if now.IsZero() {
		now = time.Now().UTC()
	}
	now = now.UTC().Truncate(time.Microsecond)
	if err := plan.ensureLive(now); err != nil {
		return ExecutionEligibility{}, err
	}
	if confirmation.ConfirmedAt.After(now) {
		return ExecutionEligibility{}, confirmationRequired("confirmation is from the future")
	}
	if err := plan.Revalidate(current, now); err != nil {
		return ExecutionEligibility{}, err
	}
	return ExecutionEligibility{
		PlanIdentity: plan.Identity(), IdempotencyKey: plan.IdempotencyKey,
		Actor: confirmation.Actor, Tenant: confirmation.Tenant, EligibleAt: now,
		capability: &executionCapability{},
	}, nil
}

func (plan ActionPlan) Execute(eligibility ExecutionEligibility, current CurrentState, executor any, ledger ReceiptLedger, now time.Time) (ActionReceipt, error) {
	if eligibility.capability == nil {
		return ActionReceipt{}, executionNotEligible("execution requires plan-issued eligibility")
	}
	if eligibility.PlanIdentity != plan.Identity() {
		return ActionReceipt{}, executionNotEligible("execution eligibility belongs to another plan")
	}
	if eligibility.IdempotencyKey != plan.IdempotencyKey {
		return ActionReceipt{}, executionNotEligible("execution idempotency key does not match")
	}
	if eligibility.Actor != plan.Actor || eligibility.Tenant != plan.Tenant {
		return ActionReceipt{}, executionNotEligible("execution authority does not match")
	}
	if ledger == nil {
		return ActionReceipt{}, executionNotEligible("a caller-owned receipt ledger is required")
	}
	if executor == nil {
		return ActionReceipt{}, executionNotEligible("an operation executor is required")
	}
	if now.IsZero() {
		now = time.Now().UTC()
	}
	now = now.UTC().Truncate(time.Microsecond)
	if err := plan.Revalidate(current, now); err != nil {
		return ActionReceipt{}, err
	}
	if !ledger.Claim(plan.IdempotencyKey) {
		return ActionReceipt{}, executionNotEligible("execution idempotency key was already claimed")
	}
	for index, operation := range plan.Operations {
		result, err := invokeExecutor(executor, operation)
		if err != nil {
			receipt := plan.failedReceipt(now, index+1, index, err.Error())
			ledger.Record(receipt)
			return receipt, nil
		}
		if result.ReturnCode != 0 {
			receipt := plan.failedReceipt(now, index+1, index, result.Detail)
			ledger.Record(receipt)
			return receipt, nil
		}
	}
	receipt := ActionReceipt{
		PlanIdentity: plan.Identity(), IdempotencyKey: plan.IdempotencyKey, Status: "succeeded",
		TotalOperations: len(plan.Operations), AttemptedOperations: len(plan.Operations),
		CompletedOperations: len(plan.Operations), StartedAt: now, FinishedAt: now,
	}
	ledger.Record(receipt)
	return receipt, nil
}

func (plan ActionPlan) failedReceipt(now time.Time, attempted, completed int, detail string) ActionReceipt {
	return ActionReceipt{
		PlanIdentity: plan.Identity(), IdempotencyKey: plan.IdempotencyKey, Status: "failed",
		TotalOperations: len(plan.Operations), AttemptedOperations: attempted,
		CompletedOperations: completed, StartedAt: now, FinishedAt: now,
		Detail: boundedDetail(detail),
	}
}

func (plan ActionPlan) ensureLive(now time.Time) error {
	if now.Before(plan.CreatedAt) {
		return planExpired("plan is not valid before its creation time")
	}
	if !now.Before(plan.ExpiresAt) {
		return planExpired("plan has expired")
	}
	return nil
}

func validateOperation(operation GitHubOperation, repository string, pullRequest int, body *string) (bool, error) {
	if err := operation.Validate(); err != nil {
		return false, err
	}
	argv := operation.Args
	if argv[0] != "gh" {
		return false, invalidPlan("every operation must invoke gh directly")
	}
	for _, argument := range argv {
		if _, forbidden := forbiddenOperationArgs[argument]; forbidden {
			return false, invalidPlan("admin, force, and branch-deletion operations are forbidden")
		}
	}
	repoIndex := -1
	for index, argument := range argv {
		if argument == "--repo" {
			repoIndex = index
			break
		}
	}
	if repoIndex < 0 || repoIndex+1 >= len(argv) {
		return false, invalidPlan("every operation must bind --repo to the plan repository")
	}
	if argv[repoIndex+1] != repository {
		return false, invalidPlan("operation repository does not match the plan")
	}
	if len(argv) < 3 {
		return false, invalidPlan("operation is incomplete")
	}
	if argv[1] == "pr" {
		if len(argv) < 4 {
			return false, invalidPlan("operation is not an existing pull-request mutation")
		}
		if _, allowed := allowedPROperations[argv[2]]; !allowed {
			return false, invalidPlan("operation is not an existing pull-request mutation")
		}
		operationPullRequest, err := strconv.Atoi(strings.TrimSpace(argv[3]))
		if err != nil || operationPullRequest != pullRequest {
			return false, invalidPlan("pull-request operation must name its PR number")
		}
	} else if !(argv[1] == "label" && argv[2] == "create") {
		return false, invalidPlan("operation is not an existing review mutation")
	}
	sawBody := false
	for index, argument := range argv {
		if argument != "--body" && argument != "--body-file" {
			continue
		}
		if index+1 >= len(argv) {
			return false, invalidPlan("body operation is missing its exact value")
		}
		if body == nil {
			return false, invalidPlan("body-bearing operation requires the exact plan body")
		}
		sawBody = true
		if argument == "--body" && argv[index+1] != *body {
			return false, invalidPlan("operation body does not match the exact plan body")
		}
		if argument == "--body-file" && (operation.Body == nil || *operation.Body != *body) {
			return false, invalidPlan("body-file operation must carry the exact plan body")
		}
	}
	if operation.Body != nil && !sawBody {
		return false, invalidPlan("operation body is not represented by its argv")
	}
	return sawBody, nil
}

func invokeExecutor(executor any, operation GitHubOperation) (result OperationResult, err error) {
	defer func() {
		if recovered := recover(); recovered != nil {
			err = fmt.Errorf("%v", recovered)
		}
	}()
	switch typed := executor.(type) {
	case OperationExecutor:
		return typed(operation)
	case func(GitHubOperation) (OperationResult, error):
		return typed(operation)
	case func(GitHubOperation) OperationResult:
		return typed(operation), nil
	case func(GitHubOperation) int:
		return OperationResult{ReturnCode: typed(operation)}, nil
	default:
		return OperationResult{}, executionNotEligible("an operation executor is required")
	}
}

func planPayload(plan ActionPlan) map[string]any {
	operations := make([]any, len(plan.Operations))
	for index, operation := range plan.Operations {
		var body any
		if operation.Body != nil {
			body = *operation.Body
		}
		operations[index] = map[string]any{
			"argv": append([]string(nil), operation.Args...),
			"body": body,
		}
	}
	return map[string]any{
		"action_kind":     plan.ActionKind,
		"actor":           plan.Actor,
		"body":            stringPointerValue(plan.Body),
		"created_at":      pythonTime(plan.CreatedAt),
		"expires_at":      pythonTime(plan.ExpiresAt),
		"head_sha":        strings.ToLower(plan.HeadSHA),
		"idempotency_key": plan.IdempotencyKey,
		"operations":      operations,
		"prerequisites":   plan.Prerequisites.Payload(),
		"pull_request":    plan.PullRequest,
		"repository":      plan.Repository,
		"tenant":          plan.Tenant,
	}
}

func cloneScalarMap(value map[string]any, field string) (map[string]any, error) {
	if value == nil {
		return map[string]any{}, nil
	}
	cloned := make(map[string]any, len(value))
	for key, item := range value {
		if key == "" {
			return nil, invalidPlan(fmt.Sprintf("%s keys must be non-empty strings", field))
		}
		if !validScalar(item) {
			return nil, invalidPlan(fmt.Sprintf("%s must contain JSON scalar values", field))
		}
		cloned[key] = item
	}
	return cloned, nil
}

func validScalar(value any) bool {
	switch typed := value.(type) {
	case nil:
		return true
	case bool, int, int8, int16, int32, int64, uint, uint8, uint16, uint32, uint64, string:
		return typed != nil
	case float32:
		return !math.IsNaN(float64(typed)) && !math.IsInf(float64(typed), 0)
	case float64:
		return !math.IsNaN(typed) && !math.IsInf(typed, 0)
	default:
		return false
	}
}

func planText(value, field string) error {
	if value == "" || value != strings.TrimSpace(value) || !utf8.ValidString(value) {
		return invalidPlan(fmt.Sprintf("%s must be a non-empty exact string", field))
	}
	return nil
}

func planHead(value string) error {
	if !isAnyCaseSHA(value) {
		return invalidPlan("head_sha must be the full 40-character head SHA")
	}
	return nil
}

func isAnyCaseSHA(value string) bool {
	if len(value) != 40 {
		return false
	}
	for _, character := range value {
		if !((character >= '0' && character <= '9') || (character >= 'a' && character <= 'f') || (character >= 'A' && character <= 'F')) {
			return false
		}
	}
	return true
}

func positivePullRequest(value int) error {
	if value <= 0 {
		return invalidPlan("pull_request must be a positive integer")
	}
	return nil
}

func clonePlanMap(value map[string]any) map[string]any {
	cloned := make(map[string]any, len(value))
	for key, item := range value {
		cloned[key] = item
	}
	return cloned
}

func cloneString(value *string) *string {
	if value == nil {
		return nil
	}
	copied := *value
	return &copied
}

func stringPointerValue(value *string) any {
	if value == nil {
		return nil
	}
	return *value
}

func boundedDetail(value string) string {
	if utf8.RuneCountInString(value) <= MaxReceiptDetail {
		return value
	}
	runes := []rune(value)
	return string(runes[:MaxReceiptDetail])
}

func pythonTime(value time.Time) string {
	value = value.UTC().Truncate(time.Microsecond)
	formatted := value.Format("2006-01-02T15:04:05.000000-07:00")
	if dot := strings.LastIndexByte(formatted, '.'); dot >= 0 {
		offset := strings.IndexByte(formatted[dot:], '-')
		if offset < 0 {
			offset = strings.IndexByte(formatted[dot:], '+')
		}
		if offset > 0 {
			endFraction := dot + offset
			fraction := strings.TrimRight(formatted[dot+1:endFraction], "0")
			if fraction == "" {
				formatted = formatted[:dot] + formatted[endFraction:]
			} else {
				formatted = formatted[:dot+1] + fraction + formatted[endFraction:]
			}
		}
	}
	return formatted
}
