/**
 * The install a forward Hermes swap leaves, set aside instead of rebuilt over
 * (design: Hermes v0.23.1 adoption, section 5.5), so a rollback puts it back
 * with no network: no PyPI for the venv, no npm registry for the web and TUI
 * builds. Everything here is untracked in the checkout, so `git checkout` moves
 * none of it, and it sits on the root volume beside the checkout, so every
 * move is a rename. Kept until the swap settles (the gate passed, or the
 * backups were sealed with no gate pending), then deleted.
 */
import { HERMES_INSTALL_DIR } from "@hermetic/core/shared";
import { AgentdError } from "../errors.ts";
import { STATE_DIR } from "../fleet.ts";
import type { Host } from "../host.ts";
import { must } from "../host.ts";

export const HERMES_PREVIOUS_ROOT = `${STATE_DIR}/hermes-previous`;
/** Headroom left on the root volume after the venv copy, as the backup leaves on the data volume. */
const MIN_MARGIN = 256 * 1024 * 1024;

/** Under the checkout: the venv, the install's stamp and extras marker, the Node builds and their marker. */
const KEPT = [
  "venv",
  "install-stamp.json",
  ".hermetic-extras",
  "node_modules",
  "web/node_modules",
  "ui-tui/node_modules",
  "hermes_cli/web_dist",
  "ui-tui/dist",
  "web/.hermetic-built",
] as const;

/** Written once everything is moved: what the left install had, so a rollback knows what to delete. */
const DONE = "set-aside.json";

const stashOf = (ref: string): string => `${HERMES_PREVIOUS_ROOT}/${encodeURIComponent(ref)}`;
const parentOf = (path: string): string => path.slice(0, path.lastIndexOf("/"));

/**
 * A same-Python swap upgrades the venv in place, so before the checkout moves
 * the venv of `ref` is copied aside (`copyVenvAside`), and a rollback renames
 * the copy back with no package index. Refused with nothing changed when the
 * root volume has no room for the copy. Resumable: the copy lands under a
 * temporary name and is renamed into place, and one already there is kept,
 * because the checkout never moves before it exists.
 */
export async function copyVenvAside(host: Host, ref: string): Promise<void> {
  const stash = stashOf(ref);
  const live = `${HERMES_INSTALL_DIR}/venv`;
  const aside = `${stash}/venv`;
  if ((await host.lstat(aside)) !== null || (await host.lstat(live)) === null) return;
  const kib = Number.parseInt((await must(host, ["du", "-sk", "--", live])).stdout, 10);
  const fs = await host.filesystem(STATE_DIR);
  const needed = kib * 1024 + Math.max(Math.ceil((kib * 1024) / 10), MIN_MARGIN);
  if (!Number.isFinite(kib) || fs === null || fs.available < needed) {
    throw new AgentdError(
      "COMMAND_FAILED",
      `no room on the root volume to copy ${live} aside for a rollback: ` +
        `${Number.isFinite(kib) ? needed : "unknown"} bytes needed, ${fs?.available ?? "unknown"} free`,
      { needed: Number.isFinite(kib) ? needed : null, available: fs?.available ?? null },
    );
  }
  const part = `${stash}/.venv.partial`;
  await host.mkdir(stash, "0700");
  await host.remove(part);
  await must(host, ["cp", "-a", "--", live, part]);
  await host.rename(part, aside);
}

/**
 * Move the install of `ref` out of the checkout before the new one is built;
 * the venv only when `venv` (the new checkout pins another Python, so the
 * install would delete it anyway) or when `copyVenvAside` already copied it.
 * Resumable: a crash midway leaves the rest still in the checkout, untouched,
 * since nothing new is built before this finishes; once finished, a retry
 * moves nothing, because what the checkout holds by then is the new install's.
 */
export async function setAsidePrevious(host: Host, ref: string, venv: boolean): Promise<void> {
  const stash = stashOf(ref);
  if ((await host.lstat(`${stash}/${DONE}`)) !== null) return;
  await host.mkdir(stash, "0700");
  const kept: string[] = [];
  for (const rel of KEPT) {
    const live = `${HERMES_INSTALL_DIR}/${rel}`;
    const aside = `${stash}/${rel}`;
    if ((await host.lstat(aside)) === null) {
      if (rel === "venv" && !venv) continue;
      if ((await host.lstat(live)) === null) continue;
      await host.mkdir(parentOf(aside), "0700");
      await host.rename(live, aside);
    }
    kept.push(rel);
  }
  await host.writeFile(`${stash}/${DONE}`, `${JSON.stringify({ kept })}\n`, "0600");
}

/**
 * Put the set-aside install of `ref` back into the checkout, replacing what
 * the new install built there and deleting what the old one never had.
 * Idempotent, so a crashed rollback can run it again. `false` when nothing was
 * set aside for `ref` or no venv came back: the caller reinstalls instead.
 */
export async function restorePrevious(host: Host, ref: string): Promise<boolean> {
  const stash = stashOf(ref);
  if ((await host.lstat(stash)) === null) return false;
  const done = parseKept(await host.readFile(`${stash}/${DONE}`));
  let venv = false;
  for (const rel of KEPT) {
    const live = `${HERMES_INSTALL_DIR}/${rel}`;
    const aside = `${stash}/${rel}`;
    if ((await host.lstat(aside)) !== null) {
      await host.remove(live);
      await host.rename(aside, live);
      if (rel === "venv") venv = true;
    } else if (rel !== "venv" && done !== null && !done.includes(rel)) {
      // The new install's; the old one had none. (A venv not set aside was upgraded in place.)
      await host.remove(live);
    }
  }
  // An earlier, crashed run of this may have moved the venv back already.
  return done !== null ? done.includes("venv") : venv;
}

/** The swap settled: no rollback will need the old install. */
export async function dropPrevious(host: Host): Promise<void> {
  if ((await host.lstat(HERMES_PREVIOUS_ROOT)) !== null) await host.remove(HERMES_PREVIOUS_ROOT);
}

function parseKept(raw: string | null): string[] | null {
  if (raw === null) return null;
  try {
    const kept = (JSON.parse(raw) as { kept?: unknown }).kept;
    return Array.isArray(kept) && kept.every((k) => typeof k === "string") ? kept : null;
  } catch {
    return null;
  }
}
