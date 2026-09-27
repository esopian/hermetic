/**
 * HuJSON — JSON with line comments, block comments and trailing commas — read
 * and edited in place, so hermetic can keep its own entries in a Tailscale
 * policy file without taking the file away from the person who owns it.
 *
 * The policy file is hand-written and usually lives in git. Its comments say
 * why a grant exists; its key order says how its author thinks about the
 * tailnet. A "parse to JSON, mutate, re-serialize" pass would silently throw
 * all of that away on the first write, so nothing here ever re-serializes the
 * document: `applyManagedBlocks` and `removeManagedBlocks` splice text into and
 * out of the exact byte ranges hermetic owns, and every other byte in the file
 * comes out the way it went in.
 *
 * What hermetic owns is a *managed block*: a contiguous run of entries inside a
 * top-level container, fenced by two marker line comments.
 *
 *     "tagOwners": {
 *       "tag:prod": ["group:ops"],          // the operator's, untouched
 *       // hermetic:managed begin
 *       "tag:hermetic": ["autogroup:admin"],
 *       // hermetic:managed end
 *     },
 *
 * A block must sit directly inside a top-level container — the value of a
 * member of the root object — and there is at most one per key. Anything else
 * (a begin without an end, a block nested two levels down) is a refusal rather
 * than a guess, because guessing here rewrites somebody's ACLs.
 *
 * Three documented ways an apply→remove round trip is not quite the identity:
 *
 *   1. Inserting a block into a container whose last entry had no trailing
 *      comma adds that comma, and removing the block does not take it back
 *      again. The comma is legal HuJSON either way and un-adding it would mean
 *      guessing whether it was ours.
 *   2. On remove, a top-level container left with *nothing* in it — no entries
 *      and no comments — is deleted along with its key. That is how a container
 *      hermetic created (`"grants": [],`) disappears again; the cost is that a
 *      container the operator wrote *already empty* also disappears. A single
 *      rule, stated here, beat a subtler one that needed to remember which
 *      empty containers were whose.
 *   3. Inserting into a container whose closing bracket shares a line with an
 *      entry (`"grants": [ {…} ],`) opens that container up onto its own lines,
 *      and removal does not close it back up. Ordinary multi-line policy files
 *      never hit this.
 *
 * A leading byte-order mark is read and written back. Tailscale's `/acl` will
 * hand one over if the operator's editor put it there, and a document hermetic
 * refused to parse — or quietly stripped a byte from — is a document it cannot
 * claim to return unchanged.
 *
 * Hand-written tokenizer and parser: core ships no runtime dependency it does
 * not need (see `tar.ts`), and the grammar is JSON plus two comment forms.
 */

import { HermeticError } from "../errors.ts";

/** The opening fence. Matched on a line comment's exact trimmed text. */
export const HERMETIC_BLOCK_BEGIN = "// hermetic:managed begin";
/** The closing fence. */
export const HERMETIC_BLOCK_END = "// hermetic:managed end";

/** One top-level container hermetic manages a block inside. */
export interface ManagedBlock {
  /** Top-level key, e.g. "tagOwners", "grants", "ssh", "acls". */
  key: string;
  /** Whether the container is a JSON object or array; used when the key must be created. */
  container: "object" | "array";
  /**
   * The block body: zero or more HuJSON entries (object members or array
   * elements), each terminated by a comma. Indentation is the caller's
   * convenience only — the body is dedented and re-indented to the container's
   * own entry indent. Internal line breaks are preserved, just shifted. An
   * empty string means "an empty block".
   */
  body: string;
}

// ---------------------------------------------------------------------------
// Tokenizer
// ---------------------------------------------------------------------------

type TokenKind = "punct" | "string" | "number" | "literal" | "line-comment" | "block-comment";

interface Token {
  kind: TokenKind;
  text: string;
  start: number;
  /** Exclusive. For a line comment this stops before the newline (and before a `\r`). */
  end: number;
}

const PUNCT = new Set(["{", "}", "[", "]", ":", ","]);
const NUMBER_RE = /-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/y;
const LITERAL_RE = /true|false|null/y;
const SIMPLE_ESCAPES = '"\\/bfnrt';

/** 1-based line/column for an offset, so a refusal can point at the byte. */
function position(text: string, offset: number): { line: number; column: number } {
  let line = 1;
  let lineStart = 0;
  const limit = Math.min(offset, text.length);
  for (let i = 0; i < limit; i += 1) {
    if (text[i] === "\n") {
      line += 1;
      lineStart = i + 1;
    }
  }
  return { line, column: offset - lineStart + 1 };
}

function fail(text: string, offset: number, message: string): never {
  const { line, column } = position(text, offset);
  throw new HermeticError("VALIDATION", `${message} at ${line}:${column}`, { line, column });
}

/** Walk a string literal from its opening quote; returns the offset just past the closing quote. */
function scanString(text: string, start: number): number {
  let i = start + 1;
  for (;;) {
    if (i >= text.length) fail(text, start, "unterminated string");
    const ch = text[i]!;
    if (ch === '"') return i + 1;
    if (ch === "\\") {
      const esc = text[i + 1];
      if (esc === undefined) fail(text, start, "unterminated string");
      if (esc === "u") {
        if (!/^[0-9a-fA-F]{4}$/.test(text.slice(i + 2, i + 6))) {
          fail(text, i, "invalid \\u escape");
        }
        i += 6;
        continue;
      }
      if (!SIMPLE_ESCAPES.includes(esc)) fail(text, i, `invalid escape "\\${esc}"`);
      i += 2;
      continue;
    }
    // A raw newline inside a string is how an unterminated quote usually shows
    // up; reporting it here points at the line that is actually wrong.
    if (ch === "\n" || ch === "\r") fail(text, start, "unterminated string");
    i += 1;
  }
}

function decodeString(raw: string): string {
  const body = raw.slice(1, -1);
  if (!body.includes("\\")) return body;
  let out = "";
  for (let i = 0; i < body.length; i += 1) {
    const ch = body[i]!;
    if (ch !== "\\") {
      out += ch;
      continue;
    }
    const esc = body[i + 1]!;
    i += 1;
    if (esc === "u") {
      out += String.fromCharCode(parseInt(body.slice(i + 1, i + 5), 16));
      i += 4;
      continue;
    }
    if (esc === "b") out += "\b";
    else if (esc === "f") out += "\f";
    else if (esc === "n") out += "\n";
    else if (esc === "r") out += "\r";
    else if (esc === "t") out += "\t";
    else out += esc; // `"`, `\`, `/`
  }
  return out;
}

/**
 * Comments are kept as tokens rather than skipped: the markers hermetic looks
 * for *are* comments, and "is this container empty enough to delete" depends on
 * whether the operator left a note inside it.
 */
function tokenize(text: string): Token[] {
  const tokens: Token[] = [];
  // A BOM is a *file* marker, not a token, and only the first one is one: a
  // U+FEFF anywhere else is a character somebody did not mean to type, and
  // silently skipping it would be the guess this module does not make. The byte
  // itself stays in `text`, so every offset below — and therefore every splice
  // — still lands where it did, and the mark survives the round trip.
  let i = text.charCodeAt(0) === 0xfeff ? 1 : 0;
  while (i < text.length) {
    const ch = text[i]!;
    if (ch === " " || ch === "\t" || ch === "\n" || ch === "\r") {
      i += 1;
      continue;
    }
    const start = i;
    if (ch === "/") {
      const next = text[i + 1];
      if (next === "/") {
        let j = i + 2;
        while (j < text.length && text[j] !== "\n") j += 1;
        let end = j;
        if (end > start && text[end - 1] === "\r") end -= 1;
        tokens.push({ kind: "line-comment", text: text.slice(start, end), start, end });
        i = j;
        continue;
      }
      if (next === "*") {
        const close = text.indexOf("*/", i + 2);
        if (close === -1) fail(text, start, "unterminated block comment");
        i = close + 2;
        tokens.push({ kind: "block-comment", text: text.slice(start, i), start, end: i });
        continue;
      }
      fail(text, start, 'unexpected "/"');
    }
    if (ch === '"') {
      i = scanString(text, start);
      tokens.push({ kind: "string", text: text.slice(start, i), start, end: i });
      continue;
    }
    if (PUNCT.has(ch)) {
      i += 1;
      tokens.push({ kind: "punct", text: ch, start, end: i });
      continue;
    }
    NUMBER_RE.lastIndex = i;
    const num = NUMBER_RE.exec(text);
    if (num && num.index === i) {
      i += num[0].length;
      tokens.push({ kind: "number", text: num[0], start, end: i });
      continue;
    }
    LITERAL_RE.lastIndex = i;
    const lit = LITERAL_RE.exec(text);
    if (lit && lit.index === i) {
      i += lit[0].length;
      tokens.push({ kind: "literal", text: lit[0], start, end: i });
      continue;
    }
    fail(text, start, `unexpected character ${JSON.stringify(ch)}`);
  }
  return tokens;
}

// ---------------------------------------------------------------------------
// Parser
// ---------------------------------------------------------------------------

interface Entry {
  /** Absent for array elements. */
  key?: string;
  /** Token index of the entry's first token (the key, or the element's first token). */
  startIdx: number;
  /** Token index of the entry's last token (the value's last token). */
  endIdx: number;
  /** Token index of the comma that terminates the entry, when it has one. */
  commaIdx?: number;
  node: Node;
}

interface Node {
  kind: "object" | "array" | "scalar";
  value: unknown;
  firstIdx: number;
  lastIdx: number;
  /** Containers only: token index of `{`/`[` and of the matching `}`/`]`. */
  openIdx: number;
  closeIdx: number;
  entries: Entry[];
}

interface Doc {
  text: string;
  tokens: Token[];
  root: Node;
}

function parseDocument(text: string): Doc {
  const tokens = tokenize(text);
  // Structure is a property of the code tokens; comments are addressed by
  // absolute index so an entry's span can be compared against a marker's.
  const code: number[] = [];
  tokens.forEach((tok, idx) => {
    if (tok.kind !== "line-comment" && tok.kind !== "block-comment") code.push(idx);
  });

  let cursor = 0;
  const at = (): number | undefined => code[cursor];
  const tokenAt = (): Token | undefined => {
    const idx = at();
    return idx === undefined ? undefined : tokens[idx];
  };
  const failHere = (message: string): never => {
    const tok = tokenAt();
    if (!tok) fail(text, text.length, "unexpected end of input");
    return fail(text, tok.start, `${message}, found ${JSON.stringify(tok.text)}`);
  };
  const expectPunct = (want: string): number => {
    const tok = tokenAt();
    if (tok?.kind !== "punct" || tok.text !== want) failHere(`expected ${JSON.stringify(want)}`);
    const idx = at()!;
    cursor += 1;
    return idx;
  };

  function scalar(value: unknown, idx: number): Node {
    return {
      kind: "scalar",
      value,
      firstIdx: idx,
      lastIdx: idx,
      openIdx: idx,
      closeIdx: idx,
      entries: [],
    };
  }

  function parseValue(): Node {
    const tok = tokenAt();
    if (!tok) fail(text, text.length, "unexpected end of input");
    const idx = at()!;
    if (tok.kind === "punct" && tok.text === "{") return parseObject();
    if (tok.kind === "punct" && tok.text === "[") return parseArray();
    cursor += 1;
    if (tok.kind === "string") return scalar(decodeString(tok.text), idx);
    if (tok.kind === "number") return scalar(Number(tok.text), idx);
    if (tok.kind === "literal") {
      return scalar(tok.text === "true" ? true : tok.text === "false" ? false : null, idx);
    }
    return fail(text, tok.start, `expected a value, found ${JSON.stringify(tok.text)}`);
  }

  function parseObject(): Node {
    const openIdx = expectPunct("{");
    const entries: Entry[] = [];
    const value: Record<string, unknown> = {};
    for (;;) {
      const tok = tokenAt();
      if (!tok) fail(text, text.length, "unterminated object");
      if (tok.kind === "punct" && tok.text === "}") {
        const closeIdx = at()!;
        cursor += 1;
        return {
          kind: "object",
          value,
          firstIdx: openIdx,
          lastIdx: closeIdx,
          openIdx,
          closeIdx,
          entries,
        };
      }
      if (tok.kind !== "string") failHere("expected an object key");
      const keyIdx = at()!;
      const key = decodeString(tok.text);
      cursor += 1;
      expectPunct(":");
      const node = parseValue();
      const entry: Entry = { key, startIdx: keyIdx, endIdx: node.lastIdx, node };
      entries.push(entry);
      value[key] = node.value;
      const after = tokenAt();
      if (!after) fail(text, text.length, "unterminated object");
      if (after.kind === "punct" && after.text === ",") {
        entry.commaIdx = at()!;
        cursor += 1;
        continue;
      }
      if (after.kind === "punct" && after.text === "}") continue; // trailing comma omitted
      failHere('expected "," or "}"');
    }
  }

  function parseArray(): Node {
    const openIdx = expectPunct("[");
    const entries: Entry[] = [];
    const value: unknown[] = [];
    for (;;) {
      const tok = tokenAt();
      if (!tok) fail(text, text.length, "unterminated array");
      if (tok.kind === "punct" && tok.text === "]") {
        const closeIdx = at()!;
        cursor += 1;
        return {
          kind: "array",
          value,
          firstIdx: openIdx,
          lastIdx: closeIdx,
          openIdx,
          closeIdx,
          entries,
        };
      }
      const node = parseValue();
      const entry: Entry = { startIdx: node.firstIdx, endIdx: node.lastIdx, node };
      entries.push(entry);
      value.push(node.value);
      const after = tokenAt();
      if (!after) fail(text, text.length, "unterminated array");
      if (after.kind === "punct" && after.text === ",") {
        entry.commaIdx = at()!;
        cursor += 1;
        continue;
      }
      if (after.kind === "punct" && after.text === "]") continue; // trailing comma omitted
      failHere('expected "," or "]"');
    }
  }

  const root = parseValue();
  const trailing = tokenAt();
  if (trailing)
    fail(text, trailing.start, `unexpected ${JSON.stringify(trailing.text)} after the document`);
  return { text, tokens, root };
}

/**
 * Tolerant parse of HuJSON into plain JSON values: comments and trailing commas
 * are dropped, duplicate keys resolve last-wins as `JSON.parse` does. Throws
 * `HermeticError("VALIDATION", …)` naming line:column on malformed input.
 */
export function parseHujson(text: string): unknown {
  return parseDocument(text).root.value;
}

// ---------------------------------------------------------------------------
// Text geometry
// ---------------------------------------------------------------------------

function lineStartOf(text: string, offset: number): number {
  const nl = text.lastIndexOf("\n", offset - 1);
  return nl === -1 ? 0 : nl + 1;
}

/** True when nothing but whitespace precedes `offset` on its line. */
function onlyBlankBefore(text: string, offset: number): boolean {
  return /^[ \t]*$/.test(text.slice(lineStartOf(text, offset), offset));
}

/** The leading whitespace of the line `offset` sits on. */
function indentAt(text: string, offset: number): string {
  const slice = text.slice(lineStartOf(text, offset), offset);
  return /^[ \t]*/.exec(slice)?.[0] ?? "";
}

function eolLengthAt(text: string, offset: number): number {
  if (text.startsWith("\r\n", offset)) return 2;
  if (text[offset] === "\n") return 1;
  return 0;
}

/** Move `start` back over the newline before it, for deleting the file's last line. */
function backOverEol(text: string, start: number): number {
  if (start >= 2 && text.startsWith("\r\n", start - 2)) return start - 2;
  if (start >= 1 && text[start - 1] === "\n") return start - 1;
  return start;
}

/** Whatever the file already uses; hermetic's own lines follow it. */
function detectEol(text: string): string {
  return text.includes("\r\n") ? "\r\n" : "\n";
}

/** One level of indentation, in the file's own currency. */
function detectUnit(text: string): string {
  return /^\t+/m.test(text) ? "\t" : "  ";
}

/** Split, drop blank lines top and bottom, strip the common leading whitespace. */
function bodyLines(body: string): string[] {
  const lines = body.split(/\r\n|\n|\r/);
  while (lines.length > 0 && lines[0]!.trim() === "") lines.shift();
  while (lines.length > 0 && lines[lines.length - 1]!.trim() === "") lines.pop();
  let common: string | undefined;
  for (const line of lines) {
    if (line.trim() === "") continue;
    const lead = /^[ \t]*/.exec(line)![0];
    if (common === undefined) {
      common = lead;
      continue;
    }
    let i = 0;
    while (i < common.length && i < lead.length && common[i] === lead[i]) i += 1;
    common = common.slice(0, i);
  }
  const prefix = common ?? "";
  return lines.map((line) => (line.trim() === "" ? "" : line.slice(prefix.length)));
}

function renderBlock(indent: string, body: string, eol: string): string {
  const parts = [indent + HERMETIC_BLOCK_BEGIN];
  for (const line of bodyLines(body)) parts.push(line === "" ? "" : indent + line);
  parts.push(indent + HERMETIC_BLOCK_END);
  return parts.join(eol);
}

// ---------------------------------------------------------------------------
// Locating hermetic's blocks
// ---------------------------------------------------------------------------

interface Block {
  key: string;
  container: Node;
  /** Start of the replaceable region: the begin marker's line, or the marker itself. */
  start: number;
  /** End of the replaceable region: just past the end marker. */
  end: number;
  /** The indent the markers already sit at — reused so a body edit does not move them. */
  indent: string;
  bodyStart: number;
  bodyEnd: number;
}

function isBeginMarker(tok: Token): boolean {
  return tok.kind === "line-comment" && tok.text.trimEnd() === HERMETIC_BLOCK_BEGIN;
}

function isEndMarker(tok: Token): boolean {
  return tok.kind === "line-comment" && tok.text.trimEnd() === HERMETIC_BLOCK_END;
}

/** The innermost container whose brackets bracket `idx`, or undefined. */
function innermostContainer(node: Node, idx: number): Node | undefined {
  if (node.kind === "scalar") return undefined;
  if (!(node.openIdx < idx && idx < node.closeIdx)) return undefined;
  for (const entry of node.entries) {
    const inner = innermostContainer(entry.node, idx);
    if (inner) return inner;
  }
  return node;
}

/** The root member whose value is this container, if it is a top-level one. */
function topLevelKeyOf(root: Node, container: Node): string | undefined {
  for (const entry of root.entries) {
    if (entry.node === container) return entry.key;
  }
  return undefined;
}

function requireObjectRoot(doc: Doc): Node {
  if (doc.root.kind !== "object") {
    fail(doc.text, doc.tokens[doc.root.firstIdx]?.start ?? 0, "the policy root must be a JSON object");
  }
  return doc.root;
}

/**
 * Every top-level key that appears more than once.
 *
 * This is the one duplicate that matters. Tailscale resolves a repeated key
 * last-wins, and `applyOne` splices into the *first* member it finds — so a
 * policy with two `"acls"` keys would take hermetic's write into a container
 * nothing reads, and `policy.status` would then report `current` for a rule
 * that reaches no node. Refusing is the only honest answer: hermetic cannot
 * pick which of the operator's two containers was meant without guessing, and
 * guessing here rewrites somebody's ACLs.
 */
function duplicateTopLevelKeys(root: Node): Set<string> {
  const seen = new Set<string>();
  const duplicated = new Set<string>();
  for (const entry of root.entries) {
    if (entry.key === undefined) continue;
    if (seen.has(entry.key)) duplicated.add(entry.key);
    seen.add(entry.key);
  }
  return duplicated;
}

function refuseDuplicate(key: string): never {
  throw new HermeticError(
    "VALIDATION",
    `top-level key ${JSON.stringify(key)} appears twice; fix the policy file first`,
    { key },
  );
}

/** Refuse before touching a key the caller is about to read, write or remove. */
function assertNotDuplicated(doc: Doc, keys: readonly string[]): void {
  const duplicated = duplicateTopLevelKeys(requireObjectRoot(doc));
  for (const key of keys) {
    if (duplicated.has(key)) refuseDuplicate(key);
  }
}

/**
 * Marker pairs, validated. A block that is unpaired, nested inside another
 * block, cutting an entry in half, or sitting anywhere but directly inside a
 * top-level container is a refusal — those are the shapes where "fix it up
 * anyway" would rewrite bytes hermetic does not own. So is a block that landed
 * in a duplicated top-level key, where the write it came from was inert.
 */
function locateBlocks(doc: Doc): Map<string, Block> {
  const { text, tokens } = doc;
  const root = requireObjectRoot(doc);
  const duplicated = duplicateTopLevelKeys(root);
  const blocks = new Map<string, Block>();
  let openIdx: number | undefined;

  for (let idx = 0; idx < tokens.length; idx += 1) {
    const tok = tokens[idx]!;
    if (isBeginMarker(tok)) {
      if (openIdx !== undefined) {
        fail(text, tok.start, "hermetic:managed begin inside another hermetic block");
      }
      openIdx = idx;
      continue;
    }
    if (!isEndMarker(tok)) continue;
    if (openIdx === undefined) fail(text, tok.start, "hermetic:managed end without a begin");

    const beginTok = tokens[openIdx]!;
    const beginOwner = innermostContainer(root, openIdx);
    const endOwner = innermostContainer(root, idx);
    if (!beginOwner || beginOwner !== endOwner) {
      fail(text, beginTok.start, "a hermetic block must begin and end inside the same container");
    }
    const key = topLevelKeyOf(root, beginOwner);
    if (key === undefined) {
      fail(text, beginTok.start, "a hermetic block must sit directly inside a top-level container");
    }
    if (blocks.has(key)) {
      fail(text, beginTok.start, `more than one hermetic block in ${JSON.stringify(key)}`);
    }
    if (duplicated.has(key)) refuseDuplicate(key);
    for (const entry of beginOwner.entries) {
      const spanEnd = entry.commaIdx ?? entry.endIdx;
      for (const marker of [openIdx, idx]) {
        if (entry.startIdx < marker && marker < spanEnd) {
          fail(text, tokens[marker]!.start, "a hermetic marker must not sit inside an entry");
        }
      }
    }

    const beginOwnLine = onlyBlankBefore(text, beginTok.start);
    const endOwnLine = onlyBlankBefore(text, tok.start);
    const afterBegin = beginTok.end + eolLengthAt(text, beginTok.end);
    blocks.set(key, {
      key,
      container: beginOwner,
      start: beginOwnLine ? lineStartOf(text, beginTok.start) : beginTok.start,
      end: tok.end,
      indent: beginOwnLine ? indentAt(text, beginTok.start) : "",
      bodyStart: afterBegin,
      bodyEnd: Math.max(afterBegin, endOwnLine ? lineStartOf(text, tok.start) : tok.start),
    });
    openIdx = undefined;
  }

  if (openIdx !== undefined) {
    fail(text, tokens[openIdx]!.start, "hermetic:managed begin without an end");
  }
  return blocks;
}

/**
 * The current body of each hermetic block, keyed by top-level key: the text
 * between the markers with the container's indentation removed. Keys with no
 * block are absent. Throws VALIDATION on an unpaired marker, a block outside a
 * top-level container, or a root that is not an object.
 */
export function readManagedBlocks(text: string): Record<string, string> {
  const doc = parseDocument(text);
  const out: Record<string, string> = {};
  for (const [key, block] of locateBlocks(doc)) {
    out[key] = bodyLines(text.slice(block.bodyStart, block.bodyEnd)).join("\n");
  }
  return out;
}

/** Where one of hermetic's blocks sits: markers included, body between them. */
export interface ManagedBlockRange {
  key: string;
  /** Byte offset of the begin marker's line (or the marker, when it shares one). */
  start: number;
  /** Byte offset just past the end marker. */
  end: number;
}

/**
 * The byte range of each block hermetic owns. Exported because it is the only
 * honest way to describe a change to the operator: `policy.ts` diffs *these*
 * ranges rather than the whole document, so a report of what hermetic would
 * write cannot carry three lines of somebody's `groups` along with it (§8.3).
 */
export function locateManagedBlocks(text: string): ManagedBlockRange[] {
  return [...locateBlocks(parseDocument(text)).values()].map(({ key, start, end }) => ({
    key,
    start,
    end,
  }));
}

/** One member of a top-level object container, and whether hermetic owns it. */
export interface TopLevelMember {
  key: string;
  /** Byte offset of the member's key token. */
  start: number;
  /** Byte offset just past the member's value. */
  end: number;
  /** True when the member lies inside hermetic's managed block for this key. */
  inManagedBlock: boolean;
}

/**
 * The members of one top-level object, addressed structurally.
 *
 * The question this answers — "does anything *outside* hermetic's block already
 * own `tag:hermetic`?" — used to be asked of the raw text, which got it wrong
 * in both directions: a `//` inside a string looked like a comment, and an
 * entry commented out with a block comment still counted as owned. The parser
 * already knows where every member begins and ends, so it answers instead.
 *
 * An absent key, or a key whose value is not an object, has no members.
 */
export function topLevelMembers(text: string, key: string): TopLevelMember[] {
  const doc = parseDocument(text);
  const root = requireObjectRoot(doc);
  assertNotDuplicated(doc, [key]);
  const member = root.entries.find((entry) => entry.key === key);
  if (member?.node.kind !== "object") return [];
  const block = locateBlocks(doc).get(key);
  return member.node.entries.map((entry): TopLevelMember => {
    const start = doc.tokens[entry.startIdx]!.start;
    const end = doc.tokens[entry.endIdx]!.end;
    return {
      key: entry.key ?? "",
      start,
      end,
      inManagedBlock: block !== undefined && block.start <= start && end <= block.end,
    };
  });
}

// ---------------------------------------------------------------------------
// Apply
// ---------------------------------------------------------------------------

/** Where a fresh block's lines should start, read off whatever the container already does. */
function containerEntryIndent(doc: Doc, container: Node, unit: string): string {
  const { text, tokens } = doc;
  const openTok = tokens[container.openIdx]!;
  const containerIndent = indentAt(text, openTok.start);
  const first = container.entries[0];
  if (first) {
    const firstTok = tokens[first.startIdx]!;
    // An entry sharing the open bracket's line tells us nothing about depth.
    if (lineStartOf(text, firstTok.start) !== lineStartOf(text, openTok.start)) {
      return indentAt(text, firstTok.start);
    }
  }
  return containerIndent + unit;
}

/** Splice text in at one or two ascending offsets. */
function splice(text: string, edits: readonly { at: number; insert: string }[]): string {
  let out = "";
  let cut = 0;
  for (const edit of edits) {
    out += text.slice(cut, edit.at) + edit.insert;
    cut = edit.at;
  }
  return out + text.slice(cut);
}

/**
 * The comma a container's last entry needs before anything can follow it. Placed
 * at the value's last token, which is before any trailing comment on that line.
 */
function commaEdit(doc: Doc, container: Node): { at: number; insert: string }[] {
  const last = container.entries[container.entries.length - 1];
  if (!last || last.commaIdx !== undefined) return [];
  return [{ at: doc.tokens[last.endIdx]!.end, insert: "," }];
}

/** Insert `piece` just before a container's closing bracket, on its own lines. */
function insertBeforeClose(
  doc: Doc,
  container: Node,
  piece: string,
  eol: string,
): { at: number; insert: string } {
  const { text, tokens } = doc;
  const closeStart = tokens[container.closeIdx]!.start;
  if (onlyBlankBefore(text, closeStart)) {
    return { at: lineStartOf(text, closeStart), insert: piece + eol };
  }
  // `[]` or `[ … ]` on one line: open the container up rather than inline the block.
  const containerIndent = indentAt(text, tokens[container.openIdx]!.start);
  return { at: closeStart, insert: eol + piece + eol + containerIndent };
}

function applyOne(text: string, block: ManagedBlock): string {
  const eol = detectEol(text);
  const unit = detectUnit(text);
  const doc = parseDocument(text);
  const root = requireObjectRoot(doc);
  // Before anything is spliced: a write into the first of two `"acls"` keys is
  // a write Tailscale never reads (see `duplicateTopLevelKeys`).
  assertNotDuplicated(doc, [block.key]);
  const existing = locateBlocks(doc).get(block.key);

  if (existing) {
    if (existing.container.kind !== block.container) {
      throw new HermeticError(
        "VALIDATION",
        `${JSON.stringify(block.key)} is a JSON ${existing.container.kind}, not a ${block.container}`,
        { key: block.key },
      );
    }
    const rendered = renderBlock(existing.indent, block.body, eol);
    if (text.slice(existing.start, existing.end) === rendered) return text;
    return text.slice(0, existing.start) + rendered + text.slice(existing.end);
  }

  const member = root.entries.find((entry) => entry.key === block.key);
  if (member) {
    const container = member.node;
    if (container.kind !== block.container) {
      throw new HermeticError(
        "VALIDATION",
        `${JSON.stringify(block.key)} is a JSON ${container.kind === "scalar" ? "scalar" : container.kind}, not a ${block.container}`,
        { key: block.key },
      );
    }
    const indent = containerEntryIndent(doc, container, unit);
    const piece = renderBlock(indent, block.body, eol);
    return splice(text, [...commaEdit(doc, container), insertBeforeClose(doc, container, piece, eol)]);
  }

  // The key is missing entirely: create it at the end of the root object.
  const rootIndent = root.entries[0]
    ? indentAt(doc.text, doc.tokens[root.entries[0]!.startIdx]!.start)
    : indentAt(doc.text, doc.tokens[root.openIdx]!.start) + unit;
  const [open, close] = block.container === "object" ? ["{", "}"] : ["[", "]"];
  const piece = [
    `${rootIndent}${JSON.stringify(block.key)}: ${open}`,
    renderBlock(rootIndent + unit, block.body, eol),
    `${rootIndent}${close},`,
  ].join(eol);
  return splice(text, [...commaEdit(doc, root), insertBeforeClose(doc, root, piece, eol)]);
}

/**
 * Upsert blocks. An existing block's body is replaced in place; a missing one is
 * inserted at the end of its container (adding the trailing comma the previous
 * last entry needs); a missing top-level key is created as `{}`/`[]` at the end
 * of the root object. Every byte outside the touched blocks — and outside those
 * two additions — is identical. `changed` is false when the file already said
 * exactly this, which makes a second call a no-op.
 */
export function applyManagedBlocks(
  text: string,
  blocks: readonly ManagedBlock[],
): { text: string; changed: boolean } {
  let next = text;
  for (const block of blocks) next = applyOne(next, block);
  return { text: next, changed: next !== text };
}

// ---------------------------------------------------------------------------
// Remove
// ---------------------------------------------------------------------------

/** Extend a deletion over the rest of its line, when only whitespace is left on it. */
function cutLine(text: string, start: number, end: number): { start: number; end: number } {
  let j = end;
  while (text[j] === " " || text[j] === "\t") j += 1;
  const eol = eolLengthAt(text, j);
  if (eol > 0) return { start, end: j + eol };
  return { start: backOverEol(text, start), end: j };
}

/** No entries and no comments — nothing of the operator's is in here. */
function containerIsBare(doc: Doc, container: Node): boolean {
  if (container.entries.length > 0) return false;
  for (let idx = container.openIdx + 1; idx < container.closeIdx; idx += 1) {
    const kind = doc.tokens[idx]!.kind;
    if (kind === "line-comment" || kind === "block-comment") return false;
  }
  return true;
}

function removeOne(text: string, key: string): string {
  const doc = parseDocument(text);
  assertNotDuplicated(doc, [key]);
  const block = locateBlocks(doc).get(key);
  if (!block) return text;
  const cut = cutLine(text, block.start, block.end);
  const stripped = text.slice(0, cut.start) + text.slice(cut.end);

  // The container may now be empty; if nothing of the operator's is left in it,
  // the key goes too (see the module header's second documented deviation).
  const after = parseDocument(stripped);
  const member = after.root.entries.find((entry) => entry.key === key);
  if (!member || member.node.kind === "scalar" || !containerIsBare(after, member.node)) return stripped;
  const memberStart = after.tokens[member.startIdx]!.start;
  const memberEnd = after.tokens[member.commaIdx ?? member.endIdx]!.end;
  const memberCut = cutLine(
    stripped,
    onlyBlankBefore(stripped, memberStart) ? lineStartOf(stripped, memberStart) : memberStart,
    memberEnd,
  );
  return stripped.slice(0, memberCut.start) + stripped.slice(memberCut.end);
}

/**
 * Remove hermetic's blocks — markers and body — for the given keys. The
 * container survives unless the block was the only thing in it (no other
 * entries, no comments), in which case the whole `"key": [],` member goes with
 * it. `changed` is false when there was nothing there.
 */
export function removeManagedBlocks(
  text: string,
  keys: readonly string[],
): { text: string; changed: boolean } {
  let next = text;
  for (const key of keys) next = removeOne(next, key);
  return { text: next, changed: next !== text };
}
