/**
 * The completion receipt.
 *
 * A model can stream "done" before verification exists, and the core stop hook
 * cannot retract a sentence that has already reached the user. The answer is a
 * separate, distinctly labelled artifact that reports what the ledger proves —
 * including the honest case where nothing is proven yet — so a premature success
 * sentence in prose has nothing to attach to.
 */

import { evaluateRun, type RunVerdict } from "./convergence.ts";
import { criterionProven } from "./evidence.ts";
import type { Ledger } from "./model.ts";

/**
 * Render the Factory-verified receipt for a ledger.
 *
 * Deliberately not a function of anything the model said: the caller passes the
 * ledger, and the text is derived only from records that survived admission and
 * reconciliation.
 */
export function renderCompletionReceipt(ledger: Ledger, verdict: RunVerdict = evaluateRun(ledger)): string {
	const lines: string[] = [];
	let semanticTotal = 0;
	let verifiedSemantic = 0;
	const publicationBlockers = new Set<string>();
	for (const task of ledger.tasks) {
		for (const attempt of task.attempts) {
			const result = attempt.receipt?.semanticResult;
			if (!result) continue;
			semanticTotal += 1;
			if (result.verified && result.outcome !== "uncertain") verifiedSemantic += 1;
			if (result.publicationBlocker) publicationBlockers.add(result.publicationBlocker);
		}
	}
	if (semanticTotal > 0) lines.push(`semantic results retained: ${semanticTotal} (${verifiedSemantic} verified); publication authority none; results alone are not criterion proof`);
	if (publicationBlockers.size > 0) {
		lines.push(`publication/disclosure blockers retained: ${publicationBlockers.size}`);
		for (const blocker of [...publicationBlockers].slice(0, 8)) lines.push(`  - ${blocker}`);
		if (publicationBlockers.size > 8) lines.push(`  - ${publicationBlockers.size - 8} additional blockers omitted`);
	}
	if (verdict.converged) {
		lines.push("FACTORY VERIFIED — objective met");
		lines.push(`run ${ledger.runId} · ${ledger.generation} · revision ${ledger.revision}`);
		lines.push(`mandatory criteria proven: ${verdict.provenMandatory}/${verdict.totalMandatory}`);
		lines.push(`current mandatory work: ${verdict.activeMandatory} active · ${verdict.blockedMandatory} blocked · ${verdict.unknownMandatory} unknown`);
		for (const criterion of ledger.criteria) {
			if (!criterion.mandatory) continue;
			lines.push(`  ${criterionProven(ledger, criterion.id) ? "[proven]" : "[unproven]"} ${criterion.id}: ${criterion.statement}`);
		}
		lines.push("This receipt certifies acceptance evidence only. It grants no merge or deploy authority.");
		return lines.join("\n");
	}

	lines.push("FACTORY NOT CONVERGED");
	lines.push(`run ${ledger.runId} · ${ledger.generation} · revision ${ledger.revision} · ${verdict.control}`);
	lines.push(`current mandatory work: ${verdict.activeMandatory} active · ${verdict.blockedMandatory} blocked · ${verdict.unknownMandatory} unknown`);
	lines.push(`mandatory criteria proven: ${verdict.provenMandatory}/${verdict.totalMandatory}`);
	for (const id of verdict.remaining) lines.push(`  [unproven] ${id}`);
	if (verdict.blockers.length > 0) {
		lines.push("blockers:");
		for (const blocker of verdict.blockers) lines.push(`  - ${blocker}`);
	}
	if (verdict.resumption !== undefined) lines.push(`resumption condition: ${verdict.resumption}`);
	lines.push("This is not a completion. A returned worker is not acceptance evidence.");
	return lines.join("\n");
}
