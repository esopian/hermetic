/**
 * One assistant turn, one grouping.
 *
 * A history read maps one upstream row to one `ChatMessage`
 * (`packages/core/src/hermes-chat-history.ts`), so a single turn that made N
 * tool calls arrives as roughly `2N + 1` messages: the assistant row that
 * opened each call, the `role: "tool"` row that closed it — which
 * `messageRole()` maps to `system` — and the prose the model finally wrote.
 * Rendered one article per row that is a column of avatars and a column of
 * "Tools complete" summaries for what the operator experienced as one answer.
 *
 * `turnRows()` puts the turn back together before it is drawn: consecutive
 * non-user rows belonging to the same turn become one presented message whose
 * blocks are the concatenation of theirs. The live streaming message already
 * arrives as one message with all of its blocks, so a thread that is merged on
 * read looks the same during the turn as it does after it.
 *
 * Four rules keep the merge honest:
 *
 * **A row that broke ends the run.** A `ChatMessage` carrying `error` or
 * `incomplete` is the thing the operator is looking for; it stays its own row,
 * exactly as `messageRows()` already refused to let it continue a run.
 *
 * **Prose closes the run.** Durable history cannot tell the prose a model
 * emitted between two tool calls from the prose it finished with, so the rule
 * has to be one a reader can predict: a row whose blocks are prose and nothing
 * else ends the run it joined, and the next tool call opens a new turn.
 * Otherwise a bot that works on a schedule, with no operator message between
 * its turns, would accrete one article all day — and that article's id would
 * move every time. Two things are deliberately not prose: a `question` or
 * `approval` block, which only stops the turn to wait for the reader, and prose
 * that arrived on the *same* source row as tool blocks, which is the model
 * narrating a call it is making (`hermes-chat-history.ts` puts both on one row).
 * So `tool, question, tool, prose` is one turn, `tool, prose, tool, prose` is
 * two, and `[text, tool], tool, prose` is one.
 *
 * **A run belongs to one author.** A tool row names no author of its own and
 * joins whichever run it lands in, but a row that *does* name one joins only a
 * run that is unclaimed or already that author's: in a room, two bots working
 * at once must not end up under one avatar. A `system` row that carries
 * anything but run machinery is the box speaking for itself, not a turn's tool
 * work, and is a hard break.
 *
 * **The merged row is identified by its last source row.** Acks, the
 * `#message=` deep link and "scroll to the latest message" all key on the id of
 * the row that arrived last — for a durable turn that is the prose row, and for
 * a live turn it is the id `Thread` compares against `live.id` to decide the
 * turn is still streaming. Taking the first id instead would silently break all
 * three. `ids` keeps the whole run addressable for anything that needs it.
 */
import type { BlockLike, MessageLike, MessageRow } from "./chat-logic.ts";
import { dayDivider, messageRows } from "./chat-logic.ts";
import type { ChatBlockOf } from "../api/index.ts";

/** A presented row, plus the ids of the source messages folded into it. */
export interface TurnRow<M extends MessageLike = MessageLike> extends MessageRow<M> {
  /** Source message ids, in arrival order. A row that merged nothing has one. */
  ids: string[];
}

/** Blocks that belong inside a tool run rather than being addressed to the reader. */
const RUN_KINDS = new Set(["tool", "reasoning", "activity"]);

/** Blocks that stop the turn to wait for the reader. They do not end the run. */
const HOLD_KINDS = new Set(["approval", "question"]);

const broken = (m: MessageLike): boolean => !!m.error || !!m.incomplete;

/**
 * A `role: "tool"` row reaches the UI as `system` (`messageRole()`), so its
 * `authorKey()` never matches the `bot` rows either side of it. Such a row
 * carries nothing but the turn's machinery, so it joins whichever run it lands
 * in rather than starting one of its own.
 */
function runFiller(m: MessageLike): boolean {
  return (
    m.role !== "user" &&
    m.blocks.length > 0 &&
    m.blocks.every((block: BlockLike) => RUN_KINDS.has(block.kind))
  );
}

function speaker(m: MessageLike): string | null {
  return m.author ? `${m.author.bot}@${m.author.instance}` : null;
}

/** Who spoke, for merging. `null` means "joins the run", never "starts one". */
function turnAuthor(m: MessageLike): string | null {
  if (m.role === "user") return "user";
  if (runFiller(m)) return null;
  return speaker(m) ?? m.role;
}

/**
 * Whose run a row may join. A filler row that named an author may only join
 * that author's run; one that named nobody joins whatever it lands in.
 */
function runOwner(m: MessageLike): string | null {
  const author = turnAuthor(m);
  return author === null ? speaker(m) : author;
}

/** A row that is nothing but the answer: it ends the run it joined. */
function endsRun(m: MessageLike): boolean {
  if (turnAuthor(m) === null) return false;
  return (
    m.blocks.some((block: BlockLike) => !RUN_KINDS.has(block.kind) && !HOLD_KINDS.has(block.kind)) &&
    !m.blocks.some((block: BlockLike) => RUN_KINDS.has(block.kind))
  );
}

function sumUsage(messages: readonly MessageLike[]): MessageLike["usage"] {
  const all = messages.flatMap((m) => (m.usage ? [m.usage] : []));
  if (all.length === 0) return null;
  if (all.length === 1) return all[0]!;
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

/** One turn's messages as one message. The single-message case is untouched. */
function mergeTurn<M extends MessageLike>(run: readonly M[]): M {
  const first = run[0]!;
  if (run.length === 1) return first;
  const last = run[run.length - 1]!;
  // The name and the avatar come from the row that actually spoke; a tool row
  // is only the turn's machinery and names no author of its own.
  const base = run.find((m) => turnAuthor(m) !== null) ?? first;
  return {
    ...base,
    id: last.id,
    at: first.at,
    blocks: run.flatMap((m) => m.blocks),
    usage: sumUsage(run),
    error: last.error ?? null,
    incomplete: last.incomplete ?? null,
  } as M;
}

/**
 * The row the caller knows starts a turn of its own, whatever sits above it.
 *
 * The live message is the only one: it is the turn being spoken *now*, and the
 * rows above it are a turn the box already answered and wrote down. Folding it
 * upwards would put a streaming reply inside the previous answer's bubble —
 * which is the exact defect `two consecutive turns in one session` exists to
 * catch — and, during the moment a durable read and the live message overlap,
 * would draw the same tool run twice.
 */
export interface TurnOptions {
  /** Message id that may never continue the run above it. */
  breakBefore?: string | null;
}

/** The consecutive runs that make up each presented row. */
export function turnGroups<M extends MessageLike>(
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
    // A `system` row that is not pure run machinery is the box speaking for
    // itself. It neither joins a run nor lends one its author.
    const alien = !filler && message.role === "system";
    if (broken(message) || author === "user" || alien) {
      groups.push([message]);
      open = null;
      continue;
    }
    const owner = runOwner(message);
    // Prose that arrived beside tool blocks is the model narrating the call it
    // is making, so the row still counts as the turn's work.
    const work = filler || message.blocks.some((block: BlockLike) => RUN_KINDS.has(block.kind));
    const joins =
      open !== null &&
      message.id !== options.breakBefore &&
      open.day === day &&
      (owner === null || open.author === null || open.author === owner) &&
      // Prose only joins a run that has tool work in it. Two plain assistant
      // messages in a row are two answers and stay two bubbles, exactly as
      // `messageRows()` drew them; the merge exists for the rows a *single*
      // turn was split into, not for turns that merely follow one another.
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

/**
 * The transcript as presented rows: one row per turn, with `continuation` and
 * the day divider decided on the merged rows by the same rule `messageRows()`
 * has always used.
 */
export function turnRows<M extends MessageLike>(
  messages: readonly M[],
  now: number,
  options: TurnOptions = {},
): TurnRow<M>[] {
  const groups = turnGroups(messages, now, options);
  return messageRows(
    groups.map((run) => mergeTurn(run)),
    now,
  ).map((row, index) => ({ ...row, ids: groups[index]!.map((m) => m.id) }));
}

/* ── what a tool step says before it is opened ───────────────────────────── */

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

/**
 * The short target a tool row shows next to its name — the command a terminal
 * ran, the path a file tool touched, the url a web tool fetched, the query a
 * search tool asked. Nothing else: the header is visible before the step is
 * opened, and a tool this build does not recognise may take a credential as an
 * argument, so an unrecognised tool shows its name alone rather than whichever
 * of its arguments happened to be a string. An empty string means exactly that.
 * The caller renders it through `RedactedText`, because a command line is
 * exactly where a secret would be.
 */
export function toolSummary(block: ChatBlockOf<"tool">): string {
  const kind = family(block.name);
  if (kind === null) return "";
  const args = block.args;
  if (typeof args === "string") return clip(args);
  if (args === null || typeof args !== "object" || Array.isArray(args)) return "";
  const record = args as Record<string, unknown>;
  for (const key of TARGET_KEYS[kind]!) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) return clip(value);
  }
  return "";
}
