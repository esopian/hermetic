/**
 * Download and install a release (§6.5): validate every byte of it on the safe
 * side of the intent record, swap the binary over a hard-linked backup, refresh
 * the stages, and hand the restart to the swap marker. `update()` in
 * `index.ts` decides whether any of this runs; `swap.ts` judges the result on
 * the next boot.
 */
import type { FleetManifest } from "@hermetic/core/schema";
import type { Host } from "../host.ts";
import { must } from "../host.ts";
import { cacheFleetManifest } from "../fleet.ts";
import {
  HERMETICD_PATH,
  installStages,
  releaseObjectKey,
  releaseStages,
  sha256Hex,
} from "../stages.ts";
import { opEvent } from "../events.ts";
import { AgentdError } from "../errors.ts";
import { redactValue } from "../redact.ts";
import { readBootId } from "../install-lock.ts";
import {
  clearInstallIntent,
  readInstallIntent,
  writeInstallIntent,
  writeUpdateState,
  type InstallIntent,
  type UpdateState,
} from "./state.ts";
import { HERMETICD_PREV_PATH } from "./swap.ts";
import type { UpdateDeps, UpdateOptions, UpdateResult } from "./index.ts";

/**
 * How much free space the binary's filesystem must have before a release is
 * fetched, as a multiple of the release's own size.
 *
 * Three: the new binary at `.hermeticd.new`, the backup at `hermeticd.prev`,
 * and the one already at `hermeticd`, all on `/` at once. Below that the swap
 * fails partway — and "partway" for a 100 MB write on a full disk is a
 * truncated file whose digest will not match, which is a refusal, but a noisy
 * one that repeats nightly instead of naming the actual problem.
 */
export const MIN_FREE_SPACE_FACTOR = 3;

/**
 * Where the new binary waits between being written and being sworn in.
 *
 * Dot-prefixed and therefore not on `PATH` in any useful sense: a plain
 * `hermeticd.new` left behind by a failed update sits in `/usr/local/bin` as an
 * executable that tab-completes next to the real one, and the release it holds
 * is by definition one this box could not verify or could not run.
 */
export const HERMETICD_STAGED_PATH = (() => {
  const slash = HERMETICD_PATH.lastIndexOf("/");
  return `${HERMETICD_PATH.slice(0, slash + 1)}.${HERMETICD_PATH.slice(slash + 1)}.new`;
})();

/** What `installRelease` needs that it cannot work out for itself. */
interface InstallArgs {
  readonly state: UpdateState;
  readonly fleet: FleetManifest;
  readonly entry: { key: string; sha256: string; size: number };
  readonly target: string;
  readonly running: string;
  readonly installedSha256: string | null;
  readonly binaryStale: boolean;
  readonly stagesStale: boolean;
  /** An unfinished install this one has to finish, or `null` for a fresh one. */
  readonly pending: InstallIntent | null;
}

/**
 * Install the release, in the order that makes every step recoverable (§6.5).
 *
 *   1. **validate** — fetch the binary, check its digest, prove it runs, then
 *      fetch and check every stage. Nothing the box uses has changed yet, so a
 *      throttled `GetObject` or a release built for the wrong architecture
 *      leaves this box exactly as it was;
 *   2. **intent** — write down what is about to happen: the digest the binary
 *      path will hold, the digest it is replacing, the stage set, and whether a
 *      restart is owed. From here a crash is recoverable, because the next
 *      process can read what this one meant to do;
 *   3. **swap** the binary, one rename over a hard-linked backup;
 *   4. **install** the stages;
 *   5. **record** the swap, which is what `settleSwap` reads, and clear the
 *      intent in the same breath — the marker owns the restart from here, and
 *      two records both claiming it would have the next process count one
 *      restart twice;
 *   6. **restart**, the line nothing runs after.
 *
 * The old order was 3, 4, 5, 6 with nothing before it, and the gap was between
 * 3 and 5: a stage that would not download left the new binary on disk, the old
 * process running, and no record of either — after which every tick compared
 * the digest, found the release it wanted, and reported a box still executing
 * last month's binary as up to date.
 */
export async function installRelease(deps: UpdateDeps, args: InstallArgs): Promise<UpdateResult> {
  const { host, aws, name, bucket } = deps;
  const emit = deps.emit ?? (() => {});
  const say = deps.log ?? (() => {});
  const { state, fleet, entry, target, running, installedSha256 } = args;
  const { binaryStale, stagesStale, pending } = args;

  // A resume whose binary is already in place swaps nothing and still owes the
  // restart: the bytes at the path are not the bytes this process is running.
  const restartOwed = binaryStale || pending?.restart_owed === true;

  // ── 1. validate the whole release ─────────────────────────────────────────
  let previousSha256: string | null = pending?.previous_sha256 ?? null;
  let staged = false;
  if (binaryStale) {
    emit(opEvent("fetch", 0.5, `fetching hermeticd ${target}`, host.now()));
    const outcome = await recordInstallErrors(deps, state, () =>
      prepareBinary(deps, entry, target, fleet.hermeticd.generation),
    );

    if (!outcome.ok) {
      /**
       * A release that will not run here, or that there is no room to install.
       * Recorded like a rollback, because the consequence is the same: the
       * manifest still names it, so without a memory the next tick refuses it
       * again from scratch, nightly, forever, saying nothing.
       */
      const detail = outcome.reason;
      emit(opEvent("done", 1, detail, host.now()));
      say(detail);
      await aws.appendEvent({ name, action: "update-failed", detail }).catch(() => undefined);
      await writeUpdateState(host, {
        ...state,
        failed_sha256: entry.sha256,
        failed_target: target,
        failed_at: host.now().toISOString(),
        failed_notified: true,
      });
      return {
        running,
        target,
        installedSha256,
        upToDate: false,
        binaryChanged: false,
        stagesChanged: false,
        restarted: false,
        restartPending: false,
        rolledBack: false,
        blocked: true,
        blockedReason: detail,
        targetSha256: entry.sha256,
        fleet,
      };
    }
    previousSha256 = outcome.previousSha256;
    staged = true;
  }
  if (stagesStale) await verifyReleaseStages(deps, fleet);

  // ── 2. write down what is about to happen ─────────────────────────────────
  await writeInstallIntent(host, {
    target,
    sha256: restartOwed ? entry.sha256 : null,
    previous_sha256: previousSha256,
    stages: releaseStages(fleet).map((stage) => stage.file),
    restart_owed: restartOwed,
    started_at: host.now().toISOString(),
    started_by_pid: deps.pid ?? process.pid,
    boot_id: await readBootId(host),
  });

  // ── 3. the binary ─────────────────────────────────────────────────────────
  if (staged) await commitBinary(host, previousSha256);

  // ── 4. the stages ─────────────────────────────────────────────────────────
  if (stagesStale) {
    emit(opEvent("stages", 0.8, `refreshing the stages for hermeticd ${target}`, host.now()));
    await installStages({ host, aws, bucket, fleet });
  }

  if (!restartOwed) {
    // A stage refresh: the stages are read at the next boot, so there is no
    // restart to wait on and the cache can be adopted here — everything this
    // run was going to change has already changed.
    await clearInstallIntent(host);
    await cacheFleetManifest(host, fleet);
    await aws
      .appendEvent({ name, action: "update", detail: `stages refreshed for hermeticd ${target}` })
      .catch(() => undefined);
    emit(opEvent("done", 1, `stages refreshed; no restart needed`, host.now()));
    return {
      running,
      target,
      installedSha256,
      upToDate: false,
      binaryChanged: false,
      stagesChanged: true,
      restarted: false,
      restartPending: false,
      rolledBack: false,
      blocked: false,
      blockedReason: null,
      targetSha256: entry.sha256,
      fleet,
    };
  }

  // ── 5. record the swap, and hand the restart to the marker ────────────────
  //
  // Recorded before the restart is asked for, because the restart is the line
  // nothing runs after. From here on the swap is a fact on disk: whoever runs
  // next — us, if systemd refused, or the new binary if it did not — reads this
  // and knows which of the two it is (`settleSwap`).
  await writeUpdateState(host, {
    ...state,
    swap: {
      target,
      sha256: entry.sha256,
      previous_sha256: previousSha256,
      swapped_at: host.now().toISOString(),
      swapped_by_pid: deps.pid ?? process.pid,
      boot_id: await readBootId(host),
      seen_by_pid: null,
      seen_at: null,
      boots: 0,
    },
  });
  // The marker covers everything the intent covered and one step more, so the
  // intent is cleared here rather than after a restart that may never return.
  // The two records are contiguous: before this line a crash is the intent's to
  // recover, after it the marker's.
  await clearInstallIntent(host);

  await aws
    .appendEvent({ name, action: "update", detail: `hermeticd ${running} → ${target}` })
    .catch(() => undefined);

  // ── 6. systemd restarts us; anything after this line may not run ──────────
  //
  // Which is why the fleet cache is *not* written here. Adopting the new
  // manifest is the new binary's first act (the up-to-date branch above), so a
  // swap whose restart never happened cannot leave the box claiming a release
  // it is not running.
  emit(opEvent("restart", 0.95, `restarting into hermeticd ${target}`, host.now()));
  await must(host, ["systemctl", "restart", "hermeticd.service"]);
  return {
    running,
    target,
    installedSha256,
    upToDate: false,
    binaryChanged: true,
    stagesChanged: stagesStale,
    restarted: true,
    restartPending: false,
    rolledBack: false,
    blocked: false,
    blockedReason: null,
    targetSha256: entry.sha256,
    fleet,
  };
}

/**
 * The unfinished install this tick has to finish, if there is one.
 *
 * Two of the three answers are "not this one":
 *
 *  - the swap marker already names the same digest, so the restart was asked
 *    for and `settleSwap` — which ran at the top of this tick — is what decides
 *    whether it landed. A second opinion here would count one restart twice and
 *    walk a healthy release into the crash-loop rollback;
 *  - the fleet has moved on to a different digest since the crash, so the
 *    intent names a release nobody wants. It is dropped, and the install that
 *    follows is a binary swap of its own, which discharges the restart it owed.
 *    (The case that leaves behind — a manifest that moved on to bytes this box
 *    somehow already has — is not reachable: nothing but an install puts them
 *    there, and an install restarts.)
 *
 * `--check` changes nothing at all, so it only ever reports what it found.
 */
export async function pendingIntent(
  host: Host,
  state: UpdateState,
  entry: { sha256: string },
  installedSha256: string | null,
  opts: UpdateOptions,
): Promise<InstallIntent | null> {
  const intent = await readInstallIntent(host);
  if (intent === null) return null;
  if (state.swap !== null && state.swap.sha256 === intent.sha256) {
    if (opts.check !== true) await clearInstallIntent(host);
    return null;
  }
  if (intent.sha256 !== null && intent.sha256 !== entry.sha256) {
    if (opts.check !== true) await clearInstallIntent(host);
    return null;
  }

  /**
   * A reboot is itself the restart an already-swapped binary was waiting for.
   * The digest check is essential: if the process died before the swap, a new
   * boot still runs the old bytes and must finish the install normally. When
   * both the boot identity and installed digest changed as intended, replaying
   * the restart would count a successful boot twice and can eventually walk a
   * healthy release into rollback.
   */
  const bootId = await readBootId(host);
  const rebootDischargedRestart =
    intent.restart_owed &&
    intent.sha256 !== null &&
    intent.sha256 === installedSha256 &&
    intent.boot_id !== null &&
    bootId !== null &&
    intent.boot_id !== bootId;
  if (rebootDischargedRestart) {
    if (opts.check !== true) await clearInstallIntent(host);
    return null;
  }
  if (opts.check === true) return intent;
  return intent;
}

/**
 * Fetch every stage the release names and check it against the manifest,
 * installing none of them.
 *
 * `installStages` does the same check, and it does it over the whole set before
 * it writes any of them — but it does it *after* the binary has been swapped,
 * which is the wrong side of the one step this box cannot take back cheaply. A
 * release is either completely fetchable or it is not, and finding out costs a
 * few kilobytes of shell scripts. The second fetch inside `installStages` is
 * the price of leaving the installer in one place rather than passing verified
 * bytes across a seam that would then have two ways to install a stage.
 */
async function verifyReleaseStages(deps: UpdateDeps, fleet: FleetManifest): Promise<void> {
  const version = fleet.hermeticd.version;
  // The keys come from the manifest: a release is an immutable generation, and
  // rebuilding `artifacts/<version>/stages/<file>` would name a different one.
  for (const { file, key, sha256 } of releaseStages(fleet)) {
    const bytes = await deps.aws.getObjectBytes(deps.bucket, key);
    const actual = sha256Hex(bytes);
    if (actual !== sha256) {
      throw new AgentdError(
        "CHECKSUM_MISMATCH",
        `${file} does not match the fleet manifest digest; refusing to install any part of hermeticd ${version}`,
        { key, file, expected: sha256, actual },
      );
    }
  }
}

/**
 * Run an install and remember what it threw.
 *
 * An update that fails once is weather: a throttled `GetObject`, a mirror
 * having a bad minute, a rename losing a race. The *same* error two ticks
 * running is a box that is stuck — and stuck is the failure an operator has no
 * other way to see, because the only symptom is a version that quietly stops
 * moving while the agent goes on heartbeating `ready`. The second occurrence
 * gets one event and no more.
 */
async function recordInstallErrors(
  deps: UpdateDeps,
  state: UpdateState,
  install: () => Promise<InstallOutcome>,
): Promise<InstallOutcome> {
  try {
    const outcome = await install();
    if (state.last_install_error !== null) {
      await writeUpdateState(deps.host, {
        ...state,
        last_install_error: null,
        install_error_notified: false,
      });
    }
    return outcome;
  } catch (e) {
    const message = redactValue(e instanceof Error ? e.message : String(e));
    const repeated = state.last_install_error === message;
    if (repeated && !state.install_error_notified) {
      await deps.aws
        .appendEvent({
          name: deps.name,
          action: "update-failed",
          detail: `hermeticd update has failed twice with the same error: ${message}`,
        })
        .catch(() => undefined);
    }
    await writeUpdateState(deps.host, {
      ...state,
      last_install_error: message,
      install_error_notified: repeated || state.install_error_notified,
    });
    throw e;
  }
}

/** What an install attempt did, or why it refused to do anything. */
export type InstallOutcome =
  | { readonly ok: true; readonly previousSha256: string | null }
  | { readonly ok: false; readonly reason: string };

/**
 * Everything a swap can refuse to do, done before the swap: fetch, verify,
 * prove the binary runs, and report the digest it would replace — the one thing
 * a rollback needs in order to know the copy it kept is the copy it saved.
 *
 * Split from the swap itself (`commitBinary`) so the release is validated on
 * the safe side of the intent record (§6.5): everything here either succeeds or
 * leaves the box exactly as it found it, so it can run before anything is
 * written down and be retried from scratch as often as the manifest likes.
 *
 *   1. refuse outright unless the filesystem can hold three copies (the new
 *      one, the backup, the one already there);
 *   2. refuse if the binary path is a symlink — replacing it would silently
 *      turn somebody's deliberate link into a regular file, and following it
 *      would install the release somewhere nobody is looking;
 *   3. fetch and check the digest;
 *   4. write the bytes to `.hermeticd.new` and **run them**: `hermeticd
 *      version` is read-only, needs no network and no credentials, and is the
 *      one question a digest cannot answer — a linux-amd64 build on an arm64
 *      box matches its digest perfectly and cannot be executed at all. A
 *      binary that fails this never reaches the path, so the crash-loop
 *      machinery never has to catch it.
 *
 * The staged file is left in place on success, for `commitBinary`; on every
 * other path it is removed, because a plain executable left in `/usr/local/bin`
 * is one this box could not verify or could not run.
 */
async function prepareBinary(
  deps: UpdateDeps,
  entry: { key: string; sha256: string; size: number },
  target: string,
  generation?: string,
): Promise<InstallOutcome> {
  const { host, aws, bucket } = deps;
  const emit = deps.emit ?? (() => {});

  const room = await freeSpaceFor(host, HERMETICD_PATH);
  const needed = entry.size * MIN_FREE_SPACE_FACTOR;
  if (room !== null && room < needed) {
    return {
      ok: false,
      reason:
        `refusing to fetch hermeticd ${target}: ${describeBytes(room)} free on the volume ` +
        `holding ${HERMETICD_PATH} and the swap needs ${describeBytes(needed)} ` +
        `(${MIN_FREE_SPACE_FACTOR}× the release) to hold the new binary, the backup and the ` +
        `one running`,
    };
  }

  const existing = await host.lstat(HERMETICD_PATH);
  if (existing?.isSymlink === true) {
    return {
      ok: false,
      reason:
        `refusing to update ${HERMETICD_PATH}: it is a symlink, and swapping a release into it ` +
        `would replace somebody's deliberate link with a regular file`,
    };
  }

  /**
   * The key the manifest records, not one rebuilt from the version: since
   * releases are immutable generations, `artifacts/<target>/hermeticd` is a
   * path the fleet may no longer be pointing at (and on a fleet pushed to
   * twice, a path holding some other release's bytes). The generation the
   * manifest names goes into the check for the same reason: a key under the
   * right version but the wrong generation is exactly the older binary this
   * swap exists to replace.
   */
  const key = releaseObjectKey(target, "hermeticd", entry.key, generation);
  const bytes = await aws.getObjectBytes(bucket, key);
  const actual = sha256Hex(bytes);
  if (actual !== entry.sha256) {
    throw new AgentdError("CHECKSUM_MISMATCH", `${key} digest mismatch`, {
      key,
      expected: entry.sha256,
      actual,
    });
  }

  let staged = false;
  try {
    // A staged file from a run that was killed is not this release's bytes.
    await host.remove(HERMETICD_STAGED_PATH);
    await host.writeBytes(HERMETICD_STAGED_PATH, bytes, "0755");

    emit(opEvent("fetch", 0.6, `checking hermeticd ${target} runs on this box`, host.now()));
    const smoke = await host.exec([HERMETICD_STAGED_PATH, "version"]);
    if (smoke.code !== 0) {
      return {
        ok: false,
        reason:
          `hermeticd ${target} matches its digest but will not run on this box: ` +
          `\`${HERMETICD_STAGED_PATH} version\` exited ${smoke.code}` +
          `${smoke.stderr.trim() ? ` (${redactValue(smoke.stderr.trim().split("\n")[0] ?? "")})` : ""}`,
      };
    }

    staged = true;
    return { ok: true, previousSha256: await host.sha256File(HERMETICD_PATH) };
  } finally {
    // Whatever happened short of "ready to swap", `/usr/local/bin` does not
    // keep a spare executable.
    if (!staged) await host.remove(HERMETICD_STAGED_PATH).catch(() => undefined);
  }
}

/**
 * Swear the staged release in: back the old binary up, then one rename.
 *
 * The order is the whole of it, because `/usr/local/bin/hermeticd` is the
 * `ExecStart` of both `hermeticd.service` and `hermeticd-bootstrap.service` and
 * therefore **may never be missing**: `Restart=always` restarts a process, it
 * does not recreate a file, so a box killed while that path did not exist would
 * come back to a unit systemd cannot start and no hermeticd to fix it. Bricked,
 * by a power cut in the wrong microsecond.
 *
 *   1. unlink any stale `hermeticd.prev`, then `link(hermeticd → hermeticd.prev)`
 *      — a second name for the inode that is already there, during which the
 *      original name never stops resolving (a filesystem that refuses hard
 *      links falls back to a copy, which is slower and just as safe);
 *   2. one `rename(.hermeticd.new → hermeticd)`, which replaces the entry
 *      atomically.
 *
 * At every instant of that, `/usr/local/bin/hermeticd` exists and is a complete
 * binary: the old one before step 2, the new one after. A failure at either
 * step leaves the old release running, and the staged file is removed on the
 * way out — the intent record, written before this was called, is what makes
 * the next process finish what this one started.
 */
async function commitBinary(host: Host, previousSha256: string | null): Promise<void> {
  try {
    if (previousSha256 !== null) {
      // `link` refuses to clobber, so the stale backup goes first. Only ever
      // one generation is kept: the release before this one is a rollback
      // target, the one before that is 100 MB of a root volume nobody will boot.
      await host.remove(HERMETICD_PREV_PATH);
      await backUpBinary(host);
    }
    await host.rename(HERMETICD_STAGED_PATH, HERMETICD_PATH);
  } finally {
    await host.remove(HERMETICD_STAGED_PATH).catch(() => undefined);
  }
}

/** Errors that mean "this filesystem does not do hard links", not "this failed". */
const NO_HARDLINK_CODES = new Set(["EPERM", "ENOSYS", "EOPNOTSUPP", "EXDEV", "EMLINK", "EACCES"]);

/**
 * `hermeticd → hermeticd.prev`, by hard link where the filesystem allows one
 * and by copy where it does not.
 *
 * The fallback matters because the failure is silent and total: on an overlayfs
 * or a filesystem mounted `nolink`, `link(2)` returns `EPERM` and a swap that
 * treated that as fatal would refuse every update forever on boxes where
 * everything else works. A copy costs a second and ~100 MB of reads, and keeps
 * the property that matters — the live path is never touched by either.
 */
async function backUpBinary(host: Host): Promise<void> {
  try {
    await host.link(HERMETICD_PATH, HERMETICD_PREV_PATH);
    return;
  } catch (e) {
    const code = (e as { code?: string }).code ?? "";
    if (!NO_HARDLINK_CODES.has(code)) throw e;
  }
  const bytes = await host.readBytes(HERMETICD_PATH);
  if (bytes === null) {
    throw new AgentdError("INTERNAL", `${HERMETICD_PATH} vanished while being backed up`);
  }
  // `writeBytes` is itself staged-and-renamed, so `.prev` is whole or absent.
  await host.writeBytes(HERMETICD_PREV_PATH, bytes, "0755");
}

/** Bytes available on the filesystem holding `path`; `null` when unknowable. */
async function freeSpaceFor(host: Host, path: string): Promise<number | null> {
  const slash = path.lastIndexOf("/");
  const fs = await host.statfs(slash <= 0 ? "/" : path.slice(0, slash));
  if (fs === null || fs.blockSize <= 0) return null;
  return fs.available * fs.blockSize;
}

function describeBytes(bytes: number): string {
  return `${Math.round(bytes / 1_000_000)} MB`;
}
