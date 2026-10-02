/** Pure bounded work-graph observation and admission. No OMP, GitHub, clock, or I/O. */

export type GraphRelationKind = "contains" | "requires" | "implements" | "stacked-on" | "overlaps";
export type GraphAuthority = "authoritative" | "inferred";
export type GraphOutcomeStage = "verified-patch" | "pr-ready" | "merged-upstream";
export type GraphObservedState = "QUEUED" | "RUNNING" | "VERIFY" | "DONE" | "BLOCKED" | "UNKNOWN" | "EXCLUDED";
export type GraphDecisionState = "READY" | "RUNNING" | "VERIFY" | "DONE" | "BLOCKED" | "UNKNOWN";

export interface GraphSubject {
	readonly repo: string;
	readonly base: string;
	readonly head?: string;
}

export interface GraphRelation {
	/** The dependent/source node. */
	readonly from: string;
	/** The prerequisite/target node. */
	readonly to: string;
	readonly kind: GraphRelationKind;
	readonly authority: GraphAuthority;
	readonly source: string;
	readonly stage?: GraphOutcomeStage;
	readonly reason?: string;
}

export interface GraphNodeObservation {
	readonly key: string;
	readonly generation: string;
	readonly subject?: GraphSubject;
	readonly required: boolean;
	readonly target: GraphOutcomeStage;
	readonly state: GraphObservedState;
	readonly proof?: GraphOutcomeStage;
	readonly proofCurrent?: boolean;
	readonly blocker?: string;
}

export interface WorkGraphObservation {
	readonly generation: string;
	readonly nodes: readonly GraphNodeObservation[];
	readonly relations: readonly GraphRelation[];
}

export interface GraphNodeDecision extends GraphNodeObservation {
	readonly decision: GraphDecisionState;
	readonly blockers: readonly string[];
	readonly softHints: readonly string[];
}
interface MutableGraphNodeDecision extends GraphNodeObservation {
	readonly decision: GraphDecisionState;
	blockers: string[];
	softHints: string[];
}

export interface WorkGraphDecision {
	readonly generation: string;
	readonly nodes: readonly GraphNodeDecision[];
	readonly ready: readonly string[];
	readonly blockers: readonly string[];
	readonly softHints: readonly string[];
	readonly verdict: "ACTIVE" | "CONVERGED" | "AUTONOMOUSLY_QUIESCENT";
	readonly modelCalls: 0;
}

const STAGES: readonly GraphOutcomeStage[] = ["verified-patch", "pr-ready", "merged-upstream"];
const HARD_KINDS: Partial<Record<GraphRelationKind, true>> = { requires: true, "stacked-on": true };

function stageAtLeast(actual: GraphOutcomeStage | undefined, target: GraphOutcomeStage): boolean {
	return actual !== undefined && STAGES.indexOf(actual) >= STAGES.indexOf(target);
}

function relationLabel(relation: GraphRelation): string {
	return `${relation.kind} ${relation.from} -> ${relation.to}`;
}

function assertGraph(input: WorkGraphObservation): void {
	if (!input.generation.trim()) throw new Error("graph generation is required");
	const keys = new Set<string>();
	for (const node of input.nodes) {
		if (!node.key.trim() || keys.has(node.key)) throw new Error(`duplicate graph node ${node.key}`);
		keys.add(node.key);
		if (node.subject !== undefined && (!node.subject.repo || !node.subject.base)) throw new Error(`node ${node.key} has an incomplete subject`);
	}
	for (const relation of input.relations) {
		if (!keys.has(relation.from)) throw new Error(`graph relation has no observed source: ${relationLabel(relation)}`);
		if (!relation.source.trim()) throw new Error(`graph relation source is required: ${relationLabel(relation)}`);
	}
}

/**
 * Recompute all decisions from one captured observation. Inferred relations are
 * visible hints only; they never make a node READY or authorize an effect.
 */
export function evaluateWorkGraph(input: WorkGraphObservation): WorkGraphDecision {
	assertGraph(input);
	const ordered = [...input.relations].sort((a, b) => {
		const left = JSON.stringify(a), right = JSON.stringify(b);
		return left < right ? -1 : left > right ? 1 : 0;
	});
	const relationByFrom = new Map<string, GraphRelation[]>();
	for (const relation of ordered) {
		relationByFrom.set(relation.from, [...(relationByFrom.get(relation.from) ?? []), relation]);
		if (relation.kind !== "overlaps" || relation.authority !== "authoritative") continue;
		const reverseExists = input.relations.some((candidate) =>
			candidate.from === relation.to && candidate.to === relation.from && candidate.kind === "overlaps" && candidate.authority === "authoritative");
		if (!reverseExists) {
			const reverse = { ...relation, from: relation.to, to: relation.from, source: `${relation.source} (symmetric)` };
			relationByFrom.set(reverse.from, [...(relationByFrom.get(reverse.from) ?? []), reverse]);
		}
	}
	const cyclic = new Set<string>();
	const visited = new Set<string>();
	const visit = (key: string, path: string[]): void => {
		const start = path.indexOf(key);
		if (start >= 0) { for (const member of path.slice(start)) cyclic.add(member); return; }
		if (visited.has(key)) return;
		for (const relation of relationByFrom.get(key) ?? []) {
			if (HARD_KINDS[relation.kind] === true && relation.authority === "authoritative") visit(relation.to, [...path, key]);
		}
		visited.add(key);
	};
	for (const node of input.nodes) visit(node.key, []);
	const base = new Map<string, MutableGraphNodeDecision>();
	for (const node of input.nodes) {
		let decision: GraphDecisionState;
		const blockers: string[] = [];
		if (cyclic.has(node.key)) { decision = "BLOCKED"; blockers.push(`graph dependency cycle at ${node.key}; resolve authoritative prerequisites`); }
		else if (node.state === "RUNNING") decision = "RUNNING";
		else if (node.state === "VERIFY") decision = "VERIFY";
		else if (node.state === "BLOCKED" || node.state === "EXCLUDED") { decision = "BLOCKED"; blockers.push(node.blocker ?? "authoritative policy or ownership blocker"); }
		else if (node.state === "UNKNOWN" || node.generation !== input.generation || node.subject === undefined) {
			decision = "UNKNOWN";
			blockers.push(node.blocker ?? (node.generation !== input.generation ? "current generation must be re-observed" : node.subject === undefined ? "exact repository subject must be observed" : "authoritative evidence must be restored"));
		}
		else if (node.state === "DONE" && node.proofCurrent === true && stageAtLeast(node.proof, node.target)) decision = "DONE";
		else if (node.state === "DONE") { decision = "UNKNOWN"; blockers.push("declared outcome proof is missing or stale; re-observe or reverify"); }
		else decision = "READY";
		base.set(node.key, { ...node, decision, blockers, softHints: [] });
	}
	const initial = new Map(base);
	for (let pass = 0; pass <= input.nodes.length; pass++) {
		const previous = new Map(base);
		for (const node of input.nodes) {
		const original = initial.get(node.key)!;
		const current = { ...original, blockers: [...original.blockers], softHints: [] as string[] };
		let unknown = false, blocked = false;
		for (const relation of relationByFrom.get(node.key) ?? []) {
			if (relation.authority === "inferred") {
				current.softHints.push(`${relationLabel(relation)} is a soft ordering hint (${relation.source}${relation.reason ? `: ${relation.reason}` : ""})`);
				continue;
			}
			if (relation.kind === "contains" || relation.kind === "implements" || !["READY", "DONE"].includes(original.decision)) continue;
			const prerequisite = previous.get(relation.to);
			if (prerequisite === undefined) {
				current.blockers.push(`missing authoritative observation for ${relation.to}; observe prerequisite without expanding mutation scope`);
				unknown = true; continue;
			}
			if (relation.kind === "overlaps") {
				if (original.decision === "DONE") continue;
				if (prerequisite.decision === "DONE") continue;
				if (prerequisite.decision === "UNKNOWN") {
					current.blockers.push(`overlap with ${relation.to} is UNKNOWN`);
					unknown = true;
				} else {
					current.blockers.push(`overlaps active selected work ${relation.to}`);
					blocked = true;
				}
				continue;
			}
			if (prerequisite.decision === "DONE" && stageAtLeast(prerequisite.proof, relation.stage ?? node.target)) continue;
			if (prerequisite.decision === "UNKNOWN") {
				current.blockers.push(`${relation.kind} prerequisite ${relation.to} is UNKNOWN`);
				unknown = true;
			} else {
				current.blockers.push(`${relation.kind} prerequisite ${relation.to} is ${prerequisite.decision}`);
				blocked = true;
			}
		}
		if (unknown || blocked) current.decision = original.decision === "DONE" || unknown ? "UNKNOWN" : "BLOCKED";
		base.set(node.key, current);
		}
		if ([...base].every(([key, node]) => node.decision === previous.get(key)?.decision)) break;
	}
	const nodes: GraphNodeDecision[] = [...base.values()].map((node) => ({ ...node, blockers: [...node.blockers], softHints: [...node.softHints] }));
	const ready = nodes.filter((node) => node.decision === "READY").map((node) => node.key);
	const blockers = nodes.flatMap((node) => node.blockers.map((blocker) => `${node.key}: ${blocker}`));
	const softHints = nodes.flatMap((node) => node.softHints);
	const mandatory = nodes.filter((node) => node.required);
	const converged = mandatory.length > 0 && mandatory.every((node) => node.decision === "DONE");
	const active = nodes.some((node) => node.decision === "READY" || node.decision === "RUNNING" || node.decision === "VERIFY");
	return {
		generation: input.generation,
		nodes,
		ready,
		blockers,
		softHints,
		verdict: converged ? "CONVERGED" : active ? "ACTIVE" : "AUTONOMOUSLY_QUIESCENT",
		modelCalls: 0,
	};
}
