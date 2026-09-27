/**
 * Reboot from the agent drawer acknowledges itself (§6.5).
 *
 * Reboot is not an op — one `RebootInstances` and one row write — so it has no
 * progress rail and no op-completion toast. It used to show nothing at all: the
 * request went out, succeeded, and the drawer looked exactly as it did before
 * the press. The press now holds the button as `Rebooting…` until the box's
 * first heartbeat after the reboot, which the fixture plays a couple of seconds
 * later (`simulateReboot`), and then releases it.
 */
import { cleanup, screen, waitFor, within } from "../dom.ts";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { userEvent } from "../dom.ts";
import { FIXTURE, flowHarness, gotoHash, mountPortal, type FlowHarness } from "./bridge.ts";

let harness: FlowHarness | null = null;

beforeEach(() => {
  window.localStorage.removeItem("hermetic.layout");
  gotoHash("");
});

afterEach(async () => {
  cleanup();
  await harness?.restore();
  harness = null;
  window.localStorage.removeItem("hermetic.layout");
  gotoHash("");
});

async function pollUntil(h: FlowHarness, check: () => void, tries = 80): Promise<void> {
  let last: unknown = null;
  for (let i = 0; i < tries; i++) {
    await h.poll();
    try {
      await waitFor(check, { timeout: 50 });
      return;
    } catch (e) {
      last = e;
    }
  }
  throw last ?? new Error("pollUntil: never checked");
}

test("Reboot on a ready agent holds as Rebooting… until the box heartbeats again", async () => {
  const h = await flowHarness();
  harness = h;
  mountPortal();
  const user = userEvent.setup();

  await user.click(await screen.findByLabelText(`${FIXTURE.readyAgent} · ready`));
  const d = await waitFor(() => {
    const el = screen.getByRole("dialog");
    expect(el.querySelector(".detail-name")?.textContent).toBe(FIXTURE.readyAgent);
    return el;
  });

  // Every action lives on the drawer's Lifecycle section.
  await user.click(within(d).getByRole("tab", { name: "Lifecycle" }));
  const reboot = await waitFor(() => within(d).getByRole("button", { name: "Reboot" }));
  expect(reboot.hasAttribute("disabled")).toBe(false);
  await user.click(reboot);

  // The click reached the head as the one synchronous request it is.
  expect(h.calls.filter((c) => c.name === "agents.reboot").length).toBe(1);
  const pending = await waitFor(() => within(d).getByRole("button", { name: "Rebooting…" }));
  expect(pending.hasAttribute("disabled")).toBe(true);
  expect(within(d).queryByRole("alert")).toBeNull();

  // The fixture's box heartbeats on its way back up, and the button comes back.
  await pollUntil(h, () => {
    expect(within(d).getByRole("button", { name: "Reboot" }).hasAttribute("disabled")).toBe(false);
  });
}, 30_000);
