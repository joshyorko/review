package review

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

type fixtureCase struct {
	Name     string          `json:"name"`
	Payload  json.RawMessage `json:"payload"`
	Expected struct {
		IsClean bool  `json:"is_clean"`
		State   State `json:"state"`
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
			payload := string(testCase.Payload)
			var literal string
			if len(testCase.Payload) > 0 && testCase.Payload[0] == '"' {
				if err := json.Unmarshal(testCase.Payload, &literal); err != nil {
					t.Fatal(err)
				}
				payload = literal
			}
			result := ParseReviewResult(payload)
			if result.State != testCase.Expected.State {
				t.Fatalf("state = %q, want %q", result.State, testCase.Expected.State)
			}
			if result.IsClean() != testCase.Expected.IsClean {
				t.Fatalf("is clean = %v, want %v", result.IsClean(), testCase.Expected.IsClean)
			}
		})
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
	if roundTrip.Counts["high"] != 1 {
		t.Fatalf("round-trip high count = %d, want 1", roundTrip.Counts["high"])
	}
	if roundTrip.Findings[0]["extra"] != "kept" {
		t.Fatalf("round-trip extra field = %v, want kept", roundTrip.Findings[0]["extra"])
	}
	if FromDict(map[string]any{"version": "wrong"}).State != StateUnparsable {
		t.Fatal("FromDict accepted an invalid result")
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
