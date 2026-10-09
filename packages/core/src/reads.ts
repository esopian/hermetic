/**
 * The reads that used to live in `hermetic.ts` itself — short enough to have
 * stayed until the assembly hit its size cap (AGENTS.md rule 5): the agent
 * list and row views the heads paint from (§4.5), an agent's history, the
 * frozen config with what only the fleet knows about it (§4.6), and the two
 * local tables (`runs`, `teardowns`) core takes as stores so no SQLite call
 * appears in the lifecycle path.
 */
import type {
  Agent,
  AgentEvent,
  AgentTombstone,
  AgentView,
  FleetSettings,
  HistoryInput,
  ListAgentsInput,
  ListDestroyedInput,
  LocalConfig,
  Run,
  RunsListInput,
  TeardownReceipt,
  TeardownsListInput,
} from "./schema/index.ts";
import { FLEET_KEY, TeardownsListInput as TeardownsListInputSchema } from "./schema/index.ts";
import { validateName } from "./shared/naming.ts";
import {
  ADVISORY_PROFILE_REVISION,
  observeAdvisories,
  observeHealth,
  profileRevisionAdvisories,
} from "./chat/notifications.ts";
import type { CoreContext } from "./context.ts";
import type { ConfigStore, RunStore, TeardownStore } from "./hermetic-deps.ts";
import type { ReconcileIncarnations } from "./local/incarnations.ts";
import { legacyDestruction } from "./agents/lifecycle/release-name.ts";

export interface ReadsDeps {
  ctx: CoreContext;
  /** `profile-apply.ts`'s soft settings read, for the `update_available` annotation (§8.3). */
  settingsForView: () => Promise<FleetSettings | undefined>;
  configStore?: ConfigStore | undefined;
  runs?: RunStore | undefined;
  teardowns?: TeardownStore | undefined;
  /** `local/incarnations.ts`: purge a reused name's stale local state (§6.7). Never throws. */
  reconcileIncarnations?: ReconcileIncarnations | undefined;
}

export function createReads(deps: ReadsDeps) {
  const {
    backend,
    guardAccount,
    requireConfig,
    getAgent,
    view,
    notifications: notificationDeps,
  } = deps.ctx;
  const { settingsForView } = deps;

  async function list(input: ListAgentsInput = {}): Promise<AgentView[]> {
    await guardAccount();
    // §6.7: a destroy now deletes the row, so a `destroyed` row is a legacy
    // one from before tombstones existed. It is history, not fleet — it lives
    // in `agents.destroyed` with the rest of the dead, never in `ps`.
    const rows = (await backend.store.agents.scan()).filter((a) => a.status !== "destroyed");
    // Before `observeHealth`: a reused name's old watermark must be gone before
    // the new box's status is diffed against it (§6.7, `local/incarnations.ts`).
    await deps.reconcileIncarnations?.(rows, { complete: true });
    const settings = await settingsForView();
    const views = rows.map((a) => view(a, settings)).sort((a, b) => (a.name < b.name ? -1 : 1));
    /**
     * §4.9: the fleet scan is where a health transition is visible,
     * and core's scan is stateless — so the last status seen per agent lives in
     * the local store and is diffed here, before `input.status` narrows the
     * list. Filtering first would make `agent ps --status ready` silently
     * forget every agent that was not ready, and the next scan would then
     * report a transition out of a status nothing had recorded.
     *
     * It cannot throw (`observeHealth` swallows), so a broken inbox cannot be
     * what fails a list.
     */
    observeHealth(notificationDeps, views);
    /**
     * §4.9: the same scan carries the per-agent half of the
     * advisories — a profile whose revision has moved since the agent was
     * pinned to it. Reconciled here, against the *whole* list, for the reason
     * the health diff is: a filtered scan would resolve advisories for agents
     * it simply did not look at.
     */
    observeAdvisories(
      notificationDeps,
      ADVISORY_PROFILE_REVISION,
      profileRevisionAdvisories(views, settings),
    );
    return input.status ? views.filter((a) => a.display_status === input.status) : views;
  }

  // Deliberately unfiltered: `agent show <name>` on a legacy `destroyed` row
  // still answers with it, so the record is reachable by name until the next
  // destroy or create of that name releases it (§6.7).
  async function get(name: string): Promise<AgentView> {
    validateName(name);
    await guardAccount();
    const agent = await getAgent(name);
    return view(agent, await settingsForView());
  }

  async function history(input: HistoryInput): Promise<AgentEvent[]> {
    // `_fleet` is a name the store writes events under (`secrets push _fleet`,
    // `upgrade`) but never an agent name, so it is admitted here and refused by
    // `validateName` everywhere an agent is meant.
    if (input.name !== FLEET_KEY) validateName(input.name);
    await guardAccount();
    if (input.since === undefined && input.until === undefined) {
      return backend.store.events.query(input.name, input.limit);
    }
    // §6.7: one incarnation's window, inclusive at both ends. The store keys
    // events by name alone, so the window is applied here — over the whole
    // log, with `limit` after it, or a limit that landed on the newer life
    // would hide every event of the older one.
    const { since, until } = input;
    const inWindow = (await backend.store.events.query(input.name)).filter(
      (e) =>
        (since === undefined || e.timestamp >= since) && (until === undefined || e.timestamp <= until),
    );
    return input.limit === undefined ? inWindow : inWindow.slice(0, input.limit);
  }

  /**
   * §6.7: every agent this fleet has destroyed, newest first. Two sources,
   * one shape: the `_destroyed` partition a destroy now writes, and the
   * legacy `destroyed` rows a fleet kept before tombstones existed — the
   * latter synthesised here (`legacy: true`) rather than migrated, and
   * converging on their own as each name is destroyed or created again.
   *
   * The name filter and `limit` apply after the merge, so a legacy row can
   * never be pushed out of a page by the store's own cap.
   */
  async function destroyed(input: ListDestroyedInput = {}): Promise<AgentTombstone[]> {
    if (input.name !== undefined) validateName(input.name);
    await guardAccount();
    const fleetId = requireConfig().fleet_id;
    const [tombstones, rows] = await Promise.all([
      backend.store.events.queryTombstones(input.name === undefined ? {} : { name: input.name }),
      backend.store.agents.scan(),
    ]);
    const legacy = await Promise.all(
      rows
        .filter((a) => a.status === "destroyed" && (input.name === undefined || a.name === input.name))
        .map((a) => legacyTombstone(a, fleetId)),
    );
    const merged = [...tombstones, ...legacy].sort((a, b) =>
      a.destroyed_at < b.destroyed_at ? 1 : a.destroyed_at > b.destroyed_at ? -1 : 0,
    );
    return input.limit === undefined ? merged : merged.slice(0, input.limit);
  }

  /**
   * A pre-tombstone `destroyed` row read as the record a destroy writes now.
   * When and by whom it was destroyed come from the name's history
   * (`legacyDestruction`, shared with the release, so the tombstone a later
   * release writes tells the same story). Nothing on the row says whether the
   * volume was kept, so a `volume_id` it still names is read as kept — the old
   * destroy cleared the field when it deleted the disk.
   */
  async function legacyTombstone(a: Agent, fleetId: string): Promise<AgentTombstone> {
    const destruction = legacyDestruction(a, await backend.store.events.query(a.name));
    return {
      name: a.name,
      fleet_id: fleetId,
      created_at: a.created_at,
      created_by: a.created_by,
      destroyed_at: destruction.at,
      destroyed_by: destruction.by,
      size: a.size,
      region: a.region,
      provider: a.provider,
      profile_id: a.profile_id ?? null,
      instance_id: a.instance_id ?? null,
      volume_id: a.volume_id ?? null,
      volume_kept: Boolean(a.volume_id),
      hermes_version: a.hermes_version,
      legacy: true,
    };
  }

  /**
   * The frozen row plus the two things only the fleet knows: which stack this
   * home is attached to, and which tailnet its agents live on (§4.6, §6.4).
   */
  async function configShow(): Promise<
    LocalConfig & {
      stack_id: string | null;
      tailnet: string | null;
      tailscale_oauth_client_id: string | null;
      /**
       * Legacy cloud-name provenance (§6.1): the name `_fleet` recorded when
       * this fleet's v3 nodes were built, which is what their hostnames were
       * spelled from. It is *not* the fleet's display alias — `name` above is
       * that, and an alias edit must never touch this, or `legacyCloudNames`
       * would stop recognising those nodes and start calling them another
       * fleet's. `null` is a fleet created before v3, which was never given one.
       */
      fleet_name: string | null;
      /** Whether this is the fleet a bare command means on this laptop (§4.8). */
      default: boolean;
    }
  > {
    const config = requireConfig();
    await guardAccount();
    const stack = await backend.foundation.describeStack();
    const fleet = await backend.store.fleet.get();
    const preferred = deps.configStore?.defaultFleet ? await deps.configStore.defaultFleet() : null;
    return {
      ...config,
      stack_id: stack?.stack_id ?? null,
      tailnet: fleet?.tailnet ?? null,
      // Which OAuth client the fleet mints from; the secret itself never leaves SSM.
      tailscale_oauth_client_id: fleet?.tailscale_oauth_client_id ?? null,
      fleet_name: fleet?.fleet_name ?? null,
      default: preferred === config.fleet_id,
    };
  }

  /**
   * §4.6: the local command log and the permanent teardown record. Core takes
   * both stores as dependencies so no SQLite call appears in the lifecycle
   * path; with no store injected (fixtures, tests) there is nothing to report.
   * `teardowns` is readable without a fleet — it is the one command that is
   * *most* useful once the home has been reset.
   */
  async function runsList(input: RunsListInput = {}): Promise<Run[]> {
    if (!deps.runs) return [];
    return deps.runs.list(input);
  }
  async function teardownsList(input: TeardownsListInput = {}): Promise<TeardownReceipt[]> {
    if (!deps.teardowns) return [];
    return deps.teardowns.list(TeardownsListInputSchema.parse(input));
  }

  return { list, get, history, destroyed, configShow, runsList, teardownsList };
}
