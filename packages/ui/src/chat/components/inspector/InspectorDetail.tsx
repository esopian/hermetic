/**
 * The inspector's lower half: the selected record, four ways.
 *
 * - **Raw** — the payload as captured (masked when Chat › Redact secrets is on).
 * - **Lineage** — one wire message and what it became: the adapter's fate, the
 *   frames it produced, and what the page's reducer did with each.
 * - **Diff** — the wire payload against what the adapter keeps of it, from the
 *   field map for its type.
 * - **Ids & timing** — every id the record carries, and its place in time.
 */
import { useState } from "react";
import type { ReactNode } from "react";
import {
  diffRowKey,
  fieldDiff,
  fmtClockMs,
  fmtMs,
  fmtValue,
  frameTypeOf,
  lineage,
  wireEvent,
  type PageNote,
  type TapRecord,
} from "../../inspector-logic.ts";

export type DetailTab = "raw" | "lineage" | "diff" | "ids";

const TABS: { id: DetailTab; label: string }[] = [
  { id: "raw", label: "Raw" },
  { id: "lineage", label: "Lineage" },
  { id: "diff", label: "Diff" },
  { id: "ids", label: "Ids & timing" },
];

const DIFF_GLYPH = { kept: "=", renamed: "~", dropped: "−", synthesized: "+", unmapped: "?" } as const;

function pretty(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    return String(value);
  }
}

function Kv({ rows }: { rows: [string, ReactNode][] }) {
  return (
    <div className="insp-kv">
      {rows.map(([k, v]) => (
        <div key={k}>
          <span className="k">{k}</span>
          <span className="v">{v}</span>
        </div>
      ))}
    </div>
  );
}

export function InspectorDetail({
  record,
  run,
  records,
  notes,
  onCopy,
}: {
  record: TapRecord | null;
  /** The records a folded delta row stands for, when that is what is selected. */
  run: readonly TapRecord[] | null;
  records: readonly TapRecord[];
  notes: readonly PageNote[];
  onCopy: (ids: string[]) => void;
}) {
  const [tab, setTab] = useState<DetailTab>("raw");
  return (
    <div className="insp-detail">
      <div className="insp-dtabs" role="tablist" aria-label="Record detail">
        {TABS.map((t) => (
          <button
            type="button"
            key={t.id}
            role="tab"
            aria-selected={tab === t.id}
            className={tab === t.id ? "on" : undefined}
            onClick={() => setTab(t.id)}
          >
            {t.label}
          </button>
        ))}
        <span className="insp-grow" />
        <button
          type="button"
          className="insp-link"
          disabled={record === null}
          onClick={() => record && onCopy(run ? run.map((r) => r.id) : [record.id])}
        >
          copy
        </button>
      </div>
      <div className="insp-dbody" role="tabpanel">
        {record === null ? (
          <p className="insp-empty">Select a row.</p>
        ) : tab === "raw" ? (
          <>
            <div className="insp-dk">
              {record.layer} · {record.type}
              {run ? ` · ${run.length} records` : ""}
              {record.synthetic ? " · synthetic" : ""}
            </div>
            <pre className="insp-pre">
              {run ? pretty(run.map((r) => r.payload)) : pretty(record.payload)}
            </pre>
          </>
        ) : tab === "lineage" ? (
          <div className="insp-lineage">
            {lineage(record, records, notes).map((chain, i) => (
              <div className="insp-chain" key={i}>
                {chain.map((step, j) => (
                  <span key={j} className={`insp-step s-${step.layer}`}>
                    {j > 0 ? <i aria-hidden="true">→</i> : null}
                    <b>{step.label}</b>
                    <small>{step.detail}</small>
                  </span>
                ))}
              </div>
            ))}
          </div>
        ) : tab === "diff" ? (
          <DiffView record={record} records={records} />
        ) : (
          <Kv
            rows={[
              ["Record", record.id],
              ["Received", `${fmtClockMs(record.at)}`],
              [
                "Since previous",
                (() => {
                  const at = records.indexOf(record);
                  const prev = at > 0 ? records[at - 1] : undefined;
                  return prev ? `+${fmtMs(record.mono - prev.mono)}` : "—";
                })(),
              ],
              ["Layer", `${record.layer} · ${record.dir === "out" ? "laptop → box" : "box → laptop"}`],
              ["Socket", record.socket ?? "—"],
              ["Seq", record.seq === null ? "—" : String(record.seq)],
              ["Parent", record.parent ?? "—"],
              ["Bytes", `${record.bytes} B as received`],
              [
                "Conversation",
                `${record.conversation.instance}/${record.conversation.bot}${record.conversation.session ? ` · ${record.conversation.session}` : " · canonical"}`,
              ],
              ...(() => {
                const children = records.filter((r) => r.parent === record.id);
                return children.length > 0
                  ? ([["Frames", children.map((c) => `${c.id} ${frameTypeOf(c)}`).join(", ")]] as [
                      string,
                      ReactNode,
                    ][])
                  : [];
              })(),
            ]}
          />
        )}
      </div>
    </div>
  );
}

function DiffView({ record, records }: { record: TapRecord; records: readonly TapRecord[] }) {
  // A frame's diff is its wire parent's: the diff is what the adapter did.
  const wire = record.layer === "wire" ? record : (records.find((r) => r.id === record.parent) ?? null);
  if (wire === null) return <p className="insp-empty">No wire message behind this record.</p>;
  const rows = fieldDiff(wire.type, wireEvent(wire));
  if (rows === null)
    return (
      <p className="insp-empty">No field map for {wire.type}: the payload is passed through as read.</p>
    );
  return (
    <>
      <div className="insp-dk">{wire.type} payload → frame</div>
      <div className="insp-diff">
        {rows.map((row) => (
          <div key={diffRowKey(row)} className={`insp-drow d-${row.op}`}>
            <span className="g">{DIFF_GLYPH[row.op]}</span>
            <span className="p">{row.wire ?? "(adapter)"}</span>
            <span className="v">
              {row.frame !== null && row.frame !== row.wire ? `→ ${row.frame} · ` : ""}
              {row.op === "synthesized" ? "made up by the adapter" : fmtValue(row.value)}
              {row.note ? ` (${row.note})` : ""}
            </span>
          </div>
        ))}
      </div>
      <p className="insp-legend">= kept · ~ renamed · − dropped · + synthesized · ? not in the map</p>
    </>
  );
}
