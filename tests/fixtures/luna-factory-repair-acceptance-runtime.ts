import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { BatchService, currentItem, repairFixture } from "./luna-factory-repair-acceptance-support.ts";

export default function repairAcceptanceRuntime(pi: ExtensionAPI) {
	pi.on("session_start", async (_event, context) => {
		const root = process.env.LUNA176_ROOT;
		const phase = process.env.LUNA176_PHASE;
		if (!root || !["seed", "resume"].includes(phase ?? "")) throw new Error("repair acceptance root and phase are required");
		let service: InstanceType<typeof BatchService> | undefined;
		try {
			const effectiveUid = process.getuid?.();
			assert.ok(typeof effectiveUid === "number", "this Linux acceptance profile requires effective UID evidence");
			const expectedUid = process.env.LUNA176_EXPECTED_UID;
			if (expectedUid) assert.equal(effectiveUid, Number(expectedUid), "packaged runtime must preserve its intended effective user before state creation");
			const sdk = pi.pi;
			const binding = { model: context.model, modelRegistry: context.modelRegistry };
			const state = join(root, "factory-state");
			let batchId: string;
			if (phase === "seed") {
				const check = "#!/usr/bin/env bash\nset -euo pipefail\nif [[ $(cat value.txt) != 1 ]]; then\n  printf 'DISTINCTIVE_OUTPUT_FAILURE: zero is still wrong\\n'\n  printf 'trailing-noise%.0s' {1..2400}\n  exit 1\nfi\n";
				const fixture = repairFixture(async () => { throw new Error("a simulated SDK must never execute in the native acceptance probe"); }, { root: state, sdk, schema: pi.zod, acceptanceScript: check });
				service = fixture.service; batchId = fixture.batch.id;
				let paused = false;
				const remove = service.onChange(() => {
					const item = currentItem(service!.store.read(batchId));
					if (!paused && item.stage === "QUEUED" && item.attempts === 1 && item.ledger.tasks[0]?.attempts[0]?.receipt) {
						paused = true; void service!.control(batchId, "pause");
					}
				});
				await service.resume(batchId, binding); await service.waitForIdle(); remove();
				const first = currentItem(service.store.read(batchId));
				assert.equal(paused, true, first.blocker);
				assert.equal(first.attempts, 1); assert.equal(first.stage, "QUEUED");
				assert.match(first.repair!.reason, /DISTINCTIVE_REJECTION/);
				assert.ok(first.repair!.artifacts.some((artifact) => artifact.bytes > 131_072));
				writeFileSync(join(root, "seed-subject.json"), JSON.stringify({ generation: first.ledger.generation, subject: first.ledger.subject }));
			} else {
				service = new BatchService(state, { assertFresh: async () => {}, snapshot: async (selected: unknown) => selected } as never, sdk, pi.zod, 1);
				const saved = service.store.list(); assert.equal(saved.length, 1); batchId = saved[0]!.id;
				const before = currentItem(saved[0]!);
				assert.equal(before.attempts, 1); assert.equal(before.stage, "QUEUED");
				const generation = before.ledger.generation; const subject = structuredClone(before.ledger.subject);
				await service.resume(batchId, binding); await service.waitForIdle();
				const final = currentItem(service.store.read(batchId));
				assert.equal(final.attempts, 2, final.blocker); assert.equal(final.ledger.tasks[0]!.attempts.length, 2);
				assert.equal(final.ledger.generation, generation); assert.deepEqual(final.ledger.subject, subject);
				assert.equal(final.stage, "VERIFY", final.blocker); assert.equal(final.proof?.stage, "verified-patch");
				assert.deepEqual(final.selected.requiredChecks, ["bash ./tests/acceptance.sh"]);
				assert.equal(final.operations.some((operation) => ["push", "pr"].includes(operation.phase)), false);
			}
			const item = currentItem(service.store.read(batchId));
			await service.shutdown();
			const result = { status: "passed", phase, batchId, effectiveUid, attempts: item.attempts, stage: item.stage, proofStage: item.proof?.stage ?? null, operatorFollowups: 0, ownerIntegrationRequired: true, generation: item.ledger.generation, subject: item.ledger.subject, modelCalls: service.store.read(batchId).usage.modelCalls };
			writeFileSync(join(root, `${phase}-result.json`), JSON.stringify(result, null, 2));
			console.log(JSON.stringify(result)); process.exit(0);
		} catch (error) {
			const reason = error instanceof Error ? error.message : String(error);
			if (service?.isWriterAcquired()) await service.shutdown().catch(() => {});
			writeFileSync(join(root, `${phase}-result.json`), JSON.stringify({ status: "failed", phase, reason }, null, 2));
			console.error(reason); process.exit(1);
		}
	});
}
