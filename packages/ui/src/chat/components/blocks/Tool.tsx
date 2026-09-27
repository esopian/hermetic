/**
 * `tool` — what the agent did to answer.
 *
 * Fourteen examples in the gallery and **one renderer**, because they are
 * variants rather than kinds: the card switches on the `render` hint the
 * adapter set from the tool's name, and on `status`. A terminal call, a diff, a
 * table, an image and a raw payload are five bodies inside one head.
 *
 * That is not a tidiness argument, it is the version-skew argument. `render` is
 * a *hint* and is explicitly allowed to be absent or to name something this
 * build has never heard of (schema/chat.ts) — so the hint switch has to fall
 * through to "draw the payload" rather than to nothing, exactly the way the
 * block-kind switch does. A `hermes_ref` bump that adds fifty tools adds fifty
 * cards here and changes no code.
 */
import { useState } from "react";
import { RedactedText } from "../RedactedText.tsx";
import type { ChatBlockOf } from "../../../api/index.ts";
import { fmtMs, safeImageSrc, toolVerdict } from "../../chat-logic.ts";
import { Card, CardBody, CodePane } from "../Card.tsx";

/**
 * A tool result as text.
 *
 * Upstream hands back a string for some tools and an object for others, and
 * neither is promised. A string is the text; an object with an obvious text
 * field is that field; anything else is its own JSON, which is always readable
 * and never wrong.
 */
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

/** The one argument worth putting in the head: a command, a path, a query. */
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

function Diff({ text }: { text: string }) {
  return (
    <div className="ch-diff ch-card-body tight">
      {text.split("\n").map((line, i) => {
        const cls = line.startsWith("@@")
          ? "hunk"
          : line.startsWith("+")
            ? "add"
            : line.startsWith("-")
              ? "del"
              : undefined;
        // A diff line is identified by its position.
        return cls ? (
          <div key={i} className={cls}>
            <RedactedText text={line} />
          </div>
        ) : (
          <div key={i}>
            <RedactedText text={line} />
          </div>
        );
      })}
    </div>
  );
}

/**
 * A table, from either of the two shapes a tool produces one in: an array of
 * objects (the common case), or an explicit `{ columns, rows }`. Anything else
 * is not a table and falls back to the payload, which is the rule this whole
 * file is built on.
 */
function Table({ result }: { result: unknown }) {
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
  if (rows.length === 0) return <CodePane text={resultText(result)} />;

  return (
    <CardBody tight>
      <table className="ch-table">
        {columns.length > 0 ? (
          <thead>
            <tr>
              {columns.map((c) => (
                <th key={c}>
                  <RedactedText text={c} />
                </th>
              ))}
            </tr>
          </thead>
        ) : null}
        <tbody>
          {rows.map((row, i) => (
            // A result row has no id of its own.
            <tr key={i}>
              {row.map((cell, j) => (
                // Neither does a cell.
                <td key={j}>
                  <RedactedText text={cell === null || cell === undefined ? "—" : String(cell)} />
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </CardBody>
  );
}

/**
 * A picture, when the payload names one, and an honest placeholder when it does
 * not. The placeholder is `.ch-shot-fake` — a screenshot whose
 * bytes never left the box is a thing to say, not a broken image icon.
 */
function Shot({ result }: { result: unknown }) {
  const href =
    typeof result === "string"
      ? result
      : result && typeof result === "object"
        ? ((result as { href?: unknown }).href ?? (result as { url?: unknown }).url)
        : null;
  // Same-origin only. The portal serves its own attachments; an image the
  // payload points somewhere else is a request this browser would make on the
  // operator's behalf, off the tailnet, before anybody clicked anything.
  const src = safeImageSrc(typeof href === "string" ? href : null);
  // A same-origin path this portal cannot answer falls back to the same
  // placeholder rather than a broken-image box.
  const [failed, setFailed] = useState<string | null>(null);
  if (src && failed !== src)
    return <img src={src} alt="" className="ch-shot" onError={() => setFailed(src)} />;
  return (
    <div className="ch-shot-fake">
      {src
        ? "image · could not be loaded"
        : typeof href === "string" && href.length > 0
          ? `image not fetched — ${href} is not served by this portal`
          : "image · not fetched"}
    </div>
  );
}

export function ToolBlock({ block, inline = false }: { block: ChatBlockOf<"tool">; inline?: boolean }) {
  const verdict = toolVerdict(block.status);
  const running = block.status === "running";
  const failed = block.status === "bad";
  const text = resultText(block.result);

  const right = running
    ? `running${block.duration_ms ? ` · ${fmtMs(block.duration_ms)}` : ""}`
    : [
        block.exit_code === null || block.exit_code === undefined ? null : `exit ${block.exit_code}`,
        fmtMs(block.duration_ms) || null,
      ]
        .filter(Boolean)
        .join(" · ") || block.status;

  const head = (
    <>
      {/* The MCP server badge: the tool came from one, when it did. */}
      {block.server ? (
        <span className="ch-chip static">
          <RedactedText text={`mcp · ${block.server}`} />
        </span>
      ) : null}
      <span style={running ? { color: "var(--acc)" } : undefined}>
        <RedactedText text={running ? `● ${block.name}` : block.name} />
      </span>
    </>
  );

  const body = () => {
    if (running) {
      return (
        <CardBody>
          <div className="bar">
            <i />
          </div>
          <div className="ch-meter">
            <span>running on the box</span>
          </div>
        </CardBody>
      );
    }
    switch (block.render) {
      case "diff":
        return <Diff text={text} />;
      case "table":
        return <Table result={block.result} />;
      case "image":
      case "screenshot":
        return <Shot result={block.result} />;
      case "terminal":
        return <CodePane text={text} />;
      default:
        // No hint, or one this build cannot name. The payload is the body — the
        // same answer the `unknown` block gets, and for the same reason.
        return <CodePane text={text || "(no output)"} />;
    }
  };

  if (inline) return body();
  return (
    <Card
      verdict={verdict}
      failed={failed}
      head={head}
      subject={subjectOf(block.args) ?? undefined}
      right={right}
      collapsible={!running}
    >
      {body()}
    </Card>
  );
}
