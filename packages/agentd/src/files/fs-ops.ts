/**
 * The files service's filesystem moves, each run as the right account.
 *
 * Under `/data/hermes` everything — create, move, unlink — happens **as
 * `hermes`**, never as root. Every directory there is the account's own, so the
 * account can swap any of them for a symlink at any moment, and a root `mv` or
 * `rm` would follow it somewhere the account cannot reach. As the account, the
 * worst a swapped symlink can do is point the account at its own files
 * (`account-dirs.ts` makes the same argument for directories).
 *
 * Under `/run/hermetic/drop` it is the other way round: the drop directories
 * are root's (0711), so the account cannot plant anything in them, and root
 * writes the secret and then hands the one file to the account with `chown`.
 */
import { HERMES_ACCOUNT, FILES_DROP_DIR } from "@hermetic/core/shared";
import { asHermes } from "../account-dirs.ts";
import type { Host } from "../host.ts";
import { must } from "../host.ts";
import { FilesError } from "./errors.ts";

/** `install -d -m 0700` as hermes: creates what is missing and sets each to 0700. */
export async function mkdirAsHermes(host: Host, ...paths: string[]): Promise<void> {
  await must(host, asHermes(["install", "-d", "-m", "0700", ...paths]));
}

/**
 * Remove a per-entry directory and what is in it, as hermes. Best effort: for
 * cleanup on a path that is already failing, and for the sweeper, whose disk
 * pass catches whatever this leaves behind.
 */
export async function removeTreeAsHermes(host: Host, path: string): Promise<void> {
  await host.exec(asHermes(["rm", "-rf", "--", path])).catch(() => undefined);
}

/**
 * `removeTreeAsHermes` for a caller that must know it worked — a user's
 * `DELETE`, which drops the index entry only once the bytes are gone. A
 * failure is an `INTERNAL` that names no path: `rm`'s stderr quotes it.
 */
export async function mustRemoveTreeAsHermes(host: Host, path: string): Promise<void> {
  const res = await host.exec(asHermes(["rm", "-rf", "--", path])).catch(() => null);
  if (res === null || res.code !== 0) {
    throw new FilesError(
      "INTERNAL",
      `removing the file from the box failed${res === null ? "" : ` (exit ${res.code})`}`,
    );
  }
}

/** What is at a path, as the account sees it. */
export type PathKind = "missing" | "regular" | "other";

/**
 * The shell `pathKindAsHermes` runs as the account: one answer on stdout,
 * `other` for a symlink (dangling or not) or anything but a regular file,
 * `regular`, or `missing`. Exit 0 whatever the answer, so a non-zero exit is
 * the check itself failing (`runuser` refusing, a fork failure) and never
 * reads as "nothing there". `$1` is the path, positional, never parsed as shell.
 */
export const PATH_KIND_SCRIPT =
  'if [ -L "$1" ]; then echo other; elif [ -f "$1" ]; then echo regular; ' +
  'elif [ -e "$1" ]; then echo other; else echo missing; fi';

/**
 * Ask, as hermes, what is at `path`: a regular file, nothing, or something
 * else (a symlink — dangling or not — a directory, a fifo). Never a root
 * `lstat` under `/data`: what root sees there is not what the account will
 * get, and the answer is only ever acted on as the account.
 *
 * Throws `INTERNAL` when the check could not be made: a caller that would
 * forget an entry on `missing` must not forget it because `runuser` failed.
 */
export async function pathKindAsHermes(host: Host, path: string): Promise<PathKind> {
  const res = await host.exec(asHermes(["sh", "-c", PATH_KIND_SCRIPT, "sh", path]));
  const answer = res.stdout.trim();
  if (res.code === 0 && (answer === "regular" || answer === "other" || answer === "missing")) {
    return answer;
  }
  throw new FilesError("INTERNAL", `checking a file on the box failed (exit ${res.code})`);
}

/**
 * Move `from` to `to` as hermes, never over anything. `mv -n -T`: `-T` so a
 * directory at `to` is not moved *into*, `-n` so nothing is replaced.
 *
 * `mv -n` onto an existing name has exited 0 or 1 depending on the coreutils
 * release, so the exit code is not the answer: whether `from` is still there
 * is. When it is, `CONFLICT` only if something is at `to` — the no-clobber
 * refusal — and `INTERNAL` otherwise (a missing parent, a full disk, `runuser`
 * failing). Either way `from` is left for the caller to clean up.
 */
export async function moveNoClobberAsHermes(host: Host, from: string, to: string): Promise<void> {
  const res = await host.exec(asHermes(["mv", "-n", "-T", "--", from, to]));
  const stillThere = (await pathKindAsHermes(host, from)) !== "missing";
  if (stillThere) {
    if ((await pathKindAsHermes(host, to)) !== "missing") {
      throw new FilesError("CONFLICT", "the destination already exists; nothing was overwritten");
    }
    throw new FilesError("INTERNAL", `moving the file into place exited ${res.code}`);
  }
  if (res.code !== 0) {
    throw new FilesError("INTERNAL", `moving the upload into place exited ${res.code}`);
  }
}

/** `/run/hermetic/drop/<request_id>`: one root-owned directory per secret request. */
export function dropDirFor(requestId: string): string {
  return `${FILES_DROP_DIR}/${requestId}`;
}

/**
 * Write an ephemeral secret into its drop directory and give the one file to
 * hermes. Root writes (atomic, 0600), into a directory only root can create
 * entries in, so there is nothing for the account to have planted; then
 * `chown` hands it the result. Refuses if the name is already taken.
 */
export async function writeDropSecret(
  host: Host,
  requestId: string,
  name: string,
  bytes: Uint8Array,
): Promise<string> {
  const dir = dropDirFor(requestId);
  await host.mkdir(FILES_DROP_DIR, "0711");
  await host.chmod(FILES_DROP_DIR, "0711");
  await host.mkdir(dir, "0711");
  await host.chmod(dir, "0711");
  const path = `${dir}/${name}`;
  if ((await host.lstat(path)) !== null) {
    throw new FilesError("CONFLICT", "a secret with that name is already in this request's drop");
  }
  await host.writeBytes(path, bytes, "0600");
  await must(host, ["chown", `${HERMES_ACCOUNT}:${HERMES_ACCOUNT}`, path]);
  return path;
}
