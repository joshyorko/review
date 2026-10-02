import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const selected = [
	{ key: "example/a#1", repo: "example/a", number: 1, kind: "issue", action: "patch", overlaps: [], requiredChecks: ["bash ./tests/acceptance.sh"], targetRef: "main" },
	{ key: "example/b#1", repo: "example/b", number: 1, kind: "issue", action: "patch", overlaps: [], requiredChecks: ["bash ./tests/acceptance.sh"], targetRef: "main" },
	{ key: "example/a#2", repo: "example/a", number: 2, kind: "issue", action: "patch", overlaps: [], requiredChecks: ["bash ./tests/acceptance.sh"], targetRef: "main" },
	{ key: "example/observed#1", repo: "example/observed", number: 1, kind: "pr", action: "inspect", overlaps: [], observe: "merged-upstream" },
];

export function seedRepos(root) {
	const seed = join(root, "seed");
	mkdirSync(join(seed, "tests"), { recursive: true });
	writeFileSync(join(seed, "value.txt"), "0\n");
	writeFileSync(join(seed, "tests/acceptance.sh"), '#!/usr/bin/env bash\nset -euo pipefail\ntest "$(cat value.txt)" = 1\n');
	execFileSync("git", ["init", "-q", "--initial-branch=main", seed]);
	execFileSync("git", ["-c", "user.name=Graph fixture", "-c", "user.email=fixture@localhost", "add", "."], { cwd: seed });
	execFileSync("git", ["-c", "user.name=Graph fixture", "-c", "user.email=fixture@localhost", "commit", "-qm", "captured graph subject"], { cwd: seed });
	const sha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: seed, encoding: "utf8" }).trim();
	for (const name of ["a", "b", "observed"]) {
		const bare = join(root, "repos", `${name}.git`);
		mkdirSync(join(root, "repos"), { recursive: true });
		execFileSync("git", ["clone", "--quiet", "--bare", seed, bare]);
	}
	return sha;
}

export function installGhShim(root) {
	const directory = join(root, "shim"); mkdirSync(directory, { recursive: true });
	const shim = join(directory, "gh");
	const rootLiteral = `'${root.replaceAll("'", "'\\''")}'`;
	writeFileSync(shim, `#!/usr/bin/env bash\nset -euo pipefail\n[[ "$1 $2" == "repo clone" ]] || { echo "unsupported fixture gh command" >&2; exit 2; }\nrepo="$3"; destination="$4"\nfixture_root=${rootLiteral}\nname="\${repo##*/}"\ngit clone --quiet --no-checkout "$fixture_root/repos/$name.git" "$destination"\ngit -C "$destination" remote set-url origin "https://github.com/$repo"\n`, { mode: 0o755 });
	return directory;
}
