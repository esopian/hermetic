/**
 * One conversation's record, and the pure reconciliation of what this browser
 * has drawn against what the box has recorded: optimistic placeholders, rows
 * observed before the transcript was read, and rows held while a turn streams.
 * The store that owns the records is `chat-conversations.ts`.
 */
import type { ChatSelection } from "./chat-state.tsx";
import type { ChatFrameView, ChatMessageView, SessionView } from "../api/index.ts";
import type { TurnActivity } from "./chat-activity.ts";

export type Failure = { code: string; message: string };

/**
 * What the portal's observation of one conversation is doing (§9.2).
 *
 * `live` is the ordinary state and says nothing on screen. `reconnecting` is
 * the server's own advisory that its upstream stream dropped and is being
 * retried — a note, not a failure. `failed` is terminal: the server has dropped
 * the subscription and will not re-create it until something asks, so it is
 * surfaced with a way to ask rather than retried in a loop behind the operator.
 */
export type ObserveState = "live" | "reconnecting" | "failed";

/** The id an optimistic local message carries until the box gives it a real one. */
const LOCAL_PREFIX = "local:";

export const isLocal = (message: ChatMessageView): boolean => message.id.startsWith(LOCAL_PREFIX);

/** The prose of a message, for comparing a placeholder with the box's copy of it. */
function bodyOf(message: ChatMessageView): string {
  return message.blocks
    .map((block) => (block.kind === "text" ? block.markdown : ""))
    .join("")
    .trim();
}

/**
 * How far behind this browser's clock the box's may sit and a recorded message
 * still be the one a placeholder stands for.
 *
 * The box timestamps a prompt when it receives it, so the honest reading of
 * `recorded.at - placeholder.at` is "a round trip, plus however much the two
 * clocks disagree by". Both directions need a bound. Without the lower one a
 * message the box recorded before this send was typed would match it; without
 * the upper one a box whose clock runs fast makes *every* future message a
 * candidate for *every* placeholder, and two distinct sends of the same text
 * collapse into one.
 */
const MATCH_BEHIND_MS = 1_000;

/**
 * And how far ahead. Minutes rather than seconds because the cost of refusing a
 * true match is the operator's own prompt drawn twice, which is worse than the
 * cost of a window wider than any real round trip; minutes rather than hours
 * because past that the timestamps are evidence of nothing.
 */
const MATCH_AHEAD_MS = 5 * 60_000;

/**
 * Whether the box's message is the one this optimistic placeholder stands for.
 *
 * Ids cannot answer it: the placeholder is written before the send returns and
 * the box names the message itself, so the two are the same message under two
 * names. The observation of a conversation this portal is sending into
 * therefore arrives carrying the operator's own prompt, and rendering both
 * copies would repeat it — which is the one thing a chat surface must never do.
 * Same role, same prose, and inside the window above: the same test
 * `readHistory` already applies to the half-built reply it keeps.
 *
 * An unparseable timestamp on either side leaves both comparisons false, which
 * is deliberate — the role and the prose still have to agree, and a transcript
 * whose clock is unreadable is not a reason to draw a prompt twice.
 */
export function accountsFor(recorded: ChatMessageView, placeholder: ChatMessageView): boolean {
  if (recorded.role !== placeholder.role) return false;
  const gap = Date.parse(recorded.at) - Date.parse(placeholder.at);
  if (gap < -MATCH_BEHIND_MS || gap > MATCH_AHEAD_MS) return false;
  return bodyOf(recorded) === bodyOf(placeholder);
}

/**
 * Placeholders the box's transcript does not account for, kept so a send is
 * never lost.
 *
 * The match is an *assignment*, not a predicate applied row by row: a recorded
 * message accounts for at most one placeholder. Two sends of the same text a
 * few seconds apart are two messages with identical role, identical prose and
 * overlapping windows, so a plain `some()` let one recorded copy answer for
 * both and the second send vanished off the screen it had been typed into.
 * Placeholders are walked in send order against the transcript in its own
 * order, so the earliest send claims the earliest recorded copy.
 */
export function stillPending(
  local: readonly ChatMessageView[],
  recorded: readonly ChatMessageView[],
): ChatMessageView[] {
  const ids = new Set(recorded.map((row) => row.id));
  const claimed = new Set<number>();
  const pending: ChatMessageView[] = [];
  for (const message of local) {
    if (!isLocal(message)) continue;
    if (ids.has(message.id)) continue;
    const at = recorded.findIndex((row, i) => !claimed.has(i) && accountsFor(row, message));
    if (at === -1) pending.push(message);
    else claimed.add(at);
  }
  return pending;
}

/**
 * How many observed messages are held for a transcript this browser has not
 * read yet. Bounded for the reason every queue in this codebase is: a
 * conversation whose history read never succeeds must not grow without limit.
 * The oldest go, and the snapshot that eventually lands carries them anyway.
 */
export const EARLY_OBSERVE_LIMIT = 200;

/**
 * Fold anything observed before the transcript into that transcript.
 *
 * The box is authoritative about what it holds, but the read that produced this
 * transcript was made before the frames that arrived while this browser had
 * nothing to append them to. One the read already carries is dropped — the
 * snapshot covered it — and one it does not is re-delivered, because the
 * alternative is a message lost until a later snapshot that may never come.
 */
export function absorbEarly(
  record: Conversation,
  recorded: readonly ChatMessageView[],
): ChatMessageView[] {
  if (record.observedEarly.length === 0) return [...recorded];
  const known = new Set(recorded.map((row) => row.id));
  const extra = record.observedEarly.filter((row) => !known.has(row.id));
  record.observedEarly = [];
  return [...recorded, ...extra];
}
/**
 * How far behind the turn's own start a row the box recorded may be stamped and
 * still belong to that turn.
 *
 * Deliberately not `MATCH_BEHIND_MS`, although both bound the same skew between
 * this laptop's clock and the box's. The two comparisons fail in opposite
 * directions: a placeholder that misses its match draws the operator's prompt
 * twice and nothing else, while a row that misses this one un-holds and the
 * whole turn is drawn twice, tool call by tool call. So this one is wide enough
 * that no plausible clock disagreement can close it, and the cost of being too
 * wide is bounded anyway — everything held is handed back when the turn ends, a
 * minute or two later at the outside.
 */
const HOLD_BEHIND_MS = 60_000;

/**
 * How many rows one turn may hold. Unlike `EARLY_OBSERVE_LIMIT`, going over it
 * does not *drop* anything: the oldest held rows are given to the transcript
 * instead. `observedEarly` can discard because the snapshot it is waiting for
 * carries the rows anyway; a held row has no such backstop, since the path this
 * hold exists to protect — this browser's own stream dropping — never re-reads
 * the transcript successfully. A
 * turn past this many rows therefore draws its opening steps twice rather than
 * losing them.
 */
export const TURN_HOLD_LIMIT = 200;

/** A row held for the streaming turn, stamped with the session it was held under. */
interface HeldRow {
  session: string | null;
  message: ChatMessageView;
}

/** The conversation a record addresses right now. */
export function sessionOf(record: Conversation): string | null {
  return record.resolvedSession ?? record.target.session ?? null;
}

/**
 * Whether the turn being streamed right now already speaks for a row the
 * observation just delivered.
 *
 * The box writes a turn down as it goes, and the portal is watching the same
 * conversation it is sending into — so while the reply streams, the durable
 * rows for *that same reply* arrive on the observation: a `bot` row when the
 * model opened a tool call, a `system` row when the call closed, prose at the
 * end. Appending them draws the answer twice, once as the assembled live
 * message and once as the rows behind it, with each tool call repeated. They
 * share no id with the live message — the box names its rows and this browser
 * names the live one — so the dedupe on `id` cannot see it, exactly as
 * `accountsFor` cannot see the operator's own prompt coming back.
 *
 * The test is the one `readHistory` already applies when it decides a transcript
 * has caught up with the live message: not a user row (the prompt has its own
 * dedupe), on the session this record addresses, and stamped no earlier than the
 * turn began.
 *
 * The session compared is the record's *current* one and not the turn's seed.
 * A rollover mid-turn repoints the record at a new conversation, and holding
 * the new session's rows against the archived session's name would un-hold
 * every one of them for the rest of the turn.
 *
 * A message somebody else sent — a human typing into Hermes Desktop while this
 * turn runs — is held by this too, since it is a `bot` or `system` row like any
 * other. It is not lost: every path that stops a turn hands the held rows back.
 * It surfaces late, and until the next transcript read sorts the conversation
 * it sits at the tail rather than at its own stamp. Late and out of order is
 * the accepted cost of never drawing a turn twice.
 *
 * Unreadable stamps answer false, which is the safe direction here: the row is
 * drawn, possibly beside a live message saying the same thing, rather than held
 * against a condition that cannot be evaluated.
 */
export function coveredByTurn(record: Conversation, message: ChatMessageView): boolean {
  if (!record.sending || !record.turnSeed) return false;
  if (message.role === "user") return false;
  const session = sessionOf(record) ?? (record.turnSeed.session || null);
  if (session && message.session && message.session !== session) return false;
  const at = Date.parse(message.at);
  const since = Date.parse(record.turnSeed.at);
  if (Number.isNaN(at) || Number.isNaN(since)) return false;
  return at >= since - HOLD_BEHIND_MS;
}

/**
 * Empty the hold, and say what was in it.
 *
 * Rows stamped with a session this record no longer addresses are left out:
 * they were recorded in a conversation that has since been archived, and
 * appending them to the transcript that replaced it would show one
 * conversation's work under another's name. They are not lost — the rollover
 * that retires a session flushes the hold into the copy it archives first,
 * which is why `all` exists.
 */
export function takeHeld(record: Conversation, all = false): ChatMessageView[] {
  const now = sessionOf(record);
  const rows = record.observedDuringTurn.filter(
    (held) => all || !held.session || !now || held.session === now,
  );
  record.observedDuringTurn = [];
  return rows.map((held) => held.message);
}

/** Append rows the transcript does not already carry, in arrival order. */
export function appendMissing(record: Conversation, rows: readonly ChatMessageView[]): void {
  if (rows.length === 0) return;
  const known = new Set(record.messages.map((row) => row.id));
  const extra = rows.filter((row) => !known.has(row.id));
  if (extra.length > 0) record.messages = [...record.messages, ...extra];
}

/**
 * Give the turn's held rows back to the transcript.
 *
 * Called wherever a turn stops streaming — cleanly, aborted, dropped or errored
 * — because the live message stops speaking for them at that moment and the
 * rows are the only copy this browser holds. A turn core reconnected on the box
 * socket (design.md §9.2) has not stopped streaming and does not come here. The ordinary path re-reads the
 * transcript straight after and replaces them with the box's own answer; the
 * paths that do not (a drop that goes to `reconnect`, a read that never
 * succeeds) leave the rows on screen rather than losing what the box recorded.
 * Ids the transcript already carries are dropped, so a snapshot that landed
 * mid-turn — which replaces the transcript wholesale and carries these rows
 * with it — does not have them appended a second time.
 */
export function releaseHeld(record: Conversation): void {
  record.turnSeed = null;
  appendMissing(record, takeHeld(record));
}

export type Assemble = (
  live: ChatMessageView | null,
  frame: ChatFrameView,
  seed: { session: string; at: string },
) => ChatMessageView | null;
export interface Conversation {
  target: ChatSelection;
  draft: string;
  sessions: SessionView[];
  sessionsState: "pending" | "ready" | "failed";
  sessionsError: string | null;
  sessionsGen: number;
  sessionsController: AbortController | null;
  historyController: AbortController | null;
  resolvedSession: string | null;
  messages: ChatMessageView[];
  historyLoading: boolean;
  historyError: string | null;
  historyRead: boolean;
  historyGen: number;
  live: ChatMessageView | null;
  sending: boolean;
  activity: TurnActivity;
  aborting: boolean;
  turnError: Failure | null;
  /**
   * The turn's SSE response from the portal ended without a `done`, and this
   * browser is re-reading the transcript to find out what the box recorded.
   *
   * This is the browser↔portal drop, the only one the portal cannot resume:
   * core continues a dropped *box* socket from its cursor (design.md §9.2) and
   * that never surfaces here as an ending — it arrives as a replaceable
   * `connection:reconnect` status block on a turn that is still streaming.
   */
  reconnecting: boolean;
  reconnectAttempt: number;
  reconnectTimer: ReturnType<typeof setTimeout> | null;
  /**
   * The last turn ended without a `done`. Either the response to this browser
   * died, or core ran out of ways to continue from its cursor and said so with
   * `done incomplete` — from here the two look alike on purpose, because the
   * answer to both is the box's own copy.
   */
  dropped: boolean;
  turn: number;
  cancel: (() => void) | null;
  /** The portal's continuous watch on this conversation (§9.2). */
  observe: ObserveState;
  observeAttempt: number;
  observeError: Failure | null;
  /** Pending decay of a `reconnecting` advisory back to `live`; see `OBSERVE_QUIET_MS`. */
  observeQuietTimer: ReturnType<typeof setTimeout> | null;
  /**
   * Observed messages that arrived before this browser had a transcript to
   * append them to. Emptied by `absorbEarly` the moment one exists.
   */
  observedEarly: ChatMessageView[];
  /**
   * Durable rows the box wrote down for the turn that is streaming now, kept
   * off the transcript while the live message speaks for them and handed back
   * by `releaseHeld` the moment it stops. See `coveredByTurn`.
   */
  observedDuringTurn: HeldRow[];
  /** Session and start stamp of the streaming turn, for that same test. */
  turnSeed: { session: string; at: string } | null;
}
export const key = (target: ChatSelection) =>
  JSON.stringify([target.instance, target.bot, target.session]);
export function fresh(target: ChatSelection): Conversation {
  return {
    target,
    draft: "",
    sessions: [],
    sessionsState: "pending",
    sessionsError: null,
    sessionsGen: 0,
    sessionsController: null,
    historyController: null,
    resolvedSession: target.session,
    messages: [],
    historyLoading: false,
    historyError: null,
    historyRead: false,
    historyGen: 0,
    live: null,
    sending: false,
    activity: "idle",
    aborting: false,
    turnError: null,
    reconnecting: false,
    reconnectAttempt: 0,
    reconnectTimer: null,
    dropped: false,
    turn: 0,
    cancel: null,
    observe: "live",
    observeAttempt: 0,
    observeError: null,
    observeQuietTimer: null,
    observedEarly: [],
    observedDuringTurn: [],
    turnSeed: null,
  };
}
