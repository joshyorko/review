/** Qualify the configured native MCP tool contract, never a model assertion. */
export function mcpExpectedHeadQualified(tools: readonly unknown[], name: string): boolean {
	const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
	return tools.some((tool) => {
		if (!record(tool) || tool.name !== name || tool.mcpServerName !== "github" || tool.mcpToolName !== "merge_pull_request" || !record(tool.parameters) || !record(tool.parameters.properties)) return false;
		const sha = tool.parameters.properties.sha;
		return record(sha) && sha.type === "string" && typeof sha.description === "string" && /head/i.test(sha.description) && /match/i.test(sha.description);
	});
}
