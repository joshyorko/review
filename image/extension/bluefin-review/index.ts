/**
 * Bluefin policy adapter for the generic Review workbench core.
 *
 * The package edge selects Bluefin repository policy. The workbench itself
 * stays generic, uses OMP for execution, and adds Hive only in Hive mode.
 */

import { type KeyId, matchesKey } from "@earendil-works/pi-tui";
import { type ReviewExtensionHost, createReviewExtension } from "./extension.ts";
import { BLUEFIN_POLICY } from "./policy.ts";

export default function bluefinReviewExtension(pi: ReviewExtensionHost): void {
	const policy = process.env.BLUEFIN_REVIEW_ALLOW_WORKFLOW_SLAY === "1"
		? { ...BLUEFIN_POLICY, allowWorkflowSlay: true }
		: BLUEFIN_POLICY;
	createReviewExtension(pi, {
		matchKey: (data, key) => matchesKey(data, key as KeyId),
		policy,
	});
}
