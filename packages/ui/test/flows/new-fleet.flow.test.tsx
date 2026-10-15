/**
 * §4.8's "New fleet": the init wizard raised from the fleet menu over a fleet
 * that is already open, creating a second fleet in the same account.
 *
 * Driven end to end through the real handlers over the fixture backend: the
 * menu's button, the wizard's first three steps, the `init` op, and the head moving to
 * the fleet it created. The assertion that the head moved is a real
 * `meta.get` against the head, so it proves the consequence of the clicks
 * rather than how the harness was opened.
 */
import { cleanup, screen, waitFor } from "../dom.ts";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { userEvent } from "../dom.ts";
import { dispatch } from "../../../app/src/handlers/dispatch.ts";
import { flowHarness, gotoHash, mountPortal, type FlowHarness } from "./bridge.ts";

let harness: FlowHarness | null = null;

beforeEach(() => {
  window.localStorage.removeItem("hermetic.layout");
  window.sessionStorage.clear();
  gotoHash("#fleet");
});

afterEach(async () => {
  cleanup();
  await harness?.restore();
  harness = null;
  window.localStorage.removeItem("hermetic.layout");
  window.sessionStorage.clear();
  gotoHash("");
});

async function servedFleetId(h: FlowHarness): Promise<string | null> {
  const meta = (await dispatch(h.ctx, "meta.get", {})) as { fleet: { id: string | null } | null };
  return meta.fleet?.id ?? null;
}

test("New fleet walks the wizard over the open fleet and lands on the fleet it created", async () => {
  harness = await flowHarness();
  const first = await servedFleetId(harness);
  expect(first).not.toBeNull();
  mountPortal();
  const user = userEvent.setup();

  await user.click(await screen.findByRole("button", { name: /switch fleet/i }));
  await user.click(await screen.findByRole("button", { name: "+ New fleet" }));

  // Step 1: the adding copy, and a way back out that the fresh-home wizard has not.
  await screen.findByRole("heading", { name: "Add a fleet" });
  expect(screen.getByRole("button", { name: "Cancel" })).toBeTruthy();
  await user.click(await screen.findByRole("button", { name: /acme-dev/ }));
  await user.click(screen.getByRole("button", { name: "Continue →" }));

  // Step 2: always a create, even though the account already has foundations.
  await screen.findByText(/will CREATE another foundation/);
  await user.click(await screen.findByRole("checkbox"));
  await user.click(screen.getByRole("button", { name: "Continue →" }));

  // Step 3: confirm the detected tailnet, then initialize.
  await user.click(await screen.findByRole("checkbox", { name: /This is the tailnet/ }));
  await user.click(screen.getByRole("button", { name: "Initialize →" }));

  // The head serves the new fleet once the op lands, and the page — keyed by
  // fleet (`Portal.tsx`) — remounts onto its dashboard on the next meta read.
  await waitFor(async () => expect(await servedFleetId(harness as FlowHarness)).not.toBe(first), {
    timeout: 5000,
  });
  const added = await servedFleetId(harness);
  expect(added).not.toBeNull();
  await waitFor(
    () => expect(document.querySelector(".envstrip-fleet-name")?.textContent).toBe(added as string),
    { timeout: 5000 },
  );
  expect(screen.queryByRole("heading", { name: "Add a fleet" })).toBeNull();
  // The fleet that was open is still in this home, beside the new one.
  const listed = (await dispatch(harness.ctx, "fleets.list", {})) as {
    fleets: Array<{ fleet_id: string; local: boolean }>;
  };
  const local = listed.fleets.filter((f) => f.local).map((f) => f.fleet_id);
  expect(local).toContain(first as string);
  expect(local).toContain(added as string);
}, 20_000);

test("Cancel leaves the wizard and the open fleet as they were", async () => {
  harness = await flowHarness();
  const first = await servedFleetId(harness);
  mountPortal();
  const user = userEvent.setup();

  await user.click(await screen.findByRole("button", { name: /switch fleet/i }));
  await user.click(await screen.findByRole("button", { name: "+ New fleet" }));
  await user.click(await screen.findByRole("button", { name: "Cancel" }));

  await screen.findByRole("button", { name: /switch fleet/i });
  expect(screen.queryByRole("heading", { name: "Add a fleet" })).toBeNull();
  expect(await servedFleetId(harness)).toBe(first);
});
