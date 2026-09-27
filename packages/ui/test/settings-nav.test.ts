/**
 * Settings' second axis, both directions. The hash is the only place the open
 * section is written down, so a spelling that does not round-trip is a bookmark
 * that opens the wrong page.
 */
import { describe, expect, test } from "bun:test";
import {
  DEFAULT_SETTINGS_SECTION,
  SETTINGS_GROUPS,
  SETTINGS_SECTIONS,
  parseSettingsHash,
  settingsHash,
  settingsSectionInfo,
} from "../src/nav/settings-nav.ts";

describe("SETTINGS_SECTIONS", () => {
  test("is the rail the plan names, in order", () => {
    expect(SETTINGS_SECTIONS.map((s) => s.id)).toEqual([
      "defaults",
      "providers",
      "secrets",
      "policy",
      "foundation",
      "diagnostics",
      "presets",
      "chat",
      "notifications",
      "runs",
      "account",
      "danger",
    ]);
  });

  test("groups run in the rail's fixed order, each section's group contiguous", () => {
    const order = SETTINGS_GROUPS.map((g) => g.id);
    expect(order).toEqual(["fleet", "infrastructure", "laptop", "account", "danger"]);
    const seen = SETTINGS_SECTIONS.map((s) => order.indexOf(s.group));
    expect(seen).toEqual([...seen].sort((a, b) => a - b));
    // Danger is alone in its group, and it is the last thing on the rail.
    expect(SETTINGS_SECTIONS.filter((s) => s.group === "danger").map((s) => s.id)).toEqual(["danger"]);
    expect(settingsSectionInfo("policy")).toEqual({
      label: "Tailnet policy",
      group: "fleet",
      groupLabel: "Fleet",
    });
  });

  test("every section has a label, and no two share one", () => {
    const labels = SETTINGS_SECTIONS.map((s) => s.label);
    expect(labels.every((l) => l.length > 0)).toBe(true);
    expect(new Set(labels).size).toBe(labels.length);
  });
});

describe("settingsHash / parseSettingsHash", () => {
  test("every section round-trips", () => {
    for (const s of SETTINGS_SECTIONS) {
      expect(parseSettingsHash(settingsHash(s.id))).toBe(s.id);
    }
  });

  test("the landing section is spelled `#settings`, not `#settings/account`", () => {
    expect(settingsHash("account")).toBe("#settings");
    expect(settingsHash(DEFAULT_SETTINGS_SECTION)).toBe("#settings");
    // The long form is still accepted — a hand-typed URL should not bounce.
    expect(parseSettingsHash("#settings/account")).toBe("account");
  });

  test("a named section is a path segment under `#settings`", () => {
    expect(settingsHash("providers")).toBe("#settings/providers");
    // §4.9: the inbox's own page, which notification actions link to.
    expect(settingsHash("notifications")).toBe("#settings/notifications");
    expect(parseSettingsHash("#settings/notifications")).toBe("notifications");
    expect(parseSettingsHash("#settings/providers")).toBe("providers");
    expect(parseSettingsHash("#settings/danger")).toBe("danger");
  });

  test("`#settings` with nothing after it is the landing section", () => {
    expect(parseSettingsHash("#settings")).toBe("account");
    expect(parseSettingsHash("#settings/")).toBe("account");
  });

  test("an unknown section still opens Settings, on the landing section", () => {
    // A stale bookmark from a build whose rail had another entry: opening
    // Settings is a better answer than falling back to the fleet.
    expect(parseSettingsHash("#settings/nope")).toBe("account");
    expect(parseSettingsHash("#settings/providers/extra")).toBe("account");
  });

  test("a hash that is not Settings is not a section", () => {
    expect(parseSettingsHash("#volumes")).toBeNull();
    expect(parseSettingsHash("")).toBeNull();
    expect(parseSettingsHash("#")).toBeNull();
    // Prefix, not substring: `#settingsomething` is a different page.
    expect(parseSettingsHash("#settingsomething")).toBeNull();
  });

  test("the leading `#` is optional — `location.hash` has it, a stored value may not", () => {
    expect(parseSettingsHash("settings/runs")).toBe("runs");
    expect(parseSettingsHash("settings")).toBe("account");
  });
});
