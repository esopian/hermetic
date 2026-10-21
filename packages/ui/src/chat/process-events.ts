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
 * - **Markers.** A boundary rather than work — a cron or webhook delivery, a
 *   heartbeat, a loop wakeup, a handoff, a resumed or compacted context, a
 *   carried-over task list, a model switch (`isMarkerEvent`) — is drawn as a
 *   centred marker between turns. It never joins a burst, and the bot turn
 *   right after it says `re: …` in its header instead of `↳ responding to`.
 * - **Links.** A `terminal` call started in the background names its process
 *   in its result; the event names the same id. The two rows link to each other
 *   only when both are in the loaded transcript, and the event's duration is
 *   read off the two stamps — never estimated.
 *
 * Everything here is pure and keyed on shapes, so it is tested without
 * mounting anything (`packages/ui/test/process-events.test.ts`).
 */
import {
  isRoutineProcessEvent,
  NUDGE_LABELS,
  processEventSentence,
  todoSummary,
} from "@hermetic/core/shared";
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

/* ── rows: bursts and the "responding to" line ──────────────────────────── */

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
      /** `re: …` in the header, when this bot turn directly follows a marker. */
      re: string | null;
    }
  | ({ kind: "event" } & EventEntry<M>)
  /** An event drawn as a centred marker between turns (`isMarkerEvent`); never in a burst. */
  | ({ kind: "marker" } & EventEntry<M>)
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
 * `turnGroups()`. This pass only decides which of those rows fold together.
 * Nothing is hidden: there is one rendering, and every row already keeps its
 * output collapsed, so a quiet event costs one line and a failure stands out
 * in red without a filter to find it.
 */
export function threadItems<M extends MessageLike>(rows: readonly TurnRow<M>[]): ThreadItem<M>[] {
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
    if (event && isMarkerEvent(event)) {
      flush();
      items.push({ kind: "marker", row, event });
      continue;
    }
    // A warn (an oversized tool call, the tool-call limit) is routine to core
    // but should be noticed, so it keeps its own row here, as a failure does.
    if (event && isRoutineProcessEvent(event) && event.outcome !== "warn") {
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
    const bot = previous !== undefined && row.message.role === "bot";
    const re = bot && previous.kind === "marker" ? markerRe(previous.event) : null;
    const inReply = bot && previous.kind !== "turn" ? respondingTo(previous) : null;
    items.push({ kind: "turn", row, inReply, re });
  }
  flush();
  return items;
}

/* ── markers: injected events drawn between turns ───────────────────────── */

/**
 * The events drawn as a centred marker between turns rather than a gutter row:
 * a boundary in the conversation (a scheduled wakeup, a handoff, a resumed or
 * compacted context, a model change) rather than work the bot did. A UI
 * decision keyed on the event type; core stays presentation-free.
 */
const MARKER_EVENTS: ReadonlySet<ProcessEventView["event"]> = new Set([
  "cron",
  "webhook",
  "heartbeat",
  "loop",
  "handoff",
  "resume",
  "compaction",
  "todo",
  "model_switch",
]);

export function isMarkerEvent(event: ProcessEventView): boolean {
  return MARKER_EVENTS.has(event.event) && !event.dm;
}

export type MarkerTone = "bad" | "warn" | "";

export interface MarkerView {
  text: string;
  sub: string | null;
  tone: MarkerTone;
}

type NoticeTask = NonNullable<NonNullable<ProcessEventView["notice"]>["tasks"]>[number];

/** `1 active · 2 open`: done and cancelled items are not counted, a kept done parent included. */
export function taskCounts(tasks: readonly NoticeTask[]): string {
  return todoSummary(tasks);
}

const quoted = (text: string | null | undefined): string | null => (text ? `“${text}”` : null);

/** A marker's line: `text · sub`, and its colour. Fixed copy, plus only what the notice stated. */
export function markerView(event: ProcessEventView): MarkerView {
  const n = event.notice;
  const tone: MarkerTone = event.outcome === "failed" ? "bad" : event.outcome === "warn" ? "warn" : "";
  const view = (text: string, sub: string | null = null): MarkerView => ({ text, sub, tone });
  switch (event.event) {
    case "cron":
      return view(
        `cron · ${event.message ?? "job"}`,
        event.outcome === "failed" ? "failed" : n?.variant === "mirrored" ? "mirrored" : "delivered",
      );
    case "webhook":
      return view(`webhook · ${event.message ?? "delivery"}`, "mirrored");
    case "heartbeat":
      return view(n?.detail ? `heartbeat · every ${n.detail}` : "heartbeat", n?.subject ?? null);
    case "loop":
      return view(n?.detail ? `loop wakeup ${n.detail}` : "loop wakeup", n?.subject ?? null);
    case "handoff":
      return view(`handed off from ${n?.detail ?? "another client"}`, quoted(n?.subject));
    case "resume":
      if (n?.variant === "crash")
        return view("turn resumed after a crash", n.subject ? `re-sent: ${quoted(n.subject)}` : null);
      return view(n?.detail ? `turn resumed after ${n.detail}` : "turn resumed");
    case "compaction":
      return view("context compacted", "earlier turns summarised");
    case "todo":
      return view("task list carried over", taskCounts(n?.tasks ?? []));
    case "model_switch":
      return view(`model → ${n?.subject ?? "changed"}`, n?.detail ?? null);
    default:
      return view(processEventSentence(event).replace(/^■\s*/, ""));
  }
}

/** What the bot turn right after a marker says it answers: `re: <this>`. */
export function markerRe(event: ProcessEventView): string {
  switch (event.event) {
    case "cron":
      return `cron ${event.message ?? "job"}`;
    case "webhook":
      return `webhook ${event.message ?? "delivery"}`;
    case "loop": {
      const wakeup = /#\d+/.exec(event.notice?.detail ?? "")?.[0];
      return wakeup ? `/loop ${wakeup}` : "/loop";
    }
    case "resume":
      return "resumed turn";
    case "compaction":
      return "compacted context";
    case "todo":
      return "task list";
    case "model_switch":
      return "model switch";
    default:
      return event.event;
  }
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
  if (event.event === "watch_match" || event.outcome === "warn") return "warn";
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
    case "iteration_limit":
      return "limit";
    case "model_switch":
      return "model";
    case "cron":
    case "webhook":
    case "heartbeat":
    case "loop":
    case "goal":
    case "handoff":
    case "resume":
    case "nudge":
    case "compaction":
    case "todo":
    case "personality":
      return event.event;
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

export interface NoticeLine {
  status: string;
  subject: string | null;
  /** The folded payload and its label; the raw notice when the event states no body. */
  fold: { label: string; text: string };
}

/**
 * The gutter line of an injected notice drawn as an event (goal, nudge,
 * iteration limit, personality): a fixed status word, the one thing it is
 * about, and its payload folded. Null for every other event.
 */
export function noticeLine(event: ProcessEventView): NoticeLine | null {
  const n = event.notice;
  const raw = { label: "injected prompt", text: event.raw };
  switch (event.event) {
    case "goal": {
      const gate = n?.variant === "gate_failed" || event.outcome === "failed";
      return {
        status: gate ? "gate failed" : "continuing",
        subject: n?.subject ?? null,
        fold: n?.body ? { label: gate ? "gate output" : "injected prompt", text: n.body } : raw,
      };
    }
    case "nudge":
      return {
        status: (n?.variant && NUDGE_LABELS[n.variant]) || "continuation",
        subject: n?.subject ?? null,
        fold: raw,
      };
    case "iteration_limit":
      return { status: "tool-call limit reached", subject: "asked for a final summary", fold: raw };
    case "personality":
      if (n?.variant === "cleared") return { status: "cleared", subject: "default style", fold: raw };
      return {
        status: "set",
        subject: n?.subject ?? null,
        fold: n?.body ? { label: "persona", text: n.body } : raw,
      };
    default:
      return null;
  }
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
