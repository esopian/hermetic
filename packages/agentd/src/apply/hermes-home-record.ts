/**
 * Which Hermes may have opened `$HERMES_HOME` last, kept on the data volume so
 * it survives a recreate, and the guard that keeps a fresh box's first install
 * from opening a home another Hermes wrote without a backup first (design:
 * Hermes v0.23.1 adoption, D3).
 *
 * The in-place swap (`hermes-upgrade.ts`) backs the home up because it knows
 * the install it leaves. A recreate keeps `/data` and starts on a new root
 * volume with no checkout, so the plain install would start the new Hermes on
 * the old stores and let it migrate them with nothing saved. The record names
 * the ref the home belongs to: `recordInstall` writes it once an install is in
 * place and before that Hermes can start; a restore completed since it was
 * written overrides it (`lastRestoreSince`), which covers the window between a
 * rollback's restore and its reinstall.
 */
import { compareVersions } from "@hermetic/core/schema";
import { HERMES_HOME, hermesTagVersion } from "@hermetic/core/shared";
import { AgentdError } from "../errors.ts";
import type { Emit } from "../events.ts";
import { HERMES_UPGRADE_PHASE, opEvent } from "../events.ts";
import { HERMES_REF_MARKER, parseRefMarker } from "../hermes-source.ts";
import type { Host } from "../host.ts";
import { APPLY_LOCK_PATH, takeInstallLock } from "../install-lock.ts";
import {
  HERMES_BACKUP_ROOT,
  type UnfinishedRestore,
  backupHermesHome,
  ensureBackupRoot,
  lastRestoreSince,
  restoreHermesHome,
  unfinishedRestores,
} from "./hermes-backup.ts";
import { HERMES_DOWNGRADE_PATH, HERMES_HOLD_PATH, HERMES_SWAP_PATH } from "./hermes-upgrade.ts";

/** Root's, 0600, beside the backups and outside the agent's home; not named `hermes-*`, so no backup scan reads it. */
export const HOME_RECORD_PATH = `${HERMES_BACKUP_ROOT}/home-ref.json`;

/** The label of a backup taken of a home no record describes. */
export const UNRECORDED = "unrecorded";

export interface HomeRecord {
  /** The ref whose Hermes may have opened the home last; `null`: unknown. */
  readonly ref: string | null;
  readonly at: string;
  /** Taken by the guard for a first start of `to` that has not been installed yet: a retry reuses it. */
  readonly first_start_backup?: string;
  readonly to?: string;
  /** The backup of the home as it was before `ref` first opened it on a fresh box. */
  readonly before?: string;
}

export async function readHomeRecord(host: Host): Promise<HomeRecord | null> {
  const raw = await host.readFile(HOME_RECORD_PATH);
  if (raw === null) return null;
  try {
    const r = JSON.parse(raw) as Record<string, unknown>;
    const opt = (v: unknown): boolean => v === undefined || typeof v === "string";
    if (r["format"] !== 1 || !(r["ref"] === null || typeof r["ref"] === "string")) return null;
    if (
      typeof r["at"] !== "string" ||
      !opt(r["first_start_backup"]) ||
      !opt(r["to"]) ||
      !opt(r["before"])
    ) {
      return null;
    }
    return r as unknown as HomeRecord;
  } catch {
    return null;
  }
}

async function writeHomeRecord(host: Host, record: Omit<HomeRecord, "at">): Promise<void> {
  await ensureBackupRoot(host);
  const body = { format: 1, ...record, at: host.now().toISOString() };
  await host.writeFile(HOME_RECORD_PATH, `${JSON.stringify(body)}\n`, "0600");
}

/**
 * `recordInstall`'s half: the home is now `ref`'s. Never fails the install (a
 * full `/data` must not turn a rollback into a failed one): a record it could
 * not write is removed, which reads as unknown, and unknown takes a backup.
 */
export async function recordHomeRef(host: Host, ref: string): Promise<void> {
  try {
    const prev = await readHomeRecord(host);
    const before =
      prev?.to === ref ? prev.first_start_backup : prev?.ref === ref ? prev.before : undefined;
    await writeHomeRecord(host, { ref, ...(before !== undefined ? { before } : {}) });
  } catch {
    await host.remove(HOME_RECORD_PATH).catch(() => undefined);
  }
}

/** `a` against `b`: SemVer tags by version, date tags by date and before any SemVer tag; `null` when unknown. */
export function refOrder(a: string, b: string): number | null {
  if (a === b) return 0;
  const date = (ref: string): string | null => /^v(\d{4}\.\d+\.\d+)$/.exec(ref)?.[1] ?? null;
  const [sa, sb, da, db] = [hermesTagVersion(a), hermesTagVersion(b), date(a), date(b)];
  if (sa !== null && sb !== null) return compareVersions(sa, sb);
  if (da !== null && db !== null) return compareVersions(da, db);
  if (da !== null && sb !== null) return -1;
  if (sa !== null && db !== null) return 1;
  return null;
}

const series = (ref: string): string | null =>
  hermesTagVersion(ref)?.split(".").slice(0, 2).join(".") ?? null;

async function homeHasState(host: Host): Promise<boolean> {
  const home = await host.lstat(HERMES_HOME);
  if (home === null) return false;
  // Anything else at that path is the backup's to refuse (`unsafe-path`).
  if (home.isSymlink || !home.isDirectory) return true;
  return (await host.readdir(HERMES_HOME)).length > 0;
}

/**
 * Before a box with no installed checkout installs `ref`: when `$HERMES_HOME`
 * already holds state, make sure the `ref` Hermes that is about to open it
 * finds either its own state or one saved first. Same ref: nothing. An older
 * one in the same major.minor: nothing, as for an in-place patch downgrade.
 * An older one otherwise: the backup taken when it was left is restored, and
 * a refusal (`HERMES_RESTORE_REFUSED`) installs nothing. Newer, unknown, or
 * no record: a validated backup (`HERMES_BACKUP_FAILED` installs nothing).
 */
export async function guardFirstStart(
  host: Host,
  ref: string,
  unfinished: readonly UnfinishedRestore[],
  emit: Emit,
): Promise<void> {
  if (!(await homeHasState(host))) return;
  const say = (message: string, level?: "warn"): void =>
    emit(opEvent(HERMES_UPGRADE_PHASE, 0.3, message, host.now(), level));
  const restore = async (opts: {
    toVersion: string;
    leftVersion: string;
    backup?: string;
  }): Promise<void> => {
    const done = await restoreHermesHome(host, { hermesHome: HERMES_HOME, ...opts });
    await writeHomeRecord(host, { ref });
    say(
      `restored ${done.backup} before the first start of hermes ${ref}; the state found is in ${done.movedAside}`,
    );
  };

  const record = await readHomeRecord(host);
  const crashed = unfinished[0];
  if (crashed !== undefined) {
    // A fallback restore's intent names its backup's label; the record names the ref it was for.
    const target =
      crashed.toVersion === UNRECORDED && crashed.backup === record?.before && record.to !== undefined
        ? record.to
        : crashed.toVersion;
    if (target !== ref) {
      throw new AgentdError(
        "HERMES_RESTORE_FAILED",
        `a restore of ${crashed.backup} for hermes ${target} was interrupted, with the state it moved ` +
          `aside in ${crashed.dir}; hermes ${ref} was not installed on the half-restored state, and no ` +
          `Hermes runs on this box until it is pinned back to ${target}, which finishes the restore`,
        {
          moved_aside: crashed.dir,
          backup: crashed.backup,
          to_version: target,
          first_start: true,
        },
      );
    }
    say(`finishing the interrupted restore of ${crashed.backup}`, "warn");
    return await restore({
      toVersion: crashed.toVersion,
      leftVersion: crashed.leftVersion,
      backup: crashed.backup,
    });
  }

  const restored = record === null ? null : await lastRestoreSince(host, record.at);
  // A fallback restore completes as `unrecorded`: the home is then the one its record's `to` (or, once written, `ref`) names.
  const last =
    restored === UNRECORDED ? (record?.to ?? record?.ref ?? null) : (restored ?? record?.ref ?? null);
  if (last === ref) return;
  const order = last === null ? null : refOrder(ref, last);
  if (last !== null && order !== null && order < 0) {
    if (series(ref) !== null && series(ref) === series(last)) {
      say(`hermes ${last} to ${ref} is a patch-level downgrade; no state is restored`);
      return;
    }
    say(`restoring the hermes state saved when ${ref} was left, before its first start`);
    try {
      return await restore({ toVersion: ref, leftVersion: last });
    } catch (error) {
      // No copy labelled `ref`: the one taken before `last` first opened this home is the home as `ref` (or an unrecorded older Hermes) left it.
      const before = record?.ref === last ? record.before : undefined;
      const none =
        error instanceof AgentdError &&
        error.detail["reason"] === "no-backup" &&
        error.detail["path"] === undefined;
      if (!none || before === undefined) throw error;
      say(
        `no backup is labelled ${ref}; restoring ${before}, taken before ${last} first opened this home`,
        "warn",
      );
      // Names `ref` before the intent is written, so a crash mid-restore is finished by a retry for `ref`.
      await writeHomeRecord(host, { ref: last, before, to: ref });
      return await restore({ toVersion: UNRECORDED, leftVersion: last, backup: before });
    }
  }

  const backup = await backupHermesHome(host, {
    hermesHome: HERMES_HOME,
    fromVersion: last ?? UNRECORDED,
    ...(record?.first_start_backup !== undefined ? { reuse: record.first_start_backup } : {}),
  });
  await writeHomeRecord(host, { ref: last, first_start_backup: backup.dir, to: ref });
  say(
    backup.reused
      ? `reusing the hermes backup ${backup.dir} for the first start of ${ref}`
      : `backed up hermes ${last ?? UNRECORDED} before the first start of ${ref}: ${backup.files} file(s) in ${backup.dir}`,
  );
}

/**
 * A box an older hermeticd installed carries no record. At `serve` start, a
 * settled install (no swap, hold, downgrade or restore in flight, the apply
 * lock free) names the ref the home belongs to, so a later same-version
 * recreate takes no backup. Returns whether it wrote one.
 */
export async function backfillHomeRecord(host: Host): Promise<boolean> {
  const lock = await takeInstallLock(host, "apply", { path: APPLY_LOCK_PATH });
  if (lock === null) return false;
  try {
    if ((await readHomeRecord(host)) !== null) return false;
    const marker = parseRefMarker(await host.readFile(HERMES_REF_MARKER));
    if (marker === null) return false;
    for (const path of [HERMES_SWAP_PATH, HERMES_HOLD_PATH, HERMES_DOWNGRADE_PATH]) {
      if ((await host.lstat(path)) !== null) return false;
    }
    if ((await unfinishedRestores(host)).length > 0) return false;
    await writeHomeRecord(host, { ref: marker.ref });
    return true;
  } finally {
    await lock.release();
  }
}
