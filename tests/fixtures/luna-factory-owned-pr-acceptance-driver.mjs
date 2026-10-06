import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { spawn, execFileSync } from "node:child_process";
import { accessSync, constants, createWriteStream, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { once } from "node:events";
import { seedRepos } from "./luna-factory-graph-acceptance-support.mjs";

const repository = resolve(import.meta.dirname, "../..");
const mode = process.argv[2] ?? "native";
assert.ok(["native", "oci"].includes(mode), "usage: owned-PR acceptance driver native|oci");
const root = resolve(process.env.OWNED_PR_EVIDENCE ?? join("/var/tmp", `luna-factory-owned-pr-acceptance-${process.pid}`));
const source = process.env.REVIEW_TEST_SOURCE ?? repository;
const packaged = mode === "oci";
const sourceHead = execFileSync("git", ["rev-parse", "HEAD"], { cwd: source, encoding: "utf8" }).trim();
const productionDiff = execFileSync("git", ["diff", "--binary", "HEAD", "--", "image/extension/luna-factory"], { cwd: source });
const productionDiffDigest = createHash("sha256").update(productionDiff).digest("hex");
const harnessFiles = [
	"tests/fixtures/luna-factory-owned-pr-acceptance-run.sh",
	"tests/fixtures/luna-factory-owned-pr-acceptance-driver.mjs",
	"tests/fixtures/luna-factory-owned-pr-acceptance-runtime.ts",
	"docs/acceptance/luna-factory-owned-pr.md",
	"tests/fixtures/luna-factory-graph-acceptance-support.mjs",
];
const harnessDigest = () => createHash("sha256").update(harnessFiles.map((file) => `${file}:${createHash("sha256").update(readFileSync(join(repository, file))).digest("hex")}`).join("\n")).digest("hex");
const initialHarnessDigest = harnessDigest();
const harnessHead = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repository, encoding: "utf8" }).trim();
const version = /^ARG OMP_VERSION=(\S+)$/m.exec(readFileSync(join(source, "image/appliance/Containerfile"), "utf8"))?.[1];
assert.ok(version, "the pinned appliance OMP version is declared");

for (const path of ["home/.config/omp", "home/.omp/agent", "home/.cache", "omp-cwd"]) mkdirSync(join(root, path), { recursive: true });
const baseSha = seedRepos(root);
const batchId = "batch-1770a11";
for (const [key, name] of [["example/a#1", "a"], ["example/b#2", "b"]]) {
	const path = join(root, "state", "workspaces", batchId, createHash("sha256").update(key).digest("hex").slice(0, 16));
	mkdirSync(join(root, "state", "workspaces", batchId), { recursive: true });
	execFileSync("git", ["clone", "--quiet", "--no-checkout", join(root, "repos", `${name}.git`), path]);
	execFileSync("git", ["-C", path, "checkout", "--quiet", "--detach", baseSha]);
	execFileSync("git", ["-C", path, "remote", "set-url", "origin", `https://github.com/example/${name}`]);
}
const audit = [];
let child;

function executable(input) {
	if (input.includes("/")) return resolve(input);
	for (const directory of (process.env.PATH ?? "").split(":")) {
		const candidate = join(directory, input);
		try { accessSync(candidate, constants.X_OK); return candidate; } catch { /* continue PATH lookup */ }
	}
	throw new Error(`executable unavailable: ${input}`);
}

function messageText(message) {
	if (typeof message?.content === "string") return message.content;
	return Array.isArray(message?.content) ? message.content.filter((part) => part?.type === "text").map((part) => part.text).join("\n") : "";
}

function evidenceResult(message) {
	if (message.role !== "tool") return undefined;
	try {
		const value = JSON.parse(messageText(message));
		return typeof value?.id === "string" && /^evidence-\d+$/.test(value.id) ? value : undefined;
	} catch { return undefined; }
}

async function choose(body) {
	const messages = body.messages ?? [];
	const prompt = messages.filter((message) => message.role === "user").map(messageText).findLast((text) => /Current attempt: T1-a\d+/.test(text)) ?? "";
	assert.ok(prompt, "the provider request retains an admitted Factory attempt prompt");
	const attempt = /Current attempt: (T1-a\d+)/.exec(prompt)?.[1];
	const key = /Item: ([^\n]+)/.exec(prompt)?.[1];
	assert.ok(attempt && key, "native prompt binds the selected item and attempt");
	if (key === "example/b#2") assert.ok(existsSync(join(root, "pending-check-seen")), "the independent item starts only after the owned PR's pending CI observation");
	const worker = prompt.startsWith("Implement/inspect only the selected acceptance.");
	const calls = messages.flatMap((message) => message.tool_calls ?? []).map((call) => call.function);
	const writes = calls.filter((call) => call.name === "factory_write");
	const reports = calls.filter((call) => call.name === "factory_report");
	const evidence = messages.map(evidenceResult).filter(Boolean);
	const needsEvidence = !worker || key === "example/repo#1" && attempt === "T1-a2";
	if (needsEvidence) {
		const ids = [...new Set([...prompt.matchAll(/^- (evidence-\d+) \[attempt /gm)].map((match) => match[1]))];
		assert.ok(ids.length > 0, `${key} ${attempt} receives actual retained evidence handles`);
		for (const id of ids) {
			const previous = evidence.filter((entry) => entry.id === id).at(-1);
			if (!previous?.eof) return { key, attempt, phase: worker ? "worker" : "acceptance", name: "factory_evidence_read", args: { id, offset: previous?.nextOffset ?? 0, limit: 131072 } };
		}
		assert.doesNotMatch(messages.map(messageText).join("\n"), /\[Showing head and tail bytes/, "native evidence remains complete");
		if (worker && attempt === "T1-a2") assert.match(evidence.map((entry) => entry.text).join("\n"), /DISTINCTIVE_OWNED_PR_HOSTED_FAILURE/, "repair reads the complete scripted hosted failure packet");
	}
	if (worker && key === "example/repo#1" && attempt === "T1-a1" && writes.length === 0) {
		return { key, attempt, phase: "worker", name: "factory_write", args: { path: "value.txt", content: "1\n" } };
	}
	if (worker && key === "example/repo#1" && attempt === "T1-a2" && writes.length === 0) {
		return { key, attempt, phase: "worker", name: "factory_write", args: { path: "hosted-fix.txt", content: `${"repair\n"}DISTINCTIVE_OWNED_PR_HOSTED_FAILURE addressed\n` } };
	}
	if (reports.length === 0) {
		const independent = key === "example/b#2";
		return {
			key, attempt, phase: worker ? "worker" : "acceptance", name: "factory_report",
			args: {
				report: independent ? "No finding in the captured independent repository." : `Checked the selected acceptance for ${key} at ${attempt}.`,
				tests: [], accepted: true, semanticOutcome: independent && worker ? "no-finding" : "none",
				predicates: [{ item: independent ? "independent repository inspection" : "selected acceptance", ok: true, note: "scripted native session inspected the supplied subject/evidence" }], publicationBlocker: "",
			},
		};
	}
	return { key, attempt, phase: worker ? "worker" : "acceptance", content: "The scripted native session finished after its bounded report." };
}

const providerRequests = [];
let server;
let port;
const expectedVersion = version;
let binaryIdentity;

try {
	server = createServer(async (request, response) => {
		try {
			let raw = ""; for await (const chunk of request) { raw += chunk; assert.ok(raw.length < 4 * 1024 * 1024); }
			if (request.method === "GET") { response.setHeader("content-type", "application/json"); response.end(JSON.stringify({ data: [{ id: "deterministic" }] })); return; }
			const chosen = await choose(JSON.parse(raw));
			providerRequests.push({ key: chosen.key, attempt: chosen.attempt, phase: chosen.phase, tool: chosen.name ?? null, evidence: chosen.args?.id ?? null, offset: chosen.args?.offset ?? null });
			writeFileSync(join(root, "provider-audit.json"), JSON.stringify(providerRequests, null, 2));
			const base = { id: `owned-pr-${providerRequests.length}`, object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model: "deterministic" };
			const chunks = chosen.name ? [
				{ ...base, choices: [{ index: 0, delta: { role: "assistant", tool_calls: [{ index: 0, id: `call-${providerRequests.length}`, type: "function", function: { name: chosen.name, arguments: JSON.stringify(chosen.args) } }] } }] },
				{ ...base, choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] },
			] : [{ ...base, choices: [{ index: 0, delta: { role: "assistant", content: chosen.content }, finish_reason: "stop" }] }];
			response.writeHead(200, { "content-type": "text/event-stream" });
			for (const chunk of chunks) response.write(`data: ${JSON.stringify(chunk)}\n\n`);
			response.end("data: [DONE]\n\n");
		} catch (error) {
			providerRequests.push({ failure: error instanceof Error ? error.message : String(error) });
			writeFileSync(join(root, "provider-audit.json"), JSON.stringify(providerRequests, null, 2));
			response.writeHead(500); response.end(error instanceof Error ? error.message : String(error));
			if (child?.exitCode === null) child.kill("SIGTERM");
		}
	});
	server.listen(0, "127.0.0.1"); await once(server, "listening"); port = server.address().port;
	writeFileSync(join(root, "home/.config/omp/omp.yml"), readFileSync(join(repository, "tests/fixtures/luna-factory-omp-probe-config.yml")));
	writeFileSync(join(root, "home/.omp/agent/models.yml"), readFileSync(join(repository, "tests/fixtures/luna-factory-omp-probe-models.yml"), "utf8").replaceAll("43127", String(port)));
	mkdirSync(join(root, "home/.omp/profiles/bluefin-review-appliance/agent"), { recursive: true });
	writeFileSync(join(root, "home/.omp/profiles/bluefin-review-appliance/agent/models.yml"), readFileSync(join(root, "home/.omp/agent/models.yml")));

	const binary = packaged ? undefined : executable(process.env.OMP_BINARY ?? "omp");
	if (binary) {
		const observedVersion = execFileSync(binary, ["--version"], { encoding: "utf8" }).trim();
		assert.equal(observedVersion, `omp/${expectedVersion}`);
		binaryIdentity = { binary, version: observedVersion, sha256: execFileSync("sha256sum", [binary], { encoding: "utf8" }).split(/\s/)[0] };
	} else binaryIdentity = { expectedPackagedVersion: expectedVersion };
	const runtimeExtension = packaged ? "/proof/tests/fixtures/luna-factory-owned-pr-acceptance-runtime.ts" : join(repository, "tests/fixtures/luna-factory-owned-pr-acceptance-runtime.ts");
	const factoryExtension = packaged ? "/usr/share/bluefin/review/luna-factory" : join(source, "image/extension/luna-factory");
	const commonArgs = ["--mode", "rpc", "--no-ui", "--no-skills", "--no-rules", "--no-extensions", "--no-pty", "--config", join(root, "home/.config/omp/omp.yml"), "--model", "local-probe/deterministic", "--extension", factoryExtension, "--extension", runtimeExtension];
	const env = {
		PATH: packaged ? "/usr/bin:/bin" : process.env.PATH ?? "", HOME: join(root, "home"), XDG_CONFIG_HOME: join(root, "home/.config"), XDG_CACHE_HOME: join(root, "home/.cache"), XDG_STATE_HOME: join(root, "state"),
		OWNED_PR_ROOT: root, LUNA_FACTORY_ENABLED: "1", LUNA_FACTORY_CAPACITY: "1", LUNA_FACTORY_STATE_ROOT: join(root, "state"), LUNA_FACTORY_CLAIMS_ROOT: join(root, "claims"),
		REVIEW_DEFAULT_SCOPE: "example/a", REVIEW_TEST_SOURCE: packaged ? "/proof" : source,
		REVIEW_TEST_FACTORY_ROOT: packaged ? "/usr/share/bluefin/review/luna-factory" : join(source, "image/extension/luna-factory"),
		OWNED_PR_RUNTIME_KIND: packaged ? "packaged-oci" : "upstream-native",
	};
	let command = binary; let args = commonArgs;
	if (packaged) {
		const image = process.env.REVIEW_APPLIANCE_IMAGE; assert.ok(image, "REVIEW_APPLIANCE_IMAGE is required for packaged OCI qualification");
		const identity = JSON.parse(execFileSync("podman", ["image", "inspect", image], { encoding: "utf8" }))[0];
		assert.equal(identity.Config.Labels["org.opencontainers.image.revision"], sourceHead, "packaged qualification requires an image at the exact source commit");
		assert.equal(identity.Config.Labels["io.github.joshyorko.review.omp.version"], expectedVersion, "packaged OMP pin must match this checkout");
		assert.equal(productionDiff.length, 0, "packaged qualification requires clean exact production source");
		writeFileSync(join(root, "image-identity.json"), JSON.stringify({ image, id: identity.Id, digest: identity.Digest, sourceHead, expectedVersion }, null, 2));
		command = "podman";
		args = ["run", "--rm", "--network=host", "--userns=keep-id:uid=65532,gid=65532", "--volume", `${repository}:/proof:ro,z`, "--volume", `${root}:/evidence:rw,z`, "--volume", `${join(root, "home")}:/home/bluefin:rw,z`, "--env", "HOME=/evidence/home", "--env", "XDG_CONFIG_HOME=/evidence/home/.config", "--env", "XDG_CACHE_HOME=/evidence/home/.cache", "--env", "XDG_STATE_HOME=/evidence/state", "--env", "OWNED_PR_ROOT=/evidence", "--env", "OWNED_PR_RUNTIME_KIND=packaged-oci", "--env", "LUNA_FACTORY_ENABLED=1", "--env", "LUNA_FACTORY_CAPACITY=1", "--env", "LUNA_FACTORY_STATE_ROOT=/evidence/state", "--env", "LUNA_FACTORY_CLAIMS_ROOT=/evidence/claims", "--env", "REVIEW_DEFAULT_SCOPE=example/a", "--env", "REVIEW_TEST_FACTORY_ROOT=/usr/share/bluefin/review/luna-factory", "--env", "PATH=/usr/bin:/bin", "--entrypoint", "/usr/bin/omp", identity.Id, ...commonArgs.map((arg) => arg.replaceAll(join(root, "home/.config/omp/omp.yml"), "/evidence/home/.config/omp/omp.yml").replaceAll(join(repository, "tests/fixtures/luna-factory-owned-pr-acceptance-runtime.ts"), "/proof/tests/fixtures/luna-factory-owned-pr-acceptance-runtime.ts"))];
		const entry = args.indexOf("--entrypoint"); args.splice(entry, 2);
	}
	writeFileSync(join(root, "runtime-identity.json"), JSON.stringify({ mode, sourceHead, sourceDirty: productionDiff.length !== 0, productionDiffDigest, harnessHead, harnessDigest: initialHarnessDigest, ...binaryIdentity }, null, 2));
	const output = createWriteStream(join(root, `${mode}-owned-pr.log`));
	child = spawn(command, args, { cwd: join(root, "omp-cwd"), env, stdio: ["pipe", "pipe", "pipe"] });
	child.stdout.pipe(output); child.stderr.pipe(output);
	let forced;
	const timeout = setTimeout(() => { child.kill("SIGTERM"); forced = setTimeout(() => child.kill("SIGKILL"), 5_000); }, 180_000);
	const [code] = await once(child, "exit"); clearTimeout(timeout); clearTimeout(forced); child.stdin.end(); output.end();
	assert.equal(code, 0, "owned-PR OMP scenario failed; inspect retained runtime log, provider audit, and result.json");
	const result = JSON.parse(readFileSync(join(root, "result.json"), "utf8")); assert.equal(result.status, "passed");
	assert.equal(execFileSync("git", ["rev-parse", "HEAD"], { cwd: source, encoding: "utf8" }).trim(), sourceHead, "production source HEAD stayed fixed during qualification");
	assert.equal(createHash("sha256").update(execFileSync("git", ["diff", "--binary", "HEAD", "--", "image/extension/luna-factory"], { cwd: source })).digest("hex"), productionDiffDigest, "production source stayed fixed during qualification");
	assert.equal(harnessDigest(), initialHarnessDigest, "qualification harness stayed fixed while running");
	assert.equal(result.operatorFollowups, 0); assert.equal(result.prCreates, 1); assert.equal(result.mergeRequests, 0);
	writeFileSync(join(root, "driver-result.json"), JSON.stringify({ ...result, mode, runtimeIdentity: binaryIdentity, sourceHead, sourceDirty: productionDiff.length !== 0, productionDiffDigest, harnessHead, harnessDigest: initialHarnessDigest, scriptedGitHub: true, liveGitHub: false, packageRuntimeExecuted: packaged }, null, 2));
	console.log(JSON.stringify({ status: result.status, mode, outcome: result.scenario, hostedPolls: result.hostedPolls, attempts: result.attempts, operatorFollowups: result.operatorFollowups, packageRuntimeExecuted: packaged }));
} catch (error) {
	const reason = error instanceof Error ? error.message : String(error);
	writeFileSync(join(root, "driver-result.json"), JSON.stringify({ status: "blocked-or-failed", mode, sourceHead, reason, evidence: root, liveGitHub: false }, null, 2));
	throw error;
} finally {
	if (child?.exitCode === null) child.kill("SIGTERM");
	server?.close();
}
