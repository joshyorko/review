import assert from "node:assert/strict";
import { chmodSync, cpSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync, spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const fixtureDir = dirname(fileURLToPath(import.meta.url));
const repository = resolve(fixtureDir, "../..");
const helper = join(fixtureDir, "luna-factory-graph-krun-host-provider.sh");
const imageId = "a".repeat(64);
const imageDigest = `sha256:${"b".repeat(64)}`;
const ompSha = "d".repeat(64);

function setup() {
	const temp = mkdtempSync(join(tmpdir(), "graph-krun-transport-test-"));
	const source = join(temp, "source");
	const root = join(temp, "evidence");
	const home = join(root, "home");
	const fakeBin = join(temp, "bin");
	const capture = join(temp, "podman-argv.jsonl");
	const inspect = join(temp, "image-inspect.json");
	mkdirSync(join(source, "image/appliance"), { recursive: true });
	writeFileSync(join(source, "image/appliance/Containerfile"), "ARG OMP_VERSION=1.2.3\n");
	cpSync(join(repository, "image/extension/luna-factory"), join(source, "image/extension/luna-factory"), { recursive: true });
	execFileSync("git", ["init", "-q", "--initial-branch=main", source]);
	execFileSync("git", ["-c", "user.name=Graph fixture", "-c", "user.email=fixture@localhost", "add", "."], { cwd: source });
	execFileSync("git", ["-c", "user.name=Graph fixture", "-c", "user.email=fixture@localhost", "commit", "-qm", "synthetic transport source"], { cwd: source });
	const sourceSha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: source, encoding: "utf8" }).trim();
	mkdirSync(join(home, ".config/omp"), { recursive: true });
	mkdirSync(join(home, ".omp/agent"), { recursive: true });
	mkdirSync(join(home, ".omp/profiles/bluefin-review-appliance/agent"), { recursive: true });
	writeFileSync(join(home, ".config/omp/omp.yml"), ["modelRoles:", "  default: local-probe/deterministic", "  task: local-probe/deterministic", "  smol: local-probe/deterministic", "  tiny: local-probe/deterministic", "  advisor: local-probe/deterministic", "task:", "  agentModelOverrides:", "    task: local-probe/deterministic", ""].join("\n"));
	const modelConfig = ["providers:", "  local-probe:", "    baseUrl: http://127.0.0.1:43127/v1", "    apiKey: luna-factory-probe", "    models:", "      - id: deterministic", ""].join("\n");
	writeFileSync(join(home, ".omp/agent/models.yml"), modelConfig);
	writeFileSync(join(home, ".omp/profiles/bluefin-review-appliance/agent/models.yml"), modelConfig);
	mkdirSync(join(root, "claims"), { recursive: true });
	const expires = Math.floor(Date.now() / 1000) + 600;
	const grant = join(temp, "root-slot-grant.txt");
	writeFileSync(grant, `source=${imageId}\nimage-digest=${imageDigest}\nroot-review=1\nshared-slot=1\nexpires-epoch=${expires}\n`);
	chmodSync(grant, 0o400);
	mkdirSync(fakeBin, { recursive: true });
	const fakePodman = join(fakeBin, "podman");
	writeFileSync(fakePodman, `#!/usr/bin/env node\nconst fs = require("node:fs");\nconst args = process.argv.slice(2);\nfs.appendFileSync(process.env.GRAPH130_TEST_PODMAN_CAPTURE, JSON.stringify(args) + "\\n");\nif (args[0] === "image" && args[1] === "inspect") process.stdout.write(fs.readFileSync(process.env.GRAPH130_TEST_IMAGE_INSPECT, "utf8"));\nelse if (args[0] === "run" && args.includes("--version")) process.stdout.write("omp/1.2.3\\n");\n`);
	chmodSync(fakePodman, 0o755);
	const inspection = [{ Id: imageId, Digest: imageDigest, Config: { User: "65532:65532", Labels: { "org.opencontainers.image.revision": sourceSha, "io.github.joshyorko.review.omp.version": "1.2.3" } } }];
	writeFileSync(inspect, JSON.stringify(inspection));
	const env = {
		PATH: `${fakeBin}:${process.env.PATH}`,
		HOME: home,
		XDG_CONFIG_HOME: join(home, ".config"),
		XDG_CACHE_HOME: join(home, ".cache"),
		XDG_STATE_HOME: join(home, ".local/state"),
		GRAPH130_ROOT: root,
		GRAPH130_TEST_PODMAN_CAPTURE: capture,
		GRAPH130_TEST_IMAGE_INSPECT: inspect,
		REVIEW_TEST_SOURCE: source,
		REVIEW_TEST_HARNESS_ROOT: repository,
		REVIEW_TEST_FACTORY_ROOT: join(source, "image/extension/luna-factory"),
		REVIEW_TEST_KRUN_IMAGE_ID: imageId,
		REVIEW_TEST_KRUN_IMAGE_DIGEST: imageDigest,
		REVIEW_TEST_KRUN_OMP_SHA256: ompSha,
		REVIEW_TEST_KRUN_GRANT_FILE: grant,
		REVIEW_TEST_KRUN_ROOT_REVIEWED: "1",
		REVIEW_TEST_KRUN_SLOT_GRANTED: "1",
		REVIEW_TEST_KRUN_SLOT_EXPIRES_EPOCH: String(expires),
		LUNA_FACTORY_ENABLED: "1",
		LUNA_FACTORY_CAPACITY: "2",
		LUNA_FACTORY_STATE_ROOT: join(root, "state"),
		LUNA_FACTORY_CLAIMS_ROOT: join(root, "claims"),
		REVIEW_DEFAULT_SCOPE: "example/a",
	};
	const args = ["--mode", "rpc", "--no-ui", "--no-skills", "--no-rules", "--no-extensions", "--no-pty", "--config", join(home, ".config/omp/omp.yml"), "--model", "local-probe/deterministic", "--extension", join(source, "image/extension/luna-factory"), "--extension", join(repository, "tests/fixtures/luna-factory-graph-acceptance-runtime.ts")];
	return { temp, source, root, home, grant, capture, inspect, env, args };
}

function invoke(fixture, args = fixture.args, extraEnv = {}) {
	return spawnSync("bash", [helper, ...args], { encoding: "utf8", env: { ...fixture.env, ...extraEnv } });
}

function calls(fixture) {
	if (!existsSync(fixture.capture)) return [];
	return readFileSync(fixture.capture, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

test("krun host transport sends the unchanged fixture route through host networking", (t) => {
	const f = setup(); t.after(() => rmSync(f.temp, { recursive: true, force: true }));
	const version = invoke(f, ["--version"]);
	assert.equal(version.status, 0, version.stderr);
	assert.equal(version.stdout.trim(), "omp/1.2.3");
	const run = calls(f).find((argv) => argv[0] === "run");
	assert.ok(run, "the fake Podman received a run plan");
	assert.ok(run.includes("--network=host"));
	assert.ok(run.includes("--runtime=krun"));
	assert.ok(run.includes(`--userns=keep-id:uid=65532,gid=65532`));
	assert.ok(run.includes(`--user=65532:65532`));
	assert.ok(run.some((arg) => arg.startsWith(`${f.source}:${f.source}:ro`)), "the read-only source mount is derived from the supplied checkout");
	assert.ok(run.some((arg) => arg.startsWith(`${repository}:${repository}:ro`)), "a distinct harness checkout is mounted read-only for the graph runtime extension");
	assert.ok(run.some((arg) => arg.includes("/tmp/graph130-root-slot-grant.txt:ro")));
	const runtime = invoke(f, f.args, { GH_TOKEN: "captured-fixture-token" });
	assert.equal(runtime.status, 0, runtime.stderr);
	const runtimeRun = calls(f).filter((argv) => argv[0] === "run").at(-1);
	assert.ok(runtimeRun.some((arg) => arg.includes("/usr/bin/bluefin-review-appliance")), "runtime enters the packaged production entrypoint");
	assert.ok(runtimeRun.includes("--env") && runtimeRun.includes("GH_TOKEN"), "only the fixture token environment name crosses into the guest");
	assert.ok(!runtimeRun.includes("captured-fixture-token"), "the fixture credential value never enters argv");
	assert.ok(runtimeRun.includes(`--extension`));
	assert.ok(runtimeRun.includes(join(repository, "tests/fixtures/luna-factory-graph-acceptance-runtime.ts")), "the production entrypoint receives the exact path from the mounted harness checkout");
	const canonical = setup(); t.after(() => rmSync(canonical.temp, { recursive: true, force: true }));
	const canonicalVersion = invoke(canonical, ["--version"], { REVIEW_TEST_KRUN_IMAGE_ID: `sha256:${imageId}` });
	assert.equal(canonicalVersion.status, 0, canonicalVersion.stderr);
	assert.equal(canonicalVersion.stdout.trim(), "omp/1.2.3");
});

test("krun host transport rejects a foreign runtime extension with a familiar suffix", (t) => {
	const f = setup(); t.after(() => rmSync(f.temp, { recursive: true, force: true }));
	const foreign = join(f.temp, "foreign/tests/fixtures/luna-factory-graph-acceptance-runtime.ts");
	mkdirSync(dirname(foreign), { recursive: true });
	writeFileSync(foreign, "foreign extension\n");
	const args = [...f.args]; args[args.length - 1] = foreign;
	const result = invoke(f, args, { GH_TOKEN: "captured-fixture-token" });
	assert.equal(result.status, 78);
	assert.match(result.stderr, /harness.*runtime|runtime.*harness/i);
	assert.equal(calls(f).filter((argv) => argv[0] === "run").length, 0);
});

test("krun host transport refuses an unrecognized OMP argv before run", (t) => {
	const f = setup(); t.after(() => rmSync(f.temp, { recursive: true, force: true }));
	const result = invoke(f, ["--mode", "rpc", "--model", "unrecognized/model"]);
	assert.equal(result.status, 78);
	assert.match(result.stderr, /unrecognized OMP argv/);
	assert.equal(calls(f).filter((argv) => argv[0] === "run").length, 0);
});

test("krun host transport rejects stale grants and image identity mismatches before run", (t) => {
	const stale = setup(); t.after(() => rmSync(stale.temp, { recursive: true, force: true }));
	const staleResult = invoke(stale, stale.args, { REVIEW_TEST_KRUN_SLOT_EXPIRES_EPOCH: "1" });
	assert.equal(staleResult.status, 78);
	assert.match(staleResult.stderr, /grant|slot/i);
	assert.equal(calls(stale).length, 0);

	const identity = setup(); t.after(() => rmSync(identity.temp, { recursive: true, force: true }));
	writeFileSync(identity.inspect, JSON.stringify([{ Id: "e".repeat(64), Digest: imageDigest, Config: { User: "65532:65532", Labels: { "org.opencontainers.image.revision": "wrong", "io.github.joshyorko.review.omp.version": "1.2.3" } } }]));
	const identityResult = invoke(identity, ["--version"]);
	assert.equal(identityResult.status, 78);
	assert.match(identityResult.stderr, /image identity/i);
	assert.equal(calls(identity).filter((argv) => argv[0] === "run").length, 0);
});

test("krun host transport rejects tags and malformed image IDs before Podman", (t) => {
	for (const badImageId of ["review:latest", "sha256:abc", `sha256:${"a".repeat(64)}:latest`]) {
		const f = setup(); t.after(() => rmSync(f.temp, { recursive: true, force: true }));
		const result = invoke(f, ["--version"], { REVIEW_TEST_KRUN_IMAGE_ID: badImageId });
		assert.equal(result.status, 78);
		assert.match(result.stderr, /immutable local OCI image ID/);
		assert.equal(calls(f).length, 0);
	}
});

test("krun host transport rejects fixture route drift and real credential names", (t) => {
	const route = setup(); t.after(() => rmSync(route.temp, { recursive: true, force: true }));
	writeFileSync(join(route.home, ".omp/agent/models.yml"), "providers:\n  local-probe:\n    baseUrl: http://example.invalid/v1\n");
	const routeResult = invoke(route, ["--version"]);
	assert.equal(routeResult.status, 78);
	assert.match(routeResult.stderr, /fixture.*endpoint|provider endpoint/i);
	assert.equal(calls(route).length, 0);

	const credential = setup(); t.after(() => rmSync(credential.temp, { recursive: true, force: true }));
	const credentialResult = invoke(credential, credential.args, { GH_TOKEN: "captured-fixture-token", GITHUB_TOKEN: "synthetic-forbidden-value" });
	assert.equal(credentialResult.status, 78);
	assert.match(credentialResult.stderr, /credential/i);
	assert.equal(calls(credential).filter((argv) => argv[0] === "run").length, 0);
});
