/**
 * Bot handles, alias forms, mention tags and target resolution
 * (`shared/bot-handles.ts`), against the cases Hermes v2026.9.24 pins on its
 * own copies: `plugin.mentions.test.ts` on the Desktop and
 * `tests/tools/test_bot_mode_dm.py` on the gateway.
 */
import { describe, expect, test } from "bun:test";
import { botAliasForms, botHandle, botMentionTag, resolveBotTarget } from "../src/shared/index.ts";

describe("botHandle", () => {
  test("the primary profile answers to @hermes; every other profile to its name", () => {
    expect(botHandle("default")).toBe("hermes");
    expect(botHandle("Default")).toBe("hermes");
    expect(botHandle("researcher")).toBe("researcher");
  });
});

describe("botAliasForms", () => {
  test("slugified first, then collapsed", () => {
    expect(botAliasForms("Dr. Foo")).toEqual(["dr-foo", "drfoo"]);
    expect(botAliasForms("Research Buddy")).toEqual(["research-buddy", "researchbuddy"]);
    expect(botAliasForms("Scribe")).toEqual(["scribe"]);
  });

  test("reserved tokens, empty names and forms outside the charset are dropped", () => {
    for (const reserved of ["Hermes", "all", "Everyone", "user", "default"]) {
      expect(botAliasForms(reserved)).toEqual([]);
    }
    expect(botAliasForms("")).toEqual([]);
    expect(botAliasForms(null)).toEqual([]);
    expect(botAliasForms("  ...  ")).toEqual([]);
    // A leading underscore survives the slug but not the charset rule.
    expect(botAliasForms("_x")).toEqual([]);
  });
});

describe("botMentionTag", () => {
  test("a bot with no friendly name is tagged by its handle — default as hermes", () => {
    expect(botMentionTag({ name: "default", title: "default", is_default: true })).toBe("hermes");
    expect(botMentionTag({ name: "researcher", title: "researcher" })).toBe("researcher");
    expect(botMentionTag({ name: "researcher" })).toBe("researcher");
  });

  test("a renamed bot is tagged by the slug of its friendly name", () => {
    // plugin.mentions.test.ts: a renamed default titled Lucy is offered as @lucy.
    expect(botMentionTag({ name: "default", title: "Lucy", is_default: true })).toBe("lucy");
    expect(botMentionTag({ name: "foo", title: "Dr. Foo" })).toBe("dr-foo");
  });

  test("a title that reduces to nothing usable falls back to the handle", () => {
    expect(botMentionTag({ name: "ops", title: "Hermes" })).toBe("ops");
    expect(botMentionTag({ name: "ops", title: "!!!" })).toBe("ops");
  });
});

describe("resolveBotTarget", () => {
  const roster = [
    { name: "default", title: "default", is_default: true },
    { name: "writer", title: "Scribe" },
    { name: "foo", title: "Dr. Foo" },
    { name: "builder", title: "Builder" },
  ];

  test.each([
    ["Scribe", "writer"],
    ["@scribe", "writer"],
    ["Dr. Foo", "foo"],
    ["dr-foo", "foo"],
    ["drfoo", "foo"],
    ["Builder", "builder"],
    ["WRITER", "writer"],
    ["@@foo", "foo"],
  ])("%s resolves to %s", (target, name) => {
    expect(resolveBotTarget(target, roster)?.name).toBe(name);
  });

  test("hermes is the primary profile, and nothing else", () => {
    expect(resolveBotTarget("hermes", roster)?.name).toBe("default");
    expect(resolveBotTarget("@Hermes", roster)?.name).toBe("default");
    const noDefault = roster.filter((bot) => !bot.is_default);
    expect(resolveBotTarget("hermes", noDefault)).toBeNull();
  });

  test("an ambiguous friendly name fails closed and @hermes cannot be hijacked", () => {
    const bots = [
      { name: "default", title: "default", is_default: true },
      { name: "aaa", title: "Scribe" },
      { name: "bbb", title: "Scribe" },
      { name: "ops", title: "Hermes" },
    ];
    expect(resolveBotTarget("Scribe", bots)).toBeNull();
    expect(resolveBotTarget("hermes", bots)?.name).toBe("default");
  });

  test("an exact profile id wins over another bot's friendly name", () => {
    const bots = [
      { name: "scribe", title: "scribe" },
      { name: "writer", title: "Scribe" },
    ];
    expect(resolveBotTarget("scribe", bots)?.name).toBe("scribe");
  });

  test("unknown and empty targets resolve to nothing", () => {
    expect(resolveBotTarget("nobody", roster)).toBeNull();
    expect(resolveBotTarget("", roster)).toBeNull();
    expect(resolveBotTarget("@", roster)).toBeNull();
  });

  test("the row handed back is the caller's own, extra fields and all", () => {
    const bots = [{ name: "writer", title: "Scribe", instance: "atlas" }];
    expect(resolveBotTarget("scribe", bots)).toBe(bots[0]!);
  });
});
