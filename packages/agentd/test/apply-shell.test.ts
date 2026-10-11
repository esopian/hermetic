/**
 * The terminal's shell integration on the box (issue #18, `apply/shell.ts`):
 * the script, the `/etc/bash.bashrc` hook and the sudoers drop-in, through a
 * full `apply` on the stateful fake box.
 */
import { beforeEach, describe, expect, test } from "bun:test";
import { SHELL_INTEGRATION_SCRIPT } from "@hermetic/core/shared";
import {
  BASHRC_PATH,
  SHELL_HOOK_LINE,
  SHELL_HOOK_MARKER,
  SHELL_INTEGRATION_PATH,
  SHELL_SUDOERS_PATH,
  apply,
  resetAptIndexState,
  withShellHook,
} from "../src/apply/index.ts";
import { AgentdError } from "../src/errors.ts";
import { BoxHost } from "./fake-box.ts";
import { makeManifest } from "./fixtures.ts";

const count = (text: string, line: string): number => text.split("\n").filter((l) => l === line).length;

describe("apply — terminal shell integration", () => {
  let host: BoxHost;

  beforeEach(() => {
    host = new BoxHost();
    resetAptIndexState();
  });

  test("writes the script, the hook and the sudoers drop-in", async () => {
    await host.mkdir("/etc");
    await host.writeFile(BASHRC_PATH, "# System-wide .bashrc\nPS1='$ '\n", "0644");

    const result = await apply(makeManifest(), { host });

    const script = host.files.get(SHELL_INTEGRATION_PATH);
    expect(script?.content).toBe(SHELL_INTEGRATION_SCRIPT);
    expect(script?.mode).toBe("0644");
    // `stat -c %U:%G` on the fake box: root unless something chowned it.
    expect(script?.ownership ?? "root:root").toBe("root:root");

    const bashrc = host.files.get(BASHRC_PATH)?.content ?? "";
    expect(bashrc.startsWith("# System-wide .bashrc\nPS1='$ '\n")).toBe(true);
    expect(bashrc.endsWith(`${SHELL_HOOK_MARKER}\n${SHELL_HOOK_LINE}\n`)).toBe(true);
    expect(SHELL_HOOK_LINE).toBe(
      "[ -r /etc/hermetic/shell-integration.bash ] && . /etc/hermetic/shell-integration.bash",
    );
    expect(host.files.get(BASHRC_PATH)?.mode).toBe("0644");

    // No dot in the name: sudo skips such an entry silently.
    expect(SHELL_SUDOERS_PATH).toBe("/etc/sudoers.d/hermetic-terminal");
    expect(host.files.get(SHELL_SUDOERS_PATH)?.content).toBe(
      'Defaults env_keep += "HERMETIC_SI_NONCE"\n',
    );
    expect(host.files.get(SHELL_SUDOERS_PATH)?.mode).toBe("0440");
    // Validated at the inert staged name, then renamed into place.
    expect(host.commandsMatching(/^visudo /)).toContain(`visudo -c -q -f ${SHELL_SUDOERS_PATH}.new`);
    expect(host.fsOps).toContain(`rename ${SHELL_SUDOERS_PATH}.new -> ${SHELL_SUDOERS_PATH}`);

    expect(result.contentChanged).toEqual(
      expect.arrayContaining([SHELL_INTEGRATION_PATH, BASHRC_PATH, SHELL_SUDOERS_PATH]),
    );
  });

  test("a second apply leaves one hook and changes nothing", async () => {
    await apply(makeManifest(), { host });
    host.commands.length = 0;

    const second = await apply(makeManifest(), { host });

    const bashrc = host.files.get(BASHRC_PATH)?.content ?? "";
    expect(count(bashrc, SHELL_HOOK_LINE)).toBe(1);
    expect(count(bashrc, SHELL_HOOK_MARKER)).toBe(1);
    expect(second.changed).not.toContain(BASHRC_PATH);
    expect(second.changed).not.toContain(SHELL_INTEGRATION_PATH);
    expect(second.changed).not.toContain(SHELL_SUDOERS_PATH);
    expect(host.commandsMatching(/^visudo /)).toEqual([]);
  });

  test("a hook a hand edit duplicated is put back to one", () => {
    const twice = `a\n${SHELL_HOOK_MARKER}\n${SHELL_HOOK_LINE}\nb\n${SHELL_HOOK_LINE}\n`;
    const fixed = withShellHook(twice);
    expect(count(fixed, SHELL_HOOK_LINE)).toBe(1);
    expect(count(fixed, SHELL_HOOK_MARKER)).toBe(1);
    expect(fixed).toBe(`a\nb\n${SHELL_HOOK_MARKER}\n${SHELL_HOOK_LINE}\n`);
    // One copy anywhere is left exactly where the operator put it.
    const moved = `${SHELL_HOOK_LINE}\nrest\n`;
    expect(withShellHook(moved)).toBe(moved);
    // No bashrc at all, and one without a final newline.
    expect(withShellHook(null)).toBe(`${SHELL_HOOK_MARKER}\n${SHELL_HOOK_LINE}\n`);
    expect(withShellHook("x")).toBe(`x\n${SHELL_HOOK_MARKER}\n${SHELL_HOOK_LINE}\n`);
  });

  test("a sudoers drop-in visudo rejects fails the apply and lands nowhere", async () => {
    host.when(new RegExp(`^visudo .*${SHELL_SUDOERS_PATH}`), {
      code: 1,
      stderr: `>>> ${SHELL_SUDOERS_PATH}.new: syntax error near line 1 <<<`,
    });

    const error = await apply(makeManifest(), { host }).then(
      () => null,
      (e: unknown) => e,
    );

    expect(error).toBeInstanceOf(AgentdError);
    expect((error as AgentdError).code).toBe("COMMAND_FAILED");
    expect((error as AgentdError).message).toContain("syntax error near line 1");
    expect(host.files.has(SHELL_SUDOERS_PATH)).toBe(false);
    expect(host.files.has(`${SHELL_SUDOERS_PATH}.new`)).toBe(false);
  });

  test("a dry run reports the three files and writes none of them", async () => {
    const result = await apply(makeManifest(), { host, dryRun: true });

    expect(result.changed).toEqual(
      expect.arrayContaining([SHELL_INTEGRATION_PATH, BASHRC_PATH, SHELL_SUDOERS_PATH]),
    );
    expect(result.ownershipCorrected).not.toContain(SHELL_INTEGRATION_PATH);
    expect(host.files.has(SHELL_INTEGRATION_PATH)).toBe(false);
    expect(host.files.has(BASHRC_PATH)).toBe(false);
    expect(host.files.has(SHELL_SUDOERS_PATH)).toBe(false);
  });
});
