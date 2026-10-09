/**
 * Who a resource belongs to, and what it takes to prove it (§6.7).
 *
 * Instance ids and volume ids reach `destroy` and `recreate` from the agent
 * row, and the agent row is writable by the box itself: `hermeticd` reports its
 * own address, health and metrics back into DynamoDB, and the instance role's
 * `FleetRows` statement grants whole-item writes rather than per-attribute
 * ones. A compromised box can therefore put *any* id into
 * `resources.instance_id` or `resources.volume_id` — another fleet's box, an
 * operator's detached disk — and wait for somebody to run `destroy`. The row is
 * a hint about which resource was meant; it is not evidence of ownership.
 *
 * Tags are that evidence, and they are the same evidence every other lookup in
 * hermetic already relies on: `hermetic:managed=true` plus `agent=<name>` plus
 * `hermetic:fleet_id=<id>` is the only identity an EC2 resource has (§5.1), and
 * only the operator's credentials can write them. So before a by-id terminate
 * or delete, the resource is resolved and its tags are read; a resource whose
 * tags name somebody else is refused with `RESOURCE_NOT_OWNED` and nothing is
 * touched, including the row.
 *
 * The check lives here rather than in `lifecycle.ts` so both backends can share
 * one policy — `Ec2Compute` reads the tags off `DescribeInstances`/
 * `DescribeVolumes`, `MemoryBackend` off the tags it models — and so the
 * refusal reads identically wherever it comes from.
 */
import {
  AGENT_TAG,
  FLEET_ID_TAG,
  FORMER_AGENT_TAG,
  MANAGED_TAG,
  MANAGED_TAG_VALUE,
  ROLE_DATA,
  ROLE_TAG,
} from "../backend/constants.ts";
import { HermeticError } from "../errors.ts";
import type { ComputeApi, InstanceRef, OwnedVolumeStatus } from "../backend/types.ts";

/** The identity a by-id mutation claims the resource has. */
export interface ResourceOwner {
  fleet_id: string;
  /** The agent whose row named the id. */
  agent: string;
}

/**
 * A resource's tags as a plain map. A key that is absent and a key whose value
 * is `undefined` are the same state — untagged — which is how EC2 reports one.
 */
export type ResourceTags = Readonly<Record<string, string | null | undefined>>;

/** Only the three (four, for a volume) tags the check reads, in a stable order. */
function describeTags(tags: ResourceTags): string {
  const keys = [MANAGED_TAG, AGENT_TAG, FLEET_ID_TAG, ROLE_TAG];
  const shown = keys.flatMap((k) => {
    const v = tags[k];
    return v === undefined || v === null ? [] : [`${k}=${v}`];
  });
  return shown.length === 0 ? "no hermetic tags" : shown.join(", ");
}

/**
 * Refuse unless the tags say this resource is the named agent's, in the named
 * fleet, and hermetic's. `kind` is the noun the message uses ("instance",
 * "volume"); `role` is an optional extra tag the caller requires, which is how
 * a data volume is told from the root disk that carries the same `agent` tag.
 *
 * Throws rather than returning a verdict: every caller's only correct response
 * is to stop, and a boolean invites one of them to get that wrong.
 */
export function assertResourceOwned(
  kind: "instance" | "volume",
  id: string,
  owner: ResourceOwner,
  tags: ResourceTags,
  role?: string,
): void {
  const wrong =
    tags[MANAGED_TAG] !== MANAGED_TAG_VALUE ||
    tags[AGENT_TAG] !== owner.agent ||
    tags[FLEET_ID_TAG] !== owner.fleet_id ||
    // A volume from before `hermetic:role` existed carries no role tag and is
    // still the agent's data disk (`findVolumeByTag` adopts exactly that one).
    // A tag naming a *different* role is another matter: that is the root disk.
    (role !== undefined && tags[ROLE_TAG] !== undefined && tags[ROLE_TAG] !== role);
  if (!wrong) return;
  throw new HermeticError(
    "RESOURCE_NOT_OWNED",
    `${kind} ${id} is not ${owner.agent}'s in fleet ${owner.fleet_id}: it carries ${describeTags(tags)}`,
    {
      kind,
      id,
      expected: { agent: owner.agent, fleet_id: owner.fleet_id, ...(role ? { role } : {}) },
      found: {
        [MANAGED_TAG]: tags[MANAGED_TAG] ?? null,
        [AGENT_TAG]: tags[AGENT_TAG] ?? null,
        [FLEET_ID_TAG]: tags[FLEET_ID_TAG] ?? null,
        [ROLE_TAG]: tags[ROLE_TAG] ?? null,
        // Not part of the check: what a release reads to tell a volume it
        // already moved off this name from one that is somebody else's.
        [FORMER_AGENT_TAG]: tags[FORMER_AGENT_TAG] ?? null,
      },
    },
  );
}

/** The role tag a by-id volume delete requires: the data disk, never a root one. */
export const OWNED_VOLUME_ROLE = ROLE_DATA;

/**
 * The instance the row named, when it exists and is this agent's; `null` when
 * EC2 no longer has it, which every caller already treats as "already gone".
 * Throws `RESOURCE_NOT_OWNED` when it exists and belongs to somebody else.
 */
export async function assertOwnedInstance(
  compute: ComputeApi,
  owner: ResourceOwner,
  instanceId: string,
): Promise<InstanceRef | null> {
  return await compute.describeOwnedInstance(instanceId, owner);
}

/** The same for a volume: this agent's data disk, `null`, or a refusal. */
export async function assertOwnedVolume(
  compute: ComputeApi,
  owner: ResourceOwner,
  volumeId: string,
): Promise<OwnedVolumeStatus | null> {
  return await compute.describeOwnedVolume(volumeId, owner);
}
