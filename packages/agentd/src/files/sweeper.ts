/**
 * The files sweeper: TTLs, in-process, every `FILES_TTL.sweepInterval`.
 *
 * In hermeticd's own process rather than on a systemd timer because the index
 * has one writer (`store.ts`), and a timer would be a second.
 *
 * Two passes. The index pass deletes every entry past its `expires_at` — stage
 * after 1 h, inbox after the retention (the fleet's `files.retention_days`,
 * 7 d by default, fixed into an entry's `expires_at` when it lands), outbox
 * after 24 h, drop after 1 h — expires open requests past theirs (waking their long-polls), forgets
 * entries whose file has gone, and forgets closed requests a retention after
 * they expired so the index does not grow without bound. The disk pass catches
 * what the index cannot know about — a part file from an upload that died with
 * the process, a stage directory from an app that quit, anything left when an
 * unreadable index was started empty — by age on disk, with `find` run as
 * hermes under `/data` and as root in the root-owned drop. Its inbox age is
 * the retention in force at the sweep, so a fleet that lowers
 * `retention_days` has older inbox files cleared at the next sweep after the
 * box reads the new manifest; a raised one applies to files that land after.
 *
 * Neither pass touches an id some operation holds (`FilesStore.claim`): an
 * upload still streaming into its stage directory, a commit moving it, a
 * delete already removing it. The index pass skips a claimed entry until the
 * next tick; the disk pass excludes every claimed id by name. And a slot
 * stuck `receiving` past `FILES_TTL.receivingMax` is reclaimed here
 * (`reclaimStalled`), its upload aborted.
 *
 * **Never `/run/hermetic/files`.** Durable secrets live until `files rm`, and
 * are re-materialised from SSM at boot; nothing here reads or deletes them.
 *
 * Every step is best effort and logged; nothing throws into the loop.
 */
import {
  FILES_DROP_DIR,
  FILES_INBOX_DIR,
  FILES_OUTBOX_DIR,
  FILES_STAGE_DIR,
  FILES_TTL,
} from "@hermetic/core/shared";
import { asHermes } from "../account-dirs.ts";
import { type FilesCtx, inboxTtl, isDue } from "./context.ts";
import { entryPresent, removeEntryFiles } from "./entries.ts";
import { errorText } from "./errors.ts";
import { expireIfDue, reclaimStalled } from "./requests.ts";

const minutes = (seconds: number): string => `+${Math.max(1, Math.round(seconds / 60))}`;

/** What one sweep did, for the log and the tests. */
export interface SweepReport {
  readonly removed: number;
  readonly forgotten: number;
  readonly expired: number;
}

/** Ids this service generates: safe as a `find -name` pattern, with no glob characters. */
const SAFE_ID = /^[A-Za-z0-9_-]+$/;

/**
 * The disk pass, as argv. `find` never follows a symlink (`-P` is its default)
 * and `rm -rf` never descends through one, so a link the account planted is
 * removed as a link and nothing it points at is touched. `inFlight` ids — an
 * upload streaming for longer than the stage TTL — are excluded by name, as
 * their stage directory and as their part file.
 */
export function diskSweepCommands(
  inFlight: readonly string[] = [],
  inboxSeconds: number = FILES_TTL.inbox,
): string[][] {
  const stage = minutes(FILES_TTL.stage);
  const ids = inFlight.filter((id) => SAFE_ID.test(id));
  const skipDirs = ids.flatMap((id) => ["-not", "-name", id]);
  const skipParts = ids.flatMap((id) => ["-not", "-name", `.part-${id}`]);
  return [
    // Stage directories (and the part files in them) past the stage TTL.
    asHermes([
      "find",
      FILES_STAGE_DIR,
      "-mindepth",
      "1",
      "-maxdepth",
      "1",
      ...skipDirs,
      "-mmin",
      stage,
      "-exec",
      "rm",
      "-rf",
      "--",
      "{}",
      "+",
    ]),
    // Part files of request uploads that never finished: inbox/<day>/<id>/.part-*.
    asHermes([
      "find",
      FILES_INBOX_DIR,
      "-mindepth",
      "3",
      "-maxdepth",
      "3",
      "-name",
      ".part-*",
      ...skipParts,
      "-mmin",
      stage,
      "-delete",
    ]),
    // Dated inbox directories past the retention, whatever the index says.
    asHermes([
      "find",
      FILES_INBOX_DIR,
      "-mindepth",
      "1",
      "-maxdepth",
      "1",
      "-name",
      "????-??-??",
      "-mmin",
      minutes(inboxSeconds),
      "-exec",
      "rm",
      "-rf",
      "--",
      "{}",
      "+",
    ]),
    // Share directories past the outbox TTL; a share still being copied is skipped by id.
    asHermes([
      "find",
      FILES_OUTBOX_DIR,
      "-mindepth",
      "1",
      "-maxdepth",
      "1",
      ...skipDirs,
      "-mmin",
      minutes(FILES_TTL.outbox),
      "-exec",
      "rm",
      "-rf",
      "--",
      "{}",
      "+",
    ]),
    // Empty per-id and dated directories, once they have been empty a while.
    asHermes([
      "find",
      FILES_INBOX_DIR,
      "-mindepth",
      "1",
      "-maxdepth",
      "2",
      "-type",
      "d",
      "-empty",
      "-not",
      "-name",
      ".stage",
      "-mmin",
      stage,
      "-delete",
    ]),
    // The drop is root's: root sweeps it.
    [
      "find",
      FILES_DROP_DIR,
      "-mindepth",
      "1",
      "-maxdepth",
      "1",
      "-mmin",
      minutes(FILES_TTL.drop),
      "-exec",
      "rm",
      "-rf",
      "--",
      "{}",
      "+",
    ],
  ];
}

export async function sweepOnce(ctx: FilesCtx): Promise<SweepReport> {
  let removed = 0;
  let forgotten = 0;
  let expired = 0;
  const say = (what: string, e: unknown): void =>
    ctx.log(`files sweep: ${what} failed: ${errorText(e)}`);

  // Requests first: an expired slot's waiters should hear it this tick.
  try {
    const woken: string[] = [];
    const now = ctx.host.now().getTime();
    await ctx.store.mutate((index) => {
      for (const r of index.requests) {
        if (reclaimStalled(ctx, r)) woken.push(r.request_id);
        if (expireIfDue(ctx, r)) {
          expired += 1;
          woken.push(r.request_id);
        }
      }
      index.requests = index.requests.filter((r) => {
        if (r.state === "open" || r.state === "receiving") return true;
        return Date.parse(r.expires_at) + inboxTtl(ctx) * 1000 > now;
      });
    });
    for (const id of woken) ctx.store.wake(id);
  } catch (e) {
    say("request expiry", e);
  }

  // Entries past their TTL, and entries whose file has gone. A durable secret
  // has no TTL, and is skipped by name too.
  for (const seen of [...ctx.store.read().entries]) {
    if (seen.dir === "secret") continue;
    try {
      // The cheap checks first, unclaimed: an entry with nothing to do is never
      // claimed, so a commit or delete of it is not told 409 for a sweep that
      // was only looking.
      const due = seen.expires_at !== null && isDue(ctx.host, seen.expires_at);
      if (!due && (await entryPresent(ctx, seen))) continue;
    } catch (e) {
      // The check could not be made: keep the entry and try next tick.
      say(`entry ${seen.id}`, e);
      continue;
    }
    // Busy: a commit or delete is working on it. Next tick.
    const claim = ctx.store.claim(seen.id);
    if (claim === null) continue;
    try {
      // `seen` is from before every await above. Read the entry again under the
      // claim: a commit may have moved it to the inbox meanwhile, and acting on
      // the stale copy would delete the committed entry and orphan its file.
      const entry = ctx.store.read().entries.find((e) => e.id === seen.id);
      if (!entry || entry.dir !== seen.dir || entry.path !== seen.path) continue;
      if (entry.expires_at !== null && isDue(ctx.host, entry.expires_at)) {
        await removeEntryFiles(ctx, entry);
        await ctx.store.mutate((index) => {
          index.entries = index.entries.filter((e) => e.id !== entry.id);
        });
        removed += 1;
        continue;
      }
      if (!(await entryPresent(ctx, entry))) {
        await ctx.store.mutate((index) => {
          index.entries = index.entries.filter((e) => e.id !== entry.id);
        });
        forgotten += 1;
      }
    } catch (e) {
      say(`entry ${seen.id}`, e);
    } finally {
      claim.release();
    }
  }

  for (const argv of diskSweepCommands(ctx.store.inFlight(), inboxTtl(ctx))) {
    try {
      await ctx.host.exec(argv);
    } catch (e) {
      say("disk pass", e);
    }
  }

  if (removed + forgotten + expired > 0) {
    ctx.log(`files sweep: removed ${removed}, forgot ${forgotten}, expired ${expired} request(s)`);
  }
  return { removed, forgotten, expired };
}

/** Sweep now, then every `FILES_TTL.sweepInterval` until `signal` aborts. Never rejects. */
export async function sweepLoop(ctx: FilesCtx, signal: AbortSignal): Promise<void> {
  while (!signal.aborted) {
    await sweepOnce(ctx).catch((e: unknown) => {
      ctx.log(`files sweep failed: ${errorText(e)}`);
    });
    await ctx.delay(FILES_TTL.sweepInterval * 1000, signal);
  }
}
