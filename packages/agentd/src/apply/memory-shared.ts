/**
 * What the memory-service steps share (`memory-service.ts`, `memory-honcho.ts`):
 * how a command runs as the `hermes` account, the network retry budget, the
 * markers that record a finished step, and the pinned git checkout both the
 * Hindsight plugin and the honcho server come from.
 *
 * Split out so the two modules depend on this and not on each other.
 */
import { HERMES_ACCOUNT_HOME } from "@hermetic/core/shared";
import { asHermes, installAccountDir } from "../account-dirs.ts";
import type { Emit } from "../events.ts";
import { opEvent } from "../events.ts";
import type { Host } from "../host.ts";
import { must } from "../host.ts";
import { retry } from "./shared.ts";

/** In the service dir: the pin whose packages the venv last received. */
export const MEMORY_PIN_MARKER = ".hermetic-pin";
/** In a checkout (a plugin dir, honcho's source): the commit it was checked out at. */
export const PLUGIN_REF_MARKER = ".hermetic-ref";

/** Same budget as the Hermes checkout and its pip install: both are third parties. */
export const NET_ATTEMPTS = 3;
export const NET_RETRY_MS = 5_000;

/**
 * `HOME` is the account's because `runuser` keeps root's, and uv's cache, git's
 * config and curl's `.curlrc` would otherwise be read out of `/root`. The
 * account's home is also the working directory, because uv reads a `uv.toml`
 * out of whatever directory it starts in (`--no-config` as well, for the same
 * reason as `ensureAgentVenv`).
 */
export const ACCOUNT_EXEC = { cwd: HERMES_ACCOUNT_HOME } as const;
export const ACCOUNT_ENV = { HOME: HERMES_ACCOUNT_HOME } as const;
/** A clone that would otherwise block forever asking an unattended box to log in. */
const GIT_ENV = { ...ACCOUNT_ENV, GIT_TERMINAL_PROMPT: "0" } as const;

/** A small file written by the account (`tee`, fed on stdin), for the reason `memory-service.ts` gives. */
export async function writeAsHermes(host: Host, path: string, content: string): Promise<void> {
  await must(host, asHermes(["tee", path]), { stdin: content, ...ACCOUNT_EXEC });
}

/** A git checkout of `repo` at `sha` into `target`, as the account (`ensureCheckout`). */
export interface CheckoutSpec {
  readonly repo: string;
  readonly sha: string;
  /** Only this subdirectory (a sparse checkout, moved into place alone); null for the whole tree. */
  readonly subdir: string | null;
  readonly target: string;
  /** What the progress event calls it. */
  readonly label: string;
}

/**
 * `repo` at the commit `sha`, in `target`.
 *
 * A blobless clone (`--filter=blob:none`, sparse to `subdir` when one is
 * named) into a sibling dot-directory, checked out at the sha, then moved over
 * the old checkout. `PLUGIN_REF_MARKER` inside the checkout is the record: a
 * dir without it, or with another commit in it, is replaced; one that matches
 * is left alone, edits and all. Returns whether it checked anything out (or,
 * on a dry run, would).
 */
export async function ensureCheckout(
  host: Host,
  spec: CheckoutSpec,
  emit: Emit,
  dry: boolean,
  progress: number,
): Promise<boolean> {
  const { repo, sha, subdir, target } = spec;
  const marker = `${target}/${PLUGIN_REF_MARKER}`;
  if ((await host.readFile(marker))?.trim() === sha) return false;

  emit(opEvent("packages", progress, `checking out ${spec.label} (${sha.slice(0, 12)})`, host.now()));
  if (dry) return true;

  const slash = target.lastIndexOf("/");
  const parent = target.slice(0, slash);
  if ((await host.stat(parent))?.isDirectory !== true) await installAccountDir(host, parent, "0750");
  const clone = `${parent}/.${target.slice(slash + 1)}.clone`;
  const git = { env: { ...GIT_ENV }, ...ACCOUNT_EXEC };
  // The checkout fetches the blobs it needs, so it is network too and sits
  // inside the retry; each attempt starts from no clone at all.
  await retry(host, NET_ATTEMPTS, NET_RETRY_MS, async () => {
    await must(host, asHermes(["rm", "-rf", clone]), ACCOUNT_EXEC);
    await must(
      host,
      asHermes(["git", "clone", "--filter=blob:none", "--no-checkout", "--quiet", repo, clone]),
      git,
    );
    if (subdir !== null) {
      await must(
        host,
        asHermes(["git", "-C", clone, "sparse-checkout", "set", "--no-cone", subdir]),
        git,
      );
    }
    await must(host, asHermes(["git", "-C", clone, "checkout", "--quiet", sha]), git);
  });
  await must(host, asHermes(["rm", "-rf", target]), ACCOUNT_EXEC);
  await must(
    host,
    asHermes(["mv", "-T", subdir === null ? clone : `${clone}/${subdir}`, target]),
    ACCOUNT_EXEC,
  );
  if (subdir !== null) await must(host, asHermes(["rm", "-rf", clone]), ACCOUNT_EXEC);
  await writeAsHermes(host, marker, `${sha}\n`);
  return true;
}
