/**
 * The fleet's Destroyed lens (§6.7): the audit of every agent this fleet has
 * destroyed, one record per incarnation, newest first.
 *
 * A destroy ends by deleting the agent's row, so the name is free again and a
 * destroyed agent appears on no other layout. What outlives it is its
 * tombstone (`agents.destroyed`) and its event log (`agents.history`), and this
 * is where both are read. Read-only: nothing here acts, because there is
 * nothing left to act on — a kept volume is claimed from the volumes lens.
 *
 * The toolbar (lens switch, filter, refresh) is `Toolbar.tsx`'s; this is only
 * the body beneath it, a table beside a detail panel for the chosen row.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { destroyed as listDestroyed, history } from "../api/index.ts";
import type { AgentEvent, AgentTombstone } from "../api/index.ts";
import { fmtDate, fmtDateTime, fmtDuration } from "../logic/format.ts";
import { eventsText } from "./agent/AgentOverview.tsx";
import { EmptyState } from "./EmptyState.tsx";
import { InlineScan } from "./Loading.tsx";
import { CopyId, Kicker } from "./primitives.tsx";

/** How much of one incarnation's log the detail panel reads. */
export const DESTROYED_HISTORY_LIMIT = 200;

/* ── the read ────────────────────────────────────────────────────────────── */

export interface DestroyedAudit {
  /** `null` until the first read has come back. */
  tombstones: AgentTombstone[] | null;
  error: string | null;
  loading: boolean;
  /** Read again now: on lens entry, the refresh button, and a destroy settling. */
  refresh: () => void;
  /** Forget the last read — a fleet switch, where it describes the wrong fleet. */
  reset: () => void;
}

/**
 * `agents.destroyed`, read only while the lens is up (`enabled`) and again on
 * every `refresh`. No poll: tombstones change only when a destroy finishes,
 * and the shell calls `refresh` when one does. A failed read keeps the last
 * good list on screen and says so, the way the volume inventory does.
 */
export function useDestroyedAudit(enabled: boolean): DestroyedAudit {
  const [tombstones, setTombstones] = useState<AgentTombstone[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [epoch, setEpoch] = useState(0);
  const refresh = useCallback(() => setEpoch((n) => n + 1), []);
  const reset = useCallback(() => {
    setTombstones(null);
    setError(null);
    setEpoch((n) => n + 1);
  }, []);

  useEffect(() => {
    // `epoch` is read so a refresh re-runs the effect; it carries no value.
    void epoch;
    if (!enabled) return;
    let live = true;
    setLoading(true);
    listDestroyed()
      .then((list) => {
        if (!live) return;
        setTombstones(list);
        setError(null);
      })
      .catch((e: unknown) => {
        if (live) setError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => {
        if (live) setLoading(false);
      });
    return () => {
      live = false;
    };
  }, [enabled, epoch]);

  return useMemo(
    () => ({ tombstones, error, loading, refresh, reset }),
    [tombstones, error, loading, refresh, reset],
  );
}

/* ── pure helpers ────────────────────────────────────────────────────────── */

/** One incarnation's identity: a reused name has several tombstones. */
export function tombstoneKey(t: AgentTombstone): string {
  return `${t.destroyed_at}#${t.name}`;
}

/** The toolbar's one filter, over what an operator would search a record by. */
export function filterTombstones(
  tombstones: readonly AgentTombstone[],
  query: string,
): AgentTombstone[] {
  const q = query.trim().toLowerCase();
  if (!q) return [...tombstones];
  return tombstones.filter((t) =>
    [t.name, t.destroyed_by, t.created_by ?? "", t.volume_id ?? "", t.instance_id ?? ""]
      .join(" ")
      .toLowerCase()
      .includes(q),
  );
}

/** `3d 04h ago`, or `just now` inside the first minute. */
function ago(iso: string, now: number): string {
  const ms = now - Date.parse(iso);
  if (!Number.isFinite(ms)) return "—";
  if (ms < 60_000) return "just now";
  return `${fmtDuration(ms)} ago`;
}

/** How long the incarnation lived, created → destroyed. */
export function lifetime(t: AgentTombstone): string {
  return fmtDuration(Date.parse(t.destroyed_at) - Date.parse(t.created_at));
}

/** What became of the data volume. */
export function volumeFate(t: AgentTombstone): string {
  if (t.volume_id === null) return "no volume";
  return t.volume_kept ? "kept" : "deleted";
}

/* ── the view ────────────────────────────────────────────────────────────── */

export function DestroyedView({
  audit,
  query,
  onClearQuery,
}: {
  audit: DestroyedAudit;
  query: string;
  onClearQuery: () => void;
}) {
  const [chosen, setChosen] = useState<string | null>(null);
  const shown = useMemo(
    () => filterTombstones(audit.tombstones ?? [], query),
    [audit.tombstones, query],
  );
  const selected = chosen === null ? null : (shown.find((t) => tombstoneKey(t) === chosen) ?? null);

  if (audit.tombstones === null) {
    return (
      <div className="body-scroll">
        {audit.error ? (
          <div className="wiz-error mono" role="alert" style={{ margin: "18px 24px" }}>
            Could not read destroyed agents: {audit.error}
          </div>
        ) : (
          <InlineScan label="Reading destroyed agents" />
        )}
      </div>
    );
  }
  if (audit.tombstones.length === 0) {
    return (
      <EmptyState
        title="No destroyed agents"
        hint="a destroyed agent's record and history land here · its name is free again"
      />
    );
  }
  if (shown.length === 0) {
    return (
      <EmptyState
        title="No destroyed agents"
        hint={`nothing matches “${query}”`}
        action={
          <button type="button" className="btn" onClick={onClearQuery}>
            Clear filter
          </button>
        }
      />
    );
  }

  const now = Date.now();
  return (
    <div className="destroyed-lens">
      <div className="body-scroll">
        {audit.error ? (
          <div className="wiz-error mono" role="alert" style={{ margin: "12px 24px" }}>
            Could not read destroyed agents: {audit.error} · showing the last good read
          </div>
        ) : null}
        <div className="table destroyed-table" role="table" aria-label="Destroyed agents">
          <div className="trow thead" role="row">
            <span role="columnheader">Agent</span>
            <span role="columnheader">Destroyed</span>
            <span role="columnheader">By</span>
            <span role="columnheader">Lifetime</span>
            <span role="columnheader">Data volume</span>
            <span role="columnheader" />
          </div>
          {shown.map((t, i) => {
            const key = tombstoneKey(t);
            const open = () => setChosen(key === chosen ? null : key);
            return (
              <div
                key={key}
                className={chosen === key ? "trow tbody-row selected" : "trow tbody-row"}
                role="row"
                tabIndex={0}
                aria-label={`${t.name} · destroyed ${fmtDateTime(t.destroyed_at)}`}
                aria-selected={chosen === key}
                onClick={open}
                onKeyDown={(e) => {
                  if (e.target === e.currentTarget && (e.key === "Enter" || e.key === " ")) {
                    e.preventDefault();
                    open();
                  }
                }}
              >
                <span className="cell-agent" role="cell">
                  <span className="idx">{String(i + 1).padStart(2, "0")}</span>
                  <span className="nm">{t.name}</span>
                </span>
                <span className="mono" role="cell" title={fmtDateTime(t.destroyed_at)}>
                  {ago(t.destroyed_at, now)}
                </span>
                <span className="mono destroyed-by" role="cell" title={t.destroyed_by}>
                  {t.destroyed_by}
                </span>
                <span className="mono" role="cell">
                  {lifetime(t)}
                  <span className="destroyed-sub">
                    {" "}
                    · {fmtDate(t.created_at)} → {fmtDate(t.destroyed_at)}
                  </span>
                </span>
                <span className="mono" role="cell">
                  <span className={t.volume_kept ? "destroyed-kept" : "destroyed-sub"}>
                    {volumeFate(t)}
                  </span>
                  {t.volume_id ? <span className="destroyed-sub"> · {t.volume_id}</span> : null}
                </span>
                <span role="cell">{t.legacy ? <span className="tag ghost">legacy</span> : null}</span>
              </div>
            );
          })}
        </div>
      </div>
      {selected ? (
        <DestroyedDetail key={tombstoneKey(selected)} t={selected} onClose={() => setChosen(null)} />
      ) : null}
    </div>
  );
}

/**
 * The chosen incarnation: its facts, and its own history — windowed to
 * `created_at`..`released_at ?? destroyed_at` (the end of its record, which
 * includes the `release` event of a legacy row released after its destroy),
 * so a name that was reused shows this life's events and not its successor's.
 */
function DestroyedDetail({ t, onClose }: { t: AgentTombstone; onClose: () => void }) {
  const [events, setEvents] = useState<AgentEvent[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const ticket = useRef(0);
  const until = t.released_at ?? t.destroyed_at;
  useEffect(() => {
    const mine = ++ticket.current;
    history(t.name, DESTROYED_HISTORY_LIMIT, { since: t.created_at, until })
      .then((list) => {
        if (ticket.current === mine) setEvents(list);
      })
      .catch((e: unknown) => {
        if (ticket.current === mine) setError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      ticket.current++;
    };
  }, [t.name, t.created_at, until]);

  return (
    <aside className="destroyed-detail" aria-label={`${t.name} · destroyed`}>
      <div className="destroyed-detail-head">
        <div>
          <Kicker>Destroyed agent · read-only</Kicker>
          <h2>{t.name}</h2>
        </div>
        <button type="button" className="btn btn-sm btn-secondary" onClick={onClose}>
          Close
        </button>
      </div>
      <dl className="kv">
        <dt>destroyed</dt>
        <dd>
          {fmtDateTime(t.destroyed_at)} · by {t.destroyed_by}
        </dd>
        <dt>created</dt>
        <dd>
          {fmtDateTime(t.created_at)}
          {t.created_by ? ` · by ${t.created_by}` : ""}
        </dd>
        <dt>lifetime</dt>
        <dd>{lifetime(t)}</dd>
        <dt>data volume</dt>
        <dd>
          {t.volume_id ? <CopyId id={t.volume_id} /> : "—"} · {volumeFate(t)}
          {t.volume_kept ? " — released from the name; adopt it with --volume" : ""}
        </dd>
        <dt>instance</dt>
        <dd>{t.instance_id ? <CopyId id={t.instance_id} /> : "—"} · terminated</dd>
        <dt>size</dt>
        <dd>{t.size ?? "—"}</dd>
        <dt>region</dt>
        <dd>{t.region ?? "—"}</dd>
        <dt>provider</dt>
        <dd>
          {t.provider ?? "—"}
          {t.profile_id ? ` · profile ${t.profile_id}` : ""}
        </dd>
        <dt>hermes</dt>
        <dd>{t.hermes_version ?? "—"}</dd>
        {t.legacy ? (
          <>
            <dt>record</dt>
            <dd>legacy — read from a pre-tombstone destroyed row</dd>
          </>
        ) : null}
      </dl>
      <Kicker style={{ marginTop: 18 }}>History · this incarnation</Kicker>
      {error ? (
        <div className="wiz-error mono" role="alert">
          Could not read history: {error}
        </div>
      ) : events === null ? (
        <InlineScan label={`Reading ${t.name}'s history`} />
      ) : (
        <div className="logpane dr-logpane" role="log" aria-label={`${t.name} history`}>
          {eventsText(events)}
        </div>
      )}
    </aside>
  );
}
