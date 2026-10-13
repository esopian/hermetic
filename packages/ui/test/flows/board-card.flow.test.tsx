import { cleanup, screen, userEvent, waitFor, within } from "../dom.ts";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { type FlowHarness, flowHarness, gotoHash, mountPortal } from "./bridge.ts";

let harness: FlowHarness | null = null;
beforeEach(() => {
  window.localStorage.removeItem("hermetic.layout");
  gotoHash("#fleet");
});
afterEach(async () => {
  cleanup();
  await harness?.restore();
  harness = null;
  gotoHash("");
});

test("board diagnosis links, Start, and in-band Listen reach the real head", async () => {
  harness = await flowHarness();
  const h = harness;
  mountPortal();
  const user = userEvent.setup();

  const corvid = await screen.findByLabelText("corvid · ready");
  expect(corvid.getAttribute("role")).toBe("group");
  expect(corvid.textContent).toContain("Saved: openrouter → anthropic");
  await user.click(within(corvid).getByRole("button", { name: "Apply… →" }));
  const drawer = await screen.findByRole("dialog");
  expect(within(drawer).getByRole("tab", { name: "Config" }).getAttribute("aria-selected")).toBe(
    "true",
  );
  await user.keyboard("{Escape}");

  const open = within(corvid).getByRole("button", { name: "Open ▾" });
  await user.click(open);
  expect(within(corvid).getByRole("menu", { name: "Open corvid" })).toBeTruthy();
  await user.keyboard("{Escape}");
  expect(within(corvid).queryByRole("menu")).toBeNull();
  expect(document.activeElement).toBe(open);

  const lumen = await screen.findByLabelText("lumen · unreachable");
  await user.click(within(lumen).getByRole("button", { name: "Open console →" }));
  const logs = await screen.findByRole("dialog");
  expect(within(logs).getByRole("tab", { name: "Logs" }).getAttribute("aria-selected")).toBe("true");
  expect((within(logs).getByRole("combobox", { name: "Log source" }) as HTMLSelectElement).value).toBe(
    "console",
  );
  await user.keyboard("{Escape}");

  const juniper = await screen.findByLabelText("juniper · stopped");
  await user.click(within(juniper).getByRole("button", { name: "Start" }));
  await waitFor(() =>
    expect(
      h.calls.some(
        (c) => c.name === "agents.start" && (c.params as { name?: string }).name === "juniper",
      ),
    ).toBe(true),
  );

  const ibis = await screen.findByLabelText("ibis · ready");
  expect(within(ibis).queryByRole("button", { name: "Chat with ibis" })).toBeNull();
  const toggle = within(ibis).getByRole("switch", { name: "Listen to ibis" });
  await user.click(toggle);
  await waitFor(() => expect(toggle.getAttribute("aria-checked")).toBe("true"));
  await waitFor(() =>
    expect(within(ibis).getByRole("button", { name: "Chat with ibis" })).toBeTruthy(),
  );
});
