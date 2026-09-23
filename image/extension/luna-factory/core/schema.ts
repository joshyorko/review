/**
 * Strict, bounded parsers for the two shapes that cross a trust boundary.
 *
 * A worker receipt arrives as unvalidated input: a model wrote it, or a
 * transcript replayed it. Parsing it into `EvidenceReceipt` here means the rest
 * of the package can assume the shape, and that `next` and `confidence` cannot
 * be read from an object that was never a receipt at all.
 *
 * These parsers are dependency-free on purpose. The package must load inside the
 * pinned distroless appliance, and a validation library is a permanent
 * obligation the maintainer would have to carry.
 */

import { isRecord } from "./guard.ts";
import type {
	Candidate,
	CriterionId,
	Effect,
	EvidenceReceipt,
	GenerationId,
	ProofAssumption,
	PredicateEvidence,
	Routing,
	SemanticResult,
	Subject,
	TaskId,
	TestClaim,
	AttemptId,
	OperationReceipt,
} from "./model.ts";

/** Bounds. A receipt is a bounded summary, not a transport for a log. */
export const MAX_TEXT = 2_000;
export const MAX_ITEMS = 64;
export const MAX_ARTIFACT_REFS = 64;
const MAX_IDENTITY = 128;
const MAX_ENTRY_CHARS = MAX_TEXT * MAX_ITEMS;

export type ParseResult<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly errors: readonly string[] };

const IDENTITY_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const REPO_RE = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;
/** Git object names only: a branch or tag name is not a subject. */
const REVISION_RE = /^[0-9a-f]{7,64}$/;
const HTTP_URL_RE = /^[a-z][a-z0-9+.-]*:\/\//i;
const FACTORY_ARTIFACT_URI_RE = /^artifact:\/\//;

function identity(value: unknown, field: string, errors: string[]): string | undefined {
	if (typeof value !== "string") {
		errors.push(`${field} must be a string`);
		return undefined;
	}
	if (!IDENTITY_RE.test(value)) {
		errors.push(`${field} is not a bounded identity (${MAX_IDENTITY} chars, [A-Za-z0-9._:-])`);
		return undefined;
	}
	return value;
}

function text(value: unknown, field: string, errors: string[], allowEmpty = false): string | undefined {
	if (typeof value !== "string") {
		errors.push(`${field} must be a string`);
		return undefined;
	}
	if (!allowEmpty && value.trim().length === 0) {
		errors.push(`${field} must not be empty`);
		return undefined;
	}
	if (value.length > MAX_TEXT) {
		errors.push(`${field} exceeds ${MAX_TEXT} characters`);
		return undefined;
	}
	return value;
}

function stringList(value: unknown, field: string, errors: string[], allowEmptyItems = false): readonly string[] | undefined {
	if (!Array.isArray(value)) {
		errors.push(`${field} must be an array`);
		return undefined;
	}
	if (value.length > MAX_ITEMS) {
		errors.push(`${field} exceeds ${MAX_ITEMS} entries`);
		return undefined;
	}
	let chars = 0;
	const out: string[] = [];
	for (const [index, entry] of value.entries()) {
		const parsed = text(entry, `${field}[${index}]`, errors, allowEmptyItems);
		if (parsed === undefined) return undefined;
		chars += parsed.length;
		out.push(parsed);
	}
	if (chars > MAX_ENTRY_CHARS) {
		errors.push(`${field} exceeds ${MAX_ENTRY_CHARS} total characters`);
		return undefined;
	}
	return out;
}

function subject(value: unknown, errors: string[]): Subject | undefined {
	if (!isRecord(value)) {
		errors.push("subject must be an object");
		return undefined;
	}
	const repo = typeof value.repo === "string" && REPO_RE.test(value.repo) ? value.repo : undefined;
	if (repo === undefined) errors.push("subject.repo must be owner/name");
	const base = typeof value.base === "string" && REVISION_RE.test(value.base) ? value.base : undefined;
	if (base === undefined) errors.push("subject.base must be a git revision");
	let head: string | undefined;
	if (value.head !== undefined) {
		if (typeof value.head === "string" && REVISION_RE.test(value.head)) head = value.head;
		else errors.push("subject.head must be a git revision when present");
	}
	if (repo === undefined || base === undefined) return undefined;
	return head === undefined ? { repo, base } : { repo, base, head };
}

/** Parse the repository identity used to bind a Factory run or receipt. */
export function parseSubject(value: unknown): ParseResult<Subject> {
	const errors: string[] = [];
	const parsed = subject(value, errors);
	return parsed === undefined || errors.length > 0 ? { ok: false, errors } : { ok: true, value: parsed };
}

function routing(value: unknown, errors: string[]): Routing | undefined {
	if (!isRecord(value)) {
		errors.push("routing must be an object");
		return undefined;
	}
	if (typeof value.verified !== "boolean") {
		errors.push("routing.verified must be a boolean");
		return undefined;
	}
	const out: { requested?: string; effective?: string; effort?: string; verified: boolean } = { verified: value.verified };
	for (const field of ["requested", "effective", "effort"] as const) {
		const entry = value[field];
		if (entry === undefined) continue;
		const parsed = text(entry, `routing.${field}`, errors);
		if (parsed === undefined) return undefined;
		out[field] = parsed;
	}
	return out;
}

function testClaims(value: unknown, errors: string[]): readonly TestClaim[] | undefined {
	if (!Array.isArray(value)) {
		errors.push("tests must be an array");
		return undefined;
	}
	if (value.length > MAX_ITEMS) {
		errors.push(`tests exceeds ${MAX_ITEMS} entries`);
		return undefined;
	}
	const out: TestClaim[] = [];
	for (const [index, entry] of value.entries()) {
		if (!isRecord(entry)) {
			errors.push(`tests[${index}] must be an object`);
			return undefined;
		}
		const command = text(entry.command, `tests[${index}].command`, errors);
		const outcome = entry.outcome;
		if (outcome !== "pass" && outcome !== "fail" && outcome !== "not-run") {
			errors.push(`tests[${index}].outcome must be pass, fail, or not-run`);
			return undefined;
		}
		if (command === undefined) return undefined;
		let artifact: string | undefined;
		if (entry.artifact !== undefined) {
			const parsed = text(entry.artifact, `tests[${index}].artifact`, errors);
			if (parsed === undefined) return undefined;
			artifact = parsed;
		}
		out.push(artifact === undefined ? { command, outcome } : { command, outcome, artifact });
	}
	return out;
}

function assumptions(value: unknown, errors: string[]): readonly ProofAssumption[] | undefined {
	if (!Array.isArray(value) || value.length > 16) {
		errors.push("assumptions must be an array with at most 16 entries");
		return undefined;
	}
	const out: ProofAssumption[] = [];
	const seen = new Set<string>();
	for (const [index, entry] of value.entries()) {
		if (!isRecord(entry)) {
			errors.push(`assumptions[${index}] must be an object`);
			return undefined;
		}
		const kind = entry.kind;
		const parsedValue = text(entry.value, `assumptions[${index}].value`, errors);
		if (parsedValue === undefined) return undefined;
		if (kind === "dependency-outcome") {
			const taskId = identity(entry.taskId, `assumptions[${index}].taskId`, errors);
			if (taskId === undefined) return undefined;
			if (parsedValue !== "proven" && parsedValue !== "unproven") {
				errors.push(`assumptions[${index}].value must be proven or unproven`);
				return undefined;
			}
			const key = `${kind}:${taskId}`;
			if (seen.has(key)) {
				errors.push(`assumptions[${index}] duplicates ${key}`);
				return undefined;
			}
			seen.add(key);
			out.push({ kind, taskId: taskId as TaskId, value: parsedValue });
			continue;
		}
		if (kind !== "acceptance-revision") {
			errors.push(`assumptions[${index}].kind is unsupported`);
			return undefined;
		}
		if (seen.has(kind)) {
			errors.push(`assumptions[${index}] duplicates ${kind}`);
			return undefined;
		}
		seen.add(kind);
		out.push({ kind, value: parsedValue });
	}
	return out;
}

function semanticResult(value: unknown, errors: string[]): SemanticResult | undefined {
	if (!isRecord(value)) {
		errors.push("semanticResult must be an object");
		return undefined;
	}
	if (value.kind !== "inspection" && value.kind !== "finding") errors.push("semanticResult.kind must be inspection or finding");
	if (!["no-finding", "supported", "disproven", "uncertain"].includes(String(value.outcome))) {
		errors.push("semanticResult.outcome is unsupported");
	}
	if (value.kind === "inspection" && value.outcome !== "no-finding" && value.outcome !== "uncertain") {
		errors.push("inspection semantic outcomes must be no-finding or uncertain");
	}
	if (value.kind === "finding" && value.outcome === "no-finding") {
		errors.push("finding semantic outcomes cannot be no-finding");
	}
	if (value.outcome === "uncertain" && value.verified === true) {
		errors.push("an uncertain semantic result cannot be verified");
	}
	const summary = text(value.summary, "semanticResult.summary", errors);
	let publicationBlocker: string | undefined;
	if (value.publicationBlocker !== undefined) {
		publicationBlocker = text(value.publicationBlocker, "semanticResult.publicationBlocker", errors);
	}
	if (value.verified !== true && value.verified !== false) errors.push("semanticResult.verified must be boolean");
	if (value.publicationAuthority !== "none") errors.push("semanticResult.publicationAuthority must be none");
	if (summary === undefined || errors.length > 0) return undefined;
	return {
		kind: value.kind as SemanticResult["kind"],
		outcome: value.outcome as SemanticResult["outcome"],
		summary,
		verified: value.verified as boolean,
		publicationAuthority: "none",
		...(publicationBlocker === undefined ? {} : { publicationBlocker }),
	};
}
/** Parse the explicit current assumption snapshot on a criterion or proof binding. */
export function parseProofAssumptions(value: unknown): ParseResult<readonly ProofAssumption[]> {
	const errors: string[] = [];
	const parsed = assumptions(value, errors);
	return errors.length > 0 || parsed === undefined ? { ok: false, errors } : { ok: true, value: parsed };
}

function predicateRows(
	value: unknown,
	errors: string[],
	defaultPhase?: PredicateEvidence["phase"],
): readonly PredicateEvidence[] | undefined {
	if (!Array.isArray(value) || value.length > MAX_ITEMS) {
		errors.push(`predicates must be an array with at most ${MAX_ITEMS} entries`);
		return undefined;
	}
	const out: PredicateEvidence[] = [];
	for (const [index, entry] of value.entries()) {
		if (!isRecord(entry)) {
			errors.push(`predicates[${index}] must be an object`);
			return undefined;
		}
		const phase = defaultPhase ?? entry.phase;
		if (phase !== "worker" && phase !== "verification" && phase !== "acceptance") {
			errors.push(`predicates[${index}].phase is unsupported`);
			return undefined;
		}
		if (defaultPhase !== undefined && entry.phase !== undefined && entry.phase !== defaultPhase) {
			errors.push(`predicates[${index}].phase cannot override the observed phase`);
			return undefined;
		}
		const item = text(entry.item, `predicates[${index}].item`, errors);
		const note = text(entry.note, `predicates[${index}].note`, errors);
		if (typeof entry.ok !== "boolean") errors.push(`predicates[${index}].ok must be boolean`);
		if (item === undefined || note === undefined || typeof entry.ok !== "boolean") return undefined;
		out.push({ phase, item, ok: entry.ok, note });
	}
	return out;
}

/** Parse positive/negative predicate rows, attaching phase only from trusted caller context. */
export function parsePredicateEvidence(
	value: unknown,
	phase?: PredicateEvidence["phase"],
): ParseResult<readonly PredicateEvidence[]> {
	const errors: string[] = [];
	const parsed = predicateRows(value, errors, phase);
	return errors.length > 0 || parsed === undefined ? { ok: false, errors } : { ok: true, value: parsed };
}

/** Parse a durable operation identity before BatchStore can resume or retry it. */
export function parseOperationReceipt(value: unknown): ParseResult<OperationReceipt> {
	const errors: string[] = [];
	if (!isRecord(value)) return { ok: false, errors: ["operation receipt must be an object"] };
	const id = text(value.id, "operation.id", errors);
	if (id !== undefined && id.length > 512) errors.push("operation.id exceeds 512 characters");
	const generation = identity(value.generation, "operation.generation", errors);
	const parsedSubject = parseSubject(value.subject);
	if (!parsedSubject.ok) errors.push(...parsedSubject.errors.map((error) => `operation.${error}`));
	const phase = value.phase;
	if (phase !== "worker" && phase !== "verify" && phase !== "acceptance" && phase !== "push" && phase !== "pr") {
		errors.push("operation.phase is unsupported");
	}
	const effect = phase === "push" ? "git-push" : phase === "pr" ? "pull-request-create" : "repository-work";
	if (value.effect !== effect) errors.push("operation.effect does not match its phase");
	if (value.state !== "intent" && value.state !== "applied" && value.state !== "not-applied" && value.state !== "unknown") {
		errors.push("operation.state is unsupported");
	}
	const owner = value.owner === undefined ? undefined : text(value.owner, "operation.owner", errors);
	if (owner !== undefined && owner.length > 256) errors.push("operation.owner exceeds 256 characters");
	const attemptId = value.attemptId === undefined ? undefined : identity(value.attemptId, "operation.attemptId", errors);
	const branch = value.branch === undefined ? undefined : text(value.branch, "operation.branch", errors);
	if (branch !== undefined && branch.length > 256) errors.push("operation.branch exceeds 256 characters");
	const sha = value.sha === undefined ? undefined : text(value.sha, "operation.sha", errors);
	if (sha !== undefined && !REVISION_RE.test(sha)) errors.push("operation.sha must be a git object identity");
	const url = value.url === undefined ? undefined : text(value.url, "operation.url", errors);
	const resultHandle = value.resultHandle === undefined ? undefined : text(value.resultHandle, "operation.resultHandle", errors);
	if (url !== undefined && url.length > MAX_TEXT) errors.push("operation.url is too long");
	if (resultHandle !== undefined && resultHandle.length > MAX_TEXT) errors.push("operation.resultHandle is too long");
	if (phase === "push" || phase === "pr") {
		if (branch === undefined || sha === undefined) errors.push("publication operations require exact branch and SHA");
		if (parsedSubject.ok && sha !== undefined && parsedSubject.value.head !== sha) errors.push("publication subject head must match the recorded SHA");
	}
	if (errors.length > 0 || id === undefined || generation === undefined || !parsedSubject.ok) return { ok: false, errors };
	return {
		ok: true,
		value: {
			id,
			generation: generation as GenerationId,
			subject: parsedSubject.value,
			effect: effect as OperationReceipt["effect"],
			phase: phase as OperationReceipt["phase"],
			...(owner === undefined ? {} : { owner }),
			...(attemptId === undefined ? {} : { attemptId: attemptId as AttemptId }),
			state: value.state as OperationReceipt["state"],
			...(branch === undefined ? {} : { branch }),
			...(sha === undefined ? {} : { sha }),
			...(url === undefined ? {} : { url }),
			...(resultHandle === undefined ? {} : { resultHandle }),
		},
	};
}

/**
 * Parse an untrusted worker receipt.
 *
 * A successful parse proves the receipt's *shape*. It is deliberately not
 * evidence that the work happened: `reconcileReceipt` decides that.
 */
export function parseReceipt(value: unknown): ParseResult<EvidenceReceipt> {
	const errors: string[] = [];
	if (!isRecord(value)) return { ok: false, errors: ["receipt must be an object"] };
	if (value.version !== 1 && value.version !== 2) return { ok: false, errors: ["receipt.version must be 1 or 2"] };
	if (value.version === 1 && (value.assumptions !== undefined || value.semanticResult !== undefined || value.predicates !== undefined)) {
		return { ok: false, errors: ["version-1 receipts cannot contain version-2 semantic fields"] };
	}

	const taskId = identity(value.taskId, "taskId", errors);
	const attemptId = identity(value.attemptId, "attemptId", errors);
	const generation = identity(value.generation, "generation", errors);
	const parsedSubject = subject(value.subject, errors);
	const result = text(value.result, "result", errors);
	const changed = stringList(value.changed, "changed", errors, true);
	const evidence = stringList(value.evidence, "evidence", errors, true);
	const tests = testClaims(value.tests, errors);
	const unresolved = stringList(value.unresolved, "unresolved", errors, true);
	const next = text(value.next, "next", errors, true);
	const parsedRouting = routing(value.routing, errors);
	const parsedAssumptions = value.version === 2 ? assumptions(value.assumptions, errors) : undefined;
	const parsedSemanticResult = value.semanticResult === undefined ? undefined : semanticResult(value.semanticResult, errors);
	const parsedPredicates = value.version === 2 ? parsePredicateEvidence(value.predicates) : undefined;
	if (value.version === 2 && parsedAssumptions === undefined) errors.push("version-2 receipts require assumptions");
	if (parsedPredicates !== undefined && !parsedPredicates.ok) errors.push(...parsedPredicates.errors);

	const cleanEnvironment = value.cleanEnvironment;
	if (cleanEnvironment !== true && cleanEnvironment !== false && cleanEnvironment !== "unknown") {
		errors.push("cleanEnvironment must be true, false, or 'unknown'");
	}
	const confidence = value.confidence;
	if (confidence !== "low" && confidence !== "medium" && confidence !== "high") {
		errors.push("confidence must be low, medium, or high");
	}
	for (const field of ["exitCode", "aborted", "truncated"] as const) {
		if (field === "exitCode") {
			if (typeof value.exitCode !== "number" || !Number.isInteger(value.exitCode)) errors.push("exitCode must be an integer");
		} else if (typeof value[field] !== "boolean") {
			errors.push(`${field} must be a boolean`);
		}
	}

	if (errors.length > 0) return { ok: false, errors };
	return {
		ok: true,
		value: {
			version: value.version as 1 | 2,
			taskId: taskId as TaskId,
			attemptId: attemptId as AttemptId,
			generation: generation as GenerationId,
			subject: parsedSubject!,
			result: result!,
			changed: changed!,
			evidence: evidence!,
			tests: tests!,
			cleanEnvironment: cleanEnvironment as boolean | "unknown",
			unresolved: unresolved!,
			next: next!,
			confidence: confidence as EvidenceReceipt["confidence"],
			routing: parsedRouting!,
			exitCode: value.exitCode as number,
			aborted: value.aborted as boolean,
			truncated: value.truncated as boolean,
			...(value.version === 2 ? { assumptions: parsedAssumptions! } : {}),
			...(parsedSemanticResult ? { semanticResult: parsedSemanticResult } : {}),
			...(parsedPredicates?.ok ? { predicates: parsedPredicates.value } : {}),
		},
	};
}

/** Parse a discovery candidate before it can reach the ladder. */
export function parseCandidate(value: unknown): ParseResult<Candidate> {
	const errors: string[] = [];
	if (!isRecord(value)) return { ok: false, errors: ["candidate must be an object"] };

	const taskId = identity(value.taskId, "taskId", errors);
	const generation = identity(value.generation, "generation", errors);
	const criterionId = identity(value.criterionId, "criterionId", errors);
	const title = text(value.title, "title", errors);
	const necessity = text(value.necessity, "necessity", errors);
	const owner = identity(value.owner, "owner", errors);
	const effect = value.effect;
	if (effect !== "read" && effect !== "write") errors.push("effect must be read or write");

	let deps: readonly string[] = [];
	if (value.deps !== undefined) {
		const parsed = stringList(value.deps, "deps", errors);
		if (parsed === undefined) return { ok: false, errors };
		for (const dep of parsed) {
			if (!IDENTITY_RE.test(dep)) errors.push(`deps entry '${dep}' is not a bounded identity`);
		}
		deps = parsed;
	}

	if (errors.length > 0) return { ok: false, errors };
	return {
		ok: true,
		value: {
			taskId: taskId as TaskId,
			generation: generation as GenerationId,
			criterionId: criterionId as CriterionId,
			title: title!,
			deps: deps as readonly TaskId[],
			effect: effect as Effect,
			owner: owner!,
			necessity: necessity!,
		},
	};
}

/**
 * Artifact references must stay inside roots the run already owns.
 *
 * A worker-supplied path is not trusted evidence, so an HTTP reference or a
 * traversal out of the artifact roots is rejected rather than followed.
 */
export function artifactRefError(reference: string, roots: readonly string[]): string | undefined {
	if (reference.startsWith("~")) return "artifact reference must not depend on a home-directory expansion";
	if (reference.includes("\u0000")) return "artifact reference contains a NUL byte";
	if (reference.split("/").includes("..")) return "artifact reference escapes its artifact root";
	const absolute = reference.startsWith("/");
	if (roots.length === 0) return "no artifact root is configured for this run";
	const inRoot = roots.some((root) => {
		const normalized = root.endsWith("/") ? root.slice(0, -1) : root;
		return absolute ? reference === normalized || reference.startsWith(`${normalized}/`) : reference === normalized || reference.startsWith(`${normalized}/`);
	});
	if (HTTP_URL_RE.test(reference) && !FACTORY_ARTIFACT_URI_RE.test(reference)) return "remote artifact references are not followed as evidence";
	if (inRoot) return undefined;
	return `artifact reference is outside the run's artifact roots (${roots.join(", ")})`;
}

/**
 * Changed files are repository paths, not Factory artifacts.
 *
 * They are still untrusted receipt data: keep them relative to the bound
 * repository and reject path forms that could escape that boundary or be
 * interpreted differently by another host. The subject binding supplied to
 * reconciliation identifies which repository owns the path.
 */
export function changedPathError(reference: string): string | undefined {
	if (reference.length === 0) return "changed path must be non-empty and repository-relative";
	if (reference.includes("\u0000")) return "changed path contains a NUL byte";
	if (HTTP_URL_RE.test(reference)) return "remote changed paths are not repository-relative";
	if (reference.startsWith("~")) return "changed path must not depend on a home-directory expansion";
	if (reference.startsWith("/") || /^[A-Za-z]:[\\/]/.test(reference)) {
		return "changed path must be repository-relative, not absolute";
	}
	if (reference.includes("\\")) return "changed path uses unsupported path separators; use repository-relative POSIX paths";
	const segments = reference.split("/");
	if (segments.some((segment) => segment === "..")) return "changed path escapes the repository root";
	if (segments.some((segment) => segment.length === 0 || segment === ".")) {
		return "changed path must not contain empty or current-directory segments";
	}
	return undefined;
}
