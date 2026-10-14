/**
 * The phone's own inbox (§9.4): the last 200 things that happened in the
 * conversations it listens to — pushes received from the boxes and events its
 * own live sockets delivered — kept in a JSON file in the document directory.
 * No laptop store is read. Unread counts drive the app icon badge and the
 * per-bot badges on home.
 *
 * Two paths deliver one event: a box's watcher pushes it (Expo), and a socket
 * this phone holds open may show it first. Both carry a `dedupe` key — the
 * box's is `<instance>:<session>:<message_count>:<kind>` — and `ingest` keeps
 * one entry per key. A socket-delivered event does not know the box's message
 * count, so its key is phone-local (`PHONE_DEDUPE_MARK`), and a phone-local
 * entry and a box push for the same conversation and kind within
 * `SAME_EVENT_MS` of each other are the same event too. Two box pushes are
 * the same event only when their keys are: two approvals seconds apart are two
 * things to answer.
 *
 * And the one decision that matters on a phone: whether an event interrupts —
 * in-app banner, local notification, or nothing — without alerting twice
 * (`alertFor`). Pure: the file and the clock are injected.
 */
import type { Swarm } from "@hermetic/core/chat-client";
import type { MobilePushData, MobilePushKind } from "@hermetic/core/schema";

/** The last this many entries are kept. */
export const INBOX_LIMIT = 200;
/** A phone-local entry and a box push for one conversation and kind this close together are one event. */
export const SAME_EVENT_MS = 2 * 60_000;
/** What marks a `dedupe` key this phone minted for an event its own socket showed (`localDedupe`). */
export const PHONE_DEDUPE_MARK = ":phone-";

const phoneLocal = (dedupe: string): boolean => dedupe.includes(PHONE_DEDUPE_MARK);

/**
 * Whether a push is about the fleet this phone is paired with: the same
 * `fleet_id`, and an agent the fleet has. Checked before a push is filed or
 * shown, so a stale registration on a box of another fleet (or a re-paired
 * phone's old one) cannot drop entries into this inbox.
 */
export function pushBelongs(
  data: Pick<MobilePushData, "fleet_id" | "instance">,
  fleet: { fleet_id: string; agents: readonly string[] },
): boolean {
  return data.fleet_id === fleet.fleet_id && fleet.agents.includes(data.instance);
}

export interface InboxEntry {
  id: string;
  kind: MobilePushKind;
  instance: string;
  bot: string;
  session: string;
  title: string;
  body: string;
  /** ISO-8601, when the event happened (or arrived). */
  at: string;
  read_at: string | null;
  dedupe: string;
}

/** What `ingest` is handed: an entry before the inbox has numbered it. */
export type InboxArrival = Omit<InboxEntry, "id" | "read_at"> & { read_at?: string | null };

/** A push's `data` and its visible text, as an arrival. */
export function arrivalFromPush(
  data: MobilePushData,
  content: { title?: string | null; body?: string | null },
  at: string,
): InboxArrival {
  return {
    kind: data.kind,
    instance: data.instance,
    bot: data.bot,
    session: data.session,
    // The box's own title rule (`pushTitle`): the instance only when it differs from the bot.
    title:
      content.title?.trim() ||
      (data.bot === data.instance ? data.bot : `${data.bot} · ${data.instance}`),
    body: content.body?.trim() ?? "",
    at,
    dedupe: data.dedupe,
  };
}

/** The file the inbox lives in (`TextFile` in `src/fleet/store.ts`, structurally). */
export interface InboxFile {
  read(): Promise<string | null>;
  write(text: string): Promise<void>;
  remove(): Promise<void>;
}

export interface InboxState {
  /** Newest first. */
  entries: readonly InboxEntry[];
  unread: number;
  needsAction: number;
}

const KINDS: readonly MobilePushKind[] = ["turn.done", "turn.error", "needs_action", "message"];

function isEntry(v: unknown): v is InboxEntry {
  if (!v || typeof v !== "object") return false;
  const e = v as Record<string, unknown>;
  return (
    typeof e.id === "string" &&
    KINDS.includes(e.kind as MobilePushKind) &&
    typeof e.instance === "string" &&
    typeof e.bot === "string" &&
    typeof e.session === "string" &&
    typeof e.title === "string" &&
    typeof e.body === "string" &&
    typeof e.at === "string" &&
    (e.read_at === null || typeof e.read_at === "string") &&
    typeof e.dedupe === "string"
  );
}

const time = (iso: string): number => {
  const t = Date.parse(iso);
  return Number.isNaN(t) ? 0 : t;
};

function sameEvent(
  a: Pick<InboxEntry, "dedupe" | "kind" | "instance" | "bot" | "session" | "at">,
  b: typeof a,
) {
  // The window folds the two paths of one event, never two events on one path.
  if (phoneLocal(a.dedupe) === phoneLocal(b.dedupe)) return false;
  return (
    a.kind === b.kind &&
    a.instance === b.instance &&
    a.bot === b.bot &&
    a.session === b.session &&
    Math.abs(time(a.at) - time(b.at)) <= SAME_EVENT_MS
  );
}

export class InboxStore {
  private state: InboxState = { entries: [], unread: 0, needsAction: 0 };
  private readonly listeners = new Set<() => void>();
  private seq = 0;
  private unreadIndex: Map<string, number> | null = null;
  private writing: Promise<void> = Promise.resolve();

  constructor(
    private readonly file: InboxFile,
    private readonly now: () => string = () => new Date().toISOString(),
  ) {}

  getState(): InboxState {
    return this.state;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** Read the file. A missing or unreadable one is an empty inbox. */
  async load(): Promise<void> {
    let entries: InboxEntry[] = [];
    try {
      const text = await this.file.read();
      const parsed = text ? (JSON.parse(text) as unknown) : [];
      if (Array.isArray(parsed)) entries = parsed.filter(isEntry);
    } catch {
      entries = [];
    }
    this.seq = entries.reduce((n, e) => Math.max(n, Number(e.id.replace(/^\D+/, "")) || 0), 0);
    this.set(sortEntries(entries).slice(0, INBOX_LIMIT), false);
  }

  /** Whether an event with this key (or this conversation, kind and moment) is already here. */
  has(arrival: Pick<InboxEntry, "dedupe" | "kind" | "instance" | "bot" | "session" | "at">): boolean {
    return this.state.entries.some((e) => e.dedupe === arrival.dedupe || sameEvent(e, arrival));
  }

  /** Keep `arrival` unless it is already here. `true` when it is new. */
  ingest(arrival: InboxArrival): boolean {
    if (this.has(arrival)) return false;
    const entry: InboxEntry = {
      ...arrival,
      id: `i${++this.seq}`,
      read_at: arrival.read_at ?? null,
    };
    this.set(sortEntries([entry, ...this.state.entries]).slice(0, INBOX_LIMIT));
    return true;
  }

  markRead(ids: readonly string[]): void {
    if (ids.length === 0) return;
    const wanted = new Set(ids);
    const at = this.now();
    let touched = false;
    const entries = this.state.entries.map((e) => {
      if (!wanted.has(e.id) || e.read_at) return e;
      touched = true;
      return { ...e, read_at: at };
    });
    if (touched) this.set(entries);
  }

  /**
   * One event is over (a request answered or closed): mark read every unread
   * entry that is it, by its key or as the other path of the same event
   * (`sameEvent`: a box push folded with this phone's own entry). `fold:
   * false` reads the key alone: a box push names its waiting spell, not a
   * request, so while another request of that conversation is still open the
   * push may be about that one too, and it stays.
   */
  markEventRead(
    event: Pick<InboxEntry, "dedupe" | "kind" | "instance" | "bot" | "session" | "at">,
    { fold = true }: { fold?: boolean } = {},
  ): void {
    this.markRead(
      this.state.entries
        .filter((e) => !e.read_at && (e.dedupe === event.dedupe || (fold && sameEvent(e, event))))
        .map((e) => e.id),
    );
  }

  /** The conversation was opened: everything about it is read. */
  markThreadRead(instance: string, bot: string): void {
    this.markRead(
      this.state.entries
        .filter((e) => !e.read_at && e.instance === instance && e.bot === bot)
        .map((e) => e.id),
    );
  }

  /**
   * Mark read every unread entry `live` turns down: entries no screen can show
   * any more (a bot its box no longer lists), which would otherwise hold the
   * app badge up with nothing to clear it.
   */
  markReadUnless(live: (entry: InboxEntry) => boolean): void {
    this.markRead(this.state.entries.filter((e) => !e.read_at && !live(e)).map((e) => e.id));
  }

  /** Unread entries about one bot, for the bot's badge on home. */
  unreadFor = (instance: string, bot: string): number => {
    if (!this.unreadIndex) {
      const index = new Map<string, number>();
      for (const e of this.state.entries) {
        if (e.read_at) continue;
        const key = `${e.instance}/${e.bot}`;
        index.set(key, (index.get(key) ?? 0) + 1);
      }
      this.unreadIndex = index;
    }
    return this.unreadIndex.get(`${instance}/${bot}`) ?? 0;
  };

  /**
   * The app icon badge: everything unread, or only what `counted` keeps (the
   * instances this phone listens to). An instance no longer listened to keeps
   * its entries unread, so listening again brings its marks back, but they do
   * not hold the badge up meanwhile.
   */
  badgeCount(counted?: (entry: InboxEntry) => boolean): number {
    if (!counted) return this.state.unread;
    return this.state.entries.filter((e) => !e.read_at && counted(e)).length;
  }

  /** Forget everything (sign out). */
  async clear(): Promise<void> {
    this.seq = 0;
    this.set([], false);
    await this.file.remove().catch(() => {});
  }

  /** Resolves once every write queued so far has landed (for tests and shutdown). */
  flushed(): Promise<void> {
    return this.writing;
  }

  private set(entries: InboxEntry[], save = true): void {
    const unread = entries.filter((e) => !e.read_at);
    this.state = {
      entries,
      unread: unread.length,
      needsAction: unread.filter((e) => e.kind === "needs_action").length,
    };
    this.unreadIndex = null;
    if (save) {
      const text = JSON.stringify(entries);
      this.writing = this.writing.then(() => this.file.write(text)).catch(() => {});
    }
    for (const l of [...this.listeners]) l();
  }
}

/**
 * Whether an entry can still be shown on home, judged against a roster read
 * that started at `readAt`: its bot is listed — or nothing proves it gone (the
 * instance was not read, which is also what an unlistened one is; its box did
 * not answer; or the entry is newer than the read and may name a bot created
 * since). Listening is not judged here: an unlistened instance's entries stay
 * unread for when it is listened again, and the badge leaves them out
 * (`badgeCount`).
 */
export function entryLive(
  roster: { swarms: readonly Pick<Swarm, "instance" | "reachable" | "bots">[] },
  readAt: number,
): (entry: Pick<InboxEntry, "instance" | "bot" | "at">) => boolean {
  const swarms = new Map(roster.swarms.map((s) => [s.instance, s]));
  return (entry) => {
    const swarm = swarms.get(entry.instance);
    if (!swarm?.reachable || time(entry.at) >= readAt) return true;
    return swarm.bots.some((b) => b.name === entry.bot);
  };
}

function sortEntries(entries: readonly InboxEntry[]): InboxEntry[] {
  return [...entries].sort((a, b) => time(b.at) - time(a.at));
}

/* ── the alert decision ─────────────────────────────────────────────────── */

export interface WatchedThread {
  instance: string;
  bot: string;
  /**
   * The separate session on screen, by id; `null` for the Bot Chat (a
   * `?session=` that turns out to be the canonical one counts as the Bot Chat).
   */
  session: string | null;
  /**
   * The session id the screen shows, once known: the Bot Chat's resolved id,
   * or the separate session's own. What an event's `session` is matched on.
   */
  resolved?: string | null;
  /**
   * Bot Chat only: the ids of the bot's separate sessions, once its session
   * list is known. What reading the Bot Chat leaves unread (`read.ts`); the
   * alert decision does not use it.
   */
  separate?: readonly string[];
  /**
   * Bot Chat only: when that list was asked for (ISO-8601). An entry naming a
   * session the list does not, filed after it, may be a session made since,
   * and reading the Bot Chat leaves it (`read.ts`).
   */
  listedAt?: string | null;
  /** The app is in the foreground and this conversation is the visible screen. */
  focused: boolean;
}

export type AppPhase = "active" | "inactive" | "background";

export type AlertDecision =
  /** Draw an in-app banner (foreground). */
  | "banner"
  /** Schedule a local notification (backgrounded, a socket still live). */
  | "local"
  /** Nothing: already alerted, or the operator is looking at it. */
  | "none";

/**
 * Whether an event is about the conversation the operator is looking at: the
 * app in the foreground, that conversation focused, the same bot, and the same
 * session. The Bot Chat and a separate session of one bot are two
 * conversations: an event in one is not on screen while the other is. An
 * event matching the resolved id is on screen; failing that, a separate
 * session matches only its own id, and the Bot Chat takes an event with no
 * session, or any event while its own id is not known yet.
 */
export function onScreen(
  arrival: Pick<InboxEntry, "instance" | "bot" | "session">,
  phase: AppPhase,
  watched: WatchedThread | null,
): boolean {
  if (phase !== "active" || !watched?.focused) return false;
  if (watched.instance !== arrival.instance || watched.bot !== arrival.bot) return false;
  if (watched.resolved && arrival.session === watched.resolved) return true;
  if (watched.session !== null) return arrival.session === watched.session;
  return !watched.resolved || !arrival.session;
}

/**
 * Whether an event interrupts. An event about the conversation on screen
 * (`onScreen`) does not (and is recorded, so a later push for it stays
 * silent); an event the inbox already holds does not; anything else is a
 * banner in the foreground and a local notification otherwise.
 */
export function alertFor(
  arrival: Pick<InboxEntry, "dedupe" | "kind" | "instance" | "bot" | "session" | "at">,
  inbox: Pick<InboxStore, "has">,
  phase: AppPhase,
  watched: WatchedThread | null,
): AlertDecision {
  if (onScreen(arrival, phase, watched)) return "none";
  if (inbox.has(arrival)) return "none";
  return phase === "active" ? "banner" : "local";
}
