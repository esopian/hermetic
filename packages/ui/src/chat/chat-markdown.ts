/**
 * The markdown a transcript actually contains, parsed to nodes (§9.2).
 *
 * Split out of `chat-logic.ts`, which re-exports every name here so its
 * importers did not have to move. The parser is pure and DOM-free like the
 * rest of the chat rules: it reads a `text` block's prose and produces nodes,
 * and `components/chat/blocks/Text.tsx` turns nodes into elements. Nothing in
 * here knows what a message or a bot is.
 */

/**
 * A deliberately small markdown reader, and the reason it is hand-written.
 *
 * `packages/ui` has no markdown dependency and this is not the change that
 * should add one. What arrives in a `text` block is prose a language model
 * produced: paragraphs, fenced code, lists, headings, a blockquote, and inline
 * emphasis, code, links and citation markers. That is the whole grammar, it is
 * stable, and a parser for it is fifty lines.
 *
 * The other half of the reason is safety. A markdown renderer that reaches for
 * `dangerouslySetInnerHTML` is a renderer that will put model-authored HTML
 * into this document the first time a model writes some. This one produces
 * *nodes*, and `Text.tsx` turns nodes into elements — so there is no path from
 * a transcript to raw HTML, and no rule anybody has to remember not to break.
 */
export type MdSpan =
  | { type: "text"; text: string }
  | { type: "code"; text: string }
  /**
   * TeX a model wrote, kept as its source.
   *
   * Upstream Desktop hands `$…$` to KaTeX. This renderer has no KaTeX and is
   * not going to grow one for a fleet console: what an operator needs is to
   * see that the run *is* an expression and to read the symbols in it, which a
   * distinctly styled monospace span gives without a 300 KB font payload. The
   * node carries the source, so a renderer that does typeset one day needs no
   * parser change.
   */
  | { type: "math"; text: string }
  /**
   * `strong`, `em` and `link` carry `text` (their literal contents) and, when
   * that content held markup of its own, `spans` — the same content parsed.
   *
   * The optional half is not laziness. A renderer reads `spans` when it is
   * there and `text` when it is not, so a bold run with nothing inside it is
   * exactly the node it has always been, and nesting costs a field only on the
   * spans that actually nest.
   */
  | { type: "strong"; text: string; spans?: MdSpan[] }
  | { type: "em"; text: string; spans?: MdSpan[] }
  /**
   * GFM's `~~struck~~`. It carries `spans` on the same terms as `strong` and
   * `em`, because a model striking a sentence strikes the markup in it too.
   */
  | { type: "del"; text: string; spans?: MdSpan[] }
  | { type: "link"; text: string; href: string; spans?: MdSpan[] }
  | { type: "cite"; n: string }
  /**
   * A single newline inside a paragraph, kept rather than collapsed.
   *
   * CommonMark folds a lone `\n` into a space; every chat renderer worth using
   * (upstream's own included) turns on `breaks` instead, because a model that
   * writes "1\n2\n3" means three lines and the operator reads one run-on line
   * otherwise. A blank line still ends the paragraph — this is the *soft* break
   * only, and it carries no text of its own.
   */
  | { type: "br" };

/** A GFM delimiter row's `:---` / `:---:` / `---:`; `null` is "unstated". */
export type MdAlign = "left" | "center" | "right" | null;

/**
 * One item of a list. `checked` is `null` for an ordinary bullet and a boolean
 * for a GFM task item, which is the distinction the renderer needs: `null`
 * draws no box at all, `false` draws an empty one.
 */
export type MdItem = {
  spans: MdSpan[];
  checked: boolean | null;
  /**
   * The lists an item's own indented children formed, if it had any.
   *
   * A sublist hangs off the *item* rather than sitting beside it, because that
   * is where HTML puts it: a `<ul>` inside the `<li>` it belongs to. An item
   * with no children keeps exactly the shape it had before nesting existed.
   *
   * It is a list of lists because a child run may change kind mid-way — a
   * bullet under a bullet, then a numbered item at the same indent — and that
   * is two lists at one depth, exactly as it is at the top level.
   */
  lists?: MdList[];
};

export type MdList = { type: "list"; ordered: boolean; items: MdItem[] };

export type MdNode =
  | { type: "p"; spans: MdSpan[] }
  | { type: "h"; level: number; spans: MdSpan[] }
  | MdList
  | { type: "quote"; spans: MdSpan[] }
  | { type: "code"; lang: string | null; text: string }
  | { type: "table"; align: MdAlign[]; header: MdSpan[][]; rows: MdSpan[][][] }
  | { type: "hr" }
  | { type: "math"; text: string };

/**
 * One line of prose as spans. The alternation is ordered by specificity: code
 * first, because backticks suspend every other rule inside them, and the
 * citation marker before the link it otherwise looks like. Underscores only
 * delimit emphasis at word boundaries, with no whitespace just inside either
 * delimiter. Identifiers such as LIVE_CHAT_AFTER_ABORT are literal text, not
 * emphasis instructions; removing their separators changes the agent's answer.
 */
const WORD = "\\p{L}\\p{N}\\p{M}_";
const INLINE = new RegExp(
  [
    // Code is first so that a construct *starting at the same character* loses
    // to it: `` `**a**` `` is a code span. That is all alternation order buys.
    // A rule that opens earlier in the line still wins, so a delimiter pair
    // straddling a code span — ``~~a `b~~c` d~~``, `**a `b**c` d**` — eats the
    // backticks. CommonMark resolves that by scanning code spans out of the
    // line first; this parser does not, and the cure (banning backticks inside
    // a run) would break `~~drop `this` too~~`, which models actually write.
    "(?<code>`[^`]+`)",
    "(?<cite>\\[\\^(?<citeN>[^\\]]+)\\])",
    "(?<link>\\[(?<linkText>[^\\]]*)\\]\\((?<href>[^)\\s]+)\\))",
    "(?<del>~~(?!\\s)[\\s\\S]+?(?<!\\s)~~)",
    // Three delimiters before two, two before one: `***a***` read as a strong
    // run starting `*a*` is exactly the literal-asterisk bug.
    "(?<tri>\\*\\*\\*(?!\\s)[\\s\\S]+?(?<!\\s)\\*\\*\\*)",
    "(?<triU>(?<![" + WORD + "])___(?!\\s)[\\s\\S]+?(?<!\\s)___(?![" + WORD + "]))",
    // A strong run may hold lone asterisks (`**a *b* c**`) and an emphasis run
    // may hold whole `**…**` pairs (`*a **b** c*`). Both alternations are
    // disjoint on their first character, so neither can backtrack quadratically
    // over a paragraph a model wrote.
    //
    // Every run's body is `+?`, never `*?`: an empty run is not emphasis, it is
    // two delimiters that happened to meet. `2 ** 8` and `x**y` are arithmetic
    // and an identifier, and a rule that matched nothing between them deleted
    // the asterisks a model wrote. The emphasis opener also refuses to start
    // straight after another asterisk, which is what keeps a glob (`**/*.ts`)
    // whole rather than reading `*/*` out of the middle of it.
    "(?<strong>\\*\\*(?!\\s)(?:[^*]|\\*(?!\\*))+?(?<!\\s)\\*\\*)",
    "(?<em>(?<!\\*)\\*(?!\\s)(?:[^*]|\\*\\*)+?(?<!\\s)\\*(?!\\*))",
    "(?<emU>(?<![" + WORD + "])_(?![_\\s])[^_]*[^_\\s]_(?![" + WORD + "]))",
    "(?<math>\\$(?![\\s$])[^$\\n]*[^\\s$]\\$(?!\\d))",
  ].join("|"),
  "gu",
);

/**
 * The contents of an emphasis run or a link's label, parsed as spans — or
 * `undefined` when there was no markup in there to find.
 *
 * Returning `undefined` for plain content is what keeps `**ember**` the flat
 * node it was before nesting existed. The recursion terminates because every
 * delimiter pair is stripped before the content is handed back down, so each
 * level is strictly shorter than the one above it.
 */
function nested(text: string): MdSpan[] | undefined {
  if (text === "") return undefined;
  const spans = parseInline(text);
  if (spans.length === 1 && spans[0]?.type === "text") return undefined;
  return spans;
}

/**
 * The scan is *global with an explicit index* rather than "match, slice the
 * tail, match again", and the difference is not style.
 *
 * Re-slicing restarts the regex engine at character zero of what is left, so a
 * line with n spans in it is rescanned n times: quadratic in the length of text
 * a language model wrote, which is exactly the input this repo does not get to
 * bound. One long paragraph full of inline code was enough to hang the tab.
 */
export function parseInline(line: string): MdSpan[] {
  const spans: MdSpan[] = [];
  let at = 0;
  INLINE.lastIndex = 0;
  for (let m = INLINE.exec(line); m !== null; m = INLINE.exec(line)) {
    if (m.index > at) spans.push({ type: "text", text: line.slice(at, m.index) });
    const token = m[0];
    at = m.index + token.length;
    const g = m.groups ?? {};
    if (g["code"] !== undefined) {
      // Backticks suspend every other rule, including `$…$`: a code span is
      // atomic and keeps its asterisks, underscores and dollars literal.
      spans.push({ type: "code", text: token.slice(1, -1) });
    } else if (g["cite"] !== undefined) {
      spans.push({ type: "cite", n: g["citeN"] ?? "" });
    } else if (g["link"] !== undefined) {
      const text = g["linkText"] ?? "";
      spans.push({ type: "link", text, href: g["href"] ?? "", spans: nested(text) });
    } else if (g["del"] !== undefined) {
      const text = token.slice(2, -2);
      spans.push({ type: "del", text, spans: nested(text) });
    } else if (g["tri"] !== undefined || g["triU"] !== undefined) {
      // `***a***` is both at once, and the order is the one HTML nests them in:
      // a strong run whose whole content is an emphasis run.
      const text = token.slice(3, -3);
      spans.push({
        type: "strong",
        text,
        spans: [{ type: "em", text, spans: nested(text) }],
      });
    } else if (g["strong"] !== undefined) {
      const text = token.slice(2, -2);
      spans.push({ type: "strong", text, spans: nested(text) });
    } else if (g["math"] !== undefined) {
      spans.push({ type: "math", text: token.slice(1, -1) });
    } else {
      const text = token.slice(1, -1);
      spans.push({ type: "em", text, spans: nested(text) });
    }
    // `nested` re-enters this function, and `INLINE` is one shared global
    // regex: without this the child's scan would leave `lastIndex` pointing
    // into the child's own string and the parent would resume from nowhere.
    INLINE.lastIndex = at;
  }
  if (at < line.length) spans.push({ type: "text", text: line.slice(at) });
  return spans;
}

/**
 * Turns the newlines left inside a scanned paragraph into `br` spans.
 *
 * A span that straddles a break becomes two spans of its own kind with the
 * break between them — `strong("bold"), br, strong("text")` — rather than one
 * span holding a newline HTML would collapse to a space. Two `<strong>`s either
 * side of a `<br>` render as the one bold run the author wrote, and nothing
 * here has to nest.
 */
export function withBreaks(spans: MdSpan[]): MdSpan[] {
  const out: MdSpan[] = [];
  for (const span of spans) {
    // A span with children can not be split in two here without losing them,
    // so the break is put *inside* it instead: `<strong>a<br/>b</strong>` is
    // the same bold run either way, and the nesting survives.
    if (
      (span.type === "strong" || span.type === "em" || span.type === "del" || span.type === "link") &&
      span.spans
    ) {
      out.push({ ...span, spans: withBreaks(span.spans) });
      continue;
    }
    if (span.type === "cite" || span.type === "br" || !span.text.includes("\n")) {
      out.push(span);
      continue;
    }
    const parts = span.text.split("\n");
    for (let n = 0; n < parts.length; n++) {
      if (n > 0) out.push({ type: "br" });
      const text = parts[n] ?? "";
      // An empty run either side of a break is the break itself; a `<code></code>`
      // or an empty `<a>` there would be a visible artefact of the split.
      if (text === "") continue;
      if (span.type === "link") out.push({ type: "link", text, href: span.href });
      else out.push({ type: span.type, text });
    }
  }
  return out;
}

/**
 * A table row's cells. Leading and trailing pipes are optional in GFM, so both
 * `| a | b |` and `a | b` are the same two cells.
 */
function tableCells(line: string): string[] {
  let text = line.trim();
  if (text.startsWith("|")) text = text.slice(1);
  if (text.endsWith("|")) text = text.slice(0, -1);
  return text.split("|").map((cell) => cell.trim());
}

/**
 * The `|---|:--:|--:|` line, which is what makes the row above it a header
 * rather than a sentence with pipes in it. A `|` is required: without one,
 * `---` is a thematic break and nothing else.
 */
function isTableDelimiter(line: string): boolean {
  if (!line.includes("|")) return false;
  const cells = tableCells(line);
  return cells.length > 0 && cells.every((cell) => /^:?-+:?$/.test(cell));
}

function tableAlign(cell: string): MdAlign {
  const left = cell.startsWith(":");
  const right = cell.endsWith(":");
  if (left && right) return "center";
  if (right) return "right";
  if (left) return "left";
  return null;
}

/**
 * Three or more of one of `-`, `*`, `_`, alone on the line, spaces allowed.
 *
 * The single-character alternation matters: `- * -` is not a rule, and `---`
 * reaching here at all means the table check above it already declined, which
 * is the only place the two constructs could have been confused.
 */
const THEMATIC_BREAK = /^\s*([-*_])(?:\s*\1){2,}\s*$/;

/**
 * GFM's `- [ ] ` / `- [x] `, on an item the list parser has already unwrapped.
 *
 * The label is optional: a model that writes a bare `- [x]` — a checklist it
 * is still filling in, a row whose text arrived in the next delta — means an
 * empty task, and printing `[x]` at it is the bug this whole change is about.
 * `[x]text` with no space is still not a task.
 */
const TASK_MARKER = /^\[([ xX])\](?:\s+(.*))?$/;

/** A bullet or a numbered marker, with whatever indentation preceded it. */
const LIST_ITEM = /^([ \t]*)(?:[-*+]|\d+[.)])\s+(.*)$/;

/**
 * How deep a list line sits. A tab is two columns, which is all the precision
 * this needs: what matters is that an indented child sorts above its parent,
 * not that the count matches anybody's editor.
 */
function listIndent(prefix: string): number {
  return prefix.replace(/\t/g, "  ").length;
}

/** One list line, already unwrapped: its depth, its kind and its content. */
type RawItem = { indent: number; ordered: boolean; item: MdItem };

/**
 * A run of list lines, turned into the tree their indentation describes.
 *
 * The stack holds one entry per open level. A deeper line opens a child list on
 * the item above it; a shallower one closes levels until the indent fits again.
 * A run can produce more than one top-level list, because a bullet run and a
 * numbered run at column zero are two lists and not one — which is the shape
 * this parser has always produced.
 */
function buildLists(raws: RawItem[]): MdList[] {
  const roots: MdList[] = [];
  // `parent` is the item this level's list hangs off, and `undefined` at the
  // top: it is what a kind switch needs in order to put its new list where the
  // old one was, at any depth.
  const stack: { indent: number; list: MdList; parent?: MdItem }[] = [];
  const open = (ordered: boolean, item: MdItem, parent?: MdItem): MdList => {
    const list: MdList = { type: "list", ordered, items: [item] };
    if (parent) (parent.lists ??= []).push(list);
    else roots.push(list);
    return list;
  };
  for (const raw of raws) {
    while (stack.length > 1 && raw.indent < (stack[stack.length - 1]?.indent ?? 0)) stack.pop();
    const top = stack[stack.length - 1];
    if (!top) {
      stack.push({ indent: raw.indent, list: open(raw.ordered, raw.item) });
      continue;
    }
    const parent = top.list.items[top.list.items.length - 1];
    if (raw.indent > top.indent && parent) {
      // A sublist reuses the one already hanging off this item when the kind
      // still matches, so `- a` / `  - b` / `  - c` is one nested list.
      const held = parent.lists?.[parent.lists.length - 1];
      if (held && held.ordered === raw.ordered) {
        held.items.push(raw.item);
        stack.push({ indent: raw.indent, list: held, parent });
      } else {
        stack.push({ indent: raw.indent, list: open(raw.ordered, raw.item, parent), parent });
      }
      continue;
    }
    if (raw.ordered !== top.list.ordered) {
      // A kind switch is a new list at *every* depth, not only at the top: a
      // numbered item under a bullet sublist is a numbered list, and appending
      // it to the bullets drew it as a bullet.
      stack[stack.length - 1] = {
        indent: raw.indent,
        list: open(raw.ordered, raw.item, top.parent),
        parent: top.parent,
      };
      continue;
    }
    top.list.items.push(raw.item);
  }
  return roots;
}

/** A list line's content as an item, with GFM's task marker unwrapped. */
function listItem(raw: string): MdItem {
  const task = TASK_MARKER.exec(raw);
  return task
    ? { spans: parseInline(task[2] ?? ""), checked: (task[1] ?? "") !== " " }
    : { spans: parseInline(raw), checked: null };
}

export function parseMarkdown(markdown: string): MdNode[] {
  // A `text` block whose `markdown` never arrived — an older persisted row, a
  // gateway one version ahead — is an empty document, not a crashed thread.
  // Same reasoning as `RedactedText`: normalise where every caller passes, not
  // at each call site. §9.2, "it never disappears".
  const source = typeof markdown === "string" ? markdown : "";
  const lines = source.replace(/\r\n/g, "\n").split("\n");
  const nodes: MdNode[] = [];
  let paragraph: string[] = [];

  // A paragraph's own line breaks are kept as `br` spans rather than joined
  // with a space: `breaks` semantics, which is what a transcript needs.
  //
  // The paragraph is scanned *whole*, and the breaks are put back afterwards.
  // Scanning line by line would end every inline rule at the newline, so
  // `**bold` on one line and `text**` on the next printed its asterisks and a
  // code span that wrapped printed its backticks — markup a model wrote purely
  // because its own line was getting long.
  const flush = () => {
    if (paragraph.length === 0) return;
    nodes.push({ type: "p", spans: withBreaks(parseInline(paragraph.join("\n"))) });
    paragraph = [];
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    const fence = /^```\s*(\S*)\s*$/.exec(line);
    if (fence) {
      flush();
      const body: string[] = [];
      i++;
      while (i < lines.length && !/^```/.test(lines[i] ?? "")) {
        body.push(lines[i] ?? "");
        i++;
      }
      nodes.push({ type: "code", lang: fence[1] || null, text: body.join("\n") });
      continue;
    }
    // Display math, and only on two shapes: a complete `$$…$$` alone on the
    // line, or a bare `$$` that a later bare `$$` closes.
    //
    // Both halves of that are load-bearing. "`$$` is how bash spells the pid"
    // opens nothing, because the opener must be the delimiter and nothing
    // else; and an opener with no closer anywhere below it stays prose,
    // because the alternative is a sentence about shell quoting swallowing the
    // rest of the turn — every paragraph, list and table under it — into one
    // unreadable math block.
    const inlineMath = /^\$\$(.+)\$\$$/.exec(line.trim());
    if (inlineMath) {
      flush();
      nodes.push({ type: "math", text: (inlineMath[1] ?? "").trim() });
      continue;
    }
    if (line.trim() === "$$") {
      let end = i + 1;
      while (end < lines.length && (lines[end] ?? "").trim() !== "$$") end++;
      if (end < lines.length) {
        flush();
        nodes.push({
          type: "math",
          text: lines
            .slice(i + 1, end)
            .join("\n")
            .trim(),
        });
        i = end;
        continue;
      }
      // No closer: fall through, and the `$$` is a line of prose like any other.
    }
    if (line.trim() === "") {
      flush();
      continue;
    }
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      flush();
      nodes.push({ type: "h", level: heading[1]?.length ?? 1, spans: parseInline(heading[2] ?? "") });
      continue;
    }
    const quote = /^>\s?(.*)$/.exec(line);
    if (quote) {
      flush();
      nodes.push({ type: "quote", spans: parseInline(quote[1] ?? "") });
      continue;
    }
    // A table, and only if the line under the header is a delimiter row. The
    // check is what keeps a sentence containing a pipe a sentence.
    if (line.includes("|") && isTableDelimiter(lines[i + 1] ?? "")) {
      flush();
      const header = tableCells(line).map((cell) => parseInline(cell));
      const align = tableCells(lines[i + 1] ?? "").map(tableAlign);
      const rows: MdSpan[][][] = [];
      i += 2;
      // The table ends where the pipes do: a blank line or any line without one.
      while (i < lines.length && (lines[i] ?? "").trim() !== "" && (lines[i] ?? "").includes("|")) {
        rows.push(tableCells(lines[i] ?? "").map((cell) => parseInline(cell)));
        i++;
      }
      i--;
      nodes.push({ type: "table", align, header, rows });
      continue;
    }
    // Before the bullet rule, which would otherwise read `* * *` as a list.
    if (THEMATIC_BREAK.test(line)) {
      flush();
      nodes.push({ type: "hr" });
      continue;
    }
    // A list is read as a *run* of lines rather than one line at a time,
    // because indentation only means anything against the lines around it: a
    // `  - b` under a `- a` is that item's child, and a `  - b` with nothing
    // above it is just a bullet.
    if (LIST_ITEM.test(line)) {
      flush();
      const raws: RawItem[] = [];
      while (i < lines.length) {
        const match = LIST_ITEM.exec(lines[i] ?? "");
        if (!match) break;
        const content = match[2] ?? "";
        raws.push({
          indent: listIndent(match[1] ?? ""),
          // `\d+.` is ordered; anything else reaching here is a bullet.
          ordered: !/^[ \t]*[-*+]\s/.test(lines[i] ?? ""),
          item: listItem(content),
        });
        i++;
      }
      i--;
      for (const list of buildLists(raws)) {
        // A blank line between two runs of the same kind is still one list,
        // which is the behaviour this parser has always had.
        const last = nodes[nodes.length - 1];
        if (last && last.type === "list" && last.ordered === list.ordered) {
          last.items.push(...list.items);
        } else nodes.push(list);
      }
      continue;
    }
    paragraph.push(line.trim());
  }
  flush();
  return nodes;
}
