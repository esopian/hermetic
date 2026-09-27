/**
 * A finished create puts its agent on the board without waiting for a poll.
 *
 * The fleet stream only carries what a scan found, and scans are a minute apart
 * (`POLL_INTERVAL_MS`), so an agent whose create op had finished used to be
 * missing from the board — "11 agents", no card — until the next tick. The
 * provider now follows every op the page started and re-reads the fleet when
 * one ends (`state/state.tsx`).
 *
 * The harness never starts its poller and this test never calls
 * `harness.poll()`, so the only way the card can appear is that re-read.
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

function agentCount(): string {
  const lens = screen.getByRole("group", { name: "Fleet lens" });
  const button = lens.querySelector("button");
  return button?.textContent ?? "";
}

test("a finished create shows its card and the new count with no poll in between", async () => {
  harness = await flowHarness();
  mountPortal();
  const user = userEvent.setup();

  await waitFor(() => expect(agentCount()).toBe("11 agents"));

  await user.click(screen.getByRole("button", { name: /New agent/ }));
  const name = document.getElementById("create-name") as HTMLInputElement;
  await user.clear(name);
  await user.type(name, "wren");
  const drawer = screen.getByRole("dialog", { name: "Create agent" });
  await user.click(within(drawer).getAllByRole("button", { name: "Create agent →" })[0] as HTMLElement);

  await screen.findByText("Agent handed off", undefined, { timeout: 10_000 });
  await waitFor(() => expect(screen.getByRole("button", { name: /^wren · / })).toBeTruthy());
  expect(agentCount()).toBe("12 agents");
  expect(harness.calls.some((c) => c.name === "agents.list")).toBe(true);
}, 20_000);
