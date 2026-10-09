import { createHash } from "node:crypto";
import type {
  AgentConfig,
  HermesSettings,
  Provider,
  RenderedFile,
  SecretsMode,
  Size,
  TailscaleServe,
} from "../schema/index.ts";
import {
  AGENT_CONFIG_SCHEMA_VERSION,
  AgentConfig as AgentConfigSchema,
  DEFAULT_PROVIDER_KEY_SLOT,
  HERMES_DASHBOARD_UNIT,
  HERMES_GATEWAY_DROPIN,
  HERMES_GATEWAY_UNIT,
  HERMES_MANAGED_CONFIG,
  HERMES_PROVENANCE_PATH,
  HERMES_PROXY_PORT,
  HERMES_SEED_CONFIG,
  PROVIDERS,
  SIZES,
  browserIdentities,
  requiredCapabilities,
  splitHermesSettings,
} from "../schema/index.ts";
import {
  BROWSER_ENV_REFS,
  CHROME_APPARMOR_COMMAND,
  browserFiles,
  browserServeRoutes,
  browserUnits,
} from "./render-browser.ts";
import { HermeticError } from "../errors.ts";
import { archivePath, tarGz, type TarEntry } from "../release/tar.ts";
import {
  AGENT_PROFILE_PATH,
  APT_CONF_PATH,
  SUDOERS_PATH,
  agentProfile,
  aptConf,
  aptSources,
  hermeticNftablesUnit,
  nftablesRuleset,
  nginxConf,
  packages,
  sudoersGrant,
} from "./render-system.ts";
import {
  hermesManagedConfig,
  hermesSeedConfig,
  imageProvenance,
  seedCommands,
} from "./render-hermes.ts";
import {
  gatewayDropIn,
  hermesUnit,
  hermeticdUnit,
  providerKeyRef,
  secretsUnit,
} from "./render-units.ts";

// The constants the box-side modules own, kept reachable from here for every
// importer that always read them off `render.ts` (`index.ts` re-exports it).
export { APT_CONF_PATH, COMMAND_ALLOWLIST, SUDOERS_PATH } from "./render-system.ts";

/**
 * Rendering happens on the laptop, so the box never sees a template or a
 * variable (§6.4). Everything below emits *final* file content; `render.test.ts`
 * asserts no template markers survive into any rendered file. The box's own
 * files (`render-system.ts`), Hermes's configuration (`render-hermes.ts`), the
 * systemd units (`render-units.ts`) and the browser stack (`render-browser.ts`)
 * each render their own; this module assembles them into one agent's tarball.
 */

export interface RenderInput {
  name: string;
  size: Size;
  instance_type?: string;
  provider: Provider;
  secrets_mode: SecretsMode;
  hermes_version: string;
  /**
   * The upstream git tag/commit the box checks out. Hermes Agent has no PyPI
   * release, so the version alone cannot be installed; see `schema/manifest.ts`.
   */
  hermes_ref: string;
  /**
   * The pinned Chrome for Testing build this agent runs (§7.3).
   * Required, so that the one caller
   * that renders configurations cannot forget it for the agent that does;
   * nothing about it is emitted for an agent with no browsers.
   */
  chrome_ref: string;
  region: string;
  /** The fleet's tailnet (`_fleet.tailnet`). Serve publishes at `<cloud name>.<tailnet>`. */
  tailnet: string;
  /**
   * What the operator said about Hermes itself (§6.4). Absent means they said
   * nothing, which is a complete answer: the provider's default model and the
   * fleet defaults are seeded and hermetic manages none of it.
   */
  hermes?: HermesSettings | null | undefined;
  /**
   * The fleet's answers this agent was created with (`Agent.seed`): they fill
   * whatever `hermes` leaves unstated, and they can only reach the *seed* file
   * — see `splitHermesSettings`. Absent on rows written before fleet settings
   * existed, and the provider catalog's default is then the fallback, which is
   * what those rows have always rendered.
   */
  seed?: HermesSettings | null | undefined;
  /**
   * The instance secret slot hermeticd materialises this agent's provider key
   * from (§8.3). Absent renders `provider-key`, which is the slot every agent
   * created before provider profiles has and the one an older hermeticd reads.
   */
  provider_key_ref?: string | undefined;
}

export interface RenderedAgentConfig {
  manifest: AgentConfig;
  /** The files that go into the tarball, manifest included. */
  files: RenderedFile[];
  /** SHA-256 over the canonical tarball content — the row's `config_hash`. */
  config_hash: string;
  /** `config/<name>/<hash>.tgz` */
  key: string;
  /** A real gzipped ustar archive: `manifest.json` plus every rendered file. */
  tarball: Uint8Array;
}

function tailscaleServeConfig(): TailscaleServe {
  // Serve targets the proxy, not Hermes: 9120 is nginx, which rewrites `Host`
  // and `Origin` to loopback so Hermes stays in its unauthenticated local mode
  // instead of rejecting Serve's `Host` header (`nginxConf`).
  const routes = [
    {
      path: "/",
      target: `http://127.0.0.1:${String(HERMES_PROXY_PORT)}`,
      description: "Hermes dashboard, through the loopback proxy",
    },
  ];
  // One route per browser identity, pointed at that identity's websockify and
  // never at its CDP port (`browserServeRoutes`).
  routes.push(...browserServeRoutes(browserIdentities()));
  /**
   * No `hostname`. It was informational — the URL a head could link to — and
   * nothing consumed it: the Serve commands name only the local target, on the
   * node's own identity, and every head builds the URL from the agent row
   * instead (`agentHostname`), which is the name the node actually answered on.
   *
   * Leaving it out keeps the fleet's name out of `config_hash`, so renaming a
   * fleet does not re-render and restart every agent on it for a field nothing
   * reads.
   */
  return { enabled: true, routes };
}

/**
 * A Serve path is pasted straight into a `/bin/sh -c` string on the box
 * (`apply.ts`), so it may only ever be a plain URL path. Today's routes are
 * literals a few lines up, so this is a guard against a future caller rather
 * than a behaviour change.
 */
const SERVE_PATH = /^\/[A-Za-z0-9._/-]*$/;

/**
 * `tailscale serve reset` first, then one set command per route. Tailscale
 * removed the hidden `--set-raw` flag (it fails with `flag provided but not
 * defined: -set-raw` on current releases), and `serve set-config` is for
 * Tailscale *Services*, not a node's own Serve — so the per-route flag form is
 * the supported surface.
 *
 * Per-route sets only ever *add*, though, which is why the reset leads: it is
 * what keeps the manifest authoritative in both directions, the way the old
 * whole-config write was. Without it, `agents.set --browser false` plus a
 * rerun would leave `/vnc` still published, and any serve or funnel state set
 * out of band on the box would survive an apply. The sub-second blip is
 * acceptable — apply runs at bootstrap, rerun and upgrade, not continuously.
 *
 * `--bg` persists the config; `--yes` answers the prompt the runner has no TTY
 * to answer. `timeout` is for a tailnet with HTTPS certificates disabled:
 * there the CLI prints an enable link and then *waits* for an admin instead of
 * failing, and the stage runner has no timeout of its own, so the agent would
 * sit at 95% forever. A failed stage is recoverable; a stuck one is not. The
 * §4.7 preflight catches this on the laptop now — this is the belt for boxes
 * created before it existed. The reset needs no timeout: it does not prompt.
 */
export function serveCommands(serve: TailscaleServe): string[] {
  const set = serve.routes.map((r) => {
    if (!SERVE_PATH.test(r.path)) {
      throw new HermeticError("VALIDATION", `not a usable Tailscale Serve path: ${r.path}`, {
        path: r.path,
      });
    }
    // The root route takes the documented bare form; `--set-path=/` is not a
    // spelling we have verified on a node.
    const path = r.path === "/" ? "" : `--set-path=${r.path} `;
    return `timeout 120 tailscale serve --bg --yes --https=443 ${path}'${r.target}'`;
  });
  return ["tailscale serve reset", ...set];
}

const TEMPLATE_MARKERS = ["{{", "$" + "{"] as const;

/**
 * The one legitimate `${…}` in a rendered file: a systemd template unit
 * expanding a variable out of its `EnvironmentFile` at start.
 *
 * Stripped before the marker scan rather than exempting whole files, so a
 * genuinely half-rendered `${input.name}` in a browser unit still fails. The
 * names are the browser stack's (`BROWSER_ENV_REFS`); a unit that starts
 * reading a variable adds it there, in the same edit that renders it.
 */
const SYSTEMD_ENV_REFERENCE = new RegExp("\\$\\{(?:" + BROWSER_ENV_REFS.join("|") + ")\\}", "g");

/**
 * The files the strip above applies to: systemd **template** units, whose
 * instances expand those names out of an `EnvironmentFile` at start.
 *
 * Scoped by path rather than applied everywhere because everywhere is a hole: a
 * `${DISPLAY}` left in a shell script, a config file or an ordinary unit is a
 * template literal that failed to interpolate, and stripping the name there
 * would let it through the scan silently. Nothing but a template unit has a
 * runtime that expands these.
 */
const TEMPLATE_UNIT_PATH = /^\/etc\/systemd\/system\/[^/]+@\.service$/;

/**
 * The manifest quotes the body of every file it ships, so it carries those same
 * template units verbatim and has to be exempt too — but for a different
 * reason, and a safe one: every file embedded in it is also in the list below
 * on its own, where the strict rule applies. A half-rendered file cannot hide
 * inside the document that carries it.
 */
const MANIFEST_PATH = "/etc/hermetic/manifest.json";

/** Guard against a half-rendered file reaching the box. */
export function assertFullyRendered(files: readonly RenderedFile[]): void {
  for (const f of files) {
    const exempt = TEMPLATE_UNIT_PATH.test(f.path) || f.path === MANIFEST_PATH;
    const content = exempt ? f.content.replace(SYSTEMD_ENV_REFERENCE, "") : f.content;
    for (const marker of TEMPLATE_MARKERS) {
      if (content.includes(marker)) {
        throw new Error(`rendered file ${f.path} still contains a template marker: ${marker}`);
      }
    }
  }
}

function canonical(value: unknown): string {
  return JSON.stringify(value, (_k, v) => {
    if (v && typeof v === "object" && !Array.isArray(v)) {
      return Object.fromEntries(
        Object.entries(v as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : 1)),
      );
    }
    return v;
  });
}

/**
 * Render every final file for one agent plus the `manifest.json` hermeticd
 * validates, and hash the result into `config_hash` (§6.2 step 5).
 */
export function renderAgentConfig(input: RenderInput): RenderedAgentConfig {
  const instance_type = input.instance_type ?? SIZES[input.size].instance_type;
  const serve = tailscaleServeConfig();
  /**
   * Exactly one today, named `default` (§H). Every port, display and path the
   * browser stack uses is derived from this list, so the units, the Serve
   * routes, the managed config and the manifest cannot disagree about where a
   * browser is.
   */
  const browsers = browserIdentities();
  /**
   * The resolved seed, for the one field of it the manifest carries.
   *
   * Resolved rather than read off `input.hermes`, because the operator may have
   * said nothing: the answer that reaches the box is the fleet's seed or
   * `HERMES_DEFAULTS`, and an expectation the box checks has to be the value it
   * was actually sent (`splitHermesSettings`). `render-hermes.ts` splits again
   * for the files it writes — the split is a pure function of the same three
   * inputs, so the two agree by construction, and threading one result through
   * every renderer would couple them for no gain.
   */
  const { seed: hermesSeed } = splitHermesSettings(
    input.hermes,
    PROVIDERS[input.provider].default_model,
    input.seed,
  );

  const files: RenderedFile[] = [
    { path: "/etc/hermetic/nftables.hermetic.nft", mode: "0644", content: nftablesRuleset() },
    {
      path: "/etc/systemd/system/hermetic-nftables.service",
      mode: "0644",
      content: hermeticNftablesUnit(),
    },
    /**
     * Root-owned, group `hermes`, 0640: readable by the service and writable by
     * nobody but root.
     *
     * That is not what makes this the managed scope — Hermes picks the managed
     * directory purely by path (`$HERMES_MANAGED_DIR`, else `/etc/hermes`) and
     * checks no ownership anywhere, so it would honour this file whoever owned
     * it. The mode earns its keep for the other reason: it stops the *agent
     * user* rewriting the half of the configuration hermetic holds, which is
     * the difference between a managed key and a suggestion.
     *
     * `restart_units` because both Hermes units read this file and neither is
     * this file — see `RenderedFile.restart_units`. Without it, `agent set
     * --model` followed by an apply would write the new model and leave the old
     * one running. Both, because config is read at start and the two processes
     * start independently: a dashboard on the new model and a gateway still
     * answering messages on the old one is the worse half of that bug.
     */
    {
      path: HERMES_MANAGED_CONFIG,
      mode: "0640",
      content: hermesManagedConfig(input),
      owner: "root",
      group: "hermes",
      restart_units: [HERMES_DASHBOARD_UNIT, HERMES_GATEWAY_UNIT],
    },
    /**
     * The seed is not read by anything at run time — a post-step installs it
     * once (`seedCommands`) — so it needs no group and no restart hook. It is
     * root-owned and root-readable for the same reason every other file in
     * `/etc/hermes` is: only root writes this directory, and a mode nobody
     * needs is a mode not worth granting.
     */
    { path: HERMES_SEED_CONFIG, mode: "0644", content: hermesSeedConfig(input) },
    /**
     * World-readable on purpose: it is a statement *about* the box, it holds
     * nothing secret, and upstream reads it as whichever user is running
     * (`hermes update` from the dashboard runs as `hermes`). A mode that hid it
     * from the agent would turn a refusal into an unreadable marker, which
     * upstream also treats as image-managed — but for the wrong reason, and
     * with an `error` in every diagnostic that reads it.
     */
    { path: HERMES_PROVENANCE_PATH, mode: "0644", content: imageProvenance(input) },
    {
      path: `/etc/systemd/system/${HERMES_DASHBOARD_UNIT}`,
      mode: "0644",
      content: hermesUnit(input),
    },
    /**
     * The gateway's unit is not in this list and never will be: `hermes gateway
     * install --system` writes it (`apply.ts`'s `ensureGatewayUnit`). This is
     * the drop-in beside it — see `gatewayDropIn`.
     */
    {
      path: HERMES_GATEWAY_DROPIN,
      mode: "0644",
      content: gatewayDropIn(input),
      restart_units: [HERMES_GATEWAY_UNIT],
    },
    { path: "/etc/systemd/system/hermeticd.service", mode: "0644", content: hermeticdUnit(input) },
    // Root-owned and world-readable: nginx reads it as root before dropping to
    // `www-data`, and it holds nothing secret (see `nginxConf`).
    { path: "/etc/nginx/nginx.conf", mode: "0644", content: nginxConf() },
    /**
     * `0440 root:root` is what sudo demands: it refuses any file in
     * `sudoers.d` that is group- or world-writable, and refuses the *whole*
     * ruleset when one of them is malformed. hermeticd therefore stages this
     * one and runs `visudo -c` over it before it ever reaches this path —
     * see `apply.ts`.
     */
    { path: SUDOERS_PATH, mode: "0440", content: sudoersGrant(), owner: "root", group: "root" },
    // Read by every apt on the box, including one hermeticd did not start.
    { path: APT_CONF_PATH, mode: "0644", content: aptConf() },
    // Sourced by `/etc/profile`; root's and world-readable, holds nothing secret.
    { path: AGENT_PROFILE_PATH, mode: "0644", content: agentProfile() },
  ];

  /**
   * `nginx.service` last: it is the only listener Serve talks to, and the units
   * phase of `hermeticd apply` walks this list in order, so the proxy comes up
   * after the upstream it proxies. Every unit here is enabled and (re)started
   * before the `commands` phase runs `tailscale serve`, so the 9120 target is
   * live by the time Serve is pointed at it.
   *
   * Unlike the others there is no rendered unit *file* for nginx — the Ubuntu
   * package ships its own — so apply's "restart only what changed" rule cannot
   * see a changed `nginx.conf`. That is what the `nginx -t` command below is
   * for; the name here is what enables it at boot.
   */
  const units = [
    "hermetic-nftables.service",
    "hermeticd.service",
    HERMES_DASHBOARD_UNIT,
    // Upstream's, and listed here for the same reason `nginx.service` is: apply
    // enables and starts what the manifest names, whoever wrote the file.
    HERMES_GATEWAY_UNIT,
    "nginx.service",
  ];

  /**
   * The browser stack, ahead of the Hermes units in `units` for the same reason
   * nginx is behind them: apply walks the list in order, and Hermes attaches to
   * a CDP endpoint that should already be answering when it starts.
   */
  files.push(...browserFiles(browsers, input.chrome_ref));
  units.unshift(...browserUnits(browsers));

  // Unconditional: see `secretsUnit`. Every agent gets the tmpfs env file.
  files.push({
    path: "/etc/systemd/system/hermetic-secrets.service",
    mode: "0644",
    content: secretsUnit(input),
  });
  units.unshift("hermetic-secrets.service");

  /**
   * `hermes` is a system user, created before anything references it (§7.1) —
   * and *before* is the whole content of that sentence, which is why the
   * account is not in this list any more. `commands` is apply's last phase: it
   * runs after `units`, and the units phase starts `hermes-dashboard.service`, which runs
   * as `hermes`. Asking for the account here meant asking for it after the unit
   * that needs it, and a first boot failed `217/USER` for exactly that reason.
   * hermeticd's own `ensureAccounts` step (`packages/agentd/src/apply/accounts.ts`)
   * creates the account, the `docker` group and `$HERMES_HOME` before either
   * files or units, so the claim above is true rather than aspirational.
   *
   * Every command that remains here is idempotent; `apply` re-runs the whole
   * list every time it runs.
   */
  const ownedFiles = files.filter((f) => f.owner !== undefined);
  const commands = [
    // Re-assert ownership, so the order in which the apply step writes files
    // cannot leave a file Hermes cannot read.
    ...ownedFiles.map(
      (f) => `chown ${f.owner}:${f.group ?? f.owner} ${f.path} && chmod ${f.mode} ${f.path}`,
    ),
    // hermetic-nftables.service (in `units`) loads this on boot and on
    // restart; this immediate load seals the box the moment apply runs too,
    // without waiting for a unit restart.
    "nft -f /etc/hermetic/nftables.hermetic.nft",
    /**
     * Load the Chrome AppArmor profile. The browser unit loads it too, in an
     * `ExecStartPre` — this is the copy that runs where a failure is reported:
     * a failed command fails the apply with its stderr attached, where a failed
     * `ExecStartPre` is a unit quietly restarting every five seconds.
     */
    CHROME_APPARMOR_COMMAND,
    ...seedCommands(input),
    /**
     * The proxy's config is not a unit file, so apply's units phase will never
     * restart nginx for it (it restarts only units whose own file changed).
     * This is the manifest author's job, exactly as `apply.ts` says. `nginx -t`
     * first so a config we got wrong fails the apply loudly instead of leaving
     * a proxy that will not come back after the next reboot; `restart` rather
     * than `reload` because it also *starts* nginx on a box where the units
     * phase only enabled it.
     */
    "nginx -t && systemctl restart nginx.service",
    ...serveCommands(serve),
  ];

  assertFullyRendered(files);

  const unhashed = {
    schema_version: AGENT_CONFIG_SCHEMA_VERSION,
    name: input.name,
    size: input.size,
    instance_type,
    provider: input.provider,
    secrets_mode: input.secrets_mode,
    hermes_version: input.hermes_version,
    hermes_ref: input.hermes_ref,
    /**
     * Always named, for the reason `chrome_ref` is: optional on the *document*
     * so a manifest rendered before the field keeps parsing, not so a render can
     * leave it out. `splitHermesSettings` resolves an answer for every agent, so
     * every manifest this build emits states the mode `verify-hermes` should
     * find (`schema/manifest.ts`).
     */
    approvals_mode: hermesSeed.approvals_mode,
    /**
     * Both always named now. They are optional on the *document* because a
     * manifest written before the browser stack is still installed on boxes and
     * has to keep parsing (`schema/manifest.ts`), not because a render can omit
     * them: every agent runs a browser, so every manifest this build emits says
     * which build and which identities.
     */
    chrome_ref: input.chrome_ref,
    browsers,
    packages: packages(input),
    apt_sources: aptSources(input.secrets_mode),
    files,
    units,
    commands,
    tailscale_serve: serve,
    /**
     * **Omitted when it is the slot every hermeticd already reads.**
     *
     * The field is in `config_hash` (`schema/manifest.ts`), which is what makes
     * a key rotation something a rollout can carry — and which is exactly why
     * it must not be emitted where it says nothing. Writing `provider-key` on
     * every document would have re-hashed every agent config in every fleet on
     * the day this landed, reporting fleet-wide drift for a statement about the
     * configuration rather than a change to it. Absent means `provider-key`, on
     * the box and here (`providerKeyRefOf`).
     */
    ...(providerKeyRef(input) === DEFAULT_PROVIDER_KEY_SLOT
      ? {}
      : { provider_key_ref: providerKeyRef(input) }),
  };

  const config_hash = createHash("sha256").update(canonical(unhashed)).digest("hex").slice(0, 16);
  /**
   * Outside the hash, with `config_hash` itself and for the same reason: it is
   * *derived* from the document above rather than part of it, so hashing it
   * would say nothing new — and would have re-hashed every agent config in every
   * fleet on the day this field landed, reporting a fleet-wide drift for a
   * statement about the config rather than a change to it.
   */
  const requires = requiredCapabilities(unhashed);
  const manifest = AgentConfigSchema.parse({
    ...unhashed,
    config_hash,
    ...(requires.length === 0 ? {} : { requires }),
  });

  const manifestFile: RenderedFile = {
    path: MANIFEST_PATH,
    mode: "0644",
    content: JSON.stringify(manifest, null, 2) + "\n",
  };

  /**
   * A real gzipped ustar archive (§6.2 step 5): `manifest.json` at the root,
   * where `hermeticd` reads it after `tar -xzf … -C /etc/hermetic`, plus every
   * rendered file at its path relative to `/`. Deterministic — fixed mtime and
   * ownership — so the bytes are a function of the configuration alone.
   */
  const entries: TarEntry[] = [
    { path: "manifest.json", mode: "0644", content: manifestFile.content },
    ...files.map((f) => ({ path: archivePath(f.path), mode: f.mode, content: f.content })),
  ];
  const tarball = tarGz(entries);

  return {
    manifest,
    files: [...files, manifestFile],
    config_hash,
    key: "config/" + input.name + "/" + config_hash + ".tgz",
    tarball,
  };
}
