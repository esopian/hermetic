# Contributing

No AWS account is needed to contribute: the whole test suite, `bun run check`, `bun run ci` and CI
itself run offline against mocks and the in-memory fixture backend, and `bun run dev:fixture` runs
the app against a fake fleet. An AWS account (and Tailscale) only matter for real mode.

## Prerequisites

- [Bun](https://bun.sh), pinned in `.bun-version` — install a matching version.
- [`uv`/`uvx`](https://docs.astral.sh/uv/) — needed by `bun run lint:cfn` and `lint:sh`, and so by `bun run check`/`bun run ci`.
- An AWS profile in `~/.aws/config` for the account you want to target (only needed for real mode — `bun run dev:fixture` needs no AWS at all).
- The Tailscale CLI and a Tailscale OAuth client, for real mode — see [`docs/operations.md`'s Prerequisites section](docs/operations.md#prerequisites) for the exact scopes.
- [Hutch](https://hutch.blackboard.sh), pinned in `.hutch-version` (0.26.0) — it builds and runs the
  desktop app. Install the pinned version without touching your shell profile:

  ```
  curl -fsSL https://hutch.blackboard.sh/hutch/install.sh | sh -s -- --version "$(cat .hutch-version)" --no-modify-path
  ```

  Then add `~/.hutch/bin` to your PATH and run `bun run app:prepare` once per machine (it is
  `hutch electrobun prepare` in `packages/app`). That projects the Electrobun devkit into
  `packages/app/.hutch/devkit`, a few hundred megabytes fetched on first run, and it is where the
  app's types resolve from: `scripts/typecheck.ts` refuses to run without it.
- The first `bun run build` downloads a linux-arm64 Bun runtime to compile `hermeticd`; expect that one-time fetch.

## Setup

```
bun run setup            # check the toolchain, fix what is safely fixable
bun run setup:check      # report only, change nothing, exit 1 if anything is off
bun run setup -- --full  # also warm the slow caches (cfn-lint, shellcheck, hermeticd)
```

`scripts/dev-setup.sh` is the one command between a fresh checkout and a green `bun run ci`. It
verifies bun matches `.bun-version` and `uvx` is installed (a failure in either means `bun run
check` cannot pass), installs dependencies, points `core.hooksPath` at `.githooks`, reports the
optional tools real mode needs (`aws`, `tailscale`) and agents lean on (`gh`, `jq`, `rg`), and sets
up two workspace-local conveniences: `.context/hermetic-home` so a dev run's log never lands
in the real `~/.hermetic/hermetic.db`, and a read-only permission allowlist in
`.claude/settings.local.json` (git-ignored) so an agent running tests or reading the diff does not
stall on a prompt. It does not install the agent toolchain below; it only names the command. `--full` additionally runs `lint:sh`/`lint:cfn` once to populate the `uvx` cache
and builds `hermeticd`, which is where the one-time linux-arm64 bun download happens.

Adding a step is adding a `step_*` function and a call under the right section — steps are
independent, and an optional one that fails never stops a required one.

## Optional agent toolchain (recommended)

Nothing here is required to build, test or run the product — `bun run setup` alone gets you to a
green `bun run ci`. It is for people driving the repo through a coding agent (Claude Code, Codex,
opencode), and it makes those agents cheaper and better informed:

- [graft](https://github.com/trailhq/Graft) — a context graph of the repo in `graft/`: every symbol,
  its `file:line` span, and who calls what, served to the agent as CLI commands (`graft ask`,
  `graft callers`, `graft skeleton`), an MCP server, a Claude Code skill and hooks that keep the graph
  fresh as files change. An agent that queries it reads far less source than one that greps.
- [rtk](https://github.com/rtk-ai/rtk) — a proxy in front of the agent's shell commands (a Claude
  Code `PreToolUse` hook) that condenses their output; behavior and exit codes are unchanged.
- caveman — a terse-prose mode for the agent's replies to you, vendored in `.claude/skills/caveman/`
  (MIT). Off unless you opt in.

```
bun run agent-setup                 # install graft and rtk, and wire them into this checkout
bun run agent-setup -- --caveman    # the same, plus caveman full mode for every session here
bun run agent-setup:check           # report only, change nothing, exit 1 if anything is off
```

Without the flag, `/caveman full` turns caveman on for one session.

`scripts/agent-setup.sh` installs the two binaries (graft through `npm install -g`, rtk through its
checksum-verifying installer into `~/.local/bin`) and then writes only git-ignored files in this
checkout: graft's skill, hook shims and graph, `.mcp.json` and `opencode.json` for the MCP server,
and every hook, env var and permission in `.claude/settings.local.json`. The tracked
`.claude/settings.json` holds tool-neutral settings only, so a fresh clone without either tool runs
no hooks and reports no errors. When `graft init` writes its hooks into the tracked settings file, as
it insists on doing, the script moves them to `settings.local.json`, restores the tracked file, and
fails if any tracked file is left modified. graft rewires itself once after each graft upgrade (its
session-start hook and MCP server both do it), which puts the hooks back into the tracked file:
`bun run agent-setup:check` reports that, and rerunning `bun run agent-setup` moves them out again.

Nothing outside the repository is configured either. Both tools would otherwise wire themselves
machine-wide — `~/.claude/settings.json` hooks, `~/.claude.json` MCP entries, `~/.codex/hooks.json` —
so the script passes the suppressing flag on every call, then warns if a machine-wide entry turns up
regardless. If you want either tool globally, run its own installer yourself.

Conductor runs `bun install && bun run setup && bun run agent-setup` as a workspace's setup script
(`.conductor/settings.toml`), so a new worktree arrives wired and with its own graft graph built
(`graft/` is git-ignored, so each worktree needs one). After big changes, refresh it with
`graft build`.

To remove it: delete `.claude/helpers/`, `.claude/skills/graft/`, `graft/`, `.mcp.json` and
`opencode.json`, and drop the graft, rtk and `CAVEMAN_DEFAULT_MODE` entries from
`.claude/settings.local.json`. `npm uninstall -g @nanonets/graft` and `rm ~/.local/bin/rtk` remove the
binaries. A machine-wide install made by hand is undone with `graft uninstall -y` and
`rtk init -g --uninstall` (repeat with `--codex` and `--opencode`).

### rtk: getting raw output

rtk filters command output, which is the point — and occasionally the problem. Commands it has no
filter for run as-is, and a truncated result prints a hash and its recovery path in its own output.

| Need | Do this |
|---|---|
| Raw output, once | `rtk run -c '<command>'` (no filter, no tracking) or `rtk proxy <command>` (no filter, still counted); `RTK_DISABLED=1 <cmd>` skips rtk for one command |
| The part a filter elided | `rtk recall <hash>` — truncated results print their hash; `--full`, `--grep`, `--lines`, `--from` narrow the replay |
| Full file contents | `rtk read <file>` defaults to `-l none` (complete); `-l minimal`/`-l aggressive` are opt-in. Claude Code's `Read`/`Grep`/`Glob` never pass through the hook |
| A command that must never be rewritten | add it to `exclude_commands` in `~/.config/rtk/config.toml` (rtk's own config, not an agent's) — the right answer for watchers, REPLs, streams |
| More detail from a filter | `-v`, `-vv`, `-vvv` |

Bypass it when output is watched rather than read (`tail -f`, a dev server, a test watcher), when a
diff or log must be exact (release notes, security review, byte-level debugging), or when a filter's
summary and the raw text disagree. Otherwise leave it on. `rtk gain` shows the savings.

## Dev loop

```
bun install
bun run app:prepare     # once per machine, before anything typechecks or runs the app
bun run dev:fixture:hmr # fastest inner loop: fixture fleet, no AWS, UI edits hot-reload in place
bun run check           # typecheck + test (incl. boundaries) + biome check + lint + cfn-lint + shellcheck
bun run ci              # check + build + audit:dependencies; run before every push
```

`dev`, `dev:fixture` and `dev:wizard` each run `scripts/dev-app.ts`, which runs `hutch run <name>` in
`packages/app`: Hutch builds the app and launches it, rebuilding on a change under `packages/ui/src`
or `packages/core/src`. `dev` is real mode, `dev:fixture` the seeded fixture fleet, `dev:wizard` the
fixture backend with the init wizard forced. Quitting the app ends the session, as Ctrl-C does:
otherwise the watcher outlives the window and keeps holding the machine-wide Electrobun release lock,
and a `dev` in any other checkout waits at "Waiting for the project build lock..." until it is
stopped (`scripts/dev-quit.ts`). Only one `dev` can run on a machine at a time. The wrappers find
`hutch` on `PATH` or at `~/.hutch/bin`, so a shell that never sourced the installer's profile line (an
agent's, a fresh terminal) still finds it. To inspect the page itself — DOM, styles, console, network — use Safari's Web
Inspector: enable **Develop → Show Web Inspector** (Safari's Advanced settings expose the Develop
menu) and attach to the running app under **Develop → ‹your Mac› → Hermetic**.

Each of the three has an `:hmr` twin — `dev:hmr`, `dev:fixture:hmr`, `dev:wizard:hmr` — which is
Electrobun's Vite loop (its hot-reloading guide). `scripts/dev-hmr.ts` starts Vite over
`packages/ui` on `127.0.0.1:5273` (`HERMETIC_HMR_PORT` moves it), waits for it to answer, then
launches the app with `HERMETIC_VIEW_URL` pointing at it. A UI edit is then a React hot update in the
open window, with the main process — op streams, chat observations, the poller — left running; an
edit under `packages/core/src` or `packages/app/src` still rebuilds and relaunches. The URL is only
honoured by a dev-channel build, only on loopback, and only if the server answers at startup
(`packages/app/src/main/view-url.ts`); otherwise the window loads the bundled page and `app.log`
says why. Vite only serves in development — the shipped page is still bundled by Electrobun, so run
the plain `dev:*` loop once before calling a UI change done. Ctrl-C (or closing the window) stops
Vite and the app together.

`bun run ci` is `bun run check`, `bun run build` and `bun run audit:dependencies`, and it must be
green before you push. GitHub Actions runs the same scripts, one per job
(`.github/workflows/ci.yml`: `typecheck`, `test`, `lint:biome`, `lint`, `lint:cfn`, `lint:sh`,
`build`, `audit:dependencies`), so a red check names the step that failed and the slow jobs do not
queue behind the fast ones. CI also runs three things `bun run ci` does not:

- The `test` job is a matrix over the two shards in `scripts/test-shard.ts` — `cli`
  (`packages/cli`, which spawns a real process per test) and `non-cli` (everything else) — run as
  `bun scripts/test-shard.ts <shard>` so the two halves go in parallel and neither waits on the
  other's failure (`fail-fast: false`). The script, not the workflow, owns the paths and the
  environment: `non-cli` gets `HERMETIC_TEST_BUILD=1`, which enables the one slow test that really
  cross-compiles `hermeticd` (`packages/core/test/artifacts-build.test.ts`); laptops skip it unless
  they set the variable. `cli` runs with `--max-concurrency` set to the CPU count and a 15s
  timeout: its tests are CPU-bound spawns, and Bun's default of 20 in flight on a 2-vCPU runner
  timed every one of them out. On a small machine, run it the same way:
  `bun scripts/test-shard.ts cli`. `tests/ci-contract.test.ts` holds the shards to partitioning
  every test file in the repository exactly once, so a new directory cannot fall out of CI
  unnoticed.
- `test:dynamodb-local` (design §11.2) runs core's conditional writes against a real DynamoDB Local
  container. Locally: `docker run -p 8000:8000 amazon/dynamodb-local`, then
  `bun run test:dynamodb-local`.
- The `app` job builds the desktop app on a `macos-14` runner with `bun run app:build:canary`, then
  lists `packages/app/artifacts`. It proves the app still builds; nothing it produces is published.
  Locally: `bun run app:build:canary`.

The `ci` job aggregates the rest into a single green/red check for branch protection, and it fails
unless *every* job it needs reported `success` — skipped, cancelled and missing all count as failure
(`scripts/ci-results.ts`, whose `EXPECTED_JOBS` lists every one). Shared setup — pinned bun, the
install cache, and the no-AWS/no-real-home env — lives in the composite action at
`.github/actions/setup`. That action takes a `hutch` input: the jobs that build or typecheck the app
(`app`, `typecheck`, and `release.yml`) pass `hutch: true` to install the pinned Hutch and prepare the
devkit, and every other job skips a few hundred megabytes it would never open.

Every script in the root `package.json`, in its order there:

```
bun run setup                      # scripts/dev-setup.sh: check the toolchain, fix what is safely fixable
bun run setup:check                # report only
bun run agent-setup                # scripts/agent-setup.sh: optional graft, rtk, caveman (see above)
bun run agent-setup:check          # report only
bun run test                       # bun test — every package plus root tests/
bun run test:watch                 # the same, re-running on change
bun run test:dynamodb-local        # tests/integration/dynamodb-local.test.ts against HERMETIC_DYNAMODB_LOCAL (default 127.0.0.1:8000)
bun run typecheck                  # scripts/typecheck.ts across every package (needs the devkit)
bun run format                     # biome format --write . (fix)
bun run lint:biome                 # biome check . — format + lint, report only; any diagnostic fails
bun run lint                       # scripts/lint.ts's mechanical rules
bun run lint:cfn                   # cfn-lint over the rendered foundation template (needs uv, or CFN_LINT=…)
bun run lint:sh                    # shellcheck over packages/agentd/stages/*.sh (needs uv)
bun run boundaries                 # tests/boundaries.test.ts only
bun run audit:dependencies         # bun audit over the resolved tree (needs network; not in check)
bun run check                      # typecheck, test, lint:biome, lint, lint:cfn, lint:sh
bun run ci                         # check, build, audit:dependencies
bun run build                      # hermetic (CLI) + hermeticd, into dist/
bun run app:stage                  # scripts/app-stage.ts: the sidecars the app bundles, no dist/ wipe
bun run app:prepare                # hutch electrobun prepare in packages/app (once per machine)
bun run app:build                  # the stable channel app (alias of app:build:stable)
bun run app:build:canary           # the canary channel app — verification, never published
bun run app:build:stable           # cd packages/app && hutch run build:stable
bun run build:host                 # hermetic for this platform only, into dist/
bun run build:all                  # every host target into dist/<target>/
bun run release [patch|minor|major|x.y.z]  # scripts/release.ts: bump, tag, push, follow release.yml
bun run prepare                    # git config core.hooksPath .githooks (bun install runs it)
bun run dev                        # the app, real mode
bun run cli -- <args>              # the CLI from source
bun run dev:fixture                # the app against the fixture backend
bun run dev:wizard                 # fixture backend, forced init wizard
bun run dev:hmr                    # any of the three with `:hmr`: Vite serves the page, UI hot-reloads
```

Narrower than any script: `bun test packages/core` (or `cli`, `app`, `ui`, `agentd`), or a single
file, `bun test packages/core/test/render.test.ts`.

`packages/cli` is the one suite that spawns the thing it tests (§11.6), so it is built rather than
interpreted: `packages/cli/test/cli-binary.ts` compiles `packages/cli/src/main.ts` once per test
process with `bun build --compile` and every suite spawns that binary — the same entry point
`bun run build` ships. Suites whose tests share nothing but a fixture are `describe.concurrent`, so
the spawns overlap; the ones that read the run log back out of a shared `HERMETIC_HOME`, and the
golden snapshots (Bun does not support snapshot matchers in concurrent tests), are deliberately
left sequential. A home the concurrent tests share is seeded first (`seedFixtureHome`, same file):
the first open of a fixture home writes its fleets and default without a lock, and concurrent first
spawns race it.

The dashboard's end-to-end coverage is ordinary `bun test`, not a browser driver: the flow tests in
`packages/ui/test/flows/*.flow.test.tsx` render the real components against the real `bind`
(`packages/app/src/rpc/bind.ts`) and the real `dispatch`, over the fixture backend, so a request
crosses the same seam it crosses in the app. `tests/rpc-refusal.test.ts` covers the other direction —
a handler's refusal, from the throw to the `ApiError` a component renders.

CI pins bun via `.bun-version` (`oven-sh/setup-bun`'s `bun-version-file`); bump that file and your
local bun together so the two never drift. cfn-lint is pinned the same way in `scripts/lint-cfn.ts`
(`CFN_LINT_VERSION`, run through `uvx`); install [uv](https://docs.astral.sh/uv/) once and nothing
else is needed. A cfn-lint *warning* fails the check too — fix it, or add an `ignore_checks` entry
in the template's `Metadata` with the reason next to it. `lint:sh` (`scripts/lint-sh.ts`) runs
`shellcheck -S warning` over every bootstrap stage the same way, via `uvx --from shellcheck-py`.

`bun run check` is offline by design, so the advisory scan is not in it: `bun run
audit:dependencies` (`scripts/audit-dependencies.ts`) runs `bun audit` against GitHub's advisory
service, fails on a **high or critical** finding anywhere in the resolved tree — workspace packages,
dev dependencies and transitive dependencies included — and prints lower severities without failing.
A scan that times out, prints nothing, or prints something the script cannot parse exits 2 and is
reported as a failed scan, never as a clean tree, so "no advisories" always means somebody looked.
Waive an advisory only through `IGNORED_ADVISORIES` in that script, with the ID, the reason and an
owner beside it. Because it needs the network, `bun run ci` on a laptop cannot be green offline;
everything except this one step can.

Every remote GitHub Action is pinned to a full commit SHA with its release in the comment beside it,
workflows default to `permissions: contents: read`, and `.github/dependabot.yml` proposes the pin
updates weekly. `tests/ci-contract.test.ts` enforces all of that, plus the agreement between the
workflow's jobs, the `ci` aggregate's `needs`, and `EXPECTED_JOBS` in `scripts/ci-results.ts` — so
adding a CI job without requiring it fails the suite rather than quietly widening the gap.

## Formatting and hooks

Formatting is Biome's, configured in `biome.jsonc`, and it is not a matter of taste: `bun run
format` rewrites the tree, `bun run lint:biome` (`biome check`) is what `check` and CI run. The options there were
chosen to match the code as it already was (2-space indent, double quotes, semicolons, trailing
commas, 104 columns), so adopting it moved as few lines as it could. `bun run lint:biome` is the
linter half — Biome's recommended set plus unused imports/variables and `noExplicitAny`, with each
disabled rule carrying its reason as a comment in `biome.jsonc`. `packages/ui` keeps its `any`
exemption as a Biome override. `scripts/lint-biome.ts` fails on every diagnostic, `info` included:
plain `biome check` exits 0 on infos, which let them pass `check`, CI and the release script
unnoticed. A rule the repo does not want is turned off in `biome.jsonc`, not left to print.

`bun install` points `core.hooksPath` at `.githooks` (the root `prepare` script), which installs a
pre-commit hook covering the *staged* files only — a couple of seconds, not the whole suite. It
applies formatting rather than enforcing it: Biome formats the staged bytes and applies its safe
fixes, the hook re-stages the result, and only then does it check. A commit is never blocked over
whitespace; it simply carries the formatted bytes. What Biome cannot fix on its own (real lint
errors, unsafe fixes) still fails, and `bun run lint` runs after it.

A file staged whole is formatted on disk and re-staged, so the working tree and the commit agree. A
file staged with *other edits left unstaged* cannot be `git add`-ed without sweeping those edits
into the commit, so its staged blob is formatted through Biome's stdin mode and written straight to
the index; the hook names each file it handled that way. In an emergency, `git commit --no-verify`
skips all of it; CI runs the same checks as jobs, so nothing skipped there reaches master
unnoticed.

## Commit messages

Conventional commits, imperative mood, subject ≤50 chars: `fix: refuse create when SG has inbound rules`, `feat(cli): add agent recreate`. Body explains why, not what, when the diff isn't self-explanatory.

## Pull requests

The repo squash-merges, so a PR's title becomes the commit subject on `master` and follows the rules above. The body follows `.github/pull_request_template.md`, which GitHub pre-fills: a review guide (TL;DR, how it works, review stops, acceptance tests, rollout) whose test table lists only checks that were actually run. In Claude Code, `/create-pr` (`.claude/skills/create-pr/`) fills it from the branch and opens the PR; agents open every PR through it.

## Adding a CLI command or RPC handler

Every command/handler wraps exactly one core method — see "Parity contract" in `AGENTS.md` for the full six-step recipe (schema → core method → `PUBLIC_METHODS` → CLI command via `declare()` → RPC handler via `declareRpc()` → `bun test tests/parity.test.ts`). A handler lives under `packages/app/src/handlers/` and is wired into `HANDLERS` in `packages/app/src/handlers/dispatch.ts`; `declareRpc` is in `packages/app/src/declare.ts`, and `RPC_DECLARATIONS` in `packages/app/src/rpc/registry.ts` is what the parity test reads. Machinery requests that wrap no core method (meta, ops, the wizard's pre-init helpers) declare themselves as machinery instead and show up in `MACHINERY_RPC`.

## Updating snapshots

Render snapshots (`packages/core/test/render.test.ts` and similar) are the only place `-u` belongs:

```
bun test packages/core --update-snapshots
```

Review the diff before committing — a snapshot change should be explainable by the code change that caused it, not silently accepted.

## Running one package's tests

```
bun test packages/core
bun test packages/core/test/render.test.ts   # a single file
```

Any of these is safe to run: the tests never read or write your `~/.hermetic`. `bunfig.toml` preloads `tests/preload.ts` into every `bun test` process, and before a single test file is evaluated it points `HERMETIC_HOME` at a fresh `mkdtemp` directory under `os.tmpdir()` — asserting the result is not inside your real home, and removing it when the run ends. Everything that opens local state goes through `hermeticHome()`, and every subprocess a test spawns inherits the variable, so the pin covers the CLI suites too. A test that needs a home of its own on top of that (it runs `init`, a teardown, or anything else a later test would then start from) makes one with `testHome()` — `packages/app/test/home.ts`, or `mkdtempSync` directly in core — rather than sharing the run's. `tests/test-isolation.test.ts` fails if the preload stops being wired up.

## Building and smoking the binaries

```
bun run build:host      # hermetic for your platform, into dist/
./dist/hermetic --fixture agent ps
```

`bun run build` (no suffix) does the above plus `hermeticd` (always `linux-arm64`). `bun run build:all` cross-compiles every host target into `dist/<target>/`.

The dashboard is the desktop app, and it is built separately:

```
bun run app:build           # the stable channel, into packages/app/artifacts/
bun run app:build:canary    # the canary channel — what CI's `app` job runs to prove it builds
```

Either one runs `scripts/app-stage.ts` first, as Electrobun's `preBuild` hook. That is the sidecar stage: it builds `hermetic`, `hermeticd`, the two `hermeticd` stamps and `stages/`, then copies them into `packages/app/dist/bin`, which Electrobun's `build.copy` carries into `Hermetic.app/Contents/Resources/app/bin/` with the exec bits intact. It refuses on a missing item rather than shipping a smaller bundle — an app without `hermeticd` beside it looks fine until someone runs `init` from it.

To check a bundle by hand, open `Hermetic.app/Contents/Resources/app/`: `bin/` holds the sidecars above, and `views/main/` holds the page — `index.html`, the emitted `index.js`, its stylesheet, and `fonts/`. The faces are vendored because the webview has no network behind `views://`; a `fonts.css` naming a file that is not there is the whole dashboard drawn in Helvetica.

## Cutting a release

`bun run release` does steps 1–4 below: it refuses unless you are on a clean `master` in sync with `origin` and the tag is free locally and remotely, runs `bun run check`, bumps the version (`patch` by default; `minor`, `major` or an exact `x.y.z`), commits `chore: release v<version>`, asks before pushing, pushes the commit and tag in one `git push --atomic`, follows `release.yml` with `gh run watch`, and checks the published assets. `--dry-run` shows the plan and changes nothing; `--skip-check`, `--yes` and `--no-watch` skip the local check, the prompt and the watch. It needs `gh` authenticated unless `--no-watch` is given. The manual procedure, which the script follows:

1. Bump `version` in the root `package.json`. Commit it on `master`.
2. Tag the commit `v<version>` (the `v` prefix is required — `.github/workflows/release.yml` checks it against `package.json`) and push the tag: `git push origin v<version>`.
3. Pushing the tag starts `release.yml` on a `macos-14` runner: it installs Hutch pinned to `.hutch-version` and `uv` (for cfn-lint and shellcheck), asserts the tag matches `package.json`'s version and points at a commit on `master`, runs `bun run check`'s steps (with its tests split into the same `cli` and `non-cli` shards `ci.yml` runs, `scripts/test-shard.ts`), then `bun run app:build` (the stable channel), then publishes a GitHub Release named for the tag with `packages/app/artifacts/*` attached and notes generated from the commits since the last tag. About ten minutes end to end.
4. Verify: the release has three assets — `macos-arm64-Hermetic.dmg`, `stable-macos-arm64-Hermetic.app.tar.zst`, `stable-macos-arm64-update.json` — and, from the second release on, a fourth, `stable-macos-arm64-<prevhash>.patch`. `update.json` names the archive and the version. An install from an older tag should find the new release through Check for Updates and apply it (full archive if there is no patch to it yet, the patch otherwise); this needs the repository to be public, because the updater fetches `releases/latest/download/` without credentials.
5. If the workflow fails partway, the tag is not undone — tags are never moved. Delete the draft release if `gh release create` left one (a failure before that step leaves none), fix whatever broke, bump the version again and cut a new tag; do not re-push the same tag.

The build is unsigned today: no Apple Developer ID is configured, so `Hermetic.app` carries only an ad-hoc signature. A first launch needs `xattr -dr com.apple.quarantine /Applications/Hermetic.app` (README.md's Install section has the operator-facing version of this). Signing turns on with no other config change once `ELECTROBUN_DEVELOPER_ID`, `ELECTROBUN_APPLEID`, `ELECTROBUN_APPLEIDPASS`, and `ELECTROBUN_TEAMID` are set in the environment `bun run app:build` runs in.

`bun run app:build:canary` (CI's `app` job, every push) builds the canary channel on every commit to prove the app still builds — it is verification, not distribution: nothing it produces is uploaded or published, and the canary channel is never what `release.yml` ships.

## Running the wizard demo

```
bun run dev:wizard      # fixture backend, forced init wizard — for developing `init` without AWS
```

## Comment style

Most modules open with a file-level `/** … */` header that ties the file to the `docs/design.md` section it implements (e.g. `apply.ts`'s "`hermeticd apply` — §6.4", or `attach.ts`'s header, which names §4.5 a few sentences in), and often names the `AGENTS.md` rule that explains why the code was split out the way it was. Inline and block comments below that header explain *why* a piece of code does what it does — the constraint, the trade-off, the incident that shaped it — not what the next line of code already says. Match that shape in new files rather than inventing another convention.

## Where design decisions live

`docs/design.md` is authoritative for behavior: changing it changes what "correct" means for the whole test suite. A change that contradicts it updates the relevant section in the same PR as the code, and the PR description says what changed and why. Discuss larger design changes in an issue first.
