/**
 * The agent drawer's Logs and Lifecycle sections, over a real head.
 *
 * Logs is the one section that reads something the drawer did not already
 * have: every source but Activity is a `logs` read through the real handler
 * against the fixture fleet's `MemoryBackend`, whose canned `rpc.logs` answers
 * a journal unit with two lines and a Hermes log file with one. So the claims
 * here are about what the page *asked for* (`harness.calls`) as much as what it
 * shows: opening the section asks the box for nothing, and each source puts
 * exactly its own field on the request.
 *
 * Lifecycle is where every action lives. The claims are the ones an operator
 * relies on: an action that cannot run says why rather than vanishing, the
 * disruptive ones ask again before anything is sent, a started op stays on
 * screen when the operator walks to another section, and a destroyed agent is
 * offered nothing at all.
 *
 * Each test gets its own fixture fleet (`bridge.ts`), so a stop issued here
 * never reaches another flow's `granite`.
 */
import { cleanup, screen, userEvent, waitFor, within } from "../dom.ts";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { FIXTURE, flowHarness, gotoHash, mountPortal, type FlowHarness } from "./bridge.ts";

let harness: FlowHarness | null = null;

/** See `rerun.flow.test.tsx`: the hash is read at mount, so it is cleared before as well as after. */
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

async function openAgent(name: string): Promise<HTMLElement> {
  const user = userEvent.setup();
  await user.click(await screen.findByLabelText(new RegExp(`^${name} · `)));
  return await waitFor(() => {
    const el = screen.getByRole("dialog");
    expect(el.querySelector(".detail-name")?.textContent).toBe(name);
    return el;
  });
}

/** Every `logs` read the page made, as the params it sent. */
function logReads(h: FlowHarness): Array<Record<string, unknown>> {
  return h.calls
    .filter((c) => c.name === "logs.open" || c.name === "logs")
    .map((c) => c.params as Record<string, unknown>);
}

describe("the Logs section", () => {
  test("opens on Activity, asks the box nothing, and reads each source with its own field", async () => {
    harness = await flowHarness();
    mountPortal();
    const user = userEvent.setup();

    const d = await openAgent(FIXTURE.readyAgent);
    await user.click(within(d).getByRole("tab", { name: "Logs" }));

    // Activity is the history the drawer already read: nothing crossed the tailnet.
    await waitFor(() => {
      expect(within(d).getByLabelText("Activity log")).toBeDefined();
    });
    expect(logReads(harness)).toEqual([]);
    // The section rides in the hash, so a reload or a pasted link lands here.
    expect(window.location.hash).toBe(`#agent/${FIXTURE.readyAgent}/logs`);

    // errors.log is Hermes's own file on the data volume: `file`, never `unit`.
    await user.selectOptions(within(d).getByLabelText("Log source"), "errors");
    await waitFor(() => {
      expect(within(d).getByLabelText("errors.log log").textContent ?? "").toContain(
        "provider returned 429",
      );
    });
    expect(logReads(harness)).toEqual([{ name: FIXTURE.readyAgent, file: "errors" }]);

    // A journal unit is `unit`, and the lines carry it.
    await user.selectOptions(within(d).getByLabelText("Log source"), "gateway-unit");
    await waitFor(() => {
      expect(within(d).getByLabelText("Hermes gateway (journal) log").textContent ?? "").toContain(
        "hermes-gateway.service: healthy",
      );
    });
    expect(logReads(harness).at(-1)).toEqual({
      name: FIXTURE.readyAgent,
      unit: "hermes-gateway.service",
    });

    // Refresh is a second read of the same source, not a follow.
    const before = logReads(harness).length;
    await user.click(within(d).getByRole("button", { name: "Refresh" }));
    await waitFor(() => {
      expect(logReads(harness!).length).toBe(before + 1);
    });
    expect(logReads(harness).every((p) => p.follow === undefined)).toBe(true);
  });
});

describe("the Lifecycle section", () => {
  test("says why an action cannot run, asks before a rebuild, and keeps a started op on screen", async () => {
    harness = await flowHarness();
    mountPortal();
    const user = userEvent.setup();

    const d = await openAgent(FIXTURE.readyAgent);
    await user.click(within(d).getByRole("tab", { name: "Lifecycle" }));

    // One card per verb, each saying what it keeps and loses.
    for (const title of [
      "Upgrade Hermes",
      "Reboot",
      "Stop",
      "Rerun failed stages",
      "Rebuild instance",
    ]) {
      expect(within(d).getByRole("region", { name: title })).toBeDefined();
    }
    const rebuild = within(d).getByRole("region", { name: "Rebuild instance" });
    expect(rebuild.textContent ?? "").toContain("keeps");
    expect(rebuild.textContent ?? "").toContain("data volume (/data)");

    // A ready agent has nothing to rerun, and the card says so in place.
    const rerunCard = within(d).getByRole("region", { name: "Rerun failed stages" });
    expect(rerunCard.textContent ?? "").toContain(
      "Not available: rerun needs an agent in error; this one is ready",
    );
    expect(
      within(rerunCard).getByRole("button", { name: "Rerun failed stages" }).hasAttribute("disabled"),
    ).toBe(true);

    // Rebuild asks again, and Cancel sends nothing.
    await user.click(within(rebuild).getByRole("button", { name: "Rebuild…" }));
    const ask = within(rebuild).getByRole("group", { name: "Confirm rebuild" });
    await user.click(within(ask).getByRole("button", { name: "Cancel" }));
    expect(harness.calls.map((c) => c.name)).not.toContain("agents.recreate");

    // Stop is an op: the rail appears above the section…
    await user.click(
      within(within(d).getByRole("region", { name: "Stop" })).getByRole("button", { name: "Stop" }),
    );
    await waitFor(() => {
      expect(harness?.calls.map((c) => c.name)).toContain("agents.stop");
      expect(d.querySelector(".dr-main > .drawer-op")).not.toBeNull();
    });

    // …and stays there when the operator moves to another section.
    await user.click(within(d).getByRole("tab", { name: "Logs" }));
    expect(within(d).getByLabelText("Log source")).toBeDefined();
    expect(d.querySelector(".dr-main > .drawer-op")).not.toBeNull();
  });

  test("the destroy confirm lives in the danger zone and closes when the operator leaves", async () => {
    harness = await flowHarness();
    mountPortal();
    const user = userEvent.setup();

    const d = await openAgent(FIXTURE.readyAgent);
    await user.click(within(d).getByRole("tab", { name: "Lifecycle" }));
    const zone = within(d).getByRole("region", { name: "Danger zone" });
    await user.click(within(zone).getByRole("button", { name: `Destroy ${FIXTURE.readyAgent}…` }));
    await waitFor(() => {
      expect(zone.querySelector(".confirm")).not.toBeNull();
    });
    // Keep is the default, stated rather than implied.
    expect(
      (within(zone).getByRole("radio", { name: /Keep data volume/ }) as HTMLInputElement).checked,
    ).toBe(true);

    // Walking off to Overview drops a half-typed confirm rather than leaving it armed.
    await user.type(within(zone).getByLabelText("Type the agent name to confirm"), FIXTURE.readyAgent);
    await user.click(within(d).getByRole("tab", { name: "Overview" }));
    await user.click(within(d).getByRole("tab", { name: "Lifecycle" }));
    expect(d.querySelector(".confirm")).toBeNull();
    expect(harness.calls.map((c) => c.name)).not.toContain("apply");
  });

  test("a destroyed agent's Lifecycle explains the record and offers nothing", async () => {
    harness = await flowHarness();
    // Destroyed rows are hidden on the board, but a link still opens one — on
    // the section it names.
    gotoHash("#agent/oriole/lifecycle");
    mountPortal();

    const d = await waitFor(() => {
      const el = screen.getByRole("dialog");
      expect(el.querySelector(".detail-name")?.textContent).toBe("oriole");
      return el;
    });
    expect(within(d).getByRole("tab", { name: "Lifecycle" }).getAttribute("aria-selected")).toBe(
      "true",
    );
    await waitFor(() => {
      expect(d.textContent ?? "").toContain("oriole is destroyed.");
    });
    const main = d.querySelector<HTMLElement>(".dr-main");
    expect(main).not.toBeNull();
    expect(within(main as HTMLElement).queryAllByRole("button")).toHaveLength(0);
  });
});
