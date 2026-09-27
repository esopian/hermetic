/**
 * The header's `FLEET | CHAT | SETTINGS` is drawn on the Settings page too, so
 * it is the way out of Settings as well as the way in. It once only ever
 * opened Settings: choosing Fleet or Chat from there changed the pressed
 * button and nothing else, and the page kept rendering Settings.
 */
import { cleanup, screen, userEvent, waitFor, within } from "../dom.ts";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { type FlowHarness, flowHarness, gotoHash, mountPortal } from "./bridge.ts";

let harness: FlowHarness | null = null;

beforeEach(() => {
  window.localStorage.removeItem("hermetic.layout");
  window.sessionStorage.clear();
  gotoHash("");
});

afterEach(async () => {
  cleanup();
  await harness?.restore();
  harness = null;
  gotoHash("");
});

function views(): HTMLElement {
  return screen.getByRole("navigation", { name: "Views" });
}

test("the view nav leaves Settings for Fleet and for Chat", async () => {
  harness = await flowHarness();
  gotoHash("#settings");
  mountPortal();
  const user = userEvent.setup();

  await screen.findByRole("navigation", { name: "Settings sections" });

  await user.click(within(views()).getByRole("button", { name: /^Fleet/ }));
  await waitFor(() =>
    expect(screen.queryByRole("navigation", { name: "Settings sections" })).toBeNull(),
  );
  expect(
    within(views())
      .getByRole("button", { name: /^Fleet/ })
      .getAttribute("aria-pressed"),
  ).toBe("true");

  await user.click(within(views()).getByRole("button", { name: /^Settings/ }));
  await screen.findByRole("navigation", { name: "Settings sections" });

  await user.click(within(views()).getByRole("button", { name: /^Chat/ }));
  await waitFor(() =>
    expect(screen.queryByRole("navigation", { name: "Settings sections" })).toBeNull(),
  );
  expect(within(views()).getByRole("button", { name: /^Chat/ }).getAttribute("aria-pressed")).toBe(
    "true",
  );
});
