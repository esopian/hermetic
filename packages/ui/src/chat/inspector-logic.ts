/**
 * The stream inspector's pure half (§9.2 "Developer tools"): what a captured
 * record is called, which category it falls in, how a filter reads, how a run
 * of deltas folds, how records group into turns, what a wire payload lost on
 * its way to a frame, and where one wire message went.
 *
 * DOM-free and React-free, so every rule here is a unit test
 * (`test/inspector-logic.test.ts`) rather than something read off a render.
 *
 * Two record sources meet here. Core's capture (`TapRecordView`) holds what
 * came off the box socket (`wire`), what core handed the head (`frame`,
 * `observe`) and the socket's lifecycle (`conn`). The page's own notes
 * (`PageNote`, `state/devtools-store.ts`) hold what the page's reducer did with
 * each turn frame — the third tap point, which only the page can see.
 */
import { devtoolsFieldMap, type DevtoolsFieldFate } from "@hermetic/core/shared";
import type { TapRecordView } from "../api/types.ts";

export type TapRecord = TapRecordView;

/* ── the page's reducer notes (T3) ───────────────────────────────────────── */

/** What the page's turn reducer did with one frame. */
export type ReducerOutcome =
  | { kind: "new_block" }
  | { kind: "replaced"; version: number }
  | { kind: "appended" }
  | { kind: "applied" }
  | { kind: "failed" }
  | { kind: "dropped"; reason: "seq_lt_last" | "dup" }
  | { kind: "history" }
  /** A steer closed the live message off; its blocks now live under `message`. */
  | { kind: "segment"; from: string };

export interface PageNote {
  /** `p<n>`, unique on this page. */
  id: string;
  at: number;
  mono: number;
  /** The frame's own `type` (`delta`, `block`, `done`, `error`), or `history`. */
  type: string;
  seq: number | null;
  outcome: ReducerOutcome;
  /** The live message the frame landed on, when it landed on one. */
  message: string | null;
  /** The block's merge key, for a block frame; null for one that only appends. */
  key: string | null;
  /** The block itself, kept because the store's `mergeBlock` throws replaced ones away. */
  block?: unknown;
  /** A delta's text, so the State view can show the block it was appended to. */
  text?: string;
}

export function outcomeLabel(outcome: ReducerOutcome): string {
  switch (outcome.kind) {
    case "new_block":
      return "new block";
    case "replaced":
      return `replaced v${outcome.version}`;
    case "appended":
      return "appended";
    case "applied":
      return "applied";
    case "failed":
      return "failed";
    case "dropped":
      return outcome.reason === "dup" ? "dropped · dup" : "dropped · seq<last";
    case "history":
      return "replaced by history";
    case "segment":
      return "closed by steer";
  }
}

/* ── conversation keys ───────────────────────────────────────────────────── */

export interface ConversationRef {
  instance: string;
  bot: string;
  session: string | null;
}

export function conversationKey(c: ConversationRef): string {
  return `${c.instance}/${c.bot}/${c.session ?? ""}`;
}

export function sameConversation(a: ConversationRef | null, b: ConversationRef | null): boolean {
  return a !== null && b !== null && conversationKey(a) === conversationKey(b);
}

/* ── bounded rings ───────────────────────────────────────────────────────── */

/** `items` appended to `ring`, keeping the newest `keep`. Returns the new array and how many fell off. */
export function pushBounded<T>(
  ring: readonly T[],
  items: readonly T[],
  keep: number,
): { ring: T[]; evicted: number } {
  const next = ring.length + items.length;
  if (next <= keep) return { ring: [...ring, ...items], evicted: 0 };
  const all = [...ring, ...items];
  const evicted = all.length - keep;
  return { ring: all.slice(evicted), evicted };
}

function idNumber(id: string): number {
  const n = Number(id.slice(1));
  return Number.isFinite(n) ? n : Number.NaN;
}

/**
 * `items` folded into a ring of records kept in capture order, newest `keep`.
 *
 * A tap delivers a record again, under the same id, when its fate is settled
 * after it was first sent (a wire message whose frames came later), so a
 * record whose id the ring already holds replaces it in place rather than
 * appearing twice. Ids are `t<n>`, increasing, so the ring is sorted by them
 * and a re-delivery is found by binary search.
 */
export function upsertBounded(
  ring: readonly TapRecord[],
  items: readonly TapRecord[],
  keep: number,
): { ring: TapRecord[]; evicted: number } {
  let next: TapRecord[] | null = null;
  const fresh: TapRecord[] = [];
  for (const item of items) {
    const n = idNumber(item.id);
    const base = next ?? ring;
    const last = base.length > 0 ? idNumber(base[base.length - 1]!.id) : Number.NEGATIVE_INFINITY;
    if (Number.isNaN(n) || n > last) {
      // Usually the whole batch: new records, in order.
      const freshLast =
        fresh.length > 0 ? idNumber(fresh[fresh.length - 1]!.id) : Number.NEGATIVE_INFINITY;
      if (Number.isNaN(n) || n > freshLast) {
        fresh.push(item);
        continue;
      }
      const at = fresh.findIndex((r) => r.id === item.id);
      if (at >= 0) fresh[at] = item;
      else fresh.push(item);
      continue;
    }
    let lo = 0;
    let hi = base.length - 1;
    let found = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const m = idNumber(base[mid]!.id);
      if (m === n) {
        found = mid;
        break;
      }
      if (m < n) lo = mid + 1;
      else hi = mid - 1;
    }
    // An id older than the ring holds has already fallen off; nothing to update.
    if (found < 0) continue;
    next ??= [...ring];
    next[found] = item;
  }
  return pushBounded(next ?? ring, fresh, keep);
}

/* ── naming a record ─────────────────────────────────────────────────────── */

export const CATEGORIES = [
  "text",
  "reasoning",
  "tool",
  "approval",
  "activity",
  "usage",
  "rpc",
  "internal",
] as const;
export type Category = (typeof CATEGORIES)[number];

function obj(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** The block kind a frame record carries, if it carries a block. */
function blockKindOf(rec: TapRecord): string | null {
  const payload = obj(rec.payload);
  const block = obj(payload?.["block"]);
  const kind = block?.["kind"];
  return typeof kind === "string" ? kind : null;
}

/** Which chip a record answers to. A drop for `internal` is internal whatever its type. */
export function categoryOf(rec: TapRecord): Category {
  if (rec.fate?.kind === "drop" && rec.fate.reason === "internal") return "internal";
  const kind = rec.layer === "frame" || rec.layer === "observe" ? blockKindOf(rec) : null;
  const t = (kind ?? rec.type).toLowerCase();
  if (/approval|clarify|question/.test(t)) return "approval";
  if (/^tool|\.tool|tool_/.test(t) || t === "tool") return "tool";
  if (/thinking|reasoning/.test(t)) return "reasoning";
  if (/usage/.test(t) || t === "done" || t === "message.complete") return "usage";
  if (/^message\.|^delta$|^text$/.test(t)) return "text";
  if (/activity|status|subagent|notice/.test(t)) return "activity";
  return "rpc";
}

/** How to show a string inside a one-line summary. */
function quote(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ");
  return `"${flat.length > max ? `${flat.slice(0, max - 1)}…` : flat}"`;
}

/** One line for a block: its kind, and its name or opening words. */
export function blockSummary(value: unknown, max = 96): string {
  const block = obj(value);
  if (block === null) return "";
  const kind = typeof block["kind"] === "string" ? block["kind"] : "block";
  const name = block["name"] ?? block["tool"] ?? block["title"] ?? block["markdown"];
  return typeof name === "string"
    ? `${kind} · ${quote(name, Math.max(8, max - kind.length - 3))}`
    : kind;
}

/** One line for the list: the text a payload carries, else its JSON, cut. */
export function summarize(rec: TapRecord, max = 96): string {
  const payload = obj(rec.layer === "wire" ? wireEvent(rec) : rec.payload);
  if (payload === null) {
    if (rec.payload === null || rec.payload === undefined) return "";
    return typeof rec.payload === "string" ? quote(rec.payload, max) : String(rec.payload);
  }
  for (const field of ["text", "delta", "markdown", "content"]) {
    const value = payload[field];
    if (typeof value === "string" && value.length > 0) return quote(value, max);
  }
  if (obj(payload["block"])) return blockSummary(payload["block"], max);
  let json: string;
  try {
    json = JSON.stringify(payload) ?? "";
  } catch {
    json = String(rec.payload);
  }
  return json.length > max ? `${json.slice(0, max - 1)}…` : json;
}

/** What became of a wire message, in the badge's words. */
export function fateLabel(fate: TapRecord["fate"]): string {
  if (fate === null) return "";
  switch (fate.kind) {
    case "frames":
      return fate.count === 0 ? "no frame" : `→ ${fate.count} frame${fate.count === 1 ? "" : "s"}`;
    case "drop":
      return `dropped · ${fate.reason.replace("_", " ")}`;
    case "buffer":
      return `buffered → ${fate.into}`;
    case "none":
      return "no frame";
  }
}

/** A drop of either kind: core's adapter dropping a wire message, or the page's reducer a frame. */
export function isDropped(rec: TapRecord, note?: PageNote | null): boolean {
  return rec.fate?.kind === "drop" || note?.outcome.kind === "dropped";
}

/* ── the filter ──────────────────────────────────────────────────────────── */

export interface Filter {
  /** Inclusive seq range. */
  seq: { from: number; to: number } | null;
  /** A fate kind (`drop`, `frames`, `buffer`, `none`) or a drop reason (`internal`, `replay`). */
  fate: string | null;
  /** A substring of the record's type. */
  type: string | null;
  /** A message id: the frames that built it, and the wire messages they came from. */
  message: string | null;
  /** Everything else, lower-cased, matched against type, summary and payload. */
  text: string;
}

/** `seq:9` `seq:5-9` `fate:drop` `type:tool` `message:<id>` and free text, in any order. */
export function parseFilter(input: string): Filter {
  const filter: Filter = { seq: null, fate: null, type: null, message: null, text: "" };
  const free: string[] = [];
  for (const token of input.trim().split(/\s+/)) {
    if (token === "") continue;
    const at = token.indexOf(":");
    const name = at > 0 ? token.slice(0, at).toLowerCase() : "";
    const value = at > 0 ? token.slice(at + 1) : "";
    if (name === "seq" && value !== "") {
      const range = /^(\d+)(?:-(\d+))?$/.exec(value);
      if (range) {
        const from = Number(range[1]);
        const to = range[2] === undefined ? from : Number(range[2]);
        filter.seq = { from: Math.min(from, to), to: Math.max(from, to) };
        continue;
      }
    }
    if (name === "fate" && value !== "") {
      filter.fate = value.toLowerCase();
      continue;
    }
    if (name === "type" && value !== "") {
      filter.type = value.toLowerCase();
      continue;
    }
    if (name === "message" && value !== "") {
      filter.message = value;
      continue;
    }
    free.push(token.toLowerCase());
  }
  filter.text = free.join(" ");
  return filter;
}

export function isEmptyFilter(f: Filter): boolean {
  return f.seq === null && f.fate === null && f.type === null && f.message === null && f.text === "";
}

function payloadText(rec: TapRecord): string {
  try {
    return JSON.stringify(rec.payload) ?? "";
  } catch {
    return "";
  }
}

/**
 * The ids a `message:` filter keeps: every record whose payload names the
 * message, and the parent of each of those, so a frame brings the wire message
 * it came from with it.
 */
export function messageMatches(records: readonly TapRecord[], message: string): Set<string> {
  const keep = new Set<string>();
  for (const rec of records) {
    if (payloadText(rec).includes(message)) {
      keep.add(rec.id);
      if (rec.parent !== null) keep.add(rec.parent);
    }
  }
  return keep;
}

export function matchesFilter(rec: TapRecord, f: Filter, messageIds?: ReadonlySet<string>): boolean {
  if (f.seq !== null && (rec.seq === null || rec.seq < f.seq.from || rec.seq > f.seq.to)) return false;
  if (f.fate !== null) {
    const fate = rec.fate;
    if (fate === null) return false;
    const reason = fate.kind === "drop" ? fate.reason : fate.kind === "buffer" ? fate.into : "";
    if (fate.kind !== f.fate && reason !== f.fate) return false;
  }
  if (f.type !== null && !rec.type.toLowerCase().includes(f.type)) return false;
  if (f.message !== null && !(messageIds ?? messageMatches([rec], f.message)).has(rec.id)) return false;
  if (f.text !== "") {
    const hay = `${rec.type} ${summarize(rec, 400)} ${payloadText(rec)}`.toLowerCase();
    if (!hay.includes(f.text)) return false;
  }
  return true;
}

/* ── the list ────────────────────────────────────────────────────────────── */

export interface TurnHeader {
  index: number;
  /** What the operator asked, cut, or the type of the record that opened it. */
  title: string;
  startAt: number;
  durationMs: number;
  model: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  /** Output tokens per second, the box's own figure when it sent one. */
  tps: number | null;
  /** First thing back from the box after the prompt went out. */
  latencyMs: number | null;
  /** Every usage field the box sent, unrenamed: the headline is a few of these. */
  usage: Record<string, unknown> | null;
}

export type Row =
  | { kind: "record"; rec: TapRecord; depth: 0 | 1; note: PageNote | null }
  | {
      kind: "deltas";
      /** The first record's id, which is what selecting the row selects. */
      id: string;
      type: string;
      recs: TapRecord[];
      text: string;
      depth: 0 | 1;
      spanMs: number;
    }
  | { kind: "turn"; turn: TurnHeader };

/** A row's key and the record it stands for. */
export function rowId(row: Row): string {
  if (row.kind === "record") return row.rec.id;
  if (row.kind === "deltas") return row.id;
  return `turn:${row.turn.index}`;
}

export function isDelta(rec: TapRecord): boolean {
  return rec.type === "delta" || rec.type.endsWith(".delta") || rec.type.endsWith("_delta");
}

function deltaText(rec: TapRecord): string {
  const payload = obj(rec.layer === "wire" ? wireEvent(rec) : rec.payload);
  for (const field of ["text", "delta", "content"]) {
    const value = payload?.[field];
    if (typeof value === "string") return value;
  }
  return "";
}

/**
 * Consecutive deltas of one type, layer and direction become one row with a
 * count, the joined text and the time they spanned. A single delta stays a
 * record: there is nothing to fold.
 */
export function collapseDeltas(rows: readonly Row[]): Row[] {
  const out: Row[] = [];
  let run: Extract<Row, { kind: "record" }>[] = [];
  const flush = () => {
    if (run.length === 1) out.push(run[0]!);
    else if (run.length > 1) {
      const recs = run.map((r) => r.rec);
      const first = recs[0]!;
      const last = recs[recs.length - 1]!;
      out.push({
        kind: "deltas",
        id: first.id,
        type: first.type,
        recs,
        text: recs.map(deltaText).join(""),
        depth: run[0]!.depth,
        spanMs: Math.max(0, last.mono - first.mono),
      });
    }
    run = [];
  };
  for (const row of rows) {
    if (row.kind === "record" && isDelta(row.rec)) {
      const head = run[0];
      if (
        head !== undefined &&
        (head.rec.type !== row.rec.type ||
          head.rec.layer !== row.rec.layer ||
          head.rec.dir !== row.rec.dir ||
          head.depth !== row.depth)
      )
        flush();
      run.push(row);
      continue;
    }
    flush();
    out.push(row);
  }
  flush();
  return out;
}

const TURN_START = /^prompt\.|^prompt$|^chat\.send|^session\.prompt/;
const TURN_END = /^message\.complete$|^done$|^error$/;

function num(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** The box's usage object off a turn's closing record, whichever layer said it. */
function usageOf(rec: TapRecord): Record<string, unknown> | null {
  const payload = obj(rec.layer === "wire" ? wireEvent(rec) : rec.payload);
  return obj(payload?.["usage"]);
}

function turnHeader(index: number, records: readonly TapRecord[]): TurnHeader {
  const first = records[0]!;
  const last = records[records.length - 1]!;
  const prompt = obj(first.layer === "wire" ? wireEvent(first) : first.payload);
  const asked = prompt?.["text"] ?? prompt?.["prompt"] ?? prompt?.["message"];
  const closing = [...records].reverse().find((r) => TURN_END.test(r.type) && usageOf(r) !== null);
  const usage = closing ? usageOf(closing) : null;
  const firstBack = records.find((r) => r.dir === "in" && r.mono >= first.mono);
  const durationMs = Math.max(0, last.mono - first.mono);
  const output = num(usage?.["output"]) ?? num(usage?.["output_tokens"]) ?? num(usage?.["completion"]);
  const tps =
    num(usage?.["avg_tps"]) ??
    (output !== null && durationMs > 0 ? output / (durationMs / 1000) : null);
  const model = usage?.["model"];
  return {
    index,
    title: typeof asked === "string" ? asked.replace(/\s+/g, " ").slice(0, 80) : first.type,
    startAt: first.at,
    durationMs,
    model: typeof model === "string" ? model : null,
    inputTokens: num(usage?.["input"]) ?? num(usage?.["input_tokens"]) ?? num(usage?.["prompt"]),
    outputTokens: output,
    tps,
    latencyMs: firstBack ? Math.max(0, firstBack.mono - first.mono) : null,
    usage,
  };
}

/**
 * Turn headers in front of each turn's rows. A turn opens on a prompt going
 * out to the box; whatever came before the first one is left ungrouped.
 */
export function groupByTurn(rows: readonly Row[]): Row[] {
  const starts: number[] = [];
  rows.forEach((row, i) => {
    if (
      row.kind === "record" &&
      row.depth === 0 &&
      row.rec.dir === "out" &&
      TURN_START.test(row.rec.type)
    )
      starts.push(i);
  });
  if (starts.length === 0) return [...rows];
  const out: Row[] = rows.slice(0, starts[0]);
  starts.forEach((start, n) => {
    const end = starts[n + 1] ?? rows.length;
    const slice = rows.slice(start, end);
    const recs = slice.flatMap((row) =>
      row.kind === "record" ? [row.rec] : row.kind === "deltas" ? row.recs : [],
    );
    out.push({ kind: "turn", turn: turnHeader(n + 1, recs) }, ...slice);
  });
  return out;
}

/** Where a frame record's page note is filed: its type and seq. */
export function noteKey(type: string, seq: number | null): string {
  return `${type}:${seq ?? ""}`;
}

/** The page's notes, by the frame they are about. A later note for the same frame wins. */
export function notesByFrame(notes: readonly PageNote[]): Map<string, PageNote> {
  const map = new Map<string, PageNote>();
  for (const note of notes)
    if (note.type !== "history" && note.type !== "segment") map.set(noteKey(note.type, note.seq), note);
  return map;
}

/** The type of the frame a frame record carries (`block`, `delta`), else the record's own. */
export function frameTypeOf(rec: TapRecord): string {
  const t = obj(rec.payload)?.["type"];
  return typeof t === "string" ? t : rec.type;
}

export type Tab = "wire" | "frames" | "state" | "connection";

export interface ListOptions {
  filter: Filter;
  categories: ReadonlySet<Category>;
  collapse: boolean;
  showDropped: boolean;
  framesUnderEvents: boolean;
  byTurn: boolean;
}

/** The records a tab draws, before any filter. */
export function tabRecords(records: readonly TapRecord[], tab: Tab): TapRecord[] {
  switch (tab) {
    case "wire":
      return records.filter((r) => r.layer === "wire");
    case "frames":
      return records.filter((r) => r.layer === "frame" || r.layer === "observe");
    case "connection":
      return records.filter((r) => r.layer === "conn");
    case "state":
      return [];
  }
}

/** The rows one tab of the list draws, in order, with every toggle applied. */
export function buildRows(
  records: readonly TapRecord[],
  notes: readonly PageNote[],
  tab: Tab,
  options: ListOptions,
): Row[] {
  const byFrame = notesByFrame(notes);
  const noteFor = (rec: TapRecord): PageNote | null =>
    rec.layer === "frame" ? (byFrame.get(noteKey(frameTypeOf(rec), rec.seq)) ?? null) : null;
  const messageIds =
    options.filter.message !== null ? messageMatches(records, options.filter.message) : undefined;
  const keep = (rec: TapRecord): boolean =>
    options.categories.has(categoryOf(rec)) &&
    (options.showDropped || !isDropped(rec, noteFor(rec))) &&
    matchesFilter(rec, options.filter, messageIds);
  const top: Row[] = tabRecords(records, tab)
    .filter(keep)
    .map((rec) => ({ kind: "record" as const, rec, depth: 0 as const, note: noteFor(rec) }));
  let rows = options.collapse ? collapseDeltas(top) : top;
  if (tab === "wire" && options.framesUnderEvents) {
    const children = new Map<string, TapRecord[]>();
    for (const rec of records) {
      if (rec.layer !== "frame" || rec.parent === null) continue;
      const list = children.get(rec.parent) ?? [];
      list.push(rec);
      children.set(rec.parent, list);
    }
    // Each wire row is followed by the frames it became. Under a folded run
    // of deltas, the run's frames fold the same way: one child row, not one
    // per chunk.
    const expanded: Row[] = [];
    for (const row of rows) {
      expanded.push(row);
      const parents = row.kind === "record" ? [row.rec] : row.kind === "deltas" ? row.recs : [];
      const kids: Row[] = parents
        .flatMap((p) => children.get(p.id) ?? [])
        .filter((child) => options.showDropped || !isDropped(child, noteFor(child)))
        .map((child) => ({
          kind: "record" as const,
          rec: child,
          depth: 1 as const,
          note: noteFor(child),
        }));
      expanded.push(...(options.collapse ? collapseDeltas(kids) : kids));
    }
    rows = expanded;
  }
  if (options.byTurn) rows = groupByTurn(rows);
  return rows;
}

/* ── detail: lineage ─────────────────────────────────────────────────────── */

export interface LineageStep {
  layer: "wire" | "adapter" | "frame" | "page";
  label: string;
  detail: string;
}

/** One wire message and everything it became, or one frame and where it came from. */
export function lineage(
  rec: TapRecord,
  records: readonly TapRecord[],
  notes: readonly PageNote[],
): LineageStep[][] {
  const byFrame = notesByFrame(notes);
  const wire =
    rec.layer === "frame" && rec.parent !== null ? records.find((r) => r.id === rec.parent) : rec;
  const origin = wire ?? rec;
  const frames =
    origin.layer === "wire"
      ? records.filter((r) => r.layer === "frame" && r.parent === origin.id)
      : [rec];
  const head: LineageStep = {
    layer: "wire",
    label: `${origin.layer} · ${origin.type}`,
    detail: `seq ${origin.seq ?? "—"} · ${origin.bytes} B`,
  };
  const adapter: LineageStep = {
    layer: "adapter",
    label: "adapter",
    detail: origin.layer === "wire" ? fateLabel(origin.fate) || "—" : "—",
  };
  if (frames.length === 0 || origin.fate?.kind === "drop") return [[head, adapter]];
  return frames.map((frame) => {
    const note = byFrame.get(noteKey(frameTypeOf(frame), frame.seq)) ?? null;
    return [
      head,
      adapter,
      { layer: "frame", label: `frame · ${frameTypeOf(frame)}`, detail: `seq ${frame.seq ?? "—"}` },
      {
        layer: "page",
        label: "page",
        detail: note === null ? "not reduced on this page" : outcomeLabel(note.outcome),
      },
    ];
  });
}

/* ── detail: diff ────────────────────────────────────────────────────────── */

export interface DiffRow {
  op: DevtoolsFieldFate | "unmapped";
  /** The wire field, under the event's `payload`; null for a field the adapter made up. */
  wire: string | null;
  /** Where the field lands on the frame; null for a dropped or unmapped one. */
  frame: string | null;
  value: unknown;
  note: string | null;
}

function read(value: unknown, path: string): unknown {
  let at: unknown = value;
  for (const part of path.split(".")) {
    const o = obj(at);
    if (o === null) return undefined;
    at = o[part];
  }
  return at;
}

function leafPaths(value: unknown, prefix = "", depth = 0): string[] {
  const o = obj(value);
  if (o === null || depth > 2) return prefix === "" ? [] : [prefix];
  const out: string[] = [];
  for (const [k, v] of Object.entries(o)) {
    const p = prefix === "" ? k : `${prefix}.${k}`;
    if (obj(v) !== null && depth < 2) out.push(...leafPaths(v, p, depth + 1));
    else out.push(p);
  }
  return out;
}

/**
 * The event a wire record carries: `params.payload` on a JSON-RPC event
 * document, which is what the field map's wire paths are relative to. A
 * record that is already the bare event (one replayed inside an
 * `events.since` reply) is its own payload's parent.
 */
export function wireEvent(rec: TapRecord): unknown {
  const doc = obj(rec.payload);
  const params = obj(doc?.["params"]);
  if (params !== null && "payload" in params) return params["payload"];
  if (doc !== null && "payload" in doc) return doc["payload"];
  return params ?? rec.payload;
}

/**
 * The wire event against what the adapter keeps of it, field by field, from
 * core's field map for its type (`@hermetic/core/shared`, pinned against the
 * mappers by a core test). `*` stands for every field no other rule names. A
 * field no rule covers is listed as `unmapped` — the drift a map kept beside
 * the adapter exists to catch. Null when core does not map the type.
 */
export function fieldDiff(type: string, payload: unknown): DiffRow[] | null {
  const map = devtoolsFieldMap(type);
  if (map === undefined) return null;
  const named = map.fields.flatMap((rule) =>
    rule.wire !== null && rule.wire !== "*" ? [rule.wire] : [],
  );
  const rows: DiffRow[] = [];
  let wildcard = false;
  for (const rule of map.fields) {
    if (rule.wire === "*") {
      wildcard = true;
      const top = obj(payload);
      for (const key of Object.keys(top ?? {})) {
        if (named.some((n) => n === key || n.startsWith(`${key}.`))) continue;
        rows.push({
          op: rule.fate,
          wire: key,
          frame: rule.frame === null ? null : rule.frame.replace(/\*$/, key),
          value: top?.[key],
          note: rule.note ?? null,
        });
      }
      continue;
    }
    rows.push({
      op: rule.fate,
      wire: rule.wire,
      frame: rule.frame,
      value: rule.wire === null ? undefined : read(payload, rule.wire),
      note: rule.note ?? null,
    });
  }
  if (!wildcard) {
    const covered = (p: string) =>
      named.some((m) => p === m || p.startsWith(`${m}.`) || m.startsWith(`${p}.`));
    for (const path of leafPaths(payload))
      if (!covered(path))
        rows.push({ op: "unmapped", wire: path, frame: null, value: read(payload, path), note: null });
  }
  return rows;
}

/** A diff row's identity: a wire field appears once, a made-up field once per frame path. */
export function diffRowKey(row: DiffRow): string {
  return `${row.op}:${row.wire ?? ""}>${row.frame ?? ""}`;
}

/* ── detail: state ───────────────────────────────────────────────────────── */

export interface BlockVersion {
  version: number;
  seq: number | null;
  at: number;
  block: unknown;
}

export interface BlockHistory {
  key: string;
  kind: string;
  /** Every version the store was handed; it keeps only the last. */
  versions: BlockVersion[];
  /** The block as the store holds it now: the last version, with any deltas appended to its text. */
  current: unknown;
  /** Deltas folded into this block's text. */
  deltas: number;
}

export interface MessageState {
  message: string;
  blocks: BlockHistory[];
  /** Deltas appended to the message's text. */
  deltas: number;
  /** Set once a transcript read replaced the live message. */
  replacedByHistory: boolean;
  /**
   * Some of this message's notes fell off the bounded ring, so its blocks,
   * versions and counts are only the newest part of the story.
   */
  truncated: boolean;
}

/**
 * The conversation as the page's reducer built it: each live message, its
 * blocks and every version of each the store replaced, from the page's notes.
 * The store keeps only the newest version of a block; these are the ones it
 * threw away. A delta is folded into the last text block, creating one when
 * the turn has none yet, the way the reducer's `appendDelta` does.
 */
export function messageStates(
  notes: readonly PageNote[],
  truncated: ReadonlySet<string> = new Set(),
): MessageState[] {
  const order: string[] = [];
  const byMessage = new Map<string, MessageState>();
  const state = (id: string): MessageState => {
    let s = byMessage.get(id);
    if (s === undefined) {
      s = {
        message: id,
        blocks: [],
        deltas: 0,
        replacedByHistory: false,
        truncated: truncated.has(id),
      };
      byMessage.set(id, s);
      order.push(id);
    }
    return s;
  };
  for (const note of notes) {
    if (note.message === null || note.outcome.kind === "dropped") continue;
    if (note.outcome.kind === "segment") {
      // The part a steer closed off takes the blocks built so far; the live
      // message starts again empty under its own id.
      const from = note.outcome.from;
      const prev = byMessage.get(from);
      if (prev === undefined) continue;
      byMessage.delete(from);
      prev.message = note.message;
      prev.truncated ||= truncated.has(note.message);
      byMessage.set(note.message, prev);
      order[order.indexOf(from)] = note.message;
      continue;
    }
    const s = state(note.message);
    if (note.outcome.kind === "history") {
      s.replacedByHistory = true;
      continue;
    }
    if (note.type === "delta") {
      s.deltas += 1;
      let text = s.blocks.findLast((b) => b.kind === "text");
      if (text === undefined) {
        text = {
          key: `text#${s.blocks.length}`,
          kind: "text",
          versions: [],
          current: { kind: "text", markdown: "" },
          deltas: 0,
        };
        s.blocks.push(text);
      }
      const block = obj(text.current) ?? { kind: "text" };
      const markdown = typeof block["markdown"] === "string" ? block["markdown"] : "";
      text.current = { ...block, markdown: markdown + (note.text ?? "") };
      text.deltas += 1;
      continue;
    }
    if (note.type !== "block") continue;
    const kind = String(obj(note.block)?.["kind"] ?? "block");
    const key = note.key ?? `${kind}#${s.blocks.length}`;
    let history = s.blocks.find((b) => b.key === key);
    if (history === undefined) {
      history = { key, kind, versions: [], current: note.block, deltas: 0 };
      s.blocks.push(history);
    }
    history.versions.push({
      version: history.versions.length + 1,
      seq: note.seq,
      at: note.at,
      block: note.block,
    });
    history.current = note.block;
  }
  return order.map((id) => byMessage.get(id)!);
}

/* ── formatting ──────────────────────────────────────────────────────────── */

const CLOCK = new Intl.DateTimeFormat("en-GB", {
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hour12: false,
});

/** `10:42:03.512`, in this laptop's zone. */
export function fmtClockMs(at: number): string {
  const d = new Date(at);
  if (Number.isNaN(d.getTime())) return "—";
  return `${CLOCK.format(d)}.${String(d.getMilliseconds()).padStart(3, "0")}`;
}

/** `41:00.038`: minutes, seconds and milliseconds, for a list that never spans an hour per screen. */
export function fmtListTime(at: number): string {
  const d = new Date(at);
  if (Number.isNaN(d.getTime())) return "—";
  const mm = String(d.getMinutes()).padStart(2, "0");
  const ss = String(d.getSeconds()).padStart(2, "0");
  return `${mm}:${ss}.${String(d.getMilliseconds()).padStart(3, "0")}`;
}

const INTEGER = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });

export function fmtCount(n: number): string {
  return INTEGER.format(n);
}

export function fmtBytes(n: number): string {
  if (n < 1024) return `${INTEGER.format(n)} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

export function fmtMs(ms: number): string {
  return ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(2)}s`;
}

/** A value in a diff or detail row, as one line of JSON. */
export function fmtValue(value: unknown): string {
  if (value === undefined) return "(not sent)";
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}
