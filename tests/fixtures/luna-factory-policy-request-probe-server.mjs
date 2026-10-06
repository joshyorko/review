import { createServer } from "node:http";
import { appendFileSync, writeFileSync } from "node:fs";

const auditPath = process.env.LUNA_POLICY_PROBE_AUDIT;
const readyPath = process.env.LUNA_POLICY_PROBE_READY;
if (!auditPath || !readyPath) throw new Error("probe audit and ready paths are required");

const knownCases = new Set(["allow", "abort", "throw", "timeout"]);
const requests = [];
const routeCounts = new Map();
const caseWindows = [];
const activeProviderRequests = new Map();
const sockets = new Map();
const socketIds = new WeakMap();
const providerSocketIds = new Set();
let nextSocketId = 1;
let activeWindow = null;
let drainState = null;
let draining = false;
let lastProviderActivityAt = Date.now();
let finalizing = false;

function audit(record) {
	appendFileSync(auditPath, JSON.stringify(record) + "\n");
}

function promptCase(body) {
	for (const message of [...(Array.isArray(body?.messages) ? body.messages : [])].reverse()) {
		if (typeof message?.content === "string") {
			const match = message.content.match(/LUNA_POLICY_PROBE_CASE=(allow|abort|throw|timeout)/);
			if (match) return match[1];
		}
		if (Array.isArray(message?.content)) {
			for (const part of message.content) {
				if (typeof part?.text !== "string") continue;
				const match = part.text.match(/LUNA_POLICY_PROBE_CASE=(allow|abort|throw|timeout)/);
				if (match) return match[1];
			}
		}
	}
	return null;
}

function windowReceipt(window) {
	return {
		case: window.case,
		startedAt: window.startedAt,
		finishedAt: window.finishedAt ?? null,
		finished: window.finished,
		requestCount: window.requestCount,
		postCount: window.postCount,
		untaggedPostCount: window.untaggedPostCount,
		markerMismatchPostCount: window.markerMismatchPostCount,
		requests: [...window.requests],
	};
}

function activeConnectionIds(excludeSocketId) {
	return [...providerSocketIds].filter((id) => id !== excludeSocketId && sockets.has(id));
}

function snapshot(excludeSocketId = null) {
	const totalPostCount = requests.filter((request) => request.method === "POST").length;
	const assignedPostCount = caseWindows.reduce((sum, window) => sum + window.postCount, 0);
	const untaggedPostCount = caseWindows.reduce((sum, window) => sum + window.untaggedPostCount, 0);
	const markerMismatchPostCount = caseWindows.reduce((sum, window) => sum + window.markerMismatchPostCount, 0);
	return {
		activeCase: activeWindow?.case ?? null,
		totalPostCount,
		assignedPostCount,
		unassignedPostCount: totalPostCount - assignedPostCount,
		untaggedPostCount,
		markerMismatchPostCount,
		activeProviderRequestCount: activeProviderRequests.size,
		activeProviderRequests: [...activeProviderRequests.values()],
		activeProviderConnectionCount: activeConnectionIds(excludeSocketId).length,
		activeProviderConnectionIds: activeConnectionIds(excludeSocketId),
		caseWindows: caseWindows.map(windowReceipt),
		methodPathCounts: Object.fromEntries(routeCounts),
		providerRequests: [...requests],
	};
}

function sendJson(response, status, value) {
	response.writeHead(status, { "content-type": "application/json", connection: "close" });
	response.end(JSON.stringify(value));
}

function registerProviderRequest(request, response, pathname) {
	const method = request.method ?? "UNKNOWN";
	const socketId = socketIds.get(request.socket);
	providerSocketIds.add(socketId);
	const requestWindow = activeWindow;
	const record = {
		requestId: requests.length + 1,
		method,
		path: pathname,
		case: requestWindow?.case ?? "unassigned",
		attribution: requestWindow ? "case-window" : "unassigned",
		markerCase: null,
		markerMatched: false,
		markerPending: method === "POST",
		receivedAt: Date.now(),
		bytes: null,
	};
	requests.push(record);
	const key = method + " " + pathname;
	routeCounts.set(key, (routeCounts.get(key) ?? 0) + 1);
	lastProviderActivityAt = Date.now();
	if (drainState) drainState.lateProviderRequestCount += 1;
	if (requestWindow) {
		requestWindow.requestCount += 1;
		requestWindow.requests.push(record);
		if (method === "POST") {
			requestWindow.postCount += 1;
			requestWindow.untaggedPostCount += 1;
		}
	}
	activeProviderRequests.set(record.requestId, { requestId: record.requestId, method, path: pathname, startedAt: record.receivedAt });
	audit({ type: "provider-request-start", ...record });

	let requestComplete = false;
	let responseComplete = false;
	let released = false;
	const settle = () => {
		if (released || !requestComplete || !responseComplete) return;
		released = true;
		activeProviderRequests.delete(record.requestId);
		lastProviderActivityAt = Date.now();
		if (drainState) drainState.lastActiveChangeAt = lastProviderActivityAt;
	};
	request.once("end", () => {
		requestComplete = true;
		settle();
	});
	request.once("close", () => {
		if (!request.complete) {
			requestComplete = true;
			record.incompleteBody = true;
		}
		settle();
	});
	response.once("finish", () => {
		responseComplete = true;
		settle();
	});
	response.once("close", () => {
		responseComplete = true;
		settle();
	});

	const chunks = [];
	const bodyPromise = (async () => {
		for await (const chunk of request) chunks.push(chunk);
		const rawBody = Buffer.concat(chunks);
		let body;
		if (rawBody.length > 0) {
			try { body = JSON.parse(rawBody.toString("utf8")); } catch { body = undefined; }
		}
		const markerCase = promptCase(body);
		record.markerCase = markerCase;
		record.markerMatched = requestWindow ? markerCase === requestWindow.case : false;
		record.markerPending = false;
		record.bytes = rawBody.length;
		if (requestWindow && method === "POST" && markerCase !== null) {
			requestWindow.untaggedPostCount -= 1;
			if (markerCase !== requestWindow.case) requestWindow.markerMismatchPostCount += 1;
		}
		audit({ type: "provider-request-body", requestId: record.requestId, case: record.case, markerCase, markerMatched: record.markerMatched, bytes: record.bytes, bodyValidJson: body !== undefined });
		return body;
	})();
	return { record, bodyPromise, method, pathname, requestWindow, socketId };
}

function intQuery(url, name, fallback, min, max) {
	const value = Number.parseInt(url.searchParams.get(name) ?? "", 10);
	return Number.isSafeInteger(value) ? Math.max(min, Math.min(max, value)) : fallback;
}

async function runDrain(excludedSocketId, quietMs, maxWaitMs) {
	const startedAt = Date.now();
	const deadline = startedAt + maxWaitMs;
	drainState = {
		startedAt,
		quietMs,
		maxWaitMs,
		settled: false,
		completedAt: null,
		lateProviderRequestCount: 0,
		peakActiveProviderRequestCount: 0,
		peakActiveProviderConnectionCount: 0,
		forcedSocketClose: false,
		listenerClosed: false,
	};
	draining = true;
	lastProviderActivityAt = startedAt;
	audit({ type: "drain-start", startedAt, quietMs, maxWaitMs });
	while (true) {
		const state = snapshot(excludedSocketId);
		drainState.peakActiveProviderRequestCount = Math.max(drainState.peakActiveProviderRequestCount, state.activeProviderRequestCount);
		drainState.peakActiveProviderConnectionCount = Math.max(drainState.peakActiveProviderConnectionCount, state.activeProviderConnectionCount);
		const quietForMs = Date.now() - lastProviderActivityAt;
		if (state.activeProviderRequestCount === 0 && state.activeProviderConnectionCount === 0 && quietForMs >= quietMs) {
			drainState.settled = true;
			drainState.reason = "quiet-window-and-provider-requests/connections-settled";
			break;
		}
		const remainingMs = deadline - Date.now();
		if (remainingMs <= 0) break;
		await new Promise((resolve) => setTimeout(resolve, Math.min(25, remainingMs)));
	}
	drainState.completedAt = Date.now();
	drainState.waitedMs = drainState.completedAt - startedAt;
	drainState.quietForMs = Date.now() - lastProviderActivityAt;
	if (!drainState.settled) drainState.reason = "provider-drain-deadline-expired-with-active-or-recent-traffic";
	audit({ type: "drain-result", ...drainState, ...snapshot(excludedSocketId) });
	return {
		status: drainState.settled ? "settled" : "incomplete",
		settlement: { ...drainState, ...snapshot(excludedSocketId) },
		snapshot: snapshot(excludedSocketId),
	};
}

function writeFinalSummary() {
	writeFileSync(auditPath + ".summary.json", JSON.stringify({
		bind: "127.0.0.1",
		drain: drainState ?? { settled: false, reason: "provider drain was never requested", listenerClosed: false },
		...snapshot(),
	}, null, 2));
}

function closeAfterDrain(response) {
	if (finalizing) return;
	finalizing = true;
	response.once("finish", () => {
		server.close(() => {
			if (drainState) drainState.listenerClosed = true;
			writeFinalSummary();
			process.exit(drainState?.settled ? 0 : 1);
		});
		const forceTimer = setTimeout(() => {
			if (drainState && !drainState.listenerClosed) {
				drainState.forcedSocketClose = true;
				for (const socket of sockets.values()) socket.destroy();
			}
		}, 500);
		forceTimer.unref();
		const hardStop = setTimeout(() => {
			writeFinalSummary();
			process.exit(2);
		}, 2500);
		hardStop.unref();
	});
}

const server = createServer(async (request, response) => {
	const url = new URL(request.url ?? "/", "http://127.0.0.1");
	if (request.method === "GET" && url.pathname === "/__probe/stats") {
		sendJson(response, 200, snapshot());
		return;
	}
	if (request.method === "GET" && url.pathname === "/__probe/start") {
		const probeCase = url.searchParams.get("case");
		if (draining || !knownCases.has(probeCase) || activeWindow || caseWindows.some((window) => window.case === probeCase)) {
			sendJson(response, 409, { error: "invalid, closed, or overlapping probe case window", activeCase: activeWindow?.case ?? null });
			return;
		}
		activeWindow = {
			case: probeCase,
			startedAt: Date.now(),
			finished: false,
			requestCount: 0,
			postCount: 0,
			untaggedPostCount: 0,
			markerMismatchPostCount: 0,
			requests: [],
		};
		caseWindows.push(activeWindow);
		audit({ type: "case-start", case: probeCase, at: activeWindow.startedAt });
		sendJson(response, 200, { case: probeCase, startedAt: activeWindow.startedAt });
		return;
	}
	if (request.method === "GET" && url.pathname === "/__probe/finish") {
		const probeCase = url.searchParams.get("case");
		if (!activeWindow || activeWindow.case !== probeCase) {
			sendJson(response, 409, { error: "no matching active probe case", activeCase: activeWindow?.case ?? null });
			return;
		}
		activeWindow.finishedAt = Date.now();
		activeWindow.finished = true;
		const finished = windowReceipt(activeWindow);
		audit({ type: "case-finish", ...finished });
		activeWindow = null;
		sendJson(response, 200, finished);
		return;
	}
	if (request.method === "GET" && url.pathname === "/__probe/drain") {
		if (drainState) {
			sendJson(response, 409, { error: "provider drain has already started" });
			return;
		}
		if (activeWindow) {
			sendJson(response, 409, { error: "cannot drain with an open case window", activeCase: activeWindow.case });
			return;
		}
		const quietMs = intQuery(url, "quietMs", 500, 100, 1500);
		const maxWaitMs = intQuery(url, "maxWaitMs", 5000, 1000, 7000);
		const drainSocketId = socketIds.get(request.socket);
		const result = await runDrain(drainSocketId, quietMs, maxWaitMs);
		response.writeHead(200, { "content-type": "application/json", connection: "close" });
		closeAfterDrain(response);
		response.end(JSON.stringify(result));
		return;
	}

	const provider = registerProviderRequest(request, response, url.pathname);
	const body = await provider.bodyPromise.catch((error) => {
		audit({ type: "provider-request-body-error", requestId: provider.record.requestId, error: error instanceof Error ? error.message : String(error) });
		return undefined;
	});
	const { method, pathname } = provider;
	if (method === "GET" && pathname === "/v1/models") {
		sendJson(response, 200, { object: "list", data: [{ id: "deterministic", object: "model", owned_by: "local-probe" }] });
		return;
	}
	if (method !== "POST" || pathname !== "/v1/chat/completions" || !body) {
		response.writeHead(404, { "content-type": "text/plain", connection: "close" });
		response.end("unexpected local probe route");
		return;
	}

	const now = Math.floor(Date.now() / 1000);
	response.writeHead(200, {
		"content-type": "text/event-stream",
		"cache-control": "no-cache",
		connection: "close",
	});
	response.write("data: " + JSON.stringify({
		id: "policy-probe-" + provider.record.requestId,
		object: "chat.completion.chunk",
		created: now,
		model: "deterministic",
		choices: [{ index: 0, delta: { role: "assistant", content: "probe complete" }, finish_reason: null }],
	}) + "\n\n");
	response.write("data: " + JSON.stringify({
		id: "policy-probe-" + provider.record.requestId,
		object: "chat.completion.chunk",
		created: now,
		model: "deterministic",
		choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
	}) + "\n\n");
	response.end("data: [DONE]\n\n");
});

server.on("connection", (socket) => {
	const id = nextSocketId++;
	socketIds.set(socket, id);
	sockets.set(id, socket);
	socket.once("close", () => sockets.delete(id));
});

server.listen(0, "127.0.0.1", () => {
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("loopback listener address unavailable");
	writeFileSync(readyPath, JSON.stringify({ bind: "127.0.0.1", port: address.port }));
	lastProviderActivityAt = Date.now();
	audit({ type: "ready", bind: "127.0.0.1", port: address.port });
});

function stop() {
	if (!drainState) drainState = { settled: false, reason: "server stopped before explicit provider drain", listenerClosed: false, completedAt: Date.now() };
	server.close(() => {
		drainState.listenerClosed = true;
		writeFinalSummary();
		process.exit(0);
	});
	const timer = setTimeout(() => {
		for (const socket of sockets.values()) socket.destroy();
		writeFinalSummary();
		process.exit(1);
	}, 500);
	timer.unref();
}
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
