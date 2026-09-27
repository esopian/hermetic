/**
 * One doctor run for the page (`state/doctor-store.ts`).
 *
 * The env strip's fleet popover and Settings › Diagnostics both run doctor, and
 * each used to hold its own answer: run it from Settings, open the popover, and
 * it still said "doctor not run". Both are mounted here side by side, the way
 * the page has them, and the run is made from one and read from the other.
 */
import { act, cleanup, render, screen, userEvent, waitFor } from "./dom.ts";
import { afterEach, describe, expect, test } from "bun:test";
import { setFleetTarget } from "../src/api/index.ts";
import { FleetMenu } from "../src/components/FleetMenu.tsx";
import { DiagnosticsSection } from "../src/components/settings/DiagnosticsSection.tsx";
import { resetDoctorStore } from "../src/state/doctor-store.ts";
import { FleetProvider, useFleet } from "../src/state/state.tsx";
import { FAKE_TARGET, fakeServer } from "./fake-transport.ts";
import type { FakeServer } from "./fake-transport.ts";
import { withNav } from "./nav.tsx";

let server: FakeServer | null = null;

afterEach(() => {
  cleanup();
  server?.restore();
  server = null;
  // `setup.ts` resets it too, but a preload's `afterEach` does not reach every
  // file of a multi-file run; this file's second test needs a clean store.
  resetDoctorStore();
});

const DOCTOR = {
  ok: true,
  account: { frozen: FAKE_TARGET.account_id, observed: FAKE_TARGET.account_id, ok: true },
  fleet: { local: "fxtr0001", stack_tag: "fxtr0001", fleet_item: "fxtr0001", ok: true },
  foundation: {
    present: true,
    status: "CREATE_COMPLETE",
    outdated: false,
    version: 2,
    available_version: 2,
  },
  security_group: { inbound_rules: 0, ok: true },
  env_overrides: [],
  unparseable_rows: [],
  heartbeats: [],
  findings: [],
  instance_drift: [],
  tailscale: { available: true, missing: [], stale: [], detail: null, policy: null },
  local_tailscale: { ok: true, tailnet: "acme.ts.net", https_certificates: true, detail: null },
  network: {
    mode: "public",
    stack_mode: "public",
    consistent: true,
    nat: null,
    checked_nat: false,
    drifted: [],
  },
};

const META = {
  initialized: true,
  home: "/tmp/hermetic-home",
  config: {
    name: "main",
    fleet_id: FAKE_TARGET.fleet_id,
    account_id: FAKE_TARGET.account_id,
    region: FAKE_TARGET.region,
  },
  fleet: { id: FAKE_TARGET.fleet_id, alias: "main", default: FAKE_TARGET.fleet_id },
  fixture: true,
};

const ROUTES = {
  "meta.get": META,
  "fleets.list": { directory_region: "us-east-1", directory_error: null, fleets: [] },
  "agents.list": [],
  "ops.list": { ops: [] },
  doctor: DOCTOR,
};

/** The popover as `App.tsx` mounts it (meta from the fleet provider), beside Settings' section. */
function Both() {
  const fleet = useFleet();
  return (
    <>
      <FleetMenu meta={fleet.meta} />
      <DiagnosticsSection />
    </>
  );
}

function renderPage() {
  return render(<FleetProvider>{withNav(<Both />)}</FleetProvider>);
}

async function openPopover(user: ReturnType<typeof userEvent.setup>): Promise<void> {
  await waitFor(() => expect(document.querySelector(".envstrip-fleet-name")?.textContent).toBe("main"));
  await user.click(screen.getByRole("button", { name: /switch fleet/i }));
}

describe("shared doctor run", () => {
  test("a run from Settings › Diagnostics shows in the fleet popover", async () => {
    server = fakeServer(ROUTES);
    const user = userEvent.setup();
    renderPage();

    await user.click(screen.getByRole("button", { name: "Run doctor" }));
    await screen.findByRole("button", { name: "Run doctor again" });
    expect(server.to("doctor").length).toBe(1);

    await openPopover(user);
    await screen.findByText("account matches");
    expect(screen.queryByText("doctor not run")).toBeNull();
    expect(screen.getByRole("button", { name: "run doctor again →" })).toBeTruthy();
  });

  test("a run for another fleet is not shown as this one's", async () => {
    server = fakeServer(ROUTES);
    const user = userEvent.setup();
    renderPage();

    await user.click(screen.getByRole("button", { name: "Run doctor" }));
    await screen.findByRole("button", { name: "Run doctor again" });

    // The page's target moved (a switch, or the fleet moved under the tab); the
    // popover opening is the render that reads it.
    act(() => setFleetTarget({ ...FAKE_TARGET, fleet_id: "sg7k2m4p" }));
    await openPopover(user);
    await waitFor(() => expect(screen.getByText("doctor not run")).toBeTruthy());
    expect(screen.queryByText("account matches")).toBeNull();
  });
});
