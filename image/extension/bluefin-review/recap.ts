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
	const visit = (span: Span): void => {
		if (traceFacts.length >= 32) return;
		const nativeKind = span.id.startsWith("tool/") ? safePreview(span.label.split("(", 1)[0] ?? "tool", 64, "head").text : safePreview(span.label, 64, "head").text;
		traceFacts.push(`${safePreview(span.id, 128, "head").text}|${nativeKind || "native step"}|${span.status}|${span.cls ?? ""}`);
		for (const child of span.children ?? []) visit(child);
	};
	for (const span of input.trace.slice(0, 32)) visit(span);
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
	const canonicalFacts = { traceFacts, refs, publicationFacts, verificationFacts };
	const authoritySource = safePreview(input.source.authoritySource, 200, "head").text;
	const sourceFacts = { sessionId: safePreview(input.source.sessionId, 80, "head").text, branchId: safePreview(input.source.branchId, 80, "head").text, authoritySource };
	const idSeed = JSON.stringify({ source: sourceFacts, scope: safeScope, queue: safeQueue, selection: selection.map((item) => [item.repo, item.id, item.type, item.title, item.headSha]), observations, operations, remaining, ...canonicalFacts });
	const id = createHash("sha256").update(idSeed).digest("hex").slice(0, 24);
	const lines = [
		`Review recap ${id}`,
		`source session=${safePreview(input.source.sessionId, 80, "head").text} branch=${safePreview(input.source.branchId, 80, "head").text}`,
		`Review-persisted operation and authorization source: ${authoritySource}; persisted state records prior intent and outcome, not handoff authority.`,
		`scope=${safeScope}; queue=${input.queue.kind}${input.queue.kind === "available" ? ` (${input.queue.itemCount ?? "unknown"} items)` : `: ${safeQueue.reason ?? "unavailable"}`}`,
		"selection:",
		...(selection.length ? selection.map((item) => `- ${item.repo}#${item.id} ${item.type} ${item.title}${item.headSha ? ` head=${item.headSha}` : " head=unknown"} ${item.url}`) : ["- none"]),
		"timestamped queue observations (not verification):",
		...(observations.length ? observations.map((observation) => `- ${observation.subject} observed=${observation.observedAt}; ${observation.status}${observation.sourceUrl ? `; queue source URL=${observation.sourceUrl}` : ""}`) : ["- none observed"]),
		"native operations:", ...(operations.length ? operations.map((line) => `- ${line}`) : ["- none observed"]),
		"native trace outcomes:", ...(traceFacts.length ? traceFacts.map((line) => `- ${line}`) : ["- none observed"]),
		"native artifact references:", ...(refs.length ? refs.map((ref) => ref.kind === "available"
			? `- ${ref.uri ?? "artifact"} ${ref.complete ? "complete" : "sample only"} in ${ref.sessionId}${ref.path ? ` at ${ref.path}` : ""}`
			: `- ${ref.uri ?? "artifact"} unavailable: ${ref.reason ?? "unresolved"}`) : ["- none observed"]),
		`publication: ${publicationFacts.length ? publicationFacts.map((publication) => `${publication.state} targets=${publication.targets.join(",") || "unknown"} receipts=${publication.receipts.join(",") || "none"}`).join("; ") : "no publication receipt observed"}`,
		`verification: ${verificationFacts.length ? verificationFacts.map((v) => `${v.status}${v.subject ? ` ${v.subject}` : ""}${v.receipt ? ` receipt=${v.receipt}` : ""}`).join("; ") : "unknown; no verification receipt observed"}`,
		"required before any work: revalidate current repository, head, selection, claims, budget, and external effects; obtain explicit human authorization. This handoff carries no approval, merge, comment, publish, or deploy authority.",
		"remaining:", ...(remaining.map((line) => `- ${line}`)),
		...(input.selection.length > 25 || input.observations.length > 25 || input.operations.length > 12 || input.artifacts.length > 24 || input.trace.length > 32 || input.remaining.length > 16 || input.comments.length > 24 || input.verification.length > 32 ? [`Additional recap entries omitted: selection=${Math.max(0, input.selection.length - 25)}, queue observations=${Math.max(0, input.observations.length - 25)}, operations=${Math.max(0, input.operations.length - 12)}, artifacts=${Math.max(0, input.artifacts.length - 24)}, trace roots=${Math.max(0, input.trace.length - 32)}, remaining=${Math.max(0, input.remaining.length - 16)}, publication records=${Math.max(0, input.comments.length - 24)}, verification records=${Math.max(0, input.verification.length - 32)}.`] : []),
	];
	const fit = (value: string): string => {
		const marker = `\n… recap truncated to ${MAX_RECAP_BYTES} UTF-8 bytes …`;
		const bounded = safePreview(value, MAX_RECAP_BYTES - Buffer.byteLength(marker, "utf8"), "head");
		if (Buffer.byteLength(value, "utf8") <= MAX_RECAP_BYTES) return value;
		return `${bounded.text}${marker}`;
	};
	const text = fit(lines.join("\n"));
	return { id, text, handoffText: fit(`Explicit Review handoff ${id}\n${text}`) };
}
