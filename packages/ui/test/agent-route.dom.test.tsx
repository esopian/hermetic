/**
 * The agent hash as a route, driven through the whole page.
 *
 * `agent-nav.test.ts` owns the parsing and the spelling; what it cannot see is
 * what the app *does* with a route once the fleet is on screen. Two behaviours
 * live here, and both are about state that outlives the navigation that set it:
 * a teardown confirm belongs to the agent it named, so following a link to
 * another one must not carry it across; and a hash naming an agent this fleet
 * does not have is a selection nobody can see and nobody can clear, so once a
 * scan has landed it goes.
 */
import { act, cleanup, render, screen, userEvent, waitFor } from "./dom.ts";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { App } from "../src/App.tsx";
import { FleetProvider } from "../src/state/state.tsx";
import { fakeServer } from "./fake-transport.ts";
import type { FakeServer } from "./fake-transport.ts";
import { FakeStream } from "./fake-stream.ts";

let server: FakeServer | null = null;

beforeEach(() => {
  window.location.hash = "";
});

afterEach(() => {
  cleanup();
  server?.restore();
  server = null;
  window.location.hash = "";
});

function config() {
  return {
    name: "main",
    fleet_id: "m4in0abc",
    account_id: "123456789012",
    account_alias: "acme",
    org_id: null,
    profile: "acme-dev",
    region: "us-west-2",
    stack_id: "arn:aws:cloudformation:us-west-2:123456789012:stack/hermetic/abc",
    tailnet: "acme.ts.net",
    tailscale_oauth_client_id: "kAbC1",
    frozen_at: "2026-09-01T00:00:00.000Z",
    frozen_by: "evan",
    schema_version: 1,
  };
}

const META = {
  initialized: true,
  home: "/tmp/hermetic-home",
  header: "▸ main · acme · 123456789012 · us-west-2",
  config: config(),
  fleet: { id: "m4in0abc", alias: "main", default: "m4in0abc", directory_region: "us-east-1" },
  fixture: true,
  hermes_version: "1.2.0",
  hermeticd_version: "1.2.0",
  tailnet: "acme.ts.net",
  last_teardown: null,
};

function agent(name: string) {
  return {
    name,
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
    browsers: [{ name: "default", serve_path: "/vnc" }],
    tailscale_ip: "100.64.0.9",
    resources: { ssm_paths: [] },
    last_heartbeat: "2026-09-05T11:59:55.000Z",
    heartbeat_age_ms: 5_000,
    health: { hermes: true, tailscale: true, disk: true, dashboard: true },
    metrics: { cpu_pct: 10, mem_pct: 20, disk_pct: 30 },
    created_by: "evan",
    created_at: "2026-09-01T00:00:00.000Z",
    updated_at: "2026-09-05T11:59:55.000Z",
  };
}

function routes() {
  return {
    "meta.get": META,
    "fleets.list": { directory_region: "us-east-1", directory_error: null, fleets: [] },
    "agents.list": [],
    "ops.list": { ops: [] },
    "volumes.list": {
      volumes: [],
      summary: { read_at: "2026-09-05T12:00:00.000Z", free: 0, free_gib: 0, monthly_cost: 0 },
    },
    // The per-agent reads the drawer makes, none of which this suite is about.
    "agents.history": { error: { code: "NOT_ASKED", message: "not scripted here" } },
    "agents.probe": { error: { code: "NOT_ASKED", message: "not scripted here" } },
    "agents.desktop": { error: { code: "NOT_ASKED", message: "not scripted here" } },
  };
}

/** Renders the page and delivers a fleet the way the stream delivers one. */
async function page(names: string[]): Promise<void> {
  render(
    <FleetProvider>
      <App />
    </FleetProvider>,
  );
  // The fleet stream by name, not merely "a stream": the page also opens the
  // chat fan-in, and it opens first.
  await waitFor(() => expect(FakeStream.instances.some((s) => s.name === "fleet")).toBe(true));
  await act(async () => {
    FakeStream.last("fleet").emit("snapshot", {
      agents: names.map(agent),
      at: "2026-09-05T12:00:00.000Z",
      scanned: true,
    });
  });
}

/** Navigates the way a link or the back button does, rather than by prop. */
async function goto(hash: string): Promise<void> {
  await act(async () => {
    window.location.hash = hash;
    window.dispatchEvent(new Event("hashchange"));
  });
}

describe("agent routes · what a navigation resets", () => {
  /**
   * The teardown confirm names one agent and types that agent's name to arm
   * itself. Following `#agent/<other>` while it is open would leave a destroy
   * panel over a drawer describing somebody else — the single most expensive
   * misread on this screen.
   */
  test("routing to another agent closes the teardown confirm", async () => {
    server = fakeServer(routes());
    const user = userEvent.setup();
    await page(["lumen", "corvid"]);

    await user.click(await screen.findByText("lumen"));
    await user.click(await screen.findByRole("tab", { name: "Lifecycle" }));
    await user.click(await screen.findByRole("button", { name: "Destroy lumen…" }));
    expect(document.querySelector(".confirm")?.textContent).toContain("Destroy lumen");

    await goto("#agent/corvid");
    expect(document.querySelector(".confirm")).toBeNull();
    expect(screen.queryByText("Destroy lumen")).toBeNull();
  });

  /**
   * A bookmark kept past a destroy, or a typed name. There is no drawer to
   * show, so the hash was invisible state: it survived reloads and nothing on
   * screen could clear it.
   */
  test("a hash naming an agent the fleet does not have is dropped once the scan lands", async () => {
    server = fakeServer(routes());
    window.location.hash = "#agent/ghost";
    await page(["lumen"]);

    await waitFor(() => expect(window.location.hash).toBe(""));
    expect(document.querySelector(".drawer")).toBeNull();
  });

  /**
   * The other half of the same rule: before a scan has come back, "not in the
   * fleet" only means "not read yet", so a perfectly good link must survive the
   * first paint.
   */
  test("the same hash survives while the fleet is still loading", async () => {
    server = fakeServer(routes());
    window.location.hash = "#agent/lumen";
    render(
      <FleetProvider>
        <App />
      </FleetProvider>,
    );
    await waitFor(() => expect(FakeStream.instances.some((s) => s.name === "fleet")).toBe(true));
    expect(window.location.hash).toBe("#agent/lumen");

    await act(async () => {
      FakeStream.last("fleet").emit("snapshot", {
        agents: [agent("lumen")],
        at: "2026-09-05T12:00:00.000Z",
        scanned: true,
      });
    });
    expect(window.location.hash).toBe("#agent/lumen");
    await waitFor(() => expect(document.querySelector(".drawer")).not.toBeNull());
  });
});
