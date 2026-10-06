import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { spawn, execFileSync } from "node:child_process";
import { accessSync, constants, createWriteStream, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { once } from "node:events";
import { graphAcceptanceChildEnvironment, installGhShim, seedRepos } from "./luna-factory-graph-acceptance-support.mjs";

const repository = resolve(import.meta.dirname, "../..");
const source = process.env.REVIEW_TEST_SOURCE ?? repository;
const mode = process.argv[2] ?? "native";
assert.ok(["native", "krun-host-provider"].includes(mode), "select native source or explicitly granted packaged krun transport");
if (mode === "krun-host-provider") {
	assert.equal(resolve(process.env.OMP_BINARY ?? ""), join(repository, "tests/fixtures/luna-factory-graph-krun-host-provider.sh"), "krun mode uses the reviewed host-provider shim");
}
const runtimeKind = mode === "native"
	? "native OMP 18.4.12 with mounted source; not packaged-image proof"
	: "packaged OCI OMP via krun host-loopback provider; mounted source identity checked in guest";
const root = resolve(process.env.GRAPH130_EVIDENCE ?? join("/var/tmp", `luna-factory-graph-acceptance-${process.pid}`));
mkdirSync(root, { recursive: true });
const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: source, encoding: "utf8" }).trim();
const sourceDiff = execFileSync("git", ["diff", "--binary", "HEAD", "--", "image/extension/luna-factory"], { cwd: source });
const sourceDiffDigest = createHash("sha256").update(sourceDiff).digest("hex");
const harnessFiles = [
	"tests/luna-factory-graph-acceptance.sh",
	"tests/fixtures/luna-factory-graph-acceptance-driver.mjs",
	"tests/fixtures/luna-factory-graph-acceptance-runtime.ts",
	"tests/fixtures/luna-factory-graph-acceptance-support.mjs",
	"tests/fixtures/luna-factory-graph-krun-host-provider.sh",
	"tests/fixtures/luna-factory-graph-krun-host-provider.test.mjs",
];
const harnessDigest = () => createHash("sha256").update(harnessFiles.map((file) => `${file}:${createHash("sha256").update(readFileSync(join(repository, file))).digest("hex")}`).join("\n")).digest("hex");
const initialHarnessDigest = harnessDigest();
const harnessHead = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repository, encoding: "utf8" }).trim();
const initialSourceHead = head;
const expectedVersion = /^ARG OMP_VERSION=(.+)$/m.exec(readFileSync(join(source, "image/appliance/Containerfile"), "utf8"))?.[1];
mkdirSync(join(root, "home/.config/omp"), { recursive: true });
mkdirSync(join(root, "home/.omp/agent"), { recursive: true });
mkdirSync(join(root, "home/.cache"), { recursive: true });
mkdirSync(join(root, "omp-cwd"), { recursive: true });
const sha = seedRepos(root); writeFileSync(join(root, "subject.sha"), `${sha}\n`);
const shim = installGhShim(root);
const audit = [];
let child;
let requests = 0;
const itemWorkers = new Map();

function executable(input) {
	if (input.includes("/")) return resolve(input);
	for (const directory of (process.env.PATH ?? "").split(":")) {
		const candidate = join(directory, input);
		try { accessSync(candidate, constants.X_OK); return candidate; } catch {}
	}
	throw new Error(`executable unavailable: ${input}`);
}

function messageText(message) {
	if (typeof message?.content === "string") return message.content;
	return Array.isArray(message?.content) ? message.content.filter((part) => part?.type === "text").map((part) => part.text).join("\n") : "";
}

function nextAction(body) {
	const messages = body.messages ?? [];
	const prompt = messageText(messages.find((message) => message.role === "user" && /Current attempt: T1-a\d+/.test(messageText(message))));
	assert.ok(prompt, "OMP sends the declared attempt into the native SDK session");
	const attempt = /Current attempt: (T1-a\d+)/.exec(prompt)?.[1];
	const key = /Item: ([^\n]+)/.exec(prompt)?.[1];
	assert.ok(key && attempt, "native prompt retains exact selected item and original attempt id");
	const worker = prompt.includes("Implement/inspect only the selected acceptance");
	const calls = messages.flatMap((message) => message.tool_calls ?? []).map((call) => call.function);
	const reports = calls.filter((call) => call.name === "factory_report");
	const writes = calls.filter((call) => call.name === "factory_write");
	const evidence = messages.filter((message) => message.role === "tool").flatMap((message) => {
		assert.doesNotMatch(messageText(message), /\[Showing head and tail bytes/, "acceptance requires complete retained evidence");
		try { const value = JSON.parse(messageText(message)); return value?.id?.startsWith("evidence-") ? [value] : []; } catch { return []; }
	});
	if (worker) {
		if (writes.length === 0) {
			const count = (itemWorkers.get(key) ?? 0) + 1; itemWorkers.set(key, count);
			const failFirst = key === "example/a#1" && count === 1;
			return { name: "factory_write", args: { path: "value.txt", content: failFirst ? "0\n" : "1\n" }, key, attempt, phase: "worker" };
		}
		if (reports.length === 0) return { name: "factory_report", args: { report: "Changed only value.txt; mandatory original test remains unchanged.", tests: [], accepted: true, semanticOutcome: "none", predicates: [{ item: "bounded graph acceptance", ok: true, note: "actual repository change; original mandatory test executed by Factory" }], publicationBlocker: "" }, key, attempt, phase: "worker" };
		return { content: "Native worker report complete.", key, attempt, phase: "worker" };
	}
	const handles = [...new Set([...prompt.matchAll(/evidence-\d+/g)].map((match) => match[0]))];
	assert.ok(handles.length > 0, "independent native acceptance reviewer receives the actual attempt artifacts");
	for (const id of handles) {
		let offset = 0;
		for (;;) {
			const previous = evidence.filter((entry) => entry.id === id).at(-1);
			if (previous?.eof) break;
			offset = previous?.nextOffset ?? 0;
			return { name: "factory_evidence_read", args: { id, offset, limit: 131072 }, key, attempt, phase: "acceptance" };
		}
	}
	const output = evidence.map((entry) => entry.text).join("\n");
	assert.match(output, /command: bash \.\/tests\/acceptance\.sh/);
	const accepted = !/exit: 1/.test(output);
	if (reports.length === 0) return { name: "factory_report", args: { report: accepted ? "The original executable check passes against the retained tree." : "DISTINCTIVE_REJECTION: the original executable check still fails; repair the same selected task.", tests: [], accepted, semanticOutcome: "none", predicates: [{ item: "bash ./tests/acceptance.sh", ok: accepted, note: accepted ? "complete retained artifact records exit 0" : "complete retained artifact records exit 1" }], publicationBlocker: "" }, key, attempt, phase: "acceptance" };
	return { content: "Independent acceptance report complete.", key, attempt, phase: "acceptance" };
}

const server = createServer(async (request, response) => {
	try {
		let raw = ""; for await (const chunk of request) { raw += chunk; assert.ok(raw.length < 4 * 1024 * 1024); }
		if (request.method === "GET") { response.setHeader("content-type", "application/json"); response.end(JSON.stringify({ data: [{ id: "deterministic" }] })); return; }
		const chosen = nextAction(JSON.parse(raw)); requests += 1;
		if (chosen.phase === "worker" && chosen.name === "factory_write" && (chosen.key === "example/a#2" || chosen.key === "example/a#1" && chosen.attempt === "T1-a1")) {
			const marker = chosen.key === "example/a#2" ? "release-c" : "release-a";
			const deadline = Date.now() + 45_000;
			while (!existsSync(join(root, marker)) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 25));
			assert.ok(existsSync(join(root, marker)), `${chosen.key} writer resumes only after its fixture barrier`);
		}
		audit.push({ request: requests, key: chosen.key, attempt: chosen.attempt, phase: chosen.phase, tool: chosen.name ?? null, evidence: chosen.args?.id, offset: chosen.args?.offset });
		writeFileSync(join(root, "provider-audit.json"), JSON.stringify(audit, null, 2));
		const base = { id: `graph-${requests}`, object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model: "deterministic" };
		const chunks = chosen.name ? [
			{ ...base, choices: [{ index: 0, delta: { role: "assistant", tool_calls: [{ index: 0, id: `call-${requests}`, type: "function", function: { name: chosen.name, arguments: JSON.stringify(chosen.args) } }] } }] },
			{ ...base, choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] },
		] : [{ ...base, choices: [{ index: 0, delta: { role: "assistant", content: chosen.content }, finish_reason: "stop" }] }];
		response.writeHead(200, { "content-type": "text/event-stream" });
		for (const chunk of chunks) response.write(`data: ${JSON.stringify(chunk)}\n\n`);
		response.end("data: [DONE]\n\n");
	} catch (error) {
		audit.push({ failure: error instanceof Error ? error.message : String(error) }); writeFileSync(join(root, "provider-audit.json"), JSON.stringify(audit, null, 2));
		response.writeHead(500); response.end(error instanceof Error ? error.message : String(error));
		if (child?.exitCode === null) child.kill("SIGTERM");
	}
});
server.listen(0, "127.0.0.1"); await once(server, "listening");
const port = server.address().port;
writeFileSync(join(root, "home/.config/omp/omp.yml"), readFileSync(join(repository, "tests/fixtures/luna-factory-omp-probe-config.yml")));
writeFileSync(join(root, "home/.omp/agent/models.yml"), readFileSync(join(repository, "tests/fixtures/luna-factory-omp-probe-models.yml"), "utf8").replaceAll("43127", String(port)));
mkdirSync(join(root, "home/.omp/profiles/bluefin-review-appliance/agent"), { recursive: true });
writeFileSync(join(root, "home/.omp/profiles/bluefin-review-appliance/agent/models.yml"), readFileSync(join(root, "home/.omp/agent/models.yml")));

try {
	const binary = executable(process.env.OMP_BINARY ?? "omp");
	const version = execFileSync(binary, ["--version"], { encoding: "utf8" }).trim();
	assert.equal(version, `omp/${expectedVersion}`, "fixture runtime must match the packaged OMP version");
	const launcherSha256 = execFileSync("sha256sum", [binary], { encoding: "utf8" }).split(/\s/)[0];
	const binaryIdentity = mode === "native" ? { binary, binaryDigest: launcherSha256 } : { launcher: binary, launcherSha256, launcherVersion: version };
	writeFileSync(join(root, "runtime-identity.json"), JSON.stringify({ mode, ...binaryIdentity, sourceHead: head, sourceDirty: sourceDiff.length !== 0, sourceDiffDigest, harnessHead, harnessDigest: initialHarnessDigest, evidence: root, runtimeKind }, null, 2));
	const krunRuntimeEnvironment = {};
	if (mode === "krun-host-provider") {
		for (const name of ["REVIEW_TEST_KRUN_ROOT_REVIEWED", "REVIEW_TEST_KRUN_SLOT_GRANTED", "REVIEW_TEST_KRUN_SLOT_EXPIRES_EPOCH", "REVIEW_TEST_KRUN_IMAGE_ID", "REVIEW_TEST_KRUN_IMAGE_DIGEST", "REVIEW_TEST_KRUN_OMP_SHA256", "REVIEW_TEST_KRUN_GRANT_FILE"]) {
			assert.ok(process.env[name], `krun host-provider mode requires ${name}`);
			krunRuntimeEnvironment[name] = process.env[name];
		}
	}
	const env = graphAcceptanceChildEnvironment({ pathPrefix: shim, home: join(root, "home"), configHome: join(root, "home/.config"), cacheHome: join(root, "home/.cache"), stateHome: join(root, "state"), root, source, harnessRoot: mode === "krun-host-provider" ? repository : undefined, krunRuntimeEnvironment });
	const args = ["--mode", "rpc", "--no-ui", "--no-skills", "--no-rules", "--no-extensions", "--no-pty", "--config", join(root, "home/.config/omp/omp.yml"), "--model", "local-probe/deterministic", "--extension", join(source, "image/extension/luna-factory"), "--extension", join(repository, "tests/fixtures/luna-factory-graph-acceptance-runtime.ts")];
	const output = createWriteStream(join(root, "native-graph.log"));
	child = spawn(binary, args, { cwd: join(root, "omp-cwd"), env, stdio: ["pipe", "pipe", "pipe"] });
	child.stdout.pipe(output); child.stderr.pipe(output);
	let forced; const timeout = setTimeout(() => { child.kill("SIGTERM"); forced = setTimeout(() => child.kill("SIGKILL"), 5000); }, 180_000);
	const [code] = await once(child, "exit"); clearTimeout(timeout); clearTimeout(forced); child.stdin.end(); output.end();
	assert.equal(code, 0, "native OMP command exited successfully; inspect native-graph.log and retained provider audit");
	let packagedOmpIdentity = null;
	if (mode === "krun-host-provider") {
		const packagedVersion = readFileSync(join(root, "krun-omp-version.txt"), "utf8").trim();
		const packagedOmpSha256 = readFileSync(join(root, "krun-omp-binary.sha256"), "utf8").split(/\s/)[0];
		assert.equal(readFileSync(join(root, "krun-effective-uid.txt"), "utf8").trim(), "65532", "actual packaged OMP process uses the required UID");
		assert.equal(packagedVersion, `omp/${expectedVersion}`, "packaged OMP version matches source pins");
		assert.equal(packagedOmpSha256, process.env.REVIEW_TEST_KRUN_OMP_SHA256, "actual packaged OMP bytes match the immutable runtime pin");
		assert.equal(readFileSync(join(root, "krun-factory-source.diff"), "utf8"), "", "mounted Factory source matches packaged bytes");
		assert.match(readFileSync(join(root, "krun-bwrap-version.txt"), "utf8"), /^bubblewrap/);
		packagedOmpIdentity = { version: packagedVersion, sha256: packagedOmpSha256, effectiveUid: 65532, productionEntrypoint: "/usr/bin/bluefin-review-appliance", factorySourceMatch: true };
	}
	const result = JSON.parse(readFileSync(join(root, "result.json"), "utf8")); assert.equal(result.status, "passed");
	assert.equal(execFileSync("git", ["rev-parse", "HEAD"], { cwd: source, encoding: "utf8" }).trim(), initialSourceHead, "production source head stayed fixed during acceptance");
	assert.equal(createHash("sha256").update(execFileSync("git", ["diff", "--binary", "HEAD", "--", "image/extension/luna-factory"], { cwd: source })).digest("hex"), sourceDiffDigest, "production source stayed fixed during acceptance");
	assert.equal(harnessDigest(), initialHarnessDigest, "acceptance fixture stayed fixed during its run");
	assert.ok(audit.some((entry) => entry.tool === "factory_write")); assert.ok(audit.some((entry) => entry.tool === "factory_evidence_read"));
	assert.ok(execFileSync("bwrap", ["--version"], { encoding: "utf8" }).trim().startsWith("bubblewrap"), "mandatory verifier requires host bwrap");
	writeFileSync(join(root, "driver-result.json"), JSON.stringify({ status: "passed", mode, sourceHead: head, sourceDirty: sourceDiff.length !== 0, sourceDiffDigest, harnessHead, harnessDigest: initialHarnessDigest, runtimeKind, ...binaryIdentity, ...(mode === "krun-host-provider" ? { packagedOmp: packagedOmpIdentity } : {}), modelRequests: requests, loopbackOnlyProvider: true, providerNetworkScope: mode === "krun-host-provider" ? "host loopback; not network isolated" : "native loopback", githubEvidence: "captured scripted snapshot; not live GitHub", git: "real local repositories, commits, and workspace clones", verifier: "production sandboxPreflight/sandboxTest invoked bwrap; see item evidence", ...result }, null, 2));
	console.log(JSON.stringify({ status: "passed", mode, sourceHead: head, runtimeKind, modelRequests: requests, outcome: result.outcome, operatorFollowups: 0 }));
} catch (error) {
	writeFileSync(join(root, "driver-result.json"), JSON.stringify({ status: "failed", mode, sourceHead: head, reason: error instanceof Error ? error.message : String(error), evidence: root }, null, 2)); throw error;
} finally { writeFileSync(join(root, "provider-audit.json"), JSON.stringify(audit, null, 2)); server.close(); }
