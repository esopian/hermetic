# hermetic

hermetic manages a fleet of Hermes agents on AWS. Every agent is sealed — no public ports, all access over Tailscale, every secret behind an IAM boundary — and the tooling makes the sealed path the easy path. Instances are disposable; the EBS data volume each agent learns on is precious and outlives the instance.

**Status:** pre-alpha.

## Install

hermetic is a desktop app with a bundled CLI. It runs on macOS and Linux; only Apple silicon Macs have a prebuilt installer so far.

| Platform | How |
|---|---|
| macOS, Apple silicon | Prebuilt app — see [macOS](#macos) below. |
| Linux | Run from source — see [Linux and Intel Macs](#linux-and-intel-macs) below. No packaged build yet. |
| Windows | Not natively. WSL2 takes the Linux path and should work, but is untested. |
| macOS, Intel | Run from source — same steps as Linux. No packaged build yet. |

### macOS

Download `macos-arm64-Hermetic.dmg` from the [latest release](https://github.com/esopian/hermetic/releases/latest), open it, and drag `Hermetic.app` into `/Applications`.

- **Signed and notarised.** Releases from v0.3.1 on are signed with a Developer ID and notarised by Apple, so the app opens normally. v0.3.0 and earlier were ad-hoc signed only: macOS calls them "damaged" and offers only "Move to Trash" until the quarantine flag is cleared with `xattr -dr com.apple.quarantine /Applications/Hermetic.app`.
- **It updates itself** from the same release page — the app checks on launch and every six hours, downloads a patch when the gap is one release and the whole archive otherwise, and applies it on the next restart. You never download a second DMG. The check is unauthenticated, so it only works once `esopian/hermetic` is a public repository; while the repository is private, update yourself by downloading the newer DMG.
- **The `hermetic` CLI comes from the app.** There is no separate download: the app bundles the binary and its menu's **Install Command Line Tool…** item writes a shim at `/usr/local/bin/hermetic` pointing at it. Run it once and `hermetic` is on your PATH, kept current by the app's own updates.

### Linux and Intel Macs

The app and CLI run on Linux and Intel Macs from a checkout; there is just no package yet. You need [Bun](https://bun.sh) (the version in `.bun-version`) and `git`:

```
git clone https://github.com/esopian/hermetic.git && cd hermetic
bun run setup          # installs dependencies and the pinned Hutch, which builds the desktop app
bun run dev            # builds and opens the app
bun run cli -- --help  # the hermetic CLI, from the same checkout
```

`bun run setup` reports a missing `uvx` as a failure; that only matters for `bun run check`, not for running the app. A source run does not update itself: `git pull` and rerun `bun run dev`. [CONTRIBUTING.md](CONTRIBUTING.md) has the details.

## Quick start

1. Open `Hermetic.app` (from source, `bun run dev`). A home that has never run `init` opens the init wizard; an initialized one opens the dashboard.
2. Work through the wizard: pick an AWS profile, pass the connection check, create or attach to the foundation, watch it run.
3. Create your first agent from the dashboard (or `hermetic agent create <name>` once the CLI shim is installed).

On macOS nothing here needs Bun or a checkout — that is only for working on hermetic itself, or for running it on Linux or an Intel Mac.

## Prerequisites

Only real mode needs these; the fixture backend needs no AWS at all.

- An AWS profile in `~/.aws/config` for the account you want to target.
- The Tailscale CLI and a Tailscale OAuth client — see [`docs/operations.md`'s Prerequisites section](docs/operations.md#prerequisites) for the exact scopes and the one manual policy-file line it requires.
- Every operator, not just whoever ran the first `init --create`, needs IAM grants on the account-global fleet directory table in the directory region (`docs/design.md` §4.8) — without them, `init` (including a plain re-attach) stops at `DIRECTORY_UNAVAILABLE` before it gets far enough to say which fleet you were trying to join.

## The CLI in brief

```
hermetic agent ps                        # fleet table for the current fleet
hermetic --fixture agent ps              # the seeded fixture fleet, no AWS
hermetic agent ps --json | jq .          # --json is stdout-only; use it for scripts
hermetic --help                          # full command list, grouped as in docs/design.md §9
hermetic --version                       # print the CLI's own version
hermetic help exit-codes                 # every ErrorCode -> exit code mapping
```

`--fixture` (either side of the subcommand) and `HERMETIC_FIXTURE=1` are equivalent.

## Real AWS

`hermetic init` (CLI, or the app's init wizard on first launch) targets a real account:

- Picks or verifies an AWS profile from `~/.aws/config` and freezes the account via STS.
- Prompts for a Tailscale OAuth client secret — created by hand in the Tailscale admin console (there's no API to create one), scoped to `auth_keys` **write** and `devices:core` **read + write**, both restricted to tag `tag:hermetic`, plus `policy_file`. The first mints each agent's join key; the second lets `doctor` check device drift and lets `recreate`/`destroy` delete an agent's old device; the third lets hermetic keep its own entries in your tailnet policy file current. `init` pushes the secret to SSM and writes those entries itself — between `// hermetic:managed` markers, with every other byte of your policy returned unchanged; `hermetic policy` shows the state and `hermetic plan policy` the diff, and `--skip-policy` leaves the file alone if you deploy it from git. You still paste the one `tagOwners` line by hand first, because the OAuth client form only offers tags that already have an owner. Tailscale cannot add a scope to an existing client, so widening an older client means creating a new one and rotating: `hermetic secrets push _fleet --tailscale-oauth`.
- Also requires HTTPS Certificates enabled for the tailnet (admin console → DNS settings) — every agent is served over `https://<name>.<tailnet>.ts.net`, and `init --create` refuses without it.
- If no foundation exists, creates the one-time `hermetic` CloudFormation stack; if one exists, attaches to it instead.

What gets created: the `hermetic` CloudFormation stack, two DynamoDB tables (agents, events), an S3 bucket (hermeticd binaries + rendered config), and an SSM parameter slot per agent for its Tailscale auth key.

From there, `hermetic agent create`, `agent rerun`, `upgrade`, and `destroy` operate against that frozen account; every call re-verifies STS before touching AWS.

Tearing the foundation back down (destroy every agent first) is `hermetic plan teardown` to preview, then:

```
hermetic teardown --yes --confirm-account-id 123456789012 \
  [--no-purge] [--delete-snapshots] [--delete-volumes] [--no-reset-local]
```

The twelve-digit account id is a required typed confirmation, not `--yes` alone. From the dashboard, the same flow lives in Settings (`,` shortcut, or the header's `SETTINGS →` button) under **DANGER** — review the plan, type the account id and the word `teardown`, watch it run. Details: [`docs/operations.md`](docs/operations.md#teardown).

## Roadmap

Planned, not yet built. Contributions are welcome; open an issue to discuss an approach first.

- **Windows support** for the desktop client and the CLI ([#128](https://github.com/esopian/hermetic/issues/128)).
- **Automatic builds for Linux, Intel Macs and Windows**, published with each release alongside the Apple silicon app ([#128](https://github.com/esopian/hermetic/issues/128)).
- **Cloud providers beyond AWS**, by moving the AWS-specific code behind a provider adapter ([#129](https://github.com/esopian/hermetic/issues/129)).
- **A self-hosted Headscale controller** as an alternative to Tailscale's hosted control plane for the tailnet ([#130](https://github.com/esopian/hermetic/issues/130)).

## Developing

Working on hermetic needs a checkout, [Bun](https://bun.sh) pinned in `.bun-version`, [`uv`/`uvx`](https://docs.astral.sh/uv/) for the lint steps, and [Hutch](https://hutch.blackboard.sh) pinned in `.hutch-version` for the desktop app:

```
bun run setup            # check the toolchain, fix what is safely fixable: deps, Hutch, the Electrobun devkit
bun run check            # typecheck + test + boundaries + lint
bun run dev              # the app in real mode: wizard if uninitialized, dashboard if not
bun run dev:fixture      # seeded fixture fleet, no AWS — for UI work and demos
bun run dev:wizard       # fixture backend, forced init wizard
bun run cli -- agent ps --fixture        # the CLI from source
```

`dev:fixture` and `dev:wizard` both use the in-memory fixture backend (no AWS; run log and inbox persist in a separate `hermetic-fixture.db`) via `HERMETIC_FIXTURE=1`; `dev:wizard` additionally forces the wizard path with `HERMETIC_UNINIT=1` so you can develop `init` without a real account.

Full setup, the CI layout and the commit conventions are in [`CONTRIBUTING.md`](CONTRIBUTING.md).

## Building binaries

```
bun run app:build        # the macOS app, stable channel, into packages/app/artifacts/
bun run app:build:canary # the canary channel — proves the app builds, ships nothing
bun run build            # hermetic (CLI) + hermeticd, into dist/
bun run build:host       # the CLI for this machine only, into dist/
bun run build:all        # cross-compiled CLI binaries for every target, into dist/<target>/
```

`bun run app:build` produces `macos-arm64-Hermetic.dmg`, `stable-macos-arm64-Hermetic.app.tar.zst` and the channel's update manifest, `stable-macos-arm64-update.json`. Its pre-build hook (`scripts/app-stage.ts`) stages the sidecars the bundle carries: the `hermetic` CLI, `hermeticd` with both version stamps, and `stages/`, under `Hermetic.app/Contents/Resources/app/bin/`. `hermeticd` is always `linux-arm64` — the fleet agent runs on the box, never on the laptop.

## Repo map

| Package | What it is |
|---|---|
| `packages/core` | The SDK: all logic, all AWS, SQLite, DynamoDB. Zod schemas are the source of truth. |
| `packages/cli` | Commander head. Imports core in-process. |
| `packages/app` | Electrobun head: the desktop app's main process, RPC over the Electrobun bridge, and the bundle the page ships in. |
| `packages/ui` | React, browser-only, runs in the app's webview and talks to the main process over typed RPC. |
| `packages/agentd` | `hermeticd`, the node agent that runs on each instance. |

## Docs

- [`docs/design.md`](docs/design.md) — the authoritative spec for behavior.
- [`docs/architecture.md`](docs/architecture.md) — the runtime picture: heads, core, backends, create sequence, agentd's loop.
- [`docs/operations.md`](docs/operations.md) — runbook for a first real fleet.
- [`docs/ui-brief.md`](docs/ui-brief.md) — visual/style brief for the dashboard.
- [`CONTRIBUTING.md`](CONTRIBUTING.md) — dev loop, commit conventions, how to add a command.
- [`AGENTS.md`](AGENTS.md) — rules and conventions for coding agents working in this repo.
- [`site/`](site/) — marketing + docs site (own toolchain, see `site/README.md`).

## Safety model

One hermetic home is frozen to one AWS account, verified against STS on every call — `ACCOUNT_MISMATCH` and `FLEET_MISMATCH` are build errors, not bad afternoons. Zero inbound network rules on every agent, ever; access is over Tailscale only. Secrets are never logged, echoed, or written to disk on the laptop — hermetic owns the *existence* of a secret slot, never the value. Destructive operations require a plan first, then a typed confirmation.

## License

MIT — see [`LICENSE`](LICENSE).
