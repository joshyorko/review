package review

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strconv"
	"strings"

	"github.com/modelcontextprotocol/go-sdk/mcp"
)

var readOnlyToolNames = []string{"review_list", "review_get", "review_preview"}

// MCPReadOnlyServer exposes inspection and dry-run preview only. It does not
// register an execute, approve, reject, merge, or mutation tool.
type MCPReadOnlyServer struct {
	server  *mcp.Server
	runtime *ReviewRuntime
}

func NewMCPReadOnlyServer(runtime *ReviewRuntime) (*MCPReadOnlyServer, error) {
	if runtime == nil {
		return nil, errors.New("runtime is required")
	}
	server := &MCPReadOnlyServer{
		server: mcp.NewServer(&mcp.Implementation{
			Name: "review-shadow", Version: "m1-m5-contract-lab",
			Description: "fork-local read-only review inspection and dry-run preview",
		}, nil),
		runtime: runtime,
	}
	server.registerTools()
	return server, nil
}

func (server *MCPReadOnlyServer) registerTools() {
	mcp.AddTool[map[string]any, map[string]any](
		server.server,
		&mcp.Tool{
			Name:        "review_list",
			Description: "List bounded review rows and their validated results.",
		},
		server.list,
	)
	mcp.AddTool[map[string]any, map[string]any](
		server.server,
		&mcp.Tool{
			Name:        "review_get",
			Description: "Get one validated review row by ID.",
		},
		server.get,
	)
	mcp.AddTool[map[string]any, map[string]any](
		server.server,
		&mcp.Tool{
			Name:        "review_preview",
			Description: "Build a read-only approve or reject dry-run preview.",
		},
		server.preview,
	)
}

func (server *MCPReadOnlyServer) Run(ctx context.Context, transport mcp.Transport) error {
	if server == nil || server.server == nil {
		return errors.New("MCP server is required")
	}
	return server.server.Run(ctx, transport)
}

func (server *MCPReadOnlyServer) ToolNames() []string {
	return append([]string(nil), readOnlyToolNames...)
}

func (server *MCPReadOnlyServer) list(
	ctx context.Context,
	_ *mcp.CallToolRequest,
	input map[string]any,
) (*mcp.CallToolResult, map[string]any, error) {
	limit := inputInt(input, "limit")
	snapshot, err := server.runtime.List(ctx, limit)
	if err != nil {
		return nil, nil, err
	}
	return nil, runtimeSnapshotPayload(snapshot), nil
}

func (server *MCPReadOnlyServer) get(
	ctx context.Context,
	_ *mcp.CallToolRequest,
	input map[string]any,
) (*mcp.CallToolResult, map[string]any, error) {
	id := inputText(input, "id")
	if id == "" {
		return nil, nil, errors.New("id is required")
	}
	item, err := server.runtime.Get(ctx, id)
	if err != nil {
		return nil, nil, err
	}
	return nil, runtimeReviewPayload(item), nil
}

func (server *MCPReadOnlyServer) preview(
	ctx context.Context,
	_ *mcp.CallToolRequest,
	input map[string]any,
) (*mcp.CallToolResult, map[string]any, error) {
	id := inputText(input, "id")
	decision := CockpitDecision(inputText(input, "decision"))
	if id == "" || (decision != CockpitDecisionApprove && decision != CockpitDecisionReject) {
		return nil, nil, errors.New("id and decision (approve or reject) are required")
	}
	preview, err := server.runtime.Preview(ctx, id, decision)
	if err != nil {
		return nil, nil, err
	}
	var output map[string]any
	if err := json.Unmarshal([]byte(preview.ToJSON()), &output); err != nil {
		return nil, nil, err
	}
	return nil, output, nil
}

func inputText(input map[string]any, key string) string {
	value, ok := input[key].(string)
	if !ok {
		return ""
	}
	return strings.TrimSpace(value)
}

func inputInt(input map[string]any, key string) int {
	value := input[key]
	switch typed := value.(type) {
	case int:
		return typed
	case int64:
		return int(typed)
	case float64:
		return int(typed)
	case json.Number:
		parsed, err := strconv.Atoi(string(typed))
		if err == nil {
			return parsed
		}
	}
	return 0
}

func runtimeSnapshotPayload(snapshot RuntimeSnapshot) map[string]any {
	reviews := make([]any, len(snapshot.Reviews))
	for index, item := range snapshot.Reviews {
		reviews[index] = runtimeReviewPayload(item)
	}
	capabilities := make([]any, len(snapshot.Capabilities))
	for index, capability := range snapshot.Capabilities {
		capabilities[index] = capability
	}
	provenance := make([]any, len(snapshot.Provenance))
	for index, record := range snapshot.Provenance {
		provenance[index] = record
	}
	return map[string]any{
		"reviews": reviews, "truncated": snapshot.Truncated,
		"capabilities": capabilities, "provenance": provenance,
	}
}

func runtimeReviewPayload(item RuntimeReview) map[string]any {
	provenance := make([]any, len(item.Provenance))
	for index, record := range item.Provenance {
		provenance[index] = record
	}
	return map[string]any{
		"id": item.ID, "repository": item.Repository, "pull_request": item.PullRequest,
		"head_sha": item.HeadSHA, "title": item.Title, "author": item.Author,
		"result": item.Result, "provenance": provenance,
	}
}

func (server *MCPReadOnlyServer) String() string {
	if server == nil {
		return "<nil>"
	}
	return fmt.Sprintf("MCPReadOnlyServer(%s)", strings.Join(server.ToolNames(), ","))
}
