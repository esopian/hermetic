/**
 * Directories hermetic creates inside the `hermes` account's own home, and the
 * one rule that governs all of them: **hermeticd never creates or chowns a path
 * under `/data/hermes` as root.**
 *
 * Split out of `apply.ts` because it is a privilege boundary rather than a step
 * of the apply — the apply calls it twice, from two phases, for two different
 * directories, and the reasoning is the same reasoning both times.
 */
import type { AgentConfig } from "@hermetic/core/schema";
import { HERMES_ACCOUNT, HERMES_ACCOUNT_HOME } from "@hermetic/core/shared";
import { AgentdError } from "./errors.ts";
import type { Host } from "./host.ts";
import { must } from "./host.ts";

/** `/data/hermes/browser`, the parent every identity's profile lives under. */
export const BROWSER_PROFILE_ROOT = `${HERMES_ACCOUNT_HOME}/browser`;

/**
 * Run one command as the `hermes` account instead of as root.
 *
 * `runuser` rather than `su`: it execs the argv directly rather than through a
 * login shell, so the account's `nologin` shell does not stop it and there is no
 * shell to quote anything for.
 */
export function asHermes(argv: readonly string[]): string[] {
  return ["runuser", "-u", HERMES_ACCOUNT, "--", ...argv];
}

/**
 * Create a directory *inside the `hermes` account's home* — as the account,
 * never as root.
 *
 * This is a privilege boundary, not a tidiness rule. A directory entry is
 * governed by its **parent's** write bit, and `/data/hermes` is the account's
 * own home: the `hermes` uid can therefore replace any name directly under it —
 * `.hermes`, `browser`, anything — with a symlink pointing wherever it likes. A
 * root `install -d` follows that symlink and applies `-o hermes -g hermes -m
 * 0700` to whatever it lands on, which hands a root-owned directory to the
 * account. On a browser agent the account is what runs arbitrary web content,
 * so that is a real escalation and not a theoretical one.
 *
 * Running the create as `hermes` closes it by construction rather than by
 * timing. The account cannot gain anything it does not already have, whatever
 * the path resolves to, so there is nothing left for a symlink swapped in
 * between the check below and this call to win — which a check alone could
 * never promise, since `lstat` and `install` are two syscalls with a scheduler
 * in between.
 *
 * The `lstat` is still here, and it is only for the error. A symlink at one of
 * these paths is either the attempt above or an operator who meant something by
 * it, and an unprivileged `install -d` would answer either with whatever
 * `EACCES` the target happened to produce. Refusing by name says which path and
 * why; hermetic does not delete it, because a symlink an operator placed
 * deliberately is not hermetic's to remove.
 *
 * Not for `/data/hermes` itself. Its parent is `/data`, which is root's
 * (`disk.ts` makes the mount point `0755` as root), so no unprivileged process
 * can swap that name and the root `install -d` in `ensureAccounts` is safe —
 * and has to stay root, because it is what makes the home the account's in the
 * first place.
 */
export async function installAccountDir(host: Host, path: string, mode: string): Promise<void> {
  const found = await host.lstat(path);
  if (found?.isSymlink) {
    throw new AgentdError(
      "AGENT_DIR_UNSAFE",
      `${path} is a symlink. It is a directory the agent's own account owns, and hermetic will ` +
        "neither follow it nor replace it — remove it on the box, then re-apply.",
      { path },
    );
  }
  if (found !== null && !found.isDirectory) {
    throw new AgentdError("AGENT_DIR_UNSAFE", `${path} exists and is not a directory`, {
      path,
      mode: found.mode,
    });
  }
  await must(host, asHermes(["install", "-d", "-m", mode, path]));
}

/**
 * Make the profile root the agent's, so `hermetic-browser@`'s `ExecStartPre`
 * does not have to be root to create the profile under it.
 *
 * The unit's `ExecStartPre` runs `install -d` as `hermes` (`render-browser.ts`)
 * for the reason `installAccountDir` gives, and it can only do that if the
 * directory above it is already the account's. On a box built by the first
 * release of this stack it may not be, so this is where that is settled —
 * itself unprivileged, so settling it cannot be the escalation it prevents.
 *
 * Only for a manifest that lists browsers. An agent with none has no profile
 * root and should not be given one.
 */
export async function ensureBrowserProfileRoot(
  host: Host,
  manifest: AgentConfig,
  dry: boolean,
): Promise<void> {
  if ((manifest.browsers?.length ?? 0) === 0) return;
  if (dry) return;
  await installAccountDir(host, BROWSER_PROFILE_ROOT, "0700");
}
