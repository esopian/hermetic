/**
 * The nightly self-update (§4.4). It replaces the two jobs that used to run on
 * this schedule — a nightly config re-apply and a per-agent binary pin check —
 * and it does much less than either.
 *
 * Neither survived contact with the decision that a fleet runs *one* hermeticd
 * release, named in one place: the fleet manifest. So the nightly job is no
 * longer "make the box match its config"; it is "make the box match the release
 * the fleet is on". Config changes go out by rerendering and rerunning the
 * bootstrap stages, which is the same code path a first boot takes and
 * therefore the only one that has to be right.
 *
 * What it will not do:
 *
 *  - install an unverified binary — every byte is checked against the digest in
 *    the fleet manifest, because hermetic's own code comes from S3 and the
 *    digest is what makes that meaningful;
 *  - restart itself for a stage refresh — the stages are read at the next boot,
 *    so swapping them costs nothing and interrupting the heartbeat would;
 *  - do anything after the restart. `systemctl restart hermeticd.service` is
 *    always the last line, because nothing after it is guaranteed to run.
 *
 * That last line is also the one that can fail, and a box nobody is watching is
 * exactly where a failed restart hides: the new bytes are on disk, so every
 * later tick's digest comparison says "up to date" while the *running* process
 * is still the old release — permanently, silently. The running process cannot
 * hash itself out of that (it and the new binary share one path), so the swap
 * is recorded instead: a marker naming the pid that did it. Same pid on a later
 * tick ⇒ the restart never took effect ⇒ retry it. Different pid ⇒ the new
 * binary is up, and once it has stayed up the marker is cleared. Too many
 * different pids ⇒ it is crash-looping, and `hermeticd.prev` — kept beside the
 * binary for exactly this — goes back.
 */
import type { FleetManifest } from "@hermetic/core/schema";
import type { Aws } from "../aws.ts";
import type { Host } from "../host.ts";
import { cacheFleetManifest } from "../fleet.ts";
import { HERMETICD_PATH, STAGES_DIR, releaseStages, sha256Hex } from "../stages.ts";
import type { Emit } from "../events.ts";
import { opEvent } from "../events.ts";
import { AgentdError } from "../errors.ts";
import { INSTALL_LOCK_PATH, readInstallLock, takeInstallLock } from "../install-lock.ts";
import { readUpdateState, writeUpdateState, type UpdateState } from "./state.ts";
import { peekSwap, retryRestart, settleSwap } from "./swap.ts";
import { installRelease, pendingIntent } from "./install.ts";

export {
  EMPTY_UPDATE_STATE,
  MAX_PENDING_EVENTS,
  UPDATE_INTENT_PATH,
  UPDATE_STATE_PATH,
  clearInstallIntent,
  parseInstallIntent,
  parseSwapMarker,
  parseUpdateState,
  readInstallIntent,
  readUpdateState,
  writeInstallIntent,
  writeUpdateState,
} from "./state.ts";
export type { InstallIntent, PendingEvent, SwapMarker, UpdateState } from "./state.ts";
export {
  HERMETICD_PREV_PATH,
  MAX_SWAP_BOOTS,
  SWAP_SETTLE_MS,
  markSwapSettled,
  peekSwap,
  serviceMainPid,
  settleAfterUptime,
  settleSwap,
} from "./swap.ts";
export type { SwapDeps, SwapOutcome } from "./swap.ts";
export { HERMETICD_STAGED_PATH, MIN_FREE_SPACE_FACTOR } from "./install.ts";
export type { InstallOutcome } from "./install.ts";

/** The off-peak hour every agent updates in. The minute is per-agent. */
export const NIGHTLY_UTC_HOUR = 3;

/**
 * The kernel's own id for this boot, re-exported from the lock that also needs
 * it. It changes on reboot and cannot be reused within one, which makes it the
 * other half of the "are we the same process" question: a pid alone is
 * recycled, and a box that reboots into a pid that happens to match the one in
 * the marker would otherwise conclude its restart had not happened. Absent (a
 * container, a kernel without it) simply drops back to the pid comparison.
 */
export { BOOT_ID_PATH, readBootId } from "../install-lock.ts";

/**
 * The minute within the hour this particular agent updates on, derived from its
 * name.
 *
 * A single fixed minute means every box in the fleet does a `GetObject` on the
 * same `manifest.json` in the same second, and — on a release night — every box
 * downloads the same binary at once and restarts together. Spreading them over
 * the hour costs nothing (nobody is watching at 03:00 UTC) and makes a rollout
 * a ramp rather than a spike. Deterministic, so an operator can work out when a
 * given agent will move.
 */
export function nightlyMinuteFor(name: string): number {
  // FNV-1a: a few lines, stable across builds, and nothing here needs a
  // cryptographic hash — only an even spread over 60 buckets.
  let hash = 0x811c9dc5;
  for (let i = 0; i < name.length; i += 1) {
    hash ^= name.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash % 60;
}

/** Milliseconds from `now` to this agent's next nightly update slot. */
export function msUntilNightly(now: Date, name: string): number {
  const next = new Date(now.getTime());
  next.setUTCHours(NIGHTLY_UTC_HOUR, nightlyMinuteFor(name), 0, 0);
  if (next.getTime() <= now.getTime()) next.setUTCDate(next.getUTCDate() + 1);
  return next.getTime() - now.getTime();
}

export interface UpdateDeps {
  readonly host: Host;
  readonly aws: Aws;
  readonly name: string;
  readonly bucket: string;
  /** The version of the running binary — what the fleet manifest is compared to. */
  readonly hermeticdVersion: string;
  readonly emit?: Emit;
  /** Where a one-line human-readable notice goes; `main.ts`'s redacting `log`. */
  readonly log?: (message: string) => void;
  /**
   * This process's id. The one fact that distinguishes "the binary was swapped
   * and we restarted into it" from "the binary was swapped and we are still the
   * process that swapped it" — the two states a digest on disk cannot tell
   * apart. Injected so a test can be a second process without forking.
   */
  readonly pid?: number;
  /** See `SwapDeps.asService`: only the service's own restarts are counted. */
  readonly asService?: boolean;
}

/**
 * Write the events that happened where there was no client to write them.
 *
 * Best effort and never fatal, exactly like every other `appendEvent` here: an
 * event log entry is worth less than the update it describes.
 */
async function flushPendingEvents(deps: UpdateDeps, state: UpdateState): Promise<UpdateState> {
  if (state.pending_events.length === 0) return state;
  for (const event of state.pending_events) {
    await deps.aws
      .appendEvent({ name: deps.name, action: event.action, detail: event.detail })
      .catch(() => undefined);
  }
  const flushed = { ...state, pending_events: [] };
  await writeUpdateState(deps.host, flushed);
  return flushed;
}

export interface UpdateOptions {
  /** Report what would change and change nothing. */
  readonly check?: boolean;
  /**
   * Forget that this box refused a release, and forget any swap in flight.
   *
   * The refusal is deliberately sticky — a release that crash-looped here will
   * crash-loop again — but plenty of the reasons it might have crash-looped are
   * environmental: a full disk, a tailnet that was down, an SSM parameter that
   * had not been pushed yet. `--force` is the operator saying they fixed the
   * environment and want the same digest tried again, and it is the only thing
   * on the box that clears that memory.
   */
  readonly force?: boolean;
}

export interface UpdateResult {
  readonly running: string;
  readonly target: string;
  /** The digest of the binary on disk when the update started, if any. */
  readonly installedSha256: string | null;
  readonly upToDate: boolean;
  readonly binaryChanged: boolean;
  readonly stagesChanged: boolean;
  readonly restarted: boolean;
  /**
   * A binary was swapped in but this process is still the one that swapped it —
   * the restart did not take. Never `true` at the same time as `upToDate`: that
   * pair is the failure this field exists to make impossible to report.
   */
  readonly restartPending: boolean;
  /** The swap crash-looped and `hermeticd.prev` was put back (§6.5). */
  readonly rolledBack: boolean;
  /**
   * The manifest names a release this box has already failed on, so nothing was
   * installed. Cleared by the fleet naming a different digest — never by time,
   * because time does not fix a binary.
   */
  readonly blocked: boolean;
  /** Why nothing was installed, in one sentence, when `blocked` is true. */
  readonly blockedReason: string | null;
  /** The digest the fleet manifest pins for this release — what `--check` prints. */
  readonly targetSha256: string;
  readonly fleet: FleetManifest;
}

/**
 * True when `/opt/hermetic/stages` already holds exactly the files the manifest
 * names, byte for byte. A missing file, an extra-but-stale digest, a truncated
 * download: all of them read as "not up to date", which is the safe answer.
 */
export async function stagesUpToDate(host: Host, fleet: FleetManifest): Promise<boolean> {
  for (const { file, sha256 } of releaseStages(fleet)) {
    const bytes = await host.readBytes(`${STAGES_DIR}/${file}`);
    if (bytes === null || sha256Hex(bytes) !== sha256) return false;
  }
  return true;
}

export async function update(deps: UpdateDeps, opts: UpdateOptions = {}): Promise<UpdateResult> {
  const { host, aws, name, bucket } = deps;
  const emit = deps.emit ?? (() => {});
  const say = deps.log ?? (() => {});

  emit(opEvent("manifest", 0.1, "reading the fleet manifest", host.now()));
  const fleet = await aws.getFleetManifest(bucket);

  const running = deps.hermeticdVersion;
  const target = fleet.hermeticd.version;

  /**
   * The comparison is on the *digest of the binary on disk*, never on the
   * version label.
   *
   * A label is a build-time string; the manifest's is written by the laptop
   * that compiled the release. If the two ever disagree — a build that forgot
   * the `--define`, a hand-edited manifest — a label comparison is stale
   * forever: the box downloads, restarts, comes back reporting the same
   * version, and does it again. Every night, on every box. The digest cannot
   * disagree with itself: once the right bytes are installed, the update is
   * done, whatever either side calls it.
   */
  const entry = fleet.hermeticd.files["hermeticd"];
  if (!entry) {
    throw new AgentdError(
      "CHECKSUM_MISMATCH",
      `the fleet manifest names hermeticd ${target} but lists no digest for the binary; refusing to decide whether this box is up to date`,
      { version: target },
    );
  }
  if (opts.force === true && opts.check !== true) {
    const forgotten = await readUpdateState(host);
    if (forgotten.swap !== null || forgotten.failed_sha256 !== null) {
      emit(
        opEvent(
          "manifest",
          0.15,
          `--force: forgetting the refused release ${forgotten.failed_target ?? "(none)"} and any swap in flight`,
          host.now(),
        ),
      );
      await writeUpdateState(host, {
        ...forgotten,
        swap: null,
        failed_sha256: null,
        failed_target: null,
        failed_at: null,
        failed_notified: false,
        last_install_error: null,
        install_error_notified: false,
      });
    }
  }

  // Before any digest is compared, because a swap whose restart failed leaves
  // the *right* digest on disk under the *wrong* running process, and every
  // comparison below would read that as "up to date" forever.
  //
  // `serve` has normally settled it already, at the top of `run` where no
  // dependency can fail first (§6.5); this is the same call for the boxes and
  // subcommands that never reach that path, and it is a no-op when it has.
  const swap = opts.check ? await peekSwap(deps) : await settleSwap(deps);

  // Streamed, not read into memory: the binary is ~100 MB and this runs on
  // every tick of a long-lived process.
  const installedSha256 = await host.sha256File(HERMETICD_PATH);

  if (swap === "restart-pending") {
    const restarted = opts.check ? false : await retryRestart(deps);
    return {
      running,
      target,
      installedSha256,
      // The bytes are in place; this process is not running them. Whatever the
      // digest says, this box is not up to date.
      upToDate: false,
      binaryChanged: false,
      stagesChanged: false,
      restarted,
      restartPending: true,
      rolledBack: false,
      blocked: false,
      blockedReason: null,
      targetSha256: entry.sha256,
      fleet,
    };
  }

  if (swap === "rolled-back") {
    // The binary on disk is now the previous release, so `installedSha256`,
    // read above, is the one thing here that is already stale — and nothing
    // more should be installed on a box that just failed to run an install.
    return {
      running,
      target,
      installedSha256: await host.sha256File(HERMETICD_PATH),
      upToDate: false,
      binaryChanged: true,
      stagesChanged: false,
      restarted: true,
      restartPending: false,
      rolledBack: true,
      blocked: false,
      blockedReason: null,
      targetSha256: entry.sha256,
      fleet,
    };
  }

  let state = opts.check
    ? await readUpdateState(host)
    : await flushPendingEvents(deps, await readUpdateState(host));

  const binaryStale = installedSha256 !== entry.sha256;
  const stagesStale = !(await stagesUpToDate(host, fleet));

  /**
   * An install that started here and never finished (§6.5).
   *
   * Read before anything is decided, and it outranks every digest below: the
   * whole reason it exists is that the digest on disk answers "which release is
   * installed" and never "which release is running", so a box whose binary was
   * swapped by a process that then died reads as up to date while it executes
   * the previous one. An intent that is still about the release the manifest
   * names is finished — the remaining steps and the restart — whatever the
   * digest says.
   */
  const pending = await pendingIntent(host, state, entry, installedSha256, opts);

  /**
   * The release this box already failed on, still named by the manifest.
   *
   * Reinstalling it is a loop with no exit: swap, crash-loop, roll back, find
   * the binary "stale" again, swap again — nightly at best, once a minute while
   * a rollout request is pending. So it is refused until the fleet manifest
   * names a different digest, which is what a fix looks like from here. Nothing
   * is installed at all, stages included: they belong to the release being
   * refused, and putting them under an older binary is the ordering this module
   * exists to avoid.
   */
  if (binaryStale && state.failed_sha256 !== null && state.failed_sha256 === entry.sha256) {
    const detail =
      `refusing to install hermeticd ${target} again: this box rolled back from it at ` +
      `${state.failed_at ?? "an earlier update"} and the fleet manifest still names the same ` +
      `binary. It will install whatever the manifest names next.`;
    emit(opEvent("done", 1, detail, host.now()));
    if (!opts.check && !state.failed_notified) {
      await aws.appendEvent({ name, action: "update-failed", detail }).catch(() => undefined);
      await writeUpdateState(host, { ...state, failed_notified: true });
    }
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

  // The fleet has moved on to a different binary, so the old refusal is spent.
  // Kept in `state` as well as on disk: everything below writes the state back,
  // and writing the stale copy would resurrect the refusal.
  if (!opts.check && state.failed_sha256 !== null && state.failed_sha256 !== entry.sha256) {
    state = {
      ...state,
      failed_sha256: null,
      failed_target: null,
      failed_at: null,
      failed_notified: false,
    };
    await writeUpdateState(host, state);
  }

  if (!binaryStale && !stagesStale && pending === null) {
    // The label may still have moved (a rebuild of identical bytes); the box is
    // running the right code either way.
    await cacheFleetManifest(host, fleet);
    emit(opEvent("done", 1, `up to date at hermeticd ${target}`, host.now()));
    return {
      running,
      target,
      installedSha256,
      upToDate: true,
      binaryChanged: false,
      stagesChanged: false,
      restarted: false,
      restartPending: false,
      rolledBack: false,
      blocked: false,
      blockedReason: null,
      targetSha256: entry.sha256,
      fleet,
    };
  }

  if (opts.check) {
    const owed = pending?.restart_owed === true;
    const what = [
      binaryStale ? `binary ${running} → ${target}` : null,
      stagesStale ? "stages" : null,
      owed ? `an unfinished install of ${pending?.target} that still owes a restart` : null,
    ]
      .filter((x): x is string => x !== null)
      .join(", ");
    emit(opEvent("done", 1, `out of date: ${what}`, host.now()));
    // `--check` changes nothing, and the cache is a change: a box asked what it
    // would do must not come back having quietly adopted a new manifest.
    return {
      running,
      target,
      installedSha256,
      upToDate: false,
      binaryChanged: binaryStale,
      stagesChanged: stagesStale,
      restarted: false,
      restartPending: pending?.restart_owed === true,
      rolledBack: false,
      blocked: false,
      blockedReason: null,
      targetSha256: entry.sha256,
      fleet,
    };
  }

  const lock = await takeInstallLock(host, "update", { pid: deps.pid ?? process.pid });
  if (lock === null) {
    /**
     * The bootstrap runner is installing (§4.2), and two installers sharing
     * `/opt/hermetic/stages` is the thing the lock exists to prevent. Not an
     * error: the update is a nightly one and the next tick is a minute away.
     */
    const other = await readInstallLock(host);
    const detail =
      `another installer (${other?.holder ?? "unknown"}, pid ${other?.pid ?? "?"}) holds ` +
      `${INSTALL_LOCK_PATH}; nothing was installed`;
    say(detail);
    emit(opEvent("done", 1, detail, host.now(), "warn"));
    return {
      running,
      target,
      installedSha256,
      upToDate: false,
      binaryChanged: false,
      stagesChanged: false,
      restarted: false,
      restartPending: pending?.restart_owed === true,
      rolledBack: false,
      blocked: true,
      blockedReason: detail,
      targetSha256: entry.sha256,
      fleet,
    };
  }
  try {
    return await installRelease(deps, {
      state,
      fleet,
      entry,
      target,
      running,
      installedSha256,
      binaryStale,
      stagesStale,
      pending,
    });
  } finally {
    // Not reached when the restart takes effect — systemd stops this process on
    // the line above the return. That is what the lock's liveness check is for:
    // the file left behind names a pid that no longer exists, so the next
    // installer reads it as litter and takes it over (`install-lock.ts`).
    await lock.release();
  }
}
