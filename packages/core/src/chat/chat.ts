/**
 * The chat surface (§9.2): local listening preferences and methods to read
 * a box's roster, list a bot's conversations, read a transcript, take a turn and
 * stop one.
 *
 * Its own module with an explicit deps object, the shape `AgentLogsDeps` and
 * `NotificationDeps` use (AGENTS.md rule 5): nothing here needs the lifecycle's
 * closure — four things from it and nothing more — and `hermetic.ts` is at the
 * size where a new surface belongs beside it rather than inside it.
 *
 * Three rules hold everywhere below, and each of them is the reason a line is
 * where it is rather than one layer up or down.
 *
 * **This module never speaks Hermes.** Exactly one file knows what the box
 * answers with — `hermes-chat.ts`, injected as `deps.hermes` — and everything
 * here is in hermetic's own types from `schema/chat.ts`. That is what makes a
 * `hermes_ref` bump a one-file change rather than a renderer change (§4's "the
 * decision that makes the choice survivable").
 *
 * **This module is the redaction door.** Everything leaving here has been
 * through `chat-redact.ts` first — not the adapter, which would leave a second
 * door open the day something else calls it, and never the renderer, where a
 * new block kind would silently bypass it (§9.2).
 *
 * **The inbox is written here, not in the adapter.** `chat.message` comes from
 * the roster read and `chat.error` from a failed turn, and both are raised from
 * this module rather than one layer down for the same reason redaction is: the
 * adapter is one implementation of one transport, and a source wired into it
 * would stop delivering the day a second one exists. The *rules* — which of the
 * two to raise, and when — are in `notifications.ts` beside the other sources.
 *
 * **A turn is not an op.** `send` is an `AsyncIterable` with an `AbortSignal`,
 * per rule 2, and it is deliberately absent from `STREAMING_METHODS`: ops are
 * long, restartable, replayable and persisted in the registry, while a turn is a
 * live pipe to a process already running elsewhere. The precedent is
 * `GET /api/agents/:name/logs`, not `OpRegistry` (§9.2).
 */
import {
  ChatOpenInput,
  ChatCompactInput,
  ChatArchiveInput,
  ChatRespondInput,
  ChatAbortInput,
  ChatListeningInput,
  ChatListenInput,
  ChatHistoryInput,
  ChatObserveInput,
  ChatSendInput,
  ChatSessionsInput,
  ChatSwarmsInput,
  agentDashboardUrl,
  cloudName,
} from "../schema/index.ts";
import type {
  Agent,
  ChatConversation,
  ChatFrame,
  ChatMessage,
  ChatObserveEvent,
  FleetItem,
  LocalConfig,
  Session,
  Swarm,
} from "../schema/index.ts";
import type { StackInfo } from "../backend/types.ts";
import { redactDeep, redactMessage } from "./chat-redact.ts";
import { observeChatActivity } from "./notifications.ts";
import type { ChatActivity, NotificationDeps } from "./notifications.ts";
import { CHAT_CLASSIFY_LIMIT, classifyChatActivity } from "./chat-activity.ts";
import type { BoxAddress, HermesChatClient } from "./hermes/hermes-chat.ts";
import { MemoryChatFenceStore, chatFenced } from "./chat-fence.ts";
import type { ChatFenceStore } from "./chat-fence.ts";
import { MemoryInstanceListeningStore } from "./instance-listening.ts";
import type { InstanceListeningStore } from "./instance-listening.ts";
import { HermeticError } from "../errors.ts";

import { validateName } from "../shared/naming.ts";
import { parse, reasonOf, redactSessions, redactSwarm, sealed, unreachableSwarm } from "./chat-seal.ts";
import { createChatSend } from "./chat-send.ts";
import { createChatObserveWiring } from "./chat-observe-wiring.ts";

export { createDeltaGate, stableCut } from "./chat-gate.ts";
export type { DeltaGate } from "./chat-gate.ts";
export { defaultHermesChat, fixtureHermesChat } from "./chat-transport.ts";

/* ── which conversations this laptop started ──────────────────────────────── */

/**
 * The record of the sessions *this laptop* opened (§9.2).
 *
 * The box cannot answer this question, and that is not a gap to be closed. A
 * session hermetic opened over `/api/ws` and one the box's own TUI opened arrive
 * at the adapter identically; upstream's `source` field names a *kind of client*
 * rather than an installation, and `portal` is not among the values it can
 * produce. So the adapter maps nothing onto the `portal` origin, deliberately —
 * `portal` is the one value that silences the composer's destination warning,
 * and a warning that can be switched off by a string a box chose is not a
 * warning.
 *
 * What the laptop *does* know is which sessions it sent into. That is local
 * state, in the local SQLite beside `runs` and the inbox, and the fact that two
 * operators get different answers is the design rather than a defect: a session
 * this operator started is `portal` here and foreign on their colleague's
 * machine, because the colleague's reply really is going into a conversation
 * they did not open. **This table must never move to DynamoDB.**
 *
 * Absence means foreign, always. A fresh laptop, a deleted database, a pruned
 * row, a session somebody else started — every one of those has to produce the
 * warning, so every read here fails toward it.
 */
export interface LocalChatSessions {
  /** Record that this laptop sent into `session`. Idempotent. */
  remember(
    fleet: string | null,
    where: { instance: string; bot: string; session: string },
    at: string,
  ): void;
  /** Which of these session ids this laptop opened. Never more than it knows. */
  mine(fleet: string | null, sessions: readonly string[]): Set<string>;
  /** Drop every session this laptop recorded against `instance` in `fleet` (§6.7). */
  forgetInstance(fleet: string | null, instance: string): void;
}

/**
 * The record a `Hermetic` built without a local database gets: this process
 * only. Same bargain as `MemoryRunStore` and `MemoryNotificationStore` — losing
 * it costs a warning that fires where it need not have, which is the safe
 * direction.
 */
export class MemoryLocalChatSessions implements LocalChatSessions {
  private readonly rows = new Map<string, string>();
  /** Which instance each key was recorded against, for `forgetInstance`. */
  private readonly instances = new Map<string, string>();

  private key(fleet: string | null, session: string): string {
    return `${fleet ?? "-"}\u0000${session}`;
  }

  remember(
    fleet: string | null,
    where: { instance: string; bot: string; session: string },
    at: string,
  ): void {
    const key = this.key(fleet, where.session);
    this.rows.set(key, at);
    this.instances.set(key, where.instance);
  }

  forgetInstance(fleet: string | null, instance: string): void {
    const head = this.key(fleet, "");
    for (const [key, owner] of [...this.instances]) {
      if (owner !== instance || !key.startsWith(head)) continue;
      this.rows.delete(key);
      this.instances.delete(key);
    }
  }

  mine(fleet: string | null, sessions: readonly string[]): Set<string> {
    const found = new Set<string>();
    for (const id of sessions) {
      if (this.rows.has(this.key(fleet, id))) found.add(id);
    }
    return found;
  }
}

/** The one option every long or interruptible read takes (§3.2 rule 2). */
export interface ChatOptions {
  signal?: AbortSignal | undefined;
}

export interface ChatDeps {
  instanceListening?: InstanceListeningStore;
  fleet?: () => string | null;
  /** §4.2's account/fleet guard; the tailnet comes from the fleet it returns. */
  guardFleet: () => Promise<{ config: LocalConfig; fleet: FleetItem; stack: StackInfo }>;
  /** The row, or `NOT_FOUND`. */
  getAgent: (name: string) => Promise<Agent>;
  /**
   * Every agent row, for the fleet-wide roster read.
   *
   * `chat.swarms` without an instance is a fan-out over boxes (§9.2: the rail's
   * default scope is all listened-to instances), so it needs the list `getAgent` cannot
   * give it. It is a dep rather than a backend handle for the same reason the
   * other three are: this module gets what it asks for and nothing else.
   */
  listAgents: () => Promise<Agent[]>;
  /** The adapter. It is the only module that knows Hermes; this one never does. */
  hermes: HermesChatClient;
  /**
   * The inbox, when this `Hermetic` has one.
   *
   * Optional for the reason `FoundationDeps` and `VolumeDeps` make it optional:
   * a chat surface built without an inbox is a chat surface that works and says
   * nothing, and a required dependency here would make every existing test of
   * this module construct a store it does not care about.
   */
  notifications?: NotificationDeps;
  /**
   * The clock, for the two things here that need one: stamping the watermark a
   * completed turn advances (`markChatTurn`), and stamping the local session
   * record so it can be pruned. Injected rather than read from `Date` so a test
   * can settle what "after this turn" means, and defaulted so that every
   * existing caller keeps working.
   */
  now?: () => string;
  /**
   * Which sessions this laptop started, so the destination banner can stop
   * firing on threads the operator opened from this portal thirty seconds ago.
   * Optional, and absence means every session reads as foreign — which is the
   * safe direction and the reason it is safe to leave out.
   */
  localSessions?: LocalChatSessions;
  /**
   * The in-flight turn fence (`chat-fence.ts`), shared by every process using
   * this laptop's database.
   *
   * Optional, and its absence costs only the cross-process half: the default is
   * an in-memory fence, which still stops this process's own roster poll from
   * announcing this process's own turn. A `Hermetic` with a local database
   * passes the SQLite one, and then the portal defers for a turn the CLI is
   * taking.
   */
  chatFence?: ChatFenceStore;
  /**
   * How long the end of a turn waits for the box to say where its transcript
   * got to (`ATTRIBUTION_DEADLINE_MS`). Injected only so a test can settle it
   * without spending the real five seconds; production passes nothing.
   */
  attributionDeadlineMs?: number;
  /**
   * Observation timing, injected so a test can assert the reconnect policy
   * rather than wait the 31 seconds it spans. Production passes nothing and
   * gets `chat-observe.ts`'s own constants, which are the policy.
   */
  observeTuning?: {
    pollMs?: number | undefined;
    sleep?: ((ms: number, signal?: AbortSignal) => Promise<void>) | undefined;
    reconnect?:
      | { attempts?: number | undefined; baseMs?: number | undefined; maxMs?: number | undefined }
      | undefined;
  };
}

/* ── results ──────────────────────────────────────────────────────────────── */

/**
 * The roster read's answer. A list rather than a map because the order is the
 * rail's order and a map has none — and because a fleet-wide read returns one
 * entry per *box asked*, including the ones that did not answer.
 */
export interface ChatSwarmsResult {
  swarms: Swarm[];
}

export interface ChatSessionsResult {
  instance: string;
  bot: string;
  sessions: Session[];
}

export interface ChatHistoryResult {
  conversation?: ChatConversation | null;
  instance: string;
  bot: string;
  /** The session the messages came from, or null when the box named none. */
  session: string | null;
  messages: ChatMessage[];
}

/**
 * `aborted` says the stop was *delivered*, not that a turn was in flight to
 * receive it: the box answers an abort the same way whether or not it was
 * mid-turn, and hermetic does not guess at the difference. An operator who hit
 * the button a second too late gets the same answer as one who hit it in time,
 * which is honest — the turn is over either way.
 */
export interface ChatAbortResult {
  instance: string;
  bot: string;
  aborted: boolean;
}

/* ── the surface ──────────────────────────────────────────────────────────── */

export function createChat(deps: ChatDeps) {
  const { guardFleet, getAgent, listAgents, hermes } = deps;
  const now = deps.now ?? (() => new Date().toISOString());
  const instanceListening = deps.instanceListening ?? new MemoryInstanceListeningStore();
  const fenceStore = deps.chatFence ?? new MemoryChatFenceStore();
  /**
   * The laptop's clock in milliseconds, for the lease and for nothing else.
   *
   * A lease is only ever measured against another reading of this same clock,
   * which is what makes it the one place here a laptop timestamp is legitimate
   * (`chat-fence.ts`). `deps.now` is honoured so a test can settle the lease
   * without waiting 90 seconds; a clock that hands back something unparseable
   * falls back to the real one rather than fencing forever.
   */
  const nowMs = (): number => {
    const parsed = Date.parse(now());
    return Number.isNaN(parsed) ? Date.now() : parsed;
  };
  const active = new Map<string, Set<AbortController>>();
  const send = createChatSend({
    deps,
    hermes,
    validateName,
    address,
    fenceStore,
    instanceListening,
    now,
    nowMs,
  });

  function requireListening(fleet: string | null, instance: string): void {
    if (!instanceListening.list(fleet).includes(instance)) {
      throw new HermeticError("VALIDATION", `${instance}: listen to this instance before opening chat`);
    }
  }

  async function listening(input: unknown = {}): Promise<{ instances: string[] }> {
    parse(ChatListeningInput, input, "chat listening");
    const fleet = deps.fleet ? deps.fleet() : (await guardFleet()).fleet.fleet_id;
    return { instances: instanceListening.list(fleet) };
  }

  async function listen(input: unknown): Promise<{ instances: string[] }> {
    const parsed = parse(ChatListenInput, input, "chat listen");
    validateName(parsed.instance);
    const fleet = deps.fleet ? deps.fleet() : (await guardFleet()).fleet.fleet_id;
    if (parsed.listening) await getAgent(parsed.instance);
    instanceListening.set(fleet, parsed.instance, parsed.listening);
    if (!parsed.listening) {
      for (const controller of active.get(parsed.instance) ?? []) controller.abort();
    }
    return { instances: instanceListening.list(fleet) };
  }

  function lease(instance: string, opts: ChatOptions) {
    const controller = new AbortController();
    const controllers = active.get(instance) ?? new Set<AbortController>();
    controllers.add(controller);
    active.set(instance, controllers);
    return {
      signal: opts.signal ? AbortSignal.any([opts.signal, controller.signal]) : controller.signal,
      release: () => {
        controllers.delete(controller);
        if (controllers.size === 0) active.delete(instance);
      },
    };
  }

  async function watched<T>(
    instance: string,
    opts: ChatOptions,
    work: (opts: ChatOptions) => Promise<T>,
  ): Promise<T> {
    const request = lease(instance, opts);
    try {
      request.signal.throwIfAborted();
      const result = await work({ signal: request.signal });
      request.signal.throwIfAborted();
      return result;
    } finally {
      request.release();
    }
  }

  /**
   * Where a box is, resolved the way `probe.ts`'s `dashboardLayer` resolves it:
   * `agentDashboardUrl` prefers the row's `tailscale_dns_name` over the
   * canonical `<fleet id>-<agent>.<tailnet>` spelling.
   *
   * That preference is the whole reason this goes through the helper rather
   * than formatting a hostname here. After a recreate whose device cleanup
   * could not run, MagicDNS still points the canonical name at the corpse — and
   * a chat sent to the corpse is not a failed send, it is a send that appears to
   * work and reaches a box nobody is watching.
   */
  async function address(instance: string): Promise<BoxAddress> {
    const { fleet } = await guardFleet();
    requireListening(fleet.fleet_id, instance);
    const agent = await getAgent(instance);
    requireListening(fleet.fleet_id, instance);
    return {
      instance: agent.name,
      baseUrl: agentDashboardUrl(agent, fleet.tailnet, cloudName(fleet.fleet_id, agent.name)),
      // §9.2: a bot's avatar is seeded from `fleet_id/instance/bot`, so that a
      // rename does not change its face and two fleets' `default@atlas` do not
      // wear the same one. The adapter reaches boxes, not tables, so the fleet
      // has to travel with the address.
      fleet_id: fleet.fleet_id,
    };
  }

  /**
   * One listened-to instance's roster, or every listened-to instance's (§9.2).
   *
   * The fan-out is concurrent and each box's failure is its own: `allSettled`,
   * not `all`. Reads of a roster do not take one of the box's ~3 warm backend
   * slots (§9.2's "Limits the box imposes"), which is what makes asking thirteen
   * boxes at once affordable rather than a queue thirteen deep.
   */
  async function swarms(input: unknown = {}, opts: ChatOptions = {}): Promise<ChatSwarmsResult> {
    const parsed = parse(ChatSwarmsInput, input, "bots ls");
    if (parsed.instance !== undefined) validateName(parsed.instance);
    const { fleet } = await guardFleet();
    const instances = instanceListening.list(fleet.fleet_id);
    if (parsed.instance !== undefined) requireListening(fleet.fleet_id, parsed.instance);
    if (instances.length === 0) return { swarms: [] };
    const rows =
      parsed.instance === undefined
        ? (await listAgents()).filter((agent) => worthAsking(agent) && instances.includes(agent.name))
        : [await getAgent(parsed.instance)];
    const boxOf = (agent: Agent): BoxAddress => ({
      instance: agent.name,
      baseUrl: agentDashboardUrl(agent, fleet.tailnet, cloudName(fleet.fleet_id, agent.name)),
      fleet_id: fleet.fleet_id,
    });
    const settled = await Promise.allSettled(
      rows.map(async (agent): Promise<Swarm> => {
        const box = boxOf(agent);
        return await watched(agent.name, opts, async (request) => {
          requireListening(fleet.fleet_id, agent.name);
          return await hermes.swarm(box, request);
        });
      }),
    );
    const answered = settled
      .map((result, i) => {
        const instance = rows[i]?.name ?? "";
        if (result.status === "fulfilled") return redactSwarm(result.value);
        const { code, message } = reasonOf(result.reason);
        return unreachableSwarm(instance, `${code}: ${message}`);
      })
      .filter((swarm) => instanceListening.list(fleet.fleet_id).includes(swarm.instance));
    /**
     * The roster read is the only place hermetic can see a turn it did not
     * drive, so it is where `chat.message` is raised (§4.9). It is
     * handed the *redacted* swarms rather than the adapter's own, so a bot
     * title that carried something it should not cannot reach the inbox by a
     * shorter path than it reaches the screen.
     *
     * A box that did not answer contributes nothing: `unreachableSwarm` has an
     * empty bot list, so its watermarks stand still rather than being reset by
     * a laptop that merely could not ask.
     */
    if (deps.notifications) {
      const notifications = deps.notifications;
      const unfenced = (bot: ChatActivity): boolean =>
        !chatFenced(fenceStore, fleet.fleet_id, bot, nowMs());
      const roster = answered
        .flatMap((swarm) =>
          swarm.bots.map(
            (bot): ChatActivity => ({
              instance: swarm.instance,
              bot: bot.name,
              title: bot.title ?? null,
              last_message_at: bot.last_message_at ?? null,
              needs_action: bot.needs_action,
            }),
          ),
        )
        /**
         * A bot with a turn in flight is *deferred*, not classified.
         *
         * The turn has already moved the box's coordinate and has not yet had
         * the chance to record where to, so anything this read concluded
         * about it would be a conclusion about a half-finished sentence.
         * Dropping the bot from the list leaves its stored watermark exactly
         * where it was — which is the whole point, because the next read
         * after the fence lifts then classifies whatever happened, including
         * a message somebody else sent while the turn ran.
         *
         * The fence is shared by every process using this laptop's database,
         * so a turn the CLI is taking defers the portal's poll too.
         */
        .filter(unfenced);
      /**
       * A bot that moved gets one durable read of its newest rows, so a
       * background-process event can raise its own row and an event-only
       * movement raises no "has a new message" (`chat-activity.ts`). The read
       * is a transcript read — it takes no warm backend slot — and is
       * redacted here, the door, before the classifier sees a word of it.
       */
      const classified = await classifyChatActivity(notifications, roster, (bot) => {
        const agent = rows.find((row) => row.name === bot.instance);
        if (agent === undefined) return Promise.resolve([]);
        const box = boxOf(agent);
        return watched(bot.instance, opts, async (request) => {
          requireListening(fleet.fleet_id, bot.instance);
          const messages = await hermes.history(box, bot.bot, {
            signal: request.signal,
            limit: CHAT_CLASSIFY_LIMIT,
          });
          return messages.map(redactMessage);
        });
      });
      // The fence is checked again: a turn may have started while the
      // classifier was reading, and its bot is deferred like any other.
      observeChatActivity(notifications, classified.filter(unfenced));
    }
    return { swarms: answered };
  }

  /**
   * Whether a fleet-wide roster read should spend a request on this row.
   *
   * A destroyed agent is not a box that is down, it is a box that is gone, and
   * listing it as unreachable would put a permanent dead bucket in the rail.
   * Everything else is asked, including `stopped` and `error`: those *are*
   * boxes that are down, and "atlas — stopped" is the answer the operator came
   * for.
   */
  function worthAsking(agent: Agent): boolean {
    return agent.status !== "destroyed";
  }

  /**
   * Whether this laptop's own record says it started any of these sessions.
   *
   * The override runs in exactly one direction: a session the laptop opened is
   * re-stamped `portal`, and nothing is ever moved the other way. The adapter's
   * reading of upstream's `source` is what a session is otherwise, and a local
   * row that says nothing about a session leaves it exactly as the box
   * described it.
   *
   * The whole point is the asymmetry. `portal` silences the composer's
   * destination warning, so it may only ever be granted on this laptop's own
   * evidence that it sent into that conversation — never inferred from a value
   * the box chose, and never withheld from a session the box called foreign.
   */
  function claimLocal(fleet: string | null, found: readonly Session[]): Session[] {
    const store = deps.localSessions;
    if (!store) return [...found];
    const mine = store.mine(
      fleet,
      found.map((s) => s.id),
    );
    if (mine.size === 0) return [...found];
    return found.map((s) => (mine.has(s.id) ? { ...s, origin: "portal", origin_detail: null } : s));
  }

  /** One bot's conversations, each carrying where it came from (§9.2's "Origin"). */
  async function sessions(input: unknown, opts: ChatOptions = {}): Promise<ChatSessionsResult> {
    const parsed = parse(ChatSessionsInput, input, "chat ls");
    validateName(parsed.instance);
    const { fleet } = await guardFleet();
    const box = await address(parsed.instance);
    opts.signal?.throwIfAborted();
    const found = await hermes.sessions(box, parsed.bot, { signal: opts.signal });
    return {
      instance: parsed.instance,
      bot: parsed.bot,
      // Redacted first, then claimed: the claim only ever rewrites `origin`,
      // and running it the other way round would put an unmasked title through
      // an object rebuild for no reason.
      sessions: claimLocal(fleet.fleet_id, redactSessions(found)),
    };
  }

  /**
   * The transcript, read from the box every time.
   *
   * There is no cache here on purpose: the box is authoritative (§9.2), the
   * transcript already survives a recreate because it lives on the data volume,
   * and a cache in core would be a second copy of state whose staleness nothing
   * here could detect. A cache, if one is ever wanted, is a head's performance
   * decision and is allowed to be wrong.
   */
  async function history(input: unknown, opts: ChatOptions = {}): Promise<ChatHistoryResult> {
    const parsed = parse(ChatHistoryInput, input, "chat log");
    validateName(parsed.instance);
    const box = await address(parsed.instance);
    opts.signal?.throwIfAborted();
    const conversation = hermes.conversation
      ? await hermes.conversation(box, parsed.bot, {
          signal: opts.signal,
          ...(parsed.session ? { session: parsed.session } : {}),
        })
      : undefined;
    const selected = conversation?.session ?? parsed.session;
    const messages =
      conversation === null && !selected
        ? []
        : await hermes.history(box, parsed.bot, {
            signal: opts.signal,
            ...(selected !== undefined ? { session: selected } : {}),
            ...(parsed.limit !== undefined ? { limit: parsed.limit } : {}),
          });
    return {
      instance: parsed.instance,
      bot: parsed.bot,
      session: selected ?? messages[0]?.session ?? null,
      ...(conversation !== undefined ? { conversation } : {}),
      messages: messages.map(redactMessage),
    };
  }

  /**
   * Stop the turn in flight.
   *
   * It names a bot, not a turn, because that is what the operator can see: a
   * turn has no id until it has produced a frame, and the usual reason to abort
   * one is that it has produced nothing. An abort against a bot that is idle is
   * `aborted: false` and not an error.
   */
  async function abort(input: unknown, opts: ChatOptions = {}): Promise<ChatAbortResult> {
    const parsed = parse(ChatAbortInput, input, "chat abort");
    validateName(parsed.instance);
    const box = await address(parsed.instance);
    opts.signal?.throwIfAborted();
    const aborted = await hermes.abort(box, parsed.bot, {
      signal: opts.signal,
      ...(parsed.session !== undefined ? { session: parsed.session } : {}),
    });
    return { instance: parsed.instance, bot: parsed.bot, aborted: aborted ?? true };
  }

  const observation = createChatObserveWiring({ deps, hermes, address, history, now });

  /**
   * The four reads are sealed on the way out (`redactError`); `send` is not,
   * because it has no way out but the stream — its failures are error frames,
   * already masked, and its one throw is the eager `VALIDATION` refusal, which
   * carries schema paths and no values.
   */
  async function runLifecycle(
    input: unknown,
    kind: "open" | "compact" | "archive" | "respond",
    opts: ChatOptions,
  ) {
    const box = await address((input as { instance: string }).instance);
    if (kind === "open") {
      const parsed = parse(ChatOpenInput, input, "Bot Mode");
      if (!hermes.conversation)
        throw new HermeticError("CHAT_PROTOCOL", "This gateway does not support Bot Mode");
      const result = await hermes.conversation(box, parsed.bot, {
        ...parsed,
        create: true,
        signal: opts.signal,
      });
      if (!result) throw new HermeticError("CHAT_PROTOCOL", "Gateway returned no conversation");
      return result;
    }
    if (kind === "compact") {
      const p = parse(ChatCompactInput, input, "Bot Mode");
      if (!hermes.compact) throw new HermeticError("CHAT_PROTOCOL", "Compaction unavailable");
      return hermes.compact(box, p.bot, { ...p, signal: opts.signal });
    }
    if (kind === "archive") {
      const p = parse(ChatArchiveInput, input, "Bot Mode");
      if (!hermes.archive) throw new HermeticError("CHAT_PROTOCOL", "Archival unavailable");
      return hermes.archive(box, p.bot, p.session, opts);
    }
    const p = parse(ChatRespondInput, input, "Bot Mode");
    if (!hermes.respond) throw new HermeticError("CHAT_PROTOCOL", "Request responses unavailable");
    return hermes.respond(box, p, opts);
  }
  function lifecycle(
    input: { instance: string },
    kind: "open" | "compact" | "archive" | "respond",
    opts: ChatOptions,
  ) {
    return watched(input.instance, opts, (request) => runLifecycle(input, kind, request));
  }
  return {
    open: (input: unknown, opts: ChatOptions = {}) =>
      sealed(
        async () =>
          redactDeep(
            await lifecycle(parse(ChatOpenInput, input, "Bot Mode"), "open", opts),
          ) as ChatConversation,
      ),
    compact: (input: unknown, opts: ChatOptions = {}) =>
      sealed(async () =>
        redactDeep(await lifecycle(parse(ChatCompactInput, input, "Bot Mode"), "compact", opts)),
      ),
    archive: (input: unknown, opts: ChatOptions = {}) =>
      sealed(async () =>
        redactDeep(await lifecycle(parse(ChatArchiveInput, input, "Bot Mode"), "archive", opts)),
      ),
    respond: (input: unknown, opts: ChatOptions = {}) =>
      sealed(async () =>
        redactDeep(await lifecycle(parse(ChatRespondInput, input, "Bot Mode"), "respond", opts)),
      ),
    listening: (input: unknown = {}) => sealed(() => listening(input)),
    listen: (input: unknown) => sealed(() => listen(input)),
    swarms: (input: unknown, opts: ChatOptions = {}) => sealed(() => swarms(input, opts)),
    sessions: (input: unknown, opts: ChatOptions = {}) =>
      sealed(() =>
        watched(parse(ChatSessionsInput, input, "chat ls").instance, opts, (request) =>
          sessions(input, request),
        ),
      ),
    history: (input: unknown, opts: ChatOptions = {}) =>
      sealed(() =>
        watched(parse(ChatHistoryInput, input, "chat log").instance, opts, (request) =>
          history(input, request),
        ),
      ),
    send: (input: unknown, opts: ChatOptions = {}): AsyncIterable<ChatFrame> => {
      const parsed = parse(ChatSendInput, input, "chat");
      validateName(parsed.instance);
      return (async function* () {
        const request = lease(parsed.instance, opts);
        try {
          yield* send(input, { signal: request.signal });
        } finally {
          request.release();
        }
      })();
    },
    abort: (input: unknown, opts: ChatOptions = {}) =>
      sealed(() =>
        watched(parse(ChatAbortInput, input, "chat abort").instance, opts, (request) =>
          abort(input, request),
        ),
      ),
    /**
     * Watch one conversation for activity nothing here produced (§9.2).
     *
     * Validated eagerly and then streamed, the split `send` makes and for the
     * same reason: a malformed request is a thrown `VALIDATION` the CLI can
     * exit 2 on and the server can refuse before committing to a 200, and
     * everything after that point is an event in the stream.
     *
     * It takes a `lease` for the instance, so `chat listen --off` ends an
     * observation the way it ends a turn. That is the only thing an abort here
     * does: it stops this laptop watching. No remote turn is interrupted, no
     * job is stopped, and nothing is sent — there is no path in this method
     * that can write to a box, which is what makes a lost stream safe to retry.
     */
    observe: (input: unknown, opts: ChatOptions = {}): AsyncIterable<ChatObserveEvent> => {
      const parsed = parse(ChatObserveInput, input, "chat watch");
      validateName(parsed.instance);
      return (async function* () {
        const request = lease(parsed.instance, opts);
        try {
          yield* observation.observe(
            {
              instance: parsed.instance,
              bot: parsed.bot,
              ...(parsed.session !== undefined ? { session: parsed.session } : {}),
            },
            { signal: request.signal },
          );
        } finally {
          request.release();
        }
      })();
    },
  };
}
