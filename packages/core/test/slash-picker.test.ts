/**
 * The composer's slash-command picker rules (`shared/slash.ts`): when the
 * list opens, what it lists and in what order, and what accepting a row does.
 */
import { describe, expect, test } from "bun:test";
import {
  acceptSlash,
  filterSlashCommands,
  offered,
  slashQuery,
  takesArgument,
} from "../src/shared/slash.ts";
import type { ChatCommand } from "../src/schema/index.ts";

const command = (name: string, extra: Partial<ChatCommand> = {}): ChatCommand => ({
  name,
  description: `${name} does a thing`,
  category: "Session",
  argument_mode: "text",
  desktop: null,
  skill: null,
  ...extra,
});

const CATALOG = [
  command("/goal"),
  command("/theme"),
  command("/help"),
  command("/skin", { desktop: "terminal" }),
  command("/sketch-helper", { category: null, argument_mode: null, skill: { origin: "bundled" } }),
  command("/version", { argument_mode: null }),
  command("/hello", { desktop: "hidden" }),
];

const names = (query: string) => filterSlashCommands(CATALOG, query).map((m) => m.command.name);

describe("slashQuery", () => {
  test("a bare command name being typed opens the list", () => {
    expect(slashQuery("/")).toBe("");
    expect(slashQuery("/he")).toBe("he");
    expect(slashQuery("/HeL")).toBe("hel");
  });

  test("a space after the name closes it", () => {
    expect(slashQuery("/help ")).toBeNull();
    expect(slashQuery("/help\n")).toBeNull();
    expect(slashQuery("/goal ship it")).toBeNull();
  });

  test("prose with a slash in it never opens it", () => {
    expect(slashQuery("run /help")).toBeNull();
    expect(slashQuery(" /help")).toBeNull();
    expect(slashQuery("/usr/local")).toBeNull();
    expect(slashQuery("")).toBeNull();
  });
});

describe("filterSlashCommands", () => {
  test("prefix matches come before substring matches, each in catalog order", () => {
    expect(names("he")).toEqual(["/help", "/theme", "/sketch-helper"]);
  });

  test("no match returns empty", () => {
    expect(names("zzz")).toEqual([]);
  });

  test("an empty query lists every offered command", () => {
    expect(names("")).toEqual(["/goal", "/theme", "/help", "/sketch-helper", "/version"]);
  });

  test("a command a desktop composer does not offer is never listed", () => {
    expect(names("sk")).toEqual(["/sketch-helper"]);
    expect(names("hel")).not.toContain("/hello");
    expect(offered(command("/x", { desktop: "settings" }))).toBe(false);
  });

  test("the match span marks the typed part of the name", () => {
    const [help, theme] = filterSlashCommands(CATALOG, "HE");
    expect(help).toMatchObject({ start: 0, end: 2 });
    expect(theme).toMatchObject({ start: 1, end: 3 });
  });
});

describe("accepting a row", () => {
  test("inserts the name and one space", () => {
    expect(acceptSlash(command("/help"))).toBe("/help ");
  });

  test("a skill takes an argument; a command with no argument mode does not", () => {
    expect(takesArgument(command("/help"))).toBe(true);
    expect(takesArgument(CATALOG[4]!)).toBe(true);
    expect(takesArgument(command("/version", { argument_mode: null }))).toBe(false);
  });
});
