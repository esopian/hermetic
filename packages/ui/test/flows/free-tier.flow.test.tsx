/**
 * Settings › Defaults › "Set to AWS Free Tier" (§10), end to end: the real
 * page against the real `dispatch` over the fixture backend. The drawer's plan
 * is asserted on screen, then what Apply wrote is read back from the head —
 * the fleet's machine defaults and this laptop's create presets — so a page
 * that only *looked* applied fails here.
 */
import { cleanup, screen, userEvent, waitFor, within } from "../dom.ts";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { AWS_FREE_TIER } from "@hermetic/core/shared";
import { dispatch } from "../../../app/src/handlers/dispatch.ts";
import { resetPresetsStore } from "../../src/state/presets-store.ts";
import { type FlowHarness, flowHarness, gotoHash, mountPortal } from "./bridge.ts";

let harness: FlowHarness | null = null;

beforeEach(() => {
  window.localStorage.removeItem("hermetic.layout");
  window.sessionStorage.clear();
  resetPresetsStore();
  gotoHash("#fleet");
});

afterEach(async () => {
  cleanup();
  await harness?.restore();
  harness = null;
  resetPresetsStore();
  gotoHash("");
});

interface HeldPresets {
  loadout: (string | null)[];
  default: string | null;
}

interface HeldSettings {
  settings: { defaults: { size: string; volume_gib: number; root_gib?: number } };
}

test("the drawer explains the allowances, shows the plan, and Apply writes both halves", async () => {
  harness = await flowHarness();
  const h = harness;
  gotoHash("#settings/defaults");
  mountPortal();
  const user = userEvent.setup();

  const row = (await screen.findByText("AWS Free Tier")).closest("[data-field]") as HTMLElement;
  expect(within(row).getByText("not applied")).toBeTruthy();
  await user.click(within(row).getByRole("button", { name: "Set to AWS Free Tier…" }));

  const drawer = await screen.findByRole("dialog", { name: "Set defaults to AWS Free Tier" });
  // The help half: both plans, the one-agent warning, and every resource.
  expect(drawer.textContent).toContain("Before 15 July 2025: legacy plan.");
  expect(drawer.textContent).toContain("The allowance covers one agent.");
  const resources = within(drawer).getByTestId("free-tier-resources");
  for (const r of AWS_FREE_TIER.resources) {
    expect(resources.querySelector(`[data-resource="${r.id}"]`)?.textContent).toContain(r.resource);
  }
  // The plan half: what moves, and which loadout card the preset takes.
  const plan = within(drawer).getByTestId("free-tier-plan");
  expect(plan.textContent).toContain("xxsmall · t4g.small");
  expect(plan.textContent).toContain("Free tier (replaces Standard in slot 2)");
  // The terminal recipe is one the CLI accepts: the default must be in the loadout it names.
  expect(drawer.textContent).toContain("--loadout light,free-tier,heavy,gpu --default free-tier");
  expect(drawer.textContent).toContain("2 GiB is tight.");

  await user.click(await within(drawer).findByRole("button", { name: "Apply Free Tier defaults" }));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());

  const settings = (await dispatch(h.ctx, "settings.get", {})) as HeldSettings;
  expect(settings.settings.defaults).toMatchObject(AWS_FREE_TIER.machine);
  const presets = (await dispatch(h.ctx, "presets.get", {})) as HeldPresets;
  expect(presets.loadout).toEqual(["light", "free-tier", "heavy", "gpu"]);
  expect(presets.default).toBe("free-tier");

  // Reopened, there is nothing left to apply.
  await waitFor(() => expect(within(row).getByText("applied")).toBeTruthy(), { timeout: 3000 });
  await user.click(within(row).getByRole("button", { name: "Set to AWS Free Tier…" }));
  const again = await screen.findByRole("dialog", { name: "Set defaults to AWS Free Tier" });
  expect((within(again).getByRole("button", { name: "Applied" }) as HTMLButtonElement).disabled).toBe(
    true,
  );
});

test("the help link opens the same drawer without writing anything", async () => {
  harness = await flowHarness();
  const h = harness;
  gotoHash("#settings/defaults");
  mountPortal();
  const user = userEvent.setup();

  await user.click(await screen.findByRole("button", { name: "What does the AWS Free Tier cover?" }));
  const drawer = await screen.findByRole("dialog", { name: "Set defaults to AWS Free Tier" });
  await user.click(within(drawer).getByText("Close", { selector: ".drawer-foot button" }));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  const presets = (await dispatch(h.ctx, "presets.get", {})) as HeldPresets & { source: string };
  expect(presets.source).toBe("builtin");
});
