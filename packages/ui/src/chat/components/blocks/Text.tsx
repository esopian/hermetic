/**
 * `text` — the prose a model produced.
 *
 * Three variants and no branches to speak of: markdown is the default, a fenced
 * block becomes a `.ch-card` with a code pane in it, and a citation marker
 * becomes a `.ch-cite` that the `sources` card underneath resolves.
 *
 * Markdown itself never reaches for `dangerouslySetInnerHTML`, and that is the
 * point of `parseMarkdown` returning nodes rather than a string of HTML. What
 * is being rendered is text a language model wrote on a box; the day one of
 * them emits a `<script>` should be the day it appears on screen as the
 * characters it is. The one exception is the `math` cases, which draw HTML
 * KaTeX *generated* from the TeX rather than HTML anyone wrote — the argument
 * for that, and the refusal to typeset a redaction marker, are in
 * `chat-math.ts`.
 *
 * Every leaf of text goes through `RedactedText` — the second door, after
 * core's own masking (`tests/chat-redaction.test.ts`). A new construct that
 * draws prose draws it through that component or it does not draw it.
 */
import { RedactedText } from "../RedactedText.tsx";
import type { ChatBlockOf } from "../../../api/index.ts";
import { renderMathHtml } from "../../chat-math.ts";
import { parseMarkdown, safeHref } from "../../chat-logic.ts";
import type { MdNode, MdSpan } from "../../chat-logic.ts";

/**
 * The contents of an emphasis run or a link label: its parsed children when it
 * had markup inside it, and its plain text when it did not.
 *
 * Both paths end in `RedactedText`; the nested one because `Spans` is where it
 * lands, the flat one right here.
 */
function Inner({ span }: { span: { text: string; spans?: MdSpan[] } }) {
  return span.spans ? <Spans spans={span.spans} /> : <RedactedText text={span.text} />;
}

function Spans({ spans }: { spans: MdSpan[] }) {
  return (
    <>
      {spans.map((span, i) => {
        const key = `${span.type}:${i}`;
        switch (span.type) {
          case "code":
            return (
              <code key={key}>
                <RedactedText text={span.text} />
              </code>
            );
          case "strong":
            return (
              <strong key={key}>
                <Inner span={span} />
              </strong>
            );
          case "em":
            return (
              <em key={key}>
                <Inner span={span} />
              </em>
            );
          // TeX, typeset by KaTeX. `renderMathHtml` returns null — and the
          // source is drawn as source, as it was before KaTeX — when the
          // expression is empty, unrenderable, or carries a redaction marker
          // that belongs to `RedactedText` rather than to a typesetter. The
          // safety argument for the innerHTML lives in `chat-math.ts`.
          case "math": {
            const html = renderMathHtml(span.text, false);
            return html === null ? (
              <span className="ch-math" key={key}>
                <RedactedText text={span.text} />
              </span>
            ) : (
              // biome-ignore lint/security/noDangerouslySetInnerHtml: KaTeX generates this HTML from already-redacted TeX with `trust: false`; see `chat-math.ts`.
              <span className="ch-math rendered" dangerouslySetInnerHTML={{ __html: html }} key={key} />
            );
          }
          // GFM's `~~struck~~`. A `<del>` element and not a class, because
          // "this was withdrawn" is meaning, and meaning belongs in the a11y
          // tree rather than in a stylesheet.
          case "del":
            return (
              <del key={key}>
                <Inner span={span} />
              </del>
            );
          case "link": {
            // A link a model wrote is a link that may be `javascript:`, in an
            // origin that talks to the loopback API. `safeHref` allow-lists;
            // anything it refuses is drawn as the characters it is, which is
            // both safe and the most informative thing to show.
            const href = safeHref(span.href);
            return href === null ? (
              <span key={key}>
                <RedactedText text={`${span.text} (${span.href})`} />
              </span>
            ) : (
              <a key={key} href={href} rel="noreferrer noopener" target="_blank">
                <Inner span={span} />
              </a>
            );
          }
          // A single newline inside a paragraph. `parseMarkdown` keeps it; this
          // is where it becomes a line the reader can see.
          case "br":
            return <br key={key} />;
          case "cite":
            // An anchor to the sources card below, which is where the marker's
            // number is resolved. It is a link and not a superscript because the
            // one thing an operator wants from a citation is to reach it.
            return (
              <a key={key} className="ch-cite" href={`#source-${span.n}`}>
                {span.n}
              </a>
            );
          default:
            return (
              <span key={key}>
                <RedactedText text={span.text} />
              </span>
            );
        }
      })}
    </>
  );
}

function Node({ node }: { node: MdNode }) {
  switch (node.type) {
    case "h": {
      const level = Math.min(Math.max(node.level, 1), 6);
      const Tag = `h${level}` as "h1";
      return (
        <Tag>
          <Spans spans={node.spans} />
        </Tag>
      );
    }
    case "quote":
      return (
        <blockquote>
          <Spans spans={node.spans} />
        </blockquote>
      );
    case "list": {
      const items = node.items.map((item, i) => (
        // The index is the key because a list item has no identity of its own;
        // the list is re-rendered whole on every delta anyway.
        <li className={item.checked === null ? undefined : "ch-task"} key={i}>
          {item.checked === null ? null : (
            // Read-only on purpose: this is a report of what the agent did, not
            // a control. `disabled` alone would drop it out of the a11y tree's
            // value, so both attributes are set.
            <input checked={item.checked} disabled readOnly type="checkbox" />
          )}
          <Spans spans={item.spans} />
          {/* An item's own indented children, drawn as the `<ul>`/`<ol>` inside
              its `<li>` that HTML nests a sublist as. */}
          {item.lists?.map((list, n) => (
            <Node key={n} node={list} />
          ))}
        </li>
      ));
      return node.ordered ? <ol>{items}</ol> : <ul>{items}</ul>;
    }
    case "table":
      return (
        <table className="ch-md-table">
          <thead>
            <tr>
              {node.header.map((cell, c) => (
                <th
                  data-align={node.align[c] ?? undefined}
                  key={c}
                  style={{ textAlign: node.align[c] ?? undefined }}
                >
                  <Spans spans={cell} />
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {node.rows.map((row, r) => (
              <tr key={r}>
                {row.map((cell, c) => (
                  <td
                    data-align={node.align[c] ?? undefined}
                    key={c}
                    style={{ textAlign: node.align[c] ?? undefined }}
                  >
                    <Spans spans={cell} />
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      );
    case "hr":
      return <hr />;
    // Display math. Same rule as the inline case above: KaTeX when it can
    // typeset it, the source through `RedactedText` when it cannot.
    case "math": {
      const html = renderMathHtml(node.text, true);
      return html === null ? (
        <div className="ch-math block">
          <RedactedText text={node.text} />
        </div>
      ) : (
        // biome-ignore lint/security/noDangerouslySetInnerHtml: KaTeX generates this HTML from already-redacted TeX with `trust: false`; see `chat-math.ts`.
        <div className="ch-math block rendered" dangerouslySetInnerHTML={{ __html: html }} />
      );
    }
    case "code":
      return (
        <div className="ch-card muted">
          <div className="ch-card-head">
            <span>{node.lang ?? "code"}</span>
          </div>
          <pre className="ch-code ch-card-body tight">
            <RedactedText text={node.text} />
          </pre>
        </div>
      );
    default:
      return (
        <p>
          <Spans spans={node.spans} />
        </p>
      );
  }
}

/**
 * Operator text, bare-minimum markdown only: backtick `code` spans and fenced
 * ``` blocks. Matches Desktop's `user-message-text.tsx:8-15`, which deliberately
 * skips its full pipeline (Streamdown, KaTeX, syntax highlighting) for anything
 * the operator typed — a stray `$x=1$` or `***text***` is not meant to become a
 * formula or emphasis. Whitespace is preserved (`pre-wrap`) and long unbroken
 * runs wrap rather than overflow. Every leaf still goes through `RedactedText`,
 * the same door the full pipeline uses above.
 */
const FENCE = /```[^\S\n]*[^\n]*\n?([\s\S]*?)```/g;
const INLINE_CODE = /`([^`\n]+)`/g;

function splitInlineCode(text: string, keyPrefix: string) {
  const parts: { key: string; code: boolean; text: string }[] = [];
  let last = 0;
  let n = 0;
  INLINE_CODE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = INLINE_CODE.exec(text))) {
    if (m.index > last)
      parts.push({ key: `${keyPrefix}:${n++}`, code: false, text: text.slice(last, m.index) });
    parts.push({ key: `${keyPrefix}:${n++}`, code: true, text: m[1] ?? "" });
    last = INLINE_CODE.lastIndex;
  }
  if (last < text.length)
    parts.push({ key: `${keyPrefix}:${n++}`, code: false, text: text.slice(last) });
  return parts;
}

function PlainText({ text }: { text: string }) {
  const segments: { key: string; fence: boolean; text: string }[] = [];
  let last = 0;
  let n = 0;
  FENCE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = FENCE.exec(text))) {
    if (m.index > last)
      segments.push({ key: `s${n++}`, fence: false, text: text.slice(last, m.index) });
    segments.push({ key: `s${n++}`, fence: true, text: m[1] ?? "" });
    last = FENCE.lastIndex;
  }
  if (last < text.length) segments.push({ key: `s${n++}`, fence: false, text: text.slice(last) });

  return (
    <div className="ch-plain-text" style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>
      {segments.map((seg) =>
        seg.fence ? (
          <pre className="ch-code" key={seg.key}>
            <code>
              <RedactedText text={seg.text} />
            </code>
          </pre>
        ) : (
          <span key={seg.key}>
            {splitInlineCode(seg.text, seg.key).map((part) =>
              part.code ? (
                <code key={part.key}>
                  <RedactedText text={part.text} />
                </code>
              ) : (
                <RedactedText key={part.key} text={part.text} />
              ),
            )}
          </span>
        ),
      )}
    </div>
  );
}

export function TextBlock({
  block,
  streaming = false,
  /** Operator-authored text: bare-minimum markdown, see `PlainText` above. */
  plain = false,
}: {
  block: ChatBlockOf<"text">;
  streaming?: boolean;
  plain?: boolean;
}) {
  if (plain) {
    return (
      <>
        <PlainText text={block.markdown} />
        {streaming ? <span className="caret" /> : null}
      </>
    );
  }
  const nodes = parseMarkdown(block.markdown);
  return (
    <>
      {nodes.map((node, i) => (
        // Markdown nodes have no id.
        <Node key={i} node={node} />
      ))}
      {/* The blinking caret at the end of a turn still arriving. */}
      {streaming ? <span className="caret" /> : null}
    </>
  );
}
