/**
 * `agent create --volume <id>`: the two looks `create` takes at a volume the
 * operator named — one before the row is claimed, so a refusal costs nothing,
 * and one under the run's own lock and §9.1's reservation, so two creates
 * cannot both adopt the same disk. Split out of `lifecycle.ts` for size; the
 * design comments travelled with the code.
 */
import { HermeticError } from "../../errors.ts";
import type { Backend, VolumeDetail } from "../../backend/types.ts";
import { ambiguousVolumeTags } from "../../volumes/volumes.ts";
import { adoptionOwner } from "../../volumes/volume-claims.ts";
import type { VolumeReservation } from "../../volumes/volume-claims.ts";

export function createVolumeAdoption(deps: { backend: Backend; volumeClaims: VolumeReservation }) {
  const { backend, volumeClaims } = deps;

  /**
   * `agent create --volume <id>`: the volume the operator named, or a refusal.
   *
   * Called before the row is claimed, so every "no" here costs nothing. The five
   * refusals are the same rule five times — hermetic does not guess about a
   * volume that might be somebody's memory (§1):
   *
   * - unknown id → `NOT_FOUND`;
   * - ambiguous tag → `CONFLICT`, the same answer `findVolumeByTag` gives;
   * - not `hermetic:managed` → `VOLUME_UNUSABLE`; hermetic did not make it;
   * - attached, or in any state but `available` → `VOLUME_IN_USE`/`VOLUME_UNUSABLE`;
   * - in another AZ than the fleet launches into → `VOLUME_UNUSABLE`, refused
   *   *before* `RunInstances`, because a box that can never attach its own disk
   *   is money spent on nothing;
   * - still owned by a live agent row → `CONFLICT`; that agent's `recreate` is
   *   the command that wants it back.
   *
   * A `destroyed` row owning it is not a refusal: the row is kept forever (§4.3)
   * and its volume is exactly the memory this create exists to read again.
   */
  async function resolveAdopted(
    volumeId: string,
    name: string,
    fleetId: string,
  ): Promise<VolumeDetail> {
    const volumes = await backend.compute.listVolumes();
    const found = volumes.find((v) => v.volume_id === volumeId);
    if (!found) {
      /**
       * §5: `listVolumes` is already scoped to this fleet, so "not there" also
       * covers a volume another fleet has stamped — and that is the answer an
       * operator needs, because adopting one would be the most destructive
       * thing `--volume` could do (`retagVolume` would rewrite its
       * `hermetic:fleet_id` and the fleet that made the disk would stop finding
       * its own agent's memory). The two cases are not separated here because
       * separating them would mean reading outside the fleet to say so.
       */
      throw new HermeticError(
        "NOT_FOUND",
        `no volume ${volumeId} in this region, or it belongs to another fleet`,
        { volume_id: volumeId, fleet_id: fleetId },
      );
    }
    const twins = ambiguousVolumeTags(volumes).get(volumeId);
    if (twins) {
      throw new HermeticError(
        "CONFLICT",
        `${volumeId} and ${twins.join(", ")} are both tagged agent=${found.agent}; hermetic will not guess which one holds its memory`,
        { volume_id: volumeId, ambiguous_with: twins, agent: found.agent },
      );
    }
    if (!found.managed) {
      throw new HermeticError(
        "VOLUME_UNUSABLE",
        `${volumeId} is not managed by hermetic; it will not attach a volume it did not create`,
        { volume_id: volumeId },
      );
    }
    const attached = found.attachments.find((a) => a.state !== "detached");
    if (attached || found.state === "in-use") {
      throw new HermeticError(
        "VOLUME_IN_USE",
        `${volumeId} is attached to ${attached?.instance_id ?? "an instance"}`,
        { volume_id: volumeId, ...(attached ? { instance_id: attached.instance_id } : {}) },
      );
    }
    if (found.state !== "available") {
      throw new HermeticError("VOLUME_UNUSABLE", `${volumeId} is ${found.state}, not available`, {
        volume_id: volumeId,
        state: found.state,
      });
    }
    const az = await backend.compute.launchAz();
    if (found.availability_zone !== null && found.availability_zone !== az) {
      throw new HermeticError(
        "VOLUME_UNUSABLE",
        `${volumeId} is in ${found.availability_zone} and this fleet launches into ${az}; a volume can only be attached inside its own zone`,
        { volume_id: volumeId, availability_zone: found.availability_zone, launch_az: az },
      );
    }
    const owner = (await backend.store.agents.scan()).find(
      (a) =>
        (a.resources.volume_id ?? a.volume_id) === volumeId &&
        a.status !== "destroyed" &&
        a.name !== name,
    );
    if (owner) {
      throw new HermeticError(
        "CONFLICT",
        `agent ${owner.name} still owns ${volumeId}; \`hermetic agent recreate ${owner.name}\` puts it back on a new instance`,
        { volume_id: volumeId, agent: owner.name, status: owner.status },
      );
    }
    return found;
  }

  /**
   * The second look at an adopted volume, taken *after* the row claim and under
   * this run's lock (§4.4).
   *
   * `resolveAdopted` runs before the claim on purpose — a bad id should cost
   * nothing — but that makes every one of its refusals a read of a world this run
   * did not yet own. Two `create --volume vol-X` runs started together both pass
   * it, both retag `vol-X`, and both launch a box onto one disk; only later does
   * one of them lose a conditional write. Asking again here closes that window at
   * the only moment it can be closed: the name is ours, the lock is ours, and
   * nothing this run has done yet costs anything to undo.
   *
   * Only the two facts another operator can change are re-read — who owns the
   * volume, and whether something has attached it. The rest (managed, AZ, the
   * ambiguity of the tag) is settled by what the volume *is* and does not move
   * under a concurrent create.
   *
   * Re-reading is still not enough on its own, and §9.1's reservation is the
   * rest of the answer. Two creates under *different* names hold two different
   * agent locks, so nothing stops them both passing this check in the same
   * instant: both then retag the disk and both persist ownership of it, and EC2
   * refuses only the second attach — after both boxes are running and billing.
   * So the reservation is taken first, keyed on the volume id rather than on a
   * name, and held until the row records the volume. A refusal names the holder
   * and costs this run nothing: no key minted, no box launched, no tag written.
   */
  async function reconfirmAdopted(volumeId: string, name: string): Promise<void> {
    await volumeClaims.claim(volumeId, adoptionOwner(name));
    try {
      await reconfirmReserved(volumeId, name);
    } catch (e) {
      // Every refusal below leaves this run with nothing on this disk, so the
      // reservation goes back immediately rather than sitting out its TTL and
      // making the operator wait to retry something that already failed.
      await volumeClaims.release(volumeId, adoptionOwner(name));
      throw e;
    }
  }

  /** The two re-reads themselves, run under the reservation. */
  async function reconfirmReserved(volumeId: string, name: string): Promise<void> {
    const found = (await backend.compute.listVolumes()).find((v) => v.volume_id === volumeId);
    if (!found) {
      throw new HermeticError(
        "NOT_FOUND",
        `volume ${volumeId} disappeared while ${name} was being claimed`,
        { volume_id: volumeId, name },
      );
    }
    const attached = found.attachments.find((a) => a.state !== "detached");
    if (attached) {
      throw new HermeticError(
        "VOLUME_IN_USE",
        `${volumeId} was attached to ${attached.instance_id} while ${name} was being claimed`,
        { volume_id: volumeId, instance_id: attached.instance_id, name },
      );
    }
    const owner = (await backend.store.agents.scan()).find(
      (a) =>
        (a.resources.volume_id ?? a.volume_id) === volumeId &&
        a.status !== "destroyed" &&
        a.name !== name,
    );
    if (owner) {
      throw new HermeticError(
        "CONFLICT",
        `agent ${owner.name} claimed ${volumeId} while ${name} was being created; no key was minted and no instance launched for ${name}, and its row is left in \`creating\` for a re-run once ${owner.name} lets the volume go`,
        { volume_id: volumeId, agent: owner.name, status: owner.status, name },
      );
    }
  }

  return { resolveAdopted, reconfirmAdopted };
}
