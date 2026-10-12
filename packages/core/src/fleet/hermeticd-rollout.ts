/**
 * Ask every box that is up to take a hermeticd release now, and watch it land
 * (§6.5, §6.6 step 6).
 *
 * Three commands publish a release a running fleet should take at once:
 * `foundation.update` (which pushes this build's release as one of its
 * phases), `artifacts.push` and `upgrade --hermeticd`. They share this one
 * implementation because the hard parts are the same for all three — which
 * rows to ask, how to ask without clobbering a row mid-operation, and what
 * "landed" can honestly be said to mean — and three copies of those would be
 * three answers to them.
 *
 * The request is a *hint* written on the row, not an RPC: the resident runner
 * reads its own row on every heartbeat and acts (§4.2), so there is nothing
 * here to hang on and nothing left half-done if the laptop dies. An agent that
 * is stopped or mid-boot takes the new release at its next start-up, which is
 * why it is deferred rather than failed. Nothing here ever throws for a box
 * that did not land: the release is published either way, and every outcome
 * is an event.
 */
import { randomUUID } from "node:crypto";
import type { AgentStatus, FleetManifest, OpEvent } from "../schema/index.ts";
import { isHermeticError } from "../errors.ts";
import { abortableSleep, checkAbort } from "../abort.ts";
import { evt } from "../events.ts";
import type { CoreContext } from "../context.ts";
import { isLockLive } from "../agents/state.ts";

/** The agents a rollout targets: up, reachable, and running a hermeticd that can take it. */
export const ROLLOUT_STATUSES: readonly AgentStatus[] = ["ready", "degraded"];

/** How often the rollout scans for boxes that have taken the new release. */
export const ROLLOUT_POLL_MS = 10_000;

/**
 * What the rollout needs beyond the shared context (rule 5): how long to watch
 * the fleet land, and how often to look.
 *
 * `waitMs` is the *resolved* wait — a caller's `rollout_wait_ms`, else the
 * deployment's (`FoundationDeps.rolloutWaitMs`: ten minutes in real mode,
 * zero in fixtures and tests). Zero writes the requests and does not wait.
 */
export interface HermeticdRolloutDeps {
  ctx: Pick<CoreContext, "backend" | "actor" | "nowIso">;
  waitMs: number;
  /** `ROLLOUT_POLL_MS` unless a test shortens it. */
  pollMs?: number | undefined;
}

export interface HermeticdRolloutInput {
  /**
   * The binary digest the fleet manifest now names — the only evidence of
   * landing. `null` when the release recorded none, which makes the wait
   * pointless: there is nothing a box could report that would match.
   */
  targetSha256: string | null;
  /** The release's version, for the request and every line said about it. */
  version: string;
  /** The `OpEvent` phase every event is yielded under (`rollout` for all three callers today). */
  phase: string;
  /** The slice of the caller's progress bar this phase spans. */
  progress: readonly [number, number];
  /**
   * The fleet's `settings.auto_update_hermeticd` (`autoUpdateHermeticd`), only
   * to say truthfully when a box that did not take it now will: at its next
   * check a few minutes away, or at its nightly slot.
   */
  autoUpdate: boolean;
  /**
   * Renew the caller's own lock between polls. `foundation.update` holds the
   * fleet lock across the whole wait and renews it here; `artifacts.push` and
   * `upgrade --hermeticd` have already given theirs back and pass nothing.
   */
  keepLock?: (() => Promise<void>) | undefined;
  signal?: AbortSignal | undefined;
}

/** When a box that was not asked, or did not answer, takes the release anyway. */
function laterCheck(autoUpdate: boolean): string {
  // Only a hermeticd new enough to read the manifest's switch checks every
  // few minutes; an older one still waits for its nightly slot, so the line
  // promises no more than the oldest box on the fleet can keep.
  return autoUpdate
    ? "its next update check (within minutes on a hermeticd that checks the manifest, else its nightly slot)"
    : "its nightly update check";
}

export async function* rolloutHermeticd(
  deps: HermeticdRolloutDeps,
  input: HermeticdRolloutInput,
): AsyncGenerator<OpEvent, void> {
  const { backend, nowIso } = deps.ctx;
  const { targetSha256, version, phase, signal } = input;
  const [from, to] = input.progress;
  const later = laterCheck(input.autoUpdate);
  const agents = (await backend.store.agents.scan()).filter((a) => a.status !== "destroyed");
  const up = agents.filter((a) => ROLLOUT_STATUSES.includes(a.status) && a.instance_id);
  /**
   * A row somebody holds a live lock on is an operation in flight (§4.4), and
   * its status alone does not say so — a `set` or a `rerun` holds the lock on a
   * row that still reads `ready`. Writing the request on it would bump the
   * row's version under the holder, whose next `renewLock`/`releaseLock` then
   * fails `CONFLICT`: the rollout would break the very operation it is not
   * part of. Such a row is deferred and takes the release at its own next
   * check. `foundation.update` never meets one (its preflight refuses a fleet
   * with a live agent lock); `artifacts.push` and `upgrade --hermeticd` take
   * no agent lock, so here is where they step around one.
   */
  const nowMs = backend.clock.now().getTime();
  const locked = up.filter((a) => isLockLive(a.lock, undefined, nowMs));
  const targets = up.filter((a) => !locked.includes(a));
  const deferred = agents.filter((a) => !up.includes(a));
  const request = {
    id: randomUUID(),
    hermeticd_version: version,
    issued_at: nowIso(),
    issued_by: await deps.ctx.actor(),
  };
  yield evt(
    phase,
    from,
    `asking ${targets.length} agent(s) to take hermeticd ${version} now`,
    nowIso(),
    undefined,
    "start",
  );

  /**
   * Each target's heartbeat *as it stands right now*, which is the baseline
   * "has this box said anything since we asked" is measured against.
   *
   * Not `issued_at`. That is this laptop's clock and `last_heartbeat` is the
   * box's, and comparing the two makes the rollout's completion a question
   * about clock skew: a box a few seconds behind never appears to land, and
   * one a few seconds ahead appears to land on a heartbeat it sent before it
   * was asked. Comparing a box's clock only against *itself* has neither
   * failure.
   */
  const baseline = new Map<string, number>();
  const asked: string[] = [];
  const refused: string[] = [];
  for (const agent of targets) {
    checkAbort(signal, phase);
    try {
      // Conditional on the version this scan read: a row that moved since is
      // a row somebody else is operating, and it is refused rather than
      // clobbered.
      await backend.store.agents.update(agent.name, agent.version, { update_request: request });
      baseline.set(agent.name, agent.last_heartbeat ? Date.parse(agent.last_heartbeat) : 0);
      asked.push(agent.name);
    } catch (e) {
      // A row that moved underneath us is a row somebody else is operating;
      // it will take the release on its own check either way.
      refused.push(`${agent.name} (${isHermeticError(e) ? e.code : "INTERNAL"})`);
      yield evt(
        phase,
        from,
        `could not write the update request on ${agent.name} (${isHermeticError(e) ? e.code : "INTERNAL"}); it takes the release at ${later}`,
        nowIso(),
        "warn",
      );
    }
  }
  if (locked.length > 0) {
    yield evt(
      phase,
      from + 0.01,
      `deferred: ${locked.map((a) => `${a.name} (locked by ${a.lock?.owner ?? "another operator"})`).join(", ")} — an operation is in flight on each; it takes the release at ${later}`,
      nowIso(),
    );
  }
  if (deferred.length > 0) {
    yield evt(
      phase,
      from + 0.01,
      `deferred: ${deferred.map((a) => `${a.name} (${a.status})`).join(", ")} — they take the release when they next start`,
      nowIso(),
    );
  }
  /**
   * Every single target refused the write. One busy row is routine; all of
   * them is a symptom — a table being throttled, permissions that no longer
   * allow the update, another tool rewriting rows — and it means *nothing*
   * was rolled out. Still not fatal, because the release is already published
   * and each box's own check will finish the job, but it is not a warning
   * either: it is the phase failing to do its work.
   */
  if (targets.length > 0 && asked.length === 0) {
    yield evt(
      phase,
      from + 0.02,
      `not one of ${targets.length} agent(s) accepted the update request (${refused.join(", ")}); nothing was rolled out — every box takes the release at ${later} instead`,
      nowIso(),
      "error",
    );
  }

  const waitMs = deps.waitMs;
  if (asked.length === 0 || waitMs === 0) {
    yield evt(
      phase,
      to,
      asked.length === 0
        ? "no agent was up to take the release now"
        : `${asked.length} agent(s) asked; not waiting for them to land`,
      nowIso(),
      undefined,
      "done",
    );
    return;
  }

  const span = to - from;
  const pending = new Set(asked);
  /**
   * Boxes that have said *something* since they were asked, whatever it was.
   *
   * Recorded during the wait and read only after it, because "has spoken but
   * reported no digest" is a verdict that can only be reached at the
   * deadline. A box mid-update heartbeats on its **old** binary — the one
   * with no `running_hermeticd_sha256` to report — a good minute before it
   * finishes downloading, swaps and restarts into the new one. Classifying it
   * the moment it first spoke, and dropping it from `pending`, would retire it
   * from the very poll that was about to watch it land: the wait would end
   * early and call a successful rollout unconfirmable.
   */
  const spoke = new Set<string>();
  /**
   * And of those, the ones that named a digest at all — whichever one.
   *
   * This is the line between "cannot tell" and "has not caught up", and they
   * are different problems with different fixes. A box reporting *some other*
   * digest is perfectly legible: we know what it is running and it is not
   * this release, so it is a straggler and waiting is the answer. Only a box
   * that reports no digest at all leaves the question unanswerable, and the
   * fix for that one is to get a newer hermeticd onto it.
   */
  const namedADigest = new Set<string>();
  /**
   * Wall clock, not `backend.clock`: this is how long the operator waits, not
   * a timestamp the fleet records. The two are the same thing in production
   * and deliberately are not in tests, where a frozen fleet clock would make
   * the deadline unreachable and this loop unending.
   */
  // And nothing to wait *for* when there is no digest to match: the loop
  // below could only run out the clock. Ten minutes of a progress bar that
  // cannot finish is worse than saying so at once.
  const deadline = Date.now() + (targetSha256 === null ? 0 : waitMs);
  while (pending.size > 0 && Date.now() < deadline) {
    // An abort is a failure, not an early success: falling out of this loop
    // on `signal.aborted` used to reach the `done` event below and report a
    // rollout that never happened as one that did.
    checkAbort(signal, phase);
    await abortableSleep(deps.pollMs ?? ROLLOUT_POLL_MS, signal);
    checkAbort(signal, phase);
    await input.keepLock?.();
    for (const agent of await backend.store.agents.scan()) {
      if (!pending.has(agent.name)) continue;
      const since = baseline.get(agent.name) ?? 0;
      /**
       * The box has spoken since we asked. Necessary, never sufficient — a
       * heartbeat is a 30-second timer and fires whether or not an update ran.
       * Strictly newer than the box's own previous heartbeat is what "it has
       * said something since we asked" means; see `baseline` above for why the
       * comparison is against itself and not against our clock.
       */
      const heard = agent.last_heartbeat ? Date.parse(agent.last_heartbeat) : null;
      if (heard === null || heard <= since) continue;

      /**
       * And the box is running the bytes we pushed.
       *
       * This used to read `agent.hermeticd_version !== hermeticdVersion`, and
       * both sides of that were `BUILD_VERSIONS.hermeticd` — the label a box
       * reports is the label compiled into it, and a release that changed the
       * binary without an operator hand-editing that constant carries the same
       * one. The guard could therefore never fire, and every box was declared
       * landed on its first heartbeat: the phase reported "every agent is on
       * hermeticd X" when what it had established was "every agent is alive".
       *
       * The digest cannot be a tautology. It is the same comparison the box's
       * own updater makes against the manifest (`update.ts`), which is why
       * agreement here means the two halves independently reached it.
       */
      spoke.add(agent.name);
      const running = agent.running_hermeticd_sha256 ?? null;
      if (running !== null) namedADigest.add(agent.name);
      // Nothing to compare *yet*. Stay pending and keep watching: a box on the
      // old binary has nothing to report until it restarts into the new one,
      // which is precisely the event this loop exists to see.
      if (targetSha256 === null || running === null) continue;
      if (running !== targetSha256) continue;

      pending.delete(agent.name);
      yield evt(
        phase,
        from + span * ((asked.length - pending.size) / asked.length),
        `${agent.name} is running hermeticd ${version} (${targetSha256.slice(0, 12)}…)`,
        nowIso(),
      );
    }
  }

  /**
   * Three outcomes, said apart rather than collapsed into a green line.
   *
   * `landed` is the only one that is good news, and it is the only one
   * phrased as a fact. The other two are each a different kind of "we do not
   * know", and an operator who is told which one they have can act on it —
   * the fix for an unverifiable box is to get a newer hermeticd onto it, and
   * the fix for a pending one is usually to wait.
   *
   * Now the wait is over, the boxes that did not land split in two, and the
   * difference is what an operator does next.
   *
   * **Unverifiable**: it heartbeated throughout and never once named a
   * digest. Nothing can be concluded about it from here — it may well have
   * taken the release — and the fix is a newer hermeticd on that box.
   *
   * **Straggler**: everything else. It named a different digest (so it
   * demonstrably has not taken this release), or it never spoke at all. Both
   * resolve themselves at the box's own next check, which is what the line
   * says.
   */
  const unverifiable = new Set([...pending].filter((n) => spoke.has(n) && !namedADigest.has(n)));
  for (const name of unverifiable) pending.delete(name);
  const landed = asked.filter((n) => !pending.has(n) && !unverifiable.has(n));
  const lines: string[] = [];
  if (landed.length > 0) {
    lines.push(`${landed.length} of ${asked.length} agent(s) are running hermeticd ${version}`);
  }
  if (unverifiable.size > 0) {
    lines.push(
      `${[...unverifiable].sort().join(", ")} heartbeated but ${
        targetSha256 === null
          ? "this push recorded no binary digest to compare against"
          : "do not report which binary they are running (hermeticd too old); whether they took the release cannot be confirmed from here"
      }`,
    );
  }
  if (pending.size > 0) {
    lines.push(
      `${[...pending].sort().join(", ")} have not reported hermeticd ${version} yet; each will take it at ${later}`,
    );
  }
  const clean = pending.size === 0 && unverifiable.size === 0;
  yield evt(
    phase,
    to,
    clean ? `every agent that was up is running hermeticd ${version}` : lines.join("; "),
    nowIso(),
    clean ? undefined : "warn",
    "done",
  );
}

// ─── after a publish: whether to roll out at all ────────────────────────────

/**
 * Which release a fleet manifest names, as far as a rollout cares: the version
 * label, the generation (a digest of every file, so one generation is one set
 * of bytes), and the binary's digest — the one thing a box reports back.
 */
export interface ReleaseIdentity {
  version: string;
  generation?: string | undefined;
  sha256: string | null;
}

/** A manifest's `hermeticd` block as a `ReleaseIdentity`. */
export function releaseIdentityOf(block: FleetManifest["hermeticd"]): ReleaseIdentity {
  return {
    version: block.version,
    ...(block.generation === undefined ? {} : { generation: block.generation }),
    sha256: block.files["hermeticd"]?.sha256 ?? null,
  };
}

/**
 * The release before and after a command moved the pointer. `before` is
 * `null` when there was no readable manifest to compare with, which counts as
 * a change: whatever the boxes run, it is not something a manifest named.
 */
export interface ReleaseMove {
  before: ReleaseIdentity | null;
  after: ReleaseIdentity;
}

/**
 * What a publish changed, as far as a running box is concerned.
 *
 * `binary` is the one a box can be *watched* taking: its digest is what the box
 * reports. `release` is anything at all — the binary, a stage, the version
 * label — and is what decides whether there is anything to roll out. A block
 * with no generation (written before they existed) is compared on the version
 * and the binary alone.
 */
export function releaseChange(move: ReleaseMove): { release: boolean; binary: boolean } {
  const { before, after } = move;
  if (before === null) return { release: true, binary: true };
  const binary = before.sha256 !== after.sha256;
  const release =
    binary ||
    before.version !== after.version ||
    (before.generation || null) !== (after.generation || null);
  return { release, binary };
}

export interface FollowReleaseInput {
  move: ReleaseMove;
  /** `HermeticdRolloutOptions` as the request stated them. */
  options: {
    now?: boolean | undefined;
    rollout?: boolean | undefined;
    rollout_wait_ms?: number | undefined;
  };
  /** The fleet's `auto_update_hermeticd`, read from the `_fleet` the publish held. */
  autoUpdate: boolean;
  phase: string;
  progress: readonly [number, number];
  /** The command that asks every box now, for the line that says nobody was asked. */
  nowCommand: string;
  signal?: AbortSignal | undefined;
}

/**
 * After `artifacts.push` or `upgrade --hermeticd` has published a release and
 * given its lock back: decide whether to ask the running boxes to take it now,
 * say why in either case, and do it (§6.5).
 *
 * - `--no-rollout` (`rollout: false`) asks nobody, whatever else is true.
 * - `--now` asks every box, even for a release that did not change and on a
 *   fleet that has switched auto-update off.
 * - Otherwise an unchanged release has nothing to roll out, a fleet with
 *   auto-update off waits for its nightly slot, and a fleet with it on is asked.
 *
 * A release whose binary did not change — only its stages — is still asked
 * for, but not waited on: a box reports only its binary's digest, so there is
 * nothing it could say that would show it landed. A release that did not
 * change at all, asked for with `--now`, is watched on the binary it already
 * names: a box that is not yet on it can still be seen arriving.
 *
 * `deps.waitMs` is the deployment's default wait; `options.rollout_wait_ms`
 * overrides it. Nothing here fails the command: the release is already
 * published, so a rollout that cannot be asked for is an event, and only an
 * abort — the operator's own stop — ends the op as a failure.
 */
export async function* followRelease(
  deps: HermeticdRolloutDeps,
  input: FollowReleaseInput,
): AsyncGenerator<OpEvent, void> {
  const { nowIso } = deps.ctx;
  const { move, options, autoUpdate, phase, progress, signal } = input;
  const version = move.after.version;
  const change = releaseChange(move);
  const say = (message: string, level?: OpEvent["level"]) =>
    evt(phase, progress[1], message, nowIso(), level, "done");

  if (options.rollout === false) {
    yield say(
      `not asking any box to take hermeticd ${version} now (--no-rollout); each takes it at ${laterCheck(autoUpdate)}`,
    );
    return;
  }
  if (options.now !== true) {
    if (!change.release) {
      yield say(`the release is unchanged; nothing to roll out`);
      return;
    }
    if (!autoUpdate) {
      yield say(
        `this fleet does not auto-update hermeticd, so every box takes ${version} at its nightly update check; \`${input.nowCommand}\` asks them now`,
      );
      return;
    }
  }
  const stagesOnly = change.release && !change.binary;
  if (stagesOnly) {
    yield evt(
      phase,
      progress[0],
      "the hermeticd binary is unchanged (only the bootstrap stages moved), so the boxes are asked but there is no new digest to watch them land on",
      nowIso(),
    );
  } else if (!change.release) {
    yield evt(
      phase,
      progress[0],
      `the release is unchanged; asking every box to take hermeticd ${version} now`,
      nowIso(),
    );
  }
  const waitMs = stagesOnly ? 0 : (options.rollout_wait_ms ?? deps.waitMs);
  try {
    yield* rolloutHermeticd(
      { ...deps, waitMs },
      {
        targetSha256: move.after.sha256,
        version,
        phase,
        progress,
        autoUpdate,
        signal,
      },
    );
  } catch (e) {
    if (signal?.aborted === true || (isHermeticError(e) && e.code === "ABORTED")) throw e;
    // The release is published and the manifest names it; only the nudge
    // failed. Every box still takes it on its own check.
    yield say(
      `hermeticd ${version} is published, but asking the boxes to take it now failed (${isHermeticError(e) ? `${e.code}: ${e.message}` : String(e)}); each takes it at ${laterCheck(autoUpdate)} — \`${input.nowCommand}\` asks again`,
      "error",
    );
  }
}
