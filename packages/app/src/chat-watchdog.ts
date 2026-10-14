/**
 * The chat owner's coverage keeper: insurance that every listened
 * `<instance>/<bot>` is actually being watched.
 *
 * ## Why this exists
 *
 * `chat-owner.ts` decides coverage at three moments — boot, `chat.listen`, a
 * §4.8 fleet switch — and each one reads the listened boxes' rosters once. A
 * box that was stopped or unreachable at that moment has no roster, so its bots
 * are never pinned; a conversation whose read failed for good (core's bounded
 * reconnect, `OBSERVE_RECONNECT_ATTEMPTS`) is remembered as failed and stays
 * that way until an operator presses `Watch again`. Nothing else ever looks
 * again. The result is the one failure this product must not have: a listened
 * conversation silently unwatched while the box is up and talking.
 *
 * ## What it does
 *
 * It looks again, cheaply, and only where it can help:
 *
 * - **A box came up** (`reachable`, the poller's `onReachable` hook) — one
 *   debounced `owner.sync()`, which re-reads the rosters and re-pins every
 *   listened conversation that is missing, failed ones included. The backoff
 *   for that box is reset: a box that just came up deserves an immediate try.
 * - **The roster shows a bot nobody watches** (`roster`, the poller's
 *   `onRoster` hook, which hands over the roster read it already paid for) —
 *   the same debounced sync, subject to that box's backoff.
 * - **The minute tick** (`tick`) — for each listened box the poller says is
 *   `ready`/`degraded`: a sync if its coverage has a hole; `owner.resume` for
 *   each failed conversation; `owner.restart` for a pinned one that has been
 *   reconnecting for longer than `CHAT_WATCHDOG_STALE_MS`. Each of the last two
 *   is behind its own exponential backoff.
 *
 * Every sync request inside the debounce window, and every one that arrives
 * while a sync is running, collapses into one: a burst of eleven boxes coming
 * up in one scan, plus the roster read that follows, is one `sync()`.
 *
 * ## What it never does
 *
 * Send a prompt, open a session, raise a notification or tell an operator
 * anything. It only calls `sync`, `resume` and `restart` on the owner, each of
 * which is an observation on this laptop and nothing on the box. It reads the
 * listen preference (local SQLite) and the poller's last scan; it never scans
 * the fleet or sweeps the tailnet itself. §8.3: what it logs names instances,
 * bots and counts — never a message, a transcript or a token.
 */
import type { AgentView, ChatSwarmsResult } from "@hermetic/core";
import type { ChatConversationRef, ChatObserveTarget, ChatOwner } from "./chat-owner.ts";
import { classifyFailure } from "./errors.ts";
import type { AppLog, LogLevel } from "./log.ts";

/** How often the watchdog looks. The fleet poller's own minute. */
export const CHAT_WATCHDOG_INTERVAL_MS = 60_000;
/** How long sync requests are gathered before one `sync()` answers them all. */
export const CHAT_RESYNC_DEBOUNCE_MS = 2_000;
/** The first retry delay for one box's coverage or one conversation; doubled per attempt. */
export const CHAT_WATCHDOG_BACKOFF_BASE_MS = 60_000;
/** The ceiling on that delay. */
export const CHAT_WATCHDOG_BACKOFF_MAX_MS = 600_000;
/**
 * How long a pinned conversation may sit in `reconnect` before its read loop
 * is presumed wedged and restarted. Core's own reconnect gives up (terminal
 * `error`) in a few minutes at most, so a streak this long is a loop that is
 * not going to end on its own.
 */
export const CHAT_WATCHDOG_STALE_MS = 600_000;

/** As much of the owner as the watchdog may touch: three levers and four reads. */
export type ChatWatchdogOwner = Pick<
  ChatOwner,
  "sync" | "resume" | "restart" | "owned" | "failed" | "health" | "epoch"
>;

/** One timer, cancelled by calling what it returned. */
export type ChatWatchdogSchedule = (run: () => void, ms: number) => () => void;

export interface ChatWatchdogDeps {
  owner: ChatWatchdogOwner;
  /** The instances the operator listens to (`chat.listening`): local, no box read. */
  listening: () => Promise<readonly string[]>;
  /** The poller's last scan, or `null` when there is no poller or no scan yet. */
  agents: () => readonly Pick<AgentView, "name" | "display_status">[] | null;
  log?: AppLog;
  /** Injected by tests. */
  now?: () => number;
  /** Injected by tests; production is an unref'd `setTimeout`. */
  schedule?: ChatWatchdogSchedule;
}

/** One backoff entry: which box or conversation, how many tries, and when the next may go. */
export interface ChatWatchdogBackoff {
  key: string;
  attempts: number;
  next_at: number;
}

export interface ChatWatchdogStatus {
  ticks: number;
  /** `owner.sync()` calls made. */
  syncs: number;
  /** Requests for a sync, before coalescing. */
  sync_requests: number;
  resumes: number;
  restarts: number;
  /** Listened instances a tick passed over: stopped, unknown or unreachable. */
  skipped: number;
  /** Actions held back by a backoff. */
  deferred: number;
  last_tick_at: number | null;
  last_sync_at: number | null;
  backoff: ChatWatchdogBackoff[];
}

export interface ChatWatchdog {
  /** Arm the tick. Idempotent; does nothing after `stop`. */
  start(): void;
  /** Disarm every timer; nothing fires afterwards. Idempotent and terminal. */
  stop(): void;
  /** The poller's `onReachable`: these agents just became worth talking to. */
  reachable(names: readonly string[]): Promise<void>;
  /** The poller's `onRoster`: the roster it just read. */
  roster(swarms: ChatSwarmsResult["swarms"]): Promise<void>;
  /** One look; the interval's, exposed for tests. Never overlaps itself. */
  tick(): Promise<void>;
  /** Resolves once no tick or sync is in flight; for tests. */
  idle(): Promise<void>;
  status(): ChatWatchdogStatus;
}

const SCOPE = "chat";

function defaultSchedule(run: () => void, ms: number): () => void {
  const timer = setTimeout(run, ms);
  // Insurance must not keep a quitting process alive.
  timer.unref?.();
  return () => clearTimeout(timer);
}

/** The statuses in which a box could plausibly answer; the poller's own rule. */
function isReachable(status: AgentView["display_status"] | undefined): boolean {
  return status === "ready" || status === "degraded";
}

function conversationKey(ref: ChatConversationRef): string {
  return JSON.stringify([ref.instance, ref.bot, ref.session]);
}

function target(ref: ChatConversationRef): ChatObserveTarget {
  return {
    instance: ref.instance,
    bot: ref.bot,
    ...(ref.session === null ? {} : { session: ref.session }),
  };
}

export function createChatWatchdog(deps: ChatWatchdogDeps): ChatWatchdog {
  const now = deps.now ?? Date.now;
  const schedule = deps.schedule ?? defaultSchedule;
  const { owner } = deps;

  function log(level: LogLevel, message: string, fields: Record<string, unknown> = {}): void {
    deps.log?.line(level, SCOPE, `watchdog: ${message}`, fields);
  }

  /** A throw as the owner logs one: code and masked message, never a body. */
  function masked(e: unknown): Record<string, unknown> {
    const failure = classifyFailure(e);
    return { code: failure.body.error.code, message: failure.body.error.message };
  }

  const counters = {
    ticks: 0,
    syncs: 0,
    sync_requests: 0,
    resumes: 0,
    restarts: 0,
    skipped: 0,
    deferred: 0,
    last_tick_at: null as number | null,
    last_sync_at: null as number | null,
  };

  /** Per-instance backoff for coverage syncs. */
  const instanceBackoff = new Map<string, { attempts: number; nextAt: number }>();
  /** Per-conversation backoff for resumes and restarts, keyed by `conversationKey`. */
  const conversationBackoff = new Map<string, { attempts: number; nextAt: number; instance: string }>();
  /** The last roster `roster()` saw for each listened instance: its bot names. */
  const rosters = new Map<string, Set<string>>();
  /** The owner's epoch these maps describe; a fleet switch empties them. */
  let epoch = owner.epoch();

  let stopped = false;
  let cancelTick: (() => void) | null = null;
  let cancelDebounce: (() => void) | null = null;
  let syncing: Promise<void> | null = null;
  /** A sync was asked for while one was running: run one more after it. */
  let again = false;
  let ticking: Promise<void> | null = null;

  /** Everything kept is about the set of subscriptions it was kept against. */
  function checkEpoch(): void {
    const current = owner.epoch();
    if (current === epoch) return;
    epoch = current;
    instanceBackoff.clear();
    conversationBackoff.clear();
    rosters.clear();
    log("debug", "state cleared", { reason: "owner reset" });
  }

  /**
   * Whether an action keyed `key` may run now, recording the attempt if so.
   * The first is immediate; after it the delay is base × 2^(n−1), capped.
   */
  function gate<T extends { attempts: number; nextAt: number }>(
    map: Map<string, T>,
    key: string,
    fresh: () => T,
  ): boolean {
    const t = now();
    const entry = map.get(key) ?? fresh();
    if (entry.attempts > 0 && t < entry.nextAt) {
      counters.deferred += 1;
      return false;
    }
    const delay = Math.min(
      CHAT_WATCHDOG_BACKOFF_BASE_MS * 2 ** entry.attempts,
      CHAT_WATCHDOG_BACKOFF_MAX_MS,
    );
    entry.attempts += 1;
    entry.nextAt = t + delay;
    map.set(key, entry);
    return true;
  }

  function gateInstance(instance: string): boolean {
    return gate(instanceBackoff, instance, () => ({ attempts: 0, nextAt: 0 }));
  }

  function gateConversation(ref: ChatConversationRef): boolean {
    return gate(conversationBackoff, conversationKey(ref), () => ({
      attempts: 0,
      nextAt: 0,
      instance: ref.instance,
    }));
  }

  /** A box that just came up starts its backoffs over. */
  function resetInstance(instance: string): void {
    instanceBackoff.delete(instance);
    for (const [key, entry] of conversationBackoff) {
      if (entry.instance === instance) conversationBackoff.delete(key);
    }
  }

  /* ── the one sync ──────────────────────────────────────────────────────── */

  function runSync(): void {
    cancelDebounce = null;
    if (stopped) return;
    counters.syncs += 1;
    counters.last_sync_at = now();
    log("debug", "sync");
    syncing = owner
      .sync()
      .catch((e: unknown) => {
        // `sync` promises never to throw; this is the belt to its braces.
        log("warn", "sync failed", masked(e));
      })
      .finally(() => {
        syncing = null;
        if (again && !stopped) {
          again = false;
          requestSync("follow-up");
        }
      });
  }

  /**
   * Ask for a sync. Requests inside the debounce window share one; a request
   * while a sync is running buys exactly one more after it.
   */
  function requestSync(reason: string): void {
    if (stopped) return;
    counters.sync_requests += 1;
    if (cancelDebounce !== null) return;
    if (syncing !== null) {
      again = true;
      return;
    }
    log("debug", "sync requested", { reason });
    cancelDebounce = schedule(runSync, CHAT_RESYNC_DEBOUNCE_MS);
  }

  /* ── coverage ──────────────────────────────────────────────────────────── */

  /** The bots of `instance` with a canonical conversation owned or remembered as failed. */
  function covered(
    instance: string,
    owned: readonly ChatConversationRef[],
    failed: readonly ChatConversationRef[],
  ): Set<string> {
    const bots = new Set<string>();
    for (const ref of [...owned, ...failed]) {
      if (ref.instance === instance && ref.session === null) bots.add(ref.bot);
    }
    return bots;
  }

  /**
   * Whether a listened, reachable instance has a hole: a bot its last roster
   * listed that is neither owned nor failed, or — no roster seen yet — nothing
   * at all held or failed for it.
   */
  function hasGap(
    instance: string,
    owned: readonly ChatConversationRef[],
    failed: readonly ChatConversationRef[],
  ): boolean {
    const have = covered(instance, owned, failed);
    const roster = rosters.get(instance);
    if (roster === undefined) return have.size === 0;
    for (const bot of roster) if (!have.has(bot)) return true;
    return false;
  }

  async function listened(): Promise<readonly string[] | null> {
    try {
      return await deps.listening();
    } catch (e) {
      log("debug", "listening read failed", masked(e));
      return null;
    }
  }

  /* ── the tick ──────────────────────────────────────────────────────────── */

  async function look(): Promise<void> {
    counters.ticks += 1;
    counters.last_tick_at = now();
    checkEpoch();
    const instances = await listened();
    if (instances === null || stopped) return;
    checkEpoch();
    for (const instance of [...rosters.keys()]) {
      if (!instances.includes(instance)) rosters.delete(instance);
    }
    for (const instance of [...instanceBackoff.keys()]) {
      if (!instances.includes(instance)) instanceBackoff.delete(instance);
    }
    if (instances.length === 0) return;

    const agents = deps.agents();
    if (agents === null) {
      counters.skipped += instances.length;
      log("debug", "tick skipped", { reason: "no fleet scan yet", instances: instances.length });
      return;
    }
    const status = new Map(agents.map((agent) => [agent.name, agent.display_status]));
    const reachable = new Set<string>();
    for (const instance of instances) {
      if (isReachable(status.get(instance))) {
        reachable.add(instance);
        continue;
      }
      counters.skipped += 1;
      log("debug", "instance skipped", { instance, status: status.get(instance) ?? "unknown" });
    }
    if (reachable.size === 0) return;

    const owned = owner.owned();
    const failed = owner.failed();
    const health = owner.health();

    // A conversation that is held and has had a good read is well again: its
    // backoff starts over the next time it fails.
    for (const entry of health) {
      if (entry.health === null && entry.session !== null)
        conversationBackoff.delete(conversationKey(entry.ref));
    }

    // (a) Coverage.
    let wantSync = false;
    for (const instance of reachable) {
      if (!hasGap(instance, owned, failed)) {
        instanceBackoff.delete(instance);
        continue;
      }
      if (gateInstance(instance)) {
        log("debug", "coverage gap", { instance });
        wantSync = true;
      }
    }
    if (wantSync) requestSync("coverage gap");

    // (b) Failed conversations, one at a time and never a whole sync.
    for (const ref of failed) {
      if (stopped) return;
      if (!reachable.has(ref.instance) || !gateConversation(ref)) continue;
      counters.resumes += 1;
      try {
        const result = await owner.resume(target(ref));
        log(result.observing ? "debug" : "warn", result.observing ? "resumed" : "resume declined", {
          instance: ref.instance,
          bot: ref.bot,
          listening: result.listening,
        });
      } catch (e) {
        log("warn", "resume failed", { instance: ref.instance, bot: ref.bot, ...masked(e) });
      }
    }

    // (c) A pinned read stuck in `reconnect` for too long.
    const t = now();
    for (const entry of health) {
      if (stopped) return;
      if (!entry.pinned || entry.health !== "reconnect" || entry.healthSince === null) continue;
      if (t - entry.healthSince <= CHAT_WATCHDOG_STALE_MS) continue;
      if (!reachable.has(entry.ref.instance) || !gateConversation(entry.ref)) continue;
      counters.restarts += 1;
      log("warn", "stale reconnect", {
        instance: entry.ref.instance,
        bot: entry.ref.bot,
        since_ms: t - entry.healthSince,
      });
      try {
        const restarted = await owner.restart(target(entry.ref), "watchdog: stale reconnect");
        if (!restarted)
          log("debug", "restart declined", { instance: entry.ref.instance, bot: entry.ref.bot });
      } catch (e) {
        log("warn", "restart failed", {
          instance: entry.ref.instance,
          bot: entry.ref.bot,
          ...masked(e),
        });
      }
    }
  }

  function tick(): Promise<void> {
    if (stopped) return Promise.resolve();
    if (ticking !== null) return ticking;
    const run = look()
      .catch((e: unknown) => {
        log("warn", "tick failed", masked(e));
      })
      .finally(() => {
        ticking = null;
      });
    ticking = run;
    return run;
  }

  function arm(): void {
    if (stopped) return;
    cancelTick = schedule(() => {
      cancelTick = null;
      void tick().finally(arm);
    }, CHAT_WATCHDOG_INTERVAL_MS);
  }

  return {
    start(): void {
      if (stopped || cancelTick !== null) return;
      log("debug", "started", { interval_ms: CHAT_WATCHDOG_INTERVAL_MS });
      arm();
    },
    stop(): void {
      if (stopped) return;
      stopped = true;
      cancelTick?.();
      cancelTick = null;
      cancelDebounce?.();
      cancelDebounce = null;
      again = false;
      log("debug", "stopped");
    },
    async reachable(names: readonly string[]): Promise<void> {
      if (stopped || names.length === 0) return;
      try {
        checkEpoch();
        const instances = await listened();
        if (instances === null || stopped) return;
        const up = names.filter((name) => instances.includes(name));
        if (up.length === 0) return;
        for (const name of up) resetInstance(name);
        log("debug", "instances reachable", { instances: up });
        requestSync("reachable");
      } catch (e) {
        log("warn", "reachable hook failed", masked(e));
      }
    },
    async roster(swarms: ChatSwarmsResult["swarms"]): Promise<void> {
      if (stopped) return;
      try {
        checkEpoch();
        const instances = await listened();
        if (instances === null || stopped) return;
        const owned = owner.owned();
        const failed = owner.failed();
        let wantSync = false;
        for (const swarm of swarms) {
          // A roster entry for a box that did not answer says nothing about
          // its bots; keep what was last seen.
          if (!instances.includes(swarm.instance) || !swarm.reachable) continue;
          rosters.set(swarm.instance, new Set(swarm.bots.map((bot) => bot.name)));
          if (!hasGap(swarm.instance, owned, failed)) continue;
          if (gateInstance(swarm.instance)) {
            log("debug", "roster gap", { instance: swarm.instance });
            wantSync = true;
          }
        }
        if (wantSync) requestSync("roster gap");
      } catch (e) {
        log("warn", "roster hook failed", masked(e));
      }
    },
    tick,
    async idle(): Promise<void> {
      for (;;) {
        const busy = ticking ?? syncing;
        if (busy === null) return;
        await busy;
      }
    },
    status(): ChatWatchdogStatus {
      const backoff: ChatWatchdogBackoff[] = [];
      for (const [key, entry] of instanceBackoff)
        backoff.push({ key, attempts: entry.attempts, next_at: entry.nextAt });
      for (const [key, entry] of conversationBackoff)
        backoff.push({ key, attempts: entry.attempts, next_at: entry.nextAt });
      return { ...counters, backoff };
    },
  };
}
