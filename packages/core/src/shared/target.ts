/**
 * Which fleet a request means, said in terms nothing can rename (§4.7), and
 * the one comparison every head makes on it. The Zod schema of the same shape
 * is `schema/target.ts`.
 *
 * Pure values only — no Zod, no `node:*`, nothing that opens a file or a
 * socket — because `shared/index.ts` re-exports from here into the browser and
 * the box. The Zod schemas that validate these shapes live in `schema/*`, which
 * imports this module, never the reverse (`packages/core/test/shared-browser-safe.test.ts`).
 */

export interface FleetTarget {
  account_id: string;
  region: string;
  fleet_id: string;
}

/** The target of anything that knows its own account, region and `fleet_id`. */
export function fleetTargetOf(config: {
  account_id: string;
  region: string;
  fleet_id: string;
}): FleetTarget {
  return { account_id: config.account_id, region: config.region, fleet_id: config.fleet_id };
}

/** True when two targets name the same fleet. All three fields, or none of them. */
export function sameFleetTarget(a: FleetTarget | null, b: FleetTarget | null): boolean {
  if (a === null || b === null) return false;
  return a.account_id === b.account_id && a.region === b.region && a.fleet_id === b.fleet_id;
}

/**
 * One line naming a target, for an error message and for the pending-op log.
 * Deliberately not a parseable wire format: the wire form is the object above,
 * and a second encoding of the same thing is a second thing to keep in step.
 */
export function describeFleetTarget(target: FleetTarget | null): string {
  if (target === null) return "(no fleet selected)";
  return `${target.fleet_id} in ${target.account_id}/${target.region}`;
}
