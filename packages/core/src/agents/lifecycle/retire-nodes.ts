/**
 * Waiting out an agent's old nodes (§6.5, §6.7): every instance just asked to
 * terminate is confirmed `terminated`, the tailnet is given a bounded time to
 * notice, and the agent's devices are then swept.
 *
 * It is one sequence with two callers, and the two need it for the same
 * reason. `destroy` (`destroy-agent.ts`) runs it before it releases the name,
 * so the next agent created under that name is admitted to the tailnet as
 * `<name>` rather than `<name>-2`. `recreate` (`recreate-agent.ts`) runs it
 * before it mints the replacement's auth key, for the replacement itself:
 * a node joining while its predecessor's device still reads online is pushed
 * onto `<name>-2` at once, and a sweep straight after the terminate request
 * would skip that device precisely because it still reads online. Two copies
 * of the sequence would drift — one would grow a wait the other lacked —
 * which is exactly how `recreate` came to sweep before the old node was down.
 *
 * Each step and its WHY:
 *
 * 1. Wait for every instance to be `terminated` (`waitInstanceTerminated`),
 *    however long, renewing the caller's lock on every poll (§4.4).
 *    `TerminateInstances` only *asks*: the box stays `shutting-down` for a
 *    while, its hermeticd keeps writing to the agent row, and its tailnet
 *    node keeps reading online. Nothing about the node can be decided while
 *    the machine may still be running.
 * 2. Wait, bounded by `tailnetOfflineMs` (`TAILNET_OFFLINE_WAIT_MS`), for the
 *    matched devices to read offline (`waitTailnetOffline`). Tailscale lags in
 *    noticing a stopped machine — a minute or more is usual — and the sweep
 *    never deletes an online device.
 * 3. Sweep (`removeTailnetDevices`, default mode): what went offline is
 *    deleted; what is still online at the deadline is named in one `warn`
 *    and left alone. A terminated instance does not prove a device is its
 *    node — hostname plus `tag:hermetic` is also what an orphaned live box
 *    whose instance lost its agent tags joins as, and the row's
 *    `tailscale_dns_name` is written by the box itself — so deleting an
 *    online match would be a guess about a live machine (§1). The caller
 *    carries on either way: a node hermetic cannot stop must not hold the
 *    name, or the replacement, hostage.
 *
 * Steps 2 and 3 are skipped when the caller says the tailnet cannot be swept
 * (`tailnet: false`): `destroy`'s first pass has then already said why in its
 * one `warn`, and asking again would only say it twice.
 *
 * The tailnet steps never fail the caller: an unreachable API or a device
 * still online is a `warn`. What does end it is an abort (§3.2 rule 2), checked
 * before each instance's wait, before the tailnet steps and inside both waits;
 * a lock renewal the `heartbeat` refuses (`CONFLICT`, `LOCKED`); and an EC2
 * describe that is refused rather than throttled while waiting for
 * `terminated`.
 *
 * `RetireNodesDeps` is the honest list: the backend and the clock (for the
 * sweep), and the attach cadence and deadline (for the waits). Same shape as
 * `TailnetDeps` (`tailnet-devices.ts`).
 */
import type { OpEvent } from "../../schema/index.ts";
import type { OpOptions } from "../../hermetic.ts";
import { checkAbort } from "../../abort.ts";
import { waitInstanceTerminated } from "../attach.ts";
import { createTailnetCleanup } from "../../fleet/tailnet-devices.ts";
import type { CoreContext } from "../../context.ts";

export type RetireNodesDeps = Pick<CoreContext, "attachDeps" | "backend" | "nowIso">;

export interface RetireNodesInput {
  /** The agent whose nodes these are. */
  name: string;
  fleetId: string | undefined;
  /**
   * The FQDN the agent's node last reported (`tailscale_dns_name`), read when
   * the tailnet steps start — so a caller whose row is renewed during the
   * instance wait hands over the row as it is then, exactly as it did when
   * the sequence lived inline. `recreate` reads it before its terminate and
   * returns that.
   */
  dnsName: () => string | null;
  /**
   * Every instance already asked to terminate (or found already going):
   * each is waited on until `terminated`. One already gone returns at once.
   */
  instanceIds: readonly string[];
  /** The caller's TTL lock, renewed on every poll of both waits (§4.4). */
  heartbeat: () => Promise<void>;
  /** `false`: wait for the instances only; the tailnet cannot be swept. */
  tailnet: boolean;
  /** Where these events sit on the caller's progress bar. */
  progress: {
    terminated: { waiting: number; done: number };
    offline: number;
    sweep: number;
  };
}

export function createRetireNodes(deps: RetireNodesDeps) {
  const { attachDeps } = deps;
  const { removeTailnetDevices, waitTailnetOffline } = createTailnetCleanup(deps);

  async function* retireNodes(
    input: RetireNodesInput,
    opts: OpOptions = {},
  ): AsyncGenerator<OpEvent, void, undefined> {
    const { name, fleetId, heartbeat, progress } = input;
    /**
     * Each instance gets its own slice of the `terminated` range, so waiting on
     * a second box (recreate's old instance plus a lingering stray) moves the
     * bar on rather than back. One instance gets the whole range, as before.
     */
    const { waiting, done } = progress.terminated;
    const count = input.instanceIds.length;
    for (const [i, id] of input.instanceIds.entries()) {
      checkAbort(opts.signal, "instance");
      yield* waitInstanceTerminated(attachDeps(), id, {
        ...(opts.signal ? { signal: opts.signal } : {}),
        heartbeat,
        phase: "instance",
        progress: {
          waiting: waiting + ((done - waiting) * i) / count,
          done: waiting + ((done - waiting) * (i + 1)) / count,
        },
      });
    }

    checkAbort(opts.signal, "tailnet");
    await heartbeat();
    if (!input.tailnet) return;
    const dnsName = input.dnsName();
    yield* waitTailnetOffline(name, fleetId, dnsName, "tailnet", progress.offline, opts, {
      ...attachDeps(),
      heartbeat,
    });
    yield* removeTailnetDevices(name, fleetId, dnsName, "tailnet", progress.sweep, opts);
  }

  return { retireNodes };
}
