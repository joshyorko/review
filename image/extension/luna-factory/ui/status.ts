/**
 * Native status surfaces.
 *
 * Small textual projections of the ledger, sized for a status line and for
 * progressive detail. Everything is plain text with no colour dependence and no
 * permanent dashboard, so a narrow or monochrome terminal degrades to the same
 * information rather than to a truncated glyph wall.
 */

import { evaluateRun, type RunVerdict } from "../core/convergence.ts";
import { criterionProven } from "../core/evidence.ts";
import type { Ledger, TaskId, TaskRecord } from "../core/model.ts";
import { findTask } from "../core/model.ts";

/** Plain-text truncation: one call site shape, used by every renderer here. */
export function truncatePlain(text: string, width: number): string {
	if (width <= 1 || text.length <= width) return text;
	return `${text.slice(0, width - 1)}…`;
}


/**
 * The one-line status indicator.
 *
 * Namespaced with `Factory <generation>` so it cannot be mistaken for Review's
 * queue gauge or Hive connectivity.
 */
export function renderStatus(ledger: Ledger, width = 120, verdict: RunVerdict = evaluateRun(ledger)): string {
	const active = verdict.activeMandatory;
	const blocked = verdict.blockedMandatory;
	const unknown = verdict.unknownMandatory;
	const parts = [
		`Factory ${ledger.generation}`,
		`${verdict.provenMandatory}/${verdict.totalMandatory} proven`,
		`${active} active`,
		`${blocked} blocked`,
		`${unknown} unknown`,
	];
	if (ledger.control !== "active") parts.push(ledger.control);
	if (verdict.converged) parts.push("converged");
	return truncatePlain(parts.join(" · "), width);
}

function taskLine(task: TaskRecord, ledger: Ledger): string {
	const deps = task.deps.length === 0 ? "none" : task.deps.join(", ");
	const attempts = task.attempts.length === 0 ? "none" : task.attempts.map((attempt) => `${attempt.id}(L${attempt.lineage},${attempt.state})`).join(", ");
	return `${task.id} ${task.state} · criterion ${task.criterionId} · effect ${task.effect} · deps ${deps} · attempts ${attempts}`;
}

/**
 * Progressive detail: what is done, why the rest is not, and what routing was
 * requested versus actually resolved.
 *
 * Routing is reported as `unknown` whenever it was not read from a native
 * record, because an omitted field is not evidence of a default.
 */
export function renderStatusDetail(ledger: Ledger, width = 120, verdict: RunVerdict = evaluateRun(ledger)): readonly string[] {
	const lines: string[] = [renderStatus(ledger, width, verdict)];
	lines.push(`goal: ${ledger.goal.statement}`);
	if (ledger.goal.nonGoals.length > 0) lines.push(`non-goals: ${ledger.goal.nonGoals.join("; ")}`);
	lines.push(`subject: ${ledger.subject.repo}@${ledger.subject.head ?? ledger.subject.base}`);
	lines.push(`permitted effects: ${ledger.goal.permittedEffects.join(", ") || "read only"}`);
	lines.push(`finish authority: ${ledger.goal.finishAuthority}`);
	lines.push(`appetite: ${ledger.goal.appetite.tasks} tasks, ${ledger.goal.appetite.attemptsPerTask} attempts each`);
	for (const criterion of ledger.criteria) {
		const proven = criterionProven(ledger, criterion.id);
		lines.push(`  ${criterion.mandatory ? "[mandatory]" : "[optional]"} ${criterion.id}: ${criterion.statement} — ${proven ? "proven" : "unproven"}`);
	}
	if (ledger.tasks.length === 0) {
		lines.push("no tasks admitted yet");
	} else {
		for (const task of ledger.tasks) {
			lines.push(`  ${taskLine(task, ledger)}`);
			lines.push(`      ${task.decision}: ${task.decisionReason}`);
			const attempt = [...task.attempts].reverse().find((candidate) => candidate.state === "returned");
			if (attempt?.receipt !== undefined) {
				const routing = attempt.receipt.routing;
				const requested = routing.requested ?? "unknown";
				const effective = routing.verified ? (routing.effective ?? "unknown") : "unverified";
				lines.push(`      routing: requested ${requested} · effective ${effective} · effort ${routing.effort ?? "unknown"}`);
				for (const predicate of attempt.receipt.predicates ?? []) {
					lines.push(`      predicate ${predicate.phase} ${predicate.ok ? "PASS" : "FAIL"}: ${predicate.item} — ${predicate.note}`);
				}
				const semantic = attempt.receipt.semanticResult;
				if (semantic) {
					lines.push(`      semantic result: ${semantic.outcome}; verified ${semantic.verified}; publication authority none`);
					if (semantic.publicationBlocker) lines.push(`      publication/disclosure blocker: ${semantic.publicationBlocker}`);
				}
			}
		}
	}
	for (const blocker of verdict.blockers) lines.push(`blocker: ${blocker}`);
	if (verdict.resumption !== undefined) lines.push(`resumption: ${verdict.resumption}`);
	return lines.map((line) => truncatePlain(line, width));
}

/** Explain one task's admission outcome and the record behind it. */
export function renderWhy(ledger: Ledger, taskId: TaskId, width = 120): readonly string[] {
	const task = findTask(ledger, taskId);
	if (task === undefined) return [truncatePlain(`${taskId} is not in the ledger`, width)];
	const lines = [
		`${task.id}: ${task.title}`,
		`decision ${task.decision} — ${task.decisionReason}`,
		`state ${task.state} · criterion ${task.criterionId} · effect ${task.effect} · owner ${task.owner}`,
	];
	for (const dep of task.deps) {
		const dependency = findTask(ledger, dep);
		lines.push(`dep ${dep}: ${dependency === undefined ? "unknown" : `${dependency.state}`}`);
	}
	for (const attempt of task.attempts) {
		lines.push(`attempt ${attempt.id} lineage ${attempt.lineage} ${attempt.state} subject ${attempt.subject.head ?? attempt.subject.base}${attempt.integrated ? " integrated" : ""}`);
		const receipt = attempt.receipt;
		if (receipt === undefined) continue;
		for (const reference of receipt.evidence) lines.push(`  evidence ${reference}`);
		for (const claim of receipt.tests) lines.push(`  test ${claim.outcome}: ${claim.command}`);
		for (const predicate of receipt.predicates ?? []) {
			lines.push(`  predicate ${predicate.phase} ${predicate.ok ? "PASS" : "FAIL"}: ${predicate.item} — ${predicate.note}`);
		}
		const semantic = receipt.semanticResult;
		if (semantic) {
			lines.push(`  semantic result ${semantic.outcome}; verified ${semantic.verified}; publication authority none`);
			if (semantic.publicationBlocker) lines.push(`  publication/disclosure blocker: ${semantic.publicationBlocker}`);
		}
		for (const item of receipt.unresolved) lines.push(`  unresolved ${item}`);
	}
	return lines.map((line) => truncatePlain(line, width));
}
