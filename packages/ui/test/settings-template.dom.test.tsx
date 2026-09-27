/**
 * The S-1 Settings template's behaviours, driven (`docs/ui-brief.md` § Settings):
 * fleet-wide fields stage and go out together from the save bar, which counts
 * and names them; the default-profile select is an instant command outside that
 * count, with its own `✓ saved`; a staged draft outlives a visit to another
 * section and the rail says it is waiting; a `CONFLICT` turns the bar into a
 * reload; and a refused list action stays visible, with its reason, in the
 * row's `…` menu.
 */
import { cleanup, render, screen, userEvent, waitFor, within } from "./dom.ts";
import { afterEach, describe, expect, test } from "bun:test";
import { useState } from "react";
import type { Meta, SettingsResult } from "../src/api/index.ts";
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

function settings(version: number, volume = 100): SettingsResult {
  return {
    persisted: true,
    catalog: {},
    settings: {
      version,
      defaults: {
        size: "medium",
        provider: "bedrock",
        volume_gib: volume,
        browser: true,
        secrets: "none",
      },
      agent_defaults: {},
      providers: {},
      secrets: [],
      updated_at: "2026-09-06T00:00:00.000Z",
      updated_by: "evan",
    },
  } as unknown as SettingsResult;
}

const META = {
  initialized: true,
  home: "/tmp/hermetic-home",
  config: { fleet_id: "fxtr0001", account_id: "123456789012", region: "us-west-2" },
  settings: settings(7),
} as unknown as Meta;

/** The shell with the section as real state, the way `App` holds it. */
function Harness({ start = "defaults" }: { start?: SettingsSection }) {
  const [section, setSection] = useState<SettingsSection>(start);
  return (
    <SettingsShell
      meta={META}
      profiles={fixtureProfilesState()}
      section={section}
      onSection={setSection}
      onBack={() => {}}
      onOpenTeardown={() => {}}
      onOpenFoundationUpdate={() => {}}
    />
  );
}

const bar = () => document.querySelector(".st-save") as HTMLElement | null;
const rail = (id: string) => document.querySelector(`[data-rail="${id}"]`) as HTMLElement;

describe("Settings · save bar", () => {
  test("staged fields are counted and named, and Save sends only them with expected_version", async () => {
    server = fakeServer({ "settings.set": settings(8, 200) });
    const user = userEvent.setup();
    render(<Harness />);

    expect(bar()).toBeNull();
    // §4.6: the machine fields are not on this page any more.
    expect(screen.queryByLabelText("Size")).toBeNull();
    expect(screen.queryByLabelText("Data volume (GiB)")).toBeNull();
    await user.click(
      within(screen.getByRole("group", { name: "Secrets mode" })).getByRole("button", {
        name: "bitwarden",
      }),
    );

    expect(bar()?.textContent).toContain("1 unsaved change");
    expect(bar()?.textContent).toContain("secrets mode");
    expect(bar()?.textContent).toContain("fxtr0001 · rev 7");
    // The staged row carries the edge and says what it was.
    const row = document.querySelector('[data-field="secrets"]') as HTMLElement;
    expect(row.className).toContain("chg");
    expect(row.textContent).toContain("was none");

    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(server?.to("settings.set").length).toBe(1));
    const sent = server.to("settings.set")[0]?.params as { defaults?: Record<string, unknown> };
    expect(sent).toMatchObject({ defaults: { secrets: "bitwarden" }, expected_version: 7 });
    // Only what changed — never a stale size or disk the page no longer shows.
    expect(Object.keys(sent.defaults ?? {})).toEqual(["secrets"]);
    expect(server.to("settings.set")[0]?.params).not.toHaveProperty("agent_defaults");
  });

  test("a CONFLICT turns the bar into 'changed on another laptop' with a Reload", async () => {
    server = fakeServer({
      "settings.set": errorBody("CONFLICT", "settings moved to version 8"),
      "settings.get": settings(8),
    });
    const user = userEvent.setup();
    render(<Harness />);

    await user.click(
      within(screen.getByRole("group", { name: "Secrets mode" })).getByRole("button", {
        name: "bitwarden",
      }),
    );
    await user.click(screen.getByRole("button", { name: "Save" }));
    await screen.findByText("Changed on another laptop");
    expect(bar()?.className).toContain("st-save-conf");

    await user.click(within(bar() as HTMLElement).getByRole("button", { name: "Reload" }));
    await waitFor(() => expect(server?.to("settings.get").length).toBe(1));
    // The fleet's defaults did not move, so the staged edit is still here —
    // and it would now go out against the version just read.
    await waitFor(() => expect(bar()?.textContent).toContain("rev 8"));
    expect(bar()?.textContent).not.toContain("Changed on another laptop");
  });

  test("the default profile saves at once, with a tick, and never enters the bar's count", async () => {
    server = fakeServer({ "providers.update": {}, "settings.get": settings(8) });
    const user = userEvent.setup();
    render(<Harness />);

    await user.selectOptions(screen.getByLabelText("Default provider profile"), "0pr0ut3r");
    await waitFor(() => expect(server?.to("providers.update").length).toBe(1));
    expect(server.to("providers.update")[0]?.params).toMatchObject({
      profile: "0pr0ut3r",
      default: true,
      expected_version: 7,
    });
    await screen.findByText("✓ saved");
    // A command, not a staged field: nothing waits on the bar.
    expect(bar()).toBeNull();
    expect(server.to("settings.set").length).toBe(0);
  });
});

describe("Settings · leaving with unsaved changes", () => {
  test("the draft survives another section, and the rail marks Defaults until it is discarded", async () => {
    server = fakeServer({ "secrets.list": { secrets: [] } });
    const user = userEvent.setup();
    render(<Harness />);

    expect(rail("defaults").querySelector(".sq.acc")).toBeNull();
    await user.selectOptions(screen.getByLabelText("Reasoning effort"), "high");
    expect(rail("defaults").querySelector(".sq.acc")).not.toBeNull();

    await user.click(rail("secrets"));
    await screen.findByText("No shared secrets");
    // Off the page, the draft is still staged — and the rail says so.
    expect(rail("defaults").querySelector(".sq.acc")).not.toBeNull();

    await user.click(rail("defaults"));
    expect((screen.getByLabelText("Reasoning effort") as HTMLSelectElement).value).toBe("high");
    expect(bar()?.textContent).toContain("1 unsaved change");

    await user.click(screen.getByRole("button", { name: "Discard" }));
    expect((screen.getByLabelText("Reasoning effort") as HTMLSelectElement).value).toBe("");
    expect(rail("defaults").querySelector(".sq.acc")).toBeNull();
    expect(bar()).toBeNull();
  });
});

describe("Settings · list actions", () => {
  test("a refused action stays in the row's menu, dimmed, with its reason; Escape closes only the menu", async () => {
    server = fakeServer({});
    const user = userEvent.setup();
    render(<Harness start="providers" />);

    await user.click(screen.getByRole("button", { name: "More actions for anthropic-main" }));
    const menu = screen.getByRole("menu");
    const del = within(menu).getByRole("menuitem", { name: /Delete/ }) as HTMLButtonElement;
    expect(del.disabled).toBe(true);
    expect(del.textContent).toContain("still used by lumen");
    // The default's own row offers no Set-as-default at all: its "fleet
    // default" tag already says it, so there is nothing to refuse.
    expect(within(menu).queryByRole("menuitem", { name: /Set as fleet default/ })).toBeNull();

    await user.keyboard("{Escape}");
    expect(screen.queryByRole("menu")).toBeNull();
    // Still on Providers: the menu took the Escape, nothing behind it did.
    expect(rail("providers").getAttribute("aria-current")).toBe("page");
  });

  test("an allowed menu action runs its command", async () => {
    server = fakeServer({ "providers.update": {}, "settings.get": settings(8) });
    const user = userEvent.setup();
    render(<Harness start="providers" />);

    await user.click(screen.getByRole("button", { name: "More actions for openrouter-cheap" }));
    await user.click(screen.getByRole("menuitem", { name: /Set as fleet default/ }));
    await waitFor(() => expect(server?.to("providers.update").length).toBe(1));
    expect(server.to("providers.update")[0]?.params).toMatchObject({
      profile: "0pr0ut3r",
      default: true,
    });
    expect(screen.queryByRole("menu")).toBeNull();
  });
});
