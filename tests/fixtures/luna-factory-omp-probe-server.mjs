import { createServer } from "node:http";

const port = Number.parseInt(process.env.LUNA_PROBE_PORT ?? "43127", 10);
const route = process.env.LUNA_PROBE_ROUTE ?? "native-task";
const phase = process.env.LUNA_PROBE_PHASE ?? "single";
const bindAddress = process.env.LUNA_PROBE_BIND ?? "127.0.0.1";
let requestNumber = 0;

function audit(event, details = {}) {
	console.error(JSON.stringify({ type: "audit", route, phase, event, ...details }));
}

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

function latestUserText(body) {
	const messages = Array.isArray(body.messages) ? body.messages : [];
	for (let index = messages.length - 1; index >= 0; index -= 1) {
		const message = messages[index];
		if (message?.role === "user") return messageText(message);
	}
	return "";
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
	audit("tool-call", { name });
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

function responseForNormalReview(body) {
	const previous = lastTool(body) ?? lastAssistantTool(body);
	if (previous === undefined) return functionCall("hive_workbench_trace", {});
	return textCompletion("ordinary Review trace completed while Luna Factory remained inactive");
}

function probeReceipt(taskId, attemptId, criterionId, overrides = {}) {
	return {
		version: 2,
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
		assumptions: [],
		predicates: [
			{ phase: "worker", item: `${criterionId} evidence checked`, ok: true, note: "deterministic packaged probe" },
			{ phase: "acceptance", item: `${criterionId} accepted`, ok: true, note: "deterministic packaged probe" },
		],
		...overrides,
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
		audit("native-parallel-dispatch", { tasks: ["T1", "T2"] });
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
		audit("dependency-t2-deferred", { taskId: "T2", prerequisite: "T1" });
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
		audit("dependency-t2-admitted-after-done", { taskId: "T2", prerequisite: "T1" });
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

function responseForPlateauReplan(body) {
	const previous = lastTool(body) ?? lastAssistantTool(body);
	const candidates = toolCallCount(body, "luna_factory_candidate");
	const attempts = toolCallCount(body, "luna_factory_attempt");
	const dispatches = toolCallCount(body, "luna_factory_dispatch");
	const tasks = toolCallCount(body, "task");
	const receipts = toolCallCount(body, "luna_factory_receipt");
	const finishes = toolCallCount(body, "luna_factory_finish");
	const replans = toolCallCount(body, "luna_factory_replan");
	if (previous === undefined) {
		return functionCall("luna_factory_open", {
			input: JSON.stringify({
				objective: "diagnose and replan a stalled packaged Factory task",
				criteria: [{ id: "A1", statement: "the repaired approach is proven" }],
				repo: "example/repo",
				base: "a".repeat(40),
				options: { appetite: { tasks: 2, attemptsPerTask: 3 } },
			}),
		});
	}
	if (previous === "luna_factory_open") {
		return functionCall("luna_factory_candidate", {
			input: JSON.stringify({ taskId: "T1", generation: "G1", criterionId: "A1", title: "diagnose the stalled task", deps: [], effect: "read", owner: "luna", necessity: "A1 is unproven" }),
		});
	}
	if (previous === "luna_factory_candidate" && candidates === 1) {
		return functionCall("luna_factory_attempt", { input: JSON.stringify({ taskId: "T1", attemptId: "T1-a1" }) });
	}
	if (previous === "luna_factory_attempt" && attempts === 1) {
		return functionCall("luna_factory_dispatch", { input: JSON.stringify({ taskId: "T1", attemptId: "T1-a1" }) });
	}
	if (previous === "luna_factory_dispatch" && dispatches === 1) {
		return functionCall("task", { agent: "task", task: "First stalled read. LUNA_FACTORY_DISPATCH task=T1 attempt=T1-a1 generation=G1" });
	}
	if (previous === "task" && tasks === 1) {
		return functionCall("luna_factory_receipt", {
			input: JSON.stringify(probeReceipt("T1", "T1-a1", "A1", { unresolved: ["the first approach made no progress"] })),
		});
	}
	if (previous === "luna_factory_receipt" && receipts === 1) {
		return functionCall("luna_factory_attempt", { input: JSON.stringify({ taskId: "T1", attemptId: "T1-a2" }) });
	}
	if (previous === "luna_factory_attempt" && attempts === 2) {
		return functionCall("luna_factory_dispatch", { input: JSON.stringify({ taskId: "T1", attemptId: "T1-a2" }) });
	}
	if (previous === "luna_factory_dispatch" && dispatches === 2) {
		return functionCall("task", { agent: "task", task: "Second stalled read. LUNA_FACTORY_DISPATCH task=T1 attempt=T1-a2 generation=G1" });
	}
	if (previous === "task" && tasks === 2) {
		return functionCall("luna_factory_receipt", {
			input: JSON.stringify(probeReceipt("T1", "T1-a2", "A1", { unresolved: ["the second approach made no progress"] })),
		});
	}
	if (previous === "luna_factory_receipt" && receipts === 2) {
		return functionCall("luna_factory_replan", { input: JSON.stringify({ taskId: "T1" }) });
	}
	if (previous === "luna_factory_replan" && replans === 1) {
		return functionCall("luna_factory_attempt", { input: JSON.stringify({ taskId: "T1", attemptId: "T1-a3" }) });
	}
	if (previous === "luna_factory_attempt" && attempts === 3) {
		return functionCall("luna_factory_dispatch", { input: JSON.stringify({ taskId: "T1", attemptId: "T1-a3" }) });
	}
	if (previous === "luna_factory_dispatch" && dispatches === 3) {
		return functionCall("task", { agent: "task", task: "Replanned read. LUNA_FACTORY_DISPATCH task=T1 attempt=T1-a3 generation=G1" });
	}
	if (previous === "task" && tasks === 3) {
		return functionCall("luna_factory_receipt", { input: JSON.stringify(probeReceipt("T1", "T1-a3", "A1")) });
	}
	if (previous === "luna_factory_receipt" && receipts === 3) {
		return functionCall("luna_factory_finish", { input: JSON.stringify({ taskId: "T1", criterionId: "A1" }) });
	}
	if (previous === "luna_factory_finish" && finishes === 1) {
		audit("successor-cleanup-proposed", { taskId: "T2", after: "T1-DONE" });
		return functionCall("luna_factory_candidate", {
			input: JSON.stringify({ taskId: "T2", generation: "G1", criterionId: "A1", title: "optional cleanup after success", deps: [], effect: "read", owner: "luna", necessity: "cleanup would be convenient" }),
		});
	}
	if (previous === "luna_factory_candidate" && candidates === 2) {
		audit("successor-cleanup-rejected", { taskId: "T2", reason: "criterion already proven" });
		return functionCall("luna_factory_completion", { input: JSON.stringify({}) });
	}
	return textCompletion("plateau-replan route converged after one bounded replan; successor cleanup was dismissed");
}

function responseForLegitimateDefect(body) {
	const previous = lastTool(body) ?? lastAssistantTool(body);
	const candidates = toolCallCount(body, "luna_factory_candidate");
	const attempts = toolCallCount(body, "luna_factory_attempt");
	const dispatches = toolCallCount(body, "luna_factory_dispatch");
	const tasks = toolCallCount(body, "task");
	const receipts = toolCallCount(body, "luna_factory_receipt");
	const finishes = toolCallCount(body, "luna_factory_finish");
	const reopens = toolCallCount(body, "luna_factory_reopen");
	if (previous === undefined) {
		return functionCall("luna_factory_open", {
			input: JSON.stringify({
				objective: "repair a reproduced defect without authorizing successor cleanup",
				criteria: [
					{ id: "A1", statement: "the reproduced defect is repaired" },
					{ id: "A2", statement: "optional cleanup is documented", mandatory: false },
				],
				repo: "example/repo",
				base: "a".repeat(40),
			}),
		});
	}
	if (previous === "luna_factory_open") {
		return functionCall("luna_factory_candidate", {
			input: JSON.stringify({ taskId: "T1", generation: "G1", criterionId: "A1", title: "initial repair", deps: [], effect: "read", owner: "luna", necessity: "A1 is unproven" }),
		});
	}
	if (previous === "luna_factory_candidate" && candidates === 1) {
		return functionCall("luna_factory_attempt", { input: JSON.stringify({ taskId: "T1", attemptId: "T1-a1" }) });
	}
	if (previous === "luna_factory_attempt" && attempts === 1) {
		return functionCall("luna_factory_dispatch", { input: JSON.stringify({ taskId: "T1", attemptId: "T1-a1" }) });
	}
	if (previous === "luna_factory_dispatch" && dispatches === 1) {
		return functionCall("task", { agent: "task", task: "Initial repair read. LUNA_FACTORY_DISPATCH task=T1 attempt=T1-a1 generation=G1" });
	}
	if (previous === "task" && tasks === 1) {
		return functionCall("luna_factory_receipt", { input: JSON.stringify(probeReceipt("T1", "T1-a1", "A1")) });
	}
	if (previous === "luna_factory_receipt" && receipts === 1) {
		return functionCall("luna_factory_finish", { input: JSON.stringify({ taskId: "T1" }) });
	}
	if (previous === "luna_factory_finish" && finishes === 1) {
		return functionCall("luna_factory_candidate", {
			input: JSON.stringify({ taskId: "T2", generation: "G1", criterionId: "A2", title: "optional cleanup", deps: [], effect: "read", owner: "luna", necessity: "cleanup would be convenient" }),
		});
	}
	if (previous === "luna_factory_candidate" && candidates === 2) {
		audit("legitimate-defect-reopen", { taskId: "T1" });
		return functionCall("luna_factory_reopen", { input: JSON.stringify({ taskId: "T1", reason: "reproduced a legitimate data-loss defect after the green result" }) });
	}
	if (previous === "luna_factory_reopen" && reopens === 1) {
		return functionCall("luna_factory_candidate", {
			input: JSON.stringify({ taskId: "T3", generation: "G1", criterionId: "A1", title: "repair the reproduced defect", deps: [], effect: "read", owner: "luna", necessity: "the owner reproduced a mandatory defect" }),
		});
	}
	if (previous === "luna_factory_candidate" && candidates === 3) {
		return functionCall("luna_factory_attempt", { input: JSON.stringify({ taskId: "T3", attemptId: "T3-a1" }) });
	}
	if (previous === "luna_factory_attempt" && attempts === 2) {
		return functionCall("luna_factory_dispatch", { input: JSON.stringify({ taskId: "T3", attemptId: "T3-a1" }) });
	}
	if (previous === "luna_factory_dispatch" && dispatches === 2) {
		return functionCall("task", { agent: "task", task: "Legitimate defect repair read. LUNA_FACTORY_DISPATCH task=T3 attempt=T3-a1 generation=G1" });
	}
	if (previous === "task" && tasks === 2) {
		return functionCall("luna_factory_receipt", { input: JSON.stringify(probeReceipt("T3", "T3-a1", "A1")) });
	}
	if (previous === "luna_factory_receipt" && receipts === 2) {
		return functionCall("luna_factory_finish", { input: JSON.stringify({ taskId: "T3" }) });
	}
	if (previous === "luna_factory_finish" && finishes === 2) {
		return functionCall("luna_factory_completion", { input: JSON.stringify({}) });
	}
	return textCompletion("legitimate-defect route repaired the explicit defect; post-success cleanup stayed dismissed");
}

function responseForAcceptance(body) {
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
				objective: "prove the complete packaged Factory vertical without changing the repository",
				criteria: [{ id: "A1", statement: "the packaged native task is verified and finished" }],
				repo: "example/repo",
				base: "a".repeat(40),
				nonGoals: ["do not merge, deploy, publish, or modify the target repository"],
				permittedEffects: ["read"],
				finishAuthority: "report the verified result only",
			}),
		});
	}
	if (previous === "luna_factory_open") {
		return functionCall("luna_factory_candidate", {
			input: JSON.stringify({ taskId: "T1", generation: "G1", criterionId: "A1", title: "complete packaged vertical", deps: [], effect: "read", owner: "luna", necessity: "A1 is unproven" }),
		});
	}
	if (previous === "luna_factory_attempt" && attempts === 1) {
		return functionCall("luna_factory_dispatch", { input: JSON.stringify({ taskId: "T1", attemptId: "T1-a1" }) });
	}
	if (previous === "luna_factory_dispatch" && dispatches === 1) {
		return functionCall("task", { agent: "task", task: "Read the repository and report the complete vertical. LUNA_FACTORY_DISPATCH task=T1 attempt=T1-a1 generation=G1" });
	}
	if (previous === "task" && tasks === 1) {
		return functionCall("luna_factory_receipt", { input: JSON.stringify(probeReceipt("T1", "T1-a1", "A1")) });
	}
	if (previous === "luna_factory_receipt" && receipts === 1) {
		return functionCall("luna_factory_finish", { input: JSON.stringify({ taskId: "T1", criterionId: "A1" }) });
	}
	if (previous === "luna_factory_finish" && finishes === 1) {
		audit("successor-cleanup-proposed", { taskId: "T2", after: "T1-DONE" });
		return functionCall("luna_factory_candidate", {
			input: JSON.stringify({ taskId: "T2", generation: "G1", criterionId: "A1", title: "post-success cleanup", deps: [], effect: "read", owner: "luna", necessity: "cleanup would be convenient" }),
		});
	}
	if (previous === "luna_factory_candidate" && candidates === 2) {
		audit("successor-cleanup-rejected", { taskId: "T2", reason: "criterion already proven" });
		return functionCall("luna_factory_completion", { input: JSON.stringify({}) });
	}
	if (previous === "luna_factory_candidate") {
		return functionCall("luna_factory_attempt", { input: JSON.stringify({ taskId: "T1", attemptId: "T1-a1" }) });
	}
	return textCompletion("acceptance route finished the worker through VERIFY and DONE; post-success cleanup was rejected and completion grants no merge or deploy authority");
}

function responseForEnabledIdle(body) {
	const previous = lastTool(body) ?? lastAssistantTool(body);
	if (previous === undefined) return functionCall("luna_factory_status", { input: JSON.stringify({}) });
	return textCompletion("Factory is enabled but idle; no work starts until an explicit objective is opened");
}

function responseForRestartReload(body) {
	const previous = lastTool(body) ?? lastAssistantTool(body);
	if (phase === "seed") {
		if (previous === undefined) {
			return functionCall("luna_factory_open", {
				input: JSON.stringify({
					objective: "seed one durable Factory attempt for restart validation",
					criteria: [{ id: "A1", statement: "the restart attempt can be reconciled" }],
					repo: "example/repo",
					base: "a".repeat(40),
				}),
			});
		}
		if (previous === "luna_factory_open") {
			return functionCall("luna_factory_candidate", {
				input: JSON.stringify({ taskId: "T1", generation: "G1", criterionId: "A1", title: "durable restart attempt", deps: [], effect: "read", owner: "luna", necessity: "A1 is unproven" }),
			});
		}
		if (previous === "luna_factory_candidate") {
			return functionCall("luna_factory_attempt", { input: JSON.stringify({ taskId: "T1", attemptId: "T1-a1" }) });
		}
		return textCompletion("restart seed persisted the Factory attempt and stopped before external work");
	}

	const calls = assistantTools(body);
	const statusCalls = calls.filter((name) => name === "luna_factory_status").length;
	if (statusCalls === 0) return functionCall("luna_factory_status", { input: JSON.stringify({}) });
	if (previous === "luna_factory_status") {
		audit("restart-resume-observed", {
			priorFactoryCalls: calls.filter((name) => name.startsWith("luna_factory_")),
			postStatusFactoryCalls: [],
		});
		return functionCall("luna_factory_reconcile", {
			input: JSON.stringify({ taskId: "T1", attemptId: "T1-a1", outcome: "abandoned", reason: "restart reconstructed the durable attempt; no worker receipt was fabricated" }),
		});
	}
	const statusIndex = calls.lastIndexOf("luna_factory_status");
	const postStatusFactoryCalls = statusIndex < 0 ? [] : calls.slice(statusIndex + 1).filter((name) => name.startsWith("luna_factory_"));
	audit("restart-resume-no-replay", {
		priorFactoryCalls: calls.filter((name) => name.startsWith("luna_factory_")),
		postStatusFactoryCalls,
		replayedCalls: postStatusFactoryCalls.filter((name) => ["luna_factory_open", "luna_factory_candidate", "luna_factory_attempt"].includes(name)),
	});
	return textCompletion("restart reload reconstructed the durable Factory state, reconciled the existing attempt, and replayed no open, candidate, or attempt work");
}

function responseForIsolatedWrite(body) {
	const previous = lastTool(body) ?? lastAssistantTool(body);
	const attempts = toolCallCount(body, "luna_factory_attempt");
	const dispatches = toolCallCount(body, "luna_factory_dispatch");
	const tasks = toolCallCount(body, "task");
	const receipts = toolCallCount(body, "luna_factory_receipt");
	const integrations = toolCallCount(body, "luna_factory_integrate");
	if (previous === undefined) {
		return functionCall("luna_factory_open", {
			input: JSON.stringify({
				objective: "probe an isolated write without automatic application",
				criteria: [{ id: "A1", statement: "the isolated write is independently verified" }],
				repo: "example/repo",
				base: "a".repeat(40),
				options: { permittedEffects: ["read", "write"], finishAuthority: "report the verified write only" },
			}),
		});
	}
	if (previous === "luna_factory_open") {
		return functionCall("luna_factory_candidate", {
			input: JSON.stringify({ taskId: "T1", generation: "G1", criterionId: "A1", title: "isolated write probe", deps: [], effect: "write", owner: "luna", necessity: "A1 is unproven" }),
		});
	}
	if (previous === "luna_factory_candidate") {
		return functionCall("luna_factory_attempt", { input: JSON.stringify({ taskId: "T1", attemptId: "T1-a1" }) });
	}
	if (previous === "luna_factory_attempt" && attempts === 1) {
		return functionCall("luna_factory_dispatch", { input: JSON.stringify({ taskId: "T1", attemptId: "T1-a1" }) });
	}
	if (previous === "luna_factory_dispatch" && dispatches === 1) {
		return functionCall("task", {
			agent: "task",
			isolated: true,
			task: "Make no external change; inspect the isolated workspace and report the write probe. LUNA_FACTORY_DISPATCH task=T1 attempt=T1-a1 generation=G1",
		});
	}
	if (previous === "task" && tasks === 1) {
		return functionCall("luna_factory_receipt", { input: JSON.stringify(probeReceipt("T1", "T1-a1", "A1")) });
	}
	if (previous === "luna_factory_receipt" && receipts === 1) {
		return functionCall("luna_factory_integrate", {
			input: JSON.stringify({ taskId: "T1", attemptId: "T1-a1", subject: { repo: "example/repo", base: "a".repeat(40), head: "b".repeat(40) } }),
		});
	}
	if (previous === "luna_factory_integrate" && integrations === 1) {
		return functionCall("luna_factory_completion", { input: JSON.stringify({}) });
	}
	return textCompletion("isolated-write route recorded a worker receipt, integrated only by explicit owner event, and left verification pending at the moved subject");
}

function responseForSelectedBatch(body) {
	const previous = lastTool(body) ?? lastAssistantTool(body);
	if (previous === undefined) return functionCall("luna_factory_packaged_batch_probe", { input: "{}" });
	return textCompletion("packaged BatchService probe completed; inspect BATCH_PROBE evidence");
}

function responseFor(body) {
	if (route === "selected-batch") return responseForSelectedBatch(body);
	if (route === "enabled-idle") return responseForEnabledIdle(body);
	if (route === "normal-review") return responseForNormalReview(body);
	if (route === "acceptance") return responseForAcceptance(body);
	if (route === "restart-reload") return responseForRestartReload(body);
	if (!isFactoryRoot(body)) {
		if (route === "isolated-write" && toolNames(body).includes("write") && lastTool(body) !== "write" && lastAssistantTool(body) !== "write") {
			return functionCall("write", { path: "tmp/luna-factory-isolation-probe.txt", content: "isolated Factory write probe\n" });
		}
		if (toolNames(body).includes("yield")) {
			return functionCall("yield", { data: { result: "deterministic worker completed", route } });
		}
		return textCompletion("worker result from the exact packaged OMP probe");
	}
	if (route === "native-batch") return responseForNativeBatch(body);
	if (route === "dependency-join") return responseForDependencyJoin(body);
	if (route === "plateau-replan") return responseForPlateauReplan(body);
	if (route === "legitimate-defect") return responseForLegitimateDefect(body);
	if (route === "isolated-write") return responseForIsolatedWrite(body);
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
	if (previous === "luna_factory_control" && route === "async-pause-drain" && toolCallCount(body, "luna_factory_control") === 1) {
		return functionCall("luna_factory_candidate", {
			input: JSON.stringify({
				taskId: "T2",
				generation: "G1",
				criterionId: "A1",
				title: "new work discovered during pause",
				deps: [],
				effect: "read",
				owner: "luna",
				necessity: "A1 remains unproven",
			}),
		});
	}
	if (previous === "luna_factory_candidate" && route === "async-pause-drain" && toolCallCount(body, "luna_factory_candidate") === 2) {
		return functionCall("luna_factory_control", { input: JSON.stringify({ action: "drain" }) });
	}
	if (previous === "luna_factory_candidate" && (route === "eval-tool-task-reject" || route === "eval-tool-task-py-reject")) {
		return functionCall("eval", {
			language: route.endsWith("-py-reject") ? "py" : "js",
			code: route.endsWith("-py-reject")
				? "result = await tool.task({'agent': 'task', 'task': 'Unbound work must be rejected.'}); display({'route': 'eval-tool-task-py-reject', 'result': result})"
				: "const result = await tool.task({ agent: 'task', task: 'Unbound work must be rejected.' }); display({ route: 'eval-tool-task-reject', result });",
		});
	}
	if (previous === "luna_factory_attempt" && route === "async-abort-reconcile" && toolCallCount(body, "luna_factory_attempt") === 2) {
		return functionCall("luna_factory_dispatch", { input: JSON.stringify({ taskId: "T1", attemptId: "T1-a2" }) });
	}
	if (previous === "luna_factory_dispatch" && route === "async-abort-reconcile" && toolCallCount(body, "luna_factory_dispatch") === 2) {
		return functionCall("luna_factory_completion", { input: JSON.stringify({}) });
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
		if (route === "async-abort") {
			return functionCall("task", {
				agent: "task",
				task: "Run the async abort lifecycle probe. LUNA_FACTORY_DISPATCH task=T1 attempt=T1-a1 generation=G1",
			});
		}
		if (route === "async-abort-reconcile") {
			return functionCall("task", {
				agent: "task",
				task: "Run the async abort and reconciliation lifecycle probe. LUNA_FACTORY_DISPATCH task=T1 attempt=T1-a1 generation=G1",
			});
		}
		return functionCall("task", {
			agent: "task",
			task: "Read the repository and report the native probe result. LUNA_FACTORY_DISPATCH task=T1 attempt=T1-a1 generation=G1",
		});
	}
	if (previous === "task" && route === "async-abort") {
		return functionCall("luna_factory_control", { input: JSON.stringify({ action: "abort" }) });
	}
	if (previous === "task" && route === "async-abort-reconcile") {
		return functionCall("luna_factory_control", { input: JSON.stringify({ action: "abort" }) });
	}
	if (previous === "luna_factory_control" && route === "async-abort-reconcile" && toolCallCount(body, "luna_factory_control") === 1) {
		return functionCall("eval", {
			language: "js",
			code: "const jobs = await tool.hub({ op: 'jobs' }); const ids = Array.isArray(jobs?.details?.jobs) ? jobs.details.jobs.map((job) => job.id).filter((id) => typeof id === 'string') : []; const cancel = ids.length > 0 ? await tool.hub({ op: 'cancel', ids }) : { skipped: true, reason: 'no visible owned jobs' }; display({ route: 'async-abort-reconcile', ids, cancel });",
		});
	}
	if (previous === "eval" && route === "async-abort-reconcile") {
		return functionCall("luna_factory_reconcile", {
			input: JSON.stringify({ taskId: "T1", attemptId: "T1-a1", outcome: "abandoned", reason: "the packaged OMP hub cancellation probe returned; no receipt was fabricated" }),
		});
	}
	if (previous === "luna_factory_reconcile" && route === "async-abort-reconcile") {
		return functionCall("luna_factory_control", { input: JSON.stringify({ action: "resume" }) });
	}
	if (previous === "luna_factory_control" && route === "async-abort-reconcile" && toolCallCount(body, "luna_factory_control") === 2) {
		return functionCall("luna_factory_attempt", { input: JSON.stringify({ taskId: "T1", attemptId: "T1-a2" }) });
	}
	if (previous === "task" && route === "async-pause-drain") {
		return functionCall("luna_factory_control", { input: JSON.stringify({ action: "pause" }) });
	}
	return textCompletion(
		route === "async-abort-reconcile"
			? "async abort/reconcile route cancelled the observed OMP job, reconciled the attempt as abandoned, resumed the Factory run, and fabricated no receipt"
			: `${route} route completed; worker result remains VERIFY until evidence is independently reconciled`,
	);
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
			type: "request",
			request: requestNumber,
			route,
			phase,
			factoryRoot: isFactoryRoot(body),
			hasTask: names.includes("task"),
			factoryTools: names.filter((name) => name.startsWith("luna_factory_")).sort(),
			assistantTools: assistantTools(body),
			messageCount: messages.length,
			lastRole: messages.at(-1)?.role ?? null,
			lastTool: lastTool(body) ?? null,
			lastAssistantTool: lastAssistantTool(body) ?? null,
			latestUserMarker: latestUserText(body).slice(0, 80),
			lastToolResult: lastToolResultSummary(body),
		}),
	);
	const payload = responseFor(body);
	response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
	for (const chunk of Array.isArray(payload) ? payload : [payload]) response.write(`data: ${jsonBody(chunk)}\n\n`);
	response.write("data: [DONE]\n\n");
	response.end();
});

server.listen(port, bindAddress, () => {
	console.log(JSON.stringify({ ready: true, port, bind: bindAddress }));
});
