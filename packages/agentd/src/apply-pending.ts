/**
 * The restart obligations an apply owes, written down before it incurs them
 * (§6.4).
 *
 * `hermeticd apply` decides what to restart from a *diff*: a unit whose own
 * rendered file changed on this run, a unit a changed file named in its
 * `restart_units`, a unit this run enabled for the first time. That is the right
 * rule while the apply runs to the end, and it has one failure mode — the diff
 * only exists in memory. A process that writes `hermes-dashboard.service` and
 * dies before the units phase leaves a box whose files are new, whose running
 * processes are old, and whose next apply computes an *empty* diff and so
 * restarts nothing. The change is on disk and will never take effect; nothing
 * anywhere records that it is owed.
 *
 * So the obligation is persisted rather than inferred: before the first file is
 * written, apply records which units that write will oblige it to restart, and
 * it clears each name only once that unit has actually come back. A leftover
 * record is therefore exactly "restarts a previous apply owed and did not
 * make", and the next apply drains it whether or not it has a diff of its own.
 *
 * It is also the only such record. A Hermes swap stops both units most of an
 * apply before it starts them again, and that used to be tracked by a second
 * file of its own (`hermes.stopped`) holding the same kind of fact in a
 * different shape. Both are "these units are down or stale and this box owes
 * them a restart", so both live here.
 */
import { createHash } from "node:crypto";
import type { Host } from "./host.ts";
import { STATE_DIR } from "./fleet.ts";

const sha256 = (text: string): string => createHash("sha256").update(text).digest("hex");

/**
 * Under `STATE_DIR` rather than beside anything it describes: a failed apply is
 * exactly the run that may have left `/etc` half-rewritten, and hermeticd's own
 * state directory is the one place on the box that no rendered file touches.
 */
export const APPLY_PENDING_PATH = `${STATE_DIR}/apply-pending.json`;

/**
 * The record `hermes.stopped` used to be: one unit name per line. Read for as
 * long as boxes exist that were last applied by a hermeticd that wrote it, and
 * never written again.
 */
export const LEGACY_STOP_MARKER_PATH = `${STATE_DIR}/hermes.stopped`;

/** Restarts owed, and the configuration the apply that owed them was applying. */
export interface ApplyPending {
  /** Units still owed a restart, in the order the apply would make them. */
  readonly units: readonly string[];
  /** The manifest being applied when the obligation was taken on. */
  readonly config_hash: string | null;
  readonly recorded_at: string;
}

/**
 * The units this apply's file writes will oblige it to restart, decided before
 * a single one of them is written.
 *
 * Content changes only, and the same two routes the units phase uses: a unit's
 * own rendered file under `unitDir`, and any unit a changed file names in
 * `restart_units`. Filtered to `manifest.units` so a name the manifest does not
 * declare is never handed to systemctl — the record is a promise apply has to
 * be able to keep.
 *
 * A prediction, and deliberately a conservative one. It reads the same files
 * the `files` phase is about to write and asks the same question of them, so on
 * an apply that runs to the end it names exactly the units that phase will
 * trigger; where it can be wrong is in naming a unit an apply then fails before
 * ever changing, and the cost of that is one redundant restart on the next run.
 */
export async function plannedRestarts(
  host: Host,
  manifest: {
    readonly units: readonly string[];
    readonly files: ReadonlyArray<{
      readonly path: string;
      readonly content: string;
      readonly restart_units?: readonly string[] | undefined;
    }>;
  },
  unitDir: string,
): Promise<string[]> {
  const declared = new Set(manifest.units);
  const owed = new Set<string>();
  for (const file of manifest.files) {
    const existing = await host.readFile(file.path);
    if (existing !== null && sha256(existing) === sha256(file.content)) continue;
    const own = file.path.startsWith(`${unitDir}/`) ? file.path.slice(unitDir.length + 1) : null;
    if (own !== null && declared.has(own)) owed.add(own);
    for (const unit of file.restart_units ?? []) {
      if (declared.has(unit)) owed.add(unit);
    }
  }
  return manifest.units.filter((unit) => owed.has(unit));
}

/**
 * What the last apply left owed, or `null` when it owed nothing.
 *
 * A record naming no units is the same answer as no record at all, so a
 * truncated or half-written file cannot make a box restart a unit forever.
 */
export async function readApplyPending(host: Host): Promise<ApplyPending | null> {
  const text = await host.readFile(APPLY_PENDING_PATH);
  if (text !== null) {
    try {
      const raw = JSON.parse(text) as Partial<ApplyPending>;
      const units = (raw.units ?? []).filter((u): u is string => typeof u === "string" && u !== "");
      if (units.length === 0) return null;
      return {
        units,
        config_hash: typeof raw.config_hash === "string" ? raw.config_hash : null,
        recorded_at: typeof raw.recorded_at === "string" ? raw.recorded_at : "",
      };
    } catch {
      return null;
    }
  }
  const legacy = await host.readFile(LEGACY_STOP_MARKER_PATH);
  if (legacy === null) return null;
  const units = legacy
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "");
  if (units.length === 0) return null;
  return { units, config_hash: null, recorded_at: "" };
}

/**
 * Write the obligation down. Replaces rather than merges: every caller computes
 * the whole set it is about to owe, including whatever it inherited from a
 * previous run, and a record that named a unit no longer in the manifest would
 * be a promise this apply cannot keep.
 *
 * An empty set is recorded by removing the file, which is what makes "no
 * record" and "nothing owed" the same state on disk.
 */
export async function writeApplyPending(
  host: Host,
  units: readonly string[],
  configHash: string | null,
): Promise<void> {
  if (units.length === 0) {
    await clearApplyPending(host);
    return;
  }
  const record: ApplyPending = {
    units: [...units],
    config_hash: configHash,
    recorded_at: host.now().toISOString(),
  };
  await host.mkdir(STATE_DIR, "0755");
  await host.writeFile(APPLY_PENDING_PATH, `${JSON.stringify(record)}\n`, "0600");
  // A box mid-upgrade can be carrying both; the new record is the live one.
  await host.remove(LEGACY_STOP_MARKER_PATH);
}

/**
 * Discharge one unit — called after its restart returned, never before. A
 * restart that fails therefore leaves its own name and every name after it on
 * disk, which is the instruction the next apply needs.
 */
export async function dropApplyPendingUnit(host: Host, unit: string): Promise<void> {
  const pending = await readApplyPending(host);
  if (pending === null) return;
  await writeApplyPending(
    host,
    pending.units.filter((name) => name !== unit),
    pending.config_hash,
  );
}

export async function clearApplyPending(host: Host): Promise<void> {
  await host.remove(APPLY_PENDING_PATH);
  await host.remove(LEGACY_STOP_MARKER_PATH);
}
