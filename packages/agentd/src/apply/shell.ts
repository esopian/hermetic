/**
 * The terminal's shell integration on the box (issue #18).
 *
 * The desktop app's in-app terminal reads OSC 133 markers out of the session to
 * tell "a command is running" from "idle at a prompt" — what its quit prompt and
 * its notifications key on. Every interactive bash on the box has to emit them,
 * whoever it runs as and however it was started (`tailscale ssh` login, nested
 * `bash`, `sudo -i`), so the script is sourced from `/etc/bash.bashrc` rather
 * than any one account's rc file. The script itself is core's
 * (`SHELL_INTEGRATION_SCRIPT`, `@hermetic/core/shared`): the laptop parses what
 * it prints, so one module holds both halves.
 *
 * Three files, each idempotent through the same write path every rendered file
 * takes (content hash, then mode):
 *
 *   /etc/hermetic/shell-integration.bash   the script, root:root 0644
 *   /etc/bash.bashrc                       one hook line under a marker comment
 *   /etc/sudoers.d/hermetic-terminal       keeps the nonce across `sudo -i`
 */
import { SHELL_INTEGRATION_SCRIPT } from "@hermetic/core/shared";
import type { Host } from "../host.ts";
import { SUDOERS_DIR } from "./apt.ts";
import { ensureOwnership } from "./accounts.ts";
import type { ApplyResult } from "./shared.ts";

export const SHELL_INTEGRATION_PATH = "/etc/hermetic/shell-integration.bash";
export const BASHRC_PATH = "/etc/bash.bashrc";
export const SHELL_HOOK_MARKER = "# hermetic:shell-integration";
/** Guarded by `-r`, so a box whose script went missing still gets a working shell. */
export const SHELL_HOOK_LINE = `[ -r ${SHELL_INTEGRATION_PATH} ] && . ${SHELL_INTEGRATION_PATH}`;
/**
 * No dot in the name, ever: sudo skips any `sudoers.d` entry whose name holds a
 * `.` or a `~`, so `hermetic-terminal.conf` would be silently inert.
 */
export const SHELL_SUDOERS_PATH = `${SUDOERS_DIR}hermetic-terminal`;
/**
 * `sudo -i` starts a fresh login environment, which would drop the session's
 * nonce: the root shell would mint its own, and the laptop — pinned to the
 * first — would ignore every marker it printed. Keeping the one variable is the
 * whole policy; it grants nothing.
 */
export const SHELL_SUDOERS_CONTENT = 'Defaults env_keep += "HERMETIC_SI_NONCE"\n';

/** `apply`'s own idempotent writer: hash compare, mode fix, sudoers through visudo. */
export type ApplyWrite = (
  path: string,
  content: string,
  mode: string,
) => Promise<"content" | "mode" | null>;

/**
 * `/etc/bash.bashrc` with the hook in it exactly once.
 *
 * Unchanged when the hook line is already there once, wherever it sits — an
 * operator who moved it has a reason. Otherwise every copy of the hook and its
 * marker is taken out and one block is appended, which also repairs a file a
 * hand edit or an old bug left with two.
 */
export function withShellHook(existing: string | null): string {
  const text = existing ?? "";
  const lines = text.split("\n");
  if (lines.filter((line) => line === SHELL_HOOK_LINE).length === 1) return text;
  const kept = lines.filter((line) => line !== SHELL_HOOK_LINE && line !== SHELL_HOOK_MARKER);
  let body = kept.join("\n");
  if (body.length > 0 && !body.endsWith("\n")) body += "\n";
  return `${body}${SHELL_HOOK_MARKER}\n${SHELL_HOOK_LINE}\n`;
}

/**
 * Install the script, the hook and the sudoers drop-in.
 *
 * A sudoers body visudo rejects fails the apply (`writeSudoers`): a malformed
 * file in `sudoers.d` takes down the whole ruleset, and this box has no other
 * way for anyone to become root.
 */
export async function ensureShellIntegration(
  host: Host,
  write: ApplyWrite,
  result: ApplyResult,
  dry: boolean,
): Promise<void> {
  await write(SHELL_INTEGRATION_PATH, SHELL_INTEGRATION_SCRIPT, "0644");
  // A dry run over a box without the script has nothing to own yet, and the
  // real run writes it as root, which is already the owner it wants.
  const owned =
    dry && (await host.stat(SHELL_INTEGRATION_PATH)) === null
      ? "unchanged"
      : await ensureOwnership(
          host,
          {
            path: SHELL_INTEGRATION_PATH,
            content: SHELL_INTEGRATION_SCRIPT,
            mode: "0644",
            owner: "root",
            group: "root",
          },
          dry,
          { final: true },
        );
  if (owned === "changed") {
    if (!result.changed.includes(SHELL_INTEGRATION_PATH)) result.changed.push(SHELL_INTEGRATION_PATH);
    result.ownershipCorrected.push(SHELL_INTEGRATION_PATH);
  }

  const bashrc = await host.readFile(BASHRC_PATH);
  // The file's own mode is kept: this step adds a line, it does not own the file.
  const mode = (await host.stat(BASHRC_PATH))?.mode ?? "0644";
  await write(BASHRC_PATH, withShellHook(bashrc), mode);

  await write(SHELL_SUDOERS_PATH, SHELL_SUDOERS_CONTENT, "0440");
}
