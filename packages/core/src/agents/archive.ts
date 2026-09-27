/**
 * The recovery archive of §6.6 step 2: a copy of everything a foundation update
 * is about to change, taken *before* it changes any of it.
 *
 * CloudFormation rolls a failed stack update back on its own, and
 * `_fleet.foundation_version` is only written at the update's commit point — so
 * the machine-recoverable failures need no archive. This is for the other kind:
 * an update that succeeded and was wrong. It is the answer to "what did the
 * fleet look like an hour ago", and it has to be readable by a human with the
 * AWS console and nothing else, which is why every part of it is JSON or an
 * object copied verbatim.
 *
 * Two halves, and the remote one is the one that matters: the bucket outlives
 * any one laptop. The local half is a `VACUUM INTO` of `hermetic.db` beside the
 * same JSON, for the operator whose laptop *is* the fleet's memory of what it
 * ran.
 *
 * Exactly one previous version is kept, on both sides. An archive that
 * accumulates is a bucket that grows without anybody deciding to, and the
 * version before this one is the only one a rollback could target.
 *
 * The invariant that orders everything below: **there is never a moment with
 * zero complete archives**. An update may be retried, and a retry re-runs this
 * phase against the same version — so a generation that already carries its
 * completion marker is the recovery point for the update still in progress and
 * is retained exactly as it stands, never purged and never rewritten. A
 * generation with no marker was never a recovery point, so a retry may replace
 * it; it is built under a staging location and published only once its own
 * marker has landed.
 *
 * §8.3 is absolute here: `ssm-paths.json` holds parameter *names*. Never
 * values, not even placeholders — an archive is the one artifact designed to be
 * read later by someone who was not there.
 */
import { existsSync, mkdirSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { FLEET_MANIFEST_KEY } from "../schema/index.ts";
import type { AgentEvent, OpEvent } from "../schema/index.ts";
import type { Backend } from "../backend/types.ts";
import { agentParamPrefix, hermeticParamPrefix } from "../backend/constants.ts";
import { evt } from "../events.ts";
import { checkAbort } from "../abort.ts";

/** The one root every archive lives under, remote and local alike. */
export const ARCHIVE_PREFIX = "archive/";

/** How many events per agent the archive keeps. Enough to read a boot back. */
export const ARCHIVE_EVENT_LIMIT = 200;

/**
 * Written last, and only once every other object is there. Its presence is the
 * whole of "this archive is complete": without it, an archive is a directory of
 * plausible-looking JSON that may be missing the half that mattered, and
 * nothing distinguishes it from a good one at the moment somebody needs it.
 *
 * It is also what makes a retry safe. A prefix carrying this key is the fleet's
 * only recovery point for the update being retried, so the phase leaves it
 * alone rather than rebuilding it out of whatever half-updated state the retry
 * can see.
 */
export const ARCHIVE_COMPLETE_KEY = "complete.json";

/**
 * What separates a generation being built from the published one, in both
 * halves: `archive/foundation-v3.staging-9f2c1a04/` remotely and
 * `foundation-v3-k7m2x9qa.staging-9f2c1a04` locally. One segment, so the remote
 * form is a prefix `stalePrefixes` can recognise and prune like any other.
 */
export const ARCHIVE_STAGING_MARK = ".staging-";

/** `archive/foundation-v3/` — the remote home of one archived version. */
export function archivePrefix(version: number): string {
  return `${ARCHIVE_PREFIX}foundation-v${version}/`;
}

/** `archive/foundation-v3.staging-9f2c1a04/` — one attempt, not yet published. */
export function archiveStagingPrefix(version: number, attempt: string): string {
  return `${ARCHIVE_PREFIX}foundation-v${version}${ARCHIVE_STAGING_MARK}${attempt}/`;
}

/** `foundation-v3-k7m2x9qa` — the local one, fleet-scoped because homes are not. */
export function archiveDirName(version: number, fleetId: string): string {
  return `foundation-v${version}-${fleetId}`;
}

/** Whether a remote prefix or a local directory name is a staging generation. */
export function isArchiveStagingName(name: string): boolean {
  return name.includes(ARCHIVE_STAGING_MARK);
}

/**
 * The published name a staging name belongs to: `foundation-v3-k7m2x9qa` for
 * `foundation-v3-k7m2x9qa.staging-9f2c1a04`, and the name itself otherwise.
 */
function publishedName(name: string): string {
  const mark = name.indexOf(ARCHIVE_STAGING_MARK);
  return mark === -1 ? name : name.slice(0, mark);
}

export interface ArchiveDeps {
  backend: Backend;
  /**
   * `${hermeticHome}/archive/`. Absent in fixture mode and in tests that have no
   * home, and its absence is the whole of "skip the local archive" — there is no
   * separate flag to get out of step with it.
   */
  archiveDir?: string | undefined;
  /**
   * `VACUUM INTO` on the open local database (`local/db.ts`'s `archiveTo`).
   * Absent whenever `archiveDir` is, and for the same reason.
   */
  archiveLocalDb?: ((path: string) => void) | undefined;
  nowIso: () => string;
  /**
   * The id distinguishing this run's staging generation from an abandoned one.
   * Defaults to a random one; a test that wants to name the staging location it
   * asserts on passes its own. It cannot come from the clock: a fixture clock is
   * fixed on purpose, and two attempts would collide on it.
   */
  attemptId?: () => string;
}

export interface ArchiveTarget {
  fleetId: string;
  /** The version being archived: the one the fleet is on *now*, before the update. */
  version: number;
  /** Who is running the update, recorded in `archived-at.json`. */
  actor: string;
  /** The slice of the op's progress bar this phase owns. */
  from: number;
  to: number;
  /**
   * Called between objects. A fleet with a hundred config tarballs is a long
   * enough copy to outlive the caller's TTL lock, so it is kept alive from in
   * here rather than only between phases (§4.4).
   */
  heartbeat?: () => Promise<void>;
  signal?: AbortSignal;
}

export interface ArchiveResult {
  prefix: string;
  /** Every key written under `prefix`, sorted. */
  keys: string[];
  /** The local directory, or null when there was no home to write one into. */
  localDir: string | null;
  /**
   * True when an already-complete generation was found and kept rather than
   * rebuilt — the same-version retry of §6.6. Reported per half, because a
   * laptop that has never run this update has a local half to write even when
   * the bucket's is already there.
   */
  retained: { remote: boolean; local: boolean };
  /** Prefixes and directories removed to keep exactly one previous version. */
  pruned: { remote: string[]; local: string[] };
}

function json(value: unknown): Uint8Array {
  return new TextEncoder().encode(`${JSON.stringify(value, null, 2)}\n`);
}

export function createArchive(deps: ArchiveDeps) {
  const { backend, nowIso } = deps;
  const newAttemptId = deps.attemptId ?? (() => crypto.randomUUID().slice(0, 8));

  /**
   * The JSON half, built once and written to both halves of the archive. It is
   * assembled in memory rather than streamed because it is small — a fleet's
   * rows, its last two hundred events per agent, and two lists of names — and
   * because the local and the remote copy must be the same bytes.
   */
  async function documents(target: ArchiveTarget): Promise<Record<string, Uint8Array>> {
    const fleet = await backend.store.fleet.get();
    const agents = await backend.store.agents.scan();
    const events: Record<string, AgentEvent[]> = {};
    for (const agent of agents) {
      events[agent.name] = await backend.store.events.query(agent.name, ARCHIVE_EVENT_LIMIT);
    }
    /**
     * Names only (§8.3). `secrets.list` returns paths, never values, and this is
     * the only call in the archive that goes near SSM at all — the archive
     * records *which slots existed*, which is what a recovery needs, and the
     * values stay where only the instance role can read them.
     */
    const ssmPaths =
      fleet === null
        ? []
        : [
            ...(await backend.secrets.list(hermeticParamPrefix(fleet.fleet_id))),
            ...(await backend.secrets.list(agentParamPrefix(fleet.fleet_id))),
          ].sort();
    // The bucket as it stands, minus the archive itself: a listing that included
    // the previous archive would double in size on every update.
    const listing = (await backend.artifacts.list("")).filter((k) => !k.startsWith(ARCHIVE_PREFIX));
    return {
      "fleet.json": json(fleet),
      "agents.json": json(agents),
      "events.json": json(events),
      "ssm-paths.json": json(ssmPaths),
      "s3-listing.json": json(listing),
      "archived-at.json": json({
        archived_at: nowIso(),
        archived_by: target.actor,
        fleet_id: target.fleetId,
        foundation_version: target.version,
      }),
    };
  }

  /** The bytes of the completion marker, identical in both halves. */
  function completionMarker(target: ArchiveTarget, objects: number): Uint8Array {
    return json({
      complete: true,
      archived_at: nowIso(),
      fleet_id: target.fleetId,
      foundation_version: target.version,
      objects,
    });
  }

  /**
   * Every `archive/<something>/` prefix that is neither this version's nor the
   * generation currently being staged. Abandoned staging prefixes are listed
   * like any other: once the published marker is there they are debris, and
   * nothing else ever cleans them up. The in-flight one is excluded by name
   * rather than by luck — this runs after that prefix has been purged, but a
   * second laptop mid-update is not a reason to delete its working copy.
   */
  async function stalePrefixes(keep: string, inFlight?: string): Promise<string[]> {
    const keys = await backend.artifacts.list(ARCHIVE_PREFIX);
    const prefixes = new Set<string>();
    for (const key of keys) {
      const rest = key.slice(ARCHIVE_PREFIX.length);
      const slash = rest.indexOf("/");
      if (slash <= 0) continue;
      const prefix = `${ARCHIVE_PREFIX}${rest.slice(0, slash)}/`;
      if (prefix !== keep && prefix !== inFlight) prefixes.add(prefix);
    }
    return [...prefixes].sort();
  }

  /**
   * The archive, as an op phase. Yields as it goes — a fleet with thirty agents
   * and a hundred config objects is a minute of copying, and a phase that says
   * nothing for a minute is the thing the `kind: start`/`done` pair exists to
   * fix (§3.2 rule 2).
   */
  async function* archive(target: ArchiveTarget): AsyncGenerator<OpEvent, ArchiveResult> {
    const prefix = archivePrefix(target.version);
    const span = target.to - target.from;
    const at = (fraction: number) => target.from + span * fraction;
    const abort = () => checkAbort(target.signal, "archive");
    yield evt(
      "archive",
      target.from,
      `archiving foundation v${target.version} to s3://…/${prefix} before anything changes`,
      nowIso(),
      undefined,
      "start",
    );

    /**
     * Built at most once, and only if some half actually needs it: the retry
     * that finds both halves complete reads nothing and writes nothing.
     */
    let built: Record<string, Uint8Array> | undefined;
    const docs = async (): Promise<Record<string, Uint8Array>> => {
      if (built === undefined) built = await documents(target);
      return built;
    };

    let keys: string[];
    let staging: string | undefined;
    const retainedRemote = await backend.artifacts.exists(`${prefix}${ARCHIVE_COMPLETE_KEY}`);
    if (retainedRemote) {
      /**
       * A same-version retry after an attempt that archived cleanly and then
       * failed in a later phase. This prefix is the snapshot of the fleet as it
       * stood *before* the update started, which is the thing worth having;
       * rebuilding it now would replace it with a picture of a fleet the update
       * has already half-changed, and the window in between would be the one
       * moment §6.6 promises never happens.
       */
      keys = (await backend.artifacts.list(prefix)).sort();
      yield evt(
        "archive",
        at(0.6),
        `archive for v${target.version} already complete; retaining it (${keys.length} object(s) under ${prefix})`,
        nowIso(),
      );
    } else {
      const result = yield* writeRemote(target, prefix, at, abort, docs);
      keys = result.keys;
      staging = result.staging;
    }

    const local = yield* archiveLocally(target, docs, at(0.75));

    /**
     * The previous version's archive is deleted **after** this version's marker
     * exists, never before, so there is never a moment with zero complete
     * archives. Pruning first — which is what this did — meant an abort or a
     * failure in the middle of the copy left the fleet with no recovery point at
     * all, immediately before the phase that changes everything.
     */
    const stale = await stalePrefixes(prefix, staging);
    for (const gone of stale) {
      await target.heartbeat?.();
      // Version-aware: the bucket is versioned (§5), so a plain delete would
      // write a delete marker over each object and free nothing — an archive
      // that "keeps exactly one previous version" would grow forever.
      const removed = await backend.artifacts.purgeByPrefix(gone);
      const what = isArchiveStagingName(gone) ? "an abandoned staging archive" : "the previous archive";
      yield evt(
        "archive",
        at(0.95),
        `removed ${what} ${gone} (${removed} object version(s))`,
        nowIso(),
      );
    }

    yield evt(
      "archive",
      target.to,
      `archived foundation v${target.version}: ${keys.length} object(s) under ${prefix}${local.localDir ? ` and ${local.localDir}` : ""}`,
      nowIso(),
      undefined,
      "done",
    );
    return {
      prefix,
      keys: keys.sort(),
      localDir: local.localDir,
      retained: { remote: retainedRemote, local: local.retained },
      pruned: { remote: stale, local: local.prunedLocal },
    };
  }

  /**
   * One generation of the remote half, built from nothing.
   *
   * Where it is built depends on what is already under the published prefix. An
   * empty prefix is written in place: there is nothing there to lose, and the
   * copy is the cheapest it can be. A prefix holding objects but no marker is a
   * truncated attempt — worthless as a recovery point, but the keys under it are
   * not necessarily the keys this run will write, and a `config/ghost/…` object
   * belonging to an agent destroyed since would otherwise blend into the new
   * archive and leave one prefix describing two different states of the fleet.
   * So that case is built under a staging prefix, published key by key once its
   * own marker is there, and the remnants are removed afterwards. Purging the
   * published prefix first would be simpler and is exactly what this must not
   * do: it turns a wrong reading of the marker into the loss of the archive.
   */
  async function* writeRemote(
    target: ArchiveTarget,
    prefix: string,
    at: (fraction: number) => number,
    abort: () => void,
    docs: () => Promise<Record<string, Uint8Array>>,
  ): AsyncGenerator<OpEvent, { keys: string[]; staging?: string }> {
    const remnants = await backend.artifacts.list(prefix);
    const staging =
      remnants.length > 0 ? archiveStagingPrefix(target.version, newAttemptId()) : undefined;
    const dest = staging ?? prefix;
    if (staging !== undefined) {
      yield evt(
        "archive",
        at(0.05),
        `${prefix} holds ${remnants.length} object(s) and no completion marker; building this attempt under ${staging}`,
        nowIso(),
      );
    }

    // Relative names, so the same list publishes staging into the final prefix.
    const names: string[] = [];
    // The manifest and the config tarballs are copied server-side rather than
    // read and re-uploaded: same bytes, and the laptop never holds them.
    if (await backend.artifacts.exists(FLEET_MANIFEST_KEY)) {
      await backend.artifacts.copy(FLEET_MANIFEST_KEY, `${dest}${FLEET_MANIFEST_KEY}`);
      names.push(FLEET_MANIFEST_KEY);
    }
    const configs = await backend.artifacts.list("config/");
    for (const key of configs) {
      // An abort mid-copy is a *failure*, not a shorter archive: silently
      // breaking out used to carry on and write the completion marker over an
      // archive missing most of its config objects.
      abort();
      await target.heartbeat?.();
      await backend.artifacts.copy(key, `${dest}${key}`);
      names.push(key);
    }
    yield evt(
      "archive",
      at(0.4),
      `copied the fleet manifest and ${configs.length} config object(s); release directories are immutable per version and are not copied`,
      nowIso(),
    );

    abort();
    const files = await docs();
    for (const [name, bytes] of Object.entries(files)) {
      abort();
      await backend.artifacts.putObject(`${dest}${name}`, bytes, "application/json");
      names.push(name);
    }
    yield evt(
      "archive",
      at(0.6),
      `wrote ${Object.keys(files).length} state document(s) to ${dest}`,
      nowIso(),
    );

    /**
     * The marker is the **last** object written, so an archive that stops
     * anywhere earlier is recognisably incomplete rather than plausibly whole.
     */
    abort();
    await backend.artifacts.putObject(
      `${dest}${ARCHIVE_COMPLETE_KEY}`,
      completionMarker(target, names.length + 1),
      "application/json",
    );

    if (staging === undefined) {
      return { keys: [...names, ARCHIVE_COMPLETE_KEY].map((n) => `${prefix}${n}`) };
    }

    /**
     * Publish. Server-side copies again, in the same order — payload first, the
     * marker last — so the published prefix is only ever "truncated as it
     * already was" or "complete", never "complete and wrong".
     */
    for (const name of names) {
      abort();
      await target.heartbeat?.();
      await backend.artifacts.copy(`${staging}${name}`, `${prefix}${name}`);
    }
    abort();
    await backend.artifacts.copy(
      `${staging}${ARCHIVE_COMPLETE_KEY}`,
      `${prefix}${ARCHIVE_COMPLETE_KEY}`,
    );
    const keys = [...names, ARCHIVE_COMPLETE_KEY].map((n) => `${prefix}${n}`);
    yield evt(
      "archive",
      at(0.7),
      `published ${staging} to ${prefix} (${keys.length} object(s))`,
      nowIso(),
    );

    // Only now: the staging copy, then whatever the truncated attempt left that
    // this one did not overwrite. Both version-aware, for the reason the prune
    // below is.
    await backend.artifacts.purgeByPrefix(staging);
    const written = new Set(keys);
    for (const gone of remnants.filter((k) => !written.has(k))) {
      await target.heartbeat?.();
      await backend.artifacts.purgeByPrefix(gone);
    }
    return { keys, staging };
  }

  /**
   * The laptop's half. Skipped — loudly, as an event rather than silently —
   * when there is no home to write into, which is every fixture session: a
   * fixture fleet's `hermetic.db` is a fixture, and copying it would put a fake
   * fleet's records in the operator's real archive directory (§4.6).
   *
   * Same rule as the remote half, for the same reason: a directory carrying
   * `complete.json` is the recovery point for the update being retried and is
   * left as it stands; anything else is rebuilt beside it and renamed into
   * place once its own marker is there.
   */
  async function* archiveLocally(
    target: ArchiveTarget,
    docs: () => Promise<Record<string, Uint8Array>>,
    progress: number,
  ): AsyncGenerator<OpEvent, { localDir: string | null; retained: boolean; prunedLocal: string[] }> {
    const root = deps.archiveDir;
    if (root === undefined) {
      yield evt("archive", progress, "fixture: local archive skipped", nowIso());
      return { localDir: null, retained: false, prunedLocal: [] };
    }
    const name = archiveDirName(target.version, target.fleetId);
    const dir = join(root, name);
    mkdirSync(root, { recursive: true });

    /**
     * Only *this fleet's* archives, and only once this version's own marker is
     * on disk. One `HERMETIC_HOME` can be pointed at a second fleet by
     * `init --reset`, and one laptop can hold the archives of both; deleting
     * every directory here regardless of name threw away the other fleet's only
     * local recovery point as a side effect of updating this one. The
     * `-<fleet_id>` suffix `archiveDirName` puts on is what scopes it — read
     * through any `.staging-<id>` suffix, so an abandoned staging directory of
     * this fleet is cleaned up and another fleet's is still not touched.
     */
    const mine = `-${target.fleetId}`;
    const prune = (): string[] => {
      const pruned: string[] = [];
      for (const entry of readdirSync(root, { withFileTypes: true })) {
        if (!entry.isDirectory() || entry.name === name) continue;
        if (!publishedName(entry.name).endsWith(mine)) continue;
        rmSync(join(root, entry.name), { recursive: true, force: true });
        pruned.push(entry.name);
      }
      return pruned.sort();
    };

    if (existsSync(join(dir, ARCHIVE_COMPLETE_KEY))) {
      const prunedLocal = prune();
      yield evt(
        "archive",
        progress,
        `the local archive at ${dir} is already complete; retaining it${prunedLocal.length > 0 ? ` (removed ${prunedLocal.join(", ")})` : ""}`,
        nowIso(),
      );
      return { localDir: dir, retained: true, prunedLocal };
    }

    // In place when there is nothing there; beside it when there is, because
    // what is there has no marker and its files are not necessarily this run's.
    const staged = existsSync(dir);
    const work = staged ? `${dir}${ARCHIVE_STAGING_MARK}${newAttemptId()}` : dir;
    // `VACUUM INTO` refuses an existing destination, and a staging directory
    // left by a run that died is not this run's.
    rmSync(work, { recursive: true, force: true });
    mkdirSync(work, { recursive: true });

    const files = await docs();
    for (const [file, bytes] of Object.entries(files)) writeFileSync(join(work, file), bytes);
    try {
      deps.archiveLocalDb?.(join(work, "hermetic.db"));
    } catch (e) {
      // A local copy that failed is not a reason to stop an update that has not
      // changed anything yet — but it is a reason to say so, and a reason not to
      // write the marker: what is on disk is missing the half the local archive
      // exists for. No marker means the next attempt rebuilds it, and no prune
      // means the previous local archive is still there to rebuild from.
      if (staged) {
        rmSync(dir, { recursive: true, force: true });
        renameSync(work, dir);
      }
      yield evt(
        "archive",
        progress,
        `could not copy the local database into ${dir}: ${e instanceof Error ? e.message : String(e)}`,
        nowIso(),
        "warn",
      );
      return { localDir: dir, retained: false, prunedLocal: [] };
    }
    writeFileSync(
      join(work, ARCHIVE_COMPLETE_KEY),
      completionMarker(target, Object.keys(files).length + 2),
    );
    if (staged) {
      rmSync(dir, { recursive: true, force: true });
      renameSync(work, dir);
    }

    const prunedLocal = prune();
    yield evt(
      "archive",
      progress,
      `wrote the local archive to ${dir}${prunedLocal.length > 0 ? ` (removed ${prunedLocal.join(", ")})` : ""}`,
      nowIso(),
    );
    return { localDir: dir, retained: false, prunedLocal };
  }

  return { archive };
}
