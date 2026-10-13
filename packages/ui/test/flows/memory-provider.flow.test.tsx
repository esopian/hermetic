/**
 * The Hermes external memory provider, end to end through the real head: the
 * create drawer's Memory select, Settings › Defaults' fleet default and key
 * rows, and the agent drawer's memory line.
 *
 * Fixture facts leaned on (`memory-fixture.ts`, `fixture-agents.ts`): `main`
 * has no default memory provider and its shared `memory-supermemory` slot is
 * filled; no other keyed provider has a key. `atlas` was created with
 * holographic, `corvid` with supermemory.
 */
import { cleanup, screen, userEvent, waitFor, within } from "../dom.ts";
import { afterEach, beforeEach, expect, test } from "bun:test";
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

type User = ReturnType<typeof userEvent.setup>;

function paramsOf(h: FlowHarness, name: string): Record<string, unknown>[] {
  return h.calls.filter((c) => c.name === name).map((c) => c.params as Record<string, unknown>);
}

/**
 * Open the create drawer, name the agent, optionally pick a memory choice
 * (`undefined` leaves the select alone), submit, and return what was sent.
 */
async function createWith(user: User, name: string, memory: string | undefined) {
  const h = harness as FlowHarness;
  await user.click(await screen.findByRole("button", { name: /New agent/ }));
  const drawer = screen.getByRole("dialog", { name: "Create agent" });
  const input = document.getElementById("create-name") as HTMLInputElement;
  await user.clear(input);
  await user.type(input, name);
  await user.click(within(drawer).getByRole("button", { name: /Customize/ }));
  const select = within(drawer).getByLabelText("Memory") as HTMLSelectElement;
  // The fleet default is named in its option: `main` has none.
  expect(select.options[0]?.textContent).toBe("Fleet default (None)");
  // Only supermemory has a key on `main`, so honcho is marked and unpickable.
  await waitFor(() => {
    const honcho = [...select.options].find((o) => o.value === "honcho");
    expect(honcho?.disabled).toBe(true);
  });
  expect([...select.options].find((o) => o.value === "honcho")?.textContent).toBe(
    "Honcho — key missing",
  );
  expect([...select.options].find((o) => o.value === "supermemory")?.disabled).toBe(false);
  if (memory !== undefined) await user.selectOptions(select, memory);
  await user.click(within(drawer).getAllByRole("button", { name: "Create agent →" })[0] as HTMLElement);
  await waitFor(() => expect(paramsOf(h, "agents.create").length).toBe(1));
  return paramsOf(h, "agents.create")[0] as Record<string, unknown>;
}

test("create: a picked provider is sent", async () => {
  harness = await flowHarness();
  mountPortal();
  const body = await createWith(userEvent.setup(), "wren", "supermemory");
  expect(body["memory_provider"]).toBe("supermemory");
  await screen.findByText("Agent handed off", undefined, { timeout: 10_000 });
}, 20_000);

test("create: None is sent as none", async () => {
  harness = await flowHarness();
  mountPortal();
  const body = await createWith(userEvent.setup(), "wren", "none");
  expect(body["memory_provider"]).toBe("none");
}, 20_000);

test("create: the fleet default is inherited by omission", async () => {
  harness = await flowHarness();
  mountPortal();
  const body = await createWith(userEvent.setup(), "wren", undefined);
  expect("memory_provider" in body).toBe(false);
}, 20_000);

function memorySelect(): HTMLSelectElement {
  return screen.getByLabelText("Default memory provider") as HTMLSelectElement;
}

function keyRow(provider: string): HTMLElement {
  const el = document.querySelector<HTMLElement>(`[data-field="memory-key-${provider}"]`);
  if (el === null) throw new Error(`no key row for ${provider}`);
  return el;
}

test("Settings › Defaults: the default saves at once, and None clears it", async () => {
  harness = await flowHarness();
  const h = harness;
  gotoHash("#settings/defaults");
  mountPortal();
  const user = userEvent.setup();

  await waitFor(() => expect(memorySelect().value).toBe(""));
  await user.selectOptions(memorySelect(), "holographic");
  await waitFor(() => expect(paramsOf(h, "settings.set").length).toBe(1));
  expect(paramsOf(h, "settings.set")[0]?.["default_memory_provider"]).toBe("holographic");
  await waitFor(() => expect(memorySelect().value).toBe("holographic"));

  await user.selectOptions(memorySelect(), "");
  await waitFor(() => expect(paramsOf(h, "settings.set").length).toBe(2));
  expect(paramsOf(h, "settings.set")[1]?.["default_memory_provider"]).toBeNull();
  await waitFor(() => expect(memorySelect().value).toBe(""));

  // Re-read from the head, not just the write's answer: the cleared default holds.
  const got = await h.ctx.hermetic().settings.get();
  expect(got.settings.default_memory_provider ?? null).toBeNull();
}, 20_000);

test("Settings › Defaults: a missing key is set inline into the shared slot", async () => {
  harness = await flowHarness();
  const h = harness;
  gotoHash("#settings/defaults");
  mountPortal();
  const user = userEvent.setup();

  await waitFor(() => expect(keyRow("supermemory").textContent).toContain("key set"));
  await waitFor(() => expect(keyRow("honcho").textContent).toContain("key missing"));

  await user.click(within(keyRow("honcho")).getByRole("button", { name: "Set Honcho key" }));
  await user.type(within(keyRow("honcho")).getByPlaceholderText("Honcho API key"), "hk-FIXTURE-typed");
  await user.click(within(keyRow("honcho")).getByRole("button", { name: "Save key" }));

  await waitFor(() => expect(paramsOf(h, "secrets.push").length).toBe(1));
  const push = paramsOf(h, "secrets.push")[0] as Record<string, unknown>;
  expect(push["name"]).toBe("_fleet");
  expect(push["shared"]).toBe("memory-honcho");
  expect(push["value"]).toBe("hk-FIXTURE-typed");
  // The row re-read the slots: the key is set now, so the action is a replace.
  await waitFor(() =>
    expect(within(keyRow("honcho")).getByRole("button", { name: "Replace Honcho key" })).toBeTruthy(),
  );
  // The value is gone once the push returned: the input that held it is
  // unmounted, and reopening the editor starts empty. (An uncontrolled input
  // never serialises `.value` into the markup, so the element is what to check.)
  expect(within(keyRow("honcho")).queryByPlaceholderText("Honcho API key")).toBeNull();
  await user.click(within(keyRow("honcho")).getByRole("button", { name: "Replace Honcho key" }));
  const reopened = within(keyRow("honcho")).getByPlaceholderText("Honcho API key") as HTMLInputElement;
  expect(reopened.value).toBe("");
}, 20_000);

test("create: an inherited keyed default with no key holds Create until None is chosen", async () => {
  harness = await flowHarness();
  // `main`'s honcho slot is empty; make it the fleet default before the page reads meta.
  await harness.ctx.hermetic().settings.set({ default_memory_provider: "honcho" });
  mountPortal();
  const user = userEvent.setup();

  await user.click(await screen.findByRole("button", { name: /New agent/ }));
  const drawer = screen.getByRole("dialog", { name: "Create agent" });
  const create = () =>
    within(drawer).getAllByRole("button", { name: "Create agent →" })[0] as HTMLButtonElement;
  // Customize is still folded: the block is said outside it.
  await waitFor(() => expect(within(drawer).getByText(/Honcho memory has no key/)).toBeTruthy());
  expect(within(drawer).getByText(/Settings › Defaults/)).toBeTruthy();
  expect(create().disabled).toBe(true);

  await user.click(within(drawer).getByRole("button", { name: /Customize/ }));
  const select = within(drawer).getByLabelText("Memory") as HTMLSelectElement;
  expect(select.options[0]?.textContent).toBe("Fleet default (Honcho)");
  await user.selectOptions(select, "none");
  await waitFor(() => expect(create().disabled).toBe(false));
  expect(within(drawer).queryByText(/Honcho memory has no key/)).toBeNull();
}, 20_000);

async function openConfig(user: User, name: string): Promise<HTMLElement> {
  await user.click(await screen.findByRole("button", { name: `Open ${name} details` }));
  const drawer = await waitFor(() => {
    const el = screen.getByRole("dialog");
    expect(el.querySelector(".detail-name")?.textContent).toBe(name);
    return el;
  });
  await user.click(within(drawer).getByRole("tab", { name: "Config" }));
  return drawer;
}

test("agent detail: the memory row names the provider and its key slot", async () => {
  harness = await flowHarness();
  mountPortal();
  const user = userEvent.setup();

  const atlas = await openConfig(user, "atlas");
  await waitFor(() => expect(within(atlas).getByText("Holographic (local)")).toBeTruthy());
  expect(within(atlas).queryByText(/key: /)).toBeNull();
}, 20_000);

test("agent detail: a keyed provider shows its key slot; none reads built-in", async () => {
  harness = await flowHarness();
  mountPortal();
  const user = userEvent.setup();

  const corvid = await openConfig(user, "corvid");
  await waitFor(() => expect(within(corvid).getByText("Supermemory")).toBeTruthy());
  expect(within(corvid).getByText(/key: memory-key/)).toBeTruthy();
}, 20_000);
