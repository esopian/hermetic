/**
 * `shared/slash.ts`: which lines are Hermes slash commands, how they split,
 * and the `command.dispatch` reply union. Ported with upstream's own cases
 * (`apps/shared/src/slash.test.ts`), plus the ones issue #73 names.
 */
import { describe, expect, test } from "bun:test";
import {
  DISPATCH_TYPES,
  isNewSessionCommand,
  looksLikeSlashCommand,
  parseCommandDispatch,
  parseSlashCommand,
} from "../src/shared/slash.ts";
import * as schema from "../src/schema/index.ts";

describe("looksLikeSlashCommand", () => {
  test("a command is a slash at position 0, one bare name, then whitespace or the end", () => {
    expect(looksLikeSlashCommand("/help")).toBe(true);
    expect(looksLikeSlashCommand("/goal do it")).toBe(true);
    expect(looksLikeSlashCommand("/goal\nmulti-line")).toBe(true);
    expect(looksLikeSlashCommand("/")).toBe(true);
  });

  test("prose that merely starts with a slash is still a prompt", () => {
    // A second slash in the name disqualifies it.
    expect(looksLikeSlashCommand("/usr/local/bin is missing")).toBe(false);
    expect(looksLikeSlashCommand("/usr/local/bin")).toBe(false);
    expect(looksLikeSlashCommand("/etc/hosts")).toBe(false);
    // Not at position 0.
    expect(looksLikeSlashCommand("run /clean")).toBe(false);
    expect(looksLikeSlashCommand(" /help")).toBe(false);
    expect(looksLikeSlashCommand("hello")).toBe(false);
    expect(looksLikeSlashCommand("")).toBe(false);
  });
});

describe("parseSlashCommand", () => {
  test("splits the name off a single separator and lower-cases it", () => {
    expect(parseSlashCommand("/cron add daily")).toEqual({ arg: "add daily", name: "cron" });
    expect(parseSlashCommand("/Exit ")).toEqual({ arg: "", name: "exit" });
    expect(parseSlashCommand("/HELP")).toEqual({ arg: "", name: "help" });
  });

  test("keeps the argument's interior verbatim", () => {
    expect(parseSlashCommand("/goal ship   it").arg).toBe("ship   it");
  });

  test("keeps a multi-line argument byte for byte", () => {
    const arg = "first line\nsecond line\n\n  indented tail";
    expect(parseSlashCommand(`/pr-triage ${arg}`)).toEqual({ arg, name: "pr-triage" });
    expect(parseSlashCommand(`/goal ${arg}\n`)).toEqual({ arg, name: "goal" });
  });

  test("takes the name across a newline, like the gateway's split on any whitespace", () => {
    expect(parseSlashCommand("/goal\npasted block")).toEqual({ arg: "pasted block", name: "goal" });
    expect(parseSlashCommand("/goal\tx")).toEqual({ arg: "x", name: "goal" });
  });

  test("a bare or space-separated slash names no command", () => {
    expect(parseSlashCommand("/")).toEqual({ arg: "", name: "" });
    expect(parseSlashCommand("/   ")).toEqual({ arg: "", name: "" });
    expect(parseSlashCommand("/ some words")).toEqual({ arg: "", name: "" });
  });
});

describe("parseCommandDispatch", () => {
  test("parses every directive of the union and keeps notice and display", () => {
    expect(parseCommandDispatch({ type: "exec", output: "hi" })).toEqual({
      type: "exec",
      output: "hi",
    });
    expect(parseCommandDispatch({ type: "plugin" })).toEqual({ type: "plugin", output: undefined });
    expect(parseCommandDispatch({ type: "alias", target: "help" })).toEqual({
      type: "alias",
      target: "help",
    });
    expect(parseCommandDispatch({ type: "skill", name: "x", message: "do", display: "/x" })).toEqual({
      type: "skill",
      name: "x",
      message: "do",
      display: "/x",
    });
    expect(
      parseCommandDispatch({ type: "send", notice: "⊙ Goal set", message: "do the thing" }),
    ).toEqual({
      type: "send",
      message: "do the thing",
      notice: "⊙ Goal set",
      display: undefined,
    });
    expect(parseCommandDispatch({ type: "prefill", message: "edit me", notice: "↶ rewound" })).toEqual({
      type: "prefill",
      message: "edit me",
      notice: "↶ rewound",
    });
  });

  test("every DispatchType is one the parser reads", () => {
    const samples: Record<(typeof DISPATCH_TYPES)[number], unknown> = {
      exec: { type: "exec" },
      plugin: { type: "plugin" },
      alias: { type: "alias", target: "t" },
      send: { type: "send", message: "m" },
      skill: { type: "skill", name: "n" },
      prefill: { type: "prefill", message: "m" },
    };
    for (const type of DISPATCH_TYPES) expect(parseCommandDispatch(samples[type])?.type).toBe(type);
  });

  test("rejects malformed payloads", () => {
    expect(parseCommandDispatch(null)).toBeNull();
    expect(parseCommandDispatch([{ type: "exec" }])).toBeNull();
    expect(parseCommandDispatch({ output: "plain slash.exec text" })).toBeNull();
    expect(parseCommandDispatch({ type: "alias" })).toBeNull();
    expect(parseCommandDispatch({ type: "skill", name: 1 })).toBeNull();
    expect(parseCommandDispatch({ type: "send" })).toBeNull();
    expect(parseCommandDispatch({ type: "send", message: 42 })).toBeNull();
    expect(parseCommandDispatch({ type: "prefill", notice: "x" })).toBeNull();
    expect(parseCommandDispatch({ type: "nope" })).toBeNull();
  });
});

describe("isNewSessionCommand", () => {
  test("/new and /reset, bare or named, any case", () => {
    for (const line of ["/new", " /reset ", "/new side quest", "/RESET x", "/new\nnotes"])
      expect(isNewSessionCommand(line)).toBe(true);
  });
  test("other commands and prose are not", () => {
    for (const line of ["/compact", "/newer", "/news today", "new", "please /new", "/new/x"])
      expect(isNewSessionCommand(line)).toBe(false);
  });
});

describe("the doors", () => {
  test("the schema door re-exports the same parser the shared door does", () => {
    expect(schema.looksLikeSlashCommand).toBe(looksLikeSlashCommand);
    expect(schema.parseSlashCommand).toBe(parseSlashCommand);
    expect(schema.parseCommandDispatch).toBe(parseCommandDispatch);
  });
});
