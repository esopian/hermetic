/**
 * A Hermes version change on a box that already runs one (design: Hermes
 * v0.23.1 adoption, W13, sections 5.3 and 5.5, decision D9).
 *
 * A new Hermes migrates its stores the first time it opens them, and that is
 * not reversible, so a version change is fenced: the units held, stopped and
 * verified inactive; a validated backup of `$HERMES_HOME` before the checkout
 * moves forward; on a downgrade, the backup taken when the target version was
 * left restored before its checkout is installed. A forward move is then
 * gated on the new Hermes actually coming up, and anything that fails between
 * the checkout moving and that gate passing is rolled back inside the same
 * apply, so the box ends on one consistent version and old Hermes never opens
 * migrated stores.
 *
 * Backups are keyed by the ref being left (`hermes-<ref>-<time>`) and looked
 * up by the ref being returned to, so both sides of a downgrade agree.
 */
import { type AgentConfig, compareVersions } from "@hermetic/core/schema";
import { HERMES_DASHBOARD_UNIT, HERMES_GATEWAY_UNIT, HERMES_HOME } from "@hermetic/core/shared";
import { dropApplyPendingUnit, readApplyPending, writeApplyPending } from "../apply-pending.ts";
import { AgentdError } from "../errors.ts";
import type { Emit } from "../events.ts";
import { HERMES_UPGRADE_PHASE, opEvent } from "../events.ts";
import { STATE_DIR } from "../fleet.ts";
import { HERMES_HEALTH_URL, UNIT_SHOW_PROPERTIES, parseUnitState } from "../heartbeat.ts";
import type { Host } from "../host.ts";
import { must } from "../host.ts";
import { APPLIED_CONFIG_PATH } from "../manifest.ts";
import { HERMES_USER, ensureHermesHomeOwnership } from "./accounts.ts";
import {
  HERMES_BACKUP_ROOT,
  type UnfinishedRestore,
  backupHermesHome,
  completedRestore,
  restoreHermesHome,
  restoredBefore,
  sealBackups,
  unfinishedRestores,
} from "./hermes-backup.ts";
import { dropPrevious } from "./hermes-previous.ts";
import { UNIT_DIR } from "./shared.ts";

/** The install as it stood before this apply. */
export interface HermesInstalled {
  readonly ref: string;
  /** `HEAD`, to return to without the network; `null` when git could not say. */
  readonly commit: string | null;
  /** From an install stamp valid for `HEAD`; `null` is a pre-0.22 checkout, or one that cannot say. */
  readonly version: string | null;
  /** The ref marker's mirrored-from upstream commit, written back on a rollback. */
  readonly upstreamSha: string | null;
}

/** The parts of `ensureHermes` a swap runs, in its order. */
export interface SwapSteps {
  /** Before the hold: fetch `ref` and download what its install needs, moving and installing nothing. */
  prefetch(ref: string): Promise<void>;
  /** Fetch `ref` and move the checkout onto it; `moving` fires just before the working tree changes. */
  fetch(ref: string, moving: () => void): Promise<string | null>;
  /** After the checkout moved, before the install: move the install of `ref` aside for a rollback. */
  setAside(ref: string): Promise<void>;
  /** Put back what `setAside` moved, with no network; the extras spec, or `null` to reinstall. */
  restorePrevious(from: HermesInstalled): Promise<string | null>;
  /** Install whatever the checkout now holds; a `null` version skips the version cross-check. */
  install(version: string | null, rollback?: boolean): Promise<string>;
  /** Record a finished install: the extras marker, then the ref marker last. */
  record(ref: string, upstreamSha: string | null, installed: string): Promise<void>;
  /** Before the checkout moves: copy aside a venv the new install would upgrade in place. */
  keepVenv(ref: string): Promise<void>;
  /** Read the install being left; run once the units are down. */
  inspect(ref: string): Promise<HermesInstalled>;
  /** Put the checkout back on the install that was there before this apply. */
  checkoutPrevious(from: HermesInstalled): Promise<void>;
}

export interface SwapInput {
  readonly host: Host;
  readonly emit: Emit;
  readonly ref: string;
  readonly version: string;
  /** The ref the box is on (its ref marker). */
  readonly fromRef: string;
  /** The Hermes units with a file on disk, already recorded as owed a restart. */
  readonly units: readonly string[];
  /** The manifest's browser session units (`browserSession`), stopped while held. */
  readonly browsers: readonly string[];
  readonly unfinished: readonly UnfinishedRestore[];
  readonly steps: SwapSteps;
}

/** A swap once the install being left has been read. */
type Swap = SwapInput & { readonly from: HermesInstalled };

/** A step of the swap `agent history` also carries (`withUpgradeHistory`). */
function milestone(host: Host, emit: Emit, message: string, level?: "warn"): void {
  emit(opEvent(HERMES_UPGRADE_PHASE, 0.3, message, host.now(), level));
}

// --- the hold ----------------------------------------------------------------

/**
 * While this file exists the Hermes units do not start: each carries a drop-in
 * whose `ConditionPathExists=!` names it, and systemd skips a start whose
 * condition fails. Not `systemctl mask --runtime`: its link under /run is
 * shadowed by a unit file in /etc/systemd/system, which comes first on the
 * search path (systemd.unit(5)), and /run is gone after a reboot. This file is
 * on the root volume, so a box that reboots mid-swap does not start Hermes on
 * a half-installed checkout; the next apply's units phase removes it.
 */
export const HERMES_HOLD_PATH = `${STATE_DIR}/hermes-upgrade.hold`;
/** The drop-in that makes `unit` honour the hold. */
export const holdDropIn = (unit: string): string => `${UNIT_DIR}/${unit}.d/hermetic-hold.conf`;
const HOLD_CONF =
  "# Written by hermeticd: this unit does not start while a Hermes version change holds it.\n" +
  `[Unit]\nConditionPathExists=!${HERMES_HOLD_PATH}\n`;

// While held, a manual `systemctl start` of a Hermes unit is a silent no-op (its condition fails).
async function hold(host: Host, units: readonly string[]): Promise<void> {
  let wrote = false;
  for (const unit of units) {
    if ((await host.readFile(holdDropIn(unit))) === HOLD_CONF) continue;
    await host.mkdir(`${UNIT_DIR}/${unit}.d`, "0755");
    await host.writeFile(holdDropIn(unit), HOLD_CONF, "0644");
    wrote = true;
  }
  if (wrote) await must(host, ["systemctl", "daemon-reload"]);
  await host.mkdir(STATE_DIR, "0755");
  // The first hold's time stays: no Hermes has run since, which a retry relies on.
  if ((await host.lstat(HERMES_HOLD_PATH)) === null) {
    await host.writeFile(HERMES_HOLD_PATH, `${host.now().toISOString()}\n`, "0644");
  }
}

/**
 * Whether a Hermes swap is unfinished on this box: units held, or a forward
 * swap not yet seen healthy. Such a box is never "already converged".
 */
export async function hermesHeld(host: Host): Promise<boolean> {
  return (
    (await host.lstat(HERMES_HOLD_PATH)) !== null ||
    (await host.lstat(HERMES_SWAP_PATH)) !== null ||
    (await host.lstat(HERMES_DOWNGRADE_PATH)) !== null
  );
}

export async function releaseHold(host: Host): Promise<void> {
  await host.remove(HERMES_HOLD_PATH);
}

async function startUnits(host: Host, units: readonly string[]): Promise<void> {
  await releaseHold(host);
  for (const unit of units) await host.exec(["systemctl", "start", unit]);
}

// --- the browser session -----------------------------------------------------

/** Every unit of the manifest's browser identities (`xvfb@<name>` … `hermetic-browser@<name>`), in start order. */
export function browserSession(manifest: Pick<AgentConfig, "units" | "browsers">): string[] {
  const names = (manifest.browsers ?? []).map((b) => `@${b.name}.service`);
  return manifest.units.filter((unit) => names.some((n) => unit.endsWith(n)));
}

/**
 * The browser session is down while held: on the smallest size the web build
 * does not fit beside Chrome (the kernel killed it), and nothing drives Chrome
 * while Hermes is down. The running units are recorded as owed a restart
 * before they stop, as the Hermes units are, so the units phase of this apply,
 * of a rollback's re-apply or of a resumed swap starts them again.
 */
async function stopBrowsers(
  host: Host,
  say: (message: string) => void,
  units: readonly string[],
): Promise<void> {
  const running: string[] = [];
  for (const unit of units) if (!stopped(await unitState(host, unit))) running.push(unit);
  if (running.length === 0) return;
  const owed = await readApplyPending(host);
  await writeApplyPending(
    host,
    [...new Set([...(owed?.units ?? []), ...running])],
    owed?.config_hash ?? null,
  );
  for (const unit of [...running].reverse()) {
    say(`stopping ${unit} to free memory for the hermes install`);
    await host.exec(["systemctl", "stop", unit]);
  }
}

/**
 * A way out of the hold that skips the units phase: start the browser units
 * still owed. One started from down runs on the files on disk, so it owes
 * nothing more; one already up (or a failed start) stays owed its restart.
 */
export async function startOwedBrowsers(host: Host, units: readonly string[]): Promise<void> {
  if (units.length === 0) return;
  const owed = new Set((await readApplyPending(host))?.units ?? []);
  for (const unit of units) {
    if (!owed.has(unit) || !stopped(await unitState(host, unit))) continue;
    if ((await host.exec(["systemctl", "start", unit])).code === 0) {
      await dropApplyPendingUnit(host, unit);
    }
  }
}

// --- the gate record ---------------------------------------------------------

/**
 * A forward swap whose new Hermes has not yet been seen healthy: written once
 * the backup exists, removed when the gate passes or the swap is rolled back.
 * It survives a crash, so the next apply still gates (or rolls back) the swap.
 */
export const HERMES_SWAP_PATH = `${STATE_DIR}/hermes-swap.json`;

export interface SwapGate {
  readonly to_ref: string;
  readonly to_version: string;
  /** The install to return to, as read before the checkout first moved. */
  readonly from: HermesInstalled;
  readonly backup: string;
  readonly units: readonly string[];
  /**
   * Set before a rollback's restore: from then on every apply finishes the
   * rollback, never starting the new Hermes on a state put back for the old one.
   */
  readonly rolling_back?: {
    /** When the rollback began: a restore completed since is its own. */
    readonly since: string;
    readonly cause: Record<string, unknown>;
  };
  /** Applies that found this swap held after hermeticd died mid-swap (`countHeldResume`). */
  readonly resumes?: number;
}

export async function readSwapGate(host: Host): Promise<SwapGate | null> {
  const raw = await host.readFile(HERMES_SWAP_PATH);
  if (raw === null) return null;
  try {
    const g = JSON.parse(raw) as Partial<SwapGate> & { from?: Partial<HermesInstalled> };
    const opt = (v: unknown): v is string | null => v === null || typeof v === "string";
    const f = g.from;
    const rb = g.rolling_back;
    if (
      (rb !== undefined &&
        (typeof rb?.since !== "string" || typeof rb.cause !== "object" || rb.cause === null)) ||
      typeof g.to_ref !== "string" ||
      typeof g.to_version !== "string" ||
      typeof g.backup !== "string" ||
      !Array.isArray(g.units) ||
      !g.units.every((u) => typeof u === "string") ||
      typeof f?.ref !== "string" ||
      !opt(f.commit) ||
      !opt(f.version) ||
      !opt(f.upstreamSha)
    ) {
      return null;
    }
    return { ...g, from: f } as SwapGate;
  } catch {
    return null;
  }
}

export async function clearSwapGate(host: Host): Promise<void> {
  await host.remove(HERMES_SWAP_PATH);
}

async function writeSwapGate(host: Host, gate: SwapGate): Promise<void> {
  await host.writeFile(HERMES_SWAP_PATH, `${JSON.stringify(gate)}\n`, "0600");
}

/**
 * How many times an apply resumes a held swap that hermeticd died in before the
 * next one rolls it back instead. One: a death while held is far more likely the
 * swap itself (a build hermeticd's unit was OOM-killed for) than chance, and
 * every retry keeps Hermes down for another whole install.
 */
export const HERMES_SWAP_RESUME_LIMIT = 1;

/**
 * An apply starting on `gate` with the units held: hermeticd died in this swap,
 * since every failure it survives settles the record. Counts the resume, or
 * returns why the swap is to be rolled back instead. Counted here, not at
 * `serve` start, so a self-update restart (which never cuts an apply short: it
 * takes the apply lock) costs nothing.
 */
export async function countHeldResume(host: Host, gate: SwapGate): Promise<Error | null> {
  const resumes = Number.isInteger(gate.resumes) ? (gate.resumes as number) : 0;
  if (resumes < HERMES_SWAP_RESUME_LIMIT) {
    await writeSwapGate(host, { ...gate, resumes: resumes + 1 });
    return null;
  }
  return new Error(
    `hermeticd stopped during the held swap to ${gate.to_ref} ${resumes + 1} times; ` +
      "rolled back rather than resumed again",
  );
}

/**
 * A downgrade whose Hermes has not yet been seen up: written before a
 * patch-level downgrade moves the checkout, or before a restored state's
 * install, and removed when its gate passes (`verifySwap`). A retry after a
 * crash then knows the checkout may have moved.
 */
export const HERMES_DOWNGRADE_PATH = `${STATE_DIR}/hermes-downgrade.json`;

interface DowngradeGate {
  readonly to_ref: string;
  /** `null`: a pre-0.22 install a failed rollback put back, which cannot say. */
  readonly to_version: string | null;
  readonly units: readonly string[];
  /** Within one major.minor: nothing restored, only the checkout moves. Also a failed rollback's restart owed. */
  readonly patch: boolean;
}

async function readDowngrade(host: Host): Promise<DowngradeGate | null> {
  try {
    const d = JSON.parse(
      (await host.readFile(HERMES_DOWNGRADE_PATH)) ?? "null",
    ) as Partial<DowngradeGate> | null;
    return typeof d?.to_ref === "string" &&
      (typeof d.to_version === "string" || d.to_version === null) &&
      typeof d.patch === "boolean" &&
      Array.isArray(d.units) &&
      d.units.every((u) => typeof u === "string")
      ? (d as DowngradeGate)
      : null;
  } catch {
    return null;
  }
}

async function markDowngrade(input: SwapInput, patch: boolean): Promise<void> {
  const record: DowngradeGate = {
    to_ref: input.ref,
    to_version: input.version,
    units: input.units,
    patch,
  };
  await input.host.writeFile(HERMES_DOWNGRADE_PATH, `${JSON.stringify(record)}\n`, "0600");
}

/**
 * `ref`'s install is back but its Hermes was never seen up: `units` are owed a
 * restart, gated by `verifySwap` on the next apply (a failure there holds Hermes
 * for an operator), and the recorded config, which a re-apply may have written,
 * is not current.
 */
async function oweGatedStart(
  host: Host,
  ref: string,
  version: string | null,
  units: readonly string[],
): Promise<void> {
  await host.remove(APPLIED_CONFIG_PATH);
  const owed = await readApplyPending(host);
  await writeApplyPending(
    host,
    [...new Set([...(owed?.units ?? []), ...units])],
    owed?.config_hash ?? null,
  );
  const gate: DowngradeGate = { to_ref: ref, to_version: version, units, patch: true };
  await host.writeFile(HERMES_DOWNGRADE_PATH, `${JSON.stringify(gate)}\n`, "0600");
}

/**
 * The swap is over for `ref`: a record for another ref is stale and goes, and
 * unless a gate for `ref` is still pending every backup is sealed, so a later
 * swap takes a fresh copy rather than reusing one the state has moved past.
 */
export async function settleSwap(host: Host, ref: string): Promise<void> {
  if ((await readDowngrade(host))?.to_ref !== ref) await host.remove(HERMES_DOWNGRADE_PATH);
  const gate = await readSwapGate(host);
  if (gate !== null && gate.to_ref === ref) return;
  if (gate !== null || (await host.lstat(HERMES_SWAP_PATH)) !== null) await clearSwapGate(host);
  await sealBackups(host);
  await dropPrevious(host);
}

/**
 * Refuses `ref` when a failed downgrade restored the state for another ref: its
 * restore finished and the units stayed held since, so the state on disk is the
 * older ref's and the state it replaced is only in the restore's moved-aside
 * copy. `ref` started on it would report success on the wrong state.
 * shortcut: refused rather than putting back the moved-aside state (no backup
 * describes it); restore it when an operator should not have to.
 */
export async function refuseStrandedRestore(host: Host, ref: string): Promise<void> {
  const down = await readDowngrade(host);
  if (down === null || down.patch || down.to_ref === ref) return;
  const heldSince = (await host.readFile(HERMES_HOLD_PATH))?.trim() || null;
  if (heldSince === null || !(await restoredBefore(host, null, down.to_ref, heldSince))) return;
  throw stranded(down.to_ref, ref);
}

function stranded(restoredFor: string, ref: string, movedAside?: string): AgentdError {
  return new AgentdError(
    "HERMES_RESTORE_FAILED",
    `the hermes state was restored for ${restoredFor}, which was never seen up on it; hermes ${ref} ` +
      `does not start on it, and the state it replaced is under ${HERMES_BACKUP_ROOT}/post-*. ` +
      "The units stay held",
    {
      restored_for: restoredFor,
      to_version: ref,
      ...(movedAside !== undefined ? { moved_aside: movedAside } : {}),
      backup_root: HERMES_BACKUP_ROOT,
      hold: HERMES_HOLD_PATH,
    },
  );
}

// --- the swap ----------------------------------------------------------------

/** Whether the move to `ref` is a downgrade, judged from the install being left. */
async function isDowngrade(input: Swap): Promise<boolean> {
  const { host, ref, version, from, unfinished } = input;
  if (from.ref === ref || unfinished.some((u) => u.toVersion === ref)) return true;
  if ((await readDowngrade(host))?.to_ref === ref) return true;
  // A retry after the checkout already moved: the stamp no longer describes the
  // install being left, but the restore this downgrade made is on record.
  if (await restoredBefore(host, from.ref, ref)) return true;
  return from.version !== null && compareVersions(version, from.version) < 0;
}

export async function swapHermes(input: SwapInput): Promise<void> {
  const { host, emit, ref, version, fromRef, units, browsers, unfinished, steps } = input;
  const say = (message: string, level?: "warn"): void =>
    emit(opEvent("packages", 0.3, message, host.now(), level));

  // Before any unit stops: the marker may still name the ref the restored state replaced.
  await refuseStrandedRestore(host, ref);
  // Set by an unfinished swap's first hold; no Hermes has run since.
  const heldSince = (await host.readFile(HERMES_HOLD_PATH))?.trim() || null;
  const wasActive: string[] = [];
  for (const unit of units) if (!stopped(await unitState(host, unit))) wasActive.push(unit);

  // A record whose ref never reached the marker: an earlier attempt crashed
  // after writing it, with the units held since, and may have moved the
  // checkout (to `ref`, or to a ref re-pinned since). Its install is the one
  // to return to, and only its backup is reused.
  const recorded = await readSwapGate(host);
  const pending = recorded !== null && recorded.to_ref !== fromRef ? recorded : null;
  // A downgrade that crashed before its gate passed: its checkout may have moved.
  // One whose ref reached the marker was installed whole (the marker is written
  // last); a move to another ref starts from it as from any install, and the
  // record stays for that ref's own gate until this swap's gate record replaces it.
  const recordedDowngrade = await readDowngrade(host);
  const downgrade = recordedDowngrade?.to_ref === fromRef && ref !== fromRef ? null : recordedDowngrade;

  // Until the checkout moves (with no crashed restore, swap or downgrade behind
  // this apply), a failure leaves the box as it was, so its units are started again:
  // the ones that ran, or all of them when an earlier attempt's hold stopped them or
  // `fromRef` is owed a start (a failed rollback's units are down, not held).
  let untouched = unfinished.length === 0 && pending === null && downgrade === null;
  const owed = heldSince !== null || recordedDowngrade?.to_ref === fromRef;
  const restart = owed ? units : wasActive;
  // The version installed from `fromRef`, once read: what a restarted unit must answer with.
  let running: string | null = null;
  // An in-swap rollback's restart: the old Hermes, and the browser session the hold stopped.
  const restartOld = async (): Promise<void> => {
    await startUnits(host, units);
    await startOwedBrowsers(host, browsers);
  };
  const abort = async (cause: unknown, started: readonly string[]): Promise<never> => {
    try {
      // A record for `ref` is this attempt's, and the checkout never moved: left, it would hold Hermes.
      if ((await readDowngrade(host))?.to_ref === ref) await host.remove(HERMES_DOWNGRADE_PATH);
      await startUnits(host, started);
      await startOwedBrowsers(host, browsers);
      await requireUp(host, emit, started, { to_ref: fromRef, to_version: running });
    } catch (failure) {
      // As after a failed rollback: the next apply restarts the old Hermes and gates it.
      if (started.length > 0) {
        await oweGatedStart(host, fromRef, running, started).catch(() => undefined);
      }
      throw new AgentdError(
        "HERMES_ROLLBACK_FAILED",
        `hermes ${ref} was not installed (${messageOf(cause)}), and hermes ${fromRef} did not ` +
          `start again: ${messageOf(failure)}`,
        {
          cause: describe(cause),
          reason: `the restart of ${fromRef} failed: ${messageOf(failure)}`,
          rollback: describe(failure),
          from_ref: fromRef,
          to_ref: ref,
          old_install_restored: true,
        },
      );
    }
    throw aborted(cause, fromRef, ref);
  };

  // The network half of a forward swap, while Hermes still runs. Judged again
  // once the units are down; a ref that then turns out a downgrade fetches as before.
  if (untouched) {
    try {
      const before = await steps.inspect(fromRef);
      running = before.version;
      // Unknown, a downgrade would pass for an upgrade and start an older Hermes on newer stores.
      if (before.version === null) {
        throw new AgentdError(
          "HERMES_SWAP_ABORTED",
          `the hermes version installed from ${fromRef} cannot be read, so whether ${ref} is ` +
            `a downgrade cannot be judged; the box still runs ${fromRef}`,
          { reason: "unknown installed version", from_ref: fromRef, to_ref: ref },
        );
      }
      if (!(await isDowngrade({ ...input, from: before }))) await steps.prefetch(ref);
    } catch (cause) {
      return await abort(cause, owed ? units : []);
    }
  }

  try {
    await hold(host, units);
    milestone(host, emit, `held ${units.join(", ")} to move hermes from ${fromRef} to ${ref}`);
    for (const unit of units) {
      say(`stopping ${unit} to move hermes from ${fromRef} to ${ref}`);
      await host.exec(["systemctl", "stop", unit]);
    }
    await requireStopped(host, units);
    await stopBrowsers(host, say, browsers);
    // `HEAD` may be a crashed attempt's target; the install it recorded is the one being left.
    const from = pending !== null && fromRef !== ref ? pending.from : await steps.inspect(fromRef);
    running = from.version;
    const swap: Swap = { ...input, from };

    // A forward swap whose rollback crashed mid-restore: finish that restore,
    // so the backup below is of the old state and not of a half-restored one.
    for (const u of unfinished) {
      if (u.toVersion === ref) continue; // the downgrade below redoes it from the same backup
      if (u.leftVersion === ref && from.ref === ref) {
        // A downgrade away from `ref` crashed mid-restore, before its checkout
        // moved, and `ref` is pinned again. The restore is finished, so the live
        // state is a whole older copy and `ref`'s is whole in `u.dir`, then
        // refused as `refuseStrandedRestore` does: `ref` never starts on a state
        // swapped under it, and pinning `u.toVersion` resumes the downgrade.
        say(`finishing the interrupted restore of ${u.backup}`, "warn");
        await restoreOrFail(
          host,
          { toVersion: u.toVersion, leftVersion: u.leftVersion, backup: u.backup },
          u.dir,
        );
        throw stranded(u.toVersion, ref, u.dir);
      }
      if (u.toVersion !== from.ref) {
        throw new AgentdError(
          "HERMES_RESTORE_FAILED",
          `a restore of ${u.backup} was interrupted, and finishing it is not part of a move to ${ref}`,
          { moved_aside: u.dir, backup: u.backup, to_version: u.toVersion },
        );
      }
      say(`finishing the interrupted restore of ${u.backup}`, "warn");
      await restoreOrFail(
        host,
        { toVersion: from.ref, leftVersion: u.leftVersion, backup: u.backup },
        u.dir,
      );
      await ensureHermesHomeOwnership(host, false);
    }

    if (await isDowngrade(swap)) {
      // An operator's step back within one major.minor, from an install whose
      // gate passed: the backup is not restored and only the checkout moves.
      // Its own retry after a crash takes the same branch again.
      const patch =
        downgrade?.to_ref === ref
          ? downgrade.patch
          : untouched &&
            from.ref !== ref &&
            from.version !== null &&
            series(from.version) === series(version) &&
            (await readSwapGate(host)) === null;
      if (patch) {
        say(
          `hermes ${from.version ?? from.ref} to ${version} is a patch-level downgrade; no state is restored`,
        );
        await markDowngrade(input, true);
        try {
          const sha = await steps.fetch(ref, () => {
            untouched = false;
          });
          await steps.record(ref, sha, await steps.install(version));
        } catch (cause) {
          if (untouched) throw cause;
          // The venv may be half rebuilt: a reboot must not start Hermes on it.
          throw new AgentdError(
            "HERMES_RESTORE_FAILED",
            `hermes ${ref} was not installed after its checkout moved (${messageOf(cause)}); the units stay held`,
            {
              cause: describe(cause),
              moved_aside: null,
              backup: null,
              to_version: ref,
              hold: HERMES_HOLD_PATH,
            },
          );
        }
        return;
      }
      const pin = unfinished.find((u) => u.toVersion === ref);
      // A checkout found already on a newer Hermes than its marker says left that one.
      const left = from.ref === ref ? (from.version ?? from.ref) : from.ref;
      // The checkout is already past its marker (re-pinned after a crash, or this
      // downgrade's own retry): what runs here is not the old version, so a
      // refusal is not "nothing changed" and nothing is restarted.
      if (from.ref === ref || (from.version === null && (await restoredBefore(host, from.ref, ref)))) {
        untouched = false;
      }
      if (heldSince !== null && (await restoredBefore(host, null, ref, heldSince))) {
        // This downgrade's own restore finished before a crash, and the units
        // stayed held since: the state is the restored one, so restore nothing.
        untouched = false;
        say(`the hermes state for ${ref} was already restored by an earlier attempt`);
        await installRestored(input, null, null);
        return;
      }
      say(`restoring the hermes state saved when ${ref} was left`);
      // Before the state moves: a crash anywhere after it must not read as untouched,
      // or the retry restarts the newer Hermes on the restored state. A refusal
      // moves nothing, and `abort` drops the record again.
      await markDowngrade(input, false);
      let restored: Awaited<ReturnType<typeof restoreHermesHome>>;
      try {
        restored = untouched
          ? await restoreHermesHome(host, {
              hermesHome: HERMES_HOME,
              toVersion: ref,
              leftVersion: left,
            })
          : await restoreOrFail(
              host,
              { toVersion: ref, leftVersion: left, ...(pin ? { backup: pin.backup } : {}) },
              pin?.dir ?? null,
            );
      } catch (error) {
        // A refusal moved nothing; anything else may have.
        if (!(error instanceof AgentdError && error.code === "HERMES_RESTORE_REFUSED")) {
          untouched = false;
        }
        throw error;
      }
      untouched = false;
      say(`restored ${restored.backup}; the state found is in ${restored.movedAside}`);
      await installRestored(input, restored.movedAside, restored.backup);
      return;
    }

    // The crashed attempt's set-aside install of `origin` is what a rollback puts back.
    if (pending === null) await dropPrevious(host);
    const origin = pending?.from ?? from;
    let backup: Awaited<ReturnType<typeof backupHermesHome>>;
    try {
      backup = await backupHermesHome(host, {
        hermesHome: HERMES_HOME,
        fromVersion: origin.ref,
        ...(pending !== null ? { reuse: pending.backup } : {}),
      });
    } catch (cause) {
      // The crashed attempt may have moved the checkout: return to the install it recorded.
      if (pending === null) throw cause;
      return await rollBack({ host, emit, gate: pending, steps, restart: restartOld }, cause);
    }
    const gate: SwapGate = {
      to_ref: ref,
      to_version: version,
      from: origin,
      backup: backup.dir,
      units,
      // Kept, or every resume would read as the first.
      ...(pending?.resumes !== undefined ? { resumes: pending.resumes } : {}),
    };
    await writeSwapGate(host, gate);
    // Everything after the record fails through this catch: an untouched failure must drop
    // the record, or the next apply reuses a backup the restarted old Hermes has moved past.
    try {
      // The gate record holds the box from here, and a rollback to the downgrade's
      // ref gates it (`requireUp`); left, the record would hold the box forever.
      if (downgrade === null && recordedDowngrade !== null) await host.remove(HERMES_DOWNGRADE_PATH);
      milestone(
        host,
        emit,
        backup.reused
          ? `reusing the hermes backup ${backup.dir}`
          : `backed up hermes ${origin.ref}: ${backup.files} file(s) in ${backup.dir}`,
      );
      await steps.keepVenv(origin.ref);
      const sha = await steps.fetch(ref, () => {
        untouched = false;
      });
      await steps.setAside(origin.ref);
      // The new Hermes stays held until the units phase starts it and gates it.
      await steps.record(ref, sha, await steps.install(version));
    } catch (cause) {
      if (untouched) {
        // Nothing moved and the old Hermes is about to write again, so a
        // retry must take a fresh copy rather than reuse this one.
        await clearSwapGate(host);
        await sealBackups(host);
        throw cause;
      }
      return await rollBack({ host, emit, gate, steps, restart: restartOld }, cause);
    }
  } catch (error) {
    if (untouched) return await abort(error, restart);
    const reported = error instanceof AgentdError && STAYS_HELD.has(error.code);
    // A crashed attempt's swap is this apply's to settle: whatever failed, the
    // box goes back to the install it recorded, never left held on a checkout
    // that may have moved under a code that says the old version still runs.
    if (!reported && pending !== null) {
      const gate = (await readSwapGate(host)) ?? pending;
      return await rollBack({ host, emit, gate, steps, restart: restartOld }, error);
    }
    if (!reported && error instanceof AgentdError && PRE_MOVE_CODES.has(error.code)) {
      // Only an interrupted restore gets here: Hermes is held down, not still running.
      throw new AgentdError(
        "HERMES_RESTORE_FAILED",
        `hermes ${ref} was not installed (${error.message}) with an earlier restore unfinished; ` +
          "the units stay held",
        {
          cause: describe(error),
          moved_aside: unfinished[0]?.dir ?? null,
          backup: unfinished[0]?.backup ?? null,
          to_version: ref,
          hold: HERMES_HOLD_PATH,
        },
      );
    }
    // Nothing will start a held box until the next apply, so the hold stays only
    // where a code says Hermes is down and held, a crashed restore may have left
    // the state half put back, or a gate for this swap is the next apply's to settle.
    if (!reported && unfinished.length === 0 && (await readSwapGate(host))?.to_ref !== ref) {
      await releaseHold(host);
    }
    throw error;
  }
}

/** Failure codes that leave the units held: down and held, or already restarted on the old install. */
const STAYS_HELD = new Set([
  "HERMES_RESTORE_FAILED",
  "HERMES_ROLLBACK_FAILED",
  "HERMES_UPGRADE_ROLLED_BACK",
]);

/**
 * Install `ref` on the state a downgrade restored. A failure here is the
 * downgrade failing after its state moved, so it is `HERMES_RESTORE_FAILED`
 * and the units stay held: a retry relies on no Hermes having run since. Its
 * record gates the units once they start (`verifySwap`).
 */
async function installRestored(
  input: SwapInput,
  aside: string | null,
  backup: string | null,
): Promise<void> {
  const { host, ref, version, steps } = input;
  try {
    await markDowngrade(input, false);
    await ensureHermesHomeOwnership(host, false);
    const sha = await steps.fetch(ref, () => {});
    await steps.record(ref, sha, await steps.install(version));
  } catch (cause) {
    if (cause instanceof AgentdError && STAYS_HELD.has(cause.code)) throw cause;
    throw new AgentdError(
      "HERMES_RESTORE_FAILED",
      `hermes ${ref} was not installed on its restored state (${messageOf(cause)}); the units stay held`,
      { cause: describe(cause), moved_aside: aside, backup, to_version: ref, hold: HERMES_HOLD_PATH },
    );
  }
}

/** Pre-move codes the laptop already reads as "old version still running". */
const PRE_MOVE_CODES = new Set([
  "HERMES_SWAP_ABORTED",
  "HERMES_UNITS_ACTIVE",
  "HERMES_BACKUP_FAILED",
  "HERMES_RESTORE_REFUSED",
]);

/** A failure before the checkout moved: the box still runs `fromRef`, and says so. */
function aborted(cause: unknown, fromRef: string, ref: string): unknown {
  if (cause instanceof AgentdError && PRE_MOVE_CODES.has(cause.code)) return cause;
  return new AgentdError(
    "HERMES_SWAP_ABORTED",
    `hermes ${ref} was not installed (${messageOf(cause)}); the box still runs ${fromRef}`,
    { cause: describe(cause), from_ref: fromRef, to_ref: ref },
  );
}

// --- the rollback --------------------------------------------------------------

export interface Rollback {
  readonly host: Host;
  readonly emit: Emit;
  readonly gate: SwapGate;
  readonly steps: Pick<SwapSteps, "checkoutPrevious" | "restorePrevious" | "install" | "record">;
  /** Start Hermes on the restored install: a re-apply of the old manifest, or the units alone. */
  readonly restart: () => Promise<void>;
}

/**
 * A forward swap failed after its checkout moved: hold and stop the units,
 * put back the backup it took, the old checkout with its own recipe and the
 * old markers, then start Hermes on them. Always throws:
 * `HERMES_UPGRADE_ROLLED_BACK` when the box is back on the old version,
 * `HERMES_ROLLBACK_FAILED` (units held, nothing deleted) when it is not.
 */
export async function rollBack(r: Rollback, cause: unknown): Promise<never> {
  const { host, emit, gate, steps } = r;
  const { from, to_ref: ref, backup, units } = gate;
  // A rollback a crash interrupted: its own cause, and a restore done since it began is not redone.
  const rolling = gate.rolling_back ?? { since: host.now().toISOString(), cause: describe(cause) };
  const why = String(rolling.cause["message"]);
  emit(
    opEvent(
      "packages",
      0.3,
      gate.rolling_back === undefined
        ? `hermes ${ref} failed after its checkout moved (${why}); rolling back to ${from.ref}`
        : `finishing the interrupted rollback of hermes ${ref} to ${from.ref} (${why})`,
      host.now(),
      "warn",
    ),
  );
  let movedAside: string | null = null;
  // What an interrupted restore moved aside before the crash: the rest of the state found.
  let earlier: string[] = [];
  let reinstalled = false;
  let after: unknown = null;
  try {
    await writeSwapGate(host, { ...gate, rolling_back: rolling });
    const pending = await readApplyPending(host);
    await writeApplyPending(
      host,
      [...new Set([...(pending?.units ?? []), ...units])],
      pending?.config_hash ?? null,
    );
    await hold(host, units);
    for (const unit of units) await host.exec(["systemctl", "stop", unit]);
    await requireStopped(host, units);
    const restore = { backup, toVersion: from.ref, leftVersion: ref };
    movedAside = await completedRestore(host, restore, rolling.since);
    if (movedAside === null) {
      earlier = (await unfinishedRestores(host))
        .filter((u) => u.backup === backup && u.leftVersion === ref)
        .map((u) => u.dir);
      try {
        movedAside = (await restoreHermesHome(host, { hermesHome: HERMES_HOME, ...restore }))
          .movedAside;
      } catch (error) {
        // Nothing moved: the new Hermes's state and checkout are whole, so a later apply may gate it again.
        if (
          error instanceof AgentdError &&
          error.code === "HERMES_RESTORE_REFUSED" &&
          earlier.length === 0
        ) {
          await writeSwapGate(host, { ...gate, rolling_back: undefined });
        }
        throw error;
      }
    }
    await ensureHermesHomeOwnership(host, false);
    await steps.checkoutPrevious(from);
    // The set-aside install needs no network; reinstalling is the fallback.
    const kept = await steps.restorePrevious(from);
    await steps.record(from.ref, from.upstreamSha, kept ?? (await steps.install(from.version, true)));
    reinstalled = true;
    // The record (`rolling_back`) stays until the old Hermes is up: a crash before then
    // leaves a rollback the next apply finishes and reports, never a swap it re-runs.
    // The old configuration's re-apply failing after its units started is a detail; Hermes up is the test.
    await r.restart().catch((error: unknown) => {
      after = error;
    });
    await requireUp(host, emit, units, { to_ref: from.ref, to_version: from.version });
  } catch (failure) {
    // State, checkout and markers are the old version's: nothing is left to finish, but the
    // old Hermes was never seen up. The next apply restarts it and gates it (`verifySwap`),
    // and the recorded config, which the restart's re-apply may have written, is not current.
    // A step that fails keeps the rollback's record, so the next apply resumes the rollback.
    if (reinstalled) {
      await (async () => {
        await oweGatedStart(host, from.ref, from.version, units);
        await clearSwapGate(host);
      })().catch(() => undefined);
    }
    const aside = failure instanceof AgentdError ? failure.detail["moved_aside"] : undefined;
    throw new AgentdError(
      "HERMES_ROLLBACK_FAILED",
      `hermes ${ref} failed (${why}) and the rollback to ${from.ref} failed too: ` +
        `${messageOf(failure)}. The backup is ${backup}`,
      {
        cause: rolling.cause,
        rollback: describe(failure),
        ...(after === null ? {} : { after: describe(after) }),
        ...(earlier.length > 0 ? { earlier_moved_aside: earlier } : {}),
        backup,
        moved_aside: movedAside ?? (typeof aside === "string" ? aside : null),
        hermes_home: HERMES_HOME,
        from_ref: from.ref,
        to_ref: ref,
        // Whether state, checkout and markers are already the old version's:
        // then only the start (or the old configuration's re-apply) failed.
        old_install_restored: reinstalled,
        hold: HERMES_HOLD_PATH,
      },
    );
  }
  // The old Hermes is up: failing to tidy after it (a full `/data` sealing the backups) is a warning.
  let unsettled: unknown = null;
  await settleSwap(host, from.ref).catch((error: unknown) => {
    unsettled = error;
    emit(
      opEvent(
        "packages",
        0.3,
        `hermes ${from.ref} is back up, but the rollback was not tidied: ${messageOf(error)}`,
        host.now(),
        "warn",
      ),
    );
  });
  milestone(
    host,
    emit,
    `rolled back to hermes ${from.ref}: state restored from ${backup}, the state found is in ${movedAside}`,
    "warn",
  );
  throw new AgentdError(
    "HERMES_UPGRADE_ROLLED_BACK",
    `hermes ${ref} failed after its checkout moved (${why}); the box is back on ` +
      `${from.ref} with the state from ${backup}, and the state found is in ${movedAside}`,
    {
      cause: rolling.cause,
      backup,
      moved_aside: movedAside,
      ...(earlier.length > 0 ? { earlier_moved_aside: earlier } : {}),
      from_ref: from.ref,
      to_ref: ref,
      ...(after === null ? {} : { after: describe(after) }),
      ...(unsettled === null ? {} : { unsettled: describe(unsettled) }),
    },
  );
}

// --- the runtime gate --------------------------------------------------------

/** The first start runs the forward state migration, which can take minutes. */
export const HERMES_GATE_TIMEOUT_MS = 300_000;
export const HERMES_GATE_POLL_MS = 5_000;
/** Up, answering with the new version, and not restarted, for this long. */
export const HERMES_GATE_STABLE_MS = 30_000;
/** Automatic restarts of the gateway that end the wait early: a crash loop, not a slow start. */
export const HERMES_GATE_RESTART_LIMIT = 3;

/**
 * After the units phase started Hermes: when this apply (or a crashed earlier
 * one) moved the box forward and the new version has not yet been seen up,
 * wait for it. The gateway stably active with no climbing restart count, and
 * the dashboard's `/api/health` (the heartbeat's own probe) answering with the
 * target version. Passing seals the backup; failing throws, and `apply` rolls
 * the swap back.
 */
export async function verifySwap(host: Host, emit: Emit, ref: string): Promise<void> {
  const gate = await readSwapGate(host);
  if (gate !== null && gate.to_ref === ref) {
    const want = gate.to_version ?? gate.to_ref;
    milestone(host, emit, `runtime gate started for hermes ${want}`);
    try {
      await awaitHermesUp(host, emit, gate);
    } catch (error) {
      milestone(host, emit, `runtime gate failed for hermes ${want}: ${messageOf(error)}`, "warn");
      throw error;
    }
    milestone(host, emit, `runtime gate passed: hermes ${want} is up`);
    await clearSwapGate(host);
    await sealBackups(host);
    milestone(host, emit, `sealed the hermes backup ${gate.backup}`);
    await dropPrevious(host);
    return;
  }
  // A downgrade is gated the same way, but never re-upgraded: Hermes is held
  // down for an operator, its units owed a restart by the next apply.
  const down = await readDowngrade(host);
  if (down === null || down.to_ref !== ref) return;
  try {
    await awaitHermesUp(host, emit, down);
  } catch (cause) {
    const owed = await readApplyPending(host);
    await writeApplyPending(
      host,
      [...new Set([...(owed?.units ?? []), ...down.units])],
      owed?.config_hash ?? null,
    );
    await hold(host, down.units);
    for (const unit of down.units) await host.exec(["systemctl", "stop", unit]);
    throw new AgentdError(
      "HERMES_RESTORE_FAILED",
      `hermes ${down.to_version ?? ref} did not come up after the downgrade (${messageOf(cause)}); the units stay held`,
      { cause: describe(cause), to_version: ref, hold: HERMES_HOLD_PATH },
    );
  }
  await host.remove(HERMES_DOWNGRADE_PATH);
}

/** `to_version: null`: a pre-0.22 install that cannot say, so any version `/api/health` answers. */
type GateTarget = Pick<SwapGate, "to_ref" | "units"> & { readonly to_version: string | null };

/** The gateway stably active, `/api/health` answering `to_version`; throws when it does not come up. */
async function awaitHermesUp(host: Host, emit: Emit, gate: GateTarget): Promise<void> {
  const want = gate.to_version ?? gate.to_ref;
  emit(opEvent("units", 0.78, `waiting for hermes ${want} to come up`, host.now()));
  const watchGateway = gate.units.includes(HERMES_GATEWAY_UNIT);
  const watchHealth = gate.units.includes(HERMES_DASHBOARD_UNIT);
  const start = host.now().getTime();
  let baseline: number | null = null;
  let healthySince: number | null = null;
  let restartsWhenHealthy: number | null = null;
  let seen = "";
  for (;;) {
    const now = host.now().getTime();
    let up = true;
    let restarts: number | null = null;
    if (watchGateway) {
      const show = await host.exec([
        "systemctl",
        "show",
        "-p",
        UNIT_SHOW_PROPERTIES,
        HERMES_GATEWAY_UNIT,
      ]);
      const state = parseUnitState(show.stdout);
      restarts = state.restarts;
      baseline ??= restarts;
      seen = `${HERMES_GATEWAY_UNIT} ${state.activeState ?? "unknown"} (${state.subState ?? "?"}), ${restarts ?? "?"} restart(s)`;
      if (state.activeState === "failed") throw unhealthy(gate, "failed", seen);
      if (restarts !== null && baseline !== null && restarts - baseline >= HERMES_GATE_RESTART_LIMIT) {
        throw unhealthy(gate, "crash-loop", seen);
      }
      up = state.activeState === "active";
    }
    if (up && watchHealth) {
      const res = await host.exec(["curl", "-fsS", "--max-time", "3", HERMES_HEALTH_URL]);
      const reported = res.code === 0 ? versionOf(res.stdout) : null;
      up = reported !== null && (gate.to_version === null || reported === gate.to_version);
      if (!up)
        seen = `${seen ? `${seen}; ` : ""}/api/health ${reported ?? `unanswered (exit ${res.code})`}`;
    }
    if (up && healthySince !== null && restarts !== restartsWhenHealthy) up = false;
    if (!up) healthySince = null;
    else if (healthySince === null) {
      healthySince = now;
      restartsWhenHealthy = restarts;
    }
    if (healthySince !== null && now - healthySince >= HERMES_GATE_STABLE_MS) break;
    // A stability window that opened within the budget runs to its end.
    const windowOpen = healthySince !== null && healthySince - start < HERMES_GATE_TIMEOUT_MS;
    if (now - start >= HERMES_GATE_TIMEOUT_MS && !windowOpen) throw unhealthy(gate, "timeout", seen);
    await host.sleep(HERMES_GATE_POLL_MS);
  }
  emit(opEvent("units", 0.79, `hermes ${want} is up`, host.now()));
}

/**
 * The old install restarted: held to the forward gate's test, not one
 * `is-active` sample, since a `Restart=always` unit dying seconds after its
 * start still reads active; then every unit, the legacy one included, active.
 */
async function requireUp(
  host: Host,
  emit: Emit,
  units: readonly string[],
  target: Omit<GateTarget, "units">,
): Promise<void> {
  if (units.length === 0) return;
  await awaitHermesUp(host, emit, { ...target, units });
  await requireActive(host, units);
}

function versionOf(body: string): string | null {
  try {
    const version = (JSON.parse(body) as Record<string, unknown>)["version"];
    return typeof version === "string" ? version : null;
  } catch {
    return null;
  }
}

function unhealthy(gate: GateTarget, reason: string, seen: string): AgentdError {
  return new AgentdError(
    "COMMAND_FAILED",
    `hermes ${gate.to_version ?? gate.to_ref} did not come up after the swap (${reason}): ${seen}`,
    { reason, seen, to_ref: gate.to_ref },
  );
}

// --- small helpers -------------------------------------------------------------

/** `0.23` of `0.23.1`: the part a Hermes release migrates its stores on. */
const series = (version: string): string => version.split(".").slice(0, 2).join(".");

/**
 * A restore after something already moved this apply: a refusal no longer
 * means "nothing changed", so it is reported as the failure it is.
 */
async function restoreOrFail(
  host: Host,
  opts: { toVersion: string; leftVersion: string; backup?: string },
  interrupted: string | null,
): ReturnType<typeof restoreHermesHome> {
  try {
    return await restoreHermesHome(host, { hermesHome: HERMES_HOME, ...opts });
  } catch (error) {
    if (!(error instanceof AgentdError) || error.code !== "HERMES_RESTORE_REFUSED") throw error;
    throw new AgentdError("HERMES_RESTORE_FAILED", error.message, {
      ...error.detail,
      moved_aside: interrupted,
      backup: opts.backup ?? null,
    });
  }
}

async function unitState(host: Host, unit: string): Promise<string> {
  return (await host.exec(["systemctl", "is-active", unit])).stdout.trim() || "unknown";
}

const stopped = (state: string): boolean => state === "inactive" || state === "failed";

/** Every unit `active` within `HERMES_GATE_STABLE_MS`: a start's exit code is not proof Hermes is up. */
async function requireActive(host: Host, units: readonly string[]): Promise<void> {
  const start = host.now().getTime();
  for (;;) {
    const down: Array<{ unit: string; state: string }> = [];
    for (const unit of units) {
      const state = await unitState(host, unit);
      if (state !== "active") down.push({ unit, state });
    }
    if (down.length === 0) return;
    if (
      down.some((d) => d.state === "failed") ||
      host.now().getTime() - start >= HERMES_GATE_STABLE_MS
    ) {
      throw new AgentdError(
        "COMMAND_FAILED",
        `hermes did not come back up: ${down.map((d) => `${d.unit} (${d.state})`).join(", ")}`,
        { units: down },
      );
    }
    await host.sleep(HERMES_GATE_POLL_MS);
  }
}

/** Upstream's `systemd-run --user --scope --unit hermes-worker-…` (`tools/process_registry.py`). */
const WORKER_SCOPES = "hermes-worker-*.scope";

/** Fail closed: any state but stopped (`activating`, `deactivating`, unknown) is a live writer. */
async function requireStopped(host: Host, units: readonly string[]): Promise<void> {
  const alive: Array<{ unit: string; state: string }> = [];
  for (const unit of units) {
    const state = await unitState(host, unit);
    if (!stopped(state)) alive.push({ unit, state });
  }
  if (alive.length > 0) {
    throw new AgentdError(
      "HERMES_UNITS_ACTIVE",
      `still running after systemctl stop: ${alive.map((a) => `${a.unit} (${a.state})`).join(", ")}`,
      { units: alive },
    );
  }
  // Cron jobs, kanban workers and background commands the gateway started run
  // in transient scopes under the account's user manager (linger), outside the
  // units' cgroups, so they survive the units' stop. An unmatched glob exits 0;
  // with no user manager running there are no scopes, and none to ask.
  const uid = (await host.exec(["id", "-u", HERMES_USER])).stdout.trim();
  if (/^\d+$/.test(uid) && !stopped(await unitState(host, `user@${uid}.service`))) {
    const scopes = await host.exec([
      "systemctl",
      "--user",
      "-M",
      `${HERMES_USER}@`,
      "stop",
      WORKER_SCOPES,
    ]);
    if (scopes.code !== 0) {
      throw new AgentdError(
        "HERMES_UNITS_ACTIVE",
        `the Hermes worker scopes (${WORKER_SCOPES}) did not stop: ${scopes.stderr.trim() || `exit ${scopes.code}`}`,
        { units: [], scopes: WORKER_SCOPES },
      );
    }
  }
  // A Hermes outside the units (an operator's `hermes chat`, a stray worker) can
  // write the stores mid-backup or open them after a migration: any open file
  // under the home is one. find exits 1 when a process exits mid-walk, so only
  // its output is read.
  const open = await host.exec([
    "find",
    "/proc",
    "-mindepth",
    "3",
    "-maxdepth",
    "3",
    "-path",
    "/proc/[0-9]*/fd/*",
    "-lname",
    `${HERMES_HOME}/*`,
    "-printf",
    "%p %l\\n",
  ]);
  let holders = open.stdout
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => {
      const [fd = "", ...path] = line.split(" ");
      return { pid: Number(fd.split("/")[2]), path: path.join(" ") };
    });
  if (holders.length > 0) {
    // hermeticd's own readers (a `logs --follow` tail) are no Hermes; a pid
    // `ps` cannot place counts as a stray.
    const ours = await ownProcesses(host);
    holders = holders.filter((h) => !ours.has(h.pid));
  }
  if (holders.length > 0) {
    const pids = [...new Set(holders.map((h) => h.pid))];
    throw new AgentdError(
      "HERMES_UNITS_ACTIVE",
      `process(es) ${pids.join(", ")} outside the Hermes units still hold files under ${HERMES_HOME} open`,
      { units: [], processes: holders },
    );
  }
}

/** hermeticd and its descendants, by parent pid. */
async function ownProcesses(host: Host): Promise<Set<number>> {
  const children = new Map<number, number[]>();
  for (const line of (await host.exec(["ps", "-e", "-o", "pid=,ppid="])).stdout.split("\n")) {
    const [pid, ppid] = line.trim().split(/\s+/).map(Number);
    if (pid === undefined || ppid === undefined || !Number.isInteger(pid) || !Number.isInteger(ppid))
      continue;
    children.set(ppid, [...(children.get(ppid) ?? []), pid]);
  }
  const ours = new Set([process.pid]);
  for (const pid of ours) for (const child of children.get(pid) ?? []) ours.add(child);
  return ours;
}

function describe(error: unknown): Record<string, unknown> {
  return error instanceof AgentdError
    ? { code: error.code, message: error.message, detail: error.detail }
    : { code: "INTERNAL", message: messageOf(error) };
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
