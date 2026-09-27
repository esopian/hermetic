import { z } from "zod";
export { fleetTargetOf, sameFleetTarget, describeFleetTarget } from "../shared/target.ts";
import { AccountId, FleetIdSchema, Region } from "./common.ts";

/**
 * Which fleet a request means, said in terms nothing can rename (§4.7).
 *
 * A fleet's display alias moves, its default-ness moves, and — in the portal —
 * *which* fleet is selected moves, globally, for every tab at once. None of
 * those may decide what a destructive request acts on. The account, the region
 * and the `fleet_id` are the three facts about a fleet that are fixed from
 * `init` until teardown, so they are what a request names when it says "this
 * one".
 *
 * It exists here, in core's schema, rather than in the server, because it is
 * the same triple `guardAccount`/`guardFleet` check against AWS and the same
 * triple the local `fleets` row is keyed by — one shape, one source of types.
 * The *enforcement* is a head's job: core is called in-process by the CLI,
 * which resolved its target before it opened core at all, so only the HTTP head
 * has a request that could mean a fleet other than the one it is serving.
 */
export const FleetTarget = z.object({
  account_id: AccountId,
  region: Region,
  fleet_id: FleetIdSchema,
});
export type FleetTarget = z.infer<typeof FleetTarget>;
