/**
 * §4.7, §4.8: what this tab does when the fleet moves underneath it.
 *
 * Fleet selection is a property of the *server*, so a switch made anywhere —
 * another tab's switcher, a `hermetic fleet use` on the CLI — repoints this
 * page too, and this page finds out at its next `meta.get`. `refreshMeta` used
 * to adopt that meta by repointing the fleet every mutation names and leaving
 * everything else alone: the table went on showing the fleet the operator was
 * looking at while every request composed from those rows claimed the fleet the
 * server had moved to. A destroy clicked on that table would have named an
 * agent in one fleet and been executed in another, which is the exact confusion
 * the target exists to prevent.
 *
 * `fleet-switcher.dom.test.tsx` covers the switch this page makes itself. This
 * is the one it did not.
 */
import { act, cleanup, render, waitFor } from "./dom.ts";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { fleetTarget } from "../src/api/index.ts";
import type { Fleet } from "../src/state/state.tsx";
import { FleetProvider, useFleet } from "../src/state/state.tsx";
import { fakeServer } from "./fake-transport.ts";
import type { FakeServer } from "./fake-transport.ts";
import { FakeStream } from "./fake-stream.ts";

let server: FakeServer | null = null;

beforeEach(() => {});
afterEach(() => {
  cleanup();
  server?.restore();
  server = null;
});

const ACCOUNT = "123456789012";
const REGION = "us-west-2";

function config(name: string, fleetId: string) {
  return {
    name,
    fleet_id: fleetId,
    account_id: ACCOUNT,
    account_alias: "acme",
    org_id: null,
    profile: "acme-dev",
    region: REGION,
    stack_id: `arn:aws:cloudformation:${REGION}:${ACCOUNT}:stack/hermetic/abc`,
    tailnet: "acme.ts.net",
    tailscale_oauth_client_id: "kAbC1",
    frozen_at: "2026-09-01T00:00:00.000Z",
    frozen_by: "evan",
    schema_version: 1,
  };
}

function meta(name: string, fleetId: string) {
  return {
    initialized: true,
    home: "/tmp/hermetic-home",
    header: `▸ ${name} · acme · ${ACCOUNT} · ${REGION}`,
    config: config(name, fleetId),
    fleet: { id: fleetId, alias: name, default: "m4in0abc", directory_region: "us-east-1" },
    fixture: true,
    hermes_version: "1.2.0",
    hermeticd_version: "1.2.0",
    tailnet: "acme.ts.net",
    last_teardown: null,
  };
}

function agent(name: string) {
  return {
    name,
    display_status: "ready",
    status: "ready",
    instance_id: `i-${name}`,
    created_at: "2026-09-01T00:00:00.000Z",
  };
}

/** Reads the provider's whole value out into the test, render by render. */
let seen: Fleet | null = null;
function Probe() {
  seen = useFleet();
  return null;
}

/** Mounts the provider and waits for its first `meta.get` to be adopted. */
async function mount(routes: Record<string, unknown>): Promise<void> {
  server = fakeServer(routes);
  await act(async () => {
    render(
      <FleetProvider>
        <Probe />
      </FleetProvider>,
    );
  });
  await waitFor(() => expect(seen?.meta).not.toBeNull());
}

/** How many fleet streams this tab has opened so far. */
function streams(): number {
  return FakeStream.instances.filter((s) => s.name === "fleet").length;
}

/** Pushes one snapshot down the fleet stream, the way the poller would. */
async function snapshot(names: string[]): Promise<void> {
  await act(async () => {
    FakeStream.last("fleet").emit("snapshot", {
      agents: names.map(agent),
      at: "2026-09-16T12:00:00.000Z",
      scanned: true,
    });
  });
  await waitFor(() => expect(seen?.byName.size).toBe(names.length));
}

describe("the fleet moving under an open tab", () => {
  test("a meta naming another fleet is adopted whole, not just the target", async () => {
    let current = meta("main", "m4in0abc");
    await mount({
      "meta.get": () => current,
      "fleets.list": { directory_region: "us-east-1", directory_error: null, fleets: [] },
      "agents.list": [],
      "ops.list": { ops: [] },
    });
    await snapshot(["atlas", "ember"]);

    // The tab is showing `main`, has two of its agents on screen, is following
    // an op on one of them and has the other tagged NEW.
    await act(async () => {
      seen?.setOp("atlas", "op-1");
      seen?.markFresh("ember");
    });
    expect(fleetTarget()?.fleet_id).toBe("m4in0abc");
    expect(seen?.opsByAgent).toEqual({ atlas: "op-1" });
    expect(seen?.fresh.has("ember")).toBe(true);

    // Somebody else repoints the server, and this tab's next poll finds out.
    current = meta("staging", "sg7k2m4p");
    await act(async () => {
      await seen?.refreshMeta();
    });

    // The target moves — and so does everything keyed on the fleet it left.
    await waitFor(() => expect(fleetTarget()?.fleet_id).toBe("sg7k2m4p"));
    expect(seen?.meta?.fleet?.id).toBe("sg7k2m4p");
    expect(seen?.byName.size).toBe(0);
    expect(seen?.opsByAgent).toEqual({});
    expect(seen?.fresh.size).toBe(0);
    // And the stream is reopened, so what arrives next is the new fleet's
    // rather than the tail of a subscription taken out against the old one.
    await waitFor(() => expect(streams()).toBeGreaterThan(1));
    expect(FakeStream.last("fleet").closed).toBe(false);
  });

  test("a meta naming the same fleet costs nothing", async () => {
    const current = meta("main", "m4in0abc");
    await mount({
      "meta.get": () => current,
      "fleets.list": { directory_region: "us-east-1", directory_error: null, fleets: [] },
      "agents.list": [],
      "ops.list": { ops: [] },
    });
    await snapshot(["atlas"]);
    await act(async () => {
      seen?.setOp("atlas", "op-1");
    });

    await act(async () => {
      await seen?.refreshMeta();
    });

    // The control for the test above: an ordinary poll must not clear the
    // table and reopen the stream every few seconds.
    expect(fleetTarget()?.fleet_id).toBe("m4in0abc");
    expect([...(seen?.byName.keys() ?? [])]).toEqual(["atlas"]);
    expect(seen?.opsByAgent).toEqual({ atlas: "op-1" });
  });
});
