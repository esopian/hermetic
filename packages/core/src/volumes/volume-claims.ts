/**
 * The volume reservation of §9.1: one TTL claim, keyed by volume id, shared by
 * the two operations that act on a disk nothing owns yet.
 *
 * Every other durable claim hermetic makes is a row. `agent create --volume`
 * and `volume delete` are the two operations where the row is precisely what is
 * missing: a volume whose owner was destroyed, or never written, has nothing to
 * take a lock on, so both operations read the world, decide, and then act — and
 * between the reading and the acting is a window two operators can both walk
 * through. `create` closes half of it by re-reading under the agent's own lock
 * (`reconfirmAdopted`), and `delete` closes half of it by re-reading
 * immediately before `DeleteVolume`, but two *adoptions* of the same id are
 * locked on different agent names and so pass each other going in: both retag,
 * both persist ownership, both launch, and EC2 refuses only the second attach —
 * after the money is spent. A reservation keyed on the thing they are actually
 * competing for is the missing half.
 *
 * It is deliberately a *reservation* and not a lock on the volume: it covers
 * only the window between "nothing else owns this disk" and "an agent row says
 * it is mine". Once the row records the volume, the row is the claim — §9.1's
 * refusals read it — and the reservation is released. A run that dies inside
 * the window leaves a claim that expires on its own, the same ten minutes any
 * §4.4 lock lives without a heartbeat, so a dead laptop costs a wait rather
 * than an operator with no way in.
 *
 * Written as a module taking an explicit deps object (AGENTS.md rule 5).
 */
import type { VolumeClaim, VolumeClaimStore } from "../backend/types.ts";
import { HermeticError } from "../errors.ts";

export interface VolumeReservationDeps {
  claims: VolumeClaimStore;
  /** The backend's clock, so a test can hold time still. */
  now: () => Date;
  /** §4.4's TTL. The same ten minutes an agent lock gets. */
  ttlMs: number;
}

export interface VolumeReservation {
  /**
   * Reserve `volumeId` for `owner`, or refuse `LOCKED` naming who has it.
   * Re-entrant for the same owner: a resumed create is the same operation and
   * only pushes the expiry out.
   */
  claim(volumeId: string, owner: string): Promise<VolumeClaim>;
  /** Give it back. Losing the race is a no-op, never an error. */
  release(volumeId: string, owner: string): Promise<void>;
  /** Who holds it *now*; `null` for no claim or an expired one. */
  holder(volumeId: string): Promise<VolumeClaim | null>;
  /** Every live claim, by volume id — one read, for the list view. */
  holders(): Promise<Map<string, VolumeClaim>>;
  /**
   * Hold the reservation across `run` and release it however `run` ends. The
   * shape `volume delete` wants: its whole critical section is one function
   * call, and a delete that threw with the claim still held would lock the disk
   * out for the rest of the TTL for no reason.
   */
  withClaim<T>(volumeId: string, owner: string, run: () => Promise<T>): Promise<T>;
}

/**
 * The owner string an adoption reserves under: the agent that is going to own
 * the disk, not the run that is creating it.
 *
 * Which is the point. Two `create bravo --volume vol-X` runs are the same
 * operation — one is a resume of the other, or a second operator finishing what
 * a dead laptop started — and must not lock each other out; two creates under
 * *different* names are the collision this exists to refuse. The agent name is
 * exactly that distinction, and it is also what an operator needs to read in
 * the refusal.
 */
export function adoptionOwner(name: string): string {
  return `agent create ${name}`;
}

/**
 * The owner string a delete reserves under. Unlike an adoption there is nothing
 * durable to name — no row, no agent — so the run id keeps two deletes of one
 * volume from being read as the same operation.
 */
export function deletionOwner(runId: string): string {
  return `volume delete (${runId})`;
}

export function createVolumeReservation(deps: VolumeReservationDeps): VolumeReservation {
  const { claims, now, ttlMs } = deps;

  function live(claim: VolumeClaim | null, at: Date): VolumeClaim | null {
    if (!claim) return null;
    // `>=`, matching how the store reads an expiry: a claim expiring on this
    // exact tick is still held (`#expires < :now` frees it, and not before).
    return Date.parse(claim.expires) >= at.getTime() ? claim : null;
  }

  async function claim(volumeId: string, owner: string): Promise<VolumeClaim> {
    const at = now();
    const expires = new Date(at.getTime() + ttlMs).toISOString();
    const { ok, holder } = await claims.claim(volumeId, owner, expires, at);
    if (ok) return holder;
    throw new HermeticError(
      "LOCKED",
      `${volumeId} is reserved by ${holder.owner} until ${holder.expires}; ` +
        "hermetic will not adopt or delete a volume another operation is already acting on. " +
        "Wait for it to finish, or re-run once the reservation expires.",
      { volume_id: volumeId, holder: holder.owner, expires: holder.expires, owner },
    );
  }

  return {
    claim,
    release: (volumeId, owner) => claims.release(volumeId, owner),
    holder: async (volumeId) => live(await claims.get(volumeId), now()),
    holders: async () => {
      const at = now();
      const map = new Map<string, VolumeClaim>();
      for (const held of await claims.list()) {
        if (live(held, at)) map.set(held.volume_id, held);
      }
      return map;
    },
    withClaim: async (volumeId, owner, run) => {
      await claim(volumeId, owner);
      try {
        return await run();
      } finally {
        await claims.release(volumeId, owner);
      }
    },
  };
}
