/**
 * The fleet-side wrappers: agents, volumes, foundation, policy, network,
 * fleets and the directory, settings, providers, secrets, teardown, ops and
 * notifications. One named request each, through the transport seam; the
 * shapes are read off the bridge contract (`types.ts`, `BridgeInput`/
 * `BridgeResult`), never transcribed from core (§3.1).
 */
import { FETCH_KEYS, cachedFetch, invalidateFetchCache } from "../lib/fetch-cache.ts";
import { type FleetTarget, target } from "./client.ts";
import { transport } from "./transport.ts";
import type {
  Accepted,
  AgentEvent,
  AgentView,
  BridgeInput,
  BridgeResult,
  CreateAgentInput,
  DesktopAttach,
  Doctor,
  Meta,
  FoundationPlan,
  NetworkMode,
  NetworkPlan,
  NetworkReport,
  NotificationSourceView,
  NotificationsResult,
  OpEvent,
  OpSummary,
  Plan,
  PolicyPlan,
  PolicyReport,
  ProbeReport,
  Run,
  SecretsList,
  SecretsPushResult,
  PresetsResult,
  PresetsSetInput,
  SettingsResult,
  SettingsSetInput,
  SharedSecretPush,
  TeardownOptions,
  TeardownPlan,
  VolumeDeleteResult,
  VolumeList,
} from "./types.ts";

export function listAgents(): Promise<AgentView[]> {
  return transport().request<AgentView[]>("agents.list");
}

/**
 * `GET /api/agents/:name/probe` — ask each layer directly (§9). It takes up to
 * ~5s when a layer times out; that wait *is* the answer, so it is an ordinary
 * request rather than an op to stream.
 */
export function probeAgent(name: string): Promise<ProbeReport> {
  return transport().request<ProbeReport>("agents.probe", { name });
}

/**
 * §7.4: the Serve URL and the box's current dashboard session token, for
 * Hermes Desktop's remote-gateway form.
 *
 * The answer carries a live credential, so nothing here caches it: the drawer
 * asks when the operator asks, shows it, and drops it when the panel closes.
 * The token dies with the box's dashboard process anyway, which is why a
 * remembered one would be worse than no answer at all.
 */
export function desktopAttach(name: string): Promise<DesktopAttach> {
  return transport().request<DesktopAttach>("agents.desktop", { name });
}

export function history(name: string, limit = 40): Promise<AgentEvent[]> {
  return transport().request<AgentEvent[]>("agents.history", { name, limit });
}

export function planDestroy(name: string, deleteVolume: boolean): Promise<Plan> {
  return transport().request<Plan>("plan.destroy", { name, delete_volume: deleteVolume });
}

/* ── volumes (§9) ────────────────────────────────────────────────────────── */

export function listVolumes(): Promise<VolumeList> {
  return cachedFetch(FETCH_KEYS.volumes, () => transport().request<VolumeList>("volumes.list"));
}

/** The route answers 428 unless the body confirms; the drawer types the id first. */
export async function deleteVolume(volumeId: string): Promise<VolumeDeleteResult> {
  const result = await transport().request<VolumeDeleteResult>("volumes.delete", {
    volume_id: volumeId,
    yes: true,
    target: target(),
  });
  invalidateFetchCache(FETCH_KEYS.volumes);
  return result;
}

export function getDoctor(): Promise<Doctor> {
  return transport().request<Doctor>("doctor");
}

/* ── foundation (§6.6) ───────────────────────────────────────────────────── */

/** `GET /api/plan/foundation` — the dry run the update drawer reviews first. */
export function planFoundation(): Promise<FoundationPlan> {
  return transport().request<FoundationPlan>("plan.foundation");
}

/* ── tailnet policy (§4.7) ───────────────────────────────────────────────── */

/**
 * `GET /api/policy`. A pure read: it fetches the tailnet policy and reports
 * hermetic's own blocks. `managed: "unavailable"` is not "clean" — it is "the
 * client could not read the file", which is why the card renders it apart.
 */
export function getPolicy(): Promise<PolicyReport> {
  return transport().request<PolicyReport>("policy.status");
}

/** `GET /api/plan/policy` — the dry run the policy drawer reviews first. */
export function getPolicyPlan(): Promise<PolicyPlan> {
  return transport().request<PolicyPlan>("plan.policy");
}

/* ── network mode (§5) ───────────────────────────────────────────────────── */

/**
 * `GET /api/network`. A pure read: it reconciles `_fleet.network` against the
 * stack's own `Network` parameter and reports both, so a disagreement is
 * visible rather than resolved silently in favour of the cache.
 */
export function networkStatus(): Promise<NetworkReport> {
  return transport().request<NetworkReport>("network.status");
}

/**
 * `GET /api/plan/network?to=…` — the dry run the re-network drawer reviews
 * first. Refuses with `CONFLICT` when the fleet is already in `to`, and with
 * `AGENTS_EXIST` when moving `nat` → `public` while instances still sit in the
 * private subnets CloudFormation would have to delete.
 */
export function planNetwork(to: NetworkMode): Promise<NetworkPlan> {
  return transport().request<NetworkPlan>("plan.network", { to });
}

/**
 * `POST /api/apply` with a plan → 202 `{ op_id, op }`, followed like any other
 * op. `yes` is the browser saying the operator confirmed in the drawer; the
 * route answers 428 without it. The plan travels back exactly as the server
 * produced it — its `options.etag` is what makes an `apply` against a policy
 * somebody edited in the meantime a `CONFLICT` rather than an overwrite, and a
 * network plan's `options.network` is what stops a re-network reviewed as
 * "public → nat" from re-deriving its own target when it runs.
 *
 * A destroy plan goes the same way, and for the same reason: its `options`
 * carry the instance and volume ids the operator reviewed, so core can refuse
 * the plan whose row moved instead of terminating whatever the row names now.
 */
export function applyPlan(plan: Plan | PolicyPlan | NetworkPlan | RolloutPlan): Promise<Accepted> {
  return transport().request<Accepted>("apply", { plan, yes: true, target: target() });
}

/** `plan.rollout()`'s response — a core `Plan` with `kind: "rollout"`. */
export type RolloutPlan = BridgeResult<"plan.rollout">;

/**
 * `GET /api/plan/rollout?agents=…` — the dry run behind "Apply changes" on an
 * agent whose profile edit is saved but `pending` (§8.3). The rollout is the
 * delivery path that already exists: it re-renders each named agent's manifest
 * and asks its `hermeticd` to take the new configuration. `apply(plan)` runs it.
 */
export function planRollout(agents: readonly string[]): Promise<RolloutPlan> {
  return transport().request<RolloutPlan>("plan.rollout", { agents: [...agents] });
}

/**
 * `POST /api/foundation/update` → 202 `{ op_id, op }`, followed like any other
 * op. `yes` is the browser saying the operator confirmed on the drawer's second
 * stage; core ignores it (§3.2 rule 1) but validates the same shape the CLI
 * sends. There is no typed account id here: an update replaces no state — it
 * refuses (`FOUNDATION_UNSAFE`) rather than replacing any — so it is not the
 * teardown ceremony.
 */
export function updateFoundation(): Promise<Accepted> {
  return transport().request<Accepted>("foundation.update", { yes: true, target: target() });
}

/* ── fleets and the fleet directory (§4.8) ───────────────────────────────── */

/**
 * One row of `fleets.list`. Defined in `fleet-switch.ts` — the switcher's pure
 * rules need it without pulling this module's request wrappers in — and re-exported
 * here so a caller reads every server shape off `api.ts` like every other type
 * in this file. One definition, two doors.
 */
export type { FleetListEntry } from "../nav/fleet-switch.ts";

/** `fleets.list()`: the local rows ∪ the directory's, plus how the directory read went. */
export type FleetsList = BridgeResult<"fleets.list">;
/** `directory.status()`: the account-global table itself, not the fleets in it. */
export type DirectoryStatus = BridgeResult<"directory.status">;
/** One account-directory row: a `fleet_id`, its optional alias, and its status. */
export type DirectoryEntry = BridgeResult<"fleets.alias">;

/**
 * `GET /api/fleets`. Never throws for an unreachable directory — core reports
 * that in `directory_error` and still answers with the local half — so a
 * rejection here means the request itself failed.
 */
export function listFleets(): Promise<FleetsList> {
  return transport().request<FleetsList>("fleets.list");
}

/**
 * `POST /api/fleets/switch` — machinery, not a core method: it repoints *this
 * server* at another fleet frozen in the same home. The reply carries the whole
 * `/api/meta` body taken after the switch, so the browser applies one answer
 * instead of racing a second read against the move. `409 CONFLICT` when an op
 * is in flight and `404 NOT_FOUND` when the fleet is not frozen here both
 * arrive as `ApiError`s, which is what the switcher shows inline.
 */
export async function switchFleet(fleet: string): Promise<{ fleet_id: string | null; meta: Meta }> {
  // The `target` this tab sends with every later mutation moves when the page
  // *adopts* this meta, not when it arrives (§4.7) — `FleetProvider.switchTo`
  // does both in one step. See `setFleetTarget`.
  return transport().request<{ fleet_id: string | null; meta: Meta }>("fleets.switch", { fleet });
}

/**
 * `PUT /api/fleets/default` (`fleets.use`) — which fleet a bare command on this
 * laptop means. Local only: it moves no server and touches no account, so it is
 * deliberately *not* a switch, and the reply names the default it replaced.
 */
export function setDefaultFleet(fleet: string): Promise<{ fleet_id: string; previous: string | null }> {
  return transport().request<{ fleet_id: string; previous: string | null }>("fleets.use", { fleet });
}

/**
 * `PUT /api/fleets/alias` (`fleets.alias`) — the fleet's optional display label
 * (§4.6). The target is always a `fleet_id`; `null` clears the label, and the
 * fleet then shows as its id everywhere.
 */
export function setFleetAlias(fleet: string, alias: string | null): Promise<DirectoryEntry> {
  return transport().request<DirectoryEntry>(
    "fleets.alias",
    alias === null ? { fleet, clear: true } : { fleet, alias },
  );
}

/** `GET /api/directory` — a real DynamoDB read, so it refuses before `init`. */
export function getDirectory(): Promise<DirectoryStatus> {
  return transport().request<DirectoryStatus>("directory.status");
}

/* ── create presets (§4.6): this laptop's, not the fleet's ────────────────── */

/** `presets.get`: the loadout, its default, and every built-in and custom preset. */
export function getPresets(): Promise<PresetsResult> {
  return transport().request<PresetsResult>("presets.get");
}

/**
 * `presets.set`: a patch whose stated parts each replace their field, or
 * `{ reset: true }`. No `target`: a preset belongs to this laptop, not to the
 * fleet this window happens to be on.
 */
export function setPresets(input: PresetsSetInput): Promise<PresetsResult> {
  return transport().request<PresetsResult>("presets.set", input);
}

/* ── shared settings, providers, shared secrets (§4.6, §8.2) ─────────────── */

/** `GET /api/settings`. The same document `/api/meta` embeds, read fresh. */
export function getSettings(): Promise<SettingsResult> {
  return transport().request<SettingsResult>("settings.get");
}

/**
 * `PATCH /api/settings` — a patch of the fleet's own defaults. `expected_version`
 * is the version the form was composed against, so a second laptop's write
 * between load and save is a `CONFLICT` rather than a silent overwrite.
 */
export function setSettings(input: SettingsSetInput): Promise<SettingsResult> {
  return transport().request<SettingsResult>("settings.set", { ...input, target: target() });
}

/** `GET /api/secrets` — every fleet-level slot, described without its value. */
export function listSecrets(): Promise<SecretsList> {
  return transport().request<SecretsList>("secrets.list");
}

/**
 * `POST /api/secrets/_fleet/push --shared <slug>`. The value goes over the same
 * loopback channel the create drawer's API key does: straight to core, into
 * `/hermetic/secrets/<slug>`, never stored by the browser and never returned by
 * any read. `rekey: "all"` re-copies it into the slots of agents already
 * running on this slug (§8.3) — rotation is a stated act, not an implied one.
 */
export function pushSharedSecret(input: SharedSecretPush): Promise<SecretsPushResult> {
  return transport().request<SecretsPushResult>("secrets.push", {
    name: "_fleet",
    ...input,
    target: target(),
  });
}

/** The route answers 428 unless the body confirms; the drawer types the slug first. */
export function deleteSecret(slug: string): Promise<{ slug: string; deleted: boolean }> {
  return transport().request<{ slug: string; deleted: boolean }>("secrets.delete", {
    slug,
    yes: true,
    target: target(),
  });
}

/* ── provider profiles (§8.3) ────────────────────────────────────────────── */

/**
 * `providers.list`: every named profile the fleet holds, plus the two facts
 * that are about the fleet rather than about one profile — which profile is the
 * default, and which Bedrock model ids the instance role may actually invoke.
 *
 * Read off the route like everything else here. A profile carries no key and no
 * key ever comes back on one: `credential` names the slot, never its value.
 */
export type ProvidersListResult = BridgeResult<"providers.list">;
export type ProfileView = ProvidersListResult["profiles"][number];
/** Why core says a profile is or is not usable; the badge renders it. */
export type ProfileReadyReason = ProfileView["ready_reason"];
export type ProvidersWriteResult = BridgeResult<"providers.create">;
export type ProfileCreateInput = Omit<BridgeInput<"providers.create">, "target">;
export type ProfileUpdateInput = Omit<BridgeInput<"providers.update">, "target">;

/**
 * `providers.models`: the provider's own catalog, fetched live through the
 * server. Either a saved profile (whose stored credential core resolves) or a
 * bare provider plus the draft key an operator is typing into setup — which is
 * the only reason this is a POST: a key does not belong in a URL.
 */
export type ModelCatalog = BridgeResult<"providers.models">;
export type CatalogModel = ModelCatalog["models"][number];
export type ModelsInput = BridgeInput<"providers.models">;

export function listProfiles(): Promise<ProvidersListResult> {
  // Two settings sections read this, and both re-mount on every view switch.
  return cachedFetch(FETCH_KEYS.profiles, () =>
    transport().request<ProvidersListResult>("providers.list"),
  );
}

export async function createProfile(input: ProfileCreateInput): Promise<ProvidersWriteResult> {
  const result = await transport().request<ProvidersWriteResult>("providers.create", {
    ...input,
    target: target(),
  });
  invalidateFetchCache(FETCH_KEYS.profiles);
  return result;
}

/**
 * The id goes in the path *and* in the body: the route's `jsonBody` folds
 * `:id` onto the schema's `profile` field, and sending both spellings of the
 * same value is what the fold is written to accept.
 */
export async function updateProfile(
  id: string,
  patch: Omit<ProfileUpdateInput, "profile">,
): Promise<ProvidersWriteResult> {
  const result = await transport().request<ProvidersWriteResult>("providers.update", {
    ...patch,
    profile: id,
    target: target(),
  });
  invalidateFetchCache(FETCH_KEYS.profiles);
  return result;
}

/** The route answers 428 unless the body confirms; the section asks first. */
export async function deleteProfile(
  id: string,
): Promise<{ id: string; name: string; deleted: boolean }> {
  const result = await transport().request<{ id: string; name: string; deleted: boolean }>(
    "providers.delete",
    { profile: id, yes: true, target: target() },
  );
  invalidateFetchCache(FETCH_KEYS.profiles);
  return result;
}

/**
 * `POST /api/providers/models`. The draft key travels the same loopback path a
 * secret push does — straight to core, never stored by the browser, never on
 * the answer — and the catalog that comes back is metadata only.
 */
export function fetchModels(input: ModelsInput): Promise<ModelCatalog> {
  return transport().request<ModelCatalog>("providers.models", { ...input });
}

/**
 * §4.6: the permanent teardown record. Readable in both server states — the
 * modal that shows it is displayed *over the init wizard*, after the teardown
 * has already returned this home to uninitialized.
 */
export interface TeardownResourceOutcome {
  phase: string;
  disposition: "removed" | "retained" | "skipped" | "manual" | "failed";
  what: string;
  count: number | null;
  detail: string | null;
}

export interface TeardownReceipt {
  id: string;
  op_id: string | null;
  started_at: string;
  finished_at: string;
  account_id: string;
  region: string;
  fleet_id: string;
  stack_name: string;
  options: {
    purge?: boolean;
    delete_snapshots?: boolean;
    delete_volumes?: boolean;
    reset_local?: boolean;
  };
  outcome: "ok" | "failed";
  error: { code: string; message: string } | null;
  resources: TeardownResourceOutcome[];
  /**
   * §4.6: what became of the fleet's Elastic IP allocations. The dispositions
   * above say *that* one was kept or released; this is where the allocation id
   * is, which is what an operator pastes into the EC2 console. Optional because
   * a receipt written before the sweep existed carries none.
   */
  addresses?: {
    kept: Array<{ allocation_id: string; public_ip: string; associated: boolean }>;
    released: string[];
  };
  events: OpEvent[];
}

export function listTeardowns(limit = 5): Promise<TeardownReceipt[]> {
  return transport().request<TeardownReceipt[]>("teardowns.list", { limit });
}

export async function listRuns(limit = 20): Promise<Run[]> {
  return transport().request<Run[]>("runs.list", { limit });
}

/**
 * The teardown dry run the DANGER drawer reviews first, with the four teardown
 * flags as the operator set them. How they reach the head is the transport's
 * (`transport-rpc.ts`).
 */
export async function planTeardownFoundation(options: TeardownOptions = {}): Promise<TeardownPlan> {
  return transport().request<TeardownPlan>("plan.teardown", { ...options });
}

/**
 * `POST /api/teardown` — tears down the whole foundation. Refused while any
 * agent exists. `confirmAccountId` is required by the route itself (there is
 * no prompt on this side of the wire, so the twelve typed digits must arrive
 * in the request): missing → 428 `CONFIRMATION_REQUIRED`, present but not
 * twelve digits → 400 from the `zValidator` json schema, present and
 * well-formed but wrong → 202, then the op itself fails `CONFIRMATION_REQUIRED`
 * once core re-checks it against the frozen config.
 */
export function teardownFoundation(
  confirmAccountId: string,
  options: TeardownOptions = {},
): Promise<Accepted> {
  return transport().request<Accepted>("teardown", {
    yes: true,
    confirm_account_id: confirmAccountId,
    ...options,
    target: target(),
  });
}

/* ── ops (POST → 202 { op_id, op }) ──────────────────────────────────────── */

export function createAgent(input: CreateAgentInput): Promise<Accepted> {
  return transport().request<Accepted>("agents.create", { ...input, target: target() });
}

export function stopAgent(name: string): Promise<Accepted> {
  return transport().request<Accepted>("agents.stop", { name, target: target() });
}

export function startAgent(name: string): Promise<Accepted> {
  return transport().request<Accepted>("agents.start", { name, target: target() });
}

/** The route answers 428 unless the body confirms; the drawer asks first. */
export function recreate(name: string): Promise<Accepted> {
  return transport().request<Accepted>("agents.recreate", { name, yes: true, target: target() });
}

/**
 * `POST /api/agents/:name/rerun` — re-run the bootstrap stages that are not
 * `ok`, resuming at the first failure (§4.2). Not an op: it writes a
 * `BootstrapCommand` on the agent's row and returns the row, which hermeticd
 * picks up on its next poll. Non-destructive, so nothing confirms it.
 */
export function rerunAgent(name: string): Promise<AgentView> {
  return writeRow("agents.rerun", { name, target: target() });
}

/**
 * The fleet a write named, and the row it answered with. The target is the one
 * the request carried, so a reader can tell an answer that arrived after the
 * window switched fleets from one about the fleet it is showing.
 */
export type AgentWritten = (target: FleetTarget, row: AgentView) => void;

const agentWritten = new Set<AgentWritten>();

/**
 * Hear every row a write returns. The fleet stream only carries what a scan
 * found and scans are a minute apart, so without this the board held the
 * pre-write row — and its `version` — for up to a minute after core had moved
 * on, and the next version-guarded write from the drawer was refused as stale.
 */
export function onAgentWritten(listener: AgentWritten): () => void {
  agentWritten.add(listener);
  return () => {
    agentWritten.delete(listener);
  };
}

/** One row-returning agent write, whose answer is handed to every `onAgentWritten` reader. */
async function writeRow(
  name: "agents.rerun" | "agents.set" | "agents.reboot",
  params: { target: FleetTarget } & Record<string, unknown>,
): Promise<AgentView> {
  const row = await transport().request<AgentView>(name, params);
  for (const listener of [...agentWritten]) listener(params.target, row);
  return row;
}

/**
 * The stage-a-profile-change request body (§8.3), read off the route like
 * every other request shape; `target` is added by the caller.
 */
export type SetAgentProfileInput = Omit<BridgeInput<"agents.set">, "target">;

/**
 * `POST /api/agents/:name/set`. Writes `pending` on the row rather than
 * touching the box: the running configuration keeps its credential until the
 * rollout applies the staged one, which is why the drawer then offers "Apply
 * changes" instead of claiming the edit took effect.
 */
export function setAgentProfile(input: SetAgentProfileInput): Promise<AgentView> {
  return writeRow("agents.set", { ...input, target: target() });
}

/**
 * `POST /api/agents/:name/reboot` — bounce the OS on the instance the agent
 * already has (§6.5). Same box, same disks, same tailnet address, so like
 * `rerun` it is one request that returns the row rather than an op to stream.
 */
export function rebootAgent(name: string): Promise<AgentView> {
  return writeRow("agents.reboot", { name, target: target() });
}

/** `POST /api/upgrade` needs one of hermes/hermeticd, so the target version goes on the wire. */
export function upgrade(name: string, hermes: string): Promise<Accepted> {
  return transport().request<Accepted>("upgrade", { name, hermes, target: target() });
}

/*
 * There is deliberately no `destroy(name, deleteVolume)` here.
 *
 * `DELETE /api/agents/<name>` recomputes what to destroy from the name at the
 * moment it runs, so a portal calling it would terminate whatever the row
 * points at by then rather than what the operator read. The drawer applies the
 * reviewed plan instead (`applyPlan`, §6.7), which carries the instance and
 * volume ids core re-checks. The route stays for the CLI, where `--yes` with no
 * plan is a stated choice; the browser has no caller and must not grow one.
 */

/** `GET /api/ops?target=&status=` — how a reloaded page finds its own op again. */
export async function listOps(
  filter: { target?: string; status?: "running" | "ok" | "error" | "aborted" } = {},
): Promise<OpSummary[]> {
  const page = await transport().request<{ ops: OpSummary[] }>("ops.list", { ...filter });
  return page.ops;
}

/* ── notifications (§4.9) ─────────────────────────────────────────────────── */

/**
 * `GET /api/notifications`. The whole inbox in one read: the rows, both counts,
 * and the mute list the rows' `muted` flag was derived from. The counts come
 * from the server rather than being recounted here, because the badge has to
 * agree with what the CLI's `hermetic inbox` prints — and because a `limit`ed
 * page cannot count what it did not fetch.
 */
export function fetchNotifications(
  input: { unread?: boolean; limit?: number; since?: string } = {},
): Promise<NotificationsResult> {
  return transport().request<NotificationsResult>("notifications.list", { ...input });
}

/** `POST /api/notifications/ack` — one row by id, or every unread row. */
export function ackNotification(
  input: { id: string } | { all: true },
): Promise<BridgeResult<"notifications.ack">> {
  return transport().request<BridgeResult<"notifications.ack">>("notifications.ack", {
    ...input,
    target: target(),
  });
}

/**
 * `POST /api/notifications/mute` — silence an agent or a whole source, or lift
 * one with `clear`. Shared with the CLI (§4.9): a mute is about the rows
 * core writes, not about what this browser does with them, so it is the one
 * notification preference that does *not* live in `localStorage`.
 */
export function muteNotification(input: {
  agent?: string;
  source?: NotificationSourceView;
  clear?: boolean;
}): Promise<BridgeResult<"notifications.mute">> {
  return transport().request<BridgeResult<"notifications.mute">>("notifications.mute", {
    ...input,
    target: target(),
  });
}
