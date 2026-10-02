/**
 * The UI's view of every shape the app answers with, read off the bridge
 * contract (`HermeticRPC`) or off the app's own named exports — never
 * transcribed from core, which the UI cannot import (§3.1).
 *
 * Type-only, every one of them: the boundary matrix allows the UI no *value*
 * from `@hermetic/app`, and `import type` is erased before anything is
 * resolved (`tests/boundaries.test.ts`).
 */
import type {
  Accepted as ServerAccepted,
  HermeticRPC,
  OpMessage,
  OpSummary as ServerOpSummary,
} from "@hermetic/app";

/* ── the bridge, as a table of shapes ────────────────────────────────────── */

/** Every request the app answers: `PUBLIC_METHODS` plus the head's own machinery. */
type Bridge = HermeticRPC["bun"]["requests"];

/** The name of one request, as `dispatch` is keyed on it (`agents.create`). */
export type BridgeName = keyof Bridge;

/**
 * What a request takes: core's own schema plus the §4.7 fleet envelope, which
 * `withTarget` makes optional on every schema it wraps.
 */
export type BridgeInput<K extends BridgeName> = Bridge[K]["params"];

/**
 * What a request answers with, as the app's own handler resolved it.
 *
 * Nothing is narrowed or re-stated here: `PublicRequests` in
 * `packages/app/src/rpc/schema.ts` reads every answer off the handler that
 * gives it, so a shape that moves in the app moves in the page on the next
 * build rather than at runtime.
 */
export type BridgeResult<K extends BridgeName> = Bridge[K]["response"];

/* ── types, read off the bridge ──────────────────────────────────────────── */

export type AgentView = BridgeResult<"agents.list">[number];
/** §9's volume surface, read back off the bridge like everything else here. */
export type VolumeList = BridgeResult<"volumes.list">;
export type VolumeView = VolumeList["volumes"][number];
export type VolumeSummary = VolumeList["summary"];
export type VolumeGroup = VolumeView["group"];
/**
 * `volumes.get` (§9). No reader today — the fleet and the Volumes view both
 * work off the list — but the type is part of the §9 surface this file mirrors,
 * and it is what fails `tsc` here if that method's answer moves.
 */
export type VolumeDetail = BridgeResult<"volumes.get">;
export type VolumeDeleteResult = BridgeResult<"volumes.delete">;
/**
 * `agents.probe` (§9): the active counterpart to the passive `display_status`.
 * Layer failures are data — `outcome: "fail"` with a reason — so a report is a
 * 200 even when every layer is down; only an unknown agent is an error.
 */
export type ProbeReport = BridgeResult<"agents.probe">;
export type ProbeLayerOutcome = ProbeReport["instance"]["outcome"];
/** §7.4: what Hermes Desktop's remote-gateway form needs (`agents.desktop`). */
export type DesktopAttach = BridgeResult<"agents.desktop">;
export type ProbeVerdictLevel = ProbeReport["verdict"]["level"];

type MetaWire = BridgeResult<"meta.get">;
export type LocalConfig = NonNullable<MetaWire["config"]>;

/**
 * §6.6's `FoundationStatus`, read back off the bridge rather than
 * transcribed: which foundation contract the fleet is on, which one this build
 * of hermetic ships, and where each agent's own `hermeticd` has got to.
 */
export type FoundationStatus = BridgeResult<"foundation.status">;
export type FoundationAgentStatus = FoundationStatus["agents"][number];
/** `plan.foundation()`'s response — a core `Plan` with `kind: "foundation"`. */
export type FoundationPlan = BridgeResult<"plan.foundation">;

/**
 * §4.7's `PolicyReport`: what the fleet's OAuth client may do with the tailnet
 * policy file, which of hermetic's three managed blocks are there, and the
 * unified diff a write would produce. Read back off the bridge like everything
 * else here — the UI may not import core (§3.1).
 */
export type PolicyReport = BridgeResult<"policy.status">;
export type PolicyScope = PolicyReport["scope"];
export type PolicyManagedState = PolicyReport["managed"];
export type PolicyBlockReport = PolicyReport["blocks"][number];
/** `plan.policy()`'s response — a core `Plan` with `kind: "policy"`. */
export type PolicyPlan = BridgeResult<"plan.policy">;

/**
 * §5's `NetworkReport`: which side of a NAT this fleet's agents live on, what
 * CloudFormation says the answer is, and — on a `nat` fleet — the one appliance
 * every agent's egress depends on. Read off the bridge like everything else here.
 *
 * `mode` is nullable and absence is not `public`: a fleet frozen before the
 * field existed records nothing, and rendering that as `public` would state a
 * fact nobody checked.
 */
export type NetworkReport = BridgeResult<"network.status">;
export type NetworkMode = NonNullable<NetworkReport["mode"]>;
export type NatHealth = NonNullable<NetworkReport["nat"]>;
export type NetworkAgentPlacement = NetworkReport["agents"][number];
/** `plan.network()`'s response — a core `Plan` with `kind: "network"`. */
export type NetworkPlan = BridgeResult<"plan.network">;

/**
 * §4.6's shared fleet settings, as `settings.get` answers them: what the fleet
 * has been told, whether `_fleet` actually carries it yet (`persisted: false`
 * means these are synthesized defaults nobody has written), and the static
 * provider catalog the overrides sit on top of.
 *
 * The catalog rides in the same payload because a provider's "default model" is
 * only renderable with both halves — the fleet's override if there is one, the
 * catalog's otherwise.
 */
/**
 * §4.9's `Notification`, read back off the bridge like everything else
 * here. The UI may not import core (§3.1), so this is the only place the record
 * is named — `notification-logic.ts` describes it structurally instead, so the
 * rules stay testable without the bridge's own types.
 */
export type NotificationsResult = BridgeResult<"notifications.list">;
export type NotificationView = NotificationsResult["notifications"][number];
export type NotificationMuteView = NotificationsResult["mutes"][number];
export type NotificationActionView = NotificationView["actions"][number];
/** The `source` enum, read back off the row rather than re-declared here. */
export type NotificationSourceView = NotificationView["source"];

/**
 * §9.2's chat wire types, read back off the bridge for the same
 * reason everything else here is: the UI may not import core (§3.1), and a
 * hand-transcribed copy of a nine-member discriminated union is the copy that
 * drifts first.
 *
 * `ChatFrameView` is the exception, and has to be. A turn is a *stream*, and a
 * stream's frames are pushes rather than an answer (§9.2) — `HermeticRPC` types
 * `chat.frame`'s payload `unknown` for that reason — so the four frames are
 * spelled here, with the *block* half still taken off `ChatMessageView` so the
 * only hand-written part is the envelope.
 */
export type ChatSwarmsResult = BridgeResult<"chat.swarms">;
export type SwarmView = ChatSwarmsResult["swarms"][number];
export type BotView = SwarmView["bots"][number];
export type RoomView = SwarmView["rooms"][number];
export type ChatSessionsResult = BridgeResult<"chat.sessions">;
export type SessionView = ChatSessionsResult["sessions"][number];
export type ChatHistoryResult = BridgeResult<"chat.history">;
export type ChatMessageView = ChatHistoryResult["messages"][number];
export type ChatBlockView = ChatMessageView["blocks"][number];
/** Stable progress semantics are inferred from core's own contract, never upstream event names. */
export type ChatActivityView = Extract<ChatBlockView, { kind: "activity" }>;
/** One member of the block union, by its discriminant — `ChatBlockOf<"tool">`. */
export type ChatBlockOf<K extends ChatBlockView["kind"]> = Extract<ChatBlockView, { kind: K }>;
export type ChatUsageView = NonNullable<ChatMessageView["usage"]>;
export type ChatAbortResult = BridgeResult<"chat.abort">;
export type ChatResumeResult = BridgeResult<"chat.observe.resume">;

/** One frame of a live turn, as the app's chat handler names its events. */
export type ChatFrameView =
  | { type: "block"; seq: number; message: string; block: ChatBlockView }
  | { type: "delta"; seq: number; message: string; text: string }
  | { type: "done"; seq: number; message: string; usage?: ChatUsageView | null; incomplete?: boolean }
  | { type: "error"; code: string; message: string };

export type SettingsResult = BridgeResult<"settings.get">;
export type FleetSettings = SettingsResult["settings"];
export type ProviderCatalog = SettingsResult["catalog"];
export type ProviderId = keyof ProviderCatalog & string;
export type ProviderSettings = NonNullable<FleetSettings["providers"][ProviderId]>;
/**
 * The write body, read off the *request* side of the same method. A
 * hand-mirrored copy would be a second place for `settings.set`'s "a patch, not
 * a replacement" rule to be spelled, and the one that drifts.
 */
export type SettingsSetInput = Omit<BridgeInput<"settings.set">, "target">;

/**
 * §4.6's create presets: this laptop's machine bundles and loadout. Local, so
 * the write carries no fleet envelope.
 */
export type PresetsResult = BridgeResult<"presets.get">;
export type PresetsSetInput = BridgeInput<"presets.set">;

/**
 * §8.2's slot list. Values are absent by construction — no read path returns
 * one — so this is names, state, and who names them.
 */
export type SecretsList = BridgeResult<"secrets.list">;
export type SharedSecretView = SecretsList["secrets"][number];
export type SecretsPushResult = BridgeResult<"secrets.push">;
/** `SecretsPushInput` minus the target, which this UI only ever spells `_fleet`. */
export type SharedSecretPush = Omit<BridgeInput<"secrets.push">, "name" | "target">;

/**
 * `/api/meta` in both modes. `config` is null and `initialized` false before
 * `hermetic init` has bound this home to an account (§4.6, §4.7); `initialized`
 * and `home` are absent on a server built before uninitialized mode, and an
 * absent flag is read as "initialized" so the dashboard still renders.
 */
export interface Meta {
  header: string;
  config: LocalConfig | null;
  fixture: boolean;
  hermes_version: string | null;
  hermeticd_version: string | null;
  tailnet: string | null;
  initialized?: boolean;
  home?: string;
  /** AWS_* etc set in this process's env; present only while uninitialized. */
  env_overrides?: string[];
  /** Path an unreadable local config was moved to, if any, before re-init. */
  corrupted_to?: string | null;
  /** Set when init finished but the dashboard failed to attach afterward. */
  adopt_error?: string | null;
  /**
   * Recorded when a `teardown` op finished `ok` with `reset_local: true`; null
   * otherwise. The wizard shows this once, above step 1. `/api/meta` always
   * includes the key (both the initialized and uninitialized response
   * branches set it from `state.lastTeardown`), so this is required, not
   * optional — only its value is nullable.
   */
  last_teardown: LastTeardown | null;
  /**
   * §4.8: which fleet this server is currently serving, what it is called if
   * anything, which one this laptop means when no fleet is named, and where the
   * account's fleet directory lives. Both `/api/meta` branches set it — a
   * server that has never been initialized still answers, with four nulls — but
   * it is optional here for the same reason `initialized` is: a server built
   * before multi-fleet sends no such key.
   *
   * `id` and `default` are `fleet_id`s; `alias` is the optional display label
   * (§4.6). The browser shows `alias ?? id` and keys everything — state, fetch
   * targets, comparisons — on `id`.
   */
  fleet?: {
    id: string | null;
    alias: string | null;
    default: string | null;
    directory_region: string | null;
  };
  /**
   * §4.8: why this server has no fleet open, when that is a *choice* nobody has
   * made rather than a home nobody has run `init` in. `FLEET_REQUIRED` means
   * several fleets are frozen here and none is the default; `NOT_FOUND` means
   * the one that was named is not frozen here. Both leave `initialized` false,
   * but neither is a reason to show the init wizard — there is a fleet to open,
   * so the App shows the picker instead. Optional for the same reason `fleet`
   * is: an older server sends no such key, and its absence means "no such
   * problem", never "a problem nobody described".
   */
  fleet_error?: { code: string; message: string } | null;
  /**
   * §6.6: the dashboard's copy of `foundation status`, so the EnvStrip pill and
   * the Settings section need no second round trip. `null` before `init` (there
   * is no fleet to compare against) and `null` when the read itself failed —
   * the whole UI boots from `/api/meta`, so it degrades rather than fails.
   */
  foundation?: FoundationStatus | null;
  /**
   * §4.6: the fleet's shared settings, carried on `/api/meta` for the same
   * reason `foundation` is — the Settings view and the create drawer paint the
   * fleet's own defaults on the first render instead of `—` and a correction.
   * `null` when the read failed, absent on a server built before shared
   * settings existed; both are rendered as "not reported", never as "unset".
   */
  settings?: SettingsResult | null;
}

/** `ServerState.LastTeardown`, mirrored here since the UI cannot import core. */
export interface LastTeardown {
  at: string;
  account_id: string;
  region: string;
  fleet_id: string;
  /** Leftovers teardown does not reach — e.g. Tailscale admin console entries. */
  manual_steps: string[];
}

export type AgentEvent = BridgeResult<"agents.history">[number];
/** One destroyed incarnation (§6.7): the audit record that outlives the agent's row. */
export type AgentTombstone = BridgeResult<"agents.destroyed">[number];
/** `agents.history`'s window: one incarnation's `created_at`/`destroyed_at`, inclusive. */
export interface HistoryWindow {
  since?: string;
  until?: string;
}
export type Plan = BridgeResult<"plan.destroy">;
export type Doctor = BridgeResult<"doctor">;
export type Run = BridgeResult<"runs.list">[number];

/**
 * The four `teardown` flags (§9), as the plan/teardown UI carries them.
 *
 * Optional, because core gives every one of them a default and a caller that
 * names none is a valid teardown call. The drawer that owns the checkboxes
 * holds a `Required<TeardownOptions>` instead — a checkbox is always on or
 * off, and "unset" is not a box anyone can draw.
 */
export type TeardownOptions = Partial<
  Pick<BridgeInput<"teardown">, "purge" | "delete_snapshots" | "delete_volumes" | "reset_local">
>;

/** `plan.teardown()`'s response (core `Plan`, `kind: "teardown"`), read off the bridge. */
export type TeardownPlan = BridgeResult<"plan.teardown">;

/**
 * `PlanSummary` (core `schema/ops.ts`): which fleet, in which account, a plan
 * is about. Every field is required *within* the object — `stack_id` is the
 * one nullable field (null once the foundation is already gone) — but the
 * object itself stays optional on `Plan`: core's own schema marks `summary`
 * `.optional()` for plans that never resolved a fleet.
 */
export type TeardownPlanSummary = NonNullable<TeardownPlan["summary"]>;

export type TeardownPlanStep = TeardownPlan["steps"][number];

/** `OpSummary` as it comes back from a 202 — the server's own registry row type. */
export type OpSummary = ServerOpSummary;

/**
 * One tick of an op stream (`core.schema.OpEvent`).
 *
 * A stream's frames are pushes rather than an answer, so there is nothing on
 * `HermeticRPC` to read: it is taken from the app's `OpMessage` envelope — the
 * same type the `op.event` push carries (`app/src/rpc/schema.ts`).
 */
export type OpEvent = Extract<OpMessage, { type: "event" }>["event"];

/**
 * `CreateAgentInput` in core's `schema/requests.ts`, read off `agents.create`.
 *
 * `provider_profile` (§8.3) is the provider profile this agent is built
 * against, by id or by name — where the provider, the model and the credential
 * all come from. There is deliberately no `provider` and no `api_key` here. A
 * fresh create no longer accepts either — core refuses a key with "keys live on
 * provider profiles" — so the browser has no field that could send one.
 * `root_gib` is the box's own root disk (§7.1), not the `/data` volume;
 * `volume_id` is §9's reclaim path; `rollback_on_failure` undoes whatever the
 * create made if it fails instead of leaving a resumable half-made agent
 * behind (§6.2), off unless the operator asks for it.
 */
export type CreateAgentInput = BridgeInput<"agents.create">;

/**
 * What every op-starting method answers with: `{ op_id, op }`.
 *
 * The app's own type (`accepted`, `app/src/ops.ts`), not a copy of it. A
 * hand-written copy kept promising `op_id` after the handlers stopped sending
 * it, and every progress rail followed `undefined` with nothing to say so.
 */
export type Accepted = ServerAccepted;
