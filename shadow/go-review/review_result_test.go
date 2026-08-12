package review

import (
	"bytes"
	"encoding/json"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

type fixtureCase struct {
	Name     string          `json:"name"`
	Payload  json.RawMessage `json:"payload"`
	Expected struct {
		IsClean bool            `json:"is_clean"`
		State   State           `json:"state"`
		Result  json.RawMessage `json:"result"`
	} `json:"expected"`
}

func TestSharedFixturesMatchReviewResultContract(t *testing.T) {
	fixtures, err := os.ReadFile(filepath.Join("testdata", "review-result-cases.json"))
	if err != nil {
		t.Fatal(err)
	}
	var cases []fixtureCase
	if err := json.Unmarshal(fixtures, &cases); err != nil {
		t.Fatal(err)
	}

	for _, testCase := range cases {
		t.Run(testCase.Name, func(t *testing.T) {
			payload := fixturePayload(t, testCase.Payload)
			result := ParseReviewResult(payload)
			if result.State != testCase.Expected.State {
				t.Fatalf("state = %q, want %q", result.State, testCase.Expected.State)
			}
			if result.IsClean() != testCase.Expected.IsClean {
				t.Fatalf("is clean = %v, want %v", result.IsClean(), testCase.Expected.IsClean)
			}
			got := canonicalJSON(t, []byte(result.ToJSON()))
			want := canonicalJSON(t, testCase.Expected.Result)
			if !bytes.Equal(got, want) {
				t.Fatalf("serialized result = %s, want %s", got, want)
			}
			if result.State != StateUnparsable {
				roundTrip := ParseReviewResult(result.ToJSON())
				if roundTrip.State != result.State {
					t.Fatalf("round-trip state = %q, want %q", roundTrip.State, result.State)
				}
				if gotRoundTrip := canonicalJSON(t, []byte(roundTrip.ToJSON())); !bytes.Equal(got, gotRoundTrip) {
					t.Fatalf("round-trip result = %s, want %s", gotRoundTrip, got)
				}
			}
		})
	}
}

func TestBoundaryPayloadsFailClosed(t *testing.T) {
	clean := `{"counts":{"critical":0,"high":0,"low":0,"medium":0},"findings":[],"state":"complete","version":1}`
	for _, testCase := range []struct {
		name    string
		payload string
	}{
		{name: "deep JSON", payload: strings.Repeat("[", 2_000) + strings.Repeat("]", 2_000)},
		{name: "oversized JSON", payload: strings.Repeat("x", MaxRawChars+1)},
		{name: "trailing JSON", payload: clean + " {}"},
	} {
		t.Run(testCase.name, func(t *testing.T) {
			result := ParseReviewResult(testCase.payload)
			if result.State != StateUnparsable || result.IsClean() {
				t.Fatalf("result = %#v, want an unparsable non-clean result", result)
			}
			if testCase.name == "oversized JSON" {
				if len(result.RawEvidence) != 1 || len([]rune(result.RawEvidence[0])) != MaxRawChars {
					t.Fatalf("oversized raw evidence = %#v, want one %d-character line", result.RawEvidence, MaxRawChars)
				}
			}
		})
	}
}

func TestTruncatedCleanPayloadsNeverBecomeClean(t *testing.T) {
	clean := `{"counts":{"critical":0,"high":0,"low":0,"medium":0},"findings":[],"state":"complete","version":1}`
	for end := 0; end < len(clean); end++ {
		if result := ParseReviewResult(clean[:end]); result.IsClean() {
			t.Fatalf("truncated payload at byte %d became clean", end)
		}
	}
}

func TestRoundTripPreservesValidatedFields(t *testing.T) {
	payload := `{"counts":{"critical":0,"high":1,"low":0,"medium":0},"findings":[{"file":"review.go","line":7,"severity":"high","title":"unsafe path","extra":"kept"}],"live":{"ci":"failure"},"provenance":{"backend":"goose","model":"gpt-5.6-luna"},"state":"findings","version":1}`
	result := ParseReviewResult([]byte(payload))
	if result.State != StateFindings {
		t.Fatalf("state = %q, want findings", result.State)
	}
	roundTrip := ParseReviewResult(result.ToJSON())
	if roundTrip.State != StateFindings {
		t.Fatalf("round-trip state = %q, want findings", roundTrip.State)
	}
	if count, ok := integerValue(roundTrip.Counts["high"]); !ok || count.Int64() != 1 {
		t.Fatalf("round-trip high count = %#v, want 1", roundTrip.Counts["high"])
	}
	if roundTrip.Findings[0]["extra"] != "kept" {
		t.Fatalf("round-trip extra field = %v, want kept", roundTrip.Findings[0]["extra"])
	}
	if !bytes.Equal(canonicalJSON(t, []byte(result.ToJSON())), canonicalJSON(t, []byte(roundTrip.ToJSON()))) {
		t.Fatal("round-trip serialization changed the validated result")
	}
	if FromDict(map[string]any{"version": "wrong"}).State != StateUnparsable {
		t.Fatal("FromDict accepted an invalid result")
	}
}

func TestFromMapDoesNotMutateInput(t *testing.T) {
	data := map[string]any{
		"counts": map[string]any{
			"critical": json.Number("0"),
			"high":     json.Number("1"),
			"low":      json.Number("0"),
			"medium":   json.Number("0"),
		},
		"findings": []any{
			map[string]any{
				"file":     "review.go",
				"line":     json.Number("7"),
				"severity": "high",
				"title":    "unsafe path",
			},
		},
		"overlap": map[string]any{
			"duplicates":   []any{json.Number("-0")},
			"shared_files": []any{"review.go"},
		},
		"state":   "findings",
		"version": json.Number("1"),
	}
	before, err := json.Marshal(data)
	if err != nil {
		t.Fatal(err)
	}
	if result := FromMap(data); result.State != StateFindings {
		t.Fatalf("state = %q, want findings", result.State)
	}
	after, err := json.Marshal(data)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(after, before) {
		t.Fatalf("FromMap mutated input: before %s, after %s", before, after)
	}
}

func TestFromMapRejectsNonCanonicalIntegerNumbers(t *testing.T) {
	base := map[string]any{
		"counts": map[string]any{
			"critical": json.Number("0"),
			"high":     json.Number("0"),
			"low":      json.Number("0"),
			"medium":   json.Number("0"),
		},
		"findings": []any{},
		"state":    "complete",
		"version":  json.Number("1"),
	}
	for _, value := range []json.Number{"+1", "01", "-01", "1e0", "0.0"} {
		t.Run(string(value), func(t *testing.T) {
			data := cloneMap(base)
			counts := cloneMap(base["counts"].(map[string]any))
			counts["critical"] = value
			data["counts"] = counts
			if result := FromMap(data); result.State != StateUnparsable {
				t.Fatalf("state = %q, want unparsable for %q", result.State, value)
			}
		})
	}
}

func TestMalformedNestedFieldsFailClosed(t *testing.T) {
	base := `{"counts":{"critical":0,"high":1,"low":0,"medium":0},"findings":[{"file":"review.go","line":7,"severity":"high","title":"x"}],"state":"findings","version":1}`
	for _, malformed := range []string{
		strings.Replace(base, `"line":7`, `"line":"7"`, 1),
		strings.Replace(base, `"severity":"high"`, `"severity":"forged"`, 1),
		`{"counts":{"critical":0,"high":0,"low":0,"medium":0},"findings":[],"provenance":{"backend":"goose"},"state":"complete","version":1}`,
		`{"counts":{"critical":0,"high":0,"low":0,"medium":0},"findings":[],"raw_evidence":{"line":1},"state":"complete","version":1}`,
	} {
		if result := ParseReviewResult(malformed); result.State != StateUnparsable {
			t.Fatalf("state = %q, want unparsable for %s", result.State, malformed)
		}
	}
}

func TestRawEvidenceIsBoundedAndMalformedPayloadRetainsEvidence(t *testing.T) {
	lines := make([]string, MaxRawLines+1)
	for index := range lines {
		lines[index] = "evidence"
	}
	payload := strings.Join(lines, "\n")
	result := ParseReviewResult(payload)
	if result.State != StateUnparsable {
		t.Fatalf("state = %q, want unparsable", result.State)
	}
	if len(result.RawEvidence) != MaxRawLines {
		t.Fatalf("raw evidence lines = %d, want %d", len(result.RawEvidence), MaxRawLines)
	}

	result = ParseReviewResult("not json", map[string]any{"secret": "not text"})
	if result.State != StateUnparsable || len(result.RawEvidence) != 1 || result.RawEvidence[0] != "not json" {
		t.Fatalf("fallback raw evidence = %#v, want the payload line", result.RawEvidence)
	}
}

func FuzzParseReviewResultBounded(f *testing.F) {
	for _, seed := range []string{
		"",
		"not json",
		`{"counts":{"critical":0,"high":0,"low":0,"medium":0},"findings":[],"state":"complete","version":1}`,
		`{"counts":{"critical":0,"high":1,"low":0,"medium":0},"findings":[{"file":"x.go","line":1,"severity":"high","title":"x"}],"state":"findings","version":1}`,
		`{"counts":{"critical":0.0,"high":0,"low":0,"medium":0},"findings":[],"state":"complete","version":1}`,
		`{"counts":{"critical":0,"high":0,"low":0,"medium":0},"findings":[],"raw_evidence":"α\r\nβ γ","state":"complete","version":1}`,
		`{"counts":{"critical":0,"high":0,"low":0,"medium":0},"findings":[],"state":"complete","version":1} {}`,
		`{"counts":{"critical":0,"high":0,"low":0,"medium":0},"findings":[],"live":{"nested":{"value":1}},"state":"complete","version":1}`,
	} {
		f.Add(seed)
	}

	f.Fuzz(func(t *testing.T, payload string) {
		if len(payload) > MaxRawChars+1 {
			t.Skip()
		}
		result := ParseReviewResult(payload)
		if !json.Valid([]byte(payload)) && result.IsClean() {
			t.Fatal("malformed input became clean")
		}
		if result.State == StateUnparsable && result.IsClean() {
			t.Fatal("unparsable input became clean")
		}
		if result.IsClean() {
			roundTrip := ParseReviewResult(result.ToJSON())
			if !roundTrip.IsClean() || roundTrip.State != StateComplete {
				t.Fatalf("clean result did not survive serialization: %#v", roundTrip)
			}
		}
		if len(payload) > 0 {
			truncated := payload[:len(payload)-1]
			if !json.Valid([]byte(truncated)) && ParseReviewResult(truncated).IsClean() {
				t.Fatal("malformed or truncated input became clean")
			}
		}
	})
}

func FuzzTruncatedCleanPayloadNeverBecomesClean(f *testing.F) {
	clean := `{"counts":{"critical":0,"high":0,"low":0,"medium":0},"findings":[],"state":"complete","version":1}`
	for _, end := range []int{0, 1, len(clean) / 2, len(clean) - 1} {
		f.Add(end)
	}

	f.Fuzz(func(t *testing.T, end int) {
		end %= len(clean)
		if end < 0 {
			end = -end
		}
		if result := ParseReviewResult(clean[:end]); result.IsClean() {
			t.Fatalf("truncated clean payload at byte %d became clean", end)
		}
	})
}

func fixturePayload(t *testing.T, raw json.RawMessage) string {
	t.Helper()
	trimmed := bytes.TrimSpace(raw)
	if len(trimmed) > 0 && trimmed[0] == '"' {
		var literal string
		if err := json.Unmarshal(trimmed, &literal); err != nil {
			t.Fatal(err)
		}
		return literal
	}

	decoder := json.NewDecoder(bytes.NewReader(trimmed))
	decoder.UseNumber()
	var value any
	if err := decoder.Decode(&value); err != nil {
		t.Fatal(err)
	}
	encoded, err := json.Marshal(value)
	if err != nil {
		t.Fatal(err)
	}
	return string(encoded)
}

func canonicalJSON(t *testing.T, raw []byte) []byte {
	t.Helper()
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.UseNumber()
	var value any
	if err := decoder.Decode(&value); err != nil {
		t.Fatal(err)
	}
	var extra any
	if err := decoder.Decode(&extra); err != io.EOF {
		t.Fatal(err)
	}
	encoded, err := json.Marshal(value)
	if err != nil {
		t.Fatal(err)
	}
	return encoded
}
