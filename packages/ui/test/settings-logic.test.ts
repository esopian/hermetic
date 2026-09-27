/**
 * What a Settings form actually sends, and what it refuses to.
 *
 * These are the rules that decide the content of a **fleet-wide** write, so
 * they are tested without a renderer: only the changed fields, `null` for a
 * field that was cleared, `expected_version` carried through from the load, and
 * nothing at all when the form is clean.
 *
 * No real-looking secret appears anywhere here (§8.3) — the one slug that
 * stands for a filled slot is spelled with `FIXTURE`.
 */
import { describe, expect, test } from "bun:test";
import {
  activeSaveError,
  agentDefaultsOf,
  canDeleteSecret,
  changedDefaults,
  defaultsIssue,
  dirtyDefaults,
  isConflict,
  isValidSlug,
  nextSettings,
  rekeyReceiptMessage,
  secretState,
  toSaveError,
} from "../src/logic/settings-logic.ts";
import type { DefaultsForm, SecretRow } from "../src/logic/settings-logic.ts";

const LOADED: DefaultsForm = {
  secrets: "none",
  model: "",
  terminal_backend: "",
  max_turns: "",
  reasoning_effort: "",
  approvals_mode: "",
};

function form(over: Partial<DefaultsForm> = {}): DefaultsForm {
  return { ...LOADED, ...over };
}

/**
 * Every Hermes key unstated, which is how `agentDefaultsOf` spells a blanked
 * field now that core merges `agent_defaults` key by key: an omitted key would
 * mean "leave it alone", so a blank is an explicit `null`.
 */
const BLANK_HERMES = {
  model: null,
  terminal_backend: null,
  max_turns: null,
  reasoning_effort: null,
  approvals_mode: null,
} as const;

describe("changedDefaults", () => {
  test("names the touched fields in form order, and nothing when nothing moved", () => {
    expect(changedDefaults(LOADED, form())).toEqual([]);
    expect(changedDefaults(LOADED, form({ model: "x", secrets: "bitwarden" }))).toEqual([
      "secrets",
      "model",
    ]);
  });

  test("counts an unparseable edit — the bar has to own it — but not a whitespace one", () => {
    expect(changedDefaults(LOADED, form({ max_turns: "abc" }))).toEqual(["max_turns"]);
    expect(changedDefaults(LOADED, form({ max_turns: "   " }))).toEqual([]);
  });

  /**
   * §4.6: size, data volume and system disk are this laptop's create presets.
   * The form holds none of them, so no edit here can send one — a stale value
   * would otherwise overwrite the fleet's stored defaults the CLI still reads.
   */
  test("the machine fields are not on the form at all", () => {
    expect(Object.keys(LOADED)).not.toContain("size");
    expect(Object.keys(LOADED)).not.toContain("volume_gib");
    expect(Object.keys(LOADED)).not.toContain("root_gib");
    const patch = dirtyDefaults(LOADED, form({ secrets: "bitwarden", model: "m" }), 3);
    expect(Object.keys(patch?.defaults ?? {})).toEqual(["secrets"]);
  });
});

describe("dirtyDefaults", () => {
  test("a clean form sends nothing", () => {
    expect(dirtyDefaults(LOADED, form(), 3)).toBeNull();
  });

  test("only the changed field rides along", () => {
    expect(dirtyDefaults(LOADED, form({ secrets: "bitwarden" }), 3)).toEqual({
      defaults: { secrets: "bitwarden" },
      expected_version: 3,
    });
  });

  test("max turns is sent as a number, not the string the input gave", () => {
    expect(dirtyDefaults(LOADED, form({ max_turns: "250" }), 3)).toEqual({
      agent_defaults: { ...BLANK_HERMES, max_turns: 250 },
      expected_version: 3,
    });
  });

  test("a max turns that will not parse is never sent as part of another change", () => {
    const patch = dirtyDefaults(LOADED, form({ max_turns: "abc", secrets: "bitwarden" }), 3);
    expect(patch).toEqual({ defaults: { secrets: "bitwarden" }, expected_version: 3 });
    // …and the form says why Save is blocked.
    expect(defaultsIssue(form({ max_turns: "abc" }))).toContain("max turns");
  });

  test("`agent_defaults` is sent whole, every unstated field as an explicit null", () => {
    const patch = dirtyDefaults(LOADED, form({ model: "deepseek-v4-flash-0731" }), 3);
    expect(patch).toEqual({
      agent_defaults: { ...BLANK_HERMES, model: "deepseek-v4-flash-0731" },
      expected_version: 3,
    });
  });

  /**
   * The behaviour core's merge had to keep working: this form holds all five
   * Hermes fields, so blanking one is an instruction to clear that one key,
   * not an omission core would read as "leave it alone".
   */
  test("blanking one field clears that key by name and carries the others", () => {
    const loaded = form({ model: "deepseek-v4-flash-0731", max_turns: "500" });
    const patch = dirtyDefaults(loaded, form({ model: "", max_turns: "500" }), 3);
    expect(patch).toEqual({
      agent_defaults: { ...BLANK_HERMES, max_turns: 500 },
      expected_version: 3,
    });
    expect((patch as { agent_defaults: Record<string, unknown> }).agent_defaults.model).toBeNull();
  });

  test("clearing the last Hermes field is `null`, which an absent key cannot say", () => {
    const loaded = form({ max_turns: "500" });
    expect(dirtyDefaults(loaded, form({ max_turns: "" }), 3)).toEqual({
      agent_defaults: null,
      expected_version: 3,
    });
  });

  test("clearing one of two Hermes fields keeps the other", () => {
    const loaded = form({ max_turns: "500", reasoning_effort: "high" });
    expect(dirtyDefaults(loaded, form({ max_turns: "500", reasoning_effort: "" }), 3)).toEqual({
      agent_defaults: { ...BLANK_HERMES, max_turns: 500 },
      expected_version: 3,
    });
  });

  test("both halves in one write", () => {
    expect(
      dirtyDefaults(LOADED, form({ secrets: "bitwarden", terminal_backend: "docker" }), 3),
    ).toEqual({
      defaults: { secrets: "bitwarden" },
      agent_defaults: { ...BLANK_HERMES, terminal_backend: "docker" },
      expected_version: 3,
    });
  });

  test("`null` expected_version says `there was no settings object`, and is kept", () => {
    expect(dirtyDefaults(LOADED, form({ secrets: "bitwarden" }), null)).toEqual({
      defaults: { secrets: "bitwarden" },
      expected_version: null,
    });
  });

  test("omitting the version omits the key — absent is not the same as null", () => {
    const patch = dirtyDefaults(LOADED, form({ secrets: "bitwarden" }));
    expect(patch).toEqual({ defaults: { secrets: "bitwarden" } });
    expect(patch === null ? [] : Object.keys(patch)).not.toContain("expected_version");
  });

  /**
   * §6.4's approvals mode is a fleet default like the others on this form, even
   * though it is seeded on every agent rather than managed on any: the fleet
   * answers where a new agent starts, and "" is still the spelling of "it does
   * not answer".
   */
  test("the approvals mode rides in `agent_defaults` like its neighbours", () => {
    expect(dirtyDefaults(LOADED, form({ approvals_mode: "smart" }), 3)).toEqual({
      agent_defaults: { ...BLANK_HERMES, approvals_mode: "smart" },
      expected_version: 3,
    });
    // Unstated by itself, it is not a field at all rather than an `off`.
    expect(agentDefaultsOf(form())).toBeNull();
  });

  test("clearing the approvals mode is a change the diff sees", () => {
    const loaded = form({ approvals_mode: "manual", max_turns: "500" });
    expect(dirtyDefaults(loaded, form({ approvals_mode: "", max_turns: "500" }), 3)).toEqual({
      agent_defaults: { ...BLANK_HERMES, max_turns: 500 },
      expected_version: 3,
    });
  });

  test("a model that is only whitespace is unstated, not a model", () => {
    expect(dirtyDefaults(LOADED, form({ model: "   " }), 3)).toBeNull();
    expect(agentDefaultsOf(form({ model: "   " }))).toBeNull();
  });
});

describe("defaultsIssue", () => {
  test("a well-formed form has none", () => {
    expect(defaultsIssue(form())).toBeNull();
    expect(defaultsIssue(form({ max_turns: "500" }))).toBeNull();
  });

  test("the model id is capped where core caps it", () => {
    expect(defaultsIssue(form({ model: "m".repeat(200) }))).toBeNull();
    expect(defaultsIssue(form({ model: "m".repeat(201) }))).toContain("model");
  });

  test("max turns is optional, but not arbitrary", () => {
    expect(defaultsIssue(form({ max_turns: "" }))).toBeNull();
    expect(defaultsIssue(form({ max_turns: "10000" }))).toBeNull();
    expect(defaultsIssue(form({ max_turns: "10001" }))).toContain("max turns");
    expect(defaultsIssue(form({ max_turns: "0" }))).toContain("max turns");
    expect(defaultsIssue(form({ max_turns: "many" }))).toContain("max turns");
  });
});

describe("secretState", () => {
  const base: SecretRow = { slug: "nous-FIXTURE", exists: true, placeholder: false, used_by: [] };

  test("a filled parameter is `set`", () => {
    expect(secretState(base)).toBe("set");
  });

  test("a slot that was declared but never filled is `empty`, not `set`", () => {
    expect(secretState({ ...base, exists: true, placeholder: true })).toBe("empty");
    expect(secretState({ ...base, exists: false, placeholder: false })).toBe("empty");
  });

  test("a parameter no settings entry describes is `orphan`, whatever else it is", () => {
    expect(secretState({ ...base, orphan: true })).toBe("orphan");
    expect(secretState({ ...base, placeholder: true, orphan: true })).toBe("orphan");
  });

  test("`orphan: false` is not an orphan", () => {
    expect(secretState({ ...base, orphan: false })).toBe("set");
  });
});

describe("canDeleteSecret", () => {
  const base: SecretRow = { slug: "nous-FIXTURE", exists: true, placeholder: false, used_by: [] };

  test("a slot nobody names may go", () => {
    expect(canDeleteSecret(base)).toEqual({ ok: true });
  });

  test("a slot a provider still names may not, and says which", () => {
    const out = canDeleteSecret({ ...base, used_by: ["nous"] });
    expect(out.ok).toBe(false);
    expect(out.reason).toBe("still named by nous; clear it in Providers first");
  });

  test("every provider naming it is listed", () => {
    const out = canDeleteSecret({ ...base, used_by: ["nous", "openrouter"] });
    expect(out.reason).toContain("nous, openrouter");
  });

  test("an orphan with no readers may still go — that is the point of listing it", () => {
    expect(canDeleteSecret({ ...base, orphan: true }).ok).toBe(true);
  });
});

describe("isValidSlug", () => {
  test("what an SSM path may hold", () => {
    for (const ok of ["a", "nous", "nous-FIXTURE".toLowerCase(), "0", "a".repeat(31), "a-b-c"]) {
      expect(isValidSlug(ok)).toBe(true);
    }
  });

  test("anything that could escape the prefix, or is not a name", () => {
    for (const bad of [
      "",
      "-lead",
      "Upper",
      "has space",
      "has/slash",
      "has.dot",
      "under_score",
      "a".repeat(32),
    ]) {
      expect(isValidSlug(bad)).toBe(false);
    }
  });
});

describe("toSaveError", () => {
  test("an ApiError-shaped throw keeps its code", () => {
    const e = Object.assign(new Error("settings changed under you"), { code: "CONFLICT" });
    expect(toSaveError(e)).toEqual({ code: "CONFLICT", message: "settings changed under you" });
    expect(isConflict(toSaveError(e))).toBe(true);
  });

  test("anything else is still renderable", () => {
    expect(toSaveError(new Error("boom"))).toEqual({ code: "ERROR", message: "boom" });
    expect(toSaveError("boom")).toEqual({ code: "ERROR", message: "boom" });
    expect(toSaveError({ code: 42 })).toEqual({ code: "ERROR", message: "[object Object]" });
  });

  test("only CONFLICT is a conflict", () => {
    expect(isConflict(null)).toBe(false);
    expect(isConflict({ code: "LOCKED", message: "a foundation update holds the fleet" })).toBe(false);
  });
});

describe("nextSettings", () => {
  const at = (version: number, persisted = true) => ({ persisted, settings: { version } });

  test("the first answer is the answer", () => {
    expect(nextSettings(null, at(3))).toEqual(at(3));
  });

  test("a save moves the shell forward", () => {
    expect(nextSettings(at(3), at(4))).toEqual(at(4));
  });

  test("a response that lands out of order does not walk the version back", () => {
    // Two sections saving at once: the older response must not replace the
    // newer one, or the next save would carry a version the server has passed.
    expect(nextSettings(at(5), at(4))).toEqual(at(5));
  });

  test("the same version is still the newer document — its contents may differ", () => {
    const current = { persisted: true, settings: { version: 4 }, tag: "old" };
    const saved = { persisted: true, settings: { version: 4 }, tag: "new" };
    expect(nextSettings(current, saved)).toBe(saved);
  });

  test("the first persisted write beats a synthesized document, whatever its number", () => {
    expect(nextSettings(at(9, false), at(1, true))).toEqual(at(1, true));
    // …and never the other way round: a stale synthesized read cannot undo it.
    expect(nextSettings(at(1, true), at(9, false))).toEqual(at(1, true));
  });
});

describe("activeSaveError", () => {
  const err = { code: "CONFLICT", message: "settings changed under you" };

  test("nothing raised is nothing shown", () => {
    expect(activeSaveError(null, 3)).toBeNull();
  });

  test("an error raised against the current version is shown", () => {
    expect(activeSaveError({ at: 3, error: err }, 3)).toEqual(err);
  });

  test("a version bump — this section's own successful Reload, or anyone else's save — retires it", () => {
    expect(activeSaveError({ at: 3, error: err }, 4)).toBeNull();
  });

  test("`null` versions (nothing persisted yet) still compare", () => {
    expect(activeSaveError({ at: null, error: err }, null)).toEqual(err);
    expect(activeSaveError({ at: null, error: err }, 1)).toBeNull();
  });
});

describe("rekeyReceiptMessage", () => {
  test("a plain push never claims a running agent", () => {
    expect(rekeyReceiptMessage({ rekeyed: 0, rekeyRequested: false })).toBe(
      "future creates get this value; agents already running keep the copy they were built with",
    );
  });

  test("a re-key that matched agents says how many, singular and plural", () => {
    expect(rekeyReceiptMessage({ rekeyed: 1, rekeyRequested: true })).toBe(
      "rekeyed 1 agent · each takes it on its next recreate",
    );
    expect(rekeyReceiptMessage({ rekeyed: 3, rekeyRequested: true })).toBe(
      "rekeyed 3 agents · each takes it on its next recreate",
    );
  });

  test("a re-key that matched nothing is not the same as never asking", () => {
    expect(rekeyReceiptMessage({ rekeyed: 0, rekeyRequested: true })).toBe(
      "re-key requested — no running agent uses this slot; future creates get the value",
    );
  });
});
