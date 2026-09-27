/**
 * Which Bedrock models this fleet's instance role may invoke (§5.1, §8.3).
 *
 * The grant is a CloudFormation parameter — `BedrockModelArns` — and until now
 * it was decided once, at `init`, from whatever `DEFAULT_BEDROCK_MODEL_IDS` the
 * creating build shipped, and then carried forward untouched by every
 * `foundation update` (`UsePreviousValue`). That made a Bedrock profile naming
 * any other model permanently unusable: the profile could be created, the agent
 * could be built, and every turn failed with `AccessDeniedException` from a
 * policy nothing in hermetic would ever rewrite.
 *
 * So the set is *reconciled* instead. `foundation update` computes what the
 * fleet actually needs — this build's defaults, plus every Bedrock profile's
 * model, plus every Bedrock model an agent row pins — states it on the change
 * set, and records the result on `_fleet.bedrock_model_ids` so the laptop can
 * answer "is this model granted" without a `DescribeStacks` on every read.
 *
 * Pure. Everything here is a function of documents the caller already has, so
 * the plan can show the delta and the update can apply it from the same code.
 */
import { DEFAULT_BEDROCK_MODEL_IDS } from "../aws/index.ts";
import type { Agent, FleetSettings } from "../schema/index.ts";
import { bedrockBaseModelId, profilesOf } from "./provider-profiles.ts";

/**
 * The ids a fleet needs granted, sorted and deduplicated.
 *
 * Three sources, and the union rather than a replacement: a fleet that was
 * granted something an older build defaulted to keeps it, because an agent may
 * still be running on it and a foundation update is not the place to take a
 * model away from a box that is serving. Pruning would need to be its own,
 * asked-for act.
 *
 * `pending.model` counts as much as `hermes.model` does. An agent staged onto a
 * Bedrock model and not yet applied is exactly the case where the operator runs
 * `foundation update` first — refusing to grant what is staged would make the
 * order of those two commands a trap.
 */
export function desiredBedrockModelIds(input: {
  settings: FleetSettings;
  agents: readonly Agent[];
  /** What the fleet already has, so an update never narrows the grant. */
  granted?: readonly string[] | undefined;
}): string[] {
  const ids = new Set<string>([...DEFAULT_BEDROCK_MODEL_IDS, ...(input.granted ?? [])]);
  for (const profile of profilesOf(input.settings)) {
    if (profile.provider === "bedrock") ids.add(profile.model);
  }
  for (const agent of input.agents) {
    if (agent.status === "destroyed") continue;
    if (agent.provider === "bedrock" && agent.hermes?.model !== undefined) {
      ids.add(agent.hermes.model);
    }
    const pending = agent.pending;
    if (pending !== null && pending !== undefined && pending.provider === "bedrock") {
      ids.add(pending.model);
    }
  }
  return [...ids].sort();
}

/**
 * The ids inside a `BedrockModelArns` parameter value, whichever of the two
 * spellings `bedrockModelArns` emitted them in.
 *
 * It is how the v10 migration back-fills `_fleet.bedrock_model_ids` on a fleet
 * that has never recorded them: the stack is the register of record for what
 * the role may do, and reading it is the only way to learn what an older build
 * granted without assuming this build's defaults — which is precisely the
 * assumption that made the field necessary.
 */
export function bedrockIdsFromArns(parameter: string | undefined): string[] {
  if (parameter === undefined || parameter.trim() === "") return [];
  const ids = new Set<string>();
  for (const raw of parameter.split(",")) {
    const arn = raw.trim();
    if (arn === "") continue;
    const foundation = /:foundation-model\/(.+)$/.exec(arn);
    if (foundation?.[1] !== undefined) {
      ids.add(foundation[1]);
      continue;
    }
    // `inference-profile/*.<id>` — the wildcard is the region prefix
    // (`us.`, `eu.`), and the id is what is granted.
    const inference = /:inference-profile\/\*\.(.+)$/.exec(arn);
    if (inference?.[1] !== undefined) ids.add(inference[1]);
  }
  return [...ids].sort();
}

/**
 * The models named somewhere in this fleet that its role may not invoke — what
 * `foundation status` and `doctor` report as a stale grant (§8.3).
 *
 * Deliberately computed against what `_fleet` *records* rather than against
 * this build's defaults: the question is whether the fleet's own stack allows
 * it, and a newer laptop's default list is not evidence about somebody else's
 * stack.
 */
export function staleBedrockGrants(input: {
  settings: FleetSettings;
  agents: readonly Agent[];
  granted: readonly string[];
}): string[] {
  const have = new Set(input.granted.map(bedrockBaseModelId));
  const wanted = desiredBedrockModelIds({ settings: input.settings, agents: input.agents });
  return wanted.filter((id) => !have.has(bedrockBaseModelId(id)));
}
