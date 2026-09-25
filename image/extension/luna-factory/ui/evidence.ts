import { constants, closeSync, fstatSync, openSync, readSync, realpathSync } from "node:fs";
import { relative, resolve, sep } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { stripVTControlCharacters } from "node:util";

const PREVIEW_BYTES = 64 * 1024;
export interface EvidencePreview { path: string; text: string; truncated: boolean }

/** Lazy read-only preview of one owned artifact; never follow links or read unbounded output. */
export function readBoundedEvidence(root: string, path: string, maxBytes = PREVIEW_BYTES): EvidencePreview {
	if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > PREVIEW_BYTES) throw new Error("invalid evidence preview byte limit");
	const ownedRoot = realpathSync(root);
	const actual = realpathSync(path);
	const child = relative(ownedRoot, actual);
	if (!child || child === ".." || child.startsWith(`..${sep}`) || actual !== resolve(path)) {
		throw new Error("evidence path escapes Factory state or follows a symlink; original evidence preserved");
	}
	const fd = openSync(actual, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
	try {
		const stat = fstatSync(fd);
		if (!stat.isFile() || stat.nlink !== 1) throw new Error("evidence must be a regular file with one link");
		const buffer = Buffer.alloc(maxBytes + 1);
		let count = 0;
		while (count < buffer.length) {
			const read = readSync(fd, buffer, count, buffer.length - count, count);
			if (read === 0) break;
			count += read;
		}
		const truncated = count > maxBytes;
		const decoder = new StringDecoder("utf8");
		const decoded = decoder.write(buffer.subarray(0, Math.min(count, maxBytes))) + (truncated ? "" : decoder.end());
		const text = stripVTControlCharacters(decoded).replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/g, "");
		return { path: actual, text, truncated };
	} finally { closeSync(fd); }
}
