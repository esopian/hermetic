/**
 * The chat rules, pure and DOM-free (§9.2).
 *
 * Everything the chat view *decides* lives here rather than in the components
 * that draw it: how the rail groups and orders a fleet's worth of bots, which
 * session origins oblige the composer to say what sending will do,
 * whether a card opens closed, which renderer a block reaches, and what a
 * failed turn is called in English. Those are the rules the chat design
 * states in prose — "a green exit code was never news", "gold outranks
 * orange", "a reply into a `channel` session lands in somebody's Slack" —
 * and prose is not testable. This is.
 *
 * Nothing here imports `api.ts`, and nothing here is a React module. The
 * records are described *structurally*, by the fields a rule reads, exactly the
 * way `notification-logic.ts` describes a notification: that keeps the rules
 * testable without a transport, and keeps them compiling against shapes —
 * rooms, broadcast — that core will only fill in at a later phase.
 *
 * The one thing this file will not do is decide anything from a `hermetic`
 * block's payload. Such a block carries a ref and never data (schema/chat.ts),
 * so the rules that concern it are about *which* live surface to read, never
 * about what it says.
 */

import { SESSION_ORIGIN_NAMES } from "@hermetic/core/shared";
import type { SessionOriginName } from "@hermetic/core/shared";

/* ── the records, as the rules see them ──────────────────────────────────── */

/**
 * `SessionOrigin` in `core/src/schema/chat.ts`, by name — the same array, from
 * `@hermetic/core/shared` (the UI may not import the schema door), so the two
 * cannot drift. Widened to `string` at every call site that takes one.
 *
 * Widened on purpose: the origin travels from a box, through an adapter that
 * explicitly tolerates shapes it has never seen, to here. A build of the portal
 * that is one `hermes_ref` behind the fleet must render an origin it cannot
 * name — and must treat it as foreign, because the one thing worse than an
 * unlabelled destination is a wrong label saying "portal".
 */
export type OriginName = SessionOriginName;

export const ORIGIN_NAMES: readonly OriginName[] = SESSION_ORIGIN_NAMES;

export interface BotLike {
  instance: string;
  name: string;
  /** The display name. Not the seed — renaming a bot must not change its face. */
  title?: string | null;
  description?: string | null;
  is_default: boolean;
  section?: string | null;
  model?: string | null;
  avatar_seed?: string | null;
  last_message_at?: string | null;
  unread: number;
  needs_action: boolean;
  muted: boolean;
  warm: boolean;
}

export interface RoomLike {
  id: string;
  name: string;
  instance: string;
  members: { instance: string; bot: string }[];
  round?: { n: number; of: number } | null;
  needs_action: boolean;
}

export interface SwarmLike<B extends BotLike = BotLike> {
  instance: string;
  reachable: boolean;
  unreachable_reason?: string | null;
  bots: B[];
  rooms: RoomLike[];
  warm_slots: { used: number; total: number | null };
  sections: string[];
}

/** `ChatBlock`, structurally: the discriminant, and nothing a rule does not read. */
export interface BlockLike {
  kind: string;
  [field: string]: unknown;
}

export interface MessageLike {
  id: string;
  session: string;
  role: string;
  author?: { instance: string; bot: string } | null;
  at: string;
  blocks: BlockLike[];
  usage?: {
    input_tokens?: number | null;
    output_tokens?: number | null;
    cost_usd?: number | null;
    model?: string | null;
  } | null;
  error?: string | null;
  incomplete?: boolean | null;
}

/* ── time ────────────────────────────────────────────────────────────────── */

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;
const MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
] as const;

const pad2 = (n: number) => String(n).padStart(2, "0");

/**
 * The rail's timestamp: `now` · `9m` · `03:00` · `Fri` · `Sep 2` — a ladder
 * chosen to keep a 44-pixel column readable.
 *
 * `now` is taken as an argument rather than read from the clock so the rule can
 * be tested, and because a transcript rendered twice in one paint must not
 * disagree with itself about what "2m" means.
 *
 * A time in the future reads as `now` rather than as a negative age: the box's
 * clock and the laptop's are two clocks, and a few seconds of skew is not
 * something to put on screen.
 */
export function railTime(iso: string | null | undefined, now: number): string {
  if (!iso) return "—";
  const then = new Date(iso);
  const at = then.getTime();
  if (Number.isNaN(at)) return "—";
  const age = now - at;
  if (age < 45_000) return "now";
  if (age < HOUR) return `${Math.max(1, Math.round(age / MINUTE))}m`;
  const today = new Date(now);
  const sameDay =
    then.getFullYear() === today.getFullYear() &&
    then.getMonth() === today.getMonth() &&
    then.getDate() === today.getDate();
  if (sameDay) return `${pad2(then.getHours())}:${pad2(then.getMinutes())}`;
  if (age < 6 * DAY) return WEEKDAYS[then.getDay()] ?? "—";
  return `${MONTHS[then.getMonth()]} ${then.getDate()}`;
}

/**
 * The stamp beside one message in a transcript: `14:03` today, and `railTime`'s
 * own older forms (`Fri`, `Sep 2`) before that.
 *
 * One formatter rather than three. The rail already owns the ladder, and a
 * second spelling of the same instant — `toLocaleTimeString`'s `10:13 PM`, in a
 * pane whose rail says `22:13` — is the sort of disagreement an operator reads
 * as two different times. The difference from `railTime` is deliberate and is
 * the only one: a message sent seconds ago reads as the clock time it was sent
 * at rather than as `now`/`9m`, because a transcript is a record and a relative
 * age drifts under a reader who is scrolled into it.
 */
export function threadTime(iso: string | null | undefined, now: number): string {
  if (!iso) return "—";
  const then = new Date(iso);
  if (Number.isNaN(then.getTime())) return "—";
  const today = new Date(now);
  const sameDay =
    then.getFullYear() === today.getFullYear() &&
    then.getMonth() === today.getMonth() &&
    then.getDate() === today.getDate();
  return sameDay ? `${pad2(then.getHours())}:${pad2(then.getMinutes())}` : railTime(iso, now);
}

/** `Today · Sep 16`, the divider between two calendar days in the transcript. */
export function dayDivider(iso: string, now: number): string {
  const then = new Date(iso);
  if (Number.isNaN(then.getTime())) return "—";
  const today = new Date(now);
  const stamp = `${MONTHS[then.getMonth()]} ${then.getDate()}`;
  const sameDay =
    then.getFullYear() === today.getFullYear() &&
    then.getMonth() === today.getMonth() &&
    then.getDate() === today.getDate();
  return sameDay ? `Today · ${stamp}` : stamp;
}

/** `6.2s`, `1.4m` — the duration on the right of a tool head. */
export function fmtMs(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return "";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${(ms / 60_000).toFixed(1)}m`;
}

/** `214 KB`, `1.9 MB` — an attachment's size, in the units the design prints. */
export function fmtBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "—";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/* ── origins, and where a reply goes ─────────────────────────────────────── */

/**
 * What the thread knows about where a reply goes — and the reason the composer
 * takes this rather than a bare origin string.
 *
 * `portal` has to be something positively *read* off a session, never something
 * a caller fell back to. The window this closes is real and was a live defect:
 * a bot is selected, the session list is still in flight, `session` is null,
 * and a bare `origin ?? "portal"` renders a plain composer, enabled. Press
 * Enter in that window on a `channel` session and the reply leaves the tailnet
 * and lands in somebody's Slack with nothing having said so.
 *
 * So the three not-yet-known states are separate values, and each of them
 * *disables* the composer. Waiting a beat is a cost; sending a message to a
 * destination nobody named is not a cost, it is the failure.
 */
export type Destination =
  | { state: "known"; origin: string; detail: string | null }
  /** The session read has not come back yet. */
  | { state: "pending" }
  /**
   * The bot has conversations and the box did not say which one a reply would
   * continue. Real, and the fixture has one: a bot whose only sessions are a
   * room and a Slack channel has no canonical session for the portal to fall
   * into, and the two it does have go to different places.
   */
  | { state: "unchosen"; count: number }
  /** The session read failed, or the box named a session it then did not list. */
  | { state: "unknown"; reason: string };

/** The slim band above a composer that cannot send yet. */
export interface DestinationNotice {
  /** The `.ch-band` tone class. */
  tone: "acc" | "warn" | "bad";
  /** The one line the band says. */
  headline: string;
  /** The short label on the `.ch-origin` badge; the badge's class is `originClass`. */
  badge: string;
  /** Hover text, for what does not fit on one line — the read's failure reason. */
  title?: string;
}

const detailOf = (dest: Destination): string | null =>
  dest.state === "known" && dest.detail?.trim() ? dest.detail.trim() : null;

/**
 * The band above the composer, or `null` when there is none — which is every
 * known destination.
 *
 * A band is now only for a composer that is **blocked**: the session read is
 * in flight (`pending`), the bot has conversations and none is this portal's
 * (`unchosen`, which the composer follows with one chip per session), or the
 * read failed (`unknown`). Each of those disables sending, so the band is the
 * explanation for a dead button rather than a warning beside a live one. Where
 * sending *works* but has a consequence, the consequence is on the send button
 * and the footer (`sendLabel`, `composerHint`), which is where the eye is at
 * the moment of sending.
 *
 * A destination that is not known gets a band and not silence, because silence
 * is what `portal` looks like — and `portal` is the answer this whole mechanism
 * exists to stop the UI from assuming.
 */
export function destinationNotice(dest: Destination): DestinationNotice | null {
  switch (dest.state) {
    case "known":
      return null;
    case "pending":
      return { tone: "acc", badge: "reading", headline: "Reading which conversation this is." };
    case "unchosen":
      return { tone: "warn", badge: "choose", headline: "Reply into" };
    case "unknown":
      return {
        tone: "bad",
        badge: "unknown",
        headline: "hermetic could not read where a reply would go.",
        title: `${dest.reason} Sending is held until it can — a session can be a Slack channel or another bot.`,
      };
  }
}

/**
 * The send button's text, or `null` for the plain `↵`.
 *
 * Set for the three destinations where pressing Enter does something the
 * operator might not have meant, and always `warn`: a `routine` reply starts a
 * new session the routine never reads, a `peer` reply answers another bot
 * rather than a person, and a `channel` reply leaves the tailnet for somebody's
 * Slack. Those moved off a band and onto the button because the button is the
 * one thing certainly on screen, and in focus, at the moment of sending — a
 * band above the input was read once and then scrolled past by habit. An
 * origin this build does not recognise is treated as consequential too, since
 * the alternative is labelling it `portal` by omission.
 *
 * `portal`, `hermetic`, `cli`, `desktop` and `room` are `null`: a reply there
 * continues a conversation on this fleet's own boxes, and the header's badge
 * already says whose. Not-yet-known destinations are `null` as well, because
 * their composer is disabled and the band says why.
 */
export function sendLabel(dest: Destination): { label: string; tone: "warn" } | null {
  if (dest.state !== "known") return null;
  const where = detailOf(dest);
  switch (dest.origin) {
    case "portal":
    case "hermetic":
    case "cli":
    case "desktop":
    case "room":
      return null;
    case "routine":
      return { label: "Send · new session", tone: "warn" };
    case "peer":
      return { label: `Reply to ${where ?? "another bot"}`, tone: "warn" };
    case "channel":
      return { label: `Send to ${where ?? "the channel"}`, tone: "warn" };
    default:
      return { label: `Send to ${where ?? dest.origin}`, tone: "warn" };
  }
}

/**
 * A fragment for the composer's footer, after "over the tailnet · <name>", or
 * `null`. The text carries no leading separator; the composer joins it.
 *
 * `muted` where a reply lands somewhere else as well and nothing is lost by it:
 * a `desktop` session is also open in Hermes Desktop, and a `room` reply is
 * read by the room's other members. `warn` beside a send button that already
 * says what the reply does, for the half the button has no room for: the
 * `routine` will not see it, and a `channel` reply leaves the tailnet.
 *
 * `portal`, `hermetic` and `cli` say nothing. `portal` needs no restating; the
 * other two mean only "this laptop holds no record of sending into it" — true
 * of this operator's own session from another Mac, after a wiped database or
 * after the 30-day prune — so restating them is wrong too often to be worth
 * the pixels. The header badge still names them.
 */
export function composerHint(dest: Destination): { text: string; tone: "muted" | "warn" } | null {
  if (dest.state !== "known") return null;
  const where = detailOf(dest);
  switch (dest.origin) {
    case "desktop":
      return { text: "also open in Hermes Desktop", tone: "muted" };
    case "room":
      return { text: `posts to ${where ?? "the room"}`, tone: "muted" };
    case "routine":
      // No detail here on purpose: a real box names no job, and a fixture
      // detail like "cron: 06:00 daily digest" does not read as a name.
      return { text: "the routine will not see this", tone: "warn" };
    case "channel":
      return { text: "leaves the tailnet", tone: "warn" };
    default:
      return null;
  }
}

/** The `.ch-origin` badge class: the origin when it is known, and never `portal` otherwise. */
export function originClass(dest: Destination): string {
  return dest.state === "known" ? dest.origin : "unknown";
}

/**
 * Whether this thread may name an origin at all — the predicate behind the
 * header's `.ch-origin` badge.
 *
 * A canonical Bot Chat with no messages in it has no origin: nothing has been
 * said, so nothing started it. The box still reports the session's `source`
 * (`hermetic` for one this portal created, `tui` from an older build, which
 * reads as `cli`), and drawing a badge over "Nothing said yet" is a claim
 * about a conversation that has not happened.
 */
export function hasKnownOrigin(
  session: { kind?: string | null } | null | undefined,
  messageCount: number,
): boolean {
  return !(session?.kind === "canonical" && messageCount === 0);
}

/* ── URLs a model wrote ──────────────────────────────────────────────────── */

/**
 * A link target, or `null` when the renderer must draw text instead.
 *
 * Everything that reaches a renderer as a URL — a markdown link, a citation, an
 * attachment — was produced or relayed by a language model running on a box.
 * The portal is served from loopback, it talks to `/api/*` with no auth token
 * beyond same-origin, and it has no CSP. `[click](javascript:fetch('/api/…'))`
 * is therefore a script one click away from the operator, in the one origin
 * where a script has the whole fleet surface in reach.
 *
 * Core's redaction (§9.2) does not cover this and could not: it masks secrets
 * *in* a payload, and this is a payload that is dangerous for what it is rather
 * than for what it contains.
 *
 * Allowed: `http`, `https`, `mailto`, a same-origin absolute path, and a
 * fragment. Refused: everything else, `javascript:` and `data:` included, and
 * refused by allow-list rather than by blocking a list of schemes — a blocklist
 * is one obscure scheme away from being wrong, and there is no scheme a
 * transcript needs that is not above.
 */
const LINK_SCHEMES = new Set(["http:", "https:", "mailto:"]);

export function safeHref(href: string | null | undefined): string | null {
  if (typeof href !== "string") return null;
  const raw = href.trim();
  if (raw.length === 0) return null;
  if (raw.startsWith("#")) return raw;
  // A protocol-relative `//evil.example` is absolute, not same-origin.
  if (raw.startsWith("/") && !raw.startsWith("//")) return raw;
  // A scheme is anything before the first colon that precedes any `/?#`.
  const scheme = /^([a-zA-Z][a-zA-Z0-9+.-]*):/.exec(raw);
  if (!scheme) return null;
  return LINK_SCHEMES.has(scheme[1]?.toLowerCase() + ":") ? raw : null;
}

/**
 * An image source, which is strictly narrower than a link, because it is
 * fetched with no click at all.
 *
 * A link the operator never follows costs nothing. An `<img>` is requested the
 * moment it renders, so a box that wants to signal out only has to put the
 * bytes in a query string and let the operator's own machine deliver them off
 * the tailnet — past every control the fleet has, because the request is not
 * the fleet's. Root-relative paths only, which in this app resolve against the
 * page's own bundle and reach no network at all; an image anywhere else is
 * drawn as its filename instead.
 */
export function safeImageSrc(href: string | null | undefined): string | null {
  if (typeof href !== "string") return null;
  const raw = href.trim();
  return raw.startsWith("/") && !raw.startsWith("//") ? raw : null;
}

/* ── cards: the verdict, and the collapse rule ───────────────────────────── */

/**
 * The five card tones the design uses, plus `unknown` for a card whose
 * verdict nothing has established. They are `.ch-card` modifier classes, so
 * the names are the CSS's names and not ours to improve.
 */
export type CardVerdict = "ok" | "warn" | "bad" | "acc" | "muted" | "unknown";

/**
 * The rule every card in the transcript obeys: a settled verdict starts
 * collapsed, an unsettled one and any error starts open.
 *
 * A green exit code was never news. A non-zero one is the whole message, and so
 * is a payload from a tool this build has no renderer for — the operator is the
 * fallback renderer in that case, and a fallback that starts shut is not one.
 */
export function startsCollapsed(verdict: CardVerdict, failed = false): boolean {
  if (failed) return false;
  return verdict !== "unknown";
}

/** A tool's `status` as a card tone. `running` is accent: in flight, not good. */
export function toolVerdict(status: string): CardVerdict {
  switch (status) {
    case "ok":
      return "ok";
    case "warn":
      return "warn";
    case "bad":
      return "bad";
    case "running":
      return "acc";
    default:
      return "unknown";
  }
}

/* ── blocks: the kind switch, and the fallthrough that is the contract ───── */

/**
 * `CHAT_BLOCK_KINDS` in `core/src/schema/chat.ts`, copied rather than imported
 * (the UI may not import core — `tests/boundaries.test.ts`).
 *
 * The copy is safe in the one direction that matters. If core grows a tenth
 * kind and this list does not, `blockKind` answers `unknown` and the block
 * renders as name / payload rather than as nothing — which is exactly what the
 * `unknown` renderer is for.
 */
export const CHAT_BLOCK_KINDS = [
  "text",
  "reasoning",
  "activity",
  "tool",
  "attachment",
  "approval",
  "question",
  "sources",
  "hermetic",
  "process_event",
  "unknown",
] as const;

export type ChatBlockKind = (typeof CHAT_BLOCK_KINDS)[number];

const KNOWN_KINDS = new Set<string>(CHAT_BLOCK_KINDS);

/**
 * Which renderer a block reaches — and the reason this function exists at all.
 *
 * A `hermes_ref` bump can add fifty tools without touching this repo, and the
 * adapter drops everything it does not recognise into an `unknown` block. But
 * the adapter is one version too; a *block kind* this build has never seen can
 * arrive the same way. Both land here and both come out `unknown`, so the
 * renderer has one fallthrough rather than two, and a version bump can never
 * blank a transcript.
 */
export function blockKind(block: { kind?: unknown }): ChatBlockKind {
  const kind = typeof block.kind === "string" ? block.kind : "";
  return KNOWN_KINDS.has(kind) ? (kind as ChatBlockKind) : "unknown";
}

/**
 * The name an `unknown` block is drawn under. A block that *is* `kind:
 * "unknown"` carries the tool's own name; a block of a kind this build cannot
 * name is drawn under that kind, because that is the only true thing there is
 * to say about it.
 */
export function unknownName(block: { kind?: unknown; name?: unknown }): string {
  if (typeof block.name === "string" && block.name.length > 0) return block.name;
  if (typeof block.kind === "string" && block.kind.length > 0) return block.kind;
  return "block";
}

/**
 * The payload an `unknown` block shows.
 *
 * A `kind: "unknown"` block puts it in `payload`; a block of an unrecognised
 * kind has no such field and its whole self is the payload. Returning the block
 * itself in that case is deliberate — everything on it has already been through
 * core's redaction (§9.2), and the operator reading it is the renderer.
 */
export function unknownPayload(block: BlockLike): unknown {
  return "payload" in block ? block["payload"] : block;
}

/** Pretty JSON for the `unknown` renderer, with a cycle-proof fallback. */
export function formatPayload(value: unknown): string {
  if (value === undefined) return "undefined";
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    return String(value);
  }
}

/* ── messages: grouping, and what a failed turn is called ────────────────── */

export interface MessageRow<M extends MessageLike = MessageLike> {
  message: M;
  /**
   * The same author spoke last, so the avatar and the name are drawn once for
   * the run rather than once per message (`.ch-msg.cont`).
   */
  continuation: boolean;
  /** The day divider this message opens, or `null` when it opens none. */
  divider: string | null;
}

/** Who said it, as a grouping key: role for the operator, `bot@instance` otherwise. */
export function authorKey(m: MessageLike): string {
  if (m.role === "user") return "user";
  if (m.author) return `${m.author.bot}@${m.author.instance}`;
  return m.role;
}

/**
 * The transcript as rows: consecutive turns from one author collapse into one
 * visual block, and a day boundary raises a divider.
 *
 * A failed or incomplete message never continues the run above it. It is the
 * thing the operator is looking for, and burying it under a shared name is how
 * a turn that stopped comes to look like one that did not.
 */
export function messageRows<M extends MessageLike>(
  messages: readonly M[],
  now: number,
): MessageRow<M>[] {
  const rows: MessageRow<M>[] = [];
  let lastAuthor: string | null = null;
  let lastDay: string | null = null;
  for (const message of messages) {
    const day = dayDivider(message.at, now);
    const divider = day === lastDay ? null : day;
    const author = authorKey(message);
    const broken = !!message.error || !!message.incomplete;
    rows.push({
      message,
      continuation: divider === null && author === lastAuthor && !broken,
      divider,
    });
    lastAuthor = broken ? null : author;
    lastDay = day;
  }
  return rows;
}

export interface FailureCopy {
  /** The `.ch-card` tone: `warn` when the turn can be resumed, `bad` when not. */
  tone: "warn" | "bad";
  /** The card head's left label — what *kind* of stop this was. */
  head: string;
  /** The card head's right label — the code, verbatim, so it can be searched for. */
  right: string;
  /** One bolded sentence saying what happened. */
  title: string;
  /** One sentence saying what is and is not lost. */
  detail: string;
}

/**
 * The one renderer behind every message-level failure.
 *
 * Six codes, one card: rate limited, credential rejected, turn
 * ceiling, context full, box went away, model missing. They differ in their
 * words and in one tone bit, and building six renderers for that would mean six
 * places for the seventh code to be forgotten. The `default` branch is the
 * point of the shape — a code from a box this build has never heard of still
 * gets a card, with the code on it.
 */
export function failureCopy(code: string | null | undefined, message?: string | null): FailureCopy {
  const said = message?.trim() ? message.trim() : "";
  switch (code) {
    // Three spellings, because three sources produce one: core's own
    // `ErrorCode`, whatever the box passes through from the provider, and the
    // fixture. A code that reaches the `default` branch still renders, but it
    // renders without the one sentence that says the turn can be retried.
    case "PROVIDER_RATE_LIMIT":
    case "PROVIDER_RATE_LIMITED":
    case "RATE_LIMITED":
      return {
        tone: "warn",
        head: "provider error",
        right: code,
        title: "Rate limited.",
        detail: said || "The provider refused this turn for now. Nothing reached the agent.",
      };
    case "PROVIDER_AUTH":
    case "PROVIDER_UNAUTHORIZED":
      return {
        tone: "bad",
        head: "provider error",
        right: code,
        title: "The profile's key was rejected.",
        detail: "Nothing was sent to the agent, and no key is shown here.",
      };
    case "MAX_TURNS":
      return {
        tone: "warn",
        head: "stopped",
        right: code,
        title: "Hit the turn ceiling mid-task.",
        detail: "The work so far is on the box; nothing was rolled back.",
      };
    case "CONTEXT_FULL":
      return {
        tone: "warn",
        head: "context",
        right: code,
        title: "This thread has filled the model's window.",
        detail: "Compacting keeps the summary and drops the raw tool payloads.",
      };
    case "CHAT_UNREACHABLE":
      return {
        tone: "bad",
        head: "disconnected",
        right: code,
        title: "The box stopped answering.",
        detail:
          "The reply that was streaming is kept above, incomplete. Hermes writes its own " +
          "transcript on the box, so nothing is lost there.",
      };
    case "CHAT_NO_SLOT":
      return {
        tone: "warn",
        head: "no warm slot",
        right: code,
        title: "The gateway had no warm backend to give this turn.",
        detail: "About three bots run warm per box. Another one has to go idle first.",
      };
    case "CHAT_NO_TOKEN":
      return {
        tone: "bad",
        head: "disconnected",
        right: code,
        title: "The box answered, but not as Hermes.",
        detail: said || "No session token in the dashboard's page — the gateway may be restarting.",
      };
    case "CHAT_PROTOCOL":
      return {
        tone: "bad",
        head: "protocol",
        right: code,
        title: "The box answered with something this build cannot read.",
        detail: said || "This usually means the fleet's Hermes is a different version from the pin.",
      };
    case "MODEL_NOT_GRANTED":
      return {
        tone: "bad",
        head: "model error",
        right: code,
        title: "The fleet's role may not invoke this model.",
        detail: said || "It is not in the foundation's Bedrock grant.",
      };
    case "INCOMPLETE":
      return {
        tone: "bad",
        head: "cut off",
        right: "incomplete",
        title: "This turn stopped before it finished.",
        detail:
          "What arrived is kept above. Hermes writes its own transcript on the box, so the " +
          "complete turn is there — reconnecting backfills it.",
      };
    case "CHAT_TURN_FAILED":
      return {
        tone: "bad",
        head: "turn failed",
        right: code,
        title: "The turn failed on the box.",
        detail: said || "The model refused, or the agent errored partway through.",
      };
    default:
      return {
        tone: "bad",
        head: "turn failed",
        right: code ?? "UNKNOWN",
        title: "The turn stopped.",
        detail:
          said ||
          "hermetic has no copy for this code, so it is shown verbatim — it is what the box said.",
      };
  }
}

/* ── the rail ────────────────────────────────────────────────────────────── */

/** All instances in collapsible buckets, or one instance with its own sections on top. */
export type RailScope = { kind: "all" } | { kind: "instance"; instance: string };

export type RailFilter = "all" | "unread" | "needs";

/**
 * How many unread messages the rail credits a bot with.
 *
 * Two sources, and the larger of the two wins — never the sum. `bot.unread` is
 * the roster read, a box's count of its own transcripts, and `extra` is this
 * laptop's inbox, the `chat.*` rows it has been sent and nobody here has
 * acknowledged. They are two *counts of the same messages*, taken by two
 * observers that go out of step in both directions, so adding them would say
 * "2" about one message the moment they agreed on it.
 *
 * Taking the maximum keeps the failure that matters fixed — a rail whose Unread
 * filter is empty while the bell is lit about those very bots — without
 * inventing traffic that never happened.
 */
export function railUnread(bot: { unread: number }, extra = 0): number {
  return Math.max(bot.unread, Math.max(0, extra));
}

/** Looks up `extra` for one bot. Absent (the default) means "roster only". */
export type RailUnreadLookup = (instance: string, bot: string) => number;

/** What the `.ch-unread` pill says: `!` when blocked, a count when merely unread. */
export function unreadBadge(bot: { unread: number; needs_action: boolean }, extra = 0): string | null {
  if (bot.needs_action) return "!";
  const unread = railUnread(bot, extra);
  if (unread > 0) return String(unread);
  return null;
}

/**
 * How many characters of a reply the rail shows, and the cut upstream makes.
 *
 * Hermes truncates its own session preview at sixty characters and appends a
 * literal `...` (`packages/core/test/hermes-chat.test.ts`, "truncated by the
 * box"); core passes that string through untouched (`botPreview`,
 * `packages/core/src/hermes-chat-roster.ts`). A preview this browser writes
 * for a turn it just watched land has to read the same, because the next
 * roster read replaces it with the box's own and the row must not visibly
 * change shape when it does.
 */
export const PREVIEW_CHARS = 60;

/** The rail's one-line preview of a reply, cut the way the box cuts its own. */
export function previewOf(text: string | null | undefined): string | null {
  if (!text) return null;
  // The rail is one line. A newline folds to a space rather than being cut at,
  // so a reply whose first line is "Sure —" previews as what it went on to say.
  const flat = text.replace(/\s*\n+\s*/g, " ").trim();
  if (!flat) return null;
  return flat.length > PREVIEW_CHARS ? `${flat.slice(0, PREVIEW_CHARS)}...` : flat;
}

export interface RailSection<B extends BotLike = BotLike> {
  /** The operator's own grouping name, or `null` for the bots in no section. */
  name: string | null;
  bots: B[];
}

export interface RailBucket<B extends BotLike = BotLike> {
  instance: string;
  reachable: boolean;
  /** Why the box did not answer, when it did not. Shown; never hidden. */
  reason: string | null;
  warmUsed: number;
  warmTotal: number | null;
  botCount: number;
  unread: number;
  needsAction: boolean;
  /** The most recent thing said anywhere in this swarm, for sort and for the header. */
  lastAt: string | null;
  sections: RailSection<B>[];
}

const time = (iso: string | null | undefined): number => {
  if (!iso) return 0;
  const at = new Date(iso).getTime();
  return Number.isNaN(at) ? 0 : at;
};

/**
 * Conversation order inside a section: blocked on you, then unread, then most
 * recently spoken, then the default bot, then by name.
 *
 * The default bot's tiebreak is not cosmetic — it is the bot that *is* the box
 * (`$HERMES_HOME`), so on a quiet swarm it is the one an operator means.
 */
export function compareBots(a: BotLike, b: BotLike): number {
  if (a.needs_action !== b.needs_action) return a.needs_action ? -1 : 1;
  const aUnread = a.unread > 0;
  const bUnread = b.unread > 0;
  if (aUnread !== bUnread) return aUnread ? -1 : 1;
  const at = time(b.last_message_at) - time(a.last_message_at);
  if (at !== 0) return at;
  if (a.is_default !== b.is_default) return a.is_default ? -1 : 1;
  return a.name.localeCompare(b.name);
}

/**
 * Bucket order: an unreachable box sinks, and everything above it sorts the way
 * its bots do.
 *
 * Sinking rather than hiding is the whole of the rule. A box that is off the
 * tailnet is the box an operator is most likely to be looking for, and a rail
 * that quietly drops it answers "where did ember go" with silence.
 */
export function compareBuckets(a: RailBucket, b: RailBucket): number {
  if (a.reachable !== b.reachable) return a.reachable ? -1 : 1;
  if (a.needsAction !== b.needsAction) return a.needsAction ? -1 : 1;
  const aUnread = a.unread > 0;
  const bUnread = b.unread > 0;
  if (aUnread !== bUnread) return aUnread ? -1 : 1;
  const at = time(b.lastAt) - time(a.lastAt);
  if (at !== 0) return at;
  return a.instance.localeCompare(b.instance);
}

function matchesQuery(bot: BotLike, needle: string): boolean {
  if (!needle) return true;
  const q = needle.toLowerCase();
  return (
    bot.name.toLowerCase().includes(q) ||
    bot.instance.toLowerCase().includes(q) ||
    (bot.title ?? "").toLowerCase().includes(q) ||
    (bot.description ?? "").toLowerCase().includes(q) ||
    (bot.section ?? "").toLowerCase().includes(q)
  );
}

function matchesFilter(bot: BotLike, filter: RailFilter, extra = 0): boolean {
  if (filter === "unread") return railUnread(bot, extra) > 0 || bot.needs_action;
  if (filter === "needs") return bot.needs_action;
  return true;
}

/**
 * The rail's whole content, grouped, filtered and ordered.
 *
 * Scope is the only thing that changes the *shape*: `all` returns one bucket
 * per instance, and `instance` returns exactly one bucket whose sections the
 * component draws at top level with no header above them (§9.2). The filtering
 * is identical in both, which is what lets the scope switcher be a switch and
 * not a second rail.
 *
 * An unreachable swarm keeps its bucket even when the filter would empty it:
 * the bucket *is* the fact being reported, and `bots: []` from a box that did
 * not answer is not the same statement as a box with no bots.
 */
export function railBuckets<B extends BotLike>(
  swarms: readonly SwarmLike<B>[],
  opts: {
    scope: RailScope;
    filter?: RailFilter;
    query?: string;
    /** The inbox's unread `chat.*` rows per bot, when the rail has an inbox to read. */
    unreadOf?: RailUnreadLookup;
  } = { scope: { kind: "all" } },
): RailBucket<B>[] {
  const filter = opts.filter ?? "all";
  const unreadOf = opts.unreadOf ?? (() => 0);
  const query = (opts.query ?? "").trim();
  const scope = opts.scope;
  const scoped =
    scope.kind === "instance" ? swarms.filter((s) => s.instance === scope.instance) : [...swarms];

  const buckets: RailBucket<B>[] = [];
  for (const swarm of scoped) {
    const kept = swarm.bots.filter(
      (b) => matchesFilter(b, filter, unreadOf(b.instance, b.name)) && matchesQuery(b, query),
    );
    if (kept.length === 0 && swarm.reachable) continue;

    // The operator's declared section order first, then any section a bot
    // claims that the swarm did not list, then the unsectioned bots. A bot
    // naming a section nobody declared is a real case — the box is authoritative
    // about its own profiles and the section list is a convenience on top.
    const declared = swarm.sections.filter((name) => kept.some((b) => b.section === name));
    const extra = [
      ...new Set(kept.map((b) => b.section ?? "").filter((s) => s && !declared.includes(s))),
    ].sort();
    const names: (string | null)[] = [...declared, ...extra];
    if (kept.some((b) => !b.section)) names.push(null);

    const sections: RailSection<B>[] = names
      .map(
        (name): RailSection<B> => ({
          name,
          bots: kept.filter((b) => (b.section ?? null) === name).sort(compareBots),
        }),
      )
      .filter((s) => s.bots.length > 0);

    buckets.push({
      instance: swarm.instance,
      reachable: swarm.reachable,
      reason: swarm.unreachable_reason ?? null,
      warmUsed: swarm.warm_slots.used,
      warmTotal: swarm.warm_slots.total,
      botCount: swarm.bots.length,
      unread: kept.reduce((n, b) => n + railUnread(b, unreadOf(b.instance, b.name)), 0),
      needsAction: kept.some((b) => b.needs_action),
      lastAt:
        kept
          .map((b) => b.last_message_at ?? null)
          .filter((v): v is string => !!v)
          .sort()
          .pop() ?? null,
      sections,
    });
  }
  return buckets.sort(compareBuckets);
}

/**
 * The three warm-slot squares (`.ch-slots > i`), as class names.
 *
 * `on` for a slot in use, `wait` for the one a queued bot is waiting on, and
 * empty for a free one. The queue is drawn from the first second rather than
 * the thirtieth because upstream's limit *fails* an open after thirty seconds
 * of waiting, and a dead click is the worst shape that limit can take (§9.2).
 */
export function warmSlots(used: number, total: number, waiting = false): ("on" | "wait" | "")[] {
  const count = Math.max(total, 0) || 3;
  const slots: ("on" | "wait" | "")[] = [];
  for (let i = 0; i < count; i++) {
    if (i < used) slots.push("on");
    else if (waiting && i === used) slots.push("wait");
    else slots.push("");
  }
  return slots;
}

/** The fleet-wide line in `.ch-rail-foot`: what is there, and what wants you. */
export function railFooter(buckets: readonly RailBucket[]): { roster: string; attention: string } {
  const bots = buckets.reduce((n, b) => n + b.botCount, 0);
  const needs = buckets.filter((b) => b.needsAction).length;
  return {
    roster: `${buckets.length} instance${buckets.length === 1 ? "" : "s"} · ${bots} bot${bots === 1 ? "" : "s"}`,
    attention: needs === 0 ? "nothing waiting" : `${needs} need${needs === 1 ? "s" : ""} you`,
  };
}

/* ── the thread's own state ─────────────────────────────────────────────────── */

/**
 * Which pane the thread is in.
 *
 * Derived rather than stored, and derived from the *fleet* row rather than from
 * anything chat learned: a box that is stopped is stopped whether or not a
 * transcript read has failed yet, and telling the operator "reconnecting…"
 * about a box the fleet stream already says is stopped is a worse lie than
 * saying nothing.
 */
export type ThreadState =
  | "ready"
  | "empty"
  | "bootstrapping"
  | "stopped"
  | "destroyed"
  | "unreachable"
  | "no_tailnet"
  | "dropped";

export interface ThreadStateInput {
  /** `display_status` from the agent row, or `null` when the fleet has no such row. */
  status: string | null;
  /** The swarm answered this box. False for a box the roster read could not reach. */
  reachable: boolean;
  /** The turn stream dropped and a reconnect is pending. */
  reconnecting: boolean;
  /** The transcript read came back with nothing. */
  empty: boolean;
  /**
   * This laptop has no tailnet path at all — `offTailnet` in `chat-state.tsx`.
   *
   * Not "every box failed to answer", which is what this field used to be fed
   * and which is only the symptom: thirteen stopped boxes look identical from
   * here. Phase 7 makes the caller confirm it against `doctor`'s reading of the
   * *local* tailscale before claiming it, because "you are off the tailnet" and
   * "that box did not answer" have completely different fixes.
   */
  fleetUnreachable?: boolean;
}

export function threadState(input: ThreadStateInput): ThreadState {
  if (input.status === "destroyed") return "destroyed";
  if (input.status === "stopped" || input.status === "stopping") return "stopped";
  if (input.status === "creating" || input.status === "bootstrapping" || input.status === "pending") {
    return "bootstrapping";
  }
  if (input.fleetUnreachable) return "no_tailnet";
  if (input.reconnecting) return "dropped";
  if (!input.reachable) return "unreachable";
  if (input.empty) return "empty";
  return "ready";
}

/**
 * Whether the composer accepts a message, and what it says when it does not.
 *
 * Two gates, and the destination gate is checked first. A thread can be
 * perfectly healthy and still have nowhere named to send to — see `Destination`
 * — and that is the case where an enabled composer is actively dangerous rather
 * than merely premature.
 */
export function composerState(
  state: ThreadState,
  dest: Destination = { state: "known", origin: "portal", detail: null },
): { enabled: boolean; placeholder: string } {
  if (dest.state === "pending") {
    return { enabled: false, placeholder: "reading which conversation this is…" };
  }
  if (dest.state === "unchosen") {
    return { enabled: false, placeholder: "pick a conversation above to reply into" };
  }
  if (dest.state === "unknown") {
    return { enabled: false, placeholder: "no destination — hermetic will not guess where this goes" };
  }
  switch (state) {
    case "destroyed":
      return { enabled: false, placeholder: "destroyed is terminal — this transcript is read-only" };
    case "stopped":
      return { enabled: false, placeholder: "the agent is stopped — start it to send a message" };
    case "dropped":
      return { enabled: false, placeholder: "reconnecting…" };
    case "unreachable":
    case "no_tailnet":
      return { enabled: false, placeholder: "no route to this box" };
    case "bootstrapping":
      // Deliberately enabled. The box is coming up and the message is queued:
      // you can type now, and it sends the moment the gateway answers.
      return { enabled: true, placeholder: "Queue a first message…" };
    default:
      return { enabled: true, placeholder: "Message…" };
  }
}

/* ── markdown, reduced to what a transcript actually contains ────────────── */

/**
 * The parser lives in `chat-markdown.ts`; it is re-exported here so that the
 * renderer and the tests keep importing it from the module that owns the rest
 * of the chat rules.
 */
export { parseInline, parseMarkdown, withBreaks } from "./chat-markdown.ts";
export type { MdAlign, MdItem, MdList, MdNode, MdSpan } from "./chat-markdown.ts";

/**
 * Which tools this thread has actually used, in first-use order, with the worst
 * verdict each of them reached.
 *
 * The context panel draws these as `.ch-toolchip`s, and the ordering is
 * deliberate: first use, not alphabetical and not frequency. The question the
 * panel answers is "what has this bot been allowed to do in here", and the
 * order things first happened in is the closest a list gets to that.
 */
export function toolsUsed(messages: readonly MessageLike[]): { name: string; verdict: CardVerdict }[] {
  const worst: Record<CardVerdict, number> = { ok: 0, muted: 0, acc: 1, warn: 2, unknown: 2, bad: 3 };
  const seen = new Map<string, CardVerdict>();
  for (const message of messages) {
    for (const block of message.blocks) {
      if (blockKind(block) !== "tool") continue;
      const name = typeof block["name"] === "string" ? block["name"] : "tool";
      const verdict = toolVerdict(typeof block["status"] === "string" ? block["status"] : "");
      const held = seen.get(name);
      if (held === undefined || worst[verdict] > worst[held]) seen.set(name, verdict);
    }
  }
  return [...seen.entries()].map(([name, verdict]) => ({ name, verdict }));
}

/** The conversation's running totals, summed off the turn meters the box sent. */
export function threadTotals(messages: readonly MessageLike[]): {
  turns: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  /** False when no message carried usage, so the panel can say "—" and not "$0". */
  metered: boolean;
} {
  let inputTokens = 0;
  let outputTokens = 0;
  let costUsd = 0;
  let metered = false;
  for (const message of messages) {
    if (!message.usage) continue;
    metered = true;
    inputTokens += message.usage.input_tokens ?? 0;
    outputTokens += message.usage.output_tokens ?? 0;
    costUsd += message.usage.cost_usd ?? 0;
  }
  return { turns: messages.length, inputTokens, outputTokens, costUsd, metered };
}
