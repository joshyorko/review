import { createServer } from "node:http";

const port = Number.parseInt(process.env.LUNA_PROBE_PORT ?? "43127", 10);
let requestNumber = 0;

function jsonBody(value) {
	return JSON.stringify(value);
}

function toolNames(body) {
	return Array.isArray(body.tools)
		? body.tools
				.filter((tool) => tool && typeof tool === "object" && typeof tool.function?.name === "string")
				.map((tool) => tool.function.name)
		: [];
}

function messageText(message) {
	if (typeof message?.content === "string") return message.content;
	if (!Array.isArray(message?.content)) return "";
	return message.content
		.filter((part) => part && typeof part === "object" && part.type === "text" && typeof part.text === "string")
		.map((part) => part.text)
		.join(" ");
}

function lastTool(body) {
	const messages = Array.isArray(body.messages) ? body.messages : [];
	for (let index = messages.length - 1; index >= 0; index -= 1) {
		const message = messages[index];
		if (message && typeof message === "object" && message.role === "tool" && typeof message.name === "string") return message.name;
	}
	return undefined;
}

function lastAssistantTool(body) {
	const messages = Array.isArray(body.messages) ? body.messages : [];
	for (let index = messages.length - 1; index >= 0; index -= 1) {
		const message = messages[index];
		if (message?.role !== "assistant" || !Array.isArray(message.tool_calls)) continue;
		const call = message.tool_calls.at(-1);
		if (typeof call?.function?.name === "string") return call.function.name;
	}
	return undefined;
}

function lastToolResultSummary(body) {
	const messages = Array.isArray(body.messages) ? body.messages : [];
	const message = [...messages].reverse().find((candidate) => candidate?.role === "tool");
	if (!message || typeof message !== "object") return null;
	return {
		isError: message.is_error === true,
		contentLength: typeof message.content === "string" ? message.content.length : null,
		contentPreview:
			typeof message.content === "string" ? message.content.slice(0, 180).replaceAll(/\s+/g, " ") : null,
		hasDetails: message.details !== undefined,
		asyncJobId: message.details?.async?.jobId ?? null,
		resultIds: Array.isArray(message.details?.results)
			? message.details.results.map((result) => result?.id).filter((id) => typeof id === "string").slice(0, 8)
			: [],
	};
}

function isFactoryRoot(body) {
	const rootMarker = Array.isArray(body.messages)
		&& body.messages.some((message) => message?.role === "user" && messageText(message).includes("LUNA_FACTORY_PROBE_ROOT"));
	return rootMarker && toolNames(body).includes("luna_factory_open");
}

function functionCall(name, args) {
	const base = {
		id: `probe-${requestNumber}`,
		object: "chat.completion.chunk",
		created: Math.floor(Date.now() / 1000),
		model: "deterministic",
	};
	return [
		{
			...base,
			choices: [
				{
					index: 0,
					delta: {
						role: "assistant",
						tool_calls: [
							{
								index: 0,
								id: `call-${requestNumber}`,
								type: "function",
								function: { name, arguments: JSON.stringify(args) },
							},
						],
					},
				},
			],
		},
		{
			...base,
			choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
		},
	];
}

function textCompletion(text) {
	return {
		id: `probe-${requestNumber}`,
		object: "chat.completion.chunk",
		created: Math.floor(Date.now() / 1000),
		model: "deterministic",
		choices: [
			{ index: 0, delta: { role: "assistant", content: text }, finish_reason: "stop" },
		],
	};
}

function responseFor(body) {
	if (!isFactoryRoot(body)) return textCompletion("worker result from the exact packaged OMP probe");
	const previous = lastTool(body) ?? lastAssistantTool(body);
	const base = "a".repeat(40);
	if (previous === undefined) {
		return functionCall("luna_factory_open", {
			input: JSON.stringify({
				objective: "probe the native task route",
				criteria: [{ id: "A1", statement: "the native task route is exercised" }],
				repo: "example/repo",
				base,
			}),
		});
	}
	if (previous === "luna_factory_open") {
		return functionCall("luna_factory_candidate", {
			input: JSON.stringify({
				taskId: "T1",
				generation: "G1",
				criterionId: "A1",
				title: "exercise native task",
				deps: [],
				effect: "read",
				owner: "luna",
				necessity: "A1 is unproven",
			}),
		});
	}
	if (previous === "luna_factory_candidate") {
		return functionCall("luna_factory_attempt", {
			input: JSON.stringify({ taskId: "T1", attemptId: "T1-a1" }),
		});
	}
	if (previous === "luna_factory_attempt") {
		return functionCall("luna_factory_dispatch", {
			input: JSON.stringify({ taskId: "T1", attemptId: "T1-a1" }),
		});
	}
	if (previous === "luna_factory_dispatch") {
		return functionCall("task", {
			agent: "task",
			task: "Read the repository and report the native probe result. LUNA_FACTORY_DISPATCH task=T1 attempt=T1-a1 generation=G1",
		});
	}
	return textCompletion("native task route completed; worker result remains VERIFY until evidence is independently reconciled");
}

const server = createServer(async (request, response) => {
	if (request.method !== "POST" || request.url !== "/v1/chat/completions") {
		response.writeHead(404).end();
		return;
	}
	const chunks = [];
	for await (const chunk of request) chunks.push(chunk);
	let body;
	try {
		body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
	} catch {
		response.writeHead(400).end("invalid json");
		return;
	}
	requestNumber += 1;
	const names = toolNames(body);
	const messages = Array.isArray(body.messages) ? body.messages : [];
	console.error(
		JSON.stringify({
			request: requestNumber,
			factoryRoot: isFactoryRoot(body),
			hasTask: names.includes("task"),
			factoryTools: names.filter((name) => name.startsWith("luna_factory_")).sort(),
			messageCount: messages.length,
			lastRole: messages.at(-1)?.role ?? null,
			lastTool: lastTool(body) ?? null,
			lastAssistantTool: lastAssistantTool(body) ?? null,
			lastToolResult: lastToolResultSummary(body),
		}),
	);
	const payload = responseFor(body);
	response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
	for (const chunk of Array.isArray(payload) ? payload : [payload]) response.write(`data: ${jsonBody(chunk)}\n\n`);
	response.write("data: [DONE]\n\n");
	response.end();
});

server.listen(port, "127.0.0.1", () => {
	console.log(JSON.stringify({ ready: true, port }));
});
