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
import { HermeticError } from "@hermetic/core";
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
    "prism",
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
  // The card under the select carries the same reason, with no size to switch to.
  const card = drawer.querySelector<HTMLElement>('[data-memory-card="honcho"]') as HTMLElement;
  expect(within(card).getByRole("status").textContent).toBe(note);
  expect(within(card).queryByRole("button", { name: /Switch to/ })).toBeNull();

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
  // Named by the size it needs, as the card's fit line names it.
  expect(option("hindsight").textContent).toBe(`${HINDSIGHT} — needs small or larger`);
  expect(option("openviking").textContent).toBe("OpenViking (local server) — needs xsmall or larger");
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

/*
 * The resource card under the Memory select: the effective choice's summary
 * and chips, and its fit against the size this create gets. An undersized
 * provider says which size it needs and offers it; taking the offer moves the
 * size the same way the size picker does, and Create comes back.
 */
test("create: the memory card warns on a size too small, and Switch moves the size", async () => {
  harness = await flowHarness();
  mountPortal();
  const user = userEvent.setup();
  const { drawer, select, create } = await openMemoryPicker(user, "wren");
  const card = () => drawer.querySelector<HTMLElement>("[data-memory-card]");

  // The fleet default (None on main) is named beside the label, and its card is drawn.
  // Once, as the field's own tag, while the field inherits.
  await waitFor(() => expect(within(drawer).getAllByText("fleet default: None").length).toBe(1));
  expect(within(drawer).getByText("fleet default: None").className).toBe("cr-deftag");
  expect(card()?.dataset["memoryCard"]).toBe("none");
  expect(within(card() as HTMLElement).getByText("Hermes MEMORY.md / USER.md only.")).toBeTruthy();

  // Hindsight on the Standard preset (medium, 32 GiB) fits.
  await user.selectOptions(select, "hindsight");
  await waitFor(() => expect(card()?.dataset["memoryCard"]).toBe("hindsight"));
  // Changed: the tag is `changed · reset`, and the default is still named once.
  expect(within(drawer).getByRole("button", { name: "Reset Memory" })).toBeTruthy();
  expect(within(drawer).getAllByText("fleet default: None").length).toBe(1);
  expect(within(drawer).getByText("fleet default: None").className).toBe("mem-fleetdef");
  expect(within(card() as HTMLElement).getByText(MEMORY_PROVIDERS.hindsight.summary)).toBeTruthy();
  expect(card()?.querySelector('[data-fact="ram_floor"]')?.textContent).toBe("RAM: ≥ 8 GiB (small+)");
  expect(within(card() as HTMLElement).getByRole("status").textContent).toBe("");
  expect(create().disabled).toBe(false);
  // The select is described by the card's fit line.
  expect(select.getAttribute("aria-describedby")).toBe(
    within(card() as HTMLElement).getByRole("status").id,
  );

  // xsmall (t4g.medium, 4 GiB) does not.
  const more = within(drawer).queryByRole("button", { name: /More sizes/ });
  if (more !== null) await user.click(more);
  await user.click(within(drawer).getByRole("button", { name: /t4g\.medium/ }));
  await waitFor(() =>
    expect(within(card() as HTMLElement).getByRole("status").textContent).toBe(
      "Needs size small (16 GiB) or larger. Selected: xsmall (4 GiB)",
    ),
  );
  expect(create().disabled).toBe(true);
  // One live region says it: the drawer's own line stays quiet while the card is shown,
  // and takes over once Customize is folded away.
  const blockLine = () => drawer.querySelector("[data-memory-block]");
  expect(blockLine()?.getAttribute("role") ?? null).toBeNull();
  await user.click(within(drawer).getByRole("button", { name: /Customize/ }));
  await waitFor(() => expect(blockLine()?.getAttribute("role")).toBe("status"));
  await user.click(within(drawer).getByRole("button", { name: /Customize/ }));
  await waitFor(() => expect(blockLine()?.getAttribute("role") ?? null).toBeNull());

  // Switch: the size becomes small, as if picked, and the warning and the hold go.
  await user.click(within(card() as HTMLElement).getByRole("button", { name: "Switch to small →" }));
  await waitFor(() =>
    expect(
      within(drawer)
        .getByRole("button", { name: /r8g\.large/ })
        .getAttribute("aria-pressed"),
    ).toBe("true"),
  );
  expect(within(drawer).getByRole("button", { name: "Reset Size" })).toBeTruthy();
  expect(within(card() as HTMLElement).getByRole("status").textContent).toBe("");
  expect(within(card() as HTMLElement).queryByRole("button", { name: /Switch to/ })).toBeNull();
  // The button went with the warning; focus stays on the Memory field, not the drawer's top.
  // (Looked up again: folding Customize above remounted the select.)
  expect(document.activeElement?.id).toBe(within(drawer).getByLabelText("Memory").id);
  expect(within(drawer).queryByText(/needs at least 8 GiB/)).toBeNull();
  expect(create().disabled).toBe(false);
}, 20_000);

test("create: the staging fleet's default is named once, in the Memory tag, and carded", async () => {
  harness = await flowHarness({ fleet: "staging" });
  mountPortal();
  const user = userEvent.setup();
  const { drawer } = await openMemoryPicker(user, "wren");
  await waitFor(() => expect(within(drawer).getByText(`fleet default: ${HINDSIGHT}`)).toBeTruthy());
  const card = drawer.querySelector<HTMLElement>("[data-memory-card]") as HTMLElement;
  expect(card.dataset["memoryCard"]).toBe("hindsight");
}, 20_000);

function memoryGroup(): HTMLElement {
  return screen.getByRole("radiogroup", { name: "Default memory provider" });
}

function memoryRadio(name: string): HTMLInputElement {
  return within(memoryGroup()).getByRole("radio", { name }) as HTMLInputElement;
}

function checkedValue(): string | undefined {
  return within(memoryGroup())
    .getAllByRole("radio")
    .map((r) => r as HTMLInputElement)
    .find((r) => r.checked)?.value;
}

function providerRow(provider: string): HTMLElement {
  const el = document.querySelector<HTMLElement>(`[data-field="memory-provider-${provider}"]`);
  if (el === null) throw new Error(`no provider row for ${provider}`);
  return el;
}

function saveDefault(): HTMLButtonElement {
  return screen.getByRole("button", { name: "Save default" }) as HTMLButtonElement;
}

/** Which rows carry the Fleet default tag (the saved default, not the pick). */
function taggedRows(): string[] {
  return [...memoryGroup().querySelectorAll<HTMLElement>("[data-field^='memory-provider-']")]
    .filter((r) => r.querySelector(".mem-tag-default") !== null)
    .map((r) => (r.dataset["field"] ?? "").replace("memory-provider-", ""));
}

test("Settings › Defaults: every choice is a radio with its resource chips, and Honcho names the vendors it cannot serve", async () => {
  harness = await flowHarness();
  gotoHash("#settings/defaults");
  mountPortal();

  await waitFor(() => expect(checkedValue()).toBe("none"));
  const radios = within(memoryGroup()).getAllByRole("radio") as HTMLInputElement[];
  expect(radios.map((r) => r.value)).toEqual([
    "none",
    "holographic",
    "hindsight",
    "openviking",
    "honcho",
    "prism",
  ]);
  // One native group: a single tab stop, and the arrow keys move within it.
  expect(new Set(radios.map((r) => r.name)).size).toBe(1);
  expect(radios[0]?.name).not.toBe("");
  expect(memoryRadio("None (built-in only)").checked).toBe(true);
  expect(taggedRows()).toEqual(["none"]);

  // Chips with no vendor: the general statements.
  const chip = (provider: string, fact: string) =>
    providerRow(provider).querySelector<HTMLElement>(`[data-fact="${fact}"]`)?.textContent ?? "";
  expect(chip("none", "services")).toContain("0");
  expect(chip("hindsight", "ram_floor")).toContain("8 GiB (small+)");
  expect(chip("openviking", "embeddings")).toContain("local model on anthropic/bedrock");
  expect(chip("honcho", "embeddings")).toContain("provider");
  expect(document.querySelectorAll(".mem-est").length).toBe(1);

  // Honcho, and only Honcho, says which vendors it cannot serve.
  expect(providerRow("honcho").textContent).toContain(
    "Not available for anthropic / bedrock agents: no embeddings API",
  );
  for (const p of ["none", "holographic", "hindsight", "openviking", "prism"]) {
    expect(providerRow(p).querySelector(".mem-opt-note")).toBeNull();
  }
  // Nothing about keys is left anywhere on the page.
  expect(document.body.textContent).not.toMatch(/\bkey missing\b|Set .* key|shared slot memory-/);
}, 20_000);

test("Settings › Defaults: a pick is staged, Save writes it and moves the tag, and None clears it", async () => {
  harness = await flowHarness();
  const h = harness;
  gotoHash("#settings/defaults");
  mountPortal();
  const user = userEvent.setup();

  await waitFor(() => expect(checkedValue()).toBe("none"));
  expect(saveDefault().disabled).toBe(true);
  await user.click(memoryRadio(HINDSIGHT));
  // Staged: the row is picked, nothing is written, the tag stays on the saved default.
  expect(checkedValue()).toBe("hindsight");
  expect(providerRow("hindsight").classList.contains("on")).toBe(true);
  expect(paramsOf(h, "settings.set").length).toBe(0);
  expect(taggedRows()).toEqual(["none"]);

  const metaBefore = paramsOf(h, "meta.get").length;
  await user.click(saveDefault());
  await waitFor(() => expect(paramsOf(h, "settings.set").length).toBe(1));
  expect(paramsOf(h, "settings.set")[0]?.["default_memory_provider"]).toBe("hindsight");
  await waitFor(() => expect(taggedRows()).toEqual(["hindsight"]));
  await waitFor(() => expect(paramsOf(h, "meta.get").length).toBeGreaterThan(metaBefore));
  expect(saveDefault().disabled).toBe(true);
  // The pressed button is now disabled: focus is back on the checked radio, not the body.
  await waitFor(() => expect(document.activeElement?.id).toBe(memoryRadio(HINDSIGHT).id));
  expect(memoryRadio(HINDSIGHT).id).not.toBe("");

  await user.click(memoryRadio("None (built-in only)"));
  await user.click(saveDefault());
  await waitFor(() => expect(paramsOf(h, "settings.set").length).toBe(2));
  expect(paramsOf(h, "settings.set")[1]?.["default_memory_provider"]).toBeNull();
  await waitFor(() => expect(taggedRows()).toEqual(["none"]));
  expect(checkedValue()).toBe("none");

  // Re-read from the head, not just the write's answer: the cleared default holds.
  const got = await h.ctx.hermetic().settings.get();
  expect(got.settings.default_memory_provider ?? null).toBeNull();
}, 20_000);

test("Settings › Defaults: Revert drops a staged pick and writes nothing", async () => {
  harness = await flowHarness({ fleet: "staging" });
  const h = harness;
  gotoHash("#settings/defaults");
  mountPortal();
  const user = userEvent.setup();

  await waitFor(() => expect(checkedValue()).toBe("hindsight"));
  expect(taggedRows()).toEqual(["hindsight"]);
  await user.click(memoryRadio("Holographic (local)"));
  expect(checkedValue()).toBe("holographic");
  await user.click(screen.getByRole("button", { name: "Revert" }));
  expect(checkedValue()).toBe("hindsight");
  // Revert's button is gone: focus returns to the checked (saved) radio.
  await waitFor(() => expect(document.activeElement?.id).toBe(memoryRadio(HINDSIGHT).id));
  expect(paramsOf(h, "settings.set").length).toBe(0);
}, 20_000);

test("Settings › Defaults: a refused save shows the refusal, writes nothing and gives focus back to Save", async () => {
  harness = await flowHarness();
  const h = harness;
  h.intercept("settings.set", () => {
    // A browser's focus fixup moves focus off a button disabled while focused
    // (Save, while the write runs); happy-dom leaves it there, so do it here.
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
    throw new HermeticError("CONFLICT", "settings changed since they were read");
  });
  gotoHash("#settings/defaults");
  mountPortal();
  const user = userEvent.setup();

  await waitFor(() => expect(checkedValue()).toBe("none"));
  await user.click(memoryRadio(HINDSIGHT));
  await user.click(saveDefault());
  await waitFor(() => expect(paramsOf(h, "settings.set").length).toBe(1));
  const row = document.querySelector<HTMLElement>(
    '[data-field="default_memory_provider"]',
  ) as HTMLElement;
  await waitFor(() =>
    expect(row.textContent).toContain("CONFLICT · settings changed since they were read"),
  );
  // The pick is still staged and Save is live again: the operator can retry.
  expect(checkedValue()).toBe("hindsight");
  expect(taggedRows()).toEqual(["none"]);
  expect(saveDefault().disabled).toBe(false);
  // Save was disabled while the write ran; focus is back on it, not the body.
  expect(saveDefault().id).not.toBe("");
  await waitFor(() => expect(document.activeElement?.id).toBe(saveDefault().id));
}, 20_000);

test("Settings › Defaults: a stored default this build does not know is shown as such and can be cleared", async () => {
  harness = await flowHarness();
  const h = harness;
  // A newer build wrote a provider this one has no entry for. Settings is
  // seeded from meta's copy; once a write lands, the head's own answer stands.
  h.intercept("meta.get", async (_params, passthrough) => {
    const got = (await passthrough()) as { settings: { settings: Record<string, unknown> } };
    if (paramsOf(h, "settings.set").length > 0) return got;
    const settings = {
      ...got.settings,
      settings: { ...got.settings.settings, default_memory_provider: "mem0" },
    };
    return { ...got, settings };
  });
  gotoHash("#settings/defaults");
  mountPortal();
  const user = userEvent.setup();

  const note = await waitFor(() => {
    const el = document.querySelector<HTMLElement>(".mem-def-unknown");
    if (el === null) throw new Error("no unknown-default note");
    return el;
  });
  expect(note.textContent).toContain("Stored default: mem0 (unknown to this version)");
  expect(memoryGroup().getAttribute("aria-describedby")).toBe(note.id);
  // Nothing claims to be the default, and nothing is checked.
  expect(taggedRows()).toEqual([]);
  expect(checkedValue()).toBeUndefined();
  expect(saveDefault().disabled).toBe(true);

  // None differs from what is stored, so it can be saved, and is sent as null.
  await user.click(memoryRadio("None (built-in only)"));
  const row = document.querySelector<HTMLElement>(
    '[data-field="default_memory_provider"]',
  ) as HTMLElement;
  expect(row.textContent).toContain("was mem0");
  expect(saveDefault().disabled).toBe(false);
  await user.click(saveDefault());
  await waitFor(() => expect(paramsOf(h, "settings.set").length).toBe(1));
  expect(paramsOf(h, "settings.set")[0]?.["default_memory_provider"]).toBeNull();
  await waitFor(() => expect(taggedRows()).toEqual(["none"]));
  expect(document.querySelector(".mem-def-unknown")).toBeNull();
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

  await waitFor(() => expect(checkedValue()).toBe("none"));
  await user.click(memoryRadio(HINDSIGHT));
  await user.click(saveDefault());
  await waitFor(() => expect(paramsOf(h, "settings.set").length).toBe(1));
  await waitFor(() => expect(taggedRows()).toEqual(["hindsight"]));

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
 * for every provider), running, on the bedrock profile, with no provider.
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

/*
 * The chooser cards the chosen option for this agent: chips with the
 * embeddings answer for its vendor, and the fit on its size. `fathom` is small
 * (16 GiB) on the bedrock profile with no provider, so Hindsight fits and
 * Honcho is refused for the vendor.
 */
test("agent detail: the chooser cards the chosen provider, fitted to the agent", async () => {
  harness = await flowHarness();
  const h = harness;
  mountPortal();
  const user = userEvent.setup();
  expect((await h.ctx.hermetic().agents.get("fathom")).provider).toBe("bedrock");

  const fathom = await openConfig(user, "fathom");
  await user.click(await within(fathom).findByRole("button", { name: "Change memory provider" }));
  const select = within(fathom).getByLabelText("Memory provider") as HTMLSelectElement;
  const card = () => fathom.querySelector<HTMLElement>("[data-memory-card]") as HTMLElement;
  expect(card().dataset["memoryCard"]).toBe("none");

  await user.selectOptions(select, "hindsight");
  expect(card().dataset["memoryCard"]).toBe("hindsight");
  expect(card().textContent).toContain(MEMORY_PROVIDERS.hindsight.summary);
  expect(card().querySelector('[data-fact="ram_floor"]')?.textContent).toContain("8 GiB (small+)");
  const fit = card().querySelector<HTMLElement>(".mem-fit") as HTMLElement;
  expect(fit.dataset["fit"]).toBe("fits");
  // The select is described by the fit line, a live region present while it is empty.
  const msg = within(card()).getByRole("status");
  expect(select.getAttribute("aria-describedby")).toBe(msg.id);
  expect(msg.textContent).toBe("");
  // No size switch here: a size change is not this flow.
  expect(within(card()).queryByRole("button")).toBeNull();

  // OpenViking's embeddings are the effective answer for bedrock.
  await user.selectOptions(select, "openviking");
  expect(card().querySelector('[data-fact="embeddings"]')?.textContent).toContain(
    "on box (local model)",
  );

  // Honcho stays offered but disabled, with core's reason on the option.
  const honcho = within(select).getByRole("option", {
    name: `${HONCHO} — not for bedrock`,
  }) as HTMLOptionElement;
  expect(honcho.disabled).toBe(true);
  expect(honcho.title).toBe(MEMORY_PROVIDERS.honcho.vendors_note as string);
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
