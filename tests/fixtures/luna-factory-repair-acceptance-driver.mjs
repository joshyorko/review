import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { spawn, execFileSync } from "node:child_process";
import { accessSync, constants, createWriteStream, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { once } from "node:events";

const repository = resolve(import.meta.dirname, "../..");
const mode = process.argv[2] ?? "native";
const root = resolve(process.env.LUNA176_EVIDENCE ?? join("/var/tmp", `luna-factory-repair-acceptance-${process.pid}`));
const source = process.env.REVIEW_TEST_SOURCE ?? repository;
const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: source, encoding: "utf8" }).trim();
const sourceDiff = execFileSync("git", ["diff", "--binary", "HEAD", "--", "image/extension/luna-factory"], { cwd: source });
const sourceDiffDigest = createHash("sha256").update(sourceDiff).digest("hex");
const harnessFiles = ["tests/luna-factory-repair-acceptance.sh", "tests/fixtures/luna-factory-repair-acceptance-driver.mjs", "tests/fixtures/luna-factory-repair-acceptance-runtime.ts", "tests/fixtures/luna-factory-repair-acceptance-support.ts"];
const harnessDigest = () => createHash("sha256").update(harnessFiles.map((file) => `${file}:${createHash("sha256").update(readFileSync(join(repository, file))).digest("hex")}`).join("\n")).digest("hex");
const initialHarnessDigest = harnessDigest();
const identity = { sourceHead: head, sourceDirty: sourceDiff.length !== 0, sourceDiffDigest, harnessHead: execFileSync("git", ["rev-parse", "HEAD"], { cwd: repository, encoding: "utf8" }).trim(), harnessDigest: initialHarnessDigest };
const expectedVersion = /^ARG OMP_VERSION=(.+)$/m.exec(readFileSync(join(source, "image/appliance/Containerfile"), "utf8"))?.[1];
assert.ok(["native", "oci", "krun", "sif"].includes(mode), "usage: repair acceptance driver native|oci|krun|sif");
mkdirSync(join(root, "home/.config/omp"), { recursive: true });
mkdirSync(join(root, "home/.omp/agent"), { recursive: true });
mkdirSync(join(root, "home/.cache"), { recursive: true });
mkdirSync(join(root, "omp-cwd"), { recursive: true });
const audit = [];
let requests = 0;
let activeChild;
let packagedIdentity;
let initialSifDigest;

function executable(input) {
	if (input.includes("/")) return resolve(input);
	for (const directory of (process.env.PATH ?? "").split(":")) {
		const candidate = join(directory, input);
		try { accessSync(candidate, constants.X_OK); return candidate; } catch {}
	}
	throw new Error(`executable unavailable: ${input}`);
}

function text(message) {
	if (typeof message?.content === "string") return message.content;
	return Array.isArray(message?.content) ? message.content.filter((part) => part?.type === "text").map((part) => part.text).join("\n") : "";
}

function choose(body) {
	const messages = body.messages ?? [];
	const prompt = text(messages.find((message) => message.role === "user" && /Current attempt: T1-a\d+/.test(text(message))));
	const worker = prompt.includes("Implement/inspect only the selected acceptance");
	const attempt = /Current attempt: (T1-a\d+)/.exec(prompt)?.[1];
	assert.ok(attempt === "T1-a1" || attempt === "T1-a2", "only the original bounded repair lineage is admitted");
	const calls = messages.flatMap((message) => message.tool_calls ?? []).map((call) => call.function);
	const reports = calls.filter((call) => call.name === "factory_report");
	const writes = calls.filter((call) => call.name === "factory_write");
	const toolResults = messages.filter((message) => message.role === "tool");
	const evidenceResults = toolResults.flatMap((message) => {
		assert.doesNotMatch(text(message), /\[Showing head and tail bytes/, "Factory evidence page was clipped by the native SDK; missing bytes remain unproved");
		try { const value = JSON.parse(text(message)); return value?.id?.startsWith("evidence-") ? [value] : []; }
		catch { return []; }
	});
	if (!worker && reports.length === 0) {
		if (evidenceResults.length === 0) return { name: "factory_evidence_read", args: { id: "evidence-0", offset: 0, limit: 8192 } };
		return { name: "factory_report", args: reportArgs(true) };
	}
	if (!worker && reports.length === 1) {
		assert.ok(toolResults.some((message) => /all supplied evidence handles.*read in full/.test(text(message))), "native reviewer must refuse prefix-only acceptance");
	}
	if (attempt === "T1-a2" && worker) assert.match(prompt, /DISTINCTIVE_REJECTION/, "fresh native worker must receive the actual prior rejection after restart");
	if (!worker || attempt === "T1-a2") {
		const ids = [...prompt.matchAll(/^- (evidence-\d+) \[attempt /gm)].map((match) => match[1]);
		assert.ok(ids.length >= 2, "native sessions must receive actual retained artifact handles");
		for (const id of ids) {
			const previous = evidenceResults.filter((result) => result.id === id).at(-1);
			if (!previous?.eof) return { name: "factory_evidence_read", args: { id, offset: previous?.nextOffset ?? 0, limit: 131072 } };
		}
		const contents = evidenceResults.map((result) => result.text).join("");
		assert.match(contents, /DISTINCTIVE_PATCH_FAILURE/);
		if (attempt === "T1-a1" || worker) assert.match(contents, /DISTINCTIVE_OUTPUT_FAILURE/);
	}
	if (worker && attempt === "T1-a1" && writes.length < 2) return { name: "factory_write", args: writes.length === 0 ? { path: "large-a.txt", content: "a".repeat(90000) } : { path: "large-b.txt", content: `${"b".repeat(90000)}DISTINCTIVE_PATCH_FAILURE` } };
	if (worker && attempt === "T1-a2" && writes.length === 0) return { name: "factory_write", args: { path: "value.txt", content: "1\n" } };
	const wantedReports = worker ? 1 : 2;
	if (reports.length < wantedReports) return { name: "factory_report", args: reportArgs(worker || attempt === "T1-a2") };
	return { content: "This native attempt ended after its bounded authoritative report." };
}

function reportArgs(accepted) {
	return { report: accepted ? "The original acceptance is supported by fully inspected retained artifacts." : "DISTINCTIVE_REJECTION: zero is still wrong; repair only the original mandatory check.", tests: [], accepted, semanticOutcome: "none", predicates: [{ item: "original mandatory calculation", ok: accepted, note: accepted ? "actual complete artifacts" : "zero failed in retained output" }], publicationBlocker: "" };
}

const server = createServer(async (request, response) => {
	try {
		let raw = ""; for await (const chunk of request) { raw += chunk; assert.ok(raw.length < 4 * 1024 * 1024); }
		if (request.method === "GET") { response.setHeader("content-type", "application/json"); response.end(JSON.stringify({ data: [{ id: "deterministic" }] })); return; }
		const chosen = choose(JSON.parse(raw)); requests += 1;
		audit.push({ request: requests, tool: chosen.name ?? null, id: chosen.args?.id ?? null, offset: chosen.args?.offset ?? null });
		const base = { id: `repair-${requests}`, object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model: "deterministic" };
		const chunks = chosen.name ? [
			{ ...base, choices: [{ index: 0, delta: { role: "assistant", tool_calls: [{ index: 0, id: `call-${requests}`, type: "function", function: { name: chosen.name, arguments: JSON.stringify(chosen.args) } }] } }] },
			{ ...base, choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] },
		] : [{ ...base, choices: [{ index: 0, delta: { role: "assistant", content: chosen.content }, finish_reason: "stop" }] }];
		response.writeHead(200, { "content-type": "text/event-stream" });
		for (const chunk of chunks) response.write(`data: ${JSON.stringify(chunk)}\n\n`);
		response.end("data: [DONE]\n\n");
	} catch (error) {
		audit.push({ failure: error.message }); response.writeHead(500); response.end(error.message);
		if (activeChild?.exitCode === null) activeChild.kill("SIGTERM");
	}
	finally { writeFileSync(join(root, "provider-audit.json"), JSON.stringify(audit, null, 2)); }
});
server.listen(0, "127.0.0.1"); await once(server, "listening");
const port = server.address().port;
writeFileSync(join(root, "home/.config/omp/omp.yml"), readFileSync(join(repository, "tests/fixtures/luna-factory-omp-probe-config.yml")));
writeFileSync(join(root, "home/.omp/agent/models.yml"), readFileSync(join(repository, "tests/fixtures/luna-factory-omp-probe-models.yml"), "utf8").replaceAll("43127", String(port)));
mkdirSync(join(root, "home/.omp/profiles/bluefin-review-appliance/agent"), { recursive: true });
writeFileSync(join(root, "home/.omp/profiles/bluefin-review-appliance/agent/models.yml"), readFileSync(join(root, "home/.omp/agent/models.yml")));

async function runPhase(phase) {
	const binary = mode === "native" ? executable(process.env.OMP_BINARY ?? "omp") : "omp";
	const hostEnv = { PATH: process.env.PATH, HOME: join(root, "home"), XDG_CONFIG_HOME: join(root, "home/.config"), XDG_CACHE_HOME: join(root, "home/.cache"), XDG_STATE_HOME: join(root, "state"), LUNA176_ROOT: root, LUNA176_PHASE: phase, REVIEW_TEST_SOURCE: source };
	const args = ["--mode", "rpc", "--no-ui", "--no-skills", "--no-rules", "--no-extensions", "--no-pty", "--config", join(root, "home/.config/omp/omp.yml"), "--model", "local-probe/deterministic", "--extension", join(repository, "tests/fixtures/luna-factory-repair-acceptance-runtime.ts")];
	let command = binary;
	if (mode === "oci" || mode === "krun") {
		const image = process.env.REVIEW_APPLIANCE_IMAGE; assert.ok(image, "REVIEW_APPLIANCE_IMAGE is required for OCI acceptance");
		packagedIdentity ??= JSON.parse(execFileSync("podman", ["image", "inspect", image], { encoding: "utf8" }))[0];
		assert.equal(packagedIdentity.Config.Labels["org.opencontainers.image.revision"], head, "packaged acceptance requires an image at the exact source head");
		assert.equal(sourceDiff.length, 0, "packaged acceptance refuses uncommitted production source");
		writeFileSync(join(root, "image-identity.json"), JSON.stringify({ image, id: packagedIdentity.Id, digest: packagedIdentity.Digest, ...identity }, null, 2));
		command = "podman";
		args.splice(0, args.length, "run", "--rm", "--network=host", "--userns=keep-id:uid=65532,gid=65532", "--volume", `${repository}:/proof:ro,z`, "--volume", `${root}:/evidence:rw,z`, "--env", "HOME=/evidence/home", "--env", "XDG_CONFIG_HOME=/evidence/home/.config", "--env", "XDG_CACHE_HOME=/evidence/home/.cache", "--env", "XDG_STATE_HOME=/evidence/state", "--env", "LUNA176_ROOT=/evidence", "--env", `LUNA176_PHASE=${phase}`, "--env", "REVIEW_TEST_FACTORY_ROOT=/usr/share/bluefin/review/luna-factory", "--entrypoint", "/usr/bin/omp", packagedIdentity.Id, "--mode", "rpc", "--no-ui", "--no-skills", "--no-rules", "--no-extensions", "--no-pty", "--config", "/evidence/home/.config/omp/omp.yml", "--model", "local-probe/deterministic", "--extension", "/proof/tests/fixtures/luna-factory-repair-acceptance-runtime.ts");
		const entrypoint = args.indexOf("--entrypoint"); args.splice(entrypoint, 2);
		args.splice(1, 0, "--volume", `${join(root, "home")}:/home/bluefin:rw,z`, "--env", "LUNA_FACTORY_ENABLED=1", "--env", "LUNA_FACTORY_CAPACITY=1", "--env", "REVIEW_DEFAULT_SCOPE=example/repo", "--env", "LUNA176_EXPECTED_UID=65532");
		if (mode === "krun") args.splice(1, 0, "--runtime=krun");
	} else if (mode === "sif") {
		const sif = process.env.REVIEW_APPLIANCE_SIF; assert.ok(sif, "REVIEW_APPLIANCE_SIF is required for SIF acceptance");
		packagedIdentity ??= JSON.parse(execFileSync("apptainer", ["inspect", "--json", sif], { encoding: "utf8" }));
		assert.equal(packagedIdentity.data.attributes.labels["org.opencontainers.image.revision"], head, "SIF acceptance requires an image at the exact source head");
		assert.equal(sourceDiff.length, 0, "SIF acceptance refuses uncommitted production source");
		const sifDigest = execFileSync("sha256sum", [sif], { encoding: "utf8" }).split(/\s/)[0];
		initialSifDigest ??= sifDigest; assert.equal(sifDigest, initialSifDigest, "SIF artifact changed between acceptance phases");
		writeFileSync(join(root, "image-identity.json"), JSON.stringify({ sif, sifDigest, labels: packagedIdentity.data.attributes.labels, ...identity }, null, 2));
		command = "apptainer";
		args.splice(0, args.length, "exec", "--containall", "--home", `${join(root, "home")}:/home/bluefin`, "--bind", `${repository}:/proof:ro,${root}:/evidence:rw,/dev/full:/dev/full`, "--env", "XDG_CONFIG_HOME=/evidence/home/.config", "--env", "XDG_CACHE_HOME=/evidence/home/.cache", "--env", "XDG_STATE_HOME=/evidence/state", "--env", "LUNA176_ROOT=/evidence", "--env", `LUNA176_PHASE=${phase}`, "--env", "LUNA_FACTORY_ENABLED=1", "--env", "LUNA_FACTORY_CAPACITY=1", "--env", "REVIEW_DEFAULT_SCOPE=example/repo", "--env", `LUNA176_EXPECTED_UID=${process.getuid()}`, "--env", "REVIEW_TEST_FACTORY_ROOT=/usr/share/bluefin/review/luna-factory", sif, "/usr/bin/bluefin-review-appliance", "--mode", "rpc", "--no-ui", "--no-skills", "--no-rules", "--no-extensions", "--no-pty", "--config", "/evidence/home/.config/omp/omp.yml", "--model", "local-probe/deterministic", "--extension", "/proof/tests/fixtures/luna-factory-repair-acceptance-runtime.ts");
	}
	const output = createWriteStream(join(root, `${mode}-${phase}.log`));
	const child = spawn(command, args, { cwd: join(root, "omp-cwd"), env: hostEnv, stdio: ["pipe", "pipe", "pipe"] });
	activeChild = child;
	child.stdout.pipe(output); child.stderr.pipe(output);
	writeFileSync(join(root, `${phase}.pid`), `${child.pid}\n`);
	let forced;
	const timeout = setTimeout(() => { child.kill("SIGTERM"); forced = setTimeout(() => child.kill("SIGKILL"), 5_000); }, 90_000);
	const [code] = await once(child, "exit"); clearTimeout(timeout); clearTimeout(forced); child.stdin.end(); output.end();
	activeChild = undefined;
	assert.equal(code, 0, audit.find((event) => event.failure)?.failure ?? `${mode} ${phase} failed; inspect retained log`);
	const result = JSON.parse(readFileSync(join(root, `${phase}-result.json`), "utf8")); assert.equal(result.status, "passed");
	return result;
}

try {
	if (mode === "native") {
		const binary = executable(process.env.OMP_BINARY ?? "omp");
		const version = execFileSync(binary, ["--version"], { encoding: "utf8" }).trim(); assert.equal(version, `omp/${expectedVersion}`);
		const binaryDigest = execFileSync("sha256sum", [binary], { encoding: "utf8" }).split(/\s/)[0];
		writeFileSync(join(root, "runtime-identity.json"), JSON.stringify({ mode, binary, version, binaryDigest, ...identity }, null, 2));
	}
	const seed = await runPhase("seed"); const resumed = await runPhase("resume");
	assert.ok(audit.some((event) => event.tool === "factory_write")); assert.ok(audit.some((event) => event.tool === "factory_evidence_read" && event.offset > 131072));
	assert.equal(seed.attempts, 1); assert.equal(resumed.attempts, 2); assert.equal(resumed.stage, "VERIFY");
	assert.equal(execFileSync("git", ["rev-parse", "HEAD"], { cwd: source, encoding: "utf8" }).trim(), head, "source head moved during acceptance");
	assert.equal(createHash("sha256").update(execFileSync("git", ["diff", "--binary", "HEAD", "--", "image/extension/luna-factory"], { cwd: source })).digest("hex"), sourceDiffDigest, "production source changed during acceptance");
	assert.equal(harnessDigest(), initialHarnessDigest, "acceptance harness changed during its run");
	const result = { status: "passed", mode, ...identity, runtimeKind: mode === "native" ? "upstream-host-binary" : "derived-packaged-OMP", operatorFollowups: 0, seed, resumed, requests, evidence: root };
	writeFileSync(join(root, "result.json"), JSON.stringify(result, null, 2)); console.log(JSON.stringify(result));
} catch (error) { writeFileSync(join(root, "result.json"), JSON.stringify({ status: "failed", mode, ...identity, reason: error.message, evidence: root }, null, 2)); throw error; }
finally { writeFileSync(join(root, "provider-audit.json"), JSON.stringify(audit, null, 2)); server.close(); }
