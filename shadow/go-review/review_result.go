package review

import (
	"encoding/json"
	"io"
	"math/big"
	"strings"
	"unicode/utf8"
)

const (
	MaxRawLines = 400
	MaxRawChars = 120_000
)

type State string

const (
	StateComplete   State = "complete"
	StateFindings   State = "findings"
	StateIncomplete State = "incomplete"
	StateFailed     State = "failed"
	StateUnparsable State = "unparsable"
)

var severityNames = [...]string{"critical", "high", "medium", "low"}

var verificationStates = map[string]struct{}{
	"verified":   {},
	"unverified": {},
	"skipped":    {},
}

type ReviewResult struct {
	Version      int
	State        State
	Counts       map[string]any
	Findings     []map[string]any
	Verification []map[string]any
	Provenance   map[string]any
	Overlap      map[string]any
	Live         map[string]any
	RawEvidence  []string
}

func emptyResult(state State) ReviewResult {
	return ReviewResult{
		Version:      1,
		State:        state,
		Counts:       zeroCounts(),
		Findings:     []map[string]any{},
		Verification: []map[string]any{},
		Provenance:   map[string]any{},
		Overlap:      map[string]any{},
		Live:         map[string]any{},
		RawEvidence:  []string{},
	}
}

func zeroCounts() map[string]any {
	counts := make(map[string]any, len(severityNames))
	for _, severity := range severityNames {
		counts[severity] = 0
	}
	return counts
}

func FromMap(data map[string]any) ReviewResult {
	if data == nil {
		return emptyResult(StateUnparsable)
	}
	if _, ok := data["counts"]; !ok {
		return emptyResult(StateUnparsable)
	}
	if _, ok := data["findings"]; !ok {
		return emptyResult(StateUnparsable)
	}

	versionValue, ok := integerValue(data["version"])
	if !ok {
		return emptyResult(StateUnparsable)
	}
	rawState, ok := data["state"].(string)
	if !ok {
		return emptyResult(StateUnparsable)
	}
	state := State(rawState)
	if versionValue.Cmp(big.NewInt(1)) != 0 || !knownState(state) {
		state = StateUnparsable
	}

	rawCounts, ok := stringMap(data["counts"])
	if !ok || len(rawCounts) != len(severityNames) {
		return emptyResult(StateUnparsable)
	}
	counts := zeroCounts()
	for _, severity := range severityNames {
		value, present := rawCounts[severity]
		if !present {
			return emptyResult(StateUnparsable)
		}
		parsed, valid := integerValue(value)
		if !valid || parsed.Sign() < 0 {
			return emptyResult(StateUnparsable)
		}
		counts[severity] = canonicalIntegerValue(value, parsed)
	}

	rawFindings, ok := anySlice(data["findings"])
	if !ok {
		return emptyResult(StateUnparsable)
	}
	findings := make([]map[string]any, len(rawFindings))
	observed := zeroCounts()
	for index, rawFinding := range rawFindings {
		finding, valid := stringMap(rawFinding)
		if !valid || !validFinding(finding) {
			return emptyResult(StateUnparsable)
		}
		finding = cloneMap(finding)
		line, _ := integerValue(finding["line"])
		finding["line"] = canonicalIntegerValue(finding["line"], line)
		if endLine, present := finding["end_line"]; present {
			parsedEndLine, _ := integerValue(endLine)
			finding["end_line"] = canonicalIntegerValue(endLine, parsedEndLine)
		}
		findings[index] = finding
		severity := finding["severity"].(string)
		observed[severity] = observed[severity].(int) + 1
	}
	if !sameCounts(counts, observed) {
		state = StateUnparsable
	}
	if state == StateComplete && len(findings) > 0 {
		state = StateFindings
	}

	verification, ok := optionalMapSlice(data, "verification")
	if !ok {
		return emptyResult(StateUnparsable)
	}
	for _, item := range verification {
		if !validVerification(item) {
			return emptyResult(StateUnparsable)
		}
	}

	provenance, ok := optionalMap(data, "provenance")
	if !ok {
		return emptyResult(StateUnparsable)
	}
	if len(provenance) > 0 && (!nonEmptyText(provenance["backend"]) || !nonEmptyText(provenance["model"])) {
		return emptyResult(StateUnparsable)
	}

	overlap, ok := optionalMap(data, "overlap")
	if !ok {
		return emptyResult(StateUnparsable)
	}
	if len(overlap) > 0 && !validOverlap(overlap) {
		return emptyResult(StateUnparsable)
	}
	overlap = normalizedOverlap(overlap)

	live, ok := optionalMap(data, "live")
	if !ok {
		return emptyResult(StateUnparsable)
	}

	rawEvidence, ok := optionalRawEvidence(data, "raw_evidence")
	if !ok {
		return emptyResult(StateUnparsable)
	}

	if state == StateComplete && hasUnverified(verification) {
		state = StateIncomplete
	}

	return ReviewResult{
		Version:      1,
		State:        state,
		Counts:       counts,
		Findings:     findings,
		Verification: verification,
		Provenance:   provenance,
		Overlap:      overlap,
		Live:         live,
		RawEvidence:  boundRawEvidence(rawEvidence),
	}
}

func FromDict(data map[string]any) ReviewResult {
	return FromMap(data)
}

func ParseReviewResult(payload any, rawEvidence ...any) ReviewResult {
	text, ok := payloadText(payload)
	if !ok {
		return unparsableWithEvidence("", rawEvidence)
	}
	if utf8.RuneCountInString(text) > MaxRawChars {
		return unparsableWithEvidence(text, rawEvidence)
	}

	decoder := json.NewDecoder(strings.NewReader(text))
	decoder.UseNumber()
	var value any
	if err := decoder.Decode(&value); err != nil {
		return unparsableWithEvidence(text, rawEvidence)
	}
	var extra any
	if err := decoder.Decode(&extra); err != io.EOF {
		return unparsableWithEvidence(text, rawEvidence)
	}

	data, ok := value.(map[string]any)
	if !ok {
		return unparsableWithEvidence(text, rawEvidence)
	}
	result := FromMap(data)
	if result.State == StateUnparsable {
		return unparsableWithEvidence(text, rawEvidence)
	}
	return result
}

func (r ReviewResult) IsClean() bool {
	if r.State != StateComplete || len(r.Findings) != 0 {
		return false
	}
	for _, severity := range severityNames {
		count, ok := integerValue(r.Counts[severity])
		if !ok || count.Sign() != 0 {
			return false
		}
	}
	return true
}

func (r ReviewResult) ToJSON() string {
	encoded, err := marshalCanonicalJSON(r.semanticMap())
	if err != nil {
		return ""
	}
	return string(encoded)
}

func (r ReviewResult) MarshalJSON() ([]byte, error) {
	return marshalCanonicalJSON(r.semanticMap())
}

func (r ReviewResult) semanticMap() map[string]any {
	return map[string]any{
		"counts":       r.Counts,
		"findings":     r.Findings,
		"live":         r.Live,
		"overlap":      r.Overlap,
		"provenance":   r.Provenance,
		"raw_evidence": r.RawEvidence,
		"state":        r.State,
		"verification": r.Verification,
		"version":      r.Version,
	}
}

func knownState(state State) bool {
	switch state {
	case StateComplete, StateFindings, StateIncomplete, StateFailed, StateUnparsable:
		return true
	default:
		return false
	}
}

func validFinding(finding map[string]any) bool {
	severity, severityOK := finding["severity"].(string)
	file, fileOK := finding["file"].(string)
	title, titleOK := finding["title"].(string)
	line, lineOK := integerValue(finding["line"])
	if !severityOK || !contains(severityNames[:], severity) ||
		!fileOK || strings.TrimSpace(file) == "" ||
		!titleOK || strings.TrimSpace(title) == "" ||
		!lineOK || line.Cmp(big.NewInt(1)) < 0 {
		return false
	}
	if rawEndLine, present := finding["end_line"]; present {
		endLine, valid := integerValue(rawEndLine)
		if !valid || endLine.Cmp(line) < 0 {
			return false
		}
	}
	return true
}

func validVerification(item map[string]any) bool {
	name, nameOK := item["name"].(string)
	state, stateOK := item["state"].(string)
	evidence, evidenceOK := item["evidence"].(string)
	if !nameOK || strings.TrimSpace(name) == "" ||
		!stateOK || !containsMapKey(verificationStates, state) ||
		!evidenceOK || strings.TrimSpace(evidence) == "" {
		return false
	}
	return true
}

func validOverlap(overlap map[string]any) bool {
	rawDuplicates, duplicatesOK := overlap["duplicates"]
	rawSharedFiles, sharedFilesOK := overlap["shared_files"]
	duplicates, duplicatesSliceOK := anySlice(rawDuplicates)
	sharedFiles, sharedFilesSliceOK := anySlice(rawSharedFiles)
	if !duplicatesOK || !sharedFilesOK || !duplicatesSliceOK || !sharedFilesSliceOK {
		return false
	}
	for _, duplicate := range duplicates {
		_, ok := integerValue(duplicate)
		if !ok {
			return false
		}
	}
	for _, sharedFile := range sharedFiles {
		if !nonEmptyText(sharedFile) {
			return false
		}
	}
	return true
}

func optionalMap(data map[string]any, key string) (map[string]any, bool) {
	value, present := data[key]
	if !present {
		return map[string]any{}, true
	}
	return stringMap(value)
}

func optionalMapSlice(data map[string]any, key string) ([]map[string]any, bool) {
	value, present := data[key]
	if !present {
		return []map[string]any{}, true
	}
	values, ok := anySlice(value)
	if !ok {
		return nil, false
	}
	result := make([]map[string]any, len(values))
	for index, item := range values {
		converted, valid := stringMap(item)
		if !valid {
			return nil, false
		}
		result[index] = converted
	}
	return result, true
}

func optionalRawEvidence(data map[string]any, key string) ([]string, bool) {
	value, present := data[key]
	if !present {
		return []string{}, true
	}
	return rawLines(value)
}

func stringMap(value any) (map[string]any, bool) {
	converted, ok := value.(map[string]any)
	return converted, ok
}

func cloneMap(value map[string]any) map[string]any {
	cloned := make(map[string]any, len(value))
	for key, item := range value {
		cloned[key] = item
	}
	return cloned
}

func normalizedOverlap(overlap map[string]any) map[string]any {
	normalized := cloneMap(overlap)
	duplicates, ok := anySlice(normalized["duplicates"])
	if !ok {
		return normalized
	}
	copiedDuplicates := append([]any{}, duplicates...)
	for index, duplicate := range copiedDuplicates {
		parsed, valid := integerValue(duplicate)
		if valid {
			copiedDuplicates[index] = canonicalIntegerValue(duplicate, parsed)
		}
	}
	normalized["duplicates"] = copiedDuplicates
	return normalized
}

func anySlice(value any) ([]any, bool) {
	switch values := value.(type) {
	case []any:
		return values, true
	case []map[string]any:
		converted := make([]any, len(values))
		for index, item := range values {
			converted[index] = item
		}
		return converted, true
	case []string:
		converted := make([]any, len(values))
		for index, item := range values {
			converted[index] = item
		}
		return converted, true
	default:
		return nil, false
	}
}

func integerValue(value any) (*big.Int, bool) {
	switch typed := value.(type) {
	case bool:
		return nil, false
	case int:
		return big.NewInt(int64(typed)), true
	case int8:
		return big.NewInt(int64(typed)), true
	case int16:
		return big.NewInt(int64(typed)), true
	case int32:
		return big.NewInt(int64(typed)), true
	case int64:
		return big.NewInt(typed), true
	case uint:
		return new(big.Int).SetUint64(uint64(typed)), true
	case uint8:
		return new(big.Int).SetUint64(uint64(typed)), true
	case uint16:
		return new(big.Int).SetUint64(uint64(typed)), true
	case uint32:
		return new(big.Int).SetUint64(uint64(typed)), true
	case uint64:
		return new(big.Int).SetUint64(typed), true
	case json.Number:
		text := string(typed)
		if !isJSONInteger(text) {
			return nil, false
		}
		parsed, ok := new(big.Int).SetString(text, 10)
		if !ok {
			return nil, false
		}
		return parsed, true
	default:
		return nil, false
	}
}

func isJSONInteger(value string) bool {
	if value == "" {
		return false
	}
	start := 0
	if value[0] == '-' {
		start++
		if start == len(value) {
			return false
		}
	}
	if value[start] == '0' {
		return start+1 == len(value)
	}
	if value[start] < '1' || value[start] > '9' {
		return false
	}
	for index := start + 1; index < len(value); index++ {
		if value[index] < '0' || value[index] > '9' {
			return false
		}
	}
	return true
}

func canonicalIntegerValue(value any, parsed *big.Int) any {
	switch value.(type) {
	case int, int8, int16, int32, int64, uint, uint8, uint16, uint32, uint64:
		return value
	default:
		return json.Number(parsed.String())
	}
}

func nonEmptyText(value any) bool {
	text, ok := value.(string)
	return ok && strings.TrimSpace(text) != ""
}

func sameCounts(left, right map[string]any) bool {
	for _, severity := range severityNames {
		leftValue, leftOK := integerValue(left[severity])
		rightValue, rightOK := integerValue(right[severity])
		if !leftOK || !rightOK || leftValue.Cmp(rightValue) != 0 {
			return false
		}
	}
	return true
}

func hasUnverified(verification []map[string]any) bool {
	for _, item := range verification {
		if item["state"] == "unverified" {
			return true
		}
	}
	return false
}

func unparsableWithEvidence(payload string, rawEvidence []any) ReviewResult {
	candidate := any(payload)
	if len(rawEvidence) > 0 && rawEvidence[0] != nil {
		candidate = rawEvidence[0]
	}
	lines, ok := rawLines(candidate)
	if !ok {
		lines, _ = rawLines(payload)
	}
	result := emptyResult(StateUnparsable)
	result.RawEvidence = boundRawEvidence(lines)
	return result
}

func payloadText(value any) (string, bool) {
	switch typed := value.(type) {
	case string:
		return typed, true
	case []byte:
		return string(typed), true
	default:
		return "", false
	}
}

func rawLines(value any) ([]string, bool) {
	switch typed := value.(type) {
	case nil:
		return []string{}, true
	case string:
		return splitLines(typed), true
	case []string:
		return append([]string{}, typed...), true
	case []any:
		lines := make([]string, len(typed))
		for index, line := range typed {
			text, ok := line.(string)
			if !ok {
				return nil, false
			}
			lines[index] = text
		}
		return lines, true
	default:
		return nil, false
	}
}

func boundRawEvidence(lines []string) []string {
	text := strings.Join(lines, "\n")
	runes := []rune(text)
	if len(runes) > MaxRawChars {
		runes = runes[:MaxRawChars]
	}
	bounded := splitLines(string(runes))
	if len(bounded) > MaxRawLines {
		bounded = bounded[:MaxRawLines]
	}
	return bounded
}

func splitLines(value string) []string {
	runes := []rune(value)
	if len(runes) == 0 {
		return []string{}
	}
	lines := make([]string, 0)
	start := 0
	for index := 0; index < len(runes); index++ {
		if !isLineBreak(runes[index]) {
			continue
		}
		lines = append(lines, string(runes[start:index]))
		if runes[index] == '\r' && index+1 < len(runes) && runes[index+1] == '\n' {
			index++
		}
		start = index + 1
	}
	if start < len(runes) {
		lines = append(lines, string(runes[start:]))
	}
	return lines
}

func isLineBreak(value rune) bool {
	switch value {
	case '\n', '\r', '\v', '\f', '\u0085', '\u2028', '\u2029', '\u001c', '\u001d', '\u001e':
		return true
	default:
		return false
	}
}

func contains(values []string, target string) bool {
	for _, value := range values {
		if value == target {
			return true
		}
	}
	return false
}

func containsMapKey(values map[string]struct{}, target string) bool {
	_, ok := values[target]
	return ok
}
