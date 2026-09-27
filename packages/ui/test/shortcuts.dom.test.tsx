/**
 * `?` — the shortcut that makes the other four findable.
 *
 * `test/shortcuts.test.ts` pins the sheet's contents against `App.tsx`'s key
 * literals by reading the source; it cannot press anything. The half that is
 * only true at runtime is the wiring: the key opens the sheet, Escape closes
 * it before it closes anything underneath (the sheet is raised *from* the other
 * overlays, so it has to be first out of the Escape stack), and a keystroke
 * typed into a field is not a shortcut at all.
 */
import { act, cleanup, fireEvent, render, screen, userEvent, waitFor, within } from "./dom.ts";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { App } from "../src/App.tsx";
import { Portal } from "../src/Portal.tsx";
import { FleetProvider, useFleet } from "../src/state/state.tsx";
import { errorBody, fakeServer } from "./fake-transport.ts";
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
  // The hash, back where this file found it. One case here drives the app to
  // `#chat/atlas/research?session=old-session` and `nav-state.tsx` reads the
  // hash when it mounts, so leaving it set boots the *next* file's portal into
  // Bot Chat. `bun test` runs a run in one process and which file comes next is
  // readdir order, which is why that showed up as a flow test failing on Linux
  // and not on macOS. The `beforeEach` above is this file's own protection
  // against the same thing; this is the other half of it.
  window.location.hash = "";
});

const META = {
  initialized: true,
  home: "/tmp/hermetic-home",
  tailnet: "acme.ts.net",
  adopt_error: null,
  last_teardown: null,
  config: {
    account_id: "123456789012",
    region: "us-west-2",
    fleet_id: "hermetic",
    profile: "acme",
    tailnet: "acme.ts.net",
  },
};

function routes() {
  return {
    "meta.get": META,
    "agents.list": [],
    "volumes.list": { volumes: [], summary: { count: 0, size_gib: 0, monthly_cost_usd: 0 } },
    "ops.list": { ops: [] },
    "secrets.list": { secrets: [] },
  };
}

async function mount(overrides: Record<string, unknown> = {}) {
  server = fakeServer({ ...routes(), ...overrides });
  const user = userEvent.setup();
  render(
    <FleetProvider>
      <App />
    </FleetProvider>,
  );
  // The dashboard only replaces the wizard once `meta.get` says this home is
  // bound, so every assertion below is about the real shell.
  const footer = await screen.findByRole("button", { name: /shortcuts/i });
  // The fleet stream is a fake one that is never fed: the shortcuts
  // sheet is a property of the shell, not of the fleet, and it has to work on
  // a dashboard that is still waiting for its first scan.
  await waitFor(() => expect(FakeStream.last("fleet")).toBeTruthy());
  return { user, footer };
}

const sheet = () => screen.queryByRole("dialog", { name: "Keyboard shortcuts" });

describe("the `?` shortcut", () => {
  test("late teardown receipt dismisses help before taking focus and Escape", async () => {
    const { user } = await mount({
      "plan.teardown": { steps: [], warnings: [], summary: {} },
      "teardowns.list": [
        {
          id: "r-1",
          op_id: "op-teardown-late",
          outcome: "error",
          finished_at: "2026-09-03T05:09:36.000Z",
          account_id: "123456789012",
          region: "us-west-2",
          fleet_id: "hermetic",
          stack_name: "hermetic",
          options: { purge: true, delete_snapshots: false, delete_volumes: false, reset_local: true },
          error: { code: "STACK_FAILED", message: "Stack could not be removed" },
          resources: [],
          events: [],
        },
      ],
    });
    sessionStorage.setItem("hermetic.teardown.opId", "op-teardown-late");
    try {
      await user.keyboard(",");
      await user.click(screen.getByRole("link", { name: "Danger zone" }));
      await user.click(screen.getByRole("button", { name: "Tear down…" }));
      await waitFor(() =>
        expect(FakeStream.last("ops.subscribe").params).toMatchObject({
          op_id: "op-teardown-late",
        }),
      );
      await user.keyboard("?");
      expect(sheet()?.contains(document.activeElement)).toBe(true);

      act(() =>
        FakeStream.last("ops.subscribe").emit("done", {
          ok: false,
          error: { code: "STACK_FAILED", message: "Stack could not be removed" },
        }),
      );
      const receipt = await screen.findByRole("dialog", { name: "Teardown failed" });
      expect(sheet() === null).toBe(true);
      expect(receipt.contains(document.activeElement)).toBe(true);
      await user.keyboard("{Escape}");
      expect(screen.queryByRole("dialog", { name: "Teardown failed" })).toBeNull();
      expect(screen.getByRole("dialog", { name: "Tear down the foundation" })).toBeTruthy();
      expect(screen.getByRole("navigation", { name: "Settings sections" })).toBeTruthy();
    } finally {
      sessionStorage.removeItem("hermetic.teardown.opId");
    }
  });

  test("local policy drawer closes before Settings", async () => {
    const { user } = await mount({
      "policy.status": { scope: "write", managed: "absent", blocks: [], etag: null },
      "plan.policy": errorBody("OFFLINE", "Plan unavailable"),
    });
    await user.keyboard(",");
    await user.click(screen.getByRole("link", { name: "Tailnet policy" }));
    const opener = await screen.findByRole("button", { name: "Preview change…" });
    await user.click(opener);
    expect(screen.getByRole("dialog")).toBeTruthy();
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.getByRole("navigation", { name: "Settings sections" })).toBeTruthy();
    expect(document.activeElement === opener).toBe(true);
  });

  test("volume delete Escape leaves the volumes lens underneath", async () => {
    const { user } = await mount({
      "volumes.list": {
        volumes: [
          {
            volume_id: "vol-123",
            size_gib: 100,
            state: "available",
            group: "no_agent",
            agent: "lumen",
            snapshots: 0,
            attached: false,
            monthly_cost_usd: 8,
            ambiguous_with: [],
            free_for_ms: 1000,
          },
        ],
        summary: {
          total: 1,
          no_agent: 1,
          total_gib: 100,
          unattached_gib: 100,
          unattached_monthly_cost_usd: 8,
          snapshots: 0,
        },
      },
    });
    await user.click(await screen.findByRole("button", { name: /^1 volumes/ }));
    const opener = await screen.findByRole("button", { name: "Delete…" });
    await user.click(opener);
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.getByRole("textbox", { name: "Filter volumes" })).toBeTruthy();
    expect(document.activeElement === opener).toBe(true);
    // The lens is not an overlay: a second Escape, with nothing left to close,
    // leaves the operator on it.
    await user.keyboard("{Escape}");
    expect(screen.getByRole("textbox", { name: "Filter volumes" })).toBeTruthy();
    expect(window.location.hash).toBe("#fleet/volumes");
  });

  test("modified, composing, repeated and consumed keys never run shortcuts", async () => {
    await mount();
    for (const flags of [
      { ctrlKey: true },
      { metaKey: true },
      { altKey: true },
      { isComposing: true },
      { repeat: true },
    ]) {
      for (const key of ["n", ",", "/", "?"]) {
        fireEvent.keyDown(document.body, { key, ...flags });
      }
    }
    const consumed = new KeyboardEvent("keydown", { key: "n", bubbles: true, cancelable: true });
    consumed.preventDefault();
    fireEvent(document.body, consumed);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.queryByRole("navigation", { name: "Settings sections" })).toBeNull();
    expect(document.activeElement === screen.getByPlaceholderText(/filter/i)).toBe(false);
    render(
      <select aria-label="Editing selection">
        <option>n</option>
      </select>,
    );
    const selection = screen.getByRole("combobox", { name: "Editing selection" });
    for (const key of ["n", ",", "/", "?"]) fireEvent.keyDown(selection, { key });
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  test("real create field gets initial focus; Escape restores its opener", async () => {
    const { user } = await mount();
    const opener = screen.getByRole("button", { name: /New agent/i });
    await user.click(opener);
    const dialog = screen.getByRole("dialog");
    expect(document.activeElement === dialog.querySelector("[data-autofocus]")).toBe(true);
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement === opener).toBe(true);
  });

  test("local Settings drawer owns Escape, with nested help above it", async () => {
    const { user } = await mount();
    await user.keyboard(",");
    await user.click(screen.getByRole("link", { name: "Secrets" }));
    const opener = await screen.findByRole("button", { name: "Add secret" });
    await user.click(opener);
    const secret = screen.getByRole("dialog", { name: "New shared secret" });
    expect(document.activeElement === within(secret).getByPlaceholderText("e.g. nous-key")).toBe(true);
    await user.click(within(secret).getByRole("button", { name: "Close" }));
    expect(document.activeElement === opener).toBe(true);
    await user.click(opener);
    // Help is a shortcut only outside editable fields.
    within(screen.getByRole("dialog")).getByRole("button", { name: "Close" }).focus();
    await user.keyboard("?");
    expect(sheet()).not.toBeNull();
    await user.keyboard("{Escape}");
    expect(sheet()).toBeNull();
    expect(
      screen.getByRole("dialog", { name: "New shared secret" }).contains(document.activeElement),
    ).toBe(true);
    await user.keyboard("n,/");
    expect(screen.getAllByRole("dialog").length).toBe(1);
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement === opener).toBe(true);
    expect(screen.getByRole("navigation", { name: "Settings sections" })).toBeTruthy();
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("navigation", { name: "Settings sections" })).toBeNull();
  });

  test("initial metadata failure offers retry, never wizard or fleet actions", async () => {
    let attempts = 0;
    server = fakeServer({
      ...routes(),
      "meta.get": () => (++attempts === 1 ? errorBody("OFFLINE", "Portal unavailable") : META),
    });
    const user = userEvent.setup();
    render(
      <FleetProvider>
        <App />
      </FleetProvider>,
    );
    await screen.findByText("Portal unavailable");
    expect(screen.queryByRole("button", { name: /New agent/i })).toBeNull();
    expect(server.to("init.profiles").length).toBe(0);
    await user.keyboard("n,");
    expect(screen.queryByRole("dialog")).toBeNull();
    await user.click(screen.getByRole("button", { name: "Retry" }));
    await screen.findByRole("button", { name: /New agent/i });
    expect(attempts).toBe(2);
    expect(screen.queryByText("Portal unavailable")).toBeNull();
    expect(server.to("init.profiles").length).toBe(0);
  });

  test("help remains reachable before metadata loads", async () => {
    server = fakeServer({ ...routes(), "meta.get": errorBody("OFFLINE", "Portal unavailable") });
    const user = userEvent.setup();
    render(
      <FleetProvider>
        <App />
      </FleetProvider>,
    );
    await screen.findByText("Portal unavailable");
    await user.keyboard("?");
    expect(sheet()).not.toBeNull();
    expect((sheet() as HTMLElement).style.top).toBe("12px");
    await user.keyboard("{Escape}");
    expect(sheet()).toBeNull();
  });

  test("opens the sheet, and `?` again closes it", async () => {
    const { user } = await mount();
    expect(sheet()).toBeNull();

    await user.keyboard("?");
    await waitFor(() => expect(sheet()).not.toBeNull());
    // Every row the sheet promises is on it (`test/shortcuts.test.ts` pins the
    // list itself against the handler).
    expect(within(sheet() as HTMLElement).getByText("New agent")).toBeTruthy();

    await user.keyboard("?");
    expect(sheet()).toBeNull();
  });

  test("Escape closes it — the sheet is first out of the Escape stack", async () => {
    const { user } = await mount();
    await user.keyboard("?");
    await waitFor(() => expect(sheet()).not.toBeNull());
    // Focus moved into the sheet, so Esc and Tab reach it (`useFocusTrap`).
    expect(sheet()?.contains(document.activeElement)).toBe(true);

    await user.keyboard("{Escape}");
    expect(sheet()).toBeNull();
  });

  test("the footer's own control opens the same sheet, and gets focus back", async () => {
    const { user, footer } = await mount();
    await user.click(footer);
    await waitFor(() => expect(sheet()).not.toBeNull());

    await user.keyboard("{Escape}");
    expect(sheet()).toBeNull();
    // Compared by identity rather than with `toBe`, which would print the
    // whole happy-dom node on a mismatch.
    expect(document.activeElement === footer).toBe(true);
  });

  test("`?` typed into a field is a character, not a shortcut", async () => {
    const { user } = await mount();
    const filter = screen.getByPlaceholderText(/filter/i);
    await user.click(filter);
    await user.keyboard("?");

    expect(sheet()).toBeNull();
    expect((filter as HTMLInputElement).value).toBe("?");
  });
});

test("switching fleets clears the old detailed route before the new chat and inbox read", async () => {
  let meta = META;
  const historyFleets: string[] = [];
  server = fakeServer({
    ...routes(),
    "meta.get": () => meta,
    "chat.listening": () => ({
      instances: meta.config.fleet_id === META.config.fleet_id ? ["atlas"] : [],
    }),
    "chat.swarms": { swarms: [] },
    "chat.history": () => {
      historyFleets.push(meta.config.fleet_id);
      return { instance: "atlas", bot: "research", session: "old-session", messages: [] };
    },
    "chat.sessions": { instance: "atlas", bot: "research", sessions: [] },
    "notifications.list": { notifications: [], unread: 0, needs_action: 0, mutes: [] },
  });
  function ChangeFleet() {
    const fleet = useFleet();
    return (
      <button
        type="button"
        onClick={() => {
          meta = { ...META, config: { ...META.config, fleet_id: "second" } };
          void fleet.refreshMeta();
        }}
      >
        Change fixture fleet
      </button>
    );
  }
  window.history.replaceState(null, "", "/#chat/atlas/research?session=old-session");
  render(
    <FleetProvider>
      <ChangeFleet />
      <Portal />
    </FleetProvider>,
  );
  await waitFor(() => expect(server!.to("chat.history").length).toBeGreaterThan(0));
  expect(window.location.hash).toBe("#chat/atlas/research?session=old-session");

  const notifications = server!.to("notifications.list").length;
  await userEvent.click(screen.getByText("Change fixture fleet"));
  await waitFor(() => expect(window.location.hash).toBe("#chat"));
  await waitFor(() => expect(server!.to("notifications.list").length).toBeGreaterThan(notifications));
  expect(historyFleets).not.toContain("second");
});
