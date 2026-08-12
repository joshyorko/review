package review

import (
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

type evidenceManifestFixture struct {
	Name               string                 `json:"name"`
	Request            evidenceRequestFixture `json:"request"`
	Entries            []evidenceEntryFixture `json:"entries"`
	OrganizationPolicy *evidenceEntryFixture  `json:"organization_policy"`
	Expected           json.RawMessage        `json:"expected"`
}

type evidenceRequestFixture struct {
	Owner             string `json:"owner"`
	Repository        string `json:"repository"`
	PullRequestNumber int    `json:"pull_request_number"`
	BaseSHA           string `json:"base_sha"`
	HeadSHA           string `json:"head_sha"`
	Actor             string `json:"actor"`
	Tenant            string `json:"tenant"`
	Installation      string `json:"installation"`
	GeneratedAt       string `json:"generated_at"`
	Focus             string `json:"focus"`
	Steering          string `json:"steering"`
	Version           int    `json:"version"`
}

type evidenceEntryFixture struct {
	Kind          string           `json:"kind"`
	Provenance    string           `json:"provenance"`
	Trust         TrustClass       `json:"trust"`
	Availability  Availability     `json:"availability"`
	Phase         EvidencePhase    `json:"phase"`
	Summary       string           `json:"summary"`
	Handles       []EvidenceHandle `json:"handles"`
	UntrustedText *string          `json:"untrusted_text"`
}

func TestEvidenceManifestFixturesMatchCanonicalSemanticJSON(t *testing.T) {
	raw, err := os.ReadFile(filepath.Join("testdata", "evidence-manifest-cases.json"))
	if err != nil {
		t.Fatal(err)
	}
	var fixtures []evidenceManifestFixture
	if err := json.Unmarshal(raw, &fixtures); err != nil {
		t.Fatal(err)
	}
	for _, fixture := range fixtures {
		t.Run(fixture.Name, func(t *testing.T) {
			manifest := fixtureManifest(t, fixture)
			got, err := manifest.SemanticJSON()
			if err != nil {
				t.Fatal(err)
			}
			if want := canonicalJSON(t, fixture.Expected); !bytes.Equal(canonicalJSON(t, []byte(got)), want) {
				t.Fatalf("semantic JSON = %s, want %s", canonicalJSON(t, []byte(got)), want)
			}
		})
	}
}

func TestEvidenceManifestScopeDeliveryIsExact(t *testing.T) {
	request := NewReviewRequest(
		"octo", "sample", 17,
		"0123456789abcdef0123456789abcdef01234567",
		"89abcdef0123456789abcdef0123456789abcdef",
		"actor", "tenant", "now",
	)
	manifest := NewReviewEvidenceManifest(request, nil)
	received := 0
	harness := manifestHarnessFunc(func(value ReviewEvidenceManifest) error {
		received++
		if value.Request != request {
			t.Fatal("harness received a different manifest")
		}
		return nil
	})
	if err := manifest.DeliverTo(harness, request.Scope()); err != nil {
		t.Fatal(err)
	}
	if received != 1 {
		t.Fatalf("received = %d, want 1", received)
	}
	if err := manifest.DeliverTo(harness, ReviewScope{Actor: "actor", Tenant: "other"}); err == nil {
		t.Fatal("cross-tenant delivery was accepted")
	}
}

func TestEvidenceManifestRejectsMalformedAndOversizedValues(t *testing.T) {
	valid := NewReviewRequest(
		"octo", "sample", 17,
		"0000000000000000000000000000000000000000",
		"1111111111111111111111111111111111111111",
		"actor", "tenant", "now",
	)
	validEntry := EvidenceEntry{
		Kind: "source", Provenance: "checkout", Trust: TrustRepository,
		Availability: AvailabilityAvailable, Phase: EvidenceSnapshot,
	}
	cases := []struct {
		name  string
		check func() error
	}{
		{
			name: "invalid request head",
			check: func() error {
				request := valid
				request.HeadSHA = "not-a-sha"
				return NewReviewEvidenceManifest(request, nil).Validate()
			},
		},
		{
			name: "unknown enum",
			check: func() error {
				entry := validEntry
				entry.Trust = TrustClass("forged")
				return NewReviewEvidenceManifest(valid, []EvidenceEntry{entry}).Validate()
			},
		},
		{
			name: "trusted inline review text",
			check: func() error {
				entry := validEntry
				text := "untrusted"
				entry.UntrustedText = &text
				return NewReviewEvidenceManifest(valid, []EvidenceEntry{entry}).Validate()
			},
		},
		{
			name: "too many handles",
			check: func() error {
				entry := validEntry
				entry.Handles = make([]EvidenceHandle, maxEntryHandles+1)
				return NewReviewEvidenceManifest(valid, []EvidenceEntry{entry}).Validate()
			},
		},
		{
			name: "too many entries",
			check: func() error {
				entries := make([]EvidenceEntry, maxManifestEntries+1)
				for index := range entries {
					entries[index] = validEntry
				}
				return NewReviewEvidenceManifest(valid, entries).Validate()
			},
		},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			if err := testCase.check(); err == nil {
				t.Fatal("malformed value was accepted")
			}
		})
	}
}

func TestEvidenceHandleDefaultAndExplicitBounds(t *testing.T) {
	defaultHandle := NewEvidenceHandle("checkout://review", "source")
	if defaultHandle.MaxBytes != 4096 {
		t.Fatalf("default max bytes = %d, want 4096", defaultHandle.MaxBytes)
	}
	if err := defaultHandle.Validate(); err != nil {
		t.Fatal(err)
	}
	explicitZero := NewEvidenceHandle("checkout://review", "source", 0)
	if err := explicitZero.Validate(); err == nil {
		t.Fatal("an explicit zero bound was accepted")
	}
}

func TestUntrustedManifestTextIsNotSerialized(t *testing.T) {
	secret := "review instructions supplied by the pull request"
	entry := EvidenceEntry{
		Kind: "pull-request-body", Provenance: "github:pull-request",
		Trust: TrustUntrusted, Availability: AvailabilityAvailable,
		Phase: EvidenceSnapshot, Summary: "must not be rendered",
		UntrustedText: &secret,
	}
	request := NewReviewRequest(
		"octo", "sample", 17,
		"0000000000000000000000000000000000000000",
		"1111111111111111111111111111111111111111",
		"actor", "tenant", "now",
	)
	encoded, err := NewReviewEvidenceManifest(request, []EvidenceEntry{entry}).SemanticJSON()
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(encoded, secret) || strings.Contains(encoded, "must not be rendered") || strings.Contains(encoded, "untrusted_text") {
		t.Fatalf("untrusted text leaked into semantic JSON: %s", encoded)
	}
}

func FuzzEvidenceManifestValidationDoesNotPanic(f *testing.F) {
	for _, seed := range []string{"", "forged", strings.Repeat("x", 4097), "é"} {
		f.Add(seed)
	}
	f.Fuzz(func(t *testing.T, value string) {
		request := NewReviewRequest(
			value, "sample", 17,
			"0000000000000000000000000000000000000000",
			"1111111111111111111111111111111111111111",
			"actor", "tenant", "now",
		)
		entry := EvidenceEntry{
			Kind: value, Provenance: "checkout", Trust: TrustRepository,
			Availability: AvailabilityAvailable, Phase: EvidenceSnapshot,
			Summary: value,
		}
		manifest := NewReviewEvidenceManifest(request, []EvidenceEntry{entry})
		_ = manifest.Validate()
		_, _ = manifest.SemanticJSON()
	})
}

type manifestHarnessFunc func(ReviewEvidenceManifest) error

func (function manifestHarnessFunc) Receive(manifest ReviewEvidenceManifest) error {
	return function(manifest)
}

func fixtureManifest(t *testing.T, fixture evidenceManifestFixture) ReviewEvidenceManifest {
	t.Helper()
	request := ReviewRequest{
		Owner: fixture.Request.Owner, Repository: fixture.Request.Repository,
		PullRequestNumber: fixture.Request.PullRequestNumber, BaseSHA: fixture.Request.BaseSHA,
		HeadSHA: fixture.Request.HeadSHA, Actor: fixture.Request.Actor, Tenant: fixture.Request.Tenant,
		Installation: fixture.Request.Installation, GeneratedAt: fixture.Request.GeneratedAt,
		Focus: fixture.Request.Focus, Steering: fixture.Request.Steering, Version: fixture.Request.Version,
	}
	entries := make([]EvidenceEntry, len(fixture.Entries))
	for index, entry := range fixture.Entries {
		entries[index] = EvidenceEntry{
			Kind: entry.Kind, Provenance: entry.Provenance, Trust: entry.Trust,
			Availability: entry.Availability, Phase: entry.Phase, Summary: entry.Summary,
			Handles: append([]EvidenceHandle(nil), entry.Handles...), UntrustedText: cloneString(entry.UntrustedText),
		}
	}
	var policy *EvidenceEntry
	if fixture.OrganizationPolicy != nil {
		value := fixture.OrganizationPolicy
		policy = &EvidenceEntry{
			Kind: value.Kind, Provenance: value.Provenance, Trust: value.Trust,
			Availability: value.Availability, Phase: value.Phase, Summary: value.Summary,
			Handles:       append([]EvidenceHandle(nil), value.Handles...),
			UntrustedText: cloneString(value.UntrustedText),
		}
	}
	return ReviewEvidenceManifest{Request: request, Entries: entries, OrganizationPolicy: policy, Version: 1}
}
