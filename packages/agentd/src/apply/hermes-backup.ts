/**
 * The pre-upgrade copy of `$HERMES_HOME` and the restore a downgrade runs from
 * it (design: Hermes v0.23.1 adoption, sections 5.3 and 5.5, decision D9).
 *
 * Upstream takes no backup when a new Hermes migrates its stores, and the
 * migration is not reversible, so hermeticd copies the state itself while the
 * units are stopped: every SQLite file with its sidecars, wherever it is, plus
 * the small config and scheduling files a rollback needs to be coherent. The
 * copy is root's, 0700, outside the agent's home, verified file by file and
 * published by one rename. A downgrade moves the current state aside (nothing
 * is deleted) and puts the copy back.
 *
 * Both run with the Hermes units stopped and under the apply lock: a staging
 * directory found here belongs to a crashed attempt, never a live one.
 */
import { AgentdError } from "../errors.ts";
import type { FileStat, Host } from "../host.ts";

/** Root-owned pre-upgrade copies of `$HERMES_HOME`, on the data volume but outside the agent's home. */
export const HERMES_BACKUP_ROOT = "/data/hermetic-backups";

export interface HermesBackup {
  /** The published backup directory. */
  readonly dir: string;
  /** True when an earlier validated backup for this version was reused. */
  readonly reused: boolean;
  readonly files: number;
  readonly bytes: number;
}

export interface HermesRestore {
  /** The backup that was restored. */
  readonly backup: string;
  /** Where the state found in `$HERMES_HOME` was moved. */
  readonly movedAside: string;
  readonly files: number;
}

const SQLITE_HEADER = "SQLite format 3\0";
const SIDECARS = ["-wal", "-shm", "-journal"] as const;
/** Rebuildable trees, at the home root and in every profile. */
const REBUILDABLE = /^(?:profiles\/[^/]+\/)?(?:installs|lazy-packages|cache|logs)$/;
/**
 * Paths kept whatever they hold, besides the SQLite files. `sessions/` holds
 * the gateway's `sessions.json`, a mirror of `state.db`'s routing table, so it
 * goes back with the `state.db` it mirrors.
 */
const FIXED_ROOTS =
  /^(?:cron|config\.yaml|gateway_state\.json|memories|sessions|profiles\/[^/]+\/(?:profile\.yaml|config\.yaml|cron|memories|sessions))$/;
const VERSION = /^[0-9A-Za-z][0-9A-Za-z.+_-]*$/;
const BACKUP_NAME = /^hermes-(.+)-(\d{8}T\d{6}Z(?:\.\d+)?)$/;
const STAGING_PREFIX = ".staging-";
const MANIFEST = "manifest.json";
/** The completion record a finished restore leaves in its `post-…` directory. */
const RESTORED = "restore.json";
/** Written before a restore moves anything, so a crash mid-restore can be found. */
const INTENT = "restore-intent.json";
/**
 * In a backup whose swap settled (finished, or gave up and restarted the old
 * Hermes): still restorable, never reused, since the state has moved on since.
 */
const SEALED = "sealed.json";
const MIN_MARGIN = 256 * 1024 * 1024;

interface DirEntry {
  readonly path: string;
  readonly mode: string;
  readonly uid: number;
  readonly gid: number;
}

interface FileEntry extends DirEntry {
  readonly size: number;
  readonly sha256: string;
}

interface Manifest {
  readonly format: 1;
  readonly from_version: string;
  readonly hermes_home: string;
  readonly created_at: string;
  /** What a restore moves aside before copying back: the covered trees, files and databases. */
  readonly roots: readonly string[];
  readonly databases: readonly string[];
  /** Every directory on the way to a root and inside one, parents first. */
  readonly dirs: readonly DirEntry[];
  readonly files: readonly FileEntry[];
}

/** What a walk of `$HERMES_HOME` found to keep. */
interface Coverage {
  readonly roots: string[];
  readonly databases: string[];
  readonly dirs: Map<string, FileStat>;
  readonly files: Map<string, FileStat>;
}

const backupFailed = (reason: string, message: string, detail: Record<string, unknown> = {}) =>
  new AgentdError("HERMES_BACKUP_FAILED", message, { reason, ...detail });

const restoreRefused = (reason: string, message: string, detail: Record<string, unknown> = {}) =>
  new AgentdError("HERMES_RESTORE_REFUSED", message, { reason, ...detail });

/**
 * Take the backup of `$HERMES_HOME` for `fromVersion`, the version about to be
 * replaced, or reuse `reuse`: the one the swap record names for this same
 * target, which no Hermes can have written past since (the units stay held).
 * No other backup is ever reused: one left by a crash before its record was
 * written may predate state an old Hermes wrote afterwards. Throws
 * `HERMES_BACKUP_FAILED` with nothing changed when it cannot be taken or does
 * not verify; the source is never written.
 */
export async function backupHermesHome(
  host: Host,
  opts: { readonly hermesHome: string; readonly fromVersion: string; readonly reuse?: string },
): Promise<HermesBackup> {
  const { hermesHome, fromVersion, reuse } = opts;
  if (!VERSION.test(fromVersion)) {
    throw backupFailed("bad-version", `not a version: ${JSON.stringify(fromVersion)}`);
  }
  try {
    await ensureBackupRoot(host);
    await settleStaging(host);

    if (
      reuse !== undefined &&
      !(await restoredBackups(host)).has(reuse) &&
      (await host.lstat(`${reuse}/${SEALED}`)) === null
    ) {
      const manifest = await validated(host, reuse, fromVersion, hermesHome);
      if (manifest) return summary(reuse, manifest, true);
    }

    const found = await cover(host, hermesHome);
    let bytes = 0;
    for (const stat of found.files.values()) bytes += stat.size;
    const fs = await host.filesystem(HERMES_BACKUP_ROOT);
    if (fs === null) {
      throw backupFailed("space-unknown", `could not measure free space under ${HERMES_BACKUP_ROOT}`);
    }
    const needed = bytes + Math.max(Math.ceil(bytes / 10), MIN_MARGIN);
    if (fs.available < needed) {
      throw backupFailed(
        "no-space",
        `the Hermes backup needs ${needed} bytes free under ${HERMES_BACKUP_ROOT}, ${fs.available} are`,
        { needed, available: fs.available },
      );
    }

    const name = await freeName(host, `hermes-${fromVersion}`);
    const dir = `${HERMES_BACKUP_ROOT}/${name}`;
    const staging = `${HERMES_BACKUP_ROOT}/${STAGING_PREFIX}${name}`;
    try {
      const manifest = await copyOut(host, hermesHome, fromVersion, found, staging);
      if ((await validated(host, staging, fromVersion, hermesHome)) === null) {
        throw backupFailed("unverified", `the backup at ${staging} did not re-verify`);
      }
      await host.rename(staging, dir);
      return summary(dir, manifest, false);
    } catch (error) {
      await host.remove(staging).catch(() => undefined);
      throw error;
    }
  } catch (error) {
    if (error instanceof AgentdError && error.code === "HERMES_BACKUP_FAILED") throw error;
    throw backupFailed("error", `the Hermes backup failed: ${messageOf(error)}`);
  }
}

/**
 * Put back the validated backup taken when `toVersion` was replaced, moving
 * what `$HERMES_HOME` holds now to `post-<leftVersion>-<timestamp>/` first.
 * `HERMES_RESTORE_REFUSED` means nothing moved; `HERMES_RESTORE_FAILED` means
 * the failure came after the move, and names where the moved state is.
 * `backup` pins the directory (a rollback restores the copy its own swap
 * took); otherwise the newest one for `toVersion` not already restored from
 * is used, and refused rather than passed over when it does not validate.
 */
export async function restoreHermesHome(
  host: Host,
  opts: {
    readonly hermesHome: string;
    readonly toVersion: string;
    readonly leftVersion: string;
    readonly backup?: string;
  },
): Promise<HermesRestore> {
  const { hermesHome, toVersion, leftVersion } = opts;
  if (!VERSION.test(toVersion) || !VERSION.test(leftVersion)) {
    throw restoreRefused("bad-version", `not a version pair: ${toVersion}, ${leftVersion}`);
  }
  let backup: string | null = null;
  let manifest: Manifest | null = null;
  let aside: string[];
  let post: string;
  let earlier: UnfinishedRestore[];
  try {
    // Only the newest copy not yet put back: falling through to an older one
    // would silently drop everything written since it was taken.
    let dir = opts.backup;
    if (dir === undefined) {
      const restored = await restoredBackups(host);
      dir = (await backupDirs(host, toVersion)).find((d) => !restored.has(d));
    }
    manifest = dir === undefined ? null : await validated(host, dir, toVersion, hermesHome);
    if (dir === undefined || manifest === null) {
      throw restoreRefused(
        "no-backup",
        dir === undefined
          ? `no backup of Hermes ${toVersion} under ${HERMES_BACKUP_ROOT}; refusing to downgrade without one`
          : `the backup ${dir} of Hermes ${toVersion} did not validate; refusing to downgrade without it`,
        dir === undefined ? {} : { path: dir },
      );
    }
    backup = dir;
    const home = await host.lstat(hermesHome);
    if (home === null || home.isSymlink || !home.isDirectory) {
      throw restoreRefused("unsafe-path", `${hermesHome} is not a directory`, { path: hermesHome });
    }
    const fs = await host.filesystem(HERMES_BACKUP_ROOT);
    const bytes = manifest.files.reduce((n, f) => n + f.size, 0);
    const needed = bytes + Math.max(Math.ceil(bytes / 10), MIN_MARGIN);
    if (fs === null || fs.available < needed) {
      throw restoreRefused("no-space", `restoring ${backup} needs ${needed} bytes free`, {
        needed,
        available: fs?.available ?? null,
      });
    }

    // A stale `-wal` beside a restored older database would be replayed into it.
    const now = await cover(host, hermesHome);
    const candidates = new Set([...manifest.roots, ...now.databases]);
    for (const db of [...manifest.databases, ...now.databases]) {
      for (const suffix of SIDECARS) candidates.add(db + suffix);
    }
    aside = [];
    for (const rel of outermost([...candidates])) {
      if ((await host.lstat(`${hermesHome}/${rel}`)) !== null) aside.push(rel);
    }
    // Directories the copy-back writes into but does not move must be real
    // ones: root following a symlink there would write outside the home.
    for (const d of manifest.dirs) {
      if (aside.some((r) => d.path === r || d.path.startsWith(`${r}/`))) continue;
      const found = await host.lstat(`${hermesHome}/${d.path}`);
      if (found !== null && (found.isSymlink || !found.isDirectory)) {
        throw restoreRefused("unsafe-path", `${hermesHome}/${d.path} is not a directory`, {
          path: `${hermesHome}/${d.path}`,
        });
      }
    }
    post = `${HERMES_BACKUP_ROOT}/${await freeName(host, `post-${leftVersion}`)}`;
    // Read before this restore completes, which already makes them read finished.
    earlier = await unfinishedRestores(host);
  } catch (error) {
    if (error instanceof AgentdError && error.code === "HERMES_RESTORE_REFUSED") throw error;
    throw restoreRefused("error", `the Hermes restore could not start: ${messageOf(error)}`);
  }

  const record = { restored_from: backup, to_version: toVersion, left_version: leftVersion };
  try {
    await host.mkdir(`${post}/home`, "0700");
    await host.chmod(post, "0700");
    await host.writeFile(`${post}/${INTENT}`, `${JSON.stringify(record, null, 2)}\n`, "0600");
    for (const rel of aside) {
      await mkdirs(host, post, `home/${dirname(rel)}`);
      await host.rename(`${hermesHome}/${rel}`, `${post}/home/${rel}`);
    }
    for (const d of manifest.dirs) {
      const path = `${hermesHome}/${d.path}`;
      if ((await host.lstat(path)) !== null) continue;
      await host.mkdir(path, "0700");
      await host.chown(path, d.uid, d.gid);
      await host.chmod(path, d.mode);
    }
    for (const f of manifest.files) {
      const path = `${hermesHome}/${f.path}`;
      await host.copyFile(`${backup}/home/${f.path}`, path);
      await host.chown(path, f.uid, f.gid);
      await host.chmod(path, f.mode);
      await verify(host, path, f);
    }
    const done = {
      ...record,
      completed_at: host.now().toISOString(),
      supersedes: earlier.filter((old) => old.backup === backup).map((old) => old.dir),
    };
    await host.writeFile(`${post}/${RESTORED}`, `${JSON.stringify(done, null, 2)}\n`, "0600");
  } catch (error) {
    throw new AgentdError(
      "HERMES_RESTORE_FAILED",
      `restoring ${backup} failed after the current state was moved to ${post}: ${messageOf(error)}`,
      { moved_aside: post, backup },
    );
  }
  // This restore finished what a crashed one from the same backup began. Best
  // effort: the completion record's `supersedes` already hides the old intent.
  for (const old of earlier) {
    if (old.backup !== backup) continue;
    const superseded = {
      restored_from: old.backup,
      to_version: old.toVersion,
      left_version: old.leftVersion,
      completed_at: host.now().toISOString(),
      superseded_by: post,
    };
    await host
      .writeFile(`${old.dir}/${RESTORED}`, `${JSON.stringify(superseded, null, 2)}\n`, "0600")
      .catch(() => undefined);
  }
  return { backup, movedAside: post, files: manifest.files.length };
}

export interface UnfinishedRestore {
  /** The `post-…` directory holding whatever the crashed restore moved aside. */
  readonly dir: string;
  readonly backup: string;
  readonly toVersion: string;
  readonly leftVersion: string;
}

/**
 * Restores that wrote their intent and never their completion record: a crash
 * mid-restore. Not one a later restore's completion record lists under
 * `supersedes`, whether or not its supersede mark landed: the live state is
 * that restore's, and "finishing" the old intent would move it aside again.
 * A record from before `supersedes` existed hides nothing: an intent shown
 * twice is a restore redone, one hidden is a half-restored home left running.
 */
export async function unfinishedRestores(host: Host): Promise<UnfinishedRestore[]> {
  if ((await host.lstat(HERMES_BACKUP_ROOT)) === null) return [];
  const out: UnfinishedRestore[] = [];
  const superseded = new Set<string>();
  for (const name of await host.readdir(HERMES_BACKUP_ROOT)) {
    if (!name.startsWith("post-")) continue;
    const dir = `${HERMES_BACKUP_ROOT}/${name}`;
    const raw = await host.readFile(`${dir}/${RESTORED}`);
    if (raw !== null) {
      if (parseRecord(raw) !== null) {
        const listed = (JSON.parse(raw) as { supersedes?: unknown }).supersedes;
        if (Array.isArray(listed)) for (const d of listed) superseded.add(String(d));
      }
      continue;
    }
    const intent = parseRecord(await host.readFile(`${dir}/${INTENT}`));
    if (intent !== null) out.push({ dir, ...intent });
  }
  return out.filter((u) => !superseded.has(u.dir));
}

/**
 * Whether a restore from `leftVersion` (`null`: any) back to `toVersion` ever
 * completed, or, given `since` (an ISO time), completed at or after it.
 */
export async function restoredBefore(
  host: Host,
  leftVersion: string | null,
  toVersion: string,
  since?: string,
): Promise<boolean> {
  if ((await host.lstat(HERMES_BACKUP_ROOT)) === null) return false;
  for (const name of await host.readdir(HERMES_BACKUP_ROOT)) {
    if (!name.startsWith("post-")) continue;
    const raw = await host.readFile(`${HERMES_BACKUP_ROOT}/${name}/${RESTORED}`);
    const done = parseRecord(raw);
    if (done === null || done.toVersion !== toVersion) continue;
    if (leftVersion !== null && done.leftVersion !== leftVersion) continue;
    if (since === undefined) return true;
    const at = (JSON.parse(raw as string) as { completed_at?: unknown }).completed_at;
    if (typeof at === "string" && at >= since) return true;
  }
  return false;
}

/**
 * The version the newest restore completed at or after `since` put back, not
 * one a later restore superseded; `null` when none did.
 */
export async function lastRestoreSince(host: Host, since: string): Promise<string | null> {
  if ((await host.lstat(HERMES_BACKUP_ROOT)) === null) return null;
  let newest: { at: string; toVersion: string } | null = null;
  for (const name of await host.readdir(HERMES_BACKUP_ROOT)) {
    if (!name.startsWith("post-")) continue;
    const raw = await host.readFile(`${HERMES_BACKUP_ROOT}/${name}/${RESTORED}`);
    const done = parseRecord(raw);
    if (done === null) continue;
    const rec = JSON.parse(raw as string) as { completed_at?: unknown; superseded_by?: unknown };
    const at = rec.completed_at;
    if (rec.superseded_by !== undefined || typeof at !== "string" || at < since) continue;
    if (newest === null || at > newest.at) newest = { at, toVersion: done.toVersion };
  }
  return newest?.toVersion ?? null;
}

/**
 * The `post-…` directory of a restore of `backup`, from `leftVersion` back to
 * `toVersion`, that completed at or after `since` itself (not one it superseded).
 */
export async function completedRestore(
  host: Host,
  opts: { readonly backup: string; readonly toVersion: string; readonly leftVersion: string },
  since: string,
): Promise<string | null> {
  if ((await host.lstat(HERMES_BACKUP_ROOT)) === null) return null;
  for (const name of await host.readdir(HERMES_BACKUP_ROOT)) {
    if (!name.startsWith("post-")) continue;
    const raw = await host.readFile(`${HERMES_BACKUP_ROOT}/${name}/${RESTORED}`);
    const done = parseRecord(raw);
    if (done?.backup !== opts.backup || done.toVersion !== opts.toVersion) continue;
    if (done.leftVersion !== opts.leftVersion) continue;
    const rec = JSON.parse(raw as string) as { completed_at?: unknown; superseded_by?: unknown };
    if (rec.superseded_by !== undefined) continue;
    if (typeof rec.completed_at === "string" && rec.completed_at >= since) {
      return `${HERMES_BACKUP_ROOT}/${name}`;
    }
  }
  return null;
}

/**
 * Seal every backup not yet sealed: called once a swap has settled, so a later
 * swap from the same version takes a fresh copy rather than reusing one whose
 * state has since moved on. Sealed backups stay restorable.
 */
export async function sealBackups(host: Host): Promise<void> {
  if ((await host.lstat(HERMES_BACKUP_ROOT)) === null) return;
  for (const name of await host.readdir(HERMES_BACKUP_ROOT)) {
    if (!BACKUP_NAME.test(name)) continue;
    const seal = `${HERMES_BACKUP_ROOT}/${name}/${SEALED}`;
    if ((await host.lstat(seal)) !== null) continue;
    await host.writeFile(seal, `${JSON.stringify({ sealed_at: host.now().toISOString() })}\n`, "0600");
  }
}

function parseRecord(
  raw: string | null,
): { backup: string; toVersion: string; leftVersion: string } | null {
  if (raw === null) return null;
  try {
    const r = JSON.parse(raw) as Record<string, unknown>;
    const { restored_from: backup, to_version: toVersion, left_version: leftVersion } = r;
    if (
      typeof backup !== "string" ||
      typeof toVersion !== "string" ||
      typeof leftVersion !== "string"
    ) {
      return null;
    }
    return { backup, toVersion, leftVersion };
  } catch {
    return null;
  }
}

// --- the walk --------------------------------------------------------------

/**
 * Everything to keep under `home`: one walk, no symlink followed and none
 * kept, sockets and FIFOs skipped. A file is a database by its header, not
 * its name.
 */
async function cover(host: Host, home: string): Promise<Coverage> {
  const top = await host.lstat(home);
  const all = { dirs: new Map<string, FileStat>(), files: new Map<string, FileStat>() };
  if (top !== null && (top.isSymlink || !top.isDirectory)) {
    throw backupFailed("unsafe-path", `${home} is not a directory`, { path: home });
  }
  if (top !== null) await walk(host, home, "", all);

  const databases: string[] = [];
  for (const rel of all.files.keys()) {
    const head = await host.readPrefix(`${home}/${rel}`, SQLITE_HEADER.length);
    if (head !== null && [...SQLITE_HEADER].every((c, i) => head[i] === c.charCodeAt(0))) {
      databases.push(rel);
    }
  }
  const roots = new Set<string>(databases);
  for (const db of databases) for (const s of SIDECARS) if (all.files.has(db + s)) roots.add(db + s);
  for (const rel of [...all.files.keys(), ...all.dirs.keys()])
    if (FIXED_ROOTS.test(rel)) roots.add(rel);

  const kept = outermost([...roots]);
  const under = (rel: string): boolean => kept.some((r) => rel === r || rel.startsWith(`${r}/`));
  const ancestor = (rel: string): boolean => kept.some((r) => r.startsWith(`${rel}/`));
  const dirs = new Map([...all.dirs].filter(([rel]) => under(rel) || ancestor(rel)));
  const files = new Map([...all.files].filter(([rel]) => under(rel)));
  return { roots: kept, databases: databases.sort(), dirs, files };
}

async function walk(
  host: Host,
  home: string,
  rel: string,
  out: { dirs: Map<string, FileStat>; files: Map<string, FileStat> },
): Promise<void> {
  for (const name of await host.readdir(rel === "" ? home : `${home}/${rel}`)) {
    const child = rel === "" ? name : `${rel}/${name}`;
    if (REBUILDABLE.test(child)) continue;
    const stat = await host.lstat(`${home}/${child}`);
    if (stat === null || stat.isSymlink) continue;
    if (stat.isDirectory) {
      out.dirs.set(child, stat);
      await walk(host, home, child, out);
    } else if (stat.isFile) {
      out.files.set(child, stat);
    }
  }
}

/** The paths with no ancestor in the list, sorted. */
function outermost(paths: string[]): string[] {
  const sorted = [...new Set(paths)].sort();
  return sorted.filter((p) => !sorted.some((q) => q !== p && p.startsWith(`${q}/`)));
}

// --- the copy --------------------------------------------------------------

async function copyOut(
  host: Host,
  home: string,
  fromVersion: string,
  found: Coverage,
  staging: string,
): Promise<Manifest> {
  await host.mkdir(`${staging}/home`, "0700");
  await host.chmod(staging, "0700");
  await host.chmod(`${staging}/home`, "0700");
  const dirs: DirEntry[] = [];
  for (const rel of [...found.dirs.keys()].sort()) {
    const stat = found.dirs.get(rel) as FileStat;
    await host.mkdir(`${staging}/home/${rel}`, "0700");
    await host.chmod(`${staging}/home/${rel}`, "0700");
    dirs.push({ path: rel, mode: stat.mode, uid: stat.uid, gid: stat.gid });
  }
  const files: FileEntry[] = [];
  for (const rel of [...found.files.keys()].sort()) {
    const stat = found.files.get(rel) as FileStat;
    const source = `${home}/${rel}`;
    const copy = `${staging}/home/${rel}`;
    await host.copyFile(source, copy);
    const sha256 = await host.sha256File(source);
    const after = await host.lstat(source);
    if (sha256 === null || after === null || after.size !== stat.size) {
      throw backupFailed("source-changed", `${source} changed while it was being copied`, {
        path: source,
      });
    }
    const entry = { path: rel, size: stat.size, sha256, mode: stat.mode, uid: stat.uid, gid: stat.gid };
    await verify(host, copy, entry);
    files.push(entry);
  }
  const manifest: Manifest = {
    format: 1,
    from_version: fromVersion,
    hermes_home: home,
    created_at: host.now().toISOString(),
    roots: found.roots,
    databases: found.databases,
    dirs,
    files,
  };
  await host.writeFile(`${staging}/${MANIFEST}`, `${JSON.stringify(manifest, null, 2)}\n`, "0600");
  return manifest;
}

/** Size and sha256 of `path` against `entry`; throws on any difference. */
async function verify(host: Host, path: string, entry: FileEntry): Promise<void> {
  const stat = await host.lstat(path);
  const sha256 = stat?.isFile ? await host.sha256File(path) : null;
  if (stat?.size !== entry.size || sha256 !== entry.sha256) {
    throw backupFailed("mismatch", `${path} does not match ${entry.path} (size or sha256)`, {
      path,
      expected: { size: entry.size, sha256: entry.sha256 },
      found: { size: stat?.size ?? null, sha256 },
    });
  }
}

// --- the backup tree -------------------------------------------------------

export async function ensureBackupRoot(host: Host): Promise<void> {
  const found = await host.lstat(HERMES_BACKUP_ROOT);
  if (found !== null && (found.isSymlink || !found.isDirectory)) {
    throw backupFailed("unsafe-path", `${HERMES_BACKUP_ROOT} is not a directory`, {
      path: HERMES_BACKUP_ROOT,
    });
  }
  await host.mkdir(HERMES_BACKUP_ROOT, "0700");
  await host.chown(HERMES_BACKUP_ROOT, 0, 0);
  await host.chmod(HERMES_BACKUP_ROOT, "0700");
}

/**
 * A crashed attempt's staging directory is deleted, never published: even a
 * complete one is a copy of a state an old Hermes may have written past since.
 */
async function settleStaging(host: Host): Promise<void> {
  for (const entry of await host.readdir(HERMES_BACKUP_ROOT)) {
    if (entry.startsWith(STAGING_PREFIX)) await host.remove(`${HERMES_BACKUP_ROOT}/${entry}`);
  }
}

/** This version's backup directories, newest first. */
async function backupDirs(host: Host, version: string): Promise<string[]> {
  const names = (await host.readdir(HERMES_BACKUP_ROOT))
    .filter((n) => BACKUP_NAME.exec(n)?.[1] === version)
    .sort((a, b) =>
      (BACKUP_NAME.exec(a)?.[2] ?? "").localeCompare(BACKUP_NAME.exec(b)?.[2] ?? "", "en", {
        numeric: true,
      }),
    );
  return names.reverse().map((n) => `${HERMES_BACKUP_ROOT}/${n}`);
}

/**
 * Backups a finished restore already put back. Reusing one for a later
 * upgrade would make the next rollback return to a state older than the one
 * that upgrade replaced.
 */
async function restoredBackups(host: Host): Promise<Set<string>> {
  const out = new Set<string>();
  for (const name of await host.readdir(HERMES_BACKUP_ROOT)) {
    if (!name.startsWith("post-")) continue;
    const raw = await host.readFile(`${HERMES_BACKUP_ROOT}/${name}/${RESTORED}`);
    if (raw === null) continue;
    try {
      const from = (JSON.parse(raw) as { restored_from?: unknown }).restored_from;
      if (typeof from === "string") out.add(from);
    } catch {
      // An unreadable record marks nothing: the backup stays reusable.
    }
  }
  return out;
}

/**
 * The manifest, when it parses, names this version and home, and every file
 * it lists is in the backup with its size and sha256. `null` otherwise: such
 * a directory is not trusted, and not deleted either.
 */
async function validated(
  host: Host,
  dir: string,
  version: string,
  home: string,
): Promise<Manifest | null> {
  const found = await host.lstat(dir);
  if (found === null || found.isSymlink || !found.isDirectory) return null;
  const raw = await host.readFile(`${dir}/${MANIFEST}`);
  const manifest = raw === null ? null : parseManifest(raw);
  if (manifest === null || manifest.from_version !== version || manifest.hermes_home !== home) {
    return null;
  }
  try {
    for (const f of manifest.files) await verify(host, `${dir}/home/${f.path}`, f);
  } catch {
    return null;
  }
  return manifest;
}

function parseManifest(raw: string): Manifest | null {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null) return null;
  const m = value as Record<string, unknown>;
  const strings = (v: unknown): v is string[] => Array.isArray(v) && v.every((s) => isRel(s));
  const entry = (v: unknown, file: boolean): boolean => {
    if (typeof v !== "object" || v === null) return false;
    const e = v as Record<string, unknown>;
    const ok =
      isRel(e.path) &&
      typeof e.mode === "string" &&
      /^0[0-7]{3}$/.test(e.mode) &&
      Number.isInteger(e.uid) &&
      Number.isInteger(e.gid);
    return file ? ok && Number.isInteger(e.size) && typeof e.sha256 === "string" : ok;
  };
  if (
    m.format !== 1 ||
    typeof m.from_version !== "string" ||
    typeof m.hermes_home !== "string" ||
    typeof m.created_at !== "string" ||
    !strings(m.roots) ||
    !strings(m.databases) ||
    !Array.isArray(m.dirs) ||
    !m.dirs.every((d) => entry(d, false)) ||
    !Array.isArray(m.files) ||
    !m.files.every((f) => entry(f, true))
  ) {
    return null;
  }
  return value as Manifest;
}

/** A relative path with no `.`/`..` segment: a manifest may not name anything outside its tree. */
function isRel(v: unknown): v is string {
  return (
    typeof v === "string" &&
    v !== "" &&
    !v.startsWith("/") &&
    v.split("/").every((s) => s !== "" && s !== "." && s !== "..")
  );
}

// --- small helpers -----------------------------------------------------------

async function mkdirs(host: Host, base: string, rel: string): Promise<void> {
  let path = base;
  for (const part of rel.split("/").filter((p) => p !== "" && p !== ".")) {
    path = `${path}/${part}`;
    if ((await host.lstat(path)) === null) await host.mkdir(path, "0700");
  }
}

function dirname(rel: string): string {
  const slash = rel.lastIndexOf("/");
  return slash === -1 ? "" : rel.slice(0, slash);
}

/**
 * `<prefix>-<time>`, or `<prefix>-<time>.<n>` when an earlier backup or restore
 * took that second: names are never reused, so nothing is overwritten.
 */
async function freeName(host: Host, prefix: string): Promise<string> {
  const base = `${prefix}-${stamp(host.now())}`;
  for (let n = 0; ; n += 1) {
    const name = n === 0 ? base : `${base}.${n}`;
    const taken = [name, `${STAGING_PREFIX}${name}`];
    if (
      (await Promise.all(taken.map((t) => host.lstat(`${HERMES_BACKUP_ROOT}/${t}`)))).every(
        (s) => s === null,
      )
    ) {
      return name;
    }
  }
}

/** `20261115T120000Z`: UTC, sortable, safe in a file name. */
function stamp(at: Date): string {
  return at
    .toISOString()
    .replace(/\.\d{3}Z$/, "Z")
    .replace(/[-:]/g, "");
}

function summary(dir: string, manifest: Manifest, reused: boolean): HermesBackup {
  const bytes = manifest.files.reduce((n, f) => n + f.size, 0);
  return { dir, reused, files: manifest.files.length, bytes };
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
