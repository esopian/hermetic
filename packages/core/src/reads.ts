/**
 * The reads that used to live in `hermetic.ts` itself — short enough to have
 * stayed until the assembly hit its size cap (AGENTS.md rule 5): the agent
 * list and row views the heads paint from (§4.5), an agent's history, the
 * frozen config with what only the fleet knows about it (§4.6), and the two
 * local tables (`runs`, `teardowns`) core takes as stores so no SQLite call
 * appears in the lifecycle path.
 */
import type {
  AgentEvent,
  AgentView,
  FleetSettings,
  HistoryInput,
  ListAgentsInput,
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

export interface ReadsDeps {
  ctx: CoreContext;
  /** `profile-apply.ts`'s soft settings read, for the `update_available` annotation (§8.3). */
  settingsForView: () => Promise<FleetSettings | undefined>;
  configStore?: ConfigStore | undefined;
  runs?: RunStore | undefined;
  teardowns?: TeardownStore | undefined;
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
    const rows = await backend.store.agents.scan();
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
    return backend.store.events.query(input.name, input.limit);
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

  return { list, get, history, configShow, runsList, teardownsList };
}
