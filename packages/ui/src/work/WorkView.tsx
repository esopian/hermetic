/**
 * WORK (§9.2, issue #117): every instance's kanban board in one place. The
 * toolbar's lens narrows to what needs you, what is open, or everything; the
 * layout toggle switches between the matrix (instances × lanes) and the queue
 * (grouped by who acts next, with the card open beside it). The layout is a
 * laptop preference, kept in `localStorage` under `hermetic.work.view`.
 */
import { useMemo, useState, useSyncExternalStore } from "react";
import { KANBAN_LANES, KANBAN_QUEUE_GROUPS, kanbanNeedsYou, kanbanTone } from "@hermetic/core/shared";
import type { KanbanInstanceBoardView, KanbanTaskView } from "../api/chat.ts";
import { useFleet } from "../state/state.tsx";
import { fleetIdOf } from "../api/index.ts";
import { Pill, Track, Who, ago } from "./parts.tsx";
import { TaskPanel } from "./TaskDrawer.tsx";
import { allTasks, useBoardPoll, useWork } from "./work-state.tsx";
import type { TaskRef } from "./work-state.tsx";

type Layout = "matrix" | "queue";
type Lens = "you" | "open" | "all";
type Card = KanbanTaskView & { instance: string };

export const WORK_VIEW_KEY = "hermetic.work.view";
const CHANGED = "hermetic:work-view";

function readLayout(): Layout {
  try {
    return window.localStorage.getItem(WORK_VIEW_KEY) === "queue" ? "queue" : "matrix";
  } catch {
    return "matrix";
  }
}

function writeLayout(layout: Layout): void {
  try {
    window.localStorage.setItem(WORK_VIEW_KEY, layout);
  } catch {
    // Storage refused (a private window): the toggle still works for this page.
  }
  window.dispatchEvent(new Event(CHANGED));
}

function subscribeLayout(changed: () => void): () => void {
  const stored = (e: StorageEvent) => {
    if (e.key === null || e.key === WORK_VIEW_KEY) changed();
  };
  window.addEventListener(CHANGED, changed);
  window.addEventListener("storage", stored);
  return () => {
    window.removeEventListener(CHANGED, changed);
    window.removeEventListener("storage", stored);
  };
}

const ICON_MATRIX = (
  <svg viewBox="0 0 16 16" aria-hidden="true">
    <rect x="1.5" y="1.5" width="5" height="5" />
    <rect x="9.5" y="1.5" width="5" height="5" />
    <rect x="1.5" y="9.5" width="5" height="5" />
    <rect x="9.5" y="9.5" width="5" height="5" />
  </svg>
);
const ICON_QUEUE = (
  <svg viewBox="0 0 16 16" aria-hidden="true">
    <path d="M1 3h14M1 8h14M1 13h14" />
  </svg>
);

export function WorkView() {
  const work = useWork();
  useBoardPoll();
  const fleet = useFleet();
  const layout = useSyncExternalStore(subscribeLayout, readLayout, () => "matrix" as Layout);
  const [lens, setLens] = useState<Lens>("open");
  const [query, setQuery] = useState("");
  const all = useMemo(() => allTasks(work.board), [work.board]);
  const q = query.trim().toLowerCase();
  const shown = (t: Card) =>
    (!q || `${t.title} ${t.id} ${t.instance} ${t.assignee ?? ""}`.toLowerCase().includes(q)) &&
    (lens === "you" ? kanbanNeedsYou(t) : lens === "open" ? t.status !== "done" : true);
  const visible = all.filter(shown);
  const needYou = all.filter(kanbanNeedsYou).length;
  const instances = work.board?.instances ?? [];
  const lenses: [Lens, number, string][] = [
    ["you", needYou, "need you"],
    ["open", all.filter((t) => t.status !== "done").length, "open"],
    ["all", all.length, "all"],
  ];

  return (
    <div className="wk">
      <div className="toolbar wk-toolbar">
        <div className="toolbar-head">
          <div className="kicker">
            Work · fleet {fleetIdOf(fleet.meta) ?? "—"} · {instances.length} instances
          </div>
          <div className="lens-switch" role="group" aria-label="Work lens">
            {lenses.map(([k, n, label]) => (
              <button key={k} type="button" aria-pressed={lens === k} onClick={() => setLens(k)}>
                <b className={k === "you" && n > 0 ? "wk-warn" : undefined}>{work.board ? n : "···"}</b>{" "}
                {label}
              </button>
            ))}
          </div>
        </div>
        <div />
        <div className="toolbar-right">
          <div className="switch wk-vt" role="group" aria-label="Layout">
            <button
              type="button"
              aria-label="Matrix"
              title="Matrix"
              aria-pressed={layout === "matrix"}
              onClick={() => writeLayout("matrix")}
            >
              {ICON_MATRIX}
            </button>
            <button
              type="button"
              aria-label="Queue"
              title="Queue"
              aria-pressed={layout === "queue"}
              onClick={() => writeLayout("queue")}
            >
              {ICON_QUEUE}
            </button>
          </div>
          <input
            className="filter"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="filter by title, id, instance, assignee…"
            aria-label="Filter cards"
          />
          <button
            type="button"
            className="btn btn-primary toolbar-new"
            onClick={() => work.openCreate()}
          >
            + New task
          </button>
        </div>
      </div>
      {work.error && !work.board ? (
        <div className="empty" role="alert">
          <b>Could not read the boards</b>
          <span className="mono">{work.error}</span>
        </div>
      ) : !work.board ? (
        <div className="empty" role="status">
          <b>Reading the boards</b>
        </div>
      ) : (
        <>
          {instances
            .filter((i) => i.state === "unreachable" && i.tasks.length > 0)
            .map((i) => (
              <div key={i.instance} className="callout warn wk-stale">
                {i.instance} is not answering, showing the board as last read{" "}
                <b>{ago(i.stale_since)}</b>; changes are off until it is back.
              </div>
            ))}
          {layout === "queue" ? (
            <Queue cards={visible} all={all} instances={instances} />
          ) : (
            <Matrix cards={visible} instances={instances} />
          )}
        </>
      )}
    </div>
  );
}

/** Why an instance shows no board: `reason`, and the command that fixes an `off` one. */
function NoBoard({ inst }: { inst: KanbanInstanceBoardView }) {
  return (
    <div className="wk-off">
      <span>{inst.reason ?? `${inst.instance} has no board.`}</span>
      {inst.state === "off" && inst.hint ? <code className="mono">{inst.hint}</code> : null}
    </div>
  );
}

function TaskCard({ card, stale }: { card: Card; stale: boolean }) {
  const { openTask } = useWork();
  const tone = kanbanTone(card);
  return (
    <button
      type="button"
      className={`wk-card ${tone}${stale ? " stale" : ""}`}
      data-task-id={card.id}
      onClick={() => openTask(card.instance, card.id)}
    >
      <span className="wk-card-t">{card.title}</span>
      <span className="wk-card-m">
        <Who name={card.assignee} />
        {card.priority ? <span className="wk-prio">P{card.priority}</span> : null}
        {card.goal_mode ? <span title="goal mode">◎</span> : null}
        {card.workspace_kind === "scratch" ? <span className="wk-warn">scratch</span> : null}
        <span className="wk-r">
          {card.comment_count ? `✎${card.comment_count} ` : ""}
          {card.status === "running" ? (
            <span className="wk-tone-acc">♥ {ago(card.last_heartbeat_at)}</span>
          ) : (
            card.id
          )}
        </span>
      </span>
    </button>
  );
}

function Matrix({ cards, instances }: { cards: Card[]; instances: KanbanInstanceBoardView[] }) {
  const { openCreate } = useWork();
  const used = new Set(cards.map((t) => t.status));
  const cols = `190px ${KANBAN_LANES.map((l) => (used.has(l.id) ? "minmax(0, 1fr)" : "38px")).join(" ")}`;
  return (
    <div className="wk-matrix">
      <div className="wk-mrow wk-mhead" style={{ gridTemplateColumns: cols }}>
        <div />
        {KANBAN_LANES.map((l) =>
          used.has(l.id) ? (
            <div key={l.id} className={`wk-lh ${l.id}`} title={l.hint}>
              <b>{l.label}</b>
              <span className="mono dim">{cards.filter((t) => t.status === l.id).length}</span>
              {l.id === "blocked" ? <span className="wk-warn wk-r">you</span> : null}
            </div>
          ) : (
            <div key={l.id} className="wk-lh strip" title={`${l.label} — ${l.hint}`}>
              {l.label}
            </div>
          ),
        )}
      </div>
      {instances.map((inst) => {
        const mine = cards.filter((t) => t.instance === inst.instance);
        const stale = inst.state === "unreachable";
        const hasBoard = inst.state === "on" || (stale && inst.tasks.length > 0);
        const ny = inst.tasks.filter(kanbanNeedsYou).length;
        const label = (
          <div className="wk-lbl">
            <div className="kicker">instance</div>
            <div className="wk-nm">{inst.instance}</div>
            {hasBoard ? (
              <>
                <div className="mono dim">
                  {inst.tasks.length} cards ·{" "}
                  {ny ? <span className="wk-warn">{ny} need you</span> : "0 need you"}
                </div>
                {stale ? (
                  <div className="mono wk-warn">■ stale · last read {ago(inst.stale_since)}</div>
                ) : null}
                <button
                  type="button"
                  className="wk-add"
                  disabled={inst.state !== "on"}
                  onClick={() => openCreate(inst.instance)}
                >
                  + task
                </button>
              </>
            ) : (
              <div className="mono dim">{inst.state === "off" ? "kanban off" : inst.state}</div>
            )}
          </div>
        );
        if (!hasBoard)
          return (
            <div key={inst.instance} className="wk-mrow" style={{ gridTemplateColumns: "190px 1fr" }}>
              {label}
              <NoBoard inst={inst} />
            </div>
          );
        return (
          <div
            key={inst.instance}
            className="wk-mrow"
            data-instance={inst.instance}
            style={{ gridTemplateColumns: cols }}
          >
            {label}
            {KANBAN_LANES.map((l) => (
              <div key={l.id} className={`wk-cell${used.has(l.id) ? "" : " strip"}`}>
                {mine
                  .filter((t) => t.status === l.id)
                  .map((t) => (
                    <TaskCard key={t.id} card={t} stale={stale} />
                  ))}
              </div>
            ))}
          </div>
        );
      })}
    </div>
  );
}

function Queue({
  cards,
  all,
  instances,
}: {
  cards: Card[];
  /** Every card on the board: a picked card stays open after a write moves it out of the lens. */
  all: Card[];
  instances: KanbanInstanceBoardView[];
}) {
  const [picked, setPicked] = useState<TaskRef | null>(null);
  const sel =
    all.find((t) => t.id === picked?.id && t.instance === picked.instance) ??
    cards.find(kanbanNeedsYou) ??
    cards[0] ??
    null;
  const stale = new Set(instances.filter((i) => i.state === "unreachable").map((i) => i.instance));
  const noBoard = instances.filter((i) => i.state === "off" || i.state === "unknown");
  return (
    <div className="wk-qwrap">
      <div className="wk-q">
        {KANBAN_QUEUE_GROUPS.map((g, gi) => {
          const ts = cards
            .filter(g.test)
            .sort((a, b) => b.priority - a.priority || b.created_at - a.created_at);
          if (!ts.length && gi) return null;
          return (
            <section key={g.label} className="wk-qg">
              <div className="wk-ql">
                <div className={`kicker wk-tone-${g.tone}`}>{g.label}</div>
                <div className="wk-qn">{ts.length}</div>
                <div className="dim">{g.hint}</div>
              </div>
              <div>
                {ts.length ? (
                  ts.map((t) => (
                    <button
                      key={`${t.instance}/${t.id}`}
                      type="button"
                      data-task-id={t.id}
                      className={`wk-qr${sel?.id === t.id && sel.instance === t.instance ? " sel" : ""}${stale.has(t.instance) ? " stale" : ""}`}
                      onClick={() => setPicked({ instance: t.instance, id: t.id })}
                    >
                      <span
                        className={`sq ${kanbanTone(t)}${t.status === "running" ? " pulse" : ""}`}
                      />
                      <span className="wk-qt">
                        <span className="wk-card-t">{t.title}</span>
                        <span className={t.status === "blocked" ? "wk-qs wk-warn" : "wk-qs"}>
                          {t.status === "blocked"
                            ? (t.last_failure_error ?? t.latest_summary ?? "")
                            : (t.latest_summary ?? t.body ?? "")}
                        </span>
                      </span>
                      <span className="mono wk-qw">
                        {t.instance} · {t.assignee ?? <span className="wk-warn">nobody</span>}
                      </span>
                      <span className="wk-qtr">
                        <Track task={t} />
                        <Pill task={t} stale={stale.has(t.instance)} />
                      </span>
                      <span className="mono dim">
                        {ago(t.status === "running" ? t.last_heartbeat_at : t.created_at)}
                      </span>
                    </button>
                  ))
                ) : (
                  <div className="wk-qnone dim">Nothing needs you.</div>
                )}
              </div>
            </section>
          );
        })}
        {noBoard.length ? (
          <div className="wk-qoff mono dim">
            {noBoard.map((i) => (
              <span key={i.instance}>
                <b>{i.instance}</b> ·{" "}
                {i.state === "off" ? `kanban off · ${i.hint ?? ""}` : "no board API"}
              </span>
            ))}
          </div>
        ) : null}
      </div>
      <aside className="wk-pane" aria-label="Task">
        {sel ? (
          <TaskPanel
            key={`${sel.instance}/${sel.id}`}
            taskRef={{ instance: sel.instance, id: sel.id }}
            inline
            onClose={() => setPicked(null)}
          />
        ) : (
          <div className="empty">
            <b>No card matches</b>
          </div>
        )}
      </aside>
    </div>
  );
}
