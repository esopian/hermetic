/**
 * Delegated children (`delegate_task`, WI-14) in the conversation record:
 * where a child's block lands, what the head remembers about it beyond that
 * block, and the words its line and its modal say.
 *
 * Core sends a child as one whole `subagent` block, re-sent on every change
 * (`SubagentBlock` in `packages/core/src/schema/chat.ts`), so the only reducer
 * a head needs is replace-by-key (`subagent:<subagent_id>`). The block arrives
 * two ways. During the parent's turn it rides the turn's frames like any other
 * block. After the turn — a background delegation ends its parent turn at once
 * and the children keep going — it arrives on the observation stream as the
 * one typed `subagent` event (§9.2), and lands here: on the row that already
 * carries that key in *any* part of the transcript (a finished turn, a part a
 * steer closed off, the live message), else on the turn holding the
 * `delegate_task` call it belongs to, else on the latest turn. So a child can
 * be `running` inside a turn that is long over, which is the point.
 *
 * Three things are remembered per child, all on the record and all bounded:
 *
 * - `subagentLive` — the latest live block, so a history read that replaces
 *   the transcript (and with it a background child's live row, which history
 *   only knows as `dispatched`) does not set the line back until the next
 *   event. History wins whenever it knows the outcome.
 * - `subagentTrail` — when each tool call and each progress or thinking line
 *   was first seen. The block carries the last 24 tools and only the latest
 *   progress and thinking; the modal's log is chronological, so it needs the
 *   order those arrived in. It is a timeline of the block, not a second copy.
 * - `subagentDrafts` and `subagentControl` — what the operator typed into a
 *   child's steer field and what became of their steer and stop, which must
 *   survive closing and reopening the modal.
 */
import type { ChatBlockOf, ChatBlockView, ChatMessageView } from "../api/index.ts";
import type { Conversation } from "./chat-conversation-record.ts";
import { isProcessEventMessage, processEventOf } from "./process-events.ts";

export type SubagentView = ChatBlockOf<"subagent">;

/** A progress or thinking line, and how many tool calls preceded it. */
export interface TrailNote {
  kind: "progress" | "thinking";
  text: string;
  at: number;
  afterTool: number;
}

/** When the head first saw each of a child's tool calls (by 0-based call index) and notes. */
export interface SubagentTrail {
  tools: ReadonlyMap<number, number>;
  notes: readonly TrailNote[];
}

/**
 * A steer the operator sent one child, and what the box said. `tools` is the
 * child's tool-call count when the box queued it: a call past that count is
 * the heuristic for "likely applied" (Q5).
 */
export interface SubagentSteer {
  state: "sending" | "queued" | "rejected" | "failed";
  text: string;
  at: number;
  tools: number;
  error?: string;
}

/** A stop the operator sent one child. `requested` is delivered, not done. */
export interface SubagentStop {
  state: "sending" | "requested" | "not_found" | "failed";
  at: number;
  error?: string;
}

export interface SubagentControl {
  steer?: SubagentSteer;
  stop?: SubagentStop;
}

/** How many children a record remembers live blocks, trails and controls for. */
const REMEMBER_MAX = 128;
/** How many progress/thinking notes one child's trail keeps. */
const NOTES_MAX = 200;

/** Insert-or-replace with a bound, oldest first out. A fresh map, so a memo sees it move. */
export function remember<V>(map: ReadonlyMap<string, V>, key: string, value: V): Map<string, V> {
  const next = new Map(map);
  next.delete(key);
  next.set(key, value);
  for (const k of next.keys()) {
    if (next.size <= REMEMBER_MAX) break;
    next.delete(k);
  }
  return next;
}

export const isSubagent = (block: ChatBlockView | undefined | null): block is SubagentView =>
  block?.kind === "subagent";

/** The child's own count of tool calls: the wire's, not the 24-row cap. */
export const toolsSeen = (block: SubagentView): number => block.tool_count ?? block.tools.length;

/** A verdict that will not change again. `unknown` is not one: the child may be heard from. */
export const settled = (block: SubagentView): boolean =>
  block.verdict === "done" || block.verdict === "failed" || block.verdict === "stopped";

/** A background handle read from history: accepted, nothing known about how it is going. */
export const dispatchedOnly = (block: SubagentView): boolean => block.status === "dispatched";

/**
 * Whether `incoming` may replace `existing` on screen. The turn and the
 * observation are two pipes and a frame can be late, so a block never moves a
 * child backwards: a settled child stays settled, a running one never loses a
 * tool call, and a history row that knows the outcome (and the cost, which the
 * live wire never carries) is kept over a live copy of the same ending.
 */
export function supersedes(existing: SubagentView, incoming: SubagentView): boolean {
  if (settled(existing)) {
    if (!settled(incoming)) return false;
    return existing.origin !== "history" || incoming.origin === "history";
  }
  if (incoming.verdict === "running" && existing.verdict === "running" && !dispatchedOnly(existing))
    return toolsSeen(incoming) >= toolsSeen(existing);
  return true;
}

/**
 * A row standing in for `block` under another id: the history read of the same
 * call's same task (`hist:<tool_id>:<index>`, or a `dispatched` handle), which
 * the live child replaces rather than sitting beside.
 */
function standsIn(row: SubagentView, block: SubagentView): boolean {
  return (
    row.subagent_id !== block.subagent_id &&
    row.origin === "history" &&
    block.origin !== "history" &&
    !!block.tool_id &&
    row.tool_id === block.tool_id &&
    row.task_index === block.task_index &&
    row.depth === block.depth
  );
}

type Placed = ChatBlockView[] | "kept" | null;

/**
 * `block` folded into `blocks` by key (or over its stand-in); `kept` when it
 * lost to what is there. A history row that wins over its live child still
 * takes the child's id: the operator's steer and stop, the trail and an open
 * modal are all keyed by the id the child had live, and a synthetic
 * `hist:<tool>:<index>` would orphan every one of them.
 */
function placeIn(blocks: readonly ChatBlockView[], block: SubagentView): Placed {
  let at = blocks.findIndex((b) => isSubagent(b) && b.subagent_id === block.subagent_id);
  if (at === -1) at = blocks.findIndex((b) => isSubagent(b) && standsIn(b, block));
  if (at === -1) return null;
  const there = blocks[at] as SubagentView;
  const next = [...blocks];
  if (supersedes(there, block)) next[at] = block;
  else if (there.subagent_id !== block.subagent_id)
    next[at] = { ...there, subagent_id: block.subagent_id };
  else return "kept";
  return next;
}

const holdsTool = (message: ChatMessageView, toolId: string): boolean =>
  message.blocks.some((b) => b.kind === "tool" && b.tool_id === toolId);

/**
 * Put `block` on screen: replace its row wherever it is, else append it to the
 * turn holding its `delegate_task` call. `latest` adds the last fallback, the
 * latest turn of the conversation, for an observed child whose call this
 * browser never drew. `true` when the record changed.
 */
export function placeSubagent(record: Conversation, block: SubagentView, latest: boolean): boolean {
  if (record.live) {
    const placed = placeIn(record.live.blocks, block);
    if (placed === "kept") return false;
    if (placed) {
      record.live = { ...record.live, blocks: placed };
      return true;
    }
  }
  for (let i = record.messages.length - 1; i >= 0; i--) {
    const placed = placeIn(record.messages[i]!.blocks, block);
    if (placed === "kept") return false;
    if (placed) {
      replaceAt(record, i, placed);
      return true;
    }
  }
  const toolId = block.tool_id;
  if (toolId) {
    if (record.live && holdsTool(record.live, toolId)) {
      record.live = { ...record.live, blocks: [...record.live.blocks, block] };
      return true;
    }
    for (let i = record.messages.length - 1; i >= 0; i--) {
      if (!holdsTool(record.messages[i]!, toolId)) continue;
      replaceAt(record, i, [...record.messages[i]!.blocks, block]);
      return true;
    }
  }
  if (!latest) return false;
  if (record.live) {
    record.live = { ...record.live, blocks: [...record.live.blocks, block] };
    return true;
  }
  for (let i = record.messages.length - 1; i >= 0; i--) {
    const message = record.messages[i]!;
    if (message.role === "user" || isProcessEventMessage(message)) continue;
    replaceAt(record, i, [...message.blocks, block]);
    return true;
  }
  return false;
}

function replaceAt(record: Conversation, index: number, blocks: ChatBlockView[]): void {
  const next = [...record.messages];
  next[index] = { ...next[index]!, blocks } as ChatMessageView;
  record.messages = next;
}

/**
 * Remember a live block: the latest copy, and when its new tool calls and
 * notes were first seen. History rows are not remembered; they are already
 * what the box will say on every read.
 */
export function noteSubagent(record: Conversation, block: SubagentView, now: number): void {
  if (block.origin === "history") return;
  const before = subagentIn(record, block.subagent_id) ?? undefined;
  if (before && !supersedes(before, block)) return;
  record.subagentLive = remember(record.subagentLive, block.subagent_id, block);
  const trail = record.subagentTrail.get(block.subagent_id);
  const tools = new Map(trail?.tools ?? []);
  const notes = [...(trail?.notes ?? [])];
  const count = toolsSeen(block);
  // A child first seen mid-run has calls nobody here watched start: those get
  // no stamp rather than a wrong one.
  for (let i = before ? toolsSeen(before) : count; i < count; i++) if (!tools.has(i)) tools.set(i, now);
  if (before === undefined && count === 1 && !tools.has(0)) tools.set(0, now);
  // Only the calls the block still holds can be drawn; older stamps go.
  const oldest = count - block.tools.length;
  for (const index of tools.keys()) if (index < oldest) tools.delete(index);
  for (const kind of ["thinking", "progress"] as const) {
    const text = block[kind];
    if (text && text !== before?.[kind]) notes.push({ kind, text, at: now, afterTool: count });
  }
  if (!trail && tools.size === 0 && notes.length === 0) return;
  record.subagentTrail = remember(record.subagentTrail, block.subagent_id, {
    tools,
    notes: notes.slice(-NOTES_MAX),
  });
}

/** The child's copy in the transcript or the live message, newest first. */
function onScreen(record: Conversation, id: string): SubagentView | null {
  for (const message of [record.live, ...[...record.messages].reverse()]) {
    const found = message?.blocks.find((b) => isSubagent(b) && b.subagent_id === id);
    if (found && isSubagent(found)) return found;
  }
  return null;
}

/** The child's latest block this record holds: the remembered live copy, else the transcript's. */
export function subagentIn(record: Conversation, id: string): SubagentView | null {
  return record.subagentLive.get(id) ?? onScreen(record, id);
}

/**
 * Hand over a record's children and start it empty: a rolled-over session's
 * children leave with it (the snapshot's retired copy), so none of them is
 * re-placed into the conversation that replaced it.
 */
export function takeSubagents(
  record: Conversation,
): Pick<Conversation, "subagentLive" | "subagentTrail" | "subagentDrafts" | "subagentControl"> {
  const children = {
    subagentLive: record.subagentLive,
    subagentTrail: record.subagentTrail,
    subagentDrafts: record.subagentDrafts,
    subagentControl: record.subagentControl,
  };
  record.subagentLive = new Map();
  record.subagentTrail = new Map();
  record.subagentDrafts = new Map();
  record.subagentControl = new Map();
  // A streaming turn stays with the conversation that replaced the retired
  // one (its later output belongs there), but the children it already drew go
  // with their caches: none of them is this conversation's.
  if (record.live?.blocks.some(isSubagent))
    record.live = { ...record.live, blocks: record.live.blocks.filter((b) => !isSubagent(b)) };
  return children;
}

/** Every copy of the child on screen: the live message's and each transcript row's. */
function allOnScreen(record: Conversation, id: string): SubagentView[] {
  return [record.live, ...record.messages].flatMap((message) =>
    (message?.blocks ?? []).filter((b): b is SubagentView => isSubagent(b) && b.subagent_id === id),
  );
}

/**
 * A turn frame carrying a child: remembered, and handed back for the store's
 * own merge — or `null` when it must not be merged at all.
 *
 * Frames can be late, so a frame has to beat every copy already drawn: one a
 * re-read settled from history (authoritative, with the cost the wire never
 * carries, and already holding the live id) is never replaced by a running or
 * older frame, which would flip it back to running and re-offer Steer and Stop.
 * A frame older than a copy the observation delivered but nothing could draw
 * yet carries that newer copy instead, to the frame's destination, so the
 * child neither moves backwards nor stays off screen.
 */
export function noteSubagentFrame(
  record: Conversation,
  block: ChatBlockView,
  now: number,
): ChatBlockView | null {
  if (!isSubagent(block)) return block;
  const shown = allOnScreen(record, block.subagent_id);
  if (shown.some((copy) => copy !== block && !supersedes(copy, block))) return null;
  const known = record.subagentLive.get(block.subagent_id);
  if (known && known !== block && !supersedes(known, block)) return known;
  noteSubagent(record, block, now);
  return block;
}

/** An observed `subagent` event: remembered, then placed (`placeSubagent`). */
export function observeSubagent(record: Conversation, block: SubagentView, now: number): boolean {
  noteSubagent(record, block, now);
  return placeSubagent(record, block, true);
}

/**
 * After a read replaced the transcript: put each remembered live child back
 * over the row history drew for it, where that row knows less. Never onto a
 * turn that does not hold the child's call — a read is the box's word on what
 * the conversation is.
 */
export function reapplySubagents(record: Conversation): void {
  for (const block of record.subagentLive.values()) placeSubagent(record, block, false);
}

/* ── what a child says ───────────────────────────────────────────────────── */

export function firstLine(text: string | null | undefined): string {
  if (!text) return "";
  return (
    text
      .split("\n")
      .map((line) => line.trim())
      .find(Boolean) ?? ""
  );
}

/** Upstream's note when a steer reached a child too late (`[steer did not land — …]`). */
export const steerMissed = (summary: string | null | undefined): boolean =>
  typeof summary === "string" && summary.includes("[steer did not land");

/** The summary without upstream's missed-steer note, which the steer state reports instead. */
const plainSummary = (summary: string | null | undefined): string =>
  (summary ?? "").replace(/\[steer did not land[^\]]*\]/g, "").trim();

export interface Glyph {
  glyph: string;
  tone: "ok" | "bad" | "run" | "idle";
  word: string;
}

export function glyphOf(block: SubagentView): Glyph {
  if (dispatchedOnly(block)) return { glyph: "○", tone: "idle", word: "dispatched" };
  switch (block.verdict) {
    case "running":
      return { glyph: "●", tone: "run", word: block.status === "queued" ? "queued" : "running" };
    case "done":
      return { glyph: "✓", tone: "ok", word: "done" };
    case "failed":
      return { glyph: "✕", tone: "bad", word: block.status === "completed" ? "failed" : block.status };
    case "stopped":
      return { glyph: "■", tone: "idle", word: "stopped" };
    default:
      return { glyph: "?", tone: "idle", word: "unobserved" };
  }
}

export const UNOBSERVED_TEXT = "no longer observable — results arrive with the next turn";
export const DISPATCHED_TEXT = "dispatched in the background — results arrive with a later turn";

/** The line's activity column. `none` draws nothing. */
export type ActivityLine =
  | { kind: "tool"; name: string; text: string }
  | { kind: "summary" | "error" | "note"; text: string }
  | { kind: "none" };

/**
 * What a child is doing, or how it ended: the latest tool call while it runs,
 * the first line of its summary once done, its failure text when it failed
 * (live: the summary, which is all the wire carries; history: the classified
 * `failure_reason`). Under FAILURES ONLY (Q9) a successful child says nothing.
 */
export function activityOf(block: SubagentView, failuresOnly = false): ActivityLine {
  if (dispatchedOnly(block)) return { kind: "note", text: DISPATCHED_TEXT };
  switch (block.verdict) {
    case "running": {
      const tool = block.tools[block.tools.length - 1];
      if (tool) return { kind: "tool", name: tool.name, text: tool.preview };
      if (block.progress) return { kind: "note", text: firstLine(block.progress) };
      return { kind: "note", text: block.status === "queued" ? "queued" : "starting" };
    }
    case "done":
      return failuresOnly
        ? { kind: "none" }
        : { kind: "summary", text: firstLine(plainSummary(block.summary)) };
    case "failed":
      return {
        kind: "error",
        text:
          firstLine(block.result?.failure_reason) ||
          firstLine(block.result?.error) ||
          firstLine(plainSummary(block.summary)) ||
          block.status,
      };
    case "stopped":
      return { kind: "error", text: firstLine(plainSummary(block.summary)) || "stopped" };
    default:
      return { kind: "note", text: UNOBSERVED_TEXT };
  }
}

/** How long a child has run (live) or ran (settled), or `null` when nothing says. */
export function elapsedOf(block: SubagentView, now: number): number | null {
  if (block.verdict !== "running" || dispatchedOnly(block)) return block.duration_ms ?? null;
  const started = block.started_at ? Date.parse(block.started_at) : Number.NaN;
  return Number.isFinite(started) ? Math.max(0, now - started) : (block.duration_ms ?? null);
}

/** A running timer: `0:28`, `12:04`. */
export function clockText(ms: number | null): string {
  if (ms === null) return "";
  const s = Math.floor(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/** A finished duration: `22s`, `1m 04s`. */
export function spanText(ms: number | null): string {
  if (ms === null) return "";
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, "0")}s`;
}

export function timeText(block: SubagentView, now: number): string {
  const ms = elapsedOf(block, now);
  return block.verdict === "running" && !dispatchedOnly(block) ? clockText(ms) : spanText(ms);
}

const count = (n: number, one: string, many = `${one}s`): string =>
  `${n.toLocaleString("en-US")} ${n === 1 ? one : many}`;

/** Q2: `duration · tools · files · tokens · api calls`, whatever of it is known. */
export function rollupOf(block: SubagentView): string {
  const files = (block.files_read?.length ?? 0) + (block.files_written?.length ?? 0);
  const u = block.usage;
  const tokens =
    u && (u.input_tokens ?? u.output_tokens ?? u.reasoning_tokens) !== undefined
      ? (u.input_tokens ?? 0) + (u.output_tokens ?? 0) + (u.reasoning_tokens ?? 0)
      : null;
  return [
    spanText(block.duration_ms ?? null) || null,
    count(toolsSeen(block), "tool"),
    files ? count(files, "file") : null,
    tokens !== null ? count(tokens, "token") : null,
    u?.api_calls !== undefined ? count(u.api_calls, "api call") : null,
  ]
    .filter(Boolean)
    .join(" · ");
}

/** Q1: a child's cost, only when its history envelope said it. Never live, never summed. */
export function costOf(block: SubagentView): string | null {
  const cost = block.result?.cost_usd;
  return typeof cost === "number" ? `$${cost.toFixed(4)}` : null;
}

/** Steer and Stop are offered while the child's last known state is running (D25). */
export const controllable = (block: SubagentView): boolean =>
  block.verdict === "running" && !dispatchedOnly(block) && block.origin !== "history";

export const GONE_TEXT = "subagent gone or session reset";

/** Q5's three steps, plus the refusals. `null` when nothing was steered. */
export function steerLabel(control: SubagentControl | undefined, block: SubagentView): string | null {
  const steer = control?.steer;
  if (!steer) return null;
  switch (steer.state) {
    case "sending":
      return "Sending steer…";
    case "failed":
      return `Steer not sent — ${steer.error ?? "error"}`;
    case "rejected":
      return `Not delivered — ${GONE_TEXT}`;
    default:
      if (steerMissed(block.summary)) return "Steer did not land";
      return toolsSeen(block) > steer.tools ? "Likely applied" : "Queued · not yet confirmed";
  }
}

/** "Stop requested" until the child's `interrupted` completion, then "Stopped by you". */
export function stopLabel(control: SubagentControl | undefined, block: SubagentView): string | null {
  const stop = control?.stop;
  if (!stop) return null;
  switch (stop.state) {
    case "sending":
      return "Stopping…";
    case "failed":
      return `Stop not sent — ${stop.error ?? "error"}`;
    case "not_found":
      return `Not found — ${GONE_TEXT}`;
    default:
      if (block.status === "interrupted") return "Stopped by you";
      return settled(block) ? null : "Stop requested";
  }
}

/* ── where a child sits ─────────────────────────────────────────────────── */

const order = (a: SubagentView, b: SubagentView) => a.task_index - b.task_index || a.depth - b.depth;

/**
 * Children flattened under their parents (Q3): each run of siblings in task
 * order, every grandchild right after the child that spawned it.
 */
export function flatten(children: readonly SubagentView[]): SubagentView[] {
  const ids = new Set(children.map((c) => c.subagent_id));
  const roots = children.filter((c) => !c.parent_id || !ids.has(c.parent_id)).sort(order);
  const out: SubagentView[] = [];
  const seen = new Set<string>();
  const visit = (node: SubagentView) => {
    if (seen.has(node.subagent_id)) return;
    seen.add(node.subagent_id);
    out.push(node);
    for (const kid of children.filter((c) => c.parent_id === node.subagent_id).sort(order)) visit(kid);
  };
  for (const root of roots) visit(root);
  for (const rest of children) visit(rest);
  return out;
}

/**
 * One run group's children: those under each `delegate_task` call it drew (by
 * `tool_id`), and the loose ones, drawn at the end of the group. A grandchild
 * rides with its parent's call.
 */
export function subagentLayout(blocks: readonly ChatBlockView[]): {
  byTool: Map<string, SubagentView[]>;
  loose: SubagentView[];
} {
  const tools = new Set(blocks.flatMap((b) => (b.kind === "tool" && b.tool_id ? [b.tool_id] : [])));
  const kids = blocks.filter(isSubagent);
  const home = new Map<string, string | null>();
  const resolve = (kid: SubagentView, depth = 0): string | null => {
    if (home.has(kid.subagent_id)) return home.get(kid.subagent_id)!;
    let where: string | null = kid.tool_id && tools.has(kid.tool_id) ? kid.tool_id : null;
    const parent = kid.parent_id ? kids.find((k) => k.subagent_id === kid.parent_id) : undefined;
    if (where === null && parent && depth < 8) where = resolve(parent, depth + 1);
    home.set(kid.subagent_id, where);
    return where;
  };
  const byTool = new Map<string, SubagentView[]>();
  const loose: SubagentView[] = [];
  for (const kid of kids) {
    const where = resolve(kid);
    if (where === null) loose.push(kid);
    else byTool.set(where, [...(byTool.get(where) ?? []), kid]);
  }
  for (const [id, list] of byTool) byTool.set(id, flatten(list));
  return { byTool, loose: flatten(loose) };
}

/** Where one child sits in the transcript: its block, its siblings and the turn holding it. */
export interface SubagentPlace {
  block: SubagentView;
  siblings: SubagentView[];
  message: string;
}

/**
 * Every child in the transcript, with the siblings the modal lists beside it:
 * the same group the inline lines draw (`subagentLayout`), across the merged
 * turn. The latest copy of a child wins.
 */
export function subagentPlaces(groups: readonly { id: string; blocks: readonly ChatBlockView[] }[]) {
  const places = new Map<string, SubagentPlace>();
  for (const group of groups) {
    if (!group.blocks.some(isSubagent)) continue;
    const { byTool, loose } = subagentLayout(group.blocks);
    for (const list of [...byTool.values(), loose])
      for (const block of list)
        places.set(block.subagent_id, { block, siblings: list, message: group.id });
  }
  return places;
}

/**
 * The results turn each background delegation came back in, by delegation id:
 * the `subagents returned` event naming it, or a later row whose own children
 * settled under the same delegation. Only for delegations something here was
 * told was dispatched.
 */
export function delegationResults(messages: readonly ChatMessageView[]): Map<string, string> {
  const dispatched = new Set<string>();
  for (const m of messages)
    for (const b of m.blocks)
      if (isSubagent(b) && dispatchedOnly(b) && b.delegation_id) dispatched.add(b.delegation_id);
  const found = new Map<string, string>();
  if (dispatched.size === 0) return found;
  for (const m of messages) {
    const event = processEventOf(m);
    const id = event?.delegation?.id;
    if (id && dispatched.has(id) && !found.has(id)) found.set(id, m.id);
    for (const b of m.blocks)
      if (
        isSubagent(b) &&
        !dispatchedOnly(b) &&
        settled(b) &&
        b.delegation_id &&
        dispatched.has(b.delegation_id)
      )
        if (!found.has(b.delegation_id)) found.set(b.delegation_id, m.id);
  }
  return found;
}

export function hasSubagents(messages: readonly ChatMessageView[]): boolean {
  return messages.some((m) => m.blocks.some(isSubagent));
}
