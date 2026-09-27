/**
 * Scripted external activity for the fixture chat client (§9.2):
 * the staging store `hermetic.fixture.chat.inject` / `.hint` write to and
 * `fixtureChatClient` reads from. Split out of `fixture-chat.ts` (AGENTS.md
 * rule 5).
 */
import type { ChatMessage } from "../../schema/index.ts";
import { at } from "./fixture-chat-roster.ts";

/* ── scripted activity, for observation ───────────────────────────────────── */

/** Where an arrival goes. A `session` of `undefined` means the canonical one. */
export interface FixtureChatWhere {
  instance: string;
  bot: string;
  session?: string | undefined;
}

/**
 * The four things a fixture has to be able to stage for continuous observation:
 * a message that arrived with no local send, a stream that dropped, an event
 * replayed after the reconnect, and two observers of one conversation.
 *
 * It is a store handed to `fixtureChatClient` rather than module-level state
 * because a fixture table is shared by every test in the process and this one
 * is written to. Each test makes its own and gets a conversation nobody else
 * has touched.
 *
 * Nothing here opens anything. An "arrival" is an append to a table and a hint
 * is a callback, which is the whole of what an observation needs to be driven:
 * the transcript is what `history` answers with, and the hint only decides
 * *when* the service goes and asks.
 */
export interface FixtureChatActivity {
  /**
   * A message that nothing on this laptop sent — Hermes Desktop, another
   * operator's CLI, a cron routine. Appended to the transcript and announced on
   * every open hint stream for that bot.
   *
   * `id` is settable so a test can make the *same durable row* arrive twice,
   * which is what an upstream replay after a reconnect looks like from here.
   *
   * `at` is settable for the inbox rather than for the transcript.
   * `observeChatActivity`'s watermark only ever advances, so two arrivals
   * sharing one timestamp raise one row; a caller staging several arrivals in a
   * running portal passes an increasing stamp so each one is news. The default
   * stays `12:00:00`, which is after every canned message (the newest is
   * `09:32:02`) and therefore already advances the watermark once.
   */
  arrive(where: FixtureChatWhere, markdown: string, id?: string, at?: string): ChatMessage;
  /** Announce without appending: a hint for something already in the transcript. */
  hint(where: FixtureChatWhere): void;
  /** End every open hint stream for this bot, as a dashboard restart does. */
  drop(where: FixtureChatWhere): void;
  /** How many hint streams have been opened for this bot since the store was made. */
  streams(where: FixtureChatWhere): number;
  /**
   * How many hint streams are open for this bot *now*.
   *
   * `streams` counts every stream ever opened, which is the right number for
   * "did the reconnect build a second one". This is the right number for "was
   * anything listening when that arrived", which is what an injection reports
   * back to whoever staged it.
   */
  watchers(where: FixtureChatWhere): number;
  /**
   * The next timestamp on the fixture's one moving clock.
   *
   * Rows that are *made* — a turn this client was sent, a message staged as
   * having arrived from elsewhere — need a stamp, and they need it from the
   * same counter or the transcript cannot be sorted back into the order things
   * happened. Still not `Date.now()`: it counts seconds from `12:00:00` on the
   * fixture's fixed day, so the same sequence of calls produces the same
   * transcript on any machine, and every value is after the newest canned
   * message (`09:32:02`) so an advance-only inbox watermark moves for each.
   */
  stamp(): string;
  /** The arrivals for one resolved session, in arrival order. Used by `history`. */
  extras(where: FixtureChatWhere, session: string): ChatMessage[];
  /**
   * Register a hint stream. Called by `fixtureChatClient.observe` and by
   * nothing else; it is on the interface because the client holds the store
   * through this type, not because a test has any use for it.
   */
  open(where: FixtureChatWhere, listener: { push(): void; close(): void }): () => void;
}

export function createFixtureChatActivity(): FixtureChatActivity {
  interface Arrival {
    instance: string;
    bot: string;
    /** Null means "whichever session the read resolved to". */
    session: string | null;
    message: ChatMessage;
  }
  const arrivals: Arrival[] = [];
  const listeners = new Map<string, Set<{ push(): void; close(): void }>>();
  const opened = new Map<string, number>();
  let serial = 0;
  const key = (where: FixtureChatWhere): string => `${where.instance}\0${where.bot}`;
  const audience = (where: FixtureChatWhere) => listeners.get(key(where)) ?? new Set();
  let clock = 0;
  return {
    stamp() {
      const n = clock++;
      const mm = String(Math.floor(n / 60) % 60).padStart(2, "0");
      const ss = String(n % 60).padStart(2, "0");
      return at(`12:${mm}:${ss}`);
    },
    arrive(where, markdown, id, when) {
      const message: ChatMessage = {
        id: id ?? `fixture-external-${++serial}`,
        session: where.session ?? "",
        role: "user",
        at: when ?? at("12:00:00"),
        blocks: [{ kind: "text", markdown }],
      };
      arrivals.push({
        instance: where.instance,
        bot: where.bot,
        session: where.session ?? null,
        message,
      });
      for (const listener of audience(where)) listener.push();
      return message;
    },
    hint(where) {
      for (const listener of audience(where)) listener.push();
    },
    drop(where) {
      for (const listener of [...audience(where)]) listener.close();
    },
    streams(where) {
      return opened.get(key(where)) ?? 0;
    },
    watchers(where) {
      return audience(where).size;
    },
    extras(where, session) {
      return arrivals
        .filter(
          (a) =>
            a.instance === where.instance &&
            a.bot === where.bot &&
            (a.session === null || a.session === session),
        )
        .map((a) => ({ ...a.message, session }));
    },
    open(where, listener) {
      const k = key(where);
      opened.set(k, (opened.get(k) ?? 0) + 1);
      const set = listeners.get(k) ?? new Set<{ push(): void; close(): void }>();
      set.add(listener);
      listeners.set(k, set);
      return () => {
        set.delete(listener);
      };
    },
  };
}
