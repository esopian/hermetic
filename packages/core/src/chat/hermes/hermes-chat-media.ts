/**
 * A reply's `MEDIA:` lines that name an outbox share, as attachment chips.
 *
 * The files plugin's `transform_llm_output` hook shares each `MEDIA:/abs/path`
 * line of a final reply through hermeticd's outbox and rewrites the line to
 * `MEDIA:${FILES_OUTBOX_DIR}/<sh_…>/<name>` (`parseOutboxMediaLine`). Only a
 * line of exactly that form becomes an `attachment` block, with
 * `file_id: <share_id>` and `href: outbox/<share_id>/<name>`; every other
 * `MEDIA:` line — one the plugin refused, one inside a code fence, one naming
 * a path the box never shared — stays plain text. Nothing here reads a path:
 * the chip's bytes are fetched by id through `files.content`.
 *
 * The live stream has a wrinkle the transcript does not. Upstream streams the
 * reply *before* the hook rewrites it, so the deltas carry the original
 * `MEDIA:/abs/path` lines, and `message.complete` then carries the rewritten
 * text with `response_transformed: true` as the authoritative replacement
 * (`tui_gateway/prompt_turn.py` `_complete_turn_payload`). There is no frame
 * that replaces streamed text, so the turn holds a paragraph back from the
 * first line that is, or may still become, a line the plugin would share
 * (`mediaHead`), and settles the held tail against the authoritative text when
 * the message completes. Prose before such a line streams as it always did,
 * and so does prose that merely begins `MEDIA:`. When the authoritative text no
 * longer starts with what was already shown (another hook rewrote prose, or a
 * reasoning block split the paragraph), the held tail is still emitted — from
 * the authoritative text's matching `MEDIA:` line on, else as streamed — so a
 * head that never re-reads the transcript loses nothing.
 *
 * A chip names a share the box's outbox listing describes: its name, type,
 * size and digest come from the listing, not from the line. A listing that
 * answers without the share draws no chip at all; only a listing that failed
 * or stalled draws one undescribed.
 */
import type { AttachmentBlock, ChatBlock, FileEntry } from "../../schema/index.ts";
import {
  MEDIA_TAG,
  outboxRelPath,
  parseOutboxMediaLine,
  type OutboxMediaRef,
} from "../../shared/files.ts";

/** A run of text, or an outbox share, in the order the reply had them. */
export type MediaPiece =
  | { readonly kind: "text"; readonly text: string }
  | ({ readonly kind: "share" } & OutboxMediaRef);

/**
 * A fence line: three or more backticks or tildes, indented at most three
 * blanks, then anything. The files plugin's `_FENCE_RE`, so core and the box
 * agree on which `MEDIA:` lines sit inside a code block.
 */
const FENCE_RE = /^[ \t]{0,3}(`{3,}|~{3,})([\s\S]*)$/;

/** An open code fence: its character and how many of it opened it. */
interface Fence {
  readonly mark: string;
  readonly length: number;
}

/**
 * The fence state after `line` (no line ending), as the plugin's
 * `_fence_step` steps it: any fence line opens one; only a line of the same
 * character, at least as long, with nothing but blanks after it, closes it.
 * A fence never closed runs to the end of the text.
 */
function nextFence(fence: Fence | null, line: string): Fence | null {
  const match = FENCE_RE.exec(line);
  if (!match) return fence;
  const marks = match[1] as string;
  if (fence === null) return { mark: marks[0] as string, length: marks.length };
  const closes =
    marks[0] === fence.mark && marks.length >= fence.length && (match[2] ?? "").trim() === "";
  return closes ? null : fence;
}

/** `line` without its line ending. */
function bare(line: string): string {
  return line.replace(/\r?\n$/, "");
}

/**
 * `text` as text runs and outbox shares. An outbox line is removed with its
 * line ending; everything else, including every other `MEDIA:` line and every
 * line inside a code fence, stays in the text runs byte for byte. A share
 * named twice is kept once, where it first appeared.
 */
export function splitMedia(text: string): MediaPiece[] {
  const pieces: MediaPiece[] = [];
  const seen = new Set<string>();
  let run = "";
  let fence: Fence | null = null;
  let start = 0;
  while (start < text.length) {
    const nl = text.indexOf("\n", start);
    const end = nl < 0 ? text.length : nl + 1;
    const line = text.slice(start, end);
    start = end;
    const ref = fence === null ? parseOutboxMediaLine(bare(line)) : null;
    fence = nextFence(fence, bare(line));
    if (!ref) {
      run += line;
      continue;
    }
    if (seen.has(ref.share_id)) continue;
    seen.add(ref.share_id);
    if (run) pieces.push({ kind: "text", text: run });
    run = "";
    pieces.push({ kind: "share", share_id: ref.share_id, name: ref.name });
  }
  if (run) pieces.push({ kind: "text", text: run });
  return pieces;
}

/**
 * `pieces` past `shown`, the text a reader already has: null when the pieces'
 * text does not begin with it before the first share.
 */
function piecesAfter(pieces: readonly MediaPiece[], shown: string): MediaPiece[] | null {
  let rest = shown;
  for (let i = 0; i < pieces.length; i++) {
    if (rest === "") return pieces.slice(i);
    const piece = pieces[i] as MediaPiece;
    if (piece.kind !== "text") return null;
    if (piece.text.length <= rest.length) {
      if (!rest.startsWith(piece.text)) return null;
      rest = rest.slice(piece.text.length);
      continue;
    }
    if (!piece.text.startsWith(rest)) return null;
    return [{ kind: "text", text: piece.text.slice(rest.length) }, ...pieces.slice(i + 1)];
  }
  return rest === "" ? [] : null;
}

/** A guess from the name, for a chip the box's listing did not describe. Never an image type core would preview on its own say-so: the head fetches through `files.content`, which carries the box's sniffed type. */
const EXTENSION_MIME: Readonly<Record<string, string>> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".pdf": "application/pdf",
  ".csv": "text/csv",
  ".tsv": "text/tab-separated-values",
  ".json": "application/json",
  ".md": "text/markdown",
  ".txt": "text/plain",
  ".log": "text/plain",
  ".zip": "application/zip",
  ".gz": "application/gzip",
};

/** The mime a share's name suggests, `application/octet-stream` when it suggests none. */
export function mimeFromName(name: string): string {
  const dot = name.lastIndexOf(".");
  const ext = dot <= 0 ? "" : name.slice(dot).toLowerCase();
  return EXTENSION_MIME[ext] ?? "application/octet-stream";
}

/**
 * The chip for an outbox share. Described by the box's outbox listing when it
 * has the entry — its name (which wins over the line's), its sniffed type, its
 * size, its digest; otherwise `bytes: 0`, `sha256: null` and a type guessed
 * from the line's name, which is what the chip honestly knows.
 */
export function shareAttachment(ref: OutboxMediaRef, entry?: FileEntry | null): AttachmentBlock {
  const known = entry && entry.id === ref.share_id && entry.dir === "outbox" ? entry : null;
  const name = known?.name ?? ref.name;
  return {
    kind: "attachment",
    name,
    mime: known?.mime ?? mimeFromName(name),
    bytes: known?.bytes ?? 0,
    href: outboxRelPath(ref.share_id, name),
    file_id: ref.share_id,
    sha256: known?.sha256 ?? null,
  };
}

/**
 * The chip for a share given the box's outbox listing: described when the
 * listing has it, undescribed when there is no listing (`null`: it failed or
 * stalled), and none at all when the listing answered without it — a share
 * the box does not hold is a dead chip, and drawing nothing is safer.
 */
export function shareChip(
  ref: OutboxMediaRef,
  outbox: readonly FileEntry[] | null,
): AttachmentBlock | null {
  if (!outbox) return shareAttachment(ref);
  const entry = outbox.find((e) => e.id === ref.share_id && e.dir === "outbox");
  return entry ? shareAttachment(ref, entry) : null;
}

/**
 * A bot message's blocks with its outbox lines read out: each text block split
 * into text and one `attachment` per share, in place. A text block that held
 * nothing but shares leaves no empty text behind.
 */
export function readMediaShares(blocks: readonly ChatBlock[]): ChatBlock[] {
  const out: ChatBlock[] = [];
  for (const block of blocks) {
    if (block.kind !== "text" || !block.markdown.includes(MEDIA_TAG)) {
      out.push(block);
      continue;
    }
    for (const piece of splitMedia(block.markdown)) {
      if (piece.kind === "text") out.push({ kind: "text", markdown: piece.text });
      else out.push(shareAttachment(piece));
    }
  }
  return out;
}

/**
 * Fill share chips from one outbox listing: `null` (no listing) leaves them as
 * they are; a chip the listing does not hold is dropped (`shareChip`). Only
 * chips whose `href` is the outbox form are touched.
 */
export function describeShares<T extends { blocks: ChatBlock[] }>(
  messages: readonly T[],
  outbox: readonly FileEntry[] | null,
): T[] {
  if (!outbox) return [...messages];
  return messages.map((message) => {
    let changed = false;
    const blocks: ChatBlock[] = [];
    for (const block of message.blocks) {
      if (
        block.kind !== "attachment" ||
        !block.file_id ||
        block.href !== outboxRelPath(block.file_id, block.name)
      ) {
        blocks.push(block);
        continue;
      }
      changed = true;
      const chip = shareChip({ share_id: block.file_id, name: block.name }, outbox);
      if (chip) blocks.push(chip);
    }
    return changed ? { ...message, blocks } : message;
  });
}

/** Whether any message holds an outbox share chip. */
export function hasShares(messages: readonly { blocks: readonly ChatBlock[] }[]): boolean {
  return messages.some((m) =>
    m.blocks.some(
      (b) => b.kind === "attachment" && !!b.file_id && b.href === outboxRelPath(b.file_id, b.name),
    ),
  );
}

/* ── the live hold ────────────────────────────────────────────────────────── */

/**
 * One paragraph of streamed text — everything since the last non-text block —
 * with the part from its first `MEDIA:` line held back.
 */
export interface MediaHold {
  /** Append streamed text; the part of it that may be shown now. */
  push(text: string): string;
  /** Whether anything is being held. */
  holding(): boolean;
  /**
   * The message ended without a final (a tool call followed it): the held
   * tail as pieces, read the same way a transcript is. Forgets the message.
   */
  end(): MediaPiece[];
  /**
   * The paragraph was closed by a block inside the same message (reasoning, a
   * subagent's event): the held tail as pieces, like `end`, but the message's
   * text so far is kept, so its final settles against all of it.
   */
  cut(): MediaPiece[];
  /**
   * The message completed with `text`, its authoritative text: what remains
   * to emit past what the message already showed, every paragraph `cut` closed
   * included. If `text` no longer begins with that, the held tail matched
   * against it (`settleDiverged`). Never a share the message already drew.
   * Forgets the message.
   */
  settle(text: string): MediaPiece[];
  /** The message's text as streamed, since its last `end`, held part included. */
  raw(): string;
}

const MEDIA_HEAD = MEDIA_TAG.toLowerCase();

/** A blank the plugin's line pattern allows around the tag. */
function isBlank(ch: string | undefined): boolean {
  return ch === " " || ch === "\t";
}

/**
 * How far `line` (no line ending) matches the head of a line the files plugin
 * would share — its `_MEDIA_LINE_RE`: blanks, at most three `*`/`_`, `media:`
 * in any case, blanks, an optional quote, then `/` or `~/`. `yes` once the
 * path has begun; `maybe` while the line is a prefix that could still get
 * there; `no` once it cannot. Prose that merely begins `MEDIA:` is `no`.
 */
export function mediaHead(line: string): "yes" | "maybe" | "no" {
  const n = line.length;
  let i = 0;
  while (i < n && isBlank(line[i])) i++;
  let marks = 0;
  while (i < n && (line[i] === "*" || line[i] === "_")) {
    i++;
    marks++;
  }
  if (marks > 3) return "no";
  for (const ch of MEDIA_HEAD) {
    if (i >= n) return "maybe";
    if ((line[i] as string).toLowerCase() !== ch) return "no";
    i++;
  }
  while (i < n && isBlank(line[i])) i++;
  if (i < n && "`\"'".includes(line[i] as string)) i++;
  if (i >= n) return "maybe";
  if (line[i] === "/") return "yes";
  if (line[i] !== "~") return "no";
  if (i + 1 >= n) return "maybe";
  return line[i + 1] === "/" ? "yes" : "no";
}

/** Where each line of `text` the plugin would share begins, outside code fences. */
function mediaLineStarts(text: string): number[] {
  const starts: number[] = [];
  let fence: Fence | null = null;
  let start = 0;
  while (start < text.length) {
    const nl = text.indexOf("\n", start);
    const end = nl < 0 ? text.length : nl + 1;
    const line = bare(text.slice(start, end));
    if (fence === null && mediaHead(line) === "yes") starts.push(start);
    fence = nextFence(fence, line);
    start = end;
  }
  return starts;
}

/** `pieces` without the shares `seen` already holds. */
function unseen(pieces: readonly MediaPiece[], seen: ReadonlySet<string>): MediaPiece[] {
  return pieces.filter((p) => p.kind === "text" || !seen.has(p.share_id));
}

/**
 * The held `tail` settled against a `final` that no longer begins with what
 * was shown. The tail is the part nobody saw, and it begins at a line the
 * plugin would share (or one that might have become one), so it is matched to
 * the same number of such lines counted back from the end of `final`: from
 * there on `final` is emitted as it reads now, and any share before that point
 * — one whose original line was already let go as text — as a chip ahead of
 * it. When `final` has too few such lines to match, its shares and then the
 * tail as streamed: nothing that was held is lost, and nothing shown repeats.
 */
function settleDiverged(final: string, tail: string): MediaPiece[] {
  const held = mediaLineStarts(tail).length;
  const lines = mediaLineStarts(final);
  if (held === 0 || lines.length < held) {
    const shares = splitMedia(final).filter((p) => p.kind === "share");
    const seen = new Set(shares.map((p) => p.share_id));
    return [...shares, ...unseen(splitMedia(tail), seen)];
  }
  const cut = lines[lines.length - held] as number;
  const lead = splitMedia(final.slice(0, cut)).filter((p) => p.kind === "share");
  const seen = new Set(lead.map((p) => p.share_id));
  return [...lead, ...unseen(splitMedia(final.slice(cut)), seen)];
}

export function createMediaHold(): MediaHold {
  /** The message's text from paragraphs `cut` already closed, all of it shown. */
  let prior = "";
  /** The shares the message already drew, so a settle never draws one twice. */
  const drawn = new Set<string>();
  /** The open paragraph's text. */
  let raw = "";
  /** How much of `raw` was handed out to be shown. */
  let shown = 0;
  /** Index of the first line not yet decided, and the fence state at it. */
  let scan = 0;
  let fence: Fence | null = null;
  /** A whole `MEDIA:` line was seen at `scan`: the rest of the paragraph is held. */
  let held = false;

  function reset(): void {
    raw = "";
    shown = 0;
    scan = 0;
    fence = null;
    held = false;
  }

  function push(text: string): string {
    raw += text;
    if (!held) {
      for (;;) {
        const nl = raw.indexOf("\n", scan);
        if (nl < 0) break;
        const line = bare(raw.slice(scan, nl + 1));
        if (fence === null && mediaHead(line) === "yes") {
          held = true;
          break;
        }
        fence = nextFence(fence, line);
        scan = nl + 1;
      }
    }
    const partial = raw.slice(scan);
    const safe = held || (fence === null && mediaHead(partial) !== "no") ? scan : raw.length;
    if (safe <= shown) return "";
    const out = raw.slice(shown, safe);
    shown = safe;
    return out;
  }

  /** `pieces` less the shares already drawn; the rest are now drawn. */
  function draw(pieces: readonly MediaPiece[]): MediaPiece[] {
    const out = unseen(pieces, drawn);
    for (const p of out) if (p.kind === "share") drawn.add(p.share_id);
    return out;
  }

  function cut(): MediaPiece[] {
    const tail = raw.slice(shown);
    prior += raw;
    reset();
    return tail ? draw(splitMedia(tail)) : [];
  }

  function end(): MediaPiece[] {
    const pieces = cut();
    prior = "";
    drawn.clear();
    return pieces;
  }

  function settle(text: string): MediaPiece[] {
    const before = prior + raw.slice(0, shown);
    const tail = raw.slice(shown);
    reset();
    const pieces = draw(piecesAfter(splitMedia(text), before) ?? settleDiverged(text, tail));
    prior = "";
    drawn.clear();
    return pieces;
  }

  return {
    push,
    holding: () => shown < raw.length,
    end,
    cut,
    settle,
    raw: () => prior + raw,
  };
}

/* ── the outbox, read once per turn ───────────────────────────────────────── */

/** How long a turn waits on the outbox listing before drawing a chip undescribed. */
export const OUTBOX_LOOKUP_MS = 3000;

/** The box's outbox, by agent name: `GET /files`, outbox entries only. */
export type ListOutbox = (instance: string, signal: AbortSignal) => Promise<readonly FileEntry[]>;

/**
 * One listing per turn, read the first time a chip needs describing, bounded
 * by `OUTBOX_LOOKUP_MS` and never thrown: a failed or slow listing draws the
 * chip undescribed rather than holding the stream. `refresh` reads it again
 * and keeps the new answer — for a share made after the first read (the
 * plugin shares at the end of the reply, after a chip earlier in the turn).
 */
export function outboxOnce(
  list: ListOutbox | undefined,
  instance: string,
  signal: AbortSignal | undefined,
  timeoutMs = OUTBOX_LOOKUP_MS,
): (refresh?: boolean) => Promise<readonly FileEntry[] | null> {
  let pending: Promise<readonly FileEntry[] | null> | null = null;
  return (refresh = false) => {
    if (!list) return Promise.resolve(null);
    if (refresh) pending = null;
    pending ??= (async () => {
      const stop = new AbortController();
      const abort = () => stop.abort();
      signal?.addEventListener("abort", abort, { once: true });
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        return await Promise.race([
          list(instance, stop.signal).catch(() => null),
          new Promise<null>((resolve) => {
            timer = setTimeout(() => {
              stop.abort();
              resolve(null);
            }, timeoutMs);
          }),
        ]);
      } finally {
        if (timer !== undefined) clearTimeout(timer);
        signal?.removeEventListener("abort", abort);
      }
    })();
    return pending;
  };
}
