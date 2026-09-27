/**
 * `CLI_COMMANDS` is what the parity test reads, so it must not be able to drift
 * from the tree Commander actually builds. This walks the real program.
 */
import { describe, expect, test } from "bun:test";
import type { Command } from "commander";
import { PUBLIC_METHODS, STREAMING_METHODS } from "@hermetic/core";
import { z } from "zod";
import { CLI_COMMANDS } from "../src/registry.ts";
import { declarations, declare } from "../src/declare.ts";
import { buildProgram } from "../src/program.ts";

/**
 * Whether a command does something itself, as opposed to only grouping others.
 *
 * `inbox` is both: `hermetic inbox` lists, and `inbox ack` / `inbox mute` write.
 * Commander keeps no public predicate for this, so the private field is read
 * through a narrow type rather than through `any` — the alternative is a walk
 * that reports `inbox` as a group and loses the command that shares its name.
 */
function hasAction(cmd: Command): boolean {
  return typeof (cmd as unknown as { _actionHandler?: unknown })._actionHandler === "function";
}

function paths(cmd: Command, prefix: string[] = []): string[] {
  return cmd.commands.flatMap((sub) => {
    const here = [...prefix, sub.name()];
    const nested = paths(sub, here);
    if (nested.length === 0) return [here.join(" ")];
    return hasAction(sub) ? [here.join(" "), ...nested] : nested;
  });
}

const registered = new Set(paths(buildProgram()));

describe("the command tree matches the registry", () => {
  test("every registered command exists in Commander", () => {
    for (const entry of CLI_COMMANDS) {
      expect(registered.has(entry.command)).toBe(true);
    }
  });

  /**
   * Every command in the tree wraps a core method — there is no longer an
   * exception. `portal` used to be one: it launched the dashboard, wrapped no
   * core method, and was carved out of `CLI_COMMANDS` for that reason. The
   * dashboard is `hermetic-portal`, its own binary (§3.6), so the carve-out is
   * gone and this is the stronger invariant that replaces it — a command that
   * forgets to `declare()` is now a failure here rather than a second exception.
   */
  test("no command exists without a core method behind it", () => {
    const claimed = new Set(CLI_COMMANDS.map((c) => c.command));
    const extra = [...registered].filter((p) => !claimed.has(p));
    expect(extra).toEqual([]);
  });

  test("one command per public method, none repeated", () => {
    expect(CLI_COMMANDS.map((c) => c.path).sort()).toEqual([...PUBLIC_METHODS].sort());
    expect(new Set(CLI_COMMANDS.map((c) => c.command)).size).toBe(CLI_COMMANDS.length);
  });

  test("every streaming method has a command that can render its events", () => {
    for (const path of STREAMING_METHODS) {
      expect(CLI_COMMANDS.some((c) => c.path === path)).toBe(true);
    }
  });

  test("global flags are accepted after the subcommand", () => {
    const create = buildProgram()
      .commands.find((c) => c.name() === "agent")
      ?.commands.find((c) => c.name() === "create");
    const flags = create?.options.map((o) => o.long) ?? [];
    expect(flags).toContain("--json");
    expect(flags).toContain("--fixture");
    expect(flags).toContain("--fleet");
  });
});

describe("a method cannot be declared twice", () => {
  // `declare` writes into one module-global map, so without this guard a second
  // command for the same method would silently replace the first and the
  // parity test's "exactly one command per method" could never notice.
  const first = CLI_COMMANDS.find((c) => c.path === "agents.create");
  if (!first) throw new Error("agents.create is not declared");

  test("re-declaring the same command with the same schema is a no-op", () => {
    const before = declarations().length;
    expect(declare(first.path, first.command, first.schema)).toBe(first.schema);
    expect(declarations().length).toBe(before);
  });

  test("a different command name for the same method throws", () => {
    expect(() => declare(first.path, "agent make", first.schema)).toThrow(
      /agents\.create declared twice: first as "agent create", then as "agent make"/,
    );
  });

  test("a different schema for the same method throws", () => {
    expect(() => declare(first.path, first.command, z.object({}))).toThrow(
      /agents\.create declared twice.*with a different schema/,
    );
    expect(declarations().find((c) => c.path === first.path)?.schema).toBe(first.schema);
  });
});
