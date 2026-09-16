import { createServer } from "node:http";

const port = Number.parseInt(process.env.LUNA_PROBE_PORT ?? "43127", 10);
const route = process.env.LUNA_PROBE_ROUTE ?? "native-task";
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

function assistantTools(body) {
	const messages = Array.isArray(body.messages) ? body.messages : [];
	return messages.flatMap((message) => {
		if (message?.role !== "assistant" || !Array.isArray(message.tool_calls)) return [];
		return message.tool_calls
			.map((call) => call?.function?.name)
			.filter((name) => typeof name === "string");
	});
}

function toolCallCount(body, name) {
	return assistantTools(body).filter((candidate) => candidate === name).length;
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

function probeReceipt(taskId, attemptId, criterionId) {
	return {
		version: 1,
		taskId,
		attemptId,
		generation: "G1",
		subject: { repo: "example/repo", base: "a".repeat(40) },
		result: `${criterionId} was verified by the deterministic packaged probe`,
		changed: ["src/probe.ts"],
		evidence: [`artifact://${taskId}.log`],
		tests: [{ command: `probe ${taskId}`, outcome: "pass", artifact: `artifact://${taskId}-test.log` }],
		cleanEnvironment: true,
		unresolved: [],
		next: "none",
		confidence: "high",
		routing: { requested: "local-probe/deterministic", effective: "local-probe/deterministic", verified: false },
		exitCode: 0,
		aborted: false,
		truncated: false,
	};
}

function responseForNativeBatch(body) {
	const previous = lastTool(body) ?? lastAssistantTool(body);
	const candidates = toolCallCount(body, "luna_factory_candidate");
	const attempts = toolCallCount(body, "luna_factory_attempt");
	const dispatches = toolCallCount(body, "luna_factory_dispatch");
	if (previous === undefined) {
		return functionCall("luna_factory_open", {
			input: JSON.stringify({
				objective: "probe native task batching",
				criteria: [
					{ id: "A1", statement: "first native branch is exercised" },
					{ id: "A2", statement: "second native branch is exercised" },
				],
				repo: "example/repo",
				base: "a".repeat(40),
			}),
		});
	}
	if (previous === "luna_factory_open") {
		return functionCall("luna_factory_candidate", {
			input: JSON.stringify({ taskId: "T1", generation: "G1", criterionId: "A1", title: "first native branch", deps: [], effect: "read", owner: "luna", necessity: "A1 is unproven" }),
		});
	}
	if (previous === "luna_factory_candidate" && candidates === 1) {
		return functionCall("luna_factory_candidate", {
			input: JSON.stringify({ taskId: "T2", generation: "G1", criterionId: "A2", title: "second native branch", deps: [], effect: "read", owner: "luna", necessity: "A2 is unproven" }),
		});
	}
	if (previous === "luna_factory_candidate") {
		return functionCall("luna_factory_attempt", { input: JSON.stringify({ taskId: "T1", attemptId: "T1-a1" }) });
	}
	if (previous === "luna_factory_attempt" && attempts === 1) {
		return functionCall("luna_factory_attempt", { input: JSON.stringify({ taskId: "T2", attemptId: "T2-a1" }) });
	}
	if (previous === "luna_factory_attempt") {
		return functionCall("luna_factory_dispatch", { input: JSON.stringify({ taskId: "T1", attemptId: "T1-a1" }) });
	}
	if (previous === "luna_factory_dispatch" && dispatches === 1) {
		return functionCall("luna_factory_dispatch", { input: JSON.stringify({ taskId: "T2", attemptId: "T2-a1" }) });
	}
	if (previous === "luna_factory_dispatch") {
		return functionCall("task", {
			context: "Both items are read-only branches of the same admitted Luna Factory probe.",
			tasks: [
				{ agent: "task", task: "First batched read. LUNA_FACTORY_DISPATCH task=T1 attempt=T1-a1 generation=G1" },
				{ agent: "task", task: "Second batched read. LUNA_FACTORY_DISPATCH task=T2 attempt=T2-a1 generation=G1" },
			],
		});
	}
	return textCompletion("native-batch route completed; both workers returned and remain VERIFY until receipts are reconciled");
}

function responseForDependencyJoin(body) {
	const previous = lastTool(body) ?? lastAssistantTool(body);
	const candidates = toolCallCount(body, "luna_factory_candidate");
	const attempts = toolCallCount(body, "luna_factory_attempt");
	const dispatches = toolCallCount(body, "luna_factory_dispatch");
	const tasks = toolCallCount(body, "task");
	const receipts = toolCallCount(body, "luna_factory_receipt");
	const finishes = toolCallCount(body, "luna_factory_finish");
	if (previous === undefined) {
		return functionCall("luna_factory_open", {
			input: JSON.stringify({
				objective: "prove the dependency join in the packaged Factory",
				criteria: [
					{ id: "A1", statement: "the first dependency is proven" },
					{ id: "A2", statement: "the dependent join is proven" },
				],
				repo: "example/repo",
				base: "a".repeat(40),
			}),
		});
	}
	if (previous === "luna_factory_open") {
		return functionCall("luna_factory_candidate", {
			input: JSON.stringify({ taskId: "T1", generation: "G1", criterionId: "A1", title: "prove dependency", deps: [], effect: "read", owner: "luna", necessity: "A1 is unproven" }),
		});
	}
	if (previous === "luna_factory_candidate" && candidates === 1) {
		return functionCall("luna_factory_candidate", {
			input: JSON.stringify({ taskId: "T2", generation: "G1", criterionId: "A2", title: "prove dependent join", deps: ["T1"], effect: "read", owner: "luna", necessity: "A2 waits for T1" }),
		});
	}
	if (previous === "luna_factory_candidate" && candidates === 2) {
		return functionCall("luna_factory_attempt", { input: JSON.stringify({ taskId: "T1", attemptId: "T1-a1" }) });
	}
	if (previous === "luna_factory_attempt" && attempts === 1) {
		return functionCall("luna_factory_dispatch", { input: JSON.stringify({ taskId: "T1", attemptId: "T1-a1" }) });
	}
	if (previous === "luna_factory_dispatch" && dispatches === 1) {
		return functionCall("task", { agent: "task", task: "Dependency read. LUNA_FACTORY_DISPATCH task=T1 attempt=T1-a1 generation=G1" });
	}
	if (previous === "task" && tasks === 1) {
		return functionCall("luna_factory_receipt", { input: JSON.stringify(probeReceipt("T1", "T1-a1", "A1")) });
	}
	if (previous === "luna_factory_receipt" && receipts === 1) {
		return functionCall("luna_factory_finish", { input: JSON.stringify({ taskId: "T1", criterionId: "A1" }) });
	}
	if (previous === "luna_factory_finish" && finishes === 1) {
		return functionCall("luna_factory_attempt", { input: JSON.stringify({ taskId: "T2", attemptId: "T2-a1" }) });
	}
	if (previous === "luna_factory_attempt") {
		return functionCall("luna_factory_dispatch", { input: JSON.stringify({ taskId: "T2", attemptId: "T2-a1" }) });
	}
	if (previous === "luna_factory_dispatch") {
		return functionCall("task", { agent: "task", task: "Dependent read. LUNA_FACTORY_DISPATCH task=T2 attempt=T2-a1 generation=G1" });
	}
	if (previous === "task" && tasks === 2) {
		return functionCall("luna_factory_receipt", { input: JSON.stringify(probeReceipt("T2", "T2-a1", "A2")) });
	}
	if (previous === "luna_factory_receipt") {
		return functionCall("luna_factory_finish", { input: JSON.stringify({ taskId: "T2", criterionId: "A2" }) });
	}
	return textCompletion("dependency-join route converged with current receipts and no successor work");
}

function responseFor(body) {
	if (!isFactoryRoot(body)) {
		if (toolNames(body).includes("yield")) {
			return functionCall("yield", { data: { result: "deterministic worker completed", route } });
		}
		return textCompletion("worker result from the exact packaged OMP probe");
	}
	if (route === "native-batch") return responseForNativeBatch(body);
	if (route === "dependency-join") return responseForDependencyJoin(body);
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
	if (previous === "luna_factory_candidate" && (route === "eval-tool-task-reject" || route === "eval-tool-task-py-reject")) {
		return functionCall("eval", {
			language: route.endsWith("-py-reject") ? "py" : "js",
			code: route.endsWith("-py-reject")
				? "result = await tool.task({'agent': 'task', 'task': 'Unbound work must be rejected.'}); display({'route': 'eval-tool-task-py-reject', 'result': result})"
				: "const result = await tool.task({ agent: 'task', task: 'Unbound work must be rejected.' }); display({ route: 'eval-tool-task-reject', result });",
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
		if (route === "eval-tool-task" || route === "eval-tool-task-py") {
			return functionCall("eval", {
				language: route.endsWith("-py") ? "py" : "js",
				code: route.endsWith("-py")
					? "result = await tool.task({'agent': 'task', 'task': 'Read the repository and report the eval tool.task result. LUNA_FACTORY_DISPATCH task=T1 attempt=T1-a1 generation=G1'}); display({'route': 'eval-tool-task-py', 'result': result})"
					: "const result = await tool.task({ agent: 'task', task: 'Read the repository and report the eval tool.task result. LUNA_FACTORY_DISPATCH task=T1 attempt=T1-a1 generation=G1' }); display({ route: 'eval-tool-task', result });",
			});
		}
		if (route === "eval-agent") {
			return functionCall("eval", {
				language: "js",
				code: "const handle = await agent('Read the repository and report the eval agent result.', { agent: 'task', label: 'luna-eval-agent' }); const result = await handle.wait(); display({ route: 'eval-agent', id: handle.id, agent: handle.agent, result });",
			});
		}
		if (route === "workpool") {
			return functionCall("eval", {
				language: "js",
				code: "const pool = await workpool('task', { name: 'luna-probe-pool' }); const ids = await pool.push('Read-only pool item one', 'Read-only pool item two'); const status = await pool.status(); display({ route: 'workpool', pool: String(pool), ids, status });",
			});
		}
		if (route === "hub") {
			return functionCall("eval", {
				language: "js",
				code: "const handle = await agent('Wait for a steering message, then report.', { agent: 'task', label: 'luna-hub-agent' }); const peers = await tool.hub({ op: 'list' }); const send = await tool.hub({ op: 'send', to: handle.id, message: 'Luna probe steering message' }); const cancel = await tool.hub({ op: 'cancel', ids: [handle.id] }); display({ route: 'hub', id: handle.id, peers, send, cancel });",
			});
		}
		return functionCall("task", {
			agent: "task",
			task: "Read the repository and report the native probe result. LUNA_FACTORY_DISPATCH task=T1 attempt=T1-a1 generation=G1",
		});
	}
	return textCompletion(`${route} route completed; worker result remains VERIFY until evidence is independently reconciled`);
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
			route,
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
