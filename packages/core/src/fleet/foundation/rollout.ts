/**
 * §6.6 step 6: ask every box that is up to take the new release, and watch it
 * land.
 */
import { randomUUID } from "node:crypto";
import type { OpEvent } from "../../schema/index.ts";
import { isHermeticError } from "../../errors.ts";
import { abortableSleep, checkAbort } from "../../abort.ts";
import { evt } from "../../events.ts";
import { PHASE, ROLLOUT_POLL_MS, ROLLOUT_STATUSES, type FoundationCtx } from "./shared.ts";

export function createRollout(ctx: FoundationCtx) {
  const { deps, core, backend, hermeticdVersion, nowIso } = ctx;

  /**
   * §6.6 step 6. The request is a *hint* written on the row, not an RPC: the
   * resident runner reads its own row on every heartbeat and acts (§4.2), so
   * there is nothing here to hang on and nothing left half-done if the laptop
   * dies. An agent that is stopped or mid-boot takes the new release at its next
   * start-up, which is why it is deferred rather than failed.
   */
  async function* rollout(
    /** The digest `pushAndPrune` just published; the only evidence of landing. */
    targetSha256: string | null,
    keepLock: () => Promise<void>,
    overrideWaitMs: number | undefined,
    signal?: AbortSignal,
  ): AsyncGenerator<OpEvent, void> {
    const agents = (await backend.store.agents.scan()).filter((a) => a.status !== "destroyed");
    const targets = agents.filter((a) => ROLLOUT_STATUSES.includes(a.status) && a.instance_id);
    const deferred = agents.filter((a) => !targets.includes(a));
    const request = {
      id: randomUUID(),
      hermeticd_version: hermeticdVersion,
      issued_at: nowIso(),
      issued_by: await core.actor(),
    };
    yield evt(
      "rollout",
      PHASE.rollout[0],
      `asking ${targets.length} agent(s) to take hermeticd ${hermeticdVersion} now`,
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
      checkAbort(signal, "rollout");
      try {
        await backend.store.agents.update(agent.name, agent.version, { update_request: request });
        baseline.set(agent.name, agent.last_heartbeat ? Date.parse(agent.last_heartbeat) : 0);
        asked.push(agent.name);
      } catch (e) {
        // A row that moved underneath us is a row somebody else is operating;
        // it will take the release on its nightly check either way.
        refused.push(`${agent.name} (${isHermeticError(e) ? e.code : "INTERNAL"})`);
        yield evt(
          "rollout",
          PHASE.rollout[0],
          `could not write the update request on ${agent.name} (${isHermeticError(e) ? e.code : "INTERNAL"}); it takes the release on its nightly check`,
          nowIso(),
          "warn",
        );
      }
    }
    if (deferred.length > 0) {
      yield evt(
        "rollout",
        PHASE.rollout[0] + 0.01,
        `deferred: ${deferred.map((a) => `${a.name} (${a.status})`).join(", ")} — they take the release when they next start`,
        nowIso(),
      );
    }
    /**
     * Every single target refused the write. One busy row is routine; all of
     * them is a symptom — a table being throttled, permissions that no longer
     * allow the update, another tool rewriting rows — and it means *nothing*
     * was rolled out. Still not fatal, because the stack and the release are
     * already updated and the nightly check will finish the job, but it is not
     * a warning either: it is the phase failing to do its work.
     */
    if (targets.length > 0 && asked.length === 0) {
      yield evt(
        "rollout",
        PHASE.rollout[0] + 0.02,
        `not one of ${targets.length} agent(s) accepted the update request (${refused.join(", ")}); nothing was rolled out — every box takes the release on its nightly check instead`,
        nowIso(),
        "error",
      );
    }

    const waitMs = overrideWaitMs ?? deps.rolloutWaitMs ?? 0;
    if (asked.length === 0 || waitMs === 0) {
      yield evt(
        "rollout",
        PHASE.rollout[1],
        asked.length === 0
          ? "no agent was up to take the release now"
          : `${asked.length} agent(s) asked; not waiting for them to land`,
        nowIso(),
        undefined,
        "done",
      );
      return;
    }

    const span = PHASE.rollout[1] - PHASE.rollout[0];
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
      checkAbort(signal, "rollout");
      await abortableSleep(deps.rolloutPollMs ?? ROLLOUT_POLL_MS, signal);
      checkAbort(signal, "rollout");
      await keepLock();
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
          "rollout",
          PHASE.rollout[0] + span * ((asked.length - pending.size) / asked.length),
          `${agent.name} is running hermeticd ${hermeticdVersion} (${targetSha256.slice(0, 12)}…)`,
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
     */
    /**
     * Now the wait is over, the boxes that did not land split in two, and the
     * difference is what an operator does next.
     *
     * **Unverifiable**: it heartbeated throughout and never once named a
     * digest. Nothing can be concluded about it from here — it may well have
     * taken the release — and the fix is a newer hermeticd on that box.
     *
     * **Straggler**: everything else. It named a different digest (so it
     * demonstrably has not taken this release), or it never spoke at all. Both
     * resolve themselves on the nightly check, which is what the line says.
     */
    const unverifiable = new Set([...pending].filter((n) => spoke.has(n) && !namedADigest.has(n)));
    for (const name of unverifiable) pending.delete(name);
    const landed = asked.filter((n) => !pending.has(n) && !unverifiable.has(n));
    const lines: string[] = [];
    if (landed.length > 0) {
      lines.push(
        `${landed.length} of ${asked.length} agent(s) are running hermeticd ${hermeticdVersion}`,
      );
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
        `${[...pending].sort().join(", ")} have not reported hermeticd ${hermeticdVersion} yet; they will take it on the nightly check`,
      );
    }
    const clean = pending.size === 0 && unverifiable.size === 0;
    yield evt(
      "rollout",
      PHASE.rollout[1],
      clean ? `every agent that was up is running hermeticd ${hermeticdVersion}` : lines.join("; "),
      nowIso(),
      clean ? undefined : "warn",
      "done",
    );
  }

  return { rollout };
}
