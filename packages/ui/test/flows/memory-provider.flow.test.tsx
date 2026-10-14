/**
 * The Hermes external memory provider, end to end through the real head: the
 * create drawer's Memory select, Settings › Defaults' fleet default and its
 * provider list, and the agent drawer's memory line.
 *
 * Fixture facts leaned on (`memory-fixture.ts`, `fixture-agents.ts`): `main`
 * has no default memory provider; `staging` defaults to hindsight. `atlas` was
 * created with holographic, `corvid` with hindsight. The loadout's default
 * preset is Standard (medium, 32 GiB), which every provider fits.
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

const HINDSIGHT = "Hindsight (local server)";

/** Open the create drawer, name the agent, unfold Customize, and hand back the Memory select. */
async function openMemoryPicker(user: User, name: string) {
  await user.click(await screen.findByRole("button", { name: /New agent/ }));
  const drawer = screen.getByRole("dialog", { name: "Create agent" });
  const input = document.getElementById("create-name") as HTMLInputElement;
  await user.clear(input);
  await user.type(input, name);
  await user.click(within(drawer).getByRole("button", { name: /Customize/ }));
  const select = within(drawer).getByLabelText("Memory") as HTMLSelectElement;
  const create = () =>
    within(drawer).getAllByRole("button", { name: "Create agent →" })[0] as HTMLButtonElement;
  return { drawer, select, create };
}

/**
 * Open the picker, optionally pick a memory choice (`undefined` leaves the
 * select alone), submit, and return what was sent.
 */
async function createWith(user: User, name: string, memory: string | undefined, inherited: string) {
  const h = harness as FlowHarness;
  const { select, create } = await openMemoryPicker(user, name);
  // The fleet default is named in its option.
  await waitFor(() => expect(select.options[0]?.textContent).toBe(`Fleet default (${inherited})`));
  if (memory !== undefined) await user.selectOptions(select, memory);
  await user.click(create());
  await waitFor(() => expect(paramsOf(h, "agents.create").length).toBe(1));
  return paramsOf(h, "agents.create")[0] as Record<string, unknown>;
}

test("create: the picker offers exactly the catalogue, and a picked provider is sent", async () => {
  harness = await flowHarness();
  const h = harness;
  mountPortal();
  const user = userEvent.setup();
  const { select, create } = await openMemoryPicker(user, "wren");
  await waitFor(() => expect(select.options[0]?.textContent).toBe("Fleet default (None)"));
  expect([...select.options].map((o) => o.value)).toEqual([
    "",
    "none",
    "holographic",
    "hindsight",
    "openviking",
  ]);
  // Nothing is held back on the default preset: every provider fits a medium.
  expect([...select.options].some((o) => o.disabled)).toBe(false);
  await user.selectOptions(select, "holographic");
  await user.click(create());
  await waitFor(() => expect(paramsOf(h, "agents.create").length).toBe(1));
  expect(paramsOf(h, "agents.create")[0]?.["memory_provider"]).toBe("holographic");
  await screen.findByText("Agent handed off", undefined, { timeout: 10_000 });
}, 20_000);

test("create: the fleet default is inherited by omission", async () => {
  harness = await flowHarness();
  mountPortal();
  const body = await createWith(userEvent.setup(), "wren", undefined, "None");
  expect("memory_provider" in body).toBe(false);
}, 20_000);

test("create: the staging fleet's default is named, and inherited by omission", async () => {
  harness = await flowHarness({ fleet: "staging" });
  mountPortal();
  const body = await createWith(userEvent.setup(), "wren", undefined, HINDSIGHT);
  expect("memory_provider" in body).toBe(false);
}, 20_000);

test("create: None overrides a fleet default and is sent as none", async () => {
  harness = await flowHarness({ fleet: "staging" });
  mountPortal();
  const body = await createWith(userEvent.setup(), "wren", "none", HINDSIGHT);
  expect(body["memory_provider"]).toBe("none");
}, 20_000);

test("create: a size too small for a provider's server marks it, and an inherited one holds Create", async () => {
  harness = await flowHarness({ fleet: "staging" });
  mountPortal();
  const user = userEvent.setup();
  const { drawer, select, create } = await openMemoryPicker(user, "wren");
  await waitFor(() => expect(select.options[0]?.textContent).toBe(`Fleet default (${HINDSIGHT})`));
  expect(create().disabled).toBe(false);

  // micro: 1 GiB, under both servers' minimum.
  const more = within(drawer).queryByRole("button", { name: /More sizes/ });
  if (more !== null) await user.click(more);
  await user.click(within(drawer).getByRole("button", { name: /t4g\.micro/ }));

  const option = (v: string) => [...select.options].find((o) => o.value === v) as HTMLOptionElement;
  await waitFor(() => expect(option("hindsight").disabled).toBe(true));
  expect(option("hindsight").textContent).toBe(`${HINDSIGHT} — needs ≥ 8 GiB`);
  expect(option("openviking").disabled).toBe(true);
  expect(option("holographic").disabled).toBe(false);
  // The inherited hindsight would be refused by core, so Create waits, and says why.
  expect(
    within(drawer).getByText(/needs at least 8 GiB of instance memory; micro has 1 GiB/),
  ).toBeTruthy();
  expect(create().disabled).toBe(true);

  await user.selectOptions(select, "holographic");
  await waitFor(() => expect(create().disabled).toBe(false));
  expect(within(drawer).queryByText(/needs at least 8 GiB/)).toBeNull();
}, 20_000);

function memorySelect(): HTMLSelectElement {
  return screen.getByLabelText("Default memory provider") as HTMLSelectElement;
}

function providerRow(provider: string): HTMLElement {
  const el = document.querySelector<HTMLElement>(`[data-field="memory-provider-${provider}"]`);
  if (el === null) throw new Error(`no provider row for ${provider}`);
  return el;
}

test("Settings › Defaults: each provider says where it runs and what it needs", async () => {
  harness = await flowHarness();
  gotoHash("#settings/defaults");
  mountPortal();

  await waitFor(() => expect(memorySelect().value).toBe(""));
  expect([...memorySelect().options].map((o) => o.value)).toEqual([
    "",
    "holographic",
    "hindsight",
    "openviking",
  ]);
  const holo = providerRow("holographic").textContent ?? "";
  expect(holo).toContain("Inside Hermes");
  expect(holo).not.toContain("Needs ≥");
  expect(holo).not.toContain("model provider");
  const hind = providerRow("hindsight").textContent ?? "";
  expect(hind).toContain("Runs on the box");
  expect(hind).toContain("Needs ≥ 8 GiB");
  expect(hind).toContain("Uses the agent's model provider");
  expect(providerRow("openviking").textContent).toContain("Needs ≥ 4 GiB");
  // Nothing about keys is left anywhere on the page.
  expect(document.body.textContent).not.toMatch(/\bkey missing\b|Set .* key|shared slot memory-/);
}, 20_000);

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

/*
 * The create drawer reads the fleet default from the page's `/api/meta` copy,
 * not from Settings' own. A save that updated only Settings left the drawer
 * naming the old default until something else re-read meta.
 */
test("a default saved in Settings is the drawer's default straight away, with no remount", async () => {
  harness = await flowHarness();
  const h = harness;
  gotoHash("#settings/defaults");
  mountPortal();
  const user = userEvent.setup();

  await waitFor(() => expect(memorySelect().value).toBe(""));
  await user.selectOptions(memorySelect(), "hindsight");
  await waitFor(() => expect(paramsOf(h, "settings.set").length).toBe(1));
  await waitFor(() => expect(memorySelect().value).toBe("hindsight"));

  gotoHash("#fleet");
  const { select } = await openMemoryPicker(user, "wren");
  await waitFor(() => expect(select.options[0]?.textContent).toBe(`Fleet default (${HINDSIGHT})`));
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

test("agent detail: the memory row names the provider and nothing about a key", async () => {
  harness = await flowHarness();
  mountPortal();
  const user = userEvent.setup();

  const atlas = await openConfig(user, "atlas");
  await waitFor(() => expect(within(atlas).getByText("Holographic (local)")).toBeTruthy());
  expect(within(atlas).queryByText(/key: /)).toBeNull();
}, 20_000);

test("agent detail: a service provider is named by its label", async () => {
  harness = await flowHarness();
  mountPortal();
  const user = userEvent.setup();

  const corvid = await openConfig(user, "corvid");
  await waitFor(() => expect(within(corvid).getByText(HINDSIGHT)).toBeTruthy());
  expect(within(corvid).queryByText(/key: /)).toBeNull();
}, 20_000);
