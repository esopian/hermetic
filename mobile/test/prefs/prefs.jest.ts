import { DEFAULT_AVATAR_STYLE } from "@hermetic/core/shared";
import { DEFAULT_PREFS, parsePrefs } from "../../src/prefs/prefs.tsx";

describe("parsePrefs", () => {
  test("nothing stored is the defaults, with the shared default avatar style", () => {
    expect(parsePrefs(null)).toEqual(DEFAULT_PREFS);
    expect(DEFAULT_PREFS.avatarStyle).toBe(DEFAULT_AVATAR_STYLE);
  });

  test("a stored avatar style is kept", () => {
    for (const style of ["sigil", "pixel", "blob"] as const) {
      expect(parsePrefs(JSON.stringify({ avatarStyle: style })).avatarStyle).toBe(style);
    }
  });

  test("an unknown or malformed avatar style falls back to the default", () => {
    for (const bad of ["round", "", 3, null, ["sigil"]]) {
      expect(parsePrefs(JSON.stringify({ avatarStyle: bad })).avatarStyle).toBe(DEFAULT_AVATAR_STYLE);
    }
    // Prefs saved before the field existed keep everything else.
    const old = parsePrefs(JSON.stringify({ haptics: false }));
    expect(old.haptics).toBe(false);
    expect(old.avatarStyle).toBe(DEFAULT_AVATAR_STYLE);
  });

  test("unparseable storage is the defaults", () => {
    expect(parsePrefs("{nope")).toEqual(DEFAULT_PREFS);
  });
});
