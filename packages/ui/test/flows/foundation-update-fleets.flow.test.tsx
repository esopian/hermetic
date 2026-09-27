/**
 * §6.6's update, and the fleet switcher that advertised it.
 *
 * The switcher's rows come from `fleets.list`, which the page reads once when
 * it boots and again only on a switch or a default change. A finished foundation
 * update re-read `meta` — so Settings and the env strip moved to the new
 * version — but not the list, and the popover went on badging the fleet it had
 * just updated `update available`.
 *
 * Against the real head over the fixture: `staging` (`sg7k2m4p`) is seeded one
 * version behind, so the badge is live before the update and must be gone
 * after it.
 */
import { cleanup, screen, userEvent, waitFor, within } from "../dom.ts";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { FIXTURE, flowHarness, gotoHash, mountPortal, type FlowHarness } from "./bridge.ts";

let harness: FlowHarness | null = null;

beforeEach(() => {
  window.sessionStorage.removeItem("hermetic.foundation.opId");
  gotoHash("");
});

afterEach(async () => {
  cleanup();
  await harness?.restore();
  harness = null;
  window.sessionStorage.removeItem("hermetic.foundation.opId");
  gotoHash("");
});

/** The switcher row naming `staging`, from an open popover. */
function stagingRow(): HTMLElement {
  const row = [...document.querySelectorAll<HTMLElement>(".fleet-sw-row")].find(
    (r) => r.querySelector(".fleet-sw-name b")?.textContent === FIXTURE.staging.alias,
  );
  if (!row) throw new Error("no staging row in the fleet switcher");
  return row;
}

async function togglePopover(user: ReturnType<typeof userEvent.setup>): Promise<void> {
  await user.click(screen.getByRole("button", { name: /switch fleet/i }));
}

test("a finished foundation update clears the switcher's update-available badge", async () => {
  harness = await flowHarness({ fleet: FIXTURE.staging.fleet_id });
  gotoHash("#settings/foundation");
  mountPortal();
  const user = userEvent.setup();

  // Before: the list says what the fixture seeded.
  await waitFor(() => expect(screen.getByRole("button", { name: /switch fleet/i })).toBeTruthy());
  await togglePopover(user);
  await waitFor(() => expect(stagingRow().textContent).toContain("update available"));
  await togglePopover(user);

  await user.click(await screen.findByRole("button", { name: "Update foundation…" }));
  const drawer = await screen.findByRole("dialog");
  await user.click(await within(drawer).findByRole("button", { name: "Continue →" }));
  await user.click(within(drawer).getByRole("button", { name: "Update the foundation" }));
  // The drawer's foot says where the op ended; `Close` only appears once it has.
  await within(drawer).findByText(/^foundation is on v/, undefined, { timeout: 10_000 });
  // The header's × and the footer's button both read "Close"; the footer's is
  // the one a finished update offers.
  const closers = within(drawer).getAllByRole("button", { name: "Close" });
  await user.click(closers[closers.length - 1] as HTMLElement);
  await waitFor(() => expect(screen.queryAllByRole("dialog").length).toBe(0));

  await togglePopover(user);
  await waitFor(() => expect(stagingRow().textContent).not.toContain("update available"));
}, 20_000);
