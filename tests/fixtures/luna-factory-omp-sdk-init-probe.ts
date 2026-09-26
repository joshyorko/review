import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { CreateAgentSessionOptions } from "@oh-my-pi/pi-coding-agent";

const packaged = process.env.LUNA_SDK_INIT_PACKAGED === "1";
const reviewModule = await import(packaged
	? "/usr/share/bluefin/review/extension/extension.ts"
	: "../../image/extension/bluefin-review/extension.ts");
const factoryRoot = packaged ? "/usr/share/bluefin/review/luna-factory" : "../../image/extension/luna-factory";
const [{ registerFactoryBatchSubmitter, registerFactoryController, registerFactoryDashboardOpener }, { runNative }] = await Promise.all([
	import(`${factoryRoot}/omp/batch-bridge.ts`),
	import(`${factoryRoot}/omp/batch-native.ts`),
]);
const { createReviewExtension } = reviewModule;

const root = process.env.LUNA_SDK_INIT_PROBE_ROOT;
if (!root) throw new Error("LUNA_SDK_INIT_PROBE_ROOT is required");
function isNativeContext(value: unknown): value is NativeContext {
	return value !== null && typeof value === "object" && "model" in value && "modelRegistry" in value;
}

export default function sdkInitializationProbe(pi: any) {
	// OMP kicks off model catalog discovery after session initialization. Suppress
	// that background probe for this ABI check; the test only needs the already
	// selected, authenticated parent model and never submits a provider prompt.
	const registryType = pi.pi.ModelRegistry;
	if (typeof registryType?.prototype?.refreshInBackground !== "function") throw new Error("pinned OMP ModelRegistry.refreshInBackground API unavailable");
	registryType.prototype.refreshInBackground = () => {};
	pi.on("session_start", async (_event: unknown, realContext: any) => {
		try {
		const registrations: Array<[string, (...args: any[]) => unknown]> = [];
		const overlays: any[] = [];
		const notices: string[] = [];
		const host = Object.create(pi);
		host.on = (name: string, handler: (...args: any[]) => unknown) => registrations.push([name, handler]);
		const review = createReviewExtension(host, {
			scope: "example/repo",
			org: "example",
			env: {
				HOME: root,
				GH_TOKEN: "local-probe-placeholder",
				REVIEW_MODE: "review",
				REVIEW_DEFAULT_SCOPE: "example/repo",
				LUNA_FACTORY_STATE_ROOT: join(root, "factory-state"),
				LUNA_FACTORY_CLAIMS_ROOT: join(root, "factory-claims"),
			},
			fetchImpl: async () => new Response(JSON.stringify({
				data: {
					viewer: { login: "probe" },
					search: {
						pageInfo: { hasNextPage: false },
						nodes: [{
							number: 1,
							title: "Pinned OMP SDK initialization probe",
							url: "https://github.com/example/repo/pull/1",
							updatedAt: new Date().toISOString(),
							isDraft: false,
							mergeable: "MERGEABLE",
							reviewDecision: "REVIEW_REQUIRED",
							headRefOid: "a".repeat(40),
							author: { login: "contributor" },
							repository: { nameWithOwner: "example/repo" },
							labels: { nodes: [] },
							commits: { nodes: [] },
						}],
					},
				},
			}), { headers: { "content-type": "application/json" } }),
		});
		const context = Object.create(realContext);
		Object.defineProperties(context, {
			hasUI: { value: true },
			ui: { value: {
				notify: (message: string) => { notices.push(message); },
				select: async () => "Inspect selected items",
				setStatus() {}, setWidget() {}, setTitle() {},
				theme: { fg: (_color: string, text: string) => text, bold: (text: string) => text, inverse: (text: string) => text },
				custom(factory: (...args: any[]) => unknown) {
					const { promise, resolve } = Promise.withResolvers<unknown>();
					overlays.push(factory({ requestRender() {} }, this.theme, {}, resolve));
					return promise;
				},
			} },
		});

		const initialized = new Error("SDK initialization sentinel: no provider prompt was issued");
		const completed = Promise.withResolvers<{ model: string; sdkVersion: string; tools: string[] }>();
		const removeController = registerFactoryController(async () => "unused");
		const removeDashboard = registerFactoryDashboardOpener(async () => {});
		const removeSubmitter = registerFactoryBatchSubmitter(async (_action, submittedContext) => {
			try {
				assert.equal(submittedContext.model, realContext.model, "Shift+F must preserve the selected OMP model reference");
				assert.equal(submittedContext.modelRegistry, realContext.modelRegistry, "Shift+F must preserve the active OMP model registry");
				assert.equal(Object.hasOwn(realContext, "model"), false, "OMP model must be inherited from the scoped handler context");
				const createAgentSession = pi.pi.createAgentSession.bind(pi.pi);
				let initializedModel: string | undefined;
				let toolNames: string[] = [];
				let createEntered = false;
				const sdk = {
					Settings: pi.pi.Settings,
					SessionManager: pi.pi.SessionManager,
					AgentRegistry: pi.pi.AgentRegistry,
					async createAgentSession(options: CreateAgentSessionOptions) {
					createEntered = true;
					assert.equal(options.model, realContext.model, "native SDK receives the current OMP model object");
					assert.equal(options.modelRegistry, realContext.modelRegistry, "native SDK receives the current public model registry");
					assert.equal(options.authStorage, realContext.modelRegistry.authStorage, "native SDK receives the registry-owned auth storage");
					assert.equal(options.restrictToolNames, true);
					assert.equal(options.allowRestrictedCustomTools, true);
					toolNames = options.toolNames as string[];
					const native = await createAgentSession(options);
					if (native.modelFallbackMessage) {
						await native.session.dispose();
						throw new Error(native.modelFallbackMessage);
					}
					assert.ok(native.session.sessionFile, "SDK initialization created a persistent native session");
					assert.ok(native.session.model, "SDK initialization retained the selected model");
					initializedModel = `${native.session.model!.provider}/${native.session.model!.id}`;
					await native.session.dispose();
					throw initialized;
					},
				};

				const item = {
					workspace: join(root, "workspace"),
					selected: { key: "example/repo#1", repo: "example/repo", number: 1, kind: "pr", action: "inspect", overlaps: [], acceptance: "Initialize a restricted native SDK session without prompting a provider." },
					sessions: [], attempts: 0, stage: "QUEUED", ledger: {},
				} as never;
				if (!isNativeContext(submittedContext)) throw new Error("Review handoff did not preserve OMP model context");
				await assert.rejects(
					runNative(sdk, pi.zod, submittedContext, item, join(root, "factory-state"), "worker", new AbortController().signal, () => {}, () => {}),
					(error: unknown) => error === initialized,
				);
				assert.equal(createEntered, true, "explicit SDK adapter intercepted initialization before any prompt");
				assert.ok(initializedModel, "actual createAgentSession completed without a model fallback");
				assert.ok(toolNames.length > 0 && toolNames.every((name) => name.startsWith("factory_")), "actual SDK received only Factory tools");
				completed.resolve({ model: initializedModel, sdkVersion: String(pi.pi.VERSION ?? "unknown"), tools: toolNames });
				return { batchId: "sdk-init-probe", text: "native SDK initialized; provider prompt withheld" };
			} catch (error) {
				completed.reject(error);
				throw error;
			}
		});

		try {
			await registrations.find(([name]) => name === "session_start")?.[1]({}, context);
			await review.whenStarted();
			assert.ok(overlays[0], notices.join("; ") || "Review queue overlay did not open");
			overlays[0].handleInput(" ");
			overlays[0].handleInput("F");
			const timeout = new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error(`Shift+F handoff timed out: ${notices.join("; ")}`)), 30_000));
			const evidence = await Promise.race([completed.promise, timeout]);
			const result = { status: "passed", providerPrompt: "not-issued", backgroundModelDiscovery: "suppressed", ...evidence };
			writeFileSync(join(root, "result.json"), JSON.stringify(result, null, 2));
			console.log(`LUNA_SDK_INIT_PROBE_PASS ${JSON.stringify(result)}`);
			removeSubmitter(); removeDashboard(); removeController();
			await registrations.find(([name]) => name === "session_shutdown")?.[1]({}, context);
			process.exit(0);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			writeFileSync(join(root, "result.json"), JSON.stringify({ status: "failed", reason: message, notices }, null, 2));
			console.error(`LUNA_SDK_INIT_PROBE_FAIL ${message}`);
			process.exit(1);
		}
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			try { writeFileSync(join(root, "result.json"), JSON.stringify({ status: "failed", reason: message }, null, 2)); } catch {}
			console.error(`LUNA_SDK_INIT_PROBE_FAIL ${message}`);
			process.exit(1);
		}
	});
}
