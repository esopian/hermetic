/**
 * `mobile.pair` (round 3): the pairing link a phone scans to learn a fleet.
 *
 * Reads the fleet's identity (the frozen config plus the `_fleet` row's
 * tailnet) and its live agents, and encodes them with `encodeMobileLink`
 * (`shared/mobile-link.ts`), with the viewer preferences the caller asks the
 * phone to start with (`prefs`). A read: it mints nothing, stores nothing and
 * carries no secret — the phone's authentication to the fleet is tailnet
 * membership, so the link is safe to print, log and screenshot.
 */
import type { CoreContext } from "./context.ts";
import { parse } from "./chat/chat-seal.ts";
import { HermeticError } from "./errors.ts";
import { FLEET_KEY, cloudName } from "./shared/naming.ts";
import { encodeMobileLink, parseMobileLink } from "./shared/mobile-link.ts";
import {
  MobilePairInput,
  type AgentView,
  type ListAgentsInput,
  type MobileLinkAgent,
  type MobilePairResult,
} from "./schema/index.ts";

export interface MobilePairDeps {
  ctx: CoreContext;
  /** `agents.list`: the live rows, name-sorted, `destroyed` already dropped. */
  listAgents: (input?: ListAgentsInput) => Promise<AgentView[]>;
}

/**
 * The agents as the link carries them: `host` only where the box's real
 * MagicDNS name is not the one the phone would derive.
 */
export function mobileLinkAgents(
  agents: readonly Pick<AgentView, "name" | "status" | "tailscale_dns_name">[],
  fleetId: string,
  tailnet: string,
): MobileLinkAgent[] {
  return agents
    .filter((a) => a.status !== "destroyed" && !a.name.startsWith("_") && a.name !== FLEET_KEY)
    .map((a) => {
      const derived = `${cloudName(fleetId, a.name)}.${tailnet}`;
      const real = a.tailscale_dns_name?.replace(/\.$/, "") ?? null;
      return real === null || real === "" || real.toLowerCase() === derived.toLowerCase()
        ? { name: a.name }
        : { name: a.name, host: real };
    });
}

export function createMobilePair(deps: MobilePairDeps) {
  const { ctx } = deps;

  async function pair(input: unknown = {}): Promise<MobilePairResult> {
    const { prefs = {} } = parse(MobilePairInput, input ?? {}, "mobile pair");
    const config = ctx.requireConfig();
    await ctx.guardAccount();
    const fleetItem = await ctx.backend.store.fleet.get();
    if (fleetItem === null) {
      throw new HermeticError("FLEET_MISMATCH", `the ${FLEET_KEY} item is missing`, {});
    }
    if (fleetItem.fleet_id !== config.fleet_id) {
      throw new HermeticError(
        "FLEET_MISMATCH",
        `the ${FLEET_KEY} item belongs to a different fleet than this home`,
        { fleet_item: fleetItem.fleet_id, local: config.fleet_id },
      );
    }
    const fleet = {
      fleet_id: config.fleet_id,
      alias: config.name,
      account_id: config.account_id,
      region: config.region,
      tailnet: fleetItem.tailnet,
    };
    const agents = mobileLinkAgents(await deps.listAgents({}), fleet.fleet_id, fleet.tailnet);
    const link = encodeMobileLink({ ...fleet, agents, prefs });
    const carried = parseMobileLink(link);
    if (carried === null) {
      throw new HermeticError("INTERNAL", "the pairing link does not parse back");
    }
    return { link, fleet, agents, agents_in_link: carried.agents.length, prefs: carried.prefs };
  }

  return { pair };
}
