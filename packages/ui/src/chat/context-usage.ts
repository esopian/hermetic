/**
 * How full the conversation's context window is, for the composer's meter.
 *
 * The figure is the gateway's own (§9.2): `context_used` is the last prompt's
 * size, not a running total, against the model's `context_max`. It arrives on
 * each completed turn's usage and, while a turn runs, on the live
 * `session.usage` ticks core keeps as a `usage` activity block. Nothing here
 * estimates: a conversation whose gateway reported no window has no figure.
 *
 * The box's stored rows carry no window, so the re-read that replaces a settled
 * turn's live copy would take the figure away. The conversation's record keeps
 * the newest one it has seen (`Conversation.context`, `noteContext`), and the
 * thread draws the newer of that and what its own rows carry.
 */
import type { ChatBlockView, ChatFrameView, ChatUsageView } from "../api/types.ts";

/** At or above this share of the window the meter turns warn. */
export const CONTEXT_WARN_PERCENT = 80;
/** At or above this share it turns bad: the next long turn may not fit. */
export const CONTEXT_BAD_PERCENT = 95;

export type ContextLevel = "neutral" | "warn" | "bad";

export interface ContextUsage {
  used: number;
  max: number;
  /** 0–100, the gateway's rounding when it sent one. */
  percent: number;
  /** The gateway counted locally rather than reading the provider's figure. */
  estimated: boolean;
}

interface MessageLike {
  at: string;
  usage?: ChatUsageView | null;
  blocks: readonly ChatBlockView[];
}

export function contextLevel(percent: number): ContextLevel {
  if (percent >= CONTEXT_BAD_PERCENT) return "bad";
  if (percent >= CONTEXT_WARN_PERCENT) return "warn";
  return "neutral";
}

/** A figure, and the time of the message that carried it. */
export interface ContextReading {
  usage: ContextUsage;
  at: string;
}

/**
 * The newest window figure in the thread, or null when there is none.
 *
 * Walks newest first. Within one message a completed turn's usage is newer than
 * any tick it received while running, so it wins; a message still streaming has
 * no usage yet and its latest tick answers instead.
 */
export function latestContextReading(messages: readonly MessageLike[]): ContextReading | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]!;
    const settled = message.usage ? fromFields(message.usage) : null;
    if (settled) return { usage: settled, at: message.at };
    for (let j = message.blocks.length - 1; j >= 0; j--) {
      const tick = fromTick(message.blocks[j]!);
      if (tick) return { usage: tick, at: message.at };
    }
  }
  return null;
}

export function latestContextUsage(messages: readonly MessageLike[]): ContextUsage | null {
  return latestContextReading(messages)?.usage ?? null;
}

/**
 * Whichever reading is newer by its time; `b`, the one arriving, on a tie —
 * two frames of one turn can land in the same millisecond, and the later
 * frame is the later figure.
 */
export function newerReading(
  a: ContextReading | null,
  b: ContextReading | null,
): ContextReading | null {
  if (a === null) return b;
  if (b === null) return a;
  return Date.parse(b.at) >= Date.parse(a.at) ? b : a;
}

/**
 * The figure one live frame carries, stamped `at`: a completed turn's usage on
 * `done`, or a `session.usage` tick's payload on an activity block.
 */
export function frameContext(frame: ChatFrameView, at: string): ContextReading | null {
  const usage =
    frame.type === "done"
      ? frame.usage
        ? fromFields(frame.usage)
        : null
      : frame.type === "block"
        ? fromTick(frame.block)
        : null;
  return usage ? { usage, at } : null;
}

/** A `session.usage` tick's payload is upstream's raw object: read it warily. */
function fromTick(block: ChatBlockView): ContextUsage | null {
  if (block.kind !== "activity" || block.category !== "usage") return null;
  const payload = block.payload;
  if (typeof payload !== "object" || payload === null) return null;
  const usage = (payload as { usage?: unknown }).usage;
  if (typeof usage !== "object" || usage === null) return null;
  return fromFields(usage as Record<string, unknown>);
}

function fromFields(fields: {
  context_used?: unknown;
  context_max?: unknown;
  context_percent?: unknown;
  context_estimated?: unknown;
}): ContextUsage | null {
  const used = finite(fields.context_used);
  const max = finite(fields.context_max);
  if (used === null || max === null || used < 0 || max <= 0) return null;
  const sent = finite(fields.context_percent);
  const percent = Math.min(100, Math.max(0, Math.round(sent ?? (used / max) * 100)));
  return { used, max, percent, estimated: fields.context_estimated === true };
}

function finite(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

const TOKENS = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });

/** The meter's short label: `47%`, or `~47%` when the gateway estimated. */
export function contextLabel(usage: ContextUsage): string {
  return `${usage.estimated ? "~" : ""}${usage.percent}%`;
}

/** The exact figures, for the tooltip and the accessible name. */
export function contextDetail(usage: ContextUsage): string {
  const approx = usage.estimated ? "about " : "";
  return `Context: ${approx}${TOKENS.format(usage.used)} / ${TOKENS.format(usage.max)} tokens (${usage.percent}%)`;
}
