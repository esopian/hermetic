/**
 * Where Hermes lives on an agent box (§6.4): the account, its home, the
 * install tree, the systemd units and the ports — the paths hermeticd, the
 * bootstrap stages and the laptop's renderer all have to agree on.
 *
 * Pure values only — no Zod, no `node:*`, nothing that opens a file or a
 * socket — because `shared/index.ts` re-exports from here into the browser and
 * the box. The Zod schemas that validate these shapes live in `schema/*`, which
 * imports this module, never the reverse (`packages/core/test/shared-browser-safe.test.ts`).
 */

/**
 * The unprivileged account every Hermes process runs as (§7.1). A system user,
 * created by hermeticd before anything references it.
 */
export const HERMES_ACCOUNT = "hermes";

/**
 * The `hermes` account's home directory (§7.1). It sits on the data volume
 * because everything the agent accumulates does, and because the account and
 * its state should be recoverable together when a volume is reattached.
 */
export const HERMES_ACCOUNT_HOME = "/data/hermes";
/**
 * `$HERMES_HOME` — upstream's single config-and-data root (§6.4), and
 * deliberately `$HOME/.hermes` of the account above rather than an arbitrary
 * directory.
 *
 * That equality is the whole point, and it is about the `hermes` account: with
 * `$HOME/.hermes == HERMES_HOME` upstream sees a default layout rather than a
 * custom root, so `_profile_suffix()` is `""`, the gateway unit is named
 * `hermes-gateway.service` (`HERMES_GATEWAY_UNIT`), and that name is a fact
 * rather than a hash of this path.
 *
 * Which *account's* `$HOME` answers that question is upstream's to decide, and
 * it moved at `v2026.9.14`: the test used to be `home ==
 * get_default_hermes_root()`, which returns a custom root unchanged and so said
 * yes to any `HERMES_HOME` at all, and is now `home in _native_service_homes()`
 * — literally `Path.home() / ".hermes"` of the process running the installer
 * (`hermes_cli/gateway.py:2015-2041`). The equality above still holds, because
 * `ensureGatewayUnit` runs that one command with the `hermes` account's `HOME`;
 * see its comment for why that is the honest answer and not a workaround.
 */
export const HERMES_HOME = HERMES_ACCOUNT_HOME + "/.hermes";
/**
 * The agent's own config: the seeded half, and whatever it has changed since.
 * Written once by a post-step and then not hermetic's business.
 */
export const HERMES_USER_CONFIG = HERMES_HOME + "/config.yaml";
/**
 * The agent's own `.env`, which hermetic writes to never and reads about once.
 *
 * It is upstream's highest-precedence *user* credential channel: `load_env()`
 * loads it with `override=True` (`hermes_cli/env_loader.py:362-365`), so its
 * values land in `os.environ`, and the api-key path prefers it over the
 * environment on top of that (`get_env_value_prefer_dotenv`,
 * `hermes_cli/config.py:2698-2701`). A provider key in here therefore outranks the
 * one hermetic delivers on tmpfs — which is why `verify-hermes` asserts the
 * managed provider's key variable is not named in it (`hermes-check.ts`), and
 * why nothing hermetic renders ever writes it.
 */
export const HERMES_USER_ENV = HERMES_HOME + "/.env";
/**
 * The directory the managed scope *is*: `managed_scope.py` takes
 * `$HERMES_MANAGED_DIR` if set and existing, else this path if it exists.
 *
 * Named separately from the files under it because it is not only a prefix —
 * anything writing into it has to create it first. Nothing on an Ubuntu box
 * ships `/etc/hermes`; every file here appears because hermetic put it there,
 * and the writer that assumed a rendered file had already made the directory
 * is the one that failed a fresh box's bootstrap (`ensureHermesRevision`).
 */
export const HERMES_MANAGED_DIR = "/etc/hermes";
/**
 * Hermes's managed scope: its keys override the same keys in
 * `HERMES_USER_CONFIG` and `hermes config set` refuses them.
 *
 * What makes it the managed scope is the *path* and nothing else —
 * `managed_scope.py` takes `$HERMES_MANAGED_DIR` if set and existing, else
 * `/etc/hermes` if it exists, and checks neither ownership nor writability. The
 * `0640 root:hermes` this file is rendered with still earns its keep, but for
 * the other reason: it stops the agent user rewriting hermetic's half of the
 * configuration, not Hermes from honouring it.
 */
export const HERMES_MANAGED_CONFIG = HERMES_MANAGED_DIR + "/config.yaml";
/** The seed's parking spot: content for `HERMES_USER_CONFIG`, not a config itself. */
export const HERMES_SEED_CONFIG = HERMES_MANAGED_DIR + "/config.seed.yaml";
/**
 * Upstream's image-provenance marker: the file that makes Hermes refuse to
 * update itself (§6.5).
 *
 * The path is upstream's and not configurable — `IMAGE_PROVENANCE_PATH` at
 * `hermes_cli/image_provenance.py:16`, deliberately outside `$HERMES_HOME` and
 * the checkout so neither env nor config can forge or hide it. hermetic renders
 * its content in `render.ts`; the constant is here because `/etc/hermes` is
 * hermetic's directory and its paths are stated in one place.
 */
export const HERMES_PROVENANCE_PATH = HERMES_MANAGED_DIR + "/image-provenance.json";
/**
 * `HERMES_REVISION=<upstream commit>` for the two Hermes units — the one file
 * under `/etc/hermes` that hermeticd writes and core only reads back.
 *
 * It exists because upstream's update check asks the *local checkout* what
 * revision it is on, and on a mirror-installed box that question has no honest
 * answer. The bundle is a synthesized single root commit over the checked-out
 * tree (`hermes-source.ts`), so `git rev-parse HEAD` names a commit upstream
 * never made, `git fetch` shares no objects with `origin` and has to negotiate
 * upstream's entire history, and the compare API 404s on the sha. Upstream's
 * own seam for a build that knows its revision out-of-band is `HERMES_REVISION`
 * (`hermes_cli/banner.py`, `check_for_updates`): set it and the check skips the
 * checkout entirely and compares that revision to upstream `main` over the
 * GitHub API. The value hermetic has for it is exactly the marker's second line.
 *
 * Written by hermeticd rather than rendered by core, because the fact is about
 * the checkout that is *on the box now*, not the one the config named when it
 * was rendered: a rerun that installs a different ref moves this file and
 * `HERMES_REF_MARKER` in the same step. The direct-clone fallback has no
 * `upstream_sha` in the manifest and does not need one — there `HEAD` *is*
 * upstream's commit, so hermeticd reads it out of git.
 *
 * `EnvironmentFile=-` in both units (`render.ts`), so a box whose hermeticd has
 * not written it yet still starts; the only cost of its absence is the update
 * check falling back to asking the checkout, which is where it already was.
 */
export const HERMES_REVISION_ENV = HERMES_MANAGED_DIR + "/revision.env";

/**
 * Where the Hermes checkout lives on an agent box: upstream's own root-on-Linux
 * FHS layout (`scripts/install.sh:425-450`), which hermeticd mirrors rather than
 * piping the installer into a shell (`apply.ts`).
 */
export const HERMES_INSTALL_DIR = "/usr/local/lib/hermes-agent";
/**
 * The `hermes` entry point: the symlink upstream's FHS layout leaves on `PATH`
 * when the checkout is installed as root under `/usr/local/lib`
 * (`scripts/install.sh:425-450`), which is the layout hermeticd mirrors.
 */
export const HERMES_BIN = "/usr/local/bin/hermes";
/**
 * Where Vite actually writes the dashboard SPA.
 *
 * Not `web/dist`, which is what a reader of `web/` would assume and what
 * hermeticd assumed for a while: `outDir` is `../hermes_cli/web_dist`
 * (`web/vite.config.ts:103`), and upstream states it verbatim —
 * *"Vite outputs to `hermes_cli/web_dist/` (vite.config.ts outDir), NOT
 * `web/dist/`"* (`hermes_cli/main_web_build.py:88-90`).
 *
 * Stated to the unit rather than inferred, because upstream exposes the seam:
 * `HERMES_WEB_DIST` is read at `hermes_cli/web_server.py:58` and baked into the
 * official image at `Dockerfile:373`. With it set there is nothing left to
 * guess about where the bundle is.
 */
export const HERMES_WEB_DIST_DIR = HERMES_INSTALL_DIR + "/hermes_cli/web_dist";
/**
 * The prebuilt Ink TUI the dashboard's Chat tab spawns
 * (`hermes_cli/web_server_chat.py:321`).
 *
 * Without `HERMES_TUI_DIR` the launcher npm-installs at first use
 * (`hermes_cli/main_tui_launch.py:562-572`) — as the unprivileged `hermes` user,
 * into a root-owned tree, which is an EACCES and a dead Chat tab. Upstream's
 * Dockerfile sets this for exactly that reason and says so at `Dockerfile:374-389`.
 */
export const HERMES_TUI_DIR = HERMES_INSTALL_DIR + "/ui-tui";

/**
 * Ask Hermes what a config key actually resolves to, as the agent's own user.
 *
 * One builder because two packages ask the same question and a difference
 * between them would be invisible: `render.ts` puts this in a post-step (the
 * seed guard), `hermes-check.ts` runs it as a boot assertion, and whichever of
 * the two were wrong would simply answer "no model" forever.
 *
 * Why not a grep. `hermes config get <key> --json`
 * (`hermes_cli/subcommands/config.py:20-22`, `config.py:3498-3512`) resolves
 * through `load_config()`, so it sees the managed overlay in `/etc/hermes`, the
 * user config, and the `model`/`name` aliases normalisation folds into
 * `model.default` (`config.py:1793-1799`) — none of which a regex over one file
 * can see. An unset key prints "Config key not set: <key>" to stderr and exits
 * 1 (`_exit_invalid`, `config.py:3390-3392`); it never prints JSON null. So the exit
 * code is the whole answer and stdout can be discarded.
 *
 * As `hermes`, not as root: `$HERMES_HOME` is the account's and every file in
 * it is 0640 `hermes:hermes` (§7.1), so root would be asking about a config the
 * process that matters does not read. `runuser` rather than `sudo` because it
 * is util-linux, needs no sudoers entry, and asks for no password; `env` rather
 * than trusting what `runuser` forwards, because `HERMES_HOME` decides which
 * tree is read and this must not depend on the caller's environment.
 */
export function hermesConfigGetArgv(key: string): string[] {
  return [...hermesArgv(), "config", "get", key, "--json"];
}

/**
 * Set a config key in the agent's *own* `config.yaml`, as the agent's own user.
 *
 * The sibling of the reader above, and the only correct way to put a key in
 * that file from outside Hermes. Appending YAML to it is not: Hermes loads it
 * with `yaml.safe_load` (`hermes_cli/config.py:24`, `load_config`), where a
 * second top-level `model:` block silently wins over the first — so an appended
 * `model: {default: …}` discards a `model:` mapping the operator already had
 * (`provider`, `base_url`, `context_length`), and the next `_write_user_config`
 * dumps the collapsed document back over the file permanently. `config set`
 * instead reads the raw user config, promotes a scalar `model` shorthand to a
 * mapping, writes only the addressed leaf (`_set_nested`) and leaves every
 * sibling key standing (`set_config_value`, `config.py:3452-3474`).
 *
 * The value arrives as a string and stays one: `_coerce_config_set_value`
 * (`config.py:3274-3304`) only turns it into a bool/number/structure when it is
 * spelled like one, which no provider's model id is.
 *
 * **Quote the value yourself** when joining this into a `/bin/sh` line. This
 * returns argv, where a space or a `;` is inert; a shell command line is the
 * one place it is not, and `render.ts` — the only such caller — quotes it there.
 */
export function hermesConfigSetArgv(key: string, value: string): string[] {
  return [...hermesArgv(), "config", "set", key, value];
}

/** `hermes`, run as the agent's account against the agent's own `$HERMES_HOME`. */
function hermesArgv(): string[] {
  return ["runuser", "-u", HERMES_ACCOUNT, "--", "env", `HERMES_HOME=${HERMES_HOME}`, HERMES_BIN];
}

/**
 * The gateway unit — the process that runs the agent: messaging channels, cron
 * jobs, and the API server if it is ever switched on.
 *
 * hermetic does **not** render this file. `hermes gateway install --system`
 * writes it, hermeticd runs that command once when the path is absent
 * (`apply.ts`), and the name is a consequence of `HERMES_HOME` being the
 * account's default root: upstream's `_profile_suffix()` is `""` for a default
 * layout, so there is no hash in it. That is an inference about upstream's
 * behaviour rather than a documented promise, which is why `apply.ts` asserts
 * the file is really there afterwards instead of trusting the name.
 */
export const HERMES_GATEWAY_UNIT = "hermes-gateway.service";
/**
 * The dashboard unit — the browser SPA published over Tailscale Serve. This one
 * *is* hermetic's, rendered in `render.ts`, because upstream's CLI ships no
 * installer for it: `hermes dashboard` is a foreground command and nothing in
 * `subcommands/dashboard.py:40-42` turns it into a service.
 *
 * The *name*, though, is upstream's and not hermetic's to pick. Upstream's
 * restart machinery looks for exactly this unit
 * (`hermes_cli/main_dashboard.py:63`, `_DASHBOARD_SYSTEMD_UNIT`), and when it
 * does not find it `_restart_managed_dashboard_service` falls back to sending
 * SIGTERM to whatever matches a command-line scan — which the same file's
 * comment (`:74-80`) documents as the wrong path, because systemd reads a
 * direct SIGTERM as a clean stop and does not restart the unit. Upstream also
 * ships two reference units under this name (`docker/s6-rc.d/dashboard/run:54-56`,
 * `nix/nixosModules.nix:568-586`), and hermetic's argv matches them, so wearing
 * the name is a statement about a unit that really is the one upstream means.
 */
export const HERMES_DASHBOARD_UNIT = "hermes-dashboard.service";
/**
 * What hermetic used to call the dashboard unit, kept only so that an apply can
 * take it away.
 *
 * A box created before the rename has this file on disk, enabled and running.
 * Nothing in `hermeticd apply` removes a unit that merely stopped being in the
 * manifest, so without a deliberate step the box — or a data volume reattached
 * to a new one — would run two dashboards against one `$HERMES_HOME`. See
 * `removeLegacyDashboardUnit` in `packages/agentd/src/apply/accounts.ts`: it removes the
 * file only when the content identifies it as hermetic's own.
 */
export const HERMES_LEGACY_DASHBOARD_UNIT = "hermes.service";

/**
 * The two loopback ports an agent box listens on, and the reason they are
 * constants rather than four literals.
 *
 * `HERMES_DASHBOARD_PORT` is what `hermes dashboard` binds (`--port`, on the
 * rendered unit). `HERMES_PROXY_PORT` is what nginx listens on and what
 * Tailscale Serve is pointed at; nginx proxies the second to the first,
 * rewriting `Host`/`Origin` so Hermes stays in its unauthenticated local mode
 * (§6.4).
 *
 * They were spelled out at five sites across two packages — the unit's
 * `ExecStart`, nginx's `listen`, its `proxy_pass`, its two rewritten headers,
 * Serve's route target, and hermeticd's health URL — with nothing tying them
 * together. Each of those is one half of a pair that only works when both halves
 * agree, and this repo has just spent a day on what happens when two halves of a
 * contract are kept in step by hand. Moving the dashboard's port would have been
 * a cross-package edit with nothing to catch a miss.
 *
 * In `schema/` because `agentd` may import this and nothing else of core's, and
 * its health probe needs the same number the laptop rendered.
 */
export const HERMES_DASHBOARD_PORT = 9119;
export const HERMES_PROXY_PORT = 9120;
/**
 * hermetic's half of the gateway unit. A drop-in rather than a rendered unit,
 * because the file above belongs to upstream: this is how the fleet's tmpfs
 * secrets, the `docker` group and the ordering against
 * `hermetic-secrets.service` reach a unit hermetic did not write, without
 * hermetic having an opinion about its `ExecStart`.
 */
export const HERMES_GATEWAY_DROPIN = `/etc/systemd/system/${HERMES_GATEWAY_UNIT}.d/hermetic.conf`;
/**
 * One number, stated twice: `LimitNOFILE` in `hermes-dashboard.service` and
 * `runtime.nofile_soft_limit` in the seeded config. Hermes raises its own soft
 * limit toward the latter and cannot exceed the former, so a disagreement means
 * one of the two is decorative. Upstream's own default, made explicit.
 */
export const HERMES_NOFILE_LIMIT = 4096;
