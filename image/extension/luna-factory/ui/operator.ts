import type { Batch } from "../core/batch.ts";
import type { ProjectedItem } from "./projection.ts";

/** Product copy over authoritative projection facts. No transition or permission lives here. */
export interface ItemOverview {
	readonly caption: string;
	readonly heading: string;
	readonly explanation: string;
	readonly next: string;
	readonly needsYou: boolean;
}
export function itemTitle(batch: Batch, item: ProjectedItem): string {
	return batch.items.find((entry) => entry.selected.key === item.key)?.selected.acceptance?.slice(0, 512).split("\n", 1)[0]?.trim() || `Work on #${item.number}`;
}
const stageName = (stage: string): string => stage === "verified-patch" ? "verified patch" : stage === "pr-ready" ? "ready PR" : "merged change";
export function itemOverview(item: ProjectedItem, active = false): ItemOverview {
	const owner = item.claims.find((claim) => claim.conflict);
	if (owner) return {
		caption: "repository owned by another run", heading: "Repository locked",
		explanation: "Another run still owns this repository. Your work is protected while its workers and effects are checked.",
		next: "Inspect the owner, then reconcile when its work has settled.", needsYou: true,
	};
	if (item.stage === "UNKNOWN") {
		const external = item.operation?.phase === "push" || item.operation?.phase === "pr";
		return { caption: external ? "effect needs reconciliation" : "work needs checking", heading: external ? "Did the change reach GitHub?" : "Work needs checking",
			explanation: external ? "The result of the last GitHub operation is uncertain. Running it again could repeat an effect." : "The last attempt has no confirmed outcome. Inspect what it left behind before continuing.",
			next: external ? "Reconcile the recorded effect." : item.actions.includes("retry") ? "Inspect retained work, then retry." : "Inspect the run and its evidence.", needsYou: true };
	}
	if (item.stage === "RUNNING") return active
		? { caption: "working", heading: "Work is underway", explanation: "A worker is handling this item.", next: "Nothing needed. You can inspect the work or pause new starts.", needsYou: false }
		: { caption: "worker status unconfirmed", heading: "Check the previous run", explanation: "This item was last recorded as running. No current worker has been observed in this session.", next: "Inspect the owner and retained evidence before continuing.", needsYou: true };
	if (item.stage === "VERIFY") return active
		? { caption: "checking the result", heading: "Checking the result", explanation: "Verification or an independent reviewer is checking this work.", next: "Wait for the checks to finish.", needsYou: false }
		: { caption: item.prUrl ? "PR ready for owner review" : item.proof.stage === "verified-patch" ? "patch ready to integrate" : "verification needs attention", heading: item.prUrl ? "PR needs your review" : "Ready for your inspection",
			explanation: item.prUrl ? "A PR was created. Owner integration and fresh acceptance are still required." : item.proof.stage === "verified-patch" ? "The checked patch is retained in its workspace. An owner must integrate it before this item is complete." : "Verification has no active worker. Review its evidence and blocker before resuming.",
			next: item.prUrl ? "Open the PR and review the result." : "Inspect the evidence and workspace.", needsYou: true };
	if (item.stage === "DONE") return { caption: item.prUrl || item.proof.stage === "pr-ready" ? "PR ready" : item.action === "inspect" ? "checked" : "proven", heading: item.prUrl ? "Ready for review" : "Work is proven",
		explanation: "The recorded acceptance has current proof for the captured revision.", next: item.prUrl ? "Open the PR when you're ready." : "No action needed. Evidence remains available.", needsYou: false };
	if (item.stage === "EXCLUDED") return { caption: "removed from this run", heading: "Removed from this run", explanation: "This item was explicitly excluded. The original scope is not complete.", next: "No work will run for this item.", needsYou: false };
	if (item.stage === "CANCELLED") return { caption: "stopped", heading: "Work stopped", explanation: "No new work will start for this item. Stopping does not undo changes already made.", next: item.actions.includes("retry") ? "Inspect retained work, then retry when ready." : "Inspect the result before deciding what comes next.", needsYou: true };
	const dependency = item.dependencies.find((edge) => !edge.satisfied);
	if (dependency) {
		const number = dependency.requires.split("#").at(-1);
		return { caption: `waiting for #${number}`, heading: "Waiting on other work", explanation: `This item needs ${dependency.requires}'s ${stageName(dependency.stage)}.`, next: "Let that work finish; this item will remain queued safely.", needsYou: false };
	}
	if (item.stage === "BLOCKED") {
		const reason = item.blocker ?? "The last attempt could not continue.";
        if (/Command failed:.*(?:gh repo clone|git.*(?:clone|fetch))/i.test(reason)) return {
            caption: "repository setup failed", heading: "Repository setup failed",
            explanation: "Factory couldn't prepare the repository workspace. The recorded error is available in Debug.",
            next: "Inspect the error, fix the setup, then retry.", needsYou: true,
        };
		if (/credential|GitHub (401|403)|auth expired|restore access/i.test(reason)) return { caption: "GitHub access needs attention", heading: "Reconnect GitHub", explanation: "Factory couldn't use the current GitHub connection.", next: "Restore access, then retry this item.", needsYou: true };
		if (/budget|attempt.*exhaust/i.test(reason)) return { caption: "attempt budget used", heading: "This run reached its limit", explanation: "The original attempt budget has been used. Retrying does not reset it.", next: "Inspect the work before deciding on another scope.", needsYou: true };
		return { caption: reason, heading: "Work needs attention", explanation: reason, next: item.actions.includes("retry") ? "Retry when the blocker is resolved." : "Inspect the blocker and evidence.", needsYou: true };
	}
	return { caption: "waiting to start", heading: "Ready when the run can continue", explanation: "This item is queued within the current run's capacity and dependencies.", next: "Resume the run if it is paused.", needsYou: false };
}
