/**
 * §8.3's create drawer: a profile is picked, a key is never typed.
 *
 * The things worth driving through the DOM are that the brain chooser offers
 * *only* ready profiles, that the POST carries `provider_profile` and nothing
 * resembling a credential, that the "Set up a provider" detour keeps the
 * half-typed form — which is what makes the call-to-action an offer rather than
 * a punishment — that the preset strip is this laptop's loadout (§4.6) and a
 * preset states its three machine fields, and that Customize's reset moves
 * exactly the field it names and nothing else.
 */
import { act, cleanup, fireEvent, render, screen, userEvent, waitFor, within } from "./dom.ts";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Meta, VolumeView } from "../src/api/index.ts";
import { CreateDrawer } from "../src/components/CreateDrawer.tsx";
import { fakeServer } from "./fake-transport.ts";
import type { FakeServer } from "./fake-transport.ts";
import { loadCreateDraft, saveCreateDraft } from "../src/logic/create-draft.ts";
import { presetsView } from "@hermetic/core/shared";
import { resetPresetsStore } from "../src/state/presets-store.ts";
import { createRequestBody, formDefaults, initialCreateForm } from "../src/logic/create-form.ts";
import { machineMonthlyUsd } from "../src/logic/create-presets.ts";
import { fmtUsd } from "../src/logic/format.ts";
import { FIXTURE_PROFILES, fixtureProfilesState, profilesState } from "./profiles-fixture.ts";
import { resetHash, withNav } from "./nav.tsx";

let server: FakeServer | null = null;

beforeEach(() => {
  window.sessionStorage.clear();
  resetHash();
  // The built-in loadout, nothing read: Light · Standard* · Heavy · GPU.
  resetPresetsStore();
});

/** A loadout with every slot emptied: the machine goes back to following the fleet. */
const NO_LOADOUT = presetsView({ loadout: [null, null, null, null], default: null, custom: [] });
afterEach(() => {
  cleanup();
  server?.restore();
  server = null;
});

const META = {
  config: { fleet_id: "m4in0abc", region: "us-west-2", account_alias: "acme" },
} as unknown as Meta;

const CATALOG_REPLY = {
  provider: "anthropic",
  models: [
    { id: "claude-sonnet-5", name: "Claude Sonnet 5" },
    { id: "claude-opus-5", name: "Claude Opus 5" },
  ],
  default_model: "claude-sonnet-5",
  fetched_at: "2026-09-14T00:00:00.000Z",
};

function drawer(over: Partial<Parameters<typeof CreateDrawer>[0]> = {}) {
  return withNav(
    <CreateDrawer
      meta={META}
      names={new Set(["lumen"])}
      latest="1.2.0"
      tailnet="acme.ts.net"
      active={null}
      profiles={fixtureProfilesState()}
      onStart={() => {}}
      onClose={() => {}}
      {...over}
    />,
  );
}

type User = ReturnType<typeof userEvent.setup>;

/** The brain row's trigger: its accessible name is `Brain · <profile> · <model>`. */
function brainButton(): HTMLButtonElement {
  return screen.getByRole("button", { name: /^Brain/ }) as HTMLButtonElement;
}

/** Opens the brain popover and returns it. */
async function openBrain(user: User): Promise<HTMLElement> {
  await user.click(brainButton());
  return screen.getByRole("dialog", { name: "Brain" });
}

/** The profile rows the popover offers. */
function profileRows(popover: HTMLElement): HTMLButtonElement[] {
  return within(within(popover).getByRole("group", { name: "Profiles" }))
    .getAllByRole("button")
    .filter((b) => b.hasAttribute("data-profile")) as HTMLButtonElement[];
}

/** Opens Customize (if it is not already) and returns a query scope over its body. */
async function openCustomize(user: User) {
  const toggle = screen.getByRole("button", { name: /Customize/ });
  if (toggle.getAttribute("aria-expanded") !== "true") await user.click(toggle);
  return within(document.getElementById("create-customize") as HTMLElement);
}

function preset(label: string): HTMLButtonElement {
  return within(screen.getByRole("group", { name: "Machine preset" })).getByRole("button", {
    name: new RegExp(`^${label}`),
  }) as HTMLButtonElement;
}

/**
 * `usePresets` re-reads on every mount regardless of what a test cares about
 * (`presets-store.ts`), and a handful of tests below never route
 * `presets.get` at all. Left unawaited, that read's settling — a rejection,
 * here — can land mid-test, in the gap between two other awaits, and update
 * `CreateDrawer` outside whatever `act()` scope RTL opened for the one that
 * was running. Called right after `render`, before anything else touches the
 * drawer, it drains that read deterministically instead of leaving it to race
 * a later `waitFor`.
 */
async function flushPending(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

describe("CreateDrawer · provider profile", () => {
  test("offers only ready profiles, preselects the fleet default, and has no key field", async () => {
    server = fakeServer({ "providers.models": CATALOG_REPLY });
    const user = userEvent.setup();
    render(drawer());

    // The row shows the fleet's *default* already chosen — not the first ready
    // one, which the fixture deliberately makes a different profile.
    expect(brainButton().getAttribute("aria-label")).toBe("Brain · anthropic-main · claude-sonnet-5");
    const popover = await openBrain(user);
    const rows = profileRows(popover);
    expect(rows.map((r) => r.dataset["profile"])).toEqual(["0pr0ut3r", "an7hr0p1", "b3dr0ck0"]);
    const pressed = rows.filter((r) => r.getAttribute("aria-pressed") === "true");
    expect(pressed.map((r) => r.dataset["profile"])).toEqual(["an7hr0p1"]);

    // No key anywhere on a fresh create (§8.3).
    expect(document.querySelector('input[type="password"]')).toBeNull();
    expect(screen.queryByText(/API key/)).toBeNull();

    // The catalog is read for the chosen profile, with no credential on the wire.
    await waitFor(() => expect(server?.to("providers.models")).toHaveLength(1));
    expect(server.to("providers.models")[0]?.params).toEqual({ profile: "an7hr0p1" });
  });

  test("the POST names the profile and carries no provider and no key", async () => {
    server = fakeServer({
      "providers.models": CATALOG_REPLY,
      "agents.create": { op_id: "op-1", op: { id: "op-1" } },
    });
    const user = userEvent.setup();
    render(drawer());

    await user.click(screen.getByRole("button", { name: "Create agent →" }));
    await waitFor(() => expect(server?.to("agents.create")).toHaveLength(1));

    const body = server.to("agents.create")[0]?.params as Record<string, unknown>;
    expect(body["provider_profile"]).toBe("an7hr0p1");
    expect(body["provider"]).toBeUndefined();
    expect(body["api_key"]).toBeUndefined();
    // The profile's own model is not re-sent: that is what the profile resolves to.
    expect(body["hermes"]).toBeUndefined();
  });

  test("a model moved off the profile's own is sent as a hermes override", async () => {
    server = fakeServer({
      "providers.models": CATALOG_REPLY,
      "agents.create": { op_id: "op-1", op: { id: "op-1" } },
    });
    const user = userEvent.setup();
    render(drawer());

    await openBrain(user);
    await waitFor(() => expect(screen.getByText("claude-opus-5")).toBeTruthy());
    await user.click(screen.getByText("claude-opus-5"));
    // The row now says so, and tags it as an override rather than the default.
    expect(brainButton().getAttribute("aria-label")).toBe("Brain · anthropic-main · claude-opus-5");
    expect(within(brainButton()).getByText("model override")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Done" }));
    await user.click(screen.getByRole("button", { name: "Create agent →" }));
    await waitFor(() => expect(server?.to("agents.create")).toHaveLength(1));

    const body = server.to("agents.create")[0]?.params as Record<string, unknown>;
    expect(body["hermes"]).toEqual({ model: "claude-opus-5" });
  });

  /**
   * §6.4's approvals mode. It is seeded rather than managed, so what the drawer
   * states is where the agent *starts* — and stating nothing is how the fleet's
   * own answer reaches it, which is why an untouched select sends no field.
   */
  test("an approvals mode the operator picked is sent; leaving it alone sends nothing", async () => {
    server = fakeServer({
      "providers.models": CATALOG_REPLY,
      "agents.create": { op_id: "op-1", op: { id: "op-1" } },
    });
    const user = userEvent.setup();
    render(drawer());

    await openCustomize(user);
    await user.selectOptions(selectFor("Approvals"), "manual");
    await user.click(screen.getByRole("button", { name: "Create agent →" }));
    await waitFor(() => expect(server?.to("agents.create")).toHaveLength(1));

    const body = server.to("agents.create")[0]?.params as Record<string, unknown>;
    expect(body["hermes"]).toEqual({ approvals_mode: "manual" });
  });

  /**
   * `hermes` is one key, so a form that states both settings must send one
   * object carrying both rather than whichever of the two was written last.
   */
  test("a model and an approvals mode arrive in the same hermes object", async () => {
    server = fakeServer({
      "providers.models": CATALOG_REPLY,
      "agents.create": { op_id: "op-1", op: { id: "op-1" } },
    });
    const user = userEvent.setup();
    render(drawer());

    await openBrain(user);
    await waitFor(() => expect(screen.getByText("claude-opus-5")).toBeTruthy());
    await user.click(screen.getByText("claude-opus-5"));
    await user.click(screen.getByRole("button", { name: "Done" }));
    await openCustomize(user);
    await user.selectOptions(selectFor("Approvals"), "smart");
    await user.click(screen.getByRole("button", { name: "Create agent →" }));
    await waitFor(() => expect(server?.to("agents.create")).toHaveLength(1));

    const body = server.to("agents.create")[0]?.params as Record<string, unknown>;
    expect(body["hermes"]).toEqual({ model: "claude-opus-5", approvals_mode: "smart" });
  });
});

describe("CreateDrawer · no ready profile", () => {
  const none = profilesState({ list: [] });

  test("offers the setup detour instead of a picker, and Create is refused", async () => {
    server = fakeServer({});
    render(drawer({ profiles: none }));
    await flushPending();

    expect(screen.getByRole("button", { name: "Set up a provider →" })).toBeTruthy();
    expect(screen.queryByText("Provider profile")).toBeNull();
    expect((screen.getByRole("button", { name: "Create agent →" }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    // No catalog is read: there is no profile to read one for. (The laptop's
    // presets are, since the strip is drawn from them.)
    expect(server.calls.filter((c) => c.name !== "presets.get")).toHaveLength(0);
  });

  test("the unfinished form survives the detour and comes back when the drawer reopens", async () => {
    server = fakeServer({ "providers.models": CATALOG_REPLY });
    const user = userEvent.setup();
    const view = render(drawer({ profiles: none }));

    const nameField = screen.getByPlaceholderText("e.g. corvid-2");
    await user.clear(nameField);
    await user.type(nameField, "corvid-2");
    await user.click(screen.getByRole("button", { name: "Set up a provider →" }));
    // The detour is a navigation: Settings, on Providers, is where it lands.
    expect(window.location.hash).toBe("#settings/providers");

    // The operator sets a profile up and comes back: `App` unmounts and
    // remounts the drawer, and the draft is what makes that survivable.
    view.unmount();
    render(drawer());
    expect((screen.getByPlaceholderText("e.g. corvid-2") as HTMLInputElement).value).toBe("corvid-2");
    // …and the readiness list is re-run, so the profile just created is offered.
    await waitFor(() => expect(server?.to("providers.models")).toHaveLength(1));
  });
});

/**
 * A fleet configured for none of this build's constants, so every control that
 * shows one — and every field that reaches the wire unasked — is visible.
 */
const FLEET_META = {
  config: { fleet_id: "m4in0abc", region: "us-west-2", account_alias: "acme" },
  settings: {
    settings: {
      defaults: {
        size: "micro",
        provider: "anthropic",
        volume_gib: 50,
        root_gib: 30,
        secrets: "bitwarden",
      },
    },
  },
} as unknown as Meta;

/**
 * The form's own fields. `target` is not one: `api.ts` stamps the fleet this
 * tab is bound to onto every mutation, and that binding is not a create option
 * anybody could have touched.
 */
function fields(body: Record<string, unknown>): string[] {
  return Object.keys(body)
    .filter((k) => k !== "target")
    .sort();
}

function selectFor(label: string): HTMLSelectElement {
  return screen.getByLabelText(label) as HTMLSelectElement;
}

/**
 * §4.6: the fleet's `defaults` are what a create inherits, and an untouched
 * drawer must inherit them rather than restate this build's own numbers.
 *
 * `tests/create-parity.test.ts` holds the resulting request against the CLI's;
 * this one is about the drawer itself — that the form *opens* on the fleet's
 * answer, and that clicking nothing sends nothing.
 *
 * Every test here runs with an empty loadout (§4.6): with no preset to offer,
 * the machine fields follow the fleet exactly as every other field does. With
 * a preset, they are the preset's — `CreateDrawer · the loadout` below.
 */
describe("CreateDrawer · fleet defaults", () => {
  beforeEach(() => resetPresetsStore(NO_LOADOUT));

  test("the form opens on the fleet's defaults, not on the build's", async () => {
    server = fakeServer({ "providers.models": CATALOG_REPLY });
    const user = userEvent.setup();
    render(drawer({ meta: FLEET_META }));

    // No strip to choose from, and the footer prices the fleet's own machine.
    expect(screen.queryByRole("group", { name: "Machine preset" })).toBeNull();
    expect(screen.getByText(/No presets in this laptop/)).toBeTruthy();
    const total = fmtUsd(machineMonthlyUsd({ size: "micro", volume_gib: 50, root_gib: 30 }));
    expect(screen.getByTestId("create-total").textContent).toBe(`≈${total}/mo`);

    const c = await openCustomize(user);
    // `micro` is not one of the three primary cells, so the drawer opens with
    // "More sizes" already expanded — a pressed cell nobody can see is the same
    // as no pressed cell.
    const micro = c.getByRole("button", { name: /t4g\.micro/ });
    expect(micro.getAttribute("aria-pressed")).toBe("true");

    // 50 GiB is one of the canonical cells; a fleet default that was not would
    // be unioned in rather than dropped.
    const volume = c.getByRole("group", { name: "Data volume" });
    const pressed = within(volume)
      .getAllByRole("button")
      .filter((b) => b.getAttribute("aria-pressed") === "true");
    expect(pressed.map((b) => b.textContent)).toEqual(["50 GiB$4/mo"]);

    expect((screen.getByLabelText("System disk") as HTMLInputElement).value).toBe("30");
    expect(selectFor("Secrets").value).toBe("bitwarden");
  });

  /**
   * The seam (`tests/create-parity.test.ts`) proves that a request built from
   * `initialCreateForm` inherits the fleet's defaults the way the CLI does.
   * That is only worth anything if the *mounted drawer* really sends what that
   * function describes — the seam cannot see React, and this test is the join:
   * the same builder, the same fleet, against the real form's POST.
   */
  test("the mounted drawer posts exactly what the seam's seed describes", async () => {
    server = fakeServer({
      "providers.models": CATALOG_REPLY,
      "agents.create": { op_id: "op-1", op: { id: "op-1" } },
    });
    const user = userEvent.setup();
    render(drawer({ meta: FLEET_META }));

    // The name is rolled at random, so it is read off the form rather than assumed.
    const name = (screen.getByPlaceholderText("e.g. corvid-2") as HTMLInputElement).value;
    const expected = createRequestBody({
      ...initialCreateForm({
        defaults: formDefaults(FLEET_META),
        draft: null,
        profiles: FIXTURE_PROFILES,
        default_profile: "an7hr0p1",
        volume: null,
      }),
      name,
      profile_model: "",
      profile_name: "",
      volume_id: null,
    });

    await user.click(screen.getByRole("button", { name: "Create agent →" }));
    await waitFor(() => expect(server?.to("agents.create")).toHaveLength(1));

    const body = server.to("agents.create")[0]?.params as Record<string, unknown>;
    const { target: _target, ...sent } = body;
    expect(sent).toEqual(expected as unknown as Record<string, unknown>);
  });

  test("an untouched form posts a name and a profile and nothing else", async () => {
    server = fakeServer({
      "providers.models": CATALOG_REPLY,
      "agents.create": { op_id: "op-1", op: { id: "op-1" } },
    });
    const user = userEvent.setup();
    render(drawer({ meta: FLEET_META }));

    await user.click(screen.getByRole("button", { name: "Create agent →" }));
    await waitFor(() => expect(server?.to("agents.create")).toHaveLength(1));

    const body = server.to("agents.create")[0]?.params as Record<string, unknown>;
    // Every one of these used to be on the wire unasked, and every one of them
    // disagreed with this fleet.
    expect(fields(body)).toEqual(["name", "provider_profile"]);
  });

  test("a control the operator moved is stated; its neighbours are not", async () => {
    server = fakeServer({
      "providers.models": CATALOG_REPLY,
      "agents.create": { op_id: "op-1", op: { id: "op-1" } },
    });
    const user = userEvent.setup();
    render(drawer({ meta: FLEET_META }));

    const c = await openCustomize(user);
    await user.click(c.getByRole("button", { name: /t4g\.2xlarge/ }));
    await user.click(screen.getByRole("button", { name: "Create agent →" }));
    await waitFor(() => expect(server?.to("agents.create")).toHaveLength(1));

    const body = server.to("agents.create")[0]?.params as Record<string, unknown>;
    expect(body["size"]).toBe("medium");
    expect(fields(body)).toEqual(["name", "provider_profile", "size"]);
  });

  test("choosing the value already shown still counts as choosing it", async () => {
    server = fakeServer({
      "providers.models": CATALOG_REPLY,
      "agents.create": { op_id: "op-1", op: { id: "op-1" } },
    });
    const user = userEvent.setup();
    render(drawer({ meta: FLEET_META }));

    // Clicking `micro`, which the form is already showing, changes no value —
    // but it is an operator saying "micro", and a later `settings set` must not
    // move this agent off it. `touched` is intent, not difference.
    const c = await openCustomize(user);
    await user.click(c.getByRole("button", { name: /t4g\.micro/ }));
    await user.click(screen.getByRole("button", { name: "Create agent →" }));
    await waitFor(() => expect(server?.to("agents.create")).toHaveLength(1));

    const body = server.to("agents.create")[0]?.params as Record<string, unknown>;
    expect(body["size"]).toBe("micro");
  });

  /**
   * A settings read that failed, or a server too old to report one, leaves the
   * drawer with no fleet answer at all. The request is right either way — it
   * omits every untouched field — but the *form* used to show this build's
   * constants as though the fleet had said them, priced them, and then create a
   * different agent. Shown and sent must not disagree, so the untouched
   * controls say "fleet default" and price nothing.
   */
  test("unreadable defaults are shown as inherited, not as this build's constants", async () => {
    server = fakeServer({
      "providers.models": CATALOG_REPLY,
      "agents.create": { op_id: "op-1", op: { id: "op-1" } },
    });
    const user = userEvent.setup();
    render(drawer());

    // The footer does not price a machine nobody described.
    expect(screen.getByTestId("create-total").textContent).toBe("fleet default");

    const c = await openCustomize(user);
    // No size cell claims to be the fleet's, and no volume cell does either.
    const pressedIn = (group: string) =>
      within(c.getByRole("group", { name: group }))
        .getAllByRole("button")
        .filter((b) => b.getAttribute("aria-pressed") === "true");
    expect(pressedIn("Size")).toHaveLength(0);
    expect(pressedIn("Data volume")).toHaveLength(0);
    // The select offers "fleet default" and is showing it.
    expect(selectFor("Secrets").value).toBe("fleet default");
    // The root disk's readout is the phrase, not "20 GiB · $1.60/mo".
    expect((screen.getByLabelText("System disk") as HTMLElement).getAttribute("aria-valuetext")).toBe(
      "fleet default",
    );
    // …and nothing on the form prices a number nobody chose.
    expect(screen.queryByText(/\/mo for/)).toBeNull();

    await user.click(screen.getByRole("button", { name: "Create agent →" }));
    await waitFor(() => expect(server?.to("agents.create")).toHaveLength(1));

    const body = server.to("agents.create")[0]?.params as Record<string, unknown>;
    expect(fields(body)).toEqual(["name", "provider_profile"]);
  });

  test("choosing a field with defaults unknown states it and stops inheriting it", async () => {
    server = fakeServer({
      "providers.models": CATALOG_REPLY,
      "agents.create": { op_id: "op-1", op: { id: "op-1" } },
    });
    const user = userEvent.setup();
    render(drawer());

    const c = await openCustomize(user);
    await user.click(c.getByRole("button", { name: /r8g\.large/ }));
    // Now there is a value to show, because the operator supplied it.
    expect(c.getByRole("button", { name: /r8g\.large/ }).getAttribute("aria-pressed")).toBe("true");
    await user.click(screen.getByRole("button", { name: "Create agent →" }));
    await waitFor(() => expect(server?.to("agents.create")).toHaveLength(1));
    const body = server.to("agents.create")[0]?.params as Record<string, unknown>;
    expect(fields(body)).toEqual(["name", "provider_profile", "size"]);
    expect(body["size"]).toBe("small");
  });

  /**
   * The controls are `useState` initializers, so the first render's defaults
   * used to be the only ones they ever saw. A drawer opened before `meta.get`
   * answered, or left open while somebody edited the fleet's defaults, then
   * showed one set of values and created another.
   */
  test("settings arriving under an open drawer re-seed the untouched controls", async () => {
    server = fakeServer({ "providers.models": CATALOG_REPLY });
    const user = userEvent.setup();
    const view = render(drawer());

    // Touched before the settings land: this one is the operator's and must survive.
    const c = await openCustomize(user);
    await user.click(c.getByRole("button", { name: /r8g\.large/ }));

    view.rerender(drawer({ meta: FLEET_META }));

    await waitFor(() => expect(selectFor("Secrets").value).toBe("bitwarden"));
    expect((screen.getByLabelText("System disk") as HTMLInputElement).value).toBe("30");
    // The chosen size is not retracted by the fleet's answer arriving.
    expect(c.getByRole("button", { name: /r8g\.large/ }).getAttribute("aria-pressed")).toBe("true");
  });
});

/**
 * §8.3's dead draft: the form survives a detour through Settings, and Settings
 * is exactly where the profile it named gets deleted, disabled, or has its key
 * pulled. A restored `profile_id` is therefore a *claim* about a list this
 * drawer has not re-read, and submitting it produces `NOT_FOUND` from core —
 * after the operator has pressed Create.
 */
describe("CreateDrawer · a draft whose profile no longer holds", () => {
  const FLEET = "m4in0abc";

  function draft(profile_id: string) {
    saveCreateDraft(FLEET, {
      name: "corvid-2",
      size: "medium",
      volume: 100,
      root_gib: 20,
      profile_id,
      model: "",
      approvals_mode: "",
      secrets: "none",
      rollback: false,
      volume_id: null,
      touched: [],
    });
  }

  /** The profile the brain row names, or `null` when it is asking for one. */
  function chosenProfile(): string | null {
    const label = brainButton().getAttribute("aria-label") ?? "";
    return label === "Brain · choose a profile" ? null : (label.split(" · ")[1] ?? null);
  }

  /**
   * A draft stores every control's value, and only the `touched` ones are
   * statements of intent. Replaying the rest showed the operator the default
   * that was current when the draft was written, while the request — which
   * omits them — created whatever the fleet says now.
   */
  test("a restored draft re-seeds its untouched fields from the fleet's current defaults", async () => {
    server = fakeServer({
      "providers.models": CATALOG_REPLY,
      "agents.create": { op_id: "op-1", op: { id: "op-1" } },
    });
    const user = userEvent.setup();
    // Written against a fleet that then changed: medium / 100 / 20 / on / none,
    // with only the root disk chosen.
    saveCreateDraft(FLEET, {
      name: "corvid-2",
      size: "medium",
      volume: 100,
      root_gib: 20,
      profile_id: "an7hr0p1",
      model: "",
      approvals_mode: "",
      secrets: "none",
      rollback: false,
      volume_id: null,
      touched: ["root_gib"],
    });
    render(drawer({ meta: FLEET_META }));
    await flushPending();

    // A draft that chose something opens Customize, so the choice is visible.
    expect(screen.getByRole("button", { name: /Customize/ }).getAttribute("aria-expanded")).toBe(
      "true",
    );
    const c = await openCustomize(user);
    // Chosen, so it comes back from the draft…
    expect((screen.getByLabelText("System disk") as HTMLInputElement).value).toBe("20");
    // …and everything else is the fleet's answer as it stands now.
    expect(c.getByRole("button", { name: /t4g\.micro/ }).getAttribute("aria-pressed")).toBe("true");
    expect(selectFor("Secrets").value).toBe("bitwarden");

    await user.click(screen.getByRole("button", { name: "Create agent →" }));
    await waitFor(() => expect(server?.to("agents.create")).toHaveLength(1));
    const body = server.to("agents.create")[0]?.params as Record<string, unknown>;
    // Shown and sent agree: the one chosen field, and nothing the draft merely
    // happened to be holding.
    expect(body["root_gib"]).toBe(20);
    expect(body["size"]).toBeUndefined();
    expect(body["secrets"]).toBeUndefined();
  });

  test("re-reads the profile list when it opens", async () => {
    server = fakeServer({ "providers.models": CATALOG_REPLY });
    let reads = 0;
    render(drawer({ profiles: fixtureProfilesState({ refresh: () => (reads += 1) }) }));
    // The list is not polled, so this one read is the whole defence against a
    // profile somebody deleted in another terminal.
    expect(reads).toBe(1);
    // The preselected profile's catalog is still read; awaited so the drawer is
    // settled before this test's DOM goes away.
    await waitFor(() => expect(server?.to("providers.models")).toHaveLength(1));
  });

  test("a profile that has been deleted is dropped, and Create is refused", async () => {
    server = fakeServer({ "providers.models": CATALOG_REPLY });
    draft("gh0st000");
    render(drawer());
    await flushPending();

    // Everything else typed survives; only the dead selection does not.
    expect((screen.getByPlaceholderText("e.g. corvid-2") as HTMLInputElement).value).toBe("corvid-2");
    expect(chosenProfile()).toBeNull();
    expect(screen.getByText(/needs a profile chosen/)).toBeTruthy();
    expect((screen.getByRole("button", { name: "Create agent →" }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    // …and nothing is read for a profile that does not exist.
    expect(server.to("providers.models")).toHaveLength(0);
  });

  test("a profile that is still listed but no longer ready is dropped too", async () => {
    server = fakeServer({ "providers.models": CATALOG_REPLY });
    // `nous-lab` is in the list and holds a placeholder key: present, unusable.
    draft("n0us1ab0");
    render(drawer());
    await flushPending();

    expect(chosenProfile()).toBeNull();
    expect((screen.getByRole("button", { name: "Create agent →" }) as HTMLButtonElement).disabled).toBe(
      true,
    );
  });

  test("a draft restored onto a fleet with nothing ready left gets the setup state, not a create", async () => {
    server = fakeServer({});
    draft("an7hr0p1");
    render(drawer({ profiles: profilesState({ list: [] }) }));
    await flushPending();

    expect(screen.getByRole("button", { name: "Set up a provider →" })).toBeTruthy();
    expect((screen.getByRole("button", { name: "Create agent →" }) as HTMLButtonElement).disabled).toBe(
      true,
    );
  });

  test("a draft whose profile is still ready is restored intact and may be created", async () => {
    server = fakeServer({
      "providers.models": CATALOG_REPLY,
      "agents.create": { op_id: "op-1", op: { id: "op-1" } },
    });
    const user = userEvent.setup();
    draft("0pr0ut3r");
    render(drawer({ profiles: fixtureProfilesState({ list: FIXTURE_PROFILES }) }));

    expect(chosenProfile()).toBe("openrouter-cheap");
    await waitFor(() => expect(server?.to("providers.models")).toHaveLength(1));
    await user.click(screen.getByRole("button", { name: "Create agent →" }));
    await waitFor(() => expect(server?.to("agents.create")).toHaveLength(1));
    const body = server.to("agents.create")[0]?.params as Record<string, unknown>;
    expect(body["provider_profile"]).toBe("0pr0ut3r");
  });
});

/**
 * The preset strip and Customize's tags. A preset is a shorthand for three
 * field choices, so it must state exactly those three — Standard included,
 * which is a real bundle now (medium · 100 GiB · 40 GiB) rather than "the
 * fleet's defaults". A machine field's reset goes back to the preset's value;
 * every other field's reset goes back to inheriting from the fleet.
 */
describe("CreateDrawer · presets and reset", () => {
  function accept() {
    return fakeServer({
      "providers.models": CATALOG_REPLY,
      "agents.create": { op_id: "op-1", op: { id: "op-1" } },
    });
  }
  async function posted(user: User): Promise<Record<string, unknown>> {
    await user.click(screen.getByRole("button", { name: "Create agent →" }));
    await waitFor(() => expect(server?.to("agents.create")).toHaveLength(1));
    return server?.to("agents.create")[0]?.params as Record<string, unknown>;
  }

  test("an untouched drawer opens on the default preset and states its machine", async () => {
    server = accept();
    const user = userEvent.setup();
    render(drawer({ meta: FLEET_META }));

    expect(preset("Standard").getAttribute("aria-pressed")).toBe("true");
    const standard = fmtUsd(machineMonthlyUsd({ size: "medium", volume_gib: 100, root_gib: 40 }));
    expect(screen.getByTestId("create-total").textContent).toBe(`≈${standard}/mo`);

    const body = await posted(user);
    // The machine is the preset's, stated; secrets still follow the fleet.
    expect(fields(body)).toEqual(["name", "provider_profile", "root_gib", "size", "volume_gib"]);
    expect(body).toMatchObject({ size: "medium", volume_gib: 100, root_gib: 40 });
  });

  test("a preset states its size, data volume and system disk, and nothing else", async () => {
    server = accept();
    const user = userEvent.setup();
    render(drawer({ meta: FLEET_META }));

    // Priced as the whole machine, not the instance alone.
    const heavy = fmtUsd(machineMonthlyUsd({ size: "large", volume_gib: 200, root_gib: 40 }));
    expect(preset("Heavy").textContent).toContain(`${heavy}/mo`);

    await user.click(preset("Heavy"));
    expect(preset("Heavy").getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByTestId("create-total").textContent).toBe(`≈${heavy}/mo`);

    const body = await posted(user);
    expect(fields(body)).toEqual(["name", "provider_profile", "root_gib", "size", "volume_gib"]);
    expect(body).toMatchObject({ size: "large", volume_gib: 200, root_gib: 40 });
  });

  test("machine fields read `from preset`; the rest still read `fleet default`", async () => {
    server = accept();
    const user = userEvent.setup();
    render(drawer({ meta: FLEET_META }));

    expect(screen.getByRole("button", { name: /Customize/ }).textContent).toContain("Customize");
    expect(screen.getByText("from Standard")).toBeTruthy();
    const c = await openCustomize(user);
    expect(c.getAllByText("from preset")).toHaveLength(3);
    expect(c.getAllByText("fleet default").length).toBeGreaterThanOrEqual(3);
    expect(c.queryByText(/changed/)).toBeNull();
  });

  test("a Customize edit off the selected preset shows as a change on it", async () => {
    server = accept();
    const user = userEvent.setup();
    render(drawer({ meta: FLEET_META }));

    await user.click(preset("Light"));
    expect(within(preset("Light")).queryByText(/change/)).toBeNull();
    await openCustomize(user);
    fireEvent.change(screen.getByLabelText("System disk"), { target: { value: "64" } });
    expect(within(preset("Light")).getByText("+ 1 change")).toBeTruthy();

    const body = await posted(user);
    expect(body).toMatchObject({ size: "small", volume_gib: 50, root_gib: 64 });
  });

  test("reset takes a machine field back to the preset's value, still stated", async () => {
    server = accept();
    const user = userEvent.setup();
    render(drawer({ meta: FLEET_META }));

    const c = await openCustomize(user);
    await user.click(c.getByRole("button", { name: /r8g\.large/ }));
    await user.selectOptions(selectFor("Secrets"), "none");
    // Standard, with two fields stated: only the machine one counts as a change to it.
    expect(within(preset("Standard")).getByText("+ 1 change")).toBeTruthy();

    await user.click(c.getByRole("button", { name: "Reset Size" }));
    expect(c.getByRole("button", { name: /t4g\.2xlarge/ }).getAttribute("aria-pressed")).toBe("true");
    expect(within(preset("Standard")).queryByText(/change/)).toBeNull();

    const body = await posted(user);
    expect(fields(body)).toEqual([
      "name",
      "provider_profile",
      "root_gib",
      "secrets",
      "size",
      "volume_gib",
    ]);
    expect(body["size"]).toBe("medium");
  });

  test("reset on a fleet field untouches it", async () => {
    server = accept();
    const user = userEvent.setup();
    render(drawer({ meta: FLEET_META }));

    await openCustomize(user);
    await user.selectOptions(selectFor("Secrets"), "none");
    await user.click(screen.getByRole("button", { name: "Reset Secrets" }));
    expect(selectFor("Secrets").value).toBe("bitwarden");
    expect(fields(await posted(user))).not.toContain("secrets");
  });

  test("reset all puts the machine back on the preset and everything else on the fleet", async () => {
    server = accept();
    const user = userEvent.setup();
    render(drawer({ meta: FLEET_META }));

    await user.click(preset("Heavy"));
    await openCustomize(user);
    fireEvent.change(screen.getByLabelText("System disk"), { target: { value: "90" } });
    await user.selectOptions(selectFor("Approvals"), "manual");
    await user.selectOptions(selectFor("On failure"), "roll back");
    await user.click(screen.getByRole("button", { name: "Reset all" }));

    expect(preset("Heavy").getAttribute("aria-pressed")).toBe("true");
    const body = await posted(user);
    expect(fields(body)).toEqual(["name", "provider_profile", "root_gib", "size", "volume_gib"]);
    expect(body).toMatchObject({ size: "large", volume_gib: 200, root_gib: 40 });
  });

  test("on an existing volume a preset never touches the volume", async () => {
    server = accept();
    const user = userEvent.setup();
    const volume = {
      volume_id: "vol-0abc",
      size_gib: 75,
      availability_zone: "us-west-2a",
      agent: "cinder",
      snapshots: 2,
    } as unknown as VolumeView;
    render(drawer({ meta: FLEET_META, onVolume: volume }));

    // Priced with the volume's own size, which no preset can change.
    const heavy = fmtUsd(machineMonthlyUsd({ size: "large", volume_gib: 75, root_gib: 40 }));
    expect(preset("Heavy").textContent).toContain(`${heavy}/mo`);
    await user.click(preset("Heavy"));
    // …and Customize has no data-volume control to offer.
    const c = await openCustomize(user);
    expect(c.queryByRole("group", { name: "Data volume" })).toBeNull();

    const body = await posted(user);
    expect(body["volume_id"]).toBe("vol-0abc");
    expect(body["volume_gib"]).toBeUndefined();
    expect(body).toMatchObject({ size: "large", root_gib: 40 });
  });
});

/**
 * §4.6: the strip is this laptop's loadout — its order, its default, its
 * custom presets — and "Edit presets →" is a detour that keeps the form.
 */
describe("CreateDrawer · the loadout", () => {
  const RESEARCH = { id: "research", name: "research", size: "large", volume_gib: 300, root_gib: 60 };
  const ODD = { id: "odd", name: "odd", size: "quantum-9", volume_gib: 50, root_gib: 20 };

  function accept(extra: Record<string, unknown> = {}) {
    return fakeServer({
      "providers.models": CATALOG_REPLY,
      "agents.create": { op_id: "op-1", op: { id: "op-1" } },
      ...extra,
    });
  }

  test("draws the loadout's filled slots in order and opens on its default", async () => {
    resetPresetsStore(
      presetsView({ loadout: ["research", null, "gpu", "micro"], default: "gpu", custom: [RESEARCH] }),
    );
    server = accept();
    const user = userEvent.setup();
    render(drawer({ meta: FLEET_META }));

    const cells = within(screen.getByRole("group", { name: "Machine preset" })).getAllByRole("button");
    expect(cells.map((b) => b.querySelector(".t")?.textContent)).toEqual(["research", "GPU", "Micro"]);
    expect(preset("GPU").getAttribute("aria-pressed")).toBe("true");

    await user.click(preset("research"));
    await user.click(screen.getByRole("button", { name: "Create agent →" }));
    await waitFor(() => expect(server?.to("agents.create")).toHaveLength(1));
    expect(server.to("agents.create")[0]?.params).toMatchObject({
      size: "large",
      volume_gib: 300,
      root_gib: 60,
    });
  });

  test("a loadout read that lands after opening re-opens the form on its default", async () => {
    server = accept({
      "presets.get": presetsView({
        loadout: ["heavy", "light", null, null],
        default: "light",
        custom: [],
      }),
    });
    render(drawer({ meta: FLEET_META }));
    await waitFor(() => expect(preset("Light").getAttribute("aria-pressed")).toBe("true"));
    expect(screen.queryByRole("button", { name: /^Standard/ })).toBeNull();
  });

  test("…but never after the operator chose a machine", async () => {
    let answer: (v: unknown) => void = () => {};
    const pending = new Promise((r) => {
      answer = r;
    });
    server = accept({ "presets.get": () => pending });
    const user = userEvent.setup();
    render(drawer({ meta: FLEET_META }));
    await user.click(preset("Heavy"));
    answer(presetsView({ loadout: ["heavy", "light", null, null], default: "light", custom: [] }));
    await waitFor(() => expect(server?.to("presets.get").length).toBeGreaterThan(0));
    await new Promise((r) => setTimeout(r, 0));
    expect(preset("Heavy").getAttribute("aria-pressed")).toBe("true");
  });

  test("a custom preset naming a size this build does not know is offered but disabled", async () => {
    resetPresetsStore(
      presetsView({ loadout: ["standard", "odd", null, null], default: "standard", custom: [ODD] }),
    );
    server = accept();
    render(drawer({ meta: FLEET_META }));
    await flushPending();
    expect(preset("odd").disabled).toBe(true);
    expect(preset("odd").textContent).toContain("unknown size");
  });

  test("Edit presets keeps the form, preset included, and opens Settings › Create presets", async () => {
    server = accept();
    const user = userEvent.setup();
    render(drawer({ meta: FLEET_META }));

    await user.click(preset("Heavy"));
    await user.click(screen.getByRole("button", { name: "Edit presets →" }));
    expect(window.location.hash).toBe("#settings/presets");
    const kept = loadCreateDraft("m4in0abc", null);
    expect(kept?.preset).toBe("heavy");
    expect(kept?.size).toBe("large");
  });
});
