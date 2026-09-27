# hermetic — agent instructions

Fleet manager for Hermes agents on AWS. This file is the one set of instructions for every coding
agent working in this repo (Claude Code, Codex, opencode, and anything else that reads `AGENTS.md`):
layout, import boundaries, the parity contract, the rules for `packages/core`, how to run tests, and
the conventions a change is reviewed against.

- `docs/design.md` — authoritative for behavior.
- `docs/ui-brief.md` — visual style and layout. The spec wins where they disagree.
- `CONTRIBUTING.md` — setup, the full command list, CI, and the optional agent toolchain.

Prose to the user may be terse; artifacts — code, comments, commits, PR bodies, `docs/` — are always
normal English. If the caveman skill is available, use full mode for prose to the user.

Optional: `bun run agent-setup` installs graft (context graph) and rtk; when present, prefer graft
queries over grep. rtk's bypasses (raw output, recovering elided lines) are in `CONTRIBUTING.md`.

## Start here

Where to read for common tasks:

- **Add a core method** — schema → surface → CLI command → RPC handler → `bun test tests/parity.test.ts`. See [Parity contract](#parity-contract).
- **Run one package's tests** — `bun test packages/<core|cli|app|ui|agentd>`.
- **Debug a failed op** — `tail -f ~/.hermetic/app.log`, `bun run cli -- runs`, the app's Runs view. See [Watching a running app](#watching-a-running-app).
- **Debug a failure on the box** — `bun run cli -- agent history <name>`: the failed stage's event carries the last 120 lines of its log (`log_tail`; `--json` for the raw field). `logs <name> --console` reads the serial console when the box's RPC never came up. Hermes-side turn errors: `bun run cli -- logs <name> --file errors` (Hermes logs to files under `$HERMES_HOME/logs/`, not the journal).
- **Fixture mode** — `--fixture`/`HERMETIC_FIXTURE=1`, `bun run dev:fixture`/`dev:wizard`. See [Modes](#modes).
- **Add a long operation** — a module with an explicit deps object, not another function in `hermetic.ts`. See rule 5.
- **Bump `FOUNDATION_VERSION`** — see rule 7.
- **Bump `chrome_ref`** — take the new Chrome for Testing zip's sha256 and byte size, edit `BUILD_VERSIONS.chrome_ref`/`chrome_sha256`/`chrome_size` (`packages/core/src/build-versions.ts`), then `hermetic artifacts push` to mirror it. A box gets the new pin when its config is rendered — `agent create` or `recreate`, not `rerun` (which only resumes an `error` agent). Same owner and cadence as `hermes_ref`; Chrome for Testing does not self-update. §7.3/§3.6.
- **Add a second fleet** — `hermetic init --attach --fleet <id|alias>` joins an existing foundation, `init --create` makes a new one. `hermetic fleet alias <fleet-id> <alias>` labels a fleet, `--clear` unlabels it, `fleet use <fleet-id|alias>` switches the local default. `fleet_id` is the identity; the alias is display only. §4.6/§4.8.

## Layout (Bun workspaces)

```
packages/core     SDK: all logic, all AWS, SQLite, DynamoDB. Zod schemas in packages/core/src/schema/.
packages/cli      Commander head. Imports core in-process. Never imports the app package.
packages/app      Electrobun head: desktop main process, typed RPC over core; bundles ui's page.
packages/ui       React. Webview only. Talks to the main process over Electrobun RPC.
packages/agentd   hermeticd node agent. Imports ONLY `@hermetic/core/schema` and `@hermetic/core/shared`.
```

### Import boundaries

The table below is the `ALLOWED` literal in `tests/boundaries.test.ts` — edit both together. That test parses every `packages/*/src` file with `Bun.Transpiler` and resolves every import, `export … from`, `import()` and `require()` specifier to one cell:

| From \ May import | core | core/schema | core/shared | cli | app | ui | agentd |
|---|---|---|---|---|---|---|---|
| **core** | — | — | — | no | no | no | no |
| **cli** | yes | yes | yes | — | **no** | no | no |
| **app** | yes | yes | yes | no | — | no | no |
| **ui** | **no** | no | **yes** (browser-safe, values) | no | yes (types only, devDep) | — | no |
| **agentd** | **no** | yes | yes | no | no | no | — |

A `no` covers `import type` too — a type-only import is still a dependency on the other package's shape. Only ui → app is types-only, and a devDependency: a value import from app inside the UI fails, and not a byte of the app may reach the bundle. A relative or absolute path escaping its package (`../../core/src/x.ts`) resolves to whatever `packages/<x>/` it lands in and hits the same table; bypassing the `exports` map, it can never count as `core/schema` however deep into `src/schema/` it reaches. A deep bare path like `@hermetic/core/index.ts` counts against the `core` column. The matrix has no exceptions.

Scope is each package's `src`. Package `test` trees are out (a test may read both sides of a seam — that is what root `tests/` is for). `scripts/` is not a package and has its own rule in the same file: relative into `packages/core/src`, no head, no `@hermetic/*`. The `core` `package.json` has zero `@hermetic/*` deps. The `core` `exports` map is exactly `{".": "./src/index.ts", "./schema": "./src/schema/index.ts", "./shared": "./src/shared/index.ts"}` — `schema` and `shared` are the only doors agentd can use, and `shared` (pure values and helpers, no Zod, no node; `packages/core/test/shared-browser-safe.test.ts`) is the only one the UI can. `schema/*` imports `shared/*`, never the reverse.

## Parity contract

`PUBLIC_METHODS` in `packages/core/src/surface.ts` (re-exported from `hermetic.ts`, where heads import it) is the whole command surface. Every dotted method (`agents.create`, `plan.destroy`) needs exactly one CLI command and one RPC handler.

`tests/parity.test.ts` checks that three independent sources agree: `PUBLIC_METHODS`/`REQUEST_SCHEMAS`/`CLI_REQUEST_SCHEMAS` (core), `CLI_COMMANDS`/`RPC_DECLARATIONS` (recorded by the heads via `declare()`/`declareRpc()` as they build themselves, never hand-copied), and the hand-transcribed `SURFACE` table in the test, mirroring design.md §9. A request over the bridge is named by the core method it wraps — no verb, no path — so a declaration is only "this handler validates `agents.create` against *that* schema object", and it is the same binding the handler hands to `parseInput`.

Requests wrapping no core method (meta, the ops registry, the wizard's pre-init helpers) declare as machinery and land in `MACHINERY_RPC` (`packages/app/src/rpc/registry.ts`, reading `packages/app/src/declare.ts`). The parity test asserts that `HANDLER_NAMES` — every name `HANDLERS` in `packages/app/src/handlers/dispatch.ts` answers — is exactly the public methods plus the machinery, and nothing beyond.

**Add a new core method:**

1. Add or extend a Zod schema in `packages/core/src/schema/`.
2. Add the method to the SDK surface in `hermetic.ts`, validating input with that schema.
3. Add the dotted path to `PUBLIC_METHODS` (and `STREAMING_METHODS` if it is a long operation returning `AsyncIterable<OpEvent>`).
4. Add a CLI command in `packages/cli/src/program.ts` (or a command file it wires in), calling `declare(path, "command name", schema)` and validating the parsed options with the returned schema before calling core.
5. Add an RPC handler under `packages/app/src/handlers/`, calling `declareRpc(path, schema)` and validating with the returned schema via `parseInput`; wire it into `HANDLERS` in `packages/app/src/handlers/dispatch.ts`.
6. `bun test tests/parity.test.ts` — fails on a missing command, a missing handler, a schema mismatch, or `SURFACE` disagreeing.

Worked example: grep `fleets.alias` — it appears in every one of those places plus §9 of `docs/design.md`. Heads render `alias ?? fleet_id` but key state, requests and comparisons on `fleet_id` alone.

## Modes

| Mode | How to get it | What it does | Must never touch |
|---|---|---|---|
| **real** | default; `bun run dev` (Hutch builds and launches the app), installed `Hermetic.app`, plain `hermetic` | The real AWS account frozen by `init`; `~/.hermetic/hermetic.db` (or `$HERMETIC_HOME`) holds config and the run log | Any account but the one in `config` (`ACCOUNT_MISMATCH`/`FLEET_MISMATCH` guard every call) |
| **fixture** | `--fixture` (either side of the subcommand), `HERMETIC_FIXTURE=1`, `bun run dev:fixture` | In-memory `MemoryBackend`, a fake fleet, no AWS; the run log in its own `hermetic-fixture.db` | A real AWS client of any kind; the real `hermetic.db`; `git` for the Hermes mirror (canned `fixtureHermesMirror`, `hermes-mirror.ts`) |
| **fixture-uninitialized** | `HERMETIC_UNINIT=1` (+ `HERMETIC_FIXTURE=1`), `bun run dev:wizard` | Forces the init wizard against the fixture backend | An already-initialized real home — `openState` probes first and refuses to let the flag mask one |

The fixture seeds two fleets: `fxtr0001` (alias `main`, 12 agents, current `FOUNDATION_VERSION`, the default) and `sg7k2m4p` (alias `staging`, 2 agents, one version behind so `update_available` shows true). Pick the second with `--fleet staging`/`--fleet sg7k2m4p`/`HERMETIC_FLEET=…`, in the CLI and in the `dev:fixture` app — `--fleet` takes an id or an alias, and the id wins a collision. `main` also seeds five provider profiles (`FIXTURE_PROFILE_IDS` in `packages/core/src/backend/fixture/memory-fixture.ts`; anthropic `ant00001` is `default_profile`); `corvid` carries a staged `pending` binding and `atlas` sits on bedrock revision 1, so `update_available` is live on an agent too. Fixture-only chat staging (there is no gateway to fake an external message otherwise): `hermetic.fixture.chat.inject`/`.hint` and the matching `fixture.chat.inject`/`fixture.chat.hint` requests (`packages/app/src/handlers/fixture.ts`) stage a Desktop/CLI-style arrival or a bare hint against a watched conversation. Two guards keep it out of real mode (no `fixture` namespace is built outside fixture mode; a `fixture: false` control surface throws `UNSUPPORTED` before reading input), and an in-memory-only closure bounds the blast radius.

Both modes go through the same `Hermetic` interface (`openHermetic`/`openForInit` in `packages/core/src/open.ts`); heads never construct a `Backend`.

## Where things live

**Reading `docs/design.md`.** It is ~440 KB (~110k tokens) with single lines over 10k chars — never read it whole. Find the section, then read only that range:

```
grep -n "^## \|^### " docs/design.md      # headings with line numbers
sed -n '<start>,<end>p' docs/design.md    # the one section you need
```

Top-level sections, so a `§` reference resolves without a grep: §1 Principles · §2 System overview · §3 Software architecture · §4 State model · §5 AWS foundation · §6 Agent lifecycle · §7 Instance design · §8 Secrets · §9 Command surface · §10 Defaults · §11 Testing.

`docs/architecture.md` — the package map as prose and diagrams. `docs/operations.md` — running a real fleet, prerequisites included.

## Rules for core (each is a test: `scripts/lint.ts` + `tests/`)

1. Core never talks to a human: no `console.*`, no `process.exit`, no prompts. Typed results and `HermeticError` with a `code`.
2. Long operations are `AsyncIterable<OpEvent>` (`{ phase, progress, message }`) and accept an `AbortSignal`.
3. Plan, then apply: `plan.destroy(name)` returns a plan; `apply(plan)` executes it. Heads confirm.
4. Parity: every public core method has exactly one CLI command and one RPC handler (`tests/parity.test.ts`).
5. No non-test source file over 1500 lines (`scripts/lint.ts` rule 3, `bun run lint`), across `packages`/`scripts`/`tests`. It is a smell threshold, not room to fill — split before adding to a file near it. Add a new long operation as a module taking `{ ctx: CoreContext }` (`packages/core/src/context.ts`) plus its own few deps, not as another function in `hermetic.ts`.
6. The §4.7 Tailscale preflight defaults to real probes (`deps.localTailscale`/`deps.verifyTailscaleOauth` in `hermetic.ts`) — an absent dependency must not silently disable the gate on `init --create`. Tests use `testHermetic` (`packages/core/test/helpers.ts`) or `openForInit({ preflight })`; the fixture uses the canned `FIXTURE_PREFLIGHT` (`open.ts`) and never spawns a binary or reaches api.tailscale.com.
7. Bump `FOUNDATION_VERSION` (`packages/core/src/version.ts`) and the sha table in `packages/core/test/foundation-version.test.ts` whenever the foundation CFN template or its remote/local state shape changes. Add a `FOUNDATION_MIGRATIONS` entry if the state itself must move.

## Testing

Commands, CI jobs, the formatter and hooks: `CONTRIBUTING.md`. `bun run check` before a commit, `bun run ci` before a push. What is specific to this repo:

- Seam tests live in root `tests/` because no package may import both sides: `user-data.test.ts`, `seams.test.ts` (fleet manifest, agent config, stage env), `packages/core/test/shared-browser-safe.test.ts` (nothing reachable from `@hermetic/core/shared` may need node, bun, zod or AWS, since the UI bundles it). Every document the laptop writes and the box reads has one — a comment saying "change the two together" is not a substitute.
- No network: AWS is mocked with `aws-sdk-client-mock`; `hermeticd` tests run against `packages/agentd/test/fake-host.ts` (an in-memory `Host`: no root, systemd, apt or network). Bootstrap stage scripts are checked only by `bun run lint:sh`, never executed. A container suite that runs the stages is future work.
- No real home, no inherited env: `bunfig.toml` preloads `tests/preload.ts` — a fresh `HERMETIC_HOME` per test process, and `HERMETIC_FLEET`, `HERMETIC_FIXTURE` and `AWS_PROFILE` always unset, because absence is the default every test was written against. An inherited `HERMETIC_HOME` is **replaced**, not honoured, and the preload throws before creating anything if the temp root resolves inside the real home. A test needing isolation from its neighbours makes its own `mkdtempSync` home (`testHome(prefix)` in `packages/app/test/home.ts` for app suites). `tests/test-isolation.test.ts` is the gate.
- No browser driver: the dashboard's end-to-end coverage is `packages/ui/test/flows/*.flow.test.tsx` under plain `bun test` — real components against the real `bind` (`packages/app/src/rpc/bind.ts`) and the real `dispatch`, over the fixture backend, so a request crosses the same seam it crosses in the app. `tests/rpc-refusal.test.ts` covers the return path, from a handler's throw to the `ApiError` a component renders.
- `-u` (snapshot update) is for render snapshots only (`packages/core/test/render.test.ts` and friends), never to paper over a behavior change. Review the diff first.

## Conventions

- Bun per `.bun-version`, TypeScript strict, ESM. Run everything with `bun`.
- **Mobile is out of scope** — no phone breakpoints, no touch-only affordances, no phone-width tests. The app targets a desktop window; breakpoints for narrow windows (760px and up) are fine.
- Edit-scope discipline: stay inside the files and packages you were given, even when you spot something else worth fixing — flag it, no drive-by edits.
- Zod schemas live in core and are the single source of types (`z.infer`). The CLI validates parsed options against the same schema core uses.
- AWS SDK v3 clients are constructed via `aws.client()` in core (the account guard, `packages/core/src/aws/client.ts`). One documented exception: `resolveIdentity` (`aws/identity.ts`) runs before any account is frozen, so it has nothing to guard against. Never read `AWS_PROFILE` elsewhere.
- `validateName` (`names.ts`) is the only name validator; every method taking a name calls it. `_fleet` is reserved.
- No `console.*` in `packages/core/src`, no `: any`/`as any` outside `packages/ui` (`bun run lint` rules 1 and 2).
- Deferred-work markers carry an owner: `TODO(name):`, `FIXME(name):`, `PHASE2(name):`, `PHASE3(name):` — never bare (rule 4).
- Secrets are never logged, echoed, or written to disk on the laptop. Test fixtures use only `FIXTURE` sentinel values; `packages/core/test/secrets-leak.test.ts` fails the suite on any fixture secret value, or any `tskey-…`, in captured output.
- Commit messages: conventional commits, imperative, subject of 50 characters or fewer.
- Delegation and token discipline for agents that spawn subagents: `.claude/skills/orchestrator-mode/SKILL.md` §6.

## Dev

```
bun install
bun run app:prepare  # once per machine: materialises packages/app/.hutch/devkit (typecheck needs it)
bun run dev          # the app, real mode: wizard if uninitialized, dashboard if not
bun run dev:fixture  # the app against the fixture backend, rebuilding on ui/core edits
bun run dev:fixture:hmr  # same, but Vite serves the page: UI edits hot-reload, no relaunch
bun run cli -- agent ps --fixture
```

Each `dev*` script is `scripts/dev-app.ts` running `hutch run <name>` in `packages/app` and ending the session when the app is quit (a lingering `--watch` holds the machine-wide Electrobun release lock and blocks `dev` in every other checkout; `scripts/dev-quit.ts`), except the `:hmr` twins (`dev:hmr`, `dev:fixture:hmr`, `dev:wizard:hmr`), which run `scripts/dev-hmr.ts`: Vite on `127.0.0.1:5273` over `packages/ui` (`vite.config.ts`), then the app with `HERMETIC_VIEW_URL` set (`packages/app/src/main/view-url.ts` — dev channel, loopback, must answer, else the bundled page). The window's navigation rules then allow that one origin too (`mainNavigationRules`, `main/navigation.ts`). Vite is dev-only; the release page is still Electrobun's bundle. Hutch is pinned in `.hutch-version`; install and devkit notes are in `CONTRIBUTING.md`. Inspect the page with Safari's Web Inspector (Develop → ‹your Mac› → Hermetic).

`HERMETIC_FIXTURE_SLOW_STACK_MS=120000 bun run dev:wizard` stretches the fixture's foundation create over two minutes, with resource events, for long-phase progress UX.

Releases push from a **committed** tree: `init`, `artifacts push` and `foundation update` refuse with `WORKING_TREE_DIRTY` on uncommitted or untracked files (`packages/core/src/release/git.ts`) — the build number is `git rev-list --count HEAD`, which does not move for an uncommitted edit. `HERMETIC_ALLOW_DIRTY=1` overrides, accepting that the result cannot be rebuilt from the commit it names. No repository, no `git`, or a shallow clone reads as *unknown* and is never refused.

Run `bun run cli -- artifacts push` before `agent create`/`rerun` after changing `packages/agentd`: the version string does not move between commits, so the fleet keeps the last-pushed binary, and a manifest from a newer core can list a unit only a newer hermeticd installs (`create`/`rerun` warn when the checkout differs from the manifest's `build`). The same goes for a bumped `BUILD_VERSIONS.hermes_ref` (mirrors `hermes/<ref>.bundle`, `hermes-mirror.ts`, needs foundation v7) or `chrome_ref` (mirrors `browser/chrome-linux-arm64-<chrome_ref>.zip`, `browser-mirror.ts`, needs foundation v14). Foundation bumps: `hermetic foundation update`.

`init` and `artifacts push` resolve the release themselves (`packages/core/src/release/artifacts.ts`), binary and stages independently. Binary — `HERMETIC_HERMETICD=/path`, else the binary next to the executable, else `bun build --compile --target=bun-linux-arm64` into `packages/agentd/dist/hermeticd` on a source checkout. Stages — `HERMETIC_STAGES=/path`, else `stages/` next to the executable, else `packages/agentd/stages/`. Stage file names are validated (`orderStages`) before upload. With no resolvable release, `init --create` refuses with `HERMETICD_UNAVAILABLE` before creating anything; `--skip-artifacts` bypasses that for headless runs.

### Watching a running app

The main process logs to stderr **and** a file (`packages/app/src/log.ts`), so a failure is findable after the window was closed or a rebuild restarted the app. Core never logs (rule 1) — this is the head recording what core reported.

| Where | What |
|---|---|
| `~/.hermetic/app.log` (`$HERMETIC_HOME`; `app-fixture.log` in fixture mode) | every op start/outcome, every op event (`DEBUG`, file only), every failed request with code and message, stacks for anything unclassified. The path is printed at boot. |
| `bun run cli -- runs` | the local `runs` table: the same ops, persisted, shared with the CLI |
| the app's Runs view | the same ops live, with each op's buffered events |

"init failed" / "op failed": `tail -f ~/.hermetic/app.log`, reproduce, and read the `ERROR op:<method>` line — it carries core's `HermeticError` code and message, naming the failing AWS call. The page's op stream is the same data; the file has it when the window does not.
