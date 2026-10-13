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
 * | → `idle` with `message_count` grown, tail is a bot | `turn.done`, reply preview |
 * | the same, tail row carries a failure               | `turn.error`, failure text |
 * | any → `waiting`                                    | `needs_action`             |
 * | a session not seen before, first seen `idle`, > 0  | `message` (routine/channel)|
 *
 * The tail is read with the chat adapter's `history`, which needs the bot (the
 * Hermes profile) the session belongs to; `swarm` + `sessions` map session →
 * bot every `SESSION_MAP_REFRESH_MS`, and once more on demand when a session
 * the map does not know reaches a transition. A session still unknown after
 * that is pushed under bot `unknown`, as a `message` only, once it goes idle —
 * there is no profile to read its tail from or to open it under.
 *
 * The first answer after start, and after any outage, is a *baseline*: it is
 * recorded and pushes nothing, so a daemon restart does not replay every live
 * session to every phone.
 *
 * Never crashes the daemon. A gateway that does not answer backs the loop off
 * from `WATCH_POLL_MS` to `WATCH_BACKOFF_MAX_MS`; a box whose Hermes unit is
 * not running (`gatewayUp` false) idles at the same slow rate without asking.
 */
import type { BoxAddress, ChatMessage, HermesChatClient } from "@hermetic/core/chat-client";
import type { ExpoPushSender, ExpoReceiptFetcher } from "@hermetic/core/shared";
import type { MobilePushKind } from "@hermetic/core/schema";
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
  readonly preview: string;
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
      preview: typeof row["preview"] === "string" ? row["preview"] : "",
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
  for (let i = rows.length - 1; i >= 0; i--) {
    const row = rows[i];
    if (row === undefined) continue;
    if (row.failure || (typeof row.error === "string" && row.error !== "")) {
      return { kind: "turn.error", text: row.failure?.message || row.error || "the turn failed" };
    }
    if (row.role === "bot") return { kind: "turn.done", text: rowText(row) };
    if (row.role === "user") return null;
  }
  return null;
}

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

  const seen = new Map<string, { status: string; count: number }>();
  const botOf = new Map<string, string>();
  let mapAt = Number.NEGATIVE_INFINITY;
  let baseline = true;

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

  function event(kind: MobilePushKind, bot: string, s: LiveSession, text: string): PushEvent {
    return {
      kind,
      bot,
      session: s.key,
      message_count: s.message_count,
      body: previewText(text, deps.redact),
    };
  }

  /** The push a turn that just settled deserves, read off its tail. */
  async function settled(s: LiveSession): Promise<PushEvent | null> {
    const bot = await resolveBot(s.key);
    if (bot === null) return event("message", UNKNOWN_BOT, s, s.preview);
    let rows: ChatMessage[];
    try {
      rows = await deps.chat.history(box, bot, { session: s.key, limit: TAIL_ROWS });
    } catch (e) {
      // The turn did settle; without its tail, the gateway's own preview is
      // the best description of it, and silence would be the worse answer.
      deps.log(`push watcher: could not read the tail of ${s.key} (${errorText(e)})`);
      return event("turn.done", bot, s, s.preview);
    }
    const verdict = tailVerdict(rows);
    return verdict === null ? null : event(verdict.kind, bot, s, verdict.text);
  }

  async function diff(live: readonly LiveSession[]): Promise<PushEvent[]> {
    const events: PushEvent[] = [];
    const present = new Set<string>();
    for (const s of live) {
      present.add(s.key);
      const prev = seen.get(s.key);
      seen.set(s.key, { status: s.status, count: s.message_count });
      if (baseline) continue;
      if (s.status === "waiting") {
        if (prev?.status === "waiting") continue;
        const bot = await resolveBot(s.key);
        // No profile to open it under: the phone hears about it once it idles.
        if (bot !== null) events.push(event("needs_action", bot, s, `${bot} is waiting on you`));
        continue;
      }
      if (s.status !== "idle") continue;
      if (prev === undefined) {
        if (s.message_count > 0) {
          const bot = (await resolveBot(s.key)) ?? UNKNOWN_BOT;
          events.push(event("message", bot, s, s.preview));
        }
        continue;
      }
      if (s.message_count > prev.count) {
        const pushed = await settled(s);
        if (pushed !== null) events.push(pushed);
      }
    }
    for (const key of [...seen.keys()]) if (!present.has(key)) seen.delete(key);
    baseline = false;
    return events;
  }

  async function tick(): Promise<TickOutcome> {
    try {
      if (deps.gatewayUp && !(await deps.gatewayUp())) {
        baseline = true;
        return { kind: "idle" };
      }
      if (!deps.chat.botModeRpc) return { kind: "idle" };
      let live: LiveSession[] | null;
      try {
        live = parseActiveList(await deps.chat.botModeRpc(box, "session.active_list", {}));
      } catch (e) {
        baseline = true;
        return { kind: "down", reason: errorText(e) };
      }
      if (live === null) {
        baseline = true;
        return { kind: "down", reason: "session.active_list answered without a session list" };
      }
      if (deps.now() - mapAt >= tuning.mapRefreshMs) await refreshMap();
      const events = await diff(live);
      for (const e of events) await notifier.notify(e);
      return { kind: "ok", pushes: events };
    } catch (e) {
      baseline = true;
      return { kind: "down", reason: errorText(e) };
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

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
