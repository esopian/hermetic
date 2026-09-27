/**
 * The one context every long-operation module shares.
 *
 * Before this existed each module spelled out the same nine helpers — the
 * fleet guard, the actor, the clock, the event append, the TTL lock's four
 * verbs, the status transition — in its own `*Deps` interface, and
 * `hermetic.ts` re-spelled them into every `create*({...})` call. The list
 * was honest about coupling but said the same thing thirty times. Here it is
 * said once: a module's deps object is `{ ctx: CoreContext }` plus the two to
 * six things that are genuinely its own (a clock override for a test, a policy
 * hook, an injected `fetch`).
 *
 * It is a plain typed object, built once in `createHermetic` from
 * `createAgentRuntime`'s helpers and the few cross-cutting values (`backend`,
 * the pinned versions, the inbox, the release publisher) that three or more
 * modules read. Not a container and not a locator: nothing is looked up by
 * name, nothing is registered, and a test builds one with `testContext`
 * (`packages/core/test/helpers.ts`) or by hand.
 *
 * What is deliberately *not* here, for AGENTS.md rule 6: the §4.7 Tailscale
 * probes (`localTailscale`, `verifyTailscaleOauth`), the Hermes mirror and
 * every other "real by default" gate. Those stay explicit deps of the module
 * that runs them, so an absent dependency is a type error rather than a gate
 * that silently switched itself off.
 *
 * Pure helpers — `evt`, `checkAbort`, `validateName`, `abortableSleep`,
 * `describePending`, `LOCK_TTL_MS` — are not here either: they are imported by
 * the module that uses them. A deterministic function with no state is not a
 * dependency, and `events.ts` records why threading one through deps objects
 * was only ever an inconsistency.
 */
import type { AgentRuntime } from "./agents/agent-runtime.ts";
import type { NotificationDeps } from "./chat/notifications.ts";
import type { PublishDeps } from "./release/artifacts.ts";
import type { Backend } from "./backend/types.ts";
import type { LocalConfig } from "./schema/index.ts";

export interface CoreContext {
  backend: Backend;
  /** `null` before `init`; `requireConfig` is the typed way to insist on one. */
  config: LocalConfig | null;
  /** `true` only for the in-memory backend (`HermeticDeps.fixture`). */
  fixture: boolean;
  /** Resolved from `HermeticDeps` or `BUILD_VERSIONS`; never undefined here. */
  hermeticdVersion: string;
  hermesVersion: string;
  /**
   * Which build of `hermeticd` this process would push, or `null` when it
   * cannot say (`artifacts.ts`'s `localBuild`). Compared against the fleet's
   * release so a create, rerun or foundation plan warns before a box fails a
   * stage on the drift.
   */
  localBuild: () => string | null;

  /* clock and identity */
  nowIso: AgentRuntime["nowIso"];
  actor: AgentRuntime["actor"];
  /** `init` is the call that first learns the caller's ARN; this is how it says so. */
  setActor: AgentRuntime["setActor"];

  /* guards (§4.7) */
  requireConfig: AgentRuntime["requireConfig"];
  guardAccount: AgentRuntime["guardAccount"];
  guardFleet: AgentRuntime["guardFleet"];
  assertFleetUnlocked: AgentRuntime["assertFleetUnlocked"];
  assertSealed: AgentRuntime["assertSealed"];

  /* the agent row and its history (§4.3, §4.5) */
  getAgent: AgentRuntime["getAgent"];
  view: AgentRuntime["view"];
  /** Every row, or an empty scan when the table itself is gone (teardown, doctor). */
  scanAgents: AgentRuntime["scanAgentsAllowingMissingTable"];
  appendEvent: AgentRuntime["appendEvent"];
  transition: AgentRuntime["transition"];
  isHandedOff: AgentRuntime["isHandedOff"];

  /* the TTL lock (§4.4) */
  lockHeldByOther: AgentRuntime["lockHeldByOther"];
  acquireLock: AgentRuntime["acquireLock"];
  renewLock: AgentRuntime["renewLock"];
  releaseLock: AgentRuntime["releaseLock"];
  lockKeeper: AgentRuntime["lockKeeper"];
  unwind: AgentRuntime["unwind"];

  /* the render every config bundle goes through (§6.4) */
  renderFor: AgentRuntime["renderFor"];
  ensureConfig: AgentRuntime["ensureConfig"];
  assertCanApply: AgentRuntime["assertCanApply"];
  assertReleaseCanApply: AgentRuntime["assertReleaseCanApply"];

  /* SSM and bucket prefixes (§8) */
  fleetId: AgentRuntime["fleetId"];
  agentPrefix: AgentRuntime["agentPrefix"];
  configPrefix: AgentRuntime["configPrefix"];

  /* the two standalone waits, with their cadence already bound */
  attachDeps: AgentRuntime["attachDeps"];
  handoffDeps: AgentRuntime["handoffDeps"];

  /**
   * The operator's inbox (§4.9): the store, the fleet it is scoped to and the instances
   * being listened to. Core owns every row's wording, so the modules that
   * raise one (`foundation`, `volumes`, `chat`, the list read) take it here.
   */
  notifications: NotificationDeps;
  /**
   * §3.6: what `publishRelease` needs, built per call so it reads the current
   * mirrors and the current `hermeticd` path. `foundation`, `network` and
   * `init` all publish through it.
   */
  publishDeps: () => PublishDeps;
}
