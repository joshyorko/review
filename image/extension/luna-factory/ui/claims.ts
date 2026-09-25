import type { Batch } from "../core/batch.ts";
import type { ResourceClaim } from "../omp/batch-store.ts";
import { projectBatch, type ProjectedItem, type ProjectedOperation } from "./projection.ts";

export type ClaimLiveness = "active" | "unknown";

export interface ClaimInspection {
	readonly claim: ResourceClaim;
	readonly batchId?: string;
	readonly itemKey?: string;
	readonly item?: ProjectedItem;
	readonly operation?: ProjectedOperation;
	readonly liveness: ClaimLiveness;
	readonly reconcileAvailable: boolean;
	readonly releaseCondition: string;
	readonly rows: readonly string[];
}

export function claimIdentity(claim: Pick<ResourceClaim, "resource" | "owner">): string {
	return `${claim.resource.toLowerCase()}\u0000${claim.owner}`;
}

function claimItemKey(claim: ResourceClaim): string | undefined {
	return claim.resource.toLowerCase().startsWith("item:") ? claim.resource.slice("item:".length).toLowerCase() : undefined;
}

function claimRepo(claim: ResourceClaim): string | undefined {
	return claim.resource.toLowerCase().startsWith("repo:") ? claim.resource.slice("repo:".length).toLowerCase() : undefined;
}

function matchItem(claim: ResourceClaim, batch: Batch): ProjectedItem | undefined {
	const itemKey = claimItemKey(claim);
	const repo = claimRepo(claim);
	const item = batch.items.find((candidate) => itemKey === candidate.selected.key.toLowerCase())
		?? batch.items.find((candidate) => repo === candidate.selected.repo.toLowerCase());
	return item === undefined ? undefined : projectBatch(batch, { claims: [claim], readOnly: true }).items.find((candidate) => candidate.key === item.selected.key);
}

function ownerMatchesBatch(claim: ResourceClaim, batch: Batch, item: ProjectedItem | undefined): boolean {
	return claim.owner === batch.id || (item !== undefined && claim.owner === `${batch.id}:${item.key}`);
}
function matchingBatch(claim: ResourceClaim, batches: readonly Batch[]): { batch?: Batch; item?: ProjectedItem; ownerMatches: boolean } {
	for (const batch of batches) {
		const item = matchItem(claim, batch);
		if (ownerMatchesBatch(claim, batch, item)) return { batch, item, ownerMatches: true };
	}
	return { ownerMatches: false };
}

function matchingOperation(item: ProjectedItem | undefined, claim: ResourceClaim): ProjectedOperation | undefined {
	if (item === undefined) return undefined;
	return (item.operation?.owner === claim.owner ? item.operation : undefined)
		?? [...item.operations].reverse().find((operation) => operation.owner === claim.owner);
}

/** Read-only claim context. It does not decide whether a claim may be released. */
export function inspectClaim(
	claim: ResourceClaim,
	batches: readonly Batch[],
	activeItemKeys: readonly string[] = [],
	canReconcileClaims = false,
): ClaimInspection {
	const match = matchingBatch(claim, batches);
	const operation = matchingOperation(match.item, claim);
	const activeKeys = new Set(activeItemKeys.map((key) => key.toLowerCase()));
	const liveness: ClaimLiveness = match.item !== undefined && activeKeys.has(match.item.key.toLowerCase()) ? "active" : "unknown";
	const releaseCondition = claim.status === "settled"
		? "release condition: authoritative reconciliation confirms this owner/resource is settled; the controller must still verify owner identity before release"
		: "release condition: authoritative worker/external-effect reconciliation must mark this claim settled; UNKNOWN ownership is retained and cannot be released";
	const rows = [
		`resource: ${claim.resource}`,
		`owner: ${claim.owner}`,
		`batch/wave identity: ${match.ownerMatches ? match.batch?.id : "unknown (claim owner does not match a retained Factory batch)"}`,
		`item identity: ${match.item?.key ?? claimItemKey(claim) ?? "unknown"}`,
		`observed liveness: ${liveness === "active" ? "active (current Factory execution observed)" : "unknown (no current execution observation)"}`,
		`claim state: ${claim.status}`,
		`created: ${claim.createdAt}`,
		`reconciliation: ${canReconcileClaims ? "available through the authoritative controller" : "unavailable in this session; inspection only"}`,
		...(operation === undefined ? ["Factory operation/receipt: unknown (no associated receipt recorded)"] : [
			`Factory operation/receipt: ${operation.id}`,
			`effect: ${operation.effect} · phase: ${operation.phase} · state: ${operation.state}`,
			...(operation.owner === undefined ? [] : [`receipt owner: ${operation.owner}`]),
			...(operation.resultHandle === undefined ? [] : [`receipt result: ${operation.resultHandle}`]),
		]),
		releaseCondition,
	];
	return {
		claim,
		...(match.ownerMatches && match.batch !== undefined ? { batchId: match.batch.id } : {}),
		...(match.item === undefined ? (claimItemKey(claim) === undefined ? {} : { itemKey: claimItemKey(claim) }) : { itemKey: match.item.key, item: match.item }),
		...(operation === undefined ? {} : { operation }),
		liveness,
		reconcileAvailable: canReconcileClaims,
		releaseCondition,
		rows,
	};
}
