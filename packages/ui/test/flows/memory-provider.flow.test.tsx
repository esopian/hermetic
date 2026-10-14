/**
 * The Hermes external memory provider, end to end through the real head: the
 * create drawer's Memory select, Settings › Defaults' fleet default and its
 * provider list, and the agent drawer's memory line.
 *
 * Fixture facts leaned on (`memory-fixture.ts`, `fixture-agents.ts`): `main`
 * has no default memory provider; `staging` defaults to hindsight. `atlas` was
 * created with holographic, `corvid` with hindsight, `ibis` with honcho (on the
 * openrouter profile: Honcho needs an embeddings vendor). The loadout's default
 * preset is Standard (medium, 32 GiB), which every provider fits, and its
 * default profile is the anthropic one, which Honcho does not serve.
 */
import { cleanup, screen, userEvent, waitFor, within } from "../dom.ts";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { MEMORY_PROVIDERS } from "@hermetic/core/shared";
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
const HONCHO = "Honcho (local server)";

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
    "honcho",
  ]);
  // Nothing is held back on the default preset for size, and the only vendor
  // block is Honcho on the fleet's default (anthropic) profile.
  expect([...select.options].filter((o) => o.disabled).map((o) => o.value)).toEqual(["honcho"]);
  await user.selectOptions(select, "holographic");
  await user.click(create());
  await waitFor(() => expect(paramsOf(h, "agents.create").length).toBe(1));
  expect(paramsOf(h, "agents.create")[0]?.["memory_provider"]).toBe("holographic");
  await screen.findByText("Agent handed off", undefined, { timeout: 10_000 });
}, 20_000);

/*
 * Honcho embeds through an OpenAI-compatible /embeddings endpoint, which
 * anthropic and bedrock lack. The picker says so with the catalogue's own
 * `vendors_note`, and a fleet default of Honcho on such a profile holds Create
 * as core's MEMORY_LLM_UNSUPPORTED would.
 */
test("create: Honcho is blocked on an anthropic profile with the catalogue's note, and allowed on openrouter", async () => {
  harness = await flowHarness({ fleet: "staging" });
  const h = harness;
  mountPortal();
  const user = userEvent.setup();
  const { drawer, select, create } = await openMemoryPicker(user, "wren");
  const note = MEMORY_PROVIDERS.honcho.vendors_note as string;
  expect(note.length).toBeGreaterThan(0);
  const honcho = () => [...select.options].find((o) => o.value === "honcho") as HTMLOptionElement;

  // The fleet's default profile is anthropic.
  await waitFor(() => expect(honcho().disabled).toBe(true));
  expect(honcho().textContent).toBe(`${HONCHO} — not for anthropic`);
  // Each of the others is open on it.
  expect([...select.options].filter((o) => o.disabled).map((o) => o.value)).toEqual(["honcho"]);

  // A stated provider the vendor refuses (here one carried over from a draft or
  // a profile switch) shows the note as the field's hint and holds Create.
  await user.click(within(drawer).getByRole("button", { name: /^Brain/ }));
  await user.click(document.querySelector<HTMLElement>('[data-profile="rtr00002"]') as HTMLElement);
  await user.keyboard("{Escape}");
  await waitFor(() => expect(honcho().disabled).toBe(false));
  await user.selectOptions(select, "honcho");
  await waitFor(() => expect(within(drawer).getByText(/Peer-modelling memory/)).toBeTruthy());

  await user.click(within(drawer).getByRole("button", { name: /^Brain/ }));
  await user.click(document.querySelector<HTMLElement>('[data-profile="ant00001"]') as HTMLElement);
  await user.keyboard("{Escape}");
  await waitFor(() => expect(within(drawer).getAllByText(new RegExp(note)).length).toBeGreaterThan(0));
  expect(create().disabled).toBe(true);
  expect(paramsOf(h, "agents.create").length).toBe(0);

  // Back on a vendor that serves embeddings, the choice is sent.
  await user.click(within(drawer).getByRole("button", { name: /^Brain/ }));
  await user.click(document.querySelector<HTMLElement>('[data-profile="rtr00002"]') as HTMLElement);
  await user.keyboard("{Escape}");
  await waitFor(() => expect(create().disabled).toBe(false));
  await user.click(create());
  await waitFor(() => expect(paramsOf(h, "agents.create").length).toBe(1));
  expect(paramsOf(h, "agents.create")[0]?.["memory_provider"]).toBe("honcho");
}, 30_000);

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
    "honcho",
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
  const honcho = providerRow("honcho").textContent ?? "";
  expect(honcho).toContain("Runs on the box");
  expect(honcho).toContain("Needs ≥ 4 GiB");
  expect(honcho).toContain("Uses the agent's model provider");
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

test("agent detail: Honcho is named by its label on the agent seeded with it", async () => {
  harness = await flowHarness();
  mountPortal();
  const user = userEvent.setup();

  const ibis = await openConfig(user, "ibis");
  await waitFor(() => expect(within(ibis).getByText(HONCHO)).toBeTruthy());
  expect(within(ibis).queryByText(/key: /)).toBeNull();
}, 20_000);

/*
 * The agent drawer's memory switch: Change → choose → read what the switch
 * does → Switch memory, which saves the provider on the row and rolls the one
 * agent out (`plan.rollout`, then `apply`). `fathom` is small (16 GiB, enough
 * for every provider), running, on the anthropic profile, with no provider.
 */
test("agent detail: switching memory saves, rolls out, and the row names the new provider", async () => {
  harness = await flowHarness();
  const h = harness;
  mountPortal();
  const user = userEvent.setup();

  const fathom = await openConfig(user, "fathom");
  await waitFor(() => expect(within(fathom).getByText("Built-in only")).toBeTruthy());
  await user.click(within(fathom).getByRole("button", { name: "Change memory provider" }));

  const select = within(fathom).getByLabelText("Memory provider") as HTMLSelectElement;
  expect(document.activeElement).toBe(select);
  expect(select.value).toBe("none");
  expect(within(select).getByRole("option", { name: "None — built-in only · current" })).toBeTruthy();
  const switchButton = within(fathom).getByRole("button", { name: "Switch memory" });
  // The current provider is no change at all.
  expect((switchButton as HTMLButtonElement).disabled).toBe(true);

  await user.selectOptions(select, "hindsight");
  const confirm = within(fathom).getByRole("group", { name: "Confirm memory switch" });
  expect(confirm.textContent).toContain(`Built-in only → ${HINDSIGHT}`);
  expect(confirm.textContent).toContain("stays on the data volume");
  expect(confirm.textContent).toContain("there again if you switch back");
  expect(confirm.textContent).toContain("do not migrate between providers");
  expect(confirm.textContent).toContain("restarts Hermes briefly");
  // Hindsight is a server hermeticd installs: the first install is not brief.
  expect(confirm.textContent).toContain("can take several minutes");
  expect((switchButton as HTMLButtonElement).disabled).toBe(false);

  const version = (await h.ctx.hermetic().agents.get("fathom")).version;
  await user.click(switchButton);

  await waitFor(() => expect(paramsOf(h, "apply").length).toBe(1));
  const set = paramsOf(h, "agents.set");
  expect(set.length).toBe(1);
  expect(set[0]).toMatchObject({
    name: "fathom",
    memory_provider: "hindsight",
    expected_version: version,
  });
  expect(paramsOf(h, "plan.rollout")[0]).toMatchObject({ agents: ["fathom"] });
  expect(paramsOf(h, "apply")[0]).toMatchObject({ plan: { kind: "rollout" } });

  // The editor closed and the row is the row core wrote.
  await waitFor(() => expect(within(fathom).getByText(HINDSIGHT)).toBeTruthy());
  expect(within(fathom).queryByLabelText("Memory provider")).toBeNull();
  expect((await h.ctx.hermetic().agents.get("fathom")).memory?.provider).toBe("hindsight");
}, 20_000);

test("agent detail: a provider the agent's vendor cannot serve is offered disabled, with the reason", async () => {
  harness = await flowHarness();
  const h = harness;
  mountPortal();
  const user = userEvent.setup();

  // kestrel: medium, on the anthropic profile — Honcho needs an embeddings vendor.
  const kestrel = await openConfig(user, "kestrel");
  await user.click(await within(kestrel).findByRole("button", { name: "Change memory provider" }));
  const select = within(kestrel).getByLabelText("Memory provider") as HTMLSelectElement;
  const honcho = within(select).getByRole("option", {
    name: `${HONCHO} — not for anthropic`,
  }) as HTMLOptionElement;
  expect(honcho.disabled).toBe(true);
  expect((within(select).getByRole("option", { name: HINDSIGHT }) as HTMLOptionElement).disabled).toBe(
    false,
  );

  // Cancel restores the row and sends nothing.
  await user.click(within(kestrel).getByRole("button", { name: "Cancel" }));
  expect(within(kestrel).queryByLabelText("Memory provider")).toBeNull();
  expect(paramsOf(h, "agents.set").length).toBe(0);
  await waitFor(() =>
    expect(document.activeElement).toBe(
      within(kestrel).getByRole("button", { name: "Change memory provider" }),
    ),
  );
}, 20_000);
