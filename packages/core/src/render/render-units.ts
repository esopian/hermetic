/**
 * The systemd units hermetic owns on a box — `hermes-dashboard.service`,
 * hermeticd's, the secrets oneshot — and hermetic's drop-in for upstream's
 * gateway unit. Final file content, no templating — see `render.ts`.
 */
import {
  DEFAULT_PROVIDER_KEY_SLOT,
  HERMES_DASHBOARD_PORT,
  HERMES_DASHBOARD_UNIT,
  HERMES_HOME,
  HERMES_LAZY_TARGET,
  HERMES_NOFILE_LIMIT,
  HERMES_REVISION_ENV,
  HERMES_TUI_DIR,
  HERMES_USER_PREFIX,
  HERMES_WEB_DIST_DIR,
  PROVIDERS,
  browserIdentities,
  chromeBinaryPath,
  isProviderKeySlot,
} from "../schema/index.ts";
import type { RenderInput } from "./render.ts";

function unit(
  description: string,
  body: string[],
  wantedBy = "multi-user.target",
  unitExtra: string[] = [],
): string {
  return [
    "# Rendered by hermetic. Final file, no templating.",
    "[Unit]",
    "Description=" + description,
    "After=network-online.target",
    "Wants=network-online.target",
    ...unitExtra,
    "",
    "[Service]",
    ...body,
    "",
    "[Install]",
    "WantedBy=" + wantedBy,
    "",
  ].join("\n");
}

/**
 * Everything both Hermes units need in order to *run the same agent* — stated
 * once, because the two would otherwise drift.
 *
 * There are two of them and only one of them is hermetic's: `hermes-dashboard.service`
 * (the dashboard) is rendered below, and `hermes-gateway.service` (the channels
 * and the cron runner) is written by `hermes gateway install --system`, which
 * knows nothing about this fleet's tmpfs secrets file, its `docker` group or
 * its `hermetic-secrets.service`. The gateway gets these lines through a
 * drop-in instead (`HERMES_GATEWAY_DROPIN`). Same environment, same ordering,
 * one source.
 */
interface HermesRuntime {
  /** `[Unit]` lines. */
  ordering: string[];
  /** `[Service]` lines. */
  service: string[];
}

function hermesRuntimeLines(input: RenderInput): HermesRuntime {
  const service = [
    /**
     * No dashboard environment at all — no public URL, no credentials. Hermes
     * stays in its unauthenticated local mode and the loopback nginx in front
     * of it makes Serve's requests look local (`nginxConf`). The tmpfs
     * environment file is still required unconditionally: hermeticd always
     * writes it, and a keyed provider's API key arrives through it (§6.4,
     * §8.1).
     *
     * What an `EnvironmentFile` does *not* do is win. Upstream loads the user's
     * `$HERMES_HOME/.env` with `override=True`
     * (`hermes_cli/env_loader.py:362-365`), which writes those values *into*
     * `os.environ` at load, and the api-key path is dotenv-first on top of that
     * (`get_env_value_prefer_dotenv`, `hermes_cli/config.py:2698-2701`; used by
     * `get_anthropic_key`, `hermes_cli/auth.py:293-303`, whose docstring says it
     * prefers `.env` so a deliberate rotation is not shadowed by a stale
     * export). So any key an agent, `hermes setup` or the dashboard's key field
     * writes into its own `.env` outranks the one hermetic delivered from SSM,
     * permanently and silently.
     *
     * The one channel that wins outright is the managed `/etc/hermes/.env`,
     * applied last with override (`env_loader.py:423-438`), and hermetic must
     * not use it: upstream states it is mode 0644 and world-readable and to
     * keep high-sensitivity secrets out of it
     * (`website/docs/user-guide/managed-scope.md:141-143`) — which is the same
     * reasoning that puts hermetic's key on tmpfs in the first place. Stripping
     * the agent's `.env` is not an option either: after first boot that file is
     * the agent's own (§6.4).
     *
     * So the delivery stays an `EnvironmentFile` and the precedence is asserted
     * instead: `verify-hermes` fails the boot if `$HERMES_HOME/.env` names the
     * managed provider's key variable (`packages/agentd/src/hermes-check.ts`).
     */
    "EnvironmentFile=/run/hermetic/secrets.env",
    /**
     * `HERMES_REVISION`, written by hermeticd once it knows which upstream
     * commit this box's checkout came from (`HERMES_REVISION_ENV`).
     *
     * Optional — the `-` prefix — and that is the whole reason it is a file and
     * not an `Environment=` line: core renders this unit before any checkout
     * exists, and the value is a property of the install, not of the config.
     * A box that has not written it yet starts exactly as it did before.
     *
     * What it buys is a truthful answer from the one upstream surface hermetic
     * cannot render away. `/etc/hermes/image-provenance.json` already makes
     * `POST /api/hermes/update` refuse to *apply* one (§6.5), but the
     * dashboard's `GET /api/hermes/update/check` consults no marker: it calls
     * `check_for_updates()`, which without `HERMES_REVISION` interrogates the
     * local checkout — a synthesized root commit on every mirror-installed box.
     * Every branch of that fails, and the dashboard renders the failure as
     * *"Couldn't reach the update source — try again later."*, which names the
     * network for a fault that is entirely local. With the variable set the
     * check compares a real upstream sha to `main` over the GitHub API and
     * says something true.
     */
    "EnvironmentFile=-" + HERMES_REVISION_ENV,
    "SupplementaryGroups=docker",
    /**
     * The agent installs its own packages — the sudoers grant lets it run
     * anything (`sudoersGrant`), apt included — and a debconf prompt on a box
     * with nobody at the keyboard is a hung command, not a question.
     * `sudo` scrubs the environment, so this variable only survives the hop
     * because the sudoers file `env_keep`s it — the two lines are one mechanism
     * and neither works alone.
     */
    "Environment=DEBIAN_FRONTEND=noninteractive",
    /**
     * On-demand installs, redirected out of the venv — upstream's own container
     * recipe, both lines of it (`Dockerfile:430` and `:443`).
     *
     * Upstream installs a handful of optional backends at first use —
     * `tools/lazy_deps.py`'s `LAZY_DEPS` table covers search, TTS/STT, wake
     * word, OTLP, memory providers — plus plugin dependencies, all deliberately
     * outside `[all]` so they resolve on demand. The venv is root's and the
     * process is `hermes`, so an install *into the venv* would be an EACCES in
     * the middle of a tool call. The disable flag forbids exactly that, and
     * only that: with a target named, `_allow_lazy_installs` allows installs
     * into the target (`lazy_deps.py:325-337`), which `uv pip install --target`
     * fills under a constraints file pinning every core distribution, and which
     * Hermes appends to the end of `sys.path` at startup so core always wins.
     *
     * The target is the account's (`HERMES_LAZY_TARGET`, under `$HERMES_HOME`),
     * so it survives a recreate. Upstream stamps it with the interpreter's ABI
     * and empties it itself when that moves; a bumped pin in `LAZY_DEPS` is
     * reinstalled on next use. The cost, accepted: a box's Python closure is
     * the pinned `hermes_ref` *plus* whatever its features asked for, fetched
     * from PyPI at the time.
     */
    "Environment=HERMES_DISABLE_LAZY_INSTALLS=1",
    "Environment=HERMES_LAZY_INSTALL_TARGET=" + HERMES_LAZY_TARGET,
    /**
     * `npm install -g` into the account's own prefix rather than Node's, which
     * is root's (`HERMES_USER_PREFIX`). On both units because an agent's shell
     * is a child of whichever one is serving the conversation — the dashboard
     * for its own chat, the gateway for Slack and the other platforms. A plain
     * `sudo` scrubs it, so a root install still goes where root's would.
     */
    "Environment=NPM_CONFIG_PREFIX=" + HERMES_USER_PREFIX,
    // The ceiling Hermes raises its own soft limit toward; `runtime.nofile_soft_limit`
    // in the seeded config is the number it asks for, and the two are the same
    // number on purpose.
    "LimitNOFILE=" + String(HERMES_NOFILE_LIMIT),
  ];
  const browsers = browserIdentities();
  const primary = browsers[0];
  if (primary !== undefined) {
    // The display Hermes's own subprocesses draw on — a screenshot tool, or a
    // browser an operator launched by hand from a Hermes shell.
    service.push("Environment=DISPLAY=:" + String(primary.display));
    /**
     * Where upstream's agent-browser finds a Chrome, for the paths that still
     * launch one rather than attaching to `browser.cdp_url`. It is the one
     * seam of the four with no config form (`browser_tool.py:6033`), which is
     * why it is here and the other three are in the managed config.
     */
    service.push("Environment=AGENT_BROWSER_EXECUTABLE_PATH=" + chromeBinaryPath(input.chrome_ref));
  }
  if (PROVIDERS[input.provider].auth === "role") {
    /**
     * Bedrock is the one provider that authenticates as the instance, and the
     * one that therefore needs to be told *where*. Hermes resolves its Bedrock
     * region from `AWS_REGION`, then `AWS_DEFAULT_REGION`, and a systemd unit
     * inherits neither: the instance's region is in instance metadata, which is
     * not the environment. Without this a bedrock agent reaches whatever region
     * botocore falls back to, where the fleet's role grants nothing — the same
     * "healthy box, refuses the first message" failure the provider mapping
     * above exists to prevent, one layer down.
     */
    service.push(
      "Environment=AWS_REGION=" + input.region,
      "Environment=AWS_DEFAULT_REGION=" + input.region,
    );
  }
  // The tmpfs environment file must exist before either process starts (§6.4).
  return { ordering: ["After=hermetic-secrets.service", "Requires=hermetic-secrets.service"], service };
}

/**
 * hermetic's half of upstream's gateway unit.
 *
 * Deliberately not a unit file: `/etc/systemd/system/hermes-gateway.service` is
 * written by `hermes gateway install --system`, and rendering our own would put
 * the gateway's `ExecStart` — the venv python, the module path, the verb — into
 * hermetic's hands, where a Hermes upgrade could silently invalidate it.
 * `hermes_ref` pins how the gateway is supervised precisely because the unit is
 * upstream's (§6.6).
 *
 * `restart_units` because a drop-in is not the unit's *own* file, so apply's
 * "restart only what changed" rule would never see it — the same reason the
 * managed config declares its dependents.
 */
export function gatewayDropIn(input: RenderInput): string {
  const runtime = hermesRuntimeLines(input);
  return [
    "# Rendered by hermetic. Final file, no templating.",
    "#",
    "# The unit itself is upstream's (`hermes gateway install --system`).",
    "# This is only what hermetic has to add to it.",
    "[Unit]",
    ...runtime.ordering,
    "",
    "[Service]",
    ...runtime.service,
    "",
  ].join("\n");
}

export function hermesUnit(input: RenderInput): string {
  const runtime = hermesRuntimeLines(input);
  const body = [
    "Type=simple",
    "User=hermes",
    "Group=hermes",
    // `$HERMES_HOME`, matching upstream's own generated unit, which sets
    // `WorkingDirectory` to the Hermes root rather than to the account's home.
    "WorkingDirectory=" + HERMES_HOME,
    /**
     * `hermes dashboard`, not `hermes serve`. As of Hermes 0.21 `serve` is the
     * headless JSON-RPC backend and answers `/` with a 404 telling you to use
     * the dashboard; `dashboard` is the command that serves the browser SPA,
     * which is the whole point of publishing this port over Tailscale Serve.
     *
     * `--skip-build` because hermeticd builds the SPA as root during apply: the
     * `hermes` user cannot run npm in a root-owned install tree, and the build
     * needs Node ≥22 that apply provisions. `--no-open` because there is no
     * browser on the box to open. Neither command takes `--config`: config and
     * data are one tree at `$HERMES_HOME` (§6.4), and `/usr/local/bin/hermes`
     * is the symlink the official installer's FHS layout leaves behind.
     */
    "ExecStart=/usr/local/bin/hermes dashboard --no-open --skip-build --host 127.0.0.1 " +
      `--port ${String(HERMES_DASHBOARD_PORT)}`,
    "Restart=always",
    "RestartSec=5",
  ];
  // `HERMES_HOME` is upstream's single config-and-data root — `config.yaml`,
  // `.env`, `sessions/`, `memories/` all live under it. There is no separate
  // data dir to point at, so this is the only variable that decides where an
  // agent's state lands. Stated explicitly even though it is also the account's
  // default (`$HOME/.hermes`): a unit inherits no login shell, so `HOME` alone
  // would not get Hermes there.
  body.push("Environment=HERMES_HOME=" + HERMES_HOME);
  /**
   * Where the built SPA is, and where the prebuilt TUI is — told to the process
   * rather than left for it to infer.
   *
   * Both are upstream seams meant for image builders, and both replace a guess
   * that has already been wrong once. `HERMES_WEB_DIST`
   * (`hermes_cli/web_server.py:58`, `Dockerfile:373`) settles a path that is
   * *not* `web/dist` (`web/vite.config.ts:103`). `HERMES_TUI_DIR`
   * (`hermes_cli/main_tui_launch.py:562-572`, `Dockerfile:390`) stops the
   * dashboard's Chat tab npm-installing the TUI at first use as the `hermes`
   * user, into a root-owned tree, which cannot work on this box.
   *
   * On the dashboard unit only: the gateway serves neither surface.
   */
  body.push(
    "Environment=HERMES_WEB_DIST=" + HERMES_WEB_DIST_DIR,
    "Environment=HERMES_TUI_DIR=" + HERMES_TUI_DIR,
  );
  // Everything below is shared verbatim with the gateway's drop-in, so the two
  // Hermes processes cannot end up with different environments.
  body.push(...runtime.service);
  return unit(
    "Hermes agent (pinned " + input.hermes_version + ")",
    body,
    "multi-user.target",
    runtime.ordering,
  );
}

export function hermeticdUnit(input: RenderInput): string {
  // No version in the description: which hermeticd a box runs is a fleet-level
  // fact the fleet manifest moves (§1), not something pinned per agent config.
  return unit(
    "hermeticd node agent",
    [
      "Type=simple",
      "User=root",
      "ExecStart=/usr/local/bin/hermeticd serve",
      "Restart=always",
      "RestartSec=5",
      "Environment=HERMETIC_AGENT=" + input.name,
    ],
    "multi-user.target",
    // No start rate limit: systemd's default (5 starts in 10s) parks a
    // crash-looping unit in `failed` and stops restarting it, which on a bad
    // self-update would strand the box before hermeticd's own swap-settle
    // rollback ever got to run. `RestartSec=5` is the throttle here.
    ["StartLimitIntervalSec=0"],
  );
}

/**
 * The tmpfs `EnvironmentFile` and the oneshot unit that writes it are on
 * *every* agent, which is why there is no `hasSecretsFile` predicate. A bedrock
 * agent with `secrets_mode: none` has nothing to put in the file, but
 * `hermeticd secrets materialise` writes it anyway — empty if need be — so
 * `hermes-dashboard.service` can `Requires=` it unconditionally rather than the unit's
 * shape depending on a slot that can be filled or cleared long after the render
 * (§6.4, §8.1).
 */
/**
 * The comments naming where each secret comes from are deliberately
 * **fleet-independent**: they say "this fleet's SSM prefix" rather than
 * spelling the prefix out.
 *
 * Every byte of a rendered file is in `config_hash`, so a comment carrying the
 * fleet id would make two otherwise identical agents on two fleets render
 * differently, and would move the hash again the day a fleet was renamed or
 * re-scoped — a re-render, a re-upload and a `hermetic-secrets.service` restart
 * on every box, for a comment. The box does not learn its prefix from here in
 * any case: hermeticd reads `resources.param_prefix` out of the fleet manifest
 * (§4.2), which is the only place that has ever been authoritative.
 */
/**
 * The slot this agent's provider key comes from — the row's `credential_ref`
 * where it has one, else the slot every agent has always had.
 *
 * A role-authenticated provider answers with the default and therefore emits
 * nothing, which is correct rather than a gap: it has no key, hermeticd reads
 * the field only when the provider has a key variable at all, and an agent
 * moved *onto* Bedrock drops the field — which moves the hash, which is how the
 * box is told to stop materialising the key it no longer has.
 */
export function providerKeyRef(input: RenderInput): string {
  const ref = input.provider_key_ref;
  return ref !== undefined && isProviderKeySlot(ref) ? ref : DEFAULT_PROVIDER_KEY_SLOT;
}

export function secretsUnit(input: RenderInput): string {
  const sources: string[] = [];
  const slot = (name: string): string => `this fleet's SSM prefix + ${input.name}/${name}`;
  if (PROVIDERS[input.provider].auth === "api_key") {
    sources.push(
      "# " +
        PROVIDERS[input.provider].env +
        " is read from SSM at " +
        slot(providerKeyRef(input)) +
        " by hermeticd.",
    );
  }
  if (input.secrets_mode === "bitwarden") {
    sources.push("# The bws access token is read from SSM at " + slot("bws-token") + " by hermeticd.");
  }
  return unit(
    "Materialise " + input.name + "'s secrets into a tmpfs environment file",
    [
      "Type=oneshot",
      "RemainAfterExit=yes",
      "ExecStartPre=/usr/bin/install -d -m 0700 /run/hermetic",
      "ExecStart=/usr/local/bin/hermeticd secrets materialise --out /run/hermetic/secrets.env --mode 0600",
      ...sources,
    ],
    "multi-user.target",
    /**
     * `tailscaled` first, and `Before=hermes-dashboard.service`.
     *
     * Nothing `materialise` writes is derived from the tailnet any more: the
     * public URL it used to read out of `tailscale status` is gone, replaced by
     * the loopback proxy (`nginxConf`). The ordering stays because a boot in
     * which secrets land after the tailnet is up is the one this fleet has been
     * observed booting, and a soft `Wants=` on a unit that was starting anyway
     * buys that at no cost.
     *
     * `Wants=`, not `Requires=`: a box whose tailscaled failed still wants its
     * provider key materialised, and refusing to start the whole unit would
     * take Hermes down with it.
     */
    ["After=tailscaled.service", "Wants=tailscaled.service", `Before=${HERMES_DASHBOARD_UNIT}`],
  );
}
