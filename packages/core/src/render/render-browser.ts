/**
 * The browser stack of a `browser: true` agent, rendered (§7.3).
 *
 * One hermetic-owned headed Chrome per browser identity, drawing on its own
 * Xvfb display under a kiosk window manager, watched over x11vnc and websockify
 * and published at its own Tailscale Serve path — and driven by Hermes over a
 * loopback CDP endpoint rather than launched by it. Everything here runs as the
 * unprivileged `hermes` account, which is the account Hermes itself runs as and
 * therefore the one whose profile directory and X display both sides can reach.
 *
 * It is its own module for the reason `lifecycle.ts` and `teardown.ts` are:
 * `render.ts` is the file that keeps arriving at the 2500-line rule, and the
 * browser stack is the one part of a rendered configuration with no dependency
 * on the rest of it. Everything below is a pure function of the identities and
 * the pinned Chrome build; `render.ts` decides *whether* to call it.
 */
import { createHash } from "node:crypto";
import type { BrowserIdentity, RenderedFile } from "../schema/index.ts";
import { chromeBinaryPath } from "../schema/index.ts";

/**
 * What a browser agent installs from apt, and what it no longer does.
 *
 * `chromium-browser` is gone. On Ubuntu noble arm64 it is a transitional
 * package onto the **snap**, and snapd refuses a home outside `/home`, so the
 * shim dies as the `hermes` account with `cannot use invalid home directory
 * "/data/hermes"`. Worse than useless: upstream's own `_chromium_installed()`
 * probe finds it on `PATH` and reports a working browser. The browser this
 * agent runs is the pinned Chrome for Testing build the fleet mirrors
 * (`chrome_ref`), unpacked by a bootstrap stage.
 *
 * The rest is what that build needs in order to start at all. The snap used to
 * carry its own `.so` closure; a plain zip carries none, and the 16 library and
 * font packages below are `playwright install-deps --dry-run chromium` run on
 * the box, verbatim. The `t64` suffixes are noble's own (the 64-bit `time_t`
 * transition) and are why this list cannot be copied from an older guide.
 * Without them the browser unit is a `Restart=always` crash loop on a missing
 * library.
 *
 * `matchbox-window-manager` is the kiosk WM (§C): one maximised window, no root
 * menu — openbox's stock menu would offer a terminal launcher over an
 * unauthenticated VNC session. `x11-utils` is `xdpyinfo`/`xwininfo`, which the
 * probe layer and any hand debugging need. `unzip` unpacks the mirrored build.
 *
 * `apparmor` is on the stock noble image already, so installing it is normally a
 * no-op. It is listed because the browser unit's `ExecStartPre` and the
 * manifest's post-command both run `/usr/sbin/apparmor_parser`, and a binary
 * this render *assumes* is present belongs in the list that guarantees it —
 * without the profile Chrome cannot open a user namespace and the unit is a
 * restart loop on "No usable sandbox".
 */
export const BROWSER_PACKAGES = [
  "apparmor",
  "at-spi2-common",
  "fonts-freefont-ttf",
  "fonts-ipafont-gothic",
  "fonts-liberation",
  "fonts-noto-color-emoji",
  "fonts-tlwg-loma-otf",
  "fonts-unifont",
  "fonts-wqy-zenhei",
  "libatk-bridge2.0-0t64",
  "libatk1.0-0t64",
  "libatspi2.0-0t64",
  "libcups2t64",
  "libxcomposite1",
  "matchbox-window-manager",
  "novnc",
  "unzip",
  "x11-utils",
  "x11vnc",
  "xfonts-cyrillic",
  "xfonts-encodings",
  "xfonts-scalable",
  "xfonts-utils",
  "xvfb",
];

/** Where each identity's `EnvironmentFile` lives; `%i` names the file. */
export const BROWSER_ENV_DIR = "/etc/hermetic/browser";

/** The AppArmor profile that lets the pinned Chrome open a user namespace. */
export const CHROME_APPARMOR_PATH = "/etc/apparmor.d/hermetic-chrome";

/** noVNC's web root, which websockify serves with `--web`. */
export const NOVNC_WEB_ROOT = "/usr/share/novnc";

/** Where noble's `apparmor` package puts the parser. */
const APPARMOR_PARSER = "/usr/sbin/apparmor_parser";

/**
 * Load the rendered profile into the kernel. `-r` replaces a profile already
 * loaded, so this is idempotent and runs on every apply; `-T -W` skips the
 * read cache and writes a fresh one.
 */
const APPARMOR_PARSER_ARGS = `-r -T -W ${CHROME_APPARMOR_PATH}`;

/**
 * The manifest `command` that loads the profile. A post-step as well as the
 * browser unit's own `ExecStartPre`, because a command that fails fails the
 * apply loudly, where a failing `ExecStartPre` is a unit in a restart loop.
 */
export const CHROME_APPARMOR_COMMAND = `${APPARMOR_PARSER} ${APPARMOR_PARSER_ARGS}`;

/**
 * The variable names the template units expand out of their `EnvironmentFile`.
 *
 * Exported because `assertFullyRendered` has to tell a deliberate `${DISPLAY}`
 * from a JavaScript template literal that failed to interpolate — see its
 * comment. Anything not on this list is still a half-rendered file.
 */
export const BROWSER_ENV_REFS = [
  "DISPLAY",
  "CDP_PORT",
  "RFB_PORT",
  "WS_PORT",
  "PROFILE_DIR",
  "CHROME_BIN",
] as const;

/** The per-identity env file's path. `%i` in a template unit resolves to it. */
export function browserEnvPath(name: string): string {
  return `${BROWSER_ENV_DIR}/${name}.env`;
}

/** Every unit of one identity's stack, in start order. */
export function browserUnitsFor(identity: BrowserIdentity): string[] {
  const i = identity.name;
  return [
    `xvfb@${i}.service`,
    `hermetic-wm@${i}.service`,
    `x11vnc@${i}.service`,
    `novnc@${i}.service`,
    `hermetic-browser@${i}.service`,
  ];
}

/** Every browser unit of every identity, in start order. */
export function browserUnits(identities: readonly BrowserIdentity[]): string[] {
  return identities.flatMap(browserUnitsFor);
}

/**
 * The Serve routes the browser stack publishes: one per identity, pointed at
 * that identity's websockify.
 *
 * **Never a CDP port.** CDP is unauthenticated total control of the browser,
 * including local file reads, so it is bound to loopback by the unit and never
 * published by anything here — `render-network-invariants.test.ts` asserts both.
 */
export function browserServeRoutes(
  identities: readonly BrowserIdentity[],
): { path: string; target: string; description: string }[] {
  return identities.map((b) => ({
    path: b.serve_path,
    target: `http://127.0.0.1:${String(b.ws_port)}`,
    description: `noVNC (${b.name})`,
  }));
}

/**
 * The managed-config keys that point Hermes at the browser hermetic already
 * runs, rather than letting it launch one of its own (§A).
 *
 * Managed scope and not the unit's environment, deliberately: all three have a
 * config form, and upstream loads `$HERMES_HOME/.env` over the process
 * environment — so an env-only answer is one the agent's own `.env` can shadow
 * after first boot, silently, which is the hazard `hermes-check.ts` already
 * records for provider keys. A managed key cannot be edited away on the box.
 *
 * The first identity is the one Hermes is told about: `_get_cdp_override`
 * resolves one endpoint per process, so a second browser is the operator's to
 * watch, not the agent's to choose (§H, phase 0 check 8).
 */
export function browserManagedConfigLines(identities: readonly BrowserIdentity[]): string[] {
  const first = identities[0];
  if (first === undefined) return [];
  return [
    "browser:",
    // Hermes attaches to this endpoint instead of launching its own browser,
    // which is what makes the operator's noVNC session and the agent's tool
    // calls the same browser.
    `  cdp_url: ${yamlString(`http://127.0.0.1:${String(first.cdp_port)}`)}`,
    // Headed, because the point of the display is that a human can watch it.
    "  headed: true",
    // Chrome, not camoufox: the pinned build is the one the CDP endpoint is.
    "  engine: chrome",
  ];
}

/**
 * The template units, in the order they are written. One list rather than five
 * call sites because `browserTemplatesDigest` has to hash exactly the bodies
 * `browserFiles` writes — two lists would drift and the digest would stop
 * meaning anything.
 */
function browserTemplateUnits(chromeRef: string): { path: string; content: string }[] {
  return [
    { path: "/etc/systemd/system/xvfb@.service", content: xvfbTemplateUnit() },
    { path: "/etc/systemd/system/hermetic-wm@.service", content: wmTemplateUnit() },
    { path: "/etc/systemd/system/x11vnc@.service", content: vncTemplateUnit() },
    { path: "/etc/systemd/system/novnc@.service", content: novncTemplateUnit() },
    { path: "/etc/systemd/system/hermetic-browser@.service", content: browserTemplateUnit(chromeRef) },
  ];
}

/**
 * A short digest of every template unit body, stamped into each identity's env
 * file so that editing a template restarts the instances running it.
 *
 * `apply` restarts a unit whose *own* file changed, and the file of
 * `hermetic-browser@default.service` is `hermetic-browser@.service` — a path
 * `apply` never sees under that instance name, so a new Chrome flag or a changed
 * `ExecStartPre` lands on disk and the running browser keeps its old command
 * line until something else happens to restart it. The env file beside it *is*
 * per instance and does carry `restart_units`, so carrying the templates'
 * digest here is what turns any template edit into a restart of every instance.
 *
 * Truncated to 16 hex for the same reason `config_hash` is: this is a change
 * detector, not a signature.
 */
export function browserTemplatesDigest(chromeRef: string): string {
  const bodies = browserTemplateUnits(chromeRef)
    .map((u) => u.content)
    .join("\n");
  return createHash("sha256").update(bodies).digest("hex").slice(0, 16);
}

/**
 * Every file the browser stack adds to a rendered configuration.
 *
 * The template units are rendered once each — systemd instantiates them per
 * identity from `%i` — and everything identity-specific is in the env file
 * beside them, which is what makes a second browser a data change.
 */
export function browserFiles(
  identities: readonly BrowserIdentity[],
  chromeRef: string,
): RenderedFile[] {
  if (identities.length === 0) return [];
  const files: RenderedFile[] = [
    ...browserTemplateUnits(chromeRef).map((u) => ({ ...u, mode: "0644" as const })),
    /**
     * World-readable and holding nothing secret: display numbers, loopback
     * ports and two paths. It is read by systemd as root before the units drop
     * to `hermes`, and by anyone debugging the stack by hand.
     */
    { path: CHROME_APPARMOR_PATH, mode: "0644", content: chromeApparmorProfile() },
  ];
  for (const identity of identities) {
    files.push({
      path: browserEnvPath(identity.name),
      mode: "0644",
      content: browserEnvFile(identity, chromeRef),
      /**
       * The one hook that reaches a template *instance*.
       *
       * `apply` restarts a unit whose own file changed, and a template
       * instance's own file is the template — so a port or a Chrome build that
       * moves in this file would otherwise land on disk and leave the running
       * instances on the old values. The file that is rendered per identity is
       * the one that can name them.
       */
      restart_units: browserUnitsFor(identity),
    });
  }
  const web = identities.find((b) => b.serve_path === "/vnc");
  if (web !== undefined) {
    /**
     * The client `/vnc` serves. Ubuntu's `novnc` package ships `vnc.html` and
     * no `index.html` at all, so without this the path is a websockify
     * directory listing.
     *
     * One file, for the identity published at the web root: websockify's
     * `--web` root is shared by every instance, so a second identity needs its
     * own root before it can have its own landing page (§H). Its `path=` still
     * names its own Serve path, which is why this is a function of the identity
     * rather than a constant.
     */
    files.push({
      path: `${NOVNC_WEB_ROOT}/index.html`,
      mode: "0644",
      content: novncIndexHtml(web.serve_path),
    });
  }
  return files;
}

/**
 * The redirect `/vnc` answers with.
 *
 * noVNC builds its websocket URL from the **site root** — `wss://<host>/<path>`
 * with `path` defaulting to `websockify` (`app/ui.js`, `UI.connect`) — so it
 * ignores the prefix Serve published it under and dials `wss://<host>/websockify`,
 * which is the `/` route, which is nginx and then Hermes: HTTP 200, no upgrade,
 * "Failed to connect to server". Naming `path=` explicitly is the fix, and it is
 * why this page exists rather than a symlink to `vnc.html`.
 *
 * The target is an **absolute path and names no host**. Relative would resolve
 * against `/vnc` without its trailing slash and land at `/vnc.html` on the site
 * root, which is the Hermes SPA; a host would hard-code a name this render does
 * not know and must never guess (`render-network-invariants.test.ts` asserts
 * it). The `<a>` is for the browser that honours no meta refresh.
 */
export function novncIndexHtml(servePath: string): string {
  // `vnc/websockify` for `/vnc`, `vnc/<name>/websockify` for anything else:
  // noVNC resolves `path` against the site root, so it takes no leading slash.
  const wsPath = `${servePath.replace(/^\//, "")}/websockify`;
  const target =
    `${servePath}/vnc.html?path=${wsPath}&autoconnect=true&resize=scale&reconnect=true` as const;
  return [
    "<!doctype html>",
    // Rendered by hermetic, in a comment the operator sees on `view-source`.
    "<!-- Rendered by hermetic. Final file, no templating. -->",
    '<html lang="en">',
    "  <head>",
    '    <meta charset="utf-8" />',
    `    <meta http-equiv="refresh" content="0; url=${target}" />`,
    "    <title>Agent desktop</title>",
    "  </head>",
    "  <body>",
    `    <a href="${target}">Open the agent's desktop</a>`,
    "  </body>",
    "</html>",
    "",
  ].join("\n");
}

/**
 * One identity's addresses, as systemd hands them to every unit of its stack.
 *
 * Every number is derived by `browserIdentities`, never chosen here, so the
 * units and the manifest cannot disagree about which port a browser is on.
 */
export function browserEnvFile(identity: BrowserIdentity, chromeRef: string): string {
  return [
    "# Rendered by hermetic. Final file, no templating.",
    `# The addresses of browser \`${identity.name}\`, read by xvfb@, hermetic-wm@,`,
    "# x11vnc@, novnc@ and hermetic-browser@ for this instance name.",
    `DISPLAY=:${String(identity.display)}`,
    `CDP_PORT=${String(identity.cdp_port)}`,
    `RFB_PORT=${String(identity.rfb_port)}`,
    `WS_PORT=${String(identity.ws_port)}`,
    `PROFILE_DIR=${identity.profile_dir}`,
    /**
     * Not read by the unit — systemd will not expand a variable in the
     * executable position of `ExecStart`, so the browser unit names the binary
     * literally — and here anyway because it is the one place an operator
     * debugging the stack by hand can source the right path from.
     */
    `CHROME_BIN=${chromeBinaryPath(chromeRef)}`,
    /**
     * Not a variable and not read by anything: a digest of the template unit
     * bodies this env file's instances run.
     *
     * It is here because it is the only per-instance file the browser stack
     * writes. `apply` restarts a unit when the unit's own file changed, and the
     * file behind `hermetic-browser@default.service` is the template
     * `hermetic-browser@.service`, which is not a path `apply` associates with
     * that instance — so a template edit alone would be written to disk and
     * never started. Stamping the digest here changes this file's bytes
     * whenever a template body changes, and this file's `restart_units` names
     * every unit of the identity. See `browserTemplatesDigest`.
     */
    `# templates=${browserTemplatesDigest(chromeRef)}`,
    "",
  ].join("\n");
}

/**
 * Ubuntu's own blessed shape for "this binary may open an unprivileged user
 * namespace, and nothing else changes".
 *
 * Noble sets `kernel.apparmor_restrict_unprivileged_userns=1`, which denies the
 * namespace to an unconfined binary; Chrome's sandbox then falls back to the
 * SUID helper, which the Playwright zip ships non-setuid, and the browser exits
 * with "No usable sandbox". The alternatives were all worse: a setuid
 * `chrome_sandbox` hermetic would own forever, a fleet-wide sysctl that weakens
 * unprivileged userns for everything else on the box, or `--no-sandbox` on a
 * browser pointed at arbitrary web content while holding live sessions.
 *
 * `flags=(unconfined)` is what keeps this a grant rather than a confinement:
 * the profile adds the `userns` permission and constrains nothing else, exactly
 * as Ubuntu's own `chrome`/`chromium` profiles do.
 */
export function chromeApparmorProfile(): string {
  return [
    "# Rendered by hermetic. Final file, no templating.",
    "abi <abi/4.0>,",
    "include <tunables/global>",
    "",
    "# Chrome's sandbox needs an unprivileged user namespace, which noble's",
    "# kernel.apparmor_restrict_unprivileged_userns=1 denies to unconfined",
    "# binaries. This profile grants exactly that to hermetic's pinned build and",
    "# nothing else, so the sandbox stays on and --no-sandbox stays out.",
    "profile hermetic-chrome /opt/hermetic/chrome/**/chrome-linux-arm64/chrome flags=(unconfined) {",
    "  userns,",
    "  include if exists <local/hermetic-chrome>",
    "}",
    "",
  ].join("\n");
}

/**
 * A systemd **template** unit for the browser stack.
 *
 * Not `render.ts`'s `unit()`, for two reasons: importing it back would make the
 * two modules circular, and these units order on their own instance's units
 * rather than on `network-online.target` — an X display, a window manager and a
 * browser on `about:blank` need no network to come up, and ordering them behind
 * one only delays the display an operator is waiting for.
 */
function templateUnit(args: { description: string; ordering?: string[]; service: string[] }): string {
  return [
    "# Rendered by hermetic. Final file, no templating.",
    "#",
    "# A systemd template: one instance per browser identity, named by the",
    "# manifest's `browsers` list. `%i` is the identity's name.",
    "[Unit]",
    "Description=" + args.description,
    ...(args.ordering ?? []),
    "",
    "[Service]",
    "Type=simple",
    /**
     * **Not root.** Every one of these used to run as root, which put
     * a network-facing x11vnc and an unauthenticated X display in the worst
     * possible account. `hermes` is also the account Hermes runs as, so the
     * browser's profile directory and the agent's tool calls are the same
     * user's — which is what makes the shared session work at all.
     */
    "User=hermes",
    "Group=hermes",
    // Every identity-specific value — display, ports, profile — comes from
    // here, so the template body is the same bytes for every instance.
    `EnvironmentFile=${BROWSER_ENV_DIR}/%i.env`,
    ...args.service,
    "",
    "[Install]",
    "WantedBy=multi-user.target",
    "",
  ].join("\n");
}

function xvfbTemplateUnit(): string {
  return templateUnit({
    description: "Xvfb in-memory X display for browser %i",
    service: [
      // `-nolisten tcp`: the X server would otherwise accept TCP connections on
      // 6000 + display, which is an unauthenticated window into the session.
      "ExecStart=/usr/bin/Xvfb ${DISPLAY} -screen 0 1920x1080x24 -nolisten tcp",
      "Restart=always",
    ],
  });
}

function wmTemplateUnit(): string {
  return templateUnit({
    description: "Window manager for browser %i",
    ordering: ["After=xvfb@%i.service", "Requires=xvfb@%i.service"],
    service: [
      /**
       * matchbox rather than openbox (§C): a single maximised window and no
       * root menu, which is the kiosk shape "exactly one browser" wants — and
       * openbox's stock menu offers a terminal launcher over a VNC session with
       * no password on it.
       *
       * A WM is not what makes the session interactive; X delivers events to
       * the window under the pointer without one. What it adds is stacking, so
       * a popup can be moved off 0,0 rather than sitting under the page.
       */
      "ExecStart=/usr/bin/matchbox-window-manager -use_titlebar no",
      "Restart=always",
    ],
  });
}

function vncTemplateUnit(): string {
  return templateUnit({
    description: "x11vnc bound to loopback for browser %i",
    ordering: ["After=xvfb@%i.service", "Requires=xvfb@%i.service"],
    service: [
      // `-localhost`: the RFB port is reachable only through websockify, which
      // is itself only reachable through Tailscale Serve.
      "ExecStart=/usr/bin/x11vnc -display ${DISPLAY} -localhost -rfbport ${RFB_PORT} " +
        "-forever -shared -nopw",
      "Restart=always",
    ],
  });
}

function novncTemplateUnit(): string {
  return templateUnit({
    description: "noVNC websocket bridge for browser %i",
    ordering: ["After=x11vnc@%i.service", "Requires=x11vnc@%i.service"],
    service: [
      // `--web` serves the noVNC client out of the package's own root, where
      // `index.html` above lands.
      `ExecStart=/usr/bin/websockify --web ${NOVNC_WEB_ROOT} ` +
        "127.0.0.1:${WS_PORT} 127.0.0.1:${RFB_PORT}",
      "Restart=always",
    ],
  });
}

function browserTemplateUnit(chromeRef: string): string {
  return templateUnit({
    description: "Headed Chrome (%i) on the agent's X display, driven by Hermes over CDP",
    // `Requires=` on Xvfb alone: without a display there is nothing to draw on,
    // while a window manager that failed is a worse session rather than none.
    ordering: [
      "After=xvfb@%i.service hermetic-wm@%i.service",
      "Requires=xvfb@%i.service",
      /**
       * The profile lives under `/data`, and the `ExecStartPre` below creates
       * it. The data volume is mounted `nofail` (`disk.ts`) so that a missing
       * volume never wedges the boot, which also means nothing orders this unit
       * behind the mount: without this line the browser can create its profile
       * on the *root* filesystem, the volume then mounts over it, and the
       * running Chrome is writing to a directory no longer at that path.
       * `RequiresMountsFor=` adds both the ordering and the requirement.
       */
      "RequiresMountsFor=/data",
    ],
    service: [
      /**
       * The AppArmor profile, loaded before the binary it names runs.
       *
       * `+` runs it as root, which `apparmor_parser` requires. It is also in
       * the manifest's `commands`, where a failure fails the apply loudly — but
       * commands run *after* units, so on the first apply the profile would
       * otherwise reach the kernel one crash loop late.
       */
      `ExecStartPre=+${CHROME_APPARMOR_COMMAND}`,
      /**
       * Deliberately **not** `+`. This runs as `hermes`, and it has to.
       *
       * `${PROFILE_DIR}` is `/data/hermes/browser/<identity>` — every component
       * of it below `/data` sits inside the `hermes` account's own home, which
       * `ensureAccounts` makes `hermes`-owned (`apply.ts`). A directory entry is
       * controlled by the *parent* directory's write bit, so the `hermes` uid
       * can replace `browser`, or the identity under it, with a symlink to
       * anywhere on the box. Run as root, this line would follow that symlink
       * and hand its target to `hermes` at 0700: `Restart=always` re-runs
       * `ExecStartPre`, so the account only has to kill its own Chrome to get
       * another attempt. That is a `hermes`-to-root step on the one box whose
       * new job is running arbitrary web content as `hermes`, and it would be
       * bought for nothing — an account can create a directory inside its own
       * home unprivileged.
       *
       * `ensureBrowserProfileRoot` (`apply.ts`) is the other half: it makes
       * `/data/hermes/browser` the account's before the unit starts, so this
       * line never meets a parent it cannot write, and it refuses outright if
       * that path is already a symlink rather than quietly following one.
       */
      "ExecStartPre=/usr/bin/install -d -m 0700 ${PROFILE_DIR}",
      // A terminated instance leaves the singleton files behind on /data;
      // Chrome then refuses a profile whose lock names a dead pid or another
      // hostname.
      "ExecStartPre=/bin/rm -f ${PROFILE_DIR}/SingletonLock ${PROFILE_DIR}/SingletonSocket " +
        "${PROFILE_DIR}/SingletonCookie",
      /**
       * The binary is named literally rather than as `${CHROME_BIN}`: systemd
       * does not expand variables in the first word of a command line. The env
       * file carries it too, for a human at a shell.
       *
       * `--remote-debugging-address=127.0.0.1` is **load-bearing**. CDP is
       * unauthenticated total control of the browser — every page, every
       * cookie, and local file reads through `file:///` — so it never leaves
       * loopback, and it is never a Tailscale Serve route. There is no
       * `--no-sandbox` here either, and there must not be: the AppArmor profile
       * above is what makes the real sandbox work on this image.
       */
      `ExecStart=${chromeBinaryPath(chromeRef)} ` +
        "--remote-debugging-port=${CDP_PORT} --remote-debugging-address=127.0.0.1 " +
        "--user-data-dir=${PROFILE_DIR} " +
        "--disable-dev-shm-usage --no-first-run --no-default-browser-check " +
        "--hide-crash-restore-bubble " +
        "--window-position=0,0 --window-size=1920,1080 " +
        "--disable-features=Translate,MediaRouter about:blank",
      "Restart=always",
      "RestartSec=5",
    ],
  });
}

/** A double-quoted YAML scalar, for the managed config lines above. */
function yamlString(value: string): string {
  return JSON.stringify(value);
}
