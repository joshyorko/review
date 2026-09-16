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
	Routing,
	Subject,
	TaskId,
	TestClaim,
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

/**
 * Parse an untrusted worker receipt.
 *
 * A successful parse proves the receipt's *shape*. It is deliberately not
 * evidence that the work happened: `reconcileReceipt` decides that.
 */
export function parseReceipt(value: unknown): ParseResult<EvidenceReceipt> {
	const errors: string[] = [];
	if (!isRecord(value)) return { ok: false, errors: ["receipt must be an object"] };
	if (value.version !== 1) return { ok: false, errors: ["receipt.version must be 1"] };

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
			version: 1,
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
	if (HTTP_URL_RE.test(reference) && !inRoot) return "remote artifact references are not followed as evidence";
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
