/**
 * §4.8's fleet switcher, driven through the env strip the way an operator
 * reaches it.
 *
 * `test/fleet-switch.test.ts` covers the pure rules (order, switchability,
 * badges, confirm copy); what it cannot see is the part that actually moves the
 * portal — that a switch takes an explicit second click, that the one round
 * trip it makes is `fleets.switch`, that the strip re-reads itself
 * off the `meta` that reply carried rather than from a second fetch, and that a
 * refusal lands beside the row that asked for it instead of vanishing.
 *
 * The host below is the shape `App.tsx` uses — the fleet provider's `meta` into
 * `<EnvStrip/>` — so "the strip then reads staging" is the same wiring the real
 * page has, not a prop the test set itself.
 */
import { act, cleanup, render, screen, userEvent, waitFor, within } from "./dom.ts";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { App } from "../src/App.tsx";
import { EnvStrip } from "../src/components/EnvStrip.tsx";
import { FleetProvider, useFleet } from "../src/state/state.tsx";
import { errorBody, fakeServer } from "./fake-transport.ts";
import type { FakeServer } from "./fake-transport.ts";
import { FakeStream } from "./fake-stream.ts";
import { withNav } from "./nav.tsx";

let server: FakeServer | null = null;

beforeEach(() => {
  window.location.hash = "";
});
afterEach(() => {
  cleanup();
  server?.restore();
  server = null;
});

function config(name: string, fleetId: string) {
  return {
    name,
    fleet_id: fleetId,
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

function meta(name: string, fleetId: string) {
  return {
    initialized: true,
    home: "/tmp/hermetic-home",
    header: `▸ ${name} · acme · 123456789012 · us-west-2`,
    config: config(name, fleetId),
    // §4.6: `id` and `default` are `fleet_id`s; `alias` is the display label.
    fleet: { id: fleetId, alias: name, default: "m4in0abc", directory_region: "us-east-1" },
    fixture: true,
    hermes_version: "1.2.0",
    hermeticd_version: "1.2.0",
    tailnet: "acme.ts.net",
    last_teardown: null,
  };
}

/** `main` is open and default; `staging` is frozen here and a version behind. */
const FLEETS = {
  directory_region: "us-east-1",
  directory_error: null,
  fleets: [
    {
      name: "main",
      fleet_id: "m4in0abc",
      account_id: "123456789012",
      region: "us-west-2",
      local: true,
      registered: true,
      default: true,
      current: true,
      status: "active",
      foundation_version: 3,
      update_available: false,
      updated_at: "2026-09-01T00:00:00.000Z",
    },
    {
      name: "staging",
      fleet_id: "sg7k2m4p",
      account_id: "123456789012",
      region: "us-west-2",
      local: true,
      registered: true,
      default: false,
      current: false,
      status: "active",
      foundation_version: 2,
      update_available: true,
      updated_at: "2026-09-01T00:00:00.000Z",
    },
    /* In the directory, never attached on this laptop. */
    {
      name: "sandbox",
      fleet_id: "sbx09qq1",
      account_id: "123456789012",
      region: "eu-west-1",
      local: false,
      registered: true,
      default: false,
      current: false,
      status: "active",
      foundation_version: 3,
      update_available: false,
      updated_at: "2026-09-01T00:00:00.000Z",
    },
    /* Torn down: a history entry, not a destination. */
    {
      name: "zorro",
      fleet_id: "zor00001",
      account_id: "123456789012",
      region: "us-west-2",
      local: true,
      registered: true,
      default: false,
      current: false,
      status: "torn_down",
      foundation_version: 1,
      update_available: false,
      updated_at: "2026-08-01T00:00:00.000Z",
    },
  ],
};

function routes(over: Record<string, unknown> = {}) {
  return {
    "meta.get": meta("main", "m4in0abc"),
    "fleets.list": FLEETS,
    "agents.list": [],
    "ops.list": { ops: [] },
    "fleets.switch": { name: "staging", meta: meta("staging", "sg7k2m4p") },
    "fleets.use": { name: "staging", previous: "main" },
    ...over,
  };
}

/** The env strip exactly as `App.tsx` mounts it: meta from the fleet provider, popover state from nav. */
function Strip() {
  const fleet = useFleet();
  return <EnvStrip meta={fleet.meta} connected={fleet.connected} />;
}
function Host() {
  return withNav(<Strip />);
}

/** What the env strip's fleet button reads — the one place the open fleet is named. */
function headerFleet(): string {
  return document.querySelector(".envstrip-fleet-name")?.textContent ?? "";
}

/** The switcher's trigger: the fleet name on the env strip. */
function switcherButton(): HTMLElement {
  return screen.getByRole("button", { name: /switch fleet/i });
}

function rows(): HTMLElement[] {
  return [...document.querySelectorAll<HTMLElement>(".fleet-sw-row")];
}

/**
 * One row by the fleet it names. Deliberately not by index: `sortFleets` owns
 * the order and has its own tests, so pinning positions here would make this
 * file fail for a reason it is not about.
 */
function rowFor(name: string): HTMLElement {
  const found = rows().find((r) => r.querySelector(".fleet-sw-name b")?.textContent === name);
  if (!found) throw new Error(`no fleet row named ${name} (saw: ${rows().length} rows)`);
  return found;
}

/**
 * Opens the popover and hands back the fleet rows. Every row carries a Switch —
 * the current one's is disabled with its reason as the title — so the tests
 * scope their queries to a row rather than to the document.
 */
async function openSwitcher(user: ReturnType<typeof userEvent.setup>): Promise<void> {
  render(
    <FleetProvider>
      <Host />
    </FleetProvider>,
  );
  // The trigger only says a fleet name once `meta.get` has answered.
  await waitFor(() => expect(headerFleet()).toBe("main"));
  await user.click(switcherButton());
  await waitFor(() => expect(rows().length).toBe(FLEETS.fleets.length));
}

describe("fleet switcher", () => {
  test("fleet switch remounts Settings, dropping cached saves and unsaved drafts", async () => {
    function settings(model: string, version: number) {
      return {
        persisted: true,
        catalog: {},
        settings: {
          version,
          defaults: {
            size: "medium",
            provider: "bedrock",
            volume_gib: 100,
            browser: true,
            secrets: "none",
          },
          agent_defaults: { model },
          providers: { bedrock: { enabled: true } },
          secrets: [],
        },
      };
    }
    let current = { ...meta("main", "m4in0abc"), settings: settings("main-model", 1) };
    const staging = { ...meta("staging", "sg7k2m4p"), settings: settings("staging-model", 1) };
    server = fakeServer(
      routes({
        "meta.get": () => current,
        "settings.set": settings("saved-main-model", 2),
        "volumes.list": { volumes: [], summary: { total: 0, read_at: "2026-09-01T00:00:00Z" } },
        "fleets.switch": () => {
          current = staging;
          return { name: "staging", meta: staging };
        },
      }),
    );
    window.location.hash = "#settings/defaults";
    const user = userEvent.setup();
    render(
      <FleetProvider>
        <App />
      </FleetProvider>,
    );
    const model = await screen.findByLabelText(/^Model/);
    await user.clear(model);
    await user.type(model, "saved-main-model");
    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(server?.to("settings.set").length).toBe(1));
    await user.type(model, "-unsaved");
    await user.click(switcherButton());
    await user.click(within(rowFor("staging")).getByRole("button", { name: "Switch" }));
    expect(screen.getByText(/Unsaved settings and open drafts will be discarded/)).toBeTruthy();
    await user.click(within(rowFor("staging")).getByRole("button", { name: "Switch target" }));
    await waitFor(() =>
      expect((screen.getByLabelText(/^Model/) as HTMLInputElement).value).toBe("staging-model"),
    );
    expect(screen.getByRole("navigation", { name: "Settings sections" })).toBeTruthy();
  });

  test("Doctor failure offers retry and refresh failure retains the last good result", async () => {
    let reads = 0;
    server = fakeServer(
      routes({
        doctor: () =>
          ++reads === 2
            ? {
                account: { ok: true },
                foundation: { present: true, status: "CREATE_COMPLETE", outdated: false },
                security_group: { ok: true, inbound_rules: 0 },
                findings: [],
              }
            : errorBody("OFFLINE", "Doctor unavailable"),
      }),
    );
    const user = userEvent.setup();
    await openSwitcher(user);
    await user.click(screen.getByRole("button", { name: "run doctor →" }));
    await screen.findByText(/Could not run doctor: Doctor unavailable/);
    expect(screen.queryByText("doctor not run")).toBeNull();
    await user.click(screen.getByRole("button", { name: "Retry doctor" }));
    await screen.findByText("account matches");
    await user.click(screen.getByRole("button", { name: "run doctor again →" }));
    await screen.findByText(/showing the last good result/);
    expect(screen.getByText("account matches")).toBeTruthy();
  });

  test("lists every fleet the account has, and says what each row can do", async () => {
    server = fakeServer(routes());
    const user = userEvent.setup();
    await openSwitcher(user);
    const [mainRow, stagingRow, sandboxRow, zorroRow] = [
      rowFor("main"),
      rowFor("staging"),
      rowFor("sandbox"),
      rowFor("zorro"),
    ];

    // Current first (`sortFleets`), and it is the one marked as such.
    expect(mainRow?.className).toContain("current");
    expect(mainRow?.textContent).toContain("main");
    expect(stagingRow?.textContent).toContain("staging");
    expect(stagingRow?.textContent).toContain("update available");
    expect(stagingRow?.textContent).toContain("us-west-2");
    // The open fleet has nothing to switch to, and says why rather than
    // offering a control that does nothing.
    const here = within(mainRow as HTMLElement).getByRole("button", { name: "Switch" });
    expect(here.hasAttribute("disabled")).toBe(true);
    expect(here.getAttribute("title")).toBe("current fleet");
    // The frozen facts the popover used to be entirely made of are still here.
    const facts = document.querySelector(".fleet-sw-facts") as HTMLElement;
    expect(facts.textContent).toContain("123456789012");
    expect(facts.textContent).toContain("acme-dev");
    expect(facts.textContent).toContain("/tmp/hermetic-home");
    const notes = [...document.querySelectorAll(".fleet-sw > .fleet-sw-note")];
    expect(
      notes.some((n) =>
        /hermetic init --attach --fleet &lt;id&gt;|--fleet <id>/.test(n.textContent ?? ""),
      ),
    ).toBe(true);

    // A fleet this laptop has never attached: refused, and refused *visibly* —
    // a disabled control whose reason needs a hover is a control with no reason.
    const sandbox = within(sandboxRow as HTMLElement);
    expect(sandbox.getByRole("button", { name: "Switch" }).hasAttribute("disabled")).toBe(true);
    expect(sandboxRow?.textContent).toContain("hermetic init --attach --fleet sbx09qq1");
    // `fleets.use` would answer NOT_FOUND, so the row does not ask (`defaultable`).
    expect(sandbox.queryByRole("button", { name: "make default" })).toBeNull();

    // A torn-down fleet is history: nothing to switch to, nothing to default to.
    const zorro = within(zorroRow as HTMLElement);
    expect(zorro.getByRole("button", { name: "Switch" }).hasAttribute("disabled")).toBe(true);
    expect(zorroRow?.textContent).toContain("torn down");
    expect(zorro.queryByRole("button", { name: "make default" })).toBeNull();
    expect(zorroRow?.querySelector(".sq.muted")).not.toBeNull();
  });

  /**
   * A home with one fleet, frozen locally, has nowhere to attach *from*. The
   * hint would be a permanent instruction to solve a problem that laptop does
   * not have — and a line that is always on screen and never applies is the
   * first one an operator learns to stop reading.
   */
  test("a lone local fleet shows no attach hint", async () => {
    const only = FLEETS.fleets.find((f) => f.name === "main")!;
    server = fakeServer(routes({ "fleets.list": { ...FLEETS, fleets: [only] } }));
    const user = userEvent.setup();
    render(
      <FleetProvider>
        <Host />
      </FleetProvider>,
    );
    await waitFor(() => expect(headerFleet()).toBe("main"));
    await user.click(switcherButton());
    await waitFor(() => expect(rows().length).toBe(1));

    const notes = [...document.querySelectorAll(".fleet-sw > .fleet-sw-note")];
    expect(notes.some((n) => (n.textContent ?? "").includes("--attach"))).toBe(false);
  });

  test("a switch needs a confirm, and posts exactly once when confirmed", async () => {
    server = fakeServer(routes());
    const user = userEvent.setup();
    await openSwitcher(user);
    const stagingRow = rowFor("staging");

    await user.click(within(stagingRow as HTMLElement).getByRole("button", { name: "Switch" }));
    // The confirm names both ends of the move (`confirmSwitchText`).
    await screen.findByText("Switch from main to staging (us-west-2)?");
    expect(server.to("fleets.switch").length).toBe(0);

    await user.click(screen.getByRole("button", { name: "Switch target" }));
    await waitFor(() => expect(server?.to("fleets.switch").length).toBe(1));
    // §4.6: the row's action target is its `fleet_id`, never its alias.
    expect(server.to("fleets.switch")[0]?.params).toEqual({ fleet: "sg7k2m4p" });

    // The header reads the fleet off the `meta` the switch replied with — no
    // second `meta.get` was needed to learn where the portal now points.
    await waitFor(() => expect(headerFleet()).toBe("staging"));
    expect(server.to("meta.get").length).toBe(1);
  });

  test("a refused switch is reported beside the row that asked for it", async () => {
    server = fakeServer(
      routes({
        "fleets.switch": errorBody(
          "CONFLICT",
          "an operation is running; wait for it to finish before switching fleets",
        ),
      }),
    );
    const user = userEvent.setup();
    await openSwitcher(user);
    const stagingRow = rowFor("staging");

    await user.click(within(stagingRow as HTMLElement).getByRole("button", { name: "Switch" }));
    await user.click(screen.getByRole("button", { name: "Switch target" }));

    await screen.findByText(/an operation is running/);
    // Still on `main`, and the confirm is still up to be retried or cancelled.
    expect(headerFleet()).toBe("main");
    expect(screen.getByRole("button", { name: "Switch target" })).toBeDefined();
  });

  test("`make default` writes the local preference and re-reads the list", async () => {
    server = fakeServer(routes());
    const user = userEvent.setup();
    await openSwitcher(user);

    const before = server.to("fleets.list").length;
    await user.click(screen.getByRole("button", { name: "make default" }));

    await waitFor(() => expect(server?.to("fleets.use").length).toBe(1));
    expect(server.to("fleets.use")[0]?.params).toEqual({ fleet: "sg7k2m4p" });
    // The default marker moves only when the server says it did, so the list is
    // read again rather than patched in place.
    await waitFor(() => expect(server?.to("fleets.list").length).toBe(before + 1));
    // No switch rode along with it: naming the default moves no portal.
    expect(server.to("fleets.switch").length).toBe(0);
  });
});

/**
 * The switch as the whole page sees it. `FleetSwitcher` on its own can prove
 * the round trip happens; only `App` can prove the *rest* of the screen stops
 * describing the fleet that just left — the open agent drawer names an agent
 * this fleet has never had, and the volume inventory (on its own 30 s poll)
 * would otherwise keep the previous fleet's loose-volume counts on the toolbar
 * for up to half a minute with nothing saying they were stale.
 */
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

const VOLUMES = {
  volumes: [],
  summary: { read_at: "2026-09-05T12:00:00.000Z", free: 0, free_gib: 0, monthly_cost: 0 },
};

function appRoutes(over: Record<string, unknown> = {}) {
  return {
    ...routes(),
    "volumes.list": VOLUMES,
    // The per-agent reads the drawer makes, none of which this suite is about.
    "agents.history": { error: { code: "NOT_ASKED", message: "not scripted here" } },
    "agents.probe": { error: { code: "NOT_ASKED", message: "not scripted here" } },
    "agents.desktop": { error: { code: "NOT_ASKED", message: "not scripted here" } },
    ...over,
  };
}

describe("fleet switch · the whole page", () => {
  test("closes the agent drawer and forgets the old fleet's volumes", async () => {
    server = fakeServer(appRoutes());
    const user = userEvent.setup();
    render(
      <FleetProvider>
        <App />
      </FleetProvider>,
    );

    // One agent, delivered the way the server delivers one. The fleet stream by
    // name rather than "any stream": the page also opens the chat fan-in
    // (the `chat` subscription, §9.2) and the two race to be first.
    await waitFor(() => expect(FakeStream.instances.some((s) => s.name === "fleet")).toBe(true));
    await act(async () => {
      FakeStream.last("fleet").emit("snapshot", {
        agents: [agent("lumen")],
        at: "2026-09-05T12:00:00.000Z",
        scanned: true,
      });
    });

    await user.click(await screen.findByText("lumen"));
    await waitFor(() => expect(document.querySelector(".drawer")).not.toBeNull());
    await waitFor(() => expect(server?.to("volumes.list").length).toBeGreaterThan(0));
    const volumeReads = server.to("volumes.list").length;

    await user.click(switcherButton());
    await waitFor(() => expect(rows().length).toBe(FLEETS.fleets.length));
    await user.click(within(rowFor("staging")).getByRole("button", { name: "Switch" }));
    await user.click(screen.getByRole("button", { name: "Switch target" }));

    await waitFor(() => expect(headerFleet()).toBe("staging"));
    // The drawer named `lumen`, which belongs to the fleet that just left.
    await waitFor(() => expect(document.querySelector(".drawer")).toBeNull());
    // And the inventory is read again rather than aged out 30 s later.
    await waitFor(() => expect(server?.to("volumes.list").length).toBeGreaterThan(volumeReads));
  });
});

/**
 * §4.8's pre-open state. `initialized: false` with a `fleet_error` is not an
 * unbound home — it is a home with fleets and no answer to "which one", and
 * answering it with the init wizard would invite a second foundation onto an
 * account that already has one.
 */
describe("fleet picker", () => {
  const UNCHOSEN = {
    initialized: false,
    home: "/tmp/hermetic-home",
    header: "▸ no fleet selected",
    config: null,
    fleet: { id: null, alias: null, default: null, directory_region: "us-east-1" },
    fleet_error: {
      code: "FLEET_REQUIRED",
      message: "more than one fleet is frozen here and none is the default",
    },
    fixture: true,
    hermes_version: null,
    hermeticd_version: null,
    tailnet: null,
    last_teardown: null,
  };

  /** Every row is switchable in this state: nothing is current yet. */
  const UNCHOSEN_FLEETS = {
    ...FLEETS,
    fleets: FLEETS.fleets.map((f) => ({ ...f, current: false })),
  };

  test("offers the choice instead of the wizard, and opens the fleet that is picked", async () => {
    server = fakeServer(appRoutes({ "meta.get": UNCHOSEN, "fleets.list": UNCHOSEN_FLEETS }));
    const user = userEvent.setup();
    render(
      <FleetProvider>
        <App />
      </FleetProvider>,
    );

    await screen.findByText("Choose a fleet");
    expect(screen.getByText(/none is the default/)).toBeDefined();
    // The wizard is what this state used to get, and must not be what it gets.
    expect(document.querySelector(".wizard")).toBeNull();

    await waitFor(() => expect(rows().length).toBe(FLEETS.fleets.length));
    await user.click(within(rowFor("staging")).getByRole("button", { name: "Switch" }));
    // No current fleet, so the confirm has no `from` clause (`confirmSwitchText`).
    await screen.findByText("Switch to staging (us-west-2)?");
    await user.click(screen.getByRole("button", { name: "Switch target" }));

    // The reply's meta is initialized, so the dashboard replaces the picker.
    await waitFor(() => expect(screen.queryByText("Choose a fleet")).toBeNull());
    await waitFor(() => expect(headerFleet()).toBe("staging"));
  });
});
