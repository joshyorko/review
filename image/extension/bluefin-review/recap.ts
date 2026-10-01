import { createHash } from "node:crypto";
import { Buffer } from "node:buffer";
import type { Span } from "./trace.ts";
import { safePreview } from "./safe-output.ts";

const MAX_RECAP_BYTES = 16 * 1024;

export interface ReviewRecapInput {
	source: { sessionId: string; branchId: string; authoritySource: string };
	observedAt: number;
	scope: string;
	queue: { kind: "available" | "unavailable"; observedAt: number; itemCount?: number; reason?: string };
	selection: Array<{ repo: string; id: number; type: "issue" | "pr"; title: string; url: string; headSha?: string }>;
	observations: Array<{ subject: string; observedAt?: number; status: string; sourceUrl?: string }>;
	operations: Array<{ id: string; kind: string; state: string; completedItems: number; totalItems: number; startedAt: number; items?: Array<{ repo: string; id: number; type: string; headSha?: string }>; error?: string }>;
	comments: Array<{ state: string; targets: string[]; receipts: string[]; body?: string }>;
	trace: Span[];
	artifacts: Array<{ kind: "available" | "unavailable"; sessionId: string; uri?: string; path?: string; reason?: string; complete?: boolean }>;
	verification: Array<{ subject?: string; status?: string; receipt?: string }>;
	remaining: string[];
}

export interface ReviewRecap { id: string; text: string; handoffText: string }

export function buildReviewRecap(input: ReviewRecapInput): ReviewRecap {
	const safeScope = safePreview(input.scope, 160, "head").text;
	const safeQueue = { kind: input.queue.kind, itemCount: input.queue.itemCount, reason: input.queue.reason ? safePreview(input.queue.reason, 120, "head").text : undefined };
	const remaining = input.remaining.slice(0, 16).map((line) => safePreview(line, 160, "head").text);
	const selection = input.selection.slice(0, 25).map((item) => ({
		repo: safePreview(item.repo, 128, "head").text,
		id: item.id,
		type: item.type,
		title: safePreview(item.title, 256, "head").text,
		url: safePreview(item.url, 256, "head").text,
		headSha: item.headSha ? safePreview(item.headSha, 80, "head").text : undefined,
	}));
	const observations = input.observations.slice(0, 25).map((observation) => ({
		subject: safePreview(observation.subject, 160, "head").text,
		observedAt: typeof observation.observedAt === "number" && Number.isFinite(observation.observedAt) && Math.abs(observation.observedAt) <= 8.64e15
			? new Date(observation.observedAt).toISOString()
			: "timestamp unavailable",
		status: safePreview(observation.status, 200, "head").text,
		sourceUrl: observation.sourceUrl ? safePreview(observation.sourceUrl, 256, "head").text : undefined,
	}));
	const operations = input.operations.slice(-12).map((op) => {
		const targets = (op.items ?? []).slice(0, 8).map((item) => `${safePreview(item.repo, 128, "head").text}#${item.id}${item.headSha ? ` head=${safePreview(item.headSha, 80, "head").text}` : ""}`);
		return `${safePreview(op.kind, 32, "head").text} ${safePreview(op.id, 64, "head").text}: ${safePreview(op.state, 32, "head").text} (${op.completedItems}/${op.totalItems}; started=${op.startedAt})${targets.length ? ` targets=${targets.join(",")}${(op.items?.length ?? 0) > 8 ? `; ${(op.items?.length ?? 0) - 8} more omitted` : ""}` : ""}${op.error ? `; ${safePreview(op.error, 160).text}` : ""}`;
	});
	const refs = input.artifacts.slice(-24).map((artifact) => ({
		kind: artifact.kind,
		complete: artifact.kind === "available" ? artifact.complete !== false : undefined,
		sessionId: safePreview(artifact.sessionId, 80, "head").text,
		uri: artifact.uri ? safePreview(artifact.uri, 128, "head").text : undefined,
		path: artifact.path ? safePreview(artifact.path, 256, "head").text : undefined,
		reason: artifact.reason ? safePreview(artifact.reason, 120, "head").text : undefined,
	}));
	const traceFacts: string[] = [];
	let traceSpanCount = 0;
	let traceFactBytes = Buffer.byteLength("native trace outcomes:\n", "utf8");
	const adverse = (span: Span): boolean => span.status !== "success" || span.cls === "unknown";
	const visit = (span: Span, priority: boolean): void => {
		if (priority) traceSpanCount++;
		if (traceFacts.length < 32 && adverse(span) === priority) {
			const nativeKind = span.id.startsWith("tool/") ? safePreview(span.label.split("(", 1)[0] ?? "tool", 64, "head").text : safePreview(span.label, 64, "head").text;
			const fact = `${safePreview(span.id, 128, "head").text}|${nativeKind || "native step"}|${span.status}|${span.cls ?? ""}`;
			const bytes = Buffer.byteLength(fact, "utf8") + 3;
			if (traceFactBytes + bytes <= 4_096) {
				traceFacts.push(fact);
				traceFactBytes += bytes;
			}
		}
		for (let index = (span.children?.length ?? 0) - 1; index >= 0; index--) visit(span.children![index]!, priority);
	};
	for (const priority of [true, false]) {
		for (let index = input.trace.length - 1; index >= 0; index--) visit(input.trace[index]!, priority);
	}
	const omittedTraceSpans = traceSpanCount - traceFacts.length;
	const publicationFacts = input.comments.slice(-24).map((comment) => ({
		state: safePreview(comment.state, 32, "head").text,
		targets: comment.targets.slice(0, 8).map((target) => safePreview(target, 160, "head").text),
		receipts: comment.receipts.slice(0, 8).map((receipt) => safePreview(receipt, 256, "head").text),
	}));
	const verificationFacts = input.verification.slice(-32).map((verification) => ({
		subject: verification.subject ? safePreview(verification.subject, 160, "head").text : undefined,
		status: verification.status ? safePreview(verification.status, 64, "head").text : "unknown",
		receipt: verification.receipt ? safePreview(verification.receipt, 256, "head").text : undefined,
	}));
	const canonicalFacts = { traceFacts, omittedTraceSpans, refs, publicationFacts, verificationFacts };
	const authoritySource = safePreview(input.source.authoritySource, 200, "head").text;
	const sourceFacts = { sessionId: safePreview(input.source.sessionId, 80, "head").text, branchId: safePreview(input.source.branchId, 80, "head").text, authoritySource };
	const idSeed = JSON.stringify({ source: sourceFacts, scope: safeScope, queue: safeQueue, selection: selection.map((item) => [item.repo, item.id, item.type, item.title, item.headSha]), observations, operations, remaining, ...canonicalFacts });
	const id = createHash("sha256").update(idSeed).digest("hex").slice(0, 24);
	const section = (title: string, entries: string[], budget: number): string => {
		const value = `${title}\n${entries.length ? entries.join("\n") : "- none observed"}`;
		if (Buffer.byteLength(value, "utf8") <= budget) return value;
		const marker = "\n… section details omitted …";
		return `${safePreview(value, budget - Buffer.byteLength(marker, "utf8"), "head").text}${marker}`;
	};
	const lines = [
		`Review recap ${id}`,
		`source session=${safePreview(input.source.sessionId, 80, "head").text} branch=${safePreview(input.source.branchId, 80, "head").text}`,
		`Review-persisted operation and authorization source: ${authoritySource}; persisted state records prior intent and outcome, not handoff authority.`,
		`scope=${safeScope}; queue=${input.queue.kind}${input.queue.kind === "available" ? ` (${input.queue.itemCount ?? "unknown"} items)` : `: ${safeQueue.reason ?? "unavailable"}`}`,
		"required before any work: revalidate current repository, head, selection, claims, budget, and external effects; obtain explicit human authorization. This handoff carries no approval, merge, comment, publish, or deploy authority.",
		"remaining:", ...remaining.map((line) => `- ${line}`),
		...(input.remaining.length > 16 ? [`- ${input.remaining.length - 16} additional unresolved effects omitted; inspect the source session and reconcile all effects before work.`] : []),
		section("native trace outcomes:", traceFacts.map((line) => `- ${line}`), 4_096),
		...(omittedTraceSpans > 0 ? [`${omittedTraceSpans} native trace spans omitted.`] : []),
		section("selection:", selection.map((item) => `- ${item.repo}#${item.id} ${item.type} ${item.title}${item.headSha ? ` head=${item.headSha}` : " head=unknown"} ${item.url}`), 2_048),
		section("timestamped queue observations (not verification):", observations.map((observation) => `- ${observation.subject} observed=${observation.observedAt}; ${observation.status}${observation.sourceUrl ? `; queue source URL=${observation.sourceUrl}` : ""}`), 1_024),
		section("native operations:", operations.map((line) => `- ${line}`), 1_024),
		section("native artifact references:", refs.map((ref) => ref.kind === "available"
			? `- ${ref.uri ?? "artifact"} ${ref.complete ? "complete" : "sample only"} in ${ref.sessionId}${ref.path ? ` at ${ref.path}` : ""}`
			: `- ${ref.uri ?? "artifact"} unavailable: ${ref.reason ?? "unresolved"}`), 1_024),
		section("publication:", publicationFacts.length ? publicationFacts.map((publication) => `${publication.state} targets=${publication.targets.join(",") || "unknown"} receipts=${publication.receipts.join(",") || "none"}`) : ["no publication receipt observed"], 512),
		section("verification:", verificationFacts.length ? verificationFacts.map((v) => `${v.status}${v.subject ? ` ${v.subject}` : ""}${v.receipt ? ` receipt=${v.receipt}` : ""}`) : ["unknown; no verification receipt observed"], 512),
		...(input.selection.length > 25 || input.observations.length > 25 || input.operations.length > 12 || input.artifacts.length > 24 || input.comments.length > 24 || input.verification.length > 32 ? ["Additional older recap entries omitted; inspect the source session before continuing."] : []),
	];
	const text = lines.join("\n");
	const handoffText = `Explicit Review handoff ${id}\n${text}`;
	if (Buffer.byteLength(handoffText, "utf8") > MAX_RECAP_BYTES) throw new Error("Review recap section budgets exceeded");
	return { id, text, handoffText };
}
