/**
 * What the create drawer opens on (§4.6, §10), as a pure function.
 *
 * Two rules, and they are the same rule seen twice: a value is the operator's
 * only when they chose it, and the fleet's the rest of the time. So a restored
 * draft speaks for the fields its `touched` set names and for nothing else, and
 * a default the portal could not read is reported as unreadable rather than
 * replaced by this build's constant and drawn as the fleet's answer.
 */
import { describe, expect, test } from "bun:test";
import {
  BUILD_FORM_DEFAULTS,
  createCliLine,
  createRequestBody,
  formDefaults,
  initialCreateForm,
  resolveDefaults,
} from "../src/logic/create-form.ts";
import type { CreateDraftSeed, CreateFormState, FormDefaults } from "../src/logic/create-form.ts";
import type { Meta } from "../src/api/index.ts";
import { FIXTURE_PROFILES } from "./profiles-fixture.ts";

/** Nothing like the build's constants, so an inherited value is visible as one. */
const FLEET: FormDefaults = {
  size: "micro",
  volume_gib: 50,
  root_gib: 30,
  secrets: "bitwarden",
};

function meta(defaults: Record<string, unknown> | null): Meta {
  return (defaults === null ? {} : { settings: { settings: { defaults } } }) as unknown as Meta;
}

function draft(over: Partial<CreateDraftSeed> = {}): CreateDraftSeed {
  return {
    size: "large",
    volume: 200,
    root_gib: 20,
    secrets: "none",
    rollback: false,
    profile_id: "",
    model: "",
    approvals_mode: "",
    touched: [],
    ...over,
  };
}

function seed(over: Partial<Parameters<typeof initialCreateForm>[0]> = {}) {
  return initialCreateForm({
    defaults: FLEET,
    draft: null,
    profiles: FIXTURE_PROFILES,
    default_profile: "an7hr0p1",
    volume: null,
    ...over,
  });
}

describe("resolveDefaults", () => {
  test("a fleet that reported its defaults owns every one of them", () => {
    const resolved = resolveDefaults(meta({ ...FLEET }));
    expect(resolved.values).toEqual(FLEET);
    expect(resolved.from_fleet).toEqual({
      size: true,
      volume_gib: true,
      root_gib: true,
      secrets: true,
    });
  });

  test("no settings at all owns none of them, and still renders something", () => {
    const resolved = resolveDefaults(meta(null));
    // The values are the build's, which is what a picker needs to draw at all —
    // and `from_fleet` is what stops the drawer presenting them as the fleet's.
    expect(resolved.values).toEqual(BUILD_FORM_DEFAULTS);
    expect(Object.values(resolved.from_fleet).every((v) => v === false)).toBe(true);
  });

  test("an unreadable field falls back alone, and says which one did", () => {
    // A size this build does not know, from a newer one; everything else stands.
    const resolved = resolveDefaults(meta({ ...FLEET, size: "gargantuan", volume_gib: 0 }));
    expect(resolved.values.size).toBe(BUILD_FORM_DEFAULTS.size);
    expect(resolved.values.volume_gib).toBe(BUILD_FORM_DEFAULTS.volume_gib);
    expect(resolved.values.root_gib).toBe(FLEET.root_gib);
    expect(resolved.from_fleet).toMatchObject({ size: false, volume_gib: false, root_gib: true });
  });

  test("formDefaults is the values half, unchanged", () => {
    expect(formDefaults(meta({ ...FLEET }))).toEqual(resolveDefaults(meta({ ...FLEET })).values);
  });
});

describe("initialCreateForm", () => {
  test("a fresh drawer opens on the fleet, chosen nothing", () => {
    expect(seed()).toEqual({
      size: "micro",
      volume_gib: 50,
      root_gib: 30,
      secrets: "bitwarden",
      rollback: false,
      profile_id: "an7hr0p1",
      model: "",
      // Unstated: the fleet's approvals mode is inherited by the request
      // omitting the key, so there is nothing for a fresh drawer to open on.
      approvals_mode: "",
      touched: new Set(),
    });
  });

  test("the picker takes the fleet's default, not the first ready profile", () => {
    // The fixture's first ready profile is a different one on purpose.
    expect(FIXTURE_PROFILES.filter((p) => p.ready)[0]?.id).not.toBe("an7hr0p1");
    expect(seed().profile_id).toBe("an7hr0p1");
    // A default that is not ready leaves the picker empty rather than falling
    // through to whoever is first (§8.3).
    expect(seed({ default_profile: "n0us1ab0" }).profile_id).toBe("");
    expect(seed({ default_profile: null }).profile_id).toBe("");
  });

  /**
   * The bug this closes: a draft stores every control's value, but only the
   * `touched` ones are statements about intent. Replaying the rest showed the
   * operator the default that was current when the draft was written, while the
   * request — which omits them — created whatever the fleet says now.
   */
  test("a restored draft speaks only for the fields it says were chosen", () => {
    const restored = seed({ draft: draft({ touched: ["size"] }) });
    expect(restored.size).toBe("large");
    expect(restored.touched).toEqual(new Set(["size"]));
    // Everything else is re-seeded from the fleet, not replayed from the draft.
    expect(restored.volume_gib).toBe(FLEET.volume_gib);
    expect(restored.root_gib).toBe(FLEET.root_gib);
    expect(restored.secrets).toBe(FLEET.secrets);
  });

  test("a draft that chose everything keeps everything", () => {
    const restored = seed({
      draft: draft({
        touched: ["size", "volume_gib", "root_gib", "secrets"],
        rollback: true,
        profile_id: "0pr0ut3r",
        model: "claude-opus-5",
      }),
    });
    expect(restored).toMatchObject({
      size: "large",
      volume_gib: 200,
      root_gib: 20,
      secrets: "none",
      rollback: true,
      profile_id: "0pr0ut3r",
      model: "claude-opus-5",
    });
  });

  /**
   * The approvals mode is restored like `model` and unlike everything in
   * `CREATE_FIELDS`: it has no fleet value to re-seed from — the fleet's answer
   * arrives by the request omitting the key — so `""` already says "chose
   * nothing" and there is no ambiguity for `touched` to settle. Dropping it on
   * the way back was the drawer silently un-choosing something somebody chose.
   */
  test("a mode chosen before the Settings detour comes back with the form", () => {
    expect(seed({ draft: draft({ approvals_mode: "manual" }) }).approvals_mode).toBe("manual");
    // And nothing is invented for a draft that chose none.
    expect(seed({ draft: draft() }).approvals_mode).toBe("");
  });

  test("a size this build does not render is not restored into a picker that cannot show it", () => {
    const restored = seed({ draft: draft({ size: "gargantuan", touched: ["size"] }) });
    expect(restored.size).toBe(FLEET.size);
  });

  test("a reclaimed volume's size outranks the fleet's, and a choice outranks both", () => {
    expect(seed({ volume: { size_gib: 400 } }).volume_gib).toBe(400);
    expect(
      seed({ volume: { size_gib: 400 }, draft: draft({ volume: 200, touched: ["volume_gib"] }) })
        .volume_gib,
    ).toBe(200);
  });
});

/**
 * `hermes` is a single key on `CreateAgentInput`, and more than one setting now
 * rides inside it. Two things are worth holding: an untouched control is absent
 * — the fleet's answer is inherited by omission, not by sending today's default
 * — and two stated settings arrive as one object rather than one overwriting
 * the other on the way out.
 */
describe("createRequestBody · the hermes object", () => {
  function form(over: Partial<CreateFormState> = {}): CreateFormState {
    return {
      ...seed(),
      name: "atlas",
      // The profile resolved this model, so re-sending it is not an override.
      profile_model: "claude-sonnet-5",
      profile_name: "anthropic-main",
      volume_id: null,
      ...over,
    };
  }

  test("an untouched form sends no hermes object at all", () => {
    expect(createRequestBody(form()).hermes).toBeUndefined();
  });

  test("a model that is the profile's own is still not an override", () => {
    expect(createRequestBody(form({ model: "claude-sonnet-5" })).hermes).toBeUndefined();
  });

  test("an approvals mode the operator chose rides on its own", () => {
    expect(createRequestBody(form({ approvals_mode: "manual" })).hermes).toEqual({
      approvals_mode: "manual",
    });
  });

  /**
   * The seam the persisted draft has to hold: the drawer seeds its controls
   * from `initialCreateForm` and builds the body from those same controls, so a
   * mode that survives the restore only counts if it is still on the wire.
   */
  test("a mode restored from a draft is stated, not just displayed", () => {
    const restored = seed({ draft: draft({ approvals_mode: "smart" }) });
    expect(createRequestBody(form(restored)).hermes).toEqual({ approvals_mode: "smart" });
    // A draft that chose no mode leaves the request as silent as a fresh one,
    // which is what keeps `tests/create-parity.test.ts` true.
    expect(createRequestBody(form(seed({ draft: draft() }))).hermes).toBeUndefined();
  });

  test("both settings merge into one object instead of clobbering each other", () => {
    expect(createRequestBody(form({ model: "claude-opus-5", approvals_mode: "smart" })).hermes).toEqual(
      { model: "claude-opus-5", approvals_mode: "smart" },
    );
  });

  test("the cli preview names the flag exactly when the body carries the field", () => {
    expect(createCliLine(form({ approvals_mode: "off" }))).toContain("--approvals off");
    expect(createCliLine(form())).not.toContain("--approvals");
  });
});
