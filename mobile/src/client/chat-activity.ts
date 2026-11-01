/**
 * One turn's work as the transcript draws it: which blocks are steps of the
 * run (grouped under one collapsible "Worked" head, with the narration between
 * them folded in as notes), which are
 * addressed to the reader, what each step and the group say, and how a
 * delegated child reads on its one line.
 *
 * Mirrors `packages/ui/src/chat/components/Activity.tsx` (`isActivity`,
 * `isStatusBlock`, `needsAttention`, `activityRows`, the step and group
 * status words), the section split in `components/Message.tsx`, and
 * `chat/chat-subagents.ts` (`glyphOf`, `activityOf`, `timeText`, `rollupOf`,
 * `controllable`). Pure TypeScript.
 */
import type { ChatBlock, SubagentBlock } from "@hermetic/core/chat-client";
import { isKanbanTaskTool } from "@hermetic/core/shared";
import { isRequestTool } from "./file-request-logic.ts";
import { isDmTool } from "./message-agent.ts";
import { isShareTool } from "./share-logic.ts";
import { isTodoNotice, isTodoStep } from "./task-list.ts";
import type { TurnActivity } from "./turn-reducer.ts";

/* ── which blocks are run machinery ──────────────────────────────────────── */

export function isActivity(block: ChatBlock): boolean {
  return ["activity", "tool", "reasoning", "subagent", "unknown"].includes(block.kind);
}

const STATUS_CATEGORIES = new Set(["connection", "queue", "history", "usage"]);

/** A status snapshot: drawn as the group's live line, never as a step. */
export function isStatusBlock(block: ChatBlock): boolean {
  if (block.kind !== "activity") return false;
  if (block.role != null) return block.role === "status";
  if (STATUS_CATEGORIES.has(block.category)) return true;
  if (block.category === "generation")
    return block.key === "generation" || block.key === "model:aggregation" || block.key === "reasoning";
  if (block.category === "notice") return /^status(:|$)/.test(block.key);
  return false;
}

export function needsAttention(block: ChatBlock): boolean {
  return (
    block.kind === "approval" ||
    block.kind === "question" ||
    (block.kind === "activity" && (block.state === "warning" || block.state === "error"))
  );
}

/** Keyed steps collapse to their latest version, in first-seen position. */
export function activityRows(blocks: readonly ChatBlock[]): ChatBlock[] {
  const rows: ChatBlock[] = [];
  const keys = new Map<string, number>();
  for (const block of blocks) {
    const key =
      block.kind === "activity"
        ? `activity:${block.key}`
        : block.kind === "tool" && block.tool_id
          ? `tool:${block.tool_id}`
          : block.kind === "subagent"
            ? `subagent:${block.subagent_id}`
            : null;
    const previous = key === null ? undefined : keys.get(key);
    if (previous !== undefined) rows[previous] = block;
    else {
      if (key !== null) keys.set(key, rows.length);
      rows.push(block);
    }
  }
  return rows;
}

/** A section of a turn: a run of steps, or one block addressed to the reader. */
export interface Section {
  activity: boolean;
  blocks: ChatBlock[];
}

/**
 * The turn's closing prose block: the last text block, provided only steps
 * follow it; else -1. Mirrors desktop `finalText`
 * (`packages/ui/src/chat/chat-silence.ts`).
 */
export function finalText(blocks: readonly ChatBlock[]): number {
  const index = blocks.findLastIndex((block) => block.kind === "text");
  if (index < 0) return -1;
  return blocks.slice(index + 1).every(isActivity) ? index : -1;
}

/**
 * A block that joins (or opens) a run of steps. A file or secret request is a
 * card the operator answers, a shared file is a card with Save, a filed
 * kanban card is its live card, a bot-to-bot DM is a line between the prose,
 * and while the turn runs a todo call is its own Tasks row: none is a step.
 */
function joinsRun(block: ChatBlock, streaming: boolean): boolean {
  if (
    isRequestTool(block) ||
    isShareTool(block) ||
    isKanbanTaskTool(block) ||
    isDmTool(block) ||
    (streaming && isTodoStep(block))
  )
    return false;
  return isActivity(block) && !needsAttention(block);
}

/**
 * Narration between steps ("Let me check that:"): a text block whose next
 * step joins a run. It folds into the run as a note. Notices and other texts
 * are looked past, but a settled turn's closing prose is never one and ends
 * the look: nothing after it makes an earlier text a note.
 */
function isNote(blocks: readonly ChatBlock[], i: number, streaming: boolean, final: number): boolean {
  const block = blocks[i];
  if (block?.kind !== "text" || !block.markdown.trim() || i === final) return false;
  for (let j = i + 1; j < blocks.length; j++) {
    const next = blocks[j];
    if (!next || next.kind === "activity") continue;
    if (next.kind === "text") {
      if (j === final) return false;
      continue;
    }
    return joinsRun(next, streaming);
  }
  return false;
}

/**
 * Each section's React key. A group is keyed by its first step's identity,
 * never a leading note, which can leave the group when the turn settles
 * (desktop `anchorOf`), so the reader's open choice survives; by index when
 * that step has no identity or another group already took it.
 */
export function sectionKeys(list: readonly Section[]): string[] {
  const seen = new Set<string>();
  return list.map((section, index) => {
    if (!section.activity) return `b${index}`;
    const first = section.blocks.find((block) => block.kind !== "text");
    const own =
      first?.kind === "tool" && first.tool_id
        ? `a:tool:${first.tool_id}`
        : first?.kind === "activity"
          ? `a:activity:${first.key}`
          : first?.kind === "subagent"
            ? `a:subagent:${first.subagent_id}`
            : null;
    const key = own && !seen.has(own) ? own : `a${index}`;
    seen.add(key);
    return key;
  });
}

/**
 * Split a turn's blocks into sections, the desktop's way (`Message.tsx`).
 * `streaming`: the turn is running, so each todo call is its own one-line
 * Tasks row (once it settles they stay steps of their run), and its last
 * prose is still narration if a step follows it. The `todo.updated` notice
 * and the resume seed restate a call and are never drawn.
 */
export function sections(blocks: readonly ChatBlock[], streaming = false): Section[] {
  const out: Section[] = [];
  const final = streaming ? -1 : finalText(blocks);
  let run: Section | null = null;
  for (const [i, block] of blocks.entries()) {
    if (isTodoNotice(block)) continue;
    if (joinsRun(block, streaming) || isNote(blocks, i, streaming, final)) {
      if (run) run.blocks.push(block);
      else {
        run = { activity: true, blocks: [block] };
        out.push(run);
      }
      continue;
    }
    // Anything else stands alone and closes the run, but a warning notice
    // leaves it open.
    out.push({ activity: false, blocks: [block] });
    if (!(needsAttention(block) && block.kind === "activity")) run = null;
  }
  return out;
}

/** Which activity section is the live one while a turn streams. */
export function activeGroup(
  list: readonly Section[],
  streaming: boolean,
  activity: TurnActivity,
  waiting: boolean,
): number {
  let lastActivity = -1;
  for (let i = list.length - 1; i >= 0; i--)
    if (list[i]?.activity) {
      lastActivity = i;
      break;
    }
  const trailingNotices =
    lastActivity >= 0 &&
    list.slice(lastActivity + 1).every((s) => {
      const first = s.blocks[0];
      // A Tasks row after the run is part of it, like a notice, and so is
      // prose still arriving: the run stays live until the turn settles.
      return first?.kind === "activity" || first?.kind === "text" || (!!first && isTodoStep(first));
    });
  return trailingNotices || (streaming && (activity === "thinking" || waiting))
    ? lastActivity
    : list.length - 1;
}

/* ── what a step and a group say ─────────────────────────────────────────── */

export type StepTone = "ok" | "bad" | "warn" | "run" | "idle";
export interface StepStatus {
  word: string;
  tone: StepTone;
  glyph: string;
}

export function stepStatus(block: ChatBlock, streaming: boolean): StepStatus {
  if (block.kind === "tool")
    switch (block.status) {
      case "ok":
        return { word: "Complete", tone: "ok", glyph: "✓" };
      case "bad":
        return { word: "Failed", tone: "bad", glyph: "✕" };
      case "warn":
        return { word: "Needs attention", tone: "warn", glyph: "!" };
      default:
        return streaming
          ? { word: "Running", tone: "run", glyph: "●" }
          : { word: "Stopped", tone: "idle", glyph: "○" };
    }
  if (block.kind === "activity") {
    if (block.state === "done") return { word: "Complete", tone: "ok", glyph: "✓" };
    if (block.state === "error") return { word: "Failed", tone: "bad", glyph: "✕" };
    if (block.state === "warning") return { word: "Needs attention", tone: "warn", glyph: "!" };
    return streaming
      ? { word: "In progress", tone: "run", glyph: "●" }
      : { word: "", tone: "idle", glyph: "○" };
  }
  if (block.kind === "subagent") {
    const g = glyphOf(block);
    return {
      word: g.word.charAt(0).toUpperCase() + g.word.slice(1),
      tone: g.tone === "run" ? "run" : g.tone,
      glyph: g.glyph,
    };
  }
  if (block.kind === "reasoning") return { word: "Thought", tone: "idle", glyph: "·" };
  return { word: "Details", tone: "idle", glyph: "·" };
}

export function stepLabel(block: ChatBlock): string {
  switch (block.kind) {
    case "activity":
      return block.title;
    case "tool":
      return block.name;
    case "reasoning":
      return "Reasoning";
    case "subagent":
      return block.goal || "Subagent";
    case "unknown":
      return block.name || "block";
    default:
      return block.kind;
  }
}

export interface GroupSummary {
  status: string;
  count: string;
  tone: "ok" | "bad" | "warn" | "muted";
  /** Notes (text) and steps, in arrival order. */
  steps: ChatBlock[];
  kids: SubagentBlock[];
  usage: string | null;
}

/** A note's last sentence, plain, for the live head: "Let me check that…". */
function lastSentence(markdown: string): string {
  const pieces = markdown
    .replace(/\*\*|`|\*/g, "")
    .trim()
    .split(/(?<=[.!?:])\s+/);
  return (pieces[pieces.length - 1] ?? "").replace(/:$/, "…");
}

/**
 * The group head: what the run is doing or did, and how many steps it took.
 * Notes (text folded into the run) are neither steps nor tools; while the run
 * is live, a note newer than every step speaks for it.
 * `streaming` is this group being the live one; `turnRunning` is the turn it
 * belongs to still running, so a group that is not live (yet) is never
 * called complete before the turn settles.
 */
export function groupSummary(
  blocks: readonly ChatBlock[],
  streaming: boolean,
  activity: TurnActivity | undefined,
  waiting: boolean,
  turnRunning = false,
): GroupSummary {
  const rows = activityRows(blocks);
  const all = rows.filter((b) => !isStatusBlock(b));
  const steps = all.filter((b) => b.kind !== "subagent");
  const work = steps.filter((b) => b.kind !== "text");
  const notes = steps.length - work.length;
  const kids = all.filter((b): b is SubagentBlock => b.kind === "subagent");
  const kidsRunning = kids.filter((k) => k.verdict === "running" && k.status !== "dispatched").length;
  const kidsFailed = kids.some((k) => k.verdict === "failed");
  const allTools = steps.filter((b) => b.kind === "tool");
  // A todo call is a task update, not a tool, in the head's words.
  const updates = work.filter(isTodoStep).length;
  const tools = allTools.filter((b) => !isTodoStep(b));
  const finished = tools.length ? "Tools complete" : updates ? "Tasks updated" : null;
  const latest = work[work.length - 1];
  // Live, the newest note says what the run is doing, unless a step started
  // after it is still running (desktop `said`).
  const lastNote = steps.findLastIndex((b) => b.kind === "text");
  const note = steps[lastNote];
  const noteLine =
    note?.kind === "text" &&
    !steps
      .slice(lastNote + 1)
      .some(
        (b) =>
          (b.kind === "tool" && b.status === "running") ||
          (b.kind === "activity" && b.state === "running"),
      )
      ? lastSentence(note.markdown)
      : null;
  const working =
    !!latest &&
    ((latest.kind === "activity" && latest.state === "running") ||
      (latest.kind === "tool" && latest.status === "running"));
  const usageBlock = [...rows].reverse().find((b) => b.kind === "activity" && b.category === "usage");
  const snapshots = rows.filter(
    (b) => isStatusBlock(b) && b.kind === "activity" && b.category !== "usage",
  );
  const statusLine =
    (streaming
      ? [...snapshots].reverse().find((b) => b.kind === "activity" && b.state === "running")
      : undefined) ?? (work.length === 0 ? snapshots[snapshots.length - 1] : undefined);
  const failed = allTools.some((b) => b.kind === "tool" && b.status === "bad");
  const warning = allTools.some((b) => b.kind === "tool" && b.status === "warn");
  const current =
    streaming && !waiting && activity !== "streaming"
      ? working && latest
        ? `${stepStatus(latest, streaming).glyph} ${stepLabel(latest)}`
        : statusLine?.kind === "activity"
          ? statusLine.title
          : undefined
      : undefined;
  const allSettled =
    allTools.length > 0 && allTools.every((b) => b.kind === "tool" && b.status !== "running");
  const status = failed
    ? "Tool failed"
    : warning
      ? "Needs attention"
      : streaming && waiting
        ? "Waiting for your response"
        : kidsRunning
          ? `Waiting on ${kidsRunning} of ${kids.length} subagent${kids.length === 1 ? "" : "s"}`
          : kidsFailed
            ? "Subagent failed"
            : streaming
              ? noteLine ||
                (activity === "streaming"
                  ? allSettled
                    ? (finished ?? "Tools complete")
                    : "Responding…"
                  : (current ??
                    (working
                      ? "Working…"
                      : activity === "thinking"
                        ? "Thinking…"
                        : (finished ?? "Thinking…"))))
              : allTools.some((b) => b.kind === "tool" && b.status === "running")
                ? turnRunning
                  ? "Working…"
                  : "Activity stopped"
                : tools.length
                  ? "Worked"
                  : updates
                    ? "Tasks updated"
                    : turnRunning
                      ? "Working…"
                      : "Worked";
  const others = work.length - updates;
  const count = [
    tools.length
      ? `${tools.length} tool${tools.length === 1 ? "" : "s"}`
      : others || (!kids.length && !updates)
        ? `${others} step${others === 1 ? "" : "s"}`
        : null,
    updates ? `${updates} task update${updates === 1 ? "" : "s"}` : null,
    kids.length ? `${kids.length} subagent${kids.length === 1 ? "" : "s"}` : null,
    notes ? `${notes} note${notes === 1 ? "" : "s"}` : null,
  ]
    .filter(Boolean)
    .join(" · ");
  return {
    status,
    count,
    tone: failed || (kidsFailed && !kidsRunning) ? "bad" : warning ? "warn" : "muted",
    steps,
    kids,
    usage: usageBlock?.kind === "activity" ? (usageBlock.detail ?? null) : null,
  };
}

/* ── subagents ───────────────────────────────────────────────────────────── */

export const dispatchedOnly = (block: SubagentBlock): boolean => block.status === "dispatched";
export const subagentSettled = (block: SubagentBlock): boolean =>
  block.verdict === "done" || block.verdict === "failed" || block.verdict === "stopped";

export interface Glyph {
  glyph: string;
  tone: "ok" | "bad" | "run" | "idle";
  word: string;
}

export function glyphOf(block: SubagentBlock): Glyph {
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

export function firstLine(text: string | null | undefined): string {
  if (!text) return "";
  return (
    text
      .split("\n")
      .map((line) => line.trim())
      .find(Boolean) ?? ""
  );
}

const plainSummary = (summary: string | null | undefined): string =>
  (summary ?? "").replace(/\[steer did not land[^\]]*\]/g, "").trim();

export type ActivityLine =
  | { kind: "tool"; name: string; text: string }
  | { kind: "summary" | "error" | "note"; text: string }
  | { kind: "none" };

export function activityOf(block: SubagentBlock): ActivityLine {
  if (dispatchedOnly(block)) return { kind: "note", text: DISPATCHED_TEXT };
  switch (block.verdict) {
    case "running": {
      const tool = block.tools[block.tools.length - 1];
      if (tool) return { kind: "tool", name: tool.name, text: tool.preview };
      if (block.progress) return { kind: "note", text: firstLine(block.progress) };
      return { kind: "note", text: block.status === "queued" ? "queued" : "starting" };
    }
    case "done":
      return { kind: "summary", text: firstLine(plainSummary(block.summary)) };
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

export function elapsedOf(block: SubagentBlock, now: number): number | null {
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

export function timeText(block: SubagentBlock, now: number): string {
  const ms = elapsedOf(block, now);
  return block.verdict === "running" && !dispatchedOnly(block) ? clockText(ms) : spanText(ms);
}

const toolsSeen = (block: SubagentBlock): number => block.tool_count ?? block.tools.length;
const count = (n: number, one: string, many = `${one}s`): string =>
  `${n.toLocaleString("en-US")} ${n === 1 ? one : many}`;

/** `duration · tools · files · tokens · api calls`, whatever of it is known. */
export function rollupOf(block: SubagentBlock): string {
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

export function costOf(block: SubagentBlock): string | null {
  const cost = block.result?.cost_usd;
  return typeof cost === "number" ? `$${cost.toFixed(4)}` : null;
}

/** Steer and Stop are offered while the child's last known state is running. */
export const controllable = (block: SubagentBlock): boolean =>
  block.verdict === "running" && !dispatchedOnly(block) && block.origin !== "history";

export const GONE_TEXT = "subagent gone or session reset";

/** Every subagent block in a conversation, newest version, by id. */
export function subagentsIn(
  messages: readonly { blocks: readonly ChatBlock[] }[],
): Map<string, SubagentBlock> {
  const found = new Map<string, SubagentBlock>();
  for (const m of messages)
    for (const b of m.blocks) if (b.kind === "subagent") found.set(b.subagent_id, b);
  return found;
}
