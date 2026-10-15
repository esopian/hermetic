/**
 * Settings › Foundation › Snapshots (§7.1), end to end over the fixture: the
 * block reads the stack's policy, the drawer plans only what moved, a
 * destructive plan needs its acknowledgement, and Apply runs the op that moves
 * the stack's parameters — read back from the head, not from the screen.
 */
import { cleanup, screen, userEvent, waitFor, within } from "../dom.ts";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { dispatch } from "../../../app/src/handlers/dispatch.ts";
import { type FlowHarness, flowHarness, gotoHash, mountPortal } from "./bridge.ts";

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
  gotoHash("");
});

interface Report {
  policy: { enabled: boolean; retain: number; interval_hours: number } | null;
}

test("turning snapshots off is planned, acknowledged and applied to the stack", async () => {
  harness = await flowHarness();
  const h = harness;
  gotoHash("#settings/foundation");
  mountPortal();
  const user = userEvent.setup();

  const block = await screen.findByTestId("snapshots-block");
  await waitFor(() => expect(block.textContent).toContain("daily, keep 7"));
  await user.click(await screen.findByRole("button", { name: "Change snapshot policy…" }));

  const drawer = await screen.findByRole("dialog", { name: "Change snapshot policy" });
  const review = within(drawer).getByRole("button", { name: "Review plan" }) as HTMLButtonElement;
  expect(review.disabled).toBe(true);

  const onOff = within(drawer).getByRole("group", { name: "Snapshots" });
  await user.click(within(onOff).getByRole("button", { name: "off" }));
  expect(within(drawer).getByTestId("snapshots-preview").textContent).toContain("off");
  await user.click(review);

  await within(drawer).findByTestId("snapshots-review");
  expect(drawer.textContent).toContain("daily, keep 7 → off");
  const apply = within(drawer).getByRole("button", { name: "Apply" }) as HTMLButtonElement;
  expect(apply.disabled).toBe(true);
  await user.click(within(drawer).getByRole("checkbox"));
  expect(apply.disabled).toBe(false);
  await user.click(apply);

  await waitFor(
    async () => {
      const report = (await dispatch(h.ctx, "snapshots.status", {})) as Report;
      expect(report.policy).toEqual({ enabled: false, retain: 7, interval_hours: 24 });
    },
    { timeout: 5000 },
  );
  // The block re-reads once the op finishes.
  await waitFor(
    () => expect(screen.getByTestId("snapshots-block").textContent).toContain("policyoff"),
    { timeout: 5000 },
  );
});

test("a retention change sends only the retention", async () => {
  harness = await flowHarness();
  const h = harness;
  gotoHash("#settings/foundation");
  mountPortal();
  const user = userEvent.setup();

  await user.click(await screen.findByRole("button", { name: "Change snapshot policy…" }));
  const drawer = await screen.findByRole("dialog", { name: "Change snapshot policy" });
  const counts = within(drawer).getByRole("group", { name: "Common retention counts" });
  await user.click(within(counts).getByRole("button", { name: "14" }));
  await user.click(within(drawer).getByRole("button", { name: "Review plan" }));
  await within(drawer).findByTestId("snapshots-review");

  const sent = h.calls.filter((c) => c.name === "plan.snapshots").map((c) => c.params);
  expect(sent).toEqual([{ retain: 14 }]);
  // Raising retention deletes nothing, so there is nothing to acknowledge.
  expect(within(drawer).queryByRole("checkbox")).toBeNull();
});

test("a fleet behind this build cannot open the editor, and says why", async () => {
  harness = await flowHarness({ fleet: "staging" });
  gotoHash("#settings/foundation");
  mountPortal();
  const block = await screen.findByTestId("snapshots-block");
  await waitFor(() => expect(block.textContent).toContain("fixed on this foundation version"));
  const button = screen.getByRole("button", { name: "Change snapshot policy…" }) as HTMLButtonElement;
  expect(button.disabled).toBe(true);
  expect(button.title).toContain("update the foundation first");
});
