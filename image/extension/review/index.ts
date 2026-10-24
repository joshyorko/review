/**
 * GitHub-generic Review workbench entry point.
 */

import { type KeyId, matchesKey } from "@earendil-works/pi-tui";
import { type ReviewExtensionHost, createReviewExtension } from "./extension.ts";
import { GENERIC_WORKBENCH_POLICY } from "./policy.ts";

export default function reviewExtension(pi: ReviewExtensionHost): void {
	createReviewExtension(pi, {
		matchKey: (data, key) => matchesKey(data, key as KeyId),
		policy: GENERIC_WORKBENCH_POLICY,
	});
}
