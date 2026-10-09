/**
 * A destroyed agent leaves the fleet and lands in the audit (§6.7).
 *
 * A destroy ends by deleting the agent's row, so the name is free again: the
 * card goes from the board with no poll in between (the provider re-reads the
 * fleet when an op it started ends, `state/state.tsx`), the drawer that ran the
 * destroy closes with it, and the record is on the Destroyed lens instead —
 * the tombstone, and that incarnation's own history, read with the tombstone's
 * `created_at`/`destroyed_at` as its window. Then the name is used again, and
 * the new agent is back on the board.
 *
 * Everything runs through the real handlers against the fixture fleet, so the
 * row deletion, `agents.destroyed` and the windowed `agents.history` are
 * core's, not a stand-in's.
 */
import { cleanup, screen, userEvent, waitFor, within } from "../dom.ts";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { FIXTURE, type FlowHarness, flowHarness, gotoHash, mountPortal } from "./bridge.ts";

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
  window.localStorage.removeItem("hermetic.layout");
  gotoHash("");
});

function lens(): HTMLElement {
  return screen.getByRole("group", { name: "Fleet lens" });
}

test("destroy, review the tombstone and its history, then reuse the name", async () => {
  harness = await flowHarness();
  mountPortal();
  const user = userEvent.setup();
  const name = FIXTURE.readyAgent;

  // 1. Destroy through the drawer: plan, typed name, apply.
  await user.click(await screen.findByLabelText(new RegExp(`^${name} · `)));
  const d = await waitFor(() => {
    const el = screen.getByRole("dialog");
    expect(el.querySelector(".detail-name")?.textContent).toBe(name);
    return el;
  });
  await user.click(within(d).getByRole("tab", { name: "Lifecycle" }));
  await user.click(within(d).getByRole("button", { name: `Destroy ${name}…` }));
  const confirm = await waitFor(() => {
    const el = d.querySelector<HTMLElement>(".confirm");
    expect(el).not.toBeNull();
    expect(el?.querySelectorAll(".steps-list span").length).toBeGreaterThan(0);
    return el as HTMLElement;
  });
  await user.type(within(confirm).getByLabelText("Type the agent name to confirm"), name);
  const submit = await waitFor(() => {
    const button = within(confirm).getByRole("button", { name: "Destroy" });
    expect(button.hasAttribute("disabled")).toBe(false);
    return button;
  });
  await user.click(submit);

  /**
   * 2. Gone from the board, and its drawer with it — no poll in between.
   * Asserted as booleans: a failed `expect(element).toBeNull()` formats the
   * element, and a drawer node with React's fibers hanging off it is enough
   * to exhaust memory before the wait's next retry.
   */
  await waitFor(
    () => {
      expect(document.querySelector(`[aria-label^="${name} · "]`) === null).toBe(true);
      expect(document.querySelector('[role="dialog"]') === null).toBe(true);
    },
    { timeout: 15_000 },
  );

  // 3. The Destroyed lens has its record, and its history for that life alone.
  await user.click(within(lens()).getByRole("button", { name: /destroyed$/ }));
  expect(window.location.hash).toBe("#fleet/destroyed");
  const audit = await screen.findByRole("table", { name: "Destroyed agents" });
  const row = await waitFor(() =>
    within(audit).getByRole("row", { name: new RegExp(`^${name} · destroyed `) }),
  );
  await user.click(row);
  const panel = await screen.findByRole("complementary", { name: `${name} · destroyed` });
  const log = await waitFor(() => within(panel).getByRole("log", { name: `${name} history` }));
  expect(log.textContent ?? "").not.toBe("");

  const tombstones = harness.calls.filter((c) => c.name === "agents.destroyed");
  expect(tombstones.length).toBeGreaterThan(0);
  const windowed = harness.calls.find(
    (c) =>
      c.name === "agents.history" &&
      (c.params as { name?: string; since?: string }).name === name &&
      (c.params as { since?: string }).since !== undefined,
  );
  expect(windowed).toBeDefined();
  const params = windowed?.params as { since: string; until: string };
  expect(Date.parse(params.since)).toBeLessThanOrEqual(Date.parse(params.until));

  // 4. The name is free: create it again, and it is back on the board.
  await user.click(within(lens()).getByRole("button", { name: /agents$/ }));
  expect(window.location.hash).toBe("");
  await user.click(screen.getByRole("button", { name: /New agent/ }));
  const input = document.getElementById("create-name") as HTMLInputElement;
  await user.clear(input);
  await user.type(input, name);
  const drawer = screen.getByRole("dialog", { name: "Create agent" });
  await user.click(within(drawer).getAllByRole("button", { name: "Create agent →" })[0] as HTMLElement);
  await screen.findByText("Agent handed off", undefined, { timeout: 10_000 });
  await waitFor(() =>
    expect(screen.getByRole("button", { name: new RegExp(`^${name} · `) })).toBeTruthy(),
  );
}, 45_000);
