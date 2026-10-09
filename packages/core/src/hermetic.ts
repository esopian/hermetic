/**
 * The SDK surface itself: `createHermetic`, the closure every head talks to.
 *
 * What stays here is the assembly: one `CoreContext` (`context.ts`) built from
 * the shared helpers (`agent-runtime.ts` — the account and fleet guards of
 * §4.7, the TTL locks and their heartbeats of §4.4, the §4.3 status
 * transitions, the agent-manifest render `create`/`recreate`/`apply` all go
 * through per §6.4, the read path the heads paint from per §4.5), handed to
 * every module as one object. The short reads (`list`, `get`, `history`,
 * `config show`) are `reads.ts`.
 *
 * Every long operation that grew its own shape is a module taking
 * `{ ctx, ...its own }` (AGENTS.md rule 5), wired below: `lifecycle.ts`
 * (§6.2/§6.7), `update.ts` (§6.5), `teardown.ts`/`volumes.ts` (§9/§9.1),
 * `foundation/` (§6.6), `init.ts` (§4.7), `plans.ts`, `plan-apply.ts` (§3.2
 * rule 3), `agent-set.ts` (§8.3), `policy.ts` (§5.2), `secrets.ts` (§8.2).
 * The deps object a head hands in is `HermeticDeps` (`hermetic-deps.ts`).
 */
import { randomUUID } from "node:crypto";
import { withFleetLock, findRepoRoot, type ReleasePushResult } from "./release/artifacts.ts";
import { createPublisher } from "./release/publisher.ts";
import { LOCK_TTL_MS } from "./fleet/fleet-lock.ts";
import { gitBuildInfo, type GitBuildInfo } from "./release/git.ts";
import type { ArtifactsPushInput, Plan, PlanRolloutInput } from "./schema/index.ts";
import {
  ArtifactsPushInput as ArtifactsPushInputSchema,
  PlanRolloutInput as PlanRolloutInputSchema,
  runTargetFor,
} from "./schema/index.ts";
import { HEARTBEAT_INTERVAL_MS, UNREACHABLE_INTERVALS } from "./agents/state.ts";
import { probeLocalTailscale, verifyTailscaleOauthClient } from "./fleet/preflight.ts";
import { createInit } from "./fleet/init.ts";
import { pushAndPublish } from "./fleet/init-release.ts";
import { runDoctor, type DoctorReport } from "./fleet/doctor.ts";
import { createPlans } from "./agents/plans.ts";
import { createPolicy } from "./fleet/policy.ts";
import { createNetwork } from "./fleet/network.ts";
import { createTeardown } from "./fleet/teardown.ts";
import { createLifecycle } from "./agents/lifecycle.ts";
import { createRollout } from "./agents/rollout.ts";
import { createUpdate } from "./agents/update.ts";
import { createProfileApply } from "./profiles/profile-apply.ts";
import { createAgentRuntime } from "./agents/agent-runtime.ts";
import { createAgentSet } from "./agents/agent-set.ts";
import { createReads } from "./reads.ts";
import { createApply } from "./agents/plan-apply.ts";
import { BUILD_VERSIONS } from "./build-versions.ts";
import { createSettings } from "./profiles/settings.ts";
import { createProviderProfiles } from "./profiles/provider-profiles.ts";
import { createFleets } from "./fleet/fleets.ts";
import { createAgentLogs } from "./agents/agent-logs.ts";
import { MemoryInstanceListeningStore } from "./chat/instance-listening.ts";
import { MemoryLocalChatSessions, createChat, defaultHermesChat } from "./chat/chat.ts";
import { MemoryChatFenceStore } from "./chat/chat-fence.ts";
import { createBotMode } from "./chat/bot-mode.ts";
import {
  MemoryNotificationStore,
  createNotifications,
  type NotificationDeps,
} from "./chat/notifications.ts";
import { bwsPath, createSecrets, providerKeyPath, tsKeyPath } from "./profiles/secrets.ts";
import { createVolumes } from "./volumes/volumes.ts";
import { createDesktop } from "./agents/desktop.ts";
import { createVolumeReservation } from "./volumes/volume-claims.ts";
import { createProbe } from "./agents/probe.ts";
import { createFoundation } from "./fleet/foundation/index.ts";
import { createFixtureChatStack } from "./backend/fixture/fixture-chat-stack.ts";
import { FOUNDATION_VERSION } from "./version.ts";
import { foundationTemplateSha256 } from "./aws/cfn-template.ts";
import type { FetchLike } from "./aws/tailscale.ts";
import { agentParamPath, sharedSecretPath } from "./backend/constants.ts";
import type { CoreContext } from "./context.ts";
import { MemoryPresetStore, createPresets } from "./local/create-presets.ts";
import { createLocalAgentPurge } from "./local/purge-agent.ts";
import { MemoryIncarnationStore, createIncarnationReconciler } from "./local/incarnations.ts";
import type { HermeticDeps } from "./hermetic-deps.ts";

/**
 * The surface declaration lives in its own module (`surface.ts`), and is
 * re-exported here so that `PUBLIC_METHODS` and the schema tables stay
 * importable from the module the parity contract has always named.
 */
export * from "./surface.ts";

/**
 * The deps contract and the local stores it carries (`hermetic-deps.ts`),
 * the doctor's and the secret surface's result shapes, `TransitionFacts` and
 * `BUILD_VERSIONS`: each lives with the module that produces it, and each is
 * re-exported here because every importer still names it through this door.
 */
export type {
  ConfigStore,
  HermeticDeps,
  InitSupport,
  OpOptions,
  RunStore,
  TeardownStore,
  UpgradeTarget,
} from "./hermetic-deps.ts";
export type { DoctorReport, DoctorDeps } from "./fleet/doctor.ts";
export type {
  SecretsDeleteResult,
  SecretsListResult,
  SecretsPushResult,
  SecretsVerifyReport,
  SharedSecretView,
} from "./profiles/secrets.ts";
export type { TransitionFacts } from "./agents/agent-runtime.ts";
export { BUILD_VERSIONS } from "./build-versions.ts";

export type Hermetic = ReturnType<typeof createHermetic>;

const DEFAULT_HERMETICD_VERSION = BUILD_VERSIONS.hermeticd;
const DEFAULT_HERMES_VERSION = BUILD_VERSIONS.hermes;

/**
 * The whole SDK. Head-agnostic: no `console.*`, no `process.exit`, no prompts —
 * typed results and `HermeticError` only (§3.2 rule 1). Every cloud side-effect
 * goes through `deps.backend`, so the same code runs against AWS or against the
 * in-memory fixture backend.
 */
export function createHermetic(deps: HermeticDeps) {
  const { backend } = deps;
  const fixture = deps.fixture ?? false;
  const hermeticdVersion = deps.hermeticdVersion ?? DEFAULT_HERMETICD_VERSION;
  const hermesVersion = deps.hermesVersion ?? DEFAULT_HERMES_VERSION;
  const localTailscale = deps.localTailscale ?? (() => probeLocalTailscale());
  /**
   * Absent means "this process cannot say which build it is", which reads as no
   * warning at all — never as agreement. `open.ts` wires the real one in real
   * mode; fixture mode and tests keep the null.
   */
  const localBuild = deps.localBuild ?? (() => null);
  const verifyTailscaleOauth =
    deps.verifyTailscaleOauth ?? ((s: string) => verifyTailscaleOauthClient(s));
  /** §3.6: this build's mirrors and release publisher (`release/publisher.ts`). */
  const { hermesMirror, publishDeps } = createPublisher(deps, { backend, fixture, hermeticdVersion });

  /**
   * §4.9: the operator's inbox. It is handed a store and the fleet
   * this instance was opened as, and nothing else — no backend, no guard —
   * which is what makes `hermetic inbox` answerable while the fleet is down.
   */
  const instanceListening = deps.instanceListening ?? new MemoryInstanceListeningStore();
  const notificationDeps: NotificationDeps = {
    instances: () => instanceListening.list(deps.config?.fleet_id ?? null),
    store: deps.notifications ?? new MemoryNotificationStore(),
    // Not `fleetId()`: an instance with no frozen config still has an inbox,
    // and `requireConfig()` would turn reading it into NOT_INITIALIZED.
    fleet: () => deps.config?.fleet_id ?? null,
  };
  const notifications = createNotifications(notificationDeps);
  /**
   * §4.6's create presets: this laptop's machine bundles, in its own `prefs`
   * row. No backend and no guard, like the inbox.
   */
  const presets = createPresets({ store: deps.presets ?? new MemoryPresetStore() });

  /**
   * The helpers every module below shares — guards, locks, transitions, the
   * render — built once (`agent-runtime.ts`) and handed out as one context.
   */
  const runtime = createAgentRuntime({
    backend,
    config: deps.config,
    actor: deps.actor,
    attach: deps.attach,
    handoff: deps.handoff,
  });
  const ctx: CoreContext = {
    ...runtime,
    scanAgents: runtime.scanAgentsAllowingMissingTable,
    backend,
    config: deps.config,
    fixture,
    hermeticdVersion,
    hermesVersion,
    localBuild,
    notifications: notificationDeps,
    publishDeps,
  };
  const {
    nowIso,
    requireConfig,
    actor,
    guardAccount,
    guardFleet,
    getAgent,
    scanAgents,
    renderFor,
    fleetId,
  } = ctx;

  // ─── §8.3 profiles, and the per-agent lifecycle ────────────────────────────

  const { bindingPorts, applyPending, settingsForView } = createProfileApply({ ctx });

  /**
   * §9.1's volume reservation, built once and shared by the two operations that
   * compete for a disk nothing owns yet: `agent create --volume` and
   * `volume delete`. One reservation rather than one each — two guards keyed
   * differently would not see each other, which is the whole failure they
   * exist to prevent (`volume-claims.ts`).
   */
  const volumeClaims = createVolumeReservation({
    claims: backend.store.volumeClaims,
    now: () => backend.clock.now(),
    ttlMs: LOCK_TTL_MS,
  });

  // Shared with the roster read below and, for the purge, with §6.7's release.
  const localSessions = deps.localSessions ?? new MemoryLocalChatSessions();
  const chatFence = deps.chatFence ?? new MemoryChatFenceStore();
  const incarnations = deps.incarnations ?? new MemoryIncarnationStore();
  const purgeDeps = {
    notifications: notificationDeps.store,
    instanceListening,
    localSessions,
    chatFence,
  };
  const purgeLocalAgent = createLocalAgentPurge({ ...purgeDeps, incarnations });
  /**
   * §6.7: the other half of the purge. The release purges this laptop's state
   * for the name it frees; a laptop that did not run it purges when a read
   * hands it a row with a different `created_at` than the one it recorded
   * (`local/incarnations.ts`). Called by the fleet list and by chat's row reads.
   *
   * Its purge leaves the incarnation record alone. The reconciler claims the
   * new `created_at` *before* purging, and owns the record through
   * compare-and-set alone; the release's purge forgetting it unconditionally
   * would drop that claim the moment it was won, leaving the name unrecorded
   * for a concurrent scan to adopt its own, possibly older, value.
   */
  const reconcileIncarnations = createIncarnationReconciler({
    store: incarnations,
    fleet: () => deps.config?.fleet_id ?? null,
    purge: createLocalAgentPurge(purgeDeps),
    // A row the scan skipped as unparseable is not a released name (§6.7).
    unparseable: () => backend.store.agents.unparseable?.() ?? [],
  });

  const { create, destroy, stop, start, recreate } = createLifecycle({
    ctx,
    volumeClaims,
    applyPending,
    purgeLocal: purgeLocalAgent,
    tsKeyPath: (name) => tsKeyPath(fleetId(), name),
    providerKeyPath: (name) => providerKeyPath(fleetId(), name),
    agentSlotPath: (name, slot) => agentParamPath(fleetId(), name, slot),
    sharedSlotPath: (slug) => sharedSecretPath(fleetId(), slug),
    bwsPath: (name) => bwsPath(fleetId(), name),
  });

  /**
   * §6.5's converge. It is given the same `ensureConfig` every other writer of
   * a config bundle uses (through `ctx`), so a rollout cannot render by a second
   * route with a second idea of what an agent's configuration is.
   */
  const rollout = createRollout({
    ctx,
    applyPending,
    ...(deps.rollout?.convergeTimeoutMs === undefined
      ? {}
      : { convergeTimeoutMs: deps.rollout.convergeTimeoutMs }),
    ...(deps.rollout?.convergePollMs === undefined
      ? {}
      : { convergePollMs: deps.rollout.convergePollMs }),
  });

  /**
   * `plan.rollout` needs the hash each agent *would* get, without uploading
   * anything — a plan is a question. `renderFor` is pure, so asking it is free
   * and leaves no object in the bucket for a rollout the operator declines.
   */
  async function planRollout(input: PlanRolloutInput): Promise<Plan> {
    const parsed = PlanRolloutInputSchema.parse(input);
    await guardAccount();
    const config = requireConfig();
    return await rollout.plan(
      parsed,
      (agent, fleet) => renderFor(agent, fleet.region, fleet.tailnet).config_hash,
      {
        account_id: config.account_id,
        region: config.region,
        fleet_id: config.fleet_id,
        stack_id: null,
      },
    );
  }

  const { rerun, reboot, upgrade } = createUpdate({
    ctx,
    hermesRef: BUILD_VERSIONS.hermes_ref,
    hermesMirror,
  });
  const { settingsGet, settingsSet } = createSettings({ ctx });

  /**
   * §8.3's provider profiles. The catalog transport is injected here and
   * nowhere else: `fetch` defaults to the platform's, like `agents.probe`'s, and
   * Bedrock's two `List*` calls come from whichever backend can make them —
   * `MemoryBackend` cannot, so fixture mode hands in a canned catalog instead
   * and never constructs a client (§3.2).
   */
  const profiles = createProviderProfiles({
    ctx,
    catalog: {
      ...(deps.modelCatalog?.fetch !== undefined
        ? { fetch: deps.modelCatalog.fetch }
        : { fetch: ((input, init) => fetch(input, init)) as FetchLike }),
      timeoutMs: deps.modelCatalog?.timeoutMs,
      ...(deps.modelCatalog?.bedrock !== undefined
        ? { bedrock: deps.modelCatalog.bedrock }
        : backend.bedrock !== undefined
          ? { bedrock: (signal: AbortSignal) => backend.bedrock!.catalog(signal) }
          : {}),
    },
  });

  // ─── init / teardown / doctor / secrets ────────────────────────────────────

  const { teardown } = createTeardown({
    ctx,
    configStore: deps.configStore,
    teardowns: deps.teardowns,
    stackWaitProgressMs: deps.stackWaitProgressMs,
  });

  /** The command that earns trust: reconcile three sources and report where they disagree (§9). */
  async function doctor(): Promise<DoctorReport> {
    return runDoctor({
      backend,
      config: requireConfig(),
      scanAgents,
      // The same §4.7 probe `init` runs: `agents.create` does not check the
      // tailnet, so `doctor` is where an initialised fleet learns MagicDNS or
      // HTTPS Certificates got turned off.
      localTailscale,
      // The §4.7 policy read and §5's network mode, from the modules `hermetic
      // policy` and `hermetic network` use: a fleet whose blocks or mode have
      // drifted has nowhere else to be told.
      policyStatus: policy.status,
      networkStatus: network.status,
      available: {
        foundationVersion: FOUNDATION_VERSION,
        templateSha256: foundationTemplateSha256(),
        hermeticdVersion,
      },
    });
  }

  const { secretsPush, secretsVerify, secretsList, secretsDelete } = createSecrets({
    ctx,
    verifyTailscaleOauth,
  });

  // ─── plan / apply ──────────────────────────────────────────────────────────

  /**
   * §6.6 `foundation.*`, §4.7's tailnet policy and §5's network mode. `policy`
   * and `network` take `guardAccount` where the rest take `guardFleet` (through
   * `ctx`): reading the tailnet policy is about Tailscale, and refusing it
   * because the CloudFormation stack is mid-update would withhold the one thing
   * that makes the fleet reachable.
   */
  const foundation = createFoundation({
    ctx,
    ...(deps.git !== undefined
      ? { git: deps.git }
      : // The checkout the release would be built from, not the shell's.
        { git: (): GitBuildInfo | null => gitBuildInfo({ cwd: findRepoRoot() }) }),
    ...(deps.foundation ?? {}),
  });
  const plans = createPlans({ ctx });
  const policy = createPolicy({ ctx });
  const network = createNetwork({
    ctx,
    archiveDir: deps.foundation?.archiveDir,
    archiveLocalDb: deps.foundation?.archiveLocalDb,
    changeSetPollMs: deps.foundation?.changeSetPollMs,
    changeSetTimeoutMs: deps.foundation?.changeSetTimeoutMs,
    heartbeatMs: deps.foundation?.heartbeatMs,
  });

  /**
   * Execute a plan produced by `plan.*` (`plan-apply.ts`). Core never asks "are
   * you sure" (§3.2 rule 3) — it insists the head did, and it reads the plan's
   * typed `options` rather than parsing its human-readable steps back.
   */
  const { apply } = createApply({
    ctx,
    plans,
    destroy,
    recreate,
    foundation,
    policy,
    network,
    rollout,
    teardown,
  });

  // ─── reads (`reads.ts`) ────────────────────────────────────────────────────

  const { list, get, history, destroyed, configShow, runsList, teardownsList } = createReads({
    ctx,
    settingsForView,
    reconcileIncarnations,
    configStore: deps.configStore,
    runs: deps.runs,
    teardowns: deps.teardowns,
  });
  const { set } = createAgentSet({ ctx, bindingPorts });

  /**
   * §9 `artifacts push`: publish a release and point the fleet at it. Both
   * halves, always — a release nothing names is invisible, and a manifest
   * naming a release that is not there boots nothing. Held under the `_fleet`
   * lock for the upload as well as the pointer move, for the reason
   * `pointFleetAt` holds it: a release uploaded inside a `foundation.update`'s
   * prune window is deleted out from under the boxes now fetching it.
   */
  async function artifactsPush(input: ArtifactsPushInput = {}): Promise<ReleasePushResult> {
    // The stack the guard just validated, rather than a second read of it: a
    // `DescribeStacks` answering `null` here would land in `resources` as blanks.
    const { fleet, stack } = await guardFleet();
    const parsed = ArtifactsPushInputSchema.parse(input);
    const owner = `${await actor()}#${randomUUID()}`;
    const now = () => backend.clock.now();
    return withFleetLock(backend.store.fleet, { fleet, owner, ttlMs: LOCK_TTL_MS, now }, (locked) =>
      pushAndPublish(ctx, parsed, locked, stack),
    );
  }

  /**
   * `init` (`init.ts`) is the call that first learns the caller's ARN, which it
   * writes back through `ctx.setActor`. The two §4.7 probes are explicit here
   * and never context defaults (rule 6).
   */
  const initWithHelpers = createInit({
    ctx,
    configStore: deps.configStore,
    initSupport: deps.initSupport,
    actor: deps.actor,
    heartbeatMs: deps.stackWaitProgressMs,
    localTailscale,
    verifyTailscaleOauth,
  });

  const volumes = createVolumes({ ctx, reservation: volumeClaims });
  const agentLogs = createAgentLogs({ ctx });

  // ─── chat, Bot Mode and Desktop share one adapter; fixture's is a stack (0014 §7) ──

  const fixtureChat = createFixtureChatStack(fixture, deps.fixtureChat ?? {});
  const hermesChat = fixtureChat.hermes ?? defaultHermesChat(nowIso);
  const botMode = createBotMode({ guardFleet, getAgent, instanceListening, hermes: hermesChat });
  const chat = createChat({
    instanceListening,
    fleet: () => deps.config?.fleet_id ?? null,
    guardFleet,
    // Chat reads rows without the fleet list, and its sessions, fence and
    // opt-ins are most of what a reused name would carry over (§6.7).
    getAgent: async (name) => {
      const agent = await getAgent(name);
      await reconcileIncarnations([agent], { complete: false });
      return agent;
    },
    listAgents: async () => {
      const rows = await backend.store.agents.scan();
      await reconcileIncarnations(rows, { complete: true });
      return rows;
    },
    hermes: hermesChat,
    // §4.9: the roster read raises `chat.message`, a failed turn
    // raises `chat.error`. Core owns the row and its wording; no head is involved.
    notifications: notificationDeps,
    now: nowIso,
    localSessions,
    chatFence,
  });
  const desktop = createDesktop({ guardFleet, getAgent, hermes: hermesChat });

  /**
   * §4.8's three methods need only the backend's directory, the local `fleets`
   * table and this build's foundation version — none of the context.
   */
  const fleets = createFleets({
    backend,
    config: deps.config,
    configStore: deps.configStore,
    foundationVersion: FOUNDATION_VERSION,
  });

  /**
   * The §9 active liveness check. `tailnet` is a closure rather than a value
   * because it lives on the `_fleet` item, not in the frozen local config — and
   * it swallows its own failures: a fleet item this caller cannot read makes
   * the dashboard layer `skip`, not the probe throw. The probe builds the URL
   * itself, from the row, so a node that came up as `<name>-2` is probed where
   * it actually answers.
   */
  const probes = createProbe({
    ctx,
    ...(deps.probe?.fetch !== undefined
      ? { fetch: deps.probe.fetch }
      : { fetch: ((input, init) => fetch(input, init)) as FetchLike }),
    timeoutMs: deps.probe?.timeoutMs,
    tailnet: async () => {
      try {
        const fleet = await backend.store.fleet.get();
        return {
          tailnet: fleet?.tailnet ?? null,
          fleet_id: fleet?.fleet_id ?? null,
          fleet_name: fleet?.fleet_name ?? null,
        };
      } catch {
        return { tailnet: null, fleet_id: null, fleet_name: null };
      }
    },
  });

  return {
    ...botMode,
    init: initWithHelpers,
    config: { show: configShow },
    /**
     * §4.8: the account's fleets, which one this laptop means by default, and
     * the one write that changes what a fleet is called. Every method here
     * speaks `fleet_id`; the display alias is input and output, never a key
     * (§4.6).
     */
    fleets: { list: fleets.list, use: fleets.use, alias: fleets.alias },
    directory: { status: fleets.status },
    runs: { list: runsList },
    teardowns: { list: teardownsList },
    /**
     * §4.9: the operator's inbox. Local to this laptop, so two people
     * watching one fleet keep their own unread marks and their own mutes.
     */
    notifications,
    /** §4.6: the create presets this laptop offers. Local, like the inbox. */
    presets: { get: presets.get, set: presets.set },
    artifacts: { push: artifactsPush },
    teardown,
    doctor,
    agents: {
      create,
      list,
      get,
      set,
      stop,
      start,
      recreate,
      destroy,
      history,
      /** §6.7: the tombstones a destroy leaves, plus legacy `destroyed` rows. */
      destroyed,
      rerun,
      reboot,
      probe: probes.probe,
      desktop: desktop.attach,
    },
    volumes: { list: volumes.list, get: volumes.get, delete: volumes.delete },
    secrets: {
      push: secretsPush,
      verify: secretsVerify,
      list: secretsList,
      delete: secretsDelete,
    },
    /** The fleet's shared settings (§4.6). */
    settings: { get: settingsGet, set: settingsSet },
    /**
     * §8.3: the named profiles an agent is created against, and the live model
     * catalog the picker that chooses one is filled from.
     */
    providers: {
      list: profiles.providersList,
      create: profiles.providersCreate,
      update: profiles.providersUpdate,
      delete: profiles.providersDelete,
      models: profiles.providersModels,
    },
    /**
     * §9.2: the fleet's bots, their conversations and the turns taken
     * with them. A turn is not an op and is never registered as one.
     */
    chat,
    ssh: agentLogs.ssh,
    logs: agentLogs.logs,
    upgrade,
    foundation: { status: foundation.status, update: foundation.update },
    policy: { status: policy.status },
    /** §5: which side of a NAT this fleet's agents live on, and whether reality agrees. */
    network: { status: network.status },
    plan: {
      destroy: plans.destroy,
      recreate: plans.recreate,
      teardown: plans.teardown,
      foundation: foundation.plan,
      policy: policy.plan,
      rollout: planRollout,
      network: network.plan,
    },
    apply,
    /**
     * What this instance resolved to talk to (§4.6): the immutable
     * `account_id`/`region`/`fleet_id` triple, plus the display alias that
     * fleet answered to when the instance opened. `null` before `init`, where
     * there is nothing frozen to name.
     *
     * A value rather than a method, and deliberately not a `PUBLIC_METHODS`
     * entry: it adds nothing to the command surface, it reaches neither AWS nor
     * disk, and every head already had to know it. What it exists for is the
     * run log — the row a head opens before core is open cannot say which fleet
     * an alias or a persisted default meant, so it reads this the moment it can
     * and stamps the row (`RunRecorder.annotate`).
     */
    target: deps.config === null ? null : runTargetFor(deps.config),
    /** Fixture-mode chat staging (§9.2). `null` outside fixture mode, and that is the guard. */
    fixture: fixtureChat.controls,
    /** Derived-state constants the heads render against. */
    constants: { HEARTBEAT_INTERVAL_MS, UNREACHABLE_INTERVALS },
  };
}
