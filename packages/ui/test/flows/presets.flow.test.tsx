/**
 * Settings › Create presets (§4.6), end to end: the real page against the
 * real `dispatch` over the fixture backend, with the document landing in the
 * fixture home's own `prefs` row — and the create drawer drawing its strip
 * from what the page just saved.
 *
 * Each gesture is asserted twice: on screen, and in what `presets.get` now
 * answers from the head, so a page that only *looked* saved fails here.
 */
import { cleanup, fireEvent, screen, userEvent, waitFor, within } from "../dom.ts";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { dispatch } from "../../../app/src/handlers/dispatch.ts";
import { resetPresetsStore } from "../../src/state/presets-store.ts";
import { type FlowHarness, flowHarness, gotoHash, mountPortal } from "./bridge.ts";

let harness: FlowHarness | null = null;

beforeEach(() => {
  window.localStorage.removeItem("hermetic.layout");
  window.sessionStorage.clear();
  resetPresetsStore();
  gotoHash("");
});

afterEach(async () => {
  cleanup();
  await harness?.restore();
  harness = null;
  resetPresetsStore();
  gotoHash("");
});

interface Held {
  source: string;
  loadout: (string | null)[];
  default: string | null;
  custom: { id: string; name: string; size: string; volume_gib: number; root_gib: number }[];
}

async function held(h: FlowHarness): Promise<Held> {
  return (await dispatch(h.ctx, "presets.get", {})) as Held;
}

function loadoutIds(): (string | null)[] {
  return [...document.querySelectorAll(".pr-load [data-slot]")].map((el) =>
    el.getAttribute("data-preset"),
  );
}

function card(id: string): HTMLElement {
  return document.querySelector(`.pr-load [data-preset="${id}"]`) as HTMLElement;
}

function slot(n: number): HTMLElement {
  return document.querySelector(`.pr-load [data-slot="${n}"]`) as HTMLElement;
}

/** A drag carrying `data` dropped on `target` — the page reads only `getData`. */
function drop(target: HTMLElement, data: string) {
  const dataTransfer = { getData: () => data, setData: () => {} };
  fireEvent.dragOver(target, { dataTransfer });
  fireEvent.drop(target, { dataTransfer });
}

async function openPage() {
  gotoHash("#settings/presets");
  mountPortal();
  await screen.findByText("Loadout · 4 of 4");
}

test("tick, drop, move, default, remove and reset each save this laptop's loadout", async () => {
  harness = await flowHarness();
  await openPage();
  const user = userEvent.setup();
  const h = harness;

  expect(loadoutIds()).toEqual(["light", "standard", "heavy", "gpu"]);
  expect(card("standard").textContent).toContain("Default");
  expect(card("standard").textContent).toContain("medium · t4g.2xlarge");

  // A tick on a full loadout adds nothing and says how to swap one in.
  await user.click(screen.getByRole("button", { name: "Add Micro to the loadout" }));
  expect(await screen.findByText("Loadout full: drop it on a card to replace.")).toBeTruthy();
  expect((await held(h)).source).toBe("builtin");

  // Dropping a library row on a card replaces it.
  drop(slot(2), "preset:micro");
  await waitFor(async () =>
    expect((await held(h)).loadout).toEqual(["light", "standard", "micro", "gpu"]),
  );
  await waitFor(() => expect(loadoutIds()).toEqual(["light", "standard", "micro", "gpu"]));

  // The card's menu: Move left, Set as default — the keyboard's way to do what a drag does.
  await user.click(screen.getByRole("button", { name: "More actions for Micro" }));
  await user.click(screen.getByRole("menuitem", { name: /Move left/ }));
  await waitFor(() => expect(loadoutIds()).toEqual(["light", "micro", "standard", "gpu"]));
  await user.click(screen.getByRole("button", { name: "More actions for Micro" }));
  await user.click(screen.getByRole("menuitem", { name: /Set as default/ }));
  await waitFor(async () => expect((await held(h)).default).toBe("micro"));

  // A card dragged onto another slot swaps with it.
  drop(slot(3), "slot:0");
  await waitFor(() => expect(loadoutIds()).toEqual(["gpu", "micro", "standard", "light"]));

  // Remove empties the slot; removing the default moves the default.
  await user.click(screen.getByRole("button", { name: "More actions for Micro" }));
  await user.click(screen.getByRole("menuitem", { name: /Remove/ }));
  await waitFor(async () => {
    const now = await held(h);
    expect(now.loadout).toEqual(["gpu", null, "standard", "light"]);
    expect(now.default).toBe("gpu");
  });
  expect(await screen.findByText("Loadout · 3 of 4")).toBeTruthy();
  expect(slot(1).textContent).toContain("Drop a preset here");
  // …and now a tick has somewhere to go.
  await user.click(screen.getByRole("button", { name: "Add XXL to the loadout" }));
  await waitFor(async () => expect((await held(h)).loadout[1]).toBe("xxl"));

  // Reset forgets the row.
  await user.click(screen.getByRole("button", { name: "Reset to built-in" }));
  await waitFor(async () => expect((await held(h)).source).toBe("builtin"));
  await waitFor(() => expect(loadoutIds()).toEqual(["light", "standard", "heavy", "gpu"]));
});

test("a library row expands to its details; a built-in has no Edit or Delete", async () => {
  harness = await flowHarness();
  await openPage();
  const user = userEvent.setup();

  await user.click(screen.getByRole("button", { name: "Show details for Heavy" }));
  const lib = document.querySelector(".pr-lib") as HTMLElement;
  const details = within(lib).getByText("large · r8g.2xlarge").closest(".pr-exp") as HTMLElement;
  expect(details.textContent).toContain("8 vCPU · 64 GiB");
  expect(details.textContent).toContain("200 GiB gp3");
  expect(details.textContent).toContain("instance $344.00");
  expect(details.textContent).toContain("+ data $16.00");
  expect(details.textContent).toContain("+ system $3.20");
  expect(within(details).queryByRole("button", { name: /Edit/ })).toBeNull();
  expect(within(details).queryByRole("button", { name: /Delete/ })).toBeNull();
  // No duplicate anywhere on the page.
  expect(screen.queryByText(/Duplicate/)).toBeNull();
});

test("a custom preset is created, edited and deleted from its drawer", async () => {
  harness = await flowHarness();
  await openPage();
  const user = userEvent.setup();
  const h = harness;

  // Make room first, so the new preset can go straight into the loadout.
  await user.click(screen.getByRole("button", { name: "Remove GPU from the loadout" }));
  await waitFor(async () => expect((await held(h)).loadout[3]).toBeNull());

  await user.click(screen.getAllByRole("button", { name: "+ New preset" })[0]!);
  const drawer = await screen.findByRole("dialog");
  await user.type(within(drawer).getByLabelText("Name"), "research");
  await user.click(within(drawer).getByRole("button", { name: /r8g\.2xlarge/ }));
  await user.click(
    within(within(drawer).getByRole("group", { name: "Data volume" })).getByRole("button", {
      name: /300 GiB/,
    }),
  );
  fireEvent.change(within(drawer).getByLabelText("System disk"), { target: { value: "60" } });
  await user.click(within(drawer).getByRole("checkbox"));
  await user.click(within(drawer).getByRole("button", { name: "Save preset" }));

  await waitFor(async () => {
    const now = await held(h);
    expect(now.custom).toEqual([
      { id: "research", name: "research", size: "large", volume_gib: 300, root_gib: 60 },
    ]);
    expect(now.loadout[3]).toBe("research");
  });
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(card("research").textContent).toContain("300 GiB data · 60 GiB system");

  // Edit: rename, keep the id.
  await user.click(screen.getByRole("button", { name: "Show details for research" }));
  await user.click(screen.getByRole("button", { name: "Edit research" }));
  const edit = await screen.findByRole("dialog");
  const name = within(edit).getByLabelText("Name");
  await user.clear(name);
  await user.type(name, "deep research");
  await user.click(within(edit).getByRole("button", { name: "Save preset" }));
  await waitFor(async () =>
    expect((await held(h)).custom[0]).toMatchObject({ id: "research", name: "deep research" }),
  );

  // Delete: gone from the library and from its slot.
  await user.click(await screen.findByRole("button", { name: "Delete deep research" }));
  await waitFor(async () => {
    const now = await held(h);
    expect(now.custom).toEqual([]);
    expect(now.loadout[3]).toBeNull();
  });
});

test("the create drawer offers the saved loadout and opens on its default", async () => {
  harness = await flowHarness();
  await dispatch(harness.ctx, "presets.set", {
    loadout: ["heavy", null, "gpu-m", "light"],
    default: "gpu-m",
  });
  mountPortal();
  const user = userEvent.setup();
  await user.click(await screen.findByRole("button", { name: /New agent/ }));

  const strip = await screen.findByRole("group", { name: "Machine preset" });
  await waitFor(() =>
    expect(
      within(strip)
        .getAllByRole("button")
        .map((b) => b.querySelector(".t")?.textContent),
    ).toEqual(["Heavy", "GPU M", "Light"]),
  );
  await waitFor(() =>
    expect(
      within(strip)
        .getByRole("button", { name: /^GPU M/ })
        .getAttribute("aria-pressed"),
    ).toBe("true"),
  );
});

test("Defaults points at Create presets, and the link lands there", async () => {
  harness = await flowHarness();
  gotoHash("#settings/defaults");
  mountPortal();
  const user = userEvent.setup();
  await user.click(await screen.findByRole("button", { name: "Create presets →" }));
  await screen.findByText("Loadout · 4 of 4");
  expect(window.location.hash).toBe("#settings/presets");
});
