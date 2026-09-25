import { projectBatch, projectItem } from "./projection.ts";
import type { FactoryDashboardAction, FactoryDashboardSnapshot } from "./dashboard.ts";

/** Revalidate the selected subject after the UI closes and before any controller call. */
export function dashboardActionAllowed(action: FactoryDashboardAction, snapshot: FactoryDashboardSnapshot): boolean {
	const readOnly = snapshot.readOnly || Boolean(snapshot.error) || snapshot.loading === true;
	if (action.kind === "reconcile") {
		const observation = snapshot.claimOwners?.find((owner) => owner.owner === action.owner && owner.resource === action.resource);
		return !readOnly && snapshot.canReconcileClaims === true && (!observation || observation.matches && observation.reconcileAvailable) && snapshot.claims.some((c) => c.resource === action.resource && c.owner === action.owner);
	}
	if (!("batchId" in action)) return true;
	const batch = snapshot.batches.find((b) => b.id === action.batchId);
	if (!batch) return false;
	const options = { readOnly, claims: snapshot.claims, retainedBatches: snapshot.batches };
	if (action.kind === "batch") return true;
	if (action.kind === "discard" && Object.keys(snapshot.evidenceWarnings ?? {}).some((key) => key.startsWith(`${action.batchId}:`))) return false;
	if (action.kind === "pause" || action.kind === "resume" || action.kind === "stop" || action.kind === "export" || action.kind === "discard") return projectBatch(batch, options).actions.includes(action.kind);
	if (!("itemKey" in action)) return false;
	const item = batch.items.find((i) => i.selected.key === action.itemKey);
	if (!item) return false;
	const projection = projectItem(batch, item, options);
	switch (action.kind) {
		case "inspect": return true;
		case "retry": return projection.actions.includes("retry");
		case "exclude": return projection.actions.includes("exclude");
		case "reconcile-effect": return projection.actions.includes("reconcile");
		case "workspace": return projection.workspace !== undefined;
		case "session": return projection.sessions.length > 0 || projection.attemptHistory.some((a) => a.sessions.length > 0);
		case "open": return projection.prUrl === action.url && /^https:\/\//.test(action.url);
		case "evidence-preview": return [
			...projection.evidence,
			...projection.sessions,
			...projection.attemptHistory.flatMap((a) => a.sessions.map((s) => s.path)),
			...projection.tests.flatMap((t) => t.artifact ? [t.artifact] : []),
		].includes(action.path);
		default: return false;
	}
}
