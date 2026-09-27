/**
 * The properties that make an agent box safe to put on a public IP, asserted
 * over every rendered configuration rather than read off one snapshot. Nothing
 * here renders differently per network mode — that is the point. The box is
 * sealed the same way whether it sits on a public subnet or behind a NAT, so
 * these are the regression guards for a promise the fleet's network mode is
 * allowed to rely on but never allowed to change.
 *
 * Two firewall rules are deliberately *not* scoped to `tailscale0`, and the
 * tests below pin them rather than tighten them:
 *
 * - `udp dport 41641 accept` is Tailscale's direct-connection port. In public
 *   mode it is what lets a peer behind a home NAT open a direct path to the
 *   agent, which is the whole reason a public IP is preferred. In NAT mode it is
 *   what keeps two agents on the same private subnet talking directly instead of
 *   falling back to a DERP relay. The listener is WireGuard, so a packet that
 *   does not authenticate against a known peer key is dropped by the handshake.
 * - ICMPv6 stays open because dropping it breaks neighbour discovery and path
 *   MTU discovery, which fail slowly and confusingly rather than loudly.
 *
 * §6.4 states the invariant this file pins.
 */
import { describe, expect, test } from "bun:test";
import { Provider, SecretsMode, Size } from "../src/schema/index.ts";
import { renderAgentConfig } from "../src/render/render.ts";

/** The pinned Chrome for Testing build every browser agent runs. */
const CHROME_REF = "153.0.8010.12";

/**
 * Every configuration that renders differently: size picks the instance type,
 * and provider, browser and secrets mode each add or drop whole files.
 */
const COMBINATIONS = Size.options.flatMap((size) =>
  Provider.options.flatMap((provider) =>
    [true, false].flatMap((browser) =>
      SecretsMode.options.map((secrets_mode) => ({ size, provider, browser, secrets_mode })),
    ),
  ),
);

function render(c: (typeof COMBINATIONS)[number]) {
  return renderAgentConfig({
    name: "atlas",
    size: c.size,
    provider: c.provider,
    secrets_mode: c.secrets_mode,
    tailnet: "hermetic.ts.net",
    hermes_version: "0.15.0",
    hermes_ref: "v2026.8.31",
    chrome_ref: CHROME_REF,
    region: "us-west-2",
  });
}

const MANIFEST_PATH = "/etc/hermetic/manifest.json";

/**
 * Every rendered file except the manifest, which is the same files re-encoded
 * as JSON — scanning it as text would only re-report each hit with its newlines
 * escaped. The `the manifest re-encodes exactly these files` test below is what
 * keeps that exclusion honest.
 */
function configFiles(c: (typeof COMBINATIONS)[number]) {
  return render(c).files.filter((f) => f.path !== MANIFEST_PATH);
}

function label(c: (typeof COMBINATIONS)[number]): string {
  return `${c.size}/${c.provider}/browser=${c.browser}/secrets=${c.secrets_mode}`;
}

function lines(content: string): string[] {
  return content.split("\n");
}

describe("nothing rendered listens on a public interface", () => {
  /**
   * nginx owns its whole config precisely so this is the only `listen` on the
   * box: the stock Ubuntu site listens on `0.0.0.0:80` and is replaced, not
   * disabled.
   */
  test("every nginx listen directive binds loopback", () => {
    let seen = 0;
    for (const c of COMBINATIONS) {
      for (const f of configFiles(c)) {
        for (const line of lines(f.content)) {
          if (!/^\s*listen\s/.test(line)) continue;
          seen += 1;
          expect(line.trim()).toMatch(/^listen\s+(127\.0\.0\.1|\[::1\]|::1):\d+;$/);
        }
      }
    }
    // A rename that stopped producing any `listen` at all would otherwise pass.
    expect(seen).toBeGreaterThan(0);
  });

  /**
   * The address check, as two rules over the files that can carry a bind
   * address — nginx's config, the systemd units and Hermes' own YAML. The
   * nftables ruleset and the apt/sudoers files are excluded by path, because
   * their addresses are firewall matches and CIDR literals rather than binds.
   *
   * Rule one: every IPv4 literal in those files is `127.0.0.1`. That is blunt
   * on purpose — `0.0.0.0`, a VPC address and a hard-coded peer all fail it —
   * and it holds today because loopback is the only address any of them names.
   * Rule two: every `--host`/`--bind`/`--listen`/`--address` flag value and
   * every `host:`/`bind_address:`/`listen_address:` setting is loopback, which
   * catches a hostname (`localhost` passes, `0.0.0.0` and `::` do not) that the
   * first rule would not see as an address at all.
   */
  const BINDABLE = /^\/etc\/(nginx\/|systemd\/system\/|hermes\/)/;
  const IPV4 = /\b\d{1,3}(?:\.\d{1,3}){3}\b/g;
  const BIND_FLAG = /--(?:host|bind|listen|address)[=\s]+(\S+)/g;
  const BIND_SETTING =
    /\b(?:HOST|BIND_ADDRESS|LISTEN_ADDRESS|host|bind_address|listen_address)\s*[:=]\s*(\S+)/g;
  const LOOPBACK = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

  test("every address a unit or config binds to is loopback", () => {
    let seen = 0;
    for (const c of COMBINATIONS) {
      for (const f of configFiles(c)) {
        if (!BINDABLE.test(f.path)) continue;
        for (const m of f.content.matchAll(IPV4)) {
          seen += 1;
          expect(`${f.path}: ${m[0]}`).toBe(`${f.path}: 127.0.0.1`);
        }
        for (const re of [BIND_FLAG, BIND_SETTING]) {
          for (const m of f.content.matchAll(re)) {
            seen += 1;
            const value = (m[1] ?? "").replace(/[,;]$/, "").replace(/:\d+$/, "");
            // Compared as a string so a failure names the file and the value.
            expect(LOOPBACK.has(value) ? "loopback" : `${f.path}: ${value}`).toBe("loopback");
          }
        }
      }
    }
    expect(seen).toBeGreaterThan(0);
  });

  test("no wildcard bind appears anywhere, in any form", () => {
    for (const c of COMBINATIONS) {
      for (const f of configFiles(c)) {
        if (!BINDABLE.test(f.path)) continue;
        expect(f.content).not.toInclude("0.0.0.0");
        expect(f.content).not.toInclude("[::]");
        expect(f.content).not.toMatch(/(?:^|\s)\*:\d+/);
      }
    }
  });

  /** Xvfb's X server would otherwise accept TCP connections on :6099. */
  test("Xvfb is started with -nolisten tcp", () => {
    for (const c of COMBINATIONS.filter((x) => x.browser)) {
      const xvfb = configFiles(c).find((f) => f.path.endsWith("/xvfb@.service"));
      expect(xvfb, label(c)).toBeDefined();
      expect(xvfb!.content).toContain("/usr/bin/Xvfb ");
      expect(xvfb!.content).toContain("-nolisten tcp");
    }
  });

  /**
   * CDP is unauthenticated total control of the browser: every page, every
   * cookie of a profile that holds live sessions, and local file reads through
   * `file:///`. Two rules keep it on the box — it is bound to loopback wherever
   * it is opened, and it is published by nothing.
   */
  test("every CDP port is opened on loopback and published nowhere", () => {
    let seen = 0;
    for (const c of COMBINATIONS.filter((x) => x.browser)) {
      const out = render(c);
      const browsers = out.manifest.browsers ?? [];
      expect(browsers.length, label(c)).toBeGreaterThan(0);
      for (const browser of browsers) {
        const port = String(browser.cdp_port);
        for (const f of configFiles(c)) {
          for (const line of lines(f.content)) {
            if (!line.includes(port)) continue;
            seen += 1;
            /**
             * Every appearance of the number is the unit's own flag — where
             * the address flag has to be on the same line — the env file's
             * assignment that flag reads, or the loopback URL Hermes is told
             * to attach to. A port that turned up anywhere else would be a
             * listener nobody declared.
             */
            const declared =
              line.startsWith(`CDP_PORT=${port}`) ||
              // What Hermes is told to attach to, in the managed config.
              line.includes(`cdp_url: "http://127.0.0.1:${port}"`) ||
              (line.includes("--remote-debugging-port=") &&
                line.includes("--remote-debugging-address=127.0.0.1"));
            expect(declared ? "declared" : `${f.path}: ${line.trim()}`).toBe("declared");
          }
        }
        for (const route of out.manifest.tailscale_serve.routes) {
          expect(`${label(c)}: ${route.target}`).not.toContain(`:${port}`);
        }
      }
    }
    expect(seen).toBeGreaterThan(0);
  });

  /**
   * One Serve route per browser identity, at that identity's own path, pointed
   * at that identity's websockify. Exactly one today (§H) — a second route
   * appearing here is a second browser, which is a decision rather than a
   * refactor.
   */
  test("the browser publishes one route per identity and nothing else", () => {
    for (const c of COMBINATIONS) {
      const out = render(c);
      const browsers = out.manifest.browsers ?? [];
      const added = out.manifest.tailscale_serve.routes.filter((r) => r.path !== "/");
      expect(
        added.map((r) => r.path),
        label(c),
      ).toEqual(browsers.map((b) => b.serve_path));
      for (const [i, route] of added.entries()) {
        expect(route.target, label(c)).toBe(`http://127.0.0.1:${String(browsers[i]!.ws_port)}`);
      }
      expect(
        added.map((r) => r.path),
        label(c),
      ).toEqual(["/vnc"]);
    }
  });

  /**
   * Nothing in the browser stack runs as root. Xvfb, x11vnc and websockify used
   * to all run as root, which put a network-facing process and an
   * unauthenticated X display in the worst-placed account on the box.
   */
  test("every browser unit runs as hermes", () => {
    for (const c of COMBINATIONS.filter((x) => x.browser)) {
      const units = configFiles(c).filter(
        (f) => f.path.startsWith("/etc/systemd/system/") && f.path.includes("@.service"),
      );
      expect(units.length, label(c)).toBe(5);
      for (const f of units) {
        expect(lines(f.content), `${label(c)}: ${f.path}`).toContain("User=hermes");
        expect(lines(f.content), `${label(c)}: ${f.path}`).not.toContain("User=root");
      }
    }
  });

  /**
   * The `/vnc` landing page redirects to an **absolute path**: relative would
   * resolve against `/vnc` without its trailing slash and land on the Hermes
   * SPA at the site root, and a host would hard-code a name this render cannot
   * know. The node's own name is the one thing that decides where this is
   * served from.
   */
  test("the noVNC redirect names a path and no host", () => {
    for (const c of COMBINATIONS.filter((x) => x.browser)) {
      const index = configFiles(c).find((f) => f.path === "/usr/share/novnc/index.html");
      expect(index, label(c)).toBeDefined();
      const targets = [...index!.content.matchAll(/(?:url=|href=")([^"\s]+)/g)].map((m) => m[1]!);
      expect(targets.length, label(c)).toBeGreaterThan(0);
      for (const target of targets) {
        expect(target.startsWith("/vnc/vnc.html?"), `${label(c)}: ${target}`).toBe(true);
        expect(target).not.toInclude("//");
        expect(target).not.toInclude(":");
      }
      // The websocket path is relative to the site root, and names the Serve
      // path this browser is published at — noVNC would otherwise dial `/`.
      expect(index!.content).toContain("path=vnc/websockify");
    }
  });

  test("the manifest re-encodes exactly these files", () => {
    for (const c of COMBINATIONS) {
      const out = render(c);
      const embedded = out.manifest.files.map((f) => ({ path: f.path, content: f.content }));
      const rendered = configFiles(c).map((f) => ({ path: f.path, content: f.content }));
      expect(embedded, label(c)).toEqual(rendered);
    }
  });
});

/** The accept rules of the input chain, in order, exactly as rendered. */
const INPUT_ACCEPTS = [
  "iif lo accept",
  'iifname "tailscale0" accept',
  "ct state established,related accept",
  "ip protocol icmp accept",
  "ip6 nexthdr icmpv6 accept",
  'udp dport 41641 accept comment "tailscale direct connections"',
];

/** The body of a named chain in an nftables ruleset, trimmed, without braces. */
function chain(ruleset: string, name: string): string[] {
  const all = lines(ruleset).map((l) => l.trim());
  const start = all.indexOf(`chain ${name} {`);
  expect(start, `chain ${name}`).toBeGreaterThanOrEqual(0);
  const end = all.indexOf("}", start);
  expect(end, `end of chain ${name}`).toBeGreaterThan(start);
  return all.slice(start + 1, end);
}

describe("the nftables ruleset stays default-deny", () => {
  function ruleset(c: (typeof COMBINATIONS)[number]): string {
    const file = configFiles(c).find((f) => f.content.includes("type filter hook input"));
    expect(file, label(c)).toBeDefined();
    return file!.content;
  }

  test("input and forward both drop by default", () => {
    for (const c of COMBINATIONS) {
      const rules = ruleset(c);
      expect(rules, label(c)).toContain("type filter hook input priority filter; policy drop;");
      expect(rules, label(c)).toContain("type filter hook forward priority filter; policy drop;");
    }
  });

  /**
   * The exact list, not a subset: a new accept rule is a new hole in the box's
   * last line of defence and has to be argued for here before it ships.
   */
  test("the input chain accepts exactly these six things", () => {
    for (const c of COMBINATIONS) {
      const body = chain(ruleset(c), "input");
      expect(
        body.filter((l) => l.includes("accept")),
        label(c),
      ).toEqual(INPUT_ACCEPTS);
    }
  });

  test("the only interfaces accepted are lo and tailscale0", () => {
    for (const c of COMBINATIONS) {
      const body = chain(ruleset(c), "input");
      const byInterface = body.filter((l) => /\biif(name)?\b/.test(l));
      expect(byInterface, label(c)).toEqual(["iif lo accept", 'iifname "tailscale0" accept']);
    }
  });

  /** The one unscoped port, and the reasoning for it is at the top of this file. */
  test("the only port accepted is udp 41641", () => {
    for (const c of COMBINATIONS) {
      const body = chain(ruleset(c), "input");
      const byPort = body.filter((l) => /\bdport\b/.test(l));
      expect(byPort, label(c)).toEqual([
        'udp dport 41641 accept comment "tailscale direct connections"',
      ]);
    }
  });

  test("the forward chain accepts nothing at all", () => {
    for (const c of COMBINATIONS) {
      const body = chain(ruleset(c), "forward");
      expect(
        body.filter((l) => l.includes("accept")),
        label(c),
      ).toEqual([]);
    }
  });
});
