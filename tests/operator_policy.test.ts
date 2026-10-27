import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
	isOperatorPolicySnapshot,
	operatorPolicyCurrent,
	operatorPolicyPath,
	readOperatorPolicy,
	writeOperatorPolicy,
} from "../image/extension/review/operator-policy.ts";

const roots: string[] = [];
function env(): NodeJS.ProcessEnv {
	const root = mkdtempSync(join(tmpdir(), "operator-policy-"));
	roots.push(root);
	return { HOME: root, XDG_CONFIG_HOME: join(root, "xdg"), PATH: process.env.PATH };
}
test.after(() => roots.forEach((root) => rmSync(root, { recursive: true, force: true })));

test("reads team by default without creating instance state", () => {
	const state = env();
	const snapshot = readOperatorPolicy("Example/Repo", state);
	assert.deepEqual(snapshot, {
		version: 1,
		repository: "example/repo",
		mode: "team",
		source: "default",
		digest: snapshot.digest,
	});
	assert.equal(operatorPolicyCurrent(snapshot, state), true);
	assert.equal(existsSync(operatorPolicyPath(state)), false);
});

test("missing injected HOME returns an isolated team default", () => {
	const snapshot = readOperatorPolicy("owner/repo", {});
	assert.equal(snapshot.mode, "team");
	assert.equal(snapshot.source, "default");
	assert.equal(isOperatorPolicySnapshot(snapshot), true);
	assert.throws(() => operatorPolicyPath({}), /HOME/);
});

test("writes explicit normalized policy and preserves unrelated repositories", () => {
	const state = env();
	const solo = writeOperatorPolicy("Example/Repo", "solo", state);
	assert.equal(solo.repository, "example/repo");
	assert.equal(solo.source, "explicit");
	assert.equal(operatorPolicyCurrent(solo, state), true);
	assert.equal(readOperatorPolicy("EXAMPLE/repo", state).mode, "solo");
	writeOperatorPolicy("another/repo", "team", state);
	assert.equal(readOperatorPolicy("example/repo", state).mode, "solo");
	assert.equal(readOperatorPolicy("another/repo", state).source, "explicit");
	assert.deepEqual(JSON.parse(readFileSync(operatorPolicyPath(state), "utf8")), {
		version: 1,
		repositories: [
			{ repository: "another/repo", mode: "team" },
			{ repository: "example/repo", mode: "solo" },
		],
	});
});

test("same mode writes are idempotent", () => {
	const state = env();
	const first = writeOperatorPolicy("owner/repo", "solo", state);
	const second = writeOperatorPolicy("OWNER/REPO", "solo", state);
	assert.equal(first.digest, second.digest);
	assert.equal(readFileSync(operatorPolicyPath(state), "utf8").match(/owner\/repo/g)?.length, 1);
});

test("rejects invalid repositories and modes", () => {
	const state = env();
	for (const repository of ["", "owner", "org:owner", "*/repo", "owner/*", "owner/repo/other", "owner//repo", "../repo", "owner/../repo", "owner/repo?x"]) {
		assert.throws(() => readOperatorPolicy(repository, state), /repository/i, repository);
	}
	assert.throws(() => writeOperatorPolicy("owner/repo", "other" as never, state), /mode/i);
});

test("rejects malformed and duplicate normalized stored entries", () => {
	const state = env();
	mkdirSync(join(state.HOME!, ".config", "review"), { recursive: true });
	const path = operatorPolicyPath(state);
	for (const contents of [
		'{"version":2,"repositories":[]}',
		'{"version":1,"repositories":[],"extra":true}',
		'{"version":1,"repositories":[{"repository":"owner/repo","mode":"solo","extra":true}]}',
		'{"version":1,"repositories":[{"repository":"owner/repo","mode":"global"}]}',
		'{"version":1,"repositories":[{"repository":"Owner/Repo","mode":"solo"},{"repository":"owner/repo","mode":"team"}]}',
	]) {
		writeFileSync(path, contents);
		assert.throws(() => readOperatorPolicy("owner/repo", state), /invalid|corrupt|duplicate/i);
	}
});

test("validates snapshot digest and freshness against stored policy", () => {
	const state = env();
	const snapshot = writeOperatorPolicy("owner/repo", "solo", state);
	assert.equal(isOperatorPolicySnapshot(snapshot), true);
	assert.equal(isOperatorPolicySnapshot({ ...snapshot, digest: "0".repeat(64) }), false);
	assert.equal(isOperatorPolicySnapshot({ ...snapshot, extra: true }), false);
	assert.equal(operatorPolicyCurrent({ ...snapshot, digest: "0".repeat(64) }, state), false);
	writeOperatorPolicy("owner/repo", "team", state);
	assert.equal(operatorPolicyCurrent(snapshot, state), false);
});

test("rejects a solo snapshot marked as default even with its matching digest", () => {
	const repository = "owner/repo";
	const mode = "solo";
	const source = "default";
	const digest = createHash("sha256").update(JSON.stringify({ version: 1, repository, mode, source })).digest("hex");
	assert.equal(isOperatorPolicySnapshot({ version: 1, repository, mode, source, digest }), false);
});

test("uses HOME path even when XDG_CONFIG_HOME points elsewhere", () => {
	const state = env();
	assert.equal(operatorPolicyPath(state), join(state.HOME!, ".config", "review", "operator-policy.json"));
	writeOperatorPolicy("owner/repo", "solo", state);
	assert.equal(existsSync(join(state.XDG_CONFIG_HOME!, "review", "operator-policy.json")), false);
});

test("writes private state and refuses a held writer lock", () => {
	const state = env();
	const path = operatorPolicyPath(state);
	mkdirSync(join(state.HOME!, ".config", "review"), { recursive: true, mode: 0o700 });
	const lock = `${path}.lock`;
	mkdirSync(lock, { mode: 0o700 });
	assert.throws(() => writeOperatorPolicy("owner/repo", "solo", state), /lock|writer/i);
	assert.equal(existsSync(path), false);
	rmSync(lock, { recursive: true });
	writeOperatorPolicy("owner/repo", "solo", state);
	assert.equal((statSync(path).mode & 0o777), 0o600);
	assert.equal((statSync(join(state.HOME!, ".config", "review")).mode & 0o777), 0o700);
});

test("reports unreadable or corrupt files instead of defaulting", () => {
	const state = env();
	mkdirSync(join(state.HOME!, ".config", "review"), { recursive: true });
	const path = operatorPolicyPath(state);
	writeFileSync(path, "not json");
	assert.throws(() => readOperatorPolicy("owner/repo", state), /invalid|corrupt/i);
	writeFileSync(path, '{"version":1,"repositories":[]}');
	chmodSync(path, 0o000);
	try {
		assert.throws(() => readOperatorPolicy("owner/repo", state), /read|permission|unreadable/i);
	} finally {
		chmodSync(path, 0o600);
	}
});
