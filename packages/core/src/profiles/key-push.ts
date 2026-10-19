/**
 * §8.1/§8.3: a provider key edited on the laptop reaches every bound box now.
 *
 * Two steps. The key is copied into each bound agent's own slot — the one its
 * running configuration reads, and the one a staged binding will read — and
 * each box is then told to re-read its slots (`POST /secrets/sync`). The poke
 * carries no secret: the box reads its own slots with its instance role and
 * rewrites the managed block of every Hermes `.env`.
 *
 * A box that does not answer is reported, never thrown: the slot already
 * holds the new key, and hermeticd's heartbeat (which watches the slot's SSM
 * version) or its next boot catches up. An older hermeticd without the route
 * answers 404, which reads the same way.
 */

import { isProviderKeySlot } from "../shared/index.ts";
import type { Agent, AgentStatus } from "../schema/index.ts";
import { agentParamPath } from "../backend/constants.ts";
import { HermeticError } from "../errors.ts";
import type { RpcApi } from "../backend/types.ts";
import type { CoreContext } from "../context.ts";

/** Per agent, which boxes took the new key now and which will at their next sync. */
export interface KeyPushResult {
  pushed: string[];
  unreachable: string[];
}

/**
 * The statuses in which copying a key into an agent's own slot means something.
 *
 * `destroyed` and `destroying` are excluded because `destroy` sweeps
 * `/hermes/<fleet_id>/<name>/` (§6.6): a rekey that included them would *re-create* the
 * slot it had just deleted, leaving a live provider key in an account for a box
 * that no longer exists — the exact leak the sweep is there to prevent. Every
 * other status is a box that is running, will run again, or is being fixed, and
 * each of those reads its slot on its next boot (§8.1).
 *
 * `lifecycle.ts` makes the same distinction when it asks who still owns a
 * volume; this is that rule for slots.
 */
export const REKEYABLE_STATUSES: ReadonlySet<AgentStatus> = new Set<AgentStatus>([
  "creating",
  "bootstrapping",
  "ready",
  "degraded",
  "stopping",
  "stopped",
  "error",
]);

/** How many boxes are poked at once: a fleet push stays a few seconds, not one per box. */
const POKE_CONCURRENCY = 8;

/**
 * `POST /secrets/sync` to each named agent, `POKE_CONCURRENCY` at a time. Every
 * failure — no tailnet address yet, a timeout, a 404 from an older hermeticd —
 * lands the name in `unreachable`; nothing here throws.
 */
export async function pokeSecretsSync(
  rpc: RpcApi,
  names: readonly string[],
  signal?: AbortSignal,
): Promise<KeyPushResult> {
  const settled: PromiseSettledResult<unknown>[] = [];
  for (let i = 0; i < names.length; i += POKE_CONCURRENCY) {
    const batch = names.slice(i, i + POKE_CONCURRENCY);
    settled.push(
      ...(await Promise.allSettled(
        batch.map((name) => rpc.secretsSync(name, signal ? { signal } : {})),
      )),
    );
  }
  const result: KeyPushResult = { pushed: [], unreachable: [] };
  settled.forEach((s, i) => {
    (s.status === "fulfilled" ? result.pushed : result.unreachable).push(names[i]!);
  });
  return result;
}

/**
 * Copy a profile's new key into every bound agent's slots, and answer the
 * boxes whose *running* binding reads it — the ones to poke once the caller
 * has released its lock.
 *
 * Both slots a row can name are copied when they belong to this profile: the
 * current one (`credential_ref`) and a staged binding's (`pending.credential_ref`),
 * so no slot of this profile's ever holds the old key. (The apply re-copies the
 * pending slot from the profile's anyway, `profile-apply.ts`.) Only boxes whose
 * current binding changed are returned — a staged binding is not on the box yet.
 */
export async function copyProfileKey(
  ctx: CoreContext,
  profileId: string,
  value: string,
): Promise<string[]> {
  const fleetId = ctx.fleetId();
  const live: string[] = [];
  const agents = (await ctx.scanAgents()).agents.filter((a) => REKEYABLE_STATUSES.has(a.status));
  for (const agent of agents.sort((a, b) => a.name.localeCompare(b.name))) {
    const slots = slotsReading(agent, profileId);
    if (slots.length === 0) continue;
    for (const slot of slots) {
      const path = agentParamPath(fleetId, agent.name, slot);
      try {
        await ctx.backend.secrets.ensureSlot(path);
        await ctx.backend.secrets.put(path, value);
      } catch {
        // The profile's own slot and the settings already moved, so the agents
        // copied so far are on the new key and the rest on the old one. The
        // copy is idempotent: running the same command again finishes it.
        throw new HermeticError(
          "CONFLICT",
          `profile ${profileId}'s new key was written to its own slot, but could not be copied into ${agent.name}'s ${slot}, so ${agent.name} and any agent after it still hold the previous key — run the same command again to finish the copy`,
          { profile: profileId, agent: agent.name, partial_write: slot },
        );
      }
    }
    // The profile and the slots, never the key (§8.3).
    await ctx.appendEvent(
      agent.name,
      "providers.update",
      `provider-key rekeyed from profile ${profileId} into ${slots.join(", ")}`,
    );
    if (slots[0] === agent.credential_ref) live.push(agent.name);
  }
  return live;
}

/** The slots on this row that hold `profileId`'s key: the current binding's, then a staged one's. */
function slotsReading(agent: Agent, profileId: string): string[] {
  const slots: string[] = [];
  const current = agent.credential_ref;
  if (agent.profile_id === profileId && typeof current === "string" && isProviderKeySlot(current)) {
    slots.push(current);
  }
  const pending = agent.pending?.credential_ref;
  if (
    agent.pending?.profile_id === profileId &&
    typeof pending === "string" &&
    isProviderKeySlot(pending) &&
    pending !== current
  ) {
    slots.push(pending);
  }
  return slots;
}
