/**
 * What a reviewed plan promised, and the check that it is still true (§6.7).
 *
 * `plans.assertCurrent` compares a destroy or recreate plan against the agent
 * row before `apply` executes it, and that check has a gap after it by
 * construction: it reads the row, compares, and returns, and the operation
 * takes the agent's lock afterwards. A `recreate` landing in the gap swaps
 * `instance_id`, and the destroy then terminates a box the operator never saw —
 * the plan said "terminate i-old", and `i-new`, minutes old with a fresh agent
 * on it, is what dies.
 *
 * So the promise travels: `apply` hands what the plan named to the operation,
 * and the operation asks the same question again the moment its lock is held,
 * which is the first moment the answer cannot go stale between the asking and
 * the acting. One shape and one comparison, in a module of their own so the two
 * askers cannot drift apart (and so `lifecycle.ts` stays under rule 5's limit).
 */
import type { Agent } from "../schema/index.ts";
import { HermeticError } from "../errors.ts";

/**
 * The resources a plan named, carried from `plans.assertCurrent` into the
 * operation that executes the plan.
 *
 * `undefined` and `null` differ and both are meaningful: `undefined` is a plan
 * that said nothing about that resource — an older build wrote it — and `null`
 * is a plan that said there was none. The first is not compared; the second is.
 */
export interface ExpectedResources {
  instance_id?: string | null;
  volume_id?: string | null;
  /**
   * The incarnation the plan was made for (`PlanOptions.created_at`): compared,
   * because a name freed by a destroy (§6.7) can be claimed again by a row
   * whose ids are as null as the planned one's were. `undefined` is a plan
   * that said nothing — never a destroy plan, which `apply` refuses without it.
   */
  created_at?: string;
  /** Carried for the refusal's details, never compared — see `assertUnmoved`. */
  agent_version: number;
}

/**
 * Refuse unless the row still names what the plan named.
 *
 * The ids and the incarnation (`created_at`) are compared and the version is
 * not, for the reason `plans.ts` spells out at length: `hermeticd` bumps the
 * version from the box on every `ready → degraded` and back, and taking the
 * lock bumps it once more, so an equality on it would refuse every plan for
 * the flapping agent somebody is trying to destroy. The version is carried for
 * the refusal's details, where it says how far the row travelled; what the
 * plan actually promised is the ids, on the incarnation of the name it showed.
 */
export function assertUnmoved(agent: Agent, expected: ExpectedResources): void {
  const instanceId = agent.resources.instance_id ?? agent.instance_id ?? null;
  const volumeId = agent.resources.volume_id ?? agent.volume_id ?? null;
  const moved: string[] = [];
  if (expected.created_at !== undefined && expected.created_at !== agent.created_at) {
    moved.push(
      `the plan was made for the ${agent.name} created at ${expected.created_at} and the row now is one created at ${agent.created_at}`,
    );
  }
  if (expected.instance_id !== undefined && expected.instance_id !== instanceId) {
    moved.push(
      `the plan named instance ${expected.instance_id ?? "(none)"} and the row now names ${instanceId ?? "(none)"}`,
    );
  }
  if (expected.volume_id !== undefined && expected.volume_id !== volumeId) {
    moved.push(
      `the plan named data volume ${expected.volume_id ?? "(none)"} and the row now names ${volumeId ?? "(none)"}`,
    );
  }
  if (moved.length === 0) return;
  throw new HermeticError(
    "PLAN_STALE",
    `${agent.name} moved between the plan being checked and the lock being taken — ${moved.join("; ")}; nothing was destroyed. Run \`hermetic plan destroy ${agent.name}\` again and read it before applying`,
    {
      name: agent.name,
      moved,
      planned_version: expected.agent_version,
      observed_version: agent.version,
      planned_instance_id: expected.instance_id ?? null,
      observed_instance_id: instanceId,
      planned_volume_id: expected.volume_id ?? null,
      observed_volume_id: volumeId,
      planned_created_at: expected.created_at ?? null,
      observed_created_at: agent.created_at,
    },
  );
}
