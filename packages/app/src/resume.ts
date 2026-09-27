/**
 * Picking up ops whose process died (§4.6).
 *
 * `agents.create` can now wait as long as an instance takes to boot
 * (`core/attach.ts`), which makes "the portal was closed halfway through" the
 * ordinary case rather than the rare one. Every step of create records what it
 * produced on the agent row as it happens (§4.5), so re-running it costs a few
 * describes and finishes the job — but only if something re-runs it. This is
 * that something: at boot, every row still in the durable pending log is an op
 * whose process never reached an outcome, and it is started again under its
 * original id.
 *
 * Nothing here decides what "half done" means. It re-invokes the same core
 * method with the same input and lets core check reality, which is the only
 * place that knowledge is allowed to live (§4.5).
 *
 * Three things a boot does *not* do, and each of them used to lose work:
 *
 * - It does not replay a method that cannot be replayed safely. An interrupted
 *   `agents.recreate` is reported to the operator with the command that
 *   finishes it (`core/local/recovery.ts`), never re-run.
 * - It does not treat "somebody else holds the lock" as a failure. A lease can
 *   outlive the process that took it by the whole of its ten-minute TTL, so a
 *   boot inside that window meets a live lock through no fault of its own; the
 *   row waits the lease out and is tried again, rather than being cleared for
 *   ever by a refusal that was only ever about timing (§4.4).
 * - It does not take a lock from its owner to do either.
 */
import {
  REQUEST_SCHEMAS,
  manualRecovery,
  type FleetTarget,
  type Hermetic,
  type OpEvent,
  type PendingOp,
  type PendingOpIdentity,
  type PendingOpStore,
} from "@hermetic/core";
import { MIN_RETRY_WAIT_MS } from "./contention.ts";
import type { OpRegistry } from "./ops.ts";
import type { AppLog } from "./log.ts";

/**
 * How many boots may pick up the same op before it is dropped. An op that takes
 * the process down with it would otherwise be resumed forever and the portal
 * would never finish starting.
 */
export const MAX_RESUME_ATTEMPTS = 3;

/**
 * How old a pending row may be and still be acted on. A resume completes an
 * instruction the operator gave; a laptop opened a week later is not that
 * operator still waiting, and finishing a week-old `agents.destroy` because the
 * portal happened to boot would be an action nobody asked for *now*. Older rows
 * are dropped and logged — the agent row still says what state it is in, and
 * `doctor` still reports the drift, so nothing is lost except the automatic
 * finish.
 */
export const MAX_RESUME_AGE_MS = 24 * 60 * 60 * 1000;

/**
 * The methods a resume may re-invoke. Two rules decide membership, and both are
 * hard: the method must be idempotent against reality (it finds what already
 * exists rather than making a second one), and its input must carry no secret,
 * because a pending row is written to disk and replayed verbatim. `init` fails
 * the second test — its input carries the Tailscale OAuth client secret (§8.3) —
 * and `teardown` fails the first.
 *
 * `agents.destroy` passes both. It is destructive, but a pending row only
 * exists for a destroy an operator already confirmed with `--yes`, and finishing
 * it is strictly better than the alternative: a portal that died between the
 * terminate and the volume delete used to leave the agent stranded in
 * `destroying` with its instance already gone (§6.6).
 *
 * `agents.recreate` fails the first test and is deliberately absent. It
 * replaces a live instance unconditionally, so a replay of an interrupted one
 * can terminate the replacement the first attempt had already launched and
 * build a third in its place, rather than finishing an attachment that was one
 * step from done. Its row is still written, and still read here — but as
 * something to tell the operator about, not something to re-run
 * (`core/local/recovery.ts`).
 */
const RESUMABLE: Record<
  string,
  (h: Hermetic, input: never, signal: AbortSignal) => AsyncIterable<OpEvent>
> = {
  "agents.create": (h, input: Parameters<Hermetic["agents"]["create"]>[0], signal) =>
    h.agents.create(input, { signal }),
  "agents.destroy": (h, input: Parameters<Hermetic["agents"]["destroy"]>[0], signal) =>
    h.agents.destroy(input, { signal }),
};

/** Whether a method may be recorded as resumable in the first place. */
export function isResumable(method: string): boolean {
  return method in RESUMABLE;
}

export interface ResumeOptions {
  ops: OpRegistry;
  pending: PendingOpStore;
  hermetic: () => Hermetic;
  /**
   * §4.7, §4.8: the fleet this portal booted on, in full — account, region,
   * `fleet_id`. Only rows naming exactly this fleet are replayed; a create that
   * was running against `main` must not be finished by a portal that came back
   * up on `staging`, where the instance it is waiting for does not exist. The
   * rows of other fleets stay pending and are picked up by a portal that opens
   * them, and rows that name no fleet — or only part of one — are replayed by
   * nothing at all: a row that cannot say which account it belonged to is not
   * evidence that it belonged to this one.
   *
   * Required, and required to be stated even when it is `null`. It used to be
   * optional and to fall through to `pending.list()` — every row in the home,
   * whichever fleet wrote it — so a caller that could not say which fleet it
   * was on got the widest possible replay instead of the narrowest. `null` now
   * means the caller has no fleet, and a caller with no fleet resumes nothing:
   * the rows stay on disk for a boot that can name them.
   */
  fleet: FleetTarget | null;
  log?: AppLog;
  maxAttempts?: number;
  /** Rows older than this are dropped rather than resumed. Tests shorten it. */
  maxAgeMs?: number;
  now?: () => number;
  /**
   * How a retry that is waiting for somebody else's lease to lapse is booked
   * (§4.4). Defaults to an unreferenced timer, so a portal holding one can
   * still exit; tests hand in their own clock and run the callback themselves.
   */
  schedule?: (delayMs: number, run: () => void) => void;
}

export interface ResumeOutcome {
  resumed: string[];
  dropped: string[];
  /**
   * Rows this boot deliberately left alone: the agent they name is no longer
   * the agent they were confirmed against (§4.7). Unlike `dropped`, the row is
   * still on disk — an operator who still wants the work re-runs the command,
   * and the record of what they asked for is not thrown away to make a log line
   * tidier.
   */
  skipped: string[];
  /**
   * Rows whose last attempt met a lease that had not lapsed (§4.4): still on
   * disk, and booked to be tried again the moment it does. Waiting is the whole
   * point — the alternative is either dropping the operator's work because
   * somebody else was mid-operation, or taking ownership away from whoever
   * holds it. Only deferrals this pass *found* are listed; one this pass causes
   * is booked after it has returned.
   */
  deferred: string[];
  /**
   * Rows no boot may replay for the operator — an interrupted `agents.recreate`
   * (`core/local/recovery.ts`). Left on disk and reported, in the portal's log
   * and in `hermetic runs`, with the command that finishes the job.
   */
  manual: string[];
}

/**
 * The methods whose target is an agent that can be destroyed and re-created
 * under the same name. `agents.create` is not one of them: it names an agent
 * that did not exist when the row was written, so there is no identity to have
 * moved — a name taken in the meantime is `NAME_TAKEN` from core, which is the
 * right refusal and arrives on its own.
 */
const IDENTIFIED = new Set(["agents.destroy", "agents.recreate"]);

/**
 * Why this row must not be replayed, or `null` when the agent is still the one
 * the operator confirmed against.
 *
 * A read that fails means "cannot say", which is not the same as "has moved":
 * an unreachable table at boot must not silently cancel work the operator
 * asked for, and the resumed op will meet the same table a moment later and
 * report it properly.
 */
async function agentMoved(
  hermetic: Hermetic,
  name: string,
  identity: PendingOpIdentity,
): Promise<string | null> {
  let agent: { instance_id?: string | null; created_at?: string | null };
  try {
    agent = await hermetic.agents.get(name);
  } catch {
    return null;
  }
  const created = agent.created_at ?? null;
  if (identity.created_at !== null && created === null) {
    // Cannot say, which is not the same as agreeing. The row names a creation
    // time and the agent holding the name now reports none, so there is nothing
    // to compare a swap against — and this is a destroy (§4.6).
    return `not replaying ${name}: the agent by that name does not say when it was created, so this operation cannot tell whether it is still the one it was confirmed against; re-run it if you meant this one`;
  }
  if (identity.created_at !== null && created !== null && identity.created_at !== created) {
    return `not replaying ${name}: the agent by that name was created after this operation was confirmed, so it is a different agent; re-run it if you meant this one`;
  }
  const instance = agent.instance_id ?? null;
  if (identity.instance_id !== null && instance !== identity.instance_id) {
    return `not replaying ${name}: it was recreated since this operation was confirmed; re-run it if you still want it`;
  }
  return null;
}

/**
 * Re-start every op left in the pending log. Runs once at boot, before the
 * server starts listening — the ops themselves are background work, so this
 * returns as soon as they are kicked off, not when they finish.
 *
 * `async` for one reason: §4.7's identity check reads the agent row a destroy
 * or a recreate names before replaying it, and that is a round trip. Nothing
 * else here waits on anything.
 */
export async function resumePendingOps(opts: ResumeOptions): Promise<ResumeOutcome> {
  const max = opts.maxAttempts ?? MAX_RESUME_ATTEMPTS;
  const maxAge = opts.maxAgeMs ?? MAX_RESUME_AGE_MS;
  const clock = opts.now ?? Date.now;
  const schedule = opts.schedule ?? defaultSchedule;
  const outcome: ResumeOutcome = {
    resumed: [],
    dropped: [],
    skipped: [],
    deferred: [],
    manual: [],
  };

  /**
   * §4.7: no fleet, no replay. `pending.list()` with no argument answers with
   * every row in this home, whichever fleet wrote it, and that is not what a
   * boot with nothing to name should get — it is the opposite of it.
   */
  if (opts.fleet === null) {
    opts.log?.line(
      "warn",
      "resume",
      "not replaying any interrupted op: this server is serving no fleet, so no row can be shown to be its own",
    );
    return outcome;
  }
  const fleet = opts.fleet;
  /**
   * Which attempt at each op id this process has reached, so the stream a
   * browser is following can tell one attempt's sequence numbers from the
   * next's (`ops.ts`, `FollowOptions.generation`). Seeded from the durable
   * attempt count and advanced by every retry booked here.
   */
  const generations = new Map<string, number>();
  const generationFor = (id: string, floor: number): number => {
    const next = Math.max(generations.get(id) ?? 0, floor);
    generations.set(id, next + 1);
    return next;
  };

  /**
   * One row, considered. Runs at boot for every row this fleet owns, and again
   * whenever a deferred row's wait is up — the same checks either way, because
   * a retry an hour later is subject to exactly what a boot is: the row may
   * have aged out, the agent may have moved on, the method may be one no
   * machine replays.
   *
   * `boot` is the one difference. A boot counts as an attempt, because an op
   * that takes the process down with it must not be picked up for ever; a
   * retry that is waiting out somebody else's lease does not, because being
   * refused by a live lock is not evidence that this op is the one crashing.
   */
  const consider = async (row: PendingOp, boot: boolean): Promise<void> => {
    const now = clock();
    const drop = (why: string) => {
      opts.log?.line("warn", `resume:${row.method}`, `dropping ${row.id}: ${why}`, {
        target: row.target,
      });
      try {
        opts.pending.clear(row.id);
      } catch {
        /* nothing left to do about it */
      }
      outcome.dropped.push(row.id);
    };

    /**
     * §4.6: before anything else, because this is not a row to drop. An
     * interrupted `agents.recreate` is somebody's half-finished replacement,
     * and the only safe thing a machine can do with it is say so: replaying it
     * can destroy the instance the first attempt already built.
     */
    const recovery = manualRecovery(row);
    if (recovery !== null) {
      opts.log?.line("warn", `resume:${row.method}`, recovery.message, { target: row.target });
      if (boot) outcome.manual.push(row.id);
      return;
    }

    const start = RESUMABLE[row.method];
    if (!start) {
      drop(`${row.method} is not resumable`);
      return;
    }
    // The row came off disk, so it is input like any other: validated against
    // the same schema the route validated it with before it is handed to core.
    const schema = REQUEST_SCHEMAS[row.method as keyof typeof REQUEST_SCHEMAS];
    const parsed = schema === undefined ? null : schema.safeParse(row.input);
    if (parsed === null || !parsed.success) {
      drop("its recorded input no longer validates");
      return;
    }

    const startedAt = Date.parse(row.started_at);
    if (Number.isNaN(startedAt) || now - startedAt > maxAge) {
      drop(`it started ${row.started_at} and is too old to finish unattended`);
      return;
    }

    /**
     * §4.4: a lease that had not lapsed refused the last attempt, and the row
     * says when it does. Until then this is not work to do, to drop, or to take
     * from its owner — it is work to wait for.
     */
    const retryAt = row.retry_after == null ? Number.NaN : Date.parse(row.retry_after);
    if (!Number.isNaN(retryAt) && retryAt > now) {
      opts.log?.line(
        "info",
        `resume:${row.method}`,
        `${row.id} is waiting for another operator's lock; retrying at ${row.retry_after}`,
        { target: row.target },
      );
      if (boot) outcome.deferred.push(row.id);
      book(row.id, retryAt - now);
      return;
    }

    let attempts = row.attempts;
    if (boot) {
      try {
        attempts = opts.pending.attempted(row.id);
      } catch {
        attempts = row.attempts + 1;
      }
      if (attempts > max) {
        drop(`it has already been resumed ${max} time(s) without settling`);
        return;
      }
    }

    /**
     * §4.7: the row names an agent by name, and a name is a label that can be
     * freed and taken again. `target_identity` is what the agent looked like
     * when the operator confirmed — the instance it was on, and the moment its
     * row was created — and neither survives a destroy-and-recreate. A row
     * whose agent has moved on is left pending rather than acted on: finishing
     * it would apply somebody's old instruction to a new agent.
     *
     * Skipped, not dropped, and skipped only on a *disagreement*: a row from
     * before this field existed, or an agent that can no longer be read, is
     * handled exactly as it was before.
     */
    if (IDENTIFIED.has(row.method) && row.target !== null && row.target_identity != null) {
      const moved = await agentMoved(opts.hermetic(), row.target, row.target_identity);
      if (moved !== null) {
        opts.log?.line("warn", `resume:${row.method}`, moved, { target: row.target });
        if (boot) outcome.skipped.push(row.id);
        return;
      }
    }

    opts.log?.line("info", `resume:${row.method}`, `resuming ${row.id} (attempt ${attempts})`, {
      target: row.target,
      ...(row.phase == null ? {} : { phase: row.phase }),
    });
    opts.ops.start(
      row.method,
      row.target,
      (signal) => start(opts.hermetic(), parsed.data as never, signal),
      {
        input: parsed.data,
        resumable: true,
        resumedId: row.id,
        generation: generationFor(row.id, attempts),
      },
    );
    if (boot) outcome.resumed.push(row.id);
    // However this attempt ends, the row decides what happens next: cleared by
    // a settle, stamped with a retry time by a live lease (`ops.ts`).
    void opts.ops
      .wait(row.id)
      .then(() => {
        rebook(row.id);
      })
      .catch(() => {
        /* the registry does not reject; a wait that did is not a reason to fail a boot */
      });
  };

  /** The row as it stands now, or `null` once it has been cleared. */
  const reread = (id: string): PendingOp | null => {
    try {
      return opts.pending.list(fleet).find((r) => r.id === id) ?? null;
    } catch {
      return null;
    }
  };

  /** Books one retry, never sooner than the floor a clock skew could produce. */
  function book(id: string, delayMs: number): void {
    schedule(Math.max(delayMs, MIN_RETRY_WAIT_MS), () => {
      const row = reread(id);
      if (row === null) return;
      void consider(row, false);
    });
  }

  /** After an attempt settled: a row still on disk with a wait on it is owed a retry. */
  function rebook(id: string): void {
    const row = reread(id);
    if (row === null || row.retry_after == null) return;
    const retryAt = Date.parse(row.retry_after);
    if (Number.isNaN(retryAt)) return;
    book(id, retryAt - clock());
  }

  let rows: PendingOp[];
  try {
    rows = opts.pending.list(fleet);
    // Said once, as a fact rather than a warning: these are somebody's
    // unfinished work, they are still on disk, and this boot is not the one
    // that finishes them.
    const unattributed = opts.pending.listUnattributed();
    const others = opts.pending.list().length - rows.length - unattributed.length;
    if (others > 0) {
      opts.log?.line("info", "resume", `leaving ${others} pending op(s) of other fleets`, {
        fleet: fleet.fleet_id,
      });
    }
    /**
     * §4.7: louder, because these are not somebody else's rows — they are rows
     * nobody can claim. Written before the pending log recorded an account and
     * a region, so no boot can prove they were this fleet's, and replaying one
     * on a guess is exactly the mistake the columns exist to prevent. They stay
     * on disk: the row is the only local record that the command was ever
     * given.
     */
    for (const row of unattributed) {
      opts.log?.line(
        "warn",
        `resume:${row.method}`,
        `not replaying ${row.id}: it does not say which fleet it was against; re-run it if you still want it`,
        { target: row.target, started_at: row.started_at },
      );
    }
  } catch {
    // A pending log that cannot be read costs resumes, never correctness.
    return outcome;
  }

  for (const row of rows) await consider(row, true);
  return outcome;
}

/**
 * The default booking: a timer this process does not stay alive for. A portal
 * that is asked to exit while a retry is booked exits — the row is on disk, and
 * the next boot is another chance to finish it.
 */
function defaultSchedule(delayMs: number, run: () => void): void {
  const timer = setTimeout(run, delayMs);
  (timer as { unref?: () => void }).unref?.();
}
