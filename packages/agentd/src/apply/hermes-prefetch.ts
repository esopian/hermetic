/**
 * The network half of a Hermes version change, run before the units are held
 * (design: Hermes v0.23.1 adoption, section 5.7). The target ref's objects are
 * fetched into the existing repository and the uv, Node and pnpm release files
 * its checkout will install are downloaded and verified into `PREFETCH_DIR`.
 * Nothing is checked out, unpacked or relinked, so the running Hermes, and an
 * old-pin reapply after an abort, keep exactly the tools they had. A failure
 * here leaves Hermes running; the held part of the swap then needs no network
 * for any of these.
 */
import { HERMES_INSTALL_DIR } from "@hermetic/core/shared";
import { AgentdError } from "../errors.ts";
import type { Emit } from "../events.ts";
import { opEvent } from "../events.ts";
import { fetchHermesBundle } from "../hermes-source.ts";
import { must } from "../host.ts";
import {
  COMMIT_ID_RE,
  GIT_CLONE_ATTEMPTS,
  GIT_ENV,
  GIT_FETCH_TIMEOUT_S,
  GIT_RETRY_MS,
  HERMES_REPO,
  haveUvPin,
  pythonPin,
  syncsLocked,
  uvRelease,
} from "./hermes.ts";
import { PREFETCH_DIR, fetchPinned, nodeArch, prefetchNodeTools, prefetched } from "./node-web.ts";
import type { ApplyOptions } from "./shared.ts";
import { retry } from "./shared.ts";

/** A ref whose commit is in the repository, ready to check out without the network. */
export interface Prefetched {
  readonly ref: string;
  readonly commit: string;
  /** The mirrored-from upstream commit, when the objects came from the fleet's bundle. */
  readonly upstreamSha: string | null;
  /** The interpreter the fetched checkout pins. */
  readonly python: string;
}

const git = (...args: string[]): string[] => ["git", "-C", HERMES_INSTALL_DIR, ...args];

export async function prefetchHermes(opts: ApplyOptions, ref: string, emit: Emit): Promise<Prefetched> {
  const { host } = opts;
  emit(opEvent("packages", 0.3, `fetching hermes ${ref} before stopping hermes`, host.now()));
  // shortcut: a swap aborted after this succeeded leaves the files until the next pre-fetch
  // (installs still verify them), clear it in settleSwap if disk on small roots matters.
  await host.remove(PREFETCH_DIR);
  await host.mkdir(PREFETCH_DIR, "0700");
  try {
    const upstreamSha = await fetchObjects(opts, ref, emit);
    const commit = (await must(host, git("rev-parse", "FETCH_HEAD^{commit}"))).stdout.trim();
    if (!COMMIT_ID_RE.test(commit)) {
      throw new AgentdError("COMMAND_FAILED", `git named no commit for the fetched ${ref}`, {
        ref,
        commit,
      });
    }
    // Asked of the fetched commit: the working tree is still the running Hermes'.
    const pin = await host.exec(git("show", `${commit}:.python-version`));
    const python = pythonPin(pin.code === 0 ? pin.stdout : null);
    const pnpm = (await host.exec(git("cat-file", "-e", `${commit}:pnpm-lock.yaml`))).code === 0;
    if (syncsLocked(python) && !(await haveUvPin(host))) {
      const { url, sha256 } = uvRelease(nodeArch());
      await fetchPinned(host, url, prefetched(sha256), sha256);
    }
    await prefetchNodeTools(host, pnpm);
    return { ref, commit, upstreamSha, python };
  } catch (error) {
    // Nothing half-downloaded or refused stays behind for an install to take.
    await host.remove(PREFETCH_DIR);
    throw error;
  }
}

/** `fetchCheckout`'s two sources, fetch only: objects and `FETCH_HEAD`, the working tree unmoved. */
async function fetchObjects(opts: ApplyOptions, ref: string, emit: Emit): Promise<string | null> {
  const { host } = opts;
  const bundle = await fetchHermesBundle(
    host,
    ref,
    (message) => emit(opEvent("packages", 0.3, message, host.now(), "warn")),
    opts.getObject,
  );
  if (bundle !== null) {
    try {
      await must(host, git("fetch", bundle.path, ref), { env: { ...GIT_ENV } });
    } finally {
      await host.remove(bundle.path);
    }
    return bundle.upstreamSha;
  }
  await retry(host, GIT_CLONE_ATTEMPTS, GIT_RETRY_MS, () =>
    must(host, ["timeout", GIT_FETCH_TIMEOUT_S, ...git("fetch", "--depth", "1", HERMES_REPO, ref)], {
      env: { ...GIT_ENV },
    }),
  );
  return null;
}
