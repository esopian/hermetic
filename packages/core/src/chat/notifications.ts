/**
 * The notification primitive (§4.9): the store contract, the three
 * public methods over it, and every source that writes rows — `agent.health`
 * from the fleet scan's status transitions, `operation.failed` /
 * `operation.done` from a settled run, `fleet.advisory` from the four
 * conditions the fleet already computes, and `chat.message` /
 * `chat.error` from the roster read and the turn.
 *
 * Its own module with an explicit deps object, for the reason `fleets.ts` and
 * `teardown.ts` are (AGENTS.md rule 5): nothing here shares the lifecycle's
 * closure, and `hermetic.ts` is at the size where a new surface belongs beside
 * it rather than inside it.
 *
 * Two rules hold everywhere below.
 *
 * **Nothing here may fail a command.** A notification is a courtesy; an
 * `agents.list` that threw because the inbox was unwritable would be the
 * courtesy costing the fleet. Every source below is wrapped, and none of them
 * logs (rule 1).
 *
 * **Nothing here composes a message.** Detail text is assembled from an error's
 * own `code` and `message`, which §8.3 already guarantees carry no value — so
 * redaction stays the error's job and the row cannot be where a secret first
 * gets written down.
 */
import { randomUUID } from "node:crypto";
import { hiddenByListening } from "../shared/notifications.ts";
import { isRoutineProcessEvent, processEventSentence } from "../shared/process-event.ts";
import {
  NotificationsAckInput,
  NotificationsListInput,
  NotificationsMuteInput,
  agentMuteTarget,
  chatActionRef,
  sourceMuteTarget,
} from "../schema/index.ts";
import type {
  AgentView,
  DisplayStatus,
  FleetSettings,
  Notification,
  NotificationAction,
  NotificationClass,
  NotificationKind,
  NotificationMute,
  NotificationSource,
  NotificationsAckResult,
  NotificationsListResult,
  NotificationsMuteResult,
  ProcessEventBlock,
  VolumeView,
} from "../schema/index.ts";
import { HermeticError } from "../errors.ts";

/** Rows older than this are deleted as a new one is written (§4.9). */
export const NOTIFICATION_RETENTION_DAYS = 30;

const DAY_MS = 86_400_000;

/**
 * What a source hands the store. `id`, `at` and `read_at` are settable so the
 * fixture seed can write fixed rows twice and get the same inbox both times.
 */
export interface NotificationInsert {
  source: NotificationSource;
  kind: NotificationKind;
  class: NotificationClass;
  title: string;
  detail?: string | null;
  agent?: string | null;
  /** The `fleet_id` the row is about; null for a row about the laptop itself. */
  fleet?: string | null;
  ref?: string | null;
  /** The condition this row reports; unique among unresolved rows. */
  key?: string | null;
  actions?: NotificationAction[];
  id?: string;
  at?: string;
  read_at?: string | null;
}

/**
 * The local notification log. Synchronous, like the SQLite it is backed by:
 * every implementation is a local file or an array, and there is no
 * configuration in which reading the inbox is a network call.
 */
export interface NotificationStore {
  /**
   * Writes a row and returns it. A row carrying a `key` that an unresolved row
   * already holds is **not** written — the existing row is returned instead, so
   * a condition that keeps holding keeps finding the notification it already
   * raised. Enforces retention on the way through.
   */
  insert(row: NotificationInsert): Notification;
  /** Newest first. The named fleet's rows plus the rows that name no fleet. */
  list(
    input: NotificationsListInput,
    fleet: string | null,
    instances?: readonly string[],
  ): Notification[];
  counts(fleet: string | null, instances?: readonly string[]): { unread: number; needs_action: number };
  /** Marks one row, or every unread row of this fleet, read. Returns how many moved. */
  ack(input: { id?: string; all?: boolean }, fleet: string | null): number;
  mute(target: string): void;
  unmute(target: string): void;
  mutes(): NotificationMute[];
  /**
   * The keys of the unresolved rows this prefix owns, in this fleet's scope and
   * with no row limit — the read `observeAdvisories` reconciles against.
   *
   * Ownership is the rule the key scheme already documents: `prefix` matches a
   * key equal to it, or a key beginning `prefix` + `:`. The separator is
   * required rather than a bare prefix match, so `fleet.advisory:loose_volume`
   * never owns `fleet.advisory:loose_volumes`.
   *
   * Unbounded on purpose. A `list()` window would leave an advisory pushed past
   * it permanently unresolvable, which is exactly the bug the read replaces —
   * and it is bounded in practice anyway, because unresolved rows are one per
   * held condition and the conditions are counted in tens.
   */
  openKeys(prefix: string, fleet: string | null): string[];
  /** Closes the condition `key` names, so a later recurrence raises a new row. */
  resolve(key: string): void;
  /** The last `display_status` this laptop saw for an agent, or null. */
  seenStatus(fleet: string | null, agent: string): string | null;
  setSeenStatus(fleet: string | null, agent: string, status: string): void;
  forgetSeen(fleet: string | null, agent: string): void;
}

export interface NotificationDeps {
  store: NotificationStore;
  /** The `fleet_id` this `Hermetic` was opened as; null before one is chosen. */
  fleet: () => string | null;
  /** When supplied, instance alerts are visible only for this local opt-in set. */
  instances?: () => readonly string[];
}

/** Short, random, and typed back by an operator exactly once (`inbox ack <id>`). */
export function mintNotificationId(): string {
  return randomUUID().replaceAll("-", "").slice(0, 12);
}

/** The same shape `fleets.ts` validates with: a `VALIDATION` refusal, never a raw zod throw. */
function parse<T>(
  schema: { safeParse(v: unknown): { success: true; data: T } | { success: false; error: unknown } },
  input: unknown,
  what: string,
): T {
  const result = schema.safeParse(input);
  if (result.success) return result.data;
  const issues = (result.error as { issues?: { path: PropertyKey[]; message: string }[] }).issues;
  throw new HermeticError("VALIDATION", `${what} input does not validate`, {
    issues: (issues ?? []).map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`),
  });
}

/**
 * The three public methods (§9). Each is a read or a write of the local store
 * and nothing else — no AWS, no account guard — which is what makes `inbox`
 * answerable on a laptop whose fleet is unreachable.
 */
export function createNotifications(deps: NotificationDeps) {
  return {
    list: (input: unknown = {}): Promise<NotificationsListResult> =>
      Promise.resolve(notificationsList(deps, input)),
    ack: (input: unknown): Promise<NotificationsAckResult> =>
      Promise.resolve(notificationsAck(deps, input)),
    mute: (input: unknown): Promise<NotificationsMuteResult> =>
      Promise.resolve(notificationsMute(deps, input)),
  };
}

export function notificationsList(
  deps: NotificationDeps,
  input: unknown = {},
): NotificationsListResult {
  const parsed = parse(NotificationsListInput, input, "inbox");
  const fleet = deps.fleet();
  const instances = deps.instances?.();
  const counts = deps.store.counts(fleet, instances);
  return {
    notifications: deps.store.list(parsed, fleet, instances),
    unread: counts.unread,
    needs_action: counts.needs_action,
    mutes: deps.store.mutes(),
  };
}

export function notificationsAck(deps: NotificationDeps, input: unknown): NotificationsAckResult {
  const parsed = parse(NotificationsAckInput, input, "inbox ack");
  return { acked: deps.store.ack(parsed, deps.fleet()) };
}

export function notificationsMute(deps: NotificationDeps, input: unknown): NotificationsMuteResult {
  const parsed = parse(NotificationsMuteInput, input, "inbox mute");
  const source = parsed.source;
  const target =
    parsed.agent !== undefined
      ? agentMuteTarget(parsed.agent)
      : sourceMuteTarget(source as NotificationSource);
  if (parsed.clear === true) deps.store.unmute(target);
  else deps.store.mute(target);
  return { mutes: deps.store.mutes() };
}

// --- source: agent.health ---------------------------------------------------

/**
 * The display statuses that mean something is wrong *now* (§4.9).
 * Lifecycle statuses — `creating`, `stopping`, `stopped`, `destroyed` — are op
 * outcomes and notify through the other source, so a transition into one of
 * them is recorded and says nothing.
 */
const BAD_STATUSES: readonly DisplayStatus[] = ["degraded", "error", "unreachable"];

function isBad(status: string | null): boolean {
  return status !== null && (BAD_STATUSES as readonly string[]).includes(status);
}

/**
 * What the row says about *why*, in one short line: how stale the heartbeat is
 * and which of the four checks the box last failed. Null when the agent has
 * said nothing at all, which is its own kind of answer and better left to the
 * title than dressed up as a detail.
 */
function healthDetail(agent: AgentView): string | null {
  const parts: string[] = [];
  const age = agent.heartbeat_age_ms;
  if (typeof age === "number") parts.push(`last heartbeat ${formatElapsedMs(age)} ago`);
  const failing = Object.entries(agent.health ?? {})
    .filter(([, ok]) => ok === false)
    .map(([check]) => check);
  if (failing.length > 0) parts.push(`failing: ${failing.join(", ")}`);
  return parts.length === 0 ? null : parts.join(" - ");
}

/**
 * The fleet scan's half of the inbox. Core's scan is stateless and the only
 * "previous status" anywhere was an in-memory map in the server's poller —
 * which would leave the CLI blind and lose every transition across a restart —
 * so the last status seen per agent is kept in the local store and diffed here.
 *
 * A flap produces two rows; there is deliberately no debounce in v1, because a
 * flapping agent is the thing the operator most needs to see.
 */
export function observeHealth(deps: NotificationDeps, agents: readonly AgentView[]): void {
  try {
    const fleet = deps.fleet();
    for (const agent of agents) {
      const current = agent.display_status;
      /**
       * A destroyed agent is forgotten rather than recorded: the next agent to
       * carry that name is a different box, and comparing it against the dead
       * one's last status would raise a transition nothing performed.
       */
      if (current === "destroyed") {
        deps.store.forgetSeen(fleet, agent.name);
        continue;
      }
      const previous = deps.store.seenStatus(fleet, agent.name);
      deps.store.setSeenStatus(fleet, agent.name, current);
      // First sighting is recorded silently: there is no transition to report.
      if (previous === null || previous === current) continue;

      if (!isBad(previous) && isBad(current)) {
        deps.store.insert({
          source: "agent",
          kind: "agent.health",
          class: "bad",
          title: `${agent.name} went ${current}`,
          detail: healthDetail(agent),
          agent: agent.name,
          fleet,
          actions: [{ label: "Probe", target: "agent", ref: agent.name }],
        });
      } else if (isBad(previous) && current === "ready") {
        deps.store.insert({
          source: "agent",
          kind: "agent.health",
          class: "ok",
          title: `${agent.name} recovered`,
          detail: `was ${previous}`,
          agent: agent.name,
          fleet,
          actions: [{ label: "Open", target: "agent", ref: agent.name }],
        });
      }
    }
  } catch {
    // The inbox is a courtesy; an unwritable one never fails a scan (rule 1).
  }
}

// --- source: fleet.advisory ---------------------------------------------------

/**
 * Advisories are *conditions*, not events (§4.9). A condition
 * notifies once while it holds and resolves when a scan no longer sees it, and
 * the `key` is what makes both true: it is unique among unresolved rows, so the
 * second scan finds the row the first one wrote instead of shouting again.
 *
 * ### The key scheme
 *
 * ```
 * fleet.advisory:<family>            a condition the fleet has at most one of
 * fleet.advisory:<family>:<item>     one row per item, so clearing one clears one
 * ```
 *
 * The four families this phase delivers:
 *
 * | Key | Raised while |
 * |---|---|
 * | `fleet.advisory:foundation_update` | `foundation.status` reports `update_available` |
 * | `fleet.advisory:bedrock_grant:<model id>` | the model is named in this fleet and the stack does not grant it |
 * | `fleet.advisory:loose_volume:<volume id>` | the volume is free and no live agent row names it |
 * | `fleet.advisory:profile_revision:<agent>` | the profile the agent is pinned to has moved past its pinned revision |
 *
 * A family owns every key equal to `fleet.advisory:<family>` or beginning
 * `fleet.advisory:<family>:`, which is why the separator is required rather
 * than a bare prefix match — `loose_volume` must not own `loose_volumes`.
 */
export const ADVISORY_PREFIX = "fleet.advisory:";

export const ADVISORY_FOUNDATION_UPDATE = "foundation_update";
export const ADVISORY_BEDROCK_GRANT = "bedrock_grant";
export const ADVISORY_LOOSE_VOLUME = "loose_volume";
export const ADVISORY_PROFILE_REVISION = "profile_revision";

/** One held condition, as the scan that found it describes it. */
export interface Advisory {
  /** The full key, `ADVISORY_PREFIX` included. */
  key: string;
  class: NotificationClass;
  title: string;
  detail?: string | null;
  agent?: string | null;
  ref?: string | null;
  actions: NotificationAction[];
}

/**
 * How long a volume has been free, in the largest unit that still says
 * something. `formatElapsedMs` tops out at hours, which is right for an op that
 * took four minutes and useless for a disk that has been idle since March.
 */
function formatFreeFor(ms: number): string {
  return ms >= DAY_MS ? `${Math.floor(ms / DAY_MS)}d` : formatElapsedMs(ms);
}

function advisoryKey(family: string, item?: string): string {
  return item === undefined ? `${ADVISORY_PREFIX}${family}` : `${ADVISORY_PREFIX}${family}:${item}`;
}

/**
 * Reconcile one family of advisories against what a scan just saw.
 *
 * Both directions in one pass, which is the whole point: every held condition
 * is inserted (a no-op for one that already has an open row, by the `key`
 * rule), and every open row of this family the scan did *not* report is
 * resolved. A later recurrence writes a new row rather than reviving the old
 * one, so the inbox keeps the history of a condition that came back.
 *
 * A family is reconciled only by a scan that can see all of it. A caller that
 * could not compute the condition — `foundation.status` against a fleet that
 * records no Bedrock grant, say — must not call this with an empty list, or
 * "not compared" would resolve as "nothing wrong".
 *
 * Never throws, for the reason `observeHealth` does not: the inbox is a
 * courtesy, and a scan is not the place to spend a fleet on one.
 */
export function observeAdvisories(
  deps: NotificationDeps,
  family: string,
  holding: readonly Advisory[],
): void {
  try {
    const fleet = deps.fleet();
    const owned = `${ADVISORY_PREFIX}${family}`;
    const held = new Set(holding.map((a) => a.key));
    for (const advisory of holding) {
      deps.store.insert({
        source: "fleet",
        kind: "fleet.advisory",
        class: advisory.class,
        title: advisory.title,
        detail: advisory.detail ?? null,
        agent: advisory.agent ?? null,
        fleet,
        ref: advisory.ref ?? null,
        key: advisory.key,
        actions: advisory.actions,
      });
    }
    // Every open key this family owns, whatever else the inbox has collected
    // since: a reconciliation that read a window of the newest rows could not
    // resolve a condition older rows had pushed out of it.
    for (const key of deps.store.openKeys(owned, fleet)) {
      if (held.has(key)) continue;
      deps.store.resolve(key);
    }
  } catch {
    // The inbox is a courtesy; an unwritable one never fails a scan (rule 1).
  }
}

/**
 * The fleet is behind this build's foundation (§6.6).
 *
 * `needs_action`: the fix is a command only a person runs (`hermetic foundation
 * update`), it is the one advisory the design gives the gold badge, and it
 * gates everything a newer contract adds. Nothing is broken, but nothing else
 * will move it either.
 */
export function foundationUpdateAdvisories(input: {
  update_available: boolean;
  current: {
    foundation_version: number;
    template_sha256: string | null;
    hermeticd_version: string | null;
  };
  available: { foundation_version: number; template_sha256: string; hermeticd_version: string };
}): Advisory[] {
  if (!input.update_available) return [];
  const { current, available } = input;
  /**
   * Which of the three comparisons `update_available` is true for, because the
   * flag is an OR and "you are on v7, this build ships v7" is what a row that
   * assumed the version case would say about a changed template.
   */
  const reasons: string[] = [];
  if (current.foundation_version < available.foundation_version) {
    reasons.push(
      `on v${current.foundation_version}, this build ships v${available.foundation_version}`,
    );
  }
  if (current.template_sha256 !== available.template_sha256) {
    reasons.push("the foundation template has changed");
  }
  if (current.hermeticd_version !== available.hermeticd_version) {
    reasons.push(
      `hermeticd ${current.hermeticd_version ?? "unknown"} to ${available.hermeticd_version}`,
    );
  }
  return [
    {
      key: advisoryKey(ADVISORY_FOUNDATION_UPDATE),
      class: "needs_action",
      title: "Foundation update available",
      detail: reasons.length === 0 ? null : reasons.join("; "),
      actions: [{ label: "Review", target: "foundation" }],
    },
  ];
}

/**
 * A model this fleet names that its own instance role may not invoke (§8.3).
 *
 * `needs_action`: unlike the others this one is a live failure — every turn on
 * that model answers `AccessDeniedException` — and the only thing that clears
 * it is a `foundation update` reconciling the grant. One row per model, so
 * granting one of two stops asking about it and goes on asking about the other.
 *
 * A model id is a public catalog name, never a credential, so it is safe in a
 * title (§8.3, and the leak-grep test over captured output).
 */
export function bedrockGrantAdvisories(stale: readonly string[]): Advisory[] {
  return stale.map((model) => ({
    key: advisoryKey(ADVISORY_BEDROCK_GRANT, model),
    class: "needs_action" as const,
    title: `Bedrock model ${model} is not granted`,
    detail:
      "this fleet's instance role cannot invoke it; `hermetic foundation update` reconciles the grant",
    ref: model,
    actions: [{ label: "Review", target: "foundation" as const }],
  }));
}

/**
 * A volume that is free and that no live agent row names (§9.1, group
 * `no_agent`).
 *
 * `info`: nothing is broken and nothing is waiting on a person — it is money
 * being spent on memory nobody is reading, which is worth seeing in a list and
 * never worth a gold badge. Deliberately *not* the `detached` group: a live
 * agent still owns those, and offering them as loose would be offering somebody
 * else's memory for deletion.
 */
export function looseVolumeAdvisories(volumes: readonly VolumeView[]): Advisory[] {
  return volumes
    .filter((v) => v.group === "no_agent")
    .map((v) => {
      const free = v.free_for_ms === null ? null : `free for ${formatFreeFor(v.free_for_ms)}`;
      const cost = `$${v.monthly_cost_usd.toFixed(2)}/mo`;
      const parts = [`${v.size_gib} GiB in ${v.availability_zone}`, free, cost].filter(
        (p): p is string => p !== null,
      );
      return {
        key: advisoryKey(ADVISORY_LOOSE_VOLUME, v.volume_id),
        class: "info" as const,
        title: `${v.volume_id} has no agent`,
        detail: parts.join(" - "),
        ref: v.volume_id,
        actions: [{ label: "Volumes", target: "volumes" as const }],
      };
    });
}

/**
 * The provider profile an agent is pinned to has moved since it was pinned
 * (§8.3, `profileUpdateAvailable`).
 *
 * `info`: a profile edit is explicitly *not* an instruction to restart
 * somebody's agent — nothing stages the roll, and the agent is serving
 * correctly on the revision it holds. One row per agent, because rolling one
 * of five is a normal afternoon and the other four should go on asking.
 *
 * Profile *names* are operator-chosen labels; the key behind them never leaves
 * SSM and is not read here.
 */
export function profileRevisionAdvisories(
  agents: readonly AgentView[],
  settings?: FleetSettings,
): Advisory[] {
  const out: Advisory[] = [];
  for (const agent of agents) {
    // A destroyed row is kept forever (§4.3) and is nobody's rollout.
    if (agent.update_available !== true || agent.display_status === "destroyed") continue;
    const profile = agent.profile_id === undefined ? undefined : settings?.profiles?.[agent.profile_id];
    const detail =
      profile === undefined || agent.profile_revision === undefined
        ? null
        : `profile ${profile.name} is at r${profile.revision}; ${agent.name} is on r${agent.profile_revision}`;
    out.push({
      key: advisoryKey(ADVISORY_PROFILE_REVISION, agent.name),
      class: "info",
      title: `${agent.name} is on an older provider profile revision`,
      detail,
      agent: agent.name,
      actions: [{ label: `Open ${agent.name}`, target: "agent", ref: agent.name }],
    });
  }
  return out;
}

// --- source: chat.message / chat.error ---------------------------------------

/**
 * Chat as a notification source (§4.9, §9.2).
 *
 * The hard question here is not *how* but *when*, because a notification about
 * something the operator is already watching is noise, and noise is how an
 * inbox stops being read. Two rules answer it, and they are deliberately
 * asymmetric.
 *
 * **A reply the caller is streaming raises nothing.** `chat.send` hands frames
 * to whoever asked for them; by the time a row could be written the answer is
 * already on that operator's screen or in their terminal. So `chat.message` is
 * never raised from a turn — it is raised from the *roster read*, by noticing
 * that a bot's last message is newer than the last one this laptop saw. That is
 * precisely §9.2's "Origin" case: a cron routine, a messaging channel, a peer
 * bot or somebody else's Hermes client moved the transcript on, and nobody here
 * asked for it. It is also the only case hermetic can observe at all, since
 * hermetic is not attached to a turn it did not start.
 *
 * Saying that is not enough to make it true, and `markChatTurn` is the half
 * that makes it structural rather than aspirational. A turn the caller streamed
 * *does* move the box's transcript on, so the very next roster read would find
 * a newer timestamp and write a row about the reply the operator just watched
 * arrive — one per turn, forever, with the toast rule suppressing only the
 * toast and not the row or the unread count. The turn therefore advances the
 * watermark itself, and the roster read that follows sees nothing new.
 *
 * **A failed turn always raises a row**, because the operator asked for
 * something and did not get it, and unlike a reply that failure has no other
 * durable home: the stream is gone the moment the head stops reading it. Whether
 * that row is allowed to *interrupt* is a separate question and a separate
 * layer's — the portal suppresses a toast for a thread it can see is open and
 * focused (`notification-logic.ts`), which is a fact no process on this side of
 * the browser knows.
 *
 * ### Nothing here reads a message
 *
 * Neither title nor detail is ever built from message text. A `chat.message`
 * row says which bot on which box spoke and when; a `chat.error` row carries a
 * code and the failure's own message, which `chat.ts` has already masked
 * (§9.2). Even that is belt-and-braces — the roster read these rows are derived
 * from went through `redactDeep` before it reached this module — but the rule
 * is worth stating as a rule rather than as a property of today's call sites: a
 * notification is written to a local database and read back long after the
 * conversation it is about, and it is the last place a secret should be able to
 * come to rest.
 */

/** The `key` family for a reply that arrived on its own. */
export const CHAT_MESSAGE_PREFIX = "chat.message:";

/** The `key` family for a turn that failed. */
export const CHAT_ERROR_PREFIX = "chat.error:";

/**
 * A `key` is unique among unresolved rows **across every fleet**, so every key
 * this module writes names its fleet.
 *
 * The store's dedupe is `WHERE key = ? AND resolved_at IS NULL` with no fleet
 * clause, and `resolve(key)` closes every row holding that key wherever it came
 * from. Two fleets each running an agent called `atlas` would therefore share
 * one `chat.error:atlas/default:CHAT_UNREACHABLE`: the second fleet's failure
 * would be swallowed while the first fleet's row was open, and a turn that
 * recovered in the first would resolve the second's. Going off the tailnet
 * breaks every fleet at once, so that is reachable on the first outage rather
 * than being a curiosity.
 *
 * `-` stands in for a row raised before a fleet was chosen. A fleet id is
 * `[a-z0-9]{8}` and an agent name matches `AGENT_NAME_RE`, so neither can
 * contain the `:` this scheme separates on.
 */
function chatKeyScope(fleet: string | null, instance: string, bot: string): string {
  return `${fleet ?? "-"}:${chatActionRef(instance, bot)}`;
}

/**
 * The subject the watermark is filed under in the seen table.
 *
 * `agent_status_seen` is a `(fleet, subject) -> string` map that the fleet scan
 * happened to be the first user of; storing the chat watermark there rather
 * than adding a second table of identical shape is the smaller change, and it
 * is safe rather than merely convenient. An agent name matches `AGENT_NAME_RE`,
 * which admits only `[a-z0-9-]`, so a `chat:`-prefixed subject provably cannot
 * collide with the agent name the health source files under. The table is keyed
 * by fleet, so these need no fleet scoping the way the row keys above do.
 *
 * **A destroyed box's watermarks are left behind, and that is a known cost.**
 * `observeHealth` forgets a destroyed agent by name, and the store offers no
 * way to forget a *prefix*, so `chat:<name>/<bot>` survives. If that name is
 * later reused, the new box's first message is compared against the dead box's
 * watermark and notifies, where a genuine first sighting would have been
 * silent. That is right when the volume was reattached — the conversation
 * really did continue — and wrong when it was not. Fixing it properly needs a
 * `forgetSeen` that takes a prefix, which is a change to the SQLite store.
 */
export function chatSeenSubject(instance: string, bot: string): string {
  return `chat:${instance}/${bot}`;
}

/**
 * The watermark for a bot that has been seen and has never said anything.
 *
 * Without it, a bot whose `last_message_at` is null records nothing, so its
 * *first real message* reads as a first sighting and is silently swallowed —
 * which is the one message a newly created bot has, and exactly the case the
 * feature exists for. Not a valid ISO timestamp, so it can never be mistaken
 * for one.
 */
const CHAT_SEEN_SILENT = "-";

/** Whether `a` is later than `b`, by time and not by spelling. */
function laterThan(a: string, b: string): boolean {
  const ta = Date.parse(a);
  const tb = Date.parse(b);
  /**
   * `Iso` admits both `…:00Z` and `…:00.500Z`, and a string compare of mixed
   * precision is wrong in both directions. The lexical fallback is for a value
   * neither side can parse, where the spelling is the only ordering there is.
   */
  if (Number.isNaN(ta) || Number.isNaN(tb)) return a > b;
  return ta > tb;
}

/** The one bot of one box, as the roster read describes it. */
export interface ChatActivity {
  instance: string;
  bot: string;
  /** The bot's own title, already masked. Null when the box gave none. */
  title?: string | null;
  /** When that bot last said anything. Null for a bot that never has. */
  last_message_at?: string | null;
  /** The box says this bot is waiting on a person. */
  needs_action?: boolean;
}

/**
 * Diff a roster read against the watermark, and raise a row per bot that moved.
 *
 * The shape is `observeHealth`'s, for the same reasons: the first sighting of a
 * bot is recorded silently — a portal that has just started has no business
 * announcing a conversation from last Tuesday — and the watermark is persisted
 * rather than held in a closure, so restarting the portal does not re-announce
 * everything it already told the operator about.
 *
 * The watermark only ever **advances**. A box whose clock is behind, or a
 * transcript read that answers with an older session, must not be able to lower
 * it — lowering it would make the next message look new a second time — and a
 * box whose clock runs ahead must not be able to raise it past messages that
 * have not happened yet, which would swallow them.
 *
 * The `key` carries the timestamp as well as the bot, which is what makes the
 * write idempotent across two heads watching one fleet: the CLI's `bots ls` and
 * the portal's poll both see `atlas/researcher` at `09:31:40`, and the second
 * one through finds the row the first wrote. A *newer* message is a different
 * key and therefore a new row, which is right — these are events, and unlike an
 * advisory nothing ever resolves them. Reading the thread is what clears them,
 * and reading is `read_at`, the operator's own acknowledgement.
 *
 * Only what the caller passes is considered. An unreachable box contributes no
 * bots, so it moves no watermark and raises nothing — silence is not evidence
 * that a bot said something, and it is not evidence that it did not.
 */
export function observeChatActivity(deps: NotificationDeps, bots: readonly ChatActivity[]): void {
  let fleet: string | null;
  try {
    fleet = deps.fleet();
  } catch {
    // The inbox is a courtesy; an unwritable one never fails a roster read.
    return;
  }
  for (const bot of bots) {
    /**
     * Per bot, not per roster. One `try` around the whole loop meant a store
     * that threw on one bot's insert abandoned every bot after it — after the
     * watermarks they had already moved past, so those messages were never
     * news again. A failure is now one bot's failure.
     */
    try {
      const subject = chatSeenSubject(bot.instance, bot.bot);
      const previous = deps.store.seenStatus(fleet, subject);
      const at = bot.last_message_at;
      if (at == null || at === "") {
        // Seen, and said nothing. Recorded, so that the first thing it does say
        // is a transition rather than a first sighting.
        if (previous === null) deps.store.setSeenStatus(fleet, subject, CHAT_SEEN_SILENT);
        continue;
      }
      if (previous === null) {
        // First sighting of a bot that has already spoken: record where it is
        // up to and say nothing about a conversation that predates this laptop.
        deps.store.setSeenStatus(fleet, subject, at);
        continue;
      }
      if (previous !== CHAT_SEEN_SILENT && !laterThan(at, previous)) continue;
      // Raise the row *before* moving the watermark. The other order loses a
      // message outright when the insert fails: the watermark says the operator
      // has been told, and nothing will ever tell them.
      deps.store.insert({
        source: "chat",
        kind: "chat.message",
        /**
         * `needs_action` when the box says the bot is waiting on a person, so a
         * question asked by a cron run reaches the gold badge rather than
         * sitting in the same colour as small talk. Everything else is `info`:
         * a reply is not a problem, and `warn` would put a colour on a
         * conversation going normally.
         */
        class: bot.needs_action === true ? "needs_action" : "info",
        // The display name when the roster gave one: `default` is the profile
        // that is `$HERMES_HOME`, and an inbox row about "default" names nothing
        // the operator recognises. The instance stays either way — one fleet has
        // many boxes and each box has a bot called `default`.
        title: `${bot.title ?? bot.bot} on ${bot.instance} has a new message`,
        /**
         * The profile behind the display name, and only when the two differ —
         * repeating the title under itself says nothing. Still not a word of
         * what the bot said: the row names the conversation, never its
         * contents.
         */
        detail: bot.title && bot.title !== bot.bot ? bot.bot : null,
        agent: bot.instance,
        fleet,
        ref: chatActionRef(bot.instance, bot.bot),
        key: `${CHAT_MESSAGE_PREFIX}${chatKeyScope(fleet, bot.instance, bot.bot)}:${at}`,
        actions: [
          { label: "Open chat", target: "chat", ref: chatActionRef(bot.instance, bot.bot) },
          { label: `Open ${bot.instance}`, target: "agent", ref: bot.instance },
        ],
      });
      deps.store.setSeenStatus(fleet, subject, at);
    } catch {
      // The inbox is a courtesy; an unwritable one never fails a roster read.
      // Swallowed per bot, so the next bot is still read.
    }
  }
}

/** The `key` family for a background-process event worth telling the operator about. */
export const CHAT_EVENT_PREFIX = "chat.event:";

/** The longest title an event row writes; a DM reply's first line can be a paragraph. */
const CHAT_EVENT_TITLE_MAX = 140;

/**
 * A background-process event (§9.2) that deserves a row: a failed command, a
 * subagent result, or a DM reply from another bot.
 *
 * Hermes injects these as `user`-role rows, and core turns them into
 * `process_event` blocks on a `system` message (`chat/hermes/process-notice.ts`).
 * They are never an operator message, so nothing in the roster-driven
 * `observeChatActivity` may treat one as somebody typing, and a routine event
 * — a clean exit, a termination, a watch match, a notice — never raises a row
 * at all (`isRoutineProcessEvent`): the thread shows those, the inbox does not.
 *
 * The row is keyed on the process id (the delegation id, else `fallbackId`, the
 * message's own id, for a notice that carries neither), so a history read that
 * sees the same row on every poll writes it once. The store's dedupe is
 * "same key, still unresolved", which means reading the thread (`read_at`)
 * closes it and the same event is not raised again afterwards.
 *
 * This is the one place a row is worded from a message, and the `block` it
 * takes must already be past `redactDeep` — the history read is. The title is
 * one line, truncated, and never the output.
 *
 * Returns whether a row was requested, so a caller can count. A store that
 * throws is swallowed, as everywhere else in this file.
 *
 * TODO(evan): nothing calls this yet, because core has no read of a thread
 * no head is watching. `chat-observe.ts` only reads watched conversations and
 * by §4.9 writes no inbox row (the roster diff is `chat.message`'s one
 * source), and the roster itself carries no rows — only the box's
 * `last_active`, which is the newest row of any kind, notice or not, so it
 * cannot skip one. Wiring this needs either a per-bot durable read on the
 * roster poll or a §4.9 change letting observation raise rows; both are design
 * decisions, not plumbing. In practice a notice wakes the bot, which replies,
 * so the roster's "has a new message" is usually about that reply.
 */
export function notifyProcessEvent(
  deps: NotificationDeps,
  where: { instance: string; bot: string },
  block: ProcessEventBlock,
  fallbackId: string,
): boolean {
  if (isRoutineProcessEvent(block)) return false;
  try {
    const fleet = deps.fleet();
    const ref = chatActionRef(where.instance, where.bot);
    const identity = block.process_id ?? block.delegation?.id ?? fallbackId;
    const sentence = processEventSentence(block);
    deps.store.insert({
      source: "chat",
      kind: "chat.message",
      // A failure is a problem; a DM reply is news. Neither is `needs_action`:
      // nothing is waiting on an answer from a person.
      class: block.outcome === "failed" ? "bad" : "info",
      title:
        sentence.length > CHAT_EVENT_TITLE_MAX
          ? `${sentence.slice(0, CHAT_EVENT_TITLE_MAX - 1).trimEnd()}…`
          : sentence,
      detail: `${where.bot} on ${where.instance}`,
      agent: where.instance,
      fleet,
      ref,
      key: `${CHAT_EVENT_PREFIX}${chatKeyScope(fleet, where.instance, where.bot)}:${identity}`,
      actions: [
        { label: "Open chat", target: "chat", ref },
        { label: `Open ${where.instance}`, target: "agent", ref: where.instance },
      ],
    });
    return true;
  } catch {
    // The inbox is a courtesy; an unwritable one never fails a history read.
    return false;
  }
}

/**
 * A turn this laptop drove has finished, so the message it produced is not news.
 *
 * Without this the source contradicts its own rule the moment the adapter
 * reports a real `last_message_at`: the reply the operator just watched arrive
 * is, to the next roster read, a transcript that has moved on. Suppressing the
 * toast would not be enough — the row and the unread count would still be
 * there, one per turn.
 *
 * `at` **must be the box's own coordinate for this bot** — the timestamp
 * `observeChatActivity` compares against — attributed to this turn by the
 * caller. It used to be the laptop's clock at the end of the turn, and that was
 * the defect: this function and the roster read then held two different clocks
 * against each other, so a box running slightly ahead raised a row about the
 * reply the operator had just watched arrive, and one running slightly behind
 * swallowed a message that landed during the turn. The two clocks are never
 * compared and never max()-ed; `chat.ts`'s `boxCoordinate` reads the box's and
 * declines to call this at all when it cannot attribute one.
 *
 * Advance-only, for `observeChatActivity`'s reasons, so a turn cannot lower a
 * watermark a roster read has already moved past.
 */
export function markChatTurn(
  deps: NotificationDeps,
  where: { instance: string; bot: string },
  at: string,
): void {
  try {
    const fleet = deps.fleet();
    const subject = chatSeenSubject(where.instance, where.bot);
    const previous = deps.store.seenStatus(fleet, subject);
    if (previous !== null && previous !== CHAT_SEEN_SILENT && !laterThan(at, previous)) return;
    deps.store.setSeenStatus(fleet, subject, at);
  } catch {
    // As everywhere else here: recording is never what fails a turn.
  }
}

/**
 * A turn that failed, as a condition rather than as an event.
 *
 * The distinction earns its keep the first time a laptop drops off the tailnet:
 * every send answers `CHAT_UNREACHABLE`, and an operator who retries four times
 * would otherwise collect four identical rows about one broken thing. The key
 * is the fleet, the bot *and the code*, so a different failure against the same
 * bot — the box came back but the model refused — is a different row and still
 * gets said.
 *
 * `message` must already be masked. Every call site is inside `chat.ts`, which
 * is the redaction door (§9.2); this function is not a second one.
 */
export function notifyChatError(
  deps: NotificationDeps,
  where: { instance: string; bot: string },
  failure: { code: string; message: string },
): void {
  try {
    const fleet = deps.fleet();
    const ref = chatActionRef(where.instance, where.bot);
    deps.store.insert({
      source: "chat",
      kind: "chat.error",
      class: "bad",
      title: `${where.bot} on ${where.instance} could not answer`,
      detail: `${failure.code} - ${failure.message}`,
      agent: where.instance,
      fleet,
      ref,
      key: `${CHAT_ERROR_PREFIX}${chatKeyScope(fleet, where.instance, where.bot)}:${failure.code}`,
      actions: [
        { label: "Open chat", target: "chat", ref },
        { label: `Open ${where.instance}`, target: "agent", ref: where.instance },
      ],
    });
  } catch {
    // Same bargain: a turn is never failed by the inbox failing to record it.
  }
}

/**
 * A turn against this bot completed, so whatever was stopping them has stopped.
 *
 * Resolution is per bot and covers every code, because the codes are not
 * independent conditions — the box being unreachable and the box having no warm
 * slot are two readings of one thread being unusable, and a turn that got an
 * answer has disproved all of them at once.
 *
 * The separator rule is `openKeys`'s own: `chat.error:<fleet>:atlas/default`
 * owns `chat.error:<fleet>:atlas/default:CHAT_UNREACHABLE` and not
 * `chat.error:<fleet>:atlas/default-2:…`, and never another fleet's rows at
 * all. A bot whose *name* contains a colon could in principle be owned by a
 * shorter sibling's prefix; upstream names bots after profile directories,
 * hermetic does not validate them, and the cost if it ever happened is one row
 * resolved early rather than a wrong row written.
 */
export function resolveChatErrors(
  deps: NotificationDeps,
  where: { instance: string; bot: string },
): void {
  try {
    const fleet = deps.fleet();
    const owned = `${CHAT_ERROR_PREFIX}${chatKeyScope(fleet, where.instance, where.bot)}`;
    for (const key of deps.store.openKeys(owned, fleet)) deps.store.resolve(key);
  } catch {
    // As above.
  }
}

// --- source: operation.failed / operation.done -------------------------------

/**
 * The verb an operator would use for a settled op, keyed on the core method.
 *
 * `apply` is deliberately not mapped to `destroy`: an applied plan may be a
 * teardown, a foundation update or a network switch, and a row that named the
 * wrong one would be worse than a row that names the method.
 */
const OP_VERBS: Readonly<Record<string, string>> = {
  init: "init",
  teardown: "teardown",
  upgrade: "upgrade",
  apply: "apply",
  "plan.destroy": "destroy",
  "foundation.update": "foundation update",
  "agents.create": "create",
  "agents.recreate": "recreate",
  "agents.destroy": "destroy",
  "agents.stop": "stop",
  "agents.start": "start",
  "agents.rerun": "rerun",
};

export function opVerb(method: string): string {
  return OP_VERBS[method] ?? method;
}

/** `41s`, `7m41s`, `3h07m`. Short enough to sit inside a one-line detail. */
export function formatElapsedMs(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  const seconds = total % 60;
  const minutes = Math.floor(total / 60) % 60;
  const hours = Math.floor(total / 3600);
  if (hours > 0) return `${hours}h${String(minutes).padStart(2, "0")}m`;
  if (minutes > 0) return `${minutes}m${String(seconds).padStart(2, "0")}s`;
  return `${seconds}s`;
}

export interface SettledRun {
  id: string;
  command: string;
  agent: string | null;
  started_at: string;
}

export interface SettledOp {
  /** Dotted core method, e.g. `agents.create`. */
  method: string;
  /** Present exactly when the op failed. */
  error?: { code: string; message: string };
}

/**
 * The op half of the inbox, written where both heads already meet: a run that
 * has just been finalised (§4.9). `OpRegistry` is server-only, so
 * "from the registry" could not have been the source — a `hermetic agent
 * create` from the CLI has to raise the same row.
 *
 * The head says only *which* op settled and how; the wording is core's, so the
 * two heads cannot drift into describing the same failure differently.
 */
export function notifyOpSettled(
  store: NotificationStore,
  fleet: string | null,
  run: SettledRun,
  op: SettledOp,
  now: () => number = Date.now,
): void {
  try {
    const verb = opVerb(op.method);
    const agent = run.agent;
    const actions: NotificationAction[] = [{ label: "Details", target: "run", ref: run.id }];
    if (op.method.startsWith("agents.") && agent !== null) {
      actions.push({ label: `Open ${agent}`, target: "agent", ref: agent });
    }
    if (op.error) {
      store.insert({
        source: "operation",
        kind: "operation.failed",
        class: "bad",
        title: agent === null ? `${verb} failed` : `${verb} failed - ${agent}`,
        // §8.3: an error's code and message are already safe to write down.
        detail: `${op.error.code} - ${op.error.message}`,
        agent,
        fleet,
        ref: run.id,
        actions,
      });
      return;
    }
    const started = Date.parse(run.started_at);
    const detail = Number.isNaN(started) ? null : formatElapsedMs(now() - started);
    store.insert({
      source: "operation",
      kind: "operation.done",
      class: "ok",
      title: agent === null ? `${verb} finished` : `${agent} ${verb} finished`,
      detail,
      agent,
      fleet,
      ref: run.id,
      actions,
    });
  } catch {
    // Same bargain as `observeHealth`: recording is never what fails a run.
  }
}

// --- the store a home without one gets ---------------------------------------

/**
 * An inbox that lives only in this process. Tests and any `Hermetic` built
 * without a local database get one, for the reason `MemoryRunStore` exists
 * (§4.6): losing the log costs the log, never the fleet.
 */
export class MemoryNotificationStore implements NotificationStore {
  private readonly rows: Notification[] = [];
  private readonly muted = new Map<string, string>();
  private readonly seen = new Map<string, string>();

  constructor(private readonly now: () => Date = () => new Date()) {}

  private muteOf(row: Pick<Notification, "agent" | "source">): boolean {
    if (row.agent != null && this.muted.has(agentMuteTarget(row.agent))) return true;
    return this.muted.has(sourceMuteTarget(row.source));
  }

  insert(row: NotificationInsert): Notification {
    if (row.key != null) {
      const open = this.rows.find((r) => r.key === row.key && r.resolved_at == null);
      if (open) return { ...open, muted: this.muteOf(open) };
    }
    const id = row.id ?? mintNotificationId();
    const existing = this.rows.find((r) => r.id === id);
    if (existing) return { ...existing, muted: this.muteOf(existing) };
    const created: Notification = {
      id,
      at: row.at ?? this.now().toISOString(),
      source: row.source,
      kind: row.kind,
      class: row.class,
      title: row.title,
      detail: row.detail ?? null,
      agent: row.agent ?? null,
      fleet_id: row.fleet ?? null,
      ref: row.ref ?? null,
      key: row.key ?? null,
      actions: row.actions ?? [],
      read_at: row.read_at ?? null,
      resolved_at: null,
      muted: false,
    };
    this.rows.push(created);
    const cutoff = new Date(this.now().getTime() - NOTIFICATION_RETENTION_DAYS * DAY_MS).toISOString();
    for (let i = this.rows.length - 1; i >= 0; i -= 1) {
      if ((this.rows[i] as Notification).at < cutoff) this.rows.splice(i, 1);
    }
    return { ...created, muted: this.muteOf(created) };
  }

  private forFleet(fleet: string | null): Notification[] {
    return this.rows.filter((r) => r.fleet_id == null || fleet === null || r.fleet_id === fleet);
  }

  list(
    input: NotificationsListInput,
    fleet: string | null,
    instances?: readonly string[],
  ): Notification[] {
    return this.forFleet(fleet)
      .filter((r) => !hiddenByListening(r, instances))
      .filter((r) => (input.unread === true ? r.read_at == null : true))
      .filter((r) => (input.since === undefined ? true : r.at > input.since))
      .sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0))
      .slice(0, input.limit)
      .map((r) => ({ ...r, muted: this.muteOf(r) }));
  }

  /**
   * The badge is about what still holds. A resolved advisory is still *in* the
   * inbox — the list returns it, and `read_at` stays the operator's own
   * acknowledgement (§4.9) rather than something the world sets for them —
   * but a condition that has cleared must stop asking for attention.
   */
  counts(
    fleet: string | null,
    instances?: readonly string[],
  ): { unread: number; needs_action: number } {
    const unread = this.forFleet(fleet).filter(
      (r) => r.read_at == null && r.resolved_at == null && !hiddenByListening(r, instances),
    );
    return {
      unread: unread.length,
      needs_action: unread.filter((r) => r.class === "needs_action").length,
    };
  }

  ack(input: { id?: string; all?: boolean }, fleet: string | null): number {
    const at = this.now().toISOString();
    const target =
      input.all === true
        ? this.forFleet(fleet).filter((r) => r.read_at == null)
        : this.rows.filter((r) => r.id === input.id && r.read_at == null);
    for (const row of target) row.read_at = at;
    return target.length;
  }

  mute(target: string): void {
    if (!this.muted.has(target)) this.muted.set(target, this.now().toISOString());
  }

  unmute(target: string): void {
    this.muted.delete(target);
  }

  mutes(): NotificationMute[] {
    return [...this.muted.entries()]
      .map(([target, at]) => ({ target, at }))
      .sort((a, b) => (a.target < b.target ? -1 : 1));
  }

  openKeys(prefix: string, fleet: string | null): string[] {
    const owned = (key: string): boolean => key === prefix || key.startsWith(`${prefix}:`);
    const keys = new Set<string>();
    for (const row of this.forFleet(fleet)) {
      if (row.key == null || row.resolved_at != null) continue;
      if (owned(row.key)) keys.add(row.key);
    }
    return [...keys];
  }

  resolve(key: string): void {
    const at = this.now().toISOString();
    for (const row of this.rows) {
      if (row.key === key && row.resolved_at == null) row.resolved_at = at;
    }
  }

  private seenKey(fleet: string | null, agent: string): string {
    return `${fleet ?? ""} ${agent}`;
  }

  seenStatus(fleet: string | null, agent: string): string | null {
    return this.seen.get(this.seenKey(fleet, agent)) ?? null;
  }

  setSeenStatus(fleet: string | null, agent: string, status: string): void {
    this.seen.set(this.seenKey(fleet, agent), status);
  }

  forgetSeen(fleet: string | null, agent: string): void {
    this.seen.delete(this.seenKey(fleet, agent));
  }
}
