/**
 * The re-run of `create` asking EC2 directly about an instance id the row
 * already names, with the patience `attach.ts` documents. Split out of
 * `lifecycle.ts` for size; the design comments travelled with the code.
 */
import type { OpEvent } from "../../schema/index.ts";
import type { InstanceRef } from "../../backend/types.ts";
import {
  ATTACH_POLL_MS,
  ATTACH_PROGRESS_MS,
  INSTANCE_VISIBILITY_GRACE_MS,
  transientRetries,
} from "../attach.ts";
import { abortableSleep, checkAbort } from "../../abort.ts";
import type { OpOptions } from "../../hermetic.ts";
import type { CoreContext } from "../../context.ts";

export function createRecordedInstance(deps: Pick<CoreContext, "backend" | "attachDeps" | "nowIso">) {
  const { backend, attachDeps, nowIso } = deps;

  /**
   * How many times a re-run of `create` re-reads an instance id the row already
   * names before it believes EC2's silence.
   *
   * `INSTANCE_VISIBILITY_GRACE_MS` at the ordinary poll cadence — the same
   * patience `attach.ts` documents, expressed as a count so a fixed clock (every
   * test, and fixture mode) cannot turn the wait into a loop that never ends.
   */
  const VISIBILITY_POLLS = Math.ceil(INSTANCE_VISIBILITY_GRACE_MS / ATTACH_POLL_MS);

  /**
   * The instance the row already names, when `listInstancesByTag` did not return
   * it — and the patience that has to go with asking.
   *
   * `RunInstances` returns an id before `DescribeInstances` will admit the
   * instance exists, and the *tag index* lags further still: a re-run of a create
   * that died seconds after launching used to see an empty tag query, conclude
   * there was nothing there, and launch a second box — which then bills forever,
   * because the row was immediately overwritten with the new id and nothing else
   * ever names the first one. So the recorded id is asked about directly, and a
   * `null` is read the way `attach.ts` reads it: not "gone", "not yet arrived",
   * for as long as `INSTANCE_VISIBILITY_GRACE_MS` allows.
   *
   * Returns `null` only when EC2 has had its full grace and still does not know
   * the id, or when it answers that the instance is on its way out — both of
   * which mean this create must launch a replacement.
   */
  async function* recordedInstance(
    name: string,
    instanceId: string,
    say: (
      phase: string,
      progress: number,
      message: string,
      at: string,
      level?: OpEvent["level"],
    ) => OpEvent,
    opts: OpOptions,
  ): AsyncGenerator<OpEvent, InstanceRef | null> {
    const wait = attachDeps();
    const now = wait.now ?? Date.now;
    const pollMs = wait.pollMs ?? ATTACH_POLL_MS;
    const progressMs = wait.progressMs ?? ATTACH_PROGRESS_MS;
    /**
     * Said on the *first* poll and then at the cadence every other long wait
     * repeats itself. The first one is the one that matters: it is the sentence
     * that explains a create which has apparently stopped, and holding it back
     * for fifteen seconds is holding it back for exactly the period an operator
     * is most likely to be watching.
     */
    let lastSaid: number | null = null;
    const speak = function* (reason: string, level?: OpEvent["level"]): Generator<OpEvent> {
      if (lastSaid !== null && now() - lastSaid < progressMs) return;
      lastSaid = now();
      yield say("instance", 0.77, reason, nowIso(), level);
    };
    /**
     * The same policy the attach and the detach use (`attach.ts`): a throttled
     * `DescribeInstances` here would otherwise end this wait by throwing, and
     * this wait exists precisely so that not knowing is never read as "gone".
     */
    const retries = transientRetries({
      pollMs,
      ...(wait.random ? { random: wait.random } : {}),
      ...(opts.signal ? { signal: opts.signal } : {}),
      say: speak,
    });
    for (let poll = 0; ; poll += 1) {
      checkAbort(opts.signal, "instance");
      retries.pass();
      let live: InstanceRef | null;
      try {
        live = await backend.compute.describeInstance(instanceId);
      } catch (e) {
        yield* retries.refused("DescribeInstances", e);
        // A refusal is not an answer, and must not spend one of the polls this
        // wait is allowed to conclude "gone" after.
        poll -= 1;
        continue;
      }
      if (live) {
        return live.state === "terminated" || live.state === "shutting-down" ? null : live;
      }
      if (poll >= VISIBILITY_POLLS) return null;
      yield* speak(
        `the ${name} row names instance ${instanceId}, which EC2 does not admit exists yet; waiting rather than launching a second one`,
        "warn",
      );
      await abortableSleep(pollMs, opts.signal);
    }
  }

  return { recordedInstance };
}
