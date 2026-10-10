import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { request as httpRequest, Agent } from "node:http";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	abortPostFinding,
	completePostAccounting,
	cooperativeIdentityProblems,
	validateAttestationFileStat,
	validateCooperativeIdentityInput,
} from "./luna-factory-policy-request-probe-contracts.mjs";

const root = await mkdtemp(join(tmpdir(), "luna-policy-probe-negative."));
const readyPath = join(root, "ready.json");
const auditPath = join(root, "provider.jsonl");
const serverPath = new URL("./luna-factory-policy-request-probe-server.mjs", import.meta.url);
const child = spawn(process.execPath, [serverPath.pathname], {
	env: { PATH: process.env.PATH ?? "", HOME: root, LUNA_POLICY_PROBE_READY: readyPath, LUNA_POLICY_PROBE_AUDIT: auditPath },
	stdio: ["ignore", "pipe", "pipe"],
});
let childOutput = "";
child.stdout.setEncoding("utf8").on("data", (chunk) => { childOutput += chunk; });
child.stderr.setEncoding("utf8").on("data", (chunk) => { childOutput += chunk; });
let failure;
try {
	const missingIdentityProblems = cooperativeIdentityProblems(undefined, undefined);
	assert.ok(missingIdentityProblems.some((problem) => problem.includes("format/attester")));
	assert.ok(missingIdentityProblems.some((problem) => problem.includes("image/config digest")));
	assert.ok(missingIdentityProblems.some((problem) => problem.includes("effective UID")));
	assert.ok(missingIdentityProblems.some((problem) => problem.includes("fixed /usr/bin/omp")));
	assert.ok(missingIdentityProblems.some((problem) => problem.includes("18.5.0 package pin")));
	assert.ok(missingIdentityProblems.some((problem) => problem.includes("packaged SBOM pin")));
	assert.ok(missingIdentityProblems.some((problem) => problem.includes("measured /usr/bin/omp")));
	assert.throws(() => validateCooperativeIdentityInput(undefined, undefined), /cooperative identity|root-provided/i);
	assert.throws(() => validateAttestationFileStat({ isFile: false, nlink: 1, mode: 0o444 }), /single-link, read-only regular file/);
	assert.throws(() => validateAttestationFileStat({ isFile: true, nlink: 2, mode: 0o444 }), /single-link, read-only regular file/);
	assert.throws(() => validateAttestationFileStat({ isFile: true, nlink: 1, mode: 0o644 }), /single-link, read-only regular file/);

	let ready;
	for (let attempt = 0; attempt < 100; attempt += 1) {
		try {
			ready = JSON.parse(await readFile(readyPath, "utf8"));
			break;
		} catch {
			if (child.exitCode !== null) throw new Error("provider exited before ready: " + childOutput);
			await new Promise((resolve) => setTimeout(resolve, 20));
		}
	}
	assert.ok(ready, "provider becomes ready");
	const base = "http://127.0.0.1:" + ready.port;
	async function get(path) {
		const response = await fetch(base + path);
		return { status: response.status, body: await response.json() };
	}
	async function post(path, content) {
		return await fetch(base + path, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ messages: [{ role: "user", content }] }),
		});
	}
	function delayedBodyPost() {
		const agent = new Agent({ keepAlive: true, maxSockets: 1 });
		return new Promise((resolve, reject) => {
			const request = httpRequest(base + "/v1/chat/completions", {
				method: "POST",
				agent,
				headers: { "content-type": "application/json" },
			}, (response) => {
				response.resume();
				response.once("end", () => {
					const timer = setTimeout(() => { agent.destroy(); resolve(response.statusCode); }, 250);
					timer.unref?.();
				});
			});
			request.once("error", reject);
			request.flushHeaders();
			const timer = setTimeout(() => request.end(JSON.stringify({ messages: [{ role: "user", content: "late body without case marker" }] })), 250);
			timer.unref?.();
		});
	}

	const empty = {
		activeCase: null,
		totalPostCount: 0,
		assignedPostCount: 0,
		unassignedPostCount: 0,
		untaggedPostCount: 0,
		markerMismatchPostCount: 0,
		caseWindows: [{ case: "abort", finished: true, postCount: 0, untaggedPostCount: 0, markerMismatchPostCount: 0 }],
	};
	assert.equal(abortPostFinding(true, empty.caseWindows[0], completePostAccounting(empty, ["abort"]), true).zeroSendObserved, true, "clean zero-send baseline is measurable");

	assert.equal((await get("/__probe/start?case=allow")).status, 200);
	assert.equal((await post("/v1/chat/completions", "LUNA_POLICY_PROBE_CASE=allow; normal allowed send")).status, 200);
	const allowed = await get("/__probe/finish?case=allow");
	assert.equal(allowed.body.postCount, 1);
	assert.equal(allowed.body.untaggedPostCount, 0);
	assert.equal(allowed.body.markerMismatchPostCount, 0);

	assert.equal((await get("/__probe/start?case=abort")).status, 200);
	assert.equal((await post("/v1/chat/completions", "untagged send inside abort window")).status, 200);
	const inAbort = await get("/__probe/finish?case=abort");
	assert.equal(inAbort.body.postCount, 1);
	assert.equal(inAbort.body.untaggedPostCount, 1);
	let snapshot = (await get("/__probe/stats")).body;
	let complete = completePostAccounting(snapshot, ["allow", "abort"]);
	let finding = abortPostFinding(true, snapshot.caseWindows.find((window) => window.case === "abort"), complete, snapshot.untaggedPostCount === 0 && snapshot.markerMismatchPostCount === 0);
	assert.equal(finding.zeroSendObserved, false, "untagged POST during abort is counted and blocks zero-send");

	const untaggedElsewhere = {
		activeCase: null,
		totalPostCount: 1,
		assignedPostCount: 1,
		unassignedPostCount: 0,
		untaggedPostCount: 1,
		markerMismatchPostCount: 0,
		caseWindows: [
			{ case: "allow", finished: true, postCount: 1, untaggedPostCount: 1, markerMismatchPostCount: 0 },
			{ case: "abort", finished: true, postCount: 0, untaggedPostCount: 0, markerMismatchPostCount: 0 },
		],
	};
	complete = completePostAccounting(untaggedElsewhere, ["allow", "abort"]);
	finding = abortPostFinding(true, untaggedElsewhere.caseWindows[1], complete, untaggedElsewhere.untaggedPostCount === 0);
	assert.equal(complete, true, "case windows account for every POST even if a marker is absent");
	assert.equal(finding.zeroSendObserved, false, "an untagged send in another case cannot yield an abort zero-send observation");

	assert.equal((await post("/v1/internal-retry", "out-of-window send")).status, 404);
	snapshot = (await get("/__probe/stats")).body;
	complete = completePostAccounting(snapshot, ["allow", "abort"]);
	finding = abortPostFinding(true, snapshot.caseWindows.find((window) => window.case === "abort"), complete, snapshot.untaggedPostCount === 0 && snapshot.markerMismatchPostCount === 0);
	assert.equal(snapshot.unassignedPostCount, 1, "out-of-window POST is surfaced as unassigned");
	assert.equal(complete, false, "any unassigned POST invalidates the accounting receipt");
	assert.equal(finding.zeroSendObserved, false, "incomplete accounting cannot yield a zero-send observation");

	// The OMP-side case windows are closed; model a queued send arriving only after the caller exits.
	const drainPromise = get("/__probe/drain?quietMs=500&maxWaitMs=3000");
	await new Promise((resolve) => setTimeout(resolve, 100));
	const latePostStatus = await delayedBodyPost();
	assert.equal(latePostStatus, 200, "late/in-flight POST is served during the provider drain");
	const drain = await drainPromise;
	assert.equal(drain.status, 200);
	assert.equal(drain.body.status, "settled");
	assert.equal(drain.body.settlement.quietMs, 500);
	assert.ok(drain.body.settlement.waitedMs >= 500, "drain observes a full post-exit quiet window");
	assert.ok(drain.body.settlement.quietForMs >= 500, "drain reports the settled quiet duration");
	assert.equal(drain.body.settlement.lateProviderRequestCount, 1);
	assert.ok(drain.body.settlement.peakActiveProviderRequestCount >= 1, "drain observes the in-flight request");
	assert.ok(drain.body.settlement.peakActiveProviderConnectionCount >= 1, "drain observes its provider connection");
	assert.equal(drain.body.settlement.activeProviderRequestCount, 0);
	assert.equal(drain.body.settlement.activeProviderConnectionCount, 0);
	assert.equal(drain.body.snapshot.unassignedPostCount, 2, "late post remains in the unassigned count");
	complete = completePostAccounting(drain.body.snapshot, ["allow", "abort"]);
	assert.equal(complete, false, "late post keeps the final receipt incomplete");
	let summaryText;
	for (let attempt = 0; attempt < 100; attempt += 1) {
		try { summaryText = await readFile(auditPath + ".summary.json", "utf8"); break; }
		catch { await new Promise((resolve) => setTimeout(resolve, 20)); }
	}
	assert.ok(summaryText, "drain writes a final provider/listener closure summary");
	const finalSummary = JSON.parse(summaryText);
	assert.equal(finalSummary.drain.settled, true);
	assert.equal(finalSummary.drain.listenerClosed, true, "listener closure is recorded after active sockets settle");
	assert.equal(finalSummary.drain.forcedSocketClose, false);
	assert.equal(finalSummary.activeProviderRequestCount, 0);
	assert.equal(finalSummary.activeProviderConnectionCount, 0);
	for (let attempt = 0; attempt < 100 && child.exitCode === null; attempt += 1) await new Promise((resolve) => setTimeout(resolve, 10));
	assert.equal(child.exitCode, 0, "provider process exits cleanly after listener closure");

	console.log(JSON.stringify({
		status: "passed",
		negativeControls: {
			identityValidator: { missingInputProblems: missingIdentityProblems.length, invalidFileMetadataCases: 3, nativeBinaryRequired: false },
			untaggedInAbortWindow: { postCount: inAbort.body.postCount, untaggedPostCount: inAbort.body.untaggedPostCount, zeroSendObserved: false },
			untaggedInOtherCase: { abortPostCount: 0, totalUntaggedPostCount: 1, zeroSendObserved: false },
			unassignedOutsideWindow: { unassignedPostCount: snapshot.unassignedPostCount, accountingComplete: complete, zeroSendObserved: false },
			lateInFlightPost: {
				latePostCount: drain.body.settlement.lateProviderRequestCount,
				peakActiveRequests: drain.body.settlement.peakActiveProviderRequestCount,
				peakActiveConnections: drain.body.settlement.peakActiveProviderConnectionCount,
				quietMs: drain.body.settlement.quietMs,
				waitedMs: drain.body.settlement.waitedMs,
				quietForMs: drain.body.settlement.quietForMs,
				drainStatus: drain.body.status,
				listenerClosed: finalSummary.drain.listenerClosed,
				forcedSocketClose: finalSummary.drain.forcedSocketClose,
				activeRequestsAfterClose: finalSummary.activeProviderRequestCount,
				activeConnectionsAfterClose: finalSummary.activeProviderConnectionCount,
			},
		},
		methodPathCounts: finalSummary.methodPathCounts,
	}));
} catch (error) {
	failure = error;
}
if (child.exitCode === null && child.signalCode === null) {
	child.kill("SIGTERM");
	await new Promise((resolve) => child.once("exit", resolve));
}
if (failure) {
	console.error(failure);
	process.exitCode = 1;
}
await rm(root, { recursive: true, force: true });
