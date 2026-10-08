/**
 * Getting an agent's data volume onto its instance, however long that takes.
 *
 * Split out of `hermetic.ts` (AGENTS.md rule 5) because it is the one step of
 * create that is *slow for ordinary reasons*: a fresh instance takes a minute or
 * two to reach `running`, and a volume released by a just-terminated instance
 * takes its own time to come free. Neither is a failure, so neither gets a
 * deadline — the wait is unbounded and ends only when it succeeds, when the
 * operator aborts, or when something genuinely fatal is true (the instance died,
 * the volume is somebody else's). A create that "failed" after three minutes of
 * a healthy AWS doing normal AWS things taught the operator to distrust the
 * dashboard; waiting and saying so does not.
 *
 * The wait is safe to abandon: every id it needs is already on the agent row
 * before it starts (§4.5), so a crashed laptop resumes here rather than
 * relaunching. That is what makes an unbounded wait affordable.
 *
 * One subtlety the first version got wrong: an id nobody has *ever* seen is not
 * the same answer as an id that has gone away. `RunInstances` returns an id
 * before `DescribeInstances` will admit it exists — EC2 is eventually
 * consistent, usually for seconds — so the very first poll of a just-launched
 * instance can answer `InvalidInstanceID.NotFound`, which `aws/ec2.ts` maps to
 * `null`. Reading that as "terminated" killed creates at random while the box
 * was in fact booting fine. So `null` before the instance has been seen once is
 * retryable for `INSTANCE_VISIBILITY_GRACE_MS`; `null` after it has been seen,
 * or past the grace, is still gone. A confirmed `terminated`/`shutting-down` is
 * a real answer from EC2 and stays fatal on the first poll.
 */
import type { ComputeApi, VolumeStatus } from "../backend/types.ts";
import { HermeticError } from "../errors.ts";
import { abortableSleep } from "../abort.ts";
import { evt } from "../events.ts";
import type { OpEvent } from "../schema/index.ts";

/** How long between polls while waiting for an instance or a volume. */
export const ATTACH_POLL_MS = 5_000;
/** How long the wait may go quiet before it yields another "still waiting". */
export const ATTACH_PROGRESS_MS = 15_000;
/**
 * How long a brand-new instance id may stay invisible to `DescribeInstances`
 * before we believe it is really gone. AWS documents describe-after-run lag as
 * usually seconds, occasionally longer; the surrounding wait is unbounded
 * anyway, so two minutes of patience costs nothing and buys back every create
 * that lost the race.
 */
export const INSTANCE_VISIBILITY_GRACE_MS = 120_000;

/** Instance states from which `running` is still ahead of us. */
const INSTANCE_COMING_UP = new Set(["pending"]);
/** Instance states from which `running` will never arrive without help. */
const INSTANCE_WONT_RUN = new Set(["shutting-down", "terminated", "stopping", "stopped"]);

/**
 * Volume states that resolve on their own. `creating` is a volume EC2 has not
 * finished making; `detaching`/`in-use` is one the previous instance has not
 * finished letting go of.
 */
const VOLUME_SETTLING = new Set(["creating", "detaching", "in-use"]);

/**
 * `in-use` is only worth waiting on while something is still attached: the
 * attachments checked above have already ruled out this instance and any live
 * holder, so `in-use` with nothing left on it is bookkeeping EC2 has not caught
 * up with, not a disk anybody is using. Try the attach and let the retry path
 * deal with a refusal, rather than waiting for a state change that has already
 * happened.
 */
function stillSettling(volume: VolumeStatus): boolean {
  if (!VOLUME_SETTLING.has(volume.state)) return false;
  return volume.state !== "in-use" || volume.attachments.length > 0;
}
/** Volume states nothing will improve. */
const VOLUME_DEAD = new Set(["deleting", "deleted", "error"]);

/**
 * Volume states that mean the disk is on its way out. `waitVolumeReleased` is
 * finished when it sees one: there is nothing left to free, and `DeleteVolume`
 * on a volume already deleting is a no-op rather than an error.
 */
const VOLUME_GOING = new Set(["deleting", "deleted"]);

/**
 * AWS names for "you asked too early", or "not right now". Everything else is a
 * real answer and is rethrown — an unbounded retry of a request that is wrong
 * rather than early would hang forever and never say why.
 *
 * They guard the *reads* as well as `AttachVolume`. A `RequestLimitExceeded` on
 * one `DescribeInstances` used to escape the whole unbounded wait and fail the
 * create — and with `--rollback-on-failure` that terminated a healthy instance
 * that was booting perfectly well, because EC2 was busy for one second.
 */
const TRANSIENT_ATTACH_ERRORS = new Set([
  "IncorrectState",
  "IncorrectInstanceState",
  "VolumeInUse",
  "RequestLimitExceeded",
  "Throttling",
  "ThrottlingException",
  "InternalError",
  "Unavailable",
]);

/**
 * The ceiling on the transient backoff. A wait that is unbounded overall still
 * has to keep asking often enough to notice the answer changing; an hour-long
 * gap between polls would turn "EC2 was throttling us" into "hermetic hung".
 */
export const ATTACH_BACKOFF_CAP_MS = 60_000;

export interface AttachDeps {
  compute: Pick<ComputeApi, "describeInstance" | "describeVolume" | "attachVolume">;
  /** Injected by tests so a poll loop is not a real five seconds. */
  pollMs?: number | undefined;
  progressMs?: number | undefined;
  /**
   * `destroy`'s bounded wait for its tailnet devices to read offline
   * (`TAILNET_OFFLINE_WAIT_MS`, `fleet/tailnet-devices.ts`). Carried here
   * because it runs on this same poll and clock; tests set it to zero.
   */
  tailnetOfflineMs?: number | undefined;
  now?: () => number;
  /** The jitter's source. Injected so a test can assert an exact delay. */
  random?: () => number;
}

export interface AttachOptions {
  signal?: AbortSignal;
  /**
   * Called once per poll. `create`/`recreate` renew their TTL lock here: a wait
   * longer than `LOCK_TTL_MS` would otherwise unlock a still-running create and
   * let a second operator start on top of it (§4.4).
   */
  heartbeat?: () => Promise<void>;
  /** Phase the yielded events carry. Callers keep their own rail's naming. */
  phase?: string;
  /** Progress the yielded events carry, start and finish. */
  progress?: { waiting: number; done: number };
}

function at(now: () => number): string {
  return new Date(now()).toISOString();
}

/** `HermeticError.details.aws_error`, when `asHermeticError` put one there. */
function awsErrorNameOf(e: unknown): string | null {
  if (!(e instanceof HermeticError)) return null;
  const name = e.details?.["aws_error"];
  return typeof name === "string" ? name : null;
}

/** The AWS error name, if this is one of the "ask again" answers; else null. */
function transientNameOf(e: unknown): string | null {
  const name = awsErrorNameOf(e);
  return name !== null && TRANSIENT_ATTACH_ERRORS.has(name) ? name : null;
}

/**
 * How long to wait after the nth consecutive transient refusal.
 *
 * Deliberately *not* the poll cadence. A poll is a question about a world that
 * is changing on its own ("is it running yet?") and five seconds is the right
 * rhythm for it; a transient refusal is AWS saying it has too much on, and
 * asking again at the same rate is a way of adding to the problem. So the delay
 * doubles from the poll interval up to `ATTACH_BACKOFF_CAP_MS`, with jitter, so
 * that a fleet of laptops throttled at once does not resynchronise into a
 * thundering herd. It is derived from `pollMs` rather than a constant of its
 * own so that a test running at a tick-sized cadence still backs off in ticks.
 */
function backoffMs(attempt: number, pollMs: number, random: () => number): number {
  const full = Math.min(ATTACH_BACKOFF_CAP_MS, pollMs * 2 ** Math.max(0, attempt - 1));
  // Equal jitter: half the delay is guaranteed, half is random, so the retries
  // spread out without any of them becoming arbitrarily eager.
  return full / 2 + random() * (full / 2);
}

/** What an unbounded wait does about AWS answering "not right now". */
export interface TransientRetries {
  /**
   * Called once at the top of every pass. A pass that got its answers resets
   * the backoff: it is about how busy AWS is *now*, not about how long this
   * wait has been going, so an instance that takes ten minutes to boot with one
   * throttled read in the middle must not end up polling once a minute.
   */
  pass(): void;
  /**
   * One failed call. Rethrows anything that is not a "too early"/"too busy"
   * answer — an unbounded retry of a request that is simply wrong would hang
   * forever and never say why — and otherwise says which call and which AWS
   * name, then sleeps for the backoff.
   */
  refused(call: string, e: unknown): AsyncGenerator<OpEvent>;
}

/**
 * The transient-refusal policy, shared by every unbounded wait (§4.5).
 *
 * There are three of them — the attach, the detach, and the re-run of `create`
 * asking about an instance the row already names — and they are the same wait
 * wearing different questions: poll a thing that changes on its own, forever,
 * abortably. A throttled `DescribeInstances` escaping any one of them fails an
 * operation for a reason that was never a failure, so the handling belongs in
 * one place rather than being remembered in three.
 *
 * `say` is the caller's, because each wait already has its own idea of how
 * often it repeats itself and under which phase.
 */
export function transientRetries(opts: {
  pollMs: number;
  random?: () => number;
  signal?: AbortSignal;
  say: (reason: string, level?: OpEvent["level"]) => Iterable<OpEvent>;
}): TransientRetries {
  const random = opts.random ?? Math.random;
  let refusals = 0;
  let refusedLastPass = false;
  return {
    pass(): void {
      if (!refusedLastPass) refusals = 0;
      refusedLastPass = false;
    },
    async *refused(call: string, e: unknown): AsyncGenerator<OpEvent> {
      const name = transientNameOf(e);
      if (name === null) throw e;
      refusals += 1;
      refusedLastPass = true;
      yield* opts.say(`${call} was refused as ${name}; retrying`, "warn");
      await abortableSleep(backoffMs(refusals, opts.pollMs, random), opts.signal);
    },
  };
}

/**
 * How long a wait has been going, in the one wording every long wait uses.
 * Exported because `lifecycle.ts`'s stop-wait says the same sentence about the
 * same kind of wait, and two copies drift into two vocabularies.
 */
export function elapsed(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 90) return `${s}s`;
  return `${Math.round(s / 60)}m`;
}

/** Is this volume already on this instance, as far as EC2 is concerned? */
function attachedHere(volume: VolumeStatus, instanceId: string): boolean {
  return volume.attachments.some(
    (a) => a.instance_id === instanceId && a.state !== "detached" && a.state !== "detaching",
  );
}

function heldElsewhere(volume: VolumeStatus, instanceId: string): string | null {
  const other = volume.attachments.find(
    (a) => a.instance_id !== instanceId && a.state !== "detached" && a.state !== "detaching",
  );
  return other?.instance_id ?? null;
}

/**
 * Attach `volumeId` to `instanceId`, waiting for both to be ready. Idempotent:
 * a volume already on this instance is success, so a resume after a crash
 * mid-attach costs one `DescribeVolumes`.
 *
 * Yields progress events; the caller decides what to do with them (`create` and
 * `recreate` both `yield*` this straight into their op stream, which is how the
 * dashboard shows a boot that is taking its time instead of a spinner).
 */
export async function* attachAgentVolume(
  deps: AttachDeps,
  instanceId: string,
  volumeId: string,
  opts: AttachOptions = {},
): AsyncGenerator<OpEvent> {
  const now = deps.now ?? Date.now;
  const pollMs = deps.pollMs ?? ATTACH_POLL_MS;
  const progressMs = deps.progressMs ?? ATTACH_PROGRESS_MS;
  const random = deps.random ?? Math.random;
  const phase = opts.phase ?? "instance";
  const waiting = opts.progress?.waiting ?? 0.9;
  const finished = opts.progress?.done ?? 0.92;

  const started = now();
  let lastSaid = 0;
  /** Say something the first time each distinct reason for waiting appears. */
  let lastReason = "";
  /**
   * Has `DescribeInstances` ever confirmed this id exists? Until it has, a
   * `null` is more likely to be EC2 catching up with `RunInstances` than an
   * instance that has died.
   */
  let seen = false;

  const say = function* (reason: string, level?: OpEvent["level"]): Generator<OpEvent> {
    const quiet = now() - lastSaid;
    if (reason === lastReason && quiet < progressMs) return;
    lastReason = reason;
    lastSaid = now();
    yield evt(phase, waiting, `${reason} (${elapsed(now() - started)} so far)`, at(now), level);
  };

  const retries = transientRetries({
    pollMs,
    random,
    ...(opts.signal ? { signal: opts.signal } : {}),
    say,
  });

  yield evt(
    phase,
    waiting,
    `attaching data volume ${volumeId} to ${instanceId}`,
    at(now),
    undefined,
    "start",
  );

  for (;;) {
    if (opts.signal?.aborted) {
      throw new HermeticError(
        "ABORTED",
        `stopped waiting to attach ${volumeId} to ${instanceId}; both still exist in AWS and the agent row names them`,
        { instanceId, volumeId },
      );
    }
    await opts.heartbeat?.();

    retries.pass();

    let instance: Awaited<ReturnType<typeof deps.compute.describeInstance>>;
    try {
      instance = await deps.compute.describeInstance(instanceId);
    } catch (e) {
      yield* retries.refused("DescribeInstances", e);
      continue;
    }
    if (instance) seen = true;
    if (!instance && !seen && now() - started < INSTANCE_VISIBILITY_GRACE_MS) {
      // Not "gone" — not yet arrived. See the module header.
      yield* say(
        `instance ${instanceId} is not visible to DescribeInstances yet (EC2 eventual consistency); waiting`,
      );
      await abortableSleep(pollMs, opts.signal);
      continue;
    }
    if (!instance || instance.state === "terminated" || instance.state === "shutting-down") {
      throw new HermeticError(
        "NOT_FOUND",
        `instance ${instanceId} is ${instance?.state ?? "gone"} and cannot take the data volume; recreate the agent to launch a new one`,
        { instanceId, volumeId, state: instance?.state ?? null },
      );
    }
    if (instance.state !== "running") {
      if (INSTANCE_WONT_RUN.has(instance.state)) {
        throw new HermeticError(
          "CONFLICT",
          `instance ${instanceId} is ${instance.state} and will not reach running on its own; start it or recreate the agent`,
          { instanceId, volumeId, state: instance.state },
        );
      }
      // `pending`, or a state EC2 has invented since: both are "not yet".
      yield* say(
        INSTANCE_COMING_UP.has(instance.state)
          ? `instance ${instanceId} is still booting`
          : `instance ${instanceId} is ${instance.state}`,
      );
      await abortableSleep(pollMs, opts.signal);
      continue;
    }

    let volume: VolumeStatus | null;
    try {
      volume = await deps.compute.describeVolume(volumeId);
    } catch (e) {
      yield* retries.refused("DescribeVolumes", e);
      continue;
    }
    if (!volume) {
      throw new HermeticError("NOT_FOUND", `volume ${volumeId} does not exist`, {
        volumeId,
        instanceId,
      });
    }
    if (attachedHere(volume, instanceId)) {
      yield evt(
        phase,
        finished,
        `data volume ${volumeId} attached to ${instanceId}`,
        at(now),
        undefined,
        "done",
      );
      return;
    }
    if (VOLUME_DEAD.has(volume.state)) {
      throw new HermeticError(
        "CONFLICT",
        `volume ${volumeId} is ${volume.state}; it cannot be attached to ${instanceId}`,
        { volumeId, instanceId, state: volume.state },
      );
    }

    const holder = heldElsewhere(volume, instanceId);
    if (holder) {
      /**
       * A volume still listed on the instance `recreate` terminated a moment
       * ago is the normal case, not a conflict: EC2 detaches on terminate, but
       * asynchronously. Only a holder that is actually alive means this disk
       * belongs to somebody else — and guessing which disk holds an agent's
       * memory is not allowed (§1).
       */
      let other: Awaited<ReturnType<typeof deps.compute.describeInstance>>;
      try {
        other = await deps.compute.describeInstance(holder);
      } catch (e) {
        yield* retries.refused("DescribeInstances", e);
        continue;
      }
      // Written as the condition rather than a `dying` flag so the narrowing
      // survives: `other` is assigned inside the try above.
      if (other !== null && other.state !== "terminated" && other.state !== "shutting-down") {
        throw new HermeticError(
          "CONFLICT",
          `volume ${volumeId} is attached to ${holder}, not ${instanceId}`,
          { volumeId, instanceId, attached_to: holder, holder_state: other.state },
        );
      }
      yield* say(`waiting for ${holder} to release volume ${volumeId}`);
      await abortableSleep(pollMs, opts.signal);
      continue;
    }
    if (stillSettling(volume)) {
      yield* say(`volume ${volumeId} is ${volume.state}`);
      await abortableSleep(pollMs, opts.signal);
      continue;
    }

    try {
      await deps.compute.attachVolume(instanceId, volumeId);
    } catch (e) {
      // EC2 disagreeing about readiness it reported a moment ago: back off and
      // go round again.
      yield* retries.refused("AttachVolume", e);
      continue;
    }
    yield evt(
      phase,
      finished,
      `data volume ${volumeId} attached to ${instanceId}`,
      at(now),
      undefined,
      "done",
    );
    return;
  }
}

/**
 * What `waitVolumeReleased` found when it stopped waiting. `gone` means the
 * volume no longer exists (or is already being deleted) and the caller has
 * nothing left to do; `free` means it exists, is attached to nothing, and can
 * be deleted or re-attached.
 */
export type VolumeRelease = "gone" | "free";

/**
 * Wait until `volumeId` belongs to nobody — the mirror image of
 * `attachAgentVolume`, and unbounded for the same reason.
 *
 * `TerminateInstances` returns as soon as EC2 has *accepted* the request. The
 * volume stays attached through `shutting-down` and detaches on its own some
 * seconds later, so a `DeleteVolume` sent immediately after a terminate is
 * refused with `VolumeInUse`. That is a "too early", not a "no" — but `destroy`
 * read it as a failure, died at the volume step with the instance already
 * terminated and the secrets already gone, and left the agent stranded in
 * `destroying`. Waiting for the detach is the whole fix; everything else about
 * that failure was a consequence.
 *
 * Fatal only when the disk is genuinely somebody else's: an attachment to an
 * instance that is still alive. A holder that is itself terminating is the
 * ordinary case — it is the instance we just terminated — and is waited on.
 * Guessing which disk holds an agent's memory is not allowed (§1), so an
 * ambiguous holder stops the run rather than losing a volume.
 */
export async function* waitVolumeReleased(
  deps: AttachDeps,
  volumeId: string,
  opts: AttachOptions = {},
): AsyncGenerator<OpEvent, VolumeRelease> {
  const now = deps.now ?? Date.now;
  const pollMs = deps.pollMs ?? ATTACH_POLL_MS;
  const progressMs = deps.progressMs ?? ATTACH_PROGRESS_MS;
  const random = deps.random ?? Math.random;
  const phase = opts.phase ?? "volume";
  const waiting = opts.progress?.waiting ?? 0.7;
  const finished = opts.progress?.done ?? 0.8;

  const started = now();
  let lastSaid = 0;
  let lastReason = "";
  /** Only worth announcing the detach if the caller was made to wait for it. */
  let waited = false;

  const say = function* (reason: string, level?: OpEvent["level"]): Generator<OpEvent> {
    waited = true;
    const quiet = now() - lastSaid;
    if (reason === lastReason && quiet < progressMs) return;
    lastReason = reason;
    lastSaid = now();
    yield evt(phase, waiting, `${reason} (${elapsed(now() - started)} so far)`, at(now), level);
  };

  /**
   * The detach wait is as throttleable as the attach: a `RequestLimitExceeded`
   * on either read used to escape it, and this is the wait `destroy` and the
   * `--rollback-on-failure` unwind both stand on — a throw here strands an
   * agent mid-destroy with its instance already terminated.
   */
  const retries = transientRetries({
    pollMs,
    random,
    ...(opts.signal ? { signal: opts.signal } : {}),
    say,
  });

  const settled = function* (outcome: VolumeRelease): Generator<OpEvent> {
    if (!waited) return;
    yield evt(
      phase,
      finished,
      outcome === "gone"
        ? `volume ${volumeId} is gone`
        : `volume ${volumeId} detached after ${elapsed(now() - started)}`,
      at(now),
      undefined,
      "done",
    );
  };

  for (;;) {
    if (opts.signal?.aborted) {
      throw new HermeticError(
        "ABORTED",
        `stopped waiting for volume ${volumeId} to detach; it still exists and the agent row names it`,
        { volumeId },
      );
    }
    await opts.heartbeat?.();
    retries.pass();

    let volume: VolumeStatus | null;
    try {
      volume = await deps.compute.describeVolume(volumeId);
    } catch (e) {
      yield* retries.refused("DescribeVolumes", e);
      continue;
    }
    if (!volume || VOLUME_GOING.has(volume.state)) {
      yield* settled("gone");
      return "gone";
    }

    /**
     * `detaching` still counts as held: the disk is not free until EC2 says the
     * attachment is `detached` or drops it from the list entirely.
     */
    const holders = volume.attachments.filter((a) => a.state !== "detached");
    if (holders.length === 0) {
      yield* settled("free");
      return "free";
    }

    /**
     * A refusal while asking about a holder restarts the pass rather than
     * skipping the holder: "we could not find out whether that box is alive" is
     * not "that box is dying", and only the second one is safe to walk past.
     */
    let unanswered = false;
    for (const holder of holders) {
      let other: Awaited<ReturnType<typeof deps.compute.describeInstance>>;
      try {
        other = await deps.compute.describeInstance(holder.instance_id);
      } catch (e) {
        yield* retries.refused("DescribeInstances", e);
        unanswered = true;
        break;
      }
      if (other === null || other.state === "terminated" || other.state === "shutting-down") {
        continue;
      }
      throw new HermeticError(
        "CONFLICT",
        `volume ${volumeId} is still attached to ${holder.instance_id}, which is ${other.state}; it will not detach on its own`,
        { volumeId, attached_to: holder.instance_id, holder_state: other.state },
      );
    }
    if (unanswered) continue;

    yield* say(
      holders.length === 1 && holders[0]
        ? `waiting for ${holders[0].instance_id} to release volume ${volumeId}`
        : `waiting for ${holders.length} instance(s) to release volume ${volumeId}`,
    );
    await abortableSleep(pollMs, opts.signal);
  }
}

/**
 * Wait until `instanceId` is `terminated`, or so gone EC2 no longer admits it
 * ever existed — the instance-side twin of `waitVolumeReleased`, unbounded for
 * the same reason.
 *
 * `destroy` needs it before it releases the name (§6.7): the box's hermeticd
 * keeps writing its facts onto the agent row while the instance is
 * `shutting-down`, and the release deletes that row. Waiting for `terminated`
 * is what guarantees nothing on the box is still running when the row goes.
 *
 * Any other state is waited on rather than refused. `TerminateInstances` has
 * already been accepted by the time this is called, and `DescribeInstances` is
 * eventually consistent, so a poll can still read `running` for a moment
 * after the terminate; the operator's abort is the way out of a wait that
 * never ends.
 */
export async function* waitInstanceTerminated(
  deps: Pick<AttachDeps, "pollMs" | "progressMs" | "now" | "random"> & {
    compute: Pick<ComputeApi, "describeInstance">;
  },
  instanceId: string,
  opts: AttachOptions = {},
): AsyncGenerator<OpEvent, void> {
  const now = deps.now ?? Date.now;
  const pollMs = deps.pollMs ?? ATTACH_POLL_MS;
  const progressMs = deps.progressMs ?? ATTACH_PROGRESS_MS;
  const random = deps.random ?? Math.random;
  const phase = opts.phase ?? "instance";
  const waiting = opts.progress?.waiting ?? 0.8;
  const finished = opts.progress?.done ?? 0.85;

  const started = now();
  let lastSaid = 0;
  let lastReason = "";
  let waited = false;

  const say = function* (reason: string, level?: OpEvent["level"]): Generator<OpEvent> {
    waited = true;
    const quiet = now() - lastSaid;
    if (reason === lastReason && quiet < progressMs) return;
    lastReason = reason;
    lastSaid = now();
    yield evt(phase, waiting, `${reason} (${elapsed(now() - started)} so far)`, at(now), level);
  };

  const retries = transientRetries({
    pollMs,
    random,
    ...(opts.signal ? { signal: opts.signal } : {}),
    say,
  });

  for (;;) {
    if (opts.signal?.aborted) {
      throw new HermeticError(
        "ABORTED",
        `stopped waiting for instance ${instanceId} to terminate; the agent row still names it`,
        { instanceId },
      );
    }
    await opts.heartbeat?.();
    retries.pass();

    let instance: Awaited<ReturnType<typeof deps.compute.describeInstance>>;
    try {
      instance = await deps.compute.describeInstance(instanceId);
    } catch (e) {
      yield* retries.refused("DescribeInstances", e);
      continue;
    }
    if (instance === null || instance.state === "terminated") {
      if (waited) {
        yield evt(
          phase,
          finished,
          `instance ${instanceId} terminated after ${elapsed(now() - started)}`,
          at(now),
          undefined,
          "done",
        );
      }
      return;
    }
    yield* say(`waiting for instance ${instanceId} to terminate (${instance.state})`);
    await abortableSleep(pollMs, opts.signal);
  }
}
