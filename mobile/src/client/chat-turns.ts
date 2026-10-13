/**
 * One assistant turn, one row; and what a tool step says before it is opened.
 *
 * Mirror of `packages/ui/src/chat/chat-turns.ts` (`turnRows`, `toolSummary`)
 * and the two helpers `components/blocks/Tool.tsx` exports (`resultText`,
 * `subjectOf`). The four merge rules — a broken row ends the run, prose closes
 * it, a run belongs to one author, the merged row is named by its last source
 * row — are explained there. Pure TypeScript.
 */
import type { ChatBlock, ChatMessage, ToolBlock } from "../protocol/types.ts";
import { dayDivider, type MessageRow, messageRows } from "./chat-logic.ts";

export interface TurnRow<M extends ChatMessage = ChatMessage> extends MessageRow<M> {
  /** Source message ids, in arrival order. */
  ids: string[];
}

const RUN_KINDS = new Set(["tool", "reasoning", "activity", "subagent"]);
const HOLD_KINDS = new Set(["approval", "question"]);

const broken = (m: ChatMessage): boolean => !!m.error || !!m.incomplete || !!m.failure;
const settledQuestion = (block: ChatBlock): boolean => block.kind === "question" && !block.request_id;

function runFiller(m: ChatMessage): boolean {
  return (
    m.role !== "user" &&
    m.blocks.length > 0 &&
    m.blocks.every((block) => RUN_KINDS.has(block.kind) || settledQuestion(block))
  );
}

const speaker = (m: ChatMessage): string | null =>
  m.author ? `${m.author.bot}@${m.author.instance}` : null;

function turnAuthor(m: ChatMessage): string | null {
  if (m.role === "user") return "user";
  if (runFiller(m)) return null;
  return speaker(m) ?? m.role;
}

function runOwner(m: ChatMessage): string | null {
  const author = turnAuthor(m);
  return author === null ? speaker(m) : author;
}

function endsRun(m: ChatMessage): boolean {
  if (turnAuthor(m) === null) return false;
  return (
    m.blocks.some((b) => !RUN_KINDS.has(b.kind) && !HOLD_KINDS.has(b.kind)) &&
    !m.blocks.some((b) => RUN_KINDS.has(b.kind))
  );
}

function sumUsage(messages: readonly ChatMessage[]): ChatMessage["usage"] {
  const all = messages.flatMap((m) => (m.usage ? [m.usage] : []));
  if (all.length === 0) return null;
  if (all.length === 1) return all[0] ?? null;
  const add = (key: "input_tokens" | "output_tokens" | "cost_usd"): number | null => {
    const values = all.flatMap((u) => (typeof u[key] === "number" ? [u[key] as number] : []));
    return values.length ? values.reduce((a, b) => a + b, 0) : null;
  };
  const model = [...all].reverse().find((u) => u.model)?.model ?? null;
  return {
    input_tokens: add("input_tokens"),
    output_tokens: add("output_tokens"),
    cost_usd: add("cost_usd"),
    model,
  };
}

function mergeTurn<M extends ChatMessage>(run: readonly M[]): M {
  const first = run[0] as M;
  if (run.length === 1) return first;
  const last = run[run.length - 1] as M;
  const base = run.find((m) => turnAuthor(m) !== null) ?? first;
  return {
    ...base,
    id: last.id,
    at: first.at,
    blocks: run.flatMap((m) => m.blocks),
    usage: sumUsage(run),
    error: last.error ?? null,
    failure: last.failure ?? null,
    incomplete: last.incomplete ?? null,
  };
}

export interface TurnOptions {
  /** Message id that may never continue the run above it (the live reply). */
  breakBefore?: string | null;
}

export function turnGroups<M extends ChatMessage>(
  messages: readonly M[],
  now: number,
  options: TurnOptions = {},
): M[][] {
  const groups: M[][] = [];
  let open: { run: M[]; author: string | null; day: string; filler: boolean } | null = null;
  for (const message of messages) {
    const day = dayDivider(message.at, now);
    const author = turnAuthor(message);
    const filler = author === null;
    const alien = !filler && message.role === "system";
    if (broken(message) || author === "user" || alien) {
      groups.push([message]);
      open = null;
      continue;
    }
    const owner = runOwner(message);
    const work = filler || message.blocks.some((b) => RUN_KINDS.has(b.kind));
    const joins =
      open !== null &&
      message.id !== options.breakBefore &&
      open.day === day &&
      (owner === null || open.author === null || open.author === owner) &&
      (filler || open.filler);
    if (joins && open) {
      open.run.push(message);
      if (open.author === null) open.author = owner;
      open.filler = open.filler || work;
      if (endsRun(message)) open = null;
    } else {
      const run = [message];
      groups.push(run);
      open = endsRun(message) ? null : { run, author: owner, day, filler: work };
    }
  }
  return groups;
}

export function turnRows<M extends ChatMessage>(
  messages: readonly M[],
  now: number,
  options: TurnOptions = {},
): TurnRow<M>[] {
  const groups = turnGroups(messages, now, options);
  return messageRows(
    groups.map((run) => mergeTurn(run)),
    now,
  ).map((row, index) => ({ ...row, ids: (groups[index] ?? []).map((m) => m.id) }));
}

/* ── what a tool step says ───────────────────────────────────────────────── */

const TARGET_KEYS: Record<string, string[]> = {
  terminal: ["command", "cmd", "script"],
  file: ["path", "file_path", "file", "filename"],
  web: ["url", "uri", "href"],
  search: ["query", "q", "search", "pattern"],
};

function family(name: string): keyof typeof TARGET_KEYS | null {
  const n = name.toLowerCase();
  if (/terminal|bash|shell|exec|command|run/.test(n)) return "terminal";
  if (/search|query/.test(n)) return "search";
  if (/read|write|edit|file|glob|grep|ls\b/.test(n)) return "file";
  if (/web|fetch|browse|http|url/.test(n)) return "web";
  return null;
}

const MAX = 72;
function clip(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > MAX ? `${flat.slice(0, MAX - 1)}…` : flat;
}

/** The short target beside a tool's name; empty for a tool this build does not recognise. */
export function toolSummary(block: ToolBlock): string {
  const kind = family(block.name);
  if (kind === null) return "";
  const args = block.args;
  if (typeof args === "string") return clip(args);
  if (args === null || typeof args !== "object" || Array.isArray(args)) return "";
  const record = args as Record<string, unknown>;
  for (const key of TARGET_KEYS[kind] ?? []) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) return clip(value);
  }
  return "";
}

/** A tool result as text: its `stdout`/`output`/`text`/`content`, else JSON. */
export function resultText(result: unknown): string {
  if (result === null || result === undefined) return "";
  if (typeof result === "string") return result;
  if (typeof result === "object") {
    const record = result as Record<string, unknown>;
    for (const field of ["stdout", "output", "text", "content"]) {
      const value = record[field];
      if (typeof value === "string") return value;
    }
  }
  try {
    return JSON.stringify(result, null, 2) ?? String(result);
  } catch {
    return String(result);
  }
}

/** The subject line a tool card shows under its head. */
export function subjectOf(args: unknown): string | null {
  if (typeof args === "string") return args;
  if (args === null || typeof args !== "object") return null;
  const record = args as Record<string, unknown>;
  for (const field of ["command", "cmd", "path", "file", "url", "query", "q"]) {
    const value = record[field];
    if (typeof value === "string" && value.length > 0) return value;
  }
  return null;
}

/** A tool result shaped as a table, or `null`. */
export function tableOf(result: unknown): { columns: string[]; rows: unknown[][] } | null {
  let columns: string[] = [];
  let rows: unknown[][] = [];
  if (Array.isArray(result) && result.length > 0 && typeof result[0] === "object" && result[0]) {
    columns = Object.keys(result[0] as Record<string, unknown>);
    rows = result.map((row) => columns.map((c) => (row as Record<string, unknown>)[c]));
  } else if (
    result &&
    typeof result === "object" &&
    Array.isArray((result as { rows?: unknown }).rows)
  ) {
    const record = result as { columns?: unknown; rows: unknown[] };
    columns = Array.isArray(record.columns) ? record.columns.map(String) : [];
    rows = record.rows.map((row) => (Array.isArray(row) ? row : [row]));
  }
  return rows.length === 0 ? null : { columns, rows };
}
