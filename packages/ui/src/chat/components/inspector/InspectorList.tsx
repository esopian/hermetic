/**
 * The inspector's record list: fixed 22px rows, virtualized, so a ring of
 * twenty thousand records draws the forty on screen and no more.
 *
 * A row is a record (with its fate badge, and the page's reducer outcome on a
 * frame), a folded run of deltas, or a turn header. Selecting one selects the
 * record it stands for. `j`/`k` move the selection while the list has focus.
 */
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent } from "react";
import {
  categoryOf,
  fateLabel,
  fmtCount,
  fmtListTime,
  fmtMs,
  isDropped,
  outcomeLabel,
  rowId,
  summarize,
  type Row,
} from "../../inspector-logic.ts";

export const ROW_HEIGHT = 22;
/** Rows drawn above and below the viewport, so a fast scroll does not show blanks. */
const OVERSCAN = 8;
/** What the list assumes before it has been measured (and in a test DOM, which never measures). */
const FALLBACK_HEIGHT = 600;

/** Enter or Space on a row selects it, as a click does. */
function activate(e: ReactKeyboardEvent, onSelect: () => void): void {
  if (e.key !== "Enter" && e.key !== " ") return;
  e.preventDefault();
  onSelect();
}

function dirGlyph(dir: "in" | "out"): string {
  return dir === "out" ? "↑" : "↓";
}

function RowView({ row, selected, onSelect }: { row: Row; selected: boolean; onSelect: () => void }) {
  if (row.kind === "turn") {
    const t = row.turn;
    const facts = [
      fmtMs(t.durationMs),
      t.model,
      t.inputTokens !== null ? `in ${fmtCount(t.inputTokens)}` : null,
      t.outputTokens !== null ? `out ${fmtCount(t.outputTokens)}` : null,
      t.tps !== null ? `${t.tps.toFixed(1)} tps` : null,
      t.latencyMs !== null ? `first byte ${fmtMs(t.latencyMs)}` : null,
    ].filter(Boolean);
    const usage =
      t.usage === null
        ? undefined
        : Object.entries(t.usage)
            .map(([k, v]) => `${k}: ${JSON.stringify(v)}`)
            .join("\n");
    return (
      <div className="insp-row insp-turn" role="row" title={usage}>
        <b>
          Turn {t.index} · {t.title}
        </b>
        <span className="insp-turn-facts">{facts.join(" · ")}</span>
      </div>
    );
  }
  if (row.kind === "deltas") {
    const first = row.recs[0]!;
    return (
      <div
        className={`insp-row${selected ? " sel" : ""}${row.depth ? " child" : ""}`}
        role="row"
        aria-selected={selected}
        data-insp-row={row.id}
        onClick={onSelect}
        onKeyDown={(e) => activate(e, onSelect)}
      >
        <span className="insp-t">{fmtListTime(first.at)}</span>
        <span className="insp-dir">{dirGlyph(first.dir)}</span>
        <span className={`insp-cat c-${categoryOf(first)}`} aria-hidden="true" />
        <span className="insp-type">
          {row.type} ×{row.recs.length}
        </span>
        <span className="insp-seq">
          {first.seq ?? ""}
          {row.recs.length > 1 ? `–${row.recs[row.recs.length - 1]!.seq ?? ""}` : ""}
        </span>
        <span className="insp-sum">"{row.text.replace(/\s+/g, " ")}"</span>
        <span className="insp-fate">{fmtMs(row.spanMs)}</span>
      </div>
    );
  }
  const rec = row.rec;
  const dropped = isDropped(rec, row.note);
  const badge = row.note !== null ? outcomeLabel(row.note.outcome) : fateLabel(rec.fate);
  return (
    <div
      className={`insp-row${selected ? " sel" : ""}${row.depth ? " child" : ""}${dropped ? " drop" : ""}`}
      role="row"
      aria-selected={selected}
      data-insp-row={rec.id}
      onClick={onSelect}
      onKeyDown={(e) => activate(e, onSelect)}
    >
      <span className="insp-t">{fmtListTime(rec.at)}</span>
      <span className="insp-dir">{row.depth ? "↳" : dirGlyph(rec.dir)}</span>
      <span className={`insp-cat c-${categoryOf(rec)}`} aria-hidden="true" />
      <span className="insp-type">{rec.type}</span>
      <span className="insp-seq">{rec.seq ?? ""}</span>
      <span className="insp-sum">{summarize(rec)}</span>
      {badge ? (
        <span
          className={`insp-fate${dropped ? " drop" : rec.fate?.kind === "buffer" ? " buf" : rec.fate?.kind === "frames" ? " frames" : ""}`}
        >
          {badge}
        </span>
      ) : (
        <span className="insp-fate" />
      )}
    </div>
  );
}

export function InspectorList({
  rows,
  selected,
  onSelect,
  follow,
  label,
}: {
  rows: readonly Row[];
  selected: string | null;
  onSelect: (id: string | null) => void;
  follow: boolean;
  label: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [height, setHeight] = useState(0);

  useLayoutEffect(() => {
    const node = ref.current;
    if (!node) return;
    setHeight(node.clientHeight);
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => setHeight(node.clientHeight));
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  // Follow keeps the newest row in view as records arrive.
  useEffect(() => {
    const node = ref.current;
    if (!follow || !node) return;
    node.scrollTop = node.scrollHeight;
    setScrollTop(node.scrollTop);
  }, [follow, rows.length]);

  const viewport = height > 0 ? height : FALLBACK_HEIGHT;
  const first = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - OVERSCAN);
  const last = Math.min(rows.length, Math.ceil((scrollTop + viewport) / ROW_HEIGHT) + OVERSCAN);
  const visible = rows.slice(first, last);

  const selectable = rows.filter((r) => r.kind !== "turn");
  const onKeyDown = (e: ReactKeyboardEvent) => {
    if (e.key !== "j" && e.key !== "k") return;
    e.preventDefault();
    const at = selectable.findIndex((r) => rowId(r) === selected);
    const next =
      selectable[e.key === "j" ? Math.min(selectable.length - 1, at + 1) : Math.max(0, at - 1)];
    if (next === undefined) return;
    const id = rowId(next);
    onSelect(id);
    const index = rows.indexOf(next);
    const node = ref.current;
    if (node && index >= 0) {
      const top = index * ROW_HEIGHT;
      if (top < node.scrollTop) node.scrollTop = top;
      else if (top + ROW_HEIGHT > node.scrollTop + viewport)
        node.scrollTop = top + ROW_HEIGHT - viewport;
    }
  };

  return (
    <div
      className="insp-list"
      ref={ref}
      role="grid"
      aria-label={label}
      aria-rowcount={rows.length}
      tabIndex={0}
      onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}
      onKeyDown={onKeyDown}
    >
      {rows.length === 0 ? (
        <p className="insp-empty">Nothing captured here yet.</p>
      ) : (
        <div className="insp-list-inner" style={{ height: rows.length * ROW_HEIGHT }}>
          <div style={{ transform: `translateY(${first * ROW_HEIGHT}px)` }}>
            {visible.map((row) => {
              const id = rowId(row);
              return (
                <RowView
                  key={id}
                  row={row}
                  selected={id === selected}
                  onSelect={() => onSelect(id === selected ? null : id)}
                />
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
