/**
 * The two heads' creates, put through the same core and compared.
 *
 * §4.6 and §10 give the fleet a set of `defaults` a create inherits when the
 * operator states nothing, and `hermetic agent create <name>` states nothing:
 * the CLI drops every `undefined` before it validates, so core sees a request
 * carrying a name and fills size, data volume, root disk and secrets
 * from `_fleet.defaults`.
 *
 * The create drawer had the same obligation and did not meet it. It initialised
 * `medium`, 100 GiB, this build's root disk and no secrets, and put all four on
 * the wire whether or not anybody had looked at them — so a fleet configured
 * for micro, 50 GiB and Bitwarden got exactly that from
 * the CLI and none of it from the UI. Both packages' own suites stayed green,
 * because neither can see the other's answer: the drawer's tests assert the
 * body it sends, and core's assert what it does with a body it is given, and
 * nothing joined them. That is the shape of a seam (`seams.test.ts`).
 *
 * This file is at the root, so it may import core, the CLI and the UI at once,
 * which no package may do. It drives the CLI's real option mapping
 * (`createInputFrom`) and the UI's real request builder (`createRequestBody`)
 * — not copies of them — and hands both to the same in-memory `Hermetic`.
 *
 * Since §4.6's create presets, an untouched create from either head states the
 * machine from this laptop's default preset. The first block below is the
 * no-preset path (an empty loadout, or a CLI mapping handed no presets); the
 * last is the preset path.
 */
import { describe, expect, test } from "bun:test";
import { drain, freshFleet } from "../packages/core/test/helpers.ts";
import { CreateAgentInput } from "../packages/core/src/schema/requests.ts";
import type { Agent } from "../packages/core/src/schema/agent.ts";
import { createInputFrom } from "../packages/cli/src/commands/agent.ts";
import {
  createRequestBody,
  formDefaults,
  initialCreateForm,
} from "../packages/ui/src/logic/create-form.ts";
import type { CreateFormState } from "../packages/ui/src/logic/create-form.ts";
import { openingMachine } from "../packages/ui/src/logic/create-presets.ts";
import type { Meta, ProfileView } from "../packages/ui/src/api/index.ts";

/**
 * Deliberately none of this build's own constants: a fleet still sitting on
 * what `init` wrote cannot tell an inherited value from a hardcoded one, which
 * is precisely why the bug survived. Every field here differs from the UI's old
 * initial value.
 */
const FLEET_DEFAULTS = {
  size: "micro",
  volume_gib: 50,
  root_gib: 30,
  secrets: "bitwarden",
} as const;

/** The fields a create resolves from the fleet when the request omits them. */
function inherited(agent: Agent) {
  return {
    size: agent.size,
    instance_type: agent.instance_type,
    volume_gib: agent.volume_gib,
    root_gib: agent.root_gib,
    secrets_mode: agent.secrets_mode,
    provider: agent.provider,
    profile_id: agent.profile_id,
    profile_revision: agent.profile_revision,
    seed: agent.seed,
  };
}

/**
 * A fleet whose defaults are nothing like the build's, with both heads' idea of
 * an untouched create ready to run against it.
 */
async function fleetWithDefaults() {
  const { backend, hermetic } = freshFleet();
  await hermetic.settings.set({ defaults: { ...FLEET_DEFAULTS } });
  const settings = await hermetic.settings.get({});

  /*
   * `/api/meta` carries the settings document whole, so the drawer reads the
   * fleet's defaults off the same payload that boots the page. Shaping the
   * fragment the UI actually reads is what keeps this an assertion about the
   * wire rather than about a convenience object.
   */
  const meta = { settings } as unknown as Meta;
  const shown = formDefaults(meta);

  /*
   * The profile list the picker is handed, which is core's own — with the
   * fleet's default deliberately moved off the head of it. The seeded fixture
   * makes the default the first ready profile as well, and while those two are
   * the same id no test can tell "preselect the fleet's default" from
   * "preselect whatever is ready first" (§8.3 says only the first is allowed).
   */
  const profiles = [...(await hermetic.providers.list({})).profiles].sort(
    (a, b) => Number(a.is_default) - Number(b.is_default),
  ) as unknown as ProfileView[];

  /*
   * The drawer as it opens — built by the drawer's own seed function, not
   * described by this test.
   *
   * Writing the "untouched form" out by hand here asserted its own premise: it
   * said `touched: new Set()` and the fleet's default profile and would have
   * gone on saying so however `CreateDrawer` drifted. A control that touched
   * itself on mount, or a picker that fell back to the first ready profile,
   * changes what an untouched create sends and changed nothing in this file.
   * `initialCreateForm` is the function the drawer seeds every control from,
   * so a drift there fails here.
   */
  const seed = initialCreateForm({
    defaults: shown,
    draft: null,
    /*
     * §8.3: the picker preselects the fleet's *default* profile, and the
     * request names it. That is the one field the drawer states on purpose — an
     * operator who can see which credential is chosen is entitled to have that
     * one sent — and it resolves to what the CLI's omission resolves to. The
     * list deliberately offers a ready profile that is *not* the default, so a
     * seed that fell back to "the first ready one" is visible here.
     */
    profiles,
    default_profile: settings.settings.default_profile ?? null,
    volume: null,
  });
  const untouched: CreateFormState = {
    name: "ui-agent",
    ...seed,
    profile_model: "",
    profile_name: "",
    volume_id: null,
  };

  return { backend, hermetic, settings, shown, seed, profiles, untouched };
}

describe("untouched UI create matches CLI create under fleet defaults", () => {
  test("the drawer opens on the fleet's defaults, not on this build's", async () => {
    const { shown, seed } = await fleetWithDefaults();
    expect(shown).toEqual({ ...FLEET_DEFAULTS });
    // The drawer's real seed, field by field: the shown values, nothing chosen.
    expect(seed).toMatchObject({ ...FLEET_DEFAULTS, touched: new Set() });
  });

  test("the picker seeds the fleet's default profile, not the first ready one", async () => {
    const { seed, settings, profiles } = await fleetWithDefaults();
    const fleetDefault = settings.settings.default_profile ?? "";
    const firstReady = profiles.find((p) => p.ready);
    expect(firstReady?.id).not.toBe(fleetDefault);
    expect(seed.profile_id).toBe(fleetDefault);
  });

  test("an untouched form omits every field the fleet has a default for", async () => {
    const { untouched, settings } = await fleetWithDefaults();
    const body = createRequestBody(untouched);
    // The name, and the profile the picker shows. Nothing else: a value here
    // would be this drawer overriding a fleet default nobody asked it to.
    expect(Object.keys(body).sort()).toEqual(["name", "provider_profile"]);
    expect(body.provider_profile).toBe(settings.settings.default_profile ?? "");
    // And it is a request core's own schema accepts, not merely a plausible one.
    expect(CreateAgentInput.safeParse(body).success).toBe(true);
  });

  test("`hermetic agent create <name>` omits the same fields", async () => {
    // Commander sets no default for any of these flags, so an untouched
    // invocation parses to an empty options object.
    expect(Object.keys(createInputFrom("cli-agent", {})).sort()).toEqual(["name"]);
  });

  test("both produce the same agent", async () => {
    const { backend, hermetic, untouched } = await fleetWithDefaults();

    await drain(hermetic.agents.create(createInputFrom("cli-agent", {})));
    await drain(hermetic.agents.create(CreateAgentInput.parse(createRequestBody(untouched))));

    const cli = (await backend.store.agents.get("cli-agent"))!;
    const ui = (await backend.store.agents.get("ui-agent"))!;
    expect(inherited(ui)).toEqual(inherited(cli));

    // …and what they agree on is the fleet's answer, not a coincidence: a UI
    // that went back to stating its own values would still match a CLI that
    // had been broken the same way.
    expect(inherited(cli)).toMatchObject({
      size: FLEET_DEFAULTS.size,
      volume_gib: FLEET_DEFAULTS.volume_gib,
      root_gib: FLEET_DEFAULTS.root_gib,
      secrets_mode: FLEET_DEFAULTS.secrets,
    });
  });

  test("a field the operator did choose is stated, and wins over the fleet", async () => {
    const { backend, hermetic, untouched } = await fleetWithDefaults();
    const chosen: CreateFormState = {
      ...untouched,
      name: "chosen",
      size: "large",
      touched: new Set(["size"]),
    };
    const body = createRequestBody(chosen);
    expect(body.size).toBe("large");
    // Still absent: choosing a size says nothing about a data volume.
    expect(body.volume_gib).toBeUndefined();
    expect(body.root_gib).toBeUndefined();
    expect(body.secrets).toBeUndefined();

    await drain(hermetic.agents.create(CreateAgentInput.parse(body)));
    const agent = (await backend.store.agents.get("chosen"))!;
    expect(agent.size).toBe("large");
    expect(agent.volume_gib).toBe(FLEET_DEFAULTS.volume_gib);
    expect(agent.root_gib).toBe(FLEET_DEFAULTS.root_gib);
    expect(agent.secrets_mode).toBe(FLEET_DEFAULTS.secrets);
  });

  /**
   * The reclaim path (§6.2 step 6): `--volume` and `--volume-gib` are mutually
   * exclusive, so a drawer opened onto a volume must send the id and no size —
   * including when the operator never touched the (hidden) size control.
   */
  test("a reclaimed volume is sent as an id with no size beside it", async () => {
    const { untouched } = await fleetWithDefaults();
    const body = createRequestBody({ ...untouched, volume_id: "vol-0123456789abcdef0" });
    expect(body.volume_id).toBe("vol-0123456789abcdef0");
    expect(body.volume_gib).toBeUndefined();
    expect(CreateAgentInput.safeParse(body).success).toBe(true);
  });
});

/**
 * §4.6: this laptop's create presets. The drawer opens on the loadout's
 * default preset and states its machine; `hermetic agent create <name>` with
 * no machine flag resolves the same default preset. Both read the same
 * `presets.get`, so an untouched create from either head builds the same
 * machine — the preset's, not the fleet's `defaults` — while everything a
 * preset does not govern (secrets, profile) still inherits from the fleet.
 */
describe("untouched UI create matches CLI create under this laptop's presets", () => {
  type Fleet = Awaited<ReturnType<typeof fleetWithDefaults>>;
  type Presets = Awaited<ReturnType<Fleet["hermetic"]["presets"]["get"]>>;

  /** The drawer's real opening machine, built by its own function. */
  function opened(f: Fleet, presets: Presets) {
    const { size, volume_gib, root_gib, touched } = f.seed;
    return openingMachine(presets, { size, volume_gib, root_gib, touched }, false, false);
  }

  test("both open on the built-in default, Standard, and build its machine", async () => {
    const f = await fleetWithDefaults();
    const presets = await f.hermetic.presets.get({});
    const open = opened(f, presets);
    expect(open.preset).toBe("standard");

    const cliInput = createInputFrom("cli-agent", {}, presets);
    expect(cliInput).toMatchObject({ size: "medium", volume_gib: 100, root_gib: 40 });
    expect(cliInput.secrets).toBeUndefined();

    const form: CreateFormState = { ...f.untouched, ...open.machine };
    await drain(f.hermetic.agents.create(cliInput));
    await drain(f.hermetic.agents.create(CreateAgentInput.parse(createRequestBody(form))));
    const cli = (await f.backend.store.agents.get("cli-agent"))!;
    const ui = (await f.backend.store.agents.get("ui-agent"))!;
    expect(inherited(ui)).toEqual(inherited(cli));
    // The preset's machine, the fleet's secrets.
    expect(inherited(cli)).toMatchObject({
      size: "medium",
      volume_gib: 100,
      root_gib: 40,
      secrets_mode: FLEET_DEFAULTS.secrets,
    });
  });

  test("a laptop whose default is Heavy builds Heavy from both heads", async () => {
    const f = await fleetWithDefaults();
    await f.hermetic.presets.set({ default: "heavy" });
    const presets = await f.hermetic.presets.get({});
    const open = opened(f, presets);
    const body = createRequestBody({ ...f.untouched, ...open.machine });
    const cli = createInputFrom("cli-agent", {}, presets);
    expect(open.preset).toBe("heavy");
    expect({ size: body.size, volume_gib: body.volume_gib, root_gib: body.root_gib }).toEqual({
      size: cli.size,
      volume_gib: cli.volume_gib,
      root_gib: cli.root_gib,
    });
    expect(cli).toMatchObject({ size: "large", volume_gib: 200, root_gib: 40 });
  });

  test("`--preset` names one; a machine flag overrides just its field", async () => {
    const { hermetic } = await fleetWithDefaults();
    const presets = await hermetic.presets.get({});
    expect(createInputFrom("a", { preset: "light", rootGib: "60" }, presets)).toMatchObject({
      size: "small",
      volume_gib: 50,
      root_gib: 60,
    });
    // By name as well as id, ignoring case.
    expect(createInputFrom("a", { preset: "gpu m" }, presets).size).toBe("gpu-medium");
  });

  test("a machine flag without `--preset` means no preset at all", async () => {
    const { hermetic } = await fleetWithDefaults();
    const presets = await hermetic.presets.get({});
    const input = createInputFrom("a", { size: "large" }, presets);
    expect(input.size).toBe("large");
    // Left to the fleet, as before presets existed.
    expect(input.volume_gib).toBeUndefined();
    expect(input.root_gib).toBeUndefined();
  });

  test("`--volume` keeps the volume's own size: the preset never sets volume_gib", async () => {
    const { hermetic } = await fleetWithDefaults();
    const presets = await hermetic.presets.get({});
    const input = createInputFrom("a", { volume: "vol-0123456789abcdef0" }, presets);
    expect(input.volume_gib).toBeUndefined();
    expect(input).toMatchObject({ size: "medium", root_gib: 40 });
    const named = createInputFrom("a", { volume: "vol-0123456789abcdef0", preset: "heavy" }, presets);
    expect(named.volume_gib).toBeUndefined();
    expect(named.size).toBe("large");
  });

  test("an unknown preset is NOT_FOUND, and `--preset` needs presets to resolve against", async () => {
    const { hermetic } = await fleetWithDefaults();
    const presets = await hermetic.presets.get({});
    expect(() => createInputFrom("a", { preset: "nope" }, presets)).toThrow(/no create preset nope/);
    expect(() => createInputFrom("a", { preset: "heavy" })).toThrow(/--preset/);
  });

  test("an empty loadout leaves the machine to the fleet, as the drawer does", async () => {
    const f = await fleetWithDefaults();
    await f.hermetic.presets.set({ loadout: [null, null, null, null], default: null });
    const presets = await f.hermetic.presets.get({});
    expect(Object.keys(createInputFrom("a", {}, presets)).sort()).toEqual(["name"]);
    const open = opened(f, presets);
    expect(open.preset).toBeNull();
    expect(Object.keys(createRequestBody({ ...f.untouched, ...open.machine })).sort()).toEqual([
      "name",
      "provider_profile",
    ]);
  });
});
