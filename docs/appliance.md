# Review appliance

The appliance packages the GitHub-generic OMP Review workbench and Luna Factory. It accepts repositories (`owner/repo`) and organizations (`org:<name>`); it has no implicit organization scope.

```bash
just review-appliance acme/widgets
# Source checkout, without the appliance:
bin/omp-review org:acme
```

The rootless launcher prefers Podman with `krun` and KVM, then reports missing prerequisites and falls back to isolated Apptainer. Runs stay in the foreground. `Ctrl-C` stops only the active invocation.

## Scope, mode, and authentication

A fresh interactive session without an explicit, restored, or configured scope asks for one. Headless callers must pass `owner/repo` or `org:<name>`. `REVIEW_DEFAULT_SCOPE` supplies an explicit generic default; the launcher does not infer an organization from this fork, the GitHub login, or image metadata.

GitHub credentials come from `gh auth token` or inherited `GH_TOKEN`/`GITHUB_TOKEN` and supported OMP provider credentials. GitHub remains the authority for repository access, reviews, workflow changes, and landing. Review never elevates token permissions.

Review defaults to GitHub-only mode. It makes no Hive request and does not search `~/.config/hive` for contributor registration. Existing users may explicitly set `REVIEW_MODE=hive` and `HIVE_HUB` to opt into the optional read-side integration. That integration supplies context only; it does not assign or complete contributor work. The old Hive contributor image and launcher are not part of this product.

Luna Factory is packaged beside Review. Loading it starts no work; execution requires `LUNA_FACTORY_ENABLED=1`. Factory retains its own admission, claims, evidence, and durable state boundaries.

## Isolation and state

The appliance uses its own OMP profile; host `.omp` configuration and MCP servers are not inherited by default. Set `REVIEW_INHERIT_OMP_CONFIG=1` only when intentionally using the host `review` profile. Provider credentials remain environment inputs and are not copied into image layers or command arguments.

Persistent OMP state lives under the appliance-owned home (`/home/bluefin`, a retained compatibility path). Workspace and `/tmp` are separate target-specific directories, so simultaneous targets do not share mutable checkouts. `BLUEFIN_INSTANCE` remains a compatibility override for separating sessions with the same target.

## Image and personal package

The image derives from a digest-pinned FSDK base, verifies fetched OMP and GitHub CLI artifacts against per-architecture SHA-256 pins, and includes the Review and Luna Factory extensions. The TypeSafe OMP loader is optional; Review starts without a TypeSafe key. Audio is included for OMP voice support when the host exposes a supported PulseAudio socket or `/dev/snd`.

Current source and SBOM provenance identify [`joshyorko/review`](https://github.com/joshyorko/review). The personal Homebrew workflow builds an immutable OCI image and matching native SIF from the selected committed ref on `self-hosted`, then publishes the package to `joshyorko/homebrew-review-dev`.

The existing `bluefin-review-dev` formula, `bluefin review` command, `/home/bluefin` paths, and `ghcr.io/projectbluefin/review` image are retained compatibility artifacts. They are not the source of product scope or policy. Prefer `bin/omp-review` in a source checkout; use the packaged `bluefin review` command only as the existing install alias.

The image is immutable: pull a newer artifact to update it. `omp update` is disabled inside the appliance.
