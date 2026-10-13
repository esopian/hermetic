/**
 * Which Hermes external memory provider a new agent gets, and getting its key
 * onto the box.
 *
 * Its own module rather than more of `create-agent.ts` (core rule 5), and
 * shaped like `profile-binding.ts`'s credential half: a pure resolution, a
 * refusal the create can make before it owns anything, and an idempotent copy
 * from the fleet's shared slot into the agent's own.
 *
 * The choice is made once, at create, and pinned on the row (`Agent.memory`).
 * A later change to `settings.default_memory_provider` moves no existing agent,
 * for the reason `Agent.seed` is pinned: a fleet default re-read at render time
 * would re-hash every agent's configuration the day somebody changed it.
 */
import type { AgentMemory, FleetSettings, MemoryProviderChoice } from "../../schema/index.ts";
import {
  MEMORY_KEY_SLOT,
  MEMORY_PROVIDER_NONE,
  memoryKeySlug,
  memoryProviderNeedsKey,
  type MemoryProvider,
} from "../../shared/memory-providers.ts";
import { HermeticError } from "../../errors.ts";
import type { BindingPorts } from "../../profiles/profile-binding.ts";

/**
 * The provider a create resolves to: what it stated, else the fleet's default,
 * else none. `none` stated overrides a fleet default — the one thing an absent
 * choice cannot say.
 */
export function resolveMemoryProvider(
  choice: MemoryProviderChoice | undefined,
  settings: Pick<FleetSettings, "default_memory_provider">,
): MemoryProvider | null {
  const resolved = choice ?? settings.default_memory_provider ?? null;
  return resolved === MEMORY_PROVIDER_NONE ? null : resolved;
}

/** What the row records for a resolved provider: `null` is built-in memory only. */
export function memoryOf(provider: MemoryProvider | null): AgentMemory | null {
  if (provider === null) return null;
  return { provider, key_ref: memoryProviderNeedsKey(provider) ? MEMORY_KEY_SLOT : null };
}

function missing(provider: MemoryProvider): HermeticError {
  const slug = memoryKeySlug(provider);
  return new HermeticError(
    "MEMORY_KEY_MISSING",
    `memory provider ${provider} needs an API key in the fleet's shared slot ${slug}; run \`hermetic secrets push _fleet --shared ${slug}\` and retry`,
    { provider, slug },
  );
}

async function sharedFilled(ports: BindingPorts, provider: MemoryProvider): Promise<boolean> {
  const source = ports.sharedPath(memoryKeySlug(provider));
  return (await ports.secrets.exists(source)) && !(await ports.secrets.isPlaceholder(source));
}

/**
 * Refuse a keyed provider whose shared slot holds no key, before the create
 * claims the name. A Hermes told to use a provider it has no key for reports
 * the provider unavailable and runs on built-in memory alone — an agent that
 * looks healthy and is not what the operator asked for.
 */
export async function assertMemoryKeyReady(
  ports: BindingPorts,
  provider: MemoryProvider | null,
): Promise<void> {
  if (provider === null || !memoryProviderNeedsKey(provider)) return;
  if (!(await sharedFilled(ports, provider))) throw missing(provider);
}

/**
 * Copy the fleet's shared key into this agent's own slot, on the laptop and
 * with the operator's credentials — the value is a local `const` that goes to
 * SSM and nowhere else (§8.3). Read off the *row's* memory, because a resumed
 * create finishes the agent that exists.
 *
 * Idempotent the way `snapshotCredential` is: every run copies whatever the
 * shared slot holds now. A resume whose shared slot has since been emptied
 * keeps the copy an earlier run made rather than refusing; only an agent slot
 * that was never filled is `MEMORY_KEY_MISSING`.
 *
 * Returns the path (for `resources.ssm_paths`, the row's record of the slots
 * it owns) and whether this run copied into it, or `null` for an agent with no
 * keyed provider. Cleanup does not depend on that record: a rollback and a
 * destroy delete every parameter under the agent's prefix (`rollback.ts`,
 * `destroy-agent.ts`), and `memory-key` lives under it.
 */
export async function snapshotMemoryKey(
  ports: BindingPorts,
  agentName: string,
  memory: AgentMemory | null | undefined,
): Promise<{ path: string; copied: boolean } | null> {
  const ref = memory?.key_ref;
  if (memory === null || memory === undefined || ref === null || ref === undefined) return null;
  const path = ports.agentPath(agentName, ref);
  await ports.secrets.ensureSlot(path);
  if (await sharedFilled(ports, memory.provider)) {
    const value = await ports.secrets.get(ports.sharedPath(memoryKeySlug(memory.provider)));
    await ports.secrets.put(path, value);
    return { path, copied: true };
  }
  if (!(await ports.secrets.isPlaceholder(path))) return { path, copied: false };
  throw missing(memory.provider);
}
