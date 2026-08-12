package review

import (
	"context"
	"strings"
	"testing"
	"time"

	"github.com/modelcontextprotocol/go-sdk/mcp"
)

func TestMCPReadOnlyServerListsAndPreviewsWithoutMutationTools(t *testing.T) {
	runtime, err := NewReviewRuntime(StaticRuntimeSource{Value: RuntimeSnapshot{
		Reviews: []RuntimeReview{{
			ID: "review-1", Repository: "octo/sample", PullRequest: 17,
			HeadSHA: strings.Repeat("a", 40), Title: "clean review",
			Result: emptyResult(StateComplete),
		}},
	}}, RuntimeLimits{Timeout: time.Second, MaxItems: 10})
	if err != nil {
		t.Fatal(err)
	}
	server, err := NewMCPReadOnlyServer(runtime)
	if err != nil {
		t.Fatal(err)
	}
	if got := server.ToolNames(); len(got) != 3 ||
		got[0] != "review_list" || got[1] != "review_get" || got[2] != "review_preview" {
		t.Fatalf("tool names = %#v", got)
	}

	serverTransport, clientTransport := mcp.NewInMemoryTransports()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	serverErr := make(chan error, 1)
	go func() { serverErr <- server.Run(ctx, serverTransport) }()

	client := mcp.NewClient(&mcp.Implementation{Name: "shadow-test", Version: "1"}, nil)
	session, err := client.Connect(ctx, clientTransport, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer session.Close()

	tools, err := session.ListTools(ctx, nil)
	if err != nil {
		t.Fatal(err)
	}
	if len(tools.Tools) != 3 {
		t.Fatalf("MCP tools = %#v", tools.Tools)
	}
	for _, tool := range tools.Tools {
		if strings.Contains(tool.Name, "execute") || strings.Contains(tool.Name, "merge") {
			t.Fatalf("mutation tool registered: %q", tool.Name)
		}
	}
	listResult, err := session.CallTool(ctx, &mcp.CallToolParams{
		Name: "review_list", Arguments: map[string]any{"limit": 1},
	})
	if err != nil {
		t.Fatal(err)
	}
	if listResult.IsError || listResult.StructuredContent == nil {
		t.Fatalf("list result = %#v", listResult)
	}
	previewResult, err := session.CallTool(ctx, &mcp.CallToolParams{
		Name:      "review_preview",
		Arguments: map[string]any{"id": "review-1", "decision": "approve"},
	})
	if err != nil {
		t.Fatal(err)
	}
	if previewResult.IsError || previewResult.StructuredContent == nil {
		t.Fatalf("preview result = %#v", previewResult)
	}
	if err := session.Close(); err != nil {
		t.Fatal(err)
	}
	cancel()
	select {
	case <-serverErr:
	case <-time.After(time.Second):
		t.Fatal("MCP server did not stop after client close")
	}
}
