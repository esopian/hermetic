/**
 * The Bots list: swarms grouped into a pinned block and per-instance buckets,
 * filtered and ordered the way the desktop rail orders them.
 *
 * The ordering and badge rules are mirrors of `packages/ui/src/chat/chat-logic.ts`
 * (`railUnread`, `unreadBadge`, `compareBots`, `compareBuckets`, `railBuckets`)
 * and `chat-rail-prefs.ts` (`bucketSignal`); the pinned block mirrors
 * `components/BotRail.tsx` (pinned bots lifted out of their buckets, in pin
 * order). Pure: the store holds state and notifies; persistence of pins and
 * folds is the caller's (`RosterPrefsStorage`).
 */
import type { Bot, ChatRole, Swarm } from "@hermetic/core/chat-client";

export type RailFilter = "all" | "unread" | "needs";

/* ── rules (desktop mirrors) ────────────────────────────────────────────── */

/** Roster count vs inbox count of the same messages: the larger, never the sum. */
export function railUnread(bot: { unread: number }, extra = 0): number {
  return Math.max(bot.unread, Math.max(0, extra));
}

/** `!` when blocked on the operator, the count when merely unread, else nothing. */
export function unreadBadge(bot: { unread: number; needs_action: boolean }, extra = 0): string | null {
  if (bot.needs_action) return "!";
  const unread = railUnread(bot, extra);
  if (unread > 0) return String(unread);
  return null;
}

const time = (iso: string | null | undefined): number => {
  if (!iso) return 0;
  const at = new Date(iso).getTime();
  return Number.isNaN(at) ? 0 : at;
};

/** Needs-you, then unread, then most recent, then the default bot, then name. */
export function compareBots(a: Bot, b: Bot): number {
  if (a.needs_action !== b.needs_action) return a.needs_action ? -1 : 1;
  const aUnread = a.unread > 0;
  const bUnread = b.unread > 0;
  if (aUnread !== bUnread) return aUnread ? -1 : 1;
  const at = time(b.last_message_at) - time(a.last_message_at);
  if (at !== 0) return at;
  if (a.is_default !== b.is_default) return a.is_default ? -1 : 1;
  return a.name.localeCompare(b.name);
}

export interface RailBucket {
  instance: string;
  reachable: boolean;
  reason: string | null;
  warmUsed: number;
  warmTotal: number | null;
  botCount: number;
  unread: number;
  needsAction: boolean;
  needsCount: number;
  lastAt: string | null;
  bots: Bot[];
  /** Folded by the operator (never while searching, never when unreachable). */
  folded: boolean;
}

/** An unreachable box sinks (never hides); the rest sort the way their bots do. */
export function compareBuckets(
  a: Pick<RailBucket, "reachable" | "needsAction" | "unread" | "lastAt" | "instance">,
  b: Pick<RailBucket, "reachable" | "needsAction" | "unread" | "lastAt" | "instance">,
): number {
  if (a.reachable !== b.reachable) return a.reachable ? -1 : 1;
  if (a.needsAction !== b.needsAction) return a.needsAction ? -1 : 1;
  const aUnread = a.unread > 0;
  const bUnread = b.unread > 0;
  if (aUnread !== bUnread) return aUnread ? -1 : 1;
  const at = time(b.lastAt) - time(a.lastAt);
  if (at !== 0) return at;
  return a.instance.localeCompare(b.instance);
}

/** What a folded bucket header still says. */
export function bucketSignal(
  bots: readonly Bot[],
  unreadOf: (bot: Bot) => number,
): { unread: number; needs: number } {
  let unread = 0;
  let needs = 0;
  for (const bot of bots) {
    if (bot.needs_action) needs += 1;
    unread += unreadOf(bot);
  }
  return { unread, needs };
}

export function matchesQuery(bot: Bot, needle: string): boolean {
  const q = needle.trim().toLowerCase();
  if (!q) return true;
  return (
    bot.name.toLowerCase().includes(q) ||
    bot.instance.toLowerCase().includes(q) ||
    (bot.title ?? "").toLowerCase().includes(q) ||
    (bot.description ?? "").toLowerCase().includes(q) ||
    (bot.section ?? "").toLowerCase().includes(q)
  );
}

export function matchesFilter(bot: Bot, filter: RailFilter, extra = 0): boolean {
  if (filter === "unread") return railUnread(bot, extra) > 0 || bot.needs_action;
  if (filter === "needs") return bot.needs_action;
  return true;
}

export const botKey = (instance: string, bot: string): string => `${instance}/${bot}`;

/* ── the grouped list ───────────────────────────────────────────────────── */

export interface RosterLayout {
  pinned: Bot[];
  buckets: RailBucket[];
  /** Fleet-wide counts for the tab badge and the footer. */
  botCount: number;
  instanceCount: number;
  needsYou: number;
  unread: number;
}

export interface LayoutOptions {
  filter?: RailFilter;
  query?: string;
  pinned?: readonly string[];
  folded?: readonly string[];
  /** The inbox's unread `chat.*` rows for one bot (`NotificationsStore.unreadFor`). */
  unreadOf?: (instance: string, bot: string) => number;
}

export function rosterLayout(swarms: readonly Swarm[], opts: LayoutOptions = {}): RosterLayout {
  const filter = opts.filter ?? "all";
  const query = (opts.query ?? "").trim();
  const searching = query !== "";
  const unreadOf = opts.unreadOf ?? (() => 0);
  const pinnedKeys = opts.pinned ?? [];
  const pinnedSet = new Set(pinnedKeys);
  const folded = new Set(opts.folded ?? []);
  const shown = (bot: Bot) =>
    matchesFilter(bot, filter, unreadOf(bot.instance, bot.name)) && matchesQuery(bot, query);
  const extra = (bot: Bot) => unreadOf(bot.instance, bot.name);

  const byKey = new Map(
    swarms.flatMap((s) => s.bots.map((b) => [botKey(b.instance, b.name), b] as const)),
  );
  // A pin whose bot is gone draws nothing and stays stored.
  const pinned = pinnedKeys
    .map((k) => byKey.get(k))
    .filter((b): b is Bot => b !== undefined && shown(b));

  const buckets: RailBucket[] = [];
  for (const swarm of swarms) {
    const kept = swarm.bots.filter((b) => shown(b) && !pinnedSet.has(botKey(b.instance, b.name)));
    if (kept.length === 0 && swarm.reachable) continue;
    const sorted = [...kept].sort(compareBots);
    buckets.push({
      instance: swarm.instance,
      reachable: swarm.reachable,
      reason: swarm.unreachable_reason ?? null,
      warmUsed: swarm.warm_slots.used,
      warmTotal: swarm.warm_slots.total,
      botCount: swarm.bots.length,
      unread: kept.reduce((n, b) => n + railUnread(b, extra(b)), 0),
      needsAction: kept.some((b) => b.needs_action),
      needsCount: kept.filter((b) => b.needs_action).length,
      lastAt:
        kept
          .map((b) => b.last_message_at ?? null)
          .filter((v): v is string => !!v)
          .sort()
          .pop() ?? null,
      bots: sorted,
      folded: swarm.reachable && !searching && folded.has(swarm.instance),
    });
  }
  buckets.sort(compareBuckets);

  const all = swarms.flatMap((s) => s.bots);
  return {
    pinned,
    buckets,
    botCount: all.length,
    instanceCount: swarms.length,
    needsYou: all.filter((b) => b.needs_action).length,
    unread: all.reduce((n, b) => n + railUnread(b, extra(b)), 0),
  };
}

/** The footer line: "N instances · M bots" and "K need you". */
export function rosterFooter(layout: RosterLayout): { roster: string; attention: string } {
  const { instanceCount: n, botCount: m, needsYou: k } = layout;
  return {
    roster: `${n} instance${n === 1 ? "" : "s"} · ${m} bot${m === 1 ? "" : "s"}`,
    attention: k === 0 ? "nothing waiting" : `${k} need${k === 1 ? "s" : ""} you`,
  };
}

/* ── the rail, ahead of the roster ───────────────────────────────────────── */

/**
 * Something this phone saw land in a bot's conversation — its own turn's reply,
 * or a message the observation delivered — before a roster read has.
 *
 * Mirror of the desktop's `ChatArrival` (`packages/ui/src/chat/chat-conversations.ts`).
 * `unread` adds one to the badge; `false` means the thread is on screen, so the
 * row's count is cleared locally (the phone's `markSeen` rule). `preview`
 * moves the quote and who wrote it together; `null` leaves the roster's.
 */
export interface RosterArrival {
  instance: string;
  bot: string;
  /** The box's stamp; `null` when only this phone's clock knows, which never moves the time. */
  at: string | null;
  unread: boolean;
  preview: { preview: string; preview_role: ChatRole | null } | null;
}

/**
 * One bot's arrivals, held until a roster read covers them — the desktop's
 * `RailBump` (`packages/ui/src/chat/chat-state.tsx`). `seq` is what keeps the
 * two honest: a roster read discards every bump stamped before it started, and
 * keeps the ones that landed while it was in flight.
 */
interface RailBump {
  unread: number;
  /** The thread was on screen when this landed: the roster's own count is stale. */
  seen: boolean;
  at: string | null;
  preview: RosterArrival["preview"];
  seq: number;
}

/** The later of two timestamps, tolerating a null or an unparseable one. */
function newest(a: string | null | undefined, b: string | null | undefined): string | null {
  if (!a) return b ?? null;
  if (!b) return a;
  const left = Date.parse(a);
  const right = Date.parse(b);
  if (Number.isNaN(left)) return b;
  if (Number.isNaN(right)) return a;
  return right > left ? b : a;
}

/** Fold the local bumps into the roster the list draws (desktop `withBumps`). */
export function withBumps(
  swarms: readonly Swarm[],
  bumps: ReadonlyMap<string, Omit<RailBump, "seq">>,
): Swarm[] {
  if (bumps.size === 0) return swarms as Swarm[];
  return swarms.map((swarm) => {
    let touched = false;
    const bots = swarm.bots.map((bot) => {
      const bump = bumps.get(botKey(swarm.instance, bot.name));
      if (!bump) return bot;
      const at = newest(bot.last_message_at, bump.at);
      const unread = (bump.seen ? 0 : bot.unread) + bump.unread;
      if (unread === bot.unread && at === (bot.last_message_at ?? null) && !bump.preview) return bot;
      touched = true;
      return { ...bot, ...bump.preview, unread, last_message_at: at };
    });
    return touched ? { ...swarm, bots } : swarm;
  });
}

/* ── the store ──────────────────────────────────────────────────────────── */

export interface RosterPrefs {
  pinned: string[];
  folded: string[];
}

/** Where pins and folds live between launches (per fleet). */
export interface RosterPrefsStorage {
  load(fleetId: string): Promise<RosterPrefs | null>;
  save(fleetId: string, prefs: RosterPrefs): Promise<void>;
}

export interface RosterState {
  swarms: readonly Swarm[];
  listening: readonly string[];
  loading: boolean;
  error: string | null;
  /** When the last successful read landed (ms epoch). */
  readAt: number | null;
  filter: RailFilter;
  query: string;
  prefs: RosterPrefs;
}

export interface RosterSource {
  swarms(): Promise<{ swarms: Swarm[] }>;
  listening(): Promise<{ instances: string[] }>;
  listen(instance: string, listening: boolean): Promise<{ instances: string[] }>;
}

export class RosterStore {
  private state: RosterState = {
    swarms: [],
    listening: [],
    loading: false,
    error: null,
    readAt: null,
    filter: "all",
    query: "",
    prefs: { pinned: [], folded: [] },
  };
  private readonly listeners = new Set<() => void>();
  private gen = 0;
  private fleetId: string | null = null;
  /** The last roster read, before any bump is folded in. */
  private listed: readonly Swarm[] = [];
  private bumps = new Map<string, RailBump>();
  private bumpSeq = 0;

  constructor(
    private readonly source: RosterSource,
    private readonly storage: RosterPrefsStorage | null = null,
    private readonly now: () => number = Date.now,
  ) {}

  getState(): RosterState {
    return this.state;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  layout(unreadOf?: (instance: string, bot: string) => number): RosterLayout {
    const s = this.state;
    return rosterLayout(s.swarms, {
      filter: s.filter,
      query: s.query,
      pinned: s.prefs.pinned,
      folded: s.prefs.folded,
      ...(unreadOf ? { unreadOf } : {}),
    });
  }

  async setFleet(fleetId: string): Promise<void> {
    this.fleetId = fleetId;
    const prefs = (await this.storage?.load(fleetId)) ?? { pinned: [], folded: [] };
    if (this.fleetId === fleetId) this.set({ prefs });
  }

  /** Read swarms and listening together. A stale answer never overwrites a newer one. */
  async refresh(): Promise<boolean> {
    const gen = ++this.gen;
    // Every bump stamped up to here is answered for by the read below.
    const mark = this.bumpSeq;
    this.set({ loading: true });
    try {
      const [swarms, listening] = await Promise.all([this.source.swarms(), this.source.listening()]);
      if (gen !== this.gen) return false;
      this.listed = swarms.swarms;
      this.bumps = new Map([...this.bumps].filter(([, bump]) => bump.seq > mark));
      this.set({
        swarms: withBumps(this.listed, this.bumps),
        listening: listening.instances,
        loading: false,
        error: null,
        readAt: this.now(),
      });
      return true;
    } catch (error) {
      if (gen !== this.gen) return false;
      this.set({ loading: false, error: error instanceof Error ? error.message : String(error) });
      return false;
    }
  }

  /** The fleet store's listening choice changed. */
  setListening(instances: readonly string[]): void {
    this.set({ listening: [...instances] });
  }

  async listen(instance: string, listening: boolean): Promise<void> {
    const before = this.state.listening;
    // Optimistic: the switch moves at once and snaps back on refusal.
    this.set({
      listening: listening ? [...new Set([...before, instance])] : before.filter((i) => i !== instance),
    });
    try {
      const result = await this.source.listen(instance, listening);
      this.set({ listening: result.instances });
      void this.refresh();
    } catch (error) {
      this.set({ listening: before });
      throw error;
    }
  }

  setFilter(filter: RailFilter): void {
    this.set({ filter });
  }

  setQuery(query: string): void {
    this.set({ query });
  }

  togglePinned(instance: string, bot: string): void {
    const key = botKey(instance, bot);
    const pinned = this.state.prefs.pinned.includes(key)
      ? this.state.prefs.pinned.filter((k) => k !== key)
      : [...this.state.prefs.pinned, key];
    this.savePrefs({ ...this.state.prefs, pinned });
  }

  toggleFolded(instance: string): void {
    const folded = this.state.prefs.folded.includes(instance)
      ? this.state.prefs.folded.filter((k) => k !== instance)
      : [...this.state.prefs.folded, instance];
    this.savePrefs({ ...this.state.prefs, folded });
  }

  /** Locally clear a bot's unread once its conversation is opened (the next read is authoritative). */
  markSeen(instance: string, bot: string): void {
    let touched = false;
    this.listed = this.listed.map((swarm) => {
      if (swarm.instance !== instance) return swarm;
      const bots = swarm.bots.map((b) => {
        if (b.name !== bot || b.unread === 0) return b;
        touched = true;
        return { ...b, unread: 0 };
      });
      return touched ? { ...swarm, bots } : swarm;
    });
    const key = botKey(instance, bot);
    const held = this.bumps.get(key);
    if (held && held.unread > 0) {
      this.bumps.set(key, { ...held, unread: 0 });
      touched = true;
    }
    if (touched) this.set({ swarms: withBumps(this.listed, this.bumps) });
  }

  /**
   * A reply or message landed in a bot's conversation: move its row now —
   * quote, time, badge — instead of saying "No messages yet" until the next
   * poll. Additive over the last read, which stays authoritative and prunes it.
   */
  noteArrival(arrival: RosterArrival): void {
    const key = botKey(arrival.instance, arrival.bot);
    const held = this.bumps.get(key);
    this.bumps.set(key, {
      unread: arrival.unread ? (held?.unread ?? 0) + 1 : 0,
      seen: !arrival.unread || (held?.seen ?? false),
      at: newest(held?.at, arrival.at),
      // An arrival that quotes nothing keeps whatever the last one quoted.
      preview: arrival.preview ?? held?.preview ?? null,
      seq: ++this.bumpSeq,
    });
    this.set({ swarms: withBumps(this.listed, this.bumps) });
  }

  reset(): void {
    this.gen += 1;
    this.fleetId = null;
    this.listed = [];
    this.bumps = new Map();
    this.set({
      swarms: [],
      listening: [],
      loading: false,
      error: null,
      readAt: null,
      query: "",
      filter: "all",
    });
  }

  private savePrefs(prefs: RosterPrefs): void {
    this.set({ prefs });
    if (this.fleetId && this.storage) void this.storage.save(this.fleetId, prefs).catch(() => {});
  }

  private set(patch: Partial<RosterState>): void {
    this.state = { ...this.state, ...patch };
    for (const l of [...this.listeners]) l();
  }
}
