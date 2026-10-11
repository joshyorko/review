import { writeFileSync } from "node:fs";
import { abortPostFinding, completePostAccounting } from "./luna-factory-policy-request-probe-contracts.mjs";
import type {
	CreateAgentSessionOptions,
	ExtensionAPI,
	ExtensionFactory,
} from "@oh-my-pi/pi-coding-agent";

type ProbeCase = "allow" | "abort" | "throw" | "timeout";
const cases: ProbeCase[] = ["allow", "abort", "throw", "timeout"];
const resultPath = process.env.LUNA_POLICY_PROBE_RESULT;
const statsUrl = process.env.LUNA_POLICY_PROBE_STATS_URL;
const expectedSourceCommit = "9348320cc4a30a7195d36a1f05a6c11bcb701a17";
const expectedVersion = "18.5.0";

if (!resultPath || !statsUrl) throw new Error("probe result path and loopback stats URL are required");

function writeResult(result: Record<string, unknown>): void {
	writeFileSync(resultPath!, `${JSON.stringify(result, null, 2)}\n`);
}

async function readStats(): Promise<{
	providerRequests: Array<{ method: string; path: string; case: string; bytes: number }>;
	methodPathCounts: Record<string, number>;
	caseWindows: Array<{
		case: ProbeCase;
		finished: boolean;
		postCount: number;
		untaggedPostCount: number;
		markerMismatchPostCount: number;
		requests: Array<{ method: string; path: string; case: string; markerCase: string | null; receivedAt: number; bytes: number }>;
	}>;
	totalPostCount: number;
	assignedPostCount: number;
	unassignedPostCount: number;
	untaggedPostCount: number;
	markerMismatchPostCount: number;
	activeCase: ProbeCase | null;
}> {
	const response = await fetch(statsUrl!);
	if (!response.ok) throw new Error(`local provider stats returned HTTP ${response.status}`);
	return await response.json() as Awaited<ReturnType<typeof readStats>>;
}

async function startCase(probeCase: ProbeCase): Promise<void> {
	const url = new URL(statsUrl!);
	url.pathname = "/__probe/start";
	url.search = new URLSearchParams({ case: probeCase }).toString();
	const response = await fetch(url);
	if (!response.ok) throw new Error(`could not open provider accounting window for ${probeCase}: HTTP ${response.status}`);
}

async function finishCase(probeCase: ProbeCase) {
	const url = new URL(statsUrl!);
	url.pathname = "/__probe/finish";
	url.search = new URLSearchParams({ case: probeCase }).toString();
	const response = await fetch(url);
	if (!response.ok) throw new Error(`could not close provider accounting window for ${probeCase}: HTTP ${response.status}`);
	return await response.json() as {
		case: ProbeCase;
		finished: boolean;
		postCount: number;
		untaggedPostCount: number;
		markerMismatchPostCount: number;
		requests: Array<{ method: string; path: string; case: string; markerCase: string | null; receivedAt: number; bytes: number }>;
	};
}

function failureSummary(error: unknown): string | undefined {
	if (error === undefined) return undefined;
	return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

export default function policyRequestProbe(pi: ExtensionAPI) {
	pi.on("session_start", async (_event, context) => {
		const createAgentSession = pi.pi.createAgentSession.bind(pi.pi);
		const { SessionManager, Settings } = pi.pi;
		const sdkVersion = String(pi.pi.VERSION ?? "unknown");
		const sourceCommit = process.env.OMP_SOURCE_COMMIT;
		const binaryPath = process.env.LUNA_POLICY_PROBE_OMP_BINARY_PATH;
		const binarySha256 = process.env.LUNA_POLICY_PROBE_OMP_BINARY_SHA256;
		const binaryVersion = process.env.LUNA_POLICY_PROBE_BINARY_VERSION;
		const imageDigest = process.env.LUNA_POLICY_PROBE_IMAGE_DIGEST;
		const configDigest = process.env.LUNA_POLICY_PROBE_CONFIG_DIGEST;
		const runtime = process.env.LUNA_POLICY_PROBE_RUNTIME;
		const cooperativeEvidenceSha256 = process.env.LUNA_POLICY_PROBE_EVIDENCE_SHA256;
		const attester = process.env.LUNA_POLICY_PROBE_ATTESTER;
		const model = context.model;
		const effectiveUid = typeof process.getuid === "function" ? process.getuid() : null;
		if (!sourceCommit || !binaryPath || !binarySha256 || !binaryVersion || !imageDigest || !configDigest || !runtime || !cooperativeEvidenceSha256 || !attester) {
			writeResult({ status: "blocked", reason: "runner did not provide the cooperative root evidence input" });
			process.exit(78);
		}
		if (sourceCommit !== expectedSourceCommit || sdkVersion !== expectedVersion || binaryVersion !== "omp/18.5.0" || binaryPath !== "/usr/bin/omp") {
			writeResult({ status: "blocked", reason: "source, version, or binary path does not match the fixed OMP 18.5.0 package identity", sourceCommit, sdkVersion, binaryVersion, binaryPath, expectedSourceCommit, expectedVersion });
			process.exit(78);
		}
		if (effectiveUid === null || String(effectiveUid) !== process.env.LUNA_POLICY_PROBE_EFFECTIVE_UID) {
			writeResult({ status: "blocked", reason: "OMP process UID does not match the validated root attestation", effectiveUid });
			process.exit(78);
		}
		if (!model || model.provider !== "local-probe" || model.id !== "deterministic") {
			writeResult({ status: "blocked", reason: "active model is not the isolated loopback route", model: model ? `${model.provider}/${model.id}` : null });
			process.exit(78);
		}

		const results: Record<string, unknown> = {};
		try {
			for (const probeCase of cases) {
				let hookCalls = 0;
				let abortCalled = false;
				let hookEnteredAt: number | undefined;
				let payloadKeys: string[] = [];
				let promptResult: boolean | undefined;
				let promptError: string | undefined;
				let window: Awaited<ReturnType<typeof finishCase>> | undefined;
				const extension: ExtensionFactory = (api) => {
					api.on("before_provider_request", async (event, extensionContext) => {
						hookCalls += 1;
						hookEnteredAt = Date.now();
						payloadKeys = event.payload !== null && typeof event.payload === "object"
							? Object.keys(event.payload as Record<string, unknown>).sort()
							: [];
						if (probeCase === "abort") {
							abortCalled = true;
							extensionContext.abort();
							return;
						}
						if (probeCase === "throw") throw new Error("intentional policy probe handler failure");
						if (probeCase === "timeout") await new Promise<void>(() => {});
					});
				};

				const options: CreateAgentSessionOptions = {
					cwd: process.cwd(),
					model,
					modelRegistry: context.modelRegistry,
					authStorage: context.modelRegistry.authStorage,
					sessionManager: SessionManager.inMemory(process.cwd()),
					settings: Settings.isolated({
						"advisor.enabled": false,
						"autolearn.enabled": false,
						"retry.enabled": false,
						"compaction.enabled": false,
					}),
					cacheWarming: false,
					skills: [],
					rules: [],
					disableExtensionDiscovery: true,
					extensions: [extension],
					systemPrompt: "Reply with the short text probe-complete. Do not call tools.",
				};

				let session: Awaited<ReturnType<typeof createAgentSession>>["session"] | undefined;
				const startedAt = Date.now();
				try {
					await startCase(probeCase);
					({ session } = await createAgentSession(options));
					if (!session.model || session.model.provider !== "local-probe" || session.model.id !== "deterministic") {
						throw new Error("SDK session did not retain the exact local probe route");
					}
					promptResult = await session.prompt(`LUNA_POLICY_PROBE_CASE=${probeCase}; reply only probe-complete`);
				} catch (error) {
					promptError = failureSummary(error);
				} finally {
					await session?.dispose();
					window = await finishCase(probeCase);
				}

				const stats = await readStats();
				const sent = window.requests;
				const firstPost = sent.find((request) => request.method === "POST");
				results[probeCase] = {
					hookCalls,
					abortCalled,
					promptResult: promptResult ?? null,
					promptError: promptError ?? null,
					elapsedMs: Date.now() - startedAt,
					hookToFirstPostMs: hookEnteredAt === undefined || !firstPost ? null : firstPost.receivedAt - hookEnteredAt,
					payloadKeys,
					providerSendCount: window.postCount,
					untaggedPostCount: window.untaggedPostCount,
					markerMismatchPostCount: window.markerMismatchPostCount,
					providerRequests: sent,
				};
			}

			const stats = await readStats();
			const accountingComplete = completePostAccounting(stats, cases);
			const markerAttributionComplete = stats.untaggedPostCount === 0 && stats.markerMismatchPostCount === 0;
			const aborted = results.abort as { abortCalled: boolean; providerSendCount: number };
			const thrown = results.throw as { hookCalls: number; providerSendCount: number };
			const timedOut = results.timeout as { hookCalls: number; providerSendCount: number; hookToFirstPostMs: number | null };
			const allowed = results.allow as { hookCalls: number; providerSendCount: number };
			const abortWindow = stats.caseWindows.find((window) => window.case === "abort");
			const abortFinding = abortPostFinding(aborted.abortCalled, abortWindow, accountingComplete, markerAttributionComplete);
			const finding = {
				allowedRequestObserved: allowed.hookCalls > 0 && allowed.providerSendCount > 0,
				abortZeroSendObserved: abortFinding.zeroSendObserved,
				abortSendObserved: abortFinding.sendObserved,
				throwFailOpenObserved: thrown.hookCalls > 0 && thrown.providerSendCount > 0,
				timeoutFailOpenObserved: timedOut.hookCalls > 0 && timedOut.providerSendCount > 0 && (timedOut.hookToFirstPostMs ?? 0) >= 25_000,
			};
			writeResult({
				status: accountingComplete ? "observed" : "ambiguous",
				claimBoundary: "This is a single-route public API probe; it does not establish a durable request budget or complete inference-path coverage.",
				identity: {
					ompSdkVersion: sdkVersion,
					ompBinaryVersion: binaryVersion,
					ompSourceCommit: sourceCommit,
					ompBinaryPath: binaryPath,
					ompBinarySha256: binarySha256,
					imageDigest,
					containerConfigDigest: configDigest,
					runtime,
					effectiveUid,
					cooperativeEvidenceFileSha256: cooperativeEvidenceSha256,
					attesterLabel: attester,
					route: `${model.provider}/${model.id}`,
				},
				accounting: { complete: accountingComplete, markerAttributionComplete, totalPostCount: stats.totalPostCount, assignedPostCount: stats.assignedPostCount, unassignedPostCount: stats.unassignedPostCount, untaggedPostCount: stats.untaggedPostCount, markerMismatchPostCount: stats.markerMismatchPostCount },
				finding,
				cases: results,
				providerMethodPathCounts: stats.methodPathCounts,
				providerRequests: stats.providerRequests,
			});
			console.log(`LUNA_POLICY_REQUEST_PROBE ${JSON.stringify({ status: accountingComplete ? "observed" : "ambiguous", finding, accounting: { totalPostCount: stats.totalPostCount, assignedPostCount: stats.assignedPostCount, unassignedPostCount: stats.unassignedPostCount }, providerMethodPathCounts: stats.methodPathCounts })}`);
			process.exit(accountingComplete ? 0 : 1);
		} catch (error) {
			writeResult({ status: "failed", reason: failureSummary(error), ompSdkVersion: sdkVersion, sourceCommit });
			console.error(`LUNA_POLICY_REQUEST_PROBE_FAILED ${failureSummary(error)}`);
			process.exit(1);
		}
	});
}
