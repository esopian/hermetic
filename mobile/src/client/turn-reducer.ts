/**
 * Folding a turn's `ChatFrame`s into the reply being assembled.
 *
 * Mirror of the desktop's frame assembly (`packages/ui/src/chat/chat-state.tsx`,
 * `applyFrame` and friends, and the turn loop's `seq`/delta rules in
 * `chat-conversations.ts`). The rules, and why each exists, are commented there
 * at length; in short:
 *
 * - a tool block replaces the card with the same `tool_id` (name as fallback);
 * - an approval or question replaces by `request_id`, so a replayed request
 *   updates its own card rather than drawing a second one;
 * - an activity replaces by `activity:<key>`, a subagent by `subagent:<id>`;
 * - a `delta` appends to the last text block, opening one when needed;
 * - a frame with a lower `seq` than the last one is dropped, and so is a delta
 *   repeated verbatim at the same `seq`;
 * - an `error` sets the turn's `failure`, minting the message if nothing came.
 *
 * Pure: no React, no React Native, no clock.
 */
import type { ChatBlock, ChatFrame, ChatMessage } from "@hermetic/core/chat-client";

export function toolKey(block: ChatBlock): string | null {
  if (block.kind !== "tool") return null;
  const id = block.tool_id;
  return typeof id === "string" && id.length > 0 ? `id:${id}` : `name:${block.name}`;
}

export function requestKey(block: ChatBlock): string | null {
  if (block.kind !== "approval" && block.kind !== "question") return null;
  const id = block.request_id;
  if (typeof id !== "string" || id.length === 0) return null;
  return `${block.kind}:${id}`;
}

export function blockKey(block: ChatBlock): string | null {
  if (block.kind === "activity") return `activity:${block.key}`;
  if (block.kind === "subagent") return `subagent:${block.subagent_id}`;
  return toolKey(block) ?? requestKey(block);
}

export function mergeBlock(blocks: ChatBlock[], incoming: ChatBlock): ChatBlock[] {
  const key = blockKey(incoming);
  if (key === null) return [...blocks, incoming];
  const at = blocks.findIndex((b) => blockKey(b) === key);
  if (at === -1) return [...blocks, incoming];
  const next = [...blocks];
  next[at] = incoming;
  return next;
}

export function appendDelta(blocks: ChatBlock[], text: string): ChatBlock[] {
  for (let i = blocks.length - 1; i >= 0; i--) {
    const block = blocks[i];
    if (block?.kind === "text") {
      const next = [...blocks];
      next[i] = { ...block, markdown: block.markdown + text };
      return next;
    }
  }
  return [...blocks, { kind: "text", markdown: text }];
}

export function applyFrame(
  live: ChatMessage | null,
  frame: ChatFrame,
  seed: { session: string; at: string },
): ChatMessage {
  const base: ChatMessage = live ?? {
    id: frame.type === "error" ? `failed:${seed.at}` : frame.message,
    session: seed.session,
    role: "bot",
    author: null,
    at: seed.at,
    blocks: [],
    usage: null,
    error: null,
    incomplete: null,
  };
  if (frame.type === "error")
    return { ...base, failure: frame.failure ?? { code: frame.code, message: frame.message } };
  if (frame.type === "block") return { ...base, blocks: mergeBlock(base.blocks, frame.block) };
  if (frame.type === "delta") return { ...base, blocks: appendDelta(base.blocks, frame.text) };
  return { ...base, usage: frame.usage ?? base.usage, incomplete: frame.incomplete ?? null };
}

/* ── the turn loop's frame filter ───────────────────────────────────────── */

export type TurnActivity = "idle" | "thinking" | "streaming";

/** Mirror of `nextTurnActivity` (`packages/ui/src/chat/chat-activity.ts`). */
export function nextTurnActivity(current: TurnActivity, frame: ChatFrame): TurnActivity {
  if (frame.type === "done" || frame.type === "error") return "idle";
  if (frame.type === "delta") return frame.text.trim() ? "streaming" : current;
  const block = frame.block;
  if (block.kind === "text") return block.markdown.trim() ? "streaming" : current;
  if (block.kind === "tool" || block.kind === "reasoning") return "thinking";
  if (block.kind === "approval" || block.kind === "question") return "idle";
  if (block.kind === "activity") {
    if (block.category === "generation" && block.state === "running") return "thinking";
    if (block.request_id && block.state === "done") return "thinking";
  }
  return current;
}

/** Everything the loop remembers between frames of one turn. */
export interface TurnFold {
  live: ChatMessage | null;
  /** The highest upstream `seq` folded so far (`-1` before the first). */
  seq: number;
  /** `seq:text` of the last delta, so a verbatim repeat is dropped. */
  lastDelta: string | null;
  /** A `done` or `error` has been folded; nothing after it counts. */
  terminal: boolean;
  activity: TurnActivity;
  /** Request ids of approvals/questions this turn is waiting on. */
  openRequests: readonly string[];
}

export function freshFold(live: ChatMessage | null = null): TurnFold {
  return { live, seq: -1, lastDelta: null, terminal: false, activity: "thinking", openRequests: [] };
}

/** Requests a block opens or (by a done `notice` activity) closes. */
export function trackRequests(
  open: readonly string[],
  frame: ChatFrame,
  released?: ReadonlySet<string>,
): string[] {
  if (frame.type !== "block") return [...open];
  const block = frame.block;
  if (block.kind === "approval" || block.kind === "question") {
    const id = block.request_id;
    if (!id || open.includes(id) || released?.has(id)) return [...open];
    return [...open, id];
  }
  if (
    block.kind === "activity" &&
    block.category === "notice" &&
    block.state === "done" &&
    block.request_id
  )
    return open.filter((id) => id !== block.request_id);
  return [...open];
}

/**
 * Fold one frame, applying the loop's drop rules first. Returns the same
 * object when the frame was dropped, so a caller can tell by identity.
 */
export function foldFrame(
  state: TurnFold,
  frame: ChatFrame,
  seed: { session: string; at: string },
  released?: ReadonlySet<string>,
): TurnFold {
  if (state.terminal) return state;
  if (frame.type === "error") {
    return {
      ...state,
      terminal: true,
      activity: "idle",
      openRequests: [],
      live: applyFrame(state.live, frame, seed),
    };
  }
  if (frame.seq < state.seq) return state;
  let lastDelta = state.lastDelta;
  if (frame.type === "delta") {
    const fingerprint = `${frame.seq}:${frame.text}`;
    if (fingerprint === lastDelta) return state;
    lastDelta = fingerprint;
  }
  const terminal = frame.type === "done";
  return {
    live: applyFrame(state.live, frame, seed),
    seq: frame.seq,
    lastDelta,
    terminal,
    activity: nextTurnActivity(state.activity, frame),
    openRequests: terminal ? [] : trackRequests(state.openRequests, frame, released),
  };
}
