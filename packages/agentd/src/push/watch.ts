/**
 * The gateway watcher (§9.4): hermeticd's fourth resident loop, and the reason
 * a paired phone hears about a finished turn with nothing on the laptop
 * running.
 *
 * Every `WATCH_POLL_MS` it asks this box's own gateway, on loopback, for
 * `session.active_list` — upstream's summary of every live session,
 * `{id, session_key, status: waiting|starting|working|idle, message_count,
 * preview, …}` — and compares it with the last answer:
 *
 * | Transition                                         | Push                       |
 * |----------------------------------------------------|----------------------------|
 * | → `idle` after a turn was seen running             | `turn.done`, reply preview |
 * |   (`working`/`waiting`), or with `message_count`   |                            |
 * |   grown and a tail reply newer than the previous   |                            |
 * |   poll                                             |                            |
 * | `working` → `idle` with `message_count` dropped    | the same (a compaction)    |
 * | a session seen running leaves the list (reaped),   | the same                   |
 * |   its tail reply newer than the turn               |                            |
 * | any of these, tail row carries a failure           | `turn.error`, failure text |
 * | any → `waiting`                                    | `needs_action`             |
 * | a session not seen before, first seen `idle`, > 0, | `message` (routine/channel)|
 * |   its tail reply newer than the previous poll      |                            |
 *
 * News is read off the durable tail, never off the list's `last_active`:
 * upstream stamps `last_active` with the moment it builds a live record
 * (`_init_session`, `_deferred_session_record`), so a session merely resumed
 * into the list — a desktop `compact`, a subagent reconcile, a turn on a
 * reaped session — looks as fresh as one that just spoke. A cold resume also
 * hydrates its history after the record is listed, so `message_count` can
 * climb from 0 with no turn at all; `starting` (the agent being built, which
 * waits on that hydration) is therefore no evidence of a turn either.
 *
 * A turn's count is no clock either: upstream commits the turn's history
 * before it marks the session idle, so the count can finish growing while the
 * session still shows `working`, and the idle poll sees no growth at all. Once
 * a turn was seen running, the next `idle` settles it whatever the count did.
 * And upstream's orphan reaper pops a session no client is attached to within
 * about 20 s of its turn ending, so a turn seen running can leave the list
 * before any poll sees it idle; it settles from its stored tail as it goes,
 * provided that tail's reply was written after the turn was first seen — a
 * session key rotated by a compression leaves the list too, and its turn goes
 * on under the new key.
 *
 * Each of those transitions bumps the session's event counter, the `<n>` of
 * the push's dedupe key (`MobilePushData`): two `waiting` spells in one turn
 * are two events, and so are two turns either side of a compaction.
 *
 * Previews are read from the tail (the last assistant row), never from the
 * list's own `preview`, which is the session's opening line. A device gets
 * them only if it opted in (`notify.ts`).
 * The tail is read with the chat adapter's `history`, which needs the bot (the
 * Hermes profile) the session belongs to; `swarm` + `sessions` map session →
 * bot every `SESSION_MAP_REFRESH_MS`, and once more on demand when a session
 * the map does not know reaches a transition. A session still unknown after
 * that is pushed under bot `unknown`, as a `message` only, once a turn it was
 * seen running settles in the list — there is no profile to read its tail
 * from or to open it under, so one first listed idle, or one that left the
 * list mid-turn, whose news only the tail can prove, pushes nothing.
 *
 * The first answer after start, and the first after the Hermes unit was down,
 * is a *baseline*: it is recorded and pushes nothing, so a daemon restart does
 * not replay every live session to every phone. A poll that merely fails (a
 * throw, a timeout, an answer without a list) keeps what was seen, so a turn
 * that settles across the failed poll still pushes; it re-baselines only when
 * nothing had been seen yet.
 *
 * At most every `TAILNET_PRUNE_MS` it also asks Tailscale who is on the tailnet
 * (`tailnetLogins`) and drops the registrations of owners who are not: a member
 * removed from the tailnet stops receiving pushes within ten minutes rather
 * than when their registration lapses.
 *
 * Never crashes the daemon. A gateway that does not answer backs the loop off
 * from `WATCH_POLL_MS` to `WATCH_BACKOFF_MAX_MS`; a box whose Hermes unit is
 * not running (`gatewayUp` false) idles at the same slow rate without asking.
 */
import type { BoxAddress, ChatMessage, HermesChatClient } from "@hermetic/core/chat-client";
import type { ExpoPushSender, ExpoReceiptFetcher } from "@hermetic/core/shared";
import type { MobilePushKind } from "@hermetic/core/schema";
import { nodeName, type TailnetMembers } from "../tailscale.ts";
import type { PushDeviceStore } from "./devices.ts";
import {
  PUSHES_PER_DEVICE_PER_MINUTE,
  RECEIPT_DELAY_MS,
  createNotifier,
  previewText,
  type Notifier,
  type PushEvent,
} from "./notify.ts";

export const WATCH_POLL_MS = 3_000;
export const WATCH_BACKOFF_MAX_MS = 30_000;
export const SESSION_MAP_REFRESH_MS = 60_000;
/** The soonest an unknown session may force another map refresh. */
export const SESSION_MAP_FORCE_MIN_MS = 10_000;
/** How many tail rows a transition reads. */
export const TAIL_ROWS = 10;
/** The bot name a session the roster cannot place is pushed under. */
export const UNKNOWN_BOT = "unknown";
/** The loopback address of this box's own dashboard and gateway. */
export const LOOPBACK_GATEWAY_URL = "http://127.0.0.1:9119/";
/** The soonest the registrations are checked against the tailnet's members again. */
export const TAILNET_PRUNE_MS = 10 * 60_000;
/** Sessions whose event counter is remembered at once; the stalest is forgotten. */
export const EVENT_COUNTER_MEMORY = 4_096;

export interface WatchDeps {
  readonly chat: HermesChatClient;
  readonly devices: PushDeviceStore;
  readonly send: ExpoPushSender;
  readonly fetchReceipts: ExpoReceiptFetcher;
  /** Milliseconds. */
  readonly now: () => number;
  readonly sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
  readonly log: (message: string) => void;
  /** This agent's name — the instance in every push and dedupe key. */
  readonly instance: string;
  readonly fleet_id: string;
  /** agentd's `redactValue`; every preview passes through it. */
  readonly redact: (value: string) => string;
  /** Whether the Hermes unit is up; absent means "ask the gateway anyway". */
  readonly gatewayUp?: () => Promise<boolean>;
  /**
   * Who is on the tailnet now (`tailnetLogins` in `tailscale.ts`); `null` when
   * it cannot be told, and then nothing is pruned. Absent: never pruned.
   */
  readonly tailnetLogins?: () => Promise<TailnetMembers | null>;
  readonly baseUrl?: string;
  readonly tuning?: Partial<WatchTuning>;
}

export interface WatchTuning {
  pollMs: number;
  backoffMaxMs: number;
  mapRefreshMs: number;
  receiptDelayMs: number;
  perDeviceLimit: number;
}

/** What one tick did, and so how long the loop waits before the next. */
export type TickOutcome =
  | { readonly kind: "ok"; readonly pushes: readonly PushEvent[] }
  | { readonly kind: "idle" }
  | { readonly kind: "down"; readonly reason: string };

/** One live session as `session.active_list` reports it, narrowed to what is read. */
export interface LiveSession {
  /** The stored id (`session_key`, else the live `id`). */
  readonly key: string;
  readonly status: string;
  readonly message_count: number;
  /**
   * When upstream last stamped the session, in milliseconds; `null` when not
   * reported. Informational only: a resumed session is stamped *now*, so it
   * is no evidence that anything was said.
   */
  readonly last_active: number | null;
}

/**
 * `last_active` as milliseconds. Upstream reports epoch seconds as a float
 * (`1789663313.067`); a value already in milliseconds, or an ISO string, is
 * read too, and anything else is unknown.
 */
function activeAt(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value) && value > 0)
    return value < 1e12 ? value * 1000 : value;
  if (typeof value === "string") {
    const at = Date.parse(value);
    return Number.isNaN(at) ? null : at;
  }
  return null;
}

/** `session.active_list`'s answer, defensively: a malformed row is skipped. */
export function parseActiveList(value: unknown): LiveSession[] | null {
  const sessions = (value as { sessions?: unknown } | null)?.sessions;
  if (!Array.isArray(sessions)) return null;
  const out: LiveSession[] = [];
  for (const raw of sessions) {
    if (typeof raw !== "object" || raw === null) continue;
    const row = raw as Record<string, unknown>;
    const key =
      typeof row["session_key"] === "string" && row["session_key"] !== ""
        ? row["session_key"]
        : typeof row["id"] === "string" && row["id"] !== ""
          ? row["id"]
          : null;
    const count = row["message_count"];
    if (key === null || typeof row["status"] !== "string" || typeof count !== "number") continue;
    out.push({
      key,
      status: row["status"],
      message_count: count,
      last_active: activeAt(row["last_active"]),
    });
  }
  return out;
}

/** The text a bot row says, flattened. */
function rowText(row: ChatMessage): string {
  return row.blocks
    .map((block) => (block.kind === "text" ? block.markdown : ""))
    .filter((text) => text !== "")
    .join(" ");
}

/**
 * The tail's verdict: the newest row with a failure is an error, the newest
 * bot row is a reply, and a user row reached first means the turn left nothing
 * to tell (an interrupt before any output) — no push.
 */
export function tailVerdict(
  rows: readonly ChatMessage[],
): { kind: "turn.done" | "turn.error"; text: string } | null {
  const verdict = tailRow(rows);
  return verdict === null ? null : { kind: verdict.kind, text: verdict.text };
}

/** `tailVerdict`, with when the row it was read from was written (ms; 0 when unknown). */
function tailRow(
  rows: readonly ChatMessage[],
): { kind: "turn.done" | "turn.error"; text: string; at: number } | null {
  for (let i = rows.length - 1; i >= 0; i--) {
    const row = rows[i];
    if (row === undefined) continue;
    const at = Date.parse(row.at);
    const stamped = Number.isNaN(at) ? 0 : at;
    if (row.failure || (typeof row.error === "string" && row.error !== "")) {
      return {
        kind: "turn.error",
        text: row.failure?.message || row.error || "the turn failed",
        at: stamped,
      };
    }
    if (row.role === "bot") return { kind: "turn.done", text: rowText(row), at: stamped };
    if (row.role === "user") return null;
  }
  return null;
}

/** The statuses that mean a turn is under way: running, or blocked on the operator. */
const TURN_STATUSES: ReadonlySet<string> = new Set(["working", "waiting"]);

export interface Watcher {
  /** One poll: read the gateway, diff, push. Never throws. */
  tick(): Promise<TickOutcome>;
  /** The loop: ticks and receipt polls until `signal` aborts. Never throws. */
  run(signal: AbortSignal): Promise<void>;
  readonly notifier: Notifier;
}

export function createWatcher(deps: WatchDeps): Watcher {
  const tuning: WatchTuning = {
    pollMs: deps.tuning?.pollMs ?? WATCH_POLL_MS,
    backoffMaxMs: deps.tuning?.backoffMaxMs ?? WATCH_BACKOFF_MAX_MS,
    mapRefreshMs: deps.tuning?.mapRefreshMs ?? SESSION_MAP_REFRESH_MS,
    receiptDelayMs: deps.tuning?.receiptDelayMs ?? RECEIPT_DELAY_MS,
    perDeviceLimit: deps.tuning?.perDeviceLimit ?? PUSHES_PER_DEVICE_PER_MINUTE,
  };
  const box: BoxAddress = {
    instance: deps.instance,
    baseUrl: deps.baseUrl ?? LOOPBACK_GATEWAY_URL,
    fleet_id: deps.fleet_id,
  };
  const notifier = createNotifier({
    devices: deps.devices,
    send: deps.send,
    fetchReceipts: deps.fetchReceipts,
    now: deps.now,
    log: deps.log,
    instance: deps.instance,
    fleet_id: deps.fleet_id,
    receiptDelayMs: tuning.receiptDelayMs,
    perDeviceLimit: tuning.perDeviceLimit,
  });

  /**
   * What the last answer said of each listed session. `turn` is whether a
   * turn was seen under way (`TURN_STATUSES`) since the session last settled;
   * upstream commits the turn's history before it goes idle, so the next
   * `idle` settles it, grown count or not. `turnSince` is the last moment the
   * turn was not yet seen — the poll before the one that first saw it, or that
   * one when there was none — so a row the turn wrote is newer; `null` when no
   * turn is under way.
   */
  const seen = new Map<
    string,
    { status: string; count: number; turn: boolean; turnSince: number | null }
  >();
  const botOf = new Map<string, string>();
  /** session → its last event number. Outlives `seen`, so a session that leaves and returns never reuses one. */
  const counters = new Map<string, number>();
  /**
   * Where every session's counter starts: this process's start, in seconds.
   * A transition needs a poll, polls are seconds apart, so no counter of an
   * earlier process can have reached it, and a key is never reused across a
   * restart either.
   */
  const counterBase = Math.floor(deps.now() / 1000);
  /**
   * Where a counter starts once any has been forgotten: the second of the
   * latest eviction. An evicted session's counter cannot have outrun the clock
   * (one event per poll), so a session evicted and seen again starts past it.
   */
  let counterFloor = counterBase;
  let mapAt = Number.NEGATIVE_INFINITY;
  let pruneAt = Number.NEGATIVE_INFINITY;
  let baseline = true;
  /** When the last answered `session.active_list` was asked, in milliseconds. */
  let lastPollAt: number | null = null;

  function nextEvent(key: string): number {
    const n = (counters.get(key) ?? counterFloor) + 1;
    counters.delete(key);
    counters.set(key, n);
    if (counters.size > EVENT_COUNTER_MEMORY) {
      const stalest = counters.keys().next().value;
      if (stalest !== undefined) counters.delete(stalest);
      counterFloor = Math.max(counterFloor, Math.floor(deps.now() / 1000));
    }
    return n;
  }

  /** Drop the registrations of owners no longer on the tailnet; at most every `TAILNET_PRUNE_MS`. */
  async function pruneDeparted(): Promise<void> {
    if (deps.tailnetLogins === undefined) return;
    const now = deps.now();
    if (now - pruneAt < TAILNET_PRUNE_MS) return;
    pruneAt = now;
    try {
      const members = await deps.tailnetLogins();
      // No answer, or one naming nobody, is no evidence that anyone left.
      if (members === null || members.logins.size === 0) return;
      const dropped = await deps.devices.pruneOwners((owner) =>
        owner.startsWith(NODE_OWNER_PREFIX)
          ? members.nodes.has(nodeName(owner.slice(NODE_OWNER_PREFIX.length)))
          : members.logins.has(owner),
      );
      if (dropped > 0) {
        deps.log(
          `push devices: dropped ${dropped} registration${dropped === 1 ? "" : "s"} whose owner left the tailnet`,
        );
      }
    } catch (e) {
      deps.log(`push watcher: could not check the tailnet's members (${errorText(e)})`);
    }
  }

  async function refreshMap(): Promise<void> {
    mapAt = deps.now();
    try {
      const swarm = await deps.chat.swarm(box);
      for (const bot of swarm.bots) {
        const sessions = await deps.chat.sessions(box, bot.name).catch(() => []);
        for (const session of sessions) botOf.set(session.id, bot.name);
      }
    } catch (e) {
      deps.log(`push watcher: could not map sessions to bots (${errorText(e)})`);
    }
  }

  /** The bot a session belongs to, refreshing the map once if it is not there. */
  async function resolveBot(key: string): Promise<string | null> {
    const known = botOf.get(key);
    if (known !== undefined) return known;
    if (deps.now() - mapAt >= SESSION_MAP_FORCE_MIN_MS) await refreshMap();
    return botOf.get(key) ?? null;
  }

  function event(kind: MobilePushKind, bot: string, key: string, seq: number, text: string): PushEvent {
    return {
      kind,
      bot,
      session: key,
      seq,
      preview: text === "" ? "" : previewText(text, deps.redact),
    };
  }

  /** The session's tail, or `null` (logged) when it cannot be read. */
  async function tail(bot: string, key: string): Promise<ChatMessage[] | null> {
    try {
      return await deps.chat.history(box, bot, { session: key, limit: TAIL_ROWS });
    } catch (e) {
      deps.log(`push watcher: could not read the tail of ${key} (${errorText(e)})`);
      return null;
    }
  }

  /**
   * The push a turn that just settled deserves, read off its tail. `after` is
   * for a session gone from the list, whose leaving alone proves nothing: a
   * tail row written no later than it is not this turn's, and a session no
   * bot can be placed for has no tail to prove it by; either pushes nothing.
   * An event number is taken only for a push.
   */
  async function settled(key: string, after: number | null = null): Promise<PushEvent | null> {
    const bot = await resolveBot(key);
    if (bot === null) {
      return after === null ? event("message", UNKNOWN_BOT, key, nextEvent(key), "") : null;
    }
    const rows = await tail(bot, key);
    // The turn did settle; without its tail there is no excerpt, but silence
    // would be the worse answer.
    if (rows === null) return event("turn.done", bot, key, nextEvent(key), "");
    const verdict = tailRow(rows);
    if (verdict === null || (after !== null && verdict.at <= after)) return null;
    return event(verdict.kind, bot, key, nextEvent(key), verdict.text);
  }

  /**
   * The tail's verdict for a session whose listing alone proves nothing, when
   * the row it reads was written after `since`; otherwise `null`. A session
   * with no bot to read it under, or a tail that cannot be read, has no
   * evidence of news and pushes nothing.
   */
  async function freshTail(
    s: LiveSession,
    since: number | null,
  ): Promise<{ bot: string; kind: "turn.done" | "turn.error"; text: string } | null> {
    if (since === null) return null;
    const bot = await resolveBot(s.key);
    if (bot === null) return null;
    const rows = await tail(bot, s.key);
    if (rows === null) return null;
    const verdict = tailRow(rows);
    if (verdict === null || verdict.at <= since) return null;
    return { bot, kind: verdict.kind, text: verdict.text };
  }

  /**
   * The events between the last answer and `live`. `since` is when the last
   * answer was asked for, `askedAt` when this one was. Without a turn seen
   * under way, only a tail row written after `since` is news: a `respond`, a
   * compaction, a subagent reconcile or a cold resume's hydration brings a
   * session back into the list, and grows its count, without anything new
   * having been said.
   */
  async function diff(
    live: readonly LiveSession[],
    since: number | null,
    askedAt: number,
  ): Promise<PushEvent[]> {
    const events: PushEvent[] = [];
    const present = new Set<string>();
    for (const s of live) {
      present.add(s.key);
      const prev = seen.get(s.key);
      const grew = prev !== undefined && s.message_count > prev.count;
      // A count that drops is a compaction rewriting the transcript; if a turn
      // was running, it has still settled.
      const compacted = prev !== undefined && s.message_count < prev.count && prev.status === "working";
      // A turn seen running settles at the next idle whatever its count did:
      // the history is committed before the status flips, so the count may
      // already have grown while the session still showed `working`.
      const settles = s.status === "idle" && (grew || compacted || (prev?.turn ?? false));
      const turn = (TURN_STATUSES.has(s.status) || (prev?.turn ?? false)) && !settles;
      seen.set(s.key, {
        status: s.status,
        count: s.message_count,
        turn,
        turnSince: !turn ? null : prev?.turn === true ? prev.turnSince : (since ?? askedAt),
      });
      if (baseline) continue;
      if (s.status === "waiting") {
        if (prev?.status === "waiting") continue;
        const seq = nextEvent(s.key);
        const bot = await resolveBot(s.key);
        // No profile to open it under: the phone hears about it once it idles.
        if (bot !== null) events.push(event("needs_action", bot, s.key, seq, ""));
        continue;
      }
      if (s.status !== "idle") continue;
      if (prev === undefined) {
        // Arrived already settled (a routine, a channel): a `message`, if its
        // newest reply is new.
        if (s.message_count === 0) continue;
        const news = await freshTail(s, since);
        if (news !== null) events.push(event("message", news.bot, s.key, nextEvent(s.key), news.text));
        continue;
      }
      if (!settles) continue;
      if (prev.turn) {
        const pushed = await settled(s.key);
        if (pushed !== null) events.push(pushed);
        continue;
      }
      // Grown with no turn seen: a turn that ran wholly between two polls, or
      // a hydration — only a fresh tail row tells them apart.
      const news = await freshTail(s, since);
      if (news !== null) events.push(event(news.kind, news.bot, s.key, nextEvent(s.key), news.text));
    }
    for (const [key, prev] of [...seen]) {
      if (present.has(key)) continue;
      // Gone mid-turn: the orphan reaper pops a detached session soon after
      // its turn ends, possibly before any poll saw it idle. Its stored tail
      // still says how the turn ended, if the reply is newer than the turn — a
      // key rotated by a compression leaves too, and its turn settles under
      // the new key. A baseline knows nothing of what happened meanwhile.
      if (!baseline && prev.turn) {
        const pushed = await settled(key, prev.turnSince);
        if (pushed !== null) events.push(pushed);
      }
      seen.delete(key);
    }
    baseline = false;
    return events;
  }

  /**
   * A poll that failed without the unit going down. What was seen still
   * stands, so the next answer is diffed against it; only with nothing seen
   * is there nothing to diff against, and the next answer is a baseline.
   */
  function failed(reason: string): TickOutcome {
    if (seen.size === 0) baseline = true;
    return { kind: "down", reason };
  }

  async function tick(): Promise<TickOutcome> {
    try {
      await pruneDeparted();
      if (deps.gatewayUp && !(await deps.gatewayUp())) {
        baseline = true;
        return { kind: "idle" };
      }
      if (!deps.chat.botModeRpc) return { kind: "idle" };
      const askedAt = deps.now();
      let live: LiveSession[] | null;
      try {
        live = parseActiveList(await deps.chat.botModeRpc(box, "session.active_list", {}));
      } catch (e) {
        return failed(errorText(e));
      }
      if (live === null) return failed("session.active_list answered without a session list");
      if (deps.now() - mapAt >= tuning.mapRefreshMs) await refreshMap();
      const events = await diff(live, lastPollAt, askedAt);
      lastPollAt = askedAt;
      for (const e of events) await notifier.notify(e);
      return { kind: "ok", pushes: events };
    } catch (e) {
      return failed(errorText(e));
    }
  }

  async function run(signal: AbortSignal): Promise<void> {
    let failures = 0;
    let wasDown = false;
    while (!signal.aborted) {
      const outcome = await tick();
      let wait = tuning.pollMs;
      if (outcome.kind === "down") {
        failures += 1;
        if (!wasDown) deps.log(`push watcher: gateway not answering (${outcome.reason}); backing off`);
        wasDown = true;
        wait = Math.min(tuning.pollMs * 2 ** (failures - 1), tuning.backoffMaxMs);
      } else {
        if (wasDown && outcome.kind === "ok") deps.log("push watcher: gateway answering again");
        if (outcome.kind === "ok") wasDown = false;
        failures = 0;
        if (outcome.kind === "idle") wait = tuning.backoffMaxMs;
      }
      await notifier.pollReceipts().catch(() => undefined);
      if (signal.aborted) return;
      await deps.sleep(wait, signal).catch(() => undefined);
    }
  }

  return { tick, run, notifier };
}

/** How `peerOwner` (`rpc.ts`) names a tagged node's registration. */
const NODE_OWNER_PREFIX = "node:";

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
