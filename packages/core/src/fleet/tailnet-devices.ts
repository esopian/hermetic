/**
 * The tailnet side of a teardown: deleting the devices a destroyed or recreated
 * agent left behind (§6.5, §6.7).
 *
 * It is its own module because it has two callers that are not each other —
 * `destroy` (`destroy-agent.ts`) and `recreate` (`lifecycle/recreate-agent.ts`),
 * both through the wait-then-sweep sequence in `lifecycle/retire-nodes.ts`, and
 * `destroy` once more directly for its first pass — and because it needs four
 * things from the SDK closure where those two need thirty. Naming
 * that small list here is what keeps the sweep reviewable on its own: nothing
 * in this file can reach the agent row, the lock or the store.
 *
 * `TailnetDeps` is the honest list. Same shape as `LifecycleDeps`
 * (`lifecycle.ts`), `DestroyDeps` (`destroy-agent.ts`) and `PowerDeps`
 * (`power.ts`).
 */
import { cloudName } from "../schema/index.ts";
import type { OpEvent } from "../schema/index.ts";
import type { TailscaleDeleteOutcome, TailscaleDevice } from "../backend/types.ts";
import { TAILSCALE_TAG } from "../aws/tailscale.ts";
import type { OpOptions } from "../hermetic.ts";
import { evt } from "../events.ts";
import { abortableSleep, checkAbort } from "../abort.ts";
import { ATTACH_POLL_MS, elapsed, type AttachDeps } from "../agents/attach.ts";
import type { CoreContext } from "../context.ts";

/** What the tailnet sweep reads from the shared context: the backend and the clock. */
export type TailnetDeps = Pick<CoreContext, "backend" | "nowIso">;

/**
 * How long `destroy` and `recreate` wait, after every instance for the name is
 * `terminated`, for the agent's devices to read offline before they sweep
 * (`waitTailnetOffline`, `retire-nodes.ts`). Tailscale notices a node has
 * stopped some time after its machine did — a minute or two is usual — and
 * three minutes covers that without holding an operation open for a node that
 * is not coming down. `HermeticDeps.attach`
 * overrides it; tests set it to zero.
 */
export const TAILNET_OFFLINE_WAIT_MS = 180_000;

/** The cadence and the budget `waitTailnetOffline` runs on, and the lock it renews. */
export type TailnetWait = Pick<AttachDeps, "pollMs" | "now" | "tailnetOfflineMs"> & {
  /** Called once per poll: the caller's TTL lock (§4.4). */
  heartbeat?: () => Promise<void>;
};

/**
 * Which devices in the tailnet are this agent's (§6.5).
 *
 * Ownership is decided on `hostname`, not on the MagicDNS `name`: `hostname`
 * is the OS hostname, which cloud-init sets, while `name` is what carries
 * the `-2` suffix. Matching on the hostname therefore finds both the corpse
 * and its replacement under one agent, where matching on the name would
 * find neither reliably. The tag is the second half of the question — a
 * device somebody else put in this tailnet under the same hostname is not
 * ours to delete.
 *
 * Two things identify this agent's devices, and they are matched on
 * different fields on purpose:
 *
 * - `hostname === cloudName(fleet id, agent)` — what a node launched by this
 *   build joins as. On the *hostname*, because that is what finds both the
 *   corpse and the `-2` replacement it pushed onto a suffixed name.
 * - `name === ` the row's own `tailscale_dns_name` (`reported`, root dot
 *   stripped) — the FQDN *this agent's* node reported about itself on its
 *   last heartbeat. On the *name*, because it is exact: a pre-v3 node is
 *   called `atlas`, and so is every other pre-v3 fleet's `atlas`, but only
 *   one device in the tailnet answers to `atlas.hermetic.ts.net`.
 *
 * The second replaces a blanket "match the bare name when the fleet has no
 * name" pass, which could not tell our pre-v3 `atlas` from another fleet's
 * and would have deleted either. Nothing here can reach a device no row of
 * ours names.
 *
 * It is also the arm that carries the whole job on a box built before v4:
 * that node's hostname is its v3 or pre-v3 spelling, so it can never equal
 * the fleet-id canonical name, and the reported FQDN is the only thing
 * that still ties it to this row. Recreating a legacy agent therefore
 * cleans up after itself exactly as a current one does.
 *
 * One function for the sweep and for the wait before it, so the devices the
 * wait watches are exactly the ones the sweep then acts on.
 */
function matchDevices(
  devices: TailscaleDevice[],
  name: string,
  fleetId: string | undefined,
  reported: string | null,
): TailscaleDevice[] {
  const canonical = cloudName(fleetId, name);
  return devices.filter(
    (d) =>
      d.tags.includes(TAILSCALE_TAG) &&
      (d.hostname === canonical || (reported !== null && d.name === reported)),
  );
}

/** The row's `tailscale_dns_name`, minus the DNS root dot Tailscale includes. */
function reportedName(dnsName: string | null): string | null {
  return dnsName === null ? null : dnsName.replace(/\.$/, "");
}

/** A device's name for an event: its FQDN, or its hostname when it has none. */
function fqdnOf(device: TailscaleDevice): string {
  return device.name || device.hostname;
}

export function createTailnetCleanup(deps: TailnetDeps) {
  const { backend, nowIso } = deps;

  /**
   * Delete the agent's own devices from the tailnet, after its instance is gone
   * (§6.5, §6.7).
   *
   * WHY this exists: Tailscale gives a joining node the name it asks for only if
   * nothing else in the tailnet holds it. A terminated box leaves its device
   * behind, so the replacement is admitted as `<name>-2` and MagicDNS keeps
   * resolving `<name>` to a machine that no longer exists. Deleting the corpse
   * here is what lets the next node claim the canonical name — everything else
   * hermetic does about this (the real name on the row, `doctor`'s stale-device
   * note) is a way of living with the corpse rather than removing it.
   *
   * WHY nothing in here is fatal: the caller has already terminated an instance.
   * A tailnet that is unreachable, or an OAuth client that was never re-scoped,
   * must not turn a destroy that did its job into a failed op — so every failure
   * is a `warn` event and the op carries on.
   *
   * `progress` and `opts` are arguments rather than closure state because the two
   * callers place this at different points in their own progress bar, and both
   * are abort-aware (§3.2 rule 2).
   *
   * The generator's return value is the devices it left holding the name —
   * each one's FQDN — once it has looked at every match, or `null` when it
   * could not finish looking (no list, no scope, a failed delete; each of
   * those has already said so in a `warn`).
   *
   * A match that still reads online is never deleted, whatever the caller
   * knows about its own instances. Hostname and tag are not proof of which
   * machine a device is: they are what a box this fleet launched for the
   * name joins as, but an orphaned live node whose instance lost its EC2
   * agent tags — so no terminate or wait of ours ever saw it — joins as
   * exactly the same thing, and so does any node that reports a forged
   * `tailscale_dns_name`. "Online" is the one fact that says a machine may
   * be running, and hermetic does not delete those on a guess (§1). The
   * caller that can afford to wait for a lagging flag does so first
   * (`waitTailnetOffline`); then `sweep.online` says what becomes of a match
   * still online:
   *
   * - absent: named in a `warn` and left alone (`recreate`'s one pass, and
   *   `destroy`'s second — both after `waitTailnetOffline`, `retire-nodes.ts`);
   * - `"defer"`: skipped without a word and returned, for a caller that
   *   sweeps twice and will look again once its boxes are `terminated`
   *   (`destroy-agent.ts`'s first pass).
   *
   * Offline matches on either arm are deleted in both modes.
   */
  async function* removeTailnetDevices(
    name: string,
    fleetId: string | undefined,
    /**
     * The row's `tailscale_dns_name` — the FQDN this agent's node last reported
     * for itself. Its first label is the node's OS hostname, and it is the only
     * evidence that ties a *particular* device to *this* row (see below).
     * `null` on a row that has never heartbeated, which has no device yet.
     */
    dnsName: string | null,
    phase: string,
    progress: number,
    opts: OpOptions = {},
    sweep: { online?: "defer" } = {},
  ): AsyncGenerator<OpEvent, string[] | null, undefined> {
    const reported = reportedName(dnsName);
    /** The one sentence for "hermetic is not allowed to do this", said once. */
    const unscoped = (): OpEvent =>
      evt(
        phase,
        progress,
        `tailnet devices not checked: the OAuth client lacks devices:core; ` +
          `the old device keeps the name ${reported ?? cloudName(fleetId, name)} until it is deleted in the admin console`,
        nowIso(),
        "warn",
      );
    const why = (e: unknown): string => (e instanceof Error ? e.message : String(e));

    let devices: TailscaleDevice[] | null;
    try {
      devices = await backend.tailscale.listDevices();
    } catch (e) {
      yield evt(phase, progress, `tailnet devices not checked: ${why(e)}`, nowIso(), "warn");
      return null;
    }
    if (devices === null) {
      yield unscoped();
      return null;
    }

    const mine = matchDevices(devices, name, fleetId, reported);
    const remaining: string[] = [];
    for (const device of mine) {
      checkAbort(opts.signal, phase);
      const fqdn = fqdnOf(device);
      if (device.online) {
        remaining.push(fqdn);
        if (sweep.online === "defer") continue;
        // This runs only after every instance was terminated and the wait for
        // the flag to catch up (`retire-nodes.ts`), so a node still up is one we
        // did not launch, did not manage to kill, or only a hostname or a
        // box-written FQDN ties to this row. Any of those may be a live
        // machine, and hermetic does not delete those on a guess (§1).
        yield evt(
          phase,
          progress,
          `${fqdn} is still online; not deleting a live node`,
          nowIso(),
          "warn",
        );
        continue;
      }
      let outcome: TailscaleDeleteOutcome;
      try {
        outcome = await backend.tailscale.deleteDevice(device.id);
      } catch (e) {
        // Once, then stop: an API that just refused this call will refuse the
        // next one too, and one warning is the useful number.
        yield evt(
          phase,
          progress,
          `could not delete tailnet device ${fqdn}: ${why(e)}`,
          nowIso(),
          "warn",
        );
        return null;
      }
      if (outcome === "forbidden") {
        yield unscoped();
        return null;
      }
      // `not_found` is the state we wanted: somebody already deleted it.
      if (outcome === "deleted") {
        yield evt(phase, progress, `removed tailnet device ${fqdn}`, nowIso());
      }
    }
    return remaining;
  }

  /**
   * Wait, for a bounded time, until none of the agent's devices reads online
   * — the pause between confirming every instance `terminated` and the sweep
   * that follows, in `destroy` before it releases the name (§6.7) and in
   * `recreate` before it launches the replacement (§6.5); both run it through
   * `retire-nodes.ts`.
   *
   * WHY wait at all: the sweep never deletes an online device (see
   * `removeTailnetDevices`), and Tailscale lags in noticing a node has
   * stopped — a node can read online for a minute or more after its machine
   * is gone. Sweeping straight after the terminate would leave the very
   * corpse this cleanup exists for holding the name, and the next node of
   * that name — a recreate's replacement, or a later agent — would join as
   * `<name>-2`. Waiting for the flag lets the sweep
   * delete it on evidence rather than on a guess.
   *
   * WHY bounded, and why the caller proceeds at the deadline: a device still
   * online after `tailnetOfflineMs` (`TAILNET_OFFLINE_WAIT_MS`) is not lag —
   * it is a machine that is running, ours or not. Waiting longer cannot make
   * it safe to delete, and refusing would hold the name hostage to a node
   * hermetic cannot stop; so the wait ends, the sweep names it in a `warn`,
   * and the release or the launch goes on.
   *
   * Never fatal and never a second warning: a list that fails, or a client
   * without `devices:core` (`null`), ends the wait silently, and the sweep
   * that follows lists again and says so once. The elapsed time is the clock
   * or the polls slept, whichever is further on, so a clock that does not
   * move (the fixture's) still reaches the deadline.
   */
  async function* waitTailnetOffline(
    name: string,
    fleetId: string | undefined,
    dnsName: string | null,
    phase: string,
    progress: number,
    opts: OpOptions = {},
    wait: TailnetWait = {},
  ): AsyncGenerator<OpEvent, void, undefined> {
    const reported = reportedName(dnsName);
    const now = wait.now ?? Date.now;
    const pollMs = wait.pollMs ?? ATTACH_POLL_MS;
    const budget = wait.tailnetOfflineMs ?? TAILNET_OFFLINE_WAIT_MS;
    const started = now();
    let slept = 0;
    let said = false;
    for (;;) {
      checkAbort(opts.signal, phase);
      await wait.heartbeat?.();
      let devices: TailscaleDevice[] | null;
      try {
        devices = await backend.tailscale.listDevices();
      } catch {
        return;
      }
      if (devices === null) return;
      const online = matchDevices(devices, name, fleetId, reported).filter((d) => d.online);
      if (online.length === 0) return;
      if (Math.max(now() - started, slept) >= budget) return;
      if (!said) {
        said = true;
        yield evt(
          phase,
          progress,
          `waiting up to ${elapsed(budget)} for ${online.map(fqdnOf).join(", ")} to go offline`,
          nowIso(),
        );
      }
      await abortableSleep(pollMs, opts.signal);
      slept += pollMs;
    }
  }

  return { removeTailnetDevices, waitTailnetOffline };
}
