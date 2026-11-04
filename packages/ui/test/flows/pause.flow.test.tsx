/**
 * Pause and Resume, over a real head and the fixture fleet.
 *
 * Pause always asks first: there is no cheap "is a turn running" read, so the
 * one inline confirm says what a busy box loses, and Cancel must send nothing.
 * The drawer header's "⏸ Pause" does not run the op; it lands on Lifecycle
 * with that same confirm open. Resume loses nothing, so it runs directly.
 *
 * `atlas` is seeded `ready`, `marrow` `paused` (`fixture-agents.ts`).
 */
import { cleanup, screen, userEvent, waitFor, within } from "../dom.ts";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { flowHarness, gotoHash, mountPortal, useTableLayout, type FlowHarness } from "./bridge.ts";

let harness: FlowHarness | null = null;

/** `fmtDuration`'s shape: `3h 11m`, `55d 11h`, `4m`. */
const SPAN = String.raw`(\d+d \d{2}h|\d+h \d{2}m|\d+m)`;

beforeEach(() => {
  window.localStorage.removeItem("hermetic.layout");
  gotoHash("#fleet");
});

afterEach(async () => {
  cleanup();
  await harness?.restore();
  harness = null;
  window.localStorage.removeItem("hermetic.layout");
  gotoHash("");
});

async function openAgent(name: string): Promise<HTMLElement> {
  const user = userEvent.setup();
  await user.click(await screen.findByLabelText(new RegExp(`^${name} · `)));
  return await waitFor(() => {
    const el = screen.getByRole("dialog");
    expect(el.querySelector(".detail-name")?.textContent).toBe(name);
    return el;
  });
}

function called(h: FlowHarness, method: string, name: string): boolean {
  return h.calls.some((c) => c.name === method && (c.params as { name?: string }).name === name);
}

describe("Pause", () => {
  test("the Pause card asks first, and Cancel sends nothing", async () => {
    harness = await flowHarness();
    mountPortal();
    const user = userEvent.setup();

    const d = await openAgent("atlas");
    await user.click(within(d).getByRole("tab", { name: "Lifecycle" }));
    const card = within(d).getByRole("region", { name: "Pause" });
    // One Recommended per grid: atlas is behind, so Upgrade holds it and Pause does not.
    const tagged = within(d)
      .getAllByRole("region")
      .filter((r) => (r.textContent ?? "").includes("Recommended"))
      .map((r) => r.getAttribute("aria-label"));
    expect(tagged).toEqual(["Upgrade Hermes"]);
    expect(card.textContent ?? "").toContain("chat history");
    // Stop stays as the escape hatch beside it.
    expect(within(d).getByRole("region", { name: "Stop" })).toBeDefined();

    await user.click(within(card).getByRole("button", { name: "Pause…" }));
    const ask = within(card).getByRole("group", { name: "Confirm pause" });
    expect(ask.textContent ?? "").toContain("A turn in flight is interrupted");
    await user.click(within(ask).getByRole("button", { name: "Cancel" }));
    expect(within(card).queryByRole("group", { name: "Confirm pause" })).toBeNull();
    expect(harness.calls.map((c) => c.name)).not.toContain("agents.pause");
  });

  test("confirming pauses the agent, and the row lands paused", async () => {
    harness = await flowHarness();
    mountPortal();
    const user = userEvent.setup();

    const d = await openAgent("atlas");
    await user.click(within(d).getByRole("tab", { name: "Lifecycle" }));
    const card = within(d).getByRole("region", { name: "Pause" });
    await user.click(within(card).getByRole("button", { name: "Pause…" }));
    const ask = within(card).getByRole("group", { name: "Confirm pause" });
    await user.click(within(ask).getByRole("button", { name: "Pause" }));

    await waitFor(() => expect(called(harness!, "agents.pause", "atlas")).toBe(true));
    await waitFor(
      () => expect(d.querySelector(".dr-head-pill")?.textContent ?? "").toContain("paused"),
      { timeout: 10_000 },
    );
    // Paused: the header offers Resume, Lifecycle offers Resume and no Start.
    expect(within(d).getByRole("button", { name: "▶ Resume" })).toBeDefined();
    expect(within(d).getByRole("region", { name: "Resume" })).toBeDefined();
    expect(within(d).queryByRole("region", { name: "Start" })).toBeNull();
  });

  test("the header's ⏸ Pause opens Lifecycle with the confirm already open", async () => {
    harness = await flowHarness();
    mountPortal();
    const user = userEvent.setup();

    const d = await openAgent("atlas");
    await user.click(within(d).getByRole("button", { name: "⏸ Pause" }));
    await waitFor(() =>
      expect(within(d).getByRole("tab", { name: "Lifecycle" }).getAttribute("aria-selected")).toBe(
        "true",
      ),
    );
    const card = within(d).getByRole("region", { name: "Pause" });
    expect(within(card).getByRole("group", { name: "Confirm pause" })).toBeDefined();
    expect(harness.calls.map((c) => c.name)).not.toContain("agents.pause");
  });
});

describe("Resume", () => {
  test("a paused agent's header Resume runs it without asking", async () => {
    harness = await flowHarness();
    mountPortal();
    const user = userEvent.setup();

    const d = await openAgent("marrow");
    // The chip says how long it has been paused. The fixture's clock is not
    // this test's, so the shape is checked here and the arithmetic in format's tests.
    expect(d.querySelector(".dr-head-pill .status-sub")?.textContent ?? "").toMatch(
      new RegExp(`^${SPAN}$`),
    );
    expect(within(d).queryByRole("button", { name: "⏸ Pause" })).toBeNull();
    await user.click(within(d).getByRole("button", { name: "▶ Resume" }));
    await waitFor(() => expect(called(harness!, "agents.resume", "marrow")).toBe(true));
  });

  test("the paused agent has its own triage group, with how long it has been paused", async () => {
    window.localStorage.setItem("hermetic.layout", "triage");
    harness = await flowHarness();
    mountPortal();

    const row = await screen.findByLabelText("marrow · paused");
    const group = row.closest(".group") as HTMLElement;
    expect(group.querySelector(".group-label")?.textContent).toBe("paused");
    expect(group.textContent ?? "").toContain("Hermes halted, data volume kept.");
    expect(row.textContent ?? "").toMatch(new RegExp(`paused ${SPAN}$`));
    // Not also under stopped, though it is off like a stopped agent.
    const stopped = [...document.querySelectorAll(".group")].find(
      (g) => g.querySelector(".group-label")?.textContent === "stopped",
    );
    expect(stopped?.textContent ?? "").not.toContain("marrow");
  });

  test("the board card's Resume resumes the paused agent", async () => {
    harness = await flowHarness();
    mountPortal();
    const user = userEvent.setup();

    const card = await screen.findByLabelText("marrow · paused");
    expect(within(card).queryByRole("button", { name: "Start" })).toBeNull();
    await user.click(within(card).getByRole("button", { name: "Resume" }));
    await waitFor(() => expect(called(harness!, "agents.resume", "marrow")).toBe(true));
    expect(called(harness, "agents.start", "marrow")).toBe(false);
    // Clicking the button must not also open the drawer.
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  test("the Lifecycle Resume card resumes the paused agent", async () => {
    harness = await flowHarness();
    mountPortal();
    const user = userEvent.setup();

    const d = await openAgent("marrow");
    await user.click(within(d).getByRole("tab", { name: "Lifecycle" }));
    const card = within(d).getByRole("region", { name: "Resume" });
    await user.click(within(card).getByRole("button", { name: "Resume" }));
    await waitFor(() => expect(called(harness!, "agents.resume", "marrow")).toBe(true));
  });

  test("a paused agent's Lifecycle offers no Start, Stop, Pause or live Reboot", async () => {
    harness = await flowHarness();
    mountPortal();
    const user = userEvent.setup();

    const d = await openAgent("marrow");
    await user.click(within(d).getByRole("tab", { name: "Lifecycle" }));
    for (const gone of ["Start", "Stop", "Pause"]) {
      expect(within(d).queryByRole("region", { name: gone })).toBeNull();
    }
    // Reboot stays on the grid, dead, with the reason (core refuses paused).
    const reboot = within(d).getByRole("region", { name: "Reboot" });
    for (const b of within(reboot).getAllByRole("button")) {
      expect((b as HTMLButtonElement).disabled).toBe(true);
    }
    expect(reboot.textContent ?? "").toContain("this one is paused");
  });

  test("the fleet table's status chip says paused, and for how long", async () => {
    useTableLayout();
    harness = await flowHarness();
    mountPortal();

    const row = await screen.findByLabelText("marrow · paused");
    const chip = row.querySelector(".cell-status") as HTMLElement;
    expect(chip.textContent ?? "").toMatch(new RegExp(`^paused${SPAN}$`));
    expect(chip.querySelector(".status-sub")?.textContent ?? "").toMatch(new RegExp(`^${SPAN}$`));
  });
});
