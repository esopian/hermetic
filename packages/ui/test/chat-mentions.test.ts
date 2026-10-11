/**
 * The composer's `@`-mention rules (`chat/chat-mentions.ts`), mirroring Hermes
 * Desktop v2026.9.24: the trigger in `composer/text-utils.ts`, the provider in
 * `plugins/hermes-bots/plugin.tsx` and its cases in `plugin.mentions.test.ts`
 * that apply to a single instance.
 */
import { describe, expect, test } from "bun:test";
import {
  MENTION_LIMIT,
  botCandidate,
  filterMentions,
  insertMention,
  mentionAt,
} from "../src/chat/chat-mentions.ts";
import type { MentionBot } from "../src/chat/chat-mentions.ts";

const bot = (name: string, title = name, is_default = false): MentionBot => ({
  instance: "atlas",
  name,
  title,
  is_default,
});
const tags = (bots: MentionBot[], query: string) =>
  filterMentions(bots.map(botCandidate), query).map((row) => `@${row.tag}`);

describe("mentionAt", () => {
  test("opens on an @ at the start or after whitespace, up to the caret", () => {
    expect(mentionAt("@ma", 3)).toEqual({ start: 0, end: 3, query: "ma" });
    expect(mentionAt("hi @Ma", 6)).toEqual({ start: 3, end: 6, query: "ma" });
    expect(mentionAt("hi\n@", 4)).toEqual({ start: 3, end: 4, query: "" });
    // Only the text before the caret counts.
    expect(mentionAt("@marshall rest", 3)).toEqual({ start: 0, end: 3, query: "ma" });
  });

  test("an email address, a closed token and a second @ do not open it", () => {
    // plugin.mentions.test.ts: `user@example.com` is not a mention.
    expect(mentionAt("mail a@b.c", 10)).toBeNull();
    expect(mentionAt("@marshall ", 10)).toBeNull();
    expect(mentionAt("@a@b", 4)).toBeNull();
    expect(mentionAt("no trigger", 10)).toBeNull();
  });

  test("a chip placeholder is a token boundary, as upstream's is", () => {
    expect(mentionAt("￼@sc", 4)).toEqual({ start: 1, end: 4, query: "sc" });
  });
});

describe("filterMentions over bots", () => {
  const roster = [
    bot("default", "default", true),
    bot("scribe", "Marshall"),
    bot("auditor", "NickQABot"),
    bot("researcher"),
  ];

  test("an empty query lists every candidate in roster order", () => {
    expect(tags(roster, "")).toEqual(["@hermes", "@marshall", "@nickqabot", "@researcher"]);
  });

  test("a prefix narrows on the tag, the handle or the friendly name", () => {
    expect(tags(roster, "ma")).toEqual(["@marshall"]);
    // The profile handle still finds a renamed bot.
    expect(tags(roster, "scr")).toEqual(["@marshall"]);
    expect(tags(roster, "NICK")).toEqual(["@nickqabot"]);
    expect(tags(roster, "her")).toEqual(["@hermes"]);
    expect(tags(roster, "zzz")).toEqual([]);
  });

  test("prefix, not substring", () => {
    expect(tags(roster, "arsh")).toEqual([]);
  });

  test("an empty roster offers nothing", () => {
    expect(tags([], "")).toEqual([]);
  });

  test("a renamed default is offered under its friendly slug", () => {
    expect(tags([bot("default", "Lucy", true)], "")).toEqual(["@lucy"]);
  });

  test("no @all, @everyone or @user rows are invented", () => {
    for (const reserved of ["all", "every", "user"]) expect(tags(roster, reserved)).toEqual([]);
  });

  test("at most eight rows", () => {
    const many = Array.from({ length: 12 }, (_, i) => bot(`b${i}`));
    expect(tags(many, "")).toHaveLength(MENTION_LIMIT);
    expect(MENTION_LIMIT).toBe(8);
  });
});

describe("insertMention", () => {
  test("replaces the typed token with the tag and a trailing space", () => {
    const text = "ask @ma";
    expect(insertMention(text, mentionAt(text, 7)!, "marshall")).toEqual({
      text: "ask @marshall ",
      cursor: 14,
    });
  });

  test("no trailing space when whitespace already follows the caret", () => {
    const text = "ask @ma about it";
    expect(insertMention(text, mentionAt(text, 7)!, "marshall")).toEqual({
      text: "ask @marshall about it",
      cursor: 13,
    });
  });

  test("the text after the caret is kept, mid-token included", () => {
    const text = "@mazzz";
    expect(insertMention(text, mentionAt(text, 3)!, "marshall").text).toBe("@marshall zzz");
  });
});
