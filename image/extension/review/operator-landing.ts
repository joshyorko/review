import type { QueueItem } from "./github.ts";
import type { HumanReviewFacts } from "./human-review-policy.ts";
import type { OperatorPolicySnapshot } from "./operator-policy.ts";
import { landingState, landingReason } from "./landing.ts";
import type { WorkbenchPolicy } from "./policy.ts";

export type OperatorLandingDecision = { readonly allowed: true } | { readonly allowed: false; readonly reason: string };

/** Local human policy, native acceptance and GitHub facts stay separate. */
export function operatorLandingDecision(input: {
	readonly item: QueueItem;
	readonly operatorPolicy: OperatorPolicySnapshot;
	readonly github: HumanReviewFacts;
	readonly reviewerClean: boolean;
	readonly action: "approve" | "merge";
	readonly policy?: WorkbenchPolicy;
}): OperatorLandingDecision {
	const { item, operatorPolicy, github, reviewerClean, action, policy } = input;
	const deny = (reason: string): OperatorLandingDecision => ({ allowed: false, reason });
	const state = landingState(item, policy);
	if (state !== "ready-to-land" && state !== "unreviewed") return deny(landingReason(state));
	if (item.draft || item.ciStatus !== "success" || item.ciEvidenceComplete !== true || item.mergeState !== "clean") return deny("complete passing CI and clean mergeability are required");
	if (operatorPolicy.repository !== item.repo.toLowerCase() || github.repository.toLowerCase() !== item.repo.toLowerCase()
		|| github.number !== item.id || github.headSha !== item.headSha || github.authorLogin.toLowerCase() !== item.author.toLowerCase()) return deny("current PR identity or head differs from the verified subject");
	if (!github.canMerge) return deny("current GitHub credential lacks repository write permission");
	if (github.githubReviewState === "changes_requested") return deny("GitHub reports a blocking changes-requested review");
	if (!reviewerClean) return deny("a delivered clean independent reviewer receipt for the current head is required");
	if (action === "approve") return github.viewerLogin.toLowerCase() === github.authorLogin.toLowerCase()
		? deny("the authenticated PR author cannot approve their own PR") : { allowed: true };
	if ((github.requiredApprovals > 0 || github.requiresCodeOwnerReview || github.requiresLastPushApproval)
		&& github.githubReviewState !== "approved") return deny("GitHub requires an eligible approving review; solo cannot waive this requirement");
	if (operatorPolicy.mode === "team" && github.currentHumanApprovals.length === 0) return deny("local team policy requires an eligible non-author human review of the current head");
	return { allowed: true };
}
