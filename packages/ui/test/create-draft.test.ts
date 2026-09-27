/**
 * The create form kept across the "Set up a provider" detour (§8.3).
 *
 * Two rules matter more than round-tripping: a draft belongs to one fleet and
 * one target volume, and anything that does not parse is discarded rather than
 * spread into a form as `undefined`.
 */
import "./setup.ts";
import { beforeEach, describe, expect, test } from "bun:test";
import { clearCreateDraft, loadCreateDraft, saveCreateDraft } from "../src/logic/create-draft.ts";
import type { CreateDraft } from "../src/logic/create-draft.ts";

const DRAFT: CreateDraft = {
  name: "corvid-2",
  size: "large",
  volume: 200,
  root_gib: 20,
  profile_id: "an7hr0p1",
  model: "claude-sonnet-5",
  approvals_mode: "manual",
  secrets: "none",
  rollback: false,
  volume_id: null,
  touched: ["size", "volume_gib"],
  preset: "heavy",
};

beforeEach(() => {
  window.sessionStorage.clear();
});

describe("create draft", () => {
  test("round-trips what was typed", () => {
    saveCreateDraft("m4in0abc", DRAFT);
    expect(loadCreateDraft("m4in0abc", null)).toEqual(DRAFT);
    // Named on its own because it is the field the detour used to lose: a
    // Hermes setting like `model`, carried whole rather than through `touched`.
    expect(loadCreateDraft("m4in0abc", null)?.approvals_mode).toBe("manual");
  });

  test("the selected preset rides along, and a draft without one reads as none", () => {
    saveCreateDraft("m4in0abc", DRAFT);
    expect(loadCreateDraft("m4in0abc", null)?.preset).toBe("heavy");
    const { preset: _dropped, ...older } = DRAFT;
    window.sessionStorage.setItem("hermetic.create-draft.m4in0abc", JSON.stringify(older));
    expect(loadCreateDraft("m4in0abc", null)?.preset).toBeNull();
  });

  test("belongs to one fleet: another fleet's drawer sees nothing", () => {
    saveCreateDraft("m4in0abc", DRAFT);
    expect(loadCreateDraft("sg7k2m4p", null)).toBeNull();
  });

  test("belongs to one target: a volume draft is not restored into a plain create", () => {
    saveCreateDraft("m4in0abc", { ...DRAFT, volume_id: "vol-abc" });
    expect(loadCreateDraft("m4in0abc", null)).toBeNull();
    expect(loadCreateDraft("m4in0abc", "vol-abc")?.volume_id).toBe("vol-abc");
  });

  test("a draft written by an older build is discarded, not half-applied", () => {
    window.sessionStorage.setItem("hermetic.create-draft.m4in0abc", JSON.stringify({ name: "x" }));
    expect(loadCreateDraft("m4in0abc", null)).toBeNull();
    window.sessionStorage.setItem("hermetic.create-draft.m4in0abc", "not json");
    expect(loadCreateDraft("m4in0abc", null)).toBeNull();
    // Including one written before `touched` existed: every value on it was
    // sent unconditionally, so neither "all chosen" nor "none chosen" is a
    // faithful reading of it and it is dropped instead.
    const { touched, ...older } = DRAFT;
    expect(touched).toBeArray();
    window.sessionStorage.setItem("hermetic.create-draft.m4in0abc", JSON.stringify(older));
    expect(loadCreateDraft("m4in0abc", null)).toBeNull();
  });

  test("a field this build does not know is dropped from `touched`", () => {
    window.sessionStorage.setItem(
      "hermetic.create-draft.m4in0abc",
      JSON.stringify({ ...DRAFT, touched: ["size", "gpu_count"] }),
    );
    // A draft from a newer build names a control this one does not render.
    // Keeping it would make the request claim a choice no visible field can
    // show, so it is filtered rather than trusted or rejected wholesale.
    expect(loadCreateDraft("m4in0abc", null)?.touched).toEqual(["size"]);
  });

  /**
   * `approvals_mode` is the one field read leniently, and that is a decision
   * rather than an oversight. `touched` is dropped wholesale because a draft
   * written before it existed has no faithful reading — its values were all
   * sent unconditionally, so neither "chosen" nor "inherited" is true of them.
   * Absence here has an exact reading: nobody picked a mode, which is `""`,
   * which is what a fresh drawer opens on. Throwing a typed-out form away over
   * a field whose absence is unambiguous would be that reasoning applied where
   * it does not hold.
   */
  test("an older build's draft has no approvals mode, and that is not a reason to drop it", () => {
    const { approvals_mode, ...older } = DRAFT;
    expect(approvals_mode).toBe("manual");
    window.sessionStorage.setItem("hermetic.create-draft.m4in0abc", JSON.stringify(older));
    const loaded = loadCreateDraft("m4in0abc", null);
    expect(loaded).not.toBeNull();
    expect(loaded?.approvals_mode).toBe("");
    // Everything else on it is still restored, which is the point of being lenient.
    expect(loaded?.name).toBe(DRAFT.name);
    expect(loaded?.touched).toEqual(DRAFT.touched);
  });

  test("a mode this build cannot show reads as no choice at all", () => {
    // A newer build's fourth mode, or plain junk: the drawer has no control
    // that could display it, so "chose nothing" is the only honest seeding.
    window.sessionStorage.setItem(
      "hermetic.create-draft.m4in0abc",
      JSON.stringify({ ...DRAFT, approvals_mode: "supervised" }),
    );
    expect(loadCreateDraft("m4in0abc", null)?.approvals_mode).toBe("");
    window.sessionStorage.setItem(
      "hermetic.create-draft.m4in0abc",
      JSON.stringify({ ...DRAFT, approvals_mode: 7 }),
    );
    expect(loadCreateDraft("m4in0abc", null)?.approvals_mode).toBe("");
  });

  test("a submitted create clears its own draft", () => {
    saveCreateDraft("m4in0abc", DRAFT);
    clearCreateDraft("m4in0abc");
    expect(loadCreateDraft("m4in0abc", null)).toBeNull();
  });

  test("nothing secret is in the shape at all", () => {
    // The field list is the guarantee: a create has no key field any more, so
    // there is nothing here that could persist one (§8.3).
    expect(Object.keys(DRAFT).some((k) => /key|secret_value|token/.test(k))).toBe(false);
  });
});
