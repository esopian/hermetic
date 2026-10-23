/**
 * Foundation's "Auto-update hermeticd" switch (§6.5): an instant-save On/Off
 * over `FleetSettings.auto_update_hermeticd`. Absent reads as On (core's
 * `autoUpdateHermeticd`, not a default restated here); a click sends only that
 * field and the settings version the page holds; a `CONFLICT` reloads the
 * settings and says so instead of leaving the operator on a stale version.
 */
import { cleanup, render, screen, userEvent, waitFor, within } from "./dom.ts";
import { afterEach, describe, expect, test } from "bun:test";
import { useState } from "react";
import type { FoundationStatus, Meta, SettingsResult } from "../src/api/index.ts";
import { SettingsShell } from "../src/components/settings/SettingsShell.tsx";
import type { SettingsSection } from "../src/nav/settings-nav.ts";
import { errorBody, fakeServer } from "./fake-transport.ts";
import type { FakeServer } from "./fake-transport.ts";
import { fixtureProfilesState } from "./profiles-fixture.ts";

let server: FakeServer | null = null;
afterEach(() => {
  cleanup();
  server?.restore();
  server = null;
});

function settings(version: number, auto?: boolean, persisted = true): SettingsResult {
  return {
    persisted,
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
      agent_defaults: {},
      providers: {},
      secrets: [],
      ...(auto === undefined ? {} : { auto_update_hermeticd: auto }),
      updated_at: "2026-09-06T00:00:00.000Z",
      updated_by: "evan",
    },
  } as unknown as SettingsResult;
}

function foundation(inProgress = false): FoundationStatus {
  return {
    fleet: {
      foundation_version: 10,
      template_sha256: "a".repeat(64),
      hermeticd_version: "0.6.0",
      ubuntu_release: "noble",
      ami_id: "ami-0123456789abcdef0",
      network: null,
    },
    available: { foundation_version: 10, template_sha256: "a".repeat(64), hermeticd_version: "0.6.0" },
    update_available: false,
    tool_outdated: false,
    in_progress: inProgress ? { owner: "evan", expires: "2026-09-06T01:00:00.000Z" } : null,
    agents: [],
    hermes: null,
    stale_bedrock_grants: [],
  } as unknown as FoundationStatus;
}

function meta(s: SettingsResult, f: FoundationStatus = foundation()): Meta {
  return {
    initialized: true,
    home: "/tmp/hermetic-home",
    config: { fleet_id: "fxtr0001", account_id: "123456789012", region: "us-west-2" },
    settings: s,
    foundation: f,
  } as unknown as Meta;
}

function Harness({ m }: { m: Meta }) {
  const [section, setSection] = useState<SettingsSection>("foundation");
  return (
    <SettingsShell
      meta={m}
      profiles={fixtureProfilesState()}
      section={section}
      onSection={setSection}
      onBack={() => {}}
      onOpenTeardown={() => {}}
      onOpenFoundationUpdate={() => {}}
    />
  );
}

const NETWORK = { "network.status": errorBody("INTERNAL", "no network in tests") };
const group = () => screen.getByRole("group", { name: "Auto-update hermeticd" });
const button = (name: "On" | "Off") =>
  within(group()).getByRole("button", { name }) as HTMLButtonElement;
/** The section's own `network.status` read has landed, so no state update is left to arrive late. */
const settled = () => screen.findByText(/network status unavailable/);
const pressed = (name: "On" | "Off") => button(name).getAttribute("aria-pressed");

describe("Foundation · auto-update hermeticd", () => {
  test("absent reads as On, and the helper line says what On means", async () => {
    server = fakeServer(NETWORK);
    render(<Harness m={meta(settings(7))} />);
    await settled();

    expect(pressed("On")).toBe("true");
    expect(pressed("Off")).toBe("false");
    expect(document.querySelector('[data-field="auto_update_hermeticd"]')?.textContent).toContain(
      "within minutes",
    );
  });

  test("Off sends only the flag and the held version, then shows Off and its helper line", async () => {
    server = fakeServer({ ...NETWORK, "settings.set": settings(8, false) });
    const user = userEvent.setup();
    render(<Harness m={meta(settings(7))} />);

    await user.click(button("Off"));
    await waitFor(() => expect(server?.to("settings.set").length).toBe(1));
    const sent = server.to("settings.set")[0]?.params as Record<string, unknown>;
    expect(sent).toMatchObject({ auto_update_hermeticd: false, expected_version: 7 });
    expect(Object.keys(sent).sort()).toEqual(["auto_update_hermeticd", "expected_version", "target"]);

    await waitFor(() => expect(pressed("Off")).toBe("true"));
    expect(pressed("On")).toBe("false");
    const row = document.querySelector('[data-field="auto_update_hermeticd"]') as HTMLElement;
    expect(row.textContent).toContain("nightly");
    expect(row.textContent).toContain("--now");
    await screen.findByText("✓ saved");
  });

  test("a warning from core is shown in warn style, the setting is still held, and no tick", async () => {
    const warning =
      "hermeticd auto-update is saved as off, but the fleet manifest could not be republished (boom); run `hermetic artifacts push`";
    server = fakeServer({ ...NETWORK, "settings.set": { ...settings(8, false), warning } });
    const user = userEvent.setup();
    render(<Harness m={meta(settings(7))} />);

    await user.click(button("Off"));
    const note = await screen.findByText(warning);
    expect(note.closest(".st-callout")?.className).toContain("warn");
    // It did save: the shell holds version 8's document, so Off is what shows.
    await waitFor(() => expect(pressed("Off")).toBe("true"));
    expect(screen.queryByText("✓ saved")).toBeNull();

    // The next write goes against the version the warned save returned.
    await user.click(button("On"));
    await waitFor(() => expect(server?.to("settings.set").length).toBe(2));
    expect(server.to("settings.set")[1]?.params).toMatchObject({ expected_version: 8 });
  });

  test("On from Off sends true against the version the last save returned", async () => {
    server = fakeServer({ ...NETWORK, "settings.set": settings(9, true) });
    const user = userEvent.setup();
    render(<Harness m={meta(settings(7, false))} />);

    expect(pressed("Off")).toBe("true");
    await user.click(button("On"));
    await waitFor(() => expect(server?.to("settings.set").length).toBe(1));
    expect(server.to("settings.set")[0]?.params).toMatchObject({
      auto_update_hermeticd: true,
      expected_version: 7,
    });
    await waitFor(() => expect(pressed("On")).toBe("true"));
  });

  test("clicking the state already shown sends nothing", async () => {
    server = fakeServer(NETWORK);
    const user = userEvent.setup();
    render(<Harness m={meta(settings(7))} />);

    await user.click(button("On"));
    expect(server.to("settings.set").length).toBe(0);
  });

  test("an unpersisted fleet is written against null, not the synthesized version", async () => {
    server = fakeServer({ ...NETWORK, "settings.set": settings(1, false) });
    const user = userEvent.setup();
    render(<Harness m={meta(settings(1, undefined, false))} />);

    await user.click(button("Off"));
    await waitFor(() => expect(server?.to("settings.set").length).toBe(1));
    expect(server.to("settings.set")[0]?.params).toMatchObject({ expected_version: null });
  });

  test("a CONFLICT reloads the settings, says so, and leaves the shown value alone", async () => {
    server = fakeServer({
      ...NETWORK,
      "settings.set": errorBody("CONFLICT", "settings moved to version 8"),
      "settings.get": settings(8),
    });
    const user = userEvent.setup();
    render(<Harness m={meta(settings(7))} />);

    await user.click(button("Off"));
    await screen.findByText(/Changed on another laptop/);
    await waitFor(() => expect(server?.to("settings.get").length).toBe(1));
    expect(pressed("On")).toBe("true");
    expect(button("Off").disabled).toBe(false);

    // The retry is composed against the version just read.
    await user.click(button("Off"));
    await waitFor(() => expect(server?.to("settings.set").length).toBe(2));
    expect(server.to("settings.set")[1]?.params).toMatchObject({ expected_version: 8 });
  });

  test("any other failure is shown with its code, and nothing flips", async () => {
    server = fakeServer({ ...NETWORK, "settings.set": errorBody("INTERNAL", "boom") });
    const user = userEvent.setup();
    render(<Harness m={meta(settings(7))} />);

    await user.click(button("Off"));
    await screen.findByText("INTERNAL · boom");
    expect(pressed("On")).toBe("true");
    expect(server.to("settings.get").length).toBe(0);
  });

  test("a running foundation update holds the switch", async () => {
    server = fakeServer(NETWORK);
    render(<Harness m={meta(settings(7), foundation(true))} />);
    await settled();

    expect(button("On").disabled).toBe(true);
    expect(button("Off").disabled).toBe(true);
    expect(group().getAttribute("title")).toBe("a foundation update is running");
  });
});

/**
 * §6.6's `auto_upgrade` beside it: the same instant-save On/Off, but absent
 * reads as Off (core's `autoUpgrade`), and the helper line says what On does.
 */
describe("Foundation · auto-upgrade fleet", () => {
  const upgrade = () => screen.getByRole("group", { name: "Auto-upgrade fleet" });
  const upButton = (name: "On" | "Off") =>
    within(upgrade()).getByRole("button", { name }) as HTMLButtonElement;
  const row = () => document.querySelector('[data-field="auto_upgrade"]') as HTMLElement;

  test("absent reads as Off, and the helper line says what On would do", async () => {
    server = fakeServer(NETWORK);
    render(<Harness m={meta(settings(7))} />);
    await settled();

    expect(upButton("Off").getAttribute("aria-pressed")).toBe("true");
    expect(upButton("On").getAttribute("aria-pressed")).toBe("false");
    expect(row().textContent).toContain("restarts Hermes");
    expect(row().querySelector("[title]")?.getAttribute("title")).toContain(
      "never runs a foundation update",
    );
  });

  test("On sends only auto_upgrade and the held version, then shows On", async () => {
    const saved = settings(8);
    (saved.settings as { auto_upgrade?: boolean }).auto_upgrade = true;
    server = fakeServer({ ...NETWORK, "settings.set": saved });
    const user = userEvent.setup();
    render(<Harness m={meta(settings(7))} />);

    await user.click(upButton("On"));
    await waitFor(() => expect(server?.to("settings.set").length).toBe(1));
    const sent = server.to("settings.set")[0]?.params as Record<string, unknown>;
    expect(sent).toMatchObject({ auto_upgrade: true, expected_version: 7 });
    expect(Object.keys(sent).sort()).toEqual(["auto_upgrade", "expected_version", "target"]);
    await waitFor(() => expect(upButton("On").getAttribute("aria-pressed")).toBe("true"));
    expect(row().textContent).toContain("Restarts Hermes on agents");
    // The hermeticd switch beside it is untouched.
    expect(pressed("On")).toBe("true");
  });

  test("a running foundation update holds it too", async () => {
    server = fakeServer(NETWORK);
    render(<Harness m={meta(settings(7), foundation(true))} />);
    await settled();
    expect(upButton("On").disabled).toBe(true);
  });
});
