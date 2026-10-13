import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { createLunaFactoryExtension } from "../../image/extension/luna-factory/index.ts";

const modules = process.env.OMP_SDK_NODE_MODULES;
assert.ok(modules, "OMP_SDK_NODE_MODULES must identify the isolated pinned SDK installation");
const sdkRequire = createRequire(join(resolve(modules), ".factory-schema-test.cjs"));
const { z } = await import(pathToFileURL(sdkRequire.resolve("@oh-my-pi/omptype/zod")));
const { fromJsonSchema } = await import(pathToFileURL(sdkRequire.resolve("@oh-my-pi/omptype")));
const version = readFileSync(new URL("../../image/appliance/Containerfile", import.meta.url), "utf8")
	.match(/^ARG OMP_VERSION=(\S+)$/m)?.[1];
assert.ok(version, "the appliance must pin OMP");
assert.equal(JSON.parse(readFileSync(join(modules, "@oh-my-pi/omptype/package.json"), "utf8")).version, version);

// Use the packaged schema builder, with registration only: no session event,
// tool execution, model call, or persistent Factory state is needed.
const tools = new Map();
createLunaFactoryExtension({
	zod: z,
	registerTool(definition) { tools.set(definition.name, definition); },
	registerCommand() {},
	setLabel() {},
	on() {},
	appendEntry() { assert.fail("schema registration must not write session state"); },
}, { env: {} });

// OMP accepts both native schemas and raw JSON Schema tool parameters.
const wireSchema = (parameters) => JSON.parse(JSON.stringify(
	typeof parameters.toJsonSchema === "function" ? parameters.toJsonSchema() : parameters,
));
const receiptTool = tools.get("luna_factory_receipt");
assert.ok(receiptTool, "the receipt tool must be registered");
const receiptSchema = wireSchema(receiptTool.parameters);
const acceptsReceipt = fromJsonSchema(receiptSchema);
const v1 = {
	version: 1,
	taskId: "T1",
	attemptId: "T1-a1",
	generation: "G1",
	subject: { repo: "owner/repo", base: "a".repeat(40) },
	result: "verified",
	changed: [],
	evidence: ["artifact://verification.log"],
	tests: [{ command: "node --test", outcome: "pass" }],
	cleanEnvironment: "unknown",
	unresolved: [],
	next: "none",
	confidence: "high",
	routing: { verified: false },
	exitCode: 0,
	aborted: false,
	truncated: false,
};
const v2 = {
	...v1,
	version: 2,
	assumptions: [{ kind: "acceptance-revision", value: "A1" }],
	predicates: [{ phase: "verification", item: "tests", ok: true, note: "passed" }],
};

test("every advertised Factory tool has an object root for Bedrock", () => {
	assert.ok(tools.size > 0);
	for (const tool of tools.values()) {
		assert.equal(wireSchema(tool.parameters).type, "object", `${tool.name} needs a root type: object`);
	}
});

test("the pinned SDK accepts flat v1 and v2 receipt arguments", () => {
	assert.equal(acceptsReceipt.allows(v1), true);
	assert.equal(acceptsReceipt.allows(v2), true);
	assert.equal(acceptsReceipt.allows({ receipt: v2 }), false, "receipt arguments must remain flat");
});

test("receipt registration retains native SDK validation", () => {
	const native = receiptTool.parameters;
	assert.equal(typeof native, "function", "OMP must retain its native schema normalization path");
	assert.equal(typeof native.toJsonSchema, "function");
	assert.equal(native.allows(v1), true);
	assert.equal(native.allows(v2), true);
	assert.equal(native.allows({ receipt: v2 }), false);
	for (const field of ["assumptions", "predicates"]) {
		const missing = { ...v2 };
		delete missing[field];
		assert.equal(native.allows(missing), false, `native validation must require v2 ${field}`);
	}
});

test("v2 assumptions and predicates remain required", () => {
	for (const field of ["assumptions", "predicates"]) {
		const missing = { ...v2 };
		delete missing[field];
		assert.equal(acceptsReceipt.allows(missing), false, `v2 must require ${field}`);
	}
});

test("receipt schemas reject unsupported versions and wrong field types", () => {
	for (const invalid of [
		{ ...v1, version: 3 },
		{ ...v1, version: "1" },
		{ ...v1, taskId: 1 },
		{ ...v1, exitCode: "0" },
		{ ...v1, routing: { verified: "false" } },
		{ ...v2, assumptions: "A1" },
		{ ...v2, predicates: [{ ...v2.predicates[0], ok: "true" }] },
	]) {
		assert.equal(acceptsReceipt.allows(invalid), false);
	}
});
