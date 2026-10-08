/**
 * The tailnet side of a teardown: deleting the devices a destroyed or recreated
 * agent left behind (§6.5, §6.7).
 *
 * It is its own module because it has two callers that are not each other —
 * `destroy` (`destroy-agent.ts`) and `recreate` (`lifecycle.ts`) — and because
 * it needs four things from the SDK closure where those two need thirty. Naming
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
import { checkAbort } from "../abort.ts";
import type { CoreContext } from "../context.ts";

/** What the tailnet sweep reads from the shared context: the backend and the clock. */
export type TailnetDeps = Pick<CoreContext, "backend" | "nowIso">;

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
   * those has already said so in a `warn`). `deferOnline` is for a caller
   * that sweeps twice: a node still online is skipped without a word and
   * returned, because the caller will look again once the box is
   * `terminated` and report what is left then (`destroy-agent.ts`).
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
    sweep: { deferOnline?: boolean } = {},
  ): AsyncGenerator<OpEvent, string[] | null, undefined> {
    /** The reported FQDN, minus the DNS root dot Tailscale includes. */
    const reported = dnsName === null ? null : dnsName.replace(/\.$/, "");
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

    /**
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
     * - `name === ` the row's own `tailscale_dns_name` — the FQDN *this
     *   agent's* node reported about itself on its last heartbeat. On the
     *   *name*, because it is exact: a pre-v3 node is called `atlas`, and so is
     *   every other pre-v3 fleet's `atlas`, but only one device in the tailnet
     *   answers to `atlas.hermetic.ts.net`.
     *
     * The second replaces a blanket "match the bare name when the fleet has no
     * name" pass, which could not tell our pre-v3 `atlas` from another fleet's
     * and would have deleted either. Nothing here can reach a device no row of
     * ours names.
     *
     * It is also the arm that carries the whole job on a box built before v4:
     * that node's hostname is its v3 or pre-v3 spelling, so it can never equal
     * the fleet-id `canonical` below, and the reported FQDN is the only thing
     * that still ties it to this row. Recreating a legacy agent therefore
     * cleans up after itself exactly as a current one does.
     */
    const canonical = cloudName(fleetId, name);
    const mine = devices.filter(
      (d) =>
        d.tags.includes(TAILSCALE_TAG) &&
        (d.hostname === canonical || (reported !== null && d.name === reported)),
    );
    const remaining: string[] = [];
    for (const device of mine) {
      checkAbort(opts.signal, phase);
      const fqdn = device.name || device.hostname;
      if (device.online) {
        remaining.push(fqdn);
        if (sweep.deferOnline) continue;
        // This runs only after the instance was terminated, so a node still up is
        // one we did not launch or did not manage to kill. Either way it is a live
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

  return { removeTailnetDevices };
}
