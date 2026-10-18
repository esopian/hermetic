/**
 * The stream inspector (§9.2 "Developer tools"): a resizable pane to the right
 * of the thread in the full chat view, replacing the context pane while it is
 * open.
 *
 * Dense and mono, in the app's brutalist voice rather than the chat's soft
 * skin, because it is a table you scan. Four tabs over one conversation's
 * capture:
 *
 * - **Wire** — every JSON-RPC message on the box socket, both directions, with
 *   its fate, and (optionally) the frames it produced indented under it.
 * - **Frames** — every frame core handed the head, with what the page's
 *   reducer did with it (`chat/devtap.ts`).
 * - **State** — the live messages the reducer built, every keyed block, and
 *   every version of each that the store replaced.
 * - **Connection** — the socket's lifecycle.
 *
 * Subscribes while mounted and only then (`useTap`). Copy goes through core's
 * export, which is always masked.
 *
 * Keys: `/` focuses the filter, `j`/`k` move through rows while the list has
 * focus, Escape clears the selection and a second Escape closes the pane.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent } from "react";
import { chatSettings } from "../../../api/chat.ts";
import { devtoolsExport } from "../../../api/devtools.ts";
import {
  CATEGORIES,
  blockSummary,
  buildRows,
  fmtClockMs,
  fmtCount,
  messageStates,
  parseFilter,
  rowId,
  tabRecords,
  type Category,
  type ConversationRef,
  type Row,
  type Tab,
  type TapRecord,
} from "../../inspector-logic.ts";
import { devtap, usePageNotes, useTap } from "../../../state/devtools-store.ts";
import { InspectorDetail } from "./InspectorDetail.tsx";
import { InspectorList } from "./InspectorList.tsx";

const TABS: { id: Tab; label: string }[] = [
  { id: "wire", label: "Wire" },
  { id: "frames", label: "Frames" },
  { id: "state", label: "State" },
  { id: "connection", label: "Connection" },
];

interface Toggles {
  collapse: boolean;
  showDropped: boolean;
  framesUnderEvents: boolean;
  byTurn: boolean;
  follow: boolean;
}

/** Each toggle, and the tabs it means something on. */
const TOGGLES: { id: keyof Toggles; label: string; tabs: readonly Tab[] }[] = [
  { id: "collapse", label: "Collapse deltas", tabs: ["wire", "frames"] },
  { id: "showDropped", label: "Show dropped", tabs: ["wire", "frames"] },
  { id: "framesUnderEvents", label: "Show frames under events", tabs: ["wire"] },
  { id: "byTurn", label: "Group by turn", tabs: ["wire"] },
  { id: "follow", label: "Follow", tabs: ["wire", "frames", "connection"] },
];

/** Category chips name what a wire event or a frame carries; a connection fact is neither. */
const CHIP_TABS: readonly Tab[] = ["wire", "frames"];

/**
 * The narrowest the thread column may get beside the pane: the thread header's
 * name, badge and action chips on one line. The grip stops there, and so does
 * the stylesheet (`chat-inspector.css`) when the window narrows under it.
 */
export const CHAT_MIN_WIDTH = 660;
/** The conversation rail's fixed column (`chat.css`, `.ch-body`). */
const RAIL_WIDTH = 300;
const ALL_CATEGORIES: ReadonlySet<Category> = new Set(CATEGORIES);

function conversationLabel(c: ConversationRef): string {
  return `${c.instance}/${c.bot}${c.session ? ` · ${c.session}` : ""}`;
}

export function Inspector({
  conversation,
  message,
  nonce,
  keep,
  width,
  onResize,
  onClose,
}: {
  conversation: ConversationRef;
  /** Opened from a message: filtered to it. */
  message: string | null;
  /** Changes on every open, so reopening on a message re-applies its filter. */
  nonce: number;
  keep: number;
  width: number;
  onResize: (px: number) => void;
  onClose: () => void;
}) {
  const tap = useTap(conversation, keep);
  const notes = usePageNotes(conversation);
  const [tab, setTab] = useState<Tab>("wire");
  const [filterText, setFilterText] = useState(message ? `message:${message}` : "");
  const [categories, setCategories] = useState<ReadonlySet<Category>>(() => new Set(CATEGORIES));
  const [toggles, setToggles] = useState<Toggles>({
    collapse: true,
    showDropped: true,
    framesUnderEvents: true,
    byTurn: false,
    follow: true,
  });
  const [selected, setSelected] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [masked, setMasked] = useState<boolean | null>(null);
  const filterRef = useRef<HTMLInputElement>(null);
  const rootRef = useRef<HTMLElement>(null);

  useEffect(() => {
    setFilterText(message ? `message:${message}` : "");
    setSelected(null);
    if (message) setTab("frames");
  }, [message, nonce]);

  // The masked badge reads the redaction preference once per open: masking
  // is core's, and follows Chat › Redact secrets.
  useEffect(() => {
    let live = true;
    Promise.resolve()
      .then(() => chatSettings())
      .then(
        (s) => {
          if (live) setMasked(s.redact);
        },
        () => {},
      );
    return () => {
      live = false;
    };
  }, []);

  const filter = useMemo(() => parseFilter(filterText), [filterText]);
  const rows: Row[] = useMemo(
    () =>
      tab === "state"
        ? []
        : buildRows(tap.records, notes, tab, {
            filter,
            // A control a tab does not draw does not filter it either.
            categories: CHIP_TABS.includes(tab) ? categories : ALL_CATEGORIES,
            collapse: tab !== "connection" && toggles.collapse,
            showDropped: tab === "connection" || toggles.showDropped,
            framesUnderEvents: tab === "wire" && toggles.framesUnderEvents,
            byTurn: tab === "wire" && toggles.byTurn,
          }),
    [tap.records, notes, tab, filter, categories, toggles],
  );
  // `notes` is a fresh array whenever one is added or evicted, so the
  // truncation set read beside it is never staler than the notes.
  const states = useMemo(
    () => (tab === "state" ? messageStates(notes, devtap.truncatedFor(conversation)) : []),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [tab, notes],
  );

  const counts = useMemo(
    () => ({
      wire: tabRecords(tap.records, "wire").length,
      frames: tabRecords(tap.records, "frames").length,
      connection: tabRecords(tap.records, "connection").length,
      dropped: tap.records.filter((r) => r.fate?.kind === "drop").length,
    }),
    [tap.records],
  );
  const stateMessages = useMemo(
    () => new Set(notes.map((n) => n.message).filter(Boolean)).size,
    [notes],
  );

  const selectedRow = rows.find((r) => rowId(r) === selected) ?? null;
  const run = selectedRow?.kind === "deltas" ? selectedRow.recs : null;
  const record: TapRecord | null =
    selectedRow?.kind === "record"
      ? selectedRow.rec
      : run
        ? run[0]!
        : selected !== null
          ? (tap.records.find((r) => r.id === selected) ?? null)
          : null;

  const latestSocket = useMemo(() => {
    for (let i = tap.records.length - 1; i >= 0; i--) {
      const s = tap.records[i]!.socket;
      if (s !== null) return s;
    }
    return null;
  }, [tap.records]);

  async function copy(ids?: string[]) {
    setNotice(null);
    try {
      const out = await devtoolsExport(conversation, ids);
      if (typeof navigator === "undefined" || !navigator.clipboard)
        throw new Error("no clipboard here");
      await navigator.clipboard.writeText(out.ndjson);
      setNotice(`copied ${fmtCount(out.count)} record${out.count === 1 ? "" : "s"} · masked`);
    } catch (e) {
      setNotice(e instanceof Error ? e.message : String(e));
    }
  }

  async function clear() {
    setNotice(null);
    setSelected(null);
    try {
      await tap.clear();
    } catch (e) {
      setNotice(e instanceof Error ? e.message : String(e));
    }
  }

  const onKeyDown = (e: ReactKeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      if (selected !== null) setSelected(null);
      else onClose();
      return;
    }
    const typing = (e.target as Element | null)?.closest?.("input, textarea");
    if (e.key === "/" && !typing) {
      e.preventDefault();
      filterRef.current?.focus();
    }
  };

  // The grip: dragging left widens the pane.
  const onGrip = (e: ReactPointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    const startX = e.clientX;
    const startW = width;
    // The body's width, read once per drag: the pane may not squeeze the
    // thread below what its header needs. Zero means nothing was measured.
    const body = rootRef.current?.parentElement?.clientWidth ?? 0;
    const max = body > 0 ? body - RAIL_WIDTH - CHAT_MIN_WIDTH : Number.POSITIVE_INFINITY;
    const move = (ev: PointerEvent) => onResize(Math.min(max, startW + (startX - ev.clientX)));
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  // Each half ellipsises in a narrow pane; the whole line is its tooltip.
  const footLeft = `${fmtCount(counts.wire)} events · ${fmtCount(counts.frames)} frames · ${fmtCount(counts.dropped)} dropped`;
  const footRight = [
    `ring ${fmtCount(tap.records.length)} / ${fmtCount(keep)}`,
    tap.evicted > 0 ? `${fmtCount(tap.evicted)} evicted` : null,
    tap.since !== null ? `capture since ${fmtClockMs(tap.since).slice(0, 8)}` : null,
  ]
    .filter(Boolean)
    .join(" · ");

  const status = tap.paused
    ? `paused${tap.held > 0 ? ` · ${fmtCount(tap.held)} held` : ""}`
    : tap.status === "opening"
      ? "opening"
      : tap.status === "ended"
        ? "ended"
        : "live";

  return (
    <aside
      className="insp"
      aria-label="Stream inspector"
      data-owns-escape
      ref={rootRef}
      onKeyDown={onKeyDown}
    >
      <div
        className="insp-grip"
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize the inspector"
        aria-valuenow={width}
        onPointerDown={onGrip}
      />
      <header className="insp-hd">
        <span className="insp-title">Stream</span>
        <span className={`insp-badge${tap.status === "ended" ? " bad" : ""}`}>{status}</span>
        {masked !== null ? (
          <span className={`insp-badge${masked ? " ok" : ""}`} title="Follows Chat › Redact secrets">
            {masked ? "masked" : "unmasked"}
          </span>
        ) : null}
        <span className="insp-grow" />
        <button type="button" className="insp-btn" onClick={() => tap.setPaused(!tap.paused)}>
          {tap.paused ? "▶ Resume" : "❚❚ Pause"}
        </button>
        <button type="button" className="insp-btn" onClick={() => void clear()}>
          Clear
        </button>
        <button type="button" className="insp-btn" onClick={() => void copy()}>
          Copy
        </button>
        <button
          type="button"
          className="insp-btn insp-x"
          aria-label="Close the inspector"
          onClick={onClose}
        >
          ✕
        </button>
      </header>
      <div className="insp-meta">
        <span>
          conv <b>{conversationLabel(conversation)}</b>
        </span>
        <span>
          socket <b>{latestSocket ?? "—"}</b>
        </span>
      </div>
      {tap.failure !== null ? (
        <p className="insp-notice bad" role="alert">
          {tap.failure.message || tap.failure.code}
        </p>
      ) : null}
      {notice !== null ? (
        <p className="insp-notice" role="status">
          {notice}
        </p>
      ) : null}
      <div className="insp-tabs" role="tablist" aria-label="Inspector views">
        {TABS.map((t) => (
          <button
            type="button"
            role="tab"
            key={t.id}
            aria-selected={tab === t.id}
            className={tab === t.id ? "on" : undefined}
            onClick={() => {
              setTab(t.id);
              setSelected(null);
            }}
          >
            {t.label}
            <small>
              {t.id === "state"
                ? `${stateMessages} msgs`
                : fmtCount(
                    t.id === "wire"
                      ? counts.wire
                      : t.id === "frames"
                        ? counts.frames
                        : counts.connection,
                  )}
            </small>
          </button>
        ))}
      </div>
      {tab !== "state" ? (
        <>
          <div className="insp-tools">
            <input
              ref={filterRef}
              className="insp-filter"
              aria-label="Filter records"
              placeholder="filter · type:, seq:, fate:, text"
              value={filterText}
              onChange={(e) => setFilterText(e.target.value)}
            />
            {(CHIP_TABS.includes(tab) ? CATEGORIES : []).map((c) => (
              <button
                type="button"
                key={c}
                className={`insp-cat-chip c-${c}${categories.has(c) ? " on" : ""}`}
                aria-pressed={categories.has(c)}
                onClick={() =>
                  setCategories((prev) => {
                    const next = new Set(prev);
                    if (next.has(c)) next.delete(c);
                    else next.add(c);
                    return next;
                  })
                }
              >
                <i aria-hidden="true" />
                {c}
              </button>
            ))}
          </div>
          <div className="insp-toggles">
            {TOGGLES.filter((t) => t.tabs.includes(tab)).map((t) => (
              <label key={t.id} className="insp-toggle">
                <input
                  type="checkbox"
                  checked={toggles[t.id]}
                  onChange={(e) => setToggles((prev) => ({ ...prev, [t.id]: e.target.checked }))}
                />
                {t.label}
              </label>
            ))}
          </div>
          <InspectorList
            rows={rows}
            selected={selected}
            onSelect={setSelected}
            follow={toggles.follow && !tap.paused}
            label={`${TABS.find((t) => t.id === tab)?.label ?? ""} records`}
          />
          <InspectorDetail
            record={record}
            run={run}
            records={tap.records}
            notes={notes}
            onCopy={(ids) => void copy(ids)}
          />
        </>
      ) : (
        <StateView states={states} />
      )}
      <footer className="insp-foot">
        <span title={footLeft}>{footLeft}</span>
        <span className="insp-grow" />
        <span title={footRight}>{footRight}</span>
      </footer>
    </aside>
  );
}

function StateView({ states }: { states: ReturnType<typeof messageStates> }) {
  if (states.length === 0)
    return (
      <div className="insp-state">
        <p className="insp-empty">
          No turn reduced on this page yet. State shows the live messages this window assembled.
        </p>
      </div>
    );
  return (
    <div className="insp-state" role="tree" aria-label="Conversation state">
      {states.map((m) => (
        <div className="insp-msg" key={m.message} role="treeitem" aria-expanded="true">
          <div className="insp-msg-h">
            <b className="mono">{m.message}</b>
            <span>
              {m.blocks.length} block{m.blocks.length === 1 ? "" : "s"}
              {m.deltas > 0 ? ` · ${m.deltas} deltas` : ""}
              {m.replacedByHistory ? " · replaced by history" : ""}
            </span>
            {m.truncated ? (
              <span
                className="insp-badge"
                title="Older notes for this message fell off the ring: blocks, versions and counts are only the newest part"
              >
                partial
              </span>
            ) : null}
          </div>
          {m.blocks.map((b) => (
            <div className="insp-blk" key={b.key}>
              <div>
                {b.kind} · key <span className="mono">{b.key}</span>
                {b.versions.length > 1 ? ` · ${b.versions.length} versions` : ""}
                {b.deltas > 0 ? ` · ${b.deltas} deltas` : ""}
              </div>
              <div className="insp-ver insp-cur">now · {blockSummary(b.current)}</div>
              {b.versions.length > 1 || b.deltas > 0
                ? b.versions.map((v) => (
                    <div className="insp-ver" key={v.version}>
                      v{v.version} · seq {v.seq ?? "—"} · {blockSummary(v.block)}
                    </div>
                  ))
                : null}
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}
