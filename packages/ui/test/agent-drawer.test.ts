/**
 * The drawer's liveness half, rendered. Static markup only — effects do not
 * run, so nothing here fetches: this asserts the shape the first paint has,
 * which is exactly where the `dashboard` check and the `Probe` button live.
 */
import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { profilesState } from "./profiles-fixture.ts";
import type { AgentView } from "../src/api/index.ts";
import type { AgentTab } from "../src/nav/agent-nav.ts";
import { AgentDrawer } from "../src/components/AgentDrawer.tsx";
/*
 * The one import of core in this file, and the reason it is legal: the
 * boundary test (`tests/boundaries.test.ts`) parses `packages/<name>/src`, and
 * a package's `test` tree is deliberately outside it so a seam can be held from
 * one side. `APPROVALS_DEFAULT` is a hand-copied constant; this is what stops
 * it drifting from the value it copies.
 */
import { HERMES_DEFAULTS } from "@hermetic/core/schema";
import { APPROVALS_DEFAULT } from "../src/components/agent/AgentConfig.tsx";

function agent(overrides: Partial<AgentView> = {}): AgentView {
  return {
    name: "lumen",
    status: "ready",
    display_status: "ready",
    version: 1,
    lock: null,
    size: "medium",
    instance_type: "t4g.2xlarge",
    region: "us-west-2",
    instance_id: "i-1",
    volume_id: "vol-1",
    volume_gib: 100,
    hermes_version: "1.2.0",
    hermeticd_version: "1.2.0",
    config_hash: null,
    provider: "bedrock",
    secrets_mode: "none",
    browser: true,
    tailscale_ip: "100.64.0.9",
    resources: { ssm_paths: [] },
    last_heartbeat: "2026-09-05T11:59:55.000Z",
    heartbeat_age_ms: 5_000,
    health: { hermes: true, tailscale: true, disk: true, dashboard: true },
    metrics: { cpu_pct: 10, mem_pct: 20, disk_pct: 30 },
    created_by: "evan",
    created_at: "2026-09-01T00:00:00.000Z",
    updated_at: "2026-09-05T11:59:55.000Z",
    ...overrides,
  } as AgentView;
}

/**
 * `/api/meta` has landed and named the tailnet. The drawer needs it *told*, not
 * guessed: the stale-device note is an accusation about a name, and the
 * `tailnet` prop's fallback (`DEFAULT_TAILNET`) is a guess. Only the fields the
 * drawer reads are here.
 */
const META = { tailnet: "acme.ts.net" } as unknown as Parameters<typeof AgentDrawer>[0]["meta"];

function html(
  a: AgentView,
  meta: Parameters<typeof AgentDrawer>[0]["meta"] = META,
  tailnet = "acme.ts.net",
  tab: AgentTab = "overview",
): string {
  return renderToStaticMarkup(
    createElement(AgentDrawer, {
      agent: a,
      meta,
      latest: "1.2.0",
      tailnet,
      profiles: profilesState(),
      runningOpId: null,
      onOp: () => {},
      onClose: () => {},
      confirmOpen: false,
      setConfirmOpen: () => {},
      tab,
      onTab: () => {},
    }),
  );
}

describe("AgentDrawer · health checks", () => {
  test("dashboard is a fourth check, and names the URL it proved", () => {
    const out = html(agent());
    expect(out).toContain("<b>dashboard</b>");
    expect(out).toContain("https://lumen.acme.ts.net/ answers");
  });

  test("a hermeticd too old to report it renders pending, not failing", () => {
    // `health.dashboard` absent is "never asked", which is the same beat as a
    // row before its first heartbeat — muted and pulsing, never red.
    const out = html(agent({ health: { hermes: true, tailscale: true, disk: true } }));
    expect(out).toContain("not reported by this hermeticd yet");
    expect(out).not.toContain("check the tailnet&#x27;s HTTPS certificates");
  });

  test("a reported failure says which toggle to go and look at", () => {
    const out = html(
      agent({
        display_status: "degraded",
        health: { hermes: true, tailscale: true, disk: true, dashboard: false },
      }),
    );
    expect(out).toContain("check the tailnet&#x27;s HTTPS certificates");
    expect(out).not.toContain("not reported by this hermeticd yet");
  });
});

describe("AgentDrawer · liveness panel", () => {
  test("the panel offers a manual probe and dates the last heartbeat", () => {
    const out = html(agent());
    expect(out).toContain("Liveness");
    expect(out).toContain(">Probe now<");
    expect(out).toContain("last heartbeat: ");
    // No report before one is asked for — the panel is a button, not a spinner.
    // `probe-detail` is the layer rows' own class, so its absence is exact in a
    // drawer that says "instance id" and "Instance" for other reasons.
    expect(out).not.toContain("probe-verdict");
    expect(out).not.toContain("probe-detail");
    expect(out.split("Recent activity")[0]).not.toContain("aria-live");
  });

  test("the panel does not sit on the shared failure banner", () => {
    // A probe changes nothing, so it has no business clearing the slot a
    // reboot or a destroy uses to say why it did not happen.
    const out = html(agent());
    expect(out).not.toContain("probe failed");
  });
});

/**
 * §6.5: a recreate leaves the old device holding the canonical name, so the new
 * node comes up as `<name>-2`. The drawer is where an operator looks the agent
 * up, so it is where the real name and the cleanup have to be said.
 */
describe("AgentDrawer · a node that did not get its canonical name", () => {
  test("the header shows the real name and names the stale device", () => {
    const out = html(agent({ tailscale_dns_name: "lumen-2.acme.ts.net" }));
    expect(out).toContain("lumen-2.acme.ts.net");
    expect(out).toContain("lumen.acme.ts.net is held by a stale device");
    expect(out).toContain("Tailscale admin");
  });

  test("the dashboard link points at the node that answers", () => {
    const out = html(agent({ tailscale_dns_name: "lumen-2.acme.ts.net" }));
    expect(out).toContain("https://lumen-2.acme.ts.net/ answers");
    expect(out).not.toContain("https://lumen.acme.ts.net/ answers");
  });

  test("a node holding its own name says nothing extra", () => {
    const out = html(agent({ tailscale_dns_name: "lumen.acme.ts.net" }));
    expect(out).toContain("lumen.acme.ts.net");
    expect(out).not.toContain("stale device");
  });

  test("a row with no reported name falls back to the canonical one", () => {
    const out = html(agent());
    expect(out).toContain("lumen.acme.ts.net");
    expect(out).not.toContain("stale device");
  });

  /**
   * First paint, before `/api/meta` answers: the tailnet is unknown, so the
   * canonical name is unknowable and no node can be said to hold the wrong one.
   * The note used to appear on every agent that had reported a dns name and then
   * vanish a moment later, which is worse than saying nothing.
   */
  test("says nothing about a stale device until the tailnet is known", () => {
    const out = html(agent({ tailscale_dns_name: "lumen-2.acme.ts.net" }), null);
    expect(out).toContain("lumen-2.acme.ts.net");
    expect(out).not.toContain("stale device");
  });
});

/**
 * Since foundation v4 a node joins the tailnet as `<fleet id>-<agent>`
 * (`cloudName`, `format.ts` mirroring core's `schema/fleet.ts`). The drawer's
 * `meta` prop carries the fleet's id (`meta.config.fleet_id`) and its own name
 * (`meta.config.fleet_name`); the first builds every hostname, and the second
 * exists only to recognise a node built under v3, when the name was the prefix.
 */
describe("AgentDrawer · the fleet-prefixed cloud hostname (§ foundation v4)", () => {
  const MAIN_META = {
    tailnet: "hermetic.ts.net",
    config: { fleet_id: "k7m2x9qa", fleet_name: "main" },
    fleet: { name: "main", default: "main", directory_region: "us-east-1" },
  } as unknown as Parameters<typeof AgentDrawer>[0]["meta"];

  test("with no reported dns name yet, the canonical hostname carries the fleet id", () => {
    const out = html(agent({ tailscale_dns_name: undefined }), MAIN_META, "hermetic.ts.net");
    expect(out).toContain("k7m2x9qa-lumen.hermetic.ts.net");
    expect(out).not.toContain(">lumen.hermetic.ts.net<");
    expect(out).not.toContain("stale device");
  });

  test("a dns name that already carries the fleet id is not flagged at all", () => {
    const out = html(
      agent({ tailscale_dns_name: "k7m2x9qa-lumen.hermetic.ts.net" }),
      MAIN_META,
      "hermetic.ts.net",
    );
    expect(out).toContain("k7m2x9qa-lumen.hermetic.ts.net");
    expect(out).not.toContain("stale device");
    expect(out).not.toContain("used to hand out");
  });

  /**
   * The regression this whole split exists to prevent. Both of these nodes are
   * this agent's own machine, wearing the hostname hermetic gave it at boot —
   * `main-lumen` under v3, `lumen` before it. Sending an operator to delete
   * either in the Tailscale admin console would evict the running agent, so the
   * drawer says what the node is instead, and never names the console.
   */
  describe("a node wearing a name from before the naming rule moved", () => {
    test("a v3 `<fleet name>-<agent>` node is described, not condemned", () => {
      const out = html(
        agent({ tailscale_dns_name: "main-lumen.hermetic.ts.net" }),
        MAIN_META,
        "hermetic.ts.net",
      );
      expect(out).toContain("main-lumen.hermetic.ts.net");
      expect(out).toContain("wearing a name hermetic used to hand out");
      expect(out).not.toContain("stale device");
      expect(out).not.toContain("Tailscale admin");
    });

    test("a pre-v3 bare node is described the same way", () => {
      const out = html(
        agent({ tailscale_dns_name: "lumen.hermetic.ts.net" }),
        MAIN_META,
        "hermetic.ts.net",
      );
      expect(out).toContain("wearing a name hermetic used to hand out");
      expect(out).not.toContain("stale device");
    });

    /** It still says the canonical name resolves to nothing, which is true. */
    test("it names the canonical spelling nothing answers to", () => {
      const out = html(
        agent({ tailscale_dns_name: "lumen.hermetic.ts.net" }),
        MAIN_META,
        "hermetic.ts.net",
      );
      expect(out).toContain("k7m2x9qa-lumen.hermetic.ts.net");
    });
  });

  /**
   * A suffix is Tailscale's, never hermetic's: nothing here would ever ask for
   * `k7m2x9qa-lumen-2`, so a node wearing one was admitted under it because the
   * canonical name was taken — by a device a `recreate` failed to delete.
   */
  test("a suffixed node is still a stale device, and still names the console", () => {
    const out = html(
      agent({ tailscale_dns_name: "k7m2x9qa-lumen-2.hermetic.ts.net" }),
      MAIN_META,
      "hermetic.ts.net",
    );
    expect(out).toContain("k7m2x9qa-lumen.hermetic.ts.net is held by a stale device");
    expect(out).toContain("Tailscale admin");
  });
});

/**
 * §7.3's desktop, as the first paint has it: the header link, the section nav
 * and which of the two bodies is drawn. The stream itself is a behaviour and
 * lives in `agent-desktop.dom.test.tsx` — static markup cannot press Connect.
 */
describe("AgentDrawer · desktop", () => {
  test("Open desktop links at the agent's /vnc/ route", () => {
    const out = html(agent());
    expect(out).toContain("Open desktop ↗");
    expect(out).toContain('href="https://lumen.acme.ts.net/vnc/"');
  });

  test("the section nav is there, on Overview, with the overview body beside it", () => {
    const out = html(agent());
    expect(out).toContain('role="tablist"');
    for (const label of ["Overview", "Chat", "Desktop", "Logs", "Config", "Lifecycle"]) {
      expect(out).toContain(`>${label}</span>`);
    }
    // The selected section is the one the hash named; `overview` is the default.
    expect(out).toMatch(/id="agent-tab-overview" aria-selected="true"/);
    expect(out).toContain("Recent activity");
    expect(out).not.toContain("Start watching");
  });

  /**
   * The Desktop tab swaps the whole body, and it arrives cold: the panel offers
   * to connect, and nothing is streaming until it is asked to.
   */
  test("the Desktop tab replaces the overview and starts cold", () => {
    const out = html(
      agent({ browsers: [{ name: "default", serve_path: "/vnc" }] } as Partial<AgentView>),
      META,
      "acme.ts.net",
      "desktop",
    );
    expect(out).toMatch(/id="agent-tab-desktop" aria-selected="true"/);
    expect(out).toContain("Start watching");
    expect(out).toContain("Connect →");
    expect(out).not.toContain("<iframe");
    expect(out).not.toContain("Recent activity");
  });
});

/**
 * §6.4's approvals mode on the Config section's Hermes panel.
 *
 * The panel's rule is "what hermetic holds", and every other Hermes setting is
 * off it for a good reason: hermetic seeded them and the agent owns them since,
 * so the row's copy may no longer be what the box reads. `approvals_mode` is
 * seed-only (`SEED_ONLY` in `schema/hermes.ts`), which is what makes it the
 * exception rather than a breach — there is no managed spelling of it to be
 * mistaken for, only the question of whose value it is, and the line answers
 * that outright. The CLI already prints it (`packages/cli/src/table.ts`), so
 * until now the portal was the head that quietly knew less.
 */
describe("AgentDrawer · the approvals mode", () => {
  /** The Hermes panel lives on the Config section. */
  const config = (a: AgentView) => html(a, META, "acme.ts.net", "config");

  test("a mode stated on the row is the one shown, and it is labelled seeded", () => {
    const out = config(agent({ hermes: { approvals_mode: "manual" } } as Partial<AgentView>));
    expect(out).toContain('<span class="k">approvals</span>');
    expect(out).toContain("manual");
    expect(out).toContain("seeded — the agent&#x27;s to change");
    expect(out).toContain("agent set --approvals");
  });

  /**
   * A row that states nothing inherited the fleet's answer, and that answer was
   * frozen onto `seed` at create time rather than re-read from `_fleet` — so it
   * is the honest second source, and reading it is what `splitHermesSettings`
   * does on the CLI side.
   */
  test("with nothing stated, the fleet's answer frozen at create time shows", () => {
    const out = config(agent({ seed: { approvals_mode: "smart" } } as Partial<AgentView>));
    expect(out).toContain("smart (seeded");
    expect(out).not.toContain("off (seeded");
  });

  test("a stated mode outranks the seed", () => {
    const out = config(
      agent({
        hermes: { approvals_mode: "off" },
        seed: { approvals_mode: "smart" },
      } as Partial<AgentView>),
    );
    expect(out).toContain("off (seeded");
    expect(out).not.toContain("smart");
  });

  /**
   * Neither side states it on most agents: `resolveCreateDefaults` seeds only
   * what `settings.agent_defaults` actually named, so a fleet that never named
   * a mode leaves `seed.approvals_mode` absent on everything it created.
   */
  test("with neither stated, the build's own default is what the panel says", () => {
    expect(config(agent())).toContain("off (seeded");
  });

  /**
   * The seam. `APPROVALS_DEFAULT` is a second copy of a core constant, carried
   * because the UI may not import core (§3.1) — and the boundary test's scope
   * is each package's `src`, so this test, which is not in one, may import the
   * original and hold the two together.
   */
  test("the portal's default is core's default, not a guess that drifted", () => {
    expect(APPROVALS_DEFAULT).toBe(HERMES_DEFAULTS.approvals_mode);
  });
});
