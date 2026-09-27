/**
 * What `network.status` answers with (§5, §9).
 *
 * The fleet's network mode lives in two places and only one of them is true:
 * CloudFormation owns the subnets, so the stack's `Network` parameter is
 * authoritative and `_fleet.network` is the cache heads read without spending a
 * `DescribeStacks`. This report carries both, side by side, rather than picking
 * one and hiding the disagreement — reconciling the two is the whole reason the
 * read exists, and `doctor` turns a mismatch into a finding.
 *
 * The other half is placement. EC2 cannot move a running instance between
 * subnets, so a fleet that changes mode strands every agent it already has on
 * the subnets it used to launch into. Nothing breaks immediately — those boxes
 * keep their old egress — but they are no longer the fleet they belong to, and
 * the only fix is `agent recreate`. So drift is reported per agent, by name,
 * rather than summarised into a number nobody can act on.
 */
import { z } from "zod";
import { NetworkMode } from "./fleet.ts";

/**
 * Where one agent's instance actually sits, against where the fleet launches
 * today.
 *
 * `unknown` is deliberately not folded into `drifted`: an agent with no
 * instance (stopped, destroyed, never created) and an agent whose instance EC2
 * no longer describes are both "we cannot say", and calling that drift would
 * put a recreate in front of an operator for a box that does not exist.
 */
export const NetworkAgentPlacement = z.object({
  name: z.string(),
  instance_id: z.string().nullable(),
  subnet_id: z.string().nullable(),
  placement: z.enum(["matches", "drifted", "unknown"]),
});
export type NetworkAgentPlacement = z.infer<typeof NetworkAgentPlacement>;

/**
 * The NAT appliance a `nat` fleet's whole egress depends on (§5).
 *
 * `route_state` is the field that matters and the one nothing else reports:
 * `PrivateDefaultRoute` is pinned to the NAT instance's id, so when that
 * instance dies the route goes `blackhole` and every agent loses egress with
 * no other symptom than timeouts. A `running` instance with a blackholed route
 * is a real state — the instance was replaced and the route still names the
 * corpse — which is why both are carried rather than one derived from the
 * other.
 *
 * Every field is nullable because every one of them is a separate AWS read that
 * can come back empty on a stack mid-update, and a report that refused to
 * answer until all four agreed would be unavailable exactly when it is wanted.
 */
export const NatHealth = z.object({
  instance_id: z.string().nullable(),
  /** EC2's own word — `running`, `stopped`, `terminated` — never a verdict. */
  instance_state: z.string().nullable(),
  /** The `NatEip` the stack allocated: a `nat` fleet's stable outbound address. */
  egress_ip: z.string().nullable(),
  route_state: z.enum(["active", "blackhole"]).nullable(),
});
export type NatHealth = z.infer<typeof NatHealth>;

export const NetworkReport = z.object({
  /**
   * `_fleet.network`. `null` means "not back-filled", never "public": a fleet
   * created with `--network nat` before the field existed has nothing here, and
   * reading absence as `public` is exactly the mistake the v6 migration exists
   * to undo.
   */
  mode: NetworkMode.nullable(),
  /** The stack's `Network` parameter: what the fleet *is*. Null only if the stack is gone. */
  stack_mode: NetworkMode.nullable(),
  /** The cache agrees with CloudFormation. False when it does not, and when it is absent. */
  consistent: z.boolean(),
  /** The stack's current `SubnetIds` output — where the next agent would launch. */
  subnet_ids: z.array(z.string()),
  /** `NatEgressIp`, on a `nat` fleet; null on a `public` one, which has no single address. */
  egress_ip: z.string().nullable(),
  /** Null on a `public` fleet — there is no NAT box — and when the probe could not read one. */
  nat: NatHealth.nullable(),
  agents: z.array(NetworkAgentPlacement),
  /** How many of `agents` are `drifted`; the names are in the list. */
  drifted: z.number().int().nonnegative(),
});
export type NetworkReport = z.infer<typeof NetworkReport>;
