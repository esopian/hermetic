/**
 * Background-process events in a thread (§9.2): the pure half.
 *
 * Hermes wakes a bot by injecting a `user`-role row when a background process
 * finishes, a watch pattern matches, a subagent batch returns or the MCP
 * servers reload. Core recognises those rows and hands them over as a `system`
 * message carrying exactly one `process_event` block. Nobody typed them, so the
 * thread must never draw them as the operator — they get their own row type in
 * the avatar gutter instead, and this module decides where those rows go:
 *
 * - **Bursts.** Two or more routine events in a row, with no chat turn between
 *   them, fold into one `n events` row. A failure, a DM reply and a subagent
 *   result are never routine (`isRoutineProcessEvent`), so each keeps its own
 *   row and breaks a burst.
 * - **Density.** "failures only" hides the routine events, bursts included.
 *   What it keeps is exactly what a burst refuses to swallow.
 * - **Links.** A `terminal` call started in the background names its process
 *   in its result; the event names the same id. The two rows link to each other
 *   only when both are in the loaded transcript, and the event's duration is
 *   read off the two stamps — never estimated.
 *
 * Everything here is pure and keyed on shapes, so it is tested without
 * mounting anything (`packages/ui/test/process-events.test.ts`).
 */
import { isRoutineProcessEvent, processEventSentence } from "@hermetic/core/shared";
import type { ChatBlockOf } from "../api/index.ts";
import { messageAgentCall } from "./bot-dm.ts";
import type { BlockLike, MessageLike } from "./chat-logic.ts";
import type { TurnRow } from "./chat-turns.ts";

export type ProcessEventView = ChatBlockOf<"process_event">;

/**
 * The event a message carries, when it is an event message: exactly one
 * `process_event` block. The role is not checked — core marks these `system`,
 * but a row that carries one is an event row whatever it claims to be, and an
 * event row is never the operator speaking.
 */
export function processEventOf(message: Pick<MessageLike, "blocks">): ProcessEventView | null {
  const blocks = message.blocks;
  if (!Array.isArray(blocks) || blocks.length !== 1) return null;
  const block = blocks[0] as BlockLike | undefined;
  return block?.kind === "process_event" ? (block as unknown as ProcessEventView) : null;
}

export function isProcessEventMessage(message: Pick<MessageLike, "blocks">): boolean {
  return processEventOf(message) !== null;
}

export function hasProcessEvents(messages: readonly Pick<MessageLike, "blocks">[]): boolean {
  return messages.some(isProcessEventMessage);
}

/* ── rows: bursts, density, and the "responding to" line ─────────────────── */

/** Per-thread event density: everything, or only what needs reading. */
export type EventDensity = "compact" | "failures";

export interface EventEntry<M extends MessageLike = MessageLike> {
  row: TurnRow<M>;
  event: ProcessEventView;
}

export type ThreadItem<M extends MessageLike = MessageLike> =
  | {
      kind: "turn";
      row: TurnRow<M>;
      /** `↳ responding to …`, when this bot turn directly follows an event row. */
      inReply: string | null;
    }
  | ({ kind: "event" } & EventEntry<M>)
  | {
      kind: "burst";
      /** The first event's source id, which does not move as the burst grows. */
      key: string;
      divider: string | null;
      entries: EventEntry<M>[];
    };

/** A burst needs at least this many routine events; one alone keeps its own row. */
const BURST_MIN = 2;

/** What a bot turn directly after an event says it is answering. */
function respondingTo<M extends MessageLike>(item: ThreadItem<M>): string | null {
  if (item.kind === "burst") return `${item.entries.length} events`;
  if (item.kind !== "event") return null;
  const dm = item.event.dm;
  if (dm) return `${dm.to_profile}'s DM reply`;
  return processEventSentence(item.event).replace(/^■\s*/, "");
}

/**
 * The thread's presented rows, with events drawn as events.
 *
 * `rows` is `turnRows()` output: an event message is always a row of its own
 * there, because a `system` row that is not tool machinery is a hard break in
 * `turnGroups()`. This pass only decides which of those rows fold together and
 * which are hidden.
 *
 * The `responding to` line is decided before the density filter: the bot was
 * answering the event whether or not the reader chose to see it.
 *
 * A hidden row's day divider moves to the next row that is drawn, so hiding the
 * first event of a day does not also hide the day.
 */
export function threadItems<M extends MessageLike>(
  rows: readonly TurnRow<M>[],
  density: EventDensity = "compact",
): ThreadItem<M>[] {
  const items: ThreadItem<M>[] = [];
  let run: EventEntry<M>[] = [];
  const flush = () => {
    if (run.length >= BURST_MIN) {
      items.push({
        kind: "burst",
        key: run[0]!.row.ids[0] ?? run[0]!.row.message.id,
        divider: run[0]!.row.divider,
        entries: run,
      });
    } else {
      for (const entry of run) items.push({ kind: "event", ...entry });
    }
    run = [];
  };
  for (const row of rows) {
    const event = processEventOf(row.message);
    if (event && isRoutineProcessEvent(event)) {
      // A day boundary inside a run starts a new one: a burst is drawn under
      // one divider, and that would put a later day's events under an earlier one.
      if (run.length > 0 && row.divider !== null) flush();
      run.push({ row, event });
      continue;
    }
    flush();
    if (event) {
      items.push({ kind: "event", row, event });
      continue;
    }
    const previous = items[items.length - 1];
    const inReply =
      previous && previous.kind !== "turn" && row.message.role === "bot"
        ? respondingTo(previous)
        : null;
    items.push({ kind: "turn", row, inReply });
  }
  flush();
  return density === "failures" ? withoutRoutine(items) : items;
}

/** True for an item "failures only" hides. */
export function hiddenByFailuresOnly<M extends MessageLike>(item: ThreadItem<M>): boolean {
  if (item.kind === "burst") return true;
  return item.kind === "event" && isRoutineProcessEvent(item.event);
}

function itemDivider<M extends MessageLike>(item: ThreadItem<M>): string | null {
  return item.kind === "burst" ? item.divider : item.row.divider;
}

function withDivider<M extends MessageLike>(item: ThreadItem<M>, divider: string): ThreadItem<M> {
  if (item.kind === "burst") return { ...item, divider };
  return { ...item, row: { ...item.row, divider } };
}

function withoutRoutine<M extends MessageLike>(items: readonly ThreadItem<M>[]): ThreadItem<M>[] {
  const kept: ThreadItem<M>[] = [];
  let carried: string | null = null;
  for (const item of items) {
    if (hiddenByFailuresOnly(item)) {
      carried = itemDivider(item) ?? carried;
      continue;
    }
    kept.push(carried !== null && itemDivider(item) === null ? withDivider(item, carried) : item);
    carried = null;
  }
  return kept;
}

/* ── the burst's one line ────────────────────────────────────────────────── */

export type EventTone = "ok" | "bad" | "warn" | "mute";

export interface BurstPart {
  text: string;
  tone: EventTone;
}

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

/**
 * `3 completed · 1 watch match`, in a fixed order so two bursts of the same
 * mix read the same. Only routine events reach a burst, so there is no failed
 * bucket to count.
 */
export function burstParts(events: readonly ProcessEventView[]): BurstPart[] {
  let completed = 0;
  let watches = 0;
  let terminated = 0;
  let notices = 0;
  for (const event of events) {
    if (event.event === "watch_match") watches++;
    else if (event.outcome === "terminated") terminated++;
    else if (event.event === "completion" && event.outcome === "ok") completed++;
    else notices++;
  }
  const parts: BurstPart[] = [];
  if (completed) parts.push({ text: `${completed} completed`, tone: "ok" });
  if (watches) parts.push({ text: plural(watches, "watch match", "watch matches"), tone: "warn" });
  if (terminated) parts.push({ text: `${terminated} terminated`, tone: "mute" });
  if (notices) parts.push({ text: plural(notices, "notice", "notices"), tone: "mute" });
  return parts;
}

/** `proc_3be1` — enough of a process id to tell a burst's members apart. */
export function shortProcessId(id: string): string {
  const match = /^(proc_[0-9a-z]{4})[0-9a-z]+$/i.exec(id);
  return match ? match[1]! : id;
}

/* ── one event's line ────────────────────────────────────────────────────── */

/** The status square's colour. A watch match is the one warn: something asked to be told. */
export function eventTone(event: ProcessEventView): EventTone {
  if (event.event === "watch_match") return "warn";
  if (event.outcome === "ok") return "ok";
  if (event.outcome === "failed") return "bad";
  return "mute";
}

/** The kicker at the start of the line. */
export function eventKind(event: ProcessEventView): string {
  switch (event.event) {
    case "completion":
      return "process";
    case "watch_match":
    case "watch_disabled":
      return "watch";
    case "delegation":
      return "subagents";
    case "mcp_reload":
      return "mcp";
    default:
      return "notice";
  }
}

/**
 * The status word, in upstream's own phrase where it has one: `completed` for
 * a clean exit (upstream says "completed normally"), otherwise the status as
 * the notice worded it — `exited`, `failed to start`, `terminated by Hermes`.
 */
export function eventStatus(event: ProcessEventView): string {
  if (event.outcome === "ok") return "completed";
  const status = event.status?.trim();
  if (status) return status;
  return event.outcome === "terminated" ? "terminated" : event.outcome === "failed" ? "failed" : "";
}

/* ── output ──────────────────────────────────────────────────────────────── */

/** The output's lines, without the trailing blank ones a captured tail ends on. */
export function outputLines(tail: string | null | undefined): string[] {
  if (!tail) return [];
  const lines = tail.replace(/\r\n/g, "\n").split("\n");
  while (lines.length > 0 && lines[lines.length - 1]!.trim() === "") lines.pop();
  return lines;
}

/** The last line with anything on it, which is what a collapsed row hints with. */
export function lastLine(lines: readonly string[]): string {
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!.trim();
    if (line) return line;
  }
  return "";
}

/** Lines an expanded failure shows before "show all": the error is at the end. */
export const FAILURE_TAIL_LINES = 6;
/** Lines an expanded clean exit shows before "show all". */
export const OUTPUT_TAIL_LINES = 12;

export interface HighlightPart {
  text: string;
  hit: boolean;
}

/**
 * A matched line with the watch pattern marked. The pattern is matched as a
 * literal substring — upstream's watch patterns are plain strings, and reading
 * one as a regular expression would let a stray `(` break the row — and the
 * parts are rendered as text nodes, so nothing in either needs escaping.
 */
export function highlightParts(text: string, pattern: string | null | undefined): HighlightPart[] {
  if (!pattern) return [{ text, hit: false }];
  const parts: HighlightPart[] = [];
  let from = 0;
  for (let at = text.indexOf(pattern); at !== -1; at = text.indexOf(pattern, from)) {
    if (at > from) parts.push({ text: text.slice(from, at), hit: false });
    parts.push({ text: pattern, hit: true });
    from = at + pattern.length;
  }
  if (from < text.length || parts.length === 0) parts.push({ text: text.slice(from), hit: false });
  return parts;
}

/* ── links between a start and its event ─────────────────────────────────── */

function recordOf(value: unknown): Record<string, unknown> | null {
  if (typeof value === "string") {
    try {
      return recordOf(JSON.parse(value) as unknown);
    } catch {
      return null;
    }
  }
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * The process a `terminal` call started in the background, or null, or the
 * delivery a `message_agent` call queued. For `terminal`, Hermes
 * answers `background: true` with `{ output: "Background process started",
 * session_id: "proc_…" }`, which arrives as an object or, from an older
 * adapter, as that object's JSON — anything else is not a start.
 */
export function backgroundProcessId(block: BlockLike): string | null {
  // A `message_agent` call's acknowledgement names the delivery process whose
  // completion notice carries the reply (`bot-dm.ts`).
  const dm = messageAgentCall(block);
  if (dm) return dm.processId;
  if (block.kind !== "tool" || block["name"] !== "terminal") return null;
  const args = recordOf(block["args"]);
  if (args?.["background"] !== true) return null;
  const id = recordOf(block["result"])?.["session_id"];
  return typeof id === "string" && id.length > 0 ? id : null;
}

/**
 * Every background start in the loaded transcript, by process id, with the
 * stamp of the source row it arrived on. Read off the unmerged messages: a
 * merged turn is stamped with its first row, which is not when the call ran.
 */
export function processStarts(messages: readonly MessageLike[]): Map<string, { at: string }> {
  const starts = new Map<string, { at: string }>();
  for (const message of messages) {
    for (const block of message.blocks) {
      const id = backgroundProcessId(block);
      if (id && !starts.has(id)) starts.set(id, { at: message.at });
    }
  }
  return starts;
}

/**
 * The event row each process's "result ↓" lands on, among the drawn items: its
 * process id to the source id of its *last* event. A watched process can match
 * several times before it exits, and the row worth landing on is the latest.
 */
export function eventAnchors<M extends MessageLike>(
  items: readonly ThreadItem<M>[],
): Map<string, string> {
  const anchors = new Map<string, string>();
  for (const item of items) {
    const entries = item.kind === "burst" ? item.entries : item.kind === "event" ? [item] : [];
    for (const entry of entries)
      if (entry.event.process_id) anchors.set(entry.event.process_id, entry.row.message.id);
  }
  return anchors;
}

/** A process id as a DOM id: the event row's, or its starting tool step's. */
export function processDomId(end: "event" | "start", processId: string): string {
  return `ch-${end === "event" ? "ev" : "start"}-${processId.replace(/[^A-Za-z0-9_-]/g, "_")}`;
}

/** Milliseconds from the start's stamp to the event's, or null when either is unreadable. */
export function spanMs(startAt: string | null | undefined, eventAt: string): number | null {
  if (!startAt) return null;
  const ms = Date.parse(eventAt) - Date.parse(startAt);
  return Number.isFinite(ms) && ms >= 0 ? ms : null;
}

/** `42s`, `4m 10s`, `1h 02m` — how long a process ran. */
export function fmtSpan(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, "0")}s`;
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}m`;
}

/* ── the places an event row must not read as the operator ───────────────── */

/**
 * What quick jump searches a message by. An event row has no prose the
 * operator wrote, so it is not searchable as one of their messages.
 */
export function searchableText(message: Pick<MessageLike, "blocks">): string {
  if (isProcessEventMessage(message)) return "";
  return message.blocks
    .flatMap((block) =>
      block.kind === "text" && typeof block["markdown"] === "string" ? [block["markdown"]] : [],
    )
    .join(" ");
}

/**
 * What the rail quotes for a message this browser just watched land: its prose,
 * or, for an event row, the one sentence every head words it with. Another
 * bot's DM delivery is quoted as that bot speaking, as core's roster preview is.
 */
export function previewText(message: Pick<MessageLike, "blocks" | "from_bot">): string {
  const event = processEventOf(message);
  if (event) return processEventSentence(event);
  const prose = message.blocks
    .map((block) =>
      block.kind === "text" && typeof block["markdown"] === "string" ? block["markdown"] : "",
    )
    .filter((text) => text.length > 0)
    .join("\n");
  return message.from_bot && prose ? `${message.from_bot.name}: ${prose}` : prose;
}
