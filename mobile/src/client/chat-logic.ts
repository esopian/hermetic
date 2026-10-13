/**
 * The transcript's rules: time ladders, link safety, card verdicts, the block
 * kind switch, message grouping, failure copy, and the thread/composer state.
 *
 * Mirrors of `packages/ui/src/chat/chat-logic.ts` (same names, same rules, and
 * the same reasons, which are argued at length there). The one deliberate
 * difference is `openableHref`: a phone has no "same origin", so a root path or
 * a fragment is drawn as text rather than opened. Pure TypeScript.
 */
import type { ChatBlock, ChatMessage } from "@hermetic/core/chat-client";

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

const sameDay = (a: Date, b: Date) =>
  a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();

/** `now` · `9m` · `03:00` · `Fri` · `Sep 2`. A future stamp (clock skew) reads `now`. */
export function railTime(iso: string | null | undefined, now: number): string {
  if (!iso) return "—";
  const then = new Date(iso);
  const at = then.getTime();
  if (Number.isNaN(at)) return "—";
  const age = now - at;
  if (age < 45_000) return "now";
  if (age < HOUR) return `${Math.max(1, Math.round(age / MINUTE))}m`;
  if (sameDay(then, new Date(now))) return `${pad2(then.getHours())}:${pad2(then.getMinutes())}`;
  if (age < 6 * DAY) return WEEKDAYS[then.getDay()] ?? "—";
  return `${MONTHS[then.getMonth()]} ${then.getDate()}`;
}

/** The stamp beside a message: the clock time today, `railTime`'s older forms before. */
export function threadTime(iso: string | null | undefined, now: number): string {
  if (!iso) return "—";
  const then = new Date(iso);
  if (Number.isNaN(then.getTime())) return "—";
  return sameDay(then, new Date(now))
    ? `${pad2(then.getHours())}:${pad2(then.getMinutes())}`
    : railTime(iso, now);
}

/** `Today · Sep 16`, the divider between two calendar days in the transcript. */
export function dayDivider(iso: string, now: number): string {
  const then = new Date(iso);
  if (Number.isNaN(then.getTime())) return "—";
  const stamp = `${MONTHS[then.getMonth()]} ${then.getDate()}`;
  return sameDay(then, new Date(now)) ? `Today · ${stamp}` : stamp;
}

/** `6.2s`, `1.4m`. */
export function fmtMs(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return "";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${(ms / 60_000).toFixed(1)}m`;
}

/** `214 KB`, `1.9 MB`. */
export function fmtBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "—";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** `1,234` — numbers always in one explicit locale. */
export const fmtCount = (n: number): string => n.toLocaleString("en-US");

/* ── URLs a model wrote ──────────────────────────────────────────────────── */

const LINK_SCHEMES = new Set(["http:", "https:", "mailto:"]);

/** The desktop's allow-list: http, https, mailto, a root path, a fragment. Else `null`. */
export function safeHref(href: string | null | undefined): string | null {
  if (typeof href !== "string") return null;
  const raw = href.trim();
  if (raw.length === 0) return null;
  if (raw.startsWith("#")) return raw;
  if (raw.startsWith("/") && !raw.startsWith("//")) return raw;
  const scheme = /^([a-zA-Z][a-zA-Z0-9+.-]*):/.exec(raw);
  if (!scheme) return null;
  return LINK_SCHEMES.has(`${scheme[1]?.toLowerCase()}:`) ? raw : null;
}

/**
 * What the phone may hand to the OS to open: `safeHref`'s absolute schemes
 * only. A root path or fragment means "this portal" on the desktop and nothing
 * at all on a phone, so it is drawn as text.
 */
export function openableHref(href: string | null | undefined): string | null {
  const safe = safeHref(href);
  if (safe === null || safe.startsWith("/") || safe.startsWith("#")) return null;
  return safe;
}

/* ── cards ───────────────────────────────────────────────────────────────── */

export type CardVerdict = "ok" | "warn" | "bad" | "acc" | "muted" | "unknown";

/** A settled verdict starts collapsed; only `unknown` starts open. */
export function startsCollapsed(verdict: CardVerdict): boolean {
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

/* ── blocks ──────────────────────────────────────────────────────────────── */

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
  "subagent",
  "unknown",
] as const;

export type BlockKindName = (typeof CHAT_BLOCK_KINDS)[number];

const KNOWN_KINDS = new Set<string>(CHAT_BLOCK_KINDS);

/** Which renderer a block reaches; anything this build cannot name is `unknown`. */
export function blockKind(block: { kind?: unknown }): BlockKindName {
  const kind = typeof block.kind === "string" ? block.kind : "";
  return KNOWN_KINDS.has(kind) ? (kind as BlockKindName) : "unknown";
}

export function unknownName(block: { kind?: unknown; name?: unknown }): string {
  if (typeof block.name === "string" && block.name.length > 0) return block.name;
  if (typeof block.kind === "string" && block.kind.length > 0) return block.kind;
  return "block";
}

export function unknownPayload(block: object): unknown {
  return "payload" in block ? (block as { payload: unknown }).payload : block;
}

/** Pretty JSON for a payload, with a cycle-proof fallback. */
export function formatPayload(value: unknown): string {
  if (value === undefined) return "undefined";
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    return String(value);
  }
}

/* ── messages ────────────────────────────────────────────────────────────── */

export interface MessageRow<M extends ChatMessage = ChatMessage> {
  message: M;
  /** The same author spoke last: the avatar and name are drawn once for the run. */
  continuation: boolean;
  /** The day divider this message opens, or `null`. */
  divider: string | null;
}

/** Who said it, as a grouping key. */
export function authorKey(m: ChatMessage): string {
  if (m.role === "user") return m.from_bot ? `dm:${m.from_bot.handle ?? m.from_bot.name}` : "user";
  if (m.author) return `${m.author.bot}@${m.author.instance}`;
  return m.role;
}

/** Consecutive messages by one author collapse; a day boundary raises a divider. */
export function messageRows<M extends ChatMessage>(
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
    const broken = !!message.error || !!message.incomplete || !!message.failure;
    rows.push({ message, continuation: divider === null && author === lastAuthor && !broken, divider });
    lastAuthor = broken ? null : author;
    lastDay = day;
  }
  return rows;
}

/** The rail's one-line preview, cut the way the box cuts its own. */
export const PREVIEW_CHARS = 60;
export function previewOf(text: string | null | undefined): string | null {
  if (!text) return null;
  const flat = text.replace(/\s*\n+\s*/g, " ").trim();
  if (!flat) return null;
  return flat.length > PREVIEW_CHARS ? `${flat.slice(0, PREVIEW_CHARS)}...` : flat;
}

/** A message's prose, joined (for copying and for a failed turn's prompt). */
export function messageText(message: Pick<ChatMessage, "blocks">): string {
  return message.blocks
    .map((b: ChatBlock) => (b.kind === "text" ? b.markdown : ""))
    .join("")
    .trim();
}

/* ── failure copy ────────────────────────────────────────────────────────── */

export interface FailureCopy {
  tone: "warn" | "bad";
  head: string;
  right: string;
  title: string;
  detail: string;
}

/** One renderer behind every message-level failure; an unknown code still gets a card. */
export function failureCopy(code: string | null | undefined, message?: string | null): FailureCopy {
  const said = message?.trim() ? message.trim() : "";
  switch (code) {
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

/** What a refused turn's band says (desktop `turnErrorHeadline`). */
export function turnErrorHeadline(code: string): string {
  switch (code) {
    case "ABORT_FAILED":
      return "The turn could not be stopped.";
    case "FLEET_MISMATCH":
    case "NO_TARGET":
      return "Not sent: that agent is not part of the fleet this phone is paired with.";
    case "WRONG_FLEET":
      return "Not sent: this phone is paired with another fleet. Re-pair to use it.";
    default:
      return "The message was not sent.";
  }
}

/* ── thread and composer state ───────────────────────────────────────────── */

export type ThreadState =
  | "ready"
  | "empty"
  | "bootstrapping"
  | "stopped"
  | "destroyed"
  | "unreachable"
  | "no_tailnet"
  | "dropped"
  | "missing";

export interface ThreadStateInput {
  /** `display_status` of the instance's agent row, or `null` when unknown. */
  status: string | null;
  reachable: boolean;
  reconnecting: boolean;
  empty: boolean;
  fleetUnreachable?: boolean;
  /** The bridge said this bot (or this session) does not exist (`NOT_FOUND` on the read). */
  missing?: boolean;
}

export function threadState(input: ThreadStateInput): ThreadState {
  if (input.status === "destroyed") return "destroyed";
  if (input.status === "stopped" || input.status === "stopping") return "stopped";
  if (input.status === "creating" || input.status === "bootstrapping" || input.status === "pending")
    return "bootstrapping";
  if (input.missing) return "missing";
  if (input.fleetUnreachable) return "no_tailnet";
  if (input.reconnecting) return "dropped";
  if (!input.reachable) return "unreachable";
  if (input.empty) return "empty";
  return "ready";
}

/** Whether the composer accepts a message, and what it says when it does not. */
export function composerState(state: ThreadState): { enabled: boolean; placeholder: string } {
  switch (state) {
    case "destroyed":
      return { enabled: false, placeholder: "destroyed is terminal — this transcript is read-only" };
    case "stopped":
      return { enabled: false, placeholder: "the agent is stopped — start it to send a message" };
    case "dropped":
      return { enabled: false, placeholder: "reconnecting…" };
    case "missing":
      return { enabled: false, placeholder: "nothing to send to" };
    case "unreachable":
    case "no_tailnet":
      return { enabled: false, placeholder: "no route to this box" };
    case "bootstrapping":
      return { enabled: true, placeholder: "Queue a first message…" };
    default:
      return { enabled: true, placeholder: "Message…" };
  }
}
