/**
 * §6.6's config update, end to end over the fixture: `main`'s `ibis` applied
 * what it was sent while this build renders it newer (`config_update` in
 * `fixture-agents.ts`), so the rollout table reads it as a neutral `update`, the update
 * drawer's plan names what converging it changes, and the fleet's
 * `auto_upgrade` opt-in round-trips through `settings.set`.
 */
import { cleanup, screen, userEvent, waitFor, within } from "../dom.ts";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { dispatch } from "../../../app/src/handlers/dispatch.ts";
import { type FlowHarness, flowHarness, gotoHash, mountPortal } from "./bridge.ts";

let harness: FlowHarness | null = null;

beforeEach(() => {
  window.sessionStorage.clear();
  gotoHash("");
});

afterEach(async () => {
  cleanup();
  await harness?.restore();
  harness = null;
  window.sessionStorage.clear();
  gotoHash("");
});

/** The Config cell of one agent's row in the rollout table. */
function configTag(name: string): HTMLElement | null {
  const row = [...document.querySelectorAll<HTMLTableRowElement>(".foundation-agents tbody tr")].find(
    (r) => r.querySelector("b")?.textContent === name,
  );
  return row?.cells[4]?.querySelector<HTMLElement>(".fa-tag") ?? null;
}

test("a config-only update reads neutral, and the plan lists what it converges", async () => {
  harness = await flowHarness();
  gotoHash("#settings/foundation");
  mountPortal();
  const user = userEvent.setup();

  await waitFor(() => expect(configTag("ibis")?.textContent).toBe("update"));
  expect(configTag("ibis")?.classList.contains("behind")).toBe(false);
  // An agent held on an older Hermes is never offered one it cannot take.
  expect(configTag("corvid")?.textContent).not.toBe("update");

  await user.click(await screen.findByRole("button", { name: "Update foundation…" }));
  const drawer = await screen.findByRole("dialog");
  const list = await waitFor(() => {
    const el = drawer.querySelector<HTMLElement>(".fu-config");
    if (!el) throw new Error("no config list yet");
    return el;
  });
  const ibis = within(list).getByText("ibis").closest("li");
  expect(ibis).not.toBeNull();
  const text = ibis?.textContent ?? "";
  expect(text).toMatch(/[0-9a-f]{12} → [0-9a-f]{12}/);
  // It converges, with the files converging would touch.
  expect(text).not.toContain("deferred");
  expect(text).toContain("/etc/hermes/config.yaml");
  // The fixture holds corvid on an older Hermes, so it is listed but waits.
  expect(within(list).getByText("corvid").closest("li")?.textContent).toContain(
    "deferred: held on Hermes",
  );
  // One box converges, and the drawer says what that costs.
  expect(drawer.textContent).toContain("restarts Hermes on the box it converges");
});

test("the auto-upgrade switch round-trips through settings.set", async () => {
  harness = await flowHarness();
  const h = harness;
  gotoHash("#settings/foundation");
  mountPortal();
  const user = userEvent.setup();

  const group = await screen.findByRole("group", { name: "Auto-upgrade fleet" });
  // Absent means off (`autoUpgrade`).
  expect(within(group).getByRole("button", { name: "Off" }).getAttribute("aria-pressed")).toBe("true");
  await user.click(within(group).getByRole("button", { name: "On" }));

  await waitFor(async () => {
    const got = (await dispatch(h.ctx, "settings.get", {})) as { settings: { auto_upgrade?: boolean } };
    expect(got.settings.auto_upgrade).toBe(true);
  });
  expect(h.calls.filter((c) => c.name === "settings.set").map((c) => c.params)).toEqual([
    expect.objectContaining({ auto_upgrade: true }),
  ]);
  await waitFor(() =>
    expect(within(group).getByRole("button", { name: "On" }).getAttribute("aria-pressed")).toBe("true"),
  );
});
