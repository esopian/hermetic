import { describe, expect, test } from "bun:test";
import {
  APT_LOCK_TIMEOUT_SECONDS,
  AgentConfig,
  type ApprovalsMode,
  type HermesSettings,
  Provider,
  SecretsMode,
  HERMES_SEED_CONFIG,
  Size,
  hermesConfigGetArgv,
  hermesConfigSetArgv,
} from "../src/schema/index.ts";
import { assertFullyRendered, renderAgentConfig, serveCommands } from "../src/render/render.ts";
import { HERMETIC_PLATFORM_HINT } from "../src/render/render-hermes.ts";
import { HermeticError } from "../src/errors.ts";

/**
 * The pinned Chrome for Testing build, spelled out rather than imported from
 * `BUILD_VERSIONS`: a snapshot that moved because somebody bumped the browser
 * should say so in the diff.
 */
const CHROME_REF = "153.0.8010.12";

/** Every unit of the one browser identity a browser agent runs, in start order. */
const BROWSER_UNITS = [
  "xvfb@default.service",
  "hermetic-wm@default.service",
  "x11vnc@default.service",
  "novnc@default.service",
  "hermetic-browser@default.service",
];

/** The template files those instances are created from — one each, not per identity. */
const BROWSER_UNIT_FILES = BROWSER_UNITS.map(
  (u) => `/etc/systemd/system/${u.replace(/@[^.]*\./, "@.")}`,
);

/**
 * The one `${…}` a rendered file may keep: a systemd template unit expanding a
 * variable out of its `EnvironmentFile`. Mirrors `SYSTEMD_ENV_REFERENCE` in
 * `render.ts`, deliberately spelled out here rather than imported, so widening
 * the renderer's list does not silently widen the assertion.
 */
const SYSTEMD_ENV_REFERENCE = /\$\{(?:DISPLAY|CDP_PORT|RFB_PORT|WS_PORT|PROFILE_DIR|CHROME_BIN)\}/g;

/** The Serve block of a rendered command list, in order. */
function serveOf(out: ReturnType<typeof renderAgentConfig>): string[] {
  return out.manifest.commands.filter((c) => c.includes("tailscale serve "));
}

/** Keep snapshots readable; every named size gets a validation test below. */
const SNAPSHOT_SIZES = Size.options.filter((size) => ["small", "medium", "large"].includes(size));
const COMBINATIONS = SNAPSHOT_SIZES.flatMap((size) =>
  Provider.options.flatMap((provider) =>
    SecretsMode.options.map((secrets_mode) => ({ size, provider, secrets_mode })),
  ),
);

function render(
  c: (typeof COMBINATIONS)[number] & {
    hermes?: HermesSettings | undefined;
    seed?: HermesSettings | undefined;
  },
) {
  return renderAgentConfig({
    name: "atlas",
    size: c.size,
    provider: c.provider,
    secrets_mode: c.secrets_mode,
    hermes: c.hermes,
    // The fleet's answers pinned on the row at create (`Agent.seed`). Every
    // snapshot combination leaves it undefined, which is what a row written
    // before fleet settings existed carries — it uses the current catalog default.
    seed: c.seed,
    tailnet: "hermetic.ts.net",
    // No fleet identifier of any kind. The one field that ever wanted one —
    // `TailscaleServe.hostname` — is not emitted, so nothing rendered names the
    // fleet and no agent re-renders when a fleet is scoped or renamed.
    hermes_version: "0.15.0",
    hermes_ref: "v2026.8.31",
    chrome_ref: CHROME_REF,
    region: "us-west-2",
  });
}

/**
 * One rendered agent. Named `browserOn` while there was a `browserOff` to tell
 * it from; there is not any more, because every agent runs a browser.
 */
const browserOn = () => render({ size: "medium", provider: "bedrock", secrets_mode: "none" });

function pathsOf(out: ReturnType<typeof renderAgentConfig>): string[] {
  return out.manifest.files.map((f) => f.path);
}

function fileAt(out: ReturnType<typeof renderAgentConfig>, path: string): string {
  const file = out.manifest.files.find((f) => f.path === path);
  if (file === undefined) throw new Error(`nothing rendered at ${path}`);
  return file.content;
}

describe("renderAgentConfig", () => {
  test("covers every size × provider × secrets combination", () => {
    expect(COMBINATIONS).toHaveLength(3 * 6 * 2);
  });

  test("renders every named size", () => {
    for (const size of Size.options) {
      const out = renderAgentConfig({
        name: "atlas",
        size,
        provider: "bedrock",
        secrets_mode: "none",
        tailnet: "hermetic.ts.net",
        hermes_version: "0.15.0",
        hermes_ref: "v2026.8.31",
        chrome_ref: CHROME_REF,
        region: "us-west-2",
      });
      expect(out.manifest.instance_type).toBeDefined();
      expect(() => AgentConfig.parse(out.manifest)).not.toThrow();
    }
  });

  for (const c of COMBINATIONS) {
    const label = `${c.size}/${c.provider}/secrets=${c.secrets_mode}`;

    test(`snapshot: ${label}`, () => {
      const { manifest, config_hash, key } = render(c);
      // The hash is part of the contract, so it belongs in the snapshot.
      expect({ manifest, config_hash, key }).toMatchSnapshot();
    });

    test(`no template markers survive: ${label}`, () => {
      const { files } = render(c);
      for (const f of files) {
        expect(f.content).not.toInclude("{{");
        /**
         * `${…}` survives in exactly one shape: a systemd template unit
         * expanding a variable out of its `EnvironmentFile` at start, which is
         * the box's syntax rather than an un-interpolated template. Every other
         * `${` is still a half-rendered file, and `assertFullyRendered` draws
         * the same line by the same list of names.
         */
        expect(f.content.replace(SYSTEMD_ENV_REFERENCE, "")).not.toInclude("${");
      }
      expect(() => assertFullyRendered(files)).not.toThrow();
    });

    test(`the manifest validates against the schema: ${label}`, () => {
      expect(() => AgentConfig.parse(render(c).manifest)).not.toThrow();
    });

    test(`rendering is deterministic: ${label}`, () => {
      expect(render(c).config_hash).toBe(render(c).config_hash);
    });
  }

  test("every agent renders the browser stack", () => {
    const on = browserOn();
    expect(on.manifest.packages).toContain("xvfb");
    expect(on.manifest.units).toEqual(expect.arrayContaining(BROWSER_UNITS));
    expect(on.manifest.tailscale_serve.routes.map((r) => r.path)).toContain("/vnc");
    // Every unit of the stack has a template file to be instantiated from.
    for (const path of BROWSER_UNIT_FILES) {
      expect(pathsOf(on), path).toContain(path);
    }
    // The stack runs as `hermes` — see `templateUnit`. Root used to own an
    // unauthenticated X display and a network-facing x11vnc.
    for (const path of BROWSER_UNIT_FILES) {
      expect(fileAt(on, path), path).toContain("User=hermes");
    }
    // Not conditional on anything a caller can say: `RenderInput` has no
    // `browser` field to turn it off with, which is the point of removing it.
    expect(Object.keys(on.manifest)).not.toContain("browser");
  });

  /**
   * The browser an agent runs is the mirrored Chrome for Testing build, not
   * anything apt can supply: Ubuntu's `chromium-browser` on noble arm64 is a
   * snap shim that cannot run as `hermes`, and leaving it on `PATH` fools
   * upstream's own `_chromium_installed()` probe into reporting a browser.
   */
  test("no apt browser is installed, and the pinned build is named instead", () => {
    const on = browserOn();
    expect(on.manifest.packages).not.toContain("chromium-browser");
    expect(on.manifest.packages).not.toContain("firefox");
    expect(on.manifest.chrome_ref).toBe(CHROME_REF);
    expect(fileAt(on, "/etc/systemd/system/hermetic-browser@.service")).toContain(
      `ExecStart=/opt/hermetic/chrome/${CHROME_REF}/chrome-linux-arm64/chrome `,
    );
  });

  /**
   * §H: one browser per agent, at the documented allocation. The shape is a
   * list so that a second identity is a data change rather than a redesign —
   * this test is what makes that true, by pinning what the first entry is.
   */
  test("a browser agent runs exactly one identity, named default", () => {
    const browsers = browserOn().manifest.browsers;
    expect(browsers).toEqual([
      {
        name: "default",
        display: 99,
        cdp_port: 9222,
        rfb_port: 5900,
        ws_port: 6080,
        profile_dir: "/data/hermes/browser/default",
        serve_path: "/vnc",
      },
    ]);
  });

  /**
   * A document that needs the browser units needs a box that installs them —
   * which is now every document this build renders, so every box must be on a
   * hermeticd that knows the stack before it can apply anything at all.
   */
  test("every rendered document asks for the browser capability", () => {
    expect(browserOn().manifest.requires).toContain("browser-stack");
  });

  /**
   * Ubuntu's `novnc` package ships `vnc.html` and no `index.html`, so `/vnc`
   * served a websockify directory listing. The redirect names the websocket
   * path explicitly because noVNC resolves its own against the site root and
   * would otherwise dial `/websockify`, which is the Hermes dashboard.
   */
  test("/vnc serves a client", () => {
    const index = fileAt(browserOn(), "/usr/share/novnc/index.html");
    expect(index).toContain("/vnc/vnc.html?path=vnc/websockify");
    expect(index).toContain("autoconnect=true");
    expect(index).toContain("resize=scale");
    expect(index).toContain("reconnect=true");
  });

  /**
   * Sessions hermetic opens are stamped `source: "hermetic"`, which Hermes uses
   * as the platform key for its system-prompt hint and has no built-in entry
   * for. The managed scope supplies one, where the agent's own config cannot
   * shadow it — and it has to survive `yamlString` quoting intact, quotes,
   * backticks, em dashes and all.
   */
  test("the managed config carries the hermetic platform hint, intact", () => {
    const stated = render({
      size: "large",
      provider: "anthropic",
      secrets_mode: "none",
      hermes: { max_turns: 40, terminal_backend: "local" },
    });
    for (const out of [browserOn(), stated]) {
      const managed = fileAt(out, "/etc/hermes/config.yaml");
      expect(managed).toMatch(/^platform_hints:\n {2}hermetic:\n {4}replace: "/m);
      expect(managed).toContain(
        "MEDIA:/path tags are NOT intercepted here (they print as literal text)",
      );
      const parsed = Bun.YAML.parse(managed) as {
        platform_hints?: { hermetic?: { replace?: unknown } };
      };
      expect(parsed.platform_hints?.hermetic?.replace).toBe(HERMETIC_PLATFORM_HINT);
    }
    // Managed, never seeded: the agent's own file must not carry a copy to shadow.
    expect(fileAt(browserOn(), HERMES_SEED_CONFIG)).not.toContain("platform_hints");
  });

  /**
   * The three seams that make Hermes attach to hermetic's browser rather than
   * launch one of its own. The first three have a config form and go in the
   * managed scope, where the agent's own `.env` cannot shadow them; the fourth
   * has none and is a drop-in line.
   */
  test("Hermes is pointed at the browser hermetic runs", () => {
    const on = browserOn();
    const managed = fileAt(on, "/etc/hermes/config.yaml");
    expect(managed).toContain("browser:");
    expect(managed).toContain('cdp_url: "http://127.0.0.1:9222"');
    expect(managed).toContain("headed: true");
    expect(managed).toContain("engine: chrome");

    const chrome = `/opt/hermetic/chrome/${CHROME_REF}/chrome-linux-arm64/chrome`;
    for (const path of [
      "/etc/systemd/system/hermes-dashboard.service",
      "/etc/systemd/system/hermes-gateway.service.d/hermetic.conf",
    ]) {
      expect(fileAt(on, path), path).toContain(`AGENT_BROWSER_EXECUTABLE_PATH=${chrome}`);
      expect(fileAt(on, path), path).toContain("Environment=DISPLAY=:99");
    }
  });

  /**
   * The profile has to reach the kernel before the browser starts, and apply's
   * `commands` phase runs after its `units` phase — so the unit loads it too.
   * Without it Chrome cannot open a user namespace on noble, falls back to a
   * SUID helper the Playwright zip ships non-setuid, and exits "No usable
   * sandbox" — which is how `--no-sandbox` gets proposed.
   */
  test("the Chrome AppArmor profile is rendered and loaded", () => {
    const on = browserOn();
    const profile = fileAt(on, "/etc/apparmor.d/hermetic-chrome");
    expect(profile).toContain("profile hermetic-chrome /opt/hermetic/chrome/**");
    expect(profile).toContain("userns,");
    expect(on.manifest.commands).toContain(
      "/usr/sbin/apparmor_parser -r -T -W /etc/apparmor.d/hermetic-chrome",
    );
    // The parser is on the stock image, but this render assumes it, so the
    // package list says so out loud rather than relying on the base AMI.
    expect(on.manifest.packages).toContain("apparmor");
    expect(fileAt(on, "/etc/systemd/system/hermetic-browser@.service")).toContain(
      "ExecStartPre=+/usr/sbin/apparmor_parser -r -T -W /etc/apparmor.d/hermetic-chrome",
    );
    // Not on the command line. The profile's own comment says the word, which
    // is why this looks at the ExecStart rather than at the whole document.
    const exec = fileAt(on, "/etc/systemd/system/hermetic-browser@.service")
      .split("\n")
      .filter((l) => l.startsWith("ExecStart"));
    expect(exec.join("\n")).not.toContain("--no-sandbox");
  });

  /**
   * Everything identity-specific is in the env file, which is also the only
   * rendered file that can name a template *instance*: apply restarts a unit
   * whose own file changed, and an instance's own file is the template.
   */
  test("each identity's addresses are in its EnvironmentFile", () => {
    const on = browserOn();
    const env = fileAt(on, "/etc/hermetic/browser/default.env");
    expect(env).toContain("DISPLAY=:99");
    expect(env).toContain("CDP_PORT=9222");
    expect(env).toContain("RFB_PORT=5900");
    expect(env).toContain("WS_PORT=6080");
    expect(env).toContain("PROFILE_DIR=/data/hermes/browser/default");
    expect(env).toContain(`CHROME_BIN=/opt/hermetic/chrome/${CHROME_REF}/chrome-linux-arm64/chrome`);
    const file = on.manifest.files.find((f) => f.path === "/etc/hermetic/browser/default.env");
    expect(file?.restart_units).toEqual(BROWSER_UNITS);
  });

  /**
   * The other half of that `restart_units`. `apply` restarts a unit whose own
   * file changed, and the file behind `hermetic-browser@default.service` is the
   * template `hermetic-browser@.service` — a path apply never associates with
   * that instance. So a change to a template *body* alone (a new Chrome flag, a
   * changed `ExecStartPre`) would land on disk and leave the running browser on
   * its old command line. The env file stamps a digest of the template bodies
   * for that reason, and the digest is recomputed here from the rendered files
   * rather than imported: a template body that moves without moving the env
   * file has to fail.
   */
  test("the env file carries a digest of the template bodies, so a template edit restarts them", () => {
    const on = browserOn();
    const bodies = BROWSER_UNIT_FILES.map((path) => fileAt(on, path)).join("\n");
    const digest = new Bun.CryptoHasher("sha256").update(bodies).digest("hex").slice(0, 16);
    expect(digest).toMatch(/^[0-9a-f]{16}$/);
    expect(fileAt(on, "/etc/hermetic/browser/default.env")).toContain(`# templates=${digest}`);
  });

  /**
   * The profile lives on `/data`, which is fstab'd `nofail` so that a missing
   * volume never wedges the boot — which also means nothing orders this unit
   * behind the mount unless it says so. Without the line the unit's
   * `ExecStartPre=install -d` can create the profile on the root filesystem and
   * the volume then mounts straight over it.
   */
  /**
   * The one `ExecStartPre` that may run as root is the AppArmor parser, and it
   * has to: loading a profile is a privileged operation and the path it names is
   * root's.
   *
   * The profile directory is the opposite case. `${PROFILE_DIR}` is
   * `/data/hermes/browser/<identity>`, every component of which sits inside the
   * `hermes` account's own home — and a directory entry is controlled by its
   * *parent's* write bit, so the account can replace any of them with a symlink.
   * A `+` on that line makes systemd follow the symlink as root and hand its
   * target to `hermes` at 0700, with `Restart=always` supplying the retries. It
   * buys nothing: an account can create a directory inside its own home.
   *
   * Asserted on the whole unit rather than on one string, so a second privileged
   * `ExecStartPre` cannot arrive unnoticed.
   */
  test("only the AppArmor parser runs as root, and the profile dir is made by hermes", () => {
    const unit = fileAt(browserOn(), "/etc/systemd/system/hermetic-browser@.service");
    const privileged = unit.split("\n").filter((l) => l.startsWith("ExecStartPre=+"));
    expect(privileged).toEqual([
      "ExecStartPre=+/usr/sbin/apparmor_parser -r -T -W /etc/apparmor.d/hermetic-chrome",
    ]);
    expect(unit).toContain("ExecStartPre=/usr/bin/install -d -m 0700 ${PROFILE_DIR}");
    expect(unit).not.toContain("-o hermes");
  });

  test("the browser unit waits for the volume its profile lives on", () => {
    const unit = fileAt(browserOn(), "/etc/systemd/system/hermetic-browser@.service");
    expect(unit).toContain("RequiresMountsFor=/data");
    // In [Unit]: systemd ignores it anywhere else.
    expect(unit.indexOf("RequiresMountsFor=/data")).toBeLessThan(unit.indexOf("[Service]"));
  });

  test("nothing Bitwarden-shaped exists when secrets are off (§8.1)", () => {
    const off = render({ size: "small", provider: "bedrock", secrets_mode: "none" });
    const rendered = JSON.stringify(off.manifest);
    expect(off.manifest.packages).not.toContain("bws");
    expect(off.manifest.apt_sources.map((s) => s.name)).not.toContain("bitwarden-sm");
    expect(rendered).not.toInclude("bws-token");
    // The env file itself is *not* Bitwarden-shaped any more: every agent has
    // one, because the fleet dashboard login travels in it (§8.3).
    expect(rendered).toInclude("EnvironmentFile");

    const on = render({
      size: "small",
      provider: "anthropic",
      secrets_mode: "bitwarden",
    });
    expect(on.manifest.packages).toContain("bws");
    expect(JSON.stringify(on.manifest)).toInclude("bws-token");
  });

  test("every rendered file is absolute, moded, and non-empty", () => {
    for (const c of COMBINATIONS) {
      for (const f of render(c).files) {
        expect(f.path).toStartWith("/");
        expect(f.mode).toMatch(/^0[0-7]{3}$/);
        expect(f.content.length).toBeGreaterThan(0);
      }
    }
  });

  test("the nftables ruleset is default-deny inbound on tailscale0 and loopback", () => {
    const { files } = render({
      size: "medium",
      provider: "bedrock",
      secrets_mode: "none",
    });
    const nft = files.find((f) => f.path.endsWith(".nft"))!.content;
    expect(nft).toInclude("flush ruleset");
    expect(nft).toInclude("policy drop");
    expect(nft).toInclude('iifname "tailscale0" accept');
    expect(nft).toInclude("iif lo accept");
    expect(nft).toInclude("ct state established,related accept");
    expect(nft).toInclude("ip6 nexthdr icmpv6 accept");
  });

  test("nftables survives a reboot via a dedicated unit, not stock nftables.service", () => {
    const { manifest, files } = render({
      size: "medium",
      provider: "bedrock",
      secrets_mode: "none",
    });
    expect(manifest.units).toContain("hermetic-nftables.service");
    expect(manifest.units).not.toContain("nftables.service");
    expect(manifest.commands.join("\n")).not.toContain("enable --now nftables.service");
    expect(manifest.packages).toContain("nftables");

    const unitFile = files.find((f) => f.path.endsWith("hermetic-nftables.service"))!;
    expect(unitFile.content).toContain(
      "ExecStart=/usr/sbin/nft -f /etc/hermetic/nftables.hermetic.nft",
    );
    expect(unitFile.content).toContain(
      "ExecReload=/usr/sbin/nft -f /etc/hermetic/nftables.hermetic.nft",
    );
    expect(unitFile.content).toContain("Type=oneshot");
    expect(unitFile.content).toContain("RemainAfterExit=yes");
    expect(unitFile.content).toContain("Before=network-online.target tailscaled.service");
    expect(unitFile.content).toContain("WantedBy=multi-user.target");

    // The ruleset itself starts with flush ruleset so re-applies are idempotent.
    const nft = files.find((f) => f.path.endsWith(".nft"))!.content;
    expect(
      nft
        .trimStart()
        .split("\n")
        .filter((l) => !l.startsWith("#"))[0],
    ).toBe("flush ruleset");
  });

  test("every service binds loopback only", () => {
    const { files } = render({
      size: "large",
      provider: "bedrock",
      secrets_mode: "none",
    });
    // Hermes's own bind is an argv, not a config key: `--host 127.0.0.1` in the
    // unit. nginx is the only other listener, and it is loopback too.
    const unit = files.find((f) => f.path === "/etc/systemd/system/hermes-dashboard.service")!.content;
    expect(unit).toInclude("--host 127.0.0.1 --port 9119");
    const nginx = files.find((f) => f.path === "/etc/nginx/nginx.conf")!.content;
    expect(nginx).toInclude("listen 127.0.0.1:9120;");
    for (const f of files) {
      expect(f.content).not.toInclude("0.0.0.0:");
    }
  });

  test("changing any input changes the config_hash", () => {
    const base = render({ size: "medium", provider: "bedrock", secrets_mode: "none" });
    const hashes = new Set(COMBINATIONS.map((c) => render(c).config_hash));
    expect(hashes.size).toBe(COMBINATIONS.length);
    expect(hashes).toContain(base.config_hash);
  });

  test("an explicit instance_type overrides the size's default", () => {
    const out = renderAgentConfig({
      name: "atlas",
      size: "medium",
      instance_type: "r8g.xlarge",
      provider: "bedrock",
      secrets_mode: "none",
      tailnet: "hermetic.ts.net",
      hermes_version: "0.15.0",
      hermes_ref: "v2026.8.31",
      chrome_ref: CHROME_REF,
      region: "us-west-2",
    });
    expect(out.manifest.instance_type).toBe("r8g.xlarge");
  });

  test("assertFullyRendered catches a leftover marker", () => {
    expect(() =>
      assertFullyRendered([{ path: "/etc/x", mode: "0644", content: "name = {{ name }}" }]),
    ).toThrow(/template marker/);
  });

  /**
   * The `${…}` exemption belongs to systemd template units and nowhere else: a
   * template *instance* expands those names out of its `EnvironmentFile` at
   * start, while the same text in a script, a config file or an ordinary unit
   * is a JavaScript template literal that failed to interpolate.
   */
  test("assertFullyRendered exempts an env reference in a template unit, and only there", () => {
    expect(() =>
      assertFullyRendered([
        {
          path: "/etc/systemd/system/xvfb@.service",
          mode: "0644",
          content: "ExecStart=/usr/bin/Xvfb ${DISPLAY}\n",
        },
      ]),
    ).not.toThrow();

    for (const path of ["/etc/hermetic/browser/default.env", "/etc/systemd/system/hermes.service"]) {
      expect(
        () => assertFullyRendered([{ path, mode: "0644", content: "X=${DISPLAY}\n" }]),
        path,
      ).toThrow(/template marker/);
    }
  });
});

/**
 * §7.1: Hermes runs as its own system user. Nothing may reference `hermes`
 * before it exists, and the rendered config must be readable by it.
 */
describe("the hermes system user", () => {
  const rendered = render({
    size: "medium",
    provider: "bedrock",
    secrets_mode: "bitwarden",
  });

  /**
   * The account is *not* rendered as a post-step any more, and the reason is
   * ordering: `commands` is the last phase of `hermeticd apply`, after `units`
   * — and the units phase starts `hermes-dashboard.service`, which is `User=hermes`. A
   * manifest that asked for the account here was asking for it after the thing
   * that needs it, and every first boot failed the unit `217/USER`.
   *
   * hermeticd creates it instead (`ensureAccounts` in `packages/agentd/src/apply.ts`,
   * tested there), before both the files phase and the units phase. What this
   * test holds onto is the invariant that made the move necessary: no post-step
   * may be the thing that creates an account another post-step already assumes.
   */
  test("is not a post-step, because post-steps run after the units that need it", () => {
    const commands = rendered.manifest.commands;
    expect(commands.filter((c) => /\b(useradd|groupadd|usermod)\b/.test(c))).toEqual([]);
    // Post-steps still name `hermes` freely — they run last, by which point
    // hermeticd has created it.
    expect(commands.filter((c) => c.includes("hermes")).length).toBeGreaterThan(0);
  });

  /**
   * The managed config is root's and the `hermes` group's — never the `hermes`
   * user's. Hermes decides a scope is managed by finding it un-writable by the
   * user it runs as, so an `owner: "hermes"` here would silently demote the
   * file from policy to suggestion.
   */
  test("reads the managed config it may not write, and ownership is re-asserted", () => {
    const managed = rendered.manifest.files.find((f) => f.path === "/etc/hermes/config.yaml")!;
    expect(managed.owner).toBe("root");
    expect(managed.group).toBe("hermes");
    expect(managed.mode).toBe("0640");
    expect(rendered.manifest.commands.join("\n")).toContain(
      "chown root:hermes /etc/hermes/config.yaml",
    );
  });

  test("files with no owner stay root-owned by omission", () => {
    const nft = rendered.manifest.files.find((f) => f.path.endsWith(".nft"))!;
    expect(nft.owner).toBeUndefined();
    expect(nft.group).toBeUndefined();
  });
});

/**
 * §6.4's "root on the box": the agent administers its own box, unattended.
 * Four rendered pieces have to agree for that to work — the sudoers grant, the
 * allowlist Hermes consults when approvals are on, the lock timeout that stops
 * the agent's apt racing hermeticd's, and the environment `sudo` would
 * otherwise scrub — so each is asserted for itself rather than left to a
 * snapshot.
 */
describe("root on the box", () => {
  const rendered = render({
    size: "small",
    provider: "bedrock",
    secrets_mode: "none",
  });
  const fileAt = (path: string) => rendered.manifest.files.find((f) => f.path === path);

  test("the grant is root-owned 0440 and says exactly what it grants", () => {
    const sudoers = fileAt("/etc/sudoers.d/hermetic-apt")!;
    // sudo refuses a group- or world-writable file in sudoers.d outright.
    expect(sudoers.mode).toBe("0440");
    expect(sudoers.owner).toBe("root");
    expect(sudoers.group).toBe("root");
    const lines = sudoers.content.split("\n");
    expect(lines).toContain('Defaults:hermes env_keep += "DEBIAN_FRONTEND"');
    // Everything, as any user, with no password. The account is already
    // root-equivalent through the docker group and the boundary is the
    // instance (§7.1), so the narrow grant this replaced bought nothing and
    // cost the agent every root-owned path it met.
    expect(lines).toContain("hermes ALL=(ALL:ALL) NOPASSWD: ALL");
    expect(sudoers.content).toContain("NOPASSWD: ALL");
  });

  test("`sudo` is installed, or the grant is a dead letter", () => {
    expect(rendered.manifest.packages).toContain("sudo");
  });

  /**
   * `DPkg::Lock::Timeout` is stated twice on the box — here, and on hermeticd's
   * own argv — and one number is the whole point: three processes share one
   * lock and any of them failing fast is the failure this file exists to
   * prevent. The constant is shared so they cannot drift; this asserts the
   * rendered file actually spells it.
   */
  test("the apt drop-in carries the shared lock timeout and conffile defaults", () => {
    const conf = fileAt("/etc/apt/apt.conf.d/91hermetic-dpkg")!;
    expect(conf.mode).toBe("0644");
    expect(conf.content).toContain(`DPkg::Lock::Timeout "${String(APT_LOCK_TIMEOUT_SECONDS)}";`);
    expect(conf.content).toContain('DPkg::Options { "--force-confdef"; "--force-confold"; };');
  });

  /**
   * Seeded, not managed. A managed list replaces the agent's rather than
   * merging into it, which reads like the safer choice and is not: upstream
   * persists an "always approve" answer by writing this whole key back to the
   * user config (`tools/approval.py:363`) and `save_config` strips managed
   * leaves before writing (`hermes_cli/config.py:2281`, `:2320`), so a managed
   * `command_allowlist` makes every `always` anyone answers unpersistable, on
   * every agent, forever. The list is not the security boundary — the sudoers
   * drop-in is — so the four apt patterns are seeded and the agent may add to
   * them.
   *
   * Exactly these four, and no longer because they are the sudoers grant — that
   * file grants everything now. They are what an agent reaches for first, kept
   * for the operator who turns approvals back on; at the seeded mode the list
   * decides nothing.
   */
  test("the seed allowlists apt and nothing else, and the managed file is silent", () => {
    const seeded = fileAt("/etc/hermes/config.seed.yaml")!.content;
    expect(seeded).toContain("command_allowlist:");
    // Managed, it would be a floor the agent cannot raise *and* a key its own
    // "always" answers are silently dropped from.
    expect(fileAt("/etc/hermes/config.yaml")!.content).not.toContain("command_allowlist");
    // Nothing about approvals is managed either: no `approvals.deny` floor
    // (an empty one pins nothing), and `approvals_mode` is seed-only, so this
    // one assertion covers both.
    expect(fileAt("/etc/hermes/config.yaml")!.content).not.toContain("approvals");
    const entries = seeded
      .split("\n")
      .filter((line) => line.startsWith("  - "))
      .map((line) => line.slice(4));
    expect(entries).toEqual(['"apt-get *"', '"sudo apt-get *"', '"apt *"', '"sudo apt *"']);
  });

  /** `sudo` scrubs the environment; `env_keep` above is the other half of this. */
  test("the hermes unit sets DEBIAN_FRONTEND", () => {
    const unit = fileAt("/etc/systemd/system/hermes-dashboard.service")!;
    expect(unit.content).toContain("Environment=DEBIAN_FRONTEND=noninteractive");
  });
});

/**
 * The other half of the grant. Root the agent must ask permission to use is
 * not root on a box where nobody answers, so the sudoers file and
 * `approvals.mode` are one decision and are asserted together.
 *
 * Seed-only in both directions: stated or not, the value lands in the agent's
 * own config and never in the managed overlay. A managed leaf would be
 * un-flippable on the box — the managed scope wins, and `save_config` strips
 * managed leaves, so an in-session change could not even survive the session.
 */
describe("the approvals mode", () => {
  const seedAt = (input?: Parameters<typeof render>[0]) =>
    fileAt(
      render(input ?? { size: "small", provider: "bedrock", secrets_mode: "none" }),
      "/etc/hermes/config.seed.yaml",
    );

  test("the default is seeded off", () => {
    const seeded = seedAt();
    expect(seeded).toContain("approvals:");
    expect(seeded).toContain('mode: "off"');
  });

  test("a stated mode is seeded, not managed", () => {
    const out = render({
      size: "small",
      provider: "bedrock",
      secrets_mode: "none",
      hermes: { approvals_mode: "smart" },
    });
    expect(fileAt(out, "/etc/hermes/config.seed.yaml")).toContain('mode: "smart"');
    // The managed file is silent about approvals however the mode was reached:
    // hermetic holding this key is what would make it un-flippable.
    expect(fileAt(out, "/etc/hermes/config.yaml")).not.toContain("approvals");
  });

  /** A fleet-wide answer reaches the seed the same way a stated one does. */
  test("a fleet default is seeded too", () => {
    const out = render({
      size: "small",
      provider: "bedrock",
      secrets_mode: "none",
      seed: { approvals_mode: "manual" },
    });
    expect(fileAt(out, "/etc/hermes/config.seed.yaml")).toContain('mode: "manual"');
    expect(fileAt(out, "/etc/hermes/config.yaml")).not.toContain("approvals");
  });

  /**
   * The seed file is installed once, so a box that already has a config would
   * never see a changed answer without this. It is guarded by a marker rather
   * than a `config get` probe because upstream ships a default for this key —
   * the probe would always resolve and the set would never run — and it is
   * guarded at all so that an agent that turned approvals on for itself is not
   * silently overruled on the next apply.
   */
  test("the post-step asserts the mode once, keyed on a marker file", () => {
    const out = render({
      size: "small",
      provider: "bedrock",
      secrets_mode: "none",
      hermes: { approvals_mode: "smart" },
    });
    const command = out.manifest.commands.find((c) => c.includes("approvals.mode"))!;
    expect(command).toBe(
      'test "$(cat /etc/hermetic/asserted/approvals_mode 2>/dev/null)" = "smart" || { ' +
        "runuser -u hermes -- env HERMES_HOME=/data/hermes/.hermes /usr/local/bin/hermes " +
        "config set approvals.mode 'smart' >/dev/null && " +
        "systemctl try-restart hermes-dashboard.service hermes-gateway.service && " +
        "install -d -m 0755 /etc/hermetic/asserted && " +
        "printf '%s' 'smart' > /etc/hermetic/asserted/approvals_mode; }",
    );
    // The same argv the model step writes with, so the two cannot drift.
    expect(command).toContain(hermesConfigSetArgv("approvals.mode", "'smart'").join(" "));
  });

  /**
   * The marker is the last thing the chain writes, and that is a correctness
   * requirement rather than a matter of taste.
   *
   * hermeticd runs these through `/bin/sh -c` with no `set -e` and fails the
   * apply on a non-zero exit, so a `try-restart` that fails has to leave the
   * box in a state the retry can still fix. A marker written before the restart
   * would claim the assertion had happened while both units were still serving
   * the old mode, and the retry would skip the whole right-hand side on the
   * strength of that claim.
   */
  test("the marker is written after the restart, so a failed restart is retried", () => {
    const out = render({
      size: "small",
      provider: "bedrock",
      secrets_mode: "none",
      hermes: { approvals_mode: "smart" },
    });
    const command = out.manifest.commands.find((c) => c.includes("approvals.mode"))!;
    // `lastIndexOf`, because the marker path appears twice: once in the `test`
    // that reads it and once in the `printf` that writes it. The write is the
    // one that has to come after the restart.
    expect(command.indexOf("try-restart")).toBeLessThan(
      command.lastIndexOf("/etc/hermetic/asserted/approvals_mode"),
    );
    expect(command.indexOf("config set approvals.mode")).toBeLessThan(command.indexOf("try-restart"));
  });

  /** The box would otherwise keep the old answer: the seed is installed once. */
  test("changing the mode moves the config_hash", () => {
    const of = (approvals_mode: ApprovalsMode) =>
      render({ size: "small", provider: "bedrock", secrets_mode: "none", hermes: { approvals_mode } })
        .config_hash;
    expect(new Set([of("off"), of("smart"), of("manual")]).size).toBe(3);
  });
});

/**
 * What a Hermes install needs from apt, per upstream's own installer and image
 * (`scripts/install.sh`, `Dockerfile:71-73`) rather than per a hand-written
 * guess — plus the one variable that keeps the Python closure sealed.
 */
describe("the packages Hermes actually needs", () => {
  const rendered = render({
    size: "small",
    provider: "nous",
    secrets_mode: "none",
  });

  test("every base package upstream installs for a server is installed", () => {
    // rg: the search tool's preferred engine (`file_operations_search.py:308-318`).
    // libatomic1: the official Node tarball links libatomic.so.1 (`install.sh:1104-1122`).
    // xz-utils: `tar -xJf` on that tarball. ffmpeg: TTS and voice messages.
    for (const pkg of ["ripgrep", "libatomic1", "xz-utils", "ffmpeg"]) {
      expect(rendered.manifest.packages).toContain(pkg);
    }
  });

  /** uv provisions both the interpreter and the venv, so this installed nothing. */
  test("python3-venv is not installed", () => {
    expect(rendered.manifest.packages).not.toContain("python3-venv");
  });

  /**
   * Upstream's container recipe, both halves (`Dockerfile:430`, `:443`): the
   * disable flag keeps on-demand installs out of the root-owned venv, and the
   * target sends them to a directory the account owns on the data volume,
   * which re-enables them there (`lazy_deps.py:325-337`). On *both* units,
   * because either process can reach a lazy backend.
   */
  test("on-demand installs are redirected to the account's target on both Hermes units", () => {
    for (const path of ["/etc/systemd/system/hermes-dashboard.service", "hermetic.conf"]) {
      const file = rendered.manifest.files.find((f) => f.path.endsWith(path))!.content;
      expect(file).toContain("Environment=HERMES_DISABLE_LAZY_INSTALLS=1");
      expect(file).toContain(
        "Environment=HERMES_LAZY_INSTALL_TARGET=/data/hermes/.hermes/lazy-packages",
      );
    }
  });

  /**
   * Hermes's terminal tool strips `VIRTUAL_ENV` from what it hands a login
   * shell, and an operator's `sudo -iu hermes` gets no unit environment at all,
   * so the account's install locations are re-established by a profile script.
   */
  test("every hermes login shell gets the agent's venv first and the install targets", () => {
    const profile = rendered.manifest.files.find((f) => f.path === "/etc/profile.d/hermetic-agent.sh");
    expect(profile?.mode).toBe("0644");
    const content = profile?.content ?? "";
    expect(content).toContain('if [ "$(id -un 2>/dev/null)" = "hermes" ]; then');
    expect(content).toContain("export HERMES_LAZY_INSTALL_TARGET=/data/hermes/.hermes/lazy-packages");
    expect(content).toContain("export NPM_CONFIG_PREFIX=/data/hermes/.local");
    expect(content).toContain("export VIRTUAL_ENV=/data/hermes/.venv");
    expect(content).toContain('PATH="/data/hermes/.venv/bin:$PATH"');
  });

  /**
   * Node is root's, so npm's default global prefix is a directory `hermes`
   * cannot write. Both units point it at the account's own prefix, because an
   * agent's shell is a child of whichever process serves the conversation.
   */
  test("npm installs globally into the account's own prefix on both Hermes units", () => {
    for (const path of ["/etc/systemd/system/hermes-dashboard.service", "hermetic.conf"]) {
      const file = rendered.manifest.files.find((f) => f.path.endsWith(path))!.content;
      expect(file).toContain("Environment=NPM_CONFIG_PREFIX=/data/hermes/.local");
    }
  });
});

/**
 * §6.5's pin, made a mechanism rather than a convention.
 *
 * hermetic decides which Hermes a box runs. Nothing on the box may decide
 * otherwise, and until the marker below existed the dashboard's own update
 * button could — so this asserts the two halves of the refusal: the file
 * upstream reads, in the shape upstream accepts, and the config key that stops
 * `hermes --version` reaching github.com to advertise the command it refuses.
 */
describe("the box cannot un-pin itself", () => {
  const rendered = render({
    size: "small",
    provider: "nous",
    secrets_mode: "none",
  });
  const fileAt = (path: string) => rendered.manifest.files.find((f) => f.path === path);

  test("the image-provenance marker parses, and says schema 1, image, hermetic", () => {
    const marker = fileAt("/etc/hermes/image-provenance.json")!;
    // World-readable: upstream reads it as whichever user runs `hermes`.
    expect(marker.mode).toBe("0644");
    const parsed: unknown = JSON.parse(marker.content);
    // Upstream's three required keys, with `schema` a real int — it rejects
    // `true`, which `bool` would satisfy in Python (`image_provenance.py:73-75`).
    expect(parsed).toEqual({
      schema: 1,
      deployment_kind: "image",
      manager: "hermetic",
      version: "v2026.8.31",
    });
    expect(Number.isInteger((parsed as { schema: number }).schema)).toBe(true);
  });

  /** Nothing derived: the marker must not make `config_hash` move on its own. */
  test("the marker is a pure function of the pin", () => {
    const again = render({ size: "large", provider: "bedrock", secrets_mode: "none" });
    expect(
      again.manifest.files.find((f) => f.path === "/etc/hermes/image-provenance.json")!.content,
    ).toBe(fileAt("/etc/hermes/image-provenance.json")!.content);
  });

  /**
   * Managed, so `hermes config set updates.check true` cannot put the fetch
   * back: `hermes --version` runs twice per apply and would otherwise reach
   * github.com and print "run 'hermes update'" — the command the marker above
   * exists to refuse.
   */
  test("the managed config pins updates.check false", () => {
    const managed = fileAt("/etc/hermes/config.yaml")!.content;
    expect(managed).toContain("updates:\n  check: false");
  });
});

/**
 * §6.4's gateway. There are two Hermes processes on an agent box and only one
 * of the two units is hermetic's: `hermes gateway install --system` writes
 * `hermes-gateway.service`, and hermetic reaches it with a drop-in. What is
 * asserted here is mostly an absence — that hermetic renders no unit for it —
 * plus the one thing that would silently break if the two ever drifted apart:
 * the environment both processes run with.
 */
describe("the gateway unit is upstream's", () => {
  const GATEWAY_UNIT = "/etc/systemd/system/hermes-gateway.service";
  const DROPIN = "/etc/systemd/system/hermes-gateway.service.d/hermetic.conf";

  const filesOf = (provider: Provider = "bedrock") =>
    render({ size: "small", provider, secrets_mode: "none" }).manifest.files;

  /**
   * The plan's stated test. A rendered unit would put the gateway's `ExecStart`
   * — the venv python, the module path, the verb — in hermetic's hands, where a
   * Hermes upgrade could silently invalidate it; `hermes_ref` pins supervision
   * precisely because the file is upstream's (§6.6).
   */
  test("hermetic renders no file at the gateway's unit path", () => {
    for (const c of COMBINATIONS) {
      expect(render(c).manifest.files.map((f) => f.path)).not.toContain(GATEWAY_UNIT);
    }
  });

  test("the drop-in carries the fleet's environment and names the unit it feeds", () => {
    const dropin = filesOf().find((f) => f.path === DROPIN)!;
    expect(dropin.mode).toBe("0644");
    // A drop-in is not the unit's *own* file, so apply's "restart only what
    // changed" rule would never see it without this.
    expect(dropin.restart_units).toEqual(["hermes-gateway.service"]);
    expect(dropin.content).toContain("EnvironmentFile=/run/hermetic/secrets.env");
    expect(dropin.content).toContain("SupplementaryGroups=docker");
    expect(dropin.content).toContain("Environment=DEBIAN_FRONTEND=noninteractive");
    expect(dropin.content).toContain("LimitNOFILE=4096");
    // The tmpfs file must exist before either process starts.
    expect(dropin.content).toContain("After=hermetic-secrets.service");
    expect(dropin.content).toContain("Requires=hermetic-secrets.service");
    // It adds to upstream's unit; it does not restate it.
    expect(dropin.content).not.toContain("ExecStart=");
    expect(dropin.content).not.toContain("User=");
  });

  test("the gateway is enabled, right after the dashboard", () => {
    const units = render({
      size: "small",
      provider: "bedrock",
      secrets_mode: "none",
    }).manifest.units;
    expect(units.indexOf("hermes-gateway.service")).toBe(units.indexOf("hermes-dashboard.service") + 1);
  });

  /**
   * The two units are one agent, so an environment that reached only one of
   * them is a bug with no symptom until the other is asked to do the same work.
   * These two are the ones that vary.
   */
  test("every agent gets DISPLAY on both units", () => {
    const files = filesOf();
    const unit = files.find((f) => f.path === "/etc/systemd/system/hermes-dashboard.service")!;
    const dropin = files.find((f) => f.path === DROPIN)!;
    expect(unit.content).toContain("Environment=DISPLAY=:99");
    expect(dropin.content).toContain("Environment=DISPLAY=:99");
  });

  test("a bedrock agent gets AWS_REGION on both units; a keyed one on neither", () => {
    const files = filesOf("bedrock");
    const unit = files.find((f) => f.path === "/etc/systemd/system/hermes-dashboard.service")!;
    const dropin = files.find((f) => f.path === DROPIN)!;
    expect(unit.content).toContain("Environment=AWS_REGION=us-west-2");
    expect(dropin.content).toContain("Environment=AWS_REGION=us-west-2");
    expect(dropin.content).toContain("Environment=AWS_DEFAULT_REGION=us-west-2");

    const keyed = filesOf("nous").find((f) => f.path === DROPIN)!;
    expect(keyed.content).not.toContain("AWS_REGION");
  });

  /**
   * `HERMES_HOME` is the one thing the drop-in deliberately does not restate:
   * upstream's generated unit already sets it (and `HOME`), because the
   * installer was told where the root is.
   */
  test("the drop-in restates no HERMES_HOME", () => {
    expect(filesOf().find((f) => f.path === DROPIN)!.content).not.toContain("HERMES_HOME");
  });
});

/**
 * §8.1 and §6.4: what a provider puts in Hermes's own config, and what it does
 * not. The key never appears — the managed file names the *variable* the tmpfs
 * `EnvironmentFile` supplies — and the provider is spelled the way Hermes
 * spells it, which for Nous is not the way hermetic spells it.
 */
describe("provider configuration", () => {
  function managed(provider: Provider, hermes?: HermesSettings, fleet?: HermesSettings): string {
    const out = render({
      size: "small",
      provider,
      secrets_mode: "bitwarden",
      hermes,
      seed: fleet,
    });
    return out.manifest.files.find((f) => f.path === "/etc/hermes/config.yaml")!.content;
  }

  function seed(provider: Provider, hermes?: HermesSettings, fleet?: HermesSettings): string {
    const out = render({
      size: "small",
      provider,
      secrets_mode: "bitwarden",
      hermes,
      seed: fleet,
    });
    return out.manifest.files.find((f) => f.path === "/etc/hermes/config.seed.yaml")!.content;
  }

  test("bedrock names itself and states that no key exists", () => {
    const yaml = managed("bedrock");
    expect(yaml).toContain('provider: "bedrock"');
    expect(yaml).toContain("no API key exists on this box");
    expect(yaml).not.toContain("base_url");
    expect(yaml).not.toContain("key_env");
  });

  /**
   * The bug this whole file exists to prevent: Hermes's built-in `nous` is an
   * OAuth device-code login that never reads `NOUS_API_KEY`, so an agent wired
   * to it boots healthy and then refuses the first message. The Portal is
   * declared as its own endpoint instead, under a name that does not shadow the
   * built-in — Hermes ignores a declared entry that does.
   */
  test("nous is declared as its own endpoint, not as hermes's built-in nous", () => {
    const yaml = managed("nous");
    expect(yaml).toContain('provider: "hermetic-nous"');
    expect(yaml).toContain("  hermetic-nous:");
    expect(yaml).toContain('base_url: "https://inference-api.nousresearch.com/v1"');
    expect(yaml).toContain('key_env: "NOUS_API_KEY"');
    expect(yaml).not.toMatch(/provider:\s*"nous"/);
  });

  test("openrouter and anthropic are hermes's own providers, keyed from the environment", () => {
    const openrouter = managed("openrouter");
    expect(openrouter).toContain('provider: "openrouter"');
    expect(openrouter).toContain("OPENROUTER_API_KEY comes from /run/hermetic/secrets.env");
    expect(openrouter).not.toContain("key_env");

    const anthropic = managed("anthropic");
    expect(anthropic).toContain('provider: "anthropic"');
    expect(anthropic).toContain("ANTHROPIC_API_KEY comes from /run/hermetic/secrets.env");
    expect(anthropic).not.toContain("base_url");
  });

  /**
   * A model nobody chose is the other half of the same failure: the provider
   * resolves and there is nothing to send it. Every provider seeds one, spelled
   * its own way.
   */
  test("every provider seeds a model, spelled the way that provider spells it", () => {
    expect(seed("bedrock")).toContain('default: "zai.glm-4.7-flash"');
    expect(seed("anthropic")).toContain('default: "claude-sonnet-5"');
    expect(seed("openrouter")).toContain('default: "deepseek/deepseek-v4.1-flash"');
    expect(seed("nous")).toContain('default: "deepseek/deepseek-v4.1-flash"');
    expect(seed("openai")).toContain('default: "gpt-5.6-luna"');
    expect(seed("vercel")).toContain('default: "deepseek/deepseek-v4.1-flash"');
  });

  /**
   * The rule from `splitHermesSettings`: hermetic manages what it was told to
   * manage. A stated model is hermetic's and lands in the managed file; an
   * unstated one is seeded and then belongs to the operator. Never both.
   */
  test("a stated setting is managed; an unstated one is seeded", () => {
    const stated = { model: "anthropic/claude-opus-5" } as const;
    expect(managed("nous", stated)).toContain('default: "anthropic/claude-opus-5"');
    expect(seed("nous", stated)).not.toContain("model:");

    expect(managed("nous")).not.toContain("default:");
    expect(seed("nous")).toContain("model:");
  });

  test("the managed config asks both Hermes units to restart when it changes", () => {
    const out = render({ size: "small", provider: "nous", secrets_mode: "none" });
    const file = out.manifest.files.find((f) => f.path === "/etc/hermes/config.yaml")!;
    // Both read it, and both read it at start: a model that reached only the
    // dashboard would leave the gateway answering messages on the old one.
    expect(file.restart_units).toEqual(["hermes-dashboard.service", "hermes-gateway.service"]);
  });

  /**
   * The seed is installed once and then the agent's own. Rendering it every
   * time keeps `config_hash` a pure function of the configuration; installing
   * it only when nothing is there keeps hermetic out of an operator's edits.
   */
  test("the seed is installed only when the agent has no config of its own", () => {
    const out = render({ size: "small", provider: "nous", secrets_mode: "none" });
    const command = out.manifest.commands.find((c) => c.includes("config.seed.yaml"))!;
    expect(command).toContain("test -e /data/hermes/.hermes/config.yaml ||");
    expect(command).toContain("install -o hermes -g hermes -m 0640");
    expect(command).toContain("systemctl try-restart hermes-dashboard.service hermes-gateway.service");
  });

  /**
   * Hermes writes itself a `config.yaml` the first time it starts, so on a box
   * that has already run, installing the seed stands down — and if that file
   * names no model the agent still has nothing to send. The second step is for
   * exactly that box, and must not disturb one whose operator chose a model.
   */
  test("a model is set on a config that has one of everything but", () => {
    const out = render({ size: "small", provider: "bedrock", secrets_mode: "none" });
    const command = out.manifest.commands.find((c) => c.includes("config set model.default"))!;
    // Shell-quoted, so a Bedrock id's `:` reaches Hermes as one word; Hermes
    // writes the YAML, so nothing here quotes it a second time.
    expect(command).toContain("config set model.default 'zai.glm-4.7-flash'");
    expect(command).not.toContain(`default: "%s"`);
  });

  /**
   * The guard is a leaf query, not a block grep. `model:` with a `provider:`
   * under it and no `default:` — what `hermes config set model.provider` writes
   * (`hermes_cli/config.py:3491-3494`) — passes `grep -qE '^model:'` and is
   * exactly the box this step exists for. Asking Hermes what it resolves is the
   * only reading that sees the difference, and the managed overlay with it.
   */
  test("the model guard asks Hermes for the leaf, as the agent's own user", () => {
    const out = render({ size: "small", provider: "bedrock", secrets_mode: "none" });
    const command = out.manifest.commands.find((c) => c.includes("config set model.default"))!;
    expect(command).not.toContain("grep -qE '^model:'");
    expect(command).toContain(
      "runuser -u hermes -- env HERMES_HOME=/data/hermes/.hermes " +
        "/usr/local/bin/hermes config get model.default --json >/dev/null 2>&1 ||",
    );
    // The same argv the boot assertion runs (`hermesConfigGetArgv`), so the two
    // readings of "does this agent have a model" cannot disagree.
    expect(command).toContain(hermesConfigGetArgv("model.default").join(" "));
  });

  /**
   * The reason this writes through `hermes config set` and not `printf >>`.
   *
   * Hermes reads the file with `yaml.safe_load` (`hermes_cli/config.py:24`),
   * where a duplicate top-level key is last-wins — so a second appended
   * `model:` block would silently discard the `model:` mapping the box already
   * had, `provider` and `base_url` with it, and the next `_write_user_config`
   * would make the loss permanent. The one shape this step exists for is
   * exactly such a mapping. `config set` writes the leaf and leaves the
   * siblings (`set_config_value`, `config.py:3484-3496`).
   */
  test("the model is set through hermes, never appended to the agent's config", () => {
    const out = render({ size: "small", provider: "bedrock", secrets_mode: "none" });
    const command = out.manifest.commands.find((c) => c.includes("config set model.default"))!;
    expect(command).not.toContain("printf");
    expect(command).not.toContain(">>");
    expect(command).not.toContain("model:");
    // No sentinel any more, and none needed: `config set` rewrites the file,
    // so the `config get` probe above is the whole idempotence check.
    expect(command).not.toContain("appended by hermetic");
    expect(command).not.toContain("grep -qF");
  });

  /**
   * `config get` first, `config set` only if it answered nothing — so a box
   * that already has a model is never written to, and a `hermes` too broken to
   * answer is never written to twice either.
   */
  test("the set runs only when the probe found no model, and restarts both units", () => {
    const out = render({ size: "small", provider: "bedrock", secrets_mode: "none" });
    const command = out.manifest.commands.find((c) => c.includes("config set model.default"))!;
    expect(command).toBe(
      "runuser -u hermes -- env HERMES_HOME=/data/hermes/.hermes /usr/local/bin/hermes " +
        "config get model.default --json >/dev/null 2>&1 || { " +
        "runuser -u hermes -- env HERMES_HOME=/data/hermes/.hermes /usr/local/bin/hermes " +
        "config set model.default 'zai.glm-4.7-flash' >/dev/null && " +
        "systemctl try-restart hermes-dashboard.service hermes-gateway.service; }",
    );
    // The same argv the seed writes with, so the two cannot drift apart.
    expect(command).toContain(hermesConfigSetArgv("model.default", "'zai.glm-4.7-flash'").join(" "));
  });

  /** When hermetic holds the model, the agent's own file is not involved. */
  test("nothing is set when the managed config carries the model", () => {
    const out = render({
      size: "small",
      provider: "bedrock",
      secrets_mode: "none",
      hermes: { model: "us.anthropic.claude-haiku-4-5-20251001-v1:0" },
    });
    expect(out.manifest.commands.find((c) => c.includes("config set model.default"))).toBeUndefined();
  });

  /** Bedrock is the one provider that must be told which region it is in. */
  test("bedrock pins the region on the unit; the keyed providers need none", () => {
    const unitOf = (provider: Provider) =>
      render({ size: "small", provider, secrets_mode: "none" }).manifest.files.find(
        (f) => f.path === "/etc/systemd/system/hermes-dashboard.service",
      )!.content;
    expect(unitOf("bedrock")).toContain("Environment=AWS_REGION=us-west-2");
    expect(unitOf("bedrock")).toContain("Environment=AWS_DEFAULT_REGION=us-west-2");
    expect(unitOf("nous")).not.toContain("AWS_REGION");
  });

  /**
   * §4.6: a model that came from *fleet settings* rather than from `--model` is
   * seeded, not managed. The agent boots with it and its own dashboard may
   * still change it — which is only true if the value is in the seed file and
   * nowhere in the managed one.
   */
  describe("the fleet's seed", () => {
    const seed_settings = { model: "deepseek-v4-flash-0731" } as const;

    test("a fleet default model is seeded, and the managed config states no model", () => {
      const seeded = seed("nous", undefined, seed_settings);
      expect(seeded).toContain('default: "deepseek-v4-flash-0731"');
      const held = managed("nous", undefined, seed_settings);
      expect(held).not.toContain("default:");
      expect(held).not.toContain("deepseek-v4-flash-0731");
    });

    test("the post-step sets the fleet's model, not the catalog's", () => {
      const out = render({
        size: "small",
        provider: "nous",
        secrets_mode: "none",
        seed: seed_settings,
      });
      const command = out.manifest.commands.find((c) => c.includes("config set model.default"))!;
      expect(command).toContain("'deepseek-v4-flash-0731'");
      expect(command).not.toContain("deepseek/deepseek-v4.1-flash");
    });

    /** A stated model is hermetic's; the fleet's is then not rendered at all. */
    test("a stated model wins, and the seed is silent about the model", () => {
      const stated = { model: "anthropic/claude-opus-5" } as const;
      expect(managed("nous", stated, seed_settings)).toContain('default: "anthropic/claude-opus-5"');
      const seeded = seed("nous", stated, seed_settings);
      expect(seeded).not.toContain("model:");
      expect(seeded).not.toContain("deepseek-v4-flash-0731");
    });

    /** The rest of `agent_defaults` behaves the same way: seeded, never managed. */
    test("every fleet-wide setting reaches the seed and none reaches the managed file", () => {
      const fleet = {
        model: "deepseek-v4-flash-0731",
        max_turns: 42,
        reasoning_effort: "high",
      } as const;
      const seeded = seed("nous", undefined, fleet);
      expect(seeded).toContain("max_turns: 42");
      expect(seeded).toContain('reasoning_effort: "high"');
      const held = managed("nous", undefined, fleet);
      expect(held).not.toContain("max_turns");
      expect(held).not.toContain("reasoning_effort");
    });

    /**
     * Rows written before fleet settings existed fall back to the current
     * provider catalog when they have no pinned seed.
     */
    test("no seed at all is the provider catalog's default", () => {
      expect(seed("nous")).toContain('default: "deepseek/deepseek-v4.1-flash"');
      expect(seed("nous", undefined, undefined)).toBe(seed("nous"));
    });
  });

  test("no rendered file ever contains a key-shaped value", () => {
    for (const provider of Provider.options) {
      const { files } = render({ size: "small", provider, secrets_mode: "bitwarden" });
      for (const f of files) {
        expect(f.content).not.toMatch(/sk-[A-Za-z0-9-]{8,}/);
        expect(f.content).not.toMatch(/_API_KEY\s*=/);
      }
    }
  });
});

/** §6.4: the secrets file must exist before Hermes starts. */
describe("unit ordering", () => {
  test("hermes waits for the bitwarden materialiser when there is one", () => {
    const withSecrets = render({
      size: "medium",
      provider: "anthropic",
      secrets_mode: "bitwarden",
    });
    const hermes = withSecrets.manifest.files.find((f) => f.path.endsWith("hermes-dashboard.service"))!;
    expect(hermes.content).toContain("After=hermetic-secrets.service");
    expect(hermes.content).toContain("Requires=hermetic-secrets.service");

    const secrets = withSecrets.manifest.files.find((f) =>
      f.path.endsWith("hermetic-secrets.service"),
    )!;
    expect(secrets.content).toContain("Before=hermes-dashboard.service");
  });

  test("a keyed provider gets the materialiser even with secrets_mode none", () => {
    const keyed = render({
      size: "small",
      provider: "openrouter",
      secrets_mode: "none",
    });
    const hermes = keyed.manifest.files.find((f) => f.path.endsWith("hermes-dashboard.service"))!;
    expect(hermes.content).toContain("EnvironmentFile=/run/hermetic/secrets.env");
    expect(hermes.content).toContain("Requires=hermetic-secrets.service");

    const unit = keyed.manifest.files.find((f) => f.path.endsWith("hermetic-secrets.service"))!;
    expect(unit.content).toContain("this fleet's SSM prefix + atlas/provider-key");
    expect(unit.content).not.toContain("bws-token");
    expect(keyed.manifest.units).toContain("hermetic-secrets.service");
    // SSM is read by hermeticd with the instance role: no `bws` on the box.
    expect(keyed.manifest.packages).not.toContain("bws");
  });

  test("a keyed provider with bitwarden names both sources on one unit", () => {
    const both = render({
      size: "small",
      provider: "nous",
      secrets_mode: "bitwarden",
    });
    const unit = both.manifest.files.find((f) => f.path.endsWith("hermetic-secrets.service"))!;
    expect(unit.content).toContain("this fleet's SSM prefix + atlas/provider-key");
    expect(unit.content).toContain("this fleet's SSM prefix + atlas/bws-token");
    expect(both.manifest.packages).toContain("bws");
  });

  /**
   * The ordering used to be conditional on the agent having secrets of its own.
   * It is not any more: the fleet dashboard login is delivered through the same
   * tmpfs file (§8.3), so the bedrock/`none` agent — the one with nothing of its
   * own to materialise — needs the unit exactly as much as the rest.
   */
  test("even an agent with no secrets of its own orders after the secrets unit", () => {
    const plain = render({
      size: "small",
      provider: "bedrock",
      secrets_mode: "none",
    });
    const hermes = plain.manifest.files.find((f) => f.path.endsWith("hermes-dashboard.service"))!;
    expect(hermes.content).toContain("After=hermetic-secrets.service");
    expect(hermes.content).toContain("Requires=hermetic-secrets.service");
    expect(hermes.content).toContain("EnvironmentFile=/run/hermetic/secrets.env");
    expect(plain.manifest.units).toContain("hermetic-secrets.service");

    // Nothing of its own, though: an agent with no slots names none. The unit
    // is still rendered and still required, because hermeticd writes the file
    // either way and `hermes-dashboard.service` must not have two shapes.
    const unit = plain.manifest.files.find((f) => f.path.endsWith("hermetic-secrets.service"))!;
    expect(unit.content).not.toContain("provider-key");
    expect(unit.content).not.toContain("bws-token");
    expect(unit.content).toContain("hermeticd secrets materialise");
  });
});

/** §6.4: Serve publishes at `<name>.<tailnet>` — fleet configuration, not a guess. */
describe("the tailnet", () => {
  test("the Serve config names no hostname at all", () => {
    const out = render({ size: "medium", provider: "bedrock", secrets_mode: "none" });
    /**
     * It was informational and nothing consumed it: `serveCommands` names only
     * the local target, and every head builds the URL from the agent row
     * (`agentHostname`) — the name the node actually answered on, which after a
     * recreate is not the one a render would have guessed.
     *
     * Its absence is the contract: emitting it would put the fleet's name into
     * `config_hash`, so renaming a fleet would re-render and restart every
     * agent on it for a field nobody reads.
     */
    expect(out.manifest.tailscale_serve.hostname).toBeUndefined();
  });

  /**
   * There is no dashboard environment at all, anywhere. A public URL engages
   * Hermes 0.21's auth gate — with no auth provider registered it refuses to
   * start — so the way to keep the dashboard open on the tailnet is to leave
   * Hermes in local mode and let the loopback proxy rewrite `Host`/`Origin`
   * for it. The env file stays required because a provider key still arrives
   * through it (§6.4, §8.1).
   */
  test("no dashboard public URL or credentials are baked into the unit", () => {
    const out = render({ size: "medium", provider: "bedrock", secrets_mode: "none" });
    const hermes = out.manifest.files.find((f) => f.path.endsWith("hermes-dashboard.service"))!;
    expect(hermes.content).not.toContain("HERMES_DASHBOARD");
    expect(hermes.content).toContain("EnvironmentFile=/run/hermetic/secrets.env");
  });

  /**
   * The whole point of the proxy: Serve's target is nginx on 9120, not Hermes
   * on 9119, because Hermes' DNS-rebinding guard rejects the `Host` Serve
   * forwards and nginx is what rewrites it to loopback. A route pointed
   * straight at 9119 is the `Invalid Host header` bug, so it is asserted here
   * rather than left to the snapshot.
   */
  test("the dashboard route targets the loopback proxy, not Hermes", () => {
    const out = render({ size: "medium", provider: "bedrock", secrets_mode: "none" });
    const root = out.manifest.tailscale_serve.routes.find((r) => r.path === "/")!;
    expect(root.target).toBe("http://127.0.0.1:9120");
    expect(out.manifest.units).toContain("nginx.service");

    const conf = out.manifest.files.find((f) => f.path === "/etc/nginx/nginx.conf")!;
    expect(conf.mode).toBe("0644");
    expect(conf.content).toContain("listen 127.0.0.1:9120;");
    expect(conf.content).toContain("proxy_pass http://127.0.0.1:9119;");
    expect(conf.content).toContain("proxy_set_header Host 127.0.0.1:9119;");
    expect(conf.content).toContain("proxy_set_header Origin http://127.0.0.1:9119;");
    // The only listener: a `sites-enabled/default` on 0.0.0.0:80 is exactly
    // what owning the whole nginx.conf exists to prevent.
    expect(conf.content.match(/listen /g)).toHaveLength(1);
    expect(out.manifest.packages).toContain("nginx-light");
  });

  /** §6.4: `serve` is the headless backend and 404s the SPA; `dashboard` serves it. */
  test("hermes runs the dashboard command, not the headless backend", () => {
    const out = render({ size: "medium", provider: "bedrock", secrets_mode: "none" });
    const hermes = out.manifest.files.find((f) => f.path.endsWith("hermes-dashboard.service"))!;
    expect(hermes.content).toContain(
      "ExecStart=/usr/local/bin/hermes dashboard --no-open --skip-build --host 127.0.0.1 --port 9119",
    );
  });

  /**
   * `--skip-build` only works if the process can find what was built. Vite's
   * `outDir` is `../hermes_cli/web_dist` (`web/vite.config.ts:103`), not
   * `web/dist`, and the TUI the Chat tab spawns must not be npm-installed at
   * first use by the `hermes` user. Both are upstream env seams; both are
   * stated rather than inferred.
   */
  test("the dashboard unit is told where the SPA and the TUI are", () => {
    const out = render({ size: "medium", provider: "bedrock", secrets_mode: "none" });
    const hermes = out.manifest.files.find((f) => f.path.endsWith("hermes-dashboard.service"))!.content;
    expect(hermes).toContain(
      "Environment=HERMES_WEB_DIST=/usr/local/lib/hermes-agent/hermes_cli/web_dist",
    );
    expect(hermes).toContain("Environment=HERMES_TUI_DIR=/usr/local/lib/hermes-agent/ui-tui");
    expect(hermes).not.toContain("/web/dist");

    // The gateway serves neither surface, so its drop-in says nothing about them.
    const dropIn = out.manifest.files.find((f) => f.path.endsWith("hermetic.conf"))!.content;
    expect(dropIn).not.toContain("HERMES_WEB_DIST");
    expect(dropIn).not.toContain("HERMES_TUI_DIR");
  });

  /**
   * Serve is published by the documented per-route CLI form; the hidden
   * `--set-raw` flag (and the `/etc/hermetic/serve.json` it read) is gone.
   */
  test("Serve is reset and then published one command per route, `/` first", () => {
    const on = render({ size: "medium", provider: "bedrock", secrets_mode: "none" });
    expect(serveOf(on)).toEqual([
      "tailscale serve reset",
      "timeout 120 tailscale serve --bg --yes --https=443 'http://127.0.0.1:9120'",
      "timeout 120 tailscale serve --bg --yes --https=443 --set-path=/vnc 'http://127.0.0.1:6080'",
    ]);
  });

  /** The commands run through `/bin/sh -c` on the box; a path is never a place to hide one. */
  test("a Serve path that is not a plain URL path is refused", () => {
    expect(() =>
      serveCommands({
        enabled: true,
        hostname: "atlas.hermetic.ts.net",
        routes: [{ path: "/x;rm -rf /", target: "http://127.0.0.1:9119", description: "evil" }],
      }),
    ).toThrow(HermeticError);
  });

  test("no rendered command uses the removed --set-raw flag, and no serve.json ships", () => {
    for (const c of COMBINATIONS) {
      const out = render(c);
      for (const command of out.manifest.commands) expect(command).not.toInclude("set-raw");
      expect(out.files.map((f) => f.path)).not.toContain("/etc/hermetic/serve.json");
    }
  });
});
