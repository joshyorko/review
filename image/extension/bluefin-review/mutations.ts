/**
 * Typed GitHub mutation capability selection, fallback policy, retry classification,
 * and merge authority enforcement.
 *
 * Invariant: Typed GitHub mutations prefer native/gh/API tools. Browser is bounded
 * fallback for UI-only work; equivalent preferred attempts are not repeated indefinitely.
 * Preserves human confirmation and merge authority.
 */

export type MutationKind = "title" | "label" | "review" | "comment";
export type MutationCapability = "native" | "browser";

export interface TitleMutationParams {
	title: string;
	targetType?: "pull_request" | "issue";
}

export interface LabelMutationParams {
	addLabels?: string[];
	removeLabels?: string[];
	targetType?: "pull_request" | "issue";
}

export interface ReviewMutationParams {
	event: "APPROVE" | "REQUEST_CHANGES" | "COMMENT";
	body?: string;
}

export interface CommentMutationParams {
	body: string;
	targetType?: "pull_request" | "issue";
}

export type MutationParamsMap = {
	title: TitleMutationParams;
	label: LabelMutationParams;
	review: ReviewMutationParams;
	comment: CommentMutationParams;
};

export interface MutationRequest<K extends MutationKind = MutationKind> {
	kind: K;
	repo: string;
	number: number;
	params: MutationParamsMap[K];
	unsupportedNative?: boolean;
}

export interface MutationPlan {
	kind: MutationKind;
	repo: string;
	number: number;
	capability: MutationCapability;
	command?: string;
	reason: string;
	fallbackAvailable: boolean;
	bounded: boolean;
	attemptCount: number;
	blocked?: boolean;
}

export type RetryClassification =
	| "fresh"
	| "retryable"
	| "equivalent_attempt_exhausted"
	| "fallback_to_browser"
	| "unsupported";

export interface MutationAttemptRecord {
	signature: string;
	capability: MutationCapability;
	timestamp: number;
	success: boolean;
	error?: string;
}

export interface MergeAuthorityCheckItem {
	id: number;
	repo: string;
	ciStatus?: string;
	reviewState?: string;
	labels?: string[];
	author?: string;
	draft?: boolean;
}

export interface MergeAuthorityResult {
	allowed: boolean;
	reason?: string;
}

function quote(val: string): string {
	return `"${val.replace(/(["\\$`])/g, "\\$1")}"`;
}

export function generateNativeCommand<K extends MutationKind>(request: MutationRequest<K>): string {
	switch (request.kind) {
		case "title": {
			const p = request.params as TitleMutationParams;
			const type = p.targetType === "issue" ? "issue" : "pr";
			return `gh ${type} edit ${request.number} --repo ${request.repo} --title ${quote(p.title)}`;
		}
		case "label": {
			const p = request.params as LabelMutationParams;
			const type = p.targetType === "issue" ? "issue" : "pr";
			const parts = [`gh ${type} edit ${request.number} --repo ${request.repo}`];
			if (p.addLabels && p.addLabels.length > 0) {
				for (const l of p.addLabels) {
					parts.push(`--add-label ${quote(l)}`);
				}
			}
			if (p.removeLabels && p.removeLabels.length > 0) {
				for (const l of p.removeLabels) {
					parts.push(`--remove-label ${quote(l)}`);
				}
			}
			return parts.join(" ");
		}
		case "review": {
			const p = request.params as ReviewMutationParams;
			const flag =
				p.event === "APPROVE"
					? "--approve"
					: p.event === "REQUEST_CHANGES"
						? "--request-changes"
						: "--comment";
			const bodyPart = p.body ? ` --body ${quote(p.body)}` : "";
			return `gh pr review ${request.number} --repo ${request.repo} ${flag}${bodyPart}`;
		}
		case "comment": {
			const p = request.params as CommentMutationParams;
			const type = p.targetType === "issue" ? "issue" : "pr";
			return `gh ${type} comment ${request.number} --repo ${request.repo} --body ${quote(p.body)}`;
		}
		default:
			throw new Error(`unsupported mutation kind: ${(request as MutationRequest).kind}`);
	}
}

export function mutationSignature<K extends MutationKind>(request: MutationRequest<K>): string {
	return `${request.repo}#${request.number}:${request.kind}:${JSON.stringify(request.params)}`;
}

export class MutationCapabilityPolicy {
	readonly maxEquivalentAttempts: number;
	readonly maxBrowserFallbacks: number;
	private attempts: MutationAttemptRecord[] = [];

	constructor(options: { maxEquivalentAttempts?: number; maxBrowserFallbacks?: number } = {}) {
		this.maxEquivalentAttempts = options.maxEquivalentAttempts ?? 1;
		this.maxBrowserFallbacks = options.maxBrowserFallbacks ?? 1;
	}

	clear(): void {
		this.attempts = [];
	}

	recordAttempt(record: MutationAttemptRecord): void {
		this.attempts.push(record);
	}

	getAttemptsFor(signature: string): MutationAttemptRecord[] {
		return this.attempts.filter((a) => a.signature === signature);
	}

	classifyAttempt<K extends MutationKind>(
		request: MutationRequest<K>,
		preferredCapability: MutationCapability = "native",
	): RetryClassification {
		const sig = mutationSignature(request);
		const past = this.getAttemptsFor(sig);
		const pastCapability = past.filter((a) => a.capability === preferredCapability);

		if (pastCapability.length === 0) {
			return "fresh";
		}

		if (preferredCapability === "native") {
			const browserPast = past.filter((a) => a.capability === "browser");
			if (browserPast.length < this.maxBrowserFallbacks) {
				return "fallback_to_browser";
			}
			return "equivalent_attempt_exhausted";
		}

		if (pastCapability.length >= this.maxBrowserFallbacks) {
			return "equivalent_attempt_exhausted";
		}

		return "retryable";
	}

	selectCapability<K extends MutationKind>(request: MutationRequest<K>): MutationPlan {
		const sig = mutationSignature(request);
		const past = this.getAttemptsFor(sig);

		// When explicitly unsupported by native (UI-only work)
		if (request.unsupportedNative) {
			const browserPast = past.filter((a) => a.capability === "browser");
			if (browserPast.length >= this.maxBrowserFallbacks) {
				return {
					kind: request.kind,
					repo: request.repo,
					number: request.number,
					capability: "browser",
					reason: "bounded browser fallback exhausted; equivalent attempts not repeated indefinitely",
					fallbackAvailable: false,
					bounded: true,
					attemptCount: browserPast.length,
					blocked: true,
				};
			}
			return {
				kind: request.kind,
				repo: request.repo,
				number: request.number,
				capability: "browser",
				reason: "native capability unsupported for UI-only work; bounded browser fallback selected",
				fallbackAvailable: false,
				bounded: true,
				attemptCount: browserPast.length + 1,
			};
		}

		// Prefer typed native tools (gh/API) first
		const nativePast = past.filter((a) => a.capability === "native");
		if (nativePast.length < this.maxEquivalentAttempts) {
			return {
				kind: request.kind,
				repo: request.repo,
				number: request.number,
				capability: "native",
				command: generateNativeCommand(request),
				reason: "typed GitHub mutations prefer native/gh/API tools",
				fallbackAvailable: true,
				bounded: true,
				attemptCount: nativePast.length + 1,
			};
		}

		// Native attempts exhausted; check bounded browser fallback
		const browserPast = past.filter((a) => a.capability === "browser");
		if (browserPast.length < this.maxBrowserFallbacks) {
			return {
				kind: request.kind,
				repo: request.repo,
				number: request.number,
				capability: "browser",
				reason: "native mutation failed or exhausted; bounded browser fallback selected",
				fallbackAvailable: false,
				bounded: true,
				attemptCount: browserPast.length + 1,
			};
		}

		// Both exhausted: reject repeated equivalent attempts
		return {
			kind: request.kind,
			repo: request.repo,
			number: request.number,
			capability: "native",
			reason: "equivalent preferred attempts are not repeated indefinitely; mutation halted",
			fallbackAvailable: false,
			bounded: true,
			attemptCount: nativePast.length + browserPast.length,
			blocked: true,
		};
	}
}

export function checkMergeAuthority(
	item: MergeAuthorityCheckItem,
	operatorLogin?: string,
): MergeAuthorityResult {
	if (item.draft) {
		return { allowed: false, reason: "stop and report: pull request is draft" };
	}
	const ci = item.ciStatus?.toLowerCase();
	if (ci === "failure" || ci === "failed" || ci === "failing") {
		return { allowed: false, reason: "stop and report instead of merging: check is failing" };
	}
	if (ci === "pending" || ci === "running" || ci === "in_progress") {
		return { allowed: false, reason: "stop and report instead of merging: check is pending" };
	}
	if (item.labels) {
		if (item.labels.some((l) => l.toLowerCase() === "hold")) {
			return { allowed: false, reason: "merge blocked: pull request has hold label" };
		}
		if (item.labels.some((l) => l.toLowerCase() === "blocked")) {
			return { allowed: false, reason: "merge blocked: pull request has blocked label" };
		}
	}
	if (item.reviewState === "CHANGES_REQUESTED") {
		return { allowed: false, reason: "merge blocked: changes requested on pull request" };
	}
	if (item.reviewState === "REVIEW_REQUIRED") {
		return { allowed: false, reason: "merge blocked: review required before landing" };
	}
	if (operatorLogin && item.author && item.author.toLowerCase() === operatorLogin.toLowerCase()) {
		return {
			allowed: false,
			reason: "cannot approve or merge own pull request: requires another contributor's review",
		};
	}
	return { allowed: true };
}
